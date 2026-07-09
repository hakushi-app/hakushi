//! `GitBackend` — the load-bearing git abstraction (docs/dev/INTERFACES.md §1,
//! docs/DESIGN.md).
//!
//! The FULL surface (clone/commit/branch/diff/merge/status/push/pull/fetch +
//! custom-ref read/write) is declared now. Backends only need to implement the
//! M0-M1 subset (`init / is_repo / status / commit_all / log`); everything
//! else has a default impl returning `GitError::Unsupported`, and
//! `capabilities()` must report honestly what actually works.

use std::path::Path;

use serde::Serialize;
use thiserror::Error;

/// Errors from git backends. Commands map these to readable strings.
#[derive(Debug, Error)]
pub enum GitError {
    /// The active backend does not (yet) support this operation.
    #[error("operation not supported by this git backend: {0}")]
    Unsupported(&'static str),

    /// `commit_all` found no changes to commit.
    #[error("nothing to commit")]
    NothingToCommit,

    /// The path is not (or does not contain) a git repository.
    #[error("not a git repository: {0}")]
    NotARepository(String),

    /// Any other backend-specific failure, already rendered readable.
    #[error("{0}")]
    Backend(String),
}

/// What the active backend can actually do. Serialized to TS as part of
/// `BackendInfo` (all field names are single words, camelCase is a no-op but
/// declared for consistency with the contract).
///
/// `branch` means BOTH `create_branch` and `checkout_branch` are usable
/// (docs/dev/INTERFACES.md §7.1). A backend that can create refs but cannot
/// safely reset the worktree (gix, M4) must report `branch: false`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub init: bool,
    pub status: bool,
    pub commit: bool,
    pub log: bool,
    pub branch: bool,
    pub merge: bool,
    pub push: bool,
    pub pull: bool,
}

/// One changed path in the working tree / index.
/// `status` ∈ "new" | "modified" | "deleted" | "renamed" | "conflicted".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub rel_path: String,
    pub status: String,
}

/// One commit in the history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// Full hex OID.
    pub oid: String,
    /// First line of the commit message.
    pub summary: String,
    pub author_name: String,
    /// Epoch seconds.
    pub timestamp: i64,
}

/// Local branches + the currently checked-out one (docs/dev/INTERFACES.md
/// §7.1). `current` is `None` on an unborn HEAD (fresh repo before the first
/// commit) and on a detached HEAD.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub current: Option<String>,
    /// Short local branch names, sorted lexicographically.
    pub branches: Vec<String>,
}

/// Result of `merge_branch` (M6, docs/dev/INTERFACES.md §10.2).
/// `kind` ∈ "fastForward" | "merged" | "conflicts". On "conflicts" the merge
/// was aborted cleanly (worktree left at its pre-merge state) and
/// `conflict_paths` lists the paths that could not be auto-merged; otherwise
/// `conflict_paths` is empty.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub kind: String,
    pub conflict_paths: Vec<String>,
}

/// One conflicting file's three versions during an in-memory merge (M8,
/// docs/dev/INTERFACES.md §12.1). `base` is the merge-base content (`None`
/// when the path is absent in the common ancestor, e.g. add/add), `ours` is
/// the current branch's content, `theirs` is `source`'s. Binary (non-UTF-8)
/// blobs are surfaced as a short placeholder paragraph rather than raw bytes
/// (Hakushi workspaces are text `.md`; see docs/dev/M7-M8-PLAN.md §2.1.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub rel_path: String,
    pub base: Option<String>,
    pub ours: String,
    pub theirs: String,
}

/// One resolved file supplied to `merge_resolve` (M8, docs/dev/INTERFACES.md
/// §12.1): the final merged content the TS conflict resolver produced (already
/// normalized + frontmatter-joined). Deserialized from `{ relPath, content }`.
///
/// `#[allow(dead_code)]`: the libgit2 backend reads both fields, but the gix
/// build routes `merge_resolve` through the trait default (Unsupported), which
/// drops the `Vec<ResolvedFile>` — so the fields look unread under `git-gix`.
/// The type is still needed there for the command signature and serde.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ResolvedFile {
    pub rel_path: String,
    pub content: String,
}

