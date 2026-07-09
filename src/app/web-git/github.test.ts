// Regression tests for the GitHub REST sync transport (github.ts).
//
// The heavy hitters, each traced to a real user-visible failure:
//   - EMPTY REPO: GitHub disables the whole Git Data API (not just refs) on a
//     zero-commit repo with 409 "Git Repository is empty." — the first sync
//     must bootstrap an initial commit via the Contents API, not die on the
//     tree POST. (「同期」ボタンが 409 で機能しない)
//   - report kinds: pull-only must NOT be reported as 変更なし (the UI would
//     skip the editor/tree reload), push-only must NOT be reported as
//     fastForward (the UI would needlessly remount the editor).
//   - conflicts must NOT advance the sync base, or the next sync silently
//     rolls back the remote's non-conflicting changes.
//   - non-text entries (binaries, symlinks, submodules) ride through pushes
//     by sha — never decoded, merged, or re-encoded.
//   - collab refs (refs/hakushi/*) union-merge (INTERFACES.md §11.3).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  canonicalizeEventLine,
  clearToken,
  hasToken,
  parseRepo,
  runSync,
  setToken,
  syncCollabRefs,
  unionEvents,
} from "./github";

// ---------------------------------------------------------------------------
// fetch double: match by `METHOD path` prefix; routes can be limited to N
// uses (`times`) so a path can answer differently across calls (e.g. a branch
// ref that 409s before the bootstrap and resolves after it). Bodies may be
// functions of the request body (for per-call counters).
// ---------------------------------------------------------------------------

interface Route {
  match: string;
  status?: number;
  body?: unknown | ((reqBody: unknown) => unknown);
  times?: number;
}

interface Call {
  key: string;
  body: unknown;
}

function stubFetch(routes: Route[]): { calls: Call[] } {
  const remaining = routes.map((r) => r.times ?? Number.POSITIVE_INFINITY);
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");
    const key = `${method} ${path}`;
    let reqBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        reqBody = JSON.parse(init.body);
      } catch {
        reqBody = init.body;
      }
    }
    calls.push({ key, body: reqBody });
    const i = routes.findIndex((r, idx) => key.startsWith(r.match) && remaining[idx] > 0);
    if (i === -1) throw new Error(`unrouted request: ${key}`);
    remaining[i] -= 1;
    const route = routes[i];
    const status = route.status ?? 200;
    const resBody = typeof route.body === "function" ? route.body(reqBody) : (route.body ?? {});
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: () => Promise.resolve(resBody),
    } as Response);
  });
  return { calls };
}

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Routes serving one remote commit's tree (texts by path). */
function remoteTreeRoutes(
  commitSha: string,
  files: Record<string, string>,
  extra: { path: string; mode: string; type: string; sha: string }[] = [],
): Route[] {
  const entries = Object.keys(files).map((path, i) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: `blob-${commitSha}-${i}`,
  }));
  return [
    {
      match: `GET /repos/you/repo/git/commits/${commitSha}`,
      body: { tree: { sha: `tree-${commitSha}` }, parents: [] },
    },
    {
      match: `GET /repos/you/repo/git/trees/tree-${commitSha}`,
      body: { tree: [...entries, ...extra], truncated: false },
    },
    ...entries.map((e, i) => ({
      match: `GET /repos/you/repo/git/blobs/${e.sha}`,
      body: { content: b64(Object.values(files)[i]) },
    })),
  ];
}

const URL_ = "https://github.com/you/repo.git";

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken("github.com");
});

describe("setToken validation", () => {
  it("accepts a real PAT (classic and fine-grained)", () => {
    setToken("github.com", "ghp_EXAMPLE_classic_pat_for_tests_only");
    expect(hasToken("github.com")).toBe(true);
    setToken("github.com", "github_pat_11ABCDEF0abcdef");
    expect(hasToken("github.com")).toBe(true);
  });

  it("rejects the settings-page URL pasted instead of a token", () => {
    expect(() => setToken("github.com", "https://github.com/settings/tokens")).toThrow(
      /トークンの形式/,
    );
    expect(hasToken("github.com")).toBe(false);
  });

  it("rejects values with embedded whitespace and empty input", () => {
    expect(() => setToken("github.com", "Bearer ghp_abc")).toThrow(/トークンの形式/);
    expect(() => setToken("github.com", "   ")).toThrow(/空のトークン/);
  });
});

