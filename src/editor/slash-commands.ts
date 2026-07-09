// Track C — slash-command registry + trigger detection (Notion-style「/」menu).
//
// This module is intentionally free of React and of any editor *view* concerns
// so it can be unit-tested headlessly (see slash-commands.test.ts): it exposes
//
//   - `getSlashContext(state)` — pure ProseMirror-state → trigger range/query,
//   - `COMMANDS` / `filterCommands(query)` — the command palette + fuzzy filter,
//   - each command's `run(ctx, value?)` — a TipTap chain that mutates the doc.
//
// The command set is deliberately the *Markdown-native* subset of Notion's
// slash menu: every command produces a node that already round-trips through
// `src/markdown/pipeline.ts` (headings, lists, task list, quote, code block,
// GFM table, thematic break, image, and the Hakushi `::embed` directive). No
// command introduces opaque/JSON-only blocks (colours, callouts, synced blocks,
// databases, …) — those would violate the "on-disk is Markdown-native" iron
// rule in CLAUDE.md.

import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

// ---------------------------------------------------------------------------
// Context probes
// ---------------------------------------------------------------------------

/** True when the selection sits inside a GFM table (any cell). */
export function isInTable(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "table") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

export interface SlashContext {
  /** Absolute document position of the triggering "/". */
  from: number;
  /** Absolute document position of the caret (end of the query). */
  to: number;
  /** The text typed after "/" (excluding the slash itself). */
  query: string;
}

// A "/" that starts a fresh word (line start or after whitespace), followed by
// a run of non-space, non-slash characters up to the caret. Anchoring at the
// end means the menu only stays open while the caret sits at the query tail.
const TRIGGER_RE = /(^|\s)\/([^\s/]*)$/;

/**
 * Detect an active slash trigger at the current caret, or `null`.
 *
 * Only fires inside an editable text block (never in a code block, where "/"
 * is literal) and only for a collapsed selection sitting at the query tail.
 * Positions are absolute so callers can `deleteRange({ from, to })` to remove
 * the "/query" text before applying a command.
 */
export function getSlashContext(state: EditorState): SlashContext | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  if (parent.type.name === "codeBlock") return null;

  const blockStart = $from.start();
  const caret = $from.pos;
  // Text from the block start to the caret. Inline atoms collapse to a single
  // placeholder char, keeping offsets 1:1 with positions inside one textblock.
  const before = state.doc.textBetween(blockStart, caret, "\n", "￼");
  const match = TRIGGER_RE.exec(before);
  if (match === null) return null;

  const query = match[2];
  const slashOffset = match.index + match[1].length; // offset of "/" in `before`
  return { from: blockStart + slashOffset, to: caret, query };
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

export type CommandGroup = "basic" | "table" | "media";

export const GROUP_LABELS: Record<CommandGroup, string> = {
  basic: "基本ブロック",
  table: "表の操作",
  media: "メディア",
};

/** Order groups render in. */
export const GROUP_ORDER: CommandGroup[] = ["basic", "table", "media"];

export interface CommandRunContext {
  editor: Editor;
  /** The "/query" range to delete before applying (empty for the right-click menu). */
  range: { from: number; to: number };
}

/** A command that first prompts for a single text value (image URL, embed page). */
export interface CommandInput {
  label: string;
  placeholder: string;
}

export interface EditorCommand {
  id: string;
  group: CommandGroup;
  /** Primary label (Japanese). */
  title: string;
  /** Right-aligned muted hint, e.g. the Markdown shorthand. */
  hint?: string;
  /** Short glyph shown at the row start. */
  icon: string;
  /** Extra match terms (English / romaji / Markdown) for filtering. */
  keywords: string[];
  /** When set, selecting the command asks for `value` before running. */
  input?: CommandInput;
  /** Apply the command. `value` is the confirmed input for `input` commands. */
  run(ctx: CommandRunContext, value?: string): void;
}

/** Focus + delete the trigger range, returning the open chain to extend. */
function base(ctx: CommandRunContext) {
  return ctx.editor.chain().focus().deleteRange(ctx.range);
}

