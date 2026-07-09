// Track V — embed resolution helpers (INTERFACES.md §5.6).
//
// Everything here is DOM-level but Tauri-free: the resolver functions are
// *injected* (see `EmbedResolverFns`), so vitest/jsdom can exercise nested
// resolution with plain mock functions. The production wiring passes the
// functions from `src/app/resolver.ts` down through the editor (EditorPane →
// BlockEditor → HakushiEmbed options → NodeView).
//
// `renderPreviewHtml` (src/markdown) renders nested embed directives as
// placeholder `<div class="embed-ref" data-page data-mode>` elements. Nested
// resolution works by post-processing those divs: each is resolved with the
// injected resolver, guarded by `canRenderEmbed`, and — for inline/preview
// modes — filled with another rendered preview whose own `.embed-ref` divs
// are then processed recursively with the extended chain.

import { canRenderEmbed, MAX_EMBED_DEPTH } from "./embed-cycle";

// ---------------------------------------------------------------------------
// Injected resolver surface (mirrors src/app/resolver.ts, Track U contract)
// ---------------------------------------------------------------------------

export interface ResolvedPageLike {
  relPath: string;
  title: string | null;
}

export interface EmbedResolverFns {
  resolvePage(root: string, target: string): Promise<ResolvedPageLike | null>;
  listChildPages(root: string, relPath: string): Promise<ResolvedPageLike[]>;
  readPageBody(root: string, relPath: string): Promise<string>;
}

// Badge texts (also asserted by tests).
export const UNRESOLVED_BADGE_TEXT = "未解決";
export const CYCLE_BADGE_TEXT = "循環embed";

export interface NestedEmbedOptions {
  /** Absolute workspace root, forwarded verbatim to the resolver fns. */
  root: string;
  /**
   * Pages already being rendered, outermost first (the host page plus every
   * enclosing preview). Passed to `canRenderEmbed`.
   */
  chain: readonly string[];
  resolver: EmbedResolverFns;
  /** Markdown → preview HTML (production: renderPreviewHtml). */
  renderHtml(md: string): string;
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Nested `.embed-ref` post-processing
// ---------------------------------------------------------------------------

function appendBadge(el: HTMLElement, state: string, text: string): void {
  el.setAttribute("data-embed-state", state);
  const badge = el.ownerDocument.createElement("span");
  badge.className = `embed-ref-badge embed-ref-badge-${state}`;
  badge.textContent = text;
  el.appendChild(badge);
}

async function resolveEmbedRefElement(
  el: HTMLElement,
  opts: NestedEmbedOptions,
  maxDepth: number,
): Promise<void> {
  // Claim the element so a second pass never double-processes it.
  el.setAttribute("data-embed-state", "resolving");
  const target = el.getAttribute("data-page") ?? "";
  const mode = el.getAttribute("data-mode") ?? "inline";
  const doc = el.ownerDocument;

  const resolved =
    target === ""
      ? null
      : await opts.resolver.resolvePage(opts.root, target).catch(() => null);
  if (resolved === null) {
    appendBadge(el, "unresolved", UNRESOLVED_BADGE_TEXT);
    return;
  }

  if (!canRenderEmbed(opts.chain, resolved.relPath, maxDepth)) {
    // Inert placeholder: keep the label text, add the cycle badge, render
    // nothing below this point.
    appendBadge(el, "cycle", CYCLE_BADGE_TEXT);
    return;
  }

  el.textContent = "";
  el.setAttribute("data-embed-state", "resolved");
  const title = doc.createElement("div");
  title.className = "embed-ref-title";
  title.textContent = resolved.title ?? resolved.relPath;
  el.appendChild(title);

  if (mode === "folder") {
    const children = await opts.resolver
      .listChildPages(opts.root, resolved.relPath)
      .catch(() => [] as ResolvedPageLike[]);
    const list = doc.createElement("ul");
    list.className = "embed-ref-children";
    for (const child of children) {
      const item = doc.createElement("li");
      const link = doc.createElement("span");
      link.className = "embed-ref-child";
      link.setAttribute("data-rel-path", child.relPath);
      link.textContent = child.title ?? child.relPath;
      item.appendChild(link);
      list.appendChild(item);
    }
    el.appendChild(list);
    return;
  }

  // inline / preview: render the page body, then recurse into its own
  // embed-ref placeholders with the extended chain.
  let body: string | null;
  try {
    body = await opts.resolver.readPageBody(opts.root, resolved.relPath);
  } catch {
    body = null;
  }
  if (body === null) {
    appendBadge(el, "unresolved", UNRESOLVED_BADGE_TEXT);
    return;
  }
  const content = doc.createElement("div");
  content.className = "embed-ref-content";
  content.innerHTML = opts.renderHtml(body);
  el.appendChild(content);
  await resolveNestedEmbeds(content, {
    ...opts,
    chain: [...opts.chain, resolved.relPath],
    maxDepth,
  });
}

/**
 * Resolve every not-yet-processed `div.embed-ref` placeholder inside
 * `container` (recursively — nested previews are post-processed with the
 * extended chain until `canRenderEmbed` trips, at which point the placeholder
 * becomes an inert 「循環embed」 badge).
 */
export async function resolveNestedEmbeds(
  container: ParentNode,
  options: NestedEmbedOptions,
): Promise<void> {
  const maxDepth = options.maxDepth ?? MAX_EMBED_DEPTH;
  const refs = Array.from(
    container.querySelectorAll<HTMLElement>("div.embed-ref:not([data-embed-state])"),
  );
  await Promise.all(refs.map((el) => resolveEmbedRefElement(el, options, maxDepth)));
}

// ---------------------------------------------------------------------------
// Link-target helpers (internal navigation, INTERFACES.md §5.6)
// ---------------------------------------------------------------------------

/** True for hrefs with a URL scheme (`https:`, `mailto:`, …) or `//host`. */
export function isExternalHref(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//");
}

/**
 * Resolve a document-relative `.md` href against the linking document's
 * workspace-relative path. Returns the normalized workspace-relative path,
 * or `null` when the href is not an internal `.md` link (external URL,
 * absolute path, pure fragment, non-md asset) or escapes the workspace root.
 */
export function resolveRelativeHref(fromRelPath: string, href: string): string | null {
  if (href === "" || isExternalHref(href) || href.startsWith("/") || href.startsWith("#")) {
    return null;
  }
  // Strip fragment / query, decode percent-encoding (best effort).
  let path = href.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  if (!path.toLowerCase().endsWith(".md")) return null;

  const baseDir = fromRelPath.split("/").slice(0, -1);
  const parts = [...baseDir];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null; // escapes the workspace root
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}
