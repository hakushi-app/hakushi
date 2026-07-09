//! Application-level error types.
//!
//! Tauri commands return `Result<T, String>` per the interface contract
//! (docs/dev/INTERFACES.md §1); these errors exist so internal code can be
//! written against typed errors and mapped to readable strings at the
//! command boundary via `.to_string()`.

use thiserror::Error;

/// Errors produced by filesystem commands (and general app plumbing).
#[derive(Debug, Error)]
pub enum AppError {
    /// The requested `rel_path` would escape the workspace root
    /// (`..` components, absolute paths, drive prefixes, symlink escape).
    #[error("path escapes workspace root: {0}")]
    PathEscape(String),

    /// The `rel_path` is syntactically invalid (empty, NUL bytes, ...).
    #[error("invalid path: {0}")]
    InvalidPath(String),

    /// `create_page` refuses to overwrite an existing file.
    #[error("file already exists: {0}")]
    AlreadyExists(String),

    /// The requested path does not exist or is not a regular file/directory.
    #[error("not found: {0}")]
    NotFound(String),

    /// Underlying I/O failure.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// SQLite link-index failure (`.hakushi/index.db`). The `From<rusqlite::
    /// Error>` impl lives in `index_store` to keep this module dependency-free.
    #[error("index error: {0}")]
    Index(String),
}
