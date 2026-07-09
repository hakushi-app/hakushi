//! Filesystem Tauri commands (docs/dev/INTERFACES.md §1).
//!
//! Every command takes an absolute workspace `root` plus a `/`-separated
//! workspace-relative `rel_path`. Requests that would escape the root are
//! rejected: `rel_path` is validated component-by-component (the target may
//! not exist yet, so it cannot itself be canonicalized), the root IS
//! canonicalized, and the deepest existing ancestor of the target is
//! canonicalized to defeat symlink escapes.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;

/// Directory/file names skipped by `list_tree` (in addition to any
/// dot-prefixed name).
const SKIP_NAMES: &[&str] = &[".git", ".hakushi", "node_modules", "target"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    /// Workspace-relative path, always `/`-separated.
    pub rel_path: String,
    pub is_dir: bool,
    /// `Some(vec)` (possibly empty) for directories, `None` for files.
    pub children: Option<Vec<TreeEntry>>,
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/// Canonicalize the workspace root; it must exist and be a directory.
/// `pub(crate)`: also used by `index_store` to locate `.hakushi/index.db`.
pub(crate) fn canonical_root(root: &str) -> Result<PathBuf, AppError> {
    let canon = Path::new(root)
        .canonicalize()
        .map_err(|_| AppError::NotFound(format!("workspace root: {root}")))?;
    if !canon.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "workspace root is not a directory: {root}"
        )));
    }
    Ok(canon)
}

/// Validate a `/`-separated workspace-relative path component-by-component
/// and return it joined onto `root_canon`.
///
/// The target may not exist yet (writes/creates), so validation is purely
/// lexical here; symlink escapes are handled by `ensure_within_root`.
fn resolve_rel_path(root_canon: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    if rel_path.is_empty() {
        return Err(AppError::InvalidPath("empty rel_path".to_string()));
    }
    if rel_path.contains('\0') {
        return Err(AppError::InvalidPath("rel_path contains NUL".to_string()));
    }
    // Absolute paths (unix) are never valid rel_paths.
    if rel_path.starts_with('/') {
        return Err(AppError::PathEscape(rel_path.to_string()));
    }

    let mut clean = PathBuf::new();
    for comp in rel_path.split('/') {
        if comp.is_empty() || comp == "." {
            continue; // tolerate "a//b" and "./a"
        }
        if comp == ".." {
            return Err(AppError::PathEscape(rel_path.to_string()));
        }
        // Windows-style separators / drive prefixes hidden inside a component
        // ("..\\x", "C:\\x", "C:x") must not smuggle the path out of root.
        if comp.contains('\\') || comp.contains(':') {
            return Err(AppError::PathEscape(rel_path.to_string()));
        }
        // Defense in depth: re-check what std parses this component as.
        match Path::new(comp).components().next() {
            Some(Component::Normal(_)) => {}
            _ => return Err(AppError::PathEscape(rel_path.to_string())),
        }
        clean.push(comp);
    }
    if clean.as_os_str().is_empty() {
        return Err(AppError::InvalidPath(rel_path.to_string()));
    }
    Ok(root_canon.join(clean))
}

/// Reject targets whose deepest existing ancestor canonicalizes to somewhere
/// outside the workspace root (symlink escape protection).
fn ensure_within_root(root_canon: &Path, target: &Path) -> Result<(), AppError> {
    let mut probe = target.to_path_buf();
    let existing = loop {
        if probe.symlink_metadata().is_ok() {
            break probe;
        }
        match probe.parent() {
            Some(parent) => probe = parent.to_path_buf(),
            None => return Err(AppError::PathEscape(target.display().to_string())),
        }
    };
    let canon = existing
        .canonicalize()
        .map_err(|_| AppError::PathEscape(target.display().to_string()))?;
    if canon.starts_with(root_canon) {
        Ok(())
    } else {
        Err(AppError::PathEscape(target.display().to_string()))
    }
}

