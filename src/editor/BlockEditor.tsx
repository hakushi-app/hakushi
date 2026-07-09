// Track C — TipTap v3 block WYSIWYG editor (INTERFACES.md §4).
//
// Receives BODY-ONLY markdown (frontmatter is split off by EditorPane,
// rule 2) and exposes `getBody()` which returns markdown produced by the
// official @tiptap/markdown serializer. Callers MUST pass that through
// `normalizeMarkdown` before writing to disk (rule 1) — the editor's native
// serialization never reaches the disk directly.
//
// M2 (INTERFACES.md §5.6): the optional `embedContext` prop carries the
// embed resolution context (workspace root, resolver fns, onNavigate). It is
// stored in a mutable holder handed to the HakushiEmbed extension, so the
// editor never needs rebuilding when callback identities change. The same
// context powers internal link navigation: clicks on relative `.md` links
// inside the WYSIWYG resolve via `resolvePage` and call `onNavigate`;
// external links are a deliberate no-op in M2 (window.open misbehaves in
// Tauri — follow-up: the opener plugin).

import { EditorContent, useEditor } from "@tiptap/react";
import { forwardRef, useImperativeHandle, useRef } from "react";

import { CommandMenu } from "./CommandMenu";
import type { EmbedContextHolder, HakushiEmbedContext } from "./embed-view";
import { isExternalHref, resolveRelativeHref } from "./embed-resolve";
import { createEditorExtensions } from "./extensions";
import { SlashCommand, type SlashController } from "./slash-command-extension";

export interface BlockEditorHandle {
  /** Markdown for the current document body (from the TipTap serializer). */
  getBody(): string;
}

export interface BlockEditorProps {
  /** Body-only markdown (no frontmatter). */
  body: string;
  /** Called whenever the document changes. */
  onDirty(): void;
  /** Embed/link resolution context (M2); omit for a standalone editor. */
  embedContext?: HakushiEmbedContext | null;
}

/**
 * Handle clicks on `<a>` elements inside the ProseMirror DOM.
 * Returns true when the event was consumed.
 */
function handleAnchorClick(holder: EmbedContextHolder, event: MouseEvent): boolean {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest("a[href]");
  if (anchor === null || anchor === undefined) return false;
  // Embed cards manage their own interactions (NodeView stopEvent).
  if (anchor.closest(".hakushi-embed-card") !== null) return false;

  const href = anchor.getAttribute("href") ?? "";
  // Never let the webview navigate away from the app.
  event.preventDefault();
  if (isExternalHref(href)) {
    // M2: deliberate no-op (Tauri needs the opener plugin — follow-up).
    return true;
  }
  const ctx = holder.context;
  if (ctx === null) return true;
  const wsRel = resolveRelativeHref(ctx.currentRelPath, href);
  if (wsRel === null) return true;
  void ctx.resolver
    .resolvePage(ctx.workspaceRoot, wsRel)
    .then(async (resolved) => {
      // Fallback: the raw href may already be workspace-relative.
      if (resolved === null && wsRel !== href) {
        resolved = await ctx.resolver.resolvePage(ctx.workspaceRoot, href);
      }
      if (resolved !== null) ctx.onNavigate?.(resolved.relPath);
    })
    .catch(() => undefined);
  return true;
}

export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(
  function BlockEditor({ body, onDirty, embedContext }, ref) {
    // Keep the latest callback without recreating the editor.
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;

    // Mutable holder: identity is stable for the lifetime of the component,
    // contents track the latest prop (NodeViews read it lazily).
    const holderRef = useRef<EmbedContextHolder>({ context: null });
    holderRef.current.context = embedContext ?? null;

    // Stable bridge between the slash-command plugin and the React menu; the
    // menu registers its callback onto it (see CommandMenu / SlashCommand).
    const slashControllerRef = useRef<SlashController>({ onUpdate: null });

    // Recreated when `body` changes — EditorPane only changes it on file load
    // and view switch, both of which are logically "open a fresh document".
    const editor = useEditor(
      {
        extensions: [
          ...createEditorExtensions(holderRef.current),
          // WYSIWYG-only: adds no schema nodes, so the fidelity corpus (which
          // uses createEditorExtensions directly) is unaffected.
          SlashCommand.configure({ controller: slashControllerRef.current }),
        ],
        content: body,
        contentType: "markdown",
        onUpdate: () => onDirtyRef.current(),
        editorProps: {
          handleDOMEvents: {
            click: (_view, event) => handleAnchorClick(holderRef.current, event),
          },
        },
      },
      [body],
    );

    useImperativeHandle(
      ref,
      () => ({
        getBody: () => editor?.getMarkdown() ?? body,
      }),
      [editor, body],
    );

    return (
      <>
        <EditorContent className="block-editor" editor={editor} />
        <CommandMenu editor={editor} controller={slashControllerRef.current} />
      </>
    );
  },
);
