//! Collab layer (M6): serverless Issues / PRs stored as append-only event
//! logs under `refs/hakushi/*` (docs/DESIGN.md §Git ネイティブ・コラボ層,
//! docs/dev/INTERFACES.md §10).
//!
//! High-level operations materialize summaries by scanning the refs on every
//! call — no cache. §10.2 leaves a SQLite materialization as an optional
//! later optimization; workspace-sized ref counts make a full scan cheap.

pub mod refs;
pub mod sync;

use std::path::Path;

use serde::Serialize;
use serde_json::json;

use refs::{issue_ref, pr_ref, Event, ISSUES_PREFIX, ISSUE_EVENT_TYPES, PRS_PREFIX, PR_EVENT_TYPES};

/// Issue list entry, materialized from the ref chain (§10.2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub id: String,
    pub title: String,
    /// "open" | "closed"
    pub state: String,
    pub comment_count: u32,
    /// Epoch seconds of the latest event.
    pub updated_ts: i64,
}

/// PR list entry, materialized from the ref chain (§10.2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub id: String,
    pub title: String,
    /// "open" | "merged" | "closed"
    pub state: String,
    pub source: String,
    pub target: String,
    /// Epoch seconds of the latest event.
    pub updated_ts: i64,
}

fn data_str(event: &Event, key: &str) -> String {
    event
        .data
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

pub fn create_issue(root: &Path, title: &str, body: &str) -> Result<String, String> {
    let id = ulid::Ulid::new().to_string();
    let event = refs::make_event(root, "create", json!({ "title": title, "body": body }));
    refs::append(root, &issue_ref(&id), &event)?;
    Ok(id)
}

pub fn issue_event(root: &Path, id: &str, event_json: &str) -> Result<(), String> {
    let ref_name = issue_ref(id);
    if !refs::exists(root, &ref_name)? {
        return Err(format!("issue not found: {id}"));
    }
    let event = refs::normalize_event(root, event_json, ISSUE_EVENT_TYPES)?;
    refs::append(root, &ref_name, &event)?;
    Ok(())
}

pub fn list_issues(root: &Path) -> Result<Vec<IssueSummary>, String> {
    let ref_names = crate::git::backend()
        .list_refs(root, ISSUES_PREFIX)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for ref_name in ref_names {
        let id = ref_name[ISSUES_PREFIX.len()..].to_string();
        let events = refs::read_events(root, &ref_name)?;

        let mut title = String::new();
        let mut state = "open".to_string();
        let mut comment_count: u32 = 0;
        let mut updated_ts: i64 = 0;
        for event in &events {
            updated_ts = updated_ts.max(event.ts);
            match event.kind.as_str() {
                "create" if title.is_empty() => title = data_str(event, "title"),
                "comment" => comment_count += 1,
                "close" => state = "closed".to_string(),
                "reopen" => state = "open".to_string(),
                _ => {}
            }
        }
        out.push(IssueSummary {
            id,
            title,
            state,
            comment_count,
            updated_ts,
        });
    }
    // Most recently updated first; id breaks ties deterministically.
    out.sort_by(|a, b| b.updated_ts.cmp(&a.updated_ts).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub fn get_issue(root: &Path, id: &str) -> Result<Vec<String>, String> {
    refs::read_raw(root, &issue_ref(id)).map_err(|e| {
        if e.contains("ref not found") {
            format!("issue not found: {id}")
        } else {
            e
        }
    })
}

// ---------------------------------------------------------------------------
// PRs
// ---------------------------------------------------------------------------

pub fn create_pr(
    root: &Path,
    title: &str,
    body: &str,
    source: &str,
    target: &str,
) -> Result<String, String> {
    // A PR is a merge proposal between two existing local branches (§10.1).
    let info = crate::git::backend()
        .branches(root)
        .map_err(|e| e.to_string())?;
    for branch in [source, target] {
        if !info.branches.iter().any(|b| b == branch) {
            return Err(format!("branch not found: {branch}"));
        }
    }

    let id = ulid::Ulid::new().to_string();
    let event = refs::make_event(
        root,
        "create",
        json!({ "title": title, "body": body, "source": source, "target": target }),
    );
    refs::append(root, &pr_ref(&id), &event)?;
    Ok(id)
}

pub fn pr_event(root: &Path, id: &str, event_json: &str) -> Result<(), String> {
    let ref_name = pr_ref(id);
    if !refs::exists(root, &ref_name)? {
        return Err(format!("pr not found: {id}"));
    }
    let event = refs::normalize_event(root, event_json, PR_EVENT_TYPES)?;
    refs::append(root, &ref_name, &event)?;
    Ok(())
}

pub fn list_prs(root: &Path) -> Result<Vec<PrSummary>, String> {
    let ref_names = crate::git::backend()
        .list_refs(root, PRS_PREFIX)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for ref_name in ref_names {
        let id = ref_name[PRS_PREFIX.len()..].to_string();
        let events = refs::read_events(root, &ref_name)?;

        let mut title = String::new();
        let mut source = String::new();
        let mut target = String::new();
        let mut state = "open".to_string();
        let mut updated_ts: i64 = 0;
        let mut seen_create = false;
        for event in &events {
            updated_ts = updated_ts.max(event.ts);
            match event.kind.as_str() {
                "create" if !seen_create => {
                    seen_create = true;
                    title = data_str(event, "title");
                    source = data_str(event, "source");
                    target = data_str(event, "target");
                }
                "status" => {
                    let next = data_str(event, "state");
                    if matches!(next.as_str(), "open" | "merged" | "closed") {
                        state = next;
                    }
                }
                _ => {}
            }
        }
        out.push(PrSummary {
            id,
            title,
            state,
            source,
            target,
            updated_ts,
        });
    }
    // Most recently updated first; id breaks ties deterministically.
    out.sort_by(|a, b| b.updated_ts.cmp(&a.updated_ts).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub fn get_pr(root: &Path, id: &str) -> Result<Vec<String>, String> {
    refs::read_raw(root, &pr_ref(id)).map_err(|e| {
        if e.contains("ref not found") {
            format!("pr not found: {id}")
        } else {
            e
        }
    })
}

// ---------------------------------------------------------------------------
// Tauri commands (docs/dev/INTERFACES.md §10.2)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn collab_create_issue(root: String, title: String, body: String) -> Result<String, String> {
    create_issue(Path::new(&root), &title, &body)
}

#[tauri::command]
pub fn collab_issue_event(root: String, id: String, event_json: String) -> Result<(), String> {
    issue_event(Path::new(&root), &id, &event_json)
}

#[tauri::command]
pub fn collab_list_issues(root: String) -> Result<Vec<IssueSummary>, String> {
    list_issues(Path::new(&root))
}

#[tauri::command]
pub fn collab_get_issue(root: String, id: String) -> Result<Vec<String>, String> {
    get_issue(Path::new(&root), &id)
}

#[tauri::command]
pub fn collab_create_pr(
    root: String,
    title: String,
    body: String,
    source: String,
    target: String,
) -> Result<String, String> {
    create_pr(Path::new(&root), &title, &body, &source, &target)
}

#[tauri::command]
pub fn collab_pr_event(root: String, id: String, event_json: String) -> Result<(), String> {
    pr_event(Path::new(&root), &id, &event_json)
}

#[tauri::command]
pub fn collab_list_prs(root: String) -> Result<Vec<PrSummary>, String> {
    list_prs(Path::new(&root))
}

#[tauri::command]
pub fn collab_get_pr(root: String, id: String) -> Result<Vec<String>, String> {
    get_pr(Path::new(&root), &id)
}

// ---------------------------------------------------------------------------
// Tests — run against whichever backend this build selects (libgit2 under
// default features, gix under --no-default-features --features git-gix).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hakushi-collab-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        crate::git::backend().init(&dir).unwrap();
        dir
    }

    #[test]
    fn issue_lifecycle_create_comment_close() {
        let root = tmp_repo("issue");

        // Fresh workspace: no issues.
        assert!(list_issues(&root).unwrap().is_empty());

        let id = create_issue(&root, "Bug: embeds break", "Steps: …").unwrap();
        assert_eq!(id.len(), 26, "ULID id");

        let issues = list_issues(&root).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, id);
        assert_eq!(issues[0].title, "Bug: embeds break");
        assert_eq!(issues[0].state, "open");
        assert_eq!(issues[0].comment_count, 0);
        assert!(issues[0].updated_ts > 0);

        // Two comments and a close; ts/author are auto-filled when missing.
        issue_event(&root, &id, r#"{"type":"comment","data":{"body":"first"}}"#).unwrap();
        issue_event(
            &root,
            &id,
            r#"{"v":1,"type":"comment","ts":9999999999,"author":"alice","data":{"body":"second"}}"#,
        )
        .unwrap();
        issue_event(&root, &id, r#"{"type":"close","data":{}}"#).unwrap();

        let issues = list_issues(&root).unwrap();
        assert_eq!(issues[0].state, "closed");
        assert_eq!(issues[0].comment_count, 2);
        assert_eq!(issues[0].updated_ts, 9999999999, "max ts wins");

        // reopen flips the state back.
        issue_event(&root, &id, r#"{"type":"reopen"}"#).unwrap();
        assert_eq!(list_issues(&root).unwrap()[0].state, "open");

        // get_issue returns the full event log, ts-ascending, normalized.
        let events = get_issue(&root, &id).unwrap();
        assert_eq!(events.len(), 5);
        let first: Value = serde_json::from_str(&events[0]).unwrap();
        assert_eq!(first["v"], 1);
        assert_eq!(first["type"], "create");
        assert_eq!(first["data"]["title"], "Bug: embeds break");
        assert!(first["author"].as_str().unwrap().len() > 0);
        assert!(first["ts"].as_i64().unwrap() > 0);
        // The event with the huge explicit ts sorted last.
        let last: Value = serde_json::from_str(&events[4]).unwrap();
        assert_eq!(last["ts"], 9999999999i64);
        assert_eq!(last["author"], "alice");
        // Auto-filled data object for the bare reopen.
        let reopen = events
            .iter()
            .map(|e| serde_json::from_str::<Value>(e).unwrap())
            .find(|v| v["type"] == "reopen")
            .unwrap();
        assert!(reopen["data"].is_object());

        // Validation: unknown type, create-via-event, bad json, missing issue.
        assert!(issue_event(&root, &id, r#"{"type":"explode","data":{}}"#).is_err());
        assert!(issue_event(&root, &id, r#"{"type":"create","data":{}}"#).is_err());
        assert!(issue_event(&root, &id, "not json").is_err());
        assert!(issue_event(&root, "01NOTANISSUE", r#"{"type":"comment","data":{}}"#).is_err());
        assert!(get_issue(&root, "01NOTANISSUE").is_err());

        // The event log never dirties the worktree.
        assert!(crate::git::backend().status(&root).unwrap().is_empty());
    }

    #[test]
    fn pr_lifecycle_create_review_status() {
        let root = tmp_repo("pr");

        // PRs need real branches: one commit + a feature branch.
        fs::write(root.join("a.md"), "# a\n").unwrap();
        crate::git::backend().commit_all(&root, "base").unwrap();
        let main = crate::git::backend()
            .branches(&root)
            .unwrap()
            .current
            .expect("current branch");
        crate::git::backend().create_branch(&root, "feature").unwrap();

        // Branch validation on create.
        assert!(create_pr(&root, "t", "b", "no-such", &main).is_err());
        assert!(create_pr(&root, "t", "b", "feature", "no-such").is_err());

        let id = create_pr(&root, "Add embeds", "Please review", "feature", &main).unwrap();
        assert_eq!(id.len(), 26, "ULID id");

        let prs = list_prs(&root).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].id, id);
        assert_eq!(prs[0].title, "Add embeds");
        assert_eq!(prs[0].state, "open");
        assert_eq!(prs[0].source, "feature");
        assert_eq!(prs[0].target, main);

        pr_event(
            &root,
            &id,
            r#"{"type":"review_comment","data":{"anchor":{"page":"01PAGE","block":3},"body":"nit"}}"#,
        )
        .unwrap();
        pr_event(&root, &id, r#"{"type":"status","data":{"state":"merged"}}"#).unwrap();

        let prs = list_prs(&root).unwrap();
        assert_eq!(prs[0].state, "merged");

        let events = get_pr(&root, &id).unwrap();
        assert_eq!(events.len(), 3);
        let review: Value = serde_json::from_str(&events[1]).unwrap();
        assert_eq!(review["type"], "review_comment");
        assert_eq!(review["data"]["anchor"]["page"], "01PAGE");
        assert_eq!(review["data"]["anchor"]["block"], 3);

        // Validation mirrors issues.
        assert!(pr_event(&root, &id, r#"{"type":"comment","data":{}}"#).is_err());
        assert!(pr_event(&root, &id, r#"{"type":"create","data":{}}"#).is_err());
        assert!(pr_event(&root, "01NOTAPR", r#"{"type":"status","data":{"state":"closed"}}"#).is_err());
        assert!(get_pr(&root, "01NOTAPR").is_err());

        // Issues and PRs live under separate prefixes.
        assert!(list_issues(&root).unwrap().is_empty());
    }
}