const BASIC_COMMANDS: EditorCommand[] = [
  {
    id: "text",
    group: "basic",
    title: "テキスト",
    icon: "T",
    keywords: ["text", "paragraph", "plain", "honbun", "本文", "だんらく", "段落"],
    run: (ctx) => base(ctx).setParagraph().run(),
  },
  {
    id: "heading1",
    group: "basic",
    title: "見出し1",
    hint: "#",
    icon: "H1",
    keywords: ["heading1", "h1", "midashi", "見出し", "みだし", "title"],
    run: (ctx) => base(ctx).setHeading({ level: 1 }).run(),
  },
  {
    id: "heading2",
    group: "basic",
    title: "見出し2",
    hint: "##",
    icon: "H2",
    keywords: ["heading2", "h2", "midashi", "見出し", "みだし", "subtitle"],
    run: (ctx) => base(ctx).setHeading({ level: 2 }).run(),
  },
  {
    id: "heading3",
    group: "basic",
    title: "見出し3",
    hint: "###",
    icon: "H3",
    keywords: ["heading3", "h3", "midashi", "見出し", "みだし"],
    run: (ctx) => base(ctx).setHeading({ level: 3 }).run(),
  },
  {
    id: "bulletList",
    group: "basic",
    title: "箇条書きリスト",
    hint: "-",
    icon: "•",
    keywords: ["bulleted", "bullet", "list", "ul", "kajougaki", "箇条書き", "リスト"],
    run: (ctx) => base(ctx).toggleBulletList().run(),
  },
  {
    id: "orderedList",
    group: "basic",
    title: "番号付きリスト",
    hint: "1.",
    icon: "1.",
    keywords: ["numbered", "ordered", "list", "ol", "bangou", "番号", "リスト"],
    run: (ctx) => base(ctx).toggleOrderedList().run(),
  },
  {
    id: "taskList",
    group: "basic",
    title: "ToDoリスト",
    hint: "[ ]",
    icon: "☑",
    keywords: ["todo", "task", "checkbox", "check", "チェック", "タスク"],
    run: (ctx) => base(ctx).toggleTaskList().run(),
  },
  {
    id: "blockquote",
    group: "basic",
    title: "引用",
    hint: ">",
    icon: "❝",
    keywords: ["quote", "blockquote", "inyou", "引用"],
    run: (ctx) => base(ctx).toggleBlockquote().run(),
  },
  {
    id: "codeBlock",
    group: "basic",
    title: "コードブロック",
    hint: "```",
    icon: "</>",
    keywords: ["code", "codeblock", "fence", "コード", "pre"],
    run: (ctx) => base(ctx).toggleCodeBlock().run(),
  },
  {
    id: "table",
    group: "basic",
    title: "テーブル",
    icon: "▦",
    keywords: ["table", "grid", "hyou", "表", "テーブル"],
    run: (ctx) =>
      base(ctx).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "divider",
    group: "basic",
    title: "区切り線",
    hint: "---",
    icon: "―",
    keywords: ["divider", "hr", "rule", "separator", "kugiri", "区切り", "線"],
    run: (ctx) => base(ctx).setHorizontalRule().run(),
  },
];

/** Media commands (offered outside tables). */
const MEDIA_COMMANDS: EditorCommand[] = [
  {
    id: "image",
    group: "media",
    title: "画像",
    icon: "🖼",
    keywords: ["image", "picture", "photo", "img", "gazou", "画像", "写真"],
    input: { label: "画像の URL", placeholder: "https://… または ./assets/xxx.png" },
    run: (ctx, value) => {
      const raw = (value ?? "").trim();
      if (raw === "") return;
      // @tiptap/markdown emits `![](src)` verbatim; a bare space in a CommonMark
      // link destination does not round-trip (normalizeMarkdown would demote the
      // image to literal text), so percent-encode spaces — the common case for
      // the local-path placeholder ("./assets/my file.png") — to stay Markdown-native.
      const src = raw.replace(/ /g, "%20");
      base(ctx).setImage({ src }).run();
    },
  },
  {
    id: "embed",
    group: "media",
    title: "ページ埋め込み",
    icon: "⧉",
    keywords: ["embed", "page", "link", "transclude", "埋め込み", "ページ", "リンク"],
    input: { label: "埋め込むページ (id またはパス)", placeholder: "Roadmap または notes/roadmap.md" },
    run: (ctx, value) => {
      const page = (value ?? "").trim();
      if (page === "") return;
      base(ctx)
        .insertContent({
          type: "hakushiEmbed",
          attrs: {
            page,
            mode: null,
            label: null,
            container: false,
            content: null,
            raw: null,
          },
        })
        .run();
    },
  },
];

