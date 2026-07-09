//! `git_sync` orchestration for the libgit2 backend (M7,
//! docs/dev/INTERFACES.md §11.2, docs/dev/M7-M8-PLAN.md §1.4).
//!
//! One pass: dirty check → fetch (heads + collab refs) → current-branch
//! integration → collab-refs union merge → push. Every stage advances as far
//! as it can and reflects the outcome in the [`SyncReport`]; a mid-pass
//! failure never leaves the repository in a broken state (a merge conflict
//! restores the pre-merge worktree and skips the branch push; collab refs
//! still sync).

use std::path::Path;

use git2::{
    build::CheckoutBuilder, AutotagOption, ErrorCode, FetchOptions, PushOptions, Repository,
};

use super::backend::{
    BranchSyncReport, GitBackend, GitError, SyncReport,
};
use super::libgit2_backend::{origin_remote, remote_callbacks, Libgit2Backend, FETCH_REFSPECS, ORIGIN};

fn map_err(e: git2::Error) -> GitError {
    GitError::Backend(e.message().to_string())
}

/// Full sync for libgit2. `backend` is the same `Libgit2Backend` — passed so
/// the collab union merge (which is backend-generic) can drive it through the
/// trait.
pub fn sync_libgit2(backend: &Libgit2Backend, root: &Path) -> Result<SyncReport, GitError> {
    // 1. Preconditions: origin set, worktree clean.
    let url = backend
        .remote_get(root)?
        .ok_or_else(|| GitError::Backend(
            "no remote configured: add a remote URL in sync settings".to_string(),
        ))?;
    if !backend.status(root)?.is_empty() {
        return Err(GitError::Backend(
            "working tree has uncommitted changes: commit or discard changes first".to_string(),
        ));
    }

    let repo = Repository::open(root).map_err(map_err)?;

    // 2. Fetch heads + collab refs into their tracking namespaces.
    fetch(&repo, &url)?;
    let fetched = true;

    // 3. Integrate the current branch (only — other branches are untouched).
    let branch = integrate_current_branch(&repo, root, &url)?;
    let conflicts = branch.kind == "conflicts";

    // 4. Collab refs union merge (backend-generic, works via the trait).
    let collab_refs = crate::collab::sync::union_merge_all(backend, root)?;

    // 5. Push: current head (unless conflicts) + all local refs/hakushi/*.
    //    A non-fast-forward rejection triggers one fetch + retry.
    let pushed = push_all(&repo, backend, root, &url, conflicts)?;

    let message = summarize(&branch, &collab_refs, pushed, conflicts);
    Ok(SyncReport {
        fetched,
        pushed,
        branch,
        collab_refs,
        message,
    })
}

/// Fetch heads (`refs/remotes/origin/*`) and collab refs
/// (`refs/hakushi-remote/*`) with the credential callback.
fn fetch(repo: &Repository, url: &str) -> Result<(), GitError> {
    let mut remote = origin_remote(repo)?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(remote_callbacks(url));
    fo.download_tags(AutotagOption::None);
    let specs: Vec<&str> = FETCH_REFSPECS.to_vec();
    remote.fetch(&specs, Some(&mut fo), None).map_err(map_err)?;
    Ok(())
}

/// Current short branch name, or `None` on unborn/detached HEAD.
fn current_branch_name(repo: &Repository) -> Result<Option<String>, GitError> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(head.shorthand().map(str::to_string)),
        Ok(_) => Ok(None),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Integrate the fetched remote-tracking branch into the current branch:
