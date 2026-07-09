// Track S3 — static site publish (INTERFACES.md §11.4, M7-M8-PLAN.md §1.9).
//
//   exportSite(root)         — every .md page → .html (embeds resolved via the
//                              M3 machinery, page-to-page links rewritten
//                              .md → .html) + index.html, all sharing a nav
//                              sidebar built from the workspace tree.
//   publishSiteToFolder(root) — directory picker → `write_site_files` Tauri
//                              command (1 IPC for the whole site).
//
// The core (`buildSiteFiles`) is pure: workspace access is injected as a
// `SiteSource`, so vitest exercises everything with in-memory fakes — no
// Tauri, no DOM. `exportSite` wires the real workspace (listTree/readFile +
// the resolver-backed EmbedSource from index.ts).
//
// Rust side (integrator handoff, NOT implemented in this track):
//   write_site_files(base_dir: String, files: Vec<SiteFile>) -> Result<u32, String>
//   SiteFile { rel_path: String, content: String } with
//   #[serde(rename_all = "camelCase")] (TS sends { relPath, content }),
//   creating parent directories as needed, rejecting rel_paths escaping
//   base_dir (same path rules as fs_commands.rs).
//
// Browser (non-Tauri) note: there is no directory picker / fs. The dev-only
// behaviour is: `exportSite` works (mock workspace), `publishSiteToFolder`
// generates nothing on disk and returns null; PublishMenuItem.tsx shows the
// generated file count instead. No per-file Blob download spam by design.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import {
  dirnameRel,
  flattenMdPages,
  pageNameFromRelPath,
  relPathBetween,
  splitTargetSuffix,
} from "../app/paths";
import {
  isTauri,
  listTree,
  readFile,
  type TreeEntry,
} from "../app/workspace";
import { parseMarkdown, readFrontmatter, rewriteRefs, splitFrontmatter } from "../markdown";
import { mdastToHtmlDocument } from "./html";
import { workspaceEmbedSource } from "./index";
import { resolveEmbedsInTree, type EmbedSource } from "./resolve-embeds";

// ---------------------------------------------------------------------------
// Contract types (INTERFACES.md §11.4)
// ---------------------------------------------------------------------------

export interface SiteFile {
  /** Output path relative to the chosen destination folder (`/`-separated). */
  relPath: string;
  content: string;
}

