// Track T1 — Kanban model tests: bundled fixture parsing, byte-level
// roundtrip stability of every op, and the "card move = one-line diff"
// guarantee (INTERFACES.md §9.2).

import { describe, expect, it } from "vitest";

import { normalizeMarkdown, parseMarkdown, stringifyMarkdown } from "../markdown";
import { BUNDLED_TEMPLATES } from "./bundled";
import { addCard, deleteCard, moveCard, parseKanban, toggleCard } from "./kanban-model";

const kanbanRaw = BUNDLED_TEMPLATES.find((t) => t.key === "kanban")!.raw;
// Canonical baseline: ops are always applied to pipeline-parsed trees and
// compared against pipeline output.
const baseline = normalizeMarkdown(kanbanRaw);
const baseTree = () => parseMarkdown(baseline);

/** op output must be a fixed point of the pipeline (byte-level roundtrip). */
function expectCanonical(md: string): void {
  expect(stringifyMarkdown(parseMarkdown(md))).toBe(md);
}

describe("parseKanban", () => {
  it("parses the bundled template into ordered columns and cards", () => {
    const model = parseKanban(baseTree());
    expect(model.columns.map((c) => c.title)).toEqual(["Backlog", "In Progress", "Done"]);
    expect(model.columns.map((c) => c.cards.length)).toEqual([2, 1, 1]);
    expect(model.columns[0].cards[0]).toEqual({
      text: "AST アダプタを設計する :prio[high]",
      checked: false,
      raw: "- [ ] AST アダプタを設計する :prio[high]",
    });
    expect(model.columns[2].cards[0].checked).toBe(true);
  });

  it("orders by frontmatter kanban.columns and appends extra sections", () => {
    const md = [
      "---",
      "kanban: { columns: [B, A] }",
      "---",
      "",
      "## A",
      "",
      "- [ ] a1",
      "",
      "## Extra",
      "",
      "- [x] e1",
      "",
      "## B",
      "",
      "- [ ] b1",
      "",
    ].join("\n");
    const model = parseKanban(parseMarkdown(md));
    expect(model.columns.map((c) => c.title)).toEqual(["B", "A", "Extra"]);
    expect(model.columns[0].cards[0].text).toBe("b1");
  });

  it("includes frontmatter-declared columns that have no body section", () => {
    const md = "---\nkanban: { columns: [A, Empty] }\n---\n\n## A\n\n- [ ] a1\n";
    const model = parseKanban(parseMarkdown(md));
    expect(model.columns.map((c) => c.title)).toEqual(["A", "Empty"]);
    expect(model.columns[1].cards).toEqual([]);
  });

  it("skips non-task list items but keeps task cards", () => {
    const md = "## A\n\n- plain note\n- [ ] task\n";
    const model = parseKanban(parseMarkdown(md));
    expect(model.columns[0].cards.map((c) => c.text)).toEqual(["task"]);
  });
});

describe("kanban ops", () => {
  it("moveCard serializes to a minimal one-line move", () => {
    const before = baseline;
    const after = stringifyMarkdown(moveCard(baseTree(), "Backlog", 1, "In Progress", 1));
    expectCanonical(after);

    const movedLine = "- [ ] テンプレート UI を検討する";
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    // Same multiset of lines (a pure move)…
    expect([...afterLines].sort()).toEqual([...beforeLines].sort());
    // …and removing the moved line from both sides leaves identical docs:
    // exactly one line changed position, nothing else was touched.
    const bIdx = beforeLines.indexOf(movedLine);
    const aIdx = afterLines.indexOf(movedLine);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).not.toBe(bIdx);
    expect(afterLines.filter((_, i) => i !== aIdx)).toEqual(
      beforeLines.filter((_, i) => i !== bIdx),
    );

    const model = parseKanban(parseMarkdown(after));
    expect(model.columns[0].cards.map((c) => c.text)).toEqual([
      "AST アダプタを設計する :prio[high]",
    ]);
    expect(model.columns[1].cards.map((c) => c.text)).toEqual([
      "エディタ同期のスパイク :assignee[keita]",
      "テンプレート UI を検討する",
    ]);
  });

  it("moveCard inserts at the requested index", () => {
    const after = stringifyMarkdown(moveCard(baseTree(), "Done", 0, "Backlog", 0));
    expectCanonical(after);
    const model = parseKanban(parseMarkdown(after));
    expect(model.columns[0].cards.map((c) => c.raw)).toEqual([
      "- [x] リポジトリの骨格",
      "- [ ] AST アダプタを設計する :prio[high]",
      "- [ ] テンプレート UI を検討する",
    ]);
    expect(model.columns[2].cards).toEqual([]);
  });

  it("toggleCard flips exactly one line", () => {
    const after = stringifyMarkdown(toggleCard(baseTree(), "Backlog", 0));
    expectCanonical(after);
    const beforeLines = baseline.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    const changed = afterLines.filter((l, i) => l !== beforeLines[i]);
    expect(changed).toEqual(["- [x] AST アダプタを設計する :prio[high]"]);
    // Toggling back restores the exact bytes.
    expect(
      stringifyMarkdown(toggleCard(parseMarkdown(after), "Backlog", 0)),
    ).toBe(baseline);
  });

  it("addCard appends one line to the column", () => {
    const after = stringifyMarkdown(addCard(baseTree(), "Done", "リリースノートを書く"));
    expectCanonical(after);
    const beforeLines = baseline.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length + 1);
    expect(afterLines).toContain("- [ ] リリースノートを書く");
    const model = parseKanban(parseMarkdown(after));
    expect(model.columns[2].cards.map((c) => c.text)).toEqual([
      "リポジトリの骨格",
      "リリースノートを書く",
    ]);
  });

  it("addCard creates the section for a frontmatter-only column", () => {
    const md = normalizeMarkdown(
      "---\nkanban: { columns: [A, B] }\n---\n\n## A\n\n- [ ] a1\n",
    );
    const after = stringifyMarkdown(addCard(parseMarkdown(md), "B", "b1"));
    expectCanonical(after);
    const model = parseKanban(parseMarkdown(after));
    expect(model.columns.map((c) => c.title)).toEqual(["A", "B"]);
    expect(model.columns[1].cards.map((c) => c.text)).toEqual(["b1"]);
  });

  it("deleteCard removes the line (and an emptied list) cleanly", () => {
    const after = stringifyMarkdown(deleteCard(baseTree(), "In Progress", 0));
    expectCanonical(after);
    expect(after).not.toContain("エディタ同期のスパイク");
    const model = parseKanban(parseMarkdown(after));
    expect(model.columns.map((c) => c.title)).toEqual(["Backlog", "In Progress", "Done"]);
    expect(model.columns[1].cards).toEqual([]);
  });

  it("ops never mutate the input tree", () => {
    const tree = baseTree();
    addCard(tree, "Backlog", "x");
    toggleCard(tree, "Backlog", 0);
    moveCard(tree, "Backlog", 0, "Done", 0);
    deleteCard(tree, "Backlog", 0);
    expect(stringifyMarkdown(tree)).toBe(baseline);
  });

  it("throws on unknown columns / card indices", () => {
    expect(() => toggleCard(baseTree(), "Nope", 0)).toThrow(/column not found/);
    expect(() => deleteCard(baseTree(), "Backlog", 9)).toThrow(/not found/);
  });
});
