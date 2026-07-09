// Markdown canonical pipeline (INTERFACES.md §3).
//
// This module is the ONLY producer of `.md` bytes in Hakushi. Every write to
// disk goes through `normalizeMarkdown` (or content built by
// `newPageMarkdown`), so on-disk bytes are always in canonical form and git
// diffs stay clean.

import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Paragraph, Root } from "mdast";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import { toHast, type Handlers, type State } from "mdast-util-to-hast";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify, { type Options as StringifyOptions } from "remark-stringify";
import { unified } from "unified";
import { ulid } from "ulid";
import { visit } from "unist-util-visit";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { remarkHakushiEmbed } from "./remark-hakushi-embed";

// ---------------------------------------------------------------------------
// Processors
// ---------------------------------------------------------------------------

/** Canonical, deterministic serializer settings (INTERFACES.md §3). */
const CANONICAL_STRINGIFY_OPTIONS: StringifyOptions = {
  bullet: "-",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  ruleSpaces: false,
  setext: false,
  incrementListMarker: true,
  tightDefinitions: true,
};

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkDirective)
  .use(remarkHakushiEmbed)
  .freeze();

const serializer = unified()
  .use(remarkStringify, CANONICAL_STRINGIFY_OPTIONS)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkDirective)
  .freeze();

/**
 * Parse markdown into mdast. Tolerant input: GFM, YAML frontmatter,
 * directives, and `![[wikilinks]]` (converted to `embed` leaf directives by
 * `remarkHakushiEmbed`).
 */
export function parseMarkdown(md: string): Root {
  const tree = parser.parse(md);
  return parser.runSync(tree) as Root;
}

/**
 * Deterministic canonical serialization of an mdast tree.
 * Always ends with exactly one trailing `"\n"`.
 */
export function stringifyMarkdown(tree: Root): string {
  const out = String(serializer.stringify(tree));
  return out.replace(/\n*$/, "\n");
}

/**
 * Canonicalize markdown: `stringifyMarkdown(parseMarkdown(md))`.
 * Idempotent: `normalizeMarkdown(normalizeMarkdown(x)) === normalizeMarkdown(x)`.
 */
export function normalizeMarkdown(md: string): string {
  return stringifyMarkdown(parseMarkdown(md));
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Page metadata stored in YAML frontmatter. */
export interface PageMeta {
  id?: string;
  title?: string;
  template?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

/** Stable key order for frontmatter (diff-friendly). */
const META_KEY_ORDER = ["id", "title", "template", "created", "updated"] as const;

// Opening `---` line, YAML body (possibly empty), closing `---` line
// (with trailing newline unless at end of input). Anchored at byte 0.
const FRONTMATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;

/**
 * Split raw markdown into raw frontmatter text and body.
 * `frontmatter` includes the `---` fences and the trailing newline
 * (`"---\n...\n---\n"`), or is `null` when the document has none.
 * `joinFrontmatter(splitFrontmatter(md))` is byte-exact.
 */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER_RE.exec(md);
  if (match === null) return { frontmatter: null, body: md };
  return { frontmatter: match[0], body: md.slice(match[0].length) };
}

/** Re-join raw frontmatter (as returned by `splitFrontmatter`) and body. */
export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return frontmatter.endsWith("\n") ? frontmatter + body : frontmatter + "\n" + body;
}

/**
 * Parse the YAML frontmatter of a document into `PageMeta`.
 * Returns `null` when there is no frontmatter or it is not a YAML mapping.
 */
