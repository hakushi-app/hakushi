// Track X — resolveEmbedsInTree unit tests (INTERFACES.md §6.1).
// Pure: fake EmbedSource over an in-memory page map, no Tauri, no DOM.

import { describe, expect, it } from "vitest";

import type { Paragraph, Root } from "mdast";

import { parseMarkdown, stringifyMarkdown } from "../markdown";
import {
  cycleText,
  NO_CHILDREN_TEXT,
  resolveEmbedsInTree,
  unresolvedText,
  type EmbedSource,
  type ResolvedRef,
} from "./resolve-embeds";

// ---------------------------------------------------------------------------
// Fake EmbedSource
// ---------------------------------------------------------------------------

interface FakeWorkspace {
  /** relPath → body markdown (frontmatter-free). */
  pages: Record<string, string>;
  /** relPath (folder note) → children. */
  children?: Record<string, ResolvedRef[]>;
}

function fakeSource(ws: FakeWorkspace): EmbedSource {
  const resolveRelPath = (target: string): string | null => {
    for (const cand of [target, `${target}.md`, `${target}/index.md`]) {
      if (cand in ws.pages) return cand;
    }
    return null;
  };
  return {
    async resolve(target) {
      const relPath = resolveRelPath(target);
      return relPath === null ? null : { relPath, title: null };
    },
    async readBody(relPath) {
      const body = ws.pages[relPath];
      if (body === undefined) throw new Error(`no page: ${relPath}`);
      return body;
    },
    async listChildren(relPath) {
      return ws.children?.[relPath] ?? [];
    },
  };
}

