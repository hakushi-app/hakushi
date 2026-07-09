// Track T3 — in-memory collab store + merge of the dev mock backend
// (INTERFACES.md §10.2/§10.3). Like tauri-mock-git.test.ts, the mock state is
// module-global, so this file runs as one sequential scenario; vitest gives
// each test file its own module registry, so other files are unaffected.

import { describe, expect, it } from "vitest";

import { MOCK_WORKSPACE_ROOT, mockBackend } from "../app/tauri-mock";
import { parseIssueEvents, parsePrEvents } from "./events";

const ROOT = MOCK_WORKSPACE_ROOT;

describe("tauri-mock collab (sequential scenario)", () => {
  it("advertises merge capability and seeds one sample issue", async () => {
    const info = await mockBackend.gitBackendInfo();
    expect(info.capabilities.merge).toBe(true);

    const issues = await mockBackend.collabListIssues(ROOT);
    expect(issues).toHaveLength(1);
    expect(issues[0].state).toBe("open");
    expect(issues[0].commentCount).toBe(1);
    expect(issues[0].title).toContain("サンプル Issue");
  });

  it("creates issues, appends events, and derives summaries", async () => {
    const id = await mockBackend.collabCreateIssue(ROOT, "バグ: 保存できない", "詳細");
    expect(id).toMatch(/^01JARCLB\d{18}$/);

    await mockBackend.collabIssueEvent(
      ROOT,
      id,
      JSON.stringify({ v: 1, type: "comment", ts: 9_999_999_999, author: "me", data: { body: "調査中" } }),
    );
    await mockBackend.collabIssueEvent(
      ROOT,
      id,
      JSON.stringify({ v: 1, type: "close", ts: 10_000_000_000, author: "me", data: {} }),
    );
    // A malformed line must not brick listing or reading.
    await mockBackend.collabIssueEvent(ROOT, id, "{oops");

    const summary = (await mockBackend.collabListIssues(ROOT)).find((s) => s.id === id);
    expect(summary).toMatchObject({
      title: "バグ: 保存できない",
      state: "closed",
      commentCount: 1,
    });

    const events = parseIssueEvents(await mockBackend.collabGetIssue(ROOT, id));
    expect(events.map((e) => e.type)).toEqual(["create", "comment", "close"]);

    await expect(mockBackend.collabIssueEvent(ROOT, "nope", "{}")).rejects.toThrow(
      /issue が見つかりません/,
    );
  });

  it("fast-forwards when the current head is an ancestor of the source", async () => {
    await mockBackend.gitCreateBranch(ROOT, "feature-ff");
    await mockBackend.gitCheckoutBranch(ROOT, "feature-ff");
    await mockBackend.writeFile(ROOT, "FF.md", "ff\n");
    await mockBackend.gitCommit(ROOT, "add FF page");
    await mockBackend.gitCheckoutBranch(ROOT, "main");
    expect(await mockBackend.readFile(ROOT, "FF.md").catch(() => null)).toBeNull();

    const outcome = await mockBackend.gitMergeBranch(ROOT, "feature-ff");
    expect(outcome).toEqual({ kind: "fastForward", conflictPaths: [] });
    expect(await mockBackend.readFile(ROOT, "FF.md")).toBe("ff\n");
    expect(await mockBackend.gitStatus(ROOT)).toEqual([]);
    // Merging the already-contained branch again is a no-op fastForward.
    expect(await mockBackend.gitMergeBranch(ROOT, "feature-ff")).toEqual({
      kind: "fastForward",
      conflictPaths: [],
    });
  });

  it("creates a merge commit when branches diverge on different files", async () => {
    await mockBackend.gitCreateBranch(ROOT, "feature-merge");
    // Advance main.
    await mockBackend.writeFile(ROOT, "MainOnly.md", "main\n");
    await mockBackend.gitCommit(ROOT, "main-side change");
    // Advance the feature branch on a different file.
    await mockBackend.gitCheckoutBranch(ROOT, "feature-merge");
    await mockBackend.writeFile(ROOT, "FeatureOnly.md", "feature\n");
    await mockBackend.gitCommit(ROOT, "feature-side change");
    await mockBackend.gitCheckoutBranch(ROOT, "main");

    const outcome = await mockBackend.gitMergeBranch(ROOT, "feature-merge");
    expect(outcome).toEqual({ kind: "merged", conflictPaths: [] });
    expect(await mockBackend.readFile(ROOT, "MainOnly.md")).toBe("main\n");
    expect(await mockBackend.readFile(ROOT, "FeatureOnly.md")).toBe("feature\n");
    const log = await mockBackend.gitLog(ROOT, null, 1);
    expect(log[0].summary).toBe("Merge branch 'feature-merge'");
  });

  it("reports conflicts (worktree untouched) when both sides touch one file", async () => {
    await mockBackend.gitCreateBranch(ROOT, "feature-conflict");
    await mockBackend.writeFile(ROOT, "Notes.md", "main version\n");
    await mockBackend.gitCommit(ROOT, "main edits Notes");
    await mockBackend.gitCheckoutBranch(ROOT, "feature-conflict");
    await mockBackend.writeFile(ROOT, "Notes.md", "feature version\n");
    await mockBackend.gitCommit(ROOT, "feature edits Notes");
    await mockBackend.gitCheckoutBranch(ROOT, "main");

    const outcome = await mockBackend.gitMergeBranch(ROOT, "feature-conflict");
    expect(outcome.kind).toBe("conflicts");
    expect(outcome.conflictPaths).toEqual(["Notes.md"]);
    expect(await mockBackend.readFile(ROOT, "Notes.md")).toBe("main version\n");

    await expect(mockBackend.gitMergeBranch(ROOT, "main")).rejects.toThrow(
      /現在のブランチ/,
    );
    await expect(mockBackend.gitMergeBranch(ROOT, "no-such-branch")).rejects.toThrow(
      /ブランチがありません/,
    );

    // Dirty worktree refuses to merge.
    await mockBackend.writeFile(ROOT, "Dirty.md", "x\n");
    await expect(mockBackend.gitMergeBranch(ROOT, "feature-conflict")).rejects.toThrow(
      /未コミット/,
    );
    await mockBackend.deletePath(ROOT, "Dirty.md");
  });

  it("stores PRs with summaries derived from events", async () => {
    const id = await mockBackend.collabCreatePr(
      ROOT,
      "feature-merge を取り込む",
      "説明",
      "feature-merge",
      "main",
    );
    const listed = (await mockBackend.collabListPrs(ROOT)).find((p) => p.id === id);
    expect(listed).toMatchObject({
      title: "feature-merge を取り込む",
      state: "open",
      source: "feature-merge",
      target: "main",
    });

    await mockBackend.collabPrEvent(
      ROOT,
      id,
      JSON.stringify({
        v: 1,
        type: "review_comment",
        ts: 9_999_999_999,
        author: "me",
        data: { anchor: { page: "Notes.md", block: 2 }, body: "ここ直したい" },
      }),
    );
    await mockBackend.collabPrEvent(
      ROOT,
      id,
      JSON.stringify({ v: 1, type: "status", ts: 10_000_000_000, author: "me", data: { state: "merged" } }),
    );

    const events = parsePrEvents(await mockBackend.collabGetPr(ROOT, id));
    expect(events.map((e) => e.type)).toEqual(["create", "review_comment", "status"]);
    const after = (await mockBackend.collabListPrs(ROOT)).find((p) => p.id === id);
    expect(after?.state).toBe("merged");
  });
});
