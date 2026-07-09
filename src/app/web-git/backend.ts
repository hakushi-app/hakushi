// Web backend assembly — a real, persistent, remote-capable WorkspaceBackend
// for the browser. Local fs+git come from store.ts (lightning-fs +
// isomorphic-git); the GitHub remote comes from github.ts (REST API, no proxy).
//
// This REPLACES the in-memory mock (tauri-mock.ts) for production web. The mock
// stays the backend for vitest/jsdom (no IndexedDB there) — see workspace.ts.

import { ulid } from "ulid";

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
  ResolvedFile,
  SyncReport,
  TreeEntry,
  WorkspaceBackend,
} from "../workspace";
import { refPointsTo } from "../paths";
import * as gh from "./github";
import git from "isomorphic-git";
import {
  WORKSPACE_DIR,
  branches,
  checkoutBranch,
  commitAll,
  createBranch,
  createPage,
  deletePath,
  ensureWorkspace,
  fileAtCommit,
  gitFs,
  listFilesRel,
  listTree,
  log,
  metaList,
  metaRead,
  metaWrite,
  readFileRel,
  renamePath,
  revertFile,
  status,
  writeFileRel,
} from "./store";

const GITHUB_HOST = "github.com";

/**
 * Sentinel `source` for resolving conflicts that came from `git_sync` (mirrors
 * workspace.ts SYNC_CONFLICT_SOURCE; duplicated here to keep this module free
 * of a runtime import cycle with workspace.ts).
 */
const SYNC_SOURCE = "__sync__";

// ---------------------------------------------------------------------------
// In-memory link index (derived; rebuilt as the app re-indexes on load)
// ---------------------------------------------------------------------------

const index = new Map<string, PagePut>();

// ---------------------------------------------------------------------------
// Collab event logs (persisted as JSONL under the meta store)
// ---------------------------------------------------------------------------

interface RawEvent {
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

function rawEvent(json: string): RawEvent | null {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.type !== "string" || typeof o.ts !== "number") return null;
    const data =
      typeof o.data === "object" && o.data !== null ? (o.data as Record<string, unknown>) : {};
    return { type: o.type, ts: o.ts, data };
  } catch {
    return null;
  }
}

function sortedEvents(log: readonly string[]): string[] {
  return log
    .map((json, i) => ({ json, i, ts: rawEvent(json)?.ts ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map((e) => e.json);
}

function eventLine(type: string, ts: number, data: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, type, ts, author: "me", data });
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function readLog(kind: "issues" | "prs", id: string): Promise<string[] | null> {
  const raw = await metaRead(`collab/${kind}/${id}.jsonl`);
  if (raw === null) return null;
  return raw.split("\n").filter((l) => l.trim() !== "");
}

async function writeLog(kind: "issues" | "prs", id: string, lines: readonly string[]): Promise<void> {
  await metaWrite(`collab/${kind}/${id}.jsonl`, lines.join("\n") + "\n");
}

async function appendLog(kind: "issues" | "prs", id: string, line: string): Promise<void> {
  const existing = (await readLog(kind, id)) ?? [];
  existing.push(line);
  await writeLog(kind, id, existing);
}

async function listLogIds(kind: "issues" | "prs"): Promise<string[]> {
  // Meta files are flat: collab/<kind>/<id>.jsonl
  const names = await metaList(`collab/${kind}`);
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.replace(/\.jsonl$/, ""));
}

async function readAllLogs(kind: "issues" | "prs"): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of await listLogIds(kind)) {
    const lines = await readLog(kind, id);
    if (lines !== null) out.set(id, lines);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Sync state (per-branch bases; url) + caches — persisted in the meta store
// ---------------------------------------------------------------------------

interface SyncState {
  url: string | null;
  /**
   * Last-synced remote commit per branch. A single workspace-wide sha (the
   * legacy shape) breaks after a branch switch: the next sync would 3-way
   * merge against a base from a DIFFERENT branch, producing false conflicts
   * or silently rolled-back changes.
   */
  baseByBranch: Record<string, string>;
}

async function readSyncState(): Promise<SyncState> {
  const raw = await metaRead("sync/state.json");
  if (raw === null) return { url: null, baseByBranch: {} };
  try {
    const parsed = JSON.parse(raw) as {
      url?: string | null;
      baseByBranch?: Record<string, string>;
      lastRemoteSha?: string | null; // legacy single-sha shape
    };
    const baseByBranch =
      parsed.baseByBranch ??
      (typeof parsed.lastRemoteSha === "string" ? { main: parsed.lastRemoteSha } : {});
    return { url: parsed.url ?? null, baseByBranch };
  } catch {
    return { url: null, baseByBranch: {} };
  }
}

async function writeSyncState(s: SyncState): Promise<void> {
  await metaWrite("sync/state.json", JSON.stringify(s));
}

/** Cached text tree of a branch's sync base (avoids refetching every blob). */
async function readBaseCache(
  branch: string,
): Promise<{ sha: string; files: Map<string, string> } | null> {
  const raw = await metaRead(`sync/base-${branch}.json`);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { sha?: string; files?: Record<string, string> };
    if (typeof parsed.sha !== "string" || parsed.sha === "" || parsed.files === undefined) {
      return null;
    }
    return { sha: parsed.sha, files: new Map(Object.entries(parsed.files)) };
  } catch {
    return null;
  }
}

