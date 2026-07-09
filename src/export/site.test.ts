// Track S3 — static site publish unit tests (INTERFACES.md §11.4, PLAN §1.9).
//
// Pure: everything runs against an in-memory SiteSource (workspace tree + page
// bodies + a fake EmbedSource over the same page map). No Tauri, no DOM, no fs.
// publishSiteToFolder (dialog + write_site_files IPC) is intentionally NOT
// tested here — it is a thin wrapper and belongs to the integration handoff.

import { describe, expect, it } from "vitest";

import type { TreeEntry } from "../app/workspace";
import type { EmbedSource, ResolvedRef } from "./resolve-embeds";
import {
  buildNavTree,
  buildSiteFiles,
  mdTargetToHtml,
  pickLandingPage,
  renderNavHtml,
  type SiteFile,
  type SiteSource,
} from "./site";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

/** relPath → raw page markdown (frontmatter included). */
type PageMap = Record<string, string>;

/** Build a TreeEntry[] (contract-shaped: dirs first, sorted) from rel paths. */
function buildTree(relPaths: string[]): TreeEntry[] {
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: string[];
  }
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const rel of relPaths) {
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = node.dirs.get(seg);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.push(parts[parts.length - 1]);
  }
  const toEntries = (node: DirNode, prefix: string): TreeEntry[] => {
    const dirEntries: TreeEntry[] = [...node.dirs.entries()]
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([name, child]) => {
        const relPath = prefix === "" ? name : `${prefix}/${name}`;
        return {
          name,
          relPath,
          isDir: true,
          children: toEntries(child, relPath),
        };
      });
    const fileEntries: TreeEntry[] = [...node.files]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((name) => ({
        name,
        relPath: prefix === "" ? name : `${prefix}/${name}`,
        isDir: false,
        children: null,
      }));
    return [...dirEntries, ...fileEntries];
  };
  return toEntries(root, "");
}

/** EmbedSource over the page map (mirrors resolve-embeds.test.ts fake). */
function fakeEmbedSource(pages: PageMap, children?: Record<string, ResolvedRef[]>): EmbedSource {
  const stripFrontmatter = (raw: string): string => {
    const m = /^---\n[\s\S]*?\n---\n?/.exec(raw);
    return m === null ? raw : raw.slice(m[0].length);
  };
  const resolveRel = (target: string): string | null => {
    for (const cand of [target, `${target}.md`, `${target}/index.md`]) {
      if (cand in pages) return cand;
    }
    return null;
  };
  return {
    async resolve(target) {
      const relPath = resolveRel(target);
      return relPath === null ? null : { relPath, title: null };
    },
    async readBody(relPath) {
      const raw = pages[relPath];
      if (raw === undefined) throw new Error(`no page: ${relPath}`);
      return stripFrontmatter(raw);
    },
    async listChildren(relPath) {
      return children?.[relPath] ?? [];
    },
  };
}

/** A full SiteSource from a page map (+ optional folder children). */
function fakeSite(pages: PageMap, children?: Record<string, ResolvedRef[]>): SiteSource {
  return {
    listTree: async () => buildTree(Object.keys(pages)),
    readPage: async (relPath) => {
      const raw = pages[relPath];
      if (raw === undefined) throw new Error(`no page: ${relPath}`);
      return raw;
    },
    embeds: fakeEmbedSource(pages, children),
  };
}

const fileFor = (files: SiteFile[], relPath: string): SiteFile => {
  const f = files.find((x) => x.relPath === relPath);
  if (f === undefined) {
    throw new Error(`no output file ${relPath}; got ${files.map((x) => x.relPath).join(", ")}`);
  }
  return f;
};

// ---------------------------------------------------------------------------
// mdTargetToHtml — link rewrite (.md → .html), fragments, nesting, non-.md
// ---------------------------------------------------------------------------

