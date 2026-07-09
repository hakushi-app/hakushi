// Track C2 — semantic 3-way merge test suite (INTERFACES.md §12.2).

import { describe, expect, it } from "vitest";

import { normalizeMarkdown } from "../markdown";
import {
  connectMergedBlocks,
  semanticMerge3,
  type MergeBlock,
  type MergeResult,
} from "./semantic-merge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conflicts(r: MergeResult): Extract<MergeBlock, { kind: "conflict" }>[] {
  return r.blocks.filter((b): b is Extract<MergeBlock, { kind: "conflict" }> => b.kind === "conflict");
}

function autoTexts(r: MergeResult): string[] {
  return r.blocks
    .filter((b): b is Extract<MergeBlock, { kind: "auto" }> => b.kind === "auto")
    .map((b) => b.md);
}

/** Resolve every conflict by a chooser, then connect + normalize to one doc. */
function resolveAll(
  r: MergeResult,
  choose: (c: Extract<MergeBlock, { kind: "conflict" }>) => string,
): string {
  const first = r.blocks[0];
  const hasFm = first?.kind === "auto" && /^---/.test(first.md.trimStart());
  const fmMd = hasFm ? (first as { md: string }).md : null;
  const bodyBlocks = (hasFm ? r.blocks.slice(1) : r.blocks).map((b) =>
    b.kind === "auto" ? b.md : choose(b),
  );
  return connectMergedBlocks(fmMd, bodyBlocks);
}

// ---------------------------------------------------------------------------
// Auto-merge: non-overlapping edits
// ---------------------------------------------------------------------------

