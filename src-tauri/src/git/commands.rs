//! Git Tauri commands (docs/dev/INTERFACES.md §1). Thin wrappers that
//! delegate to the statically selected `crate::git::backend()` and map
//! `GitError` to human-readable strings.

use std::path::Path;

use serde::Serialize;

use super::backend::{
    BranchInfo, Capabilities, CommitInfo, ConflictFile, MergeOutcome, ResolvedFile, StatusEntry,
    SyncReport,
};

/// Default number of commits returned by `git_log` when `limit` is omitted.
const DEFAULT_LOG_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// "libgit2" | "gix"
    pub name: String,
    pub capabilities: Capabilities,
}

#[tauri::command]
pub fn git_backend_info() -> Result<BackendInfo, String> {
    let backend = super::backend();
    Ok(BackendInfo {
        name: backend.name().to_string(),
        capabilities: backend.capabilities(),
    })
}

#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
    super::backend()
        .init(Path::new(&root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_status(root: String) -> Result<Vec<StatusEntry>, String> {
    super::backend()
        .status(Path::new(&root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<String, String> {
    super::backend()
        .commit_all(Path::new(&root), &message)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_log(
    root: String,
    rel_path: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<CommitInfo>, String> {
    let limit = limit.map(|n| n as usize).unwrap_or(DEFAULT_LOG_LIMIT);
    super::backend()
        .log(Path::new(&root), rel_path.as_deref(), limit)
        .map_err(|e| e.to_string())
}

// -- M4 (docs/dev/INTERFACES.md §7.1) ----------------------------------------

#[tauri::command]
pub fn git_branches(root: String) -> Result<BranchInfo, String> {
    super::backend()
        .branches(Path::new(&root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_create_branch(root: String, name: String) -> Result<(), String> {
    super::backend()
        .create_branch(Path::new(&root), &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_checkout_branch(root: String, name: String) -> Result<(), String> {
    super::backend()
        .checkout_branch(Path::new(&root), &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_file_at_commit(
    root: String,
    rel_path: String,
    oid: String,
) -> Result<Option<String>, String> {
    validate_rel_path(&root, &rel_path)?;
    super::backend()
        .file_at_commit(Path::new(&root), &rel_path, &oid)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_revert_file(root: String, rel_path: String, oid: String) -> Result<(), String> {
    validate_rel_path(&root, &rel_path)?;
    super::backend()
        .revert_file(Path::new(&root), &rel_path, &oid)
        .map_err(|e| e.to_string())
}

// -- M6 (docs/dev/INTERFACES.md §10.2) ---------------------------------------

#[tauri::command]
pub fn git_merge_branch(root: String, source: String) -> Result<MergeOutcome, String> {
    super::backend()
        .merge_branch(Path::new(&root), &source)
        .map_err(|e| e.to_string())
}

// -- M8 (docs/dev/INTERFACES.md §12.1) ---------------------------------------

#[tauri::command]
pub fn git_conflict_versions(
    root: String,
    source: String,
) -> Result<Vec<ConflictFile>, String> {
    super::backend()
        .conflict_versions(Path::new(&root), &source)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_merge_resolve(
    root: String,
    source: String,
    resolved: Vec<ResolvedFile>,
) -> Result<String, String> {
    super::backend()
        .merge_resolve(Path::new(&root), &source, resolved)
        .map_err(|e| e.to_string())
}

// -- M7 (docs/dev/INTERFACES.md §11.2) ---------------------------------------

#[tauri::command]
pub fn git_remote_get(root: String) -> Result<Option<String>, String> {
    super::backend()
        .remote_get(Path::new(&root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_remote_set(root: String, url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("remote URL is required".to_string());
    }
    // M7 accepts https:// and file:// / absolute paths only (SSH is a §1.8
    // non-goal). Reject obviously unsupported schemes with a readable message.
    if url.starts_with("ssh://") || url.starts_with("git@") {
        return Err("SSH remotes are not supported yet — use an https:// URL".to_string());
    }
    super::backend()
        .remote_set(Path::new(&root), url)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_sync(root: String) -> Result<SyncReport, String> {
    super::backend()
        .sync(Path::new(&root))
        .map_err(|e| e.to_string())
}

/// §1 preamble: every command must reject a `rel_path` that would escape the
/// workspace root. Reuses the fs_commands validation pipeline (lexical check
/// + symlink-escape check on the deepest existing ancestor).
fn validate_rel_path(root: &str, rel_path: &str) -> Result<(), String> {
    crate::fs_commands::resolve_checked(root, rel_path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
