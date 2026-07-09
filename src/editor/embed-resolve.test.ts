// @vitest-environment jsdom
//
// Track V — DOM-level nested embed resolution tests (INTERFACES.md §5.6).
//
// The resolver functions are injected mocks (no Tauri); the preview HTML is
// produced by the real `renderPreviewHtml` pipeline so the `.embed-ref`
// placeholder contract is exercised end-to-end.

import { describe, expect, it } from "vitest";

import { renderPreviewHtml } from "../markdown";
import {
  CYCLE_BADGE_TEXT,
  UNRESOLVED_BADGE_TEXT,
  isExternalHref,
  resolveNestedEmbeds,
  resolveRelativeHref,
  type EmbedResolverFns,
  type ResolvedPageLike,
} from "./embed-resolve";

interface MockPage {
  title: string | null;
  body: string;
  children?: ResolvedPageLike[];
}

function makeResolver(pages: Record<string, MockPage>): EmbedResolverFns {
  const complete = (target: string) => (target.endsWith(".md") ? target : `${target}.md`);
  return {
    resolvePage: async (_root, target) => {
      const relPath = complete(target);
      const page = pages[relPath];
      return page === undefined ? null : { relPath, title: page.title };
    },
    listChildPages: async (_root, relPath) => pages[relPath]?.children ?? [],
    readPageBody: async (_root, relPath) => {
      const page = pages[relPath];
      if (page === undefined) throw new Error(`no such page: ${relPath}`);
      return page.body;
    },
  };
}

function refDiv(page: string, mode = "inline"): string {
  return `<div class="embed-ref" data-page="${page}" data-mode="${mode}">${page}</div>`;
}

