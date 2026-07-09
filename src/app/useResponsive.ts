// Track C3 — responsive breakpoint hook (M8, INTERFACES.md §12.4).
//
// Single source of truth for the `max-width: 768px` breakpoint used across
// the shell (sidebar drawer, git-panel sheet, modal width). The same 768px
// literal lives in styles.css @media rules; keep them in lockstep.
//
// Pure logic (media-query string, initial match) is factored out so it can be
// unit-tested without a DOM (see useResponsive.test.ts).

import { useEffect, useState } from "react";

/** The one breakpoint below which the shell switches to its mobile layout. */
export const MOBILE_MAX_WIDTH = 768;

/** The media query the hook subscribes to. Exported for tests. */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/**
 * Whether the environment currently reports a mobile-width viewport.
 * Safe on the server / in non-DOM test envs (returns false when
 * `window.matchMedia` is unavailable).
 */
export function matchesMobile(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * Reactively track whether the viewport is at mobile width (≤768px).
 * Re-renders the caller when the breakpoint is crossed. Falls back to a
 * static `false` where `matchMedia` is missing (SSR / node tests).
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(matchesMobile);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Sync once in case the width changed between initial state and effect.
    setIsMobile(mql.matches);
    // Safari <14 only has the deprecated addListener; guard for both.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isMobile;
}