/// up-to-date / fast-forward / clean merge / conflicts / no-remote-branch.
/// On conflicts the worktree is restored to its pre-merge state.
fn integrate_current_branch(
    repo: &Repository,
    root: &Path,
    url: &str,
) -> Result<BranchSyncReport, GitError> {
    let _ = (root, url);
    let ff_report = |kind: &str| BranchSyncReport {
        kind: kind.to_string(),
        conflict_paths: Vec::new(),
    };

    let Some(branch) = current_branch_name(repo)? else {
        // Unborn/detached HEAD: nothing to integrate; push may create it.
        return Ok(ff_report("noRemoteBranch"));
    };

    let tracking = format!("refs/remotes/{ORIGIN}/{branch}");
    let their_oid = match repo.refname_to_id(&tracking) {
        Ok(oid) => oid,
        Err(e) if e.code() == ErrorCode::NotFound => {
            // Remote has no such branch yet → push will create it.
            return Ok(ff_report("noRemoteBranch"));
        }
        Err(e) => return Err(map_err(e)),
    };

    let our_oid = repo
        .head()
        .map_err(map_err)?
        .target()
        .ok_or_else(|| GitError::Backend("current branch has no commit".to_string()))?;

    if our_oid == their_oid {
        return Ok(ff_report("upToDate"));
    }

    let their_annotated = repo.find_annotated_commit(their_oid).map_err(map_err)?;
    let (analysis, _) = repo.merge_analysis(&[&their_annotated]).map_err(map_err)?;

    if analysis.is_up_to_date() {
        return Ok(ff_report("upToDate"));
    }

    if analysis.is_fast_forward() {
        let commit = repo.find_commit(their_oid).map_err(map_err)?;
        let mut opts = CheckoutBuilder::new();
        opts.safe();
        repo.checkout_tree(commit.as_object(), Some(&mut opts))
            .map_err(map_err)?;
        repo.head()
            .map_err(map_err)?
            .set_target(their_oid, "sync: fast-forward")
            .map_err(map_err)?;
        return Ok(ff_report("fastForward"));
    }

    // Normal (three-way) merge. Stage into index + worktree.
    repo.merge(&[&their_annotated], None, None).map_err(map_err)?;
    let mut index = repo.index().map_err(map_err)?;

    if index.has_conflicts() {
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

        // Abort cleanly: drop merge state, force worktree/index back to HEAD
        // (which was clean before the merge — the pre-merge state).
        abort_merge(repo)?;
        return Ok(BranchSyncReport {
            kind: "conflicts".to_string(),
            conflict_paths: paths,
        });
    }

    // Clean merge: commit with both parents, update worktree.
    let tree_oid = index.write_tree().map_err(map_err)?;
    let tree = repo.find_tree(tree_oid).map_err(map_err)?;
    let ours = repo.head().map_err(map_err)?.peel_to_commit().map_err(map_err)?;
    let theirs = repo.find_commit(their_oid).map_err(map_err)?;
    let sig = match repo.signature() {
        Ok(s) => s,
        Err(_) => git2::Signature::now("Hakushi", "hakushi@local").map_err(map_err)?,
    };
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Merge remote-tracking branch 'origin/{branch}'"),
        &tree,
        &[&ours, &theirs],
    )
    .map_err(map_err)?;
    repo.cleanup_state().map_err(map_err)?;
    let mut opts = CheckoutBuilder::new();
    opts.safe();
    repo.checkout_head(Some(&mut opts)).map_err(map_err)?;

    Ok(ff_report("merged"))
}

/// Restore index + worktree to HEAD and clear merge state.
fn abort_merge(repo: &Repository) -> Result<(), GitError> {
    repo.cleanup_state().map_err(map_err)?;
    let head = repo.head().map_err(map_err)?.peel_to_commit().map_err(map_err)?;
    let mut opts = CheckoutBuilder::new();
    opts.force();
    repo.checkout_tree(head.as_object(), Some(&mut opts))
        .map_err(map_err)?;
    let mut index = repo.index().map_err(map_err)?;
    index.read_tree(&head.tree().map_err(map_err)?).map_err(map_err)?;
    index.write().map_err(map_err)?;
    Ok(())
}

