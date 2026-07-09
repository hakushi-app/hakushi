// remark-hakushi-embed — tolerant-input wikilink transform (INTERFACES.md §3).
//
// Converts text-node occurrences of `![[Target]]` / `![[Target|Label]]` into
// remark-directive `leafDirective` nodes:
//
//   { type: "leafDirective", name: "embed",
//     attributes: { page: "Target" },
//     children: [{ type: "text", value: "Label" }] }  // only when a label given
//
// A leaf directive is *flow* content (it serializes as `::embed{…}` on its own
// line), so occurrences embedded inside longer text are extracted by splitting
// the text node and the surrounding paragraph: `before ![[X]] after` becomes
// three flow nodes — paragraph, leafDirective, paragraph. This keeps
// normalizeMarkdown idempotent: the serialized output re-parses to the exact
// same tree.
//
// canonical-output is handled by mdast-util-directive's serializer — on disk
// the embed is always written in directive form (`::embed{page="..."}`), never
// as a wikilink. No new mdast node types are introduced.
//
// Scope: only text nodes that are *direct children of a paragraph* are
// transformed. In other phrasing spots (headings, table cells, inside
// emphasis, …) a flow node cannot be hoisted, so the raw text is left alone —
// consistently, which preserves idempotency there too.

import type { Paragraph, Parent, PhrasingContent, Root, RootContent, Text } from "mdast";
import type { LeafDirective } from "mdast-util-directive";
import { visit } from "unist-util-visit";

// `![[Target]]` or `![[Target|Label]]`. Target must not contain `[`, `]`, `|`;
// Label must not contain `[`, `]`.
const WIKILINK_RE = /!\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

type Piece =
  | { kind: "phrasing"; node: PhrasingContent }
  | { kind: "embed"; node: LeafDirective };

function makeEmbed(target: string, label: string | undefined): LeafDirective {
  const children: PhrasingContent[] = [];
  if (label !== undefined && label !== "") {
    const text: Text = { type: "text", value: label };
    children.push(text);
  }
  return {
    type: "leafDirective",
    name: "embed",
    attributes: { page: target },
    children,
  };
}

/**
 * Merge adjacent `text` children in place. Wikilink-shaped input parses as a
 * failed image reference and may surface as several adjacent text nodes.
 */
function mergeAdjacentText(parent: Parent): void {
  const merged: typeof parent.children = [];
  for (const child of parent.children) {
    const previous = merged[merged.length - 1];
    if (child.type === "text" && previous !== undefined && previous.type === "text") {
      previous.value += child.value;
    } else {
      merged.push(child);
    }
  }
  parent.children = merged;
}

/**
 * Split one text node on wikilink occurrences. Returns `undefined` when the
 * node contains no (non-empty-target) wikilinks.
 */
function splitTextOnWikilinks(node: Text): Piece[] | undefined {
  const value = node.value;
  WIKILINK_RE.lastIndex = 0;
  const pieces: Piece[] = [];
  let start = 0;
  let found = false;
  let match = WIKILINK_RE.exec(value);
  while (match !== null) {
    const target = match[1].trim();
    if (target === "") {
      // Empty target — leave this occurrence as raw text.
      match = WIKILINK_RE.exec(value);
      continue;
    }
    found = true;
    if (match.index > start) {
      pieces.push({ kind: "phrasing", node: { type: "text", value: value.slice(start, match.index) } });
    }
    pieces.push({ kind: "embed", node: makeEmbed(target, match[2]?.trim()) });
    start = match.index + match[0].length;
    match = WIKILINK_RE.exec(value);
  }
  if (!found) return undefined;
  if (start < value.length) {
    pieces.push({ kind: "phrasing", node: { type: "text", value: value.slice(start) } });
  }
  return pieces;
}

/**
 * Turn a run of phrasing content into a paragraph, trimming boundary
 * whitespace left over around an extracted embed. Returns `undefined` when
 * nothing but whitespace remains.
 */
function toParagraph(run: PhrasingContent[]): Paragraph | undefined {
  const children = [...run];
  const first = children[0];
  if (first !== undefined && first.type === "text") {
    first.value = first.value.replace(/^[ \t]+/, "");
    if (first.value === "") children.shift();
  }
  const last = children[children.length - 1];
  if (last !== undefined && last.type === "text") {
    last.value = last.value.replace(/[ \t]+$/, "");
    if (last.value === "") children.pop();
  }
  if (children.length === 0) return undefined;
  return { type: "paragraph", children };
}

/**
 * remark plugin. Tolerant input: accepts Obsidian-style `![[wikilinks]]` in
 * paragraph text (including occurrences embedded in longer text nodes, which
 * are split) and rewrites them to `embed` leaf directives.
 */
export function remarkHakushiEmbed() {
  return function transform(tree: Root): void {
    visit(tree, "paragraph", function (paragraph, index, parent) {
      if (parent === undefined || index === undefined) return undefined;
      mergeAdjacentText(paragraph);

      const flow: RootContent[] = [];
      let run: PhrasingContent[] = [];
      let found = false;

      const flushRun = (): void => {
        const p = toParagraph(run);
        if (p !== undefined) flow.push(p);
        run = [];
      };

      for (const child of paragraph.children) {
        if (child.type === "text") {
          const pieces = splitTextOnWikilinks(child);
          if (pieces !== undefined) {
            found = true;
            for (const piece of pieces) {
              if (piece.kind === "embed") {
                flushRun();
                flow.push(piece.node);
              } else {
                run.push(piece.node);
              }
            }
            continue;
          }
        }
        run.push(child);
      }

      if (!found) return undefined;
      flushRun();
      parent.children.splice(index, 1, ...(flow as typeof parent.children));
      // Continue after the inserted nodes.
      return index + flow.length;
    });
  };
}

export default remarkHakushiEmbed;
