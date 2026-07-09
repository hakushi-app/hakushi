// Track C2 — shared block alignment over the canonical markdown pipeline.
//
// The top-level-block LCS that powers the M4 semantic diff (semantic-diff.ts)
// is also the backbone of the M8 semantic 3-way merge (semantic-merge.ts):
// both align two block sequences keyed on each block's canonical
// serialization. This module factors out the pieces they share so neither
// duplicates the alignment logic:
//
//   - `docBlocks`  — parse markdown, strip the `yaml` frontmatter node, and
//                    return the top-level blocks annotated with a canonical
//                    LCS key and their nearest preceding heading (section);
//   - `diffScript` — the classic LCS edit script (same / del / ins) over two
//                    block sequences, keyed on `BlockRec.key`;
//   - `blockToMd`  — canonical serialization of a single block (trimmed).
//
// semantic-diff.ts keeps its public API and tests unchanged; it now imports
// these instead of defining them privately.

import type { Root, RootContent } from "mdast";

import { parseMarkdown, stringifyMarkdown } from "../markdown";

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

/** Concatenated raw text of an mdast subtree (headings → section names). */
export function toPlainText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(toPlainText).join("");
  return "";
}

/** Canonical serialization of a single top-level block, trimmed (LCS key). */
export function blockToMd(node: RootContent): string {
  const root: Root = { type: "root", children: [node] };
  return stringifyMarkdown(root).trim();
}

export interface BlockRec {
  node: RootContent;
  key: string;
  /** Nearest preceding top-level heading text (Kanban column). */
  section: string | null;
}

/** Top-level blocks of a document, yaml stripped, section-annotated. */
export function docBlocks(md: string): BlockRec[] {
  const tree = parseMarkdown(md);
  const out: BlockRec[] = [];
  let section: string | null = null;
  for (const child of tree.children) {
    if (child.type === "yaml") continue;
    if (child.type === "heading") section = toPlainText(child).trim();
    out.push({ node: child, key: blockToMd(child), section });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block-level LCS
// ---------------------------------------------------------------------------

export type ScriptEntry =
  | { op: "same"; ai: number; bi: number }
  | { op: "del"; ai: number }
  | { op: "ins"; bi: number };

/**
 * LCS edit script aligning block sequence `a` → `b`, keyed on `BlockRec.key`.
 * Deterministic: on ties the deletion (from `a`) is emitted first, so the
 * output order tracks `a` then `b`.
 */
export function diffScript(a: BlockRec[], b: BlockRec[]): ScriptEntry[] {
  const n = a.length;
  const m = b.length;
  // dp[i*(m+1)+j] = LCS length of a[i:] vs b[j:]
  const dp = new Array<number>((n + 1) * (m + 1)).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i].key === b[j].key
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const script: ScriptEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].key === b[j].key) {
      script.push({ op: "same", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      script.push({ op: "del", ai: i });
      i++;
    } else {
      script.push({ op: "ins", bi: j });
      j++;
    }
  }
  while (i < n) script.push({ op: "del", ai: i++ });
  while (j < m) script.push({ op: "ins", bi: j++ });
  return script;
}
