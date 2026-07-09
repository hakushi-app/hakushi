// Track S2 — sync status line helpers (M7, PLAN §1.10 / INTERFACES.md §11.5).
//
// Pure functions so they are unit-testable; App.tsx renders the actual
// sidebar status line (last sync time / spinner / SyncReport message).

import type { SyncReport } from "./workspace";

export type SyncLevel = "ok" | "warn" | "error";

export interface SyncStatusMessage {
  level: SyncLevel;
  text: string;
}

/**
 * Human summary of a SyncReport for the sidebar status line.
 *
 * Conflicts are a warning, not an error: the sync itself ran — collab refs
 * are synced, only the code-branch push was skipped (PLAN §1.4). The
 * block-level resolution UI ships in M8 (PLAN §2.1), so we say so honestly
 * instead of pretending it exists.
 */
export function summarizeSyncReport(report: SyncReport): SyncStatusMessage {
  if (report.branch.kind === "conflicts") {
    return {
      level: "warn",
      text: `${report.message} Git パネルの「コンフリクトを解決…」から解決できます。`,
    };
  }
  return { level: "ok", text: report.message };
}

/** Local "HH:MM" (zero-padded) for the 最終同期 label. */
export function formatSyncTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