/// How the current code branch was integrated during `sync` (M7,
/// docs/dev/INTERFACES.md §11.2).
/// `kind` ∈ "upToDate" | "fastForward" | "merged" | "conflicts" |
/// "noRemoteBranch". On "conflicts" the worktree is left untouched and the
/// branch push is skipped (collab refs still sync).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSyncReport {
    pub kind: String,
    pub conflict_paths: Vec<String>,
}

/// Union-merge result over `refs/hakushi/*` (M7, docs/dev/INTERFACES.md
/// §11.2/§11.3): `merged` = refs whose local chain changed (adopted /
/// fast-forwarded / rebuilt), `unchanged` = refs already in sync (including
/// local-only refs that only need a push).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabRefsReport {
    pub merged: u32,
    pub unchanged: u32,
}

/// Result of one full `sync` pass (M7, docs/dev/INTERFACES.md §11.2):
/// fetch → current-branch integration → collab-refs union merge → push.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub fetched: bool,
    pub pushed: bool,
    pub branch: BranchSyncReport,
    pub collab_refs: CollabRefsReport,
    pub message: String,
}

/// Abstraction over git implementations (libgit2 on desktop, gix on mobile,
/// possibly isomorphic-git fallbacks for push/fetch later). Object-safe:
/// selected statically via `crate::git::backend()`.
pub trait GitBackend: Send + Sync {
    /// Backend identifier: "libgit2" | "gix".
    fn name(&self) -> &'static str;

    /// Honest report of what this backend implements today.
    fn capabilities(&self) -> Capabilities;

    // -- M0-M1 subset: backends must implement these ------------------------

    /// Initialize a repository at `root`. No-op success if already a repo.
    fn init(&self, root: &Path) -> Result<(), GitError>;

    /// Is `root` itself a git repository (no upward discovery)?
    fn is_repo(&self, root: &Path) -> Result<bool, GitError>;

    /// Combined index + worktree status, one entry per changed path.
    fn status(&self, root: &Path) -> Result<Vec<StatusEntry>, GitError>;

    /// Stage everything (`git add -A` semantics) and commit. Returns the new
    /// commit OID as hex. `Err(GitError::NothingToCommit)` when clean.
    fn commit_all(&self, root: &Path, message: &str) -> Result<String, GitError>;

    /// History, newest first. `rel_path` filters to commits touching that
    /// path. `limit` caps the number of returned commits.
    fn log(
        &self,
        root: &Path,
        rel_path: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CommitInfo>, GitError>;

    // -- Full surface: default Unsupported until implemented ----------------

    /// Local branches + current branch (M4, docs/dev/INTERFACES.md §7.1).
    fn branches(&self, root: &Path) -> Result<BranchInfo, GitError> {
        let _ = root;
        Err(GitError::Unsupported("branches"))
    }

    /// Create a local branch at the current HEAD commit. Errors if the branch
    /// already exists or HEAD is unborn.
    fn create_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let _ = (root, name);
        Err(GitError::Unsupported("create_branch"))
    }

    /// Switch HEAD + worktree to `name`. Must refuse when the working tree is
    /// dirty ("commit or discard changes first").
    fn checkout_branch(&self, root: &Path, name: &str) -> Result<(), GitError> {
        let _ = (root, name);
        Err(GitError::Unsupported("checkout_branch"))
    }

    /// Blob content of `rel_path` in the tree of commit `oid` (full hex),
    /// `None` when no file exists at that path in that commit.
    /// `rel_path` must already be validated at the command boundary
    /// (never touches the filesystem here, but the §1 contract applies).
    fn file_at_commit(
        &self,
        root: &Path,
        rel_path: &str,
        oid: &str,
    ) -> Result<Option<String>, GitError> {
        let _ = (root, rel_path, oid);
        Err(GitError::Unsupported("file_at_commit"))
    }

    /// Restore the blob bytes of `rel_path` at commit `oid` into the working
    /// tree, creating parent directories as needed. Contract exception
    /// (docs/dev/INTERFACES.md §7.1): this writes bytes git itself produced —
    /// no new `.md` bytes are generated, so the pipeline.ts monopoly does not
    /// apply. `rel_path` must already be validated at the command boundary.
    fn revert_file(&self, root: &Path, rel_path: &str, oid: &str) -> Result<(), GitError> {
        let _ = (root, rel_path, oid);
        Err(GitError::Unsupported("revert_file"))
    }