describe("parseRepo", () => {
  it("parses https, ssh, .git and shorthand forms", () => {
    for (const url of [
      "https://github.com/you/repo.git",
      "https://github.com/you/repo",
      "git@github.com:you/repo.git",
      "you/repo",
    ]) {
      expect(parseRepo(url)).toEqual({ owner: "you", repo: "repo" });
    }
  });

  it("rejects non-GitHub URLs", () => {
    expect(parseRepo("https://gitlab.com/you/repo")).toBeNull();
    expect(parseRepo("file:///tmp/repo")).toBeNull();
  });
});

describe("runSync against an empty repository", () => {
  it("bootstraps an initial commit via the Contents API, then syncs normally", async () => {
    setToken("github.com", "ghp_test");
    const { calls } = stubFetch([
      // 1st ref lookup: the whole repo is empty → 409 (NOT just the branch).
      {
        match: "GET /repos/you/repo/git/ref/heads/main",
        status: 409,
        body: { message: "Git Repository is empty." },
        times: 1,
      },
      // Bootstrap via Contents API (the only write that works on empty repos).
      { match: "PUT /repos/you/repo/contents/README.md", body: { commit: { sha: "boot1" } } },
      // The bootstrap commit's tree: just the README.
      ...remoteTreeRoutes("boot1", { "README.md": "# repo\n" }),
      // Snapshot push on top of the bootstrap commit.
      { match: "POST /repos/you/repo/git/trees", body: { sha: "tree1" } },
      { match: "POST /repos/you/repo/git/commits", body: { sha: "commit1" } },
      // push() re-checks the branch: it exists now (created by the bootstrap).
      {
        match: "GET /repos/you/repo/git/ref/heads/main",
        body: { object: { sha: "boot1" } },
      },
      { match: "PATCH /repos/you/repo/git/refs/heads/main", body: {} },
    ]);

    const ours = new Map([["Welcome.md", "# hi\n"]]);
    const result = await runSync(URL_, "main", ours, null);

    expect(result.report.pushed).toBe(true);
    expect(result.report.message).toContain("空のリポジトリを初期化しました");
    // The README comes back INTO the local worktree (pull side of the merge).
    expect(result.merged?.get("README.md")).toBe("# repo\n");
    expect(result.newBase?.sha).toBe("commit1");
    // The pushed tree carries both the local page and the README.
    const treePost = calls.find((c) => c.key.startsWith("POST /repos/you/repo/git/trees"));
    const tree = (treePost?.body as { tree: { path: string }[] }).tree;
    expect(tree.map((t) => t.path).sort()).toEqual(["README.md", "Welcome.md"]);
  });

  it("first-pushes a missing branch parented on the default branch head", async () => {
    setToken("github.com", "ghp_test");
    const { calls } = stubFetch([
      {
        match: "GET /repos/you/repo/git/ref/heads/feature",
        status: 404,
        body: { message: "Not Found" },
      },
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "m1" } } },
      { match: "GET /repos/you/repo", body: { default_branch: "main" } },
      { match: "POST /repos/you/repo/git/trees", body: { sha: "t1" } },
      { match: "POST /repos/you/repo/git/commits", body: { sha: "c1" } },
      { match: "POST /repos/you/repo/git/refs", body: {} },
    ]);

    const result = await runSync(URL_, "feature", new Map([["a.md", "x"]]), null);
    expect(result.report.branch.kind).toBe("noRemoteBranch");
    expect(result.report.pushed).toBe(true);
    // NOT an orphan: the new branch's commit is parented on main's head, so
    // GitHub's compare / PR view keeps working.
    const commitPost = calls.find((c) => c.key.startsWith("POST /repos/you/repo/git/commits"));
    expect((commitPost?.body as { parents: string[] }).parents).toEqual(["m1"]);
  });

  it("propagates other API errors (e.g. 401) instead of swallowing them", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      {
        match: "GET /repos/you/repo/git/ref/heads/main",
        status: 401,
        body: { message: "Bad credentials" },
      },
    ]);
    await expect(runSync(URL_, "main", new Map([["a.md", "x"]]), null)).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

