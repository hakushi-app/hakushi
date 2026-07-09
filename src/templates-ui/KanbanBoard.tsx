// Track T1 — Kanban rich view (INTERFACES.md §9.2). Presentation only:
// every edit goes through the pure kanban-model ops and is handed back to
// the owner via onChange(next Root); EditorPane owns persistence.
//
// M8 (§12.4): touch drag via Pointer Events is layered on top of the existing
// ←/→ buttons and HTML5 drag-and-drop. HTML5 DnD does not fire in mobile
// WebViews, so a long-press (200ms) pointer drag drives a floating ghost and
// drops the card at the end of the column under the finger. The ←/→ buttons
// remain the always-available fallback (progressive enhancement) and desktop
// HTML5 DnD is untouched.

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Root } from "mdast";

import {
  addCard,
  deleteCard,
  moveCard,
  parseKanban,
  toggleCard,
} from "./kanban-model";
import "./templates.css";

export interface KanbanBoardProps {
  root: Root;
  onChange(next: Root): void;
  onNavigate?(relPath: string): void;
}

interface DragPayload {
  column: string;
  cardIdx: number;
}

const DRAG_MIME = "application/x-hakushi-kanban-card";

/** Long-press threshold before a pointer drag begins (ms). */
const LONG_PRESS_MS = 200;
/** Movement (px) before long-press that cancels the drag (treated as scroll). */
const MOVE_CANCEL_PX = 10;

function readPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (raw === "") return null;
    const parsed = JSON.parse(raw) as DragPayload;
    if (typeof parsed.column !== "string" || typeof parsed.cardIdx !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Column title under the given viewport point, or null (pointer hit-test). */
function columnTitleAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const col = el?.closest<HTMLElement>("[data-kanban-column]");
  return col?.dataset.kanbanColumn ?? null;
}

/** Whether the pointer-down target is an interactive control (skip drag). */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, input, textarea, a, select, form") !== null
  );
}

interface PointerDragState {
  column: string;
  cardIdx: number;
  text: string;
  /** True once the long-press fired and the ghost is live. */
  active: boolean;
}