    // Declared for the full design surface (INTERFACES.md §64), but no command
    // calls current_branch (branch info comes via `branches`) yet.
    #[allow(dead_code)]
    fn current_branch(&self, root: &Path) -> Result<String, GitError> {
        let _ = root;
        Err(GitError::Unsupported("current_branch"))
    }

    /// Unified diff between two revspecs (rendered as text).
    // Part of the declared full surface; the git UI uses the TS semantic diff
    // (§7.2) instead of a text diff, so no command calls this yet.
    #[allow(dead_code)]
    fn diff(&self, root: &Path, from: &str, to: &str) -> Result<String, GitError> {
        let _ = (root, from, to);
        Err(GitError::Unsupported("diff"))
    }

    /// Merge local branch `source` into the current branch (M6,
    /// docs/dev/INTERFACES.md §10.2). Fast-forwards when possible; otherwise
    /// creates a merge commit with both parents. On conflicts the merge is
    /// aborted — the worktree is restored to its pre-merge state and the
    /// outcome reports `kind: "conflicts"` with the conflicting paths.
    /// Must refuse when the working tree is dirty (same message pattern as
    /// `checkout_branch`).
    fn merge_branch(&self, root: &Path, source: &str) -> Result<MergeOutcome, GitError> {
        let _ = (root, source);
        Err(GitError::Unsupported("merge_branch"))
    }

    /// Re-run the merge of `source` into the current branch **in memory** and
    /// return the three versions of every conflicting path (M8,
    /// docs/dev/INTERFACES.md §12.1). Never touches the worktree or any ref;
    /// returns an empty `Vec` when the merge is conflict-free. gix stays
    /// Unsupported (consistent with `merge_branch`).
    fn conflict_versions(
        &self,
        root: &Path,
        source: &str,
    ) -> Result<Vec<ConflictFile>, GitError> {
        let _ = (root, source);
        Err(GitError::Unsupported("conflict_versions"))
    }

    /// Complete a conflicted merge of `source` into the current branch by
    /// splicing `resolved`'s blobs into the in-memory merge index, verifying no
    /// conflict remains, then creating a 2-parent merge commit, moving the
    /// current branch ref, and syncing the worktree (M8,
    /// docs/dev/INTERFACES.md §12.1). Errors when a conflicting path is missing
    /// from `resolved` (partial resolution is not allowed) or the worktree is
    /// dirty (same refusal as `merge_branch`). Returns the merge commit OID.
    /// gix stays Unsupported.
    fn merge_resolve(
        &self,
        root: &Path,
        source: &str,
        resolved: Vec<ResolvedFile>,
    ) -> Result<String, GitError> {
        let _ = (root, source, resolved);
        Err(GitError::Unsupported("merge_resolve"))
    }

    // push/pull/fetch/clone_repo are part of the declared full surface, but the
    // M7 sync path drives fetch+push internally through `sync` (§11) rather than
    // these granular hooks, so no command calls them directly yet.
    #[allow(dead_code)]
    fn push(&self, root: &Path, remote: &str, refspec: &str) -> Result<(), GitError> {
        let _ = (root, remote, refspec);
        Err(GitError::Unsupported("push"))
    }

    #[allow(dead_code)]
    fn pull(&self, root: &Path, remote: &str) -> Result<(), GitError> {
        let _ = (root, remote);
        Err(GitError::Unsupported("pull"))
    }

    #[allow(dead_code)]
    fn fetch(&self, root: &Path, remote: &str) -> Result<(), GitError> {
        let _ = (root, remote);
        Err(GitError::Unsupported("fetch"))
    }

    #[allow(dead_code)]
    fn clone_repo(&self, url: &str, dest: &Path) -> Result<(), GitError> {
        let _ = (url, dest);
        Err(GitError::Unsupported("clone_repo"))
    }

    // -- M7: remotes, deterministic ref rebuild, full sync (docs/dev/
    // INTERFACES.md §11, docs/dev/M7-M8-PLAN.md §1) --------------------------