describe("runSync report kinds", () => {
  function baseRoutes(remoteFiles: Record<string, string>): Route[] {
    return [
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "r1" } } },
      ...remoteTreeRoutes("r1", remoteFiles),
    ];
  }

  it("up to date: no pushes, no local change", async () => {
    setToken("github.com", "ghp_test");
    const { calls } = stubFetch(baseRoutes({ "a.md": "same" }));
    const result = await runSync(URL_, "main", new Map([["a.md", "same"]]), "r1");
    expect(result.report.branch.kind).toBe("upToDate");
    expect(result.report.pushed).toBe(false);
    expect(result.merged).toBeNull();
    expect(calls.every((c) => c.key.startsWith("GET"))).toBe(true);
  });

  it("push-only: kind upToDate + pushed (no editor-remount fastForward)", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      ...baseRoutes({ "a.md": "old" }),
      { match: "POST /repos/you/repo/git/trees", body: { sha: "t2" } },
      { match: "POST /repos/you/repo/git/commits", body: { sha: "c2" } },
      { match: "PATCH /repos/you/repo/git/refs/heads/main", body: {} },
    ]);
    const result = await runSync(URL_, "main", new Map([["a.md", "new"]]), "r1");
    expect(result.report.branch.kind).toBe("upToDate");
    expect(result.report.pushed).toBe(true);
    expect(result.merged).toBeNull(); // nothing to write locally
    expect(result.newBase?.sha).toBe("c2");
  });

  it("pull-only: kind fastForward + merged map (NOT 変更なし)", async () => {
    setToken("github.com", "ghp_test");
    // base r0 (cached files passed in) → remote advanced to r1.
    stubFetch([
      ...baseRoutes({ "a.md": "remote-new" }),
      // base-existence probe (r0 still exists on the remote)
      { match: "GET /repos/you/repo/git/commits/r0", body: { tree: { sha: "t-r0" } } },
    ]);
    const result = await runSync(
      URL_,
      "main",
      new Map([["a.md", "old"]]),
      "r0",
      new Map([["a.md", "old"]]), // cached base tree — no API fetch needed
    );
    expect(result.report.branch.kind).toBe("fastForward");
    expect(result.report.pushed).toBe(false);
    expect(result.merged?.get("a.md")).toBe("remote-new");
    expect(result.newBase?.sha).toBe("r1");
  });

  it("conflicts: base does NOT advance; pendingMerge carries the full tree", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      ...baseRoutes({ "a.md": "theirs", "b.md": "remote-only-change" }),
      { match: "GET /repos/you/repo/git/commits/r0", body: { tree: { sha: "t-r0" } } },
    ]);
    const result = await runSync(
      URL_,
      "main",
      new Map([
        ["a.md", "ours"],
        ["b.md", "base-b"],
      ]),
      "r0",
      new Map([
        ["a.md", "base-a"],
        ["b.md", "base-b"],
      ]),
    );
    expect(result.report.branch.kind).toBe("conflicts");
    expect(result.conflicts?.map((c) => c.relPath)).toEqual(["a.md"]);
    // The base must stay put until the resolution lands.
    expect(result.newBase).toBeNull();
    // The pending merge keeps the NON-conflicting remote change (b.md) so the
    // resolution flow cannot lose it.
    expect(result.pendingMerge?.merged.get("b.md")).toBe("remote-only-change");
    expect(result.pendingMerge?.merged.get("a.md")).toBe("ours");
    expect(result.pendingMerge?.remoteSha).toBe("r1");
  });
});

