// Track C2 — M8 conflict resolution UI (INTERFACES.md §12.3, PLAN §2.1.3).
//
// A self-contained full-screen modal GitPanel mounts when a merge / sync
// reports conflicts. It loads the three versions of each colliding file
// (gitConflictVersions), runs the semantic 3-way merge per file
// (semanticMerge3), and shows:
//   - auto-resolved blocks as a collapsed, read-only preview (renderPreviewHtml);
//   - conflict blocks as cards presenting 「あなたの変更」/「相手の変更」 side by
//     side with three plain-language choices — keep yours, keep theirs, or keep
//     both (yours then theirs). No ours/theirs/HEAD jargon.
// Once every conflict block across every file has a choice, 「マージを完了」
// concatenates each file's resolved blocks → normalizeMarkdown + joinFrontmatter
// (via connectMergedBlocks) → git_merge_resolve, then calls onResolved(oid).
// 中断 (onCancel) closes without touching anything.

import { useEffect, useMemo, useState } from "react";

import { renderPreviewHtml } from "../markdown";
import {
  gitConflictVersions,
  gitMergeResolve,
  type ConflictFile,
  type ResolvedFile,
} from "../app/workspace";
import {
  connectMergedBlocks,
  semanticMerge3,
  type MergeBlock,
  type MergeResult,
} from "./semantic-merge";
import "./conflict.css";

export interface ConflictResolverProps {
  root: string;
  /** Incoming branch (real name, or a mock sentinel) being merged in. */
  source: string;
  /** Called with the merge-commit oid once resolution completes. */
  onResolved(oid: string): void;
  /** Called to close without merging (worktree untouched). */
  onCancel(): void;
}

/** Per-file merge state: the loaded versions + the semantic merge result. */
interface FileState {
  file: ConflictFile;
  merge: MergeResult;
  /** True when this page carries YAML frontmatter (first block is fm). */
  hasFrontmatter: boolean;
}

/** A user's choice for one conflict block. */
type Choice = "ours" | "theirs" | "both";

/** Key identifying a conflict block: `${fileIndex}:${blockIndex}`. */
type ChoiceKey = string;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Does a block-md string start with a frontmatter fence? */
function isFrontmatterBlock(md: string): boolean {
  return /^---\r?\n/.test(md.trimStart());
}

