//! `refs/hakushi/*` event-log plumbing (docs/dev/INTERFACES.md §10.1).
//!
//! Each issue/PR is an append-only chain of empty-tree commits under a custom
//! ref; every commit message is exactly one JSON line:
//!
//! ```json
//! {"v":1,"type":"…","ts":<epoch_sec>,"author":"<git user.name>","data":{…}}
//! ```
//!
//! This module owns the schema (serde structs), append-time validation /
//! normalization (known type, `ts` and `author` auto-filled), and ordered
//! reads. The git mechanics live behind `GitBackend::append_ref_event` /
//! `read_ref_events` / `list_refs`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ISSUES_PREFIX: &str = "refs/hakushi/issues/";
pub const PRS_PREFIX: &str = "refs/hakushi/prs/";

/// Event types allowed on an issue chain (§10.1). "create" is only ever
/// written by `create_issue` as the first event of a chain.
pub const ISSUE_EVENT_TYPES: &[&str] = &["create", "comment", "close", "reopen", "label"];
/// Event types allowed on a PR chain (§10.1). "create" is only ever written
/// by `create_pr` as the first event of a chain.
pub const PR_EVENT_TYPES: &[&str] = &["create", "review_comment", "status"];

pub fn issue_ref(id: &str) -> String {
    format!("{ISSUES_PREFIX}{id}")
}

pub fn pr_ref(id: &str) -> String {
    format!("{PRS_PREFIX}{id}")
}

/// One event of an issue/PR log. Field order matters: serde serializes in
/// declaration order, producing the canonical key order (v, type, ts,
/// author, data) that the TS side emits as well.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    /// Epoch seconds.
    pub ts: i64,
    pub author: String,
    #[serde(default)]
    pub data: Value,
}

/// Loosely-typed incoming event (from the UI): only `type` is required;
/// `v` / `ts` / `author` / `data` are normalized by [`normalize_event`].
#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    ts: Option<i64>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    data: Value,
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `git user.name` for `root`, falling back to "Hakushi" (the same identity
/// the backends use for commit signatures). Resolved through whichever git
/// implementation this build carries — the `GitBackend` trait deliberately
/// does not expose config access.
#[cfg(feature = "git-libgit2")]
pub fn git_author_name(root: &Path) -> String {
    fn from_config(root: &Path) -> Option<String> {
        let repo = git2::Repository::open(root).ok()?;
        let sig = repo.signature().ok()?;
        sig.name().map(str::to_string)
    }
    from_config(root).unwrap_or_else(|| "Hakushi".to_string())
}

/// `git user.name` for `root`, falling back to "Hakushi" (gix-only builds).
#[cfg(all(feature = "git-gix", not(feature = "git-libgit2")))]
pub fn git_author_name(root: &Path) -> String {
    fn from_config(root: &Path) -> Option<String> {
        let repo = gix::open(root).ok()?;
        let sig = repo.author()?.ok()?;
        Some(sig.name.to_string())
    }
    from_config(root).unwrap_or_else(|| "Hakushi".to_string())
}

/// Build a fully-formed event locally (create_issue / create_pr path).
pub fn make_event(root: &Path, kind: &str, data: Value) -> Event {
    Event {
        v: 1,
        kind: kind.to_string(),
        ts: now_ts(),
        author: git_author_name(root),
        data,
    }
}

/// Validate + normalize an incoming event JSON (issue_event / pr_event path):
/// - `type` must be one of `allowed` ("create" is rejected — chains are
///   started via create_issue / create_pr only);
/// - `v` is forced to 1;
/// - `ts` defaults to now, `author` to git user.name (or "Hakushi");
/// - `data` defaults to `{}` (readers require an object).
pub fn normalize_event(root: &Path, event_json: &str, allowed: &[&str]) -> Result<Event, String> {
    let raw: RawEvent = serde_json::from_str(event_json)
        .map_err(|e| format!("invalid event json: {e}"))?;

    if raw.kind == "create" {
        return Err(
            "event type \"create\" starts a new chain: use collab_create_issue / collab_create_pr"
                .to_string(),
        );
    }
    if !allowed.contains(&raw.kind.as_str()) {
        return Err(format!(
            "unknown event type \"{}\" (allowed: {})",
            raw.kind,
            allowed.join(", ")
        ));
    }

    let data = match raw.data {
        Value::Null => Value::Object(serde_json::Map::new()),
        Value::Object(map) => Value::Object(map),
        other => return Err(format!("event data must be an object, got: {other}")),
    };

    Ok(Event {
        v: 1,
        kind: raw.kind,
        ts: raw.ts.unwrap_or_else(now_ts),
        author: match raw.author {
            Some(name) if !name.trim().is_empty() => name,
            _ => git_author_name(root),
        },
        data,
    })
}

/// Serialize an event to its canonical one-line JSON form.
pub fn to_json(event: &Event) -> Result<String, String> {
    serde_json::to_string(event).map_err(|e| format!("cannot serialize event: {e}"))
}

/// Append one event to the chain at `ref_name`. Returns the commit OID.
pub fn append(root: &Path, ref_name: &str, event: &Event) -> Result<String, String> {
    let json = to_json(event)?;
    crate::git::backend()
        .append_ref_event(root, ref_name, &json)
        .map_err(|e| e.to_string())
}

/// Does the chain ref exist?
pub fn exists(root: &Path, ref_name: &str) -> Result<bool, String> {
    let refs = crate::git::backend()
        .list_refs(root, ref_name)
        .map_err(|e| e.to_string())?;
    Ok(refs.iter().any(|r| r == ref_name))
}

/// Raw event JSON lines of the chain at `ref_name`, ordered ts-ascending
/// (stable: chain/append order breaks ts ties, which is deterministic — the
/// oid tie-break of §10 only becomes observable at M7 when chains from other
/// clones are unioned in).
pub fn read_raw(root: &Path, ref_name: &str) -> Result<Vec<String>, String> {
    let mut lines = crate::git::backend()
        .read_ref_events(root, ref_name)
        .map_err(|e| e.to_string())?;
    lines.sort_by_key(|line| parse_ts(line));
    Ok(lines)
}

/// Parsed events of the chain at `ref_name`, ordered like [`read_raw`].
/// Unparsable lines are skipped (tolerant reader — one bad commit must not
/// brick the log).
pub fn read_events(root: &Path, ref_name: &str) -> Result<Vec<Event>, String> {
    let mut events: Vec<Event> = crate::git::backend()
        .read_ref_events(root, ref_name)
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    events.sort_by_key(|e| e.ts);
    Ok(events)
}

/// `ts` of a raw event line, 0 when unparsable (sorted stably, so malformed
/// lines keep their chain position relative to each other).
fn parse_ts(line: &str) -> i64 {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("ts").and_then(Value::as_i64))
        .unwrap_or(0)
}