export function readFrontmatter(md: string): PageMeta | null {
  const { frontmatter } = splitFrontmatter(md);
  if (frontmatter === null) return null;
  const yamlSource = frontmatter
    .replace(/^---\r?\n/, "")
    .replace(/(?:^|\r?\n)---(?:\r?\n|$)$/, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as PageMeta;
}

/** Serialize meta to a raw frontmatter block with stable key order. */
function stringifyFrontmatterMeta(meta: PageMeta): string {
  const ordered: Record<string, unknown> = {};
  for (const key of META_KEY_ORDER) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  for (const key of Object.keys(meta)) {
    if (!(META_KEY_ORDER as readonly string[]).includes(key) && meta[key] !== undefined) {
      ordered[key] = meta[key];
    }
  }
  const yamlText = stringifyYaml(ordered).replace(/\n+$/, "");
  return `---\n${yamlText}\n---\n`;
}

/**
 * Canonical content for a brand-new page: YAML frontmatter with a fresh
 * `ulid()` id, the given title, and today's ISO date as `created`.
 * Key order: id, title, template, created, updated, then others.
 * The result is already canonical (`normalizeMarkdown` is a no-op on it).
 */
export function newPageMarkdown(title: string): string {
  const meta: PageMeta = {
    id: ulid(),
    title,
    created: new Date().toISOString().slice(0, 10),
  };
  return joinFrontmatter(stringifyFrontmatterMeta(meta), "");
}

// ---------------------------------------------------------------------------
// Refs / folder pages (INTERFACES.md §5.4)
// ---------------------------------------------------------------------------

/** References a page makes to other pages (for the id⇄path link index). */
export interface PageRefs {
  /** Relative `.md` link targets (external URLs / anchors excluded). */
  links: { target: string; position?: unknown }[];
  /** `::embed` / `:::embed` directives (`page` attribute + `mode`). */
  embeds: { target: string; mode: string }[];
}

// A scheme prefix (`http:`, `https:`, `mailto:`, …) marks an external URL.
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Is `url` a workspace-relative `.md` target? Excludes external URLs
 * (any scheme, protocol-relative `//`), anchor-only links (`#…`), and
 * absolute paths. A `#fragment` or `?query` suffix is tolerated.
 */
function isRelativeMdTarget(url: string): boolean {
  if (url === "" || url.startsWith("#")) return false;
  if (URL_SCHEME_RE.test(url) || url.startsWith("//") || url.startsWith("/")) return false;
  const path = url.split(/[#?]/, 1)[0];
  return /\.md$/i.test(path);
}

function isEmbedDirective(node: {
  type: string;
  name?: string;
}): node is LeafDirective | ContainerDirective {
  return (
    (node.type === "leafDirective" || node.type === "containerDirective") &&
    node.name === "embed"
  );
}

/**
 * Collect outgoing references from a parsed page (INTERFACES.md §5.3/§5.4):
 * - `links`: relative `.md` targets from `link` and `definition` nodes
 *   (`linkReference` targets live in their `definition`, so collecting
 *   definitions covers reference-style links exactly once).
 * - `embeds`: `embed` directives — raw `page` attribute + `mode`
 *   (default `"inline"`).
 * Walks the whole tree (list items, blockquotes, tables, …).
 */
export function extractRefs(tree: Root): PageRefs {
  const links: PageRefs["links"] = [];
  const embeds: PageRefs["embeds"] = [];
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "definition") {
      if (isRelativeMdTarget(node.url)) {
        links.push(
          node.position !== undefined
            ? { target: node.url, position: node.position }
            : { target: node.url },
        );
      }
    } else if (isEmbedDirective(node)) {
      const page = node.attributes?.page;
      if (page !== undefined && page !== null && page !== "") {
        embeds.push({ target: page, mode: node.attributes?.mode ?? "inline" });
      }
    }
  });
  return { links, embeds };
}

/** A paragraph that renders as nothing (whitespace-only text). */
function isBlankParagraph(paragraph: Paragraph): boolean {
  return paragraph.children.every(
    (child) => child.type === "text" && child.value.trim() === "",
  );
}

/**
 * Folder page = body (excluding the `yaml` frontmatter node) consists of
 * embed directives only, at least one (DESIGN.md folder-note computed
 * rendering). Whitespace-only paragraphs are skipped; an empty body is not
 * a folder page.
 */
export function isFolderPage(tree: Root): boolean {
  let embedCount = 0;
  for (const child of tree.children) {
    if (child.type === "yaml") continue;
    if (isEmbedDirective(child)) {
      embedCount += 1;
      continue;
    }
    if (child.type === "paragraph" && isBlankParagraph(child)) continue;
    return false;
  }
  return embedCount > 0;
}

