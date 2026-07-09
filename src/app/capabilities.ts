// Track C3 — git capability context (M8, INTERFACES.md §12.5).
//
// `git_backend_info` is fetched ONCE here (App startup) and distributed via
// React context, replacing the per-panel fetches. On gix (mobile) several
// operations report `false` (checkout/merge/push); the UI must surface a
// single, non-engineer Japanese explanation instead of raw backend errors —
// see capabilityNotice() below.
//
// The value type re-uses GitBackendInfo from workspace.ts so there is exactly
// one shape for the backend report across the app.

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { gitBackendInfo, type GitBackendInfo } from "./workspace";

/**
 * Safe default used before the real `git_backend_info` resolves and whenever
 * the call fails (e.g. browser dev / plain vitest). Matches the tauri-mock
 * backend: local ops (branch/merge) work, remote ops (push/pull) do not.
 */
export const DEFAULT_BACKEND_INFO: GitBackendInfo = {
  name: "mock",
  capabilities: {
    init: true,
    status: true,
    commit: true,
    log: true,
    branch: true,
    merge: true,
    push: false,
    pull: false,
  },
};

const CapabilitiesContext = createContext<GitBackendInfo>(DEFAULT_BACKEND_INFO);

export interface CapabilitiesProviderProps {
  children: ReactNode;
}

/**
 * Fetches `git_backend_info` once on mount and provides it to the tree.
 * Never throws: on failure it keeps the mock-capability default so the UI
 * degrades to "everything looks available" rather than blocking.
 */
export function CapabilitiesProvider({ children }: CapabilitiesProviderProps) {
  const [info, setInfo] = useState<GitBackendInfo>(DEFAULT_BACKEND_INFO);

  useEffect(() => {
    let cancelled = false;
    gitBackendInfo()
      .then((real) => {
        if (!cancelled) setInfo(real);
      })
      .catch(() => {
        // Keep DEFAULT_BACKEND_INFO — do not surface as an error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return createElement(CapabilitiesContext.Provider, { value: info }, children);
}

/** The backend name + capability report from the single startup fetch. */
export function useCapabilities(): GitBackendInfo {
  return useContext(CapabilitiesContext);
}

// ---------------------------------------------------------------------------
// Unified non-engineer wording for capability-gated operations (§12.5).
// ---------------------------------------------------------------------------

/** Operations that can be gated by the active backend's capabilities. */
export type GatedOp = "checkout" | "merge" | "push" | "pull";

const OP_LABEL: Record<GatedOp, string> = {
  checkout: "ブランチの切替",
  merge: "ブランチのマージ",
  push: "変更のアップロード（送信）",
  pull: "変更のダウンロード（受信）",
};

/**
 * Whether the given operation is supported by the active backend. `checkout`
 * is folded into the `branch` capability (which means "create AND switch";
 * see M0-SPIKE-RESULTS.md §M4). `pull`/`push` map to their own flags.
 */
export function isOpSupported(info: GitBackendInfo, op: GatedOp): boolean {
  switch (op) {
    case "checkout":
      return info.capabilities.branch;
    case "merge":
      return info.capabilities.merge;
    case "push":
      return info.capabilities.push;
    case "pull":
      return info.capabilities.pull;
  }
}

/**
 * A single, consistent Japanese sentence explaining WHY an operation is
 * unavailable and WHAT to do — no jargon (no ours/theirs/HEAD/gix). Returns
 * null when the operation IS supported (nothing to say).
 *
 * Mobile (gix) is the driver: local edits + pull work, but switching
 * branches / merging / pushing must be done on the desktop app for now.
 */
export function capabilityNotice(info: GitBackendInfo, op: GatedOp): string | null {
  if (isOpSupported(info, op)) return null;
  return `この端末では${OP_LABEL[op]}は未対応です。PC 版 Hakushi をご利用ください。`;
}
