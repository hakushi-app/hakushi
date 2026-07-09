// Track C — TipTap extension that surfaces the slash-command trigger.
//
// Rather than pull in `@tiptap/suggestion` (not a project dependency), this
// adds a tiny ProseMirror plugin that recomputes the slash context on every
// transaction and pushes changes to a *controller* — a stable object owned by
// the React CommandMenu (same "mutable holder" pattern as the embed context in
// hakushi-embed-node.ts).
//
// Keyboard navigation (arrows / Enter / Tab / Escape) is deliberately NOT wired
// through props.handleKeyDown: on WebKit, ProseMirror drops keydowns for ~500ms
// after an IME composition ends (inOrNearComposition) *before* handleKeyDown is
// called, which would swallow the Enter that confirms a Japanese-filtered slash
// command. The menu instead listens on view.dom in the capture phase (see
// CommandMenu), which is not subject to that gating.
//
// The extension adds NO schema nodes or marks, so the WYSIWYG fidelity corpus
// is unaffected; it is mounted only by BlockEditor (React), never by the
// headless round-trip tests.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { getSlashContext, isInTable, type SlashContext } from "./slash-commands";

export interface SlashTrigger {
  range: { from: number; to: number };
  query: string;
  /** Whether the caret is inside a table cell (selects the palette). */
  inTable: boolean;
  /** Viewport coords of the triggering "/", for positioning the menu. */
  rect: { left: number; top: number; bottom: number };
}

export interface SlashController {
  /** Set by the menu: called whenever the trigger opens, changes, or closes. */
  onUpdate: ((trigger: SlashTrigger | null) => void) | null;
}

export interface SlashCommandOptions {
  controller: SlashController | null;
}

const slashKey = new PluginKey<SlashContext | null>("hakushiSlash");

function sameContext(a: SlashContext | null, b: SlashContext | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.from === b.from && a.to === b.to && a.query === b.query;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "hakushiSlashCommand",

  addOptions() {
    return { controller: null };
  },

  addProseMirrorPlugins() {
    const controller = this.options.controller;
    return [
      new Plugin<SlashContext | null>({
        key: slashKey,
        state: {
          init: () => null,
          apply: (_tr, _value, _oldState, newState: EditorState) =>
            getSlashContext(newState),
        },
        view: () => ({
          update: (view: EditorView, prevState: EditorState) => {
            if (controller === null) return;
            // Never open/re-query mid-IME-composition (mirrors TipTap's own
            // FloatingMenu/BubbleMenu): the doc text is still being composed and
            // re-rendering the portal would fight the IME candidate window.
            if (view.composing) return;
            const current = slashKey.getState(view.state) ?? null;
            const previous = slashKey.getState(prevState) ?? null;
            if (sameContext(current, previous)) return;
            if (current === null) {
              controller.onUpdate?.(null);
              return;
            }
            let coords: { left: number; top: number; bottom: number };
            try {
              const c = view.coordsAtPos(current.from);
              coords = { left: c.left, top: c.top, bottom: c.bottom };
            } catch {
              // Position transiently invalid mid-update — skip this tick.
              return;
            }
            controller.onUpdate?.({
              range: { from: current.from, to: current.to },
              query: current.query,
              inTable: isInTable(view.state),
              rect: coords,
            });
          },
          destroy: () => {
            controller?.onUpdate?.(null);
          },
        }),
      }),
    ];
  },
});
