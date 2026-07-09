// Track T1 — Calendar rich view (INTERFACES.md §9.2). Month grid over the
// page's first GFM table. Presentation only: edits go through the pure
// calendar-model ops; onNavigate receives the raw `page` cell value (id or
// rel path) — the owner (EditorPane) resolves it.

import { useMemo, useState, type FormEvent } from "react";
import type { Root } from "mdast";

import { addEvent, parseCalendar, type CalendarEvent } from "./calendar-model";
import "./templates.css";

export interface CalendarViewProps {
  root: Root;
  onChange(next: Root): void;
  /** Called with the event's raw `page` target (id or workspace rel path). */
  onNavigate?(target: string): void;
}

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function ymd(year: number, month0: number, day: number): string {
  const mm = String(month0 + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

interface DayCell {
  date: string;
  day: number;
  inMonth: boolean;
}

/** 6×7 month grid, weeks starting on Sunday. */
function monthGrid(year: number, month0: number): DayCell[] {
  const first = new Date(year, month0, 1);
  const start = new Date(year, month0, 1 - first.getDay());
  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      date: ymd(d.getFullYear(), d.getMonth(), d.getDate()),
      day: d.getDate(),
      inMonth: d.getMonth() === month0,
    });
  }
  return cells;
}

export function CalendarView({ root, onChange, onNavigate }: CalendarViewProps) {
  const model = useMemo(() => parseCalendar(root), [root]);

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month0, setMonth0] = useState(now.getMonth());
  const [draft, setDraft] = useState({ date: "", title: "", page: "", tag: "" });

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of model.events) {
      const list = map.get(ev.date);
      if (list === undefined) map.set(ev.date, [ev]);
      else list.push(ev);
    }
    return map;
  }, [model]);

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month0 + delta, 1);
    setYear(d.getFullYear());
    setMonth0(d.getMonth());
  };

  const today = ymd(now.getFullYear(), now.getMonth(), now.getDate());
  const cells = useMemo(() => monthGrid(year, month0), [year, month0]);

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    const date = draft.date.trim();
    const title = draft.title.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || title === "") return;
    onChange(addEvent(root, { date, title, page: draft.page, tag: draft.tag }));
    setDraft({ date: "", title: "", page: "", tag: "" });
  };

  return (
    <div className="tpl-view calendar-view">
      <div className="calendar-header">
        <button type="button" aria-label="前の月" onClick={() => shiftMonth(-1)}>
          ←
        </button>
        <h3>
          {year}年{month0 + 1}月
        </h3>
        <button type="button" aria-label="次の月" onClick={() => shiftMonth(1)}>
          →
        </button>
      </div>

      <div className="calendar-grid">
        {DOW_LABELS.map((label) => (
          <div key={label} className="calendar-dow">
            {label}
          </div>
        ))}
        {cells.map((cell) => {
          const classes = ["calendar-cell"];
          if (!cell.inMonth) classes.push("other-month");
          if (cell.date === today) classes.push("today");
          return (
            <div key={cell.date} className={classes.join(" ")}>
              <span className="calendar-daynum">{cell.day}</span>
              {(eventsByDate.get(cell.date) ?? []).map((ev) => (
                <button
                  key={`${ev.rowIdx}`}
                  type="button"
                  className={
                    ev.page !== "" ? "calendar-event has-page" : "calendar-event"
                  }
                  title={ev.page !== "" ? `${ev.title} → ${ev.page}` : ev.title}
                  onClick={() => {
                    if (ev.page !== "") onNavigate?.(ev.page);
                  }}
                >
                  {ev.title}
                  {ev.tag !== "" && <span className="calendar-tag">#{ev.tag}</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <form className="calendar-add-form" onSubmit={submitAdd}>
        <input
          type="date"
          value={draft.date}
          aria-label="日付"
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
        <input
          type="text"
          value={draft.title}
          placeholder="タイトル"
          aria-label="タイトル"
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <input
          type="text"
          value={draft.page}
          placeholder="ページ (id か パス、任意)"
          aria-label="ページ"
          onChange={(e) => setDraft((d) => ({ ...d, page: e.target.value }))}
        />
        <input
          type="text"
          value={draft.tag}
          placeholder="タグ (任意)"
          aria-label="タグ"
          onChange={(e) => setDraft((d) => ({ ...d, tag: e.target.value }))}
        />
        <button type="submit">イベント追加</button>
      </form>
    </div>
  );
}
