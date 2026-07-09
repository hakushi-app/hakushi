// Track S2 — unit tests for the credential-host parser (M7, PLAN §1.3).
//
// hostFromSyncUrl decides the keyring account name from whatever the user typed
// into the remote-URL field. Only http(s) remotes need a PAT; file:// remotes
// and plain local paths return null (no credential required). The returned host
// must match the Rust keyring key: bare hostname, lowercased, no port.

import { describe, expect, it } from "vitest";

import { hostFromSyncUrl } from "./sync-url";

describe("hostFromSyncUrl", () => {
  it("returns the bare host for https URLs", () => {
    expect(hostFromSyncUrl("https://github.com/me/repo.git")).toBe("github.com");
    expect(hostFromSyncUrl("http://example.org/x.git")).toBe("example.org");
  });

  it("lowercases the host (keychain key is case-insensitive host)", () => {
    expect(hostFromSyncUrl("https://GitHub.COM/me/repo.git")).toBe("github.com");
  });

  it("drops the port (account name is the bare hostname)", () => {
    expect(hostFromSyncUrl("https://gitlab.example.com:8443/g/r.git")).toBe(
      "gitlab.example.com",
    );
  });

  it("keeps subdomains and userinfo out of the host", () => {
    expect(hostFromSyncUrl("https://x-token@git.example.com/r.git")).toBe(
      "git.example.com",
    );
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(hostFromSyncUrl("  https://github.com/me/repo.git  ")).toBe("github.com");
  });

  it("returns null for file:// remotes (no PAT needed)", () => {
    expect(hostFromSyncUrl("file:///Users/me/repo")).toBeNull();
  });

  it("returns null for plain local paths (no PAT needed)", () => {
    expect(hostFromSyncUrl("/Users/me/repo")).toBeNull();
    expect(hostFromSyncUrl("../sibling-repo")).toBeNull();
  });

  it("returns null for ssh-style remotes (out of M7 scope)", () => {
    // git@github.com:me/repo.git is not http(s) → no keychain PAT.
    expect(hostFromSyncUrl("git@github.com:me/repo.git")).toBeNull();
    expect(hostFromSyncUrl("ssh://git@github.com/me/repo.git")).toBeNull();
  });

  it("returns null for empty / whitespace / garbage input", () => {
    expect(hostFromSyncUrl("")).toBeNull();
    expect(hostFromSyncUrl("   ")).toBeNull();
    expect(hostFromSyncUrl("https://")).toBeNull();
    expect(hostFromSyncUrl("not a url")).toBeNull();
  });
});
