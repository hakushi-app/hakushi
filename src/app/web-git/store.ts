// Web backend — persistent local store + REAL local git for the browser.
//
// Replaces the DEV-ONLY in-memory mock (tauri-mock.ts) for production web:
//   - files live in IndexedDB via @isomorphic-git/lightning-fs, so pages
//     SURVIVE reloads (the mock lost everything on refresh);
//   - git is the real thing via isomorphic-git — real blobs/trees/commits with
//     content-addressed OIDs. That determinism is what lets github.ts push/pull
//     to GitHub through its REST API with NO CORS proxy (INTERFACES.md §11 is
//     satisfied by the API transport instead of the git wire protocol).
//
// Layout (two separate lightning-fs roots):
//   /hakushi          git worktree — the .md pages + .git
//   /hakushi-meta     non-git metadata (collab logs, sync state) — never
//                     pollutes page history or the file tree

import { Buffer as BufferPolyfill } from "buffer";
import FS from "@isomorphic-git/lightning-fs";
import git from "isomorphic-git";

// isomorphic-git reaches for a global `Buffer` at call time; browsers have none.
// Polyfill it once here (this module is the web backend's foundation). Guarded
// so it never clobbers Node's/vitest's native Buffer.
if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer?: unknown }).Buffer = BufferPolyfill;
}

import type { GitBranchInfo, GitCommitInfo, GitStatusEntry } from "../workspace";
import { buildTreeFromPaths } from "../tauri-mock";

export const WORKSPACE_DIR = "/hakushi";
export const META_DIR = "/hakushi-meta";

/** Commit identity for browser-authored commits. */
const AUTHOR = { name: "Hakushi Web", email: "web@hakushi.local" } as const;

// Single IndexedDB-backed fs shared by the git worktree and the meta store.
// Constructed lazily so importing this module is safe in jsdom/vitest (which
// has no IndexedDB); the web backend is only ever *selected* in a real browser.
let _fs: InstanceType<typeof FS> | null = null;
function fsInstance(): InstanceType<typeof FS> {
  if (_fs === null) _fs = new FS("hakushi");
  return _fs;
}
function pfsInstance() {
  return fsInstance().promises;
}

/** The `fs` object isomorphic-git needs (lightning-fs is the canonical pairing). */
export function gitFs() {
  return fsInstance();
}

// ---------------------------------------------------------------------------
// Seed content (first run only) — mirrors the mock's starter pages.
// ---------------------------------------------------------------------------

const SEED_FILES: Record<string, string> = {
  "Welcome.md": `---
id: 01JAR000000000000000000001
title: Welcome
created: 2026-07-01
---

# 白紙 Hakushi へようこそ

これはブラウザ版のワークスペースです。内容はこのブラウザに保存されます。

- [ノート](Notes.md)
- [プロジェクト](Projects/index.md)
`,
  "Notes.md": `---
id: 01JAR000000000000000000002
title: Notes
created: 2026-07-01
---

日々のメモ。[Welcome](Welcome.md) に戻る。
`,
  "Projects/index.md": `---
id: 01JAR000000000000000000003
title: Projects
created: 2026-07-01
---

::embed{page="Projects/Roadmap.md"}
`,
  "Projects/Roadmap.md": `---
id: 01JAR000000000000000000004
title: Roadmap
created: 2026-07-01
---

# Roadmap

- M0: skeleton
- M1: dual editors
`,
};

// ---------------------------------------------------------------------------
// Low-level fs helpers (paths are workspace-relative; joined onto a root)
// ---------------------------------------------------------------------------

