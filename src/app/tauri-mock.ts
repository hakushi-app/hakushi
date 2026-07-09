// Track U — DEV-ONLY in-memory mock backend (INTERFACES.md §5.7).
//
// When `window.__TAURI_INTERNALS__` is absent (plain-browser `vite dev`,
// vitest), workspace.ts routes every call here instead of to Tauri. Full UI
// flows (tree, edit, save, move/rename/delete, index, embeds) can then be
// driven in a normal browser for development and E2E checks.
//
// This module MUST NOT affect production behavior: inside Tauri it is never
// selected (see `isTauri()` in workspace.ts).
//
// M4 (INTERFACES.md §7.3): an in-memory pseudo git backs the GitPanel in the
// browser — a linear list of commits per branch (each holding a full snapshot
// of the files map), status computed against the current branch head,
// create/checkout branch (checkout requires a clean tree and swaps the live
// files), file-at-commit and revert-file.

import type {
  BacklinkRecord,
  ConflictFile,
  GitBranchInfo,
  GitCommitInfo,
  GitStatusEntry,
  IssueSummary,
  MergeOutcome,
  PagePut,
  PageRecord,
  PrSummary,
  SyncReport,
  TreeEntry,
  WorkspaceBackend,
} from "./workspace";
import { refPointsTo } from "./paths";

export const MOCK_WORKSPACE_ROOT = "/mock-workspace";

// ---------------------------------------------------------------------------
// Seed content (canonical markdown, matching the pipeline's output style)
// ---------------------------------------------------------------------------

const SEED_FILES: Record<string, string> = {
  "Welcome.md": `---
id: 01JAR000000000000000000001
title: Welcome
created: 2026-07-01
---

# 白紙 Hakushi へようこそ

これはブラウザ開発用のモックワークスペースです（Tauri 外でのみ使われます）。

- [ノート](Notes.md)
- [プロジェクト](Projects/index.md)
`,
  "Notes.md": `---
id: 01JAR000000000000000000002
title: Notes
created: 2026-07-01
---

日々のメモ。[Welcome](Welcome.md) に戻る。

::embed[Roadmap]{page="Projects/Roadmap.md"}
`,
  // Folder note: body is embeds only → rendered as a folder page.
  "Projects/index.md": `---
id: 01JAR000000000000000000003
title: Projects
created: 2026-07-01
---

::embed{page="Projects/Roadmap.md"}

::embed{page="Projects/Tasks.md"}
`,
  "Projects/Roadmap.md": `---
id: 01JAR000000000000000000004
title: Roadmap
created: 2026-07-01
---

# Roadmap

- M0: skeleton
- M1: dual editors
- M2: nested pages / embeds / link index
`,
  // Kanban template page (DESIGN.md §テンプレート).
  "Projects/Tasks.md": `---
id: 01JAR000000000000000000005
title: Tasks
template: kanban
created: 2026-07-01
kanban:
  columns:
    - Backlog
    - In Progress
    - Done
---

## Backlog

- [ ] Design AST adapter

## In Progress

- [ ] Editor sync spike

## Done

- [x] Repo skeleton
`,
};

// rel path → file content. Single mock workspace; the `root` argument of the
// backend methods is ignored.
const files = new Map<string, string>(Object.entries(SEED_FILES));

// Naive in-memory index: rel path → PagePut (same lookup semantics as the
// SQLite index, INTERFACES.md §5.3).
const index = new Map<string, PagePut>();

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
}

function ciCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build a TreeEntry tree from flat rel paths with the list_tree contract:
 * directories first, then files, each sorted case-insensitively; dirs get
 * `children: []` (never null), files get `children: null`. Exported for
 * reuse by unit tests (fake fs).
 */
