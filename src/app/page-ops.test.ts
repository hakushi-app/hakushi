// Track U — unit tests for the pure move/rename/delete/create logic
// (INTERFACES.md §5.5) driven through a fake in-memory PageFs.

import { describe, expect, it } from "vitest";

import { extractRefs, parseMarkdown, readFrontmatter } from "../markdown";
import {
  collectDeleteImpact,
  computeRewrittenTarget,
  createNewPage,
  dedupeName,
  deletePage,
  movePage,
  movedPathMap,
  sanitizeTitle,
  type PageFs,
} from "./page-ops";
import { refPointsTo, relPathBetween } from "./paths";
import { buildTreeFromPaths } from "./tauri-mock";
import type { BacklinkRecord, PagePut } from "./workspace";

const ROOT = "/fake-root";

// ---------------------------------------------------------------------------
// Fake fs: in-memory files + live-computed backlinks + index call recording
// ---------------------------------------------------------------------------

function makeFakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const removed: string[] = [];
  const puts: PagePut[] = [];

  const hasDirPrefix = (rel: string) => {
    for (const k of files.keys()) if (k.startsWith(`${rel}/`)) return true;
    return false;
  };

  const fs: PageFs = {
    async listTree() {
      return buildTreeFromPaths([...files.keys()]);
    },
    async readFile(_r, rel) {
      const v = files.get(rel);
      if (v === undefined) throw new Error(`not found: ${rel}`);
      return v;
    },
    async writeFile(_r, rel, content) {
      files.set(rel, content);
    },
    async createPage(_r, rel, content) {
      if (files.has(rel) || hasDirPrefix(rel)) throw new Error(`exists: ${rel}`);
      files.set(rel, content);
    },
    async renamePath(_r, from, to) {
      if (files.has(to) || hasDirPrefix(to)) throw new Error(`exists: ${to}`);
      if (files.has(from)) {
        files.set(to, files.get(from) as string);
        files.delete(from);
        return;
      }
      if (!hasDirPrefix(from)) throw new Error(`not found: ${from}`);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${from}/`)) {
          files.set(to + key.slice(from.length), files.get(key) as string);
          files.delete(key);
        }
      }
    },
    async deletePath(_r, rel) {
      if (files.delete(rel)) return;
      if (!hasDirPrefix(rel)) throw new Error(`not found: ${rel}`);
      for (const key of [...files.keys()]) if (key.startsWith(`${rel}/`)) files.delete(key);
    },
    async indexBacklinks(_r, rel): Promise<BacklinkRecord[]> {
      // Live scan of the current files (same semantics as the real index).
      const md = files.get(rel);
      const id =
        md !== undefined
          ? ((readFrontmatter(md)?.id as string | undefined) ?? null)
          : null;
      const out: BacklinkRecord[] = [];
      for (const [src, content] of files) {
        const refs = extractRefs(parseMarkdown(content));
        for (const l of refs.links) {
          if (refPointsTo(src, "link", l.target, { relPath: rel, id })) {
            out.push({ srcRelPath: src, kind: "link", target: l.target });
          }
        }
        for (const e of refs.embeds) {
          if (refPointsTo(src, "embed", e.target, { relPath: rel, id })) {
            out.push({ srcRelPath: src, kind: "embed", target: e.target });
          }
        }
      }
      return out;
    },
    async indexPutPages(_r, pages) {
      puts.push(...pages);
    },
    async indexRemovePages(_r, rels) {
      removed.push(...rels);
    },
  };
  return { files, removed, puts, fs };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("sanitizeTitle", () => {
  it("strips forbidden filename characters", () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });
  it("trims leading/trailing dots and spaces", () => {
    expect(sanitizeTitle("  ..My Page.. ")).toBe("My Page");
  });
  it("falls back to Untitled", () => {
    expect(sanitizeTitle("")).toBe("Untitled");
    expect(sanitizeTitle(' ../::""|| ')).toBe("Untitled");
  });
});

describe("dedupeName", () => {
  it("returns the base name when free", () => {
    expect(dedupeName("Untitled", ["Other.md"])).toBe("Untitled");
  });
  it("suffixes -1, -2 against both files and directories", () => {
    expect(dedupeName("Untitled", ["Untitled.md", "Untitled-1"])).toBe("Untitled-2");
  });
});

describe("movedPathMap", () => {
  it("maps a single file move", () => {
    const map = movedPathMap("A.md", "sub/B.md", false, ["A.md", "C.md"]);
    expect([...map]).toEqual([["A.md", "sub/B.md"]]);
  });
  it("maps every page under a directory move", () => {
    const map = movedPathMap("P", "Arc/P", true, [
      "P/index.md",
      "P/a.md",
      "P/deep/b.md",
      "Other.md",
    ]);
    expect([...map]).toEqual([
      ["P/index.md", "Arc/P/index.md"],
      ["P/a.md", "Arc/P/a.md"],
      ["P/deep/b.md", "Arc/P/deep/b.md"],
    ]);
  });
});

describe("relPathBetween", () => {
  it("computes sibling, downward and upward paths", () => {
    expect(relPathBetween("", "Notes.md")).toBe("Notes.md");
    expect(relPathBetween("a", "a/b.md")).toBe("b.md");
    expect(relPathBetween("a/b", "Notes.md")).toBe("../../Notes.md");
    expect(relPathBetween("a", "b/c.md")).toBe("../b/c.md");
  });
});

describe("computeRewrittenTarget", () => {
  const moveMap = new Map([["Projects/Roadmap.md", "Archive/Roadmap.md"]]);

  it("rewrites a backlink link target to the moved location", () => {
    expect(
      computeRewrittenTarget("Projects/Roadmap.md", "link", "Notes.md", "Notes.md", moveMap),
    ).toBe("Archive/Roadmap.md");
  });

  it("rewrites relative backlink targets from nested sources", () => {
    expect(
      computeRewrittenTarget(
        "../Projects/Roadmap.md",
        "link",
        "sub/Page.md",
        "sub/Page.md",
        moveMap,
      ),
    ).toBe("../Archive/Roadmap.md");
  });

  it("preserves #fragment suffixes", () => {
    expect(
      computeRewrittenTarget(
        "Projects/Roadmap.md#plan",
        "link",
        "Notes.md",
        "Notes.md",
        moveMap,
      ),
    ).toBe("Archive/Roadmap.md#plan");
  });

  it("keeps unaffected links untouched (null)", () => {
    expect(
      computeRewrittenTarget("Welcome.md", "link", "Notes.md", "Notes.md", moveMap),
    ).toBeNull();
    expect(
      computeRewrittenTarget("./Welcome.md", "link", "Notes.md", "Notes.md", moveMap),
    ).toBeNull();
  });

  it("rewrites the moved page's own refs so they keep pointing at unmoved targets", () => {
    // Notes.md → sub/Notes.md; its link to Welcome.md must gain a ../
    expect(
      computeRewrittenTarget("Welcome.md", "link", "Notes.md", "sub/Notes.md", new Map([["Notes.md", "sub/Notes.md"]])),
    ).toBe("../Welcome.md");
  });

  it("keeps refs between pages moved together unchanged", () => {
    const dirMove = new Map([
      ["Projects/index.md", "Archive/index.md"],
      ["Projects/Roadmap.md", "Archive/Roadmap.md"],
    ]);
    expect(
      computeRewrittenTarget(
        "Roadmap.md",
        "link",
        "Projects/index.md",
        "Archive/index.md",
        dirMove,
      ),
    ).toBeNull();
  });

  it("rewrites workspace-relative embed targets, with extension completion", () => {
    expect(
      computeRewrittenTarget("Projects/Roadmap.md", "embed", "Notes.md", "Notes.md", moveMap),
    ).toBe("Archive/Roadmap.md");
    expect(
      computeRewrittenTarget("Projects/Roadmap", "embed", "Notes.md", "Notes.md", moveMap),
    ).toBe("Archive/Roadmap.md");
  });

  it("never rewrites id embed targets", () => {
    expect(
      computeRewrittenTarget(
        "01JAR000000000000000000004",
        "embed",
        "Notes.md",
        "Notes.md",
        moveMap,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// movePage orchestration (fake fs)
// ---------------------------------------------------------------------------

const DIR_WORKSPACE = {
  "Notes.md":
    'See [Roadmap](Projects/Roadmap.md).\n\n::embed{page="Projects/index.md"}\n',
  "Projects/index.md": '::embed{page="Projects/Roadmap.md"}\n',
  "Projects/Roadmap.md": "Back to [Notes](../Notes.md).\n",
  "Welcome.md": "Nothing here.\n",
};

describe("movePage", () => {
  it("moves a directory, rewriting backlink sources and the moved pages", async () => {
    const { files, removed, puts, fs } = makeFakeFs(DIR_WORKSPACE);
    await movePage(ROOT, "Projects", "Archive/Projects", fs);

    // files physically moved
    expect(files.has("Projects/index.md")).toBe(false);
    expect(files.has("Archive/Projects/index.md")).toBe(true);
    expect(files.has("Archive/Projects/Roadmap.md")).toBe(true);

    // external backlink source rewritten (link + embed)
    const notes = files.get("Notes.md") as string;
    expect(notes).toContain("(Archive/Projects/Roadmap.md)");
    expect(notes).toContain('page="Archive/Projects/index.md"');

    // moved folder note's embed now points at the target's new path
    expect(files.get("Archive/Projects/index.md")).toContain(
      'page="Archive/Projects/Roadmap.md"',
    );

    // moved page's own relative link updated to keep pointing at Notes.md
    expect(files.get("Archive/Projects/Roadmap.md")).toContain("(../../Notes.md)");

    // untouched page untouched
    expect(files.get("Welcome.md")).toBe("Nothing here.\n");

    // index: old paths removed, new/changed pages re-put
    expect(new Set(removed)).toEqual(
      new Set(["Projects/index.md", "Projects/Roadmap.md"]),
    );
    expect(new Set(puts.map((p) => p.page.relPath))).toEqual(
      new Set(["Notes.md", "Archive/Projects/index.md", "Archive/Projects/Roadmap.md"]),
    );
  });

  it("moves a single file, rewriting backlinks and its own refs", async () => {
    const { files, fs } = makeFakeFs(DIR_WORKSPACE);
    await movePage(ROOT, "Projects/Roadmap.md", "Roadmap.md", fs);

    expect(files.has("Projects/Roadmap.md")).toBe(false);
    expect(files.get("Notes.md")).toContain("(Roadmap.md)");
    expect(files.get("Projects/index.md")).toContain('page="Roadmap.md"');
    expect(files.get("Roadmap.md")).toContain("(Notes.md)");
  });

  it("rejects moving a folder into itself and non-.md page destinations", async () => {
    const { fs } = makeFakeFs(DIR_WORKSPACE);
    await expect(movePage(ROOT, "Projects", "Projects/sub", fs)).rejects.toThrow(
      /into itself/,
    );
    await expect(movePage(ROOT, "Notes.md", "Notes", fs)).rejects.toThrow(/\.md/);
  });
});

// ---------------------------------------------------------------------------
// deletePage
// ---------------------------------------------------------------------------

describe("deletePage / collectDeleteImpact", () => {
  it("reports only external backlinks and removes the subtree", async () => {
    const { files, removed, fs } = makeFakeFs(DIR_WORKSPACE);

    const impact = await collectDeleteImpact(ROOT, "Projects", fs);
    expect(new Set(impact.deletedRelPaths)).toEqual(
      new Set(["Projects/index.md", "Projects/Roadmap.md"]),
    );
    // Projects/index.md's embed of Projects/Roadmap.md is internal → excluded
    expect(impact.backlinks.every((b) => b.srcRelPath === "Notes.md")).toBe(true);
    expect(impact.backlinks).toHaveLength(2);

    const result = await deletePage(ROOT, "Projects", fs);
    expect(result.backlinks).toHaveLength(2);
    expect(files.has("Projects/index.md")).toBe(false);
    expect(files.has("Projects/Roadmap.md")).toBe(false);
    expect(new Set(removed)).toEqual(
      new Set(["Projects/index.md", "Projects/Roadmap.md"]),
    );
  });
});

// ---------------------------------------------------------------------------
// createNewPage
// ---------------------------------------------------------------------------

describe("createNewPage", () => {
  it("sanitizes the title, dedupes, writes canonical frontmatter, indexes", async () => {
    const { files, puts, fs } = makeFakeFs({ "Untitled.md": "x\n" });

    const rel = await createNewPage(ROOT, "", "Untitled", fs);
    expect(rel).toBe("Untitled-1.md");
    const md = files.get(rel) as string;
    expect(md.startsWith("---\n")).toBe(true);
    const meta = readFrontmatter(md);
    expect(meta?.title).toBe("Untitled-1");
    expect(typeof meta?.id).toBe("string");
    expect((meta?.id as string).length).toBe(26);
    expect(puts.map((p) => p.page.relPath)).toContain("Untitled-1.md");
  });

  it("creates inside a directory with a sanitized name", async () => {
    const { files, fs } = makeFakeFs({ "P/index.md": "x\n" });
    const rel = await createNewPage(ROOT, "P", 'A/B:C?"', fs);
    expect(rel).toBe("P/ABC.md");
    expect(files.has("P/ABC.md")).toBe(true);
  });
});