async function writeBaseCache(
  branch: string,
  base: { sha: string; files: Map<string, string> } | null,
): Promise<void> {
  await metaWrite(
    `sync/base-${branch}.json`,
    base === null
      ? "{}"
      : JSON.stringify({ sha: base.sha, files: Object.fromEntries(base.files) }),
  );
}

async function readCollabTips(): Promise<gh.CollabTipCache> {
  const raw = await metaRead("sync/collab-tips.json");
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as gh.CollabTipCache;
  } catch {
    return {};
  }
}

async function writeCollabTips(tips: gh.CollabTipCache): Promise<void> {
  await metaWrite("sync/collab-tips.json", JSON.stringify(tips));
}

// ---------------------------------------------------------------------------
// Pending merges (memory-only; a reload just means re-running merge/sync)
// ---------------------------------------------------------------------------
//
// Both carry the FULL merged tree, not only the conflicting files: finishing
// a merge by writing just the resolved files would silently drop every
// non-conflicting change from the other side.

let pendingSync: {
  branch: string;
  remoteSha: string;
  merged: Map<string, string>;
  conflicts: ConflictFile[];
} | null = null;

let pendingBranch: {
  source: string;
  curOid: string;
  srcOid: string;
  merged: Map<string, string>;
  conflicts: ConflictFile[];
} | null = null;

// --- worktree map helpers (for remote sync) --------------------------------

/** Sync-relevant local text files: everything except .git and .hakushi. */
async function worktreeMap(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listFilesRel(WORKSPACE_DIR)) {
    if (rel === ".hakushi" || rel.startsWith(".hakushi/")) continue;
    out.set(rel, await readFileRel(WORKSPACE_DIR, rel));
  }
  return out;
}

/** Overwrite the worktree to match `files`, deleting anything not present. */
async function applyWorktree(files: Map<string, string>): Promise<void> {
  const current = await listFilesRel(WORKSPACE_DIR);
  for (const rel of current) {
    if (rel === ".hakushi" || rel.startsWith(".hakushi/")) continue; // local-only cache
    if (!files.has(rel)) await deletePath(rel);
  }
  for (const [rel, content] of files) {
    let old: string | null = null;
    try {
      old = await readFileRel(WORKSPACE_DIR, rel);
    } catch {
      /* new file */
    }
    if (old !== content) await writeFileRel(WORKSPACE_DIR, rel, content);
  }
}

// --- local merge helpers (real git objects) --------------------------------

