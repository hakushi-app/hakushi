// Track S3 — the ⋯ menu entry that publishes the workspace as a static site
// (M7-M8-PLAN.md §1.9, §1.10; INTERFACES.md §11.4/§11.5).
//
// Self-contained on purpose: App.tsx (owned by track S2 this round) was NOT
// briefed on this action, so instead of editing App.tsx's menu handlers we
// expose a drop-in component. At integration the ⋯ menu just renders:
//
//     <PublishMenuItem
//       workspaceRoot={workspaceRoot}
//       onClose={() => setMenuOpen(false)}
//     />
//
// inside the existing `.menu-popup` div — no other App.tsx wiring is needed.
// The component owns its own busy / result state and renders the menuitem
// button plus a small inline status line (no global toast dependency).
//
// Browser dev note: in a non-Tauri build publishSiteToFolder() writes nothing
// (there is no directory picker / fs) and returns null; we detect that path
// via isTauri() and show the generated file count instead, so the action is
// still demonstrable in the vite preview.

import { useCallback, useState } from "react";

import { isTauri } from "../app/workspace";
import { exportSite, publishSiteToFolder } from "./site";

export interface PublishMenuItemProps {
  /** Absolute workspace root, or null before a workspace is open. */
  workspaceRoot: string | null;
  /** Close the surrounding ⋯ menu (called after the flow settles). */
  onClose?: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/**
 * ⋯-menu item「静的サイトを書き出す…」. Picks a destination folder and writes
 * the whole workspace there as a static HTML site (one IPC via write_site_files).
 * In the browser dev mock it reports the file count instead of writing.
 */
export function PublishMenuItem({ workspaceRoot, onClose }: PublishMenuItemProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const publish = useCallback(async () => {
    if (workspaceRoot === null || status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      if (!isTauri()) {
        // Dev mock: nothing is written to disk; surface the count instead.
        const { files } = await exportSite(workspaceRoot);
        setStatus({
          kind: "done",
          message: `${files.length} 件のHTMLを生成しました（開発モードのため保存はされません）`,
        });
        return;
      }
      const dest = await publishSiteToFolder(workspaceRoot);
      if (dest === null) {
        // Dialog cancelled — quietly reset, close the menu.
        setStatus({ kind: "idle" });
        onClose?.();
        return;
      }
      setStatus({ kind: "done", message: `${dest} に書き出しました` });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [workspaceRoot, status.kind, onClose]);

  return (
    <>
      <button
        role="menuitem"
        disabled={workspaceRoot === null || status.kind === "busy"}
        onClick={() => {
          void publish();
        }}
      >
        {status.kind === "busy" ? "書き出し中…" : "静的サイトを書き出す…"}
      </button>
      {status.kind === "done" && (
        <div className="menu-status" role="status">
          {status.message}
        </div>
      )}
      {status.kind === "error" && (
        <div className="menu-status error" role="alert">
          書き出しに失敗しました: {status.message}
        </div>
      )}
    </>
  );
}
