// Track C3 — pure-logic tests for the responsive breakpoint + capability
// wording helpers (M8, INTERFACES.md §12.4/§12.5). No DOM/React required:
// only the fs-independent, side-effect-free functions are exercised here.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BACKEND_INFO,
  capabilityNotice,
  isOpSupported,
  type GatedOp,
} from "./capabilities";
import type { GitBackendInfo } from "./workspace";
import {
  MOBILE_MAX_WIDTH,
  MOBILE_MEDIA_QUERY,
  matchesMobile,
} from "./useResponsive";

const libgit2: GitBackendInfo = {
  name: "libgit2",
  capabilities: {
    init: true,
    status: true,
    commit: true,
    log: true,
    branch: true,
    merge: true,
    push: true,
    pull: true,
  },
};

// gix (mobile): local edits + pull work; switching branches / merging /
// pushing are Unsupported (M0-SPIKE-RESULTS.md §M7).
const gix: GitBackendInfo = {
  name: "gix",
  capabilities: {
    init: true,
    status: true,
    commit: true,
    log: true,
    branch: false,
    merge: false,
    push: false,
    pull: true,
  },
};

describe("useResponsive breakpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a 768px max-width media query", () => {
    expect(MOBILE_MAX_WIDTH).toBe(768);
    expect(MOBILE_MEDIA_QUERY).toBe("(max-width: 768px)");
  });

  it("matchesMobile is false when matchMedia is unavailable (node env)", () => {
    // In the node test env there is no window.matchMedia.
    expect(matchesMobile()).toBe(false);
  });

  it("matchesMobile reflects the matchMedia result when present", () => {
    const calls: string[] = [];
    vi.stubGlobal("window", {
      matchMedia: (q: string) => {
        calls.push(q);
        return { matches: true };
      },
    });
    expect(matchesMobile()).toBe(true);
    expect(calls).toEqual([MOBILE_MEDIA_QUERY]);

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
    expect(matchesMobile()).toBe(false);
  });
});

describe("capability gating (§12.5)", () => {
  it("libgit2 (desktop) supports every gated op", () => {
    const ops: GatedOp[] = ["checkout", "merge", "push", "pull"];
    for (const op of ops) {
      expect(isOpSupported(libgit2, op)).toBe(true);
      expect(capabilityNotice(libgit2, op)).toBeNull();
    }
  });

  it("gix (mobile) gates checkout/merge/push but allows pull", () => {
    expect(isOpSupported(gix, "checkout")).toBe(false);
    expect(isOpSupported(gix, "merge")).toBe(false);
    expect(isOpSupported(gix, "push")).toBe(false);
    expect(isOpSupported(gix, "pull")).toBe(true);
  });

  it("checkout maps to the branch capability, not a separate flag", () => {
    // branch=false ⇒ checkout unsupported, even though other flags vary.
    expect(isOpSupported(gix, "checkout")).toBe(false);
    expect(isOpSupported(libgit2, "checkout")).toBe(true);
  });

  it("produces a jargon-free Japanese notice for each unsupported op", () => {
    for (const op of ["checkout", "merge", "push"] as GatedOp[]) {
      const notice = capabilityNotice(gix, op);
      expect(notice).not.toBeNull();
      // Non-engineer wording: no ours/theirs/HEAD/gix leaking through.
      expect(notice).not.toMatch(/ours|theirs|HEAD|gix|checkout/i);
      expect(notice).toContain("PC 版 Hakushi");
    }
    // Supported op ⇒ nothing to say.
    expect(capabilityNotice(gix, "pull")).toBeNull();
  });

  it("DEFAULT_BACKEND_INFO matches the browser-mock capability set", () => {
    // Safe default before git_backend_info resolves: local ops work, remote
    // ops do not (mirrors tauri-mock).
    expect(DEFAULT_BACKEND_INFO.name).toBe("mock");
    expect(isOpSupported(DEFAULT_BACKEND_INFO, "checkout")).toBe(true);
    expect(isOpSupported(DEFAULT_BACKEND_INFO, "merge")).toBe(true);
    expect(isOpSupported(DEFAULT_BACKEND_INFO, "push")).toBe(false);
    expect(isOpSupported(DEFAULT_BACKEND_INFO, "pull")).toBe(false);
  });
});