/**
 * Rewrite reference targets (move/rename follow-up, INTERFACES.md §5.5).
 * Calls `rewrite(target, kind)` for every relative `.md` link target
 * (`link` + `definition` nodes) and every embed `page` attribute; a `null`
 * return keeps the target. The input tree is never mutated — a deep clone
 * is returned along with whether anything changed.
 */
export function rewriteRefs(
  tree: Root,
  rewrite: (target: string, kind: "link" | "embed") => string | null,
): { tree: Root; changed: boolean } {
  const cloned = structuredClone(tree);
  let changed = false;
  visit(cloned, (node) => {
    if (node.type === "link" || node.type === "definition") {
      if (isRelativeMdTarget(node.url)) {
        const next = rewrite(node.url, "link");
        if (next !== null && next !== node.url) {
          node.url = next;
          changed = true;
        }
      }
    } else if (isEmbedDirective(node)) {
      const page = node.attributes?.page;
      if (page !== undefined && page !== null && page !== "") {
        const next = rewrite(page, "embed");
        if (next !== null && next !== page) {
          node.attributes = { ...node.attributes, page: next };
          changed = true;
        }
      }
    }
  });
  return { tree: cloned, changed };
}

// ---------------------------------------------------------------------------
// Read-only preview HTML (INTERFACES.md §5.4)
// ---------------------------------------------------------------------------

/** Concatenated text of an mdast subtree. */
function allText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(allText).join("");
  return "";
}

/** Human label of an embed directive (leaf: children; container: `[label]`). */
function embedLabel(node: LeafDirective | ContainerDirective): string {
  if (node.type === "leafDirective") return allText(node).trim();
  const first = node.children[0];
  if (
    first !== undefined &&
    first.type === "paragraph" &&
    (first.data as { directiveLabel?: boolean } | undefined)?.directiveLabel === true
  ) {
    return allText(first).trim();
  }
  return "";
}

/** Both leaf and container `embed` directives become a placeholder div. */
function directiveToHast(
  state: State,
  node: LeafDirective | ContainerDirective,
): Element | ElementContent {
  if (node.name === "embed") {
    const page = node.attributes?.page ?? "";
    const mode = node.attributes?.mode ?? "inline";
    const label = embedLabel(node);
    const element: Element = {
      type: "element",
      tagName: "div",
      properties: { className: ["embed-ref"], dataPage: page, dataMode: mode },
      children: [{ type: "text", value: label === "" ? page : label }],
    };
    state.patch(node, element);
    return state.applyData(node, element);
  }
  // Other block directives: generic wrapper, children rendered normally.
  const element: Element = {
    type: "element",
    tagName: "div",
    properties: { className: ["directive", `directive-${node.name}`] },
    children: state.all(node) as ElementContent[],
  };
  state.patch(node, element);
  return state.applyData(node, element);
}

const previewHandlers: Handlers = {
  leafDirective(state: State, node: LeafDirective) {
    return directiveToHast(state, node);
  },
  containerDirective(state: State, node: ContainerDirective) {
    return directiveToHast(state, node);
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

/**
 * Read-only preview HTML for embed cards (INTERFACES.md §5.6):
 * `parseMarkdown` → drop the `yaml` frontmatter node → mdast→hast →
 * `rehype-stringify`. GFM tables and task lists render via the default
 * handlers; embed directives (leaf and container) render as
 * `<div class="embed-ref" data-page="…" data-mode="…">label|page</div>`.
 * Raw HTML in the source is dropped (safe default).
 */
export function renderPreviewHtml(md: string): string {
  const tree = parseMarkdown(md);
  const body: Root = {
    ...tree,
    children: tree.children.filter((child) => child.type !== "yaml"),
  };
  const hast = toHast(body, { handlers: previewHandlers }) as HastRoot;
  return String(htmlCompiler.stringify(hast));
}
