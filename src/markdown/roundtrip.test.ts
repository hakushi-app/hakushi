// M0 idempotency harness (docs/DESIGN.md M0 gate, INTERFACES.md §3/§5).
//
// Every fixture must be idempotent under normalizeMarkdown. Fixtures authored
// in canonical form must additionally round-trip byte-exactly — the canonical
// serializer defines that form; fixtures follow it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  joinFrontmatter,
  newPageMarkdown,
  normalizeMarkdown,
  parseMarkdown,
  readFrontmatter,
  splitFrontmatter,
  stringifyMarkdown,
} from "./pipeline";

const FIXTURE_DIR = fileURLToPath(new URL("__fixtures__/", import.meta.url));
const fixtureNames = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

/**
 * Intentionally non-canonical fixtures (tolerant input). They are still in
 * the idempotency gate, but are excluded from the byte-exact check:
 * - autolink.md: contains a GFM literal autolink; canonical form is `<url>`.
 * - calendar.md / kanban.md: kept exactly as shown in docs/DESIGN.md; the
 *   canonical serializer re-pads the table and inserts blank lines between
 *   blocks.
 * - wikilink.md: `![[wikilink]]` input; canonical form is `::embed{…}`.
 */
const NON_CANONICAL = new Set(["autolink.md", "calendar.md", "kanban.md", "wikilink.md"]);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("fixture corpus", () => {
  it("covers the expected corpus", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(20);
    for (const required of NON_CANONICAL) {
      expect(fixtureNames).toContain(required);
    }
  });

  describe.each(fixtureNames)("%s", (name) => {
    it("normalizeMarkdown is idempotent", () => {
      const once = normalizeMarkdown(fixture(name));
      expect(normalizeMarkdown(once)).toBe(once);
    });

    it("ends with exactly one trailing newline", () => {
      expect(normalizeMarkdown(fixture(name))).toMatch(/[^\n]\n$/);
    });

    it("splitFrontmatter/joinFrontmatter round-trips byte-exactly", () => {
      const input = fixture(name);
      const { frontmatter, body } = splitFrontmatter(input);
      expect(joinFrontmatter(frontmatter, body)).toBe(input);
    });

    if (!NON_CANONICAL.has(name)) {
      it("is canonical: normalizeMarkdown(x) === x", () => {
        const input = fixture(name);
        expect(normalizeMarkdown(input)).toBe(input);
      });
    }
  });
});

describe("wikilink tolerant input (remark-hakushi-embed)", () => {
  it("converts every wikilink to an embed directive", () => {
    const output = normalizeMarkdown(fixture("wikilink.md"));
    expect(output).not.toContain("![[");
    expect(output).toContain('::embed{page="Roadmap"}');
    expect(output).toContain('::embed{page="Notes"}');
    expect(output).toContain('::embed[custom label]{page="01J8ZZZZZZZZZZZZZZZZZZZZZZ"}');
    expect(output).toContain('::embed{page="PageA"}');
    expect(output).toContain('::embed[B]{page="PageB"}');
  });

  it("produces leafDirective nodes with page attribute and label children", () => {
    const tree = parseMarkdown("![[Roadmap|The Plan]]\n");
    expect(tree.children).toHaveLength(1);
    const directive = tree.children[0] as unknown as {
      type: string;
      name: string;
      attributes: Record<string, string>;
      children: Array<{ type: string; value: string }>;
    };
    expect(directive.type).toBe("leafDirective");
    expect(directive.name).toBe("embed");
    expect(directive.attributes).toEqual({ page: "Roadmap" });
    expect(directive.children).toEqual([{ type: "text", value: "The Plan" }]);
  });

  it("omits label children when no label is given", () => {
    const tree = parseMarkdown("![[Roadmap]]\n");
    const directive = tree.children[0] as unknown as { type: string; children: unknown[] };
    expect(directive.type).toBe("leafDirective");
    expect(directive.children).toEqual([]);
  });

  it("splits longer text around inline occurrences", () => {
    const output = normalizeMarkdown("before ![[X]] after\n");
    expect(output).toBe("before\n\n::embed{page=\"X\"}\n\nafter\n");
    expect(normalizeMarkdown(output)).toBe(output);
  });
});

