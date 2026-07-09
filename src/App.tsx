// Track U — app shell (M2, INTERFACES.md §5.1/§5.5/§5.6).
// Startup: ensure_default_workspace → open immediately (no folder picker),
// then build the link index in the background. The folder picker survives
// only as a secondary overflow-menu item (「別のフォルダを開く…」).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  readAutoSyncConfig,
  startAutoSync,
  type AutoSyncConfig,
  type AutoSyncController,
  type AutoSyncResult,
} from "./app/autosync";
import { CapabilitiesProvider } from "./app/capabilities";
import { Drawer } from "./app/Drawer";
import { FileTree } from "./app/FileTree";
import { buildIndex, updatePageInIndex } from "./app/link-index";
import { MobileChrome } from "./app/MobileChrome";
import { useIsMobile } from "./app/useResponsive";
import {
  collectDeleteImpact,
  createNewPage,
  createPageFromTemplate,
  deletePage,
  movePage,
} from "./app/page-ops";
import { baseNameRel, dirnameRel, findDirChildren, joinRel } from "./app/paths";
import { PublishMenuItem } from "./export/PublishMenuItem";
import { SyncSettings } from "./app/SyncSettings";
import { formatSyncTime, summarizeSyncReport } from "./app/sync-status";
import {
  ensureDefaultWorkspace,
  gitSync,
  listTree,
  openWorkspace,
  readFile,
  SYNC_CONFLICT_SOURCE,
  type SyncReport,
} from "./app/workspace";
import { EditorPane } from "./editor/EditorPane";
import { GitPanel } from "./git-ui/GitPanel";
import { BUNDLED_TEMPLATES } from "./templates-ui/bundled";

type IndexStatus = "idle" | "building" | "ready" | "error";

type ModalState =
  | { kind: "new-page"; dirRelPath: string }
  | { kind: "rename"; relPath: string; isDir: boolean }
  | { kind: "move"; relPath: string; isDir: boolean }
  | { kind: "delete"; relPath: string; isDir: boolean; refPages: number };

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

// M5 (INTERFACES.md §9.3): template choice in the new-page modal.
// "" = plain page, "bundled:<key>" = bundled, "user:<relPath>" = workspace
// templates/*.md.
type TemplateChoice = string;

interface UserTemplate {
  label: string;
  relPath: string;
}

