// Track U — page operations: create / move / rename / delete with link
// follow-up (INTERFACES.md §5.5).
//
// The mapping/rewrite logic is pure (fs-independent) and unit-tested in
// page-ops.test.ts; the orchestration functions take a `PageFs` interface
// (defaulting to the real workspace API) so tests can drive them with an
// in-memory fake.

import { ulid } from "ulid";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  newPageMarkdown,
  parseMarkdown,
  rewriteRefs,
  stringifyMarkdown,
} from "../markdown";
import { pagePutFor } from "./link-index";
import {
  dirnameRel,
  findDirChildren,
  findEntry,
  flattenMdPages,
  joinRel,
  looksLikeId,
  normalizeRel,
  pathCandidates,
  relPathBetween,
  resolveFrom,
  splitTargetSuffix,
} from "./paths";
import {
  createPage,
  deletePath,
  indexBacklinks,
  indexPutPages,
  indexRemovePages,
  listTree,
  readFile,
  renamePath,
  writeFile,
  type BacklinkRecord,
  type PagePut,
  type TreeEntry,
} from "./workspace";

// ---------------------------------------------------------------------------
// fs seam (fake-able in tests)
// ---------------------------------------------------------------------------

export interface PageFs {
  listTree(root: string): Promise<TreeEntry[]>;
  readFile(root: string, relPath: string): Promise<string>;
  writeFile(root: string, relPath: string, content: string): Promise<void>;
  createPage(root: string, relPath: string, content: string): Promise<void>;
  renamePath(root: string, fromRel: string, toRel: string): Promise<void>;
  deletePath(root: string, relPath: string): Promise<void>;
  indexBacklinks(root: string, relPath: string): Promise<BacklinkRecord[]>;
  indexPutPages(root: string, pages: PagePut[]): Promise<void>;
  indexRemovePages(root: string, relPaths: string[]): Promise<void>;
}

const defaultFs: PageFs = {
  listTree,
  readFile,
  writeFile,
  createPage,
  renamePath,
  deletePath,
  indexBacklinks,
  indexPutPages,
  indexRemovePages,
};

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Sanitize a user-entered page title into a safe file name: strips
 * `/ \ : * ? " < > |`, trims leading/trailing dots and spaces; falls back
 * to "Untitled" when nothing is left.
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "");
  return cleaned === "" ? "Untitled" : cleaned;
}

/**
 * First unused name among `base`, `base-1`, `base-2`, … checking against
 * both `<name>.md` files and same-named directories in the target dir.
 */
export function dedupeName(base: string, existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    if (!taken.has(`${candidate}.md`) && !taken.has(candidate)) return candidate;
  }
}

/**
 * Old rel path → new rel path for every page affected by moving
 * `fromRel` → `toRel`. A file move maps just itself; a directory move maps
 * every page under it (prefix replacement).
 */
export function movedPathMap(
  fromRel: string,
  toRel: string,
  isDir: boolean,
  allPageRelPaths: Iterable<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!isDir) {
    map.set(fromRel, toRel);
    return map;
  }
  const prefix = `${fromRel}/`;
  for (const p of allPageRelPaths) {
    if (p.startsWith(prefix)) map.set(p, toRel + p.slice(fromRel.length));
  }
  return map;
}

/**
 * Rewrite a single raw ref target for a move (pure; INTERFACES.md §5.5).
 *
 * `srcOldRel`/`srcNewRel` are the containing page's rel paths before/after
 * the move (equal for unmoved backlink sources). `moveMap` is the
 * {@link movedPathMap} of the operation. Returns the new raw target, or
 * `null` to keep it unchanged.
 *
 * - links are source-relative: resolved at the old location, re-relativized
 *   from the new location (so a moved page keeps pointing at unmoved
 *   targets, and refs that moved together stay untouched);
 * - embeds are workspace-relative (or an id, never rewritten): rewritten to
 *   the target's new rel path when the target moved;
 * - `#fragment` / `?query` suffixes on link targets are preserved.
 */
