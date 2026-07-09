// Track X — mdast (post embed-resolution) → standalone HTML (INTERFACES.md §6.1).
//
// Renders the resolved tree via mdast-util-to-hast + rehype-stringify with
// the same directive-handler approach as renderPreviewHtml (pipeline.ts),
// but produces a complete self-contained document: <!doctype html>, <title>,
// inline Notion-ish CSS, no external assets. GFM (tables, task lists,
// strikethrough) renders through the default mdast→hast handlers.

import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Root } from "mdast";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import { toHast, type Handlers, type State } from "mdast-util-to-hast";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

export interface HtmlDocumentOptions {
  /** Document title (frontmatter title → file name, decided by the caller). */
  title: string;
  /**
   * Append a script that calls window.print() once the page has loaded
   * (used by the PDF backend, pdf.ts).
   */
  autoPrint?: boolean;
}

// ---------------------------------------------------------------------------
// Directive handlers — leftover directives after embed resolution render as
// inert labelled blocks (embeds are normally gone by the time we get here;
// unresolved ones were already replaced with placeholder paragraphs).
// ---------------------------------------------------------------------------

function blockDirectiveToHast(
  state: State,
  node: LeafDirective | ContainerDirective,
): Element | ElementContent {
  const element: Element = {
    type: "element",
    tagName: "div",
    properties: { className: ["directive", `directive-${node.name}`] },
    children: state.all(node) as ElementContent[],
  };
  state.patch(node, element);
  return state.applyData(node, element);
}

const exportHandlers: Handlers = {
  leafDirective(state: State, node: LeafDirective) {
    return blockDirectiveToHast(state, node);
  },
  containerDirective(state: State, node: ContainerDirective) {
    return blockDirectiveToHast(state, node);
  },
  textDirective(state: State, node: TextDirective) {
    const element: Element = {
      type: "element",
      tagName: "span",
      properties: { className: ["directive", `directive-${node.name}`] },
      children: state.all(node) as ElementContent[],
    };
    state.patch(node, element);
    return state.applyData(node, element);
  },
};

const htmlCompiler = unified().use(rehypeStringify).freeze();

// ---------------------------------------------------------------------------
// Inline CSS — the Notion-ish reading style (adapted from editor.css)
// ---------------------------------------------------------------------------

const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica,
      "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
    font-size: 16px;
    line-height: 1.7;
    color: #37352f;
  }
  article.page {
    max-width: 46rem;
    margin: 0 auto;
    padding: 48px 48px 96px;
  }
  article.page > * + * { margin-top: 0.5em; }
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    line-height: 1.3;
    color: #1c1b18;
    margin-bottom: 0;
  }
  h1 { font-size: 1.875em; margin-top: 1.1em; }
  h2 { font-size: 1.5em; margin-top: 1em; }
  h3 { font-size: 1.25em; margin-top: 0.9em; }
  h4 { font-size: 1.1em; }
  h5 { font-size: 1em; }
  h6 { font-size: 0.9em; letter-spacing: 0.02em; }
  header.page-title h1 { margin-top: 0; }
  blockquote {
    border-left: 3px solid #d9d5cd;
    margin: 0.5em 0 0;
    padding-left: 14px;
    color: #57534a;
  }
  code {
    background: #f1efe9;
    border-radius: 4px;
    padding: 0.15em 0.35em;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.875em;
    color: #b3591b;
  }
  pre {
    background: #f6f5f1;
    border: 1px solid #e7e5e0;
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
  }
  pre code {
    background: none;
    padding: 0;
    color: #37352f;
    font-size: 0.85em;
    line-height: 1.6;
  }
  ul, ol { padding-left: 1.5em; margin: 0.5em 0 0; }
  hr { border: none; border-top: 1px solid #d9d5cd; margin: 1.5em 0; }
  img { max-width: 100%; border-radius: 4px; }
  a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75em 0;
    font-size: 0.95em;
  }
  th, td {
    border: 1px solid #e0ddd6;
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  th { background: #f6f5f1; font-weight: 600; }
  li.task-list-item, li:has(> input[type="checkbox"]) { list-style: none; }
  ul:has(> li > input[type="checkbox"]) { padding-left: 0.25em; }
  input[type="checkbox"] { margin-right: 8px; }
  .directive {
    border: 1px dashed #d9d5cd;
    border-radius: 6px;
    background: #faf9f6;
    padding: 6px 10px;
    margin: 0.4em 0;
  }
  span.directive {
    display: inline-flex;
    border-radius: 4px;
    background: #eef1f6;
    border: 1px solid #dbe1ec;
    padding: 0 6px;
    font-size: 0.85em;
  }
  @media print {
    article.page { padding: 0; max-width: none; }
    a { color: inherit; }
  }
`;

const AUTO_PRINT_SCRIPT =
  '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},200);});</script>';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render the body of a (resolved) mdast tree to an HTML fragment. */
export function mdastToHtmlBody(tree: Root): string {
  const body: Root = {
    ...tree,
    children: tree.children.filter((child) => child.type !== "yaml"),
  };
  const hast = toHast(body, { handlers: exportHandlers }) as HastRoot;
  return String(htmlCompiler.stringify(hast));
}

/**
 * Standalone, self-contained HTML document for a resolved mdast tree:
 * doctype + <title> + inline CSS + rendered body. No external assets.
 */
export function mdastToHtmlDocument(tree: Root, opts: HtmlDocumentOptions): string {
  const title = escapeHtml(opts.title);
  const body = mdastToHtmlBody(tree);
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${EXPORT_CSS}</style>`,
    "</head>",
    "<body>",
    '<article class="page">',
    `<header class="page-title"><h1>${title}</h1></header>`,
    body,
    "</article>",
    opts.autoPrint === true ? AUTO_PRINT_SCRIPT : "",
    "</body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