/// Push the current head (unless `skip_branch`) and every local
/// `refs/hakushi/*`. One fetch+retry on a non-fast-forward rejection.
fn push_all(
    repo: &Repository,
    backend: &dyn GitBackend,
    root: &Path,
    url: &str,
    skip_branch: bool,
) -> Result<bool, GitError> {
    let specs = push_specs(repo, backend, root, skip_branch)?;
    if specs.is_empty() {
        return Ok(false);
    }

    match do_push(repo, url, &specs) {
        Ok(()) => Ok(true),
        Err(e) if is_non_fast_forward(&e) => {
            // Sync race on the code branch: re-fetch, re-integrate, retry once.
            // The append-only collab log converges on the next pass regardless,
            // so a second failure is reported (not fatal).
            fetch(repo, url)?;
            let _ = integrate_current_branch(repo, root, url)?;
            let _ = crate::collab::sync::union_merge_all(backend, root)?;
            let specs2 = push_specs(repo, backend, root, skip_branch)?;
            match do_push(repo, url, &specs2) {
                Ok(()) => Ok(true),
                Err(_) => Ok(false),
            }
        }
        Err(e) => Err(e),
    }
}

/// Refspecs to push: the current head (unless skipped, plain ff-only) plus
/// every local `refs/hakushi/*` FORCE-pushed. Collab refs are deterministic,
/// append-only rebuilds — a rebuilt chain is a brand-new commit graph that is
/// not a fast-forward of the remote tip, but carries a superset of the events
/// (no information is lost), so forcing is safe and required for convergence.
fn push_specs(
    repo: &Repository,
    backend: &dyn GitBackend,
    root: &Path,
    skip_branch: bool,
) -> Result<Vec<String>, GitError> {
    let mut specs: Vec<String> = Vec::new();
    if !skip_branch {
        if let Some(branch) = current_branch_name(repo)? {
            specs.push(format!("refs/heads/{branch}:refs/heads/{branch}"));
        }
    }
    for r in backend.list_refs(root, crate::collab::sync::LOCAL_PREFIX)? {
        specs.push(format!("+{r}:{r}"));
    }
    Ok(specs)
}

fn do_push(repo: &Repository, url: &str, specs: &[String]) -> Result<(), GitError> {
    let mut remote = origin_remote(repo)?;
    let mut po = PushOptions::new();
    po.remote_callbacks(remote_callbacks(url));
    let refspecs: Vec<&str> = specs.iter().map(String::as_str).collect();
    remote.push(&refspecs, Some(&mut po)).map_err(map_err)
}

fn is_non_fast_forward(e: &GitError) -> bool {
    let msg = e.to_string().to_ascii_lowercase();
    msg.contains("fast-forward") || msg.contains("fast forward") || msg.contains("non-fast")
}

fn summarize(
    branch: &BranchSyncReport,
    collab: &crate::git::backend::CollabRefsReport,
    pushed: bool,
    conflicts: bool,
) -> String {
    let branch_part = match branch.kind.as_str() {
        "upToDate" => "branch up to date".to_string(),
        "fastForward" => "branch fast-forwarded".to_string(),
        "merged" => "branch merged".to_string(),
        "noRemoteBranch" => "branch will be created on the remote".to_string(),
        "conflicts" => format!(
            "branch has conflicts in {} file(s) — resolve on desktop for now",
            branch.conflict_paths.len()
        ),
        other => other.to_string(),
    };
    let collab_part = format!(
        "collab: {} updated, {} unchanged",
        collab.merged, collab.unchanged
    );
    let push_part = if conflicts {
        if pushed {
            "pushed collab refs (branch push skipped due to conflicts)"
        } else {
            "branch push skipped due to conflicts"
        }
    } else if pushed {
        "pushed"
    } else {
        "nothing to push"
    };
    format!("{branch_part}; {collab_part}; {push_part}")
}

