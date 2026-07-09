// Track C4 (M8) — auto-sync settings section (M7-M8-PLAN.md §2.5).
//
// A small, self-contained form the integrator can slot into the 同期設定 modal
// (SyncSettings.tsx) or render standalone. It reads/writes `.hakushi/config.json`
// via the autosync helpers. No busy-polling, no Tauri-specific code here — the
// helpers pick the real workspace vs the dev mock automatically.

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_AUTO_SYNC,
  readAutoSyncConfig,
  writeAutoSyncConfig,
  type AutoSyncConfig,
} from "./autosync";

export interface AutoSyncSettingsProps {
  root: string;
  /** Notified after a successful save so App can re-arm its controller. */
  onChange?: (config: AutoSyncConfig) => void;
}

/** Interval choices offered in the UI (null = off). */
const INTERVAL_CHOICES: { label: string; value: number | null }[] = [
  { label: "自動 (オフ)", value: null },
  { label: "5 分ごと", value: 5 },
  { label: "15 分ごと", value: 15 },
  { label: "30 分ごと", value: 30 },
  { label: "60 分ごと", value: 60 },
];

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AutoSyncSettings({ root, onChange }: AutoSyncSettingsProps) {
  const [config, setConfig] = useState<AutoSyncConfig>(DEFAULT_AUTO_SYNC);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await readAutoSyncConfig(root);
        if (alive) setConfig(loaded);
      } catch (e) {
        if (alive) setError(errMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [root]);

  const persist = useCallback(
    async (next: AutoSyncConfig) => {
      setConfig(next);
      setSaved(false);
      setBusy(true);
      setError(null);
      try {
        await writeAutoSyncConfig(root, next);
        setSaved(true);
        onChange?.(next);
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [root, onChange],
  );

  if (loading) {
    return <p className="sync-loading">読み込み中…</p>;
  }

  return (
    <div className="autosync-settings">
      <h3 className="autosync-heading">自動同期</h3>

      <label className="autosync-row">
        <input
          type="checkbox"
          checked={config.onLaunch}
          disabled={busy}
          onChange={(e) => void persist({ ...config, onLaunch: e.target.checked })}
        />
        起動時に同期する
      </label>

      <label className="autosync-row">
        定期的に同期
        <select
          value={config.intervalMin === null ? "" : String(config.intervalMin)}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            void persist({ ...config, intervalMin: v });
          }}
        >
          {INTERVAL_CHOICES.map((c) => (
            <option key={c.label} value={c.value === null ? "" : String(c.value)}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="autosync-row">
        <input
          type="checkbox"
          checked={config.afterCommit}
          disabled={busy}
          onChange={(e) => void persist({ ...config, afterCommit: e.target.checked })}
        />
        コミット後に同期する
      </label>

      <p className="sync-hint">
        変更していないときのみ自動同期します。未保存・未コミットの変更があるときは
        自動的にコミットや同期はしません。
      </p>

      {error !== null && (
        <div className="op-error" role="alert">
          {error}
        </div>
      )}
      {saved && error === null && (
        <span className="sync-saved-badge">保存しました ✓</span>
      )}
    </div>
  );
}
