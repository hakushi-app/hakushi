// Track T1 — Todo rich view (INTERFACES.md §9.2) for the todo and
// todo-advanced templates. Read-mostly: sorting/grouping is display-only;
// the only write-back is the checkbox toggle (pure todo-model op).

import { useMemo, useState } from "react";
import type { Root } from "mdast";

import { parseTodos, toggleTask, type TodoTask } from "./todo-model";
import "./templates.css";

export interface TodoViewProps {
  root: Root;
  onChange(next: Root): void;
  onNavigate?(relPath: string): void;
}

type SortMode = "document" | "due" | "prio";

const PRIO_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const PRIO_GROUPS = ["high", "medium", "low", "なし"] as const;

interface IndexedTask {
  task: TodoTask;
  /** Document-order index — the toggleTask key. */
  docIdx: number;
}

function prioRank(prio: string | undefined): number {
  if (prio === undefined) return 3;
  return PRIO_ORDER[prio] ?? 3;
}

function TaskRow({ entry, onToggle }: { entry: IndexedTask; onToggle(i: number): void }) {
  const { task, docIdx } = entry;
  return (
    <div className={task.checked ? "todo-item checked" : "todo-item"}>
      <input
        type="checkbox"
        checked={task.checked}
        aria-label={task.text}
        onChange={() => onToggle(docIdx)}
      />
      <span className="todo-text">{task.text}</span>
      {task.due !== undefined && <span className="todo-badge due">期限 {task.due}</span>}
      {task.prio !== undefined && (
        <span className={`todo-badge prio-${task.prio}`}>{task.prio}</span>
      )}
      {task.tags.map((tag) => (
        <span key={tag} className="todo-badge">
          #{tag}
        </span>
      ))}
    </div>
  );
}

export function TodoView({ root, onChange }: TodoViewProps) {
  const tasks = useMemo(
    () => parseTodos(root).map((task, docIdx): IndexedTask => ({ task, docIdx })),
    [root],
  );
  const [sortMode, setSortMode] = useState<SortMode>("document");

  const onToggle = (docIdx: number) => onChange(toggleTask(root, docIdx));

  let content;
  if (sortMode === "prio") {
    const groups = PRIO_GROUPS.map((label) => ({
      label,
      entries: [] as IndexedTask[],
    }));
    for (const entry of tasks) groups[prioRank(entry.task.prio)].entries.push(entry);
    content = groups
      .filter((g) => g.entries.length > 0)
      .map((g) => (
        <div key={g.label}>
          <div className="todo-group-title">
            {g.label === "なし" ? "優先度なし" : `優先度: ${g.label}`}
          </div>
          {g.entries.map((entry) => (
            <TaskRow key={entry.docIdx} entry={entry} onToggle={onToggle} />
          ))}
        </div>
      ));
  } else {
    const sorted =
      sortMode === "due"
        ? [...tasks].sort((a, b) => {
            const da = a.task.due ?? "9999-99-99"; // undated last
            const db = b.task.due ?? "9999-99-99";
            return da === db ? a.docIdx - b.docIdx : da < db ? -1 : 1;
          })
        : tasks;
    content = sorted.map((entry) => (
      <TaskRow key={entry.docIdx} entry={entry} onToggle={onToggle} />
    ));
  }

  return (
    <div className="tpl-view todo-view">
      <div className="todo-controls">
        <label>
          並び替え{" "}
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="document">ドキュメント順</option>
            <option value="due">期限順</option>
            <option value="prio">優先度でグループ</option>
          </select>
        </label>
        <span>
          {tasks.filter((t) => t.task.checked).length} / {tasks.length} 完了
        </span>
      </div>
      {content}
      {tasks.length === 0 && <p>タスクがありません。</p>}
    </div>
  );
}
