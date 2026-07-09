// Track H — semantic diff over the canonical markdown pipeline
// (INTERFACES.md §7.2).
//
// Both documents are parsed with `parseMarkdown`, the `yaml` frontmatter node
// is stripped (frontmatter changes are invisible to this diff), and the
// top-level blocks are compared with an LCS keyed on each block's canonical
// serialization (`stringifyMarkdown`, trimmed). Paired removed/added blocks
// are then post-processed into higher-level operations, in priority order:
//
//   1. list-ITEM level, across the whole document:
//      - identical items (text + checked + section) inside rewritten list
//        blocks cancel out (they did not change),
//      - `moved`: an identical item disappears under one top-level heading
//        section and reappears under another (the Kanban card move),
//      - `task-toggled`: same item text, checkbox state flipped in place,
//      - a cross-section reappearance with a flipped checkbox still counts
//        as `moved` (the section change is the dominant signal);
//   2. leftover removed+added blocks in the same hunk whose canonical text
//      shares a >60% common prefix become `modified`;
//   3. everything else stays `added` / `removed`.
//
// The returned list follows the after-document order where possible.

import type { List, Root } from "mdast";

import { stringifyMarkdown } from "../markdown";
import { blockToMd, diffScript, docBlocks, type BlockRec } from "./block-align";

export type BlockChange =
  | { kind: "added"; block: string } // block = canonical md fragment
  | { kind: "removed"; block: string }
  | { kind: "modified"; before: string; after: string }
  | { kind: "task-toggled"; text: string; done: boolean }
  | {
      kind: "moved";
      text: string;
      fromSection: string | null;
      toSection: string | null;
    };

/** Common-prefix ratio above which a removed+added pair becomes `modified`. */
const MODIFIED_PREFIX_THRESHOLD = 0.6;

// Block extraction (`docBlocks`, `blockToMd`, `BlockRec`) and the block-level
// LCS (`diffScript`, `ScriptEntry`) now live in block-align.ts, shared with
// the M8 semantic 3-way merge (semantic-merge.ts).

// ---------------------------------------------------------------------------
// Item-level post-processing
// ---------------------------------------------------------------------------

interface DiffItem {
  /** Canonical serialization of the item content, without the checkbox. */
  text: string;
  checked: boolean | null;
  section: string | null;
  node: List["children"][number];
  consumed: boolean;
  /** After-document anchor position of the containing block. */
  pos: number;
}

interface SideBlock {
  rec: BlockRec;
  /** After-document anchor position (for output ordering). */
  pos: number;
  hunk: number;
  /** Direct list items when the block is a list, else null. */
  items: DiffItem[] | null;
  /** Canonical md of the (possibly residual-rewritten) block. */
  key: string;
  consumed: boolean;
}

function makeSide(rec: BlockRec, pos: number, hunk: number): SideBlock {
  let items: DiffItem[] | null = null;
  if (rec.node.type === "list") {
    items = rec.node.children.map((item) => {
      const root: Root = { type: "root", children: item.children };
      return {
        text: stringifyMarkdown(root).trim(),
        checked: item.checked ?? null,
        section: rec.section,
        node: item,
        consumed: false,
        pos,
      };
    });
  }
  return { rec, pos, hunk, items, key: rec.key, consumed: false };
}

/** `commonPrefixLength / max(length)` — the "similar prefix" heuristic. */
function prefixSimilarity(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length, 1);
}

/**
 * Drop consumed items from a removed/added list block. Returns false when
 * the whole block is explained by item-level operations (drop the block);
 * otherwise rewrites `key` to the residual list when items were consumed.
 */
function keepResidual(side: SideBlock): boolean {
  if (side.items === null) return true;
  const remaining = side.items.filter((i) => !i.consumed);
  if (remaining.length === side.items.length) return true;
  if (remaining.length === 0) return false;
  const residual: List = {
    ...(side.rec.node as List),
    children: remaining.map((i) => i.node),
  };
  side.key = blockToMd(residual);
  return true;
}

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §7.2)
// ---------------------------------------------------------------------------

