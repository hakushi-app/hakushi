// Track H — in-memory pseudo git of the dev mock backend (INTERFACES.md
// §7.3). The mock's git state is module-global (like the files map), so these
// steps run as one sequential scenario; vitest gives this file its own module
// registry, so other test files are unaffected.

import { describe, expect, it } from "vitest";

import { MOCK_WORKSPACE_ROOT, mockBackend } from "./tauri-mock";

const ROOT = MOCK_WORKSPACE_ROOT;

describe("tauri-mock pseudo git (sequential scenario)", () => {
  it("starts with one seed commit on main and a clean worktree", async () => {
    const info = await mockBackend.gitBackendInfo();
    expect(info.name).toBe("mock");
    expect(info.capabilities.branch).toBe(true);
    expect(info.capabilities.push).toBe(false);

    expect(await mockBackend.gitBranches(ROOT)).toEqual({
      current: "main",
      branches: ["main"],
    });

    const log = await mockBackend.gitLog(ROOT, null, null);
    expect(log).toHaveLength(1);
    expect(log[0].summary).toContain("初期コミット");

    expect(await mockBackend.gitStatus(ROOT)).toEqual([]);
  });

  it("reports new / modified / deleted vs the branch head", async () => {
    const original = await mockBackend.readFile(ROOT, "Welcome.md");
    await mockBackend.writeFile(ROOT, "Welcome.md", `${original}\n追記。\n`);
    await mockBackend.writeFile(ROOT, "Scratch.md", "# scratch\n");
    await mockBackend.deletePath(ROOT, "Notes.md");

    const status = await mockBackend.gitStatus(ROOT);
    expect(status).toEqual([
      { relPath: "Notes.md", status: "deleted" },
      { relPath: "Scratch.md", status: "new" },
      { relPath: "Welcome.md", status: "modified" },
    ]);
  });

  it("commit_all clears status and appends to the log (newest first)", async () => {
    const oid = await mockBackend.gitCommit(ROOT, "作業コミット\n本文");
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await mockBackend.gitStatus(ROOT)).toEqual([]);

    const log = await mockBackend.gitLog(ROOT, null, null);
    expect(log.map((c) => c.summary)).toEqual(["作業コミット", "初期コミット: シードページ"]);

    // relPath filter: Welcome.md was touched by both commits, Roadmap only by the seed.
    const welcome = await mockBackend.gitLog(ROOT, "Welcome.md", null);
    expect(welcome).toHaveLength(2);
    const roadmap = await mockBackend.gitLog(ROOT, "Projects/Roadmap.md", null);
    expect(roadmap.map((c) => c.summary)).toEqual(["初期コミット: シードページ"]);
    // limit caps the count.
    expect(await mockBackend.gitLog(ROOT, null, 1)).toHaveLength(1);
  });

  it("rejects a commit on a clean worktree", async () => {
    await expect(mockBackend.gitCommit(ROOT, "empty")).rejects.toThrow(/nothing to commit/);
  });

  it("file_at_commit returns the blob at that commit, or null when absent", async () => {
    const [head, seed] = await mockBackend.gitLog(ROOT, null, null);
    const atSeed = await mockBackend.gitFileAtCommit(ROOT, "Welcome.md", seed.oid);
    const atHead = await mockBackend.gitFileAtCommit(ROOT, "Welcome.md", head.oid);
    expect(atSeed).not.toBeNull();
    expect(atHead).toContain("追記。");
    expect(atHead).not.toBe(atSeed);
    // Scratch.md did not exist at the seed commit.
    expect(await mockBackend.gitFileAtCommit(ROOT, "Scratch.md", seed.oid)).toBeNull();
    await expect(mockBackend.gitFileAtCommit(ROOT, "x.md", "deadbeef")).rejects.toThrow();
  });

  it("revert_file restores the old blob into the worktree", async () => {
    const [, seed] = await mockBackend.gitLog(ROOT, null, null);
    await mockBackend.gitRevertFile(ROOT, "Welcome.md", seed.oid);
    expect(await mockBackend.readFile(ROOT, "Welcome.md")).toBe(
      await mockBackend.gitFileAtCommit(ROOT, "Welcome.md", seed.oid),
    );
    expect(await mockBackend.gitStatus(ROOT)).toEqual([
      { relPath: "Welcome.md", status: "modified" },
    ]);
    await mockBackend.gitCommit(ROOT, "Welcome を初版に戻す");
  });

  it("checkout requires a clean worktree and swaps the live files", async () => {
    await mockBackend.gitCreateBranch(ROOT, "feature");
    expect((await mockBackend.gitBranches(ROOT)).branches).toEqual(["feature", "main"]);

    // Dirty tree blocks checkout.
    await mockBackend.writeFile(ROOT, "Dirty.md", "wip\n");
    await expect(mockBackend.gitCheckoutBranch(ROOT, "feature")).rejects.toThrow(
      /commit or discard/,
    );
    await mockBackend.deletePath(ROOT, "Dirty.md");

    // Clean → switch, commit a branch-only file.
    await mockBackend.gitCheckoutBranch(ROOT, "feature");
    expect((await mockBackend.gitBranches(ROOT)).current).toBe("feature");
    await mockBackend.writeFile(ROOT, "Feature.md", "# feature only\n");
    await mockBackend.gitCommit(ROOT, "feature ページ追加");

    // Back on main the file is gone; on feature it is back.
    await mockBackend.gitCheckoutBranch(ROOT, "main");
    await expect(mockBackend.readFile(ROOT, "Feature.md")).rejects.toThrow(/not found/);
    await mockBackend.gitCheckoutBranch(ROOT, "feature");
    expect(await mockBackend.readFile(ROOT, "Feature.md")).toBe("# feature only\n");

    // Unknown branch / duplicate create are rejected.
    await expect(mockBackend.gitCheckoutBranch(ROOT, "nope")).rejects.toThrow();
    await expect(mockBackend.gitCreateBranch(ROOT, "feature")).rejects.toThrow();
  });
});
