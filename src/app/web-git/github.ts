// GitHub sync transport — the server-less remote (INTERFACES.md §11 over the
// GitHub REST/Git-Data API instead of the git wire protocol).
//
// WHY the API and not `git push`: a browser cannot speak git's smart-HTTP to
// github.com because those endpoints send no CORS headers, so the browser
// blocks the request and there is no client-only way around it. api.github.com,
// by contrast, DOES send CORS headers, so blobs → tree → commit → ref can all
// be created from the browser with just the user's PAT — no proxy, no server.
//
// Scope: syncs ONE branch (the current local branch) plus the collab event
// refs (refs/hakushi/*). A push uploads the whole text worktree as one commit
// on top of the remote head; a pull downloads the remote tree and 3-way-merges
// it against the last-synced base. Same-file divergence becomes a ConflictFile
// the existing ConflictResolver handles.
//
// Non-text remote entries (binaries, symlinks, exec-bit files, submodules) are
// NEVER merged or re-encoded: they ride through every pushed tree verbatim by
// sha ("passthrough"), so a Hakushi sync can not corrupt them.
//
// Empty repositories: GitHub disables the whole Git Data API (trees, blobs,
// commits — not just refs) on a repo with zero commits, answering 409
// "Git Repository is empty." The Contents API still works there, so the first
// sync bootstraps an initial commit (README.md) through it and then proceeds
// over the Git Data API as usual.

import type { CollabRefsReport, ConflictFile, SyncReport } from "../workspace";

const API = "https://api.github.com";
const HOST = "github.com";

/** The well-known oid of git's empty tree (present in every repository). */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// --- Session-only PAT store (in-memory; never persisted → smaller XSS blast) -
const tokens = new Map<string, string>();

export function setToken(host: string, token: string): void {
  const t = token.trim();
  if (t === "") throw new Error("空のトークンは保存できません");
  // Guard the most common paste mistakes before they reach GitHub as a 401:
  //   - the PAT *settings page URL* (https://github.com/settings/tokens),
  //   - a value with embedded whitespace (e.g. "Bearer ghp_…" copied wholesale).
  // No GitHub token form (ghp_ / gho_ / ghs_ / github_pat_ …) contains a slash
  // or whitespace, so either is an unambiguous sign of a wrong paste.
  if (/\s/.test(t) || t.includes("/")) {
    throw new Error(
      "トークンの形式が正しくありません。設定ページの URL ではなく、発行されたトークン" +
        "（ghp_… または github_pat_… の文字列）そのものを貼り付けてください。",
    );
  }
  tokens.set(host, t);
}
export function clearToken(host: string): void {
  tokens.delete(host);
}
export function hasToken(host: string): boolean {
  return tokens.has(host);
}

/** Parse `owner`/`repo` from any GitHub remote URL form. */
export function parseRepo(url: string): { owner: string; repo: string } | null {
  const m =
    url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^([^/:@\s]+)\/([^/:@\s]+?)(?:\.git)?$/); // "owner/repo" shorthand
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const token = tokens.get(HOST);
  if (token === undefined) throw new Error("GitHub トークンが設定されていません。");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** A non-2xx GitHub API response, carrying the HTTP status for callers to branch on. */
