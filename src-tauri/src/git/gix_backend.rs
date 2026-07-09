//! Mobile git backend built on gitoxide/`gix` (feature `git-gix`).
//!
//! Pure Rust — this is what makes git compile on iOS/Android (the M0 gate).
//! Implements the M0-M1 subset (init / is_repo / status / commit_all / log)
//! plus the read-mostly M4 operations (branches / create_branch /
//! file_at_commit / revert_file). `checkout_branch` stays `Unsupported`:
//! gix has no high-level safe-worktree-checkout API yet and a hand-rolled
//! HEAD-swap + worktree rewrite is out of the M4 mobile scope (see
//! docs/dev/M0-SPIKE-RESULTS.md, M4 addendum) — hence `capabilities().branch
//! == false` (the flag means create AND checkout are both usable).
//! Everything else falls through to the trait defaults (`Unsupported`) and is
//! reported honestly by `capabilities()`.
//!
//! Implementation notes (see docs/dev/M0-SPIKE-RESULTS.md):
//! - `status` uses `Repository::status` (tree↔index + index↔worktree with a
//!   dirwalk for untracked files), collapsing both sides into one entry per
//!   path like the libgit2 backend does.
//! - `commit_all` does NOT mutate the on-disk index to stage things. Instead
//!   it diffs the worktree against an in-memory index generated from
//!   `HEAD^{tree}`, applies the changes to a tree editor, writes the new
//!   tree + commit, then rewrites `.git/index` from the committed tree. Same
//!   observable semantics as `git add -A && git commit`.
//! - Worktree blobs are written raw (no filter/EOL conversion). Fine for
//!   Hakushi workspaces (we never set text attributes); noted in the spike
//!   report as a follow-up.

use std::path::Path;

use gix::bstr::{BStr, BString, ByteSlice};
use gix::objs::tree::EntryKind;

use super::backend::{BranchInfo, Capabilities, CommitInfo, GitBackend, GitError, StatusEntry};

pub struct GixBackend;

fn backend_err(e: impl std::fmt::Display) -> GitError {
    GitError::Backend(e.to_string())
}

fn open_repo(root: &Path) -> Result<gix::Repository, GitError> {
    // `gix::open` does no upward discovery (unlike `gix::discover`) — the
    // workspace root itself must be the repository, matching libgit2 behavior.
    gix::open(root).map_err(|e| match e {
        gix::open::Error::NotARepository { .. } => {
            GitError::NotARepository(root.display().to_string())
        }
        other => backend_err(other),
    })
}

/// Precedence when several change kinds hit the same path (mirrors the
/// if-chain in the libgit2 backend's `status_string`).
fn status_rank(status: &str) -> u8 {
    match status {
        "conflicted" => 5,
        "renamed" => 4,
        "new" => 3,
        "deleted" => 2,
        "modified" => 1,
        _ => 0,
    }
}

/// Map an index↔worktree item summary to the contract's status string.
fn summary_to_status(
    summary: gix::status::index_worktree::iter::Summary,
) -> &'static str {
    use gix::status::index_worktree::iter::Summary;
    match summary {
        Summary::Conflict => "conflicted",
        Summary::Renamed => "renamed",
        Summary::Copied | Summary::Added | Summary::IntentToAdd => "new",
        Summary::Removed => "deleted",
        Summary::Modified | Summary::TypeChange => "modified",
    }
}

/// The `(EntryKind, blob-oid)` a worktree file would have as a tree entry,
/// or `None` for things git does not track (directories, sockets, …).
fn worktree_entry(
    repo: &gix::Repository,
    root: &Path,
    rel_path: &BStr,
) -> Result<Option<(EntryKind, gix::ObjectId)>, GitError> {
    let fs_path = root.join(gix::path::from_bstr(rel_path).as_ref());
    let meta = std::fs::symlink_metadata(&fs_path).map_err(backend_err)?;

    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&fs_path).map_err(backend_err)?;
        let blob = gix::path::into_bstr(target.as_path()).into_owned();
        let id = repo.write_blob(blob.as_slice()).map_err(backend_err)?;
        return Ok(Some((EntryKind::Link, id.detach())));
    }
    if !meta.is_file() {
        return Ok(None); // directory or other untrackable kind
    }

    let bytes = std::fs::read(&fs_path).map_err(backend_err)?;
    let id = repo.write_blob(bytes).map_err(backend_err)?;

    #[cfg(unix)]
    let kind = {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            EntryKind::BlobExecutable
        } else {
            EntryKind::Blob
        }
    };
    #[cfg(not(unix))]
    let kind = EntryKind::Blob;

    Ok(Some((kind, id.detach())))
}