function container(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const ROOT = "/ws";

describe("resolveNestedEmbeds", () => {
  it("resolves a placeholder into title + rendered content", async () => {
    const resolver = makeResolver({
      "B.md": { title: "Page B", body: "Hello **world**\n" },
    });
    const el = container(refDiv("B.md"));
    await resolveNestedEmbeds(el, {
      root: ROOT,
      chain: ["A.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    });
    const ref = el.querySelector<HTMLElement>("div.embed-ref");
    expect(ref?.getAttribute("data-embed-state")).toBe("resolved");
    expect(ref?.querySelector(".embed-ref-title")?.textContent).toBe("Page B");
    expect(ref?.querySelector(".embed-ref-content strong")?.textContent).toBe("world");
  });

  it("marks unknown targets with the 未解決 badge", async () => {
    const resolver = makeResolver({});
    const el = container(refDiv("Missing.md"));
    await resolveNestedEmbeds(el, {
      root: ROOT,
      chain: ["A.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    });
    const ref = el.querySelector<HTMLElement>("div.embed-ref");
    expect(ref?.getAttribute("data-embed-state")).toBe("unresolved");
    expect(ref?.querySelector(".embed-ref-badge")?.textContent).toBe(UNRESOLVED_BADGE_TEXT);
    // The original label is kept (inert placeholder).
    expect(ref?.textContent).toContain("Missing.md");
  });

  it("stops on a cycle: A embeds B embeds A → nested A becomes 循環embed", async () => {
    const resolver = makeResolver({
      "A.md": { title: "A", body: '::embed{page="B.md"}\n' },
      "B.md": { title: "B", body: '::embed{page="A.md"}\n' },
    });
    // Host page A.md renders an embed of B (chain starts at A).
    const el = container(refDiv("B.md"));
    await resolveNestedEmbeds(el, {
      root: ROOT,
      chain: ["A.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    });
    const outer = el.querySelector<HTMLElement>('div.embed-ref[data-page="B.md"]');
    expect(outer?.getAttribute("data-embed-state")).toBe("resolved");
    const nested = outer?.querySelector<HTMLElement>('div.embed-ref[data-page="A.md"]');
    expect(nested).not.toBeNull();
    expect(nested?.getAttribute("data-embed-state")).toBe("cycle");
    expect(nested?.querySelector(".embed-ref-badge")?.textContent).toBe(CYCLE_BADGE_TEXT);
    // Inert: the cycle placeholder renders no further content.
    expect(nested?.querySelector(".embed-ref-content")).toBeNull();
  });

  it("stops at the depth limit even without a cycle", async () => {
    const resolver = makeResolver({
      "A.md": { title: "A", body: '::embed{page="B.md"}\n' },
      "B.md": { title: "B", body: '::embed{page="C.md"}\n' },
      "C.md": { title: "C", body: "leaf\n" },
    });
    // chain = [Root] → A (depth 2) → B (depth 3) → C would exceed maxDepth 3.
    const el = container(refDiv("A.md"));
    await resolveNestedEmbeds(el, {
      root: ROOT,
      chain: ["Root.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    });
    const a = el.querySelector<HTMLElement>('div.embed-ref[data-page="A.md"]');
    const b = a?.querySelector<HTMLElement>('div.embed-ref[data-page="B.md"]');
    const c = b?.querySelector<HTMLElement>('div.embed-ref[data-page="C.md"]');
    expect(a?.getAttribute("data-embed-state")).toBe("resolved");
    expect(b?.getAttribute("data-embed-state")).toBe("resolved");
    expect(c?.getAttribute("data-embed-state")).toBe("cycle");
    expect(c?.querySelector(".embed-ref-badge")?.textContent).toBe(CYCLE_BADGE_TEXT);
    expect(c?.querySelector(".embed-ref-content")).toBeNull();
  });

  it("renders folder mode as a child page list", async () => {
    const resolver = makeResolver({
      "Notes/index.md": {
        title: "Notes",
        body: "unused\n",
        children: [
          { relPath: "Notes/One.md", title: "One" },
          { relPath: "Notes/Two.md", title: null },
        ],
      },
    });
    const el = container(refDiv("Notes/index.md", "folder"));
    await resolveNestedEmbeds(el, {
      root: ROOT,
      chain: ["A.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    });
    const ref = el.querySelector<HTMLElement>("div.embed-ref");
    expect(ref?.getAttribute("data-embed-state")).toBe("resolved");
    const items = ref?.querySelectorAll(".embed-ref-children .embed-ref-child");
    expect(items?.length).toBe(2);
    expect(items?.[0].textContent).toBe("One");
    expect(items?.[1].textContent).toBe("Notes/Two.md");
    expect(items?.[0].getAttribute("data-rel-path")).toBe("Notes/One.md");
  });

  it("does not re-process already-claimed placeholders", async () => {
    const resolver = makeResolver({ "B.md": { title: "B", body: "x\n" } });
    const el = container(refDiv("B.md"));
    const opts = {
      root: ROOT,
      chain: ["A.md"],
      resolver,
      renderHtml: renderPreviewHtml,
    };
    await resolveNestedEmbeds(el, opts);
    await resolveNestedEmbeds(el, opts); // second pass must be a no-op
    expect(el.querySelectorAll(".embed-ref-title").length).toBe(1);
  });
});

describe("resolveRelativeHref", () => {
  it("resolves sibling and subdirectory links", () => {
    expect(resolveRelativeHref("dir/page.md", "other.md")).toBe("dir/other.md");
    expect(resolveRelativeHref("page.md", "sub/x.md")).toBe("sub/x.md");
    expect(resolveRelativeHref("dir/page.md", "./other.md")).toBe("dir/other.md");
  });

  it("resolves parent traversal and rejects root escapes", () => {
    expect(resolveRelativeHref("dir/page.md", "../top.md")).toBe("top.md");
    expect(resolveRelativeHref("a/b/c.md", "../../x.md")).toBe("x.md");
    expect(resolveRelativeHref("page.md", "../escape.md")).toBeNull();
  });

  it("decodes percent-encoding and strips fragments", () => {
    expect(resolveRelativeHref("page.md", "My%20Page.md")).toBe("My Page.md");
    expect(resolveRelativeHref("page.md", "other.md#section")).toBe("other.md");
  });

  it("returns null for external / absolute / fragment / non-md hrefs", () => {
    expect(resolveRelativeHref("page.md", "https://example.com/x.md")).toBeNull();
    expect(resolveRelativeHref("page.md", "mailto:x@example.com")).toBeNull();
    expect(resolveRelativeHref("page.md", "/abs/path.md")).toBeNull();
    expect(resolveRelativeHref("page.md", "#anchor")).toBeNull();
    expect(resolveRelativeHref("page.md", "image.png")).toBeNull();
    expect(resolveRelativeHref("page.md", "")).toBeNull();
  });
});

describe("isExternalHref", () => {
  it("detects schemes and protocol-relative URLs", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("http://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("//example.com/x")).toBe(true);
    expect(isExternalHref("notes/page.md")).toBe(false);
    expect(isExternalHref("../page.md")).toBe(false);
  });
});
