//! id⇄path link index — SQLite store at `.hakushi/index.db`
//! (docs/dev/INTERFACES.md §5.3).
//!
//! Division of labor: **markdown parsing happens only in TS (remark)**. The
//! frontend scans the workspace, runs `extractRefs`, and pushes structured
//! records here; this module only stores and queries them. `.hakushi/` is
//! kept out of git by `workspace::ensure_workspace_at` (workspace-level
//! `.gitignore`) and skipped by `list_tree`.
//!
//! Connections are opened per command: the M2 workspace scale makes pooling
//! unnecessary, and it keeps the commands stateless and re-entrant.

use std::fs;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Index(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Records (wire format: camelCase, per INTERFACES.md §2 note)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecord {
    pub id: Option<String>,
    pub rel_path: String,
    pub title: Option<String>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefRecord {
    /// "link" | "embed"
    pub kind: String,
    /// Raw target as written in the source page: relative path or page id.
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePut {
    pub page: PageRecord,
    pub refs: Vec<RefRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRecord {
    pub src_rel_path: String,
    pub kind: String,
    pub target: String,
}

// ---------------------------------------------------------------------------
// Connection / schema
// ---------------------------------------------------------------------------

/// `resolved_rel_path` is declared per the §5.3 schema but not yet populated;
/// resolution currently happens at query time (`index_lookup`/`index_backlinks`).
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pages (
    rel_path TEXT PRIMARY KEY,
    id       TEXT,
    title    TEXT,
    template TEXT
);
CREATE TABLE IF NOT EXISTS refs (
    src_rel_path      TEXT NOT NULL,
    kind              TEXT NOT NULL,
    target            TEXT NOT NULL,
    resolved_rel_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_refs_src ON refs(src_rel_path);
";

fn open_db(root: &str) -> Result<Connection, AppError> {
    let root_canon = crate::fs_commands::canonical_root(root)?;
    let dir = root_canon.join(".hakushi");
    fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("index.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Pure resolution helpers (unit-tested; no fs, no db)
// ---------------------------------------------------------------------------

/// Normalize a raw link/embed `target` written in a page whose directory is
/// `src_dir` ("" for workspace root) into a root-relative `/`-separated path.
///
/// Handles `./`, `../`, bare (no-prefix) targets, and a leading `/` meaning
/// workspace-root-relative. Returns `None` when `..` would escape the
/// workspace root.
fn normalize_rel(src_dir: &str, target: &str) -> Option<String> {
    let (base, rest) = match target.strip_prefix('/') {
        Some(stripped) => ("", stripped),
        None => (src_dir, target),
    };
    let mut stack: Vec<&str> = base
        .split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .collect();
    for comp in rest.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                stack.pop()?; // popping past the root = escape
            }
            other => stack.push(other),
        }
    }
    Some(stack.join("/"))
}

/// The §5.3 completion order applied to a normalized target: exact,
/// `+ ".md"`, `+ "/index.md"`.
fn completion_candidates(norm: &str) -> [String; 3] {
    [
        norm.to_string(),
        format!("{norm}.md"),
        format!("{norm}/index.md"),
    ]
}

/// Does a ref (raw `target`, written in page `src_rel_path`) resolve to the
/// page at `page_rel_path` (with optional frontmatter `page_id`)?
fn ref_resolves_to(
    src_rel_path: &str,
    target: &str,
    page_rel_path: &str,
    page_id: Option<&str>,
) -> bool {
    if let Some(id) = page_id {
        if target == id {
            return true;
        }
    }
    let src_dir = match src_rel_path.rfind('/') {
        Some(i) => &src_rel_path[..i],
        None => "",
    };
    match normalize_rel(src_dir, target) {
        Some(norm) => completion_candidates(&norm)
            .iter()
            .any(|cand| cand == page_rel_path),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn index_put_pages(root: String, pages: Vec<PagePut>) -> Result<(), String> {
    put_pages_impl(&root, &pages).map_err(|e| e.to_string())
}

fn put_pages_impl(root: &str, pages: &[PagePut]) -> Result<(), AppError> {
    let mut conn = open_db(root)?;
    let tx = conn.transaction()?;
    {
        let mut del_refs = tx.prepare("DELETE FROM refs WHERE src_rel_path = ?1")?;
        let mut upsert_page = tx.prepare(
            "INSERT INTO pages (rel_path, id, title, template) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(rel_path) DO UPDATE SET
                 id = excluded.id, title = excluded.title, template = excluded.template",
        )?;
        let mut ins_ref = tx.prepare(
            "INSERT INTO refs (src_rel_path, kind, target) VALUES (?1, ?2, ?3)",
        )?;
        for put in pages {
            del_refs.execute([&put.page.rel_path])?;
            upsert_page.execute((
                &put.page.rel_path,
                &put.page.id,
                &put.page.title,
                &put.page.template,
            ))?;
            for r in &put.refs {
                ins_ref.execute((&put.page.rel_path, &r.kind, &r.target))?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn index_remove_pages(root: String, rel_paths: Vec<String>) -> Result<(), String> {
    remove_pages_impl(&root, &rel_paths).map_err(|e| e.to_string())
}

fn remove_pages_impl(root: &str, rel_paths: &[String]) -> Result<(), AppError> {
    let mut conn = open_db(root)?;
    let tx = conn.transaction()?;
    {
        let mut del_page = tx.prepare("DELETE FROM pages WHERE rel_path = ?1")?;
        let mut del_refs = tx.prepare("DELETE FROM refs WHERE src_rel_path = ?1")?;
        for rel_path in rel_paths {
            del_page.execute([rel_path])?;
            del_refs.execute([rel_path])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn index_clear(root: String) -> Result<(), String> {
    let conn = open_db(&root).map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM refs; DELETE FROM pages;")
        .map_err(|e| AppError::from(e).to_string())
}

#[tauri::command]
pub fn index_lookup(root: String, id_or_path: String) -> Result<Option<PageRecord>, String> {
    lookup_impl(&root, &id_or_path).map_err(|e| e.to_string())
}

fn lookup_impl(root: &str, id_or_path: &str) -> Result<Option<PageRecord>, AppError> {
    let conn = open_db(root)?;
    // §5.3 resolution order: id exact → relPath exact → +".md" → +"/index.md".
    if let Some(page) = select_page(&conn, "id", id_or_path)? {
        return Ok(Some(page));
    }
    for cand in completion_candidates(id_or_path) {
        if let Some(page) = select_page(&conn, "rel_path", &cand)? {
            return Ok(Some(page));
        }
    }
    Ok(None)
}

fn select_page(conn: &Connection, column: &str, value: &str) -> Result<Option<PageRecord>, AppError> {
    // `column` is a compile-time constant ("id" | "rel_path"), never user input.
    let sql =
        format!("SELECT rel_path, id, title, template FROM pages WHERE {column} = ?1 LIMIT 1");
    let page = conn
        .query_row(&sql, [value], |row| {
            Ok(PageRecord {
                rel_path: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
                template: row.get(3)?,
            })
        })
        .optional()?;
    Ok(page)
}

#[tauri::command]
pub fn index_backlinks(root: String, rel_path: String) -> Result<Vec<BacklinkRecord>, String> {
    backlinks_impl(&root, &rel_path).map_err(|e| e.to_string())
}

fn backlinks_impl(root: &str, rel_path: &str) -> Result<Vec<BacklinkRecord>, AppError> {
    let conn = open_db(root)?;
    let page_id: Option<String> = conn
        .query_row("SELECT id FROM pages WHERE rel_path = ?1", [rel_path], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();

    let mut stmt = conn.prepare("SELECT src_rel_path, kind, target FROM refs")?;
    let rows = stmt.query_map([], |row| {
        Ok(BacklinkRecord {
            src_rel_path: row.get(0)?,
            kind: row.get(1)?,
            target: row.get(2)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        let record = row?;
        if ref_resolves_to(
            &record.src_rel_path,
            &record.target,
            rel_path,
            page_id.as_deref(),
        ) {
            out.push(record);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_root(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "hakushi-index-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let canon = dir.canonicalize().unwrap();
        let root = canon.to_string_lossy().to_string();
        (canon, root)
    }

    fn page(rel_path: &str, id: Option<&str>) -> PagePut {
        PagePut {
            page: PageRecord {
                id: id.map(str::to_string),
                rel_path: rel_path.to_string(),
                title: None,
                template: None,
            },
            refs: vec![],
        }
    }

    fn with_refs(mut put: PagePut, refs: &[(&str, &str)]) -> PagePut {
        put.refs = refs
            .iter()
            .map(|(kind, target)| RefRecord {
                kind: kind.to_string(),
                target: target.to_string(),
            })
            .collect();
        put
    }

    // -- normalize_rel (pure) ------------------------------------------------

    #[test]
    fn normalize_rel_handles_dot_dotdot_and_bare() {
        assert_eq!(normalize_rel("notes", "./x.md"), Some("notes/x.md".into()));
        assert_eq!(normalize_rel("notes", "../x.md"), Some("x.md".into()));
        assert_eq!(normalize_rel("notes", "x.md"), Some("notes/x.md".into()));
        assert_eq!(normalize_rel("", "x.md"), Some("x.md".into()));
        assert_eq!(normalize_rel("a/b", "../c/./d"), Some("a/c/d".into()));
        assert_eq!(normalize_rel("a", "b//c"), Some("a/b/c".into()));
        assert_eq!(normalize_rel("a/b", "/top.md"), Some("top.md".into()));
        // Escaping the workspace root is a non-resolution, not an error.
        assert_eq!(normalize_rel("", "../x.md"), None);
        assert_eq!(normalize_rel("a", "../../x.md"), None);
    }

    #[test]
    fn ref_resolution_matches_id_and_completed_paths() {
        // id match wins regardless of src location.
        assert!(ref_resolves_to("deep/src.md", "01ABC", "b.md", Some("01ABC")));
        assert!(!ref_resolves_to("deep/src.md", "01ABC", "b.md", Some("01XYZ")));
        // Path match with .md completion, relative to the src dir.
        assert!(ref_resolves_to("notes/a.md", "../b", "b.md", None));
        assert!(ref_resolves_to("notes/a.md", "./c.md", "notes/c.md", None));
        assert!(ref_resolves_to("a.md", "Proj", "Proj/index.md", None));
        assert!(!ref_resolves_to("notes/a.md", "b", "b.md", None)); // resolves to notes/b.md
        assert!(!ref_resolves_to("a.md", "../out", "out.md", None)); // escapes root
    }

    // -- store CRUD + lookup -------------------------------------------------

    #[test]
    fn put_lookup_resolution_order_and_remove_clear() {
        let (_dir, root) = tmp_root("crud");

        put_pages_impl(
            &root,
            &[
                page("Foo.md", Some("01AAA")),
                page("Foo/index.md", Some("01BBB")),
                page("Bar.md", Some("Foo")), // id that collides with a path stem
            ],
        )
        .unwrap();

        // id exact beats every path interpretation.
        let hit = lookup_impl(&root, "Foo").unwrap().unwrap();
        assert_eq!(hit.rel_path, "Bar.md");
        // relPath exact.
        assert_eq!(
            lookup_impl(&root, "Foo.md").unwrap().unwrap().id.as_deref(),
            Some("01AAA")
        );
        // "+ .md" completion beats "/index.md".
        put_pages_impl(&root, &[page("Baz.md", None), page("Baz/index.md", None)]).unwrap();
        assert_eq!(lookup_impl(&root, "Baz").unwrap().unwrap().rel_path, "Baz.md");
        // "/index.md" completion when no .md sibling exists.
        put_pages_impl(&root, &[page("Qux/index.md", None)]).unwrap();
        assert_eq!(
            lookup_impl(&root, "Qux").unwrap().unwrap().rel_path,
            "Qux/index.md"
        );
        assert!(lookup_impl(&root, "missing").unwrap().is_none());

        // Upsert replaces the page row and its refs.
        put_pages_impl(
            &root,
            &[with_refs(page("Foo.md", Some("01AA2")), &[("link", "./Bar.md")])],
        )
        .unwrap();
        assert_eq!(
            lookup_impl(&root, "Foo.md").unwrap().unwrap().id.as_deref(),
            Some("01AA2")
        );
        assert_eq!(backlinks_impl(&root, "Bar.md").unwrap().len(), 1);
        put_pages_impl(&root, &[page("Foo.md", Some("01AA2"))]).unwrap();
        assert!(
            backlinks_impl(&root, "Bar.md").unwrap().is_empty(),
            "upsert must drop the page's old refs"
        );

        // Remove.
        remove_pages_impl(&root, &["Foo.md".to_string()]).unwrap();
        assert!(lookup_impl(&root, "Foo.md").unwrap().is_none());

        // Clear.
        index_clear(root.clone()).unwrap();
        assert!(lookup_impl(&root, "Bar.md").unwrap().is_none());
    }

    #[test]
    fn backlinks_match_by_id_and_normalized_paths() {
        let (_dir, root) = tmp_root("backlinks");
        put_pages_impl(
            &root,
            &[
                page("b.md", Some("01TARGET")),
                with_refs(
                    page("notes/a.md", None),
                    &[
                        ("link", "../b"),        // → b.md via .. + .md completion
                        ("embed", "01TARGET"),   // → b.md via id
                        ("link", "./other.md"),  // → notes/other.md, not b.md
                    ],
                ),
                with_refs(page("c.md", None), &[("link", "b.md")]), // bare, root level
                with_refs(page("notes/d.md", None), &[("link", "b.md")]), // → notes/b.md ≠ b.md
                with_refs(page("e.md", None), &[("link", "/b.md")]), // root-relative
            ],
        )
        .unwrap();

        let mut hits = backlinks_impl(&root, "b.md").unwrap();
        hits.sort_by(|a, b| {
            (a.src_rel_path.clone(), a.target.clone())
                .cmp(&(b.src_rel_path.clone(), b.target.clone()))
        });
        let summary: Vec<(String, String, String)> = hits
            .into_iter()
            .map(|r| (r.src_rel_path, r.kind, r.target))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("c.md".into(), "link".into(), "b.md".into()),
                ("e.md".into(), "link".into(), "/b.md".into()),
                ("notes/a.md".into(), "link".into(), "../b".into()),
                ("notes/a.md".into(), "embed".into(), "01TARGET".into()),
            ]
        );

        // Folder page: refs targeting "Proj" resolve to Proj/index.md.
        put_pages_impl(
            &root,
            &[
                page("Proj/index.md", None),
                with_refs(page("f.md", None), &[("embed", "Proj")]),
            ],
        )
        .unwrap();
        let folder_hits = backlinks_impl(&root, "Proj/index.md").unwrap();
        assert_eq!(folder_hits.len(), 1);
        assert_eq!(folder_hits[0].src_rel_path, "f.md");
    }
}
