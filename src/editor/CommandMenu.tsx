// Track C — Notion-style command palette for the WYSIWYG editor.
//
// One component drives both entry points requested in the M-follow-up:
//   - "/"        → the editor plugin (slash-command-extension.ts) pushes a
//                  trigger through the shared `controller`; the query is the
//                  live document text after the slash.
//   - right click → a `contextmenu` listener on the editor DOM opens the same
//                  palette at the pointer, with an in-menu search box.
//
// The palette is context-aware: inside a table cell it swaps to table
// operations (add/delete row·column) so a structural block command can never
// corrupt the cell. Selecting a command runs a TipTap chain (slash-commands.ts)
// that deletes the "/query" range and applies the block. Two commands (image,
// page embed) first collect a value via an inline input sub-view — no
// `window.prompt` (disabled in the Tauri webview).
//
// Keyboard: navigation in slash mode is handled by a capture-phase keydown
// listener on the editor DOM (NOT ProseMirror's handleKeyDown), because WebKit
// drops keydowns for ~500ms after an IME commit before handleKeyDown runs. All
// input handlers are guarded against IME composition (isComposing / keyCode 229)
// so the Enter/keys that confirm a Japanese conversion never execute a command.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";

import type { SlashController } from "./slash-command-extension";
import {
  filterCommands,
  GROUP_LABELS,
  GROUP_ORDER,
  isInTable,
  paletteFor,
  type EditorCommand,
} from "./slash-commands";

interface Rect {
  left: number;
  top: number;
  bottom: number;
}

type MenuState =
  | { mode: "slash"; range: { from: number; to: number }; rect: Rect; query: string; inTable: boolean }
  | { mode: "context"; range: { from: number; to: number }; rect: Rect; inTable: boolean };

export interface CommandMenuProps {
  editor: Editor | null;
  controller: SlashController;
}

const MARGIN = 8;
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]);

