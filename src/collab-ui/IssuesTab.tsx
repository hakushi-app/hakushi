// Track T3 — Issues tab of the right panel (INTERFACES.md §10.3).
//
// list (open/closed filter chips, comment count, relative time)
//   → 新規 Issue form (title + body)
//   → detail (event timeline 作成/コメント/クローズ/再オープン rendered in
//     ts order, comment box, close/reopen buttons).
//
// All data flows through the workspace.ts collab wrappers; raw event JSON
// lines are parsed here via events.ts (malformed lines are skipped).

import { useCallback, useEffect, useState } from "react";

import {
  collabCreateIssue,
  collabGetIssue,
  collabIssueEvent,
  collabListIssues,
  type IssueSummary,
} from "../app/workspace";
import {
  issueStateFrom,
  makeIssueClose,
  makeIssueComment,
  makeIssueReopen,
  parseIssueEvents,
  serializeEvent,
  type IssueEvent,
  type IssueState,
} from "./events";
import { relativeTime } from "./format";
import "./collab.css";

export interface IssuesTabProps {
  root: string;
  /** Bump to re-read the list / open detail. */
  refreshToken?: number;
}

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function IssuesTab({ root, refreshToken = 0 }: IssuesTabProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [filter, setFilter] = useState<IssueState>("open");
  const [listError, setListError] = useState<string | null>(null);
  // 新規 Issue form
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Detail
  const [events, setEvents] = useState<IssueEvent[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const refreshList = useCallback(async () => {
    try {
      setIssues(await collabListIssues(root));
      setListError(null);
    } catch (e) {
      setListError(errMsg(e));
    }
  }, [root]);

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        setEvents(parseIssueEvents(await collabGetIssue(root, id)));
        setDetailError(null);
      } catch (e) {
        setDetailError(errMsg(e));
      }
    },
    [root],
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList, refreshToken]);

  useEffect(() => {
    if (view.kind === "detail") {
      setEvents(null);
      void loadDetail(view.id);
    }
  }, [view, loadDetail, refreshToken]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const createIssue = useCallback(async () => {
    const title = newTitle.trim();
    if (title === "") return;
    setBusy(true);
    try {
      const id = await collabCreateIssue(root, title, newBody.trim());
      setNewTitle("");
      setNewBody("");
      setListError(null);
      await refreshList();
      setView({ kind: "detail", id });
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [root, newTitle, newBody, refreshList]);

  const postEvent = useCallback(
    async (id: string, event: IssueEvent) => {
      setBusy(true);
      try {
        await collabIssueEvent(root, id, serializeEvent(event));
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

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (view.kind === "new") {
    return (
      <section className="git-section">
        <button type="button" className="collab-back-btn" onClick={() => setView({ kind: "list" })}>
          ← 一覧へ戻る
        </button>
        <h3>新規 Issue</h3>
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
            placeholder="本文（任意）"
            rows={4}
            value={newBody}
            disabled={busy}
            onChange={(e) => setNewBody(e.target.value)}
          />
          <div className="collab-form-actions">
            <button
              type="button"
              className="collab-primary-btn"
              disabled={busy || newTitle.trim() === ""}
              onClick={() => void createIssue()}
            >
              作成
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (view.kind === "detail") {
    const summary = issues.find((s) => s.id === view.id) ?? null;
    const create = events?.find((e) => e.type === "create") ?? null;
    const title =
      create !== null && create.type === "create"
        ? create.data.title
        : (summary?.title ?? view.id);
    const state: IssueState =
      events !== null ? issueStateFrom(events) : ((summary?.state as IssueState) ?? "open");
    return (
      <section className="git-section">
        <button type="button" className="collab-back-btn" onClick={() => setView({ kind: "list" })}>
          ← 一覧へ戻る
        </button>
        <h4 className="collab-detail-title">{title}</h4>
        <div className="collab-detail-meta">
          <StateBadge state={state} />
          {summary !== null && <span>💬 {summary.commentCount}</span>}
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
              <IssueEventItem key={i} event={ev} />
            ))}
          </ul>
        )}
        <div className="collab-form">
          <textarea
            placeholder="コメントを書く…"
            rows={3}
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="collab-form-actions">
            <button
              type="button"
              className="collab-primary-btn"
              disabled={busy || comment.trim() === ""}
              onClick={() => {
                const body = comment.trim();
                setComment("");
                void postEvent(view.id, makeIssueComment(body));
              }}
            >
              コメント
            </button>
            {state === "open" ? (
              <button
                type="button"
                className="collab-secondary-btn"
                disabled={busy}
                onClick={() => void postEvent(view.id, makeIssueClose())}
              >
                クローズ
              </button>
            ) : (
              <button
                type="button"
                className="collab-secondary-btn"
                disabled={busy}
                onClick={() => void postEvent(view.id, makeIssueReopen())}
              >
                再オープン
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  // --- list ---
  const filtered = issues.filter((s) => s.state === filter);
  return (
    <section className="git-section">
      <h3>Issues</h3>
      <div className="collab-chips" role="group" aria-label="状態フィルタ">
        {(["open", "closed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={filter === s ? "collab-chip active" : "collab-chip"}
            onClick={() => setFilter(s)}
          >
            {s === "open" ? "オープン" : "クローズ"}
          </button>
        ))}
      </div>
      {listError !== null && (
        <div className="git-error" role="alert">
          {listError}
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="git-empty">
          {filter === "open" ? "オープンな Issue はありません" : "クローズ済みの Issue はありません"}
        </p>
      ) : (
        <ul className="collab-list">
          {filtered.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="collab-item"
                onClick={() => setView({ kind: "detail", id: s.id })}
              >
                <span className="collab-item-title">{s.title}</span>
                <span className="collab-item-meta">
                  💬 {s.commentCount} · {relativeTime(s.updatedTs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="collab-primary-btn"
        onClick={() => setView({ kind: "new" })}
      >
        ＋ 新規 Issue
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StateBadge({ state }: { state: IssueState }) {
  return state === "open" ? (
    <span className="collab-badge collab-badge-open">オープン</span>
  ) : (
    <span className="collab-badge collab-badge-closed">クローズ</span>
  );
}

function IssueEventItem({ event }: { event: IssueEvent }) {
  const meta = `${event.author} · ${relativeTime(event.ts)}`;
  switch (event.type) {
    case "create":
      return (
        <li className="collab-event">
          <span className="collab-event-head">作成 · {meta}</span>
          {event.data.body !== "" && <p className="collab-event-body">{event.data.body}</p>}
        </li>
      );
    case "comment":
      return (
        <li className="collab-event">
          <span className="collab-event-head">コメント · {meta}</span>
          <p className="collab-event-body">{event.data.body}</p>
        </li>
      );
    case "close":
      return (
        <li className="collab-event">
          <span className="collab-event-head">クローズしました · {meta}</span>
        </li>
      );
    case "reopen":
      return (
        <li className="collab-event">
          <span className="collab-event-head">再オープンしました · {meta}</span>
        </li>
      );
    case "label":
      return (
        <li className="collab-event">
          <span className="collab-event-head">
            ラベル変更（
            {[
              ...event.data.add.map((l) => `+${l}`),
              ...event.data.remove.map((l) => `−${l}`),
            ].join(" ")}
            ）· {meta}
          </span>
        </li>
      );
  }
}
