// Track X — standalone HTML export tests (INTERFACES.md §6.1).

import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../markdown";
import { mdastToHtmlDocument } from "./html";

const FIXTURE_MD = `---
id: 01JAR000000000000000000009
title: Fixture
---

# Heading

Some *emphasis* and ~~strikethrough~~.

| col A | col B |
|-------|-------|
| 1     | 2     |

- [x] done task
- [ ] open task
`;

describe("mdastToHtmlDocument", () => {
  it("produces a self-contained document with doctype, title, CSS and GFM markup", () => {
    const html = mdastToHtmlDocument(parseMarkdown(FIXTURE_MD), { title: "Fixture" });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Fixture</title>");
    expect(html).toContain("<style>");
    // Frontmatter never leaks into the output.
    expect(html).not.toContain("01JAR000000000000000000009");
    // GFM: table + strikethrough + task list checkboxes.
    expect(html).toContain("<table>");
    expect(html).toContain("<th>col A</th>");
    expect(html).toContain("<del>strikethrough</del>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    // No external asset references (self-contained contract).
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });

  it("escapes the title and omits the auto-print script by default", () => {
    const html = mdastToHtmlDocument(parseMarkdown("hello\n"), {
      title: '<b>"T&T"</b>',
    });

    expect(html).toContain("<title>&lt;b&gt;&quot;T&amp;T&quot;&lt;/b&gt;</title>");
    expect(html).not.toContain("window.print");
  });

  it("appends the auto-print script when autoPrint is set (PDF flow)", () => {
    const html = mdastToHtmlDocument(parseMarkdown("hello\n"), {
      title: "P",
      autoPrint: true,
    });

    expect(html).toContain("window.print()");
  });

  it("renders leftover non-embed directives as inert labelled blocks", () => {
    const html = mdastToHtmlDocument(parseMarkdown("::note[keep me]\n"), {
      title: "D",
    });

    expect(html).toContain('class="directive directive-note"');
    expect(html).toContain("keep me");
  });
});
