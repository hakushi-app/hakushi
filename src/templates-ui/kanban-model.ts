// Track T1 — Kanban model (INTERFACES.md §9.2), pure functions over mdast.
//
// On-disk form (DESIGN.md §テンプレート): columns are top-level `## Title`
// headings, cards are GFM task-list items under them; the frontmatter
// `kanban.columns` array fixes the display order (extra body sections are
// appended). Every op returns a NEW Root — callers serialize it through
// `stringifyMarkdown` only, so a card move stays a one-line diff.

import type { Heading, List, ListItem, Root } from "mdast";
import { parse as parseYaml } from "yaml";

import { parseMarkdown, stringifyMarkdown } from "../markdown";

export interface KanbanCard {
  /** Card text as canonical markdown (directives kept), checkbox stripped. */
  text: string;
  checked: boolean;
  /** Full canonical line, e.g. `- [ ] Design AST adapter :prio[high]`. */
  raw: string;
}

export interface KanbanColumn {
  title: string;
  cards: KanbanCard[];
}

export interface KanbanModel {
  columns: KanbanColumn[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function plainText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(plainText).join("");
  return "";
}

function isColumnHeading(node: Root["children"][number]): node is Heading {
  return node.type === "heading" && node.depth === 2;
}

function isTaskItem(item: ListItem): boolean {
  return typeof item.checked === "boolean";
}

/** `[start, end)` range of top-level children forming the column's section. */
interface SectionRange {
  headingIdx: number;
  /** Index one past the last child of the section (next `##` or doc end). */
  end: number;
}

function findSection(tree: Root, columnTitle: string): SectionRange | null {
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (isColumnHeading(child) && plainText(child).trim() === columnTitle) {
      let end = i + 1;
      while (end < tree.children.length && !isColumnHeading(tree.children[end])) end++;
      return { headingIdx: i, end };
    }
  }
  return null;
}

/** Position of one card: the list, its top-level index, the item's index. */
interface CardSlot {
  list: List;
  /** Index of `list` in `tree.children`. */
  treeIdx: number;
  /** Index of the card's item in `list.children`. */
  itemIdx: number;
  item: ListItem;
}

/** Card slots of a section, in document order (non-task items are skipped). */
function sectionCardSlots(tree: Root, range: SectionRange): CardSlot[] {
  const slots: CardSlot[] = [];
  for (let i = range.headingIdx + 1; i < range.end; i++) {
    const child = tree.children[i];
    if (child.type !== "list") continue;
    child.children.forEach((item, itemIdx) => {
      if (isTaskItem(item)) slots.push({ list: child, treeIdx: i, itemIdx, item });
    });
  }
  return slots;
}

const TASK_MARKER_RE = /^- \[[ xX]\] ?/;

function itemToCard(item: ListItem): KanbanCard {
  const list: List = { type: "list", ordered: false, spread: false, children: [item] };
  const raw = stringifyMarkdown({ type: "root", children: [list] }).trimEnd();
  return {
    text: raw.replace(TASK_MARKER_RE, ""),
    checked: item.checked === true,
    raw,
  };
}

/** Frontmatter `kanban.columns` (empty when absent/malformed). */
function frontmatterColumns(tree: Root): string[] {
  const yamlNode = tree.children.find((c) => c.type === "yaml");
  if (yamlNode === undefined) return [];
  let meta: unknown;
  try {
    meta = parseYaml(yamlNode.value);
  } catch {
    return [];
  }
  const kanban = (meta as { kanban?: unknown } | null)?.kanban;
  const columns = (kanban as { columns?: unknown } | null)?.columns;
  if (!Array.isArray(columns)) return [];
  return columns.filter((c): c is string => typeof c === "string");
}

/** Build a task-list item node from user text via the canonical parser. */
function makeTaskItem(text: string): ListItem {
  const clean = text.replace(/\s+/g, " ").trim();
  const parsed = parseMarkdown(`- [ ] ${clean === "" ? " " : clean}`);
  const list = parsed.children.find((c): c is List => c.type === "list");
  if (list === undefined || list.children.length === 0) {
    throw new Error(`could not build a card from: ${text}`);
  }
  const item = list.children[0];
  item.checked = false;
  item.spread = false;
  return item;
}

/** Insert `item` at the end of a column's cards (creating a list if needed). */
function appendItemToSection(tree: Root, range: SectionRange, item: ListItem): void {
  const slots = sectionCardSlots(tree, range);
  const last = slots[slots.length - 1];
  if (last !== undefined) {
    last.list.children.splice(last.itemIdx + 1, 0, item);
    return;
  }
  // No cards yet: reuse the section's last list, else create one.
  for (let i = range.end - 1; i > range.headingIdx; i--) {
    const child = tree.children[i];
    if (child.type === "list") {
      child.children.push(item);
      return;
    }
  }
  const list: List = { type: "list", ordered: false, spread: false, children: [item] };
  tree.children.splice(range.end, 0, list);
}