/**
 * Table operations, offered only when the caret is inside a table cell. Running
 * a structural block command (heading/list/quote/divider) in a cell would leave
 * literal Markdown syntax in the cell (corruption), so inside a table the palette
 * swaps entirely to these row/column commands.
 */
const TABLE_COMMANDS: EditorCommand[] = [
  {
    id: "rowBefore",
    group: "table",
    title: "上に行を追加",
    icon: "⤒",
    keywords: ["row", "above", "before", "insert", "行", "上", "ぎょう", "追加"],
    run: (ctx) => base(ctx).addRowBefore().run(),
  },
  {
    id: "rowAfter",
    group: "table",
    title: "下に行を追加",
    icon: "⤓",
    keywords: ["row", "below", "after", "insert", "行", "下", "ぎょう", "追加"],
    run: (ctx) => base(ctx).addRowAfter().run(),
  },
  {
    id: "colBefore",
    group: "table",
    title: "左に列を追加",
    icon: "⇤",
    keywords: ["column", "col", "left", "before", "列", "左", "れつ", "追加"],
    run: (ctx) => base(ctx).addColumnBefore().run(),
  },
  {
    id: "colAfter",
    group: "table",
    title: "右に列を追加",
    icon: "⇥",
    keywords: ["column", "col", "right", "after", "列", "右", "れつ", "追加"],
    run: (ctx) => base(ctx).addColumnAfter().run(),
  },
  {
    id: "headerRow",
    group: "table",
    title: "ヘッダー行を切替",
    icon: "⊤",
    keywords: ["header", "toggle", "ヘッダー", "見出し行", "切替"],
    run: (ctx) => base(ctx).toggleHeaderRow().run(),
  },
  {
    id: "rowDelete",
    group: "table",
    title: "行を削除",
    icon: "⌫",
    keywords: ["delete", "remove", "row", "行", "削除"],
    run: (ctx) => base(ctx).deleteRow().run(),
  },
  {
    id: "colDelete",
    group: "table",
    title: "列を削除",
    icon: "⌦",
    keywords: ["delete", "remove", "column", "col", "列", "削除"],
    run: (ctx) => base(ctx).deleteColumn().run(),
  },
  {
    id: "tableDelete",
    group: "table",
    title: "表を削除",
    icon: "🗑",
    keywords: ["delete", "remove", "table", "表", "削除"],
    run: (ctx) => base(ctx).deleteTable().run(),
  },
];

/** The full non-table palette (basic blocks + media). */
export const COMMANDS: EditorCommand[] = [...BASIC_COMMANDS, ...MEDIA_COMMANDS];

/**
 * The palette to show for the caret's block context: table operations inside a
 * table cell, otherwise the basic-block + media palette. Keeping structural
 * block commands out of table cells is what prevents the silent cell corruption.
 */
export function paletteFor(inTable: boolean): EditorCommand[] {
  return inTable ? TABLE_COMMANDS : COMMANDS;
}

/**
 * Filter + rank `palette` against `query` (case-insensitive). Empty query
 * returns the palette in declaration order. Exact > prefix > substring; ties
 * keep declaration order (stable sort).
 */
export function filterCommands(
  query: string,
  palette: EditorCommand[] = COMMANDS,
): EditorCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return palette;

  const ranked: { cmd: EditorCommand; score: number; order: number }[] = [];
  palette.forEach((cmd, order) => {
    const terms = [cmd.title, ...cmd.keywords];
    let score = 0;
    for (const term of terms) {
      const t = term.toLowerCase();
      if (t === q) {
        score = Math.max(score, 3);
      } else if (t.startsWith(q)) {
        score = Math.max(score, 2);
      } else if (t.includes(q)) {
        score = Math.max(score, 1);
      }
    }
    if (score > 0) ranked.push({ cmd, score, order });
  });

  ranked.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return ranked.map((r) => r.cmd);
}
