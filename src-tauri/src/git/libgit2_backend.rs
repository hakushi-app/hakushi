//! Desktop git backend built on libgit2 (feature `git-libgit2`).
//!
//! Implements the M0-M1 subset of `GitBackend` (init / is_repo / status /
//! commit_all / log) plus the M4 surface (branches / create_branch /
//! checkout_branch / file_at_commit / revert_file). Everything else falls
//! through to the trait defaults (`GitError::Unsupported`) and is reported as
//! such in `capabilities()`.

use std::path::Path;

use git2::{
    build::CheckoutBuilder, build::RepoBuilder, AutotagOption, BranchType, Commit, Cred,
    DiffOptions, ErrorCode, FetchOptions, IndexAddOption, Oid, RemoteCallbacks, Repository,
    Signature, Sort, Status, StatusOptions,
};

use super::backend::{
    BranchInfo, Capabilities, CommitInfo, ConflictFile, GitBackend, GitError, MergeOutcome,
    ResolvedFile, StatusEntry, SyncReport,
};

/// The remote we manage (single-remote model, docs/dev/M7-M8-PLAN.md §1.1).
pub(super) const ORIGIN: &str = "origin";

/// Fixed email for rebuilt collab commits so a deterministic rebuild is
/// byte-identical across clones (author name + ts come from the event).
const HAKUSHI_EMAIL: &str = "hakushi@local";