export function semanticDiff(beforeMd: string, afterMd: string): BlockChange[] {
  const a = docBlocks(beforeMd);
  const b = docBlocks(afterMd);
  const script = diffScript(a, b);

  // Collect removed/added blocks with hunk ids and after-document anchors.
  const dels: SideBlock[] = [];
  const inss: SideBlock[] = [];
  let hunk = -1;
  let inHunk = false;
  let afterCursor = 0; // after-doc position where the next change lands
  for (const entry of script) {
    if (entry.op === "same") {
      inHunk = false;
      afterCursor = entry.bi + 1;
      continue;
    }
    if (!inHunk) {
      hunk++;
      inHunk = true;
    }
    if (entry.op === "del") {
      dels.push(makeSide(a[entry.ai], afterCursor, hunk));
    } else {
      inss.push(makeSide(b[entry.bi], entry.bi, hunk));
      afterCursor = entry.bi + 1;
    }
  }

  interface PendingOp {
    change: BlockChange;
    pos: number;
    tier: number;
  }
  const ops: PendingOp[] = [];

  // --- item level (task-toggled / moved), across the whole document -------
  const delItems = dels.flatMap((s) => s.items ?? []);
  const insItems = inss.flatMap((s) => s.items ?? []);

  const takeDelItem = (pred: (d: DiffItem) => boolean): DiffItem | null => {
    const found = delItems.find((d) => !d.consumed && pred(d));
    if (found === undefined) return null;
    found.consumed = true;
    return found;
  };

  // 1) identical items inside rewritten lists did not change → cancel.
  for (const ins of insItems) {
    const m = takeDelItem(
      (d) =>
        d.text === ins.text &&
        d.checked === ins.checked &&
        d.section === ins.section,
    );
    if (m !== null) ins.consumed = true;
  }
  // 2) moved: identical item (text + checked) under a different heading.
  for (const ins of insItems) {
    if (ins.consumed) continue;
    const m = takeDelItem(
      (d) =>
        d.text === ins.text &&
        d.checked === ins.checked &&
        d.section !== ins.section,
    );
    if (m !== null) {
      ins.consumed = true;
      ops.push({
        change: {
          kind: "moved",
          text: ins.text,
          fromSection: m.section,
          toSection: ins.section,
        },
        pos: ins.pos,
        tier: 1,
      });
    }
  }
  // 3) task-toggled: same text, checkbox flipped in place.
  for (const ins of insItems) {
    if (ins.consumed || typeof ins.checked !== "boolean") continue;
    const m = takeDelItem(
      (d) =>
        d.text === ins.text &&
        typeof d.checked === "boolean" &&
        d.checked !== ins.checked &&
        d.section === ins.section,
    );
    if (m !== null) {
      ins.consumed = true;
      ops.push({
        change: { kind: "task-toggled", text: ins.text, done: ins.checked },
        pos: ins.pos,
        tier: 0,
      });
    }
  }
  // 4) cross-section reappearance with a flipped checkbox → still a move.
  for (const ins of insItems) {
    if (ins.consumed) continue;
    const m = takeDelItem((d) => d.text === ins.text && d.section !== ins.section);
    if (m !== null) {
      ins.consumed = true;
      ops.push({
        change: {
          kind: "moved",
          text: ins.text,
          fromSection: m.section,
          toSection: ins.section,
        },
        pos: ins.pos,
        tier: 1,
      });
    }
  }

  // --- residual blocks: drop fully-explained lists, rewrite partial ones --
  const delsLeft = dels.filter(keepResidual);
  const inssLeft = inss.filter(keepResidual);

  // --- modified: removed+added in the same hunk with a similar prefix -----
  for (const d of delsLeft) {
    const cand = inssLeft.find(
      (x) =>
        !x.consumed &&
        x.hunk === d.hunk &&
        prefixSimilarity(d.key, x.key) > MODIFIED_PREFIX_THRESHOLD,
    );
    if (cand !== undefined) {
      d.consumed = true;
      cand.consumed = true;
      ops.push({
        change: { kind: "modified", before: d.key, after: cand.key },
        pos: cand.pos,
        tier: 2,
      });
    }
  }

  // --- everything else stays removed/added --------------------------------
  for (const d of delsLeft) {
    if (!d.consumed) {
      ops.push({ change: { kind: "removed", block: d.key }, pos: d.pos, tier: 3 });
    }
  }
  for (const x of inssLeft) {
    if (!x.consumed) {
      ops.push({ change: { kind: "added", block: x.key }, pos: x.pos, tier: 4 });
    }
  }

  // After-document order where possible; kind priority breaks ties.
  ops.sort((p, q) => p.pos - q.pos || p.tier - q.tier);
  return ops.map((o) => o.change);
}