export function buildTreeFromPaths(relPaths: string[]): TreeEntry[] {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const rel of relPaths) {
    const segs = rel.split("/");
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = node.dirs.get(segs[i]);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segs[i], next);
      }
      node = next;
    }
    node.files.push(segs[segs.length - 1]);
  }
  const toEntries = (node: DirNode, prefix: string): TreeEntry[] => {
    const dirs = [...node.dirs.keys()].sort(ciCompare).map((name): TreeEntry => {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      return {
        name,
        relPath: rel,
        isDir: true,
        children: toEntries(node.dirs.get(name) as DirNode, rel),
      };
    });
    const mdFiles = node.files
      .filter((n) => /\.md$/i.test(n))
      .sort(ciCompare)
      .map(
        (name): TreeEntry => ({
          name,
          relPath: prefix === "" ? name : `${prefix}/${name}`,
          isDir: false,
          children: null,
        }),
      );
    return [...dirs, ...mdFiles];
  };
  return toEntries(root, "");
}

// ---------------------------------------------------------------------------
// Pseudo git (INTERFACES.md §7.3 — in-memory commits + blob snapshots)
// ---------------------------------------------------------------------------

interface MockCommit {
  oid: string;
  message: string;
  /** Epoch seconds. */
  timestamp: number;
  parent: string | null;
  /** Full snapshot of the files map at commit time. */
  snapshot: Map<string, string>;
}

const commits = new Map<string, MockCommit>(); // oid → commit
const branchHeads = new Map<string, string>(); // branch name → head oid
let currentBranch = "main";
let oidCounter = 0;

/** Deterministic fake 40-hex OIDs: 0000…0001, 0000…0002, … */
function nextOid(): string {
  oidCounter += 1;
  return oidCounter.toString(16).padStart(40, "0");
}

function headCommit(): MockCommit | null {
  const oid = branchHeads.get(currentBranch);
  if (oid === undefined) return null;
  return commits.get(oid) ?? null;
}

/** Worktree status vs the current branch head (new/modified/deleted). */
function computeStatus(): GitStatusEntry[] {
  const snap = headCommit()?.snapshot ?? new Map<string, string>();
  const out: GitStatusEntry[] = [];
  for (const [rel, content] of files) {
    const old = snap.get(rel);
    if (old === undefined) out.push({ relPath: rel, status: "new" });
    else if (old !== content) out.push({ relPath: rel, status: "modified" });
  }
  for (const rel of snap.keys()) {
    if (!files.has(rel)) out.push({ relPath: rel, status: "deleted" });
  }
  out.sort((a, b) => ciCompare(a.relPath, b.relPath));
  return out;
}

/** Did `commit` add/change/remove `relPath` relative to its parent? */
function commitTouches(commit: MockCommit, relPath: string): boolean {
  const parent = commit.parent === null ? null : commits.get(commit.parent) ?? null;
  return (parent?.snapshot.get(relPath) ?? null) !== (commit.snapshot.get(relPath) ?? null);
}

// Seed one initial commit of the seed pages so 履歴 has content in the
// browser right after startup.
{
  const oid = nextOid();
  commits.set(oid, {
    oid,
    message: "初期コミット: シードページ",
    timestamp: Math.floor(Date.parse("2026-07-01T09:00:00Z") / 1000),
    parent: null,
    snapshot: new Map(files),
  });
  branchHeads.set(currentBranch, oid);
}

// ---------------------------------------------------------------------------
// Pseudo collab (INTERFACES.md §10.2 — in-memory issue/PR event logs + merge)
// ---------------------------------------------------------------------------
//
// Events are stored exactly as the real backend stores them: one JSON string
// per event (§10.1 schema). Summaries are derived on every list call; events
// come back sorted by `ts` ascending (stable for equal ts). Malformed JSON is
// kept in the log (append is dumb, like a git commit message) but skipped
// when deriving summaries — the typed parse lives in src/collab-ui/events.ts.

const issueLogs = new Map<string, string[]>(); // issue id → event JSON lines
const prLogs = new Map<string, string[]>(); // pr id → event JSON lines
let collabIdCounter = 0;

