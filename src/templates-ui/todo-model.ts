// Track T1 — Todo model (INTERFACES.md §9.2), pure functions over mdast.
//
// On-disk form (DESIGN.md §テンプレート): GFM task-list items; the advanced
// template adds inline directives `:due[YYYY-MM-DD]` / `:prio[high]` and
// `#tags` — one task per line, so a toggle stays a one-line diff.

import type { ListItem, Paragraph, PhrasingContent, Root } from "mdast";
import { visit } from "unist-util-visit";

export interface TodoTask {
  /** Human text: directives and `#tags` stripped, whitespace collapsed. */
  text: string;
  checked: boolean;
  /** `:due[…]` value (YYYY-MM-DD), when present. */
  due?: string;
  /** `:prio[…]` value (e.g. high / medium / low), when present. */
  prio?: string;
  /** `#tag` tokens found in the task line (without the `#`). */
  tags: string[];
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

const TAG_RE = /(^|\s)#([^\s#]+)/g;

/** Task items in document order (pre-order visit = source order). */
function taskItems(tree: Root): ListItem[] {
  const items: ListItem[] = [];
  visit(tree, "listItem", (item: ListItem) => {
    if (typeof item.checked === "boolean") items.push(item);
  });
  return items;
}

function itemToTask(item: ListItem): TodoTask {
  let due: string | undefined;
  let prio: string | undefined;
  let text = "";

  // Only the item's own paragraphs — nested list items are separate tasks.
  const paragraphs = item.children.filter((c): c is Paragraph => c.type === "paragraph");
  const consume = (node: PhrasingContent): void => {
    if (node.type === "textDirective") {
      if (node.name === "due") {
        due = plainText(node).trim();
        return;
      }
      if (node.name === "prio") {
        prio = plainText(node).trim();
        return;
      }
    }
    text += plainText(node);
  };
  for (const p of paragraphs) for (const child of p.children) consume(child);

  const tags: string[] = [];
  const stripped = text.replace(TAG_RE, (_m, pre: string, tag: string) => {
    tags.push(tag);
    return pre;
  });

  const task: TodoTask = {
    text: stripped.replace(/\s+/g, " ").trim(),
    checked: item.checked === true,
    tags,
  };
  if (due !== undefined && due !== "") task.due = due;
  if (prio !== undefined && prio !== "") task.prio = prio;
  return task;
}

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §9.2)
// ---------------------------------------------------------------------------

/** All tasks of the page, flat, in document order. */
export function parseTodos(tree: Root): TodoTask[] {
  return taskItems(tree).map(itemToTask);
}

/** Flip the checkbox of the `taskIdx`-th task (document order). */
export function toggleTask(tree: Root, taskIdx: number): Root {
  const next = structuredClone(tree);
  const items = taskItems(next);
  const item = items[taskIdx];
  if (item === undefined) throw new Error(`todo task ${taskIdx} not found`);
  item.checked = item.checked !== true;
  return next;
}
