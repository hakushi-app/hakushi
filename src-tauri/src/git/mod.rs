//! Git module: backend trait, feature-selected implementations, and the
//! Tauri commands that expose them (docs/dev/INTERFACES.md §1).
//!
//! Backend selection is static, decided by cargo features:
//! - `git-libgit2` (desktop default) → `Libgit2Backend`
//! - `git-gix` (mobile)              → `GixBackend`
//! - both enabled                    → libgit2 wins
//! - neither                         → compile error

pub mod backend;
pub mod commands;

#[cfg(feature = "git-libgit2")]
mod libgit2_backend;

/// M7 sync orchestration for the libgit2 backend (docs/dev/M7-M8-PLAN.md §1.4).
#[cfg(feature = "git-libgit2")]
mod sync;

#[cfg(feature = "git-gix")]
#[cfg_attr(feature = "git-libgit2", allow(dead_code))]
mod gix_backend;

/// M7 fetch-only sync (pull) for the gix backend (docs/dev/M7-M8-PLAN.md §1.7).
/// Only compiled when gix is the selected backend (libgit2 wins when both
/// features are on, and then gix's `sync` is never reached).
#[cfg(all(feature = "git-gix", not(feature = "git-libgit2")))]
mod gix_sync;

#[cfg(not(any(feature = "git-libgit2", feature = "git-gix")))]
compile_error!(
    "at least one git backend feature must be enabled: `git-libgit2` (desktop) or `git-gix` (mobile)"
);

use backend::GitBackend;

/// The statically selected git backend for this build.
#[cfg(feature = "git-libgit2")]
pub fn backend() -> &'static dyn GitBackend {
    static BACKEND: libgit2_backend::Libgit2Backend = libgit2_backend::Libgit2Backend;
    &BACKEND
}

/// The statically selected git backend for this build.
#[cfg(all(feature = "git-gix", not(feature = "git-libgit2")))]
pub fn backend() -> &'static dyn GitBackend {
    static BACKEND: gix_backend::GixBackend = gix_backend::GixBackend;
    &BACKEND
}
