// Track C — TipTap custom nodes for Hakushi directives (INTERFACES.md §4 rule 5).
//
// `HakushiEmbed` renders `::embed{...}` leaf directives and `:::embed{...}`
// containers as placeholder cards inside the WYSIWYG editor, and round-trips
// them byte-stably through the @tiptap/markdown pipeline:
//
//   - a custom marked block tokenizer (`markdownTokenizer`) recognizes the
//     directive syntax and captures the *exact* source text of the block,
//   - `parseMarkdown` stores that source in the node's `raw` attribute
//     (plus parsed `page` / `mode` / `label` / `content` for display),
//   - `renderMarkdown` re-emits `raw` verbatim, so after the caller runs the
//     output through `normalizeMarkdown` the directive bytes are unchanged.
//
// The node is an atom in M1 — its attributes cannot be edited in the WYSIWYG
// view, so `raw` can never go stale. Embeds inserted programmatically (no
// `raw`) are serialized from their attributes and then canonicalized by the
// remark pipeline on save.
//
// TODO(M2): make container-embed fallback content editable (currently kept
// verbatim in the `content` attribute) and resolve `page` against the link
// index for live previews. Nested containers (`::::embed`) are not handled
// yet; the tokenizer only consumes simple `:::embed ... :::` blocks.
//
// `HakushiInlineDirective` is a fidelity-preservation node for *inline* text
// directives (`:due[2026-08-01]`, `:prio[high]`, …) used by the advanced-todo
// and kanban templates. Without it, TipTap would treat the directive as plain
// text and backslash-escape the `[` on output, silently demoting the
// directive to literal text. It renders as a small chip and re-emits the raw
// directive source verbatim. TODO(M5): give each template directive a real
// editing UI instead of a read-only chip.

import { Node, mergeAttributes } from "@tiptap/core";
import type { MarkdownParseHelpers, MarkdownToken } from "@tiptap/core";

import { HakushiEmbedNodeView, type EmbedContextHolder } from "./embed-view";

// ---------------------------------------------------------------------------
// Directive attribute helpers
// ---------------------------------------------------------------------------

/** Parse a directive attribute block like `{page="Roadmap" mode="folder"}`. */
function parseDirectiveAttributes(attrBlock: string | null | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrBlock) return attrs;
  const inner = attrBlock.replace(/^\{/, "").replace(/\}$/, "");
  const re = /([a-zA-Z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;
  let match = re.exec(inner);
  while (match !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    match = re.exec(inner);
  }
  return attrs;
}

interface EmbedAttrs {
  page: string;
  mode: string | null;
  label: string | null;
  container: boolean;
  content: string | null;
  raw: string | null;
}

/** Serialize embed attrs to canonical-ish directive markdown (no `raw`). */
function buildEmbedMarkdown(attrs: EmbedAttrs): string {
  const pairs: string[] = [];
  if (attrs.page) pairs.push(`page="${attrs.page.replace(/"/g, '\\"')}"`);
  if (attrs.mode) pairs.push(`mode="${attrs.mode}"`);
  const attrBlock = pairs.length > 0 ? `{${pairs.join(" ")}}` : "";
  if (attrs.container) {
    const inner = attrs.content ? `${attrs.content}\n` : "";
    return `:::embed${attrBlock}\n${inner}:::`;
  }
  const label = attrs.label ? `[${attrs.label}]` : "";
  return `::embed${label}${attrBlock}`;
}

// First line of a leaf or container embed directive.
const EMBED_FIRST_LINE_RE = /^(:{2,3})embed(?:\[([^\]\n]*)\])?[ \t]*(\{[^}\n]*\})?[ \t]*$/;
// Cheap pre-filter used by marked's `start` callback (line-anchored).
const EMBED_START_RE = /^:{2,3}embed/m;

/**
 * Tokenize a leaf (`::embed…`) or container (`:::embed…\n…\n:::`) directive
 * at the start of `src`. Returns a marked token whose `raw` is the exact
 * consumed source (including one trailing newline when present).
 */
function tokenizeEmbed(src: string): MarkdownToken | undefined {
  const newlineIndex = src.indexOf("\n");
  const firstLine = newlineIndex === -1 ? src : src.slice(0, newlineIndex);
  const head = EMBED_FIRST_LINE_RE.exec(firstLine);
  if (head === null) return undefined;
  const [, colons, label, attrBlock] = head;
  const attrs = parseDirectiveAttributes(attrBlock);

  const token = (raw: string, container: boolean, content: string | null): MarkdownToken => ({
    type: "hakushiEmbed",
    raw,
    page: attrs.page ?? "",
    mode: attrs.mode ?? null,
    label: label !== undefined && label !== "" ? label : null,
    container,
    content,
  });

  if (colons === "::") {
    const raw = newlineIndex === -1 ? firstLine : src.slice(0, newlineIndex + 1);
    return token(raw, false, null);
  }

  // Container: scan for the closing `:::` line.
  const lines = src.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    if (/^:::[ \t]*$/.test(lines[i])) {
      const consumedLength = lines.slice(0, i + 1).join("\n").length;
      // Include the newline after the closing `:::` when present.
      const rawEnd = src[consumedLength] === "\n" ? consumedLength + 1 : consumedLength;
      const content = lines.slice(1, i).join("\n");
      return token(src.slice(0, rawEnd), true, content === "" ? null : content);
    }
  }
  // No closing fence — leave the text to the default tokenizers.
  return undefined;
}

