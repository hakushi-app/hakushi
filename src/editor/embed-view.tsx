// Track V — resolving NodeView for the HakushiEmbed card (INTERFACES.md §5.6).
//
// Display-only: this NodeView never touches the node's attributes or the
// document, so markdown serialization stays exactly as in M1 (the `raw`
// attribute captured at parse time is re-emitted verbatim). It is a plain
// (non-React) ProseMirror NodeView so the headless round-trip tests and the
// live editor share the same extension list without a React renderer.
//
// States (data-state on the card): "static" (no resolver context — e.g. the
// headless test editor), "resolving", "resolved", "unresolved" (未解決),
// "cycle" (循環embed).
//
// Resolution context (workspace root, resolver fns from src/app/resolver.ts,
// onNavigate, current file) is plumbed EditorPane → BlockEditor →
// `createEditorExtensions(holder)` → HakushiEmbed option `contextHolder` —
// a *mutable holder* so callback identity changes never recreate the editor.

import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { renderPreviewHtml } from "../markdown";
import { canRenderEmbed, MAX_EMBED_DEPTH } from "./embed-cycle";
import {
  CYCLE_BADGE_TEXT,
  UNRESOLVED_BADGE_TEXT,
  resolveNestedEmbeds,
  type EmbedResolverFns,
} from "./embed-resolve";

// ---------------------------------------------------------------------------
// Context plumbing types
// ---------------------------------------------------------------------------

export interface HakushiEmbedContext {
  /** Absolute workspace root (forwarded verbatim to the resolver fns). */
  workspaceRoot: string;
  /** Workspace-relative path of the file open in the editor (chain root). */
  currentRelPath: string;
  /** Injected resolver functions (production: src/app/resolver.ts). */
  resolver: EmbedResolverFns;
  /** Navigate the app to another page. */
  onNavigate?: (relPath: string) => void;
}

/** Mutable holder so the context can change without rebuilding the editor. */
export interface EmbedContextHolder {
  context: HakushiEmbedContext | null;
}

// ---------------------------------------------------------------------------
// NodeView
// ---------------------------------------------------------------------------

interface EmbedViewAttrs {
  page: string;
  mode: string;
  label: string | null;
}

function readAttrs(node: ProseMirrorNode): EmbedViewAttrs {
  return {
    page: String(node.attrs.page ?? ""),
    mode: node.attrs.mode === null || node.attrs.mode === undefined ? "inline" : String(node.attrs.mode),
    label: node.attrs.label === null || node.attrs.label === undefined ? null : String(node.attrs.label),
  };
}

export class HakushiEmbedNodeView {
  dom: HTMLElement;
  contentDOM: null = null;

  private node: ProseMirrorNode;
  private readonly holder: EmbedContextHolder | null;
  private readonly titleEl: HTMLElement;
  private readonly badgeEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private resolvedRelPath: string | null = null;
  private seq = 0;
  private destroyed = false;