/** True when a React keyboard event is an IME composition/commit keystroke. */
function isComposingKey(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function CommandMenu({ editor, controller }: CommandMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const [inputCmd, setInputCmd] = useState<EditorCommand | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const menuElRef = useRef<HTMLDivElement | null>(null);
  const searchElRef = useRef<HTMLInputElement | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);

  const effectiveQuery =
    menu === null ? "" : menu.mode === "slash" ? menu.query : search;
  const inTable = menu?.inTable ?? false;

  // Filter within the context palette, then order rows the way they render
  // (grouped by GROUP_ORDER) so ArrowDown always moves to the visually-next row.
  const filtered = useMemo(() => {
    const ranked = filterCommands(effectiveQuery, paletteFor(inTable));
    const ordered: EditorCommand[] = [];
    for (const group of GROUP_ORDER) {
      for (const cmd of ranked) if (cmd.group === group) ordered.push(cmd);
    }
    return ordered;
  }, [effectiveQuery, inTable]);

  // Refs mirror the latest state so the stable capture-phase keydown listener
  // reads fresh values without re-registering on every keystroke.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const menuRef = useRef<MenuState | null>(menu);
  menuRef.current = menu;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const inputCmdRef = useRef<EditorCommand | null>(inputCmd);
  inputCmdRef.current = inputCmd;

  const close = useCallback(() => {
    setMenu(null);
    setInputCmd(null);
    setSearch("");
    setSelected(0);
    setPos(null);
  }, []);

  const backToList = useCallback(() => {
    setInputCmd(null);
    setInputValue("");
  }, []);

  const execute = useCallback(
    (cmd: EditorCommand) => {
      const ed = editorRef.current;
      const current = menuRef.current;
      if (ed === null || current === null) return;
      if (cmd.input) {
        setInputCmd(cmd);
        setInputValue("");
        return;
      }
      cmd.run({ editor: ed, range: current.range });
      close();
    },
    [close],
  );

  const confirmInput = useCallback(() => {
    const ed = editorRef.current;
    const current = menuRef.current;
    const cmd = inputCmdRef.current;
    if (ed === null || current === null || cmd === null) return;
    const value = inputValue.trim();
    if (value === "") return;
    cmd.run({ editor: ed, range: current.range }, value);
    close();
  }, [inputValue, close]);

  // Shared navigation-key handler (arrows / Enter / Tab / Escape). Returns true
  // when the key was consumed. Reads refs so it is safe to call from the
  // capture-phase editor listener.
  const navKey = useCallback(
    (key: string): boolean => {
      if (menuRef.current === null) return false;
      if (inputCmdRef.current !== null) {
        if (key === "Escape") {
          backToList();
          return true;
        }
        return false; // Enter etc. handled by the input element itself.
      }
      if (key === "Escape") {
        close();
        return true;
      }
      const items = filteredRef.current;
      if (items.length === 0) {
        // Swallow Enter too, so it never leaks to the editor as a newline while
        // the (empty) menu is visibly open.
        if (key === "Enter") {
          close();
          return true;
        }
        return false;
      }
      if (key === "ArrowDown") {
        setSelected((i) => (i + 1) % items.length);
        return true;
      }
      if (key === "ArrowUp") {
        setSelected((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        const cmd = items[selectedRef.current];
        if (cmd !== undefined) execute(cmd);
        return true;
      }
      return false;
    },
    [backToList, close, execute],
  );
  const navKeyRef = useRef(navKey);
  navKeyRef.current = navKey;

  // Bridge the editor plugin to this component (slash trigger open/close).
  useEffect(() => {
    controller.onUpdate = (trigger) => {
      if (trigger === null) {
        setMenu(null);
        setInputCmd(null);
        return;
      }
      setMenu({
        mode: "slash",
        range: trigger.range,
        rect: trigger.rect,
        query: trigger.query,
        inTable: trigger.inTable,
      });
    };
    return () => {
      controller.onUpdate = null;
    };
  }, [controller]);

  // Slash-mode keyboard navigation via a capture-phase listener on the editor
  // DOM. Capture + stopPropagation keeps ProseMirror from also acting on the key
  // (e.g. Enter inserting a newline), and — unlike props.handleKeyDown — it is
  // not skipped by WebKit's post-IME-composition gating.
  useEffect(() => {
    if (editor === null) return;
    const dom = editor.view.dom as HTMLElement;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      const current = menuRef.current;
      if (current === null || current.mode !== "slash" || inputCmdRef.current !== null) return;
      if (event.isComposing || event.keyCode === 229) return; // let the IME own composition keys
      if (!NAV_KEYS.has(event.key)) return;
      if (navKeyRef.current(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    dom.addEventListener("keydown", onKeyDownCapture, true);
    return () => dom.removeEventListener("keydown", onKeyDownCapture, true);
  }, [editor]);

  // Right-click anywhere in the editor → open the palette at the pointer.
  useEffect(() => {
    if (editor === null) return;
    const dom = editor.view.dom as HTMLElement;
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const view = editor.view;
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      const target = hit ? hit.pos : view.state.selection.from;
      editor.chain().focus().setTextSelection(target).run();
      setInputCmd(null);
      setSearch("");
      setSelected(0);
      setMenu({
        mode: "context",
        range: { from: target, to: target },
        rect: { left: event.clientX, top: event.clientY, bottom: event.clientY },
        inTable: isInTable(editor.state),
      });
    };
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [editor]);

  // Reset the highlight whenever the filtered set changes.
  useEffect(() => {
    setSelected(0);
  }, [filtered]);

  // Autofocus the relevant input for each sub-view.
  useEffect(() => {
    if (menu !== null && menu.mode === "context" && inputCmd === null) {
      searchElRef.current?.focus();
    }
  }, [menu, inputCmd]);
  useEffect(() => {
    if (inputCmd !== null) inputElRef.current?.focus();
  }, [inputCmd]);

  // Position: below the caret (slash) or at the pointer (context), flipped above
  // and clamped horizontally to stay on-screen.
  useLayoutEffect(() => {
    if (menu === null || menuElRef.current === null) return;
    const { width, height } = menuElRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = menu.rect.left;
    let top = menu.mode === "slash" ? menu.rect.bottom + 6 : menu.rect.top + 4;
    if (left + width + MARGIN > vw) left = Math.max(MARGIN, vw - width - MARGIN);
    if (top + height + MARGIN > vh) {
      const above = menu.rect.top - height - 6;
      top = above > MARGIN ? above : Math.max(MARGIN, vh - height - MARGIN);
    }
    setPos({ left: Math.max(MARGIN, left), top });
  }, [menu, filtered, inputCmd]);

  // Keep the highlighted row visible.
  useEffect(() => {
    const el = menuElRef.current?.querySelector(".cmd-item.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selected, filtered]);

  if (menu === null) return null;

  const style: React.CSSProperties = {
    left: pos?.left ?? menu.rect.left,
    top: pos?.top ?? (menu.mode === "slash" ? menu.rect.bottom + 6 : menu.rect.top + 4),
    visibility: pos === null ? "hidden" : "visible",
  };

  return createPortal(
    <>
      <div
        className="cmd-menu-backdrop"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={menuElRef}
        className="cmd-menu"
        style={style}
        role="menu"
        aria-label="コマンド"
        onMouseDown={(e) => e.preventDefault()}
      >
        {inputCmd !== null && inputCmd.input !== undefined ? (
          <div className="cmd-input-view">
            <div className="cmd-input-label">{inputCmd.input.label}</div>
            <input
              ref={inputElRef}
              className="cmd-input"
              type="text"
              value={inputValue}
              placeholder={inputCmd.input.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingKey(e)) return; // let the IME confirm first
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmInput();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  backToList();
                }
              }}
            />
            <div className="cmd-input-actions">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={backToList}>
                戻る
              </button>
              <button
                type="button"
                className="primary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={confirmInput}
              >
                挿入
              </button>
            </div>
          </div>
        ) : (
          <>
            {menu.mode === "context" && (
              <input
                ref={searchElRef}
                className="cmd-search"
                type="text"
                value={search}
                placeholder="コマンドを検索…"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposingKey(e)) return; // don't hijack IME candidate keys
                  if (navKey(e.key)) e.preventDefault();
                }}
              />
            )}
            <div className="cmd-list">
              {filtered.length === 0 ? (
                <div className="cmd-empty" role="status">
                  該当するコマンドがありません
                </div>
              ) : (
                GROUP_ORDER.map((group) => {
                  const items = filtered.filter((c) => c.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group} className="cmd-group">
                      <div className="cmd-group-label">{GROUP_LABELS[group]}</div>
                      {items.map((cmd) => {
                        const idx = filtered.indexOf(cmd);
                        return (
                          <button
                            key={cmd.id}
                            type="button"
                            role="menuitem"
                            aria-selected={idx === selected}
                            className={idx === selected ? "cmd-item active" : "cmd-item"}
                            onMouseEnter={() => setSelected(idx)}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => execute(cmd)}
                          >
                            <span className="cmd-icon">{cmd.icon}</span>
                            <span className="cmd-title">{cmd.title}</span>
                            {cmd.hint !== undefined && (
                              <span className="cmd-hint">{cmd.hint}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
            <div className="cmd-footer">↑↓ で移動 · Enter で選択 · Esc で閉じる</div>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
