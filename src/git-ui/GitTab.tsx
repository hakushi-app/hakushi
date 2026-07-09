// Track T3 — the "Git" tab of the right panel (formerly the whole GitPanel
// body, M4 / INTERFACES.md §7.3; extracted unchanged when the panel became a
// tab container for M6 §10.3).
//
// Three sections:
//   ① 変更   — worktree status list + commit message + コミット
//   ② 履歴   — commits touching the current page; clicking one shows the
//              semantic diff vs the file's previous version (semantic-diff.ts)
//              rendered as a Japanese operation list, plus 「この版に戻す」
//   ③ ブランチ — current branch, switch select, create+switch. Backend
//              errors (gix checkout Unsupported, dirty worktree) surface here.
//
// All git access goes through the workspace.ts wrappers, so the tab works
// both inside Tauri (libgit2/gix) and in the browser (tauri-mock pseudo git).

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { capabilityNotice, isOpSupported } from "../app/capabilities";
import {
  gitBranches,
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitFileAtCommit,
  gitLog,
  gitRevertFile,
  gitStatus,
  type GitBackendInfo,
  type GitBranchInfo,
  type GitCommitInfo,
  type GitStatusEntry,
} from "../app/workspace";
import { semanticDiff, type BlockChange } from "./semantic-diff";

const LOG_LIMIT = 50;

const STATUS_LABELS: Record<string, string> = {
  new: "追加",
  modified: "変更",
  deleted: "削除",
  renamed: "改名",
  conflicted: "競合",
};

export interface GitTabProps {
  root: string;
  /** Currently open page (rel path), or null — drives the 履歴 section. */
  currentFile: string | null;
  /**
   * Called after the worktree content changed underneath the app (revert /
   * branch checkout) so the editor and tree can reload. `relPath` is the
   * reverted page, or "" when the change is not tied to one page (checkout).
   */
  onReverted(relPath: string): void;
  /** Bump to re-read status/history (e.g. after an editor save or 更新). */
  refreshToken: number;
  /** Backend report from the single startup fetch (§12.5). */
  backendInfo: GitBackendInfo;
  /** Called after a successful commit (App wires the afterCommit auto-sync). */
  onCommitted?(): void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function snippet(md: string, max = 160): string {
  const oneBlock = md.trim();
  return oneBlock.length <= max ? oneBlock : `${oneBlock.slice(0, max)}…`;
}

export function GitTab({
  root,
  currentFile,
  onReverted,
  refreshToken,
  backendInfo,
  onCommitted,
}: GitTabProps) {
  // §12.5: unified, non-engineer wording for the capability-gated branch
  // switch (gix/mobile reports branch=false → "checkout" is unsupported).
  const canBranch = isOpSupported(backendInfo, "checkout");
  const branchNotice = capabilityNotice(backendInfo, "checkout");
  // ① 変更
  const [status, setStatus] = useState<GitStatusEntry[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  // ② 履歴
  const [history, setHistory] = useState<GitCommitInfo[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [diff, setDiff] = useState<BlockChange[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  // ③ ブランチ
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await gitStatus(root));
      setStatusError(null);
    } catch (e) {
      setStatusError(errMsg(e));
    }
  }, [root]);

  const refreshHistory = useCallback(async () => {
    if (currentFile === null) {
      setHistory([]);
      setHistoryError(null);
      return;
    }
    try {
      setHistory(await gitLog(root, currentFile, LOG_LIMIT));
      setHistoryError(null);
    } catch (e) {
      setHistoryError(errMsg(e));
    }
  }, [root, currentFile]);

  const refreshBranches = useCallback(async () => {
    try {
      setBranchInfo(await gitBranches(root));
    } catch (e) {
      setBranchError(errMsg(e));
    }
  }, [root]);

  useEffect(() => {
    void refreshStatus();
    void refreshBranches();
  }, [refreshStatus, refreshBranches, refreshToken]);

  // History follows the open page; drop the diff selection when it changes.
  useEffect(() => {
    setSelectedOid(null);
    setDiff(null);
    setDiffError(null);
    void refreshHistory();
  }, [refreshHistory, refreshToken]);

  // -------------------------------------------------------------------------
  // ① 変更 — commit
  // -------------------------------------------------------------------------

