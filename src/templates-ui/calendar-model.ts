// Track T1 — Calendar model (INTERFACES.md §9.2), pure functions over mdast.
//
// On-disk form (DESIGN.md §テンプレート): frontmatter `calendar.default_view`
// plus the first GFM table in the body with date / title / page / tag
// columns (matched by header name, positional fallback). Adding an event
// appends one table row = one-line diff.

import type { Root, Table, TableCell, TableRow } from "mdast";
import { parse as parseYaml } from "yaml";

export interface CalendarEvent {
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  /** Page id or workspace-relative path ("" when the cell is empty). */
  page: string;
  tag: string;
  /** 0-based index among the table's data rows (header excluded). */
  rowIdx: number;
}

export interface CalendarModel {
  /** Frontmatter `calendar.default_view`, default `"month"`. */
  view: string;
  events: CalendarEvent[];
}

export interface CalendarEventInput {
  date: string;
  title: string;
  page?: string;
  tag?: string;
}

const COLUMNS = ["date", "title", "page", "tag"] as const;
type ColumnName = (typeof COLUMNS)[number];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function plainText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(plainText).join("");
  return "";
}

function firstTable(tree: Root): Table | null {
  const table = tree.children.find((c): c is Table => c.type === "table");
  return table ?? null;
}

/**
 * Column name → cell index from the header row. When the header names at
 * least one known column, unnamed known columns are absent (`-1`); a header
 * with no known names falls back to positional date|title|page|tag.
 */
function columnIndices(table: Table): Record<ColumnName, number> {
  const positional: Record<ColumnName, number> = { date: 0, title: 1, page: 2, tag: 3 };
  const header = table.children[0];
  if (header === undefined) return positional;
  const named: Record<ColumnName, number> = { date: -1, title: -1, page: -1, tag: -1 };
  let anyNamed = false;
  header.children.forEach((cell, i) => {
    const name = plainText(cell).trim().toLowerCase();
    if ((COLUMNS as readonly string[]).includes(name)) {
      named[name as ColumnName] = i;
      anyNamed = true;
    }
  });
  return anyNamed ? named : positional;
}

function cellText(row: TableRow, idx: number): string {
  const cell = idx < 0 ? undefined : row.children[idx];
  return cell === undefined ? "" : plainText(cell).trim();
}

function makeCell(value: string): TableCell {
  return {
    type: "tableCell",
    children: value === "" ? [] : [{ type: "text", value }],
  };
}

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §9.2)
// ---------------------------------------------------------------------------

/** Parse a calendar page (full Root, frontmatter included). */
export function parseCalendar(tree: Root): CalendarModel {
  let view = "month";
  const yamlNode = tree.children.find((c) => c.type === "yaml");
  if (yamlNode !== undefined) {
    try {
      const meta = parseYaml(yamlNode.value) as { calendar?: { default_view?: unknown } } | null;
      const v = meta?.calendar?.default_view;
      if (typeof v === "string" && v !== "") view = v;
    } catch {
      // malformed frontmatter → default view
    }
  }

  const table = firstTable(tree);
  if (table === null) return { view, events: [] };
  const idx = columnIndices(table);
  const events: CalendarEvent[] = table.children.slice(1).map((row, rowIdx) => ({
    date: cellText(row, idx.date),
    title: cellText(row, idx.title),
    page: cellText(row, idx.page),
    tag: cellText(row, idx.tag),
    rowIdx,
  }));
  return { view, events };
}

/**
 * Append an event row to the first table (created with a
 * date|title|page|tag header when the document has none yet).
 */
export function addEvent(tree: Root, event: CalendarEventInput): Root {
  const next = structuredClone(tree);
  let table = firstTable(next);
  if (table === null) {
    table = {
      type: "table",
      align: [null, null, null, null],
      children: [
        {
          type: "tableRow",
          children: COLUMNS.map((name) => makeCell(name)),
        },
      ],
    };
    next.children.push(table);
  }
  const idx = columnIndices(table);
  const width = Math.max(
    table.children[0]?.children.length ?? 0,
    ...COLUMNS.map((c) => idx[c] + 1),
  );
  const cells: TableCell[] = Array.from({ length: width }, () => makeCell(""));
  const put = (col: ColumnName, value: string): void => {
    if (idx[col] >= 0) cells[idx[col]] = makeCell(value);
  };
  put("date", event.date.trim());
  put("title", event.title.trim());
  put("page", (event.page ?? "").trim());
  put("tag", (event.tag ?? "").trim());
  table.children.push({ type: "tableRow", children: cells });
  return next;
}
