// Track X — export orchestration (INTERFACES.md §6.1): one resolved mdast,
// three outputs (HTML / Docx / PDF). DESIGN.md「1-AST-3-出力の契約」.
//
// Reading the page and resolving embeds goes through the real M2 machinery
// (src/app/resolver.ts → link index); the resolved tree is then handed to
// html.ts / docx.ts / pdf.ts. No `.md` bytes are ever produced here.

import type { Heading, Root, RootContent } from "mdast";

import { listChildPages, readPageBody, resolvePage } from "../app/resolver";
import { pageNameFromRelPath } from "../app/paths";
import { readFile } from "../app/workspace";
import { parseMarkdown, readFrontmatter, splitFrontmatter } from "../markdown";
import { mdastToDocx } from "./docx";
import { mdastToHtmlDocument } from "./html";
import { getPdfBackend, type PdfBackend } from "./pdf";
import { resolveEmbedsInTree, type EmbedSource } from "./resolve-embeds";

export type ExportFormat = "html" | "docx" | "pdf";

export interface ExportResult {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ExportPageOptions {
  /** Folder-note: append 配下ページ as H1-prefixed sections (recursive). */
  includeSubtree?: boolean;
  /** Override the PDF backend (tests); default WebviewPrintBackend. */
  pdfBackend?: PdfBackend;
}

const MIME_HTML = "text/html";
const MIME_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------------------
// Real EmbedSource over the workspace (resolver.ts + link index)
// ---------------------------------------------------------------------------

/** EmbedSource backed by the live workspace (INTERFACES.md §5.6 resolver). */
export function workspaceEmbedSource(root: string): EmbedSource {
  return {
    resolve: (target) => resolvePage(root, target),
    readBody: (relPath) => readPageBody(root, relPath),
    listChildren: (relPath) => listChildPages(root, relPath),
  };
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

function h1(text: string): Heading {
  return { type: "heading", depth: 1, children: [{ type: "text", value: text }] };
}

async function pageBodyTree(root: string, relPath: string): Promise<Root> {
  const raw = await readFile(root, relPath);
  const tree = parseMarkdown(splitFrontmatter(raw).body);
  return { ...tree, children: tree.children.filter((c) => c.type !== "yaml") };
}

/** Rel paths of the whole folder-note subtree, depth-first (page excluded). */
async function collectSubtreeRelPaths(
  root: string,
  relPath: string,
  visited: Set<string>,
): Promise<string[]> {
  const out: string[] = [];
  for (const child of await listChildPages(root, relPath)) {
    if (visited.has(child.relPath)) continue;
    visited.add(child.relPath);
    out.push(child.relPath);
    out.push(...(await collectSubtreeRelPaths(root, child.relPath, visited)));
  }
  return out;
}

/**
 * Drop top-level embed directives whose target resolves into `subtree` —
 * with includeSubtree those pages appear as full sections, and a folder
 * note's own body is typically exactly those embeds (avoid duplication).
 */
async function dropEmbedsInto(
  tree: Root,
  src: EmbedSource,
  subtree: ReadonlySet<string>,
): Promise<Root> {
  const kept: RootContent[] = [];
  for (const child of tree.children) {
    if (
      (child.type === "leafDirective" || child.type === "containerDirective") &&
      child.name === "embed"
    ) {
      const target = child.attributes?.page ?? "";
      const resolved = target === "" ? null : await src.resolve(target).catch(() => null);
      if (resolved !== null && subtree.has(resolved.relPath)) continue;
    }
    kept.push(child);
  }
  return { ...tree, children: kept };
}

/**
 * The fully resolved export tree for a page: its own body (embeds resolved,
 * cycle-guarded with the page itself on the chain), plus — when
 * `includeSubtree` — every descendant page as an H1-titled section.
 */
export async function buildExportTree(
  root: string,
  relPath: string,
  opts?: { includeSubtree?: boolean },
): Promise<Root> {
  const src = workspaceEmbedSource(root);
  let main = await pageBodyTree(root, relPath);

  if (opts?.includeSubtree !== true) {
    return resolveEmbedsInTree(main, src, { chain: [relPath] });
  }

  const visited = new Set<string>([relPath]);
  const subtreeRelPaths = await collectSubtreeRelPaths(root, relPath, visited);
  const subtreeSet = new Set(subtreeRelPaths);

  main = await dropEmbedsInto(main, src, subtreeSet);
  const resolved = await resolveEmbedsInTree(main, src, { chain: [relPath] });

  const sections: RootContent[] = [];
  for (const childRel of subtreeRelPaths) {
    const record = await resolvePage(root, childRel);
    sections.push(h1(record?.title ?? pageNameFromRelPath(childRel)));
    const body = await pageBodyTree(root, childRel);
    // Children of this page are their own sections; do not re-inline them.
    const deduped = await dropEmbedsInto(body, src, subtreeSet);
    const childResolved = await resolveEmbedsInTree(deduped, src, { chain: [childRel] });
    sections.push(...childResolved.children);
  }

  return { ...resolved, children: [...resolved.children, ...sections] };
}

// ---------------------------------------------------------------------------
// exportPage (contract §6.1)
// ---------------------------------------------------------------------------

/** Windows/macOS-hostile filename characters → "-". */
function safeFileName(title: string): string {
  const cleaned = title.replace(/[\/\\:*?"<>|]/g, "-").trim();
  return cleaned === "" ? "export" : cleaned;
}

async function pageTitle(root: string, relPath: string): Promise<string> {
  try {
    const raw = await readFile(root, relPath);
    const title = readFrontmatter(raw)?.title;
    if (typeof title === "string" && title.trim() !== "") return title;
  } catch {
    // fall through to the path-derived name
  }
  return pageNameFromRelPath(relPath);
}

/**
 * Export one page (INTERFACES.md §6.1).
 *   - html / docx: returns { fileName, mime, bytes } — hand to saveExport().
 *   - pdf: opens the print flow via PdfBackend and returns null.
 */
export async function exportPage(
  root: string,
  relPath: string,
  format: ExportFormat,
  opts?: ExportPageOptions,
): Promise<ExportResult | null> {
  const title = await pageTitle(root, relPath);
  const tree = await buildExportTree(root, relPath, {
    includeSubtree: opts?.includeSubtree,
  });

  switch (format) {
    case "html": {
      const html = mdastToHtmlDocument(tree, { title });
      return {
        fileName: `${safeFileName(title)}.html`,
        mime: MIME_HTML,
        bytes: new TextEncoder().encode(html),
      };
    }
    case "docx": {
      const bytes = await mdastToDocx(tree, { title });
      return { fileName: `${safeFileName(title)}.docx`, mime: MIME_DOCX, bytes };
    }
    case "pdf": {
      const html = mdastToHtmlDocument(tree, { title, autoPrint: true });
      await (opts?.pdfBackend ?? getPdfBackend()).openForPrint(html, title);
      return null;
    }
  }
}

export { saveExport } from "./save";
export { mdastToHtmlDocument, mdastToHtmlBody } from "./html";
export { mdastToDocx } from "./docx";
export { getPdfBackend, WebviewPrintBackend, type PdfBackend } from "./pdf";
export {
  resolveEmbedsInTree,
  type EmbedSource,
  type ResolvedRef,
  type ResolveEmbedsOptions,
} from "./resolve-embeds";
// Static site publish (Track S3, INTERFACES.md §11.4).
export {
  exportSite,
  publishSiteToFolder,
  buildSiteFiles,
  type SiteFile,
  type SiteSource,
} from "./site";
