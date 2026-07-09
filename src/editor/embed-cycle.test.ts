// Track V — cycle/depth guard unit tests (INTERFACES.md §5.6).

import { describe, expect, it } from "vitest";

import { canRenderEmbed, MAX_EMBED_DEPTH } from "./embed-cycle";

describe("canRenderEmbed", () => {
  it("allows a fresh target under the depth limit", () => {
    expect(canRenderEmbed(["A.md"], "B.md")).toBe(true);
    expect(canRenderEmbed([], "A.md")).toBe(true);
  });

  it("rejects a target already in the chain (direct cycle)", () => {
    expect(canRenderEmbed(["A.md"], "A.md")).toBe(false);
  });

  it("rejects a target anywhere in the chain (indirect cycle)", () => {
    expect(canRenderEmbed(["A.md", "B.md", "C.md"], "A.md", 10)).toBe(false);
    expect(canRenderEmbed(["A.md", "B.md", "C.md"], "B.md", 10)).toBe(false);
  });

  it("rejects when the chain has reached maxDepth", () => {
    expect(canRenderEmbed(["A.md", "B.md"], "C.md", 2)).toBe(false);
    expect(canRenderEmbed(["A.md"], "B.md", 1)).toBe(false);
  });

  it("allows exactly up to the depth boundary", () => {
    expect(canRenderEmbed(["A.md"], "B.md", 2)).toBe(true);
    expect(canRenderEmbed(["A.md", "B.md"], "C.md", 3)).toBe(true);
  });

  it("defaults maxDepth to MAX_EMBED_DEPTH (3)", () => {
    expect(MAX_EMBED_DEPTH).toBe(3);
    expect(canRenderEmbed(["A.md", "B.md"], "C.md")).toBe(true);
    expect(canRenderEmbed(["A.md", "B.md", "C.md"], "D.md")).toBe(false);
  });
});
