# ADR-0002: Dual git backend — git2/libgit2 on desktop, gix on mobile

- Status: Accepted
- Date: 2026-07-04

## Context

Git is Hakushi's storage and sync substrate, so it must build and run on all
five targets (macOS/Windows/Linux/iOS/Android). `git2-rs` (libgit2) has the
most mature merge/push implementation, but its OpenSSL dependency is a known
cross-compilation trap on iOS/Android. `gix` (gitoxide) is pure Rust and,
with rustls, builds on every Cargo-supported target — but its push/merge
surface is historically weaker than libgit2's.

## Decision

1. Abstract everything behind `trait GitBackend`
   (`src-tauri/src/git/backend.rs`): clone/commit/branch/diff/merge/status/
   push/pull/fetch plus custom-ref read/write. Upper layers never see the
   implementation.
2. **Desktop** uses `Libgit2Backend` (cargo feature `git-libgit2`, the
   default). **Mobile** uses `GixBackend` (feature `git-gix`,
   `--no-default-features`), pure Rust + rustls, avoiding the OpenSSL
   cross-compile entirely.
3. Network features (https/ssh) stay **off in both backends until M7**;
   M0–M6 need local operations only.
4. Backends report `capabilities()` honestly; the app does **runtime
   capability detection** and degrades gracefully. If gix push/fetch proves
   insufficient at M7, the fallback plan is **isomorphic-git (JS)** for
   push/fetch and an mdast-level 3-way merge for merging.

## Consequences

- Mobile git buildability was the project's top risk; it is retired at M0 by
  CI `cargo check` gates for `aarch64-apple-ios` and `aarch64-linux-android`
  with `--features git-gix`.
- Two backends must be kept behaviorally aligned (shared trait tests).
- Feature flags mean desktop and mobile binaries compile different code; CI
  checks all feature combinations on every push.