describe("runSync base validation", () => {
  it("falls back to an empty base when the base commit vanished (repo recreated) — never mass-deletes local pages", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "new1" } } },
      ...remoteTreeRoutes("new1", { "README.md": "# recreated\n" }),
      // The old base commit is GONE from the remote.
      { match: "GET /repos/you/repo/git/commits/r0", status: 404, body: { message: "Not Found" } },
      { match: "POST /repos/you/repo/git/trees", body: { sha: "t9" } },
      { match: "POST /repos/you/repo/git/commits", body: { sha: "c9" } },
      { match: "PATCH /repos/you/repo/git/refs/heads/main", body: {} },
    ]);
    // The STALE cached base claims Welcome.md was synced before. Trusting it
    // would read "missing on the recreated remote" as a remote deletion and
    // wipe the local page. The vanished-base fallback must keep it.
    const result = await runSync(
      URL_,
      "main",
      new Map([["Welcome.md", "keep me"]]),
      "r0",
      new Map([
        ["Welcome.md", "keep me"],
        ["README.md", "old readme"],
      ]),
    );
    expect(result.conflicts).toBeNull();
    expect(result.report.pushed).toBe(true);
    // Local page survives AND the recreated remote's README is adopted.
    expect(result.newBase?.files.get("Welcome.md")).toBe("keep me");
    expect(result.newBase?.files.get("README.md")).toBe("# recreated\n");
  });
});

describe("runSync non-text handling", () => {
  it("passes binaries/symlinks through by sha — never merged or re-encoded", async () => {
    setToken("github.com", "ghp_test");
    const binary = btoa(String.fromCharCode(0xff, 0xd8, 0x00, 0xfe)); // not UTF-8
    const { calls } = stubFetch([
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "r1" } } },
      {
        match: "GET /repos/you/repo/git/commits/r1",
        body: { tree: { sha: "tree-r1" } },
      },
      {
        match: "GET /repos/you/repo/git/trees/tree-r1",
        body: {
          tree: [
            { path: "a.md", mode: "100644", type: "blob", sha: "blob-a" },
            { path: "img.png", mode: "100644", type: "blob", sha: "blob-img" },
            { path: "link", mode: "120000", type: "blob", sha: "blob-link" },
          ],
          truncated: false,
        },
      },
      { match: "GET /repos/you/repo/git/blobs/blob-a", body: { content: b64("text") } },
      { match: "GET /repos/you/repo/git/blobs/blob-img", body: { content: binary } },
      { match: "POST /repos/you/repo/git/trees", body: { sha: "t2" } },
      { match: "POST /repos/you/repo/git/commits", body: { sha: "c2" } },
      { match: "PATCH /repos/you/repo/git/refs/heads/main", body: {} },
    ]);

    const result = await runSync(URL_, "main", new Map([["a.md", "text-edited"]]), "r1");
    expect(result.report.pushed).toBe(true);
    // The symlink blob is never even fetched.
    expect(calls.some((c) => c.key.includes("blob-link"))).toBe(false);
    const treePost = calls.find((c) => c.key.startsWith("POST /repos/you/repo/git/trees"));
    const tree = (treePost?.body as {
      tree: { path: string; sha?: string; content?: string; mode: string }[];
    }).tree;
    const img = tree.find((t) => t.path === "img.png");
    const link = tree.find((t) => t.path === "link");
    expect(img).toEqual({ path: "img.png", mode: "100644", type: "blob", sha: "blob-img" });
    expect(link?.mode).toBe("120000");
    expect(link?.sha).toBe("blob-link");
    // The binary never appears anywhere in the local merge result.
    expect(result.merged).toBeNull();
  });

  it("refuses a truncated remote tree instead of treating it as deletions", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "r1" } } },
      { match: "GET /repos/you/repo/git/commits/r1", body: { tree: { sha: "tree-r1" } } },
      {
        match: "GET /repos/you/repo/git/trees/tree-r1",
        body: { tree: [], truncated: true },
      },
    ]);
    await expect(runSync(URL_, "main", new Map(), "r1")).rejects.toThrow(/多すぎて/);
  });

  it("pushes an all-deleted worktree as the empty tree (no invalid tree POST)", async () => {
    setToken("github.com", "ghp_test");
    const { calls } = stubFetch([
      { match: "GET /repos/you/repo/git/ref/heads/main", body: { object: { sha: "r1" } } },
      ...remoteTreeRoutes("r1", { "a.md": "x" }),
      { match: "POST /repos/you/repo/git/commits", body: { sha: "c2" } },
      { match: "PATCH /repos/you/repo/git/refs/heads/main", body: {} },
    ]);
    // base == remote (a.md), local deleted it → merged is empty.
    const result = await runSync(URL_, "main", new Map(), "r1");
    expect(result.report.pushed).toBe(true);
    expect(calls.some((c) => c.key.startsWith("POST /repos/you/repo/git/trees"))).toBe(false);
    const commitPost = calls.find((c) => c.key.startsWith("POST /repos/you/repo/git/commits"));
    expect((commitPost?.body as { tree: string }).tree).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });
});

