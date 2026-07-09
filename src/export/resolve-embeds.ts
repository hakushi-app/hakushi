// Track X — embed resolution for export (INTERFACES.md §6.1).
//
// Pure logic: the workspace access is injected as an `EmbedSource`, so vitest
// exercises everything with in-memory fakes. The production wiring (index.ts)
// builds an EmbedSource from src/app/resolver.ts.
//
// Semantics (contract §6.1):
//   - inline/preview embeds are replaced by the target page body's mdast
//     blocks (frontmatter stripped, heading levels untouched), resolved
//     recursively with a visited chain.
//   - folder embeds become a list of links to the target's child pages.
//   - unresolved target      → paragraph "(未解決: target)"
//   - cycle / depth > max    → paragraph "(循環参照: target)"
//   - folder with no children → paragraph "(子ページなし)"
// The input tree is never mutated; a resolved deep clone is returned.

import type { List, Paragraph, Parent, Root, RootContent } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";

import { parseMarkdown } from "../markdown";

// ---------------------------------------------------------------------------
// Contract types (INTERFACES.md §6.1)
// ---------------------------------------------------------------------------

export interface ResolvedRef {
  relPath: string;
  title: string | null;
}

/** Injected workspace access for embed resolution. */
export interface EmbedSource {
  /** Resolve a raw embed target (page id or path-ish) to a page, or null. */
  resolve(target: string): Promise<ResolvedRef | null>;
  /** Page body markdown without frontmatter. */
  readBody(relPath: string): Promise<string>;
  /** Child pages of a folder note (empty for non-folder pages). */
  listChildren(relPath: string): Promise<ResolvedRef[]>;
}

export interface ResolveEmbedsOptions {
  /** Maximum embed nesting depth (chain length), default 3. */
  maxDepth?: number;
  /**
   * Pages already being rendered, outermost first — pass the exported page's
   * own relPath so self-embeds are caught. Default: [].
   */
  chain?: readonly string[];
}

export const DEFAULT_MAX_EMBED_DEPTH = 3;

// Placeholder paragraph texts (also asserted by tests).
export const unresolvedText = (target: string): string => `(未解決: ${target})`;
export const cycleText = (target: string): string => `(循環参照: ${target})`;
export const NO_CHILDREN_TEXT = "(子ページなし)";

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

type EmbedDirective = LeafDirective | ContainerDirective;

function isEmbedDirective(node: RootContent): node is EmbedDirective {
  return (
    (node.type === "leafDirective" || node.type === "containerDirective") &&
    node.name === "embed"
  );
}

function textParagraph(value: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  const base = i === -1 ? relPath : relPath.slice(i + 1);
  if (base.toLowerCase() === "index.md") {
    const dir = i === -1 ? "" : relPath.slice(0, i);
    const j = dir.lastIndexOf("/");
    return dir === "" ? "index" : j === -1 ? dir : dir.slice(j + 1);
  }
  return base.replace(/\.md$/i, "");
}

function childLinkList(children: ResolvedRef[]): List {
  return {
    type: "list",
    ordered: false,
    spread: false,
    children: children.map((child) => ({
      type: "listItem",
      spread: false,
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: child.relPath,
              children: [{ type: "text", value: child.title ?? baseName(child.relPath) }],
            },
          ],
        },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Replacement blocks for one embed directive. */
async function expandEmbed(
  node: EmbedDirective,
  src: EmbedSource,
  chain: readonly string[],
  maxDepth: number,
): Promise<RootContent[]> {
  const target = node.attributes?.page ?? "";
  if (target === "") return [textParagraph(unresolvedText(target))];

  const resolved = await src.resolve(target).catch(() => null);
  if (resolved === null) return [textParagraph(unresolvedText(target))];

  // Cycle / depth guard (same rule as the editor's canRenderEmbed):
  // re-visiting a page on the chain, or a chain already maxDepth long.
  if (chain.includes(resolved.relPath) || chain.length >= maxDepth) {
    return [textParagraph(cycleText(target))];
  }

  const mode = node.attributes?.mode ?? "inline";
  if (mode === "folder") {
    const children = await src.listChildren(resolved.relPath).catch(() => []);
    if (children.length === 0) return [textParagraph(NO_CHILDREN_TEXT)];
    return [childLinkList(children)];
  }

  // inline / preview: splice the target page body's blocks in place.
  let body: string;
  try {
    body = await src.readBody(resolved.relPath);
  } catch {
    return [textParagraph(unresolvedText(target))];
  }
  const sub: Root = {
    type: "root",
    children: parseMarkdown(body).children.filter((c) => c.type !== "yaml"),
  };
  await resolveInParent(sub, src, [...chain, resolved.relPath], maxDepth);
  return sub.children;
}

/** True when a node's children are block-level (worth descending into). */
function isBlockContainer(node: RootContent): node is RootContent & Parent {
  return (
    node.type === "blockquote" ||
    node.type === "list" ||
    node.type === "listItem" ||
    node.type === "containerDirective"
  );
}

async function resolveInParent(
  parent: Parent,
  src: EmbedSource,
  chain: readonly string[],
  maxDepth: number,
): Promise<void> {
  const out: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    if (isEmbedDirective(child)) {
      out.push(...(await expandEmbed(child, src, chain, maxDepth)));
      continue;
    }
    if (isBlockContainer(child)) {
      await resolveInParent(child, src, chain, maxDepth);
    }
    out.push(child);
  }
  parent.children = out;
}

/**
 * Resolve every `embed` directive in `tree` for export (INTERFACES.md §6.1).
 * Returns a new tree; the input is not mutated.
 */
export async function resolveEmbedsInTree(
  tree: Root,
  src: EmbedSource,
  opts?: ResolveEmbedsOptions,
): Promise<Root> {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_EMBED_DEPTH;
  const chain = [...(opts?.chain ?? [])];
  const cloned = structuredClone(tree);
  await resolveInParent(cloned, src, chain, maxDepth);
  return cloned;
}
