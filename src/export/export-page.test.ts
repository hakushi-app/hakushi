// Track X — exportPage integration tests over the dev mock workspace
// (INTERFACES.md §6.1 wired to the real resolver + link index of §5.3/§5.6;
// outside Tauri, workspace.ts routes to tauri-mock.ts automatically).

import { beforeAll, describe, expect, it } from "vitest";

import { buildIndex } from "../app/link-index";
import { MOCK_WORKSPACE_ROOT } from "../app/tauri-mock";
import { exportPage } from "./index";
import type { PdfBackend } from "./pdf";

const root = MOCK_WORKSPACE_ROOT;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

beforeAll(async () => {
  // Seed the (empty) mock link index from the seed files, same as App does.
  const result = await buildIndex(root);
  expect(result.pages).toBeGreaterThan(0);
});

describe("exportPage", () => {
  it("exports a page to HTML with its embeds resolved", async () => {
    const result = await exportPage(root, "Notes.md", "html");

    expect(result).not.toBeNull();
    expect(result?.fileName).toBe("Notes.html");
    expect(result?.mime).toBe("text/html");
    const html = decode(result!.bytes);
    expect(html).toContain("<title>Notes</title>");
    // Notes.md embeds Projects/Roadmap.md — its body must be inlined.
    expect(html).toContain("M1: dual editors");
    expect(html).not.toContain("::embed");
  });

  it("exports a folder note with includeSubtree as H1-prefixed sections", async () => {
    const result = await exportPage(root, "Projects/index.md", "html", {
      includeSubtree: true,
    });

    expect(result).not.toBeNull();
    const html = decode(result!.bytes);
    // Child pages appear as H1 sections…
    expect(html).toContain("<h1>Roadmap</h1>");
    expect(html).toContain("<h1>Tasks</h1>");
    // …with their bodies included.
    expect(html).toContain("M2: nested pages / embeds / link index");
    expect(html).toContain("Editor sync spike");
    // The folder note's own child embeds are not ALSO inlined (dedup):
    // Roadmap's body shows up exactly once.
    expect((html.match(/M0: skeleton/g) ?? []).length).toBe(1);
  });

  it("exports Docx bytes with the right mime and extension", async () => {
    const result = await exportPage(root, "Projects/Roadmap.md", "docx");

    expect(result).not.toBeNull();
    expect(result?.fileName).toBe("Roadmap.docx");
    expect(result?.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result?.bytes[0]).toBe(0x50); // "P"
    expect(result?.bytes[1]).toBe(0x4b); // "K"
  });

  it("delegates PDF to the PdfBackend and returns null", async () => {
    const opened: { html: string; title: string }[] = [];
    const fake: PdfBackend = {
      async openForPrint(html, title) {
        opened.push({ html, title });
      },
    };

    const result = await exportPage(root, "Welcome.md", "pdf", { pdfBackend: fake });

    expect(result).toBeNull();
    expect(opened).toHaveLength(1);
    expect(opened[0].title).toBe("Welcome");
    expect(opened[0].html).toContain("window.print()");
    expect(opened[0].html).toContain("白紙 Hakushi へようこそ");
  });
});