describe("semanticMerge3 — auto-merge", () => {
  it("auto-merges non-overlapping edits to different blocks", () => {
    const base = "# タイトル\n\n段落A。\n\n段落B。\n";
    const ours = "# タイトル\n\n段落A を編集。\n\n段落B。\n";
    const theirs = "# タイトル\n\n段落A。\n\n段落B を編集。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    expect(conflicts(r)).toHaveLength(0);
    const merged = resolveAll(r, () => {
      throw new Error("no conflicts expected");
    });
    expect(merged).toContain("段落A を編集");
    expect(merged).toContain("段落B を編集");
    // Idempotent + canonical.
    expect(normalizeMarkdown(merged)).toBe(merged);
  });

  it("auto-merges a pure addition on one side", () => {
    const base = "# メモ\n\n本文。\n";
    const ours = "# メモ\n\n本文。\n\nours が追加した段落。\n";
    const theirs = base;
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    expect(autoTexts(r).some((t) => t.includes("ours が追加した段落"))).toBe(true);
  });

  it("auto-merges identical edits on both sides (no conflict)", () => {
    const base = "同じ文。\n";
    const ours = "同じ文を両者が同じに直した。\n";
    const theirs = "同じ文を両者が同じに直した。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    expect(autoTexts(r)).toContain("同じ文を両者が同じに直した。");
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe("semanticMerge3 — conflicts", () => {
  it("conflicts when both edit the SAME block differently", () => {
    const base = "共有段落。元の文。\n";
    const ours = "共有段落。私の変更。\n";
    const theirs = "共有段落。相手の変更。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(false);
    const cs = conflicts(r);
    expect(cs).toHaveLength(1);
    expect(cs[0].ours).toContain("私の変更");
    expect(cs[0].theirs).toContain("相手の変更");
    expect(cs[0].base).toContain("元の文");
  });

  it("conflicts on deletion vs edit of the same block", () => {
    const base = "# 見出し\n\n消えるかもしれない段落。\n";
    const ours = "# 見出し\n"; // ours deleted the paragraph
    const theirs = "# 見出し\n\n消えるかもしれない段落を編集した。\n"; // theirs edited it
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(false);
    const cs = conflicts(r);
    expect(cs).toHaveLength(1);
    // ours deleted → empty; theirs kept the edited text.
    expect(cs[0].ours).toBe("");
    expect(cs[0].theirs).toContain("編集した");
  });

  it("conflicts when both add DIFFERENT content at the same position", () => {
    const base = "# 見出し\n\n本文。\n";
    const ours = "# 見出し\n\n本文。\n\nours の新段落。\n";
    const theirs = "# 見出し\n\n本文。\n\ntheirs の新段落。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(false);
    const cs = conflicts(r);
    expect(cs).toHaveLength(1);
    expect(cs[0].base).toBeNull();
    expect(cs[0].ours).toContain("ours の新段落");
    expect(cs[0].theirs).toContain("theirs の新段落");
  });
});

// ---------------------------------------------------------------------------
// List / Kanban item granularity
// ---------------------------------------------------------------------------

describe("semanticMerge3 — list item granularity", () => {
  it("auto-merges edits to DIFFERENT task-list items", () => {
    const base = "## Todo\n\n- [ ] 牛乳を買う\n- [ ] 掃除する\n";
    const ours = "## Todo\n\n- [x] 牛乳を買う\n- [ ] 掃除する\n"; // ours checked #1
    const theirs = "## Todo\n\n- [ ] 牛乳を買う\n- [x] 掃除する\n"; // theirs checked #2
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => {
      throw new Error("no conflicts expected");
    });
    expect(merged).toContain("- [x] 牛乳を買う");
    expect(merged).toContain("- [x] 掃除する");
  });

  it("conflicts when both edit the SAME task-list item differently", () => {
    const base = "## Todo\n\n- [ ] 共有タスク\n";
    const ours = "## Todo\n\n- [x] 共有タスク\n"; // ours checked it
    const theirs = "## Todo\n\n- [ ] 共有タスクを言い換えた\n"; // theirs rewrote text
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(false);
    expect(conflicts(r)).toHaveLength(1);
  });

  it("auto-merges a Kanban card move (ours) with a different card added (theirs)", () => {
    const base = `## Backlog

- [ ] カードA
- [ ] カードB

## Done

- [x] 完了済み
`;
    // ours: move カードA from Backlog to Done.
    const ours = `## Backlog

- [ ] カードB

## Done

- [x] 完了済み
- [ ] カードA
`;
    // theirs: add a new card in Backlog, leave everything else.
    const theirs = `## Backlog

- [ ] カードA
- [ ] カードB
- [ ] カードC

## Done

- [x] 完了済み
`;
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => {
      throw new Error("no conflicts expected");
    });
    // カードA moved to Done, カードC added in Backlog, カードB stays.
    expect(merged).toContain("カードC");
    const doneIdx = merged.indexOf("## Done");
    expect(merged.indexOf("カードA")).toBeGreaterThan(doneIdx);
  });

  it("auto-merges when both sides delete the same block", () => {
    const base = "# T\n\n段落1。\n\n消える段落。\n";
    const ours = "# T\n\n段落1。\n";
    const theirs = "# T\n\n段落1。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => "");
    expect(merged).not.toContain("消える段落");
    expect(merged).toContain("段落1");
  });

  it("auto-merges deletion (ours) with an unrelated edit (theirs)", () => {
    const base = "段落A。\n\n段落B。\n";
    const ours = "段落B。\n"; // ours deleted A
    const theirs = "段落A。\n\n段落B を編集。\n"; // theirs edited B
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => "");
    expect(merged).not.toContain("段落A");
    expect(merged).toContain("段落B を編集");
  });

  it("conflicts when one side MOVES an item the other side EDITS", () => {
    const base = "## Backlog\n\n- [ ] 共有カード\n\n## Done\n\n- [x] 済\n";
    // ours: move 共有カード to Done.
    const ours = "## Backlog\n\n## Done\n\n- [x] 済\n- [ ] 共有カード\n";
    // theirs: edit 共有カード's text in Backlog.
    const theirs = "## Backlog\n\n- [ ] 共有カードを改名\n\n## Done\n\n- [x] 済\n";
    const r = semanticMerge3(base, ours, theirs);
    // ours deletes it from Backlog (move-away); theirs changes it in Backlog →
    // delete-vs-change conflict at the Backlog slot (safe: no silent loss).
    expect(r.autoMerged).toBe(false);
    expect(conflicts(r).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter key-level merge
// ---------------------------------------------------------------------------

describe("semanticMerge3 — frontmatter", () => {
  const withFm = (title: string, body: string, extra = "") =>
    `---\nid: 01ABC\ntitle: ${title}\ncreated: 2026-07-01\n${extra}---\n\n${body}\n`;

  it("auto-merges a frontmatter title change (ours) with a body edit (theirs)", () => {
    const base = withFm("旧タイトル", "本文の元の文。");
    const ours = withFm("新タイトル", "本文の元の文。"); // ours: title only
    const theirs = withFm("旧タイトル", "本文を編集した。"); // theirs: body only
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => {
      throw new Error("no conflicts expected");
    });
    expect(merged).toContain("title: 新タイトル");
    expect(merged).toContain("本文を編集した");
    expect(merged).toContain("id: 01ABC"); // id preserved
  });

  it("keeps id stable and takes the newer updated on a title collision", () => {
    const base = withFm("A", "本文。", "updated: 2026-07-01\n");
    const ours = withFm("Ours タイトル", "本文。", "updated: 2026-07-03\n");
    const theirs = withFm("Theirs タイトル", "本文。", "updated: 2026-07-02\n");
    const r = semanticMerge3(base, ours, theirs);
    // title collides but is non-settings → newer updated (ours) wins, auto.
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => {
      throw new Error("no conflicts expected");
    });
    expect(merged).toContain("title: Ours タイトル");
    expect(merged).toContain("id: 01ABC");
  });

  it("conflicts on a genuine template setting divergence", () => {
    const base = "---\nid: 01ABC\ntitle: T\ntemplate: kanban\n---\n\n本文。\n";
    const ours = "---\nid: 01ABC\ntitle: T\ntemplate: calendar\n---\n\n本文。\n";
    const theirs = "---\nid: 01ABC\ntitle: T\ntemplate: todo\n---\n\n本文。\n";
    const r = semanticMerge3(base, ours, theirs);
    expect(r.autoMerged).toBe(false);
    const cs = conflicts(r);
    expect(cs.length).toBeGreaterThanOrEqual(1);
    // The frontmatter conflict carries whole-block ours/theirs.
    expect(cs[0].ours).toContain("template: calendar");
    expect(cs[0].theirs).toContain("template: todo");
  });
});

// ---------------------------------------------------------------------------
// Connect + normalize idempotency
// ---------------------------------------------------------------------------

describe("connectMergedBlocks — canonical & idempotent", () => {
  it("produces canonical markdown that normalizeMarkdown leaves unchanged", () => {
    const base = "# T\n\n- [ ] a\n- [ ] b\n";
    const ours = "# T\n\n- [x] a\n- [ ] b\n";
    const theirs = "# T\n\n- [ ] a\n- [x] b\n";
    const r = semanticMerge3(base, ours, theirs);
    const merged = resolveAll(r, () => "");
    expect(normalizeMarkdown(merged)).toBe(merged);
    // Double-connect stays stable.
    expect(normalizeMarkdown(normalizeMarkdown(merged))).toBe(merged);
  });

  it("re-attaches frontmatter verbatim (id bytes preserved)", () => {
    const fm = "---\nid: 01XYZ\ntitle: Keep\ncreated: 2026-07-01\n---\n";
    const out = connectMergedBlocks(fm, ["# 見出し", "本文。"]);
    expect(out.startsWith(fm)).toBe(true);
    expect(out).toContain("# 見出し");
    expect(normalizeMarkdown(out)).toBe(out);
  });

  it("handles a page with no frontmatter", () => {
    const out = connectMergedBlocks(null, ["段落1。", "段落2。"]);
    expect(out).toBe("段落1。\n\n段落2。\n");
    expect(normalizeMarkdown(out)).toBe(out);
  });

  it("resolving a conflict toward either side yields canonical output", () => {
    const base = "共有段落。元。\n";
    const ours = "共有段落。私。\n";
    const theirs = "共有段落。相手。\n";
    const r = semanticMerge3(base, ours, theirs);
    const takeOurs = resolveAll(r, (c) => c.ours);
    const takeTheirs = resolveAll(r, (c) => c.theirs);
    const takeBoth = resolveAll(r, (c) => `${c.ours}\n\n${c.theirs}`);
    for (const m of [takeOurs, takeTheirs, takeBoth]) {
      expect(normalizeMarkdown(m)).toBe(m);
    }
    expect(takeOurs).toContain("私");
    expect(takeTheirs).toContain("相手");
    expect(takeBoth).toContain("私");
    expect(takeBoth).toContain("相手");
  });
});

// ---------------------------------------------------------------------------
// Identity / no-change
// ---------------------------------------------------------------------------

describe("semanticMerge3 — identity", () => {
  it("auto-merges when neither side changed anything", () => {
    const doc = "# 変わらない\n\n本文。\n";
    const r = semanticMerge3(doc, doc, doc);
    expect(r.autoMerged).toBe(true);
    const merged = resolveAll(r, () => "");
    expect(normalizeMarkdown(merged)).toBe(normalizeMarkdown(doc));
  });
});