/// `(mode, oid)` of the tree entry at `rel_path` inside `commit`'s tree,
/// `None` if absent. Used for the `log` path filter.
fn tree_entry_at(
    repo: &gix::Repository,
    tree_id: gix::ObjectId,
    rel_path: &str,
) -> Result<Option<(gix::objs::tree::EntryMode, gix::ObjectId)>, GitError> {
    let tree = repo.find_tree(tree_id).map_err(backend_err)?;
    let entry = tree
        .lookup_entry_by_path(rel_path)
        .map_err(backend_err)?;
    Ok(entry.map(|e| (e.mode(), e.object_id())))
}

/// Author/committer source with the same fallback identity the libgit2
/// backend uses ("Hakushi <hakushi@local>"). Owns the fallback time string so
/// borrowed `SignatureRef`s stay valid for the caller's scope.
struct SigSource {
    fallback_time: String,
}

impl SigSource {
    fn new() -> Self {
        // SignatureRef.time is the raw git format "<epoch-seconds> <offset>".
        let fallback_time = format!(
            "{} +0000",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        Self { fallback_time }
    }

    fn fallback(&self) -> gix::actor::SignatureRef<'_> {
        gix::actor::SignatureRef {
            name: "Hakushi".into(),
            email: "hakushi@local".into(),
            time: &self.fallback_time,
        }
    }

    fn author<'a>(&'a self, repo: &'a gix::Repository) -> gix::actor::SignatureRef<'a> {
        match repo.author() {
            Some(Ok(sig)) => sig,
            _ => self.fallback(),
        }
    }

    fn committer<'a>(&'a self, repo: &'a gix::Repository) -> gix::actor::SignatureRef<'a> {
        match repo.committer() {
            Some(Ok(sig)) => sig,
            _ => self.fallback(),
        }
    }
}

/// The blob bytes of `rel_path` inside the tree of commit `oid_hex`,
/// `None` when no blob exists at that path (absent, or a directory).
fn blob_at_commit(
    repo: &gix::Repository,
    rel_path: &str,
    oid_hex: &str,
) -> Result<Option<Vec<u8>>, GitError> {
    let oid = gix::ObjectId::from_hex(oid_hex.as_bytes())
        .map_err(|_| GitError::Backend(format!("invalid commit id: {oid_hex}")))?;
    let commit = repo.find_commit(oid).map_err(backend_err)?;
    let tree_id = commit.tree_id().map_err(backend_err)?.detach();
    let Some((mode, blob_id)) = tree_entry_at(repo, tree_id, rel_path)? else {
        return Ok(None);
    };
    if !mode.is_blob() {
        return Ok(None); // a sub-tree (directory) is "no file at this path"
    }
    let mut blob = repo
        .find_object(blob_id)
        .map_err(backend_err)?
        .try_into_blob()
        .map_err(backend_err)?;
    Ok(Some(blob.take_data()))
}

