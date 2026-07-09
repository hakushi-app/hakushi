// M2 pipeline additions (INTERFACES.md §5.4): extractRefs / isFolderPage /
// rewriteRefs / renderPreviewHtml.

import { describe, expect, it } from "vitest";

import {
  extractRefs,
  isFolderPage,
  normalizeMarkdown,
  parseMarkdown,
  renderPreviewHtml,
  rewriteRefs,
  stringifyMarkdown,
} from "./index";

// ---------------------------------------------------------------------------
// extractRefs
// ---------------------------------------------------------------------------

describe("extractRefs", () => {
  const doc = [
    "---",
    "id: 01J8DOC",
    "---",
    "",
    "# Refs",
    "",
    "A [note](./Notes.md), an [external](https://example.com/page.md) link,",
    "a [mail](mailto:someone@example.com) link, an [anchor](#section),",
    "an [asset](./diagram.png), and a [fragment link](Sub/Page.md#heading).",
    "",
    "- list item with [nested](../Up.md)",
    "",
    "> blockquote with [quoted](Quoted.md)",
    "",
    "| a | b |",
    "| - | - |",
    "| [cell](Cell.md) | x |",
    "",
    "Reference style: [ref][r1]",
    "",
    "[r1]: Referenced.md",
    "",
    '::embed{page="01J8TARGET"}',
    "",
    '::embed[Label]{page="Other.md" mode="preview"}',
    "",
    ':::embed{page="Folder/index.md" mode="folder"}',
    ":::",
    "",
  ].join("\n");

  it("collects relative .md links, walking lists/blockquotes/tables", () => {
    const refs = extractRefs(parseMarkdown(doc));
    expect(refs.links.map((l) => l.target)).toEqual([
      "./Notes.md",
      "Sub/Page.md#heading",
      "../Up.md",
      "Quoted.md",
      "Cell.md",
      "Referenced.md", // linkReference target via its definition
    ]);
  });

  it("excludes external URLs, anchors, and non-.md targets", () => {
    const refs = extractRefs(parseMarkdown(doc));
    const targets = refs.links.map((l) => l.target);
    expect(targets).not.toContain("https://example.com/page.md");
    expect(targets).not.toContain("mailto:someone@example.com");
    expect(targets).not.toContain("#section");
    expect(targets).not.toContain("./diagram.png");
  });

  it("collects embeds (leaf + container) with mode defaulting to inline", () => {
    const refs = extractRefs(parseMarkdown(doc));
    expect(refs.embeds).toEqual([
      { target: "01J8TARGET", mode: "inline" },
      { target: "Other.md", mode: "preview" },
      { target: "Folder/index.md", mode: "folder" },
    ]);
  });

  it("attaches positions to links", () => {
    const refs = extractRefs(parseMarkdown("[a](A.md)\n"));
    expect(refs.links).toHaveLength(1);
    expect(refs.links[0].position).toBeDefined();
  });

  it("excludes absolute and protocol-relative targets", () => {
    const refs = extractRefs(
      parseMarkdown("[abs](/root/A.md) and [proto](//host/B.md)\n"),
    );
    expect(refs.links).toEqual([]);
  });

  it("returns empty refs for a plain document", () => {
    expect(extractRefs(parseMarkdown("# Just a heading\n\nText.\n"))).toEqual({
      links: [],
      embeds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// isFolderPage
// ---------------------------------------------------------------------------

describe("isFolderPage", () => {
  it("true: frontmatter + only embed directives (leaf and container)", () => {
    const md = [
      "---",
      "id: 01J8FOLDER",
      "---",
      "",
      '::embed{page="A.md"}',
      "",
      ':::embed{page="B" mode="folder"}',
      ":::",
      "",
    ].join("\n");
    expect(isFolderPage(parseMarkdown(md))).toBe(true);
  });

  it("true: single embed without frontmatter", () => {
    expect(isFolderPage(parseMarkdown('::embed{page="A.md"}\n'))).toBe(true);
  });

  it("false: embed plus other content", () => {
    const md = '::embed{page="A.md"}\n\nSome prose.\n';
    expect(isFolderPage(parseMarkdown(md))).toBe(false);
  });

  it("false: embed plus heading", () => {
    const md = '# Title\n\n::embed{page="A.md"}\n';
    expect(isFolderPage(parseMarkdown(md))).toBe(false);
  });

  it("false: empty document", () => {
    expect(isFolderPage(parseMarkdown(""))).toBe(false);
  });

  it("false: frontmatter only", () => {
    expect(isFolderPage(parseMarkdown("---\nid: 01J8X\n---\n"))).toBe(false);
  });

  it("false: non-embed directive only", () => {
    expect(isFolderPage(parseMarkdown("::toc\n"))).toBe(false);
  });

  it("whitespace-only paragraphs do not disqualify", () => {
    const tree = parseMarkdown('::embed{page="A.md"}\n');
    // Simulate a parser yielding an empty paragraph.
    tree.children.push({
      type: "paragraph",
      children: [{ type: "text", value: "  " }],
    });
    expect(isFolderPage(tree)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rewriteRefs
// ---------------------------------------------------------------------------

describe("rewriteRefs", () => {
  const doc = [
    "[a](./Notes.md) and [ext](https://example.com/x.md) and [ref][r1]",
    "",
    "[r1]: Referenced.md",
    "",
    '::embed{page="01J8TARGET"}',
    "",
    '::embed{page="Other.md" mode="preview"}',
    "",
  ].join("\n");

  it("rewrites link, definition, and embed targets; reports changed", () => {
    const input = parseMarkdown(doc);
    const map: Record<string, string> = {
      "./Notes.md": "./Moved.md",
      "Referenced.md": "Moved/Referenced.md",
      "Other.md": "Elsewhere.md",
    };
    const { tree, changed } = rewriteRefs(input, (target) => map[target] ?? null);
    expect(changed).toBe(true);
    const out = stringifyMarkdown(tree);
    expect(out).toContain("(./Moved.md)");
    expect(out).toContain("[r1]: Moved/Referenced.md");
    expect(out).toContain('page="Elsewhere.md"');
    // null return keeps the target untouched.
    expect(out).toContain('page="01J8TARGET"');
    // Non-matching (external) targets untouched.
    expect(out).toContain("https://example.com/x.md");
  });

  it("passes the right (target, kind) pairs — externals never offered", () => {
    const calls: [string, string][] = [];
    rewriteRefs(parseMarkdown(doc), (target, kind) => {
      calls.push([target, kind]);
      return null;
    });
    expect(calls).toEqual([
      ["./Notes.md", "link"],
      ["Referenced.md", "link"],
      ["01J8TARGET", "embed"],
      ["Other.md", "embed"],
    ]);
  });

  it("does not mutate the input tree", () => {
    const input = parseMarkdown(doc);
    const before = JSON.stringify(input);
    const { tree } = rewriteRefs(input, () => "REWRITTEN.md");
    expect(JSON.stringify(input)).toBe(before);
    expect(tree).not.toBe(input);
    expect(stringifyMarkdown(input)).not.toContain("REWRITTEN.md");
  });

  it("changed=false when every rewrite returns null", () => {
    const input = parseMarkdown(doc);
    const { tree, changed } = rewriteRefs(input, () => null);
    expect(changed).toBe(false);
    expect(stringifyMarkdown(tree)).toBe(stringifyMarkdown(input));
  });

  it("changed=false when rewrite returns the identical target", () => {
    const { changed } = rewriteRefs(parseMarkdown(doc), (target) => target);
    expect(changed).toBe(false);
  });

  it("rewritten output stays idempotent under normalizeMarkdown", () => {
    const { tree } = rewriteRefs(parseMarkdown(doc), (target) =>
      target === "./Notes.md" ? "./Moved.md" : null,
    );
    const once = normalizeMarkdown(stringifyMarkdown(tree));
    expect(normalizeMarkdown(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// renderPreviewHtml
// ---------------------------------------------------------------------------

describe("renderPreviewHtml", () => {
  it("renders headings and paragraphs", () => {
    const html = renderPreviewHtml("# Title\n\nBody text.\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Body text.</p>");
  });

  it("renders GFM tables", () => {
    const html = renderPreviewHtml("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM task lists as checkboxes", () => {
    const html = renderPreviewHtml("- [x] done\n- [ ] todo\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("done");
    expect(html).toContain("todo");
  });

  it("renders leaf embed directives as placeholder divs", () => {
    const html = renderPreviewHtml('::embed{page="Roadmap.md"}\n');
    expect(html).toContain('class="embed-ref"');
    expect(html).toContain('data-page="Roadmap.md"');
    expect(html).toContain('data-mode="inline"');
    expect(html).toContain(">Roadmap.md</div>");
  });

  it("uses the embed label when present", () => {
    const html = renderPreviewHtml('::embed[My label]{page="Roadmap.md"}\n');
    expect(html).toContain('data-page="Roadmap.md"');
    expect(html).toContain(">My label</div>");
  });

  it("renders container embed directives as placeholder divs", () => {
    const html = renderPreviewHtml(
      ':::embed{page="Folder/index.md" mode="folder"}\n:::\n',
    );
    expect(html).toContain('class="embed-ref"');
    expect(html).toContain('data-page="Folder/index.md"');
    expect(html).toContain('data-mode="folder"');
  });

  it("accepts wikilink input (tolerant) and renders an embed placeholder", () => {
    const html = renderPreviewHtml("![[Target]]\n");
    expect(html).toContain('class="embed-ref"');
    expect(html).toContain('data-page="Target"');
  });

  it("strips frontmatter", () => {
    const html = renderPreviewHtml("---\nid: 01J8SECRET\n---\n\n# Visible\n");
    expect(html).not.toContain("01J8SECRET");
    expect(html).toContain("<h1>Visible</h1>");
  });

  it("drops raw HTML from the source", () => {
    const html = renderPreviewHtml('<script>alert("x")</script>\n\nSafe.\n');
    expect(html).not.toContain("<script>");
    expect(html).toContain("Safe.");
  });
});
