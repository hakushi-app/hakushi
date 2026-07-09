//! Deterministic union merge of `refs/hakushi/*` event chains across clones
//! (M7, docs/dev/INTERFACES.md §11.3, docs/dev/M7-M8-PLAN.md §1.5).
//!
//! After a fetch, each local chain `refs/hakushi/<kind>/<id>` is reconciled
//! with its fetched counterpart `refs/hakushi-remote/<kind>/<id>`:
//!
//! - remote-only            → adopt the remote chain wholesale.
//! - local-only / remote ⊆ local → nothing to do (push propagates it).
//! - local ⊂ remote (ff)    → fast-forward the local ref to the remote tip.
//! - diverged               → collect BOTH chains' events, dedupe by
//!   normalized JSON, sort by `(ts, normalized-json)`, and rebuild the chain
//!   from scratch with deterministic commits (author + both timestamps taken
//!   from each event via `append_ref_event_raw`). The same event set rebuilds
//!   to byte-identical commit oids on every clone, so the next push/fetch
//!   converges by fast-forward.
//!
//! Works through the `GitBackend` trait only (`read_ref_events`, `list_refs`,
//! `append_ref_event_raw`, `force_set_ref`, `delete_ref`), so a gix fetch-only
//! pull can reuse it unchanged.

use std::collections::BTreeMap;
use std::path::Path;

use crate::git::backend::{CollabRefsReport, GitBackend, GitError};

pub const LOCAL_PREFIX: &str = "refs/hakushi/";
pub const REMOTE_PREFIX: &str = "refs/hakushi-remote/";

/// One event, kept alongside its canonical single-line JSON. `sort_key` groups
/// by `(ts, canonical-json)` for a fully deterministic order without needing
/// commit oids (which are not exposed by the trait and differ per clone until
/// convergence).
struct Item {
    ts: i64,
    author: String,
    canonical: String,
}

/// Canonicalize an event line to the same one-line form the append path emits
/// (`{"v","type","ts","author","data"}` in `refs::Event` declaration order,
/// with `data` keys sorted by serde_json), so dedup, the sort tie-break, AND
/// the rebuilt commit bytes are identical on every clone regardless of the
/// incoming key order or whitespace. Falls back to the raw line when it is not
/// a parseable event (a malformed commit must not brick the merge — it just
/// sorts by its raw text with ts 0).
fn canonicalize(line: &str) -> (i64, String, String) {
    match serde_json::from_str::<crate::collab::refs::Event>(line) {
        Ok(event) => {
            let ts = event.ts;
            let author = event.author.clone();
            let canonical =
                crate::collab::refs::to_json(&event).unwrap_or_else(|_| line.trim().to_string());
            (ts, author, canonical)
        }
        Err(_) => (0, String::new(), line.trim().to_string()),
    }
}

/// Read a chain into canonical items, tolerant of a missing ref (returns an
/// empty vec) so callers can treat "no such chain" as "no events".
fn read_items(
    backend: &dyn GitBackend,
    root: &Path,
    ref_name: &str,
) -> Result<Vec<Item>, GitError> {
    let lines = match backend.read_ref_events(root, ref_name) {
        Ok(lines) => lines,
        // read_ref_events errors when the ref is absent; treat as empty.
        Err(_) => return Ok(Vec::new()),
    };
    Ok(lines
        .into_iter()
        .map(|line| {
            let (ts, author, canonical) = canonicalize(&line);
            Item { ts, author, canonical }
        })
        .collect())
}

/// Suffix (`<kind>/<id>`) shared between a local ref and its remote tracking
/// counterpart.
fn suffix<'a>(ref_name: &'a str, prefix: &str) -> Option<&'a str> {
    ref_name.strip_prefix(prefix)
}

/// Union-merge every collab ref after a fetch. `merged` counts refs whose
/// local chain changed (adopted / fast-forwarded / rebuilt); `unchanged`
/// counts refs already in sync (including local-only refs). Always deletes the
/// temporary `refs/hakushi-remote/*` tracking refs afterward so a later
/// `list_refs("refs/hakushi/")` never sees them.
pub fn union_merge_all(
    backend: &dyn GitBackend,
    root: &Path,
) -> Result<CollabRefsReport, GitError> {
    let local = backend.list_refs(root, LOCAL_PREFIX)?;
    let remote = backend.list_refs(root, REMOTE_PREFIX)?;

    // Collect the set of suffixes present on either side.
    let mut suffixes: BTreeMap<String, ()> = BTreeMap::new();
    for r in &local {
        if let Some(s) = suffix(r, LOCAL_PREFIX) {
            suffixes.insert(s.to_string(), ());
        }
    }
    for r in &remote {
        if let Some(s) = suffix(r, REMOTE_PREFIX) {
            suffixes.insert(s.to_string(), ());
        }
    }

    let mut merged = 0u32;
    let mut unchanged = 0u32;

    for s in suffixes.keys() {
        let local_ref = format!("{LOCAL_PREFIX}{s}");
        let remote_ref = format!("{REMOTE_PREFIX}{s}");
        let has_remote = remote.iter().any(|r| r == &remote_ref);
        let has_local = local.iter().any(|r| r == &local_ref);

        if !has_remote {
            // Local-only: nothing fetched to merge; push will propagate it.
            unchanged += 1;
            continue;
        }

        let local_items = read_items(backend, root, &local_ref)?;
        let remote_items = read_items(backend, root, &remote_ref)?;

        if reconcile(
            backend,
            root,
            &local_ref,
            &remote_ref,
            has_local,
            &local_items,
            &remote_items,
        )? {
            merged += 1;
        } else {
            unchanged += 1;
        }
    }

    // Prune the tracking namespace so it never leaks into ISSUES/PRS listings.
    for r in &remote {
        backend.delete_ref(root, r)?;
    }

    Ok(CollabRefsReport { merged, unchanged })
}