function ensureMdExt(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

/** currentFile follow-up after a move/rename. */
function remapPath(p: string, fromRel: string, toRel: string, isDir: boolean): string {
  if (p === fromRel) return toRel;
  if (isDir && p.startsWith(`${fromRel}/`)) return toRel + p.slice(fromRel.length);
  return p;
}

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>("idle");
  const [treeToken, setTreeToken] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  // M5: user templates (workspace templates/*.md) for the new-page modal.
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  // M4 git UI (INTERFACES.md §7.3)
  const [gitOpen, setGitOpen] = useState(false);
  // M8 responsive (INTERFACES.md §12.4): sidebar off-canvas drawer on mobile.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Bumped after revert/checkout so <EditorPane key> remounts with the
  // restored on-disk content.
  const [editorReloadToken, setEditorReloadToken] = useState(0);
  // Bumped after every save so the git panel re-reads status/history.
  const [gitRefreshToken, setGitRefreshToken] = useState(0);
  // M7 sync (INTERFACES.md §11.5): settings modal + status line state.
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMs, setLastSyncMs] = useState<number | null>(null);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // M8 auto-sync (§2.5): conflict badge when a (manual or auto) sync reports
  // an unresolved code-branch conflict. Surfaced as state only — never an
  // auto-opened modal (the user chooses when to resolve).
  const [conflictPaths, setConflictPaths] = useState<string[]>([]);
  // When the user acts on the conflict badge, hand the sync sentinel to the
  // GitPanel, which opens the ConflictResolver (§12.3). Null = nothing pending.
  const [pendingConflictSource, setPendingConflictSource] = useState<string | null>(null);
  // Single in-app auto-sync controller (launch sync + optional interval timer).
  const autoSyncRef = useRef<AutoSyncController | null>(null);
  // Latest auto-sync config (for the afterCommit hook, §12.6).
  const autoSyncConfigRef = useRef<AutoSyncConfig | null>(null);

  const bumpTree = useCallback(() => setTreeToken((t) => t + 1), []);
  /** Worktree files changed → tree AND git status/history are stale. */
  const bumpWorktree = useCallback(() => {
    setTreeToken((t) => t + 1);
    setGitRefreshToken((t) => t + 1);
  }, []);

  const rebuildIndex = useCallback(async (root: string) => {
    setIndexStatus("building");
    try {
      await buildIndex(root);
      setIndexStatus("ready");
    } catch {
      setIndexStatus("error");
    }
  }, []);

  // Startup: auto-create/open the app-managed workspace. No picker.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    ensureDefaultWorkspace()
      .then((root) => {
        setWorkspaceRoot(root);
        void rebuildIndex(root); // fire-and-forget, status shown in sidebar
      })
      .catch((e: unknown) => {
        setBootError(e instanceof Error ? e.message : String(e));
      });
  }, [rebuildIndex]);

  /** Run a workspace operation with shared busy/error handling. */
  const run = useCallback(async (op: () => Promise<void>) => {
    setOpBusy(true);
    setOpError(null);
    try {
      await op();
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpBusy(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Page operations
  // -------------------------------------------------------------------------

  const handleCreateInDir = useCallback(
    async (dirRelPath: string) => {
      if (workspaceRoot === null) return;
      await run(async () => {
        const rel = await createNewPage(workspaceRoot, dirRelPath, "Untitled");
        bumpWorktree();
        setCurrentFile(rel);
      });
    },
    [workspaceRoot, run, bumpWorktree],
  );

  /** Open the new-page modal and (re)load the user template list (§9.3). */
  const openNewPageModal = useCallback(
    (dirRelPath: string) => {
      setOpError(null);
      setModal({ kind: "new-page", dirRelPath });
      if (workspaceRoot === null) return;
      listTree(workspaceRoot)
        .then((tree) => {
          const entries = findDirChildren(tree, "templates").filter(
            (e) => !e.isDir && /\.md$/i.test(e.name),
          );
          setUserTemplates(
            entries.map((e) => ({ label: stripMdExt(e.name), relPath: e.relPath })),
          );
        })
        .catch(() => setUserTemplates([]));
    },
    [workspaceRoot],
  );

  const submitNewPage = useCallback(
    async (title: string, template: TemplateChoice) => {
      if (workspaceRoot === null || modal?.kind !== "new-page") return;
      const dir = modal.dirRelPath;
      await run(async () => {
        let rel: string;
        if (template === "") {
          rel = await createNewPage(workspaceRoot, dir, title);
        } else {
          let raw: string;
          if (template.startsWith("bundled:")) {
            const key = template.slice("bundled:".length);
            const bundled = BUNDLED_TEMPLATES.find((t) => t.key === key);
            if (bundled === undefined) throw new Error(`unknown template: ${key}`);
            raw = bundled.raw;
          } else if (template.startsWith("user:")) {
            raw = await readFile(workspaceRoot, template.slice("user:".length));
          } else {
            throw new Error(`unknown template: ${template}`);
          }
          rel = await createPageFromTemplate(workspaceRoot, dir, title, raw);
        }
        bumpWorktree();
        setCurrentFile(rel);
        setModal(null);
      });
    },
    [workspaceRoot, modal, run, bumpWorktree],
  );

  const doMove = useCallback(
    async (fromRel: string, toRel: string, isDir: boolean) => {
      if (workspaceRoot === null) return;
      await run(async () => {
        await movePage(workspaceRoot, fromRel, toRel);
        setCurrentFile((p) => (p === null ? null : remapPath(p, fromRel, toRel, isDir)));
        bumpWorktree();
        setModal(null);
      });
    },
    [workspaceRoot, run, bumpWorktree],
  );

  const submitRename = useCallback(
    async (value: string) => {
      if (modal?.kind !== "rename") return;
      const name = value.trim();
      if (name === "" || name.includes("/")) {
        setOpError("名前に / は使えません");
        return;
      }
      const toRel = joinRel(
        dirnameRel(modal.relPath),
        modal.isDir ? name : ensureMdExt(name),
      );
      if (toRel === modal.relPath) {
        setModal(null);
        return;
      }
      await doMove(modal.relPath, toRel, modal.isDir);
    },
    [modal, doMove],
  );

  const submitMove = useCallback(
    async (value: string) => {
      if (modal?.kind !== "move") return;
      const toRel = value.trim().replace(/^\/+|\/+$/g, "");
      if (toRel === "") {
        setOpError("移動先パスを入力してください");
        return;
      }
      if (toRel === modal.relPath) {
        setModal(null);
        return;
      }
      await doMove(modal.relPath, toRel, modal.isDir);
    },
    [modal, doMove],
  );

  const requestDelete = useCallback(
    (relPath: string, isDir: boolean) => {
      if (workspaceRoot === null) return;
      void run(async () => {
        const impact = await collectDeleteImpact(workspaceRoot, relPath);
        const refPages = new Set(impact.backlinks.map((b) => b.srcRelPath)).size;
        setModal({ kind: "delete", relPath, isDir, refPages });
      });
    },
    [workspaceRoot, run],
  );

  const confirmDelete = useCallback(async () => {
    if (workspaceRoot === null || modal?.kind !== "delete") return;
    const { relPath, isDir } = modal;
    await run(async () => {
      await deletePage(workspaceRoot, relPath);
      setCurrentFile((p) =>
        p !== null && (p === relPath || (isDir && p.startsWith(`${relPath}/`)))
          ? null
          : p,
      );
      bumpWorktree();
      setModal(null);
    });
  }, [workspaceRoot, modal, run, bumpWorktree]);

  // -------------------------------------------------------------------------
  // Workspace switching / index
  // -------------------------------------------------------------------------

  const switchFolder = useCallback(() => {
    setMenuOpen(false);
    void run(async () => {
      const picked = await openWorkspace();
      if (picked === null || picked === workspaceRoot) return;
      setWorkspaceRoot(picked);
      setCurrentFile(null);
      bumpTree();
      void rebuildIndex(picked);
    });
  }, [workspaceRoot, run, bumpTree, rebuildIndex]);

  const reindex = useCallback(() => {
    setMenuOpen(false);
    if (workspaceRoot !== null) void rebuildIndex(workspaceRoot);
  }, [workspaceRoot, rebuildIndex]);

  // -------------------------------------------------------------------------
  // Git panel (M4): worktree content changed underneath the app
  // -------------------------------------------------------------------------

  const handleReverted = useCallback(
    (relPath: string) => {
      // Remount the editor so it reloads the restored bytes, refresh the tree
      // (branch checkout may add/remove pages), and keep the index fresh.
      setEditorReloadToken((t) => t + 1);
      bumpTree();
      if (workspaceRoot !== null && relPath !== "") {
        void readFile(workspaceRoot, relPath)
          .then((md) => updatePageInIndex(workspaceRoot, relPath, md))
          .catch(() => undefined);
      }
    },
    [workspaceRoot, bumpTree],
  );

  // -------------------------------------------------------------------------
  // Sync (M7, INTERFACES.md §11.5) — zero polling; sync only on user action.
  // -------------------------------------------------------------------------

  /** Reflect a completed SyncReport into the shared UI state (manual + auto). */
  const applySyncReport = useCallback(
    (report: SyncReport) => {
      setLastReport(report);
      setLastSyncMs(Date.now());
      setSyncError(null);
      // Conflicts (code branch) → badge; anything else clears it.
      setConflictPaths(
        report.branch.kind === "conflicts" ? report.branch.conflictPaths : [],
      );
      // Sync may have advanced the branch / collab refs → refresh the git
      // panel (status/history/issues/PRs) without any polling.
      setGitRefreshToken((t) => t + 1);
      // A fast-forward/merge changed on-disk bytes → reload the open editor.
      if (report.branch.kind === "fastForward" || report.branch.kind === "merged") {
        setEditorReloadToken((t) => t + 1);
        bumpTree();
      }
    },
    [bumpTree],
  );

  const runSync = useCallback(async () => {
    setMenuOpen(false);
    if (workspaceRoot === null || syncing) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const report = await gitSync(workspaceRoot);
      applySyncReport(report);
    } catch (e) {
      setLastReport(null);
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [workspaceRoot, syncing, applySyncReport]);

  // -------------------------------------------------------------------------
  // In-app auto-sync (M8, §2.5) — launch sync + optional interval timer, zero
  // busy-polling. Conflicts surface as a badge (state), never an auto-modal.
  // -------------------------------------------------------------------------
  const handleAutoSyncResult = useCallback(
    (result: AutoSyncResult) => {
      if (result.kind === "synced") {
        applySyncReport(result.report);
      } else if (result.kind === "error") {
        // Silent failure → status line only (no modal), per §2.5.
        setSyncError(result.message);
      }
      // "skipped" (no-remote / dirty / busy) is intentionally quiet.
    },
    [applySyncReport],
  );
  const autoSyncResultRef = useRef(handleAutoSyncResult);
  autoSyncResultRef.current = handleAutoSyncResult;

  useEffect(() => {
    if (workspaceRoot === null) return;
    let controller: AutoSyncController | null = null;
    let cancelled = false;
    void readAutoSyncConfig(workspaceRoot).then((config) => {
      if (cancelled) return;
      autoSyncConfigRef.current = config;
      controller = startAutoSync(workspaceRoot, config, (r) =>
        autoSyncResultRef.current(r),
      );
      autoSyncRef.current = controller;
    });
    return () => {
      cancelled = true;
      controller?.stop();
      if (autoSyncRef.current === controller) autoSyncRef.current = null;
    };
  }, [workspaceRoot]);

  /** Re-arm the auto-sync controller after the settings form saves. */
  const onAutoSyncConfigChange = useCallback((config: AutoSyncConfig) => {
    autoSyncConfigRef.current = config;
    autoSyncRef.current?.setConfig(config);
  }, []);

  /**
   * afterCommit hook (§12.6): a commit landed → sync right away unless the
   * user explicitly disabled it. Runs through the MANUAL sync path (not the
   * quiet auto-sync controller) so the outcome — pushed, or「トークンが
   * 未設定」 — always lands in the status line instead of a silent skip.
   */
  const handleCommitted = useCallback(() => {
    if (autoSyncConfigRef.current?.afterCommit !== false) {
      void runSync();
    }
  }, [runSync]);

  const openSyncSettings = useCallback(() => {
    setMenuOpen(false);
    setSyncSettingsOpen(true);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const syncStatus =
    lastReport !== null ? summarizeSyncReport(lastReport) : null;

  // On mobile, picking a page slides the sidebar drawer shut so the editor
  // takes the full screen. Desktop keeps the sidebar in place (no-op close).
  const selectFile = useCallback(
    (relPath: string) => {
      setCurrentFile(relPath);
      if (isMobile) setDrawerOpen(false);
    },
    [isMobile],
  );

  return (
    <CapabilitiesProvider>
      <div className="app-layout">
        <MobileChrome
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
        />
        <Drawer
          isMobile={isMobile}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          ariaLabel="サイドバー"
        >
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="app-title">白紙 Hakushi</span>
          <button
            type="button"
            className={gitOpen ? "git-toggle-btn active" : "git-toggle-btn"}
            aria-label="Git パネルを表示"
            aria-pressed={gitOpen}
            onClick={() => {
              setGitOpen((v) => !v);
              // On mobile the git panel is a full-screen sheet; slide the
              // sidebar drawer shut so it doesn't sit behind the sheet.
              if (isMobile) setDrawerOpen(false);
            }}
          >
            Git
          </button>
          <div className="sidebar-menu-wrap">
            <button
              type="button"
              className="icon-btn"
              aria-label="メニュー"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="menu-popup" role="menu">
                  <button role="menuitem" onClick={switchFolder}>
                    別のフォルダを開く…
                  </button>
                  <button
                    role="menuitem"
                    disabled={workspaceRoot === null || indexStatus === "building"}
                    onClick={reindex}
                  >
                    インデックス再構築
                  </button>
                  <button
                    role="menuitem"
                    disabled={workspaceRoot === null}
                    onClick={openSyncSettings}
                  >
                    同期設定…
                  </button>
                  <button
                    role="menuitem"
                    disabled={workspaceRoot === null || syncing}
                    onClick={() => void runSync()}
                  >
                    今すぐ同期
                  </button>
                  <PublishMenuItem
                    workspaceRoot={workspaceRoot}
                    onClose={() => setMenuOpen(false)}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          className="new-page-btn"
          disabled={workspaceRoot === null || opBusy}
          onClick={() => openNewPageModal("")}
        >
          ＋ 新規ページ
        </button>

        {indexStatus === "building" && (
          <div className="index-status">インデックス構築中…</div>
        )}
        {indexStatus === "error" && (
          <div className="index-status error">
            インデックス構築に失敗しました（メニューから再構築できます）
          </div>
        )}
        {opError !== null && modal === null && (
          <div className="op-error" role="alert">
            {opError}
          </div>
        )}

        {workspaceRoot !== null ? (
          <FileTree
            root={workspaceRoot}
            selected={currentFile}
            onSelect={selectFile}
            reloadToken={treeToken}
            onCreatePage={handleCreateInDir}
            onRenameEntry={(relPath, isDir) => {
              setOpError(null);
              setModal({ kind: "rename", relPath, isDir });
            }}
            onMoveEntry={(relPath, isDir) => {
              setOpError(null);
              setModal({ kind: "move", relPath, isDir });
            }}
            onDeleteEntry={requestDelete}
          />
        ) : (
          <p className="sidebar-empty">
            {bootError !== null
              ? `ワークスペースを開けませんでした: ${bootError}`
              : "ワークスペースを準備中…"}
          </p>
        )}

        {workspaceRoot !== null && (
          <div className="sync-status" aria-live="polite">
            <div className="sync-status-row">
              <button
                type="button"
                className="sync-now-btn"
                disabled={syncing}
                onClick={() => void runSync()}
              >
                {syncing && <span className="sync-spinner" aria-hidden="true" />}
                {syncing ? "同期中…" : "同期"}
              </button>
              {lastSyncMs !== null && !syncing && (
                <span className="sync-last-time">
                  最終同期 {formatSyncTime(lastSyncMs)}
                </span>
              )}
            </div>
            {syncError !== null && (
              <div className="sync-status-msg sync-status-error" role="alert">
                {syncError}
              </div>
            )}
            {syncError === null && syncStatus !== null && (
              <div className={`sync-status-msg sync-status-${syncStatus.level}`}>
                {syncStatus.text}
              </div>
            )}
            {conflictPaths.length > 0 && (
              <button
                type="button"
                className="sync-conflict-badge"
                onClick={() => {
                  // Open the git panel and hand it the sync sentinel so the
                  // ConflictResolver launches for the remote-tracking merge.
                  setGitOpen(true);
                  if (isMobile) setDrawerOpen(false);
                  setPendingConflictSource(SYNC_CONFLICT_SOURCE);
                }}
              >
                ⚠ コンフリクト {conflictPaths.length} 件（タップして解決）
              </button>
            )}
          </div>
        )}
      </aside>
        </Drawer>

      <main className="editor-area">
        {workspaceRoot !== null && currentFile !== null ? (
          <EditorPane
            key={`${currentFile}#${editorReloadToken}`}
            workspaceRoot={workspaceRoot}
            filePath={currentFile}
            onSaved={(relPath: string, markdown: string) => {
              // Keep the link index fresh after every save (§5.3).
              void updatePageInIndex(workspaceRoot, relPath, markdown).catch(
                () => undefined,
              );
              // Let the git panel re-read status/history.
              setGitRefreshToken((t) => t + 1);
            }}
            onNavigate={(relPath: string) => setCurrentFile(relPath)}
            onTemplateSaved={() => {
              // templates/ is a normal tree dir (§9.3) — show the new file.
              bumpTree();
              setGitRefreshToken((t) => t + 1);
            }}
          />
        ) : (
          <div className="editor-empty">
            <p>サイドバーからページを選ぶか、「＋ 新規ページ」で作成してください。</p>
          </div>
        )}
      </main>

      {gitOpen && workspaceRoot !== null && (
        <div className={isMobile ? "git-panel-sheet" : "git-panel-dock"}>
          {isMobile && (
            <button
              type="button"
              className="git-sheet-close"
              aria-label="Git パネルを閉じる"
              onClick={() => setGitOpen(false)}
            >
              ✕ 閉じる
            </button>
          )}
          <GitPanel
            root={workspaceRoot}
            currentFile={currentFile}
            onCommitted={handleCommitted}
            onReverted={(relPath) => {
              // A completed conflict resolution reaches here (source "") — the
              // code branch is merged, so clear the outstanding badge.
              if (relPath === "") setConflictPaths([]);
              handleReverted(relPath);
            }}
            refreshToken={gitRefreshToken}
            conflictSource={pendingConflictSource}
            onConflictSourceHandled={() => setPendingConflictSource(null)}
          />
        </div>
      )}

      {modal?.kind === "new-page" && (
        <NewPageModal
          userTemplates={userTemplates}
          busy={opBusy}
          error={opError}
          onSubmit={(title, template) => void submitNewPage(title, template)}
          onCancel={() => {
            setModal(null);
            setOpError(null);
          }}
        />
      )}
      {modal?.kind === "rename" && (
        <PromptModal
          title={modal.isDir ? "フォルダを改名" : "ページを改名"}
          label={`新しい名前（${modal.relPath}）`}
          initial={
            modal.isDir
              ? baseNameRel(modal.relPath)
              : stripMdExt(baseNameRel(modal.relPath))
          }
          submitLabel="改名"
          busy={opBusy}
          error={opError}
          onSubmit={(v) => void submitRename(v)}
          onCancel={() => {
            setModal(null);
            setOpError(null);
          }}
        />
      )}
      {modal?.kind === "move" && (
        <PromptModal
          title="移動"
          label="移動先パス（ワークスペース相対）"
          initial={modal.relPath}
          submitLabel="移動"
          busy={opBusy}
          error={opError}
          onSubmit={(v) => void submitMove(v)}
          onCancel={() => {
            setModal(null);
            setOpError(null);
          }}
        />
      )}
      {modal?.kind === "delete" && (
        <ConfirmModal
          title="削除"
          message={
            (modal.refPages > 0
              ? `${modal.refPages} ページがこの${modal.isDir ? "フォルダ内のページ" : "ページ"}を参照しています。`
              : "") + `「${modal.relPath}」を削除しますか？（git 履歴には残ります）`
          }
          confirmLabel="削除"
          busy={opBusy}
          error={opError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setModal(null);
            setOpError(null);
          }}
        />
      )}

      {syncSettingsOpen && workspaceRoot !== null && (
        <SyncSettings
          root={workspaceRoot}
          onClose={() => setSyncSettingsOpen(false)}
          onAutoSyncChange={onAutoSyncConfigChange}
        />
      )}
      </div>
    </CapabilitiesProvider>
  );
}

// ---------------------------------------------------------------------------
// Minimal modals (no window.prompt — inline inputs)
// ---------------------------------------------------------------------------

interface PromptModalProps {
  title: string;
  label: string;
  initial: string;
  placeholder?: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit(value: string): void;
  onCancel(): void;
}

function PromptModal({
  title,
  label,
  initial,
  placeholder,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onSubmit(value);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form className="modal" onSubmit={handleSubmit}>
        <h2>{title}</h2>
        <label className="modal-label">
          {label}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        {error !== null && (
          <div className="op-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

// M5 (§9.3): new-page modal with template picker (none / bundled / user).
interface NewPageModalProps {
  userTemplates: UserTemplate[];
  busy: boolean;
  error: string | null;
  onSubmit(title: string, template: TemplateChoice): void;
  onCancel(): void;
}

function NewPageModal({
  userTemplates,
  busy,
  error,
  onSubmit,
  onCancel,
}: NewPageModalProps) {
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<TemplateChoice>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onSubmit(title, template);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form className="modal" onSubmit={handleSubmit}>
        <h2>新規ページ</h2>
        <label className="modal-label">
          ページのタイトル
          <input
            ref={inputRef}
            type="text"
            value={title}
            placeholder="Untitled"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <label className="modal-label">
          テンプレート
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
            }}
          >
            <option value="">なし</option>
            <optgroup label="バンドル">
              {BUNDLED_TEMPLATES.map((t) => (
                <option key={t.key} value={`bundled:${t.key}`}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            {userTemplates.length > 0 && (
              <optgroup label="ユーザーテンプレート (templates/)">
                {userTemplates.map((t) => (
                  <option key={t.relPath} value={`user:${t.relPath}`}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {error !== null && (
          <div className="op-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={busy}>
            作成
          </button>
        </div>
      </form>
    </div>
  );
}

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal" role="alertdialog" aria-label={title}>
        <h2>{title}</h2>
        <p className="modal-message">{message}</p>
        {error !== null && (
          <div className="op-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