export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`GitHub API ${status}: ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { message?: string }).message ?? "";
    } catch {
      /* non-JSON error body */
    }
    // Friendly wording for the two rate-limit shapes (403 primary / 429
    // secondary) — a raw "API rate limit exceeded for …" helps nobody.
    if ((res.status === 403 || res.status === 429) && /rate limit/i.test(detail)) {
      throw new GitHubApiError(
        res.status,
        "GitHub API のレート制限に達しました。しばらく待ってから再同期してください。",
      );
    }
    throw new GitHubApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

interface Repo {
  owner: string;
  repo: string;
}

interface BranchHead {
  /** Head commit SHA, or null when the ref does not exist yet. */
  sha: string | null;
  /** True when the whole repository has zero commits (Git Data API disabled). */
  emptyRepo: boolean;
}

/** Head commit SHA of a branch; distinguishes "branch missing" from "repo empty". */
async function branchSha({ owner, repo }: Repo, branch: string): Promise<BranchHead> {
  try {
    const ref = await api<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return { sha: ref.object.sha, emptyRepo: false };
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) return { sha: null, emptyRepo: false };
    // 409 "Git Repository is empty." — a freshly created remote with no
    // commits at all. The Git Data API is entirely unusable in this state
    // (trees/blobs/commits also 409), so the caller must bootstrap through
    // the Contents API first.
    if (e instanceof GitHubApiError && e.status === 409) return { sha: null, emptyRepo: true };
    throw e;
  }
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\n/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Create the initial commit on an empty repository via the Contents API (the
 * only write path GitHub allows there), un-emptying it so the Git Data API
 * works. Returns the new commit's SHA — the remote head to sync against.
 */
async function bootstrapEmptyRepo(r: Repo, branch: string): Promise<string> {
  const res = await api<{ commit: { sha: string } }>(
    "PUT",
    `/repos/${r.owner}/${r.repo}/contents/README.md`,
    {
      message: "Hakushi: initial commit",
      content: encodeBase64(`# ${r.repo}\n`),
      branch,
    },
  );
  return res.commit.sha;
}

/** Default-branch head SHA, for parenting the first push of a new branch. */
async function defaultBranchSha(r: Repo): Promise<string | null> {
  const info = await api<{ default_branch: string }>("GET", `/repos/${r.owner}/${r.repo}`);
  return (await branchSha(r, info.default_branch)).sha;
}

/** A remote tree entry we never merge — preserved verbatim by sha on push. */
export interface PassthroughEntry {
  mode: string;
  type: string;
  sha: string;
}

/** The remote tree of one commit, split into mergeable text and passthrough. */
export interface RemoteTree {
  texts: Map<string, string>;
  passthrough: Map<string, PassthroughEntry>;
}

/**
 * All entries of the tree of commit `sha`. Regular files (mode 100644) whose
 * bytes decode as UTF-8 become `texts`; everything else — binaries, symlinks
 * (120000), exec-bit files (100755), submodules (160000) — is `passthrough`.
 */
