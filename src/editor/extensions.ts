// Track C — shared TipTap extension list (INTERFACES.md §4).
//
// Factored out so that BlockEditor.tsx (React) and the headless round-trip
// test (editor-roundtrip.test.ts) instantiate byte-identical schemas. Any
// extension change MUST keep the editor fidelity corpus green:
//   npx vitest run src/editor

import type { AnyExtension, JSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { Image } from "@tiptap/extension-image";
import { ListItem } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";

import type { EmbedContextHolder } from "./embed-view";
import { HakushiEmbed, HakushiInlineDirective } from "./hakushi-embed-node";

// ---------------------------------------------------------------------------
// Fidelity overrides for stock extensions
// ---------------------------------------------------------------------------

// The stock Code mark renders single-backtick fences, which breaks code spans
// that contain backticks (``a `tick` inside``). The markdown serializer probes
// marks with a placeholder, so the fence cannot depend on the actual content —
// instead always emit space-padded double-backtick fences. CommonMark strips
// one leading/trailing space when both are present, so `` x `` parses back to
// exactly `x`, and normalizeMarkdown then reduces the fence to the canonical
// minimal form. (Code spans containing a literal `` `` `` still cannot
// round-trip; none of the corpus needs that.)
const HakushiCode = Code.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers) => {
    if (!node.content) return "";
    return `\`\` ${h.renderChildren(node.content)} \`\``;
  },
});

// The stock ListItem indents nested children by the manager's fixed indent
// width (2 spaces), which is not enough inside ordered lists: `2. two` needs
// its children indented by 3 (the marker width), otherwise a nested list
// escapes the parent item on re-parse. Indent by the marker width instead.
function renderListItemMarkdown(
  node: JSONContent,
  h: MarkdownRendererHelpers,
  ctx: RenderContext,
): string {
  let prefix = "- ";
  if (ctx.parentType === "orderedList") {
    const parentAttrs = (ctx.meta?.parentAttrs ?? {}) as { start?: number };
    const start = typeof parentAttrs.start === "number" ? parentAttrs.start : 1;
    prefix = `${start + (ctx.index || 0)}. `;
  }
  const children = node.content ?? [];
  if (children.length === 0) return prefix;
  const [first, ...rest] = children;
  const indent = " ".repeat(prefix.length);
  let output = prefix + h.renderChildren([first]);
  rest.forEach((child, index) => {
    const childContent = h.renderChild ? h.renderChild(child, index + 1) : h.renderChildren([child]);
    const indented = childContent
      .split("\n")
      .map((line) => (line === "" ? line : indent + line))
      .join("\n");
    output += (child.type === "paragraph" ? "\n\n" : "\n") + indented;
  });
  return output;
}

const HakushiListItem = ListItem.extend({
  renderMarkdown: renderListItemMarkdown,
});

// ---------------------------------------------------------------------------
// Shared extension list
// ---------------------------------------------------------------------------

/**
 * Build the extension list shared by the WYSIWYG editor and the tests.
 *
 * `embedContextHolder` (M2, INTERFACES.md §5.6) plumbs the embed resolution
 * context into the HakushiEmbed NodeView. It is a *mutable holder* so callers
 * can swap the context without rebuilding the editor; omitting it (headless
 * round-trip tests) renders embeds as static placeholder cards.
 */
export function createEditorExtensions(
  embedContextHolder?: EmbedContextHolder | null,
): AnyExtension[] {
  return [
    // Stock Code / ListItem are replaced by the fidelity overrides above.
    StarterKit.configure({ code: false, listItem: false }),
    HakushiCode,
    HakushiListItem,
    Table,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    // Inline so images survive inside paragraphs (`text ![alt](src) text`),
    // matching how mdast represents images as phrasing content.
    Image.configure({ inline: true }),
    HakushiEmbed.configure({ contextHolder: embedContextHolder ?? null }),
    HakushiInlineDirective,
    // The official bidirectional markdown extension: provides
    // `contentType: "markdown"` input and `editor.getMarkdown()` output.
    Markdown,
  ];
}