  const doCommit = useCallback(async () => {
    const msg = message.trim();
    if (msg === "") return;
    setCommitting(true);
    try {
      await gitCommit(root, msg);
      setMessage("");
      setStatusError(null);
      await Promise.all([refreshStatus(), refreshHistory()]);
      onCommitted?.();
    } catch (e) {
      setStatusError(errMsg(e));
    } finally {
      setCommitting(false);
    }
  }, [root, message, refreshStatus, refreshHistory, onCommitted]);

  // -------------------------------------------------------------------------
  // ② 履歴 — semantic diff vs the file's previous version + revert
  // -------------------------------------------------------------------------

  const selectCommit = useCallback(
    async (index: number) => {
      if (currentFile === null) return;
      const commit = history[index];
      if (commit === undefined) return;
      if (selectedOid === commit.oid) {
        setSelectedOid(null); // toggle closed
        setDiff(null);
        setDiffError(null);
        return;
      }
      setSelectedOid(commit.oid);
      setDiff(null);
      setDiffError(null);
      setDiffBusy(true);
      try {
        const after = (await gitFileAtCommit(root, currentFile, commit.oid)) ?? "";
        // Previous version of THIS file = next entry in the path-filtered log.
        const parent = history[index + 1];
        const before =
          parent === undefined
            ? ""
            : ((await gitFileAtCommit(root, currentFile, parent.oid)) ?? "");
        setDiff(semanticDiff(before, after));
      } catch (e) {
        setDiffError(errMsg(e));
      } finally {
        setDiffBusy(false);
      }
    },
    [root, currentFile, history, selectedOid],
  );

  const revertTo = useCallback(
    async (oid: string) => {
      if (currentFile === null) return;
      setDiffBusy(true);
      setDiffError(null);
      try {
        await gitRevertFile(root, currentFile, oid);
        onReverted(currentFile);
        await refreshStatus();
      } catch (e) {
        setDiffError(errMsg(e));
      } finally {
        setDiffBusy(false);
      }
    },
    [root, currentFile, onReverted, refreshStatus],
  );

  // -------------------------------------------------------------------------
  // ③ ブランチ — switch / create+switch
  // -------------------------------------------------------------------------

  const checkout = useCallback(
    async (name: string) => {
      if (branchInfo !== null && name === branchInfo.current) return;
      setBranchBusy(true);
      setBranchError(null);
      try {
        await gitCheckoutBranch(root, name);
        // Worktree files changed under the app: reload editor + tree.
        onReverted(currentFile ?? "");
        await Promise.all([refreshBranches(), refreshStatus(), refreshHistory()]);
      } catch (e) {
        setBranchError(errMsg(e));
        await refreshBranches();
      } finally {
        setBranchBusy(false);
      }
    },
    [root, branchInfo, currentFile, onReverted, refreshBranches, refreshStatus, refreshHistory],
  );

