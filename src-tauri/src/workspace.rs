//! Default app-managed workspace (docs/dev/INTERFACES.md §5.1).
//!
//! Hakushi opens ready-to-use, Notion-style: on startup the frontend calls
//! `ensure_default_workspace`, which creates (if needed) and returns
//! `{app_data_dir}/workspace` — git-initialized, `.hakushi/` gitignored, and
//! seeded with a Welcome page when the workspace has no `.md` files yet.
//!
//! The Welcome page bytes are a static template kept in **canonical form**
//! (LF, single trailing newline, `-` bullets) so `normalizeMarkdown` on the
//! TS side is a no-op on them — this file never bypasses the canonical-form
//! rule even though the bytes originate in Rust. The body's fixpoint property
//! is verified against the real pipeline in scratch tests whenever it changes.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::error::AppError;

/// Welcome page body written into a fresh workspace, after the frontmatter.
/// Canonical form: verified as a fixpoint of `normalizeMarkdown`.
const WELCOME_BODY: &str = "# ようこそ

白紙（Hakushi）へようこそ。ここはアプリが管理する既定のワークスペースです。

- ページはすべて Markdown（.md）ファイルとしてこのフォルダに保存されます。
- ワークスペースは Git リポジトリとして管理され、変更の履歴が残ります。
- サイドバーの「新規ページ」ボタンから、いつでも新しいページを作成できます。

このページは自由に書き換えても、削除してもかまいません。
";

/// Line added to the workspace-root `.gitignore` so the SQLite link index
/// cache is never committed to user history.
const GITIGNORE_LINE: &str = ".hakushi/";

#[tauri::command]
pub fn ensure_default_workspace(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    ensure_workspace_at(&base.join("workspace")).map_err(|e| e.to_string())
}

/// Core of `ensure_default_workspace`, factored on a plain path so tests can
/// exercise it without a `tauri::AppHandle`.
///
/// Idempotent: create dirs → git init (no-op if already a repo) → ensure
/// `.gitignore` covers `.hakushi/` → write `Welcome.md` only when the
/// workspace contains no `.md` file anywhere. Returns the absolute path.
pub fn ensure_workspace_at(dir: &Path) -> Result<String, AppError> {
    fs::create_dir_all(dir)?;
    let canon = dir.canonicalize()?;

    crate::git::backend()
        .init(&canon)
        .map_err(|e| AppError::InvalidPath(format!("git init failed: {e}")))?;

    ensure_gitignore_line(&canon)?;

    if !contains_markdown(&canon)? {
        let welcome = format!(
            "---\nid: {}\ntitle: Welcome\ncreated: {}\n---\n\n{}",
            ulid::Ulid::new(),
            today_iso_date(),
            WELCOME_BODY
        );
        fs::write(canon.join("Welcome.md"), welcome)?;
    }

    Ok(canon.to_string_lossy().into_owned())
}

/// Ensure the workspace-root `.gitignore` contains a `.hakushi/` line
/// (create the file if missing, append if present without it).
fn ensure_gitignore_line(root: &Path) -> Result<(), AppError> {
    let path = root.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let covered = existing
        .lines()
        .map(str::trim)
        .any(|line| line == GITIGNORE_LINE || line == ".hakushi");
    if covered {
        return Ok(());
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(GITIGNORE_LINE);
    updated.push('\n');
    fs::write(&path, updated)?;
    Ok(())
}

/// Does the workspace contain any `.md` file (recursively, skipping dot
/// directories such as `.git`/`.hakushi`)? Symlinks are never followed.
fn contains_markdown(dir: &Path) -> Result<bool, AppError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if contains_markdown(&entry.path())? {
                return Ok(true);
            }
        } else if file_type.is_file()
            && Path::new(&name)
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Today's UTC date as `YYYY-MM-DD` without a date-time dependency
/// (Howard Hinnant's civil-from-days algorithm).
fn today_iso_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hakushi-ws-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn ensure_default_is_idempotent() {
        let dir = tmp_dir("idem");
        let first = ensure_workspace_at(&dir).unwrap();
        let root = PathBuf::from(&first);

        assert!(root.join(".git").is_dir(), "git init must have run");
        let welcome = root.join("Welcome.md");
        assert!(welcome.is_file(), "Welcome.md must be seeded");
        let bytes_before = fs::read_to_string(&welcome).unwrap();
        assert!(bytes_before.starts_with("---\nid: "));
        assert!(bytes_before.contains("\ntitle: Welcome\n"));
        assert!(bytes_before.ends_with("\n") && !bytes_before.ends_with("\n\n"));
        // Frontmatter id is a 26-char uppercase-Crockford ULID.
        let id_line = bytes_before.lines().nth(1).unwrap();
        let id = id_line.strip_prefix("id: ").unwrap();
        assert_eq!(id.len(), 26);
        assert_eq!(id, id.to_uppercase());

        let second = ensure_workspace_at(&dir).unwrap();
        assert_eq!(first, second, "second call must return the same path");
        assert_eq!(
            fs::read_to_string(&welcome).unwrap(),
            bytes_before,
            "Welcome.md must not be rewritten (fresh ulid would change bytes)"
        );
        let md_count = fs::read_dir(&root)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".md")
            })
            .count();
        assert_eq!(md_count, 1, "no duplicate Welcome page");
    }

    #[test]
    fn welcome_skipped_when_markdown_exists_even_nested() {
        let dir = tmp_dir("nested");
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/existing.md"), "x\n").unwrap();
        ensure_workspace_at(&dir).unwrap();
        assert!(
            !dir.join("Welcome.md").exists(),
            "existing pages anywhere must suppress the Welcome page"
        );
    }

    #[test]
    fn gitignore_gets_hakushi_line_without_clobbering() {
        let dir = tmp_dir("gitignore");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        ensure_workspace_at(&dir).unwrap();
        let text = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(text, "node_modules/\n.hakushi/\n");

        // Second run must not duplicate the line.
        ensure_workspace_at(&dir).unwrap();
        let again = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(again, text);
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // leap year start
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // leap day
        assert_eq!(civil_from_days(20_638), (2026, 7, 4));
    }
}
