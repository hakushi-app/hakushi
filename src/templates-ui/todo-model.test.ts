// Track T1 — Todo model tests: bundled fixtures (plain + advanced) and
// byte-level roundtrip stability of toggleTask (INTERFACES.md §9.2).

import { describe, expect, it } from "vitest";

import { normalizeMarkdown, parseMarkdown, stringifyMarkdown } from "../markdown";
import { BUNDLED_TEMPLATES } from "./bundled";
import { parseTodos, toggleTask } from "./todo-model";

const todoRaw = BUNDLED_TEMPLATES.find((t) => t.key === "todo")!.raw;
const advancedRaw = BUNDLED_TEMPLATES.find((t) => t.key === "todo-advanced")!.raw;

function expectCanonical(md: string): void {
  expect(stringifyMarkdown(parseMarkdown(md))).toBe(md);
}

describe("parseTodos", () => {
  it("parses the plain todo template", () => {
    const tasks = parseTodos(parseMarkdown(normalizeMarkdown(todoRaw)));
    expect(tasks.map((t) => t.checked)).toEqual([false, false, true]);
    expect(tasks[0]).toEqual({ text: "今日やること", checked: false, tags: [] });
  });

  it("reads :due / :prio directives and #tags from the advanced template", () => {
    const tasks = parseTodos(parseMarkdown(normalizeMarkdown(advancedRaw)));
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toEqual({
      text: "M1 をリリースする",
      checked: false,
      due: "2026-08-01",
      prio: "high",
      tags: ["editor"],
    });
    expect(tasks[2]).toEqual({
      text: "モバイル実機で確認",
      checked: false,
      prio: "low",
      tags: ["mobile"],
    });
    expect(tasks[3].checked).toBe(true);
    expect(tasks[3].prio).toBe("high");
  });

  it("collects nested task items in document order, text kept per item", () => {
    const md = "- [ ] parent #a\n  - [x] child :prio[low]\n- [ ] sibling\n";
    const tasks = parseTodos(parseMarkdown(md));
    expect(tasks.map((t) => t.text)).toEqual(["parent", "child", "sibling"]);
    expect(tasks[0].tags).toEqual(["a"]);
    expect(tasks[1]).toMatchObject({ checked: true, prio: "low" });
  });
});

describe("toggleTask", () => {
  it("flips exactly one line and roundtrips byte-stable", () => {
    const baseline = normalizeMarkdown(advancedRaw);
    const after = stringifyMarkdown(toggleTask(parseMarkdown(baseline), 0));
    expectCanonical(after);
    const beforeLines = baseline.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    const changed = afterLines.filter((l, i) => l !== beforeLines[i]);
    expect(changed).toEqual([
      "- [x] M1 をリリースする :due[2026-08-01] :prio[high] #editor",
    ]);
    // Toggling again restores the exact bytes.
    expect(stringifyMarkdown(toggleTask(parseMarkdown(after), 0))).toBe(baseline);
  });

  it("does not mutate the input tree and rejects bad indices", () => {
    const baseline = normalizeMarkdown(todoRaw);
    const tree = parseMarkdown(baseline);
    toggleTask(tree, 1);
    expect(stringifyMarkdown(tree)).toBe(baseline);
    expect(() => toggleTask(tree, 99)).toThrow(/not found/);
  });
});
