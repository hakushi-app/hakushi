// @vitest-environment jsdom
//
// Track C — slash-command palette: trigger detection + command runners.
// Uses a headless TipTap editor (element: null), the same technique as
// editor-roundtrip.test.ts, and asserts on canonical markdown so the commands
// are guaranteed to produce Markdown-native output (CLAUDE.md iron rules).

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { normalizeMarkdown } from "../markdown";
import { createEditorExtensions } from "./extensions";
import {
  COMMANDS,
  filterCommands,
  getSlashContext,
  isInTable,
  paletteFor,
} from "./slash-commands";

function makeEditor(content = ""): Editor {
  return new Editor({
    element: null as unknown as HTMLElement,
    extensions: createEditorExtensions(),
    content,
    contentType: "markdown",
  });
}

/** Type `pre + typed` into a fresh doc, detect the slash trigger, run `cmdId`. */
function applySlash(pre: string, typed: string, cmdId: string, value?: string): string {
  const editor = makeEditor();
  try {
    editor.commands.insertContent(pre + typed);
    const ctx = getSlashContext(editor.state);
    if (ctx === null) throw new Error(`no slash context for ${JSON.stringify(pre + typed)}`);
    const cmd = COMMANDS.find((c) => c.id === cmdId);
    if (cmd === undefined) throw new Error(`unknown command: ${cmdId}`);
    cmd.run({ editor, range: { from: ctx.from, to: ctx.to } }, value);
    // normalizeMarkdown keeps the canonical trailing newline; drop it so block
    // assertions read cleanly (the roundtrip corpus covers the newline itself).
    return normalizeMarkdown(editor.getMarkdown()).trimEnd();
  } finally {
    editor.destroy();
  }
}

describe("getSlashContext (trigger detection)", () => {
  it("detects a slash at the start of a block", () => {
    const editor = makeEditor();
    editor.commands.insertContent("/head");
    const ctx = getSlashContext(editor.state);
    expect(ctx?.query).toBe("head");
    editor.destroy();
  });

  it("detects a slash after whitespace and captures the query", () => {
    const editor = makeEditor();
    editor.commands.insertContent("Hello /quo");
    const ctx = getSlashContext(editor.state);
    expect(ctx?.query).toBe("quo");
    editor.destroy();
  });

  it("does not trigger for a slash inside a word (path-like a/b)", () => {
    const editor = makeEditor();
    editor.commands.insertContent("a/b");
    expect(getSlashContext(editor.state)).toBeNull();
    editor.destroy();
  });

  it("does not trigger inside a code block (slash is literal)", () => {
    const editor = makeEditor();
    editor.chain().setCodeBlock().insertContent("/h1").run();
    expect(getSlashContext(editor.state)).toBeNull();
    editor.destroy();
  });

  it("closes once a space follows the query", () => {
    const editor = makeEditor();
    editor.commands.insertContent("/h1 ");
    expect(getSlashContext(editor.state)).toBeNull();
    editor.destroy();
  });
});

describe("command runners produce Markdown-native output", () => {
  it("Text → paragraph", () => {
    expect(applySlash("Hello ", "/x", "text")).toBe("Hello");
  });

  it("Heading 1/2/3", () => {
    expect(applySlash("Hello ", "/x", "heading1")).toBe("# Hello");
    expect(applySlash("Hello ", "/x", "heading2")).toBe("## Hello");
    expect(applySlash("Hello ", "/x", "heading3")).toBe("### Hello");
  });

  it("Bulleted list", () => {
    expect(applySlash("Item ", "/x", "bulletList")).toBe("- Item");
  });

  it("Numbered list", () => {
    expect(applySlash("Item ", "/x", "orderedList")).toBe("1. Item");
  });

  it("To-do list", () => {
    expect(applySlash("Task ", "/x", "taskList")).toContain("[ ] Task");
  });

  it("Quote", () => {
    expect(applySlash("Quote ", "/x", "blockquote")).toBe("> Quote");
  });

  it("Code block", () => {
    const out = applySlash("code ", "/x", "codeBlock");
    expect(out).toContain("```");
    expect(out).toContain("code");
  });

  it("Table (GFM)", () => {
    const out = applySlash("", "/x", "table");
    expect(out).toContain("|");
    // 3-column header separator row.
    expect(out).toMatch(/\|[\s-]*\|[\s-]*\|/);
  });

  it("Divider (thematic break)", () => {
    const out = applySlash("Above ", "/x", "divider");
    expect(out).toContain("---");
    expect(out).toContain("Above");
  });

  it("Image (with URL value)", () => {
    const out = applySlash("", "/x", "image", "https://example.com/a.png");
    expect(out).toContain("![](https://example.com/a.png)");
  });

  it("Page embed (with page value) → ::embed directive", () => {
    const out = applySlash("", "/x", "embed", "Roadmap");
    expect(out).toContain('::embed{page="Roadmap"}');
  });

  it("Image encodes spaces so a local path round-trips (no literal-text demotion)", () => {
    const out = applySlash("", "/x", "image", "./assets/my file.png");
    expect(out).toContain("![](./assets/my%20file.png)");
    // Survives a second normalize pass still as an image (idempotent).
    expect(normalizeMarkdown(out + "\n")).toContain("my%20file.png");
  });

  it("input commands insert nothing for an empty value", () => {
    // The block stays untouched (the trigger text remains for the user to edit).
    expect(applySlash("", "/x", "image", "   ")).not.toContain("![");
    expect(applySlash("", "/x", "embed", "")).not.toContain("::embed");
  });
});

