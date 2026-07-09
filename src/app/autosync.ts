// Track C4 (M8) — in-app auto-sync (M7-M8-PLAN.md §2.5, INTERFACES.md §12.6).
//
// Scope (honest): OS-level background sync (BGTaskScheduler / WorkManager) is
// out of reach for Tauri today (README v2 backlog). What we do here is
// IN-APP auto-sync only:
//   - on launch (if a remote is configured and onLaunch is on) run one sync;
//   - optionally on an interval timer (intervalMin) — a SINGLE timer, never
//     busy-polling; disabled when intervalMin is null;
//   - a dirty worktree SKIPS auto-sync (we never auto-commit — that stays an
//     explicit user action);
//   - conflicts are reported back as state (a badge), NOT an auto-opened modal
//     (the user chooses when to resolve).
//
// Config lives in `.hakushi/config.json` (the gitignored per-workspace cache
// area, INTERFACES.md §5.3). It is read/written through the ordinary
// read_text_file / write_text_file commands with a `.hakushi/config.json`
// rel_path — that path passes the fs_commands path validation (dot-dirs are
// allowed) and never appears in the file tree (dot-dirs are skipped) or in git
// (.hakushi is gitignored).
//
// The pure pieces (parseConfig / mergeConfig / shouldAutoSyncOnLaunch) are
// fs-independent and unit-tested; startAutoSync wires them to the real
// workspace + gitSync.

import {
  credentialHas,
  gitRemoteGet,
  gitStatus,
  gitSync,
  readFile,
  writeFile,
  type SyncReport,
} from "./workspace";
import { hostFromSyncUrl } from "./sync-url";

// ---------------------------------------------------------------------------
// Config shape (INTERFACES.md §12.6)
// ---------------------------------------------------------------------------

export interface AutoSyncConfig {
  /** Run one sync at app launch when a remote is set. Default true. */
  onLaunch: boolean;
  /** Minutes between periodic syncs, or null to disable the timer. Default null. */
  intervalMin: number | null;
  /**
   * Sync automatically right after a commit. Default TRUE (INTERFACES.md
   * §12.6): without it, a commit looks like "done" but never reaches GitHub
   * until the user separately presses 同期 — the exact confusion reported in
   * the field. App wires this to its MANUAL sync path post-commit, so the
   * outcome (pushed / token missing) is always visible in the status line.
   */
  afterCommit: boolean;
}

/** The whole `.hakushi/config.json` document (only autoSync today). */
export interface HakushiConfig {
  autoSync: AutoSyncConfig;
}

export const DEFAULT_AUTO_SYNC: AutoSyncConfig = {
  onLaunch: true,
  intervalMin: null,
  afterCommit: true,
};

const CONFIG_REL_PATH = ".hakushi/config.json";

// ---------------------------------------------------------------------------
// Pure config helpers (unit-tested)
// ---------------------------------------------------------------------------

function coerceIntervalMin(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  // Guard against absurd values; clamp to a sane floor of 1 minute.
  return Math.max(1, Math.floor(v));
}

/**
 * Parse a raw config JSON string into a fully-populated AutoSyncConfig,
 * tolerating missing keys / wrong types / invalid JSON (any of which fall back
 * to defaults). Never throws.
 */
export function parseConfig(raw: string | null): AutoSyncConfig {
  if (raw === null) return { ...DEFAULT_AUTO_SYNC };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_AUTO_SYNC };
  }
  if (typeof doc !== "object" || doc === null) return { ...DEFAULT_AUTO_SYNC };
  const as = (doc as { autoSync?: unknown }).autoSync;
  if (typeof as !== "object" || as === null) return { ...DEFAULT_AUTO_SYNC };
  const o = as as Record<string, unknown>;
  return {
    onLaunch: typeof o.onLaunch === "boolean" ? o.onLaunch : DEFAULT_AUTO_SYNC.onLaunch,
    intervalMin:
      "intervalMin" in o ? coerceIntervalMin(o.intervalMin) : DEFAULT_AUTO_SYNC.intervalMin,
    afterCommit:
      typeof o.afterCommit === "boolean" ? o.afterCommit : DEFAULT_AUTO_SYNC.afterCommit,
  };
}

/** Merge a partial update onto an existing config (for the settings form). */
export function mergeConfig(
  base: AutoSyncConfig,
  patch: Partial<AutoSyncConfig>,
): AutoSyncConfig {
  return {
    onLaunch: patch.onLaunch ?? base.onLaunch,
    intervalMin:
      "intervalMin" in patch ? coerceIntervalMin(patch.intervalMin) : base.intervalMin,
    afterCommit: patch.afterCommit ?? base.afterCommit,
  };
}