/// Full pipeline: canonical root + lexical rel_path validation + symlink check.
/// `pub(crate)`: also used by git commands to validate their `rel_path`s.
pub(crate) fn resolve_checked(root: &str, rel_path: &str) -> Result<(PathBuf, PathBuf), AppError> {
    let root_canon = canonical_root(root)?;
    let target = resolve_rel_path(&root_canon, rel_path)?;
    ensure_within_root(&root_canon, &target)?;
    Ok((root_canon, target))
}

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

fn is_skipped(name: &str) -> bool {
    name.starts_with('.') || SKIP_NAMES.contains(&name)
}

fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn walk_dir(dir: &Path, rel_prefix: &str) -> Result<Vec<TreeEntry>, AppError> {
    let mut dirs: Vec<TreeEntry> = Vec::new();
    let mut files: Vec<TreeEntry> = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue, // skip non-UTF-8 names
        };
        if is_skipped(&name) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue; // never follow symlinks while listing
        }
        let rel_path = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if file_type.is_dir() {
            let children = walk_dir(&entry.path(), &rel_path)?;
            dirs.push(TreeEntry {
                name,
                rel_path,
                is_dir: true,
                children: Some(children),
            });
        } else if file_type.is_file() && is_markdown(&name) {
            files.push(TreeEntry {
                name,
                rel_path,
                is_dir: false,
                children: None,
            });
        }
    }

    let by_name =
        |a: &TreeEntry, b: &TreeEntry| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    Ok(dirs)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_tree(root: String) -> Result<Vec<TreeEntry>, String> {
    let root_canon = canonical_root(&root).map_err(|e| e.to_string())?;
    walk_dir(&root_canon, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(root: String, rel_path: String) -> Result<String, String> {
    let (_, target) = resolve_checked(&root, &rel_path).map_err(|e| e.to_string())?;
    if !target.is_file() {
        return Err(AppError::NotFound(rel_path).to_string());
    }
    fs::read_to_string(&target).map_err(|e| AppError::from(e).to_string())
}

#[tauri::command]
pub fn write_text_file(root: String, rel_path: String, content: String) -> Result<(), String> {
    let (root_canon, target) = resolve_checked(&root, &rel_path).map_err(|e| e.to_string())?;
    write_impl(&root_canon, &target, &content, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_page(root: String, rel_path: String, content: String) -> Result<(), String> {
    let (root_canon, target) = resolve_checked(&root, &rel_path).map_err(|e| e.to_string())?;
    write_impl(&root_canon, &target, &content, true)
        .map_err(|e| match e {
            AppError::AlreadyExists(_) => AppError::AlreadyExists(rel_path.clone()),
            other => other,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(root: String, from_rel: String, to_rel: String) -> Result<(), String> {
    rename_impl(&root, &from_rel, &to_rel).map_err(|e| e.to_string())
}

fn rename_impl(root: &str, from_rel: &str, to_rel: &str) -> Result<(), AppError> {
    // Both endpoints go through the full validation pipeline; the workspace
    // root itself (empty rel_path) is rejected by `resolve_rel_path`.
    let (root_canon, from) = resolve_checked(root, from_rel)?;
    let (_, to) = resolve_checked(root, to_rel)?;

    if from.symlink_metadata().is_err() {
        return Err(AppError::NotFound(from_rel.to_string()));
    }
    if to.symlink_metadata().is_ok() {
        return Err(AppError::AlreadyExists(to_rel.to_string()));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
        // Re-verify after creating dirs: the now-existing parent must still
        // canonicalize inside the root.
        ensure_within_root(&root_canon, &to)?;
    }
    fs::rename(&from, &to)?;
    Ok(())
}

#[tauri::command]
pub fn delete_path(root: String, rel_path: String) -> Result<(), String> {
    delete_impl(&root, &rel_path).map_err(|e| e.to_string())
}

fn delete_impl(root: &str, rel_path: &str) -> Result<(), AppError> {
    // The workspace root itself (empty rel_path) is rejected by
    // `resolve_rel_path`; git history makes a trash can unnecessary.
    let (_, target) = resolve_checked(root, rel_path)?;
    let meta = target
        .symlink_metadata()
        .map_err(|_| AppError::NotFound(rel_path.to_string()))?;
    if meta.is_dir() {
        fs::remove_dir_all(&target)?;
    } else {
        fs::remove_file(&target)?;
    }
    Ok(())
}

/// M3 export (docs/dev/INTERFACES.md §6.2): write bytes to an absolute path
/// obtained from the OS save dialog. Unlike the workspace commands this is
/// NOT root-relative — the user explicitly chose the destination — but
/// relative paths are rejected and the parent directory must already exist
/// (the save dialog only produces paths inside existing directories).
/// Overwriting is allowed (the dialog already asked for confirmation).
#[tauri::command]
pub fn write_export_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    write_export_impl(&path, &bytes).map_err(|e| e.to_string())
}

fn write_export_impl(path: &str, bytes: &[u8]) -> Result<(), AppError> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(AppError::InvalidPath(format!(
            "export path must be absolute: {path}"
        )));
    }
    let parent = target.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("export path has no parent directory: {path}"))
    })?;
    if !parent.is_dir() {
        return Err(AppError::NotFound(format!(
            "parent directory does not exist: {}",
            parent.display()
        )));
    }
    fs::write(target, bytes)?;
    Ok(())
}

/// M8 PDF (docs/dev/M7-M8-PLAN.md §2.6 / INTERFACES.md §12.6): write `content`
/// to a temp HTML file under the app cache dir and return its absolute path so
/// the PDF backend can open it as a `file://` URL in a new WebviewWindow (the
/// old `data:` URL was rejected by some platform webviews, docs/dev §0.4-1).
/// `name` is sanitized to a single path component (no traversal); a non-`.html`
/// name is left as given but is still forced to be a bare file name.
#[tauri::command]
pub fn write_temp_file(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<String, String> {
    write_temp_file_impl(&app, &name, &content).map_err(|e| e.to_string())
}

fn write_temp_file_impl(
    app: &tauri::AppHandle,
    name: &str,
    content: &str,
) -> Result<String, AppError> {
    use tauri::Manager;

    // Reduce `name` to a safe single component: strip any directory parts and
    // reject NUL, so nothing escapes the cache dir even with a hostile name.
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .unwrap_or("export.html");

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::NotFound(format!("app cache dir unavailable: {e}")))?
        .join("pdf-preview");
    fs::create_dir_all(&dir)?;
    let target = dir.join(base);
    fs::write(&target, content.as_bytes())?;
    Ok(target.to_string_lossy().into_owned())
}

/// One file of a static-site publish (INTERFACES.md §11.4). `rel_path` is a
/// `/`-separated path relative to the chosen destination folder.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteFile {
    pub rel_path: String,
    pub content: String,
}