function abs(root: string, rel: string): string {
  return `${root}/${rel}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await pfsInstance().stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursively `mkdir -p` every parent directory of `path`. */
async function mkdirp(dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += `/${p}`;
    if (!(await exists(cur))) {
      try {
        await pfsInstance().mkdir(cur);
      } catch {
        /* raced or already exists */
      }
    }
  }
}

/** Read a UTF-8 file under a root; throws if absent. */
export async function readFileRel(root: string, rel: string): Promise<string> {
  return (await pfsInstance().readFile(abs(root, rel), "utf8")) as string;
}

/** Write a UTF-8 file under a root, creating parent dirs. */
export async function writeFileRel(root: string, rel: string, content: string): Promise<void> {
  const path = abs(root, rel);
  await mkdirp(path.slice(0, path.lastIndexOf("/")));
  await pfsInstance().writeFile(path, content, "utf8");
}

export async function existsRel(root: string, rel: string): Promise<boolean> {
  return exists(abs(root, rel));
}

/**
 * All file rel-paths under `root`, excluding only `.git`. Dotfiles
 * (.gitignore, .hakushi/…) ARE included: sync and rename must see them, or a
 * pushed tree silently deletes them from the remote / a directory move drops
 * them. UI-facing listings filter dot-entries separately (listTree).
 */
export async function listFilesRel(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dirAbs: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await pfsInstance().readdir(dirAbs)) as string[];
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const childAbs = `${dirAbs}/${name}`;
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const st = await pfsInstance().stat(childAbs);
      if (st.isDirectory()) await walk(childAbs, rel);
      else out.push(rel);
    }
  };
  await walk(root, "");
  return out;
}

async function rmRel(root: string, rel: string): Promise<boolean> {
  const path = abs(root, rel);
  if (!(await exists(path))) return false;
  const st = await pfsInstance().stat(path);
  if (st.isDirectory()) {
    for (const name of (await pfsInstance().readdir(path)) as string[]) {
      await rmRel(root, `${rel}/${name}`);
    }
    await pfsInstance().rmdir(path);
  } else {
    await pfsInstance().unlink(path);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

let ready: Promise<void> | null = null;

/** Idempotently create + git-init + seed the workspace (first run only). */
export function ensureWorkspace(): Promise<void> {
  if (ready === null) ready = init();
  return ready;
}

/**
 * `.hakushi/` is the local-only cache area (auto-sync config, INTERFACES.md
 * §5.3) — without this ignore, saving any setting would leave the worktree
 * permanently dirty (blocking auto-sync and branch switches) and sync would
 * push the config to GitHub.
 */
const GITIGNORE_CONTENT = ".hakushi/\n";

async function init(): Promise<void> {
  await mkdirp(WORKSPACE_DIR);
  await mkdirp(META_DIR);
  const hasGit = await exists(`${WORKSPACE_DIR}/.git`);
  if (!hasGit) {
    await git.init({ fs: fsInstance(), dir: WORKSPACE_DIR, defaultBranch: "main" });
    await writeFileRel(WORKSPACE_DIR, ".gitignore", GITIGNORE_CONTENT);
    for (const [rel, content] of Object.entries(SEED_FILES)) {
      await writeFileRel(WORKSPACE_DIR, rel, content);
    }
    await commitAll("初期コミット: シードページ");
  } else if (!(await existsRel(WORKSPACE_DIR, ".gitignore"))) {
    // Migration for workspaces created before the .gitignore seed. Commit ONLY
    // this file (never `commitAll` here — it would sweep the user's
    // uncommitted edits into a surprise commit on app launch).
    await writeFileRel(WORKSPACE_DIR, ".gitignore", GITIGNORE_CONTENT);
    await git.add({ fs: fsInstance(), dir: WORKSPACE_DIR, filepath: ".gitignore" });
    await git.commit({
      fs: fsInstance(),
      dir: WORKSPACE_DIR,
      message: ".gitignore を追加",
      author: AUTHOR,
    });
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export async function listTree() {
  // Dot-entries (.gitignore, .hakushi/…) stay out of the page tree UI.
  const paths = (await listFilesRel(WORKSPACE_DIR)).filter(
    (rel) => !rel.split("/").some((seg) => seg.startsWith(".")),
  );
  return buildTreeFromPaths(paths);
}

// ---------------------------------------------------------------------------
// Page fs ops (mirror the mock's create/rename/delete contract)
// ---------------------------------------------------------------------------

export async function createPage(rel: string, content: string): Promise<void> {
  if (await existsRel(WORKSPACE_DIR, rel)) throw new Error(`already exists: ${rel}`);
  await writeFileRel(WORKSPACE_DIR, rel, content);
}

export async function renamePath(fromRel: string, toRel: string): Promise<void> {
  if (await existsRel(WORKSPACE_DIR, toRel)) {
    throw new Error(`destination already exists: ${toRel}`);
  }
  const fromAbs = abs(WORKSPACE_DIR, fromRel);
  if (!(await exists(fromAbs))) throw new Error(`not found: ${fromRel}`);
  const st = await pfsInstance().stat(fromAbs);
  if (st.isDirectory()) {
    if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
      throw new Error("cannot move a directory into itself");
    }
    for (const childRel of await listFilesRel(fromAbs)) {
      const content = await readFileRel(fromAbs, childRel);
      await writeFileRel(WORKSPACE_DIR, `${toRel}/${childRel}`, content);
    }
    await rmRel(WORKSPACE_DIR, fromRel);
  } else {
    const content = await readFileRel(WORKSPACE_DIR, fromRel);
    await writeFileRel(WORKSPACE_DIR, toRel, content);
    await rmRel(WORKSPACE_DIR, fromRel);
  }
}

export async function deletePath(rel: string): Promise<void> {
  if (!(await rmRel(WORKSPACE_DIR, rel))) throw new Error(`not found: ${rel}`);
}

// ---------------------------------------------------------------------------
// Local git (real, via isomorphic-git)
// ---------------------------------------------------------------------------

/** Working-tree status vs HEAD (new / modified / deleted), sorted by path. */
export async function status(): Promise<GitStatusEntry[]> {
  const matrix = await git.statusMatrix({ fs: fsInstance(), dir: WORKSPACE_DIR });
  const out: GitStatusEntry[] = [];
  for (const [filepath, head, workdir] of matrix) {
    if (head === 0 && workdir === 2) out.push({ relPath: filepath, status: "new" });
    else if (head === 1 && workdir === 2) out.push({ relPath: filepath, status: "modified" });
    else if (head === 1 && workdir === 0) out.push({ relPath: filepath, status: "deleted" });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/** Stage every change and commit; returns the new commit OID. */
export async function commitAll(message: string): Promise<string> {
  const matrix = await git.statusMatrix({ fs: fsInstance(), dir: WORKSPACE_DIR });
  let staged = 0;
  for (const [filepath, head, workdir] of matrix) {
    if (workdir === 0 && head === 1) {
      await git.remove({ fs: fsInstance(), dir: WORKSPACE_DIR, filepath });
      staged++;
    } else if (workdir === 2) {
      await git.add({ fs: fsInstance(), dir: WORKSPACE_DIR, filepath });
      staged++;
    }
  }
  if (staged === 0) throw new Error("nothing to commit (worktree clean)");
  return git.commit({ fs: fsInstance(), dir: WORKSPACE_DIR, message, author: AUTHOR });
}

export async function log(relPath: string | null, limit: number | null): Promise<GitCommitInfo[]> {
  let entries;
  try {
    entries = await git.log({
      fs: fsInstance(),
      dir: WORKSPACE_DIR,
      depth: limit ?? 100,
      filepath: relPath ?? undefined,
    });
  } catch {
    return []; // unborn HEAD
  }
  return entries.map((e) => ({
    oid: e.oid,
    summary: e.commit.message.split("\n", 1)[0],
    authorName: e.commit.author.name,
    timestamp: e.commit.author.timestamp,
  }));
}

export async function branches(): Promise<GitBranchInfo> {
  const list = await git.listBranches({ fs: fsInstance(), dir: WORKSPACE_DIR });
  const current = await git.currentBranch({ fs: fsInstance(), dir: WORKSPACE_DIR, fullname: false });
  return { current: current ?? null, branches: [...list].sort() };
}

export async function createBranch(name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("ブランチ名が空です");
  const existing = await git.listBranches({ fs: fsInstance(), dir: WORKSPACE_DIR });
  if (existing.includes(trimmed)) throw new Error(`ブランチは既に存在します: ${trimmed}`);
  await git.branch({ fs: fsInstance(), dir: WORKSPACE_DIR, ref: trimmed, checkout: false });
}

export async function checkoutBranch(name: string): Promise<void> {
  if ((await status()).length > 0) {
    throw new Error("未コミットの変更があります。先にコミットしてください。");
  }
  await git.checkout({ fs: fsInstance(), dir: WORKSPACE_DIR, ref: name });
}

/** File content at a specific commit, or null if absent there. */
export async function fileAtCommit(relPath: string, oid: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs: fsInstance(), dir: WORKSPACE_DIR, oid, filepath: relPath });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

export async function revertFile(relPath: string, oid: string): Promise<void> {
  const content = await fileAtCommit(relPath, oid);
  if (content === null) throw new Error(`${relPath} はコミット ${oid.slice(0, 8)} に存在しません`);
  await writeFileRel(WORKSPACE_DIR, relPath, content);
}

// --- Meta store (collab logs, sync state — plain fs, not git) --------------

export async function metaRead(rel: string): Promise<string | null> {
  try {
    return await readFileRel(META_DIR, rel);
  } catch {
    return null;
  }
}

export async function metaWrite(rel: string, content: string): Promise<void> {
  await writeFileRel(META_DIR, rel, content);
}

export async function metaList(dirRel: string): Promise<string[]> {
  try {
    return (await pfsInstance().readdir(abs(META_DIR, dirRel))) as string[];
  } catch {
    return [];
  }
}