export function computeRewrittenTarget(
  target: string,
  kind: "link" | "embed",
  srcOldRel: string,
  srcNewRel: string,
  moveMap: ReadonlyMap<string, string>,
): string | null {
  if (kind === "embed") {
    if (looksLikeId(target)) return null;
    const norm = normalizeRel(target);
    if (norm === null) return null;
    for (const cand of pathCandidates(norm)) {
      const moved = moveMap.get(cand);
      if (moved !== undefined) return moved;
    }
    return null;
  }
  const { path, suffix } = splitTargetSuffix(target);
  const oldResolved = resolveFrom(dirnameRel(srcOldRel), path);
  if (oldResolved === null) return null;
  const moved = moveMap.get(oldResolved);
  // Unmoved source pointing at an unmoved target: nothing to do (avoids
  // cosmetic churn on e.g. "./Foo.md").
  if (moved === undefined && srcOldRel === srcNewRel) return null;
  const newAbs = moved ?? oldResolved;
  const newTarget = relPathBetween(dirnameRel(srcNewRel), newAbs) + suffix;
  return newTarget === target ? null : newTarget;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function isDirIn(tree: TreeEntry[], relPath: string): boolean {
  const entry = findEntry(tree, relPath);
  if (entry !== null) return entry.isDir;
  return !/\.md$/i.test(relPath);
}

/**
 * Move/rename a page or directory with link follow-up (INTERFACES.md §5.5):
 * collect backlink sources from the index, `rename_path`, rewrite refs in
 * the backlink sources AND the moved pages themselves (canonical pipeline
 * output only), then update the index. Id refs stay untouched by design.
 */
export async function movePage(
  root: string,
  fromRel: string,
  toRel: string,
  fs: PageFs = defaultFs,
): Promise<void> {
  const from = normalizeRel(fromRel);
  const to = normalizeRel(toRel);
  if (from === null || from === "" || to === null || to === "") {
    throw new Error(`invalid move: ${fromRel} → ${toRel}`);
  }
  if (from === to) return;
  if (to.startsWith(`${from}/`)) {
    throw new Error("cannot move a folder into itself");
  }

  const tree = await fs.listTree(root);
  const isDir = isDirIn(tree, from);
  if (!isDir && !/\.md$/i.test(to)) {
    throw new Error("page destination must end with .md");
  }
  const moveMap = movedPathMap(from, to, isDir, flattenMdPages(tree));

  // 1) collect backlink sources for every page being moved (before rename)
  const backlinkSrcs = new Set<string>();
  for (const oldRel of moveMap.keys()) {
    for (const b of await fs.indexBacklinks(root, oldRel)) {
      backlinkSrcs.add(b.srcRelPath);
    }
  }

  // 2) physical rename
  await fs.renamePath(root, from, to);

  // 3) rewrite refs in backlink sources + the moved pages themselves
  const toRewrite = new Set<string>([...backlinkSrcs, ...moveMap.keys()]);
  const puts: PagePut[] = [];
  for (const oldSrc of toRewrite) {
    const newSrc = moveMap.get(oldSrc) ?? oldSrc;
    const raw = await fs.readFile(root, newSrc);
    const { tree: rewritten, changed } = rewriteRefs(parseMarkdown(raw), (target, kind) =>
      computeRewrittenTarget(target, kind, oldSrc, newSrc, moveMap),
    );
    let onDisk = raw;
    if (changed) {
      // .md bytes always come from the canonical pipeline.
      onDisk = stringifyMarkdown(rewritten);
      await fs.writeFile(root, newSrc, onDisk);
    }
    if (changed || newSrc !== oldSrc) puts.push(pagePutFor(newSrc, onDisk));
  }

  // 4) index update: drop old paths, upsert changed/moved pages
  if (moveMap.size > 0) await fs.indexRemovePages(root, [...moveMap.keys()]);
  if (puts.length > 0) await fs.indexPutPages(root, puts);
}

export interface DeleteImpact {
  /** Rel paths of every page that is (or would be) deleted. */
  deletedRelPaths: string[];
  /** Backlinks from pages OUTSIDE the deleted subtree (for the UI warning). */
  backlinks: BacklinkRecord[];
}

/** Dry-run impact of deleting `relPath` (file or directory). */
export async function collectDeleteImpact(
  root: string,
  relPath: string,
  fs: PageFs = defaultFs,
): Promise<DeleteImpact> {
  const tree = await fs.listTree(root);
  const isDir = isDirIn(tree, relPath);
  const deletedRelPaths = isDir
    ? flattenMdPages(tree).filter((p) => p.startsWith(`${relPath}/`))
    : [relPath];
  const deletedSet = new Set(deletedRelPaths);
  const backlinks: BacklinkRecord[] = [];
  for (const p of deletedRelPaths) {
    for (const b of await fs.indexBacklinks(root, p)) {
      if (!deletedSet.has(b.srcRelPath)) backlinks.push(b);
    }
  }
  return { deletedRelPaths, backlinks };
}

/**
 * Delete a page or directory: `delete_path` + index removal. Returns the
 * impact report (collected just before deleting) so the UI can tell the
 * user "N pages referenced this".
 */
export async function deletePage(
  root: string,
  relPath: string,
  fs: PageFs = defaultFs,
): Promise<DeleteImpact> {
  const impact = await collectDeleteImpact(root, relPath, fs);
  await fs.deletePath(root, relPath);
  await fs.indexRemovePages(root, impact.deletedRelPaths);
  return impact;
}

/**
 * Create a new page in `dirRelPath` ("" = workspace root) from a user
 * title: sanitize → dedupe (`-1`, `-2`, …) → canonical frontmatter via
 * `newPageMarkdown` → `create_page` → index update.
 * Returns the rel path of the created page.
 */
export async function createNewPage(
  root: string,
  dirRelPath: string,
  title: string,
  fs: PageFs = defaultFs,
): Promise<string> {
  const safe = sanitizeTitle(title);
  const tree = await fs.listTree(root);
  const siblings = findDirChildren(tree, dirRelPath).map((e) => e.name);
  const name = dedupeName(safe, siblings);
  const relPath = joinRel(dirRelPath, `${name}.md`);
  const markdown = newPageMarkdown(name);
  await fs.createPage(root, relPath, markdown);
  await fs.indexPutPages(root, [pagePutFor(relPath, markdown)]);
  return relPath;
}

// ---------------------------------------------------------------------------
// M5 templates (INTERFACES.md §9.1)
// ---------------------------------------------------------------------------

/** Frontmatter key order shared with `newPageMarkdown` (diff-friendly). */
const TEMPLATE_META_KEY_ORDER = ["id", "title", "template", "created", "updated"] as const;

/**
 * Instantiate a template (pure): parse the raw template, replace the
 * frontmatter `id` with a fresh ULID, `title` with the given title and
 * `created` with today; a stale `updated` is dropped. The YAML node value
 * is rewritten via the `yaml` package and the whole document is
 * re-serialized through the canonical pipeline (`stringifyMarkdown`) — the
 * only producer of `.md` bytes.
 */
export function instantiateTemplate(
  templateRaw: string,
  title: string,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const tree = structuredClone(parseMarkdown(templateRaw));
  const yamlNode = tree.children.find((c) => c.type === "yaml");

  let meta: Record<string, unknown> = {};
  if (yamlNode !== undefined) {
    try {
      const parsed: unknown = parseYaml(yamlNode.value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed template frontmatter → replace it wholesale
    }
  }
  meta.id = ulid();
  meta.title = title;
  meta.created = today;
  delete meta.updated;

  const ordered: Record<string, unknown> = {};
  for (const key of TEMPLATE_META_KEY_ORDER) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  for (const key of Object.keys(meta)) {
    if (!(TEMPLATE_META_KEY_ORDER as readonly string[]).includes(key)) {
      ordered[key] = meta[key];
    }
  }
  const yamlText = stringifyYaml(ordered).replace(/\n+$/, "");

  if (yamlNode !== undefined) {
    yamlNode.value = yamlText;
  } else {
    tree.children.unshift({ type: "yaml", value: yamlText });
  }
  return stringifyMarkdown(tree);
}

/**
 * Create a page from a template (INTERFACES.md §9.1): sanitize + dedupe the
 * title like {@link createNewPage}, instantiate the template (fresh id,
 * title, created = today) and `create_page` + index update.
 * Returns the rel path of the created page.
 */
export async function createPageFromTemplate(
  root: string,
  dirRelPath: string,
  title: string,
  templateRaw: string,
  fs: PageFs = defaultFs,
): Promise<string> {
  const safe = sanitizeTitle(title);
  const tree = await fs.listTree(root);
  const siblings = findDirChildren(tree, dirRelPath).map((e) => e.name);
  const name = dedupeName(safe, siblings);
  const relPath = joinRel(dirRelPath, `${name}.md`);
  const markdown = instantiateTemplate(templateRaw, name);
  await fs.createPage(root, relPath, markdown);
  await fs.indexPutPages(root, [pagePutFor(relPath, markdown)]);
  return relPath;
}

/**
 * Save the page at `relPath` as a user template: byte-exact copy to
 * `templates/<sanitized-name>.md` with `create_page` semantics (error when
 * the name is taken). The id is kept on purpose — it is replaced on every
 * instantiation. Returns the template's rel path.
 */
export async function saveAsTemplate(
  root: string,
  relPath: string,
  name: string,
  fs: PageFs = defaultFs,
): Promise<string> {
  const safe = sanitizeTitle(name);
  const content = await fs.readFile(root, relPath);
  const destRel = joinRel("templates", `${safe}.md`);
  await fs.createPage(root, destRel, content);
  await fs.indexPutPages(root, [pagePutFor(destRel, content)]);
  return destRel;
}