describe("mdTargetToHtml", () => {
  it("rewrites a bare .md target", () => {
    expect(mdTargetToHtml("Foo.md")).toBe("Foo.html");
  });

  it("keeps nested directories", () => {
    expect(mdTargetToHtml("Projects/Roadmap.md")).toBe("Projects/Roadmap.html");
    expect(mdTargetToHtml("../Notes/A.md")).toBe("../Notes/A.html");
  });

  it("preserves a #fragment", () => {
    expect(mdTargetToHtml("Foo.md#section")).toBe("Foo.html#section");
    expect(mdTargetToHtml("dir/Foo.md#a-b")).toBe("dir/Foo.html#a-b");
  });

  it("preserves a ?query", () => {
    expect(mdTargetToHtml("Foo.md?x=1")).toBe("Foo.html?x=1");
  });

  it("is case-insensitive on the extension", () => {
    expect(mdTargetToHtml("Foo.MD")).toBe("Foo.html");
  });

  it("leaves non-.md targets untouched (external links, anchors, assets)", () => {
    expect(mdTargetToHtml("https://example.com/x")).toBe("https://example.com/x");
    expect(mdTargetToHtml("#local")).toBe("#local");
    expect(mdTargetToHtml("image.png")).toBe("image.png");
    expect(mdTargetToHtml("Foo.markdown")).toBe("Foo.markdown");
  });
});

// ---------------------------------------------------------------------------
// buildNavTree — tree order, folder-notes → dir/index.html, titles
// ---------------------------------------------------------------------------

describe("buildNavTree", () => {
  it("keeps tree order and uses titles for labels", () => {
    const tree = buildTree(["Alpha.md", "Beta.md"]);
    const titles = new Map([
      ["Alpha.md", "α ページ"],
      ["Beta.md", "β ページ"],
    ]);
    const nav = buildNavTree(tree, titles);

    expect(nav.map((n) => n.label)).toEqual(["α ページ", "β ページ"]);
    expect(nav.map((n) => n.htmlPath)).toEqual(["Alpha.html", "Beta.html"]);
    expect(nav.every((n) => n.children.length === 0)).toBe(true);
  });

  it("falls back to the page name when a title is missing", () => {
    const tree = buildTree(["Untitled.md"]);
    const nav = buildNavTree(tree, new Map());
    expect(nav[0]).toMatchObject({ label: "Untitled", htmlPath: "Untitled.html" });
  });

  it("links a folder note to dir/index.html and does not repeat index.md as a child", () => {
    const tree = buildTree(["Projects/index.md", "Projects/Roadmap.md"]);
    const titles = new Map([
      ["Projects/index.md", "プロジェクト"],
      ["Projects/Roadmap.md", "ロードマップ"],
    ]);
    const nav = buildNavTree(tree, titles);

    expect(nav).toHaveLength(1);
    const dir = nav[0];
    // Folder-note directory links to its own index.html, labelled by its title.
    expect(dir).toMatchObject({ label: "プロジェクト", htmlPath: "Projects/index.html" });
    // index.md is not repeated among the children; Roadmap is the only child.
    expect(dir.children.map((c) => c.htmlPath)).toEqual(["Projects/Roadmap.html"]);
    expect(dir.children.map((c) => c.label)).toEqual(["ロードマップ"]);
  });

  it("renders a plain directory (no index.md) as a non-link label", () => {
    const tree = buildTree(["Notes/A.md"]);
    const nav = buildNavTree(tree, new Map([["Notes/A.md", "A"]]));

    expect(nav).toHaveLength(1);
    expect(nav[0].label).toBe("Notes");
    expect(nav[0].htmlPath).toBeNull(); // plain dir → not a link
    expect(nav[0].children.map((c) => c.htmlPath)).toEqual(["Notes/A.html"]);
  });

  it("orders directories before files (contract tree order)", () => {
    const tree = buildTree(["Zeta.md", "Alpha/index.md"]);
    const nav = buildNavTree(tree, new Map());
    // Directory 'Alpha' precedes file 'Zeta' regardless of name.
    expect(nav.map((n) => n.label)).toEqual(["Alpha", "Zeta"]);
  });
});

// ---------------------------------------------------------------------------
// renderNavHtml — relative hrefs per page dir, current highlight, home link
// ---------------------------------------------------------------------------

