// Track C4 (M8) — pure auto-sync config/decision tests (M7-M8-PLAN.md §2.5).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_SYNC,
  mergeConfig,
  parseConfig,
  serializeConfig,
  shouldAutoSyncOnLaunch,
  type AutoSyncConfig,
} from "./autosync";

describe("parseConfig", () => {
  it("returns defaults for null / invalid JSON / non-object", () => {
    expect(parseConfig(null)).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig("not json")).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig("42")).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig("null")).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig("[]")).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("returns defaults when autoSync key is missing or wrong type", () => {
    expect(parseConfig("{}")).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig('{"autoSync": 5}')).toEqual(DEFAULT_AUTO_SYNC);
    expect(parseConfig('{"autoSync": null}')).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("reads a full valid config", () => {
    const raw = JSON.stringify({
      autoSync: { onLaunch: false, intervalMin: 15, afterCommit: true },
    });
    expect(parseConfig(raw)).toEqual({
      onLaunch: false,
      intervalMin: 15,
      afterCommit: true,
    });
  });

  it("fills only the missing keys from defaults (partial config)", () => {
    expect(parseConfig('{"autoSync": {"onLaunch": false}}')).toEqual({
      onLaunch: false,
      intervalMin: null,
      afterCommit: true, // default (INTERFACES.md §12.6)
    });
    // An explicit false is preserved (users can opt out).
    expect(
      parseConfig('{"autoSync": {"afterCommit": false}}').afterCommit,
    ).toBe(false);
  });

  it("coerces invalid intervalMin to null and clamps/floors positive numbers", () => {
    expect(parseConfig('{"autoSync": {"intervalMin": 0}}').intervalMin).toBe(null);
    expect(parseConfig('{"autoSync": {"intervalMin": -3}}').intervalMin).toBe(null);
    expect(parseConfig('{"autoSync": {"intervalMin": "x"}}').intervalMin).toBe(null);
    expect(parseConfig('{"autoSync": {"intervalMin": 0.5}}').intervalMin).toBe(1);
    expect(parseConfig('{"autoSync": {"intervalMin": 12.9}}').intervalMin).toBe(12);
  });
});

describe("mergeConfig", () => {
  const base: AutoSyncConfig = { onLaunch: true, intervalMin: 30, afterCommit: false };

  it("overrides only provided keys", () => {
    expect(mergeConfig(base, { onLaunch: false })).toEqual({
      onLaunch: false,
      intervalMin: 30,
      afterCommit: false,
    });
  });

  it("distinguishes an explicit null intervalMin (off) from an untouched one", () => {
    expect(mergeConfig(base, { intervalMin: null }).intervalMin).toBe(null);
    expect(mergeConfig(base, {}).intervalMin).toBe(30);
  });
});

describe("serializeConfig", () => {
  it("round-trips through parseConfig", () => {
    const cfg: AutoSyncConfig = { onLaunch: false, intervalMin: 5, afterCommit: true };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it("ends with a single trailing newline", () => {
    const text = serializeConfig(DEFAULT_AUTO_SYNC);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("shouldAutoSyncOnLaunch", () => {
  const on: AutoSyncConfig = { onLaunch: true, intervalMin: null, afterCommit: false };
  const off: AutoSyncConfig = { onLaunch: false, intervalMin: null, afterCommit: false };

  it("requires onLaunch, a remote, and a clean worktree", () => {
    expect(shouldAutoSyncOnLaunch({ config: on, hasRemote: true, dirty: false })).toBe(true);
    expect(shouldAutoSyncOnLaunch({ config: off, hasRemote: true, dirty: false })).toBe(false);
    expect(shouldAutoSyncOnLaunch({ config: on, hasRemote: false, dirty: false })).toBe(false);
    // Never auto-sync (which could push half-work) with a dirty worktree.
    expect(shouldAutoSyncOnLaunch({ config: on, hasRemote: true, dirty: true })).toBe(false);
  });
});