    /// The `origin` remote URL, `None` when no `origin` is configured.
    fn remote_get(&self, root: &Path) -> Result<Option<String>, GitError> {
        let _ = root;
        Err(GitError::Unsupported("remote_get"))
    }

    /// Create or update the `origin` remote to `url` (https / file / absolute
    /// path). gix cannot safely write remote config, so it stays Unsupported
    /// there (docs/dev/M7-M8-PLAN.md §1.1).
    fn remote_set(&self, root: &Path, url: &str) -> Result<(), GitError> {
        let _ = (root, url);
        Err(GitError::Unsupported("remote_set"))
    }

    /// Append one event to `ref_name` with the author and timestamps taken
    /// from the caller (not from git config / wall clock), so a deterministic
    /// rebuild of a chain produces byte-identical commits on every clone
    /// (docs/dev/M7-M8-PLAN.md §1.5). `author` is the commit author/committer
    /// name (email fixed to the Hakushi identity), `ts` is epoch seconds for
    /// both author and committer time (offset +0000). Never a Tauri command —
    /// used only by the collab union-merge rebuild.
    fn append_ref_event_raw(
        &self,
        root: &Path,
        ref_name: &str,
        json: &str,
        author: &str,
        ts: i64,
    ) -> Result<String, GitError> {
        let _ = (root, ref_name, json, author, ts);
        Err(GitError::Unsupported("append_ref_event_raw"))
    }

    /// Point `ref_name` at `oid` (full hex), creating the ref or force-moving
    /// it regardless of the current target. Used to swap a collab ref onto a
    /// rebuilt / adopted chain tip (docs/dev/M7-M8-PLAN.md §1.5).
    fn force_set_ref(&self, root: &Path, ref_name: &str, oid: &str) -> Result<(), GitError> {
        let _ = (root, ref_name, oid);
        Err(GitError::Unsupported("force_set_ref"))
    }

    /// Delete `ref_name` if it exists (no-op success when it does not). Used
    /// to prune the temporary `refs/hakushi-remote/*` tracking namespace.
    fn delete_ref(&self, root: &Path, ref_name: &str) -> Result<(), GitError> {
        let _ = (root, ref_name);
        Err(GitError::Unsupported("delete_ref"))
    }

    /// One full sync pass (docs/dev/INTERFACES.md §11.2, §11.4 of the plan):
    /// dirty check → fetch → current-branch integration → collab-refs union
    /// merge → push. Desktop (libgit2) does the whole round trip; gix does
    /// fetch-only (pull) or stays Unsupported depending on the M7 TLS spike.
    fn sync(&self, root: &Path) -> Result<SyncReport, GitError> {
        let _ = root;
        Err(GitError::Unsupported("sync"))
    }

    // -- Custom refs (refs/hakushi/* event log, M6; docs/dev/INTERFACES.md
    // §10.1, §10.2) ----------------------------------------------------------

    /// Append one event to the log stored at `ref_name` (full ref name, e.g.
    /// "refs/hakushi/issues/<ulid>"): create an empty-tree commit whose
    /// message is exactly `json` (one line), parented on the current ref
    /// target (none if the ref does not exist yet), then point the ref at the
    /// new commit. Returns the new commit OID as hex.
    fn append_ref_event(
        &self,
        root: &Path,
        ref_name: &str,
        json: &str,
    ) -> Result<String, GitError> {
        let _ = (root, ref_name, json);
        Err(GitError::Unsupported("append_ref_event"))
    }

    /// Read the event log at `ref_name` in append (ts-ascending) order: walk
    /// the first-parent chain from the ref tip, collect commit messages, then
    /// reverse. Errors when the ref does not exist.
    fn read_ref_events(&self, root: &Path, ref_name: &str) -> Result<Vec<String>, GitError> {
        let _ = (root, ref_name);
        Err(GitError::Unsupported("read_ref_events"))
    }

    /// List full ref names under `prefix` (e.g. "refs/hakushi/issues/"),
    /// sorted lexicographically.
    fn list_refs(&self, root: &Path, prefix: &str) -> Result<Vec<String>, GitError> {
        let _ = (root, prefix);
        Err(GitError::Unsupported("list_refs"))
    }
}