export function ConflictResolver({ root, source, onResolved, onCancel }: ConflictResolverProps) {
  const [files, setFiles] = useState<FileState[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Map<ChoiceKey, Choice>>(new Map());
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  // Load the conflict material and compute the per-file semantic merge once.
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setLoadError(null);
    gitConflictVersions(root, source)
      .then((conflicts) => {
        if (cancelled) return;
        const states: FileState[] = conflicts.map((file) => {
          const merge = semanticMerge3(file.base ?? "", file.ours, file.theirs);
          const first = merge.blocks[0];
          const hasFrontmatter =
            first !== undefined && first.kind === "auto" && isFrontmatterBlock(first.md);
          return { file, merge, hasFrontmatter };
        });
        setFiles(states);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errMsg(e));
      });
    return () => {
      cancelled = true;
    };
  }, [root, source]);

  // Enumerate every conflict block that needs a choice.
  const conflictKeys = useMemo<ChoiceKey[]>(() => {
    if (files === null) return [];
    const keys: ChoiceKey[] = [];
    files.forEach((fs, fi) => {
      fs.merge.blocks.forEach((b, bi) => {
        if (b.kind === "conflict") keys.push(`${fi}:${bi}`);
      });
    });
    return keys;
  }, [files]);

  const allChosen = conflictKeys.length > 0 && conflictKeys.every((k) => choices.has(k));
  const noConflicts = files !== null && conflictKeys.length === 0;

  const choose = (key: ChoiceKey, choice: Choice) => {
    setChoices((prev) => {
      const next = new Map(prev);
      next.set(key, choice);
      return next;
    });
  };

  // Assemble one file's resolved markdown from its blocks + the user's choices.
  const resolveFile = (fs: FileState, fi: number): ResolvedFile => {
    let frontmatterMd: string | null = null;
    const bodyBlocks: string[] = [];
    fs.merge.blocks.forEach((block, bi) => {
      const md = blockResolvedMd(block, choices.get(`${fi}:${bi}`));
      // The merged frontmatter is always block 0 (auto) when present — hand it
      // to connectMergedBlocks verbatim so id/settings bytes survive. When the
      // frontmatter genuinely diverged (template/kanban), block 0 is instead a
      // CONFLICT whose chosen side is a raw `---…---` string; it flows through
      // the body path and connectMergedBlocks → normalizeMarkdown re-parses the
      // leading fence as frontmatter, which is exactly right.
      if (bi === 0 && fs.hasFrontmatter && block.kind === "auto") {
        frontmatterMd = md;
        return;
      }
      if (md.trim() !== "") bodyBlocks.push(md);
    });
    return {
      relPath: fs.file.relPath,
      content: connectMergedBlocks(frontmatterMd, bodyBlocks),
    };
  };

  const complete = async () => {
    if (files === null || completing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      const resolved = files.map((fs, fi) => resolveFile(fs, fi));
      const oid = await gitMergeResolve(root, source, resolved);
      onResolved(oid);
    } catch (e) {
      setCompleteError(errMsg(e));
    } finally {
      setCompleting(false);
    }
  };

  const totalConflicts = conflictKeys.length;
  const chosenCount = conflictKeys.filter((k) => choices.has(k)).length;

  return (
    <div className="conflict-backdrop" role="dialog" aria-modal="true" aria-label="変更の統合">
      <div className="conflict-modal">
        <header className="conflict-header">
          <h2 className="conflict-title">変更の統合</h2>
          <div className="conflict-header-spacer" />
          {totalConflicts > 0 && (
            <span className="conflict-progress">
              選択済み {chosenCount} / {totalConflicts}
            </span>
          )}
          <button type="button" className="conflict-cancel-btn" onClick={onCancel}>
            中断
          </button>
        </header>

        <div className="conflict-body">
          {loadError !== null ? (
            <div className="conflict-error" role="alert">
              変更の読み込みに失敗しました: {loadError}
            </div>
          ) : files === null ? (
            <p className="conflict-loading">変更を読み込んでいます…</p>
          ) : noConflicts ? (
            <div className="conflict-empty">
              <p>すべての変更を自動で統合できました。「マージを完了」を押してください。</p>
            </div>
          ) : (
            <>
              <p className="conflict-intro">
                2 つの版で同じ場所が別々に書き換えられています。ぶつかった箇所ごとに、
                残したい方（または両方）を選んでください。ぶつからなかった変更は自動でまとめられ、
                プレビューで確認できます。
              </p>
              {files.map((fs, fi) => (
                <FileSection
                  key={fs.file.relPath}
                  fs={fs}
                  fileIndex={fi}
                  choices={choices}
                  onChoose={choose}
                />
              ))}
            </>
          )}
        </div>

        <footer className="conflict-footer">
          {files !== null && (
            allChosen || noConflicts ? (
              <span className="conflict-footer-status ready">
                すべての選択が完了しました
              </span>
            ) : (
              <span className="conflict-footer-status">
                残り {totalConflicts - chosenCount} 件を選択してください
              </span>
            )
          )}
          {completeError !== null && (
            <span className="conflict-footer-error" role="alert">
              完了に失敗しました: {completeError}
            </span>
          )}
          <div className="conflict-footer-spacer" />
          <button
            type="button"
            className="conflict-complete-btn"
            disabled={files === null || completing || !(allChosen || noConflicts)}
            onClick={() => void complete()}
          >
            {completing ? "統合中…" : "マージを完了"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-file section
// ---------------------------------------------------------------------------

function FileSection({
  fs,
  fileIndex,
  choices,
  onChoose,
}: {
  fs: FileState;
  fileIndex: number;
  choices: Map<ChoiceKey, Choice>;
  onChoose(key: ChoiceKey, choice: Choice): void;
}) {
  const conflictCount = fs.merge.blocks.filter((b) => b.kind === "conflict").length;
  const resolvedCount = fs.merge.blocks.filter(
    (b, bi) => b.kind === "conflict" && choices.has(`${fileIndex}:${bi}`),
  ).length;
  const done = conflictCount > 0 && resolvedCount === conflictCount;

  return (
    <section className="conflict-file">
      <div className="conflict-file-head">
        <span className="conflict-file-name">{fs.file.relPath}</span>
        <span className={done ? "conflict-file-count done" : "conflict-file-count"}>
          {conflictCount === 0
            ? "自動統合"
            : `ぶつかった箇所 ${resolvedCount} / ${conflictCount}`}
        </span>
      </div>
      <div className="conflict-blocks">
        {fs.merge.blocks.map((block, bi) => {
          // Skip the frontmatter block (auto) — it is metadata, not shown.
          if (bi === 0 && fs.hasFrontmatter && block.kind === "auto") return null;
          const key: ChoiceKey = `${fileIndex}:${bi}`;
          return block.kind === "auto" ? (
            <AutoBlock key={bi} md={block.md} />
          ) : (
            <ConflictCard
              key={bi}
              block={block}
              choice={choices.get(key)}
              onChoose={(c) => onChoose(key, c)}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Auto block (collapsed preview)
// ---------------------------------------------------------------------------

function AutoBlock({ md }: { md: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="conflict-auto">
      <button
        type="button"
        className="conflict-auto-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="conflict-auto-badge">自動</span>
        <span className="conflict-auto-summary">{open ? "閉じる" : summarize(md)}</span>
      </button>
      {open && <MarkdownPreview className="conflict-auto-preview" md={md} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflict card (three choices)
// ---------------------------------------------------------------------------

function ConflictCard({
  block,
  choice,
  onChoose,
}: {
  block: Extract<MergeBlock, { kind: "conflict" }>;
  choice: Choice | undefined;
  onChoose(choice: Choice): void;
}) {
  return (
    <div className={choice !== undefined ? "conflict-card resolved" : "conflict-card"}>
      <div className="conflict-card-head">
        <span>ぶつかった変更</span>
        {choice !== undefined && (
          <span className="conflict-card-resolved-tag">
            {choice === "ours"
              ? "あなたの変更を採用"
              : choice === "theirs"
                ? "相手の変更を採用"
                : "両方を採用"}
          </span>
        )}
      </div>
      <div className="conflict-sides">
        <Side
          label="あなたの変更"
          md={block.ours}
          selected={choice === "ours"}
          onSelect={() => onChoose("ours")}
        />
        <Side
          label="相手の変更"
          md={block.theirs}
          selected={choice === "theirs"}
          onSelect={() => onChoose("theirs")}
        />
      </div>
      <div className="conflict-both-row">
        <button
          type="button"
          className={choice === "both" ? "conflict-both-btn selected" : "conflict-both-btn"}
          onClick={() => onChoose("both")}
        >
          両方を残す（あなた → 相手）
        </button>
      </div>
    </div>
  );
}

function Side({
  label,
  md,
  selected,
  onSelect,
}: {
  label: string;
  md: string;
  selected: boolean;
  onSelect(): void;
}) {
  const empty = md.trim() === "";
  return (
    <div
      className={selected ? "conflict-side selected" : "conflict-side"}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="conflict-side-label">
        <span className="conflict-side-radio" aria-hidden="true" />
        {label}
      </div>
      {empty ? (
        <div className="conflict-side-body empty">（この部分を削除）</div>
      ) : (
        <MarkdownPreview className="conflict-side-body" md={md} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Read-only rendered markdown (renderPreviewHtml → dangerouslySetInnerHTML). */
function MarkdownPreview({ md, className }: { md: string; className: string }) {
  const html = useMemo(() => renderPreviewHtml(md), [md]);
  return (
    <div
      className={`${className} conflict-preview`}
      // renderPreviewHtml drops raw HTML in the source (safe default), so this
      // is trusted app-generated markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** First non-empty line of a block, truncated, for the collapsed summary. */
function summarize(md: string, max = 60): string {
  const line = md
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** The resolved markdown for one block given the user's choice. */
function blockResolvedMd(block: MergeBlock, choice: Choice | undefined): string {
  if (block.kind === "auto") return block.md;
  switch (choice) {
    case "theirs":
      return block.theirs;
    case "both":
      return [block.ours, block.theirs].filter((s) => s.trim() !== "").join("\n\n");
    case "ours":
    default:
      return block.ours;
  }
}