/// M7 static-site publish (INTERFACES.md §11.4, PLAN §1.9): write every
/// generated site file under `base_dir` in one IPC. `base_dir` is the
/// user-chosen destination (absolute); each `rel_path` is validated
/// lexically (no `..`, no absolute, no `\`/`:` smuggling) so nothing escapes
/// `base_dir`. Parent directories are created; overwriting is allowed.
/// Returns the number of files written.
#[tauri::command]
pub fn write_site_files(base_dir: String, files: Vec<SiteFile>) -> Result<u32, String> {
    write_site_files_impl(&base_dir, &files).map_err(|e| e.to_string())
}

fn write_site_files_impl(base_dir: &str, files: &[SiteFile]) -> Result<u32, AppError> {
    let base = Path::new(base_dir);
    if !base.is_absolute() {
        return Err(AppError::InvalidPath(format!(
            "site destination must be absolute: {base_dir}"
        )));
    }
    if !base.is_dir() {
        return Err(AppError::NotFound(format!(
            "destination directory does not exist: {base_dir}"
        )));
    }
    // Canonicalize the destination so symlink escapes (via a symlinked parent
    // created between files) are caught by the same check the fs commands use.
    let base_canon = base
        .canonicalize()
        .map_err(|_| AppError::NotFound(format!("destination directory: {base_dir}")))?;

    let mut written: u32 = 0;
    for file in files {
        // resolve_rel_path applies the full lexical rules (empty, NUL,
        // absolute, `..`, `\`, `:`, non-Normal components all rejected).
        let target = resolve_rel_path(&base_canon, &file.rel_path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
            ensure_within_root(&base_canon, &target)?;
        }
        fs::write(&target, file.content.as_bytes())?;
        written += 1;
    }
    Ok(written)
}

