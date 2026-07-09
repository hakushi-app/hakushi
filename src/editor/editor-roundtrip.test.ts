// @vitest-environment jsdom
//
// Track C — editor fidelity corpus (INTERFACES.md §4/§5, DESIGN M0 gate):
//
//   normalize(editorMarkdownOut(editorMarkdownIn(body))) === normalize(body)
//
// i.e. parse → toTiptap → toMdast(stringify) — routed through the canonical
// remark pipeline — must equal parse → stringify for every fixture in
// src/markdown/__fixtures__/ (frontmatter stripped first: the WYSIWYG editor
// never sees frontmatter, rule 2).

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { normalizeMarkdown, splitFrontmatter } from "../markdown";
import { createEditorExtensions } from "./extensions";

// Under the jsdom environment `import.meta.url` is an http URL, so resolve
// the fixtures from the vitest root (the repo root) instead.
const FIXTURE_DIR = resolve(process.cwd(), "src/markdown/__fixtures__");

// Constructs the TipTap markdown parser cannot round-trip yet. Keep this list
// SHORT and explicit; every entry needs a reason and a milestone to fix it.
const EXCLUSIONS: Record<string, string> = {
  // TipTap's schema-aware HTML parsing has no nodes for raw HTML blocks
  // (<div>…</div>) or inline elements (<kbd>), so the markup is reduced to
  // its text content instead of being passed through verbatim like mdast
  // `html` nodes are. TODO(M2): add an html-passthrough preservation node.
  "html-passthrough.md": "raw HTML blocks / inline HTML are not preserved by the TipTap markdown parser yet",
};

/** body-only markdown → TipTap doc → TipTap markdown serializer output. */
function editorRoundtrip(body: string): string {
  const editor = new Editor({
    element: null,
    extensions: createEditorExtensions(),
    content: body,
    contentType: "markdown",
  });
  try {
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("editor round-trip fidelity (fixture corpus)", () => {
  it("has fixtures to test", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    const exclusionReason = EXCLUSIONS[name];
    const testFn = exclusionReason === undefined ? it : it.skip;
    testFn(`${name}${exclusionReason ? ` (excluded: ${exclusionReason})` : ""}`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
      const { body } = splitFrontmatter(raw);
      const viaEditor = normalizeMarkdown(editorRoundtrip(body));
      const canonical = normalizeMarkdown(body);
      expect(viaEditor).toBe(canonical);
    });
  }
});

describe("embed directive byte stability through the editor", () => {
  it("keeps leaf and container embed directives byte-identical", () => {
    const canonical = normalizeMarkdown(
      [
        '::embed{page="Roadmap"}',
        "",
        '::embed[Label text]{page="01J8ZZZZZZZZZZZZZZZZZZZZZZ" mode="preview"}',
        "",
        ':::embed{page="Roadmap" mode="folder"}',
        ":::",
        "",
        ':::embed{page="Notes"}',
        "Fallback content shown while the page loads.",
        ":::",
        "",
      ].join("\n"),
    );
    expect(normalizeMarkdown(editorRoundtrip(canonical))).toBe(canonical);
  });

  it("keeps inline directives (:due[…], :prio[…]) byte-identical", () => {
    const canonical = normalizeMarkdown("- [ ] Ship M1 :due[2026-08-01] :prio[high]\n");
    expect(normalizeMarkdown(editorRoundtrip(canonical))).toBe(canonical);
  });
});