/// Fetch refspecs (docs/dev/M7-M8-PLAN.md §1.4 step 2): branch heads into the
/// usual remote-tracking namespace, collab refs into a private tracking
/// namespace kept separate from `refs/remotes/*`.
pub(super) const FETCH_REFSPECS: [&str; 2] = [
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/hakushi/*:refs/hakushi-remote/*",
];

pub struct Libgit2Backend;

fn map_err(e: git2::Error) -> GitError {
    GitError::Backend(e.message().to_string())
}

fn open_repo(root: &Path) -> Result<Repository, GitError> {
    Repository::open(root).map_err(|e| match e.code() {
        ErrorCode::NotFound => GitError::NotARepository(root.display().to_string()),
        _ => map_err(e),
    })
}

/// Map a libgit2 status bitfield to the contract's status string.
/// Considers both index (staged) and worktree sides.
fn status_string(s: Status) -> Option<&'static str> {
    if s.is_conflicted() {
        Some("conflicted")
    } else if s.contains(Status::WT_RENAMED) || s.contains(Status::INDEX_RENAMED) {
        Some("renamed")
    } else if s.contains(Status::WT_NEW) || s.contains(Status::INDEX_NEW) {
        Some("new")
    } else if s.contains(Status::WT_DELETED) || s.contains(Status::INDEX_DELETED) {
        Some("deleted")
    } else if s.contains(Status::WT_MODIFIED)
        || s.contains(Status::INDEX_MODIFIED)
        || s.contains(Status::WT_TYPECHANGE)
        || s.contains(Status::INDEX_TYPECHANGE)
    {
        Some("modified")
    } else {
        None // CURRENT / IGNORED / anything we don't surface
    }
}

/// Default signature, falling back to "Hakushi <hakushi@local>" when no
/// user.name/user.email is configured.
fn signature(repo: &Repository) -> Result<Signature<'static>, GitError> {
    match repo.signature() {
        Ok(sig) => Ok(sig),
        Err(_) => Signature::now("Hakushi", "hakushi@local").map_err(map_err),
    }
}

/// HEAD commit, or `None` on an unborn branch (fresh repo before the first
/// commit).
fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, GitError> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit().map_err(map_err)?)),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// The blob bytes of `rel_path` inside the tree of commit `oid_hex`,
/// `None` when no blob exists at that path (absent, or a directory).
fn blob_at_commit(
    repo: &Repository,
    rel_path: &str,
    oid_hex: &str,
) -> Result<Option<Vec<u8>>, GitError> {
    let oid = Oid::from_str(oid_hex)
        .map_err(|_| GitError::Backend(format!("invalid commit id: {oid_hex}")))?;
    let commit = repo.find_commit(oid).map_err(map_err)?;
    let tree = commit.tree().map_err(map_err)?;
    let entry = match tree.get_path(Path::new(rel_path)) {
        Ok(entry) => entry,
        Err(e) if e.code() == ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(map_err(e)),
    };
    let object = entry.to_object(repo).map_err(map_err)?;
    match object.as_blob() {
        Some(blob) => Ok(Some(blob.content().to_vec())),
        None => Ok(None), // a directory (sub-tree) is "no file at this path"
    }
}

/// Does `commit` touch `rel_path` (compared against its first parent, or
/// simple tree presence for a root commit)?
fn commit_touches_path(
    repo: &Repository,
    commit: &Commit<'_>,
    rel_path: &str,
) -> Result<bool, GitError> {
    let tree = commit.tree().map_err(map_err)?;
    if commit.parent_count() == 0 {
        return Ok(tree.get_path(Path::new(rel_path)).is_ok());
    }
    let parent_tree = commit
        .parent(0)
        .and_then(|p| p.tree())
        .map_err(map_err)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(rel_path);
    let diff = repo
        .diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(&mut opts))
        .map_err(map_err)?;
    Ok(diff.deltas().len() > 0)
}

/// Build `RemoteCallbacks` with a credentials handler that pulls the PAT for
/// `url`'s host from the keychain (docs/dev/M7-M8-PLAN.md §1.2). file:// and
/// local-path remotes carry no host, so no credentials are attempted (git
/// falls through to the anonymous transport). The `url` is owned by the caller
/// and must outlive the callbacks.
pub(super) fn remote_callbacks(url: &str) -> RemoteCallbacks<'_> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, username_from_url, allowed| {
        // SSH is out of M7 scope; only user/pass (PAT over https) is handled.
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Some((user, token)) = crate::credentials::token_for_url(url) {
                return Cred::userpass_plaintext(user, &token);
            }
        }
        // Some transports request a default before the userpass round; honor
        // an explicit username if libgit2 supplies one.
        if allowed.contains(git2::CredentialType::USERNAME) {
            if let Some(name) = username_from_url {
                return Cred::username(name);
            }
        }
        Err(git2::Error::from_str(
            "no credential available: save a personal access token in sync settings",
        ))
    });
    cb
}

/// Resolve the `origin` remote, erroring with the contract message when it is
/// unset.
pub(super) fn origin_remote(repo: &Repository) -> Result<git2::Remote<'_>, GitError> {
    repo.find_remote(ORIGIN).map_err(|e| match e.code() {
        ErrorCode::NotFound => {
            GitError::Backend("no remote configured: add a remote URL in sync settings".to_string())
        }
        _ => map_err(e),
    })
}

/// Placeholder text surfaced for a conflicting binary (non-UTF-8) blob. M8
/// assumes text `.md`; a binary conflict is reported as a paragraph note so the
/// TS resolver never receives raw bytes (docs/dev/M7-M8-PLAN.md §2.1.1).
const BINARY_CONFLICT_NOTE: &str = "(binary file — resolve on desktop with git)";

/// Decode a merge-index conflict entry's blob to a `String`, substituting the
/// binary placeholder on non-UTF-8 content. `None` entry (a stage absent from
/// the merge, e.g. a side deleted the file) decodes to the empty string, so the
/// TS resolver treats "deleted" as "empty".
fn decode_conflict_blob(
    repo: &Repository,
    entry: Option<&git2::IndexEntry>,
) -> Result<String, GitError> {
    let Some(entry) = entry else {
        return Ok(String::new());
    };
    let blob = repo.find_blob(entry.id).map_err(map_err)?;
    Ok(match std::str::from_utf8(blob.content()) {
        Ok(text) => text.to_string(),
        Err(_) => BINARY_CONFLICT_NOTE.to_string(),
    })
}

/// Sentinel `source` the conflict-resolution flow uses when the conflict came
/// from a `git_sync` merge against the remote-tracking branch rather than a
/// named local branch (there is no incoming branch name in the sync flow).
/// The TS side (`tauri-mock` / `ConflictResolver`) uses the same literal.
const SYNC_CONFLICT_SOURCE: &str = "__sync__";

/// Resolve the current branch tip (`ours`) and `source` branch tip (`theirs`)
/// as commits, for an in-memory 3-way merge. Errors when HEAD is unborn or
/// `source` does not exist — the contract's readable messages.
///
/// `source` accepts, in order of precedence: the `__sync__` sentinel
/// (resolves to `origin/<current branch>`, the endpoint a sync conflict merged
/// against), a local branch name, or any resolvable revspec / remote-tracking
/// ref (e.g. `origin/main`). This keeps the PR-merge path (local branch names)
/// working while letting a sync conflict be resolved through the same command.
fn merge_endpoints<'r>(
    repo: &'r Repository,
    source: &str,
) -> Result<(Commit<'r>, Commit<'r>), GitError> {
    let ours = head_commit(repo)?.ok_or_else(|| {
        GitError::Backend("cannot merge: current branch has no commits yet".to_string())
    })?;

    // Map the sync sentinel to the current branch's remote-tracking ref.
    let source = if source == SYNC_CONFLICT_SOURCE {
        let head = repo.head().map_err(map_err)?;
        let branch = head.shorthand().ok_or_else(|| {
            GitError::Backend("cannot resolve conflict: HEAD is not on a branch".to_string())
        })?;
        format!("origin/{branch}")
    } else {
        source.to_string()
    };

    // Prefer an exact local branch (the PR-merge path). Fall back to a general
    // revspec so remote-tracking refs like `origin/main` resolve too.
    let theirs = match repo.find_branch(&source, BranchType::Local) {
        Ok(branch) => branch.get().peel_to_commit().map_err(map_err)?,
        Err(e) if e.code() == ErrorCode::NotFound => repo
            .revparse_single(&source)
            .map_err(|e| match e.code() {
                ErrorCode::NotFound => GitError::Backend(format!("branch not found: {source}")),
                _ => map_err(e),
            })?
            .peel_to_commit()
            .map_err(map_err)?,
        Err(e) => return Err(map_err(e)),
    };
    Ok((ours, theirs))
}

impl GitBackend for Libgit2Backend {
    fn name(&self) -> &'static str {
        "libgit2"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            init: true,
            status: true,
            commit: true,
            log: true,
            branch: true, // M4: create_branch + checkout_branch both work
            merge: true,  // M6: merge_branch (fast-forward / merge / conflicts)
            push: true,   // M7: git_sync pushes heads + refs/hakushi/*
            pull: true,   // M7: git_sync fetches + integrates
        }
    }

    fn init(&self, root: &Path) -> Result<(), GitError> {
        if self.is_repo(root)? {
            return Ok(()); // already a repo: no-op success
        }
        Repository::init(root).map_err(map_err)?;
        Ok(())
    }

    fn is_repo(&self, root: &Path) -> Result<bool, GitError> {
        // Repository::open does no upward discovery — exactly what we want:
        // the workspace root itself must be the repo.
        Ok(Repository::open(root).is_ok())
    }

    fn status(&self, root: &Path) -> Result<Vec<StatusEntry>, GitError> {
        let repo = open_repo(root)?;
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .exclude_submodules(true)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(map_err)?;

        let mut entries = Vec::new();
        for entry in statuses.iter() {
            let Some(status) = status_string(entry.status()) else {
                continue;
            };
            // Prefer the delta's new-file path (correct side for renames);
            // fall back to the raw entry path.
            let rel_path = entry
                .index_to_workdir()
                .and_then(|d| d.new_file().path())
                .or_else(|| entry.head_to_index().and_then(|d| d.new_file().path()))
                .and_then(|p| p.to_str())
                .map(str::to_string)
                .or_else(|| entry.path().map(str::to_string));
            let Some(rel_path) = rel_path else { continue };
            entries.push(StatusEntry {
                rel_path,
                status: status.to_string(),
            });
        }
        Ok(entries)
    }

    fn commit_all(&self, root: &Path, message: &str) -> Result<String, GitError> {
        let repo = open_repo(root)?;

        // `git add -A`: add_all picks up new/modified, update_all picks up
        // deletions of already-tracked files.
        let mut index = repo.index().map_err(map_err)?;
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(map_err)?;
        index.update_all(["*"].iter(), None).map_err(map_err)?;
        index.write().map_err(map_err)?;
        let tree_oid = index.write_tree().map_err(map_err)?;

        let parent = head_commit(&repo)?;
        match &parent {
            Some(parent_commit) => {
                if parent_commit.tree_id() == tree_oid {
                    return Err(GitError::NothingToCommit);
                }
            }
            None => {
                // Initial commit: an empty index means an empty workspace.
                if index.is_empty() {
                    return Err(GitError::NothingToCommit);
                }
            }
        }

        let sig = signature(&repo)?;
        let tree = repo.find_tree(tree_oid).map_err(map_err)?;
        let parents: Vec<&Commit<'_>> = parent.iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .map_err(map_err)?;
        Ok(oid.to_string())
    }

    fn log(
        &self,
        root: &Path,
        rel_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CommitInfo>, GitError> {
        let repo = open_repo(root)?;

        let mut walk = match repo.revwalk() {
            Ok(walk) => walk,
            Err(e) => return Err(map_err(e)),
        };
        walk.set_sorting(Sort::TIME).map_err(map_err)?;
        if walk.push_head().is_err() {
            // Unborn HEAD (no commits yet): empty history, not an error.
            return Ok(Vec::new());
        }

        let mut out = Vec::new();
        for oid in walk {
            if out.len() >= limit {
                break;
            }
            let oid = oid.map_err(map_err)?;
            let commit = repo.find_commit(oid).map_err(map_err)?;
            if let Some(rel) = rel_path {
                if !commit_touches_path(&repo, &commit, rel)? {
                    continue;
                }
            }
            out.push(CommitInfo {
                oid: oid.to_string(),
                summary: commit.summary().unwrap_or("").to_string(),
                author_name: commit.author().name().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
            });
        }
        Ok(out)
    }

    // -- M4: branches / checkout / historical file access --------------------

    fn branches(&self, root: &Path) -> Result<BranchInfo, GitError> {
        let repo = open_repo(root)?;

        // Unborn HEAD (fresh repo) and detached HEAD both report None.
        let current = match repo.head() {
            Ok(head) if head.is_branch() => head.shorthand().map(str::to_string),
            Ok(_) => None, // detached HEAD
            Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => None,
            Err(e) => return Err(map_err(e)),
        };

        let mut branches = Vec::new();
        for item in repo.branches(Some(BranchType::Local)).map_err(map_err)? {
            let (branch, _) = item.map_err(map_err)?;
            if let Some(name) = branch.name().map_err(map_err)? {
                branches.push(name.to_string());
            }
        }
        branches.sort();
        Ok(BranchInfo { current, branches })
    }

    fn create_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let head = head_commit(&repo)?.ok_or_else(|| {
            GitError::Backend("cannot create a branch: repository has no commits yet".to_string())
        })?;
        repo.branch(name, &head, false).map_err(map_err)?;
        Ok(())
    }

    fn checkout_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;

        // Contract (docs/dev/INTERFACES.md §7.1): refuse on a dirty worktree.
        if !self.status(root)?.is_empty() {
            return Err(GitError::Backend(
                "working tree has uncommitted changes: commit or discard changes first"
                    .to_string(),
            ));
        }

        let branch = repo
            .find_branch(name, BranchType::Local)
            .map_err(|e| match e.code() {
                ErrorCode::NotFound => GitError::Backend(format!("branch not found: {name}")),
                _ => map_err(e),
            })?;
        let commit = branch.get().peel_to_commit().map_err(map_err)?;

        // Safe checkout: the tree is clean (checked above), so this only
        // updates files that differ between the two branch tips.
        let mut opts = CheckoutBuilder::new();
        opts.safe();
        repo.checkout_tree(commit.as_object(), Some(&mut opts))
            .map_err(map_err)?;
        repo.set_head(&format!("refs/heads/{name}")).map_err(map_err)?;
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
            std::fs::create_dir_all(parent).map_err(|e| GitError::Backend(e.to_string()))?;
        }
        std::fs::write(&target, bytes).map_err(|e| GitError::Backend(e.to_string()))?;
        Ok(())
    }

    // -- M6: refs/hakushi/* event log + merge (docs/dev/INTERFACES.md §10) ---

    fn append_ref_event(
        &self,
        root: &Path,
        ref_name: &str,
        json: &str,
    ) -> Result<String, GitError> {
        let repo = open_repo(root)?;

        // Empty tree: events carry no file content, only the JSON message.
        let tree_oid = {
            let builder = repo.treebuilder(None).map_err(map_err)?;
            builder.write().map_err(map_err)?
        };
        let tree = repo.find_tree(tree_oid).map_err(map_err)?;

        // Parent = current ref tip if the ref exists, none otherwise.
        let parent = match repo.find_reference(ref_name) {
            Ok(reference) => Some(reference.peel_to_commit().map_err(map_err)?),
            Err(e) if e.code() == ErrorCode::NotFound => None,
            Err(e) => return Err(map_err(e)),
        };
        let parents: Vec<&Commit<'_>> = parent.iter().collect();

        // Same signature fallback as commit_all. Passing the ref name as
        // update_ref creates the ref or moves it to the new commit.
        let sig = signature(&repo)?;
        let oid = repo
            .commit(Some(ref_name), &sig, &sig, json, &tree, &parents)
            .map_err(map_err)?;
        Ok(oid.to_string())
    }

    fn read_ref_events(&self, root: &Path, ref_name: &str) -> Result<Vec<String>, GitError> {
        let repo = open_repo(root)?;
        let reference = repo.find_reference(ref_name).map_err(|e| match e.code() {
            ErrorCode::NotFound => GitError::Backend(format!("ref not found: {ref_name}")),
            _ => map_err(e),
        })?;
        let mut commit = reference.peel_to_commit().map_err(map_err)?;

        // Walk the first-parent chain (newest → oldest), then reverse so the
        // result is in append (ts-ascending) order.
        let mut events = Vec::new();
        loop {
            events.push(commit.message().unwrap_or("").trim_end().to_string());
            match commit.parent_count() {
                0 => break,
                _ => commit = commit.parent(0).map_err(map_err)?,
            }
        }
        events.reverse();
        Ok(events)
    }

    fn list_refs(&self, root: &Path, prefix: &str) -> Result<Vec<String>, GitError> {
        let repo = open_repo(root)?;
        let glob = format!("{prefix}*");
        let mut names = Vec::new();
        for reference in repo.references_glob(&glob).map_err(map_err)? {
            let reference = reference.map_err(map_err)?;
            if let Some(name) = reference.name() {
                names.push(name.to_string());
            }
        }
        names.sort();
        Ok(names)
    }

    fn merge_branch(&self, root: &Path, source: &str) -> Result<MergeOutcome, GitError> {
        let repo = open_repo(root)?;

        // Contract (docs/dev/INTERFACES.md §10.2): never start a merge on a
        // dirty worktree — same message pattern as checkout_branch.
        if !self.status(root)?.is_empty() {
            return Err(GitError::Backend(
                "working tree has uncommitted changes: commit or discard changes first"
                    .to_string(),
            ));
        }

        let branch = repo
            .find_branch(source, BranchType::Local)
            .map_err(|e| match e.code() {
                ErrorCode::NotFound => GitError::Backend(format!("branch not found: {source}")),
                _ => map_err(e),
            })?;
        let annotated = repo
            .reference_to_annotated_commit(branch.get())
            .map_err(map_err)?;

        let (analysis, _prefs) = repo.merge_analysis(&[&annotated]).map_err(map_err)?;

        if analysis.is_up_to_date() {
            // Nothing to do: report as a no-op fast-forward.
            return Ok(MergeOutcome {
                kind: "fastForward".to_string(),
                conflict_paths: Vec::new(),
            });
        }

        if analysis.is_unborn() {
            return Err(GitError::Backend(
                "cannot merge: current branch has no commits yet".to_string(),
            ));
        }

        if analysis.is_fast_forward() {
            let target_oid = annotated.id();
            let commit = repo.find_commit(target_oid).map_err(map_err)?;
            // Tree first (worktree is clean → safe checkout), then move the
            // current branch ref onto the source tip.
            let mut opts = CheckoutBuilder::new();
            opts.safe();
            repo.checkout_tree(commit.as_object(), Some(&mut opts))
                .map_err(map_err)?;
            repo.head()
                .map_err(map_err)?
                .set_target(target_oid, &format!("merge {source}: Fast-forward"))
                .map_err(map_err)?;
            return Ok(MergeOutcome {
                kind: "fastForward".to_string(),
                conflict_paths: Vec::new(),
            });
        }

        if !analysis.is_normal() {
            return Err(GitError::Backend(format!(
                "merge of '{source}' is not possible"
            )));
        }

        // Normal merge: stages the result into the index and worktree.
        repo.merge(&[&annotated], None, None).map_err(map_err)?;

        let mut index = repo.index().map_err(map_err)?;
        if index.has_conflicts() {
            // Collect conflicting paths, then abort cleanly: drop the merge
            // state and force-restore index + worktree to HEAD (the worktree
            // was clean before the merge, so this is exactly the pre-merge
            // state).
            let mut paths = Vec::new();
            for conflict in index.conflicts().map_err(map_err)? {
                let conflict = conflict.map_err(map_err)?;
                let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
                if let Some(entry) = entry {
                    if let Ok(path) = String::from_utf8(entry.path) {
                        paths.push(path);
                    }
                }
            }
            paths.sort();
            paths.dedup();

            repo.cleanup_state().map_err(map_err)?;
            let head = repo.head().map_err(map_err)?.peel_to_commit().map_err(map_err)?;
            let mut opts = CheckoutBuilder::new();
            opts.force();
            repo.checkout_tree(head.as_object(), Some(&mut opts))
                .map_err(map_err)?;
            let mut index = repo.index().map_err(map_err)?;
            index
                .read_tree(&head.tree().map_err(map_err)?)
                .map_err(map_err)?;
            index.write().map_err(map_err)?;

            return Ok(MergeOutcome {
                kind: "conflicts".to_string(),
                conflict_paths: paths,
            });
        }

        // Clean automerge: commit the staged result with both parents.
        let tree_oid = index.write_tree().map_err(map_err)?;
        let tree = repo.find_tree(tree_oid).map_err(map_err)?;
        let ours = repo.head().map_err(map_err)?.peel_to_commit().map_err(map_err)?;
        let theirs = repo.find_commit(annotated.id()).map_err(map_err)?;
        let sig = signature(&repo)?;
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("Merge branch '{source}'"),
            &tree,
            &[&ours, &theirs],
        )
        .map_err(map_err)?;
        repo.cleanup_state().map_err(map_err)?;
        let mut opts = CheckoutBuilder::new();
        opts.safe();
        repo.checkout_head(Some(&mut opts)).map_err(map_err)?;

        Ok(MergeOutcome {
            kind: "merged".to_string(),
            conflict_paths: Vec::new(),
        })
    }

    // -- M8: conflict material + resolve (docs/dev/INTERFACES.md §12.1) -------

    fn conflict_versions(
        &self,
        root: &Path,
        source: &str,
    ) -> Result<Vec<ConflictFile>, GitError> {
        let repo = open_repo(root)?;
        let (ours, theirs) = merge_endpoints(&repo, source)?;

        // In-memory 3-way merge (no worktree, no index, no refs touched):
        // libgit2 finds the merge-base itself and records conflict stages
        // (1 = base/ancestor, 2 = ours, 3 = theirs) in the returned index.
        let index = repo
            .merge_commits(&ours, &theirs, None)
            .map_err(map_err)?;

        if !index.has_conflicts() {
            return Ok(Vec::new());
        }

        let mut files = Vec::new();
        for conflict in index.conflicts().map_err(map_err)? {
            let conflict = conflict.map_err(map_err)?;
            // A path with no ancestor/ours/theirs entry at all cannot happen
            // for a real conflict; pick whichever side carries the path.
            let rel_path = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref())
                .and_then(|e| String::from_utf8(e.path.clone()).ok());
            let Some(rel_path) = rel_path else { continue };

            let base = match &conflict.ancestor {
                Some(entry) => Some(decode_conflict_blob(&repo, Some(entry))?),
                None => None,
            };
            let ours_content = decode_conflict_blob(&repo, conflict.our.as_ref())?;
            let theirs_content = decode_conflict_blob(&repo, conflict.their.as_ref())?;

            files.push(ConflictFile {
                rel_path,
                base,
                ours: ours_content,
                theirs: theirs_content,
            });
        }
        // Stable, deterministic order for the resolver UI.
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(files)
    }

    fn merge_resolve(
        &self,
        root: &Path,
        source: &str,
        resolved: Vec<ResolvedFile>,
    ) -> Result<String, GitError> {
        let repo = open_repo(root)?;

        // Same refusal as merge_branch: never complete a merge on a dirty
        // worktree (the checkout at the end would otherwise clobber changes).
        if !self.status(root)?.is_empty() {
            return Err(GitError::Backend(
                "working tree has uncommitted changes: commit or discard changes first"
                    .to_string(),
            ));
        }

        let (ours, theirs) = merge_endpoints(&repo, source)?;

        // Recompute the same in-memory merge index the resolver was built from.
        let mut index = repo
            .merge_commits(&ours, &theirs, None)
            .map_err(map_err)?;

        // Which paths are still conflicted? Every one must be covered by
        // `resolved` (partial resolution is not allowed, §12.1).
        let mut conflicted: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for conflict in index.conflicts().map_err(map_err)? {
            let conflict = conflict.map_err(map_err)?;
            let path = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref())
                .and_then(|e| String::from_utf8(e.path.clone()).ok());
            if let Some(path) = path {
                conflicted.insert(path);
            }
        }

        // Validate the provided set first: every resolved path must have been
        // in conflict (never silently overwrite an auto-merged file).
        for file in &resolved {
            if !conflicted.contains(&file.rel_path) {
                return Err(GitError::Backend(format!(
                    "resolved file was not in conflict: {}",
                    file.rel_path
                )));
            }
        }

        // Then require full coverage: partial resolution is not allowed.
        let provided: std::collections::BTreeSet<&str> =
            resolved.iter().map(|r| r.rel_path.as_str()).collect();
        let missing: Vec<String> = conflicted
            .iter()
            .filter(|p| !provided.contains(p.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(GitError::Backend(format!(
                "unresolved conflicting files: {}",
                missing.join(", ")
            )));
        }

        // Splice each resolved blob in as a stage-0 (resolved) index entry.
        // The merge index from `merge_commits` is not backed by an odb, so we
        // write each blob into `repo` ourselves and add an entry carrying that
        // blob oid; `index.add` replaces the path (clearing its stage-1/2/3
        // conflict entries) without needing a backing repository.
        for file in &resolved {
            let blob_oid = repo.blob(file.content.as_bytes()).map_err(map_err)?;
            // Drop all three conflict stages for this path first, then add the
            // resolved blob as a stage-0 entry (libgit2's `add` does not clear
            // higher stages on its own).
            index
                .remove_path(Path::new(&file.rel_path))
                .map_err(map_err)?;
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: file.content.len() as u32,
                id: blob_oid,
                flags: 0,
                flags_extended: 0,
                path: file.rel_path.clone().into_bytes(),
            };
            index.add(&entry).map_err(map_err)?;
        }

        if index.has_conflicts() {
            // Defensive: the coverage check above should have caught this.
            return Err(GitError::Backend(
                "conflicts remain after applying resolutions".to_string(),
            ));
        }

        // Write the resolved tree into the repo's object db. `write_tree_to`
        // targets `repo` explicitly since this index is detached (produced by
        // merge_commits, not backed by `.git/index`).
        let tree_oid = index.write_tree_to(&repo).map_err(map_err)?;
        let tree = repo.find_tree(tree_oid).map_err(map_err)?;

        // 2-parent merge commit on the current branch. HEAD points at `ours`.
        // A sync conflict has no incoming branch name, so give it a message
        // that reflects the remote-tracking merge instead of the sentinel.
        let sig = signature(&repo)?;
        let merge_message = if source == SYNC_CONFLICT_SOURCE {
            "Merge remote changes (conflicts resolved)".to_string()
        } else {
            format!("Merge branch '{source}'")
        };
        let merge_oid = repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                &merge_message,
                &tree,
                &[&ours, &theirs],
            )
            .map_err(map_err)?;

        // Sync the worktree to the new commit. The tree was clean before (dirty
        // check above), so a forced checkout only writes the merged result.
        let merge_commit = repo.find_commit(merge_oid).map_err(map_err)?;
        let mut opts = CheckoutBuilder::new();
        opts.force();
        repo.checkout_tree(merge_commit.as_object(), Some(&mut opts))
            .map_err(map_err)?;
        // Reset .git/index to the committed tree so a follow-up status is clean.
        let mut wt_index = repo.index().map_err(map_err)?;
        wt_index.read_tree(&tree).map_err(map_err)?;
        wt_index.write().map_err(map_err)?;

        Ok(merge_oid.to_string())
    }

    // -- M7: remotes / credentials-aware fetch·push / clone / rebuild / sync
    // (docs/dev/INTERFACES.md §11, docs/dev/M7-M8-PLAN.md §1) ----------------

    fn remote_get(&self, root: &Path) -> Result<Option<String>, GitError> {
        let repo = open_repo(root)?;
        let url = match repo.find_remote(ORIGIN) {
            Ok(remote) => Ok(remote.url().map(str::to_string)),
            Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
            Err(e) => Err(map_err(e)),
        };
        url
    }

    fn remote_set(&self, root: &Path, url: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        // Create origin if absent, otherwise repoint it. `remote_set_url`
        // persists to config without touching fetch refspecs (we pass explicit
        // refspecs at fetch/push time).
        match repo.find_remote(ORIGIN) {
            Ok(_) => repo.remote_set_url(ORIGIN, url).map_err(map_err)?,
            Err(e) if e.code() == ErrorCode::NotFound => {
                repo.remote(ORIGIN, url).map_err(map_err)?;
            }
            Err(e) => return Err(map_err(e)),
        }
        Ok(())
    }

    fn clone_repo(&self, url: &str, dest: &Path) -> Result<(), GitError> {
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(remote_callbacks(url));
        fo.download_tags(AutotagOption::None);
        RepoBuilder::new()
            .fetch_options(fo)
            .clone(url, dest)
            .map_err(map_err)?;
        Ok(())
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
        let tree_oid = {
            let builder = repo.treebuilder(None).map_err(map_err)?;
            builder.write().map_err(map_err)?
        };
        let tree = repo.find_tree(tree_oid).map_err(map_err)?;

        let parent = match repo.find_reference(ref_name) {
            Ok(reference) => Some(reference.peel_to_commit().map_err(map_err)?),
            Err(e) if e.code() == ErrorCode::NotFound => None,
            Err(e) => return Err(map_err(e)),
        };
        let parents: Vec<&Commit<'_>> = parent.iter().collect();

        // Deterministic signature: author name + time come from the event, so
        // the same event set rebuilds to the same commit oids on every clone
        // (docs/dev/M7-M8-PLAN.md §1.5). Time offset fixed to +0000.
        let when = git2::Time::new(ts, 0);
        let sig = Signature::new(author, HAKUSHI_EMAIL, &when).map_err(map_err)?;
        let oid = repo
            .commit(Some(ref_name), &sig, &sig, json, &tree, &parents)
            .map_err(map_err)?;
        Ok(oid.to_string())
    }

    fn force_set_ref(&self, root: &Path, ref_name: &str, oid: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let target = Oid::from_str(oid)
            .map_err(|_| GitError::Backend(format!("invalid oid: {oid}")))?;
        repo.reference(ref_name, target, true, "hakushi: set collab ref")
            .map_err(map_err)?;
        Ok(())
    }

    fn delete_ref(&self, root: &Path, ref_name: &str) -> Result<(), GitError> {
        let repo = open_repo(root)?;
        let result = match repo.find_reference(ref_name) {
            Ok(mut reference) => reference.delete().map_err(map_err),
            Err(e) if e.code() == ErrorCode::NotFound => Ok(()),
            Err(e) => Err(map_err(e)),
        };
        result
    }

    fn sync(&self, root: &Path) -> Result<SyncReport, GitError> {
        super::sync::sync_libgit2(self, root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hakushi-git-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_status_commit_log_roundtrip() {
        let backend = Libgit2Backend;
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
        let backend = Libgit2Backend;
        let root = tmp_repo("unsupported");
        backend.init(&root).unwrap();
        // `diff` stays a Unsupported trait default on libgit2 (M7 does not add
        // it); network ops now route through `sync`, so the low-level `push` /
        // `pull` / `fetch` trait methods remain unused defaults too.
        assert!(matches!(
            backend.diff(&root, "a", "b"),
            Err(GitError::Unsupported("diff"))
        ));
        let caps = backend.capabilities();
        assert!(caps.init && caps.status && caps.commit && caps.log);
        assert!(caps.branch, "M4: create+checkout both usable on libgit2");
        assert!(caps.merge, "M6: merge_branch usable on libgit2");
        assert!(caps.push && caps.pull, "M7: sync provides push/pull on libgit2");
    }

    #[test]
    fn branch_checkout_file_at_commit_revert() {
        let backend = Libgit2Backend;
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

        // Dirty tree refuses checkout with the contract message.
        fs::write(root.join("a.md"), "dirty\n").unwrap();
        let err = backend.checkout_branch(&root, "topic").unwrap_err();
        assert!(
            err.to_string().contains("commit or discard changes first"),
            "got: {err}"
        );
        fs::write(root.join("a.md"), "v2\n").unwrap(); // clean again

        // Clean tree switches; missing branch errors.
        assert!(backend.checkout_branch(&root, "nope").is_err());
        backend.checkout_branch(&root, "topic").unwrap();
        assert_eq!(
            backend.branches(&root).unwrap().current.as_deref(),
            Some("topic")
        );

        // Diverge on topic, then switch back: worktree follows the branch.
        fs::write(root.join("a.md"), "topic\n").unwrap();
        backend.commit_all(&root, "topic change").unwrap();
        backend.checkout_branch(&root, &default_branch).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "v2\n");
        assert_eq!(
            backend.branches(&root).unwrap().current.as_deref(),
            Some(default_branch.as_str())
        );

        // file_at_commit: historical content, None for absent paths.
        assert_eq!(
            backend.file_at_commit(&root, "a.md", &oid1).unwrap().as_deref(),
            Some("v1\n")
        );
        assert_eq!(
            backend.file_at_commit(&root, "a.md", &oid2).unwrap().as_deref(),
            Some("v2\n")
        );
        assert!(backend
            .file_at_commit(&root, "sub/b.md", &oid1)
            .unwrap()
            .is_none());
        assert!(backend
            .file_at_commit(&root, "sub", &oid2)
            .unwrap()
            .is_none(), "a directory is not a file");
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

    // -- M6: refs/hakushi/* event log + merge --------------------------------

    #[test]
    fn ref_event_append_read_roundtrip_and_prefix_filter() {
        let backend = Libgit2Backend;
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

    /// Base repo for merge tests: one commit on the default branch, returns
    /// the default branch name.
    fn merge_fixture(backend: &Libgit2Backend, root: &Path) -> String {
        backend.init(root).unwrap();
        fs::write(root.join("base.md"), "base\n").unwrap();
        backend.commit_all(root, "base").unwrap();
        backend
            .branches(root)
            .unwrap()
            .current
            .expect("current branch after first commit")
    }

    #[test]
    fn merge_fast_forward() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m6-ff");
        let main = merge_fixture(&backend, &root);

        backend.create_branch(&root, "topic").unwrap();
        backend.checkout_branch(&root, "topic").unwrap();
        fs::write(root.join("t.md"), "T\n").unwrap();
        backend.commit_all(&root, "topic work").unwrap();
        backend.checkout_branch(&root, &main).unwrap();
        assert!(!root.join("t.md").exists());

        let outcome = backend.merge_branch(&root, "topic").unwrap();
        assert_eq!(outcome.kind, "fastForward");
        assert!(outcome.conflict_paths.is_empty());
        assert_eq!(fs::read_to_string(root.join("t.md")).unwrap(), "T\n");
        assert!(backend.status(&root).unwrap().is_empty());
        // Still on the default branch, now at the topic tip.
        assert_eq!(backend.branches(&root).unwrap().current.as_deref(), Some(main.as_str()));

        // Merging again is an up-to-date no-op reported as fastForward.
        let again = backend.merge_branch(&root, "topic").unwrap();
        assert_eq!(again.kind, "fastForward");
    }

    #[test]
    fn merge_independent_changes_creates_two_parent_commit() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m6-merge");
        let main = merge_fixture(&backend, &root);

        backend.create_branch(&root, "topic").unwrap();
        backend.checkout_branch(&root, "topic").unwrap();
        fs::write(root.join("t.md"), "T\n").unwrap();
        backend.commit_all(&root, "topic work").unwrap();

        backend.checkout_branch(&root, &main).unwrap();
        fs::write(root.join("m.md"), "M\n").unwrap();
        backend.commit_all(&root, "main work").unwrap();

        let outcome = backend.merge_branch(&root, "topic").unwrap();
        assert_eq!(outcome.kind, "merged");
        assert!(outcome.conflict_paths.is_empty());
        assert_eq!(fs::read_to_string(root.join("t.md")).unwrap(), "T\n");
        assert_eq!(fs::read_to_string(root.join("m.md")).unwrap(), "M\n");
        assert!(backend.status(&root).unwrap().is_empty());

        // The merge commit has both parents; merge state is cleaned up.
        let repo = Repository::open(&root).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn merge_conflict_aborts_cleanly() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m6-conflict");
        let main = merge_fixture(&backend, &root);

        backend.create_branch(&root, "topic").unwrap();
        backend.checkout_branch(&root, "topic").unwrap();
        fs::write(root.join("base.md"), "topic\n").unwrap();
        fs::write(root.join("added-on-topic.md"), "T\n").unwrap();
        backend.commit_all(&root, "topic edit").unwrap();

        backend.checkout_branch(&root, &main).unwrap();
        fs::write(root.join("base.md"), "main\n").unwrap();
        backend.commit_all(&root, "main edit").unwrap();

        let outcome = backend.merge_branch(&root, "topic").unwrap();
        assert_eq!(outcome.kind, "conflicts");
        assert_eq!(outcome.conflict_paths, vec!["base.md".to_string()]);

        // Worktree is back at the pre-merge state: no conflict markers, no
        // half-merged files, clean status, no lingering merge state.
        assert_eq!(fs::read_to_string(root.join("base.md")).unwrap(), "main\n");
        assert!(!root.join("added-on-topic.md").exists());
        assert!(backend.status(&root).unwrap().is_empty());
        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        // A follow-up commit attempt agrees the tree is clean.
        assert!(matches!(
            backend.commit_all(&root, "noop"),
            Err(GitError::NothingToCommit)
        ));
    }

    #[test]
    fn merge_refuses_dirty_tree_and_missing_branch() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m6-dirty");
        let _main = merge_fixture(&backend, &root);
        backend.create_branch(&root, "topic").unwrap();

        fs::write(root.join("base.md"), "dirty\n").unwrap();
        let err = backend.merge_branch(&root, "topic").unwrap_err();
        assert!(
            err.to_string().contains("commit or discard changes first"),
            "got: {err}"
        );
        // Worktree untouched by the refusal.
        assert_eq!(fs::read_to_string(root.join("base.md")).unwrap(), "dirty\n");

        fs::write(root.join("base.md"), "base\n").unwrap(); // clean again
        let err = backend.merge_branch(&root, "no-such-branch").unwrap_err();
        assert!(err.to_string().contains("branch not found"), "got: {err}");
    }

    // -- M8: conflict material + resolve (docs/dev/INTERFACES.md §12.1) -------

    /// Build a genuinely conflicting merge: the default branch and `topic`
    /// both edit the SAME block of `conflict.md`, plus each side makes an
    /// independent non-conflicting edit. Leaves the worktree on the default
    /// branch (clean, ready to merge `topic`). Returns the default branch name.
    fn conflict_fixture(backend: &Libgit2Backend, root: &Path) -> String {
        backend.init(root).unwrap();
        // Common ancestor: the conflicting file + a file only main will touch +
        // a file only topic will touch.
        fs::write(root.join("conflict.md"), "# Shared\n\nbase line\n").unwrap();
        fs::write(root.join("only-main.md"), "M0\n").unwrap();
        fs::write(root.join("only-topic.md"), "T0\n").unwrap();
        backend.commit_all(root, "base").unwrap();
        let main = backend
            .branches(root)
            .unwrap()
            .current
            .expect("current branch after first commit");

        backend.create_branch(root, "topic").unwrap();
        backend.checkout_branch(root, "topic").unwrap();
        // Topic edits the shared block (conflict) and its own file (auto).
        fs::write(root.join("conflict.md"), "# Shared\n\ntheirs line\n").unwrap();
        fs::write(root.join("only-topic.md"), "T1\n").unwrap();
        backend.commit_all(root, "topic edit").unwrap();

        backend.checkout_branch(root, &main).unwrap();
        // Main edits the same shared block differently (conflict) + its own file.
        fs::write(root.join("conflict.md"), "# Shared\n\nours line\n").unwrap();
        fs::write(root.join("only-main.md"), "M1\n").unwrap();
        backend.commit_all(root, "main edit").unwrap();
        main
    }

    #[test]
    fn conflict_versions_reports_three_ways() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m8-versions");
        let _main = conflict_fixture(&backend, &root);

        // A plain merge_branch reports conflicts and leaves the worktree clean.
        let outcome = backend.merge_branch(&root, "topic").unwrap();
        assert_eq!(outcome.kind, "conflicts");
        assert_eq!(outcome.conflict_paths, vec!["conflict.md".to_string()]);
        assert!(backend.status(&root).unwrap().is_empty());

        // conflict_versions returns only the conflicting path (the independent
        // edits auto-merge and are not surfaced), with all three versions.
        let versions = backend.conflict_versions(&root, "topic").unwrap();
        assert_eq!(versions.len(), 1);
        let cf = &versions[0];
        assert_eq!(cf.rel_path, "conflict.md");
        assert_eq!(cf.base.as_deref(), Some("# Shared\n\nbase line\n"));
        assert_eq!(cf.ours, "# Shared\n\nours line\n");
        assert_eq!(cf.theirs, "# Shared\n\ntheirs line\n");

        // conflict_versions never touches the worktree or refs.
        assert!(backend.status(&root).unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(root.join("conflict.md")).unwrap(),
            "# Shared\n\nours line\n"
        );
        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn merge_resolve_creates_two_parent_commit_and_clean_tree() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m8-resolve");
        let _main = conflict_fixture(&backend, &root);

        // Resolve the one conflict with a hand-merged content.
        let resolved = vec![ResolvedFile {
            rel_path: "conflict.md".to_string(),
            content: "# Shared\n\nmerged line\n".to_string(),
        }];
        let oid = backend.merge_resolve(&root, "topic", resolved).unwrap();
        assert_eq!(oid.len(), 40);

        // Worktree is synced to the merge result: chosen content for the
        // conflicting file, both sides' independent edits present.
        assert_eq!(
            fs::read_to_string(root.join("conflict.md")).unwrap(),
            "# Shared\n\nmerged line\n"
        );
        assert_eq!(fs::read_to_string(root.join("only-main.md")).unwrap(), "M1\n");
        assert_eq!(fs::read_to_string(root.join("only-topic.md")).unwrap(), "T1\n");

        // Status clean, merge commit has both parents, repo state clean.
        assert!(backend.status(&root).unwrap().is_empty());
        let repo = Repository::open(&root).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        // A follow-up commit attempt agrees the tree is clean.
        assert!(matches!(
            backend.commit_all(&root, "noop"),
            Err(GitError::NothingToCommit)
        ));
    }

    #[test]
    fn merge_resolve_requires_all_conflicts_and_refuses_dirty() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m8-partial");
        let _main = conflict_fixture(&backend, &root);

        // Resolving nothing leaves the one conflict unresolved → Err naming it.
        let err = backend.merge_resolve(&root, "topic", Vec::new()).unwrap_err();
        assert!(
            err.to_string().contains("unresolved conflicting files")
                && err.to_string().contains("conflict.md"),
            "got: {err}"
        );
        // The failed resolve left the worktree untouched.
        assert!(backend.status(&root).unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(root.join("conflict.md")).unwrap(),
            "# Shared\n\nours line\n"
        );

        // Supplying a file that was never in conflict is rejected too.
        let bogus = vec![ResolvedFile {
            rel_path: "only-main.md".to_string(),
            content: "x\n".to_string(),
        }];
        let err = backend.merge_resolve(&root, "topic", bogus).unwrap_err();
        assert!(err.to_string().contains("was not in conflict"), "got: {err}");

        // Dirty worktree refuses the resolve (same message as merge_branch).
        fs::write(root.join("conflict.md"), "dirty\n").unwrap();
        let resolved = vec![ResolvedFile {
            rel_path: "conflict.md".to_string(),
            content: "# Shared\n\nmerged line\n".to_string(),
        }];
        let err = backend.merge_resolve(&root, "topic", resolved).unwrap_err();
        assert!(
            err.to_string().contains("commit or discard changes first"),
            "got: {err}"
        );
        assert_eq!(fs::read_to_string(root.join("conflict.md")).unwrap(), "dirty\n");
    }

    #[test]
    fn conflict_versions_empty_when_no_conflict() {
        let backend = Libgit2Backend;
        let root = tmp_repo("m8-noconflict");
        let main = merge_fixture(&backend, &root);

        // Independent edits on two branches: mergeable, so no conflicts.
        backend.create_branch(&root, "topic").unwrap();
        backend.checkout_branch(&root, "topic").unwrap();
        fs::write(root.join("t.md"), "T\n").unwrap();
        backend.commit_all(&root, "topic work").unwrap();
        backend.checkout_branch(&root, &main).unwrap();
        fs::write(root.join("m.md"), "M\n").unwrap();
        backend.commit_all(&root, "main work").unwrap();

        assert!(backend.conflict_versions(&root, "topic").unwrap().is_empty());
    }
}
