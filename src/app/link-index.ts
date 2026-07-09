// Track U — link-index orchestration (INTERFACES.md §5.3).
//
// Markdown parsing happens ONLY here on the TS side (remark, via the
// canonical pipeline); the Rust index just stores and queries the results.

import { extractRefs, parseMarkdown, readFrontmatter } from "../markdown";
import { pageNameFromRelPath, flattenMdPages } from "./paths";
import {
  indexClear,
  indexPutPages,
  listTree,
  readFile,
  type PagePut,
} from "./workspace";

/** Display title: frontmatter `title`, else derived from the rel path. */
export function titleOf(md: string, relPath: string): string {
  const meta = readFrontmatter(md);
  if (meta !== null && typeof meta.title === "string" && meta.title !== "") {
    return meta.title;
  }
  return pageNameFromRelPath(relPath);
}

/** Build the index record (page meta + outgoing refs) for one page. */
export function pagePutFor(relPath: string, markdown: string): PagePut {
  const tree = parseMarkdown(markdown);
  const refs = extractRefs(tree);
  const meta = readFrontmatter(markdown);
  const str = (v: unknown): string | null =>
    typeof v === "string" && v !== "" ? v : null;
  return {
    page: {
      relPath,
      id: str(meta?.id),
      title: str(meta?.title),
      template: str(meta?.template),
    },
    refs: [
      ...refs.links.map((l) => ({ kind: "link" as const, target: l.target })),
      ...refs.embeds.map((e) => ({ kind: "embed" as const, target: e.target })),
    ],
  };
}

export interface IndexBuildResult {
  pages: number;
  errors: { relPath: string; message: string }[];
}

/**
 * Full workspace scan: walk the tree, parse every `.md` page, then replace
 * the index contents (`index_clear` + one batched `index_put_pages`).
 */
export async function buildIndex(root: string): Promise<IndexBuildResult> {
  const tree = await listTree(root);
  const relPaths = flattenMdPages(tree);
  const puts: PagePut[] = [];
  const errors: IndexBuildResult["errors"] = [];
  for (const relPath of relPaths) {
    try {
      puts.push(pagePutFor(relPath, await readFile(root, relPath)));
    } catch (e) {
      errors.push({ relPath, message: e instanceof Error ? e.message : String(e) });
    }
  }
  await indexClear(root);
  if (puts.length > 0) await indexPutPages(root, puts);
  return { pages: puts.length, errors };
}

/** Post-save hook: re-index a single page from its just-saved markdown. */
export async function updatePageInIndex(
  root: string,
  relPath: string,
  markdown: string,
): Promise<void> {
  await indexPutPages(root, [pagePutFor(relPath, markdown)]);
}