function firstParagraphText(tree: Root, index = 0): string {
  const node = tree.children[index] as Paragraph;
  expect(node.type).toBe("paragraph");
  return node.children.map((c) => (c.type === "text" ? c.value : "")).join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveEmbedsInTree", () => {
  it("splices the target page body in place of an inline embed", async () => {
    const src = fakeSource({
      pages: { "B.md": "First from B.\n\nSecond from B.\n" },
    });
    const tree = parseMarkdown('Before.\n\n::embed{page="B.md"}\n\nAfter.\n');

    const out = await resolveEmbedsInTree(tree, src);

    expect(out.children).toHaveLength(4);
    expect(firstParagraphText(out, 0)).toBe("Before.");
    expect(firstParagraphText(out, 1)).toBe("First from B.");
    expect(firstParagraphText(out, 2)).toBe("Second from B.");
    expect(firstParagraphText(out, 3)).toBe("After.");
    // No directive nodes survive resolution.
    expect(stringifyMarkdown(out)).not.toContain("::embed");
  });

  it("treats preview mode like inline (body spliced)", async () => {
    const src = fakeSource({ pages: { "B.md": "# B heading\n" } });
    const tree = parseMarkdown('::embed{page="B.md" mode="preview"}\n');

    const out = await resolveEmbedsInTree(tree, src);

    expect(out.children[0]).toMatchObject({ type: "heading", depth: 1 });
  });

  it("resolves nested embeds and cuts off at maxDepth with a cycle paragraph", async () => {
    const src = fakeSource({
      pages: {
        "B.md": 'From B.\n\n::embed{page="C.md"}\n',
        "C.md": 'From C.\n\n::embed{page="D.md"}\n',
        "D.md": "From D.\n",
      },
    });
    const tree = parseMarkdown('::embed{page="B.md"}\n');

    // chain = [A.md] → B (depth 2) and C (depth 3) resolve; C's embed of D
    // would exceed maxDepth 3 → 循環参照 placeholder.
    const out = await resolveEmbedsInTree(tree, src, { chain: ["A.md"] });
    const md = stringifyMarkdown(out);

    expect(md).toContain("From B.");
    expect(md).toContain("From C.");
    expect(md).not.toContain("From D.");
    expect(md).toContain(cycleText("D.md"));
  });

  it("honors a custom maxDepth", async () => {
    const src = fakeSource({
      pages: { "B.md": 'From B.\n\n::embed{page="C.md"}\n', "C.md": "From C.\n" },
    });
    const tree = parseMarkdown('::embed{page="B.md"}\n');

    const out = await resolveEmbedsInTree(tree, src, { chain: ["A.md"], maxDepth: 2 });
    const md = stringifyMarkdown(out);

    expect(md).toContain("From B.");
    expect(md).not.toContain("From C.");
    expect(md).toContain(cycleText("C.md"));
  });

  it("guards direct cycles (A embeds B embeds A)", async () => {
    const src = fakeSource({
      pages: {
        "A.md": '::embed{page="B.md"}\n',
        "B.md": 'From B.\n\n::embed{page="A.md"}\n',
      },
    });
    const tree = parseMarkdown('::embed{page="B.md"}\n');

    const out = await resolveEmbedsInTree(tree, src, { chain: ["A.md"] });
    const md = stringifyMarkdown(out);

    expect(md).toContain("From B.");
    expect(md).toContain(cycleText("A.md"));
  });

  it("guards self-embeds via the chain", async () => {
    const src = fakeSource({ pages: { "A.md": '::embed{page="A.md"}\n' } });
    const tree = parseMarkdown('::embed{page="A.md"}\n');

    const out = await resolveEmbedsInTree(tree, src, { chain: ["A.md"] });

    expect(firstParagraphText(out)).toBe(cycleText("A.md"));
  });

  it("renders folder mode as a list of links to child pages", async () => {
    const src = fakeSource({
      pages: { "Projects/index.md": "ignored" },
      children: {
        "Projects/index.md": [
          { relPath: "Projects/Roadmap.md", title: "Roadmap" },
          { relPath: "Projects/Tasks.md", title: null },
        ],
      },
    });
    const tree = parseMarkdown('::embed{page="Projects/index.md" mode="folder"}\n');

    const out = await resolveEmbedsInTree(tree, src);

    expect(out.children[0].type).toBe("list");
    const md = stringifyMarkdown(out);
    expect(md).toContain("[Roadmap](Projects/Roadmap.md)");
    // Title fallback = page name from rel path.
    expect(md).toContain("[Tasks](Projects/Tasks.md)");
  });

  it("renders an empty folder as a placeholder paragraph", async () => {
    const src = fakeSource({ pages: { "Empty/index.md": "x" }, children: {} });
    const tree = parseMarkdown('::embed{page="Empty/index.md" mode="folder"}\n');

    const out = await resolveEmbedsInTree(tree, src);

    expect(firstParagraphText(out)).toBe(NO_CHILDREN_TEXT);
  });

  it("replaces unresolved targets with a placeholder paragraph", async () => {
    const src = fakeSource({ pages: {} });
    const tree = parseMarkdown('::embed{page="Nope.md"}\n');

    const out = await resolveEmbedsInTree(tree, src);

    expect(firstParagraphText(out)).toBe(unresolvedText("Nope.md"));
  });

  it("resolves container-directive embeds and embeds nested in blockquotes", async () => {
    const src = fakeSource({ pages: { "B.md": "From B.\n" } });
    const tree = parseMarkdown(
      ':::embed{page="B.md"}\nLabel text\n:::\n\n> quoted\n>\n> ::embed{page="B.md"}\n',
    );

    const out = await resolveEmbedsInTree(tree, src);
    const md = stringifyMarkdown(out);

    expect(md).not.toContain("embed");
    expect((md.match(/From B\./g) ?? []).length).toBe(2);
  });

  it("does not mutate the input tree", async () => {
    const src = fakeSource({ pages: { "B.md": "From B.\n" } });
    const tree = parseMarkdown('::embed{page="B.md"}\n');
    const before = JSON.stringify(tree);

    await resolveEmbedsInTree(tree, src);

    expect(JSON.stringify(tree)).toBe(before);
  });
});