// ---------------------------------------------------------------------------
// Collab refs (refs/hakushi/*)
// ---------------------------------------------------------------------------

describe("canonicalizeEventLine", () => {
  it("is key-order insensitive and sorts data keys (matches the Rust side)", () => {
    const a = '{"v":1,"type":"comment","ts":5,"author":"a","data":{"body":"x","a":1}}';
    const b = '{"data":{"a":1,"body":"x"},"author":"a","ts":5,"type":"comment","v":1}';
    expect(canonicalizeEventLine(a).canonical).toBe(canonicalizeEventLine(b).canonical);
    expect(canonicalizeEventLine(a).canonical).toBe(
      '{"v":1,"type":"comment","ts":5,"author":"a","data":{"a":1,"body":"x"}}',
    );
  });

  it("falls back to the raw line for malformed events (ts 0)", () => {
    const raw = canonicalizeEventLine("not json at all");
    expect(raw.ts).toBe(0);
    expect(raw.canonical).toBe("not json at all");
    // Missing required fields (author) → also the raw fallback, like serde.
    const noAuthor = canonicalizeEventLine('{"v":1,"type":"x","ts":3,"data":{}}');
    expect(noAuthor.ts).toBe(0);
  });
});

describe("unionEvents", () => {
  it("dedups by canonical json and orders by (ts, json)", () => {
    const e = (ts: number, body: string) =>
      canonicalizeEventLine(
        JSON.stringify({ v: 1, type: "comment", ts, author: "a", data: { body } }),
      );
    const u = unionEvents([e(2, "b"), e(1, "a")], [e(2, "b"), e(2, "a")]);
    expect(u).toHaveLength(3);
    expect(u[0].ts).toBe(1);
    expect(u[1].canonical).toContain('"body":"a"');
    expect(u[2].canonical).toContain('"body":"b"');
  });
});

