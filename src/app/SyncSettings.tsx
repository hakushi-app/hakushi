// Track S2 — sync settings modal (M7, PLAN §1.3 / §1.10, INTERFACES.md §11.5).
//
// Two independent forms in one dialog:
//   1. Remote URL — loaded via gitRemoteGet on open, saved via gitRemoteSet.
//      A gix (mobile) backend may reject set with an Unsupported message; we
//      surface it verbatim instead of pretending it worked (PLAN §1.1).
//   2. PAT — saved via credentialSet(host-from-URL); the input clears on save
//      and never round-trips back (no credential_get exists, INTERFACES §11.2).
//      The 保存済み ✓ / 削除 state comes from credentialHas / credentialClear.
//
// The credential host is derived from the *saved* remote URL (hostFromSyncUrl):
// only http(s) remotes need a PAT, so file:// / local remotes hide the PAT form.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { AutoSyncSettings } from "./AutoSyncSettings";
import type { AutoSyncConfig } from "./autosync";
import {
  credentialClear,
  credentialHas,
  credentialSet,
  gitRemoteGet,
  gitRemoteSet,
} from "./workspace";
import { hostFromSyncUrl } from "./sync-url";

export interface SyncSettingsProps {
  root: string;
  onClose(): void;
  /** Notified when the auto-sync config is saved (App re-arms its controller). */
  onAutoSyncChange?: (config: AutoSyncConfig) => void;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SyncSettings({ root, onClose, onAutoSyncChange }: SyncSettingsProps) {
  // Remote URL form.
  const [urlInput, setUrlInput] = useState("");
  // The remote URL as currently persisted — drives which host the PAT form
  // targets. null until loaded / when no remote is set.
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlSaved, setUrlSaved] = useState(false);

  // PAT form.
  const [pat, setPat] = useState("");
  const [patBusy, setPatBusy] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);
  const [credStored, setCredStored] = useState(false);

  const [loading, setLoading] = useState(true);
  const urlRef = useRef<HTMLInputElement | null>(null);

  const host = savedUrl === null ? null : hostFromSyncUrl(savedUrl);

  /** Refresh the 保存済み ✓ state for the given host. */
  const refreshCredential = useCallback(async (h: string | null) => {
    if (h === null) {
      setCredStored(false);
      return;
    }
    try {
      setCredStored(await credentialHas(h));
    } catch {
      setCredStored(false);
    }
  }, []);

  // Load the current remote URL + PAT presence on open.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const url = await gitRemoteGet(root);
        if (!alive) return;
        setSavedUrl(url);
        setUrlInput(url ?? "");
        await refreshCredential(url === null ? null : hostFromSyncUrl(url));
      } catch (e) {
        if (alive) setUrlError(errMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [root, refreshCredential]);

  useEffect(() => {
    if (!loading) urlRef.current?.focus();
  }, [loading]);

  const saveUrl = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const url = urlInput.trim();
      if (url === "") {
        setUrlError("リモート URL を入力してください");
        return;
      }
      setUrlBusy(true);
      setUrlError(null);
      setUrlSaved(false);
      try {
        await gitRemoteSet(root, url);
        setSavedUrl(url);
        setUrlSaved(true);
        // The host may have changed → re-check the stored PAT.
        await refreshCredential(hostFromSyncUrl(url));
      } catch (e2) {
        // gix backends reject set with an Unsupported message — show it.
        setUrlError(errMessage(e2));
      } finally {
        setUrlBusy(false);
      }
    },
    [root, urlInput, refreshCredential],
  );

  const savePat = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (host === null) return;
      const token = pat.trim();
      if (token === "") {
        setPatError("トークンを入力してください");
        return;
      }
      setPatBusy(true);
      setPatError(null);
      try {
        await credentialSet(host, token);
        setPat(""); // never keep the token in component state
        setCredStored(true);
      } catch (e2) {
        setPatError(errMessage(e2));
      } finally {
        setPatBusy(false);
      }
    },
    [host, pat],
  );

  const clearPat = useCallback(async () => {
    if (host === null) return;
    setPatBusy(true);
    setPatError(null);
    try {
      await credentialClear(host);
      setCredStored(false);
    } catch (e2) {
      setPatError(errMessage(e2));
    } finally {
      setPatBusy(false);
    }
  }, [host]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal sync-modal" role="dialog" aria-label="同期設定">
        <h2>同期設定</h2>

        {loading ? (
          <p className="sync-loading">読み込み中…</p>
        ) : (
          <>
            {/* Remote URL */}
            <form className="sync-form" onSubmit={(e) => void saveUrl(e)}>
              <label className="modal-label">
                リモート URL
                <input
                  ref={urlRef}
                  type="text"
                  value={urlInput}
                  placeholder="https://github.com/you/repo.git"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setUrlSaved(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                  }}
                />
              </label>
              <p className="sync-hint">
                https:// または file:// / 絶対パスに対応します。
              </p>
              {urlError !== null && (
                <div className="op-error" role="alert">
                  {urlError}
                </div>
              )}
              <div className="sync-row-actions">
                {urlSaved && urlError === null && (
                  <span className="sync-saved-badge">保存しました ✓</span>
                )}
                <button type="submit" className="primary" disabled={urlBusy}>
                  リモートを保存
                </button>
              </div>
            </form>

            <hr className="sync-divider" />

            {/* PAT — only http(s) remotes need one. */}
            {host === null ? (
              <p className="sync-hint">
                {savedUrl === null
                  ? "リモートを保存すると、必要に応じてアクセストークンを設定できます。"
                  : "このリモートは認証トークンを必要としません（file:// / ローカルパス）。"}
              </p>
            ) : (
              <form className="sync-form" onSubmit={(e) => void savePat(e)}>
                <label className="modal-label">
                  アクセストークン（{host}）
                  <input
                    type="password"
                    value={pat}
                    placeholder={credStored ? "保存済み（変更する場合のみ入力）" : "ghp_…"}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setPat(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") onClose();
                    }}
                  />
                </label>
                <p className="sync-hint">
                  GitHub は Personal Access Token（PAT）を使います。トークンは OS
                  のキーチェーンに保存され、アプリの外へ出ません。
                </p>
                {patError !== null && (
                  <div className="op-error" role="alert">
                    {patError}
                  </div>
                )}
                <div className="sync-row-actions">
                  {credStored && (
                    <>
                      <span className="sync-saved-badge">保存済み ✓</span>
                      <button
                        type="button"
                        className="sync-clear-btn"
                        disabled={patBusy}
                        onClick={() => void clearPat()}
                      >
                        削除
                      </button>
                    </>
                  )}
                  <button type="submit" className="primary" disabled={patBusy}>
                    トークンを保存
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        <hr className="sync-divider" />

        {/* M8 (§2.5): in-app auto-sync settings (.hakushi/config.json). */}
        <AutoSyncSettings root={root} onChange={onAutoSyncChange} />

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
