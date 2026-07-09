// Track U — page resolution for the editor layer (contract with track V,
// INTERFACES.md §5.6). Signatures are binding; do not change without
// updating INTERFACES.md and the editor side.

import { splitFrontmatter } from "../markdown";
import { dirnameRel, findDirChildren, pageNameFromRelPath } from "./paths";
import { indexLookup, listTree, readFile } from "./workspace";

export interface ResolvedPage {
  relPath: string;
  title: string | null;
}

/**
 * Resolve an embed/link target (page id or workspace-relative path, with
 * `.md` / `index.md` completion) via the link index. Returns `null` when
 * the target is unknown.
 */
export async function resolvePage(
  root: string,
  target: string,
): Promise<ResolvedPage | null> {
  const record = await indexLookup(root, target);
  if (record === null) return null;
  return {
    relPath: record.relPath,
    title: record.title ?? pageNameFromRelPath(record.relPath),
  };
}

/**
 * Child pages of a folder note (`mode="folder"` embeds): the entries inside
 * the directory containing that `index.md` — excluding the `index.md`
 * itself. Leaf `.md` files count as pages; subdirectories count via their
 * own `index.md` (when present). Order matches the sidebar tree. Non-folder
 * pages (anything not named `index.md`) have no children.
 */
export async function listChildPages(
  root: string,
  relPath: string,
): Promise<ResolvedPage[]> {
  if (relPath !== "index.md" && !relPath.endsWith("/index.md")) return [];
  const dir = dirnameRel(relPath);
  const tree = await listTree(root);
  const entries = findDirChildren(tree, dir);

  const childRelPaths: string[] = [];
  for (const entry of entries) {
    if (entry.isDir) {
      const hasIndex = (entry.children ?? []).some(
        (c) => !c.isDir && c.name === "index.md",
      );
      if (hasIndex) childRelPaths.push(`${entry.relPath}/index.md`);
    } else if (/\.md$/i.test(entry.name) && entry.relPath !== relPath) {
      childRelPaths.push(entry.relPath);
    }
  }

  return Promise.all(
    childRelPaths.map(async (child): Promise<ResolvedPage> => {
      const record = await indexLookup(root, child);
      return {
        relPath: child,
        title: record?.title ?? pageNameFromRelPath(child),
      };
    }),
  );
}

/** Page body without frontmatter (for embed previews). */
export async function readPageBody(root: string, relPath: string): Promise<string> {
  const raw = await readFile(root, relPath);
  return splitFrontmatter(raw).body;
}
