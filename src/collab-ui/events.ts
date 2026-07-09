// Track T3 — typed collab event parse/serialize (INTERFACES.md §10.1).
//
// The backend stores each issue/PR event as ONE JSON line inside a git
// commit message under refs/hakushi/*:
//   {"v":1,"type":"…","ts":<epoch_sec>,"author":"…","data":{…}}
// `collabGetIssue` / `collabGetPr` hand those lines back verbatim; this
// module is the single place that turns them into typed events (and back).
//
// Tolerance rule: reading is lenient — malformed JSON or unknown/ill-shaped
// events are SKIPPED, never thrown, so one bad commit cannot brick the panel.
// Writing is strict: serializeEvent emits the canonical key order
// (v, type, ts, author, data).

// ---------------------------------------------------------------------------
// Event types (§10.1)
// ---------------------------------------------------------------------------

export interface EventEnvelope<TType extends string, TData> {
  v: 1;
  type: TType;
  /** Epoch seconds. */
  ts: number;
  /** git user.name of the author ("me" for locally composed events). */
  author: string;
  data: TData;
}

export type IssueEvent =
  | EventEnvelope<"create", { title: string; body: string }>
  | EventEnvelope<"comment", { body: string }>
  | EventEnvelope<"close", Record<string, never>>
  | EventEnvelope<"reopen", Record<string, never>>
  | EventEnvelope<"label", { add: string[]; remove: string[] }>;

export type IssueState = "open" | "closed";

export interface PrAnchor {
  /** Page id (ULID) or workspace rel path. */
  page: string;
  /** Optional block number within the page. */
  block: number | null;
}

export type PrState = "open" | "merged" | "closed";

export type PrEvent =
  | EventEnvelope<
      "create",
      { title: string; body: string; source: string; target: string }
    >
  | EventEnvelope<"review_comment", { anchor: PrAnchor; body: string }>
  | EventEnvelope<"status", { state: PrState }>;

/**
 * Author used for events composed in this client. The real backend derives
 * `author` from git user.name when IT creates events (issue/PR create); for
 * `collab_*_event` the JSON passes through as-is, so locally composed
 * comments/status changes carry this placeholder until M7 identity wiring.
 */
export const LOCAL_AUTHOR = "me";

/** Current time as epoch seconds. */
export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Parsing (lenient)
// ---------------------------------------------------------------------------

interface RawEnvelope {
  v: 1;
  type: string;
  ts: number;
  author: string;
  data: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** JSON line → envelope with the common fields checked, or null. */
function parseEnvelope(json: string): RawEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (typeof value.type !== "string") return null;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return null;
  if (typeof value.author !== "string") return null;
  if (!isRecord(value.data)) return null;
  return {
    v: 1,
    type: value.type,
    ts: value.ts,
    author: value.author,
    data: value.data,
  };
}

function toIssueEvent(env: RawEnvelope): IssueEvent | null {
  const { data } = env;
  const base = { v: 1 as const, ts: env.ts, author: env.author };
  switch (env.type) {
    case "create":
      if (typeof data.title !== "string" || typeof data.body !== "string") return null;
      return { ...base, type: "create", data: { title: data.title, body: data.body } };
    case "comment":
      if (typeof data.body !== "string") return null;
      return { ...base, type: "comment", data: { body: data.body } };
    case "close":
      return { ...base, type: "close", data: {} };
    case "reopen":
      return { ...base, type: "reopen", data: {} };
    case "label": {
      const add = isStringArray(data.add) ? data.add : [];
      const remove = isStringArray(data.remove) ? data.remove : [];
      return { ...base, type: "label", data: { add, remove } };
    }
    default:
      return null; // unknown type → skip (forward compatibility)
  }
}