/** Deterministic fake 26-char ULID-shaped ids: 01JARCLB…0001, …0002, … */
function nextCollabId(): string {
  collabIdCounter += 1;
  return `01JARCLB${String(collabIdCounter).padStart(18, "0")}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

interface RawEvent {
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

/** Lenient parse for summary derivation; null for malformed lines. */
function rawEvent(json: string): RawEvent | null {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.type !== "string" || typeof o.ts !== "number") return null;
    const data =
      typeof o.data === "object" && o.data !== null
        ? (o.data as Record<string, unknown>)
        : {};
    return { type: o.type, ts: o.ts, data };
  } catch {
    return null;
  }
}

/** Sort JSON event lines by ts ascending (stable; malformed lines last). */
function sortedEvents(log: readonly string[]): string[] {
  return log
    .map((json, i) => ({ json, i, ts: rawEvent(json)?.ts ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map((e) => e.json);
}

function deriveIssueSummary(id: string, log: readonly string[]): IssueSummary {
  let title = "(no title)";
  let state = "open";
  let commentCount = 0;
  let updatedTs = 0;
  for (const json of sortedEvents(log)) {
    const ev = rawEvent(json);
    if (ev === null) continue;
    updatedTs = Math.max(updatedTs, ev.ts);
    if (ev.type === "create" && typeof ev.data.title === "string") title = ev.data.title;
    else if (ev.type === "comment") commentCount += 1;
    else if (ev.type === "close") state = "closed";
    else if (ev.type === "reopen") state = "open";
  }
  return { id, title, state, commentCount, updatedTs };
}

function derivePrSummary(id: string, log: readonly string[]): PrSummary {
  let title = "(no title)";
  let state = "open";
  let source = "";
  let target = "";
  let updatedTs = 0;
  for (const json of sortedEvents(log)) {
    const ev = rawEvent(json);
    if (ev === null) continue;
    updatedTs = Math.max(updatedTs, ev.ts);
    if (ev.type === "create") {
      if (typeof ev.data.title === "string") title = ev.data.title;
      if (typeof ev.data.source === "string") source = ev.data.source;
      if (typeof ev.data.target === "string") target = ev.data.target;
    } else if (ev.type === "status" && typeof ev.data.state === "string") {
      state = ev.data.state;
    }
  }
  return { id, title, state, source, target, updatedTs };
}

function eventLine(type: string, ts: number, data: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, type, ts, author: "mock", data });
}

// Seed one sample issue so the Issues tab has content right after startup
// (deterministic id + timestamps, like the seed commit above).
{
  const id = nextCollabId();
  const t0 = Math.floor(Date.parse("2026-07-01T09:05:00Z") / 1000);
  issueLogs.set(id, [
    eventLine("create", t0, {
      title: "サンプル Issue: Welcome ページの文言を見直す",
      body: "ブラウザ開発用のシード Issue です。コメント・クローズ・再オープンを試せます。",
    }),
    eventLine("comment", t0 + 300, { body: "コメントの例です。" }),
  ]);
}

/** Parent-chain OIDs of `oid`, nearest first (including itself). */
function ancestryOf(oid: string): string[] {
  const out: string[] = [];
  let cur: MockCommit | null = commits.get(oid) ?? null;
  while (cur !== null) {
    out.push(cur.oid);
    cur = cur.parent === null ? null : commits.get(cur.parent) ?? null;
  }
  return out;
}

/** Paths whose content differs between two snapshots. */
function changedPaths(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const key of new Set([...base.keys(), ...head.keys()])) {
    if ((base.get(key) ?? null) !== (head.get(key) ?? null)) out.add(key);
  }
  return out;
}

/** Replace the live worktree files with a commit snapshot. */
function applySnapshot(snap: ReadonlyMap<string, string>): void {
  files.clear();
  for (const [rel, content] of snap) files.set(rel, content);
}

// ---------------------------------------------------------------------------
// Pseudo sync (INTERFACES.md §11.2 — remote URL + PAT + git_sync simulation)
// ---------------------------------------------------------------------------
//
// Simulates the M7 sync surface so the SyncSettings modal, the 今すぐ同期 flow,
// and the sidebar status line are fully exercisable in a plain browser:
//   - no remote configured → gitSync rejects with "リモートが設定されていません";
//   - after gitRemoteSet, gitSync returns a plausible success SyncReport
//     (fastForward, collabRefs {merged:1, unchanged:2});
//   - the sentinel URL below produces a `conflicts` report with one path so the
//     warning-colored status line (and the M8 resolution notice) can be tested;
//   - credentialHas mirrors the mock set/clear (never stores the token value).

/** Sentinel remote URL that makes the mock gitSync report a conflict. */
export const MOCK_CONFLICT_URL = "mock://conflict";

/**
 * Sentinel `source` the ConflictResolver is launched with after a *sync*
 * conflict (there is no incoming branch name in the sync flow). The mock's
 * gitConflictVersions / gitMergeResolve accept this as well as a real branch
 * name, so the resolver drives end-to-end from either entry point.
 */
// Must equal workspace.ts `SYNC_CONFLICT_SOURCE` and the Rust libgit2
// `SYNC_CONFLICT_SOURCE` literal. Kept as a local literal (not a runtime import
// of the workspace constant) because workspace.ts imports this module — a value
// import would create a circular-init TDZ hazard; this module must only import
// *types* from workspace.ts.
export const MOCK_CONFLICT_SYNC_SOURCE = "__sync__";

let mockRemoteUrl: string | null = null;
/** Hosts with a stored PAT (value intentionally not kept — mirrors keyring). */
const mockCredentialHosts = new Set<string>();

// ---------------------------------------------------------------------------
// Pseudo conflict resolution (INTERFACES.md §12.1 — semantic merge material)
// ---------------------------------------------------------------------------
//
// A pending conflict is recorded whenever a mock merge/sync detects a genuine
// same-block divergence, then handed to the ConflictResolver via
// gitConflictVersions. Resolving writes the chosen content back into the
// worktree and finishes with a fake merge commit oid. This lets the full M8
// flow (sync/merge → resolver → 選択 → 完了) run in a plain browser.

/**
 * The mock's stock conflict: Welcome.md where BOTH sides changed the same
 * paragraph, plus a non-overlapping edit that semanticMerge3 auto-merges. The
 * shared paragraph becomes a `conflict` block; everything else is `auto`.
 */
const MOCK_CONFLICT_WELCOME: { base: string; ours: string; theirs: string } = {
  base: `---
id: 01JAR000000000000000000001
title: Welcome
created: 2026-07-01
---

# 白紙 Hakushi へようこそ

これはブラウザ開発用のモックワークスペースです。

- [ノート](Notes.md)
`,
  ours: `---
id: 01JAR000000000000000000001
title: Welcome
created: 2026-07-01
---

# 白紙 Hakushi へようこそ

これはブラウザ開発用のモックワークスペースです。（あなたが追記しました）

- [ノート](Notes.md)
- [新しいページ](New.md)
`,
  theirs: `---
id: 01JAR000000000000000000001
title: Welcome
created: 2026-07-01
---

# 白紙 Hakushi へようこそ

これはブラウザ開発用のモックワークスペースです。（相手が追記しました）

- [ノート](Notes.md)
`,
};

/** Files currently in a recorded, unresolved conflict (relPath → 3 versions). */
const pendingConflicts = new Map<
  string,
  { base: string | null; ours: string; theirs: string }
>();

/** Seed the stock Welcome conflict so the resolver has material to show. */
function recordWelcomeConflict(): void {
  pendingConflicts.set("Welcome.md", { ...MOCK_CONFLICT_WELCOME });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDirPrefix(relPath: string): boolean {
  const prefix = `${relPath}/`;
  for (const key of files.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

function exists(relPath: string): boolean {
  return files.has(relPath) || hasDirPrefix(relPath);
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export const mockBackend: WorkspaceBackend = {
  async openWorkspaceDialog() {
    // No folder picker outside Tauri; stay in the mock workspace.
    console.info("[hakushi mock] folder picker is unavailable in the browser; using the mock workspace");
    return MOCK_WORKSPACE_ROOT;
  },

  async ensureDefaultWorkspace() {
    return MOCK_WORKSPACE_ROOT;
  },

  async listTree() {
    return buildTreeFromPaths([...files.keys()]);
  },

  async readFile(_root, relPath) {
    const content = files.get(relPath);
    if (content === undefined) throw new Error(`mock: file not found: ${relPath}`);
    return content;
  },

  async writeFile(_root, relPath, content) {
    files.set(relPath, content);
  },

  async createPage(_root, relPath, content) {
    if (exists(relPath)) throw new Error(`mock: already exists: ${relPath}`);
    files.set(relPath, content);
  },

  async renamePath(_root, fromRel, toRel) {
    if (exists(toRel)) throw new Error(`mock: destination already exists: ${toRel}`);
    if (files.has(fromRel)) {
      const content = files.get(fromRel) as string;
      files.delete(fromRel);
      files.set(toRel, content);
      return;
    }
    if (hasDirPrefix(fromRel)) {
      if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
        throw new Error("mock: cannot move a directory into itself");
      }
      const prefix = `${fromRel}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) {
          const content = files.get(key) as string;
          files.delete(key);
          files.set(toRel + key.slice(fromRel.length), content);
        }
      }
      return;
    }
    throw new Error(`mock: not found: ${fromRel}`);
  },

  async deletePath(_root, relPath) {
    if (files.delete(relPath)) return;
    if (hasDirPrefix(relPath)) {
      const prefix = `${relPath}/`;
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
      return;
    }
    throw new Error(`mock: not found: ${relPath}`);
  },

  async indexPutPages(_root, pages) {
    for (const put of pages) index.set(put.page.relPath, put);
  },

  async indexRemovePages(_root, relPaths) {
    for (const rel of relPaths) index.delete(rel);
  },

  async indexClear() {
    index.clear();
  },

  async indexLookup(_root, idOrPath): Promise<PageRecord | null> {
    // Contract order: id exact → relPath exact → completion.
    for (const put of index.values()) {
      if (put.page.id !== null && put.page.id === idOrPath) return { ...put.page };
    }
    const direct = index.get(idOrPath);
    if (direct !== undefined) return { ...direct.page };
    for (const cand of [`${idOrPath}.md`, `${idOrPath}/index.md`]) {
      const hit = index.get(cand);
      if (hit !== undefined) return { ...hit.page };
    }
    return null;
  },

  async indexBacklinks(_root, relPath): Promise<BacklinkRecord[]> {
    const target = { relPath, id: index.get(relPath)?.page.id ?? null };
    const out: BacklinkRecord[] = [];
    for (const put of index.values()) {
      for (const ref of put.refs) {
        if (refPointsTo(put.page.relPath, ref.kind, ref.target, target)) {
          out.push({ srcRelPath: put.page.relPath, kind: ref.kind, target: ref.target });
        }
      }
    }
    return out;
  },

  // --- Pseudo git (INTERFACES.md §7.3) --------------------------------------

  async gitStatus(): Promise<GitStatusEntry[]> {
    return computeStatus();
  },

  async gitCommit(_root, message): Promise<string> {
    if (computeStatus().length === 0) {
      throw new Error("mock git: nothing to commit (worktree clean)");
    }
    const oid = nextOid();
    commits.set(oid, {
      oid,
      message,
      timestamp: Math.floor(Date.now() / 1000),
      parent: branchHeads.get(currentBranch) ?? null,
      snapshot: new Map(files),
    });
    branchHeads.set(currentBranch, oid);
    return oid;
  },

  async gitLog(_root, relPath, limit): Promise<GitCommitInfo[]> {
    const max = limit ?? 100;
    const out: GitCommitInfo[] = [];
    let cur = headCommit();
    while (cur !== null && out.length < max) {
      if (relPath === null || commitTouches(cur, relPath)) {
        out.push({
          oid: cur.oid,
          summary: cur.message.split("\n", 1)[0],
          authorName: "mock",
          timestamp: cur.timestamp,
        });
      }
      cur = cur.parent === null ? null : commits.get(cur.parent) ?? null;
    }
    return out;
  },

  async gitBranches(): Promise<GitBranchInfo> {
    return { current: currentBranch, branches: [...branchHeads.keys()].sort() };
  },

  async gitCreateBranch(_root, name) {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("mock git: ブランチ名が空です");
    if (branchHeads.has(trimmed)) {
      throw new Error(`mock git: ブランチは既に存在します: ${trimmed}`);
    }
    const head = branchHeads.get(currentBranch);
    if (head === undefined) throw new Error("mock git: コミットがありません");
    branchHeads.set(trimmed, head);
  },

  async gitCheckoutBranch(_root, name) {
    const head = branchHeads.get(name);
    if (head === undefined) throw new Error(`mock git: ブランチがありません: ${name}`);
    if (computeStatus().length > 0) {
      throw new Error(
        "mock git: 未コミットの変更があります。commit or discard changes first",
      );
    }
    currentBranch = name;
    // Checkout swaps the live files to the target branch head snapshot.
    const snap = commits.get(head)?.snapshot ?? new Map<string, string>();
    files.clear();
    for (const [rel, content] of snap) files.set(rel, content);
  },

  async gitFileAtCommit(_root, relPath, oid): Promise<string | null> {
    const commit = commits.get(oid);
    if (commit === undefined) throw new Error(`mock git: 不明なコミット: ${oid}`);
    return commit.snapshot.get(relPath) ?? null;
  },

  async gitRevertFile(_root, relPath, oid) {
    const commit = commits.get(oid);
    if (commit === undefined) throw new Error(`mock git: 不明なコミット: ${oid}`);
    const content = commit.snapshot.get(relPath);
    if (content === undefined) {
      throw new Error(
        `mock git: ${relPath} はコミット ${oid.slice(0, 8)} に存在しません`,
      );
    }
    files.set(relPath, content);
  },

  async gitBackendInfo() {
    return {
      name: "mock",
      capabilities: {
        init: true,
        status: true,
        commit: true,
        log: true,
        branch: true,
        // M6: the mock implements gitMergeBranch so the PR merge flow is
        // exercisable in the browser (INTERFACES.md §10.3).
        merge: true,
        push: false,
        pull: false,
      },
    };
  },

  // --- Pseudo collab (INTERFACES.md §10.2) -----------------------------------

  async collabCreateIssue(_root, title, body): Promise<string> {
    const id = nextCollabId();
    issueLogs.set(id, [eventLine("create", nowSec(), { title, body })]);
    return id;
  },

  async collabIssueEvent(_root, id, eventJson) {
    const log = issueLogs.get(id);
    if (log === undefined) throw new Error(`mock collab: issue が見つかりません: ${id}`);
    log.push(eventJson);
  },

  async collabListIssues(): Promise<IssueSummary[]> {
    return [...issueLogs]
      .map(([id, log]) => deriveIssueSummary(id, log))
      .sort((a, b) => b.updatedTs - a.updatedTs || a.id.localeCompare(b.id));
  },

  async collabGetIssue(_root, id): Promise<string[]> {
    const log = issueLogs.get(id);
    if (log === undefined) throw new Error(`mock collab: issue が見つかりません: ${id}`);
    return sortedEvents(log);
  },

  async collabCreatePr(_root, title, body, source, target): Promise<string> {
    const id = nextCollabId();
    prLogs.set(id, [eventLine("create", nowSec(), { title, body, source, target })]);
    return id;
  },

  async collabPrEvent(_root, id, eventJson) {
    const log = prLogs.get(id);
    if (log === undefined) throw new Error(`mock collab: PR が見つかりません: ${id}`);
    log.push(eventJson);
  },

  async collabListPrs(): Promise<PrSummary[]> {
    return [...prLogs]
      .map(([id, log]) => derivePrSummary(id, log))
      .sort((a, b) => b.updatedTs - a.updatedTs || a.id.localeCompare(b.id));
  },

  async collabGetPr(_root, id): Promise<string[]> {
    const log = prLogs.get(id);
    if (log === undefined) throw new Error(`mock collab: PR が見つかりません: ${id}`);
    return sortedEvents(log);
  },

  /**
   * Merge `source` into the current branch, approximated on the mock's
   * full-snapshot commits (INTERFACES.md §10.2):
   *   - fastForward when the current head is an ancestor of the source head
   *     (or the source brings nothing new);
   *   - conflicts when both sides changed the same file (differently) since
   *     the fork point — worktree untouched;
   *   - merged otherwise: source-side changes applied on top of the current
   *     snapshot as a new commit.
   */
  async gitMergeBranch(_root, source): Promise<MergeOutcome> {
    const srcHead = branchHeads.get(source);
    if (srcHead === undefined) throw new Error(`mock git: ブランチがありません: ${source}`);
    if (source === currentBranch) {
      throw new Error("mock git: 現在のブランチ自身はマージできません");
    }
    if (computeStatus().length > 0) {
      throw new Error(
        "mock git: 未コミットの変更があります。commit or discard changes first",
      );
    }
    const curHead = branchHeads.get(currentBranch);
    if (curHead === undefined) throw new Error("mock git: コミットがありません");

    const srcChain = ancestryOf(srcHead);
    if (srcHead === curHead || ancestryOf(curHead).includes(srcHead)) {
      // Source is already contained in the current branch: nothing to do.
      return { kind: "fastForward", conflictPaths: [] };
    }
    if (srcChain.includes(curHead)) {
      // Current head is an ancestor of the source head: fast-forward.
      const snap = (commits.get(srcHead) as MockCommit).snapshot;
      branchHeads.set(currentBranch, srcHead);
      applySnapshot(snap);
      return { kind: "fastForward", conflictPaths: [] };
    }

    // Diverged: fork point = nearest common ancestor.
    const srcSet = new Set(srcChain);
    const baseOid = ancestryOf(curHead).find((oid) => srcSet.has(oid)) ?? null;
    const baseSnap =
      baseOid === null
        ? new Map<string, string>()
        : (commits.get(baseOid) as MockCommit).snapshot;
    const curSnap = (commits.get(curHead) as MockCommit).snapshot;
    const srcSnap = (commits.get(srcHead) as MockCommit).snapshot;
    const curChanged = changedPaths(baseSnap, curSnap);
    const srcChanged = changedPaths(baseSnap, srcSnap);
    const conflictPaths = [...srcChanged]
      .filter(
        (rel) =>
          curChanged.has(rel) && (srcSnap.get(rel) ?? null) !== (curSnap.get(rel) ?? null),
      )
      .sort(ciCompare);
    if (conflictPaths.length > 0) {
      // Record each colliding path's 3 versions so the ConflictResolver
      // (launched with this source branch) can drive resolution; abort without
      // touching the worktree (mirrors the libgit2 contract).
      pendingConflicts.clear();
      for (const rel of conflictPaths) {
        pendingConflicts.set(rel, {
          base: baseSnap.get(rel) ?? null,
          ours: curSnap.get(rel) ?? "",
          theirs: srcSnap.get(rel) ?? "",
        });
      }
      return { kind: "conflicts", conflictPaths };
    }

    const mergedSnap = new Map(curSnap);
    for (const rel of srcChanged) {
      const content = srcSnap.get(rel);
      if (content === undefined) mergedSnap.delete(rel);
      else mergedSnap.set(rel, content);
    }
    const oid = nextOid();
    commits.set(oid, {
      oid,
      message: `Merge branch '${source}'`,
      timestamp: nowSec(),
      // The mock keeps a single-parent chain; good enough for log/status.
      parent: curHead,
      snapshot: mergedSnap,
    });
    branchHeads.set(currentBranch, oid);
    applySnapshot(mergedSnap);
    return { kind: "merged", conflictPaths: [] };
  },

  // --- Pseudo sync (INTERFACES.md §11.2) ------------------------------------

  async gitRemoteGet(): Promise<string | null> {
    return mockRemoteUrl;
  },

  async gitRemoteSet(_root, url) {
    mockRemoteUrl = url.trim() === "" ? null : url.trim();
  },

  async credentialSet(host, token) {
    if (token.trim() === "") throw new Error("mock: 空のトークンは保存できません");
    mockCredentialHosts.add(host);
  },

  async credentialClear(host) {
    mockCredentialHosts.delete(host);
  },

  async credentialHas(host): Promise<boolean> {
    return mockCredentialHosts.has(host);
  },

  async gitSync(): Promise<SyncReport> {
    if (mockRemoteUrl === null) {
      throw new Error("リモートが設定されていません。同期設定でリモート URL を指定してください。");
    }
    if (mockRemoteUrl === MOCK_CONFLICT_URL) {
      // Record the material so the ConflictResolver (launched with
      // MOCK_CONFLICT_SYNC_SOURCE) can drive the full resolution flow.
      recordWelcomeConflict();
      return {
        fetched: true,
        // Conflicts skip the code-branch push; collab refs still sync.
        pushed: true,
        branch: { kind: "conflicts", conflictPaths: ["Welcome.md"] },
        collabRefs: { merged: 1, unchanged: 2 },
        message:
          "同期しました（コラボ情報）。ただし Welcome.md にコンフリクトがあり、コードの変更は送信していません。",
      };
    }
    return {
      fetched: true,
      pushed: true,
      branch: { kind: "fastForward", conflictPaths: [] },
      collabRefs: { merged: 1, unchanged: 2 },
      message: "同期が完了しました（fast-forward、コラボ ref を 1 件更新）。",
    };
  },

  // --- Pseudo conflict resolution (INTERFACES.md §12.1) ---------------------

  async gitConflictVersions(_root, _source): Promise<ConflictFile[]> {
    // `source` (real branch name or MOCK_CONFLICT_SYNC_SOURCE) is accepted but
    // the mock just replays whatever conflict was last recorded.
    return [...pendingConflicts].map(([relPath, v]) => ({
      relPath,
      base: v.base,
      ours: v.ours,
      theirs: v.theirs,
    }));
  },

  async gitMergeResolve(_root, source, resolved): Promise<string> {
    if (pendingConflicts.size === 0) {
      throw new Error("mock git: 解決するコンフリクトがありません");
    }
    // Every recorded conflict must be resolved (no partial resolution).
    const resolvedPaths = new Set(resolved.map((r) => r.relPath));
    for (const rel of pendingConflicts.keys()) {
      if (!resolvedPaths.has(rel)) {
        throw new Error(`mock git: 未解決のコンフリクトがあります: ${rel}`);
      }
    }
    // Write the resolved bytes into the worktree and commit a fake merge.
    for (const { relPath, content } of resolved) files.set(relPath, content);
    pendingConflicts.clear();
    const oid = nextOid();
    commits.set(oid, {
      oid,
      message: `Merge (resolved) '${source}'`,
      timestamp: nowSec(),
      parent: branchHeads.get(currentBranch) ?? null,
      snapshot: new Map(files),
    });
    branchHeads.set(currentBranch, oid);
    return oid;
  },
};