describe("idempotency in tricky contexts", () => {
  const inputs = [
    // Wikilinks where a flow directive cannot live stay literal (escaped) text.
    "# Heading with ![[X]] inside\n",
    "*emph ![[X]] inside*\n",
    "| a | b |\n| - | - |\n| ![[X]] | y |\n",
    "text ![[]] empty target\n",
    // Wikilinks in nested flow containers are hoisted next to their paragraph.
    "- item with ![[X]] link\n",
    "- item with label ![[X|lab]] link\n",
    "> quoted ![[X|lab]] text\n",
    "1. ordered with ![[X|two words]] mid\n",
    "![[X]]![[Y]]\n",
    // Loose input whitespace.
    "line one\r\nline two\r\n",
    "trailing blank lines\n\n\n\n",
    "#  extra   spaces\tin heading\n",
  ];

  it.each(inputs)("normalizeMarkdown is idempotent for %j", (input) => {
    const once = normalizeMarkdown(input);
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("hoists list-item wikilinks as flow embeds inside the item", () => {
    expect(normalizeMarkdown("- item with ![[X]] link\n")).toBe(
      '- item with\n  ::embed{page="X"}\n  link\n',
    );
  });

  it("leaves heading wikilinks as literal text (no flow position)", () => {
    const output = normalizeMarkdown("# Heading with ![[X]] inside\n");
    expect(output).not.toContain("::embed");
    expect(normalizeMarkdown(output)).toBe(output);
  });
});

describe("frontmatter helpers", () => {
  it("readFrontmatter parses PageMeta from a fixture", () => {
    const meta = readFrontmatter(fixture("frontmatter.md"));
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe("01J8ZZZZZZZZZZZZZZZZZZZZZZ");
    expect(meta?.title).toBe("Frontmatter fixture");
    expect(meta?.template).toBe("note");
    expect(String(meta?.created)).toBe("2026-07-04");
  });

  it("readFrontmatter handles template config maps (kanban)", () => {
    const meta = readFrontmatter(fixture("kanban.md"));
    expect(meta?.template).toBe("kanban");
    expect(meta?.kanban).toEqual({ columns: ["Backlog", "In Progress", "Done"] });
  });

  it("returns null / passthrough when there is no frontmatter", () => {
    const input = fixture("headings-paragraphs.md");
    expect(readFrontmatter(input)).toBeNull();
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter).toBeNull();
    expect(body).toBe(input);
    expect(joinFrontmatter(null, input)).toBe(input);
  });

  it("splitFrontmatter keeps the raw block including fences", () => {
    const { frontmatter, body } = splitFrontmatter(fixture("frontmatter.md"));
    expect(frontmatter).toMatch(/^---\n/);
    expect(frontmatter).toMatch(/\n---\n$/);
    expect(frontmatter).toContain("id: 01J8ZZZZZZZZZZZZZZZZZZZZZZ");
    expect(body.startsWith("\n# Frontmatter fixture")).toBe(true);
  });

  it("does not treat a thematic break as frontmatter", () => {
    const input = "body first\n\n---\n\nafter\n";
    expect(splitFrontmatter(input)).toEqual({ frontmatter: null, body: input });
  });
});

describe("newPageMarkdown", () => {
  it("emits stable key order with a ulid id and ISO created date", () => {
    const md = newPageMarkdown("Test Page");
    expect(md).toMatch(
      /^---\nid: [0-9A-HJKMNP-TV-Z]{26}\ntitle: Test Page\ncreated: \d{4}-\d{2}-\d{2}\n---\n$/,
    );
  });

  it("is canonical and idempotent", () => {
    const md = newPageMarkdown("Test Page");
    expect(normalizeMarkdown(md)).toBe(md);
    expect(normalizeMarkdown(normalizeMarkdown(md))).toBe(normalizeMarkdown(md));
  });

  it("stays canonical for titles that need YAML quoting", () => {
    const md = newPageMarkdown('Notes: "2026" #plans');
    expect(normalizeMarkdown(md)).toBe(md);
    expect(readFrontmatter(md)?.title).toBe('Notes: "2026" #plans');
  });

  it("round-trips through readFrontmatter", () => {
    const meta = readFrontmatter(newPageMarkdown("日本語タイトル"));
    expect(meta?.title).toBe("日本語タイトル");
    expect(meta?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(meta?.template).toBeUndefined();
    expect(meta?.updated).toBeUndefined();
  });

  it("issues a fresh id per page", () => {
    expect(readFrontmatter(newPageMarkdown("A"))?.id).not.toBe(
      readFrontmatter(newPageMarkdown("A"))?.id,
    );
  });
});

describe("stringifyMarkdown", () => {
  it("always ends with exactly one newline", () => {
    expect(stringifyMarkdown(parseMarkdown("hello"))).toBe("hello\n");
    expect(stringifyMarkdown(parseMarkdown("hello\n\n\n"))).toBe("hello\n");
    expect(stringifyMarkdown({ type: "root", children: [] })).toBe("\n");
  });

  it("parse → stringify equals normalizeMarkdown", () => {
    const input = fixture("kanban.md");
    expect(stringifyMarkdown(parseMarkdown(input))).toBe(normalizeMarkdown(input));
  });
});