describe("syncCollabRefs", () => {
  const EV1 = '{"v":1,"type":"create","ts":10,"author":"me","data":{"title":"T"}}';
  const EV2 = '{"v":1,"type":"comment","ts":20,"author":"me","data":{"body":"hi"}}';
  const EV3 = '{"v":1,"type":"comment","ts":30,"author":"you","data":{"body":"yo"}}';

  it("pushes a local-only issue as an empty-tree commit chain + new ref", async () => {
    setToken("github.com", "ghp_test");
    let n = 0;
    const { calls } = stubFetch([
      { match: "GET /repos/you/repo/git/matching-refs/hakushi/", body: [] },
      { match: "POST /repos/you/repo/git/commits", body: () => ({ sha: `cc${++n}` }) },
      { match: "POST /repos/you/repo/git/refs", body: {} },
    ]);
    const result = await syncCollabRefs(URL_, {
      issues: new Map([["01A", [EV1, EV2]]]),
      prs: new Map(),
    });
    // Local-only refs count as unchanged (push only) — desktop semantics.
    expect(result.report).toEqual({ merged: 0, unchanged: 1 });
    expect(result.changedLocal).toEqual([]);
    const commits = calls.filter((c) => c.key.startsWith("POST /repos/you/repo/git/commits"));
    expect(commits).toHaveLength(2);
    // Chain: first commit parentless, second parented on the first; empty tree;
    // deterministic identity (author from the event, fixed email, ts as date).
    const first = commits[0].body as {
      tree: string;
      parents: string[];
      message: string;
      author: { name: string; email: string; date: string };
    };
    expect(first.tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(first.parents).toEqual([]);
    expect(first.message).toBe(canonicalizeEventLine(EV1).canonical);
    expect(first.author).toEqual({ name: "me", email: "hakushi@local", date: "1970-01-01T00:00:10Z" });
    expect((commits[1].body as { parents: string[] }).parents).toEqual(["cc1"]);
    const refPost = calls.find((c) => c.key.startsWith("POST /repos/you/repo/git/refs"));
    expect((refPost?.body as { ref: string }).ref).toBe("refs/hakushi/issues/01A");
    expect(result.newTipCache["refs/hakushi/issues/01A"]?.sha).toBe("cc2");
  });

  it("adopts a remote-only PR chain into the local log", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      {
        match: "GET /repos/you/repo/git/matching-refs/hakushi/",
        body: [{ ref: "refs/hakushi/prs/01B", object: { sha: "p2" } }],
      },
      // Chain walk: tip p2 → parent p1 → root.
      {
        match: "GET /repos/you/repo/git/commits/p2",
        body: { message: EV2, parents: [{ sha: "p1" }] },
      },
      { match: "GET /repos/you/repo/git/commits/p1", body: { message: EV1, parents: [] } },
    ]);
    const result = await syncCollabRefs(URL_, { issues: new Map(), prs: new Map() });
    expect(result.report).toEqual({ merged: 1, unchanged: 0 });
    expect(result.changedLocal).toEqual(["prs/01B"]);
    expect(result.logs.prs.get("01B")).toEqual([
      canonicalizeEventLine(EV1).canonical,
      canonicalizeEventLine(EV2).canonical,
    ]);
  });

  it("union-merges a diverged chain: local adopts, remote is rebuilt force-pushed", async () => {
    setToken("github.com", "ghp_test");
    let n = 0;
    const { calls } = stubFetch([
      {
        match: "GET /repos/you/repo/git/matching-refs/hakushi/",
        body: [{ ref: "refs/hakushi/issues/01C", object: { sha: "r2" } }],
      },
      {
        match: "GET /repos/you/repo/git/commits/r2",
        body: { message: EV3, parents: [{ sha: "r1" }] },
      },
      { match: "GET /repos/you/repo/git/commits/r1", body: { message: EV1, parents: [] } },
      { match: "POST /repos/you/repo/git/commits", body: () => ({ sha: `u${++n}` }) },
      { match: "PATCH /repos/you/repo/git/refs/hakushi/issues/01C", body: {} },
    ]);
    // Local has EV1+EV2; remote has EV1+EV3 → union is EV1,EV2,EV3 (ts order).
    const result = await syncCollabRefs(URL_, {
      issues: new Map([["01C", [EV1, EV2]]]),
      prs: new Map(),
    });
    expect(result.report).toEqual({ merged: 1, unchanged: 0 });
    expect(result.logs.issues.get("01C")).toEqual(
      [EV1, EV2, EV3].map((e) => canonicalizeEventLine(e).canonical),
    );
    const patch = calls.find((c) => c.key.startsWith("PATCH"));
    expect((patch?.body as { force: boolean }).force).toBe(true);
    const commits = calls.filter((c) => c.key.startsWith("POST /repos/you/repo/git/commits"));
    expect(commits.map((c) => (c.body as { message: string }).message)).toEqual(
      [EV1, EV2, EV3].map((e) => canonicalizeEventLine(e).canonical),
    );
  });

  it("skips the chain walk entirely when the cached tip matches", async () => {
    setToken("github.com", "ghp_test");
    const { calls } = stubFetch([
      {
        match: "GET /repos/you/repo/git/matching-refs/hakushi/",
        body: [{ ref: "refs/hakushi/issues/01D", object: { sha: "tip1" } }],
      },
    ]);
    const canonical = canonicalizeEventLine(EV1).canonical;
    const result = await syncCollabRefs(
      URL_,
      { issues: new Map([["01D", [EV1]]]), prs: new Map() },
      { "refs/hakushi/issues/01D": { sha: "tip1", events: [canonical] } },
    );
    expect(result.report).toEqual({ merged: 0, unchanged: 1 });
    expect(calls.filter((c) => c.key.includes("/git/commits/"))).toHaveLength(0);
  });

  it("treats an empty repo (409 on matching-refs) as no remote refs", async () => {
    setToken("github.com", "ghp_test");
    stubFetch([
      {
        match: "GET /repos/you/repo/git/matching-refs/hakushi/",
        status: 409,
        body: { message: "Git Repository is empty." },
      },
    ]);
    const result = await syncCollabRefs(URL_, { issues: new Map(), prs: new Map() });
    expect(result.report).toEqual({ merged: 0, unchanged: 0 });
  });
});
