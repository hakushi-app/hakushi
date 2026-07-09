// Track T3 — M6 right panel: tab container Git | Issues | PRs
// (INTERFACES.md §10.3).
//
// The exported name and props are unchanged from M4 (App.tsx mounts
// <GitPanel root currentFile onReverted refreshToken>); the former panel
// body now lives in GitTab.tsx, and the Issues / PRs tabs come from
// src/collab-ui. git_backend_info is fetched once here and passed down
// (GitTab shows the badge/branch capability, PrsTab gates the merge button).

import { useEffect, useState } from "react";

import { isOpSupported, useCapabilities } from "../app/capabilities";
import { gitBranches } from "../app/workspace";
import { IssuesTab } from "../collab-ui/IssuesTab";
import { PrsTab } from "../collab-ui/PrsTab";
import "../collab-ui/collab.css";
import { ConflictResolver } from "./ConflictResolver";
import { GitTab } from "./GitTab";

type TabKey = "git" | "issues" | "prs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "git", label: "Git" },
  { key: "issues", label: "Issues" },
  { key: "prs", label: "PRs" },
];

export interface GitPanelProps {
  root: string;
  /** Currently open page (rel path), or null — drives the 履歴 section. */
  currentFile: string | null;
  /**
   * Called after the worktree content changed underneath the app (revert /
   * branch checkout / PR merge / conflict resolution) so the editor and tree
   * can reload. `relPath` is the reverted page, or "" when the change is not
   * tied to one page.
   */
  onReverted(relPath: string): void;
  /** Bump to re-read status/history (e.g. after an editor save). */
  refreshToken?: number;
  /**
   * When a sync or merge outside this panel reports conflicts (M8, §12.3), the
   * integrator sets this to the incoming source (branch name, or a sync
   * sentinel). GitPanel opens the ConflictResolver automatically; clear it via
   * `onConflictSourceHandled`. Null / undefined = no pending conflict.
   */
  conflictSource?: string | null;
  /** Called once the pending `conflictSource` has been opened / dismissed. */
  onConflictSourceHandled?(): void;
  /**
   * Called after work landed as a commit (manual commit, conflict resolution)
   * — App wires the afterCommit auto-sync to this.
   */
  onCommitted?(): void;
}

export function GitPanel({
  root,
  currentFile,
  onReverted,
  refreshToken = 0,
  conflictSource = null,
  onConflictSourceHandled,
  onCommitted,
}: GitPanelProps) {
  const [tab, setTab] = useState<TabKey>("git");
  // 更新 button + post-merge reloads bump this; tabs re-read on the sum.
  const [localRefresh, setLocalRefresh] = useState(0);
  // Source the ConflictResolver modal is resolving (null = closed).
  const [resolving, setResolving] = useState<string | null>(null);
  // Self-service launcher: pick a source branch to resolve against.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [pickedSource, setPickedSource] = useState("");
  // M8 (§12.5): backend info comes from the single startup fetch in context,
  // not a per-panel fetch. Always non-null (mock default before/while loading).
  const backendInfo = useCapabilities();
  const canMerge = isOpSupported(backendInfo, "merge");

  // An externally-detected conflict (sync/merge in App.tsx) opens the resolver.
  useEffect(() => {
    if (conflictSource !== null && conflictSource !== undefined && resolving === null) {
      setResolving(conflictSource);
    }
  }, [conflictSource, resolving]);

  // Load branches for the self-service picker when it opens.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    gitBranches(root)
      .then((info) => {
        if (cancelled) return;
        setCurrent(info.current);
        const others = info.branches.filter((b) => b !== info.current);
        setBranches(others);
        setPickedSource(others[0] ?? "");
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, root]);

  const closeResolver = () => {
    setResolving(null);
    setPickerOpen(false);
    onConflictSourceHandled?.();
  };

  const effectiveToken = refreshToken + localRefresh;

  return (
    <aside className="git-panel" aria-label="Git パネル">
      <div className="git-panel-header">
        <span className="git-panel-title">Git</span>
        <span className="git-backend-badge">{backendInfo.name}</span>
        <button
          type="button"
          className="git-refresh-btn"
          onClick={() => setLocalRefresh((n) => n + 1)}
        >
          更新
        </button>
      </div>

      <div className="collab-tabs" role="tablist" aria-label="パネルタブ">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "collab-tab active" : "collab-tab"}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "git" && (
        <GitTab
          root={root}
          currentFile={currentFile}
          onReverted={onReverted}
          refreshToken={effectiveToken}
          backendInfo={backendInfo}
          onCommitted={onCommitted}
        />
      )}
      {tab === "issues" && <IssuesTab root={root} refreshToken={effectiveToken} />}
      {tab === "prs" && (
        <PrsTab
          root={root}
          currentFile={currentFile}
          refreshToken={effectiveToken}
          backendInfo={backendInfo}
          onMerged={() => {
            // Worktree + branches changed underneath the app; the merge is a
            // commit, so the afterCommit sync applies here too.
            onReverted("");
            setLocalRefresh((n) => n + 1);
            onCommitted?.();
          }}
        />
      )}

      {/* Conflict-resolution launcher (§12.3). Available whenever the backend
          can merge; opens the semantic ConflictResolver for a chosen branch.
          The integrator also drives it from a sync/merge conflict via the
          `conflictSource` prop. */}
      {canMerge && (
        <section className="git-section git-conflict-launcher">
          <h3>コンフリクトの解決</h3>
          {!pickerOpen ? (
            <button
              type="button"
              className="git-refresh-btn"
              onClick={() => setPickerOpen(true)}
            >
              コンフリクトを解決…
            </button>
          ) : branches.length === 0 ? (
            <p className="git-empty">
              取り込めるブランチがありません（現在: {current ?? "—"}）。
            </p>
          ) : (
            <div className="git-branch-create">
              <select
                className="git-branch-select"
                aria-label="取り込む変更元"
                value={pickedSource}
                onChange={(e) => setPickedSource(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={pickedSource === ""}
                onClick={() => setResolving(pickedSource)}
              >
                解決を開始
              </button>
            </div>
          )}
        </section>
      )}

      {resolving !== null && (
        <ConflictResolver
          root={root}
          source={resolving}
          onResolved={() => {
            // Merge committed: reload editor + tree, refresh panel, close.
            onReverted("");
            setLocalRefresh((n) => n + 1);
            closeResolver();
            onCommitted?.();
          }}
          onCancel={closeResolver}
        />
      )}
    </aside>
  );
}
