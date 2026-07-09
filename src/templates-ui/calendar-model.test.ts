// Track T1 — Calendar model tests: bundled fixture parsing and byte-level
// roundtrip stability of addEvent (INTERFACES.md §9.2).

import { describe, expect, it } from "vitest";

import { normalizeMarkdown, parseMarkdown, stringifyMarkdown } from "../markdown";
import { BUNDLED_TEMPLATES } from "./bundled";
import { addEvent, parseCalendar } from "./calendar-model";

const calendarRaw = BUNDLED_TEMPLATES.find((t) => t.key === "calendar")!.raw;
const baseline = normalizeMarkdown(calendarRaw);
const baseTree = () => parseMarkdown(baseline);

function expectCanonical(md: string): void {
  expect(stringifyMarkdown(parseMarkdown(md))).toBe(md);
}

describe("parseCalendar", () => {
  it("parses the bundled template (view + events from the first table)", () => {
    const model = parseCalendar(baseTree());
    expect(model.view).toBe("month");
    expect(model.events).toHaveLength(3);
    expect(model.events[0]).toEqual({
      date: "2026-07-10",
      title: "M1 レビュー",
      page: "01KWNEPJ0XZ476QJZ5CYVE3TW0",
      tag: "review",
      rowIdx: 0,
    });
    expect(model.events[2].page).toBe("");
    expect(model.events[2].tag).toBe("release");
  });

  it("matches columns by header name, not position", () => {
    const md = [
      "| title | date       | tag |",
      "| ----- | ---------- | --- |",
      "| X     | 2026-01-02 | t   |",
      "",
    ].join("\n");
    const model = parseCalendar(parseMarkdown(md));
    expect(model.events[0].date).toBe("2026-01-02");
    expect(model.events[0].title).toBe("X");
    expect(model.events[0].page).toBe("");
  });

  it("defaults to month view and no events without frontmatter/table", () => {
    const model = parseCalendar(parseMarkdown("# nothing here\n"));
    expect(model.view).toBe("month");
    expect(model.events).toEqual([]);
  });
});

describe("addEvent", () => {
  it("appends exactly one row (one-line diff, byte-stable)", () => {
    const after = stringifyMarkdown(
      addEvent(baseTree(), { date: "2026-07-24", title: "打合せ", tag: "sync" }),
    );
    expectCanonical(after);
    const beforeLines = baseline.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length + 1);
    const added = afterLines.filter((l) => !beforeLines.includes(l));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("2026-07-24");

    const model = parseCalendar(parseMarkdown(after));
    expect(model.events).toHaveLength(4);
    expect(model.events[3]).toEqual({
      date: "2026-07-24",
      title: "打合せ",
      page: "",
      tag: "sync",
      rowIdx: 3,
    });
  });

  it("creates the table when the document has none", () => {
    const md = normalizeMarkdown("---\ntemplate: calendar\n---\n");
    const after = stringifyMarkdown(
      addEvent(parseMarkdown(md), {
        date: "2026-07-10",
        title: "kickoff",
        page: "Notes.md",
        tag: "m",
      }),
    );
    expectCanonical(after);
    const model = parseCalendar(parseMarkdown(after));
    expect(model.events).toEqual([
      { date: "2026-07-10", title: "kickoff", page: "Notes.md", tag: "m", rowIdx: 0 },
    ]);
  });

  it("does not mutate the input tree", () => {
    const tree = baseTree();
    addEvent(tree, { date: "2026-12-31", title: "x" });
    expect(stringifyMarkdown(tree)).toBe(baseline);
  });
});