/** Remove the card at `slot`, dropping its list when it becomes empty. */
function removeSlot(tree: Root, slot: CardSlot): ListItem {
  const [item] = slot.list.children.splice(slot.itemIdx, 1);
  if (slot.list.children.length === 0) tree.children.splice(slot.treeIdx, 1);
  return item;
}

function mustFindSection(tree: Root, columnTitle: string): SectionRange {
  const range = findSection(tree, columnTitle);
  if (range === null) throw new Error(`kanban column not found: ${columnTitle}`);
  return range;
}

function mustGetSlot(slots: CardSlot[], columnTitle: string, cardIdx: number): CardSlot {
  const slot = slots[cardIdx];
  if (slot === undefined) {
    throw new Error(`kanban card ${cardIdx} not found in column: ${columnTitle}`);
  }
  return slot;
}

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §9.2)
// ---------------------------------------------------------------------------

/**
 * Parse a kanban page (full Root, frontmatter included). Column order:
 * frontmatter `kanban.columns` first (empty columns included so the board
 * can render them), then extra body sections in document order.
 */
export function parseKanban(tree: Root): KanbanModel {
  const bodySections: { title: string; range: SectionRange }[] = [];
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (!isColumnHeading(child)) continue;
    let end = i + 1;
    while (end < tree.children.length && !isColumnHeading(tree.children[end])) end++;
    bodySections.push({ title: plainText(child).trim(), range: { headingIdx: i, end } });
  }
  const byTitle = new Map(bodySections.map((s) => [s.title, s]));

  const columns: KanbanColumn[] = [];
  const emitted = new Set<string>();
  for (const title of frontmatterColumns(tree)) {
    if (emitted.has(title)) continue;
    emitted.add(title);
    const section = byTitle.get(title);
    columns.push({
      title,
      cards: section === undefined
        ? []
        : sectionCardSlots(tree, section.range).map((s) => itemToCard(s.item)),
    });
  }
  for (const section of bodySections) {
    if (emitted.has(section.title)) continue;
    emitted.add(section.title);
    columns.push({
      title: section.title,
      cards: sectionCardSlots(tree, section.range).map((s) => itemToCard(s.item)),
    });
  }
  return { columns };
}

/**
 * Append a card to a column. A frontmatter-declared column without a body
 * section gets its `## Title` heading created at the end of the document.
 */
export function addCard(tree: Root, columnTitle: string, text: string): Root {
  const next = structuredClone(tree);
  const item = makeTaskItem(text);
  let range = findSection(next, columnTitle);
  if (range === null) {
    const heading: Heading = {
      type: "heading",
      depth: 2,
      children: [{ type: "text", value: columnTitle }],
    };
    next.children.push(heading);
    range = { headingIdx: next.children.length - 1, end: next.children.length };
  }
  appendItemToSection(next, range, item);
  return next;
}

/** Flip the checkbox of the `cardIdx`-th card of a column. */
export function toggleCard(tree: Root, columnTitle: string, cardIdx: number): Root {
  const next = structuredClone(tree);
  const range = mustFindSection(next, columnTitle);
  const slot = mustGetSlot(sectionCardSlots(next, range), columnTitle, cardIdx);
  slot.item.checked = slot.item.checked !== true;
  return next;
}

/**
 * Move a card between (or within) columns. `toIdx` is the card's index in
 * the destination column AFTER the card has been removed from its source
 * (clamped to the end). Serializes to a one-line move.
 */
export function moveCard(
  tree: Root,
  fromColumn: string,
  cardIdx: number,
  toColumn: string,
  toIdx: number,
): Root {
  const next = structuredClone(tree);
  const fromRange = mustFindSection(next, fromColumn);
  const slot = mustGetSlot(sectionCardSlots(next, fromRange), fromColumn, cardIdx);
  const item = removeSlot(next, slot);

  // Re-locate the destination on the mutated tree (indices may have shifted).
  let toRange = findSection(next, toColumn);
  if (toRange === null) {
    const heading: Heading = {
      type: "heading",
      depth: 2,
      children: [{ type: "text", value: toColumn }],
    };
    next.children.push(heading);
    toRange = { headingIdx: next.children.length - 1, end: next.children.length };
  }
  const destSlots = sectionCardSlots(next, toRange);
  const before = destSlots[toIdx];
  if (before !== undefined) {
    before.list.children.splice(before.itemIdx, 0, item);
  } else {
    appendItemToSection(next, toRange, item);
  }
  return next;
}

/** Delete the `cardIdx`-th card of a column (empty lists are dropped). */
export function deleteCard(tree: Root, columnTitle: string, cardIdx: number): Root {
  const next = structuredClone(tree);
  const range = mustFindSection(next, columnTitle);
  const slot = mustGetSlot(sectionCardSlots(next, range), columnTitle, cardIdx);
  removeSlot(next, slot);
  return next;
}