/// Reconcile one local/remote pair. Returns `true` when the local ref was
/// changed (adopted / ff / rebuilt), `false` when it was already in sync.
fn reconcile(
    backend: &dyn GitBackend,
    root: &Path,
    local_ref: &str,
    remote_ref: &str,
    has_local: bool,
    local_items: &[Item],
    remote_items: &[Item],
) -> Result<bool, GitError> {
    // Canonical multiset (as a sorted, deduped key list) on each side.
    let local_keys = sorted_keys(local_items);
    let remote_keys = sorted_keys(remote_items);

    if !has_local {
        // Remote-only: adopt the remote chain (deterministic rebuild so both
        // clones agree on the tip oid).
        rebuild(backend, root, local_ref, &union(local_items, remote_items))?;
        return Ok(true);
    }

    if local_keys == remote_keys {
        // Same event set → already converged; leave the local ref untouched.
        return Ok(false);
    }

    if is_superset(&local_keys, &remote_keys) {
        // Remote ⊆ local: local already has everything; push propagates.
        return Ok(false);
    }

    // Divergence (or a strict remote-superset that we still rebuild
    // deterministically for a byte-identical tip): rebuild from the union.
    rebuild(backend, root, local_ref, &union(local_items, remote_items))?;
    let _ = remote_ref;
    Ok(true)
}

/// Sorted, deduped canonical keys of a chain (its event multiset as a set —
/// events are unique by construction: each carries a distinct ts/author/data).
fn sorted_keys(items: &[Item]) -> Vec<String> {
    let mut keys: Vec<String> = items.iter().map(|i| i.canonical.clone()).collect();
    keys.sort();
    keys.dedup();
    keys
}

fn is_superset(sup: &[String], sub: &[String]) -> bool {
    sub.iter().all(|k| sup.binary_search(k).is_ok())
}

/// Deduped union of two chains, sorted by `(ts, canonical-json)`.
fn union(a: &[Item], b: &[Item]) -> Vec<(i64, String, String)> {
    let mut all: Vec<(i64, String, String)> = a
        .iter()
        .chain(b.iter())
        .map(|i| (i.ts, i.author.clone(), i.canonical.clone()))
        .collect();
    // Dedup by canonical json (identical events collapse to one).
    all.sort_by(|x, y| x.2.cmp(&y.2));
    all.dedup_by(|x, y| x.2 == y.2);
    // Final order: ts ascending, canonical json as the tie-break (§1.5).
    all.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| x.2.cmp(&y.2)));
    all
}

/// Rebuild `ref_name` from scratch out of `events` (each `(ts, author,
/// canonical-json)`), then force-set the ref onto the new tip. Building on a
/// scratch ref keeps the target ref intact until the final swap; the scratch
/// ref shares the id so a crash mid-rebuild leaves an obvious orphan, not a
/// corrupt live ref.
fn rebuild(
    backend: &dyn GitBackend,
    root: &Path,
    ref_name: &str,
    events: &[(i64, String, String)],
) -> Result<(), GitError> {
    if events.is_empty() {
        return Ok(());
    }
    let scratch = format!("refs/hakushi-rebuild/{}", &ref_name[LOCAL_PREFIX.len()..]);
    // Ensure a clean scratch start.
    backend.delete_ref(root, &scratch)?;

    let mut tip = String::new();
    for (ts, author, json) in events {
        tip = backend.append_ref_event_raw(root, &scratch, json, author, *ts)?;
    }
    backend.force_set_ref(root, ref_name, &tip)?;
    backend.delete_ref(root, &scratch)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_is_key_order_insensitive() {
        let a = r#"{"v":1,"type":"comment","ts":5,"author":"a","data":{"body":"x"}}"#;
        let b = r#"{"data":{"body":"x"},"author":"a","ts":5,"type":"comment","v":1}"#;
        let (ts_a, au_a, ca) = canonicalize(a);
        let (ts_b, au_b, cb) = canonicalize(b);
        assert_eq!(ca, cb);
        assert_eq!(ts_a, 5);
        assert_eq!(ts_b, 5);
        assert_eq!(au_a, "a");
        assert_eq!(au_b, "a");
    }

    #[test]
    fn union_dedups_and_orders_by_ts_then_json() {
        let mk = |ts: i64, json: &str| Item {
            ts,
            author: "a".into(),
            canonical: json.to_string(),
        };
        let a = vec![mk(2, r#"{"ts":2,"x":"b"}"#), mk(1, r#"{"ts":1,"x":"a"}"#)];
        let b = vec![mk(2, r#"{"ts":2,"x":"b"}"#), mk(2, r#"{"ts":2,"x":"a"}"#)];
        let u = union(&a, &b);
        // The duplicate (ts2,x:b) collapses; ties at ts2 order by json.
        assert_eq!(u.len(), 3);
        assert_eq!(u[0].0, 1);
        assert_eq!(u[1].2, r#"{"ts":2,"x":"a"}"#);
        assert_eq!(u[2].2, r#"{"ts":2,"x":"b"}"#);
    }
}
