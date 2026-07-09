// Track T3 — PRs tab of the right panel (INTERFACES.md §10.3).
//
// 新規 PR (title + body, source = current branch prefilled from gitBranches,
// target select defaulting to main; disabled with a hint while current ==
// target) → list → detail: meta + state badge + review-comment timeline
// (anchor = page picker text input [relPath or id] + optional block number,
// rendered as 「{page}#{block}: {body}」) + comment form + マージ button.
//
// マージ = gitMergeBranch(source) into the CURRENT branch:
//   - "conflicts"          → show the conflicting paths + M8 note, nothing
//                            was touched on disk;
//   - "fastForward"/"merged" → post a status:merged event, refresh, and tell
//                            the app the worktree changed (onMerged);
//   - capabilities.merge=false (gix/mobile) → button disabled with reason.

import { useCallback, useEffect, useState } from "react";

import { capabilityNotice } from "../app/capabilities";
import {
  collabCreatePr,
  collabGetPr,
  collabListPrs,
  collabPrEvent,
  gitBranches,
  gitMergeBranch,
  type GitBackendInfo,
  type GitBranchInfo,
  type PrSummary,
} from "../app/workspace";
import {
  makePrReviewComment,
  makePrStatus,
  parsePrEvents,
  prStateFrom,
  serializeEvent,
  type PrEvent,
  type PrState,
} from "./events";
import { anchorLabel, relativeTime } from "./format";
import "./collab.css";