function toPrEvent(env: RawEnvelope): PrEvent | null {
  const { data } = env;
  const base = { v: 1 as const, ts: env.ts, author: env.author };
  switch (env.type) {
    case "create":
      if (
        typeof data.title !== "string" ||
        typeof data.body !== "string" ||
        typeof data.source !== "string" ||
        typeof data.target !== "string"
      ) {
        return null;
      }
      return {
        ...base,
        type: "create",
        data: {
          title: data.title,
          body: data.body,
          source: data.source,
          target: data.target,
        },
      };
    case "review_comment": {
      if (typeof data.body !== "string" || !isRecord(data.anchor)) return null;
      const anchor = data.anchor;
      if (typeof anchor.page !== "string") return null;
      const block =
        typeof anchor.block === "number" && Number.isFinite(anchor.block)
          ? anchor.block
          : null;
      return {
        ...base,
        type: "review_comment",
        data: { anchor: { page: anchor.page, block }, body: data.body },
      };
    }
    case "status":
      if (data.state !== "open" && data.state !== "merged" && data.state !== "closed") {
        return null;
      }
      return { ...base, type: "status", data: { state: data.state } };
    default:
      return null;
  }
}

/** ts-ascending stable sort (Array.prototype.sort is stable). */
function byTsAscending<T extends { ts: number }>(events: T[]): T[] {
  return events.sort((a, b) => a.ts - b.ts);
}

/**
 * Parse raw issue event JSON lines. Malformed lines and unknown event types
 * are skipped. Result is sorted by ts ascending (stable for equal ts).
 */
export function parseIssueEvents(jsons: readonly string[]): IssueEvent[] {
  const out: IssueEvent[] = [];
  for (const json of jsons) {
    const env = parseEnvelope(json);
    if (env === null) continue;
    const ev = toIssueEvent(env);
    if (ev !== null) out.push(ev);
  }
  return byTsAscending(out);
}

/**
 * Parse raw PR event JSON lines. Malformed lines and unknown event types
 * are skipped. Result is sorted by ts ascending (stable for equal ts).
 */
export function parsePrEvents(jsons: readonly string[]): PrEvent[] {
  const out: PrEvent[] = [];
  for (const json of jsons) {
    const env = parseEnvelope(json);
    if (env === null) continue;
    const ev = toPrEvent(env);
    if (ev !== null) out.push(ev);
  }
  return byTsAscending(out);
}

// ---------------------------------------------------------------------------
// Serialization + constructors
// ---------------------------------------------------------------------------

/** Canonical one-line JSON with fixed key order (v, type, ts, author, data). */
export function serializeEvent(event: IssueEvent | PrEvent): string {
  return JSON.stringify({
    v: event.v,
    type: event.type,
    ts: event.ts,
    author: event.author,
    data: event.data,
  });
}

export function makeIssueComment(
  body: string,
  author: string = LOCAL_AUTHOR,
  ts: number = nowTs(),
): IssueEvent {
  return { v: 1, type: "comment", ts, author, data: { body } };
}

export function makeIssueClose(
  author: string = LOCAL_AUTHOR,
  ts: number = nowTs(),
): IssueEvent {
  return { v: 1, type: "close", ts, author, data: {} };
}

export function makeIssueReopen(
  author: string = LOCAL_AUTHOR,
  ts: number = nowTs(),
): IssueEvent {
  return { v: 1, type: "reopen", ts, author, data: {} };
}

export function makePrReviewComment(
  anchor: PrAnchor,
  body: string,
  author: string = LOCAL_AUTHOR,
  ts: number = nowTs(),
): PrEvent {
  return { v: 1, type: "review_comment", ts, author, data: { anchor, body } };
}

export function makePrStatus(
  state: PrState,
  author: string = LOCAL_AUTHOR,
  ts: number = nowTs(),
): PrEvent {
  return { v: 1, type: "status", ts, author, data: { state } };
}

// ---------------------------------------------------------------------------
// Derivations (shared by the tabs after posting events)
// ---------------------------------------------------------------------------

/** Issue state after replaying close/reopen (default "open"). */
export function issueStateFrom(events: readonly IssueEvent[]): IssueState {
  let state: IssueState = "open";
  for (const ev of events) {
    if (ev.type === "close") state = "closed";
    else if (ev.type === "reopen") state = "open";
  }
  return state;
}

/** PR state after replaying status events (default "open"). */
export function prStateFrom(events: readonly PrEvent[]): PrState {
  let state: PrState = "open";
  for (const ev of events) {
    if (ev.type === "status") state = ev.data.state;
  }
  return state;
}
