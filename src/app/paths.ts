// Track U — pure workspace-relative path helpers (no fs, no Tauri).
// Shared by page-ops (move/rename mapping), the link index, the resolver,
// and the dev mock. All paths are `/`-separated and workspace-relative.

import type { TreeEntry } from "./workspace";

/** Directory part of a rel path ("" for top-level entries). */
export function dirnameRel(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

/** Last segment of a rel path. */
export function baseNameRel(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

/** Join a directory rel path ("" = root) and a child name. */
export function joinRel(dirRelPath: string, name: string): string {
  return dirRelPath === "" ? name : `${dirRelPath}/${name}`;
}

/**
 * Normalize a workspace-relative path: resolves `.` / `..`, drops empty
 * segments and a leading `./`. Returns `null` when the path escapes the
 * workspace root (too many `..`).
 */
export function normalizeRel(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Resolve `target` relative to the directory `baseDirRel` ("" = root). */
export function resolveFrom(baseDirRel: string, target: string): string | null {
  return normalizeRel(baseDirRel === "" ? target : `${baseDirRel}/${target}`);
}

/**
 * Relative path from directory `fromDirRel` ("" = root) to the
 * workspace-relative file `toRel` (`a/b` → `a/c/d.md` gives `../c/d.md`).
 */
export function relPathBetween(fromDirRel: string, toRel: string): string {
  const from = fromDirRel === "" ? [] : fromDirRel.split("/");
  const to = toRel.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const ups = from.length - i;
  return [...Array<string>(ups).fill(".."), ...to.slice(i)].join("/");
}

/**
 * Lookup candidates for a page-ish target, in contract order
 * (INTERFACES.md §5.3): exact, then `<p>.md`, then `<p>/index.md`.
 * A target already ending in `.md` has a single candidate.
 */
export function pathCandidates(relLike: string): string[] {
  if (/\.md$/i.test(relLike)) return [relLike];
  return [relLike, `${relLike}.md`, `${relLike}/index.md`];
}

/** Split a link target into its path and a trailing `#fragment`/`?query`. */
export function splitTargetSuffix(target: string): { path: string; suffix: string } {
  const m = /[#?]/.exec(target);
  if (m === null) return { path: target, suffix: "" };
  return { path: target.slice(0, m.index), suffix: target.slice(m.index) };
}

/** Does the target look like a page id (26-char Crockford ULID)? */
export function looksLikeId(target: string): boolean {
  return /^[0-9a-hjkmnp-tv-z]{26}$/i.test(target);
}

/**
 * Display name derived from a rel path: file name without `.md`; for a
 * folder note (`Dir/index.md`) the directory name.
 */
export function pageNameFromRelPath(relPath: string): string {
  const base = baseNameRel(relPath);
  if (base.toLowerCase() === "index.md") {
    const dir = dirnameRel(relPath);
    return dir === "" ? "index" : baseNameRel(dir);
  }
  return base.replace(/\.md$/i, "");
}

/**
 * Does a stored raw ref (`target` of `kind`, found in page `srcRelPath`)
 * point at the page `{relPath, id}`? Backlink semantics of INTERFACES.md
 * §5.3: id match, or the raw target resolved/normalized (with extension /
 * `index.md` completion) equals the page's rel path. Links resolve relative
 * to the source page's directory; embeds are workspace-relative (a
 * source-relative interpretation is also accepted, tolerant input).
 */
export function refPointsTo(
  srcRelPath: string,
  kind: "link" | "embed",
  target: string,
  page: { relPath: string; id: string | null },
): boolean {
  if (page.id !== null && page.id !== "" && target === page.id) return true;
  const { path } = splitTargetSuffix(target);
  const candidates = new Set<string>();
  if (kind === "link") {
    const resolved = resolveFrom(dirnameRel(srcRelPath), path);
    if (resolved !== null) for (const c of pathCandidates(resolved)) candidates.add(c);
  } else {
    const asWorkspace = normalizeRel(path);
    if (asWorkspace !== null) for (const c of pathCandidates(asWorkspace)) candidates.add(c);
    const asRelative = resolveFrom(dirnameRel(srcRelPath), path);
    if (asRelative !== null) for (const c of pathCandidates(asRelative)) candidates.add(c);
  }
  return candidates.has(page.relPath);
}

// ---------------------------------------------------------------------------
// TreeEntry helpers (shape defined in workspace.ts / INTERFACES.md §1)
// ---------------------------------------------------------------------------

/** Entries directly inside the directory `dirRelPath` ("" = root). */
export function findDirChildren(tree: TreeEntry[], dirRelPath: string): TreeEntry[] {
  if (dirRelPath === "") return tree;
  const walk = (entries: TreeEntry[]): TreeEntry[] | null => {
    for (const e of entries) {
      if (!e.isDir) continue;
      if (e.relPath === dirRelPath) return e.children ?? [];
      if (dirRelPath.startsWith(`${e.relPath}/`)) return walk(e.children ?? []);
    }
    return null;
  };
  return walk(tree) ?? [];
}

/** Find the entry with the given rel path (file or directory). */
export function findEntry(tree: TreeEntry[], relPath: string): TreeEntry | null {
  for (const e of tree) {
    if (e.relPath === relPath) return e;
    if (e.isDir && relPath.startsWith(`${e.relPath}/`)) {
      return findEntry(e.children ?? [], relPath);
    }
  }
  return null;
}

/** Rel paths of every `.md` page in the tree, in tree order. */
export function flattenMdPages(tree: TreeEntry[]): string[] {
  const out: string[] = [];
  const walk = (entries: TreeEntry[]) => {
    for (const e of entries) {
      if (e.isDir) walk(e.children ?? []);
      else if (/\.md$/i.test(e.name)) out.push(e.relPath);
    }
  };
  walk(tree);
  return out;
}
