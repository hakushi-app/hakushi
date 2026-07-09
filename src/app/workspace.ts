// Track U — TS-side workspace API wrapper (INTERFACES.md §2, §5.1–§5.3).
//
// Every exported function routes through a backend object:
//   - inside Tauri (`window.__TAURI_INTERNALS__` present): the real commands
//     defined in src-tauri/src/{fs_commands,workspace}.rs and the SQLite index
//   - otherwise (plain-browser vite dev, vitest): the DEV-ONLY in-memory mock
//     in tauri-mock.ts (INTERFACES.md §5.7)
//
// Note on casing: Tauri v2 converts camelCase invoke args to the Rust
// commands' snake_case parameters automatically (`relPath` → `rel_path`).
// Return values are serialized with `#[serde(rename_all = "camelCase")]`
// on the Rust side, so records arrive already in camelCase.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { mockBackend } from "./tauri-mock";
import { webGitBackend } from "./web-git/backend";

// ---------------------------------------------------------------------------
// Types (INTERFACES.md §1, §5.3)
// ---------------------------------------------------------------------------

export interface TreeEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  children: TreeEntry[] | null;
}

export interface PageRecord {
  id: string | null;
  relPath: string;
  title: string | null;
  template: string | null;
}

export interface RefRecord {
  kind: "link" | "embed";
  target: string;
}

export interface PagePut {
  page: PageRecord;
  refs: RefRecord[];
}

export interface BacklinkRecord {
  srcRelPath: string;
  kind: string;
  target: string;
}

// --- Git types (INTERFACES.md §1 Git 系, §7.1) ------------------------------

export interface GitStatusEntry {
  relPath: string;
  /** "new" | "modified" | "deleted" | "renamed" | "conflicted" */
  status: string;
}

export interface GitCommitInfo {
  /** Full hex OID. */
  oid: string;
  /** First line of the commit message. */
  summary: string;
  authorName: string;
  /** Epoch seconds. */
  timestamp: number;
}

export interface GitBranchInfo {
  /** null on unborn/detached HEAD. */
  current: string | null;
  branches: string[];
}

export interface GitCapabilities {
  init: boolean;
  status: boolean;
  commit: boolean;
  log: boolean;
  branch: boolean;
  merge: boolean;
  push: boolean;
  pull: boolean;
}

export interface GitBackendInfo {
  /** "libgit2" | "gix" (Tauri) | "mock" (browser dev). */
  name: string;
  capabilities: GitCapabilities;
}

// --- Collab types (INTERFACES.md §10.2) -------------------------------------

/** Materialized issue list row (derived from refs/hakushi/issues/<id>). */
export interface IssueSummary {
  id: string;
  title: string;
  /** "open" | "closed" */
  state: string;
  commentCount: number;
  /** Epoch seconds of the latest event. */
  updatedTs: number;
}

/** Materialized PR list row (derived from refs/hakushi/prs/<id>). */
export interface PrSummary {
  id: string;
  title: string;
  /** "open" | "merged" | "closed" */
  state: string;
  source: string;
  target: string;
  /** Epoch seconds of the latest event. */
  updatedTs: number;
}

export interface MergeOutcome {
  kind: "fastForward" | "merged" | "conflicts";
  conflictPaths: string[];
}

// --- Sync types (INTERFACES.md §11.2) --------------------------------------

/** How the current code branch was integrated during one `git_sync` pass. */
export interface BranchSyncReport {
  /**
   * "upToDate" | "fastForward" | "merged" | "conflicts" | "noRemoteBranch".
   * On "conflicts" the worktree is left untouched and the branch push is
   * skipped (collab refs still sync); the block-level resolution UI is M8.
   */
  kind: "upToDate" | "fastForward" | "merged" | "conflicts" | "noRemoteBranch";
  /** Paths that collided during a "conflicts" merge. */
  conflictPaths: string[];
}

/** Union-merge tally over `refs/hakushi/*` during one sync pass. */
export interface CollabRefsReport {
  /** Refs whose local chain changed (adopted / fast-forwarded / rebuilt). */
  merged: number;
  /** Refs already in sync (including local-only refs that only need a push). */
  unchanged: number;
}

