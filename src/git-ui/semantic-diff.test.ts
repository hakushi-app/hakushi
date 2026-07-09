// Track H — semantic diff test suite (INTERFACES.md §7.2).

import { describe, expect, it } from "vitest";

import { semanticDiff } from "./semantic-diff";

const KANBAN_BEFORE = `---
id: 01JAR000000000000000000005
title: Tasks
template: kanban
---

## Backlog

- [ ] Design AST adapter
- [ ] Write docs

## In Progress

- [ ] Editor sync spike

## Done

- [x] Repo skeleton
`;

describe("semanticDiff", () => {
  it("returns [] for identical documents", () => {
    expect(semanticDiff(KANBAN_BEFORE, KANBAN_BEFORE)).toEqual([]);
  });

  it("reports a pure addition as added", () => {
    const before = "# メモ\n\n最初の段落。\n";
    const after = "# メモ\n\n最初の段落。\n\n追加された段落。\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "added", block: "追加された段落。" },
    ]);
  });

  it("reports a deletion as removed", () => {
    const before = "# メモ\n\n最初の段落。\n\n消える段落。\n";
    const after = "# メモ\n\n最初の段落。\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "removed", block: "消える段落。" },
    ]);
  });

  it("reports a paragraph edit as modified (not remove+add)", () => {
    const before = "編集される段落。元の文。\n";
    const after = "編集される段落。元の文に少し追記。\n";
    expect(semanticDiff(before, after)).toEqual([
      {
        kind: "modified",
        before: "編集される段落。元の文。",
        after: "編集される段落。元の文に少し追記。",
      },
    ]);
  });

  it("keeps dissimilar block replacement as removed + added", () => {
    const before = "全く別の内容の段落です。\n";
    const after = "こちらは新規の文章で共通点がありません。\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "removed", block: "全く別の内容の段落です。" },
      { kind: "added", block: "こちらは新規の文章で共通点がありません。" },
    ]);
  });

  it("reports a task check toggle as task-toggled (not remove+add)", () => {
    const before = "## Todo\n\n- [ ] 牛乳を買う\n- [ ] 掃除する\n";
    const after = "## Todo\n\n- [x] 牛乳を買う\n- [ ] 掃除する\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "task-toggled", text: "牛乳を買う", done: true },
    ]);
  });

  it("reports unchecking as task-toggled with done=false", () => {
    const before = "## Todo\n\n- [x] 牛乳を買う\n";
    const after = "## Todo\n\n- [ ] 牛乳を買う\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "task-toggled", text: "牛乳を買う", done: false },
    ]);
  });

  it("reports a kanban card move between ## sections as moved", () => {
    const after = `---
id: 01JAR000000000000000000005
title: Tasks
template: kanban
---

## Backlog

- [ ] Write docs

## In Progress

- [ ] Editor sync spike
- [ ] Design AST adapter

## Done

- [x] Repo skeleton
`;
    expect(semanticDiff(KANBAN_BEFORE, after)).toEqual([
      {
        kind: "moved",
        text: "Design AST adapter",
        fromSection: "Backlog",
        toSection: "In Progress",
      },
    ]);
  });

  it("reports a move even when the source column becomes empty", () => {
    const before = "## Backlog\n\n- [ ] 唯一のカード\n\n## Done\n\n- [x] 完了済み\n";
    const after = "## Backlog\n\n## Done\n\n- [x] 完了済み\n- [ ] 唯一のカード\n";
    expect(semanticDiff(before, after)).toEqual([
      {
        kind: "moved",
        text: "唯一のカード",
        fromSection: "Backlog",
        toSection: "Done",
      },
    ]);
  });

  it("reports a cross-section move with a checkbox flip as moved", () => {
    const before = "## Backlog\n\n- [ ] カードX\n\n## Done\n\n- [x] 完了済み\n";
    const after = "## Backlog\n\n## Done\n\n- [x] 完了済み\n- [x] カードX\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "moved", text: "カードX", fromSection: "Backlog", toSection: "Done" },
    ]);
  });

  it("reports a new card in an existing list as a small added block", () => {
    const before = "## Backlog\n\n- [ ] カードA\n";
    const after = "## Backlog\n\n- [ ] カードA\n- [ ] 新カード\n";
    expect(semanticDiff(before, after)).toEqual([
      { kind: "added", block: "- [ ] 新カード" },
    ]);
  });

  it("handles a combined document with several operations, in after-order", () => {
    const before = `---
id: 01JAR00000000000000000000X
title: Combined
---

イントロ。ここは変わらない。

## Backlog

- [ ] カードA
- [ ] カードB

## Done

- [x] 完了済み

## Notes

消える段落。

編集される段落。元の文。
`;
    const after = `---
id: 01JAR00000000000000000000X
title: Combined
---

イントロ。ここは変わらない。

## Backlog

- [x] カードB

## Done

- [x] 完了済み
- [ ] カードA

## Notes

編集される段落。元の文に少し追記。

新しい段落。
`;
    expect(semanticDiff(before, after)).toEqual([
      { kind: "task-toggled", text: "カードB", done: true },
      { kind: "moved", text: "カードA", fromSection: "Backlog", toSection: "Done" },
      {
        kind: "modified",
        before: "編集される段落。元の文。",
        after: "編集される段落。元の文に少し追記。",
      },
      { kind: "removed", block: "消える段落。" },
      { kind: "added", block: "新しい段落。" },
    ]);
  });

  it("ignores frontmatter-only changes", () => {
    const before = "---\nid: 01X\ntitle: 旧タイトル\n---\n\n本文は同じ。\n";
    const after = "---\nid: 01X\ntitle: 新タイトル\nupdated: 2026-07-04\n---\n\n本文は同じ。\n";
    expect(semanticDiff(before, after)).toEqual([]);
  });

  it("ignores a pure reorder within the same section", () => {
    const before = "## Backlog\n\n- [ ] カードA\n- [ ] カードB\n";
    const after = "## Backlog\n\n- [ ] カードB\n- [ ] カードA\n";
    expect(semanticDiff(before, after)).toEqual([]);
  });

  it("treats an empty before-document as all-added", () => {
    expect(semanticDiff("", "新規本文。\n")).toEqual([
      { kind: "added", block: "新規本文。" },
    ]);
  });
});