  const createAndSwitch = useCallback(async () => {
    const name = newBranch.trim();
    if (name === "") return;
    setBranchBusy(true);
    setBranchError(null);
    try {
      await gitCreateBranch(root, name);
      // Same snapshot, so no editor reload is needed on success; a gix
      // Unsupported error from checkout is surfaced below.
      await gitCheckoutBranch(root, name);
      setNewBranch("");
      await refreshBranches();
    } catch (e) {
      setBranchError(errMsg(e));
      await refreshBranches();
    } finally {
      setBranchBusy(false);
    }
  }, [root, newBranch, refreshBranches]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <>
      {/* ① 変更 */}
      <section className="git-section">
        <h3>変更</h3>
        {statusError !== null && (
          <div className="git-error" role="alert">
            {statusError}
          </div>
        )}
        {status.length === 0 ? (
          <p className="git-empty">変更はありません</p>
        ) : (
          <ul className="git-status-list">
            {status.map((entry) => (
              <li key={entry.relPath}>
                <span className={`git-status-tag git-status-${entry.status}`}>
                  {STATUS_LABELS[entry.status] ?? entry.status}
                </span>
                <span className="git-status-path" title={entry.relPath}>
                  {entry.relPath}
                </span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          className="git-commit-message"
          placeholder="コミットメッセージ"
          value={message}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          type="button"
          className="git-commit-btn"
          disabled={committing || status.length === 0 || message.trim() === ""}
          onClick={() => void doCommit()}
        >
          コミット
        </button>
      </section>

      {/* ② 履歴 */}
      <section className="git-section">
        <h3>履歴{currentFile !== null ? `（${currentFile}）` : ""}</h3>
        {historyError !== null && (
          <div className="git-error" role="alert">
            {historyError}
          </div>
        )}
        {currentFile === null ? (
          <p className="git-empty">ページを開くと履歴が表示されます</p>
        ) : history.length === 0 ? (
          <p className="git-empty">このページのコミットはまだありません</p>
        ) : (
          <ul className="git-history-list">
            {history.map((commit, i) => (
              <li key={commit.oid}>
                <button
                  type="button"
                  className={
                    selectedOid === commit.oid
                      ? "git-history-item selected"
                      : "git-history-item"
                  }
                  onClick={() => void selectCommit(i)}
                >
                  <span className="git-history-summary" title={commit.summary}>
                    {commit.summary}
                  </span>
                  <span className="git-history-meta">
                    {formatTime(commit.timestamp)} · {commit.authorName} ·{" "}
                    {commit.oid.slice(0, 7)}
                  </span>
                </button>
                {selectedOid === commit.oid && (
                  <div className="git-diff">
                    {diffBusy && <p className="git-empty">読み込み中…</p>}
                    {diffError !== null && (
                      <div className="git-error" role="alert">
                        {diffError}
                      </div>
                    )}
                    {diff !== null &&
                      (diff.length === 0 ? (
                        <p className="git-empty">このページ内容への変更はありません</p>
                      ) : (
                        <ul className="git-diff-list">
                          {diff.map((change, j) => (
                            <ChangeItem key={j} change={change} />
                          ))}
                        </ul>
                      ))}
                    <button
                      type="button"
                      className="git-revert-btn"
                      disabled={diffBusy}
                      onClick={() => void revertTo(commit.oid)}
                    >
                      この版に戻す
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ③ ブランチ */}
      <section className="git-section">
        <h3>ブランチ</h3>
        {!canBranch && branchNotice !== null && (
          <p className="git-empty">{branchNotice}</p>
        )}
        {branchError !== null && (
          <div className="git-error" role="alert">
            {branchError}
          </div>
        )}
        {branchInfo !== null && (
          <>
            <label className="git-branch-label">
              現在: <strong>{branchInfo.current ?? "（未確定 HEAD）"}</strong>
            </label>
            <select
              className="git-branch-select"
              value={branchInfo.current ?? ""}
              disabled={branchBusy || branchInfo.branches.length === 0}
              onChange={(e) => void checkout(e.target.value)}
            >
              {branchInfo.current === null && <option value="">（選択）</option>}
              {branchInfo.branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <div className="git-branch-create">
              <input
                type="text"
                placeholder="新しいブランチ名"
                value={newBranch}
                disabled={branchBusy}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createAndSwitch();
                }}
              />
              <button
                type="button"
                disabled={branchBusy || newBranch.trim() === ""}
                onClick={() => void createAndSwitch()}
              >
                作成して切替
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Semantic diff rendering (§7.2 BlockChange → Japanese op list)
// ---------------------------------------------------------------------------

function ChangeItem({ change }: { change: BlockChange }): ReactNode {
  switch (change.kind) {
    case "task-toggled":
      return (
        <li className="git-diff-op">
          <span className="git-diff-head">
            <span className="git-diff-icon">✅</span>
            タスク{change.done ? "完了" : "解除"}
          </span>
          <pre className="git-diff-snippet">{snippet(change.text)}</pre>
        </li>
      );
    case "moved":
      return (
        <li className="git-diff-op">
          <span className="git-diff-head">
            <span className="git-diff-icon">📦</span>
            移動（{change.fromSection ?? "—"} → {change.toSection ?? "—"}）
          </span>
          <pre className="git-diff-snippet">{snippet(change.text)}</pre>
        </li>
      );
    case "added":
      return (
        <li className="git-diff-op">
          <span className="git-diff-head">
            <span className="git-diff-icon">＋</span>追加
          </span>
          <pre className="git-diff-snippet git-diff-added">{snippet(change.block)}</pre>
        </li>
      );
    case "removed":
      return (
        <li className="git-diff-op">
          <span className="git-diff-head">
            <span className="git-diff-icon">−</span>削除
          </span>
          <pre className="git-diff-snippet git-diff-removed">{snippet(change.block)}</pre>
        </li>
      );
    case "modified":
      return (
        <li className="git-diff-op">
          <span className="git-diff-head">
            <span className="git-diff-icon">✏</span>変更
          </span>
          <pre className="git-diff-snippet git-diff-removed">{snippet(change.before)}</pre>
          <pre className="git-diff-snippet git-diff-added">{snippet(change.after)}</pre>
        </li>
      );
  }
}