// ---------------------------------------------------------------------------
// Two-clone integration tests — THE M6/M7 done-gate (docs/dev/M7-M8-PLAN.md
// §1.6). A bare repo stands in for the server; two clones sync only through
// it (no live network). libgit2 feature only.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::collab;
    use crate::git::backend;
    use crate::git::backend::ResolvedFile;
    use git2::Repository;
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fresh temp dir unique to this test tag + process.
    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hakushi-sync-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pin an identity + a stable initial branch so both clones agree on the
    /// branch name regardless of the host's git defaults.
    fn configure(root: &Path, name: &str) {
        let repo = Repository::open(root).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", name).unwrap();
        cfg.set_str("user.email", &format!("{name}@test")).unwrap();
    }

    /// A bare "server" repo with one initial commit on `main`, plus two clones
    /// (A, B) each configured with a distinct identity and origin pointing at
    /// the bare repo via a file:// URL.
    fn bare_with_two_clones(tag: &str) -> (PathBuf, PathBuf, PathBuf, String) {
        let base = tmp(tag);
        let bare = base.join("server.git");
        Repository::init_bare(&bare).unwrap();
        let url = format!("file://{}", bare.display());

        // Seed the bare repo through a throwaway clone so it has a `main`.
        let seed = base.join("seed");
        backend().clone_repo(&url, &seed).unwrap();
        configure(&seed, "seed");
        fs::write(seed.join("index.md"), "# home\n").unwrap();
        backend().commit_all(&seed, "seed").unwrap();
        // Force the initial branch to `main` for cross-clone determinism.
        {
            let repo = Repository::open(&seed).unwrap();
            // Rename current branch to main if needed.
            let head_name = repo.head().unwrap().shorthand().unwrap().to_string();
            if head_name != "main" {
                let mut branch = repo
                    .find_branch(&head_name, git2::BranchType::Local)
                    .unwrap();
                branch.rename("main", true).unwrap();
                repo.set_head("refs/heads/main").unwrap();
            }
        }
        let seed_report = backend().sync(&seed).unwrap();
        assert!(seed_report.pushed, "seed push: {}", seed_report.message);

        // Point the bare repo's HEAD at `main` so fresh clones check it out
        // (init_bare defaults HEAD to master/main per host git config, which
        // may not match the branch we pushed).
        {
            let bare_repo = Repository::open_bare(&bare).unwrap();
            bare_repo.set_head("refs/heads/main").unwrap();
        }

        let a = base.join("cloneA");
        let b = base.join("cloneB");
        backend().clone_repo(&url, &a).unwrap();
        backend().clone_repo(&url, &b).unwrap();
        configure(&a, "alice");
        configure(&b, "bob");
        (bare, a, b, url)
    }

    /// Parse issue/pr event lines to `Value`s for comparison.
    fn events_as_values(lines: &[String]) -> Vec<Value> {
        lines
            .iter()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect()
    }

    #[test]
    fn page_commit_syncs_a_to_b() {
        let (_bare, a, b, _url) = bare_with_two_clones("page");

        fs::write(a.join("note.md"), "# from A\n").unwrap();
        backend().commit_all(&a, "add note").unwrap();
        let ra = backend().sync(&a).unwrap();
        assert!(ra.pushed, "A push: {}", ra.message);
        assert_eq!(ra.branch.kind, "upToDate");

        // B has not seen it yet.
        assert!(!b.join("note.md").exists());
        let rb = backend().sync(&b).unwrap();
        assert!(rb.fetched);
        assert_eq!(rb.branch.kind, "fastForward", "{}", rb.message);
        assert_eq!(fs::read_to_string(b.join("note.md")).unwrap(), "# from A\n");
    }

    #[test]
    fn same_issue_comments_both_sides_converge() {
        let (_bare, a, b, _url) = bare_with_two_clones("issue");

        // A creates the issue and pushes it.
        let id = collab::create_issue(&a, "shared bug", "body").unwrap();
        backend().sync(&a).unwrap();

        // B pulls, sees the issue, and both sides add a comment.
        backend().sync(&b).unwrap();
        assert_eq!(collab::list_issues(&b).unwrap().len(), 1);

        collab::issue_event(&a, &id, r#"{"type":"comment","ts":100,"author":"alice","data":{"body":"from A"}}"#).unwrap();
        collab::issue_event(&b, &id, r#"{"type":"comment","ts":200,"author":"bob","data":{"body":"from B"}}"#).unwrap();

        // Two rounds each: A→B→A→B lets the deterministic rebuild converge.
        backend().sync(&a).unwrap();
        backend().sync(&b).unwrap();
        backend().sync(&a).unwrap();
        backend().sync(&b).unwrap();

        let ev_a = collab::get_issue(&a, &id).unwrap();
        let ev_b = collab::get_issue(&b, &id).unwrap();
        assert_eq!(ev_a, ev_b, "both clones see identical event logs");
        // create + 2 comments = 3 events, both comments present.
        assert_eq!(ev_a.len(), 3);
        let bodies: Vec<String> = events_as_values(&ev_a)
            .iter()
            .filter_map(|v| v["data"]["body"].as_str().map(str::to_string))
            .collect();
        assert!(bodies.contains(&"from A".to_string()));
        assert!(bodies.contains(&"from B".to_string()));

        // Ref oids are byte-identical across clones after convergence.
        let ref_name = format!("refs/hakushi/issues/{id}");
        let oid_a = Repository::open(&a).unwrap().refname_to_id(&ref_name).unwrap();
        let oid_b = Repository::open(&b).unwrap().refname_to_id(&ref_name).unwrap();
        assert_eq!(oid_a, oid_b, "rebuilt chains reach the same tip oid");
    }

    #[test]
    fn pr_create_merge_flows_across_clones() {
        let (_bare, a, b, _url) = bare_with_two_clones("pr");

        // B builds a feature branch with a commit and pushes it via sync, then
        // opens a PR feature→main.
        backend().create_branch(&b, "feature").unwrap();
        backend().checkout_branch(&b, "feature").unwrap();
        fs::write(b.join("feature.md"), "# feature\n").unwrap();
        backend().commit_all(&b, "feature work").unwrap();
        let pr_report = backend().sync(&b).unwrap();
        // Current branch is `feature`; remote has none → noRemoteBranch, push
        // creates it.
        assert_eq!(pr_report.branch.kind, "noRemoteBranch", "{}", pr_report.message);
        assert!(pr_report.pushed);

        let pr_id = collab::create_pr(&b, "Add feature", "please", "feature", "main").unwrap();
        backend().sync(&b).unwrap();

        // A pulls: the PR is visible.
        backend().sync(&a).unwrap();
        let prs = collab::list_prs(&a).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].id, pr_id);
        assert_eq!(prs[0].state, "open");

        // A fetches the feature branch, merges it into main, marks the PR
        // merged, and syncs.
        {
            // Fetch so origin/feature exists locally on A, then make a local
            // `feature` branch to merge.
            let repo = Repository::open(&a).unwrap();
            let feat_oid = repo.refname_to_id("refs/remotes/origin/feature").unwrap();
            let commit = repo.find_commit(feat_oid).unwrap();
            repo.branch("feature", &commit, false).unwrap();
        }
        let outcome = backend().merge_branch(&a, "feature").unwrap();
        assert!(matches!(outcome.kind.as_str(), "merged" | "fastForward"), "{:?}", outcome);
        collab::pr_event(&a, &pr_id, r#"{"type":"status","ts":300,"author":"alice","data":{"state":"merged"}}"#).unwrap();
        let ra = backend().sync(&a).unwrap();
        assert!(ra.pushed, "A push after merge: {}", ra.message);

        // B syncs: main fast-forwards, PR shows merged.
        let rb = backend().sync(&b).unwrap();
        // B is on `feature`, so its current-branch integration is about
        // feature, not main; the important part is the PR state converges.
        let _ = rb;
        backend().sync(&a).unwrap();
        backend().sync(&b).unwrap();
        let prs_b = collab::list_prs(&b).unwrap();
        assert_eq!(prs_b[0].state, "merged", "PR merged status propagated to B");
    }

    #[test]
    fn divergent_commits_auto_merge() {
        let (_bare, a, b, _url) = bare_with_two_clones("diverge");

        // A and B edit DIFFERENT files, both on main.
        fs::write(a.join("a.md"), "A\n").unwrap();
        backend().commit_all(&a, "A edit").unwrap();
        backend().sync(&a).unwrap();

        fs::write(b.join("b.md"), "B\n").unwrap();
        backend().commit_all(&b, "B edit").unwrap();
        // B is behind (A already pushed) → merge, then push.
        let rb = backend().sync(&b).unwrap();
        assert_eq!(rb.branch.kind, "merged", "{}", rb.message);
        assert!(rb.pushed);
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "A\n");
        assert_eq!(fs::read_to_string(b.join("b.md")).unwrap(), "B\n");

        // A pulls the merge.
        let ra = backend().sync(&a).unwrap();
        assert_eq!(ra.branch.kind, "fastForward", "{}", ra.message);
        assert_eq!(fs::read_to_string(a.join("b.md")).unwrap(), "B\n");
    }

    #[test]
    fn same_block_conflict_keeps_worktree_and_syncs_collab() {
        let (_bare, a, b, _url) = bare_with_two_clones("conflict");

        // Both edit the SAME line of the SAME file, plus each opens an issue.
        fs::write(a.join("index.md"), "# home A\n").unwrap();
        backend().commit_all(&a, "A edit home").unwrap();
        let ia = collab::create_issue(&a, "issue A", "x").unwrap();
        backend().sync(&a).unwrap();

        fs::write(b.join("index.md"), "# home B\n").unwrap();
        backend().commit_all(&b, "B edit home").unwrap();
        let ib = collab::create_issue(&b, "issue B", "y").unwrap();

        // B syncs: branch conflicts, worktree stays at B's version, but collab
        // refs still sync (both issues push/pull).
        let rb = backend().sync(&b).unwrap();
        assert_eq!(rb.branch.kind, "conflicts", "{}", rb.message);
        assert_eq!(rb.branch.conflict_paths, vec!["index.md".to_string()]);
        // Worktree untouched: still B's content, clean status.
        assert_eq!(fs::read_to_string(b.join("index.md")).unwrap(), "# home B\n");
        assert!(backend().status(&b).unwrap().is_empty(), "worktree left clean");

        // A syncs to pick up B's issue (pushed even under conflict).
        backend().sync(&a).unwrap();
        let ids_a: Vec<String> = collab::list_issues(&a).unwrap().into_iter().map(|i| i.id).collect();
        assert!(ids_a.contains(&ia));
        assert!(ids_a.contains(&ib), "B's issue reached A despite the branch conflict");

        // M8 seam: the sync-conflict sentinel resolves against
        // origin/<current> (the endpoint the sync merge collided with), so the
        // ConflictResolver can drive the remote-tracking merge through the same
        // git_conflict_versions / git_merge_resolve commands used for branches.
        let versions = backend().conflict_versions(&b, "__sync__").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].rel_path, "index.md");
        assert_eq!(versions[0].ours, "# home B\n");
        assert_eq!(versions[0].theirs, "# home A\n");

        let resolved = vec![ResolvedFile {
            rel_path: "index.md".to_string(),
            content: "# home merged\n".to_string(),
        }];
        let oid = backend().merge_resolve(&b, "__sync__", resolved).unwrap();
        assert_eq!(oid.len(), 40);
        // Worktree now carries the merged content, status clean, 2-parent commit.
        assert_eq!(fs::read_to_string(b.join("index.md")).unwrap(), "# home merged\n");
        assert!(backend().status(&b).unwrap().is_empty());
        let repo = Repository::open(&b).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2);
    }

    #[test]
    fn dirty_tree_refuses_sync() {
        let (_bare, a, _b, _url) = bare_with_two_clones("dirty");
        fs::write(a.join("uncommitted.md"), "wip\n").unwrap();
        let err = backend().sync(&a).unwrap_err();
        assert!(
            err.to_string().contains("commit or discard changes first"),
            "got: {err}"
        );
    }

    #[test]
    fn no_remote_branch_first_push_creates_it() {
        let (bare, a, _b, _url) = bare_with_two_clones("newbranch");

        backend().create_branch(&a, "topic").unwrap();
        backend().checkout_branch(&a, "topic").unwrap();
        fs::write(a.join("t.md"), "T\n").unwrap();
        backend().commit_all(&a, "topic work").unwrap();

        let ra = backend().sync(&a).unwrap();
        assert_eq!(ra.branch.kind, "noRemoteBranch", "{}", ra.message);
        assert!(ra.pushed);

        // The bare repo now carries refs/heads/topic.
        let bare_repo = Repository::open_bare(&bare).unwrap();
        assert!(bare_repo.refname_to_id("refs/heads/topic").is_ok());
    }
}