async function filesAtRef(ref: string): Promise<Map<string, string>> {
  const oid = await git.resolveRef({ fs: gitFs(), dir: WORKSPACE_DIR, ref });
  return filesAtOid(oid);
}

/** Files at a bare commit OID (merge-base has no branch name). */
async function filesAtOid(oid: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = await git.listFiles({ fs: gitFs(), dir: WORKSPACE_DIR, ref: oid });
  for (const filepath of paths) {
    const { blob } = await git.readBlob({ fs: gitFs(), dir: WORKSPACE_DIR, oid, filepath });
    out.set(filepath, new TextDecoder().decode(blob));
  }
  return out;
}

/** Stage every worktree change (adds + deletes) against HEAD. */
async function stageAll(): Promise<void> {
  const fs = gitFs();
  const matrix = await git.statusMatrix({ fs, dir: WORKSPACE_DIR });
  for (const [filepath, head, workdir] of matrix) {
    if (workdir === 0 && head === 1) await git.remove({ fs, dir: WORKSPACE_DIR, filepath });
    else if (workdir === 2) await git.add({ fs, dir: WORKSPACE_DIR, filepath });
  }
}

/** Commit the staged index; explicit parents for merge commits, HEAD otherwise. */
async function commitWithParents(message: string, parents?: string[]): Promise<string> {
  return git.commit({
    fs: gitFs(),
    dir: WORKSPACE_DIR,
    message,
    author: { name: "Hakushi Web", email: "web@hakushi.local" },
    parent: parents,
  });
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export const webGitBackend: WorkspaceBackend = {
  async openWorkspaceDialog() {
    // No OS folder picker in the browser; the web app has exactly one
    // workspace. Returning null makes 「別のフォルダを開く…」 behave like a
    // cancelled dialog instead of pretending a new folder was opened.
    return null;
  },

  async ensureDefaultWorkspace() {
    await ensureWorkspace();
    return WORKSPACE_DIR;
  },

  async listTree(): Promise<TreeEntry[]> {
    return listTree();
  },

  readFile(_root, relPath) {
    return readFileRel(WORKSPACE_DIR, relPath);
  },

  async writeFile(_root, relPath, content) {
    await writeFileRel(WORKSPACE_DIR, relPath, content);
  },

  async createPage(_root, relPath, content) {
    await createPage(relPath, content);
  },

  async renamePath(_root, fromRel, toRel) {
    await renamePath(fromRel, toRel);
  },

  async deletePath(_root, relPath) {
    await deletePath(relPath);
  },

  // --- Index (in-memory; same lookup semantics as the mock) -----------------

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

  // --- Local git (real) ------------------------------------------------------

  gitStatus(): Promise<GitStatusEntry[]> {
    return status();
  },
  gitCommit(_root, message): Promise<string> {
    return commitAll(message);
  },
  gitLog(_root, relPath, limit): Promise<GitCommitInfo[]> {
    return log(relPath, limit);
  },
  gitBranches(): Promise<GitBranchInfo> {
    return branches();
  },
  async gitCreateBranch(_root, name) {
    await createBranch(name);
  },
  async gitCheckoutBranch(_root, name) {
    await checkoutBranch(name);
  },
  gitFileAtCommit(_root, relPath, oid): Promise<string | null> {
    return fileAtCommit(relPath, oid);
  },
  async gitRevertFile(_root, relPath, oid) {
    await revertFile(relPath, oid);
  },

  async gitBackendInfo() {
    return {
      name: "isomorphic-git",
      capabilities: {
        init: true,
        status: true,
        commit: true,
        log: true,
        branch: true,
        merge: true,
        push: true, // via GitHub API
        pull: true, // via GitHub API
      },
    };
  },

  // --- Collab (persisted event logs) ----------------------------------------

  async collabCreateIssue(_root, title, body): Promise<string> {
    const id = ulid();
    await appendLog("issues", id, eventLine("create", nowSec(), { title, body }));
    return id;
  },
  async collabIssueEvent(_root, id, eventJson) {
    if ((await readLog("issues", id)) === null) throw new Error(`issue が見つかりません: ${id}`);
    await appendLog("issues", id, eventJson);
  },
  async collabListIssues(): Promise<IssueSummary[]> {
    const ids = await listLogIds("issues");
    const summaries: IssueSummary[] = [];
    for (const id of ids) {
      const log = await readLog("issues", id);
      if (log !== null) summaries.push(deriveIssueSummary(id, log));
    }
    return summaries.sort((a, b) => b.updatedTs - a.updatedTs || a.id.localeCompare(b.id));
  },
  async collabGetIssue(_root, id): Promise<string[]> {
    const log = await readLog("issues", id);
    if (log === null) throw new Error(`issue が見つかりません: ${id}`);
    return sortedEvents(log);
  },
  async collabCreatePr(_root, title, body, source, target): Promise<string> {
    const id = ulid();
    await appendLog("prs", id, eventLine("create", nowSec(), { title, body, source, target }));
    return id;
  },
  async collabPrEvent(_root, id, eventJson) {
    if ((await readLog("prs", id)) === null) throw new Error(`PR が見つかりません: ${id}`);
    await appendLog("prs", id, eventJson);
  },
  async collabListPrs(): Promise<PrSummary[]> {
    const ids = await listLogIds("prs");
    const summaries: PrSummary[] = [];
    for (const id of ids) {
      const log = await readLog("prs", id);
      if (log !== null) summaries.push(derivePrSummary(id, log));
    }
    return summaries.sort((a, b) => b.updatedTs - a.updatedTs || a.id.localeCompare(b.id));
  },
  async collabGetPr(_root, id): Promise<string[]> {
    const log = await readLog("prs", id);
    if (log === null) throw new Error(`PR が見つかりません: ${id}`);
    return sortedEvents(log);
  },

  // --- Local branch merge (real 3-way over git objects) ---------------------

  async gitMergeBranch(_root, source): Promise<MergeOutcome> {
    const fs = gitFs();
    const cur = await git.currentBranch({ fs, dir: WORKSPACE_DIR, fullname: false });
    if (cur === undefined || cur === null) throw new Error("コミットがありません");
    if (source === cur) throw new Error("現在のブランチ自身はマージできません");
    if ((await status()).length > 0) {
      throw new Error("未コミットの変更があります。先にコミットしてください。");
    }
    const curOid = await git.resolveRef({ fs, dir: WORKSPACE_DIR, ref: cur });
    let srcOid: string;
    try {
      srcOid = await git.resolveRef({ fs, dir: WORKSPACE_DIR, ref: source });
    } catch {
      throw new Error(`ブランチがありません: ${source}`);
    }
    const bases = await git.findMergeBase({ fs, dir: WORKSPACE_DIR, oids: [curOid, srcOid] });
    const baseOid = bases[0] ?? null;

    if (baseOid === srcOid) return { kind: "fastForward", conflictPaths: [] }; // already merged
    if (baseOid === curOid) {
      // Fast-forward: move the branch and refresh the worktree.
      await git.writeRef({ fs, dir: WORKSPACE_DIR, ref: `refs/heads/${cur}`, value: srcOid, force: true });
      await git.checkout({ fs, dir: WORKSPACE_DIR, ref: cur, force: true });
      return { kind: "fastForward", conflictPaths: [] };
    }

    const base = baseOid === null ? new Map<string, string>() : await filesAtOid(baseOid);
    const ours = await filesAtRef(cur);
    const theirs = await filesAtRef(source);
    const merged = new Map<string, string>();
    const conflictPaths: string[] = [];
    const conflicts: ConflictFile[] = [];
    for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (o === t) {
        if (o !== undefined) merged.set(path, o);
      } else if (b === o) {
        if (t !== undefined) merged.set(path, t);
      } else if (b === t) {
        if (o !== undefined) merged.set(path, o);
      } else {
        if (o !== undefined) merged.set(path, o);
        conflictPaths.push(path);
        conflicts.push({ relPath: path, base: b ?? null, ours: o ?? "", theirs: t ?? "" });
      }
    }
    if (conflictPaths.length > 0) {
      pendingBranch = { source, curOid, srcOid, merged, conflicts };
      return { kind: "conflicts", conflictPaths: conflictPaths.sort() };
    }
    await applyWorktree(merged);
    await stageAll();
    // Always a two-parent merge commit — even when the merged tree happens to
    // equal ours (both branches made the same change), the merge must still
    // land so `source` becomes an ancestor.
    await commitWithParents(`Merge branch '${source}'`, [curOid, srcOid]);
    await git.checkout({ fs, dir: WORKSPACE_DIR, ref: cur, force: true });
    return { kind: "merged", conflictPaths: [] };
  },

  // --- Remote (GitHub API) ---------------------------------------------------

  async gitRemoteGet(): Promise<string | null> {
    return (await readSyncState()).url;
  },
  async gitRemoteSet(_root, url) {
    const trimmed = url.trim();
    const prev = await readSyncState();
    if (trimmed === "") {
      await writeSyncState({ url: null, baseByBranch: {} });
      return;
    }
    // The web backend only speaks GitHub-over-https. Normalizing every
    // accepted spelling (ssh, "owner/repo" shorthand, trailing .git) to the
    // canonical https URL here keeps the PAT form (hostFromSyncUrl) and the
    // sync transport (parseRepo) agreeing on the same host.
    const repo = gh.parseRepo(trimmed);
    if (repo === null) {
      throw new Error(
        "Web 版は GitHub リポジトリのみ対応です。https://github.com/owner/repo の形式で入力してください。",
      );
    }
    const canonical = `https://github.com/${repo.owner}/${repo.repo}`;
    await writeSyncState({
      url: canonical,
      // Changing the remote invalidates every sync base.
      baseByBranch: prev.url === canonical ? prev.baseByBranch : {},
    });
  },
  async credentialSet(host, token) {
    gh.setToken(host, token);
  },
  async credentialClear(host) {
    gh.clearToken(host);
  },
  async credentialHas(host): Promise<boolean> {
    return gh.hasToken(host);
  },

  async gitSync(): Promise<SyncReport> {
    const state = await readSyncState();
    if (state.url === null) {
      throw new Error("リモートが設定されていません。同期設定でリモート URL を指定してください。");
    }
    if (!gh.hasToken(GITHUB_HOST)) {
      throw new Error("GitHub トークンが未設定です。同期設定でトークンを入力してください。");
    }
    const cur = (await branches()).current ?? "main";

    // Web sync model: one snapshot commit per sync. Uncommitted edits are
    // committed FIRST as their own commit so a later pull-merge commit never
    // mixes the user's words with the remote's.
    if ((await status()).length > 0) {
      await commitAll("同期前のローカル変更");
    }

    const ours = await worktreeMap();
    const baseSha = state.baseByBranch[cur] ?? null;
    const cache = await readBaseCache(cur);
    const result = await gh.runSync(
      state.url,
      cur,
      ours,
      baseSha,
      cache !== null && cache.sha === baseSha ? cache.files : null,
    );

    if (result.pendingMerge !== null && result.conflicts !== null) {
      pendingSync = {
        branch: cur,
        remoteSha: result.pendingMerge.remoteSha,
        merged: result.pendingMerge.merged,
        conflicts: result.conflicts,
      };
    } else {
      pendingSync = null;
    }
    if (result.merged !== null) {
      await applyWorktree(result.merged);
      if ((await status()).length > 0) await commitAll("Sync from remote");
    }
    if (result.newBase !== null) {
      state.baseByBranch[cur] = result.newBase.sha;
      await writeSyncState(state);
      await writeBaseCache(cur, result.newBase);
    }

    // Collab refs (Issue/PR) sync — runs even when the code branch hit
    // conflicts, mirroring the desktop pass (§11.2). Skipped only when the
    // branch sync could not reach the repo at all (it would have thrown).
    let collabReport = result.report.collabRefs;
    try {
      const logs: gh.CollabLogs = {
        issues: await readAllLogs("issues"),
        prs: await readAllLogs("prs"),
      };
      const tips = await readCollabTips();
      const collab = await gh.syncCollabRefs(state.url, logs, tips);
      for (const key of collab.changedLocal) {
        const slash = key.indexOf("/");
        const kind = key.slice(0, slash) as "issues" | "prs";
        const id = key.slice(slash + 1);
        const lines = (kind === "issues" ? collab.logs.issues : collab.logs.prs).get(id);
        if (lines !== undefined) await writeLog(kind, id, lines);
      }
      await writeCollabTips(collab.newTipCache);
      collabReport = collab.report;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Issue/PR の同期に失敗しました: ${msg}`);
    }

    const message =
      collabReport.merged > 0
        ? `${result.report.message} Issue/PR を ${collabReport.merged} 件取り込みました。`
        : result.report.message;
    return { ...result.report, collabRefs: collabReport, message };
  },

  // --- Conflict resolution (pending merges carry the full merged tree) ------

  async gitConflictVersions(_root, source): Promise<ConflictFile[]> {
    if (source === SYNC_SOURCE) return pendingSync === null ? [] : [...pendingSync.conflicts];
    if (pendingBranch !== null && pendingBranch.source === source) {
      return [...pendingBranch.conflicts];
    }
    return [];
  },

  async gitMergeResolve(_root, source, resolved: ResolvedFile[]): Promise<string> {
    const pending = source === SYNC_SOURCE ? pendingSync : pendingBranch;
    if (pending === null || pending.conflicts.length === 0) {
      throw new Error("解決するコンフリクトがありません");
    }
    if (source !== SYNC_SOURCE && pendingBranch !== null && pendingBranch.source !== source) {
      throw new Error(`このコンフリクトのマージ元は ${pendingBranch.source} です`);
    }
    const resolvedPaths = new Set(resolved.map((r) => r.relPath));
    for (const c of pending.conflicts) {
      if (!resolvedPaths.has(c.relPath)) {
        throw new Error(`未解決のコンフリクトがあります: ${c.relPath}`);
      }
    }
    // Final tree = the pending merge (which already carries every
    // NON-conflicting change from both sides) overridden by the user's
    // resolutions. Writing only the resolved files would drop the rest.
    const final = new Map(pending.merged);
    for (const { relPath, content } of resolved) final.set(relPath, content);
    await applyWorktree(final);
    await stageAll();

    if (source === SYNC_SOURCE) {
      const sync = pendingSync;
      pendingSync = null;
      if (sync === null) throw new Error("解決するコンフリクトがありません");
      const oid = await commitWithParents("Merge (resolved) リモート同期");
      // The resolution consumed the fetched remote head: advance the base so
      // the next sync pushes the resolution instead of re-conflicting.
      const state = await readSyncState();
      state.baseByBranch[sync.branch] = sync.remoteSha;
      await writeSyncState(state);
      await writeBaseCache(sync.branch, null); // stale — refetch by sha next sync
      return oid;
    }

    const branchPending = pendingBranch;
    pendingBranch = null;
    if (branchPending === null) throw new Error("解決するコンフリクトがありません");
    const fs = gitFs();
    const cur = await git.currentBranch({ fs, dir: WORKSPACE_DIR, fullname: false });
    const oid = await commitWithParents(`Merge (resolved) '${source}'`, [
      branchPending.curOid,
      branchPending.srcOid,
    ]);
    if (cur !== undefined && cur !== null) {
      await git.checkout({ fs, dir: WORKSPACE_DIR, ref: cur, force: true });
    }
    return oid;
  },
};