describe("renderNavHtml", () => {
  it("emits root-relative hrefs and a home link from the site root", () => {
    const nav = buildNavTree(buildTree(["A.md", "B.md"]), new Map());
    const html = renderNavHtml(nav, "A.html", "");

    expect(html).toContain('class="site-home" href="index.html"');
    expect(html).toContain('href="A.html"');
    expect(html).toContain('href="B.html"');
  });

  it("marks the current page and only that page", () => {
    const nav = buildNavTree(buildTree(["A.md", "B.md"]), new Map());
    const html = renderNavHtml(nav, "A.html", "");

    const currentMatches = html.match(/class="current"/g) ?? [];
    expect(currentMatches).toHaveLength(1);
    expect(html).toContain('href="A.html" class="current" aria-current="page"');
    // B is not current.
    expect(html).toContain('href="B.html">');
  });

  it("computes hrefs relative to a nested page's directory", () => {
    const nav = buildNavTree(buildTree(["Top.md", "sub/Deep.md"]), new Map());
    // Rendering for sub/Deep.html: reaching a root page needs ../.
    const html = renderNavHtml(nav, "sub/Deep.html", "sub");

    expect(html).toContain('href="../Top.html"');
    expect(html).toContain('class="site-home" href="../index.html"');
    // The current nested page links to itself with no ../ climb.
    expect(html).toContain('href="Deep.html" class="current"');
  });

  it("renders a plain directory label as a non-link span", () => {
    const nav = buildNavTree(buildTree(["Notes/A.md"]), new Map());
    const html = renderNavHtml(nav, null, "");
    expect(html).toContain('<span class="nav-label">Notes</span>');
  });

  it("escapes HTML in labels", () => {
    const nav = buildNavTree(buildTree(["X.md"]), new Map([["X.md", "<b>&\"x\""]]));
    const html = renderNavHtml(nav, null, "");
    expect(html).toContain("&lt;b&gt;&amp;&quot;x&quot;");
    expect(html).not.toContain("<b>&\"x\"");
  });
});

// ---------------------------------------------------------------------------
// pickLandingPage — Welcome > first root page > first page
// ---------------------------------------------------------------------------