// ---------------------------------------------------------------------------
// HakushiEmbed node
// ---------------------------------------------------------------------------

export interface HakushiEmbedOptions {
  /**
   * Mutable holder for the resolution context (workspace root, resolver fns,
   * onNavigate). Plumbed in by BlockEditor via `createEditorExtensions`;
   * `null` (headless tests, dev harness) renders static placeholder cards.
   * The M2 NodeView (embed-view.tsx) is display-only — serialization still
   * goes through `renderMarkdown` below, byte-stable as in M1.
   */
  contextHolder: EmbedContextHolder | null;
}

export const HakushiEmbed = Node.create<HakushiEmbedOptions>({
  name: "hakushiEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      contextHolder: null,
    };
  },

  addNodeView() {
    return (props) => new HakushiEmbedNodeView(props, this.options.contextHolder);
  },

  addAttributes() {
    return {
      page: { default: "" },
      mode: { default: null },
      label: { default: null },
      container: { default: false },
      // Verbatim inner markdown of a container embed (M1: read-only).
      content: { default: null, rendered: false },
      // Exact directive source captured at parse time; re-emitted verbatim.
      raw: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-hakushi-embed]",
        getAttrs: (element) => ({
          page: element.getAttribute("data-page") ?? "",
          mode: element.getAttribute("data-mode"),
          label: element.getAttribute("data-label"),
          container: element.getAttribute("data-container") === "true",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const page = String(node.attrs.page ?? "");
    const mode = String(node.attrs.mode ?? "inline");
    const label = node.attrs.label === null ? null : String(node.attrs.label);
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-hakushi-embed": "",
        "data-page": page,
        "data-mode": mode,
        "data-label": label ?? undefined,
        "data-container": node.attrs.container ? "true" : "false",
        class: "hakushi-embed-card",
      }),
      ["span", { class: "hakushi-embed-icon" }, "⧉"],
      ["span", { class: "hakushi-embed-page" }, label ?? (page || "(no page)")],
      ["span", { class: "hakushi-embed-mode" }, mode],
    ];
  },

  markdownTokenName: "hakushiEmbed",

  markdownTokenizer: {
    name: "hakushiEmbed",
    level: "block",
    start: (src: string) => src.search(EMBED_START_RE),
    tokenize: (src: string) => tokenizeEmbed(src),
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.createNode("hakushiEmbed", {
      page: token.page ?? "",
      mode: token.mode ?? null,
      label: token.label ?? null,
      container: token.container ?? false,
      content: token.content ?? null,
      raw: typeof token.raw === "string" ? token.raw.replace(/\n+$/, "") : null,
    });
  },

  renderMarkdown(node) {
    const attrs = (node.attrs ?? {}) as Partial<EmbedAttrs>;
    if (typeof attrs.raw === "string" && attrs.raw !== "") return attrs.raw;
    return buildEmbedMarkdown({
      page: attrs.page ?? "",
      mode: attrs.mode ?? null,
      label: attrs.label ?? null,
      container: attrs.container ?? false,
      content: attrs.content ?? null,
      raw: null,
    });
  },
});

// ---------------------------------------------------------------------------
// HakushiInlineDirective node
// ---------------------------------------------------------------------------

// `:name[content]` optionally followed by `{attrs}` — remark-directive text
// directive shape (subset: no nested brackets inside the label).
const INLINE_DIRECTIVE_RE = /^:([a-zA-Z][\w-]*)\[([^[\]\n]*)\](\{[^}\n]*\})?/;

export const HakushiInlineDirective = Node.create({
  name: "hakushiInlineDirective",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      directive: { default: "" },
      text: { default: "" },
      // Exact directive source captured at parse time; re-emitted verbatim.
      raw: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-hakushi-directive]",
        getAttrs: (element) => ({
          directive: element.getAttribute("data-hakushi-directive") ?? "",
          text: element.getAttribute("data-text") ?? "",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const directive = String(node.attrs.directive ?? "");
    const text = String(node.attrs.text ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-hakushi-directive": directive,
        "data-text": text,
        class: "hakushi-inline-directive",
      }),
      ["span", { class: "hakushi-inline-directive-name" }, directive],
      ["span", { class: "hakushi-inline-directive-value" }, text],
    ];
  },

  markdownTokenName: "hakushiInlineDirective",

  markdownTokenizer: {
    name: "hakushiInlineDirective",
    level: "inline",
    start: (src: string) => src.indexOf(":"),
    tokenize: (src: string) => {
      const match = INLINE_DIRECTIVE_RE.exec(src);
      if (match === null) return undefined;
      return {
        type: "hakushiInlineDirective",
        raw: match[0],
        directive: match[1],
        text: match[2],
      };
    },
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.createNode("hakushiInlineDirective", {
      directive: token.directive ?? "",
      text: token.text ?? "",
      raw: typeof token.raw === "string" ? token.raw : null,
    });
  },

  renderMarkdown(node) {
    const raw = node.attrs?.raw;
    if (typeof raw === "string" && raw !== "") return raw;
    return `:${String(node.attrs?.directive ?? "")}[${String(node.attrs?.text ?? "")}]`;
  },
});
