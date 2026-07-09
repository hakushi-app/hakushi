// Track X — Docx export tests (INTERFACES.md §6.1).
//
// mdast2docx's core (`toDocx` from @m2d/core) is isomorphic — it runs in
// node as well as the browser (only the image/html/mermaid plugins need a
// DOM, and docx.ts does not load those). So the ZIP-magic assertion runs
// unconditionally here.

import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../markdown";
import { mdastToDocx } from "./docx";

describe("mdastToDocx", () => {
  it("returns .docx bytes (ZIP container, PK magic)", async () => {
    const tree = parseMarkdown(
      "# Title\n\nA paragraph with **bold** text.\n\n- item 1\n- item 2\n",
    );

    const bytes = await mdastToDocx(tree, { title: "Test" });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(200);
    // ZIP local file header magic: "PK\x03\x04".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it("tolerates GFM tables and leftover directives", async () => {
    const tree = parseMarkdown(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n::due[2026-07-31]\n",
    );

    const bytes = await mdastToDocx(tree);

    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});