describe("pickLandingPage", () => {
  it("prefers Welcome.md", () => {
    expect(pickLandingPage(["a/b.md", "Welcome.md", "c.md"])).toBe("Welcome.md");
  });
  it("falls back to the first root-level page", () => {
    expect(pickLandingPage(["deep/x.md", "Root.md", "other.md"])).toBe("Root.md");
  });
  it("falls back to the first page when all are nested", () => {
    expect(pickLandingPage(["a/x.md", "b/y.md"])).toBe("a/x.md");
  });
  it("returns null for an empty workspace", () => {
    expect(pickLandingPage([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSiteFiles — end-to-end over the pure core
// ---------------------------------------------------------------------------

describe("buildSiteFiles", () => {
  it("emits one .html per .md page, keeping folder structure", async () => {
    const site = fakeSite({
      "Welcome.md": "---\ntitle: ようこそ\n---\n\n# Welcome\n",
      "Projects/index.md": "---\ntitle: プロジェクト\n---\n\nProjects home.\n",
      "Projects/Roadmap.md": "---\ntitle: ロードマップ\n---\n\nRoadmap body.\n",
    });
    const { files } = await buildSiteFiles(site);
    const paths = files.map((f) => f.relPath).sort();

    expect(paths).toContain("Welcome.html");
    expect(paths).toContain("Projects/index.html");
    expect(paths).toContain("Projects/Roadmap.html");
    // + a synthesized index.html landing (no root index.md present).
    expect(paths).toContain("index.html");
  });

  it("rewrites page-to-page .md links to .html in the output HTML", async () => {
    const site = fakeSite({
      "A.md": "---\ntitle: A\n---\n\nSee [the roadmap](Projects/Roadmap.md#now).\n",
      "Projects/Roadmap.md": "---\ntitle: R\n---\n\nRoadmap.\n",
    });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "A.html");

    expect(a.content).toContain('href="Projects/Roadmap.html#now"');
    expect(a.content).not.toContain("Roadmap.md");
  });

  it("does not rewrite external links or non-.md targets", async () => {
    const site = fakeSite({
      "A.md": "---\ntitle: A\n---\n\n[ext](https://example.com/x.md) and [img](pic.png)\n",
    });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "A.html");

    // Absolute URL is left as-is (rewriteRefs only touches relative .md targets).
    expect(a.content).toContain('href="https://example.com/x.md"');
    expect(a.content).toContain('href="pic.png"');
  });

  it("resolves embeds into the output HTML (target body inlined)", async () => {
    const site = fakeSite({
      "Host.md": "---\ntitle: Host\n---\n\nIntro.\n\n::embed{page=\"Embedded.md\"}\n",
      "Embedded.md": "---\ntitle: E\n---\n\nUNIQUE_EMBED_MARKER content.\n",
    });
    const { files } = await buildSiteFiles(site);
    const host = fileFor(files, "Host.html");

    // The embedded page's body is inlined; the directive itself is gone.
    expect(host.content).toContain("UNIQUE_EMBED_MARKER content.");
    expect(host.content).not.toContain("::embed");
    expect(host.content).not.toContain("directive-embed");
  });

  it("renders a folder embed as links (also rewritten to .html)", async () => {
    const site = fakeSite(
      {
        // Home embeds the Projects folder note in folder mode.
        "Home.md": "---\ntitle: Home\n---\n\n::embed{page=\"Projects/index.md\" mode=\"folder\"}\n",
        "Projects/index.md": "---\ntitle: P\n---\n\nProjects home.\n",
        "Projects/Roadmap.md": "---\ntitle: R\n---\n\nx\n",
      },
      {
        "Projects/index.md": [{ relPath: "Projects/Roadmap.md", title: "Roadmap" }],
      },
    );
    const { files } = await buildSiteFiles(site);
    const home = fileFor(files, "Home.html");

    // Folder listing link target got rewritten .md → .html.
    expect(home.content).toContain('href="Projects/Roadmap.html"');
    expect(home.content).toContain("Roadmap");
  });

  it("injects a shared nav sidebar with the current page highlighted", async () => {
    const site = fakeSite({
      "A.md": "---\ntitle: A\n---\n\nbody A\n",
      "B.md": "---\ntitle: B\n---\n\nbody B\n",
    });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "A.html");

    expect(a.content).toContain('<nav class="site-nav">');
    expect(a.content).toContain('class="site-layout"');
    // Both pages appear in the nav; A is the current one on A.html.
    expect(a.content).toContain('href="A.html" class="current"');
    expect(a.content).toContain('href="B.html">');
    // Nav sits before the article and the article is still closed inside layout.
    expect(a.content.indexOf('<nav class="site-nav">')).toBeLessThan(
      a.content.indexOf('<article class="page">'),
    );
    expect(a.content).toContain("</article>\n</div>");
  });

  it("uses frontmatter titles for the <title> and nav labels", async () => {
    const site = fakeSite({
      "A.md": "---\ntitle: 私のタイトル\n---\n\nbody\n",
    });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "A.html");
    expect(a.content).toContain("<title>私のタイトル</title>");
    expect(a.content).toContain(">私のタイトル<");
  });

  it("falls back to the page name for the title when frontmatter has none", async () => {
    const site = fakeSite({ "MyPage.md": "no frontmatter body\n" });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "MyPage.html");
    expect(a.content).toContain("<title>MyPage</title>");
  });

  it("synthesizes index.html from Welcome.md when there is no root index.md", async () => {
    const site = fakeSite({
      "Welcome.md": "---\ntitle: ようこそ\n---\n\nWELCOME_BODY_MARKER\n",
      "Other.md": "---\ntitle: O\n---\n\nother\n",
    });
    const { files } = await buildSiteFiles(site);
    const index = fileFor(files, "index.html");

    expect(index.content).toContain("WELCOME_BODY_MARKER");
    expect(index.content).toContain("<title>ようこそ</title>");
    // Welcome still gets its own page too.
    expect(files.some((f) => f.relPath === "Welcome.html")).toBe(true);
  });

  it("uses a root index.md directly as index.html (no synthesis)", async () => {
    const site = fakeSite({
      "index.md": "---\ntitle: トップ\n---\n\nHOME_BODY\n",
      "A.md": "---\ntitle: A\n---\n\na\n",
    });
    const { files } = await buildSiteFiles(site);

    const indexes = files.filter((f) => f.relPath === "index.html");
    // Exactly one index.html — the page's own output, not a second synthesized one.
    expect(indexes).toHaveLength(1);
    expect(indexes[0].content).toContain("HOME_BODY");
    expect(indexes[0].content).toContain("<title>トップ</title>");
  });

  it("emits a placeholder index.html for an empty workspace", async () => {
    const site = fakeSite({});
    const { files } = await buildSiteFiles(site);

    expect(files).toHaveLength(1);
    expect(files[0].relPath).toBe("index.html");
    expect(files[0].content).toContain("ページがありません");
  });

  it("produces well-formed self-contained HTML documents", async () => {
    const site = fakeSite({ "A.md": "---\ntitle: A\n---\n\nbody\n" });
    const { files } = await buildSiteFiles(site);
    const a = fileFor(files, "A.html");

    expect(a.content.startsWith("<!doctype html>")).toBe(true);
    expect(a.content).toContain("<style>"); // inline CSS, no external assets
    expect(a.content).not.toContain("http-equiv=\"refresh\"");
    expect(a.content.trimEnd().endsWith("</html>")).toBe(true);
  });
});