/**
 * Result of one full `git_sync` pass (INTERFACES.md §11.2): fetch →
 * current-branch integration → collab-refs union merge → push. Rust serializes
 * `collab_refs` as `collabRefs` (camelCase), matching this type.
 */
export interface SyncReport {
  fetched: boolean;
  pushed: boolean;
  branch: BranchSyncReport;
  collabRefs: CollabRefsReport;
  /** Human-readable summary for the sidebar status line / toast. */
  message: string;
}

// --- Conflict-resolution types (INTERFACES.md §12.1) -----------------------

/**
 * The three versions of one file that collided during a merge (§12.1). `base`
 * is the merge-base content (null when the file has no common ancestor);
 * `ours`/`theirs` are the current-branch and incoming versions. Content is raw
 * markdown (frontmatter included). Rust serializes these fields camelCase.
 */
export interface ConflictFile {
  relPath: string;
  base: string | null;
  ours: string;
  theirs: string;
}

/** A fully-resolved file's final content, handed back to `git_merge_resolve`. */
export interface ResolvedFile {
  relPath: string;
  content: string;
}

/** Full backend surface; implemented by Tauri commands and the dev mock. */
export interface WorkspaceBackend {
  openWorkspaceDialog(): Promise<string | null>;
  ensureDefaultWorkspace(): Promise<string>;
  listTree(root: string): Promise<TreeEntry[]>;
  readFile(root: string, relPath: string): Promise<string>;
  writeFile(root: string, relPath: string, content: string): Promise<void>;
  createPage(root: string, relPath: string, content: string): Promise<void>;
  renamePath(root: string, fromRel: string, toRel: string): Promise<void>;
  deletePath(root: string, relPath: string): Promise<void>;
  indexPutPages(root: string, pages: PagePut[]): Promise<void>;
  indexRemovePages(root: string, relPaths: string[]): Promise<void>;
  indexClear(root: string): Promise<void>;
  indexLookup(root: string, idOrPath: string): Promise<PageRecord | null>;
  indexBacklinks(root: string, relPath: string): Promise<BacklinkRecord[]>;
  // Git (INTERFACES.md §1 Git 系, §7.1)
  gitStatus(root: string): Promise<GitStatusEntry[]>;
  gitCommit(root: string, message: string): Promise<string>;
  gitLog(
    root: string,
    relPath: string | null,
    limit: number | null,
  ): Promise<GitCommitInfo[]>;
  gitBranches(root: string): Promise<GitBranchInfo>;
  gitCreateBranch(root: string, name: string): Promise<void>;
  gitCheckoutBranch(root: string, name: string): Promise<void>;
  gitFileAtCommit(root: string, relPath: string, oid: string): Promise<string | null>;
  gitRevertFile(root: string, relPath: string, oid: string): Promise<void>;
  gitBackendInfo(): Promise<GitBackendInfo>;
  // Collab (INTERFACES.md §10.2)
  collabCreateIssue(root: string, title: string, body: string): Promise<string>;
  collabIssueEvent(root: string, id: string, eventJson: string): Promise<void>;
  collabListIssues(root: string): Promise<IssueSummary[]>;
  collabGetIssue(root: string, id: string): Promise<string[]>;
  collabCreatePr(
    root: string,
    title: string,
    body: string,
    source: string,
    target: string,
  ): Promise<string>;
  collabPrEvent(root: string, id: string, eventJson: string): Promise<void>;
  collabListPrs(root: string): Promise<PrSummary[]>;
  collabGetPr(root: string, id: string): Promise<string[]>;
  gitMergeBranch(root: string, source: string): Promise<MergeOutcome>;
  // Sync (INTERFACES.md §11.2)
  gitRemoteGet(root: string): Promise<string | null>;
  gitRemoteSet(root: string, url: string): Promise<void>;
  credentialSet(host: string, token: string): Promise<void>;
  credentialClear(host: string): Promise<void>;
  credentialHas(host: string): Promise<boolean>;
  gitSync(root: string): Promise<SyncReport>;
  // Conflict resolution (INTERFACES.md §12.1)
  gitConflictVersions(root: string, source: string): Promise<ConflictFile[]>;
  gitMergeResolve(root: string, source: string, resolved: ResolvedFile[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** Are we running inside the Tauri webview? */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Best-effort mobile (iOS/Android) detection from the webview user agent.
 * Used only to pick the touch/mobile UI branch (drawer sidebar, PDF print
 * path, §12.4/§12.6) — a false negative just keeps the desktop path, which
 * still works. Returns false in SSR/test environments without a navigator.
 */
export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Android WebView / Chrome; iOS WKWebView (iPhone/iPad; iPadOS 13+ reports
  // as "Macintosh" but is touch-capable, so also treat multi-touch Mac UAs as
  // mobile when running inside Tauri).
  if (/Android|iPhone|iPad|iPod/.test(ua)) return true;
  if (
    isTauri() &&
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1
  ) {
    return true;
  }
  return false;
}

const tauriBackend: WorkspaceBackend = {
  async openWorkspaceDialog() {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  ensureDefaultWorkspace: () => invoke<string>("ensure_default_workspace"),
  listTree: (root) => invoke<TreeEntry[]>("list_tree", { root }),
  readFile: (root, relPath) => invoke<string>("read_text_file", { root, relPath }),
  async writeFile(root, relPath, content) {
    await invoke("write_text_file", { root, relPath, content });
  },
  async createPage(root, relPath, content) {
    await invoke("create_page", { root, relPath, content });
  },
  async renamePath(root, fromRel, toRel) {
    await invoke("rename_path", { root, fromRel, toRel });
  },
  async deletePath(root, relPath) {
    await invoke("delete_path", { root, relPath });
  },
  async indexPutPages(root, pages) {
    await invoke("index_put_pages", { root, pages });
  },
  async indexRemovePages(root, relPaths) {
    await invoke("index_remove_pages", { root, relPaths });
  },
  async indexClear(root) {
    await invoke("index_clear", { root });
  },
  async indexLookup(root, idOrPath) {
    return (await invoke<PageRecord | null>("index_lookup", { root, idOrPath })) ?? null;
  },
  indexBacklinks: (root, relPath) =>
    invoke<BacklinkRecord[]>("index_backlinks", { root, relPath }),
  gitStatus: (root) => invoke<GitStatusEntry[]>("git_status", { root }),
  gitCommit: (root, message) => invoke<string>("git_commit", { root, message }),
  gitLog: (root, relPath, limit) =>
    invoke<GitCommitInfo[]>("git_log", { root, relPath, limit }),
  gitBranches: (root) => invoke<GitBranchInfo>("git_branches", { root }),
  async gitCreateBranch(root, name) {
    await invoke("git_create_branch", { root, name });
  },
  async gitCheckoutBranch(root, name) {
    await invoke("git_checkout_branch", { root, name });
  },
  async gitFileAtCommit(root, relPath, oid) {
    return (
      (await invoke<string | null>("git_file_at_commit", { root, relPath, oid })) ??
      null
    );
  },
  async gitRevertFile(root, relPath, oid) {
    await invoke("git_revert_file", { root, relPath, oid });
  },
  gitBackendInfo: () => invoke<GitBackendInfo>("git_backend_info"),
  // Collab (INTERFACES.md §10.2). Tauri v2 converts camelCase invoke args to
  // the Rust snake_case parameters (`eventJson` → `event_json`).
  collabCreateIssue: (root, title, body) =>
    invoke<string>("collab_create_issue", { root, title, body }),
  async collabIssueEvent(root, id, eventJson) {
    await invoke("collab_issue_event", { root, id, eventJson });
  },
  collabListIssues: (root) => invoke<IssueSummary[]>("collab_list_issues", { root }),
  collabGetIssue: (root, id) => invoke<string[]>("collab_get_issue", { root, id }),
  collabCreatePr: (root, title, body, source, target) =>
    invoke<string>("collab_create_pr", { root, title, body, source, target }),
  async collabPrEvent(root, id, eventJson) {
    await invoke("collab_pr_event", { root, id, eventJson });
  },
  collabListPrs: (root) => invoke<PrSummary[]>("collab_list_prs", { root }),
  collabGetPr: (root, id) => invoke<string[]>("collab_get_pr", { root, id }),
  gitMergeBranch: (root, source) =>
    invoke<MergeOutcome>("git_merge_branch", { root, source }),
  // Sync (INTERFACES.md §11.2). The token never crosses back to TS: only
  // set/clear/has commands exist (no credential_get).
  async gitRemoteGet(root) {
    return (await invoke<string | null>("git_remote_get", { root })) ?? null;
  },
  async gitRemoteSet(root, url) {
    await invoke("git_remote_set", { root, url });
  },
  async credentialSet(host, token) {
    await invoke("credential_set", { host, token });
  },
  async credentialClear(host) {
    await invoke("credential_clear", { host });
  },
  credentialHas: (host) => invoke<boolean>("credential_has", { host }),
  gitSync: (root) => invoke<SyncReport>("git_sync", { root }),
  // Conflict resolution (INTERFACES.md §12.1). Tauri v2 converts camelCase
  // args to the Rust snake_case parameters.
  gitConflictVersions: (root, source) =>
    invoke<ConflictFile[]>("git_conflict_versions", { root, source }),
  gitMergeResolve: (root, source, resolved) =>
    invoke<string>("git_merge_resolve", { root, source, resolved }),
};

let selected: WorkspaceBackend | null = null;

function backend(): WorkspaceBackend {
  if (selected === null) {
    if (isTauri()) {
      selected = tauriBackend;
    } else if (typeof indexedDB !== "undefined") {
      // Real browser (production web): persistent isomorphic-git + lightning-fs
      // backend with GitHub-API remote sync (no CORS proxy).
      selected = webGitBackend;
    } else {
      // jsdom / vitest — no IndexedDB; keep the in-memory dev mock.
      selected = mockBackend;
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Public API — thin pass-throughs to the active backend
// ---------------------------------------------------------------------------

/**
 * Ask the user to pick a workspace folder (secondary flow: 「別のフォルダを
 * 開く…」). Returns the absolute path, or null if the dialog was cancelled.
 */
export async function openWorkspace(): Promise<string | null> {
  return backend().openWorkspaceDialog();
}

/**
 * Create/open the app-managed default workspace (INTERFACES.md §5.1):
 * `{app_data_dir}/workspace`, git-initialized, with a Welcome page when
 * empty. Returns its absolute path. Called on startup — no folder picker.
 */
export async function ensureDefaultWorkspace(): Promise<string> {
  return backend().ensureDefaultWorkspace();
}

/** List the workspace tree (.md files and directories only). */
export async function listTree(root: string): Promise<TreeEntry[]> {
  return backend().listTree(root);
}

/** Read a UTF-8 text file relative to the workspace root. */
export async function readFile(root: string, relPath: string): Promise<string> {
  return backend().readFile(root, relPath);
}

/** Write a UTF-8 text file (parent directories are created as needed). */
export async function writeFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  await backend().writeFile(root, relPath, content);
}

/** Create a new page file; errors if the file already exists. */
export async function createPage(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  await backend().createPage(root, relPath, content);
}

/** Rename/move a file or directory (INTERFACES.md §5.2). */
export async function renamePath(
  root: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  await backend().renamePath(root, fromRel, toRel);
}

/** Delete a file or directory recursively (INTERFACES.md §5.2). */
export async function deletePath(root: string, relPath: string): Promise<void> {
  await backend().deletePath(root, relPath);
}

/** Upsert pages + their outgoing refs into the link index (§5.3). */
export async function indexPutPages(root: string, pages: PagePut[]): Promise<void> {
  await backend().indexPutPages(root, pages);
}

/** Remove pages from the link index by rel path (§5.3). */
export async function indexRemovePages(root: string, relPaths: string[]): Promise<void> {
  await backend().indexRemovePages(root, relPaths);
}

/** Clear the link index (§5.3). */
export async function indexClear(root: string): Promise<void> {
  await backend().indexClear(root);
}

/**
 * Resolve an id or path to a page record (§5.3): id exact match →
 * relPath exact match → `<p>.md` / `<p>/index.md` completion.
 */
export async function indexLookup(
  root: string,
  idOrPath: string,
): Promise<PageRecord | null> {
  return backend().indexLookup(root, idOrPath);
}

/** Pages whose stored refs point at the given page (§5.3). */
export async function indexBacklinks(
  root: string,
  relPath: string,
): Promise<BacklinkRecord[]> {
  return backend().indexBacklinks(root, relPath);
}

// ---------------------------------------------------------------------------
// Git (INTERFACES.md §1 Git 系, §7.1) — M4 git UI surface
// ---------------------------------------------------------------------------

/** Combined index + worktree status, one entry per changed path. */
export async function gitStatus(root: string): Promise<GitStatusEntry[]> {
  return backend().gitStatus(root);
}

/** Stage everything and commit (`git add -A` semantics). Returns the OID. */
export async function gitCommit(root: string, message: string): Promise<string> {
  return backend().gitCommit(root, message);
}

/**
 * History, newest first. `relPath` filters to commits touching that path;
 * `limit` caps the count (backend default when omitted).
 */
export async function gitLog(
  root: string,
  relPath?: string | null,
  limit?: number | null,
): Promise<GitCommitInfo[]> {
  return backend().gitLog(root, relPath ?? null, limit ?? null);
}

/** Local branches + current one (§7.1). */
export async function gitBranches(root: string): Promise<GitBranchInfo> {
  return backend().gitBranches(root);
}

/** Create a local branch at the current HEAD (does not switch). */
export async function gitCreateBranch(root: string, name: string): Promise<void> {
  await backend().gitCreateBranch(root, name);
}

/** Switch branches. Errors on a dirty worktree (§7.1). */
export async function gitCheckoutBranch(root: string, name: string): Promise<void> {
  await backend().gitCheckoutBranch(root, name);
}

/** Blob content of `relPath` at `oid`, or null if absent in that commit. */
export async function gitFileAtCommit(
  root: string,
  relPath: string,
  oid: string,
): Promise<string | null> {
  return backend().gitFileAtCommit(root, relPath, oid);
}

/**
 * Restore the blob bytes of `relPath` at `oid` into the worktree (§7.1 —
 * exempt from the pipeline.ts monopoly: restores git-authored bytes).
 */
export async function gitRevertFile(
  root: string,
  relPath: string,
  oid: string,
): Promise<void> {
  await backend().gitRevertFile(root, relPath, oid);
}

/** Active git backend name + honest capability report. */
export async function gitBackendInfo(): Promise<GitBackendInfo> {
  return backend().gitBackendInfo();
}

// ---------------------------------------------------------------------------
// Collab (INTERFACES.md §10.2) — M6 issue/PR event logs + merge
// ---------------------------------------------------------------------------
//
// `collabGetIssue` / `collabGetPr` return the raw event JSON strings (ts
// ascending). Parsing into typed events lives in src/collab-ui/events.ts —
// deliberately NOT here, so the wrapper stays a 1:1 command mirror.

/** Create an issue ref with its `create` event. Returns the new issue ULID. */
export async function collabCreateIssue(
  root: string,
  title: string,
  body: string,
): Promise<string> {
  return backend().collabCreateIssue(root, title, body);
}

/** Append one event (JSON line, §10.1 schema) to an issue's log. */
export async function collabIssueEvent(
  root: string,
  id: string,
  eventJson: string,
): Promise<void> {
  await backend().collabIssueEvent(root, id, eventJson);
}

/** Issue list rows, materialized from the refs on each call. */
export async function collabListIssues(root: string): Promise<IssueSummary[]> {
  return backend().collabListIssues(root);
}

/** All events of one issue as raw JSON strings, ts ascending. */
export async function collabGetIssue(root: string, id: string): Promise<string[]> {
  return backend().collabGetIssue(root, id);
}

/** Create a PR ref with its `create` event. Returns the new PR ULID. */
export async function collabCreatePr(
  root: string,
  title: string,
  body: string,
  source: string,
  target: string,
): Promise<string> {
  return backend().collabCreatePr(root, title, body, source, target);
}

/** Append one event (JSON line, §10.1 schema) to a PR's log. */
export async function collabPrEvent(
  root: string,
  id: string,
  eventJson: string,
): Promise<void> {
  await backend().collabPrEvent(root, id, eventJson);
}

/** PR list rows, materialized from the refs on each call. */
export async function collabListPrs(root: string): Promise<PrSummary[]> {
  return backend().collabListPrs(root);
}

/** All events of one PR as raw JSON strings, ts ascending. */
export async function collabGetPr(root: string, id: string): Promise<string[]> {
  return backend().collabGetPr(root, id);
}

/**
 * Merge `source` into the current branch (§10.2). On "conflicts" the
 * worktree is left untouched and `conflictPaths` lists the collisions.
 */
export async function gitMergeBranch(
  root: string,
  source: string,
): Promise<MergeOutcome> {
  return backend().gitMergeBranch(root, source);
}

// ---------------------------------------------------------------------------
// Sync (INTERFACES.md §11.2) — M7 remote sync surface
// ---------------------------------------------------------------------------

/** Current origin remote URL, or null if no remote is configured. */
export async function gitRemoteGet(root: string): Promise<string | null> {
  return backend().gitRemoteGet(root);
}

/**
 * Create/update the origin remote URL. The gix (mobile) backend may reject
 * this with an Unsupported message — the caller surfaces it to the user.
 */
export async function gitRemoteSet(root: string, url: string): Promise<void> {
  await backend().gitRemoteSet(root, url);
}

/**
 * Store a PAT for `host` in the OS keychain (service "hakushi", account =
 * host). The token is never read back into TS — only set/clear/has exist.
 */
export async function credentialSet(host: string, token: string): Promise<void> {
  await backend().credentialSet(host, token);
}

/** Remove the stored PAT for `host`. */
export async function credentialClear(host: string): Promise<void> {
  await backend().credentialClear(host);
}

/** Whether a PAT is stored for `host` (drives the 保存済み ✓ / 削除 UI). */
export async function credentialHas(host: string): Promise<boolean> {
  return backend().credentialHas(host);
}

/**
 * One-shot full sync (INTERFACES.md §11.1): fetch → current-branch
 * integration → collab-refs union merge → push. Errors on a dirty worktree
 * ("commit or discard changes first …") or when no remote is set.
 */
export async function gitSync(root: string): Promise<SyncReport> {
  return backend().gitSync(root);
}

// ---------------------------------------------------------------------------
// Conflict resolution (INTERFACES.md §12.1) — M8 semantic merge surface
// ---------------------------------------------------------------------------

/**
 * Sentinel `source` for the conflict-resolution flow when the conflict came
 * from a `git_sync` merge against the remote-tracking branch rather than a
 * named local branch (the sync flow has no incoming branch name). The Rust
 * libgit2 backend resolves it to `origin/<current branch>`; the browser mock
 * replays its last recorded conflict. Passed to `gitConflictVersions` /
 * `gitMergeResolve` as `source`.
 */
export const SYNC_CONFLICT_SOURCE = "__sync__";

/**
 * The three versions (base / ours / theirs) of every file that would collide
 * when merging `source` into the current branch (§12.1). Computed by an
 * in-memory merge; the worktree is never touched. Empty when there is no
 * conflict. Feeds the ConflictResolver's per-file `semanticMerge3`.
 */
export async function gitConflictVersions(
  root: string,
  source: string,
): Promise<ConflictFile[]> {
  return backend().gitConflictVersions(root, source);
}

/**
 * Complete the merge of `source` into the current branch with the user's
 * resolved file contents (§12.1). Every conflicting path must be present in
 * `resolved` (partial resolution is rejected). Creates the two-parent merge
 * commit, advances HEAD, checks out the worktree, and returns the merge OID.
 */
export async function gitMergeResolve(
  root: string,
  source: string,
  resolved: ResolvedFile[],
): Promise<string> {
  return backend().gitMergeResolve(root, source, resolved);
}