fn write_impl(
    root_canon: &Path,
    target: &Path,
    content: &str,
    fail_if_exists: bool,
) -> Result<(), AppError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
        // Re-verify after creating dirs: the now-existing parent must still
        // canonicalize inside the root.
        ensure_within_root(root_canon, target)?;
    }
    if fail_if_exists {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::AlreadyExists(target.display().to_string())
                } else {
                    AppError::Io(e)
                }
            })?;
        file.write_all(content.as_bytes())?;
    } else {
        fs::write(target, content)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hakushi-fs-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn rejects_escaping_paths() {
        let root = tmp_root("escape");
        let root_str = root.to_string_lossy().to_string();
        for bad in ["../x.md", "a/../../x.md", "/etc/passwd", "..", "C:\\x.md", "a\\..\\b.md"] {
            assert!(
                read_text_file(root_str.clone(), bad.to_string()).is_err(),
                "should reject {bad}"
            );
            assert!(
                write_text_file(root_str.clone(), bad.to_string(), "x".into()).is_err(),
                "should reject write {bad}"
            );
        }
    }

    #[test]
    fn write_read_roundtrip_and_create_page_no_overwrite() {
        let root = tmp_root("rw");
        let root_str = root.to_string_lossy().to_string();
        write_text_file(root_str.clone(), "notes/a.md".into(), "hello".into()).unwrap();
        assert_eq!(
            read_text_file(root_str.clone(), "notes/a.md".into()).unwrap(),
            "hello"
        );
        create_page(root_str.clone(), "notes/b.md".into(), "b".into()).unwrap();
        assert!(create_page(root_str.clone(), "notes/b.md".into(), "again".into()).is_err());
    }

    #[test]
    fn rename_moves_files_and_dirs_creating_parents() {
        let root = tmp_root("rename");
        let root_str = root.to_string_lossy().to_string();
        write_text_file(root_str.clone(), "a.md".into(), "A".into()).unwrap();

        // File rename into a not-yet-existing directory.
        rename_path(root_str.clone(), "a.md".into(), "sub/deep/b.md".into()).unwrap();
        assert_eq!(
            read_text_file(root_str.clone(), "sub/deep/b.md".into()).unwrap(),
            "A"
        );
        assert!(read_text_file(root_str.clone(), "a.md".into()).is_err());

        // Directory rename.
        rename_path(root_str.clone(), "sub".into(), "moved".into()).unwrap();
        assert_eq!(
            read_text_file(root_str.clone(), "moved/deep/b.md".into()).unwrap(),
            "A"
        );

        // Missing source / existing target / root itself are all rejected.
        assert!(rename_path(root_str.clone(), "nope.md".into(), "x.md".into()).is_err());
        write_text_file(root_str.clone(), "c.md".into(), "C".into()).unwrap();
        assert!(
            rename_path(root_str.clone(), "moved/deep/b.md".into(), "c.md".into()).is_err(),
            "must not overwrite an existing target"
        );
        assert!(rename_path(root_str.clone(), "".into(), "x".into()).is_err());
        assert!(rename_path(root_str.clone(), "c.md".into(), "".into()).is_err());
        assert!(rename_path(root_str.clone(), "c.md".into(), "../out.md".into()).is_err());
    }

    #[test]
    fn delete_removes_files_and_dirs_recursively() {
        let root = tmp_root("delete");
        let root_str = root.to_string_lossy().to_string();
        write_text_file(root_str.clone(), "keep.md".into(), "k".into()).unwrap();
        write_text_file(root_str.clone(), "dir/a.md".into(), "a".into()).unwrap();
        write_text_file(root_str.clone(), "dir/nested/b.md".into(), "b".into()).unwrap();

        delete_path(root_str.clone(), "dir".into()).unwrap();
        assert!(!root.join("dir").exists());
        delete_path(root_str.clone(), "keep.md".into()).unwrap();
        assert!(!root.join("keep.md").exists());

        assert!(delete_path(root_str.clone(), "keep.md".into()).is_err(), "already gone");
        assert!(delete_path(root_str.clone(), "".into()).is_err(), "workspace root");
        assert!(delete_path(root_str.clone(), "./".into()).is_err(), "workspace root via dot");
        assert!(delete_path(root_str, "../x".into()).is_err());
    }

    #[test]
    fn write_export_file_absolute_only_parent_must_exist_overwrite_ok() {
        let root = tmp_root("export");

        // Relative paths are rejected.
        assert!(write_export_file("relative/out.html".into(), vec![1]).is_err());

        // Parent directory must already exist (never created).
        let missing_parent = root.join("missing/out.html");
        assert!(
            write_export_file(missing_parent.to_string_lossy().into_owned(), vec![1]).is_err()
        );
        assert!(!root.join("missing").exists());

        // Absolute path with existing parent works; overwrite is allowed.
        let target = root.join("out.html");
        let target_str = target.to_string_lossy().into_owned();
        write_export_file(target_str.clone(), b"hi".to_vec()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hi");
        write_export_file(target_str, b"yo".to_vec()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"yo");
    }

    #[test]
    fn write_site_files_writes_tree_creates_dirs_rejects_escape() {
        let root = tmp_root("site");
        let base = root.join("out");
        fs::create_dir_all(&base).unwrap();
        let base_str = base.to_string_lossy().into_owned();

        // Nested paths get their parent dirs created; overwrite is allowed.
        let n = write_site_files(
            base_str.clone(),
            vec![
                SiteFile { rel_path: "index.html".into(), content: "<h1>i</h1>".into() },
                SiteFile { rel_path: "sub/deep/p.html".into(), content: "<p>p</p>".into() },
            ],
        )
        .unwrap();
        assert_eq!(n, 2);
        assert_eq!(fs::read_to_string(base.join("index.html")).unwrap(), "<h1>i</h1>");
        assert_eq!(
            fs::read_to_string(base.join("sub/deep/p.html")).unwrap(),
            "<p>p</p>"
        );
        // Overwrite.
        write_site_files(
            base_str.clone(),
            vec![SiteFile { rel_path: "index.html".into(), content: "<h1>two</h1>".into() }],
        )
        .unwrap();
        assert_eq!(fs::read_to_string(base.join("index.html")).unwrap(), "<h1>two</h1>");

        // Escaping / absolute rel_paths are rejected (nothing written outside).
        for bad in ["../evil.html", "/etc/evil.html", "a/../../evil.html", "C:\\evil.html"] {
            assert!(
                write_site_files(
                    base_str.clone(),
                    vec![SiteFile { rel_path: bad.into(), content: "x".into() }],
                )
                .is_err(),
                "should reject {bad}"
            );
        }
        assert!(!root.join("evil.html").exists());

        // Relative base_dir and a missing destination are both rejected.
        assert!(
            write_site_files(
                "relative/out".into(),
                vec![SiteFile { rel_path: "a.html".into(), content: "x".into() }],
            )
            .is_err()
        );
        assert!(
            write_site_files(
                base.join("does-not-exist").to_string_lossy().into_owned(),
                vec![SiteFile { rel_path: "a.html".into(), content: "x".into() }],
            )
            .is_err()
        );
    }

    #[test]
    fn list_tree_filters_and_sorts() {
        let root = tmp_root("tree");
        let root_str = root.to_string_lossy().to_string();
        fs::create_dir_all(root.join("Zebra")).unwrap();
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        fs::write(root.join("A.md"), "a").unwrap();
        fs::write(root.join("skip.txt"), "no").unwrap();
        fs::write(root.join(".dotfile.md"), "no").unwrap();

        let tree = list_tree(root_str).unwrap();
        let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zebra", "A.md", "b.md"]);
        assert!(tree[0].is_dir && tree[0].children.as_ref().unwrap().is_empty());
        assert!(!tree[2].is_dir && tree[2].children.is_none());
        assert_eq!(tree[2].rel_path, "A.md");
    }
}