  constructor(props: NodeViewRendererProps, holder: EmbedContextHolder | null) {
    this.node = props.node;
    this.holder = holder;

    const doc = props.view.dom.ownerDocument;
    this.dom = doc.createElement("div");
    this.dom.className = "hakushi-embed-card hakushi-embed-view";
    this.dom.setAttribute("data-hakushi-embed", "");
    this.dom.contentEditable = "false";
    this.dom.draggable = true;

    const header = doc.createElement("div");
    header.className = "hakushi-embed-header";

    const icon = doc.createElement("span");
    icon.className = "hakushi-embed-icon";
    icon.textContent = "⧉";

    this.titleEl = doc.createElement("button");
    this.titleEl.setAttribute("type", "button");
    this.titleEl.className = "hakushi-embed-page hakushi-embed-nav";
    this.titleEl.title = "ページを開く";
    this.titleEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ctx = this.holder?.context ?? null;
      if (ctx !== null && this.resolvedRelPath !== null) {
        ctx.onNavigate?.(this.resolvedRelPath);
      }
    });

    this.badgeEl = doc.createElement("span");
    this.badgeEl.className = "hakushi-embed-badge";
    this.badgeEl.hidden = true;

    this.modeEl = doc.createElement("span");
    this.modeEl.className = "hakushi-embed-mode";

    header.append(icon, this.titleEl, this.badgeEl, this.modeEl);

    this.bodyEl = doc.createElement("div");
    this.bodyEl.className = "hakushi-embed-body";
    this.bodyEl.hidden = true;

    this.dom.append(header, this.bodyEl);

    void this.resolve();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const prev = readAttrs(this.node);
    const next = readAttrs(node);
    this.node = node;
    if (prev.page !== next.page || prev.mode !== next.mode || prev.label !== next.label) {
      void this.resolve();
    }
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Async DOM fills must never be interpreted as PM document mutations. */
  ignoreMutation(): boolean {
    return true;
  }

  /** Keep clicks on the interactive bits (title button, folder links) ours. */
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return target?.closest(".hakushi-embed-nav, .hakushi-embed-child-link") != null;
  }

  // -------------------------------------------------------------------------

  private setState(state: string): void {
    this.dom.setAttribute("data-state", state);
  }

  private setBadge(text: string | null): void {
    if (text === null) {
      this.badgeEl.hidden = true;
      this.badgeEl.textContent = "";
    } else {
      this.badgeEl.hidden = false;
      this.badgeEl.textContent = text;
    }
  }

  private async resolve(): Promise<void> {
    const seq = ++this.seq;
    const stale = () => this.destroyed || seq !== this.seq;
    const { page, mode, label } = readAttrs(this.node);
    const ctx = this.holder?.context ?? null;

    this.resolvedRelPath = null;
    this.titleEl.textContent = label ?? (page || "(no page)");
    this.modeEl.textContent = mode;
    this.setBadge(null);
    this.bodyEl.hidden = true;
    this.bodyEl.textContent = "";

    if (ctx === null) {
      // No resolver plumbed in (headless tests / dev harness): stay a static
      // placeholder card, exactly like the M1 renderHTML output.
      this.setState("static");
      return;
    }
    if (page === "") {
      this.setState("unresolved");
      this.setBadge(UNRESOLVED_BADGE_TEXT);
      return;
    }

    this.setState("resolving");
    const resolved = await ctx.resolver.resolvePage(ctx.workspaceRoot, page).catch(() => null);
    if (stale()) return;

    if (resolved === null) {
      this.setState("unresolved");
      this.titleEl.textContent = label ?? page;
      this.setBadge(UNRESOLVED_BADGE_TEXT);
      return;
    }

    this.resolvedRelPath = resolved.relPath;
    this.titleEl.textContent = label ?? resolved.title ?? resolved.relPath;

    const chain = [ctx.currentRelPath];
    if (!canRenderEmbed(chain, resolved.relPath, MAX_EMBED_DEPTH)) {
      // Self-embed (page embedding itself).
      this.setState("cycle");
      this.setBadge(CYCLE_BADGE_TEXT);
      return;
    }

    if (mode === "folder") {
      const children = await ctx.resolver
        .listChildPages(ctx.workspaceRoot, resolved.relPath)
        .catch(() => []);
      if (stale()) return;
      const doc = this.dom.ownerDocument;
      const list = doc.createElement("ul");
      list.className = "hakushi-embed-children";
      for (const child of children) {
        const item = doc.createElement("li");
        const link = doc.createElement("button");
        link.setAttribute("type", "button");
        link.className = "hakushi-embed-child-link";
        link.textContent = child.title ?? child.relPath;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.holder?.context?.onNavigate?.(child.relPath);
        });
        item.appendChild(link);
        list.appendChild(item);
      }
      if (children.length === 0) {
        const empty = doc.createElement("div");
        empty.className = "hakushi-embed-empty";
        empty.textContent = "子ページはありません";
        this.bodyEl.appendChild(empty);
      } else {
        this.bodyEl.appendChild(list);
      }
      this.bodyEl.hidden = false;
      this.setState("resolved");
      return;
    }

    // inline / preview → read-only rendered body.
    let body: string | null;
    try {
      body = await ctx.resolver.readPageBody(ctx.workspaceRoot, resolved.relPath);
    } catch {
      body = null;
    }
    if (stale()) return;
    if (body === null) {
      this.setState("unresolved");
      this.setBadge(UNRESOLVED_BADGE_TEXT);
      return;
    }

    const doc = this.dom.ownerDocument;
    const preview = doc.createElement("div");
    preview.className = "hakushi-embed-preview";
    preview.innerHTML = renderPreviewHtml(body);
    this.bodyEl.appendChild(preview);
    this.bodyEl.hidden = false;
    this.setState("resolved");

    // Post-process nested embed placeholders with the extended chain.
    await resolveNestedEmbeds(preview, {
      root: ctx.workspaceRoot,
      chain: [...chain, resolved.relPath],
      resolver: ctx.resolver,
      renderHtml: renderPreviewHtml,
      maxDepth: MAX_EMBED_DEPTH,
    });
  }
}