/** Injected workspace access; exportSite() wires the real one. */
export interface SiteSource {
  listTree(): Promise<TreeEntry[]>;
  /** Raw page markdown, frontmatter included. */
  readPage(relPath: string): Promise<string>;
  embeds: EmbedSource;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** `foo.md` → `foo.html`, keeping directories and `#fragment`/`?query`. */
export function mdTargetToHtml(target: string): string {
  const { path, suffix } = splitTargetSuffix(target);
  if (!/\.md$/i.test(path)) return target;
  return `${path.slice(0, -3)}.html${suffix}`;
}

const htmlPathOf = (relPath: string): string => relPath.replace(/\.md$/i, ".html");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One entry of the shared nav sidebar. */
export interface NavNode {
  label: string;
  /** Site-root-relative .html path; null for a plain directory (no index.md). */
  htmlPath: string | null;
  children: NavNode[];
}

const isIndexMd = (e: TreeEntry): boolean => !e.isDir && e.name.toLowerCase() === "index.md";

/**
 * Nav model from the workspace tree (tree order = sidebar order).
 * Directories with an index.md (folder notes) link to `dir/index.html`;
 * plain directories become non-link labels. The folder note's index.md
 * itself is not repeated as a child entry.
 */
export function buildNavTree(
  entries: TreeEntry[],
  titles: ReadonlyMap<string, string>,
): NavNode[] {
  const out: NavNode[] = [];
  for (const e of entries) {
    if (e.isDir) {
      const children = e.children ?? [];
      const index = children.find(isIndexMd);
      out.push({
        label:
          index !== undefined ? (titles.get(index.relPath) ?? e.name) : e.name,
        htmlPath: index !== undefined ? htmlPathOf(index.relPath) : null,
        children: buildNavTree(children.filter((c) => !isIndexMd(c)), titles),
      });
    } else if (/\.md$/i.test(e.name)) {
      out.push({
        label: titles.get(e.relPath) ?? pageNameFromRelPath(e.relPath),
        htmlPath: htmlPathOf(e.relPath),
        children: [],
      });
    }
  }
  return out;
}

/**
 * Render the nav model to HTML for the page that lives in directory
 * `fromDir` ("" = site root). Hrefs are relative to that page so the site
 * works from file:// and any hosting sub-path. `currentHtmlPath` gets
 * class="current".
 */
export function renderNavHtml(
  nodes: NavNode[],
  currentHtmlPath: string | null,
  fromDir: string,
): string {
  const href = (htmlPath: string): string =>
    escapeHtml(relPathBetween(fromDir, htmlPath));
  const item = (n: NavNode): string => {
    const label = escapeHtml(n.label);
    const self =
      n.htmlPath === null
        ? `<span class="nav-label">${label}</span>`
        : `<a href="${href(n.htmlPath)}"${
            n.htmlPath === currentHtmlPath ? ' class="current" aria-current="page"' : ""
          }>${label}</a>`;
    const kids =
      n.children.length > 0
        ? `<ul>${n.children.map((c) => `<li>${item(c)}</li>`).join("")}</ul>`
        : "";
    return self + kids;
  };
  return [
    '<nav class="site-nav">',
    `<a class="site-home" href="${href("index.html")}">ホーム</a>`,
    `<ul>${nodes.map((n) => `<li>${item(n)}</li>`).join("")}</ul>`,
    "</nav>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Site chrome — nav sidebar injected into the M3 HTML document
// ---------------------------------------------------------------------------

const SITE_CSS = `
  .site-layout { display: flex; align-items: flex-start; }
  nav.site-nav {
    position: sticky; top: 0;
    flex: 0 0 220px;
    max-height: 100vh; overflow-y: auto;
    padding: 32px 8px 32px 24px;
    font-size: 0.9em;
    border-right: 1px solid #e7e5e0;
  }
  nav.site-nav ul { list-style: none; margin: 0; padding-left: 0; }
  nav.site-nav ul ul { padding-left: 1em; }
  nav.site-nav li { margin: 2px 0; }
  nav.site-nav a {
    display: inline-block; padding: 2px 6px; border-radius: 4px;
    color: #57534a; text-decoration: none;
  }
  nav.site-nav a:hover { background: #f1efe9; }
  nav.site-nav a.current { background: #f1efe9; color: #1c1b18; font-weight: 600; }
  nav.site-nav a.site-home { font-weight: 700; color: #1c1b18; margin-bottom: 8px; }
  nav.site-nav .nav-label { display: inline-block; padding: 2px 6px; color: #8f8a80; }
  .site-layout article.page { flex: 1 1 auto; min-width: 0; }
  @media (max-width: 720px) {
    .site-layout { flex-direction: column; }
    nav.site-nav {
      position: static; flex: none; width: 100%; max-height: none;
      border-right: none; border-bottom: 1px solid #e7e5e0;
      padding: 16px 24px;
    }
  }
  @media print { nav.site-nav { display: none; } }
`;

/**
 * Wrap the article of an mdastToHtmlDocument() output in a
 * `.site-layout` flex row with the nav sidebar, and append the site CSS.
 * (html.ts is owned by M3 and stays untouched; its document format is
 * deterministic and covered by the site tests.)
 */
function injectSiteChrome(docHtml: string, navHtml: string): string {
  const withCss = docHtml.replace("</head>", `<style>${SITE_CSS}</style>\n</head>`);
  const opened = withCss.replace(
    '<article class="page">',
    `<div class="site-layout">\n${navHtml}\n<article class="page">`,
  );
  const close = opened.lastIndexOf("</article>");
  if (close === -1) return opened; // defensive; format is fixed by html.ts
  return `${opened.slice(0, close)}</article>\n</div>${opened.slice(close + "</article>".length)}`;
}

// ---------------------------------------------------------------------------
// Site build (pure core)
// ---------------------------------------------------------------------------

interface LoadedPage {
  relPath: string;
  title: string;
  body: string;
}

async function loadPages(src: SiteSource, relPaths: string[]): Promise<LoadedPage[]> {
  const out: LoadedPage[] = [];
  for (const relPath of relPaths) {
    const raw = await src.readPage(relPath);
    const fmTitle = readFrontmatter(raw)?.title;
    out.push({
      relPath,
      title:
        typeof fmTitle === "string" && fmTitle.trim() !== ""
          ? fmTitle
          : pageNameFromRelPath(relPath),
      body: splitFrontmatter(raw).body,
    });
  }
  return out;
}

/** parse → resolve embeds → rewrite .md links → M3 HTML doc → nav chrome. */
async function renderPage(
  page: LoadedPage,
  outHtmlPath: string,
  nav: NavNode[],
  src: SiteSource,
): Promise<string> {
  const parsed = parseMarkdown(page.body);
  const resolved = await resolveEmbedsInTree(parsed, src.embeds, {
    chain: [page.relPath],
  });
  const { tree: rewritten } = rewriteRefs(resolved, (target, kind) =>
    kind === "link" ? mdTargetToHtml(target) : null,
  );
  const doc = mdastToHtmlDocument(rewritten, { title: page.title });
  const navHtml = renderNavHtml(nav, outHtmlPath, dirnameRel(outHtmlPath));
  return injectSiteChrome(doc, navHtml);
}

/**
 * The landing page for index.html: Welcome.md, else the first root-level
 * page, else the first page in tree order. (A root `index.md`, when present,
 * already becomes index.html — no landing page is synthesized then.)
 */
export function pickLandingPage(relPaths: readonly string[]): string | null {
  if (relPaths.length === 0) return null;
  return (
    relPaths.find((p) => p === "Welcome.md") ??
    relPaths.find((p) => !p.includes("/")) ??
    relPaths[0]
  );
}

/** Build every site file from an injected source (pure core of exportSite). */
export async function buildSiteFiles(src: SiteSource): Promise<{ files: SiteFile[] }> {
  const tree = await src.listTree();
  const relPaths = flattenMdPages(tree);
  const pages = await loadPages(src, relPaths);

  const titles = new Map<string, string>(pages.map((p) => [p.relPath, p.title]));
  const nav = buildNavTree(tree, titles);

  const files: SiteFile[] = [];
  for (const page of pages) {
    const outPath = htmlPathOf(page.relPath);
    files.push({ relPath: outPath, content: await renderPage(page, outPath, nav, src) });
  }

  // index.html — a root index.md IS the site index; otherwise synthesize the
  // landing from Welcome / the first page (its own .html also stays).
  if (!relPaths.includes("index.md")) {
    const landingRel = pickLandingPage(relPaths);
    if (landingRel === null) {
      const empty = mdastToHtmlDocument(parseMarkdown("(ページがありません)\n"), {
        title: "Hakushi",
      });
      files.push({
        relPath: "index.html",
        content: injectSiteChrome(empty, renderNavHtml(nav, null, "")),
      });
    } else {
      const landing = pages.find((p) => p.relPath === landingRel);
      if (landing !== undefined) {
        // Note: rendered at the site root — relative links inside a nested
        // landing body would be off; pickLandingPage prefers root-level pages.
        const parsed = parseMarkdown(landing.body);
        const resolved = await resolveEmbedsInTree(parsed, src.embeds, {
          chain: [landing.relPath],
        });
        const { tree: rewritten } = rewriteRefs(resolved, (target, kind) =>
          kind === "link" ? mdTargetToHtml(target) : null,
        );
        const doc = mdastToHtmlDocument(rewritten, { title: landing.title });
        files.push({
          relPath: "index.html",
          content: injectSiteChrome(
            doc,
            renderNavHtml(nav, htmlPathOf(landing.relPath), ""),
          ),
        });
      }
    }
  }

  return { files };
}

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §11.4)
// ---------------------------------------------------------------------------

/** Export the whole workspace as a static HTML site (in memory). */
export async function exportSite(root: string): Promise<{ files: SiteFile[] }> {
  return buildSiteFiles({
    listTree: () => listTree(root),
    readPage: (relPath) => readFile(root, relPath),
    embeds: workspaceEmbedSource(root),
  });
}

/**
 * Pick a destination folder and write the whole site there via the
 * `write_site_files` command (one IPC). Returns the destination path, or
 * null when the dialog was cancelled — or in the browser dev mock, where
 * nothing can be written (PublishMenuItem shows the dev-only count instead).
 */
export async function publishSiteToFolder(root: string): Promise<string | null> {
  if (!isTauri()) {
    const { files } = await exportSite(root);
    console.info(
      `[site] dev mode: generated ${files.length} files (not written to disk)`,
    );
    return null;
  }
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return null;

  const { files } = await exportSite(root);
  await invoke<number>("write_site_files", { baseDir: picked, files });
  return picked;
}
