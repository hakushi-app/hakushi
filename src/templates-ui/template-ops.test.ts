// Track T1 — createPageFromTemplate / saveAsTemplate (INTERFACES.md §9.1),
// driven through a fake in-memory PageFs like page-ops.test.ts.

import { describe, expect, it } from "vitest";

import {
  createPageFromTemplate,
  instantiateTemplate,
  saveAsTemplate,
  type PageFs,
} from "../app/page-ops";
import { buildTreeFromPaths } from "../app/tauri-mock";
import type { PagePut } from "../app/workspace";
import { normalizeMarkdown, readFrontmatter } from "../markdown";
import { BUNDLED_TEMPLATES } from "./bundled";

const ROOT = "/fake-root";
const kanbanRaw = BUNDLED_TEMPLATES.find((t) => t.key === "kanban")!.raw;

function makeFakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const puts: PagePut[] = [];
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
      if (files.has(rel)) throw new Error(`exists: ${rel}`);
      files.set(rel, content);
    },
    async renamePath() {
      throw new Error("unused");
    },
    async deletePath() {
      throw new Error("unused");
    },
    async indexBacklinks() {
      return [];
    },
    async indexPutPages(_r, ps) {
      puts.push(...ps);
    },
    async indexRemovePages() {},
  };
  return { files, puts, fs };
}

describe("instantiateTemplate", () => {
  it("replaces id/title/created, keeps template + body, canonical output", () => {
    const out = instantiateTemplate(kanbanRaw, "My Board", "2026-07-05");
    const meta = readFrontmatter(out);
    expect(meta).not.toBeNull();
    expect(meta?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(meta?.id).not.toBe("01KWNEPJ0Z1HQNRFATQ8MDZ3ES");
    expect(meta?.title).toBe("My Board");
    expect(meta?.created).toBe("2026-07-05");
    expect(meta?.template).toBe("kanban");
    expect((meta?.kanban as { columns: string[] }).columns).toEqual([
      "Backlog",
      "In Progress",
      "Done",
    ]);
    // Body survives, and the whole document is already canonical.
    expect(out).toContain("## Backlog");
    expect(out).toContain("- [ ] AST アダプタを設計する :prio[high]");
    expect(normalizeMarkdown(out)).toBe(out);
  });

  it("issues a distinct id per instantiation and drops stale updated", () => {
    const raw = "---\nid: X\ntitle: T\nupdated: 2020-01-01\n---\n\nbody\n";
    const a = readFrontmatter(instantiateTemplate(raw, "A"));
    const b = readFrontmatter(instantiateTemplate(raw, "A"));
    expect(a?.id).not.toBe(b?.id);
    expect(a?.updated).toBeUndefined();
  });

  it("adds frontmatter when the template has none", () => {
    const out = instantiateTemplate("# Hello\n", "Fresh", "2026-07-05");
    const meta = readFrontmatter(out);
    expect(meta?.title).toBe("Fresh");
    expect(meta?.created).toBe("2026-07-05");
    expect(out).toContain("# Hello");
    expect(normalizeMarkdown(out)).toBe(out);
  });
});

describe("createPageFromTemplate", () => {
  it("creates a deduped page with fresh frontmatter and indexes it", async () => {
    const { files, puts, fs } = makeFakeFs({ "Board.md": "existing" });
    const rel = await createPageFromTemplate(ROOT, "", "Board", kanbanRaw, fs);
    expect(rel).toBe("Board-1.md");
    const md = files.get("Board-1.md");
    expect(md).toBeDefined();
    const meta = readFrontmatter(md as string);
    expect(meta?.title).toBe("Board-1");
    expect(meta?.template).toBe("kanban");
    expect(meta?.id).not.toBe("01KWNEPJ0Z1HQNRFATQ8MDZ3ES");
    expect(puts.map((p) => p.page.relPath)).toEqual(["Board-1.md"]);
    expect(puts[0].page.template).toBe("kanban");
  });

  it("sanitizes titles and creates inside the given directory", async () => {
    const { files, fs } = makeFakeFs({ "notes/a.md": "x" });
    const rel = await createPageFromTemplate(ROOT, "notes", "a/b:c", kanbanRaw, fs);
    expect(rel).toBe("notes/abc.md");
    expect(files.has("notes/abc.md")).toBe(true);
  });
});

describe("saveAsTemplate", () => {
  it("copies the page bytes to templates/<name>.md and indexes it", async () => {
    const src = "---\nid: KEEPME\ntitle: Page\n---\n\nbody\n";
    const { files, puts, fs } = makeFakeFs({ "Page.md": src });
    const rel = await saveAsTemplate(ROOT, "Page.md", "週次レビュー", fs);
    expect(rel).toBe("templates/週次レビュー.md");
    // Byte-exact copy — the id is kept (replaced at instantiation time).
    expect(files.get(rel)).toBe(src);
    expect(puts.map((p) => p.page.relPath)).toEqual([rel]);
  });

  it("fails when the template name is taken (create_page semantics)", async () => {
    const { fs } = makeFakeFs({ "Page.md": "x", "templates/T.md": "y" });
    await expect(saveAsTemplate(ROOT, "Page.md", "T", fs)).rejects.toThrow(/exists/);
  });
});