impl GitBackend for GixBackend {
    fn name(&self) -> &'static str {
        "gix"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            init: true,
            status: true,
            commit: true,
            log: true,
            // M4: create_branch works, but checkout_branch is Unsupported
            // (no safe worktree reset in gix yet; out of M4 mobile scope).
            // The `branch` flag means BOTH are usable, so it stays false.
            branch: false,
            merge: false,
            // M7: gix does a fetch-only pull (collab refs + branch download,
            // no worktree checkout, no push — docs/dev/M7-M8-PLAN.md §1.7).
            push: false,
            pull: true,
        }
    }

    fn init(&self, root: &Path) -> Result<(), GitError> {
        if self.is_repo(root)? {
            return Ok(()); // already a repo: no-op success
        }
        gix::init(root).map_err(backend_err)?;
        Ok(())
    }

    fn is_repo(&self, root: &Path) -> Result<bool, GitError> {
        Ok(gix::open_opts(root, gix::open::Options::isolated()).is_ok())
    }

    fn status(&self, root: &Path) -> Result<Vec<StatusEntry>, GitError> {
        let repo = open_repo(root)?;
        let iter = repo
            .status(gix::progress::Discard)
            .map_err(backend_err)?
            .untracked_files(gix::status::UntrackedFiles::Files)
            .index_worktree_submodules(None)
            .into_iter(None::<BString>)
            .map_err(backend_err)?;

        // One entry per path: tree↔index and index↔worktree items may both
        // fire for the same path; keep the higher-precedence status.
        let mut by_path: std::collections::BTreeMap<String, &'static str> =
            std::collections::BTreeMap::new();
        for item in iter {
            let item = item.map_err(backend_err)?;
            let (path, status) = match &item {
                gix::status::Item::IndexWorktree(change) => {
                    // Skip stat-refresh-only items and non-file dirwalk
                    // entries (e.g. empty untracked directories).
                    let Some(summary) = change.summary() else {
                        continue;
                    };
                    if let gix::status::index_worktree::Item::DirectoryContents {
                        entry, ..
                    } = change
                    {
                        if !matches!(
                            entry.disk_kind,
                            Some(gix::dir::entry::Kind::File)
                                | Some(gix::dir::entry::Kind::Symlink)
                        ) {
                            continue;
                        }
                    }
                    (change.rela_path().to_string(), summary_to_status(summary))
                }
                gix::status::Item::TreeIndex(change) => {
                    let status = match change {
                        gix::diff::index::Change::Addition { .. } => "new",
                        gix::diff::index::Change::Deletion { .. } => "deleted",
                        gix::diff::index::Change::Modification { .. } => "modified",
                        gix::diff::index::Change::Rewrite { .. } => "renamed",
                    };
                    (change.location().to_string(), status)
                }
            };
            by_path
                .entry(path)
                .and_modify(|existing| {
                    if status_rank(status) > status_rank(existing) {
                        *existing = status;
                    }
                })
                .or_insert(status);
        }

        Ok(by_path
            .into_iter()
            .map(|(rel_path, status)| StatusEntry {
                rel_path,
                status: status.to_string(),
            })
            .collect())
    }

    fn commit_all(&self, root: &Path, message: &str) -> Result<String, GitError> {
        let repo = open_repo(root)?;

        // HEAD tree (empty tree on an unborn branch) and the parent commit.
        let head_tree_id = repo
            .head_tree_id_or_empty()
            .map_err(backend_err)?
            .detach();
        let parent: Option<gix::ObjectId> =
            repo.head().map_err(backend_err)?.id().map(|id| id.detach());

        // Diff the worktree against an in-memory index generated from
        // HEAD^{tree}: every reported change is a worktree-vs-HEAD change,
        // regardless of whatever is currently staged in .git/index.
        let baseline = repo.index_from_tree(&head_tree_id).map_err(backend_err)?;
        let iter = repo
            .status(gix::progress::Discard)
            .map_err(backend_err)?
            .index(gix::worktree::IndexPersistedOrInMemory::InMemory(baseline))
            .untracked_files(gix::status::UntrackedFiles::Files)
            .index_worktree_submodules(None)
            .into_index_worktree_iter(None::<BString>)
            .map_err(backend_err)?;

        let mut editor = repo.edit_tree(head_tree_id).map_err(backend_err)?;
        for item in iter {
            let item = item.map_err(backend_err)?;

            // Rewrites are disabled by default for index↔worktree status, but
            // handle the source side defensively should they ever appear.
            if let gix::status::index_worktree::Item::Rewrite { source, .. } = &item {
                editor.remove(source.rela_path()).map_err(backend_err)?;
            }

            let Some(summary) = item.summary() else {
                continue; // stat refresh only — content unchanged
            };
            use gix::status::index_worktree::iter::Summary;
            match summary {
                Summary::Removed => {
                    editor.remove(item.rela_path()).map_err(backend_err)?;
                }
                // Everything else means "take the worktree content",
                // including Conflict (cannot occur against a tree-derived
                // baseline index, but the worktree side is the safe choice).
                _ => {
                    let rela_path = item.rela_path().to_owned();
                    if let Some((kind, id)) = worktree_entry(&repo, root, rela_path.as_bstr())? {
                        editor
                            .upsert(rela_path.as_bstr(), kind, id)
                            .map_err(backend_err)?;
                    }
                }
            }
        }

        let new_tree = editor.write().map_err(backend_err)?.detach();
        if new_tree == head_tree_id {
            return Err(GitError::NothingToCommit);
        }

        // Author/committer from git config, falling back to the same identity
        // the libgit2 backend uses.
        let sigs = SigSource::new();
        let commit_id = repo
            .commit_as(
                sigs.committer(&repo),
                sigs.author(&repo),
                "HEAD",
                message,
                new_tree,
                parent,
            )
            .map_err(backend_err)?
            .detach();

        // Rewrite .git/index from the committed tree so a follow-up `status`
        // is clean (stat data is zeroed; gix rehashes on the next status,
        // which is correct, just not stat-fast — acceptable for M0/M1).
        let mut index = repo.index_from_tree(&new_tree).map_err(backend_err)?;
        index
            .write(gix::index::write::Options::default())
            .map_err(backend_err)?;

        Ok(commit_id.to_string())
    }

    fn log(
        &self,
        root: &Path,
        rel_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CommitInfo>, GitError> {
        let repo = open_repo(root)?;

        let Some(head_id) = repo.head().map_err(backend_err)?.id() else {
            // Unborn HEAD (no commits yet): empty history, not an error.
            return Ok(Vec::new());
        };

        let walk = repo
            .rev_walk([head_id.detach()])
            .sorting(gix::revision::walk::Sorting::ByCommitTime(
                gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
            ))
            .all()
            .map_err(backend_err)?;

        let mut out = Vec::new();
        for info in walk {
            if out.len() >= limit {
                break;
            }
            let info = info.map_err(backend_err)?;
            let commit = repo.find_commit(info.id).map_err(backend_err)?;

            if let Some(rel) = rel_path {
                let tree_id = commit.tree_id().map_err(backend_err)?.detach();
                let current = tree_entry_at(&repo, tree_id, rel)?;
                let touched = match commit.parent_ids().next() {
                    // Root commit: "touched" == present in the tree.
                    None => current.is_some(),
                    Some(parent_id) => {
                        let parent_tree_id = repo
                            .find_commit(parent_id)
                            .map_err(backend_err)?
                            .tree_id()
                            .map_err(backend_err)?
                            .detach();
                        current != tree_entry_at(&repo, parent_tree_id, rel)?
                    }
                };
                if !touched {
                    continue;
                }
            }

            let author = commit.author().map_err(backend_err)?;
            let summary = commit
                .message()
                .map(|m| m.summary().to_string())
                .unwrap_or_default();
            out.push(CommitInfo {
                oid: info.id.to_string(),
                summary,
                author_name: author.name.to_string(),
                timestamp: commit.time().map_err(backend_err)?.seconds,
            });
        }
        Ok(out)
    }

    // -- M4: branches / historical file access -------------------------------
    //
    // `checkout_branch` is deliberately NOT implemented here (trait default =
    // `Unsupported`): a correct checkout needs a safe worktree reset, which
    // gix does not offer as a high-level API yet. Out of scope for M4 mobile;
    // revisit at M6 (docs/dev/M0-SPIKE-RESULTS.md, M4 addendum).

    fn branches(&self, root: &Path) -> Result<BranchInfo, GitError> {
        let repo = open_repo(root)?;

        // Unborn HEAD reports current=None per contract; so does detached
        // HEAD (referent_name() is None then).
        let head = repo.head().map_err(backend_err)?;
        let current = if head.is_unborn() {
            None
        } else {
            head.referent_name().map(|name| name.shorten().to_string())
        };

        let platform = repo.references().map_err(backend_err)?;
        let mut branches = Vec::new();
        for reference in platform.local_branches().map_err(backend_err)? {
            let reference = reference.map_err(backend_err)?;
            branches.push(reference.name().shorten().to_string());
        }
        branches.sort();
        Ok(BranchInfo { current, branches })
    }

    fn create_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let Some(head_id) = repo.head().map_err(backend_err)?.id() else {
            return Err(GitError::Backend(
                "cannot create a branch: repository has no commits yet".to_string(),
            ));
        };
        let target = head_id.detach();
        let full_name = format!("refs/heads/{name}");
        // Explicit existence check: gix's `PreviousValue::MustNotExist`
        // tolerates re-creating a ref with the same target (idempotent
        // create), but the contract wants duplicate creation to error like
        // libgit2 does.
        if repo
            .try_find_reference(full_name.as_str())
            .map_err(backend_err)?
            .is_some()
        {
            return Err(GitError::Backend(format!("branch already exists: {name}")));
        }
        repo.reference(
            full_name.as_str(),
            target,
            gix::refs::transaction::PreviousValue::MustNotExist,
            format!("branch: Created from {target}"),
        )
        .map_err(backend_err)?;
        Ok(())
    }

    fn file_at_commit(
        &self,
        root: &Path,
        rel_path: &str,
        oid: &str,
    ) -> Result<Option<String>, GitError> {
        let repo = open_repo(root)?;
        match blob_at_commit(&repo, rel_path, oid)? {
            None => Ok(None),
            Some(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
                GitError::Backend(format!("file is not valid UTF-8: {rel_path} @ {oid}"))
            }),
        }
    }

    fn revert_file(&self, root: &Path, rel_path: &str, oid: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let bytes = blob_at_commit(&repo, rel_path, oid)?.ok_or_else(|| {
            GitError::Backend(format!("no file at {rel_path} in commit {oid}"))
        })?;
        // Restore git's own bytes into the worktree, creating parents
        // (pipeline.ts monopoly exception, docs/dev/INTERFACES.md §7.1).
        let target = root.join(rel_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(backend_err)?;
        }
        std::fs::write(&target, bytes).map_err(backend_err)?;
        Ok(())
    }

    // -- M6: refs/hakushi/* event log (docs/dev/INTERFACES.md §10.1) ---------
    //
    // `merge_branch` stays Unsupported on gix (capabilities.merge == false):
    // a safe conflict-aware worktree merge is out of the mobile scope, same
    // reasoning as checkout_branch (M4 addendum in docs/dev/M0-SPIKE-RESULTS.md).

    fn append_ref_event(
        &self,
        root: &Path,
        ref_name: &str,
        json: &str,
    ) -> Result<String, GitError> {
        let repo = open_repo(root)?;

        // Empty tree: events carry no file content, only the JSON message.
        // Write it explicitly so the object always exists in the odb.
        let empty_tree = repo
            .write_object(&gix::objs::Tree { entries: Vec::new() })
            .map_err(backend_err)?
            .detach();

        // Parent = current ref tip if the ref exists, none otherwise.
        // `commit_as` enforces this as a compare-and-swap: with a parent the
        // ref must still point at it, without one the ref must not exist.
        let parent: Option<gix::ObjectId> = match repo
            .try_find_reference(ref_name)
            .map_err(backend_err)?
        {
            Some(reference) => Some(
                reference
                    .try_id()
                    .ok_or_else(|| {
                        GitError::Backend(format!("ref is not a direct ref: {ref_name}"))
                    })?
                    .detach(),
            ),
            None => None,
        };

        let sigs = SigSource::new();
        let commit_id = repo
            .commit_as(
                sigs.committer(&repo),
                sigs.author(&repo),
                ref_name,
                json,
                empty_tree,
                parent,
            )
            .map_err(backend_err)?
            .detach();
        Ok(commit_id.to_string())
    }

    fn read_ref_events(&self, root: &Path, ref_name: &str) -> Result<Vec<String>, GitError> {
        let repo = open_repo(root)?;
        let reference = repo
            .try_find_reference(ref_name)
            .map_err(backend_err)?
            .ok_or_else(|| GitError::Backend(format!("ref not found: {ref_name}")))?;
        let mut oid = reference
            .try_id()
            .ok_or_else(|| GitError::Backend(format!("ref is not a direct ref: {ref_name}")))?
            .detach();

        // Walk the first-parent chain (newest → oldest), then reverse so the
        // result is in append (ts-ascending) order.
        let mut events = Vec::new();
        loop {
            let commit = repo.find_commit(oid).map_err(backend_err)?;
            let message = commit.message_raw().map_err(backend_err)?;
            events.push(message.to_str_lossy().trim_end().to_string());
            let parent = commit.parent_ids().next().map(|id| id.detach());
            match parent {
                Some(parent) => oid = parent,
                None => break,
            }
        }
        events.reverse();
        Ok(events)
    }

    fn list_refs(&self, root: &Path, prefix: &str) -> Result<Vec<String>, GitError> {
        let repo = open_repo(root)?;
        let platform = repo.references().map_err(backend_err)?;
        let mut names = Vec::new();
        for reference in platform
            .prefixed(prefix)
            .map_err(|e| GitError::Backend(format!("invalid ref prefix {prefix}: {e}")))?
        {
            let reference = reference.map_err(backend_err)?;
            names.push(reference.name().as_bstr().to_string());
        }
        names.sort();
        Ok(names)
    }

    // -- M7: remote read + local ref primitives for the collab union merge
    // (docs/dev/INTERFACES.md §11, docs/dev/M7-M8-PLAN.md §1.1/§1.5/§1.7) ----
    //
    // gix is read-only for remotes (writing remote config is fragile —
    // docs/dev/M7-M8-PLAN.md §1.1), and `remote_set` / `clone_repo` / `push`
    // stay Unsupported. `sync` does a fetch-only pull (see below). The ref
    // primitives below are pure-local and let `collab::sync::union_merge_all`
    // run on-device after a gix fetch.

    fn remote_get(&self, root: &Path) -> Result<Option<String>, GitError> {
        let repo = open_repo(root)?;
        // Read `remote.origin.url` from config. gix exposes remotes by name;
        // a missing origin is `None`, not an error.
        match repo.try_find_remote("origin") {
            Some(Ok(remote)) => Ok(remote
                .url(gix::remote::Direction::Fetch)
                .map(|u| u.to_bstring().to_string())),
            Some(Err(e)) => Err(backend_err(e)),
            None => Ok(None),
        }
    }

    fn append_ref_event_raw(
        &self,
        root: &Path,
        ref_name: &str,
        json: &str,
        author: &str,
        ts: i64,
    ) -> Result<String, GitError> {
        let repo = open_repo(root)?;
        let empty_tree = repo
            .write_object(&gix::objs::Tree { entries: Vec::new() })
            .map_err(backend_err)?
            .detach();
        let parent: Option<gix::ObjectId> = match repo
            .try_find_reference(ref_name)
            .map_err(backend_err)?
        {
            Some(reference) => Some(
                reference
                    .try_id()
                    .ok_or_else(|| {
                        GitError::Backend(format!("ref is not a direct ref: {ref_name}"))
                    })?
                    .detach(),
            ),
            None => None,
        };

        // Deterministic signature: name + time (epoch, +0000) come from the
        // event, email fixed — byte-identical rebuild across clones (§1.5).
        let time = format!("{ts} +0000");
        let sig = gix::actor::SignatureRef {
            name: author.into(),
            email: "hakushi@local".into(),
            time: &time,
        };
        let commit_id = repo
            .commit_as(sig, sig, ref_name, json, empty_tree, parent)
            .map_err(backend_err)?
            .detach();
        Ok(commit_id.to_string())
    }

    fn force_set_ref(&self, root: &Path, ref_name: &str, oid: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let target = gix::ObjectId::from_hex(oid.as_bytes())
            .map_err(|_| GitError::Backend(format!("invalid oid: {oid}")))?;
        repo.reference(
            ref_name,
            target,
            gix::refs::transaction::PreviousValue::Any,
            "hakushi: set collab ref",
        )
        .map_err(backend_err)?;
        Ok(())
    }

    fn delete_ref(&self, root: &Path, ref_name: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let Some(reference) = repo.try_find_reference(ref_name).map_err(backend_err)? else {
            return Ok(()); // absent → no-op success
        };
        reference.delete().map_err(backend_err)?;
        Ok(())
    }

    // Fetch-only pull (docs/dev/M7-M8-PLAN.md §1.7). Only wired when gix is the
    // selected backend; when libgit2 is also enabled it wins in
    // `git::backend()` and this is never reached (kept Unsupported to avoid
    // pulling the gix network module into the libgit2 build).
    #[cfg(all(feature = "git-gix", not(feature = "git-libgit2")))]
    fn sync(&self, root: &Path) -> Result<super::backend::SyncReport, GitError> {
        super::gix_sync::sync_gix(self, root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hakushi-gix-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_status_commit_log_roundtrip() {
        let backend = GixBackend;
        let root = tmp_repo("roundtrip");

        assert!(!backend.is_repo(&root).unwrap());
        backend.init(&root).unwrap();
        backend.init(&root).unwrap(); // idempotent no-op
        assert!(backend.is_repo(&root).unwrap());

        // Nothing to commit in an empty repo.
        assert!(matches!(
            backend.commit_all(&root, "empty"),
            Err(GitError::NothingToCommit)
        ));
        assert!(backend.log(&root, None, 100).unwrap().is_empty());

        fs::write(root.join("a.md"), "# a\n").unwrap();
        let status = backend.status(&root).unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].rel_path, "a.md");
        assert_eq!(status[0].status, "new");

        let oid1 = backend.commit_all(&root, "add a").unwrap();
        assert_eq!(oid1.len(), 40);
        assert!(backend.status(&root).unwrap().is_empty());
        assert!(matches!(
            backend.commit_all(&root, "noop"),
            Err(GitError::NothingToCommit)
        ));

        fs::write(root.join("a.md"), "# a changed\n").unwrap();
        fs::write(root.join("b.md"), "# b\n").unwrap();
        let statuses = backend.status(&root).unwrap();
        let get = |p: &str| statuses.iter().find(|s| s.rel_path == p).unwrap();
        assert_eq!(get("a.md").status, "modified");
        assert_eq!(get("b.md").status, "new");

        backend.commit_all(&root, "change a, add b").unwrap();
        assert!(backend.status(&root).unwrap().is_empty());

        fs::remove_file(root.join("b.md")).unwrap();
        let statuses = backend.status(&root).unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].status, "deleted");
        backend.commit_all(&root, "delete b").unwrap();

        let log = backend.log(&root, None, 100).unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].summary, "delete b");
        assert!(log[0].timestamp > 0);
        assert!(!log[0].author_name.is_empty());

        // Path filter: a.md was touched by commits 1 and 2 only.
        let a_log = backend.log(&root, Some("a.md"), 100).unwrap();
        assert_eq!(a_log.len(), 2);
        // b.md was touched by commits 2 and 3.
        let b_log = backend.log(&root, Some("b.md"), 100).unwrap();
        assert_eq!(b_log.len(), 2);
        // limit applies
        assert_eq!(backend.log(&root, None, 1).unwrap().len(), 1);
    }

    #[test]
    fn unsupported_ops_report_honestly() {
        let backend = GixBackend;
        let root = tmp_repo("unsupported");
        backend.init(&root).unwrap();
        // M6: merge stays unsupported on gix (no safe conflict-aware
        // worktree merge on mobile yet) — capabilities must say so.
        assert!(matches!(
            backend.merge_branch(&root, "topic"),
            Err(GitError::Unsupported("merge_branch"))
        ));
        // M4: checkout is unsupported on gix, so the branch capability
        // (which means create AND checkout) must stay false.
        assert!(matches!(
            backend.checkout_branch(&root, "topic"),
            Err(GitError::Unsupported("checkout_branch"))
        ));
        // M8: conflict material + resolve stay unsupported on gix (consistent
        // with merge — no in-memory merge or safe worktree checkout on mobile).
        assert!(matches!(
            backend.conflict_versions(&root, "topic"),
            Err(GitError::Unsupported("conflict_versions"))
        ));
        assert!(matches!(
            backend.merge_resolve(&root, "topic", Vec::new()),
            Err(GitError::Unsupported("merge_resolve"))
        ));
        let caps = backend.capabilities();
        assert!(caps.init && caps.status && caps.commit && caps.log);
        assert!(!caps.branch && !caps.merge && !caps.push);
        // M7: gix does a fetch-only pull (no push, no worktree checkout).
        assert!(caps.pull, "M7: gix fetch-only pull");
    }

    // -- M6: refs/hakushi/* event log -----------------------------------------

    #[test]
    fn ref_event_append_read_roundtrip_and_prefix_filter() {
        let backend = GixBackend;
        let root = tmp_repo("m6-events");
        backend.init(&root).unwrap();

        let issue_ref = "refs/hakushi/issues/01TESTISSUE";
        let events = [
            r#"{"v":1,"type":"create","ts":1,"author":"a","data":{"title":"t","body":"b"}}"#,
            r#"{"v":1,"type":"comment","ts":2,"author":"a","data":{"body":"c1"}}"#,
            r#"{"v":1,"type":"close","ts":3,"author":"a","data":{}}"#,
        ];

        // Works on a fresh repo (no HEAD needed) and returns distinct OIDs.
        let mut oids = Vec::new();
        for event in &events {
            let oid = backend.append_ref_event(&root, issue_ref, event).unwrap();
            assert_eq!(oid.len(), 40);
            oids.push(oid);
        }
        oids.dedup();
        assert_eq!(oids.len(), 3, "each append creates a new commit");

        // Read returns the messages in append (ts-ascending) order.
        let read = backend.read_ref_events(&root, issue_ref).unwrap();
        assert_eq!(read, events);

        // Missing ref errors.
        assert!(backend
            .read_ref_events(&root, "refs/hakushi/issues/NOPE")
            .is_err());

        // Prefix filter separates issues from prs.
        let pr_ref = "refs/hakushi/prs/01TESTPR";
        backend
            .append_ref_event(&root, pr_ref, r#"{"v":1,"type":"create","ts":4,"author":"a","data":{}}"#)
            .unwrap();
        assert_eq!(
            backend.list_refs(&root, "refs/hakushi/issues/").unwrap(),
            vec![issue_ref.to_string()]
        );
        assert_eq!(
            backend.list_refs(&root, "refs/hakushi/prs/").unwrap(),
            vec![pr_ref.to_string()]
        );
        assert_eq!(
            backend.list_refs(&root, "refs/hakushi/").unwrap(),
            vec![issue_ref.to_string(), pr_ref.to_string()]
        );
        assert!(backend.list_refs(&root, "refs/nothing/").unwrap().is_empty());

        // The event log never touches the worktree.
        assert!(backend.status(&root).unwrap().is_empty());
    }

    #[test]
    fn branch_file_at_commit_revert() {
        let backend = GixBackend;
        let root = tmp_repo("m4");
        backend.init(&root).unwrap();

        // Unborn HEAD: no branches, no current, and nothing to branch from.
        let info = backend.branches(&root).unwrap();
        assert!(info.current.is_none());
        assert!(info.branches.is_empty());
        assert!(backend.create_branch(&root, "topic").is_err());

        fs::write(root.join("a.md"), "v1\n").unwrap();
        let oid1 = backend.commit_all(&root, "c1").unwrap();
        fs::write(root.join("a.md"), "v2\n").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/b.md"), "B\n").unwrap();
        let oid2 = backend.commit_all(&root, "c2").unwrap();

        // Default branch name depends on git config (master/main): read it.
        let info = backend.branches(&root).unwrap();
        let default_branch = info.current.clone().expect("current branch after commit");
        assert_eq!(info.branches, vec![default_branch.clone()]);

        // create → listed; duplicate create errors.
        backend.create_branch(&root, "topic").unwrap();
        let info = backend.branches(&root).unwrap();
        assert_eq!(info.current.as_deref(), Some(default_branch.as_str()));
        assert_eq!(info.branches.len(), 2);
        assert!(info.branches.contains(&"topic".to_string()));
        assert!(backend.create_branch(&root, "topic").is_err());

        // The new branch points at HEAD.
        assert_eq!(
            backend.file_at_commit(&root, "a.md", &oid2).unwrap().as_deref(),
            Some("v2\n")
        );

        // file_at_commit: historical content, None for absent paths.
        assert_eq!(
            backend.file_at_commit(&root, "a.md", &oid1).unwrap().as_deref(),
            Some("v1\n")
        );
        assert!(backend
            .file_at_commit(&root, "sub/b.md", &oid1)
            .unwrap()
            .is_none());
        assert!(
            backend.file_at_commit(&root, "sub", &oid2).unwrap().is_none(),
            "a directory is not a file"
        );
        assert!(backend.file_at_commit(&root, "a.md", "not-an-oid").is_err());

        // revert_file: restores bytes, creating parents.
        fs::remove_dir_all(root.join("sub")).unwrap();
        backend.commit_all(&root, "delete sub").unwrap();
        backend.revert_file(&root, "sub/b.md", &oid2).unwrap();
        assert_eq!(fs::read_to_string(root.join("sub/b.md")).unwrap(), "B\n");
        backend.revert_file(&root, "a.md", &oid1).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "v1\n");
        // Absent at that commit → error, worktree untouched.
        assert!(backend.revert_file(&root, "sub/b.md", &oid1).is_err());
        assert_eq!(fs::read_to_string(root.join("sub/b.md")).unwrap(), "B\n");
    }
}
