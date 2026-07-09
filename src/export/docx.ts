// Track X — mdast (post embed-resolution) → Docx bytes (INTERFACES.md §6.1).
//
// Uses mdast2docx (dynamically imported so the docx machinery never loads
// until the user actually exports). mdast2docx's root export is @m2d/core's
// `toDocx(ast, docxProps?, defaultSectionProps?, outputType?)`; the core
// handles standard markdown, and GFM tables / list numbering come from the
// bundled @m2d/table and @m2d/list plugins (pure, node-safe — the image /
// html / mermaid plugins need a DOM and are NOT loaded here).
//
// `toDocx` returns Blob | Buffer | ArrayBuffer | Uint8Array | … depending on
// environment and outputType; we always normalize to Uint8Array.

import type { Root, RootContent } from "mdast";

export interface DocxExportOptions {
  /** Document title metadata (docx core properties). */
  title?: string;
}

// ---------------------------------------------------------------------------
// Tree sanitization
// ---------------------------------------------------------------------------

/** Concatenated text of an mdast subtree. */
function allText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(allText).join("");
  return "";
}

/**
 * mdast2docx does not know directive nodes. After embed resolution none
 * should remain, but tolerate leftovers (`:due[…]` etc.): containers unwrap
 * to their children, leaf directives become plain paragraphs, text
 * directives become plain text.
 */
function sanitizeForDocx(tree: Root): Root {
  const mapChildren = (children: RootContent[]): RootContent[] => {
    const out: RootContent[] = [];
    for (const child of children) {
      if (child.type === "yaml") continue;
      if (child.type === "containerDirective") {
        out.push(...mapChildren(child.children as RootContent[]));
        continue;
      }
      if (child.type === "leafDirective") {
        out.push({
          type: "paragraph",
          children: [{ type: "text", value: allText(child) }],
        });
        continue;
      }
      if (child.type === "textDirective") {
        out.push({ type: "text", value: allText(child) } as RootContent);
        continue;
      }
      const parentish = child as RootContent & { children?: RootContent[] };
      if (Array.isArray(parentish.children)) {
        parentish.children = mapChildren(parentish.children);
      }
      out.push(child);
    }
    return out;
  };
  const cloned = structuredClone(tree);
  cloned.children = mapChildren(cloned.children);
  return cloned;
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

async function toUint8Array(out: unknown): Promise<Uint8Array> {
  if (out instanceof Uint8Array) return out; // includes node Buffer
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof Blob !== "undefined" && out instanceof Blob) {
    return new Uint8Array(await out.arrayBuffer());
  }
  throw new Error(`docx export: unexpected output type ${Object.prototype.toString.call(out)}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert a resolved mdast tree to .docx bytes (ZIP container, "PK…"). */
export async function mdastToDocx(
  tree: Root,
  opts?: DocxExportOptions,
): Promise<Uint8Array> {
  const [{ toDocx }, { tablePlugin }, { listPlugin }] = await Promise.all([
    import("mdast2docx"),
    import("@m2d/table"),
    import("@m2d/list"),
  ]);
  const sanitized = sanitizeForDocx(tree);
  const out = await toDocx(
    sanitized as unknown as Parameters<typeof toDocx>[0],
    opts?.title !== undefined ? { title: opts.title } : {},
    { plugins: [listPlugin(), tablePlugin()] },
    "arraybuffer",
  );
  return toUint8Array(out);
}