/** Serialize a config to the canonical `.hakushi/config.json` document text. */
export function serializeConfig(config: AutoSyncConfig): string {
  const doc: HakushiConfig = { autoSync: config };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Pure launch decision: should we auto-sync now? Requires onLaunch on, a
 * configured remote, and a clean worktree (never auto-commit).
 */
export function shouldAutoSyncOnLaunch(args: {
  config: AutoSyncConfig;
  hasRemote: boolean;
  dirty: boolean;
}): boolean {
  return args.config.onLaunch && args.hasRemote && !args.dirty;
}

// ---------------------------------------------------------------------------
// I/O helpers (real workspace)
// ---------------------------------------------------------------------------

/** Read `.hakushi/config.json`, falling back to defaults if absent/unreadable. */
export async function readAutoSyncConfig(root: string): Promise<AutoSyncConfig> {
  let raw: string | null = null;
  try {
    raw = await readFile(root, CONFIG_REL_PATH);
  } catch {
    // Missing file (first run) or unreadable → defaults.
    raw = null;
  }
  return parseConfig(raw);
}

/** Persist `.hakushi/config.json` (creates `.hakushi/` as needed). */
export async function writeAutoSyncConfig(
  root: string,
  config: AutoSyncConfig,
): Promise<void> {
  await writeFile(root, CONFIG_REL_PATH, serializeConfig(config));
}

// ---------------------------------------------------------------------------
// Sync runner
// ---------------------------------------------------------------------------

/** Result of one auto-sync attempt, for the caller to reflect in the UI. */
export type AutoSyncResult =
  | {
      kind: "skipped";
      reason: "no-remote" | "no-credentials" | "dirty" | "disabled" | "busy";
    }
  | { kind: "synced"; report: SyncReport }
  | { kind: "error"; message: string };

/**
 * One guarded auto-sync pass: bail (skipped) if no remote or the worktree is
 * dirty; otherwise call gitSync and hand back the report. Never throws — a
 * failed sync becomes an { kind: "error" } (the UI shows it in the status line,
 * not a modal, per §2.5).
 */
export async function runAutoSync(root: string): Promise<AutoSyncResult> {
  let remote: string | null;
  try {
    remote = await gitRemoteGet(root);
  } catch {
    remote = null;
  }
  if (remote === null) return { kind: "skipped", reason: "no-remote" };

  // No stored credential for the remote's host → skip QUIETLY instead of
  // erroring. On the web the PAT is session-only (never persisted), so every
  // reload starts without one — a launch auto-sync must not greet the user
  // with a red error banner for that.
  const host = hostFromSyncUrl(remote);
  if (host !== null) {
    try {
      if (!(await credentialHas(host))) {
        return { kind: "skipped", reason: "no-credentials" };
      }
    } catch {
      return { kind: "skipped", reason: "no-credentials" };
    }
  }

  // Dirty worktree → skip (we never auto-commit).
  try {
    const status = await gitStatus(root);
    if (status.length > 0) return { kind: "skipped", reason: "dirty" };
  } catch {
    // If status is unavailable, be conservative and skip.
    return { kind: "skipped", reason: "dirty" };
  }

  try {
    const report = await gitSync(root);
    return { kind: "synced", report };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Controller (launch sync + single interval timer, zero busy-polling)
// ---------------------------------------------------------------------------

export interface AutoSyncController {
  /** Update the config (e.g. after the settings form saves) → re-arm timer. */
  setConfig(config: AutoSyncConfig): void;
  /** Trigger one pass immediately (used by the afterCommit hook). */
  triggerNow(): void;
  /** Stop the timer and prevent further passes. */
  stop(): void;
}

/**
 * Start in-app auto-sync for a workspace. Runs an optional launch sync and
 * arms a single interval timer when intervalMin is set. `onResult` receives
 * every pass's outcome so App can update its status line / conflict badge.
 *
 * The controller is created synchronously and returned immediately; the
 * launch pass runs asynchronously. Overlapping passes are prevented with an
 * in-flight guard (returns { skipped, busy }).
 */
export function startAutoSync(
  root: string,
  config: AutoSyncConfig,
  onResult: (result: AutoSyncResult) => void,
): AutoSyncController {
  let current = config;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const pass = async (): Promise<void> => {
    if (stopped || inFlight) {
      if (inFlight) onResult({ kind: "skipped", reason: "busy" });
      return;
    }
    inFlight = true;
    try {
      const result = await runAutoSync(root);
      if (!stopped) onResult(result);
    } finally {
      inFlight = false;
    }
  };

  const armTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (current.intervalMin !== null && !stopped) {
      timer = setInterval(() => void pass(), current.intervalMin * 60_000);
    }
  };

  // Launch pass (fire-and-forget). onLaunch gating is inside the config check;
  // runAutoSync additionally enforces remote/dirty, so the effective decision
  // matches shouldAutoSyncOnLaunch.
  if (current.onLaunch) void pass();
  armTimer();

  return {
    setConfig(next: AutoSyncConfig) {
      current = next;
      armTimer();
    },
    triggerNow() {
      void pass();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