export interface PrsTabProps {
  root: string;
  /** Currently open page (prefills the review-comment anchor). */
  currentFile: string | null;
  /** Bump to re-read the list / branches / open detail. */
  refreshToken?: number;
  /** git_backend_info result (null while loading) — gates the merge button. */
  backendInfo: GitBackendInfo | null;
  /** Called after a successful merge: worktree/branches changed underneath. */
  onMerged(): void;
}

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PrsTab({
  root,
  currentFile,
  refreshToken = 0,
  backendInfo,
  onMerged,
}: PrsTabProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // 新規 PR form
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [source, setSource] = useState<string | null>(null); // null = prefill pending
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Detail
  const [events, setEvents] = useState<PrEvent[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [anchorPage, setAnchorPage] = useState<string | null>(null); // null = prefill pending
  const [anchorBlock, setAnchorBlock] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState<string[] | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setPrs(await collabListPrs(root));
      setListError(null);
    } catch (e) {
      setListError(errMsg(e));
    }
  }, [root]);

  const refreshBranches = useCallback(async () => {
    try {
      setBranchInfo(await gitBranches(root));
    } catch (e) {
      setListError(errMsg(e));
    }
  }, [root]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setEvents(parsePrEvents(await collabGetPr(root, id)));
        setDetailError(null);
      } catch (e) {
        setDetailError(errMsg(e));
      }
    },
    [root],
  );

  useEffect(() => {
    void refreshList();
    void refreshBranches();
  }, [refreshList, refreshBranches, refreshToken]);

  useEffect(() => {
    if (view.kind === "detail") {
      setEvents(null);
      setMergeConflicts(null);
      void loadDetail(view.id);
    }
  }, [view, loadDetail, refreshToken]);

  // Prefills: source = current branch, target = main (or first ≠ source).
  const currentBranch = branchInfo?.current ?? null;
  const branches = branchInfo?.branches ?? [];
  const effSource = source ?? currentBranch ?? "";
  const effTarget =
    target ??
    (branches.includes("main") ? "main" : (branches.find((b) => b !== effSource) ?? ""));
  const sameBranch = effSource !== "" && effSource === effTarget;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const createPr = useCallback(async () => {
    const title = newTitle.trim();
    if (title === "" || effSource === "" || effTarget === "" || effSource === effTarget) return;
    setBusy(true);
    try {
      const id = await collabCreatePr(root, title, newBody.trim(), effSource, effTarget);
      setNewTitle("");
      setNewBody("");
      setSource(null);
      setTarget(null);
      setListError(null);
      await refreshList();
      setView({ kind: "detail", id });
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [root, newTitle, newBody, effSource, effTarget, refreshList]);

  const postEvent = useCallback(
    async (id: string, event: PrEvent) => {
      setBusy(true);
      try {
        await collabPrEvent(root, id, serializeEvent(event));
        setDetailError(null);
        await Promise.all([loadDetail(id), refreshList()]);
      } catch (e) {
        setDetailError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [root, loadDetail, refreshList],
  );

  const doMerge = useCallback(
    async (id: string, prSource: string) => {
      setBusy(true);
      setDetailError(null);
      setMergeConflicts(null);
      try {
        const outcome = await gitMergeBranch(root, prSource);
        if (outcome.kind === "conflicts") {
          setMergeConflicts(outcome.conflictPaths);
          return;
        }
        // fastForward | merged → record it on the PR log, then refresh.
        await collabPrEvent(root, id, serializeEvent(makePrStatus("merged")));
        await Promise.all([loadDetail(id), refreshList(), refreshBranches()]);
        onMerged();
      } catch (e) {
        setDetailError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [root, loadDetail, refreshList, refreshBranches, onMerged],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (view.kind === "new") {
    return (
      <section className="git-section">
        <button type="button" className="collab-back-btn" onClick={() => setView({ kind: "list" })}>
          ← 一覧へ戻る
        </button>
        <h3>新規 PR</h3>
        {listError !== null && (
          <div className="git-error" role="alert">
            {listError}
          </div>
        )}
        <div className="collab-form">
          <input
            type="text"
            placeholder="タイトル"
            value={newTitle}
            disabled={busy}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <textarea
            placeholder="説明（任意）"
            rows={3}
            value={newBody}
            disabled={busy}
            onChange={(e) => setNewBody(e.target.value)}
          />
          <div className="collab-form-row">
            <label htmlFor="pr-source">source</label>
            <select
              id="pr-source"
              value={effSource}
              disabled={busy || branches.length === 0}
              onChange={(e) => setSource(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <label htmlFor="pr-target">→ target</label>
            <select
              id="pr-target"
              value={effTarget}
              disabled={busy || branches.length === 0}
              onChange={(e) => setTarget(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          {sameBranch && (
            <p className="collab-hint">
              source と target が同じブランチです。Git タブで作業ブランチを作成・切替してから
              PR を作成してください。
            </p>
          )}
          <div className="collab-form-actions">
            <button
              type="button"
              className="collab-primary-btn"
              disabled={
                busy ||
                newTitle.trim() === "" ||
                effSource === "" ||
                effTarget === "" ||
                sameBranch
              }
              onClick={() => void createPr()}
            >
              作成
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (view.kind === "detail") {
    const summary = prs.find((p) => p.id === view.id) ?? null;
    const create = events?.find((e) => e.type === "create") ?? null;
    const title =
      create !== null && create.type === "create"
        ? create.data.title
        : (summary?.title ?? view.id);
    const prSource =
      create !== null && create.type === "create"
        ? create.data.source
        : (summary?.source ?? "");
    const prTarget =
      create !== null && create.type === "create"
        ? create.data.target
        : (summary?.target ?? "");
    const state: PrState =
      events !== null ? prStateFrom(events) : ((summary?.state as PrState) ?? "open");
    const mergeSupported = backendInfo?.capabilities.merge ?? false;
    // §12.5: unified non-engineer wording when merge is unsupported (gix).
    const mergeNotice =
      backendInfo !== null ? capabilityNotice(backendInfo, "merge") : null;
    const effAnchorPage = anchorPage ?? currentFile ?? "";
    return (
      <section className="git-section">
        <button type="button" className="collab-back-btn" onClick={() => setView({ kind: "list" })}>
          ← 一覧へ戻る
        </button>
        <h4 className="collab-detail-title">{title}</h4>
        <div className="collab-detail-meta">
          <PrStateBadge state={state} />
          <span>
            {prSource} → {prTarget}
          </span>
        </div>
        {detailError !== null && (
          <div className="git-error" role="alert">
            {detailError}
          </div>
        )}
        {events === null ? (
          <p className="git-empty">読み込み中…</p>
        ) : (
          <ul className="collab-timeline">
            {events.map((ev, i) => (
              <PrEventItem key={i} event={ev} />
            ))}
          </ul>
        )}

        {/* レビューコメント (anchor: page + optional block, §10.1) */}
        <div className="collab-form">
          <div className="collab-form-row">
            <input
              type="text"
              placeholder="relPath または ID"
              aria-label="アンカーページ"
              value={effAnchorPage}
              disabled={busy}
              onChange={(e) => setAnchorPage(e.target.value)}
            />
            <input
              type="number"
              placeholder="ブロック#"
              aria-label="ブロック番号（任意）"
              style={{ width: "72px" }}
              min={0}
              value={anchorBlock}
              disabled={busy}
              onChange={(e) => setAnchorBlock(e.target.value)}
            />
          </div>
          <textarea
            placeholder="レビューコメント…"
            rows={3}
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="collab-form-actions">
            <button
              type="button"
              className="collab-primary-btn"
              disabled={busy || comment.trim() === "" || effAnchorPage.trim() === ""}
              onClick={() => {
                const body = comment.trim();
                const block =
                  anchorBlock.trim() === "" ? null : Number.parseInt(anchorBlock, 10);
                setComment("");
                void postEvent(
                  view.id,
                  makePrReviewComment(
                    {
                      page: effAnchorPage.trim(),
                      block: block !== null && Number.isFinite(block) ? block : null,
                    },
                    body,
                  ),
                );
              }}
            >
              コメント
            </button>
          </div>
        </div>

        {/* マージ */}
        {state === "open" && (
          <div className="collab-form">
            <button
              type="button"
              className="collab-primary-btn"
              disabled={busy || !mergeSupported || prSource === ""}
              onClick={() => void doMerge(view.id, prSource)}
            >
              マージ（{prSource} → 現在のブランチ）
            </button>
            {!mergeSupported && mergeNotice !== null && (
              <p className="collab-hint">{mergeNotice}</p>
            )}
            {mergeSupported && prTarget !== "" && currentBranch !== null && currentBranch !== prTarget && (
              <p className="collab-hint">
                注意: 現在のブランチは {currentBranch} です（PR の target は {prTarget}）。
                マージは現在のブランチへ取り込まれます。
              </p>
            )}
            {mergeConflicts !== null && (
              <div className="collab-merge-conflicts" role="alert">
                コンフリクトのためマージできませんでした:
                <ul>
                  {mergeConflicts.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                M8 でコンフリクト解決 UI が入ります。
              </div>
            )}
          </div>
        )}
      </section>
    );
  }

  // --- list ---
  return (
    <section className="git-section">
      <h3>Pull Requests</h3>
      {listError !== null && (
        <div className="git-error" role="alert">
          {listError}
        </div>
      )}
      {prs.length === 0 ? (
        <p className="git-empty">PR はまだありません</p>
      ) : (
        <ul className="collab-list">
          {prs.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="collab-item"
                onClick={() => setView({ kind: "detail", id: p.id })}
              >
                <span className="collab-item-title">{p.title}</span>
                <span className="collab-item-meta">
                  <PrStateBadge state={(p.state as PrState) ?? "open"} /> {p.source} →{" "}
                  {p.target} · {relativeTime(p.updatedTs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="collab-primary-btn"
        onClick={() => {
          setSource(null);
          setTarget(null);
          setView({ kind: "new" });
        }}
      >
        ＋ 新規 PR
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function PrStateBadge({ state }: { state: PrState }) {
  switch (state) {
    case "open":
      return <span className="collab-badge collab-badge-open">オープン</span>;
    case "merged":
      return <span className="collab-badge collab-badge-merged">マージ済み</span>;
    case "closed":
      return <span className="collab-badge collab-badge-closed">クローズ</span>;
  }
}

function PrEventItem({ event }: { event: PrEvent }) {
  const meta = `${event.author} · ${relativeTime(event.ts)}`;
  switch (event.type) {
    case "create":
      return (
        <li className="collab-event">
          <span className="collab-event-head">作成 · {meta}</span>
          {event.data.body !== "" && <p className="collab-event-body">{event.data.body}</p>}
        </li>
      );
    case "review_comment":
      return (
        <li className="collab-event">
          <span className="collab-event-head">レビューコメント · {meta}</span>
          <p className="collab-event-body">
            <span className="collab-event-anchor">
              {anchorLabel(event.data.anchor.page, event.data.anchor.block)}
            </span>
            : {event.data.body}
          </p>
        </li>
      );
    case "status":
      return (
        <li className="collab-event">
          <span className="collab-event-head">
            状態変更 → <PrStateBadge state={event.data.state} /> · {meta}
          </span>
        </li>
      );
  }
}