export function KanbanBoard({ root, onChange }: KanbanBoardProps) {
  const model = useMemo(() => parseKanban(root), [root]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    (op: () => Root) => {
      try {
        setError(null);
        onChange(op());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onChange],
  );

  const submitAdd = (e: FormEvent, column: string) => {
    e.preventDefault();
    const text = (drafts[column] ?? "").trim();
    if (text === "") return;
    apply(() => addCard(root, column, text));
    setDrafts((d) => ({ ...d, [column]: "" }));
  };

  const handleDrop = (e: DragEvent, toColumn: string, toIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const p = readPayload(e);
    if (p === null) return;
    if (p.column === toColumn && (toIdx === p.cardIdx || toIdx === p.cardIdx + 1)) {
      return; // no-op drop back on itself
    }
    // moveCard's toIdx is the index AFTER removal from the source column.
    const adjusted =
      p.column === toColumn && toIdx > p.cardIdx ? toIdx - 1 : toIdx;
    apply(() => moveCard(root, p.column, p.cardIdx, toColumn, adjusted));
  };

  // -------------------------------------------------------------------------
  // Pointer Events touch drag (§12.4) — long-press → ghost → drop on column.
  // -------------------------------------------------------------------------
  const dragRef = useRef<PointerDragState | null>(null);
  const timerRef = useRef<number | null>(null);
  const startPtRef = useRef<{ x: number; y: number } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  // Re-render when a drag begins so cards can show a "dragging" class.
  const [pointerDragging, setPointerDragging] = useState<DragPayload | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const removeGhost = useCallback(() => {
    if (ghostRef.current !== null) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
  }, []);

  const positionGhost = (x: number, y: number) => {
    const g = ghostRef.current;
    if (g === null) return;
    g.style.left = `${x + 12}px`;
    g.style.top = `${y + 12}px`;
  };

  const endPointerDrag = useCallback(() => {
    clearTimer();
    removeGhost();
    dragRef.current = null;
    startPtRef.current = null;
    setPointerDragging(null);
    setDragOver(null);
  }, [clearTimer, removeGhost]);

  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, column: string, cardIdx: number, text: string) => {
      // Only primary touch/pen/mouse; never hijack the checkbox / buttons.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (isInteractiveTarget(e.target)) return;

      const cardEl = e.currentTarget;
      const { clientX, clientY, pointerId } = e;
      startPtRef.current = { x: clientX, y: clientY };
      dragRef.current = { column, cardIdx, text, active: false };

      clearTimer();
      timerRef.current = window.setTimeout(() => {
        const st = dragRef.current;
        if (st === null) return;
        st.active = true;
        // Capture the pointer so move/up keep firing on this element.
        try {
          cardEl.setPointerCapture(pointerId);
        } catch {
          /* setPointerCapture can throw if the pointer already ended */
        }
        // Build a floating ghost that follows the finger.
        const ghost = document.createElement("div");
        ghost.className = "kanban-drag-ghost";
        ghost.textContent = text;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
        positionGhost(clientX, clientY);
        setPointerDragging({ column, cardIdx });
      }, LONG_PRESS_MS);
    },
    [clearTimer],
  );

  const onCardPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (st === null) return;
    if (!st.active) {
      // Before long-press: cancel if the finger moved (user is scrolling).
      const start = startPtRef.current;
      if (
        start !== null &&
        (Math.abs(e.clientX - start.x) > MOVE_CANCEL_PX ||
          Math.abs(e.clientY - start.y) > MOVE_CANCEL_PX)
      ) {
        clearTimer();
        dragRef.current = null;
        startPtRef.current = null;
      }
      return;
    }
    // Active drag: move ghost + highlight the hovered column.
    e.preventDefault();
    positionGhost(e.clientX, e.clientY);
    setDragOver(columnTitleAt(e.clientX, e.clientY));
  }, [clearTimer]);

  const onCardPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const st = dragRef.current;
      if (st === null) {
        endPointerDrag();
        return;
      }
      if (st.active) {
        const toColumn = columnTitleAt(e.clientX, e.clientY);
        if (toColumn !== null && !(toColumn === st.column)) {
          // Drop appends to the end of the target column (deterministic,
          // 1-line diff), matching the ←/→ button semantics.
          const col = model.columns.find((c) => c.title === toColumn);
          const toIdx = col?.cards.length ?? 0;
          apply(() => moveCard(root, st.column, st.cardIdx, toColumn, toIdx));
        }
      }
      endPointerDrag();
    },
    [apply, endPointerDrag, model.columns, root],
  );

  return (
    <div className="tpl-view">
      {error !== null && (
        <div className="tpl-error" role="alert">
          {error}
        </div>
      )}
      <div className="kanban-board">
        {model.columns.map((col, colIdx) => (
          <div
            key={col.title}
            data-kanban-column={col.title}
            className={
              dragOver === col.title ? "kanban-column drag-over" : "kanban-column"
            }
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.title);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragOver(null);
            }}
            onDrop={(e) => handleDrop(e, col.title, col.cards.length)}
          >
            <div className="kanban-column-title">
              <span>{col.title}</span>
              <span className="kanban-count">{col.cards.length}</span>
            </div>

            {col.cards.map((card, cardIdx) => {
              const isPointerDragged =
                pointerDragging !== null &&
                pointerDragging.column === col.title &&
                pointerDragging.cardIdx === cardIdx;
              return (
                <div
                  key={`${cardIdx}-${card.raw}`}
                  className={
                    (card.checked ? "kanban-card checked" : "kanban-card") +
                    (isPointerDragged ? " pointer-dragging" : "")
                  }
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      DRAG_MIME,
                      JSON.stringify({ column: col.title, cardIdx } satisfies DragPayload),
                    );
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDrop={(e) => handleDrop(e, col.title, cardIdx)}
                  onDragOver={(e) => e.preventDefault()}
                  onPointerDown={(e) =>
                    onCardPointerDown(e, col.title, cardIdx, card.text)
                  }
                  onPointerMove={onCardPointerMove}
                  onPointerUp={onCardPointerUp}
                  onPointerCancel={endPointerDrag}
                >
                  <input
                    type="checkbox"
                    checked={card.checked}
                    aria-label="完了"
                    onChange={() => apply(() => toggleCard(root, col.title, cardIdx))}
                  />
                  <span className="kanban-card-text">{card.text}</span>
                  <span className="kanban-card-actions">
                    <button
                      type="button"
                      aria-label="左のカラムへ移動"
                      title="左のカラムへ移動"
                      disabled={colIdx === 0}
                      onClick={() =>
                        apply(() =>
                          moveCard(
                            root,
                            col.title,
                            cardIdx,
                            model.columns[colIdx - 1].title,
                            model.columns[colIdx - 1].cards.length,
                          ),
                        )
                      }
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label="右のカラムへ移動"
                      title="右のカラムへ移動"
                      disabled={colIdx === model.columns.length - 1}
                      onClick={() =>
                        apply(() =>
                          moveCard(
                            root,
                            col.title,
                            cardIdx,
                            model.columns[colIdx + 1].title,
                            model.columns[colIdx + 1].cards.length,
                          ),
                        )
                      }
                    >
                      →
                    </button>
                    <button
                      type="button"
                      aria-label="カードを削除"
                      title="カードを削除"
                      onClick={() => apply(() => deleteCard(root, col.title, cardIdx))}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}

            <form className="kanban-add-form" onSubmit={(e) => submitAdd(e, col.title)}>
              <input
                type="text"
                value={drafts[col.title] ?? ""}
                placeholder="カードを追加"
                aria-label={`${col.title} にカードを追加`}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [col.title]: e.target.value }))
                }
              />
              <button type="submit">追加</button>
            </form>
          </div>
        ))}
      </div>
    </div>
  );
}