describe("table context (palette swap + table operations)", () => {
  const TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";

  /** Put the caret inside the first header cell ("A"). */
  function selectFirstCell(editor: Editor): void {
    let pos: number | null = null;
    editor.state.doc.descendants((node, p) => {
      if (pos === null && node.isText && node.text === "A") pos = p;
    });
    if (pos === null) throw new Error("table cell text not found");
    editor.commands.setTextSelection(pos + 1);
  }

  it("isInTable detects a caret inside a cell", () => {
    const editor = makeEditor(TABLE_MD);
    selectFirstCell(editor);
    expect(isInTable(editor.state)).toBe(true);
    const plain = makeEditor("hello");
    expect(isInTable(plain.state)).toBe(false);
    editor.destroy();
    plain.destroy();
  });

  it("paletteFor swaps to table ops inside a table, block palette outside", () => {
    const inTable = paletteFor(true).map((c) => c.id);
    const outside = paletteFor(false).map((c) => c.id);
    // Structural block commands must NOT be reachable inside a cell (they would
    // leave literal Markdown syntax in the cell).
    expect(inTable).toContain("rowAfter");
    expect(inTable).toContain("colAfter");
    expect(inTable).not.toContain("heading1");
    expect(inTable).not.toContain("bulletList");
    expect(outside).toContain("heading1");
    expect(outside).not.toContain("rowAfter");
  });

  it("filterCommands respects the active palette", () => {
    const ids = filterCommands("行", paletteFor(true)).map((c) => c.id);
    expect(ids).toContain("rowAfter");
    expect(ids).not.toContain("heading1");
  });

  it("addRowAfter inserts a row and keeps valid GFM", () => {
    const editor = makeEditor(TABLE_MD);
    selectFirstCell(editor);
    const cmd = paletteFor(true).find((c) => c.id === "rowAfter");
    if (cmd === undefined) throw new Error("rowAfter missing");
    const from = editor.state.selection.from;
    cmd.run({ editor, range: { from, to: from } });
    const out = normalizeMarkdown(editor.getMarkdown());
    const tableLines = out.split("\n").filter((l) => l.trim().startsWith("|"));
    // header + separator + 2 data rows = 4 table lines.
    expect(tableLines.length).toBe(4);
    editor.destroy();
  });

  it("deleteColumn removes the caret's column", () => {
    const editor = makeEditor(TABLE_MD);
    selectFirstCell(editor);
    const cmd = paletteFor(true).find((c) => c.id === "colDelete");
    if (cmd === undefined) throw new Error("colDelete missing");
    const from = editor.state.selection.from;
    cmd.run({ editor, range: { from, to: from } });
    const out = normalizeMarkdown(editor.getMarkdown());
    expect(out).toContain("B");
    expect(out).not.toContain("A");
    editor.destroy();
  });
});

describe("filterCommands", () => {
  it("returns the full palette for an empty query", () => {
    expect(filterCommands("")).toHaveLength(COMMANDS.length);
  });

  it("ranks an exact/prefix match first", () => {
    expect(filterCommands("h1")[0]?.id).toBe("heading1");
    expect(filterCommands("table")[0]?.id).toBe("table");
  });

  it("matches Japanese titles", () => {
    const ids = filterCommands("見出し").map((c) => c.id);
    expect(ids).toContain("heading1");
    expect(ids).toContain("heading2");
  });

  it("matches romaji keywords", () => {
    expect(filterCommands("hyou").map((c) => c.id)).toContain("table");
  });

  it("returns nothing for an unmatched query", () => {
    expect(filterCommands("zzzznotacommand")).toHaveLength(0);
  });
});
