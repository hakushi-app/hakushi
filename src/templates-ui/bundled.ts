// Track T1 — bundled templates (INTERFACES.md §9.1).
//
// The canonical template files live in /templates and are statically
// bundled via vite raw imports. `key` doubles as the frontmatter
// `template` value for the four rich-view templates.

import calendarRaw from "../../templates/calendar.md?raw";
import kanbanRaw from "../../templates/kanban.md?raw";
import meetingNoteRaw from "../../templates/meeting-note.md?raw";
import todoAdvancedRaw from "../../templates/todo-advanced.md?raw";
import todoRaw from "../../templates/todo.md?raw";

export interface BundledTemplate {
  key: string;
  label: string;
  raw: string;
}

export const BUNDLED_TEMPLATES: BundledTemplate[] = [
  { key: "todo", label: "Todo", raw: todoRaw },
  { key: "todo-advanced", label: "高度な Todo", raw: todoAdvancedRaw },
  { key: "kanban", label: "Kanban", raw: kanbanRaw },
  { key: "calendar", label: "Calendar", raw: calendarRaw },
  { key: "meeting-note", label: "議事録", raw: meetingNoteRaw },
];