async function treeFiles(r: Repo, commitSha: string): Promise<RemoteTree> {
  const texts = new Map<string, string>();
  const passthrough = new Map<string, PassthroughEntry>();
  const commit = await api<{ tree: { sha: string } }>(
    "GET",
    `/repos/${r.owner}/${r.repo}/git/commits/${commitSha}`,
  );
  const tree = await api<{
    tree: { path: string; type: string; mode: string; sha: string }[];
    truncated: boolean;
  }>("GET", `/repos/${r.owner}/${r.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) {
    // A truncated listing would make every missing file look "deleted on the
    // remote" to the 3-way merge — silent data loss. Refuse instead.
    throw new Error(
      "リモートのファイル数が多すぎて一覧を取得できません（GitHub API の上限）。" +
        "このリポジトリは Web 版では同期できません。",
    );
  }
  const strict = new TextDecoder("utf-8", { fatal: true });
  for (const entry of tree.tree) {
    if (entry.type === "tree") continue;
    if (entry.type !== "blob" || entry.mode !== "100644") {
      passthrough.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
      continue;
    }
    const blob = await api<{ content: string }>(
      "GET",
      `/repos/${r.owner}/${r.repo}/git/blobs/${entry.sha}`,
    );
    const bytes = decodeBase64Bytes(blob.content);
    try {
      texts.set(entry.path, strict.decode(bytes));
    } catch {
      // Not valid UTF-8 → binary. Never merge or re-encode it.
      passthrough.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
    }
  }
  return { texts, passthrough };
}

/**
 * Create tree → commit → move ref. Returns the new commit SHA. `passthrough`
 * entries are attached by sha (no content upload, no re-encoding). An empty
 * tree skips the tree POST (GitHub rejects `tree: []`) and reuses git's
 * well-known empty-tree oid.
 */
async function push(
  r: Repo,
  branch: string,
  texts: Map<string, string>,
  passthrough: Map<string, PassthroughEntry>,
  parents: string[],
  message: string,
): Promise<string> {
  const tree = [
    ...[...texts].map(([path, content]) => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      content,
    })),
    ...[...passthrough]
      .filter(([path]) => !texts.has(path))
      .map(([path, e]) => ({ path, mode: e.mode, type: e.type, sha: e.sha })),
  ];
  let treeSha = EMPTY_TREE_SHA;
  if (tree.length > 0) {
    const treeRes = await api<{ sha: string }>("POST", `/repos/${r.owner}/${r.repo}/git/trees`, {
      tree,
    });
    treeSha = treeRes.sha;
  }
  const commitRes = await api<{ sha: string }>("POST", `/repos/${r.owner}/${r.repo}/git/commits`, {
    message,
    tree: treeSha,
    parents,
  });
  const refPath = `/repos/${r.owner}/${r.repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  if (parents.length === 0 || !(await branchExists(r, branch))) {
    await api("POST", `/repos/${r.owner}/${r.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitRes.sha,
    });
  } else {
    try {
      await api("PATCH", refPath, { sha: commitRes.sha, force: false });
    } catch (e) {
      // Somebody moved the branch between our fetch and this push.
      if (e instanceof GitHubApiError && e.status === 422) {
        throw new Error(
          "同期中にリモートが更新されました。もう一度「同期」を実行してください。",
        );
      }
      throw e;
    }
  }
  return commitRes.sha;
}

async function branchExists(r: Repo, branch: string): Promise<boolean> {
  return (await branchSha(r, branch)).sha !== null;
}

/** Whether a commit object still exists on the remote (sync-base validation). */
async function commitExists(r: Repo, sha: string): Promise<boolean> {
  try {
    await api("GET", `/repos/${r.owner}/${r.repo}/git/commits/${sha}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubApiError && (e.status === 404 || e.status === 422)) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Three-way merge (file granularity; same-file divergence → conflict)
// ---------------------------------------------------------------------------

export interface SyncResult {
  report: SyncReport;
  /** File map to write into the local worktree (null = no local change). */
  merged: Map<string, string> | null;
  /** Unresolved conflicts to hand to the resolver (null = none). */
  conflicts: ConflictFile[] | null;
  /**
   * Remote head + its text tree after the pass, to persist as the new sync
   * base. Null on conflicts: the base must NOT advance until the resolution
   * lands, or the next sync would silently roll back the remote's changes.
   */
  newBase: { sha: string; files: Map<string, string> } | null;
  /**
   * On conflicts: the full merged tree (ours kept for conflicting paths) and
   * the remote head it was computed against — everything gitMergeResolve
   * needs to finish the merge without losing the non-conflicting remote
   * changes.
   */
  pendingMerge: { remoteSha: string; merged: Map<string, string> } | null;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function report(
  kind: SyncReport["branch"]["kind"],
  fetched: boolean,
  pushed: boolean,
  message: string,
  conflictPaths: string[] = [],
): SyncReport {
  return {
    fetched,
    pushed,
    branch: { kind, conflictPaths },
    collabRefs: { merged: 0, unchanged: 0 },
    message,
  };
}

/**
 * Run one sync pass for `branch`. `ours` is the local text worktree; `baseSha`
 * is the last remote commit we synced from (null on first sync) and
 * `baseFiles` its cached text tree (null → fetched from the API). Fetches the
 * remote head, 3-way-merges, and pushes when the merged tree differs from the
 * remote.
 */
export async function runSync(
  url: string,
  branch: string,
  ours: Map<string, string>,
  baseSha: string | null,
  baseFiles: Map<string, string> | null = null,
): Promise<SyncResult> {
  const r = parseRepo(url);
  if (r === null) throw new Error(`GitHub のリポジトリ URL として解釈できません: ${url}`);

  const head = await branchSha(r, branch);
  let remoteSha = head.sha;
  let bootstrapped = false;
  if (head.emptyRepo) {
    remoteSha = await bootstrapEmptyRepo(r, branch);
    bootstrapped = true;
  }

  // First push of this branch to a non-empty repo: parent on the default
  // branch head so the histories stay connected (compare / PR keeps working).
  if (remoteSha === null) {
    const parent = await defaultBranchSha(r);
    const sha = await push(
      r,
      branch,
      ours,
      new Map(),
      parent === null ? [] : [parent],
      "Hakushi sync",
    );
    return {
      report: report(
        "noRemoteBranch",
        false,
        true,
        "リモートブランチを新規作成して送信しました。",
      ),
      merged: null,
      conflicts: null,
      newBase: { sha, files: new Map(ours) },
      pendingMerge: null,
    };
  }

  const theirs = await treeFiles(r, remoteSha);
  let base: Map<string, string>;
  if (baseSha === remoteSha) {
    base = theirs.texts; // remote unchanged since last sync → base == theirs
  } else if (baseSha === null) {
    base = new Map();
  } else if (!(await commitExists(r, baseSha))) {
    // The base commit vanished from the remote (repo recreated / history
    // rewritten). Trusting the stale base would read every remote-missing
    // file as "deleted on the remote" and wipe it locally; an empty base is
    // the conservative fallback — nothing is deleted, real divergence
    // surfaces as conflicts.
    base = new Map();
  } else {
    base = baseFiles !== null ? baseFiles : (await treeFiles(r, baseSha)).texts;
  }

  // Per-file 3-way merge over the text trees.
  const merged = new Map<string, string>();
  const conflicts: ConflictFile[] = [];
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.texts.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.texts.get(path);
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, t); // only remote changed (incl. delete)
    } else if (b === t) {
      if (o !== undefined) merged.set(path, o); // only local changed
    } else {
      // Both diverged → conflict; keep ours in the tree for now.
      if (o !== undefined) merged.set(path, o);
      conflicts.push({ relPath: path, base: b ?? null, ours: o ?? "", theirs: t ?? "" });
    }
  }

  if (conflicts.length > 0) {
    return {
      report: report(
        "conflicts",
        true,
        false,
        `コンフリクトが ${conflicts.length} 件あります。解決してから再同期してください。`,
        conflicts.map((c) => c.relPath).sort(),
      ),
      merged: null,
      conflicts,
      newBase: null, // keep the previous base until the resolution lands
      pendingMerge: { remoteSha, merged },
    };
  }

  const pullChanged = !sameMap(merged, ours); // remote → local
  const pushNeeded = !sameMap(merged, theirs.texts); // local → remote

  let newRemoteSha = remoteSha;
  if (pushNeeded) {
    newRemoteSha = await push(r, branch, merged, theirs.passthrough, [remoteSha], "Hakushi sync");
  }

  const prefix = bootstrapped ? "空のリポジトリを初期化しました。" : "";
  const kind: SyncReport["branch"]["kind"] =
    pullChanged && pushNeeded
      ? "merged"
      : pullChanged
        ? "fastForward"
        : "upToDate";
  const message =
    pullChanged && pushNeeded
      ? `${prefix}リモートとローカルの変更をマージして同期しました。`
      : pullChanged
        ? `${prefix}リモートの変更を取り込みました。`
        : pushNeeded
          ? `${prefix}変更をアップロードしました。`
          : `${prefix}同期済みです（変更なし）。`;

  return {
    report: report(kind, true, pushNeeded, message),
    merged: pullChanged ? merged : null,
    conflicts: null,
    newBase: { sha: newRemoteSha, files: merged },
    pendingMerge: null,
  };
}

// ---------------------------------------------------------------------------
// Collab refs sync — refs/hakushi/* event chains over the Git Data API
// (INTERFACES.md §10.1 wire format, §11.3 deterministic union merge)
// ---------------------------------------------------------------------------
//
// Desktop stores each Issue/PR as a git ref whose commits are empty-tree
// commits carrying one canonical JSON event per commit message. The web
// backend keeps its events in JSONL meta files instead, so sync means:
// read the remote chains, union-merge event SETS with the local logs, adopt
// missing events locally, and rebuild+force-push chains that lack local
// events. The rebuild follows the same deterministic rules as the Rust side
// (sort by (ts, canonical-json), author from the event, email hakushi@local,
// both timestamps = event ts) so rebuilt chains converge byte-identically
// across clones.

/** One event alongside its canonical single-line JSON (dedup/sort key). */
export interface CanonEvent {
  ts: number;
  author: string;
  canonical: string;
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (typeof v === "object" && v !== null) {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

/**
 * Canonicalize an event line exactly like the Rust side (collab/sync.rs
 * `canonicalize` + refs.rs `Event`): key order (v, type, ts, author, data),
 * data keys sorted recursively, missing data → null, unknown keys dropped.
 * Unparseable lines fall back to their raw trimmed text with ts 0 so a
 * malformed event can never brick the merge.
 */
export function canonicalizeEventLine(line: string): CanonEvent {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) {
      const o = parsed as Record<string, unknown>;
      if (
        typeof o.v === "number" &&
        Number.isInteger(o.v) &&
        o.v >= 0 &&
        typeof o.type === "string" &&
        typeof o.ts === "number" &&
        Number.isInteger(o.ts) &&
        typeof o.author === "string"
      ) {
        const canonical = JSON.stringify({
          v: o.v,
          type: o.type,
          ts: o.ts,
          author: o.author,
          data: o.data === undefined ? null : sortKeysDeep(o.data),
        });
        return { ts: o.ts, author: o.author, canonical };
      }
    }
  } catch {
    /* fall through to the raw-line fallback */
  }
  return { ts: 0, author: "", canonical: line.trim() };
}

/** Deduped union of two event lists, ordered by (ts, canonical-json). */
export function unionEvents(a: readonly CanonEvent[], b: readonly CanonEvent[]): CanonEvent[] {
  const byCanon = new Map<string, CanonEvent>();
  for (const e of [...a, ...b]) if (!byCanon.has(e.canonical)) byCanon.set(e.canonical, e);
  return [...byCanon.values()].sort(
    (x, y) => x.ts - y.ts || (x.canonical < y.canonical ? -1 : x.canonical > y.canonical ? 1 : 0),
  );
}

/** Local collab logs by kind and id (raw JSONL lines, as stored in meta). */
export interface CollabLogs {
  issues: Map<string, string[]>;
  prs: Map<string, string[]>;
}

/** Cached remote chain tips (ref name → {sha, canonical event set}). */
export type CollabTipCache = Record<string, { sha: string; events: string[] }>;

export interface CollabSyncResult {
  /** Updated local logs; only refs whose event set grew are rewritten. */
  logs: CollabLogs;
  /** Ids (as "<kind>/<id>") whose LOCAL log changed and must be re-persisted. */
  changedLocal: string[];
  report: CollabRefsReport;
  newTipCache: CollabTipCache;
}

async function listHakushiRefs(r: Repo): Promise<Map<string, string>> {
  try {
    const refs = await api<{ ref: string; object: { sha: string } }[]>(
      "GET",
      `/repos/${r.owner}/${r.repo}/git/matching-refs/hakushi/`,
    );
    return new Map(refs.map((x) => [x.ref, x.object.sha]));
  } catch (e) {
    // 409: empty repo (no refs at all). 404: matching-refs may 404 on some
    // setups instead of returning [] — either way: nothing to merge.
    if (e instanceof GitHubApiError && (e.status === 404 || e.status === 409)) return new Map();
    throw e;
  }
}

/** Walk a chain tip → root along first parents; returns messages ts-ascending. */
async function readChainEvents(r: Repo, tipSha: string): Promise<string[]> {
  const out: string[] = [];
  let sha: string | null = tipSha;
  let guard = 0;
  while (sha !== null) {
    if (++guard > 10_000) throw new Error("Issue/PR のイベント履歴が長すぎます");
    const c: { message: string; parents: { sha: string }[] } = await api(
      "GET",
      `/repos/${r.owner}/${r.repo}/git/commits/${sha}`,
    );
    out.push(c.message);
    sha = c.parents.length > 0 ? c.parents[0].sha : null;
  }
  return out.reverse();
}

/** Epoch seconds → the ISO form GitHub's commit API accepts (second precision). */
function isoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Rebuild one chain from scratch: one empty-tree commit per event, parented
 * in order. Deterministic — same rules as the Rust `append_ref_event_raw`
 * (author name from the event, email fixed, both dates = event ts).
 */
async function buildChain(r: Repo, events: readonly CanonEvent[]): Promise<string> {
  let parent: string | null = null;
  for (const ev of events) {
    const ident = {
      name: ev.author === "" ? "Hakushi" : ev.author,
      email: "hakushi@local",
      date: isoDate(ev.ts),
    };
    const res: { sha: string } = await api("POST", `/repos/${r.owner}/${r.repo}/git/commits`, {
      message: ev.canonical,
      tree: EMPTY_TREE_SHA,
      parents: parent === null ? [] : [parent],
      author: ident,
      committer: ident,
    });
    parent = res.sha;
  }
  if (parent === null) throw new Error("イベントのないチェーンは作れません");
  return parent;
}

async function setHakushiRef(r: Repo, refName: string, sha: string, create: boolean): Promise<void> {
  if (create) {
    await api("POST", `/repos/${r.owner}/${r.repo}/git/refs`, { ref: refName, sha });
  } else {
    // Force: a rebuilt chain rewrites history by design (union merge, §11.3).
    await api("PATCH", `/repos/${r.owner}/${r.repo}/git/refs/${refName.replace(/^refs\//, "")}`, {
      sha,
      force: true,
    });
  }
}

/**
 * Union-merge every collab ref against the remote. Local logs adopt remote
 * events they lack (returned via `changedLocal`); remote chains lacking local
 * events are deterministically rebuilt and force-pushed. `merged` counts refs
 * whose local log changed; `unchanged` counts refs already in sync (including
 * local-only refs that only needed a push) — the same semantics as the
 * desktop union merge.
 */
export async function syncCollabRefs(
  url: string,
  local: CollabLogs,
  tipCache: CollabTipCache = {},
): Promise<CollabSyncResult> {
  const r = parseRepo(url);
  if (r === null) throw new Error(`GitHub のリポジトリ URL として解釈できません: ${url}`);

  const remoteRefs = await listHakushiRefs(r);
  const logs: CollabLogs = { issues: new Map(local.issues), prs: new Map(local.prs) };
  const changedLocal: string[] = [];
  const newTipCache: CollabTipCache = {};
  let merged = 0;
  let unchanged = 0;

  const suffixes = new Set<string>();
  for (const id of local.issues.keys()) suffixes.add(`issues/${id}`);
  for (const id of local.prs.keys()) suffixes.add(`prs/${id}`);
  for (const ref of remoteRefs.keys()) {
    const s = ref.replace(/^refs\/hakushi\//, "");
    if (/^(issues|prs)\/[^/]+$/.test(s)) suffixes.add(s);
  }

  for (const s of [...suffixes].sort()) {
    const slash = s.indexOf("/");
    const kind = s.slice(0, slash) as "issues" | "prs";
    const id = s.slice(slash + 1);
    const refName = `refs/hakushi/${s}`;
    const map = kind === "issues" ? logs.issues : logs.prs;

    const localEvents = (map.get(id) ?? []).map(canonicalizeEventLine);
    const remoteSha = remoteRefs.get(refName) ?? null;
    let remoteEvents: CanonEvent[];
    const cached = tipCache[refName];
    if (remoteSha === null) {
      remoteEvents = [];
    } else if (cached !== undefined && cached.sha === remoteSha) {
      remoteEvents = cached.events.map(canonicalizeEventLine);
    } else {
      remoteEvents = (await readChainEvents(r, remoteSha)).map(canonicalizeEventLine);
    }

    const localSet = new Set(localEvents.map((e) => e.canonical));
    const remoteSet = new Set(remoteEvents.map((e) => e.canonical));
    const union = unionEvents(localEvents, remoteEvents);
    const localMissing = [...remoteSet].some((k) => !localSet.has(k));
    const remoteMissing = [...localSet].some((k) => !remoteSet.has(k));

    let tipSha = remoteSha;
    if (remoteMissing) {
      tipSha = await buildChain(r, union);
      await setHakushiRef(r, refName, tipSha, remoteSha === null);
    }
    if (localMissing) {
      map.set(id, union.map((e) => e.canonical));
      changedLocal.push(s);
      merged += 1;
    } else {
      unchanged += 1;
    }
    if (tipSha !== null) {
      newTipCache[refName] = { sha: tipSha, events: union.map((e) => e.canonical) };
    }
  }

  return { logs, changedLocal, report: { merged, unchanged }, newTipCache };
}
