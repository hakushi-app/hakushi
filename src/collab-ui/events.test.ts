// Track T3 — typed collab event helpers (INTERFACES.md §10.1).
// Parse / order / roundtrip + malformed-JSON tolerance (skip, never crash).

import { describe, expect, it } from "vitest";

import {
  issueStateFrom,
  makeIssueClose,
  makeIssueComment,
  makeIssueReopen,
  makePrReviewComment,
  makePrStatus,
  parseIssueEvents,
  parsePrEvents,
  prStateFrom,
  serializeEvent,
  type IssueEvent,
  type PrEvent,
} from "./events";
import { anchorLabel, relativeTime } from "./format";

const issueCreate = (ts: number): string =>
  JSON.stringify({
    v: 1,
    type: "create",
    ts,
    author: "alice",
    data: { title: "T", body: "B" },
  });

describe("parseIssueEvents", () => {
  it("parses a full lifecycle and keeps ts order", () => {
    const jsons = [
      issueCreate(100),
      JSON.stringify({ v: 1, type: "comment", ts: 200, author: "bob", data: { body: "hi" } }),
      JSON.stringify({ v: 1, type: "close", ts: 300, author: "alice", data: {} }),
      JSON.stringify({ v: 1, type: "reopen", ts: 400, author: "bob", data: {} }),
      JSON.stringify({
        v: 1,
        type: "label",
        ts: 500,
        author: "alice",
        data: { add: ["bug"], remove: [] },
      }),
    ];
    const events = parseIssueEvents(jsons);
    expect(events.map((e) => e.type)).toEqual([
      "create",
      "comment",
      "close",
      "reopen",
      "label",
    ]);
    expect(events[0]).toEqual({
      v: 1,
      type: "create",
      ts: 100,
      author: "alice",
      data: { title: "T", body: "B" },
    });
    expect(issueStateFrom(events)).toBe("open"); // reopened after close
  });

  it("sorts by ts ascending even when input is shuffled (stable for ties)", () => {
    const jsons = [
      JSON.stringify({ v: 1, type: "comment", ts: 300, author: "a", data: { body: "third" } }),
      JSON.stringify({ v: 1, type: "comment", ts: 100, author: "a", data: { body: "first" } }),
      JSON.stringify({ v: 1, type: "comment", ts: 200, author: "a", data: { body: "tie-1" } }),
      JSON.stringify({ v: 1, type: "comment", ts: 200, author: "a", data: { body: "tie-2" } }),
    ];
    const bodies = parseIssueEvents(jsons).map((e) =>
      e.type === "comment" ? e.data.body : "?",
    );
    expect(bodies).toEqual(["first", "tie-1", "tie-2", "third"]);
  });

  it("skips malformed JSON and ill-shaped events without throwing", () => {
    const jsons = [
      "not json at all",
      "{ truncated",
      "123",
      "null",
      "[]",
      JSON.stringify({ v: 2, type: "comment", ts: 1, author: "a", data: { body: "wrong v" } }),
      JSON.stringify({ v: 1, type: "comment", ts: "NaN", author: "a", data: { body: "bad ts" } }),
      JSON.stringify({ v: 1, type: "comment", ts: 1, author: "a", data: {} }), // body missing
      JSON.stringify({ v: 1, type: "comment", ts: 1, author: "a" }), // data missing
      JSON.stringify({ v: 1, type: "mystery", ts: 1, author: "a", data: {} }), // unknown type
      JSON.stringify({ v: 1, type: "comment", ts: 50, author: "a", data: { body: "ok" } }),
    ];
    const events = parseIssueEvents(jsons);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("comment");
    expect(events[0].data).toEqual({ body: "ok" });
  });

  it("tolerates label events with missing arrays", () => {
    const events = parseIssueEvents([
      JSON.stringify({ v: 1, type: "label", ts: 1, author: "a", data: { add: ["x"] } }),
    ]);
    expect(events).toEqual([
      { v: 1, type: "label", ts: 1, author: "a", data: { add: ["x"], remove: [] } },
    ]);
  });
});

describe("parsePrEvents", () => {
  it("parses create / review_comment / status", () => {
    const jsons = [
      JSON.stringify({
        v: 1,
        type: "create",
        ts: 10,
        author: "alice",
        data: { title: "PR", body: "b", source: "feature", target: "main" },
      }),
      JSON.stringify({
        v: 1,
        type: "review_comment",
        ts: 20,
        author: "bob",
        data: { anchor: { page: "Notes.md", block: 3 }, body: "nit" },
      }),
      JSON.stringify({
        v: 1,
        type: "review_comment",
        ts: 30,
        author: "bob",
        data: { anchor: { page: "01JAR000000000000000000002", block: null }, body: "lgtm" },
      }),
      JSON.stringify({ v: 1, type: "status", ts: 40, author: "alice", data: { state: "merged" } }),
    ];
    const events = parsePrEvents(jsons);
    expect(events.map((e) => e.type)).toEqual(["create", "review_comment", "review_comment", "status"]);
    expect(events[1]).toMatchObject({ data: { anchor: { page: "Notes.md", block: 3 } } });
    expect(events[2]).toMatchObject({ data: { anchor: { block: null } } });
    expect(prStateFrom(events)).toBe("merged");
  });

  it("skips status events with unknown states and broken anchors", () => {
    const events = parsePrEvents([
      JSON.stringify({ v: 1, type: "status", ts: 1, author: "a", data: { state: "weird" } }),
      JSON.stringify({ v: 1, type: "review_comment", ts: 2, author: "a", data: { body: "no anchor" } }),
      JSON.stringify({ v: 1, type: "review_comment", ts: 3, author: "a", data: { anchor: { block: 1 }, body: "no page" } }),
    ]);
    expect(events).toEqual([]);
  });
});

describe("serializeEvent roundtrip", () => {
  it("issue events roundtrip through serialize → parse", () => {
    const original: IssueEvent[] = [
      makeIssueComment("こんにちは", "keita", 100),
      makeIssueClose("keita", 200),
      makeIssueReopen("keita", 300),
    ];
    expect(parseIssueEvents(original.map(serializeEvent))).toEqual(original);
  });

  it("pr events roundtrip through serialize → parse", () => {
    const original: PrEvent[] = [
      makePrReviewComment({ page: "Projects/Roadmap.md", block: 2 }, "check", "keita", 10),
      makePrReviewComment({ page: "Welcome.md", block: null }, "ok", "keita", 20),
      makePrStatus("closed", "keita", 30),
    ];
    expect(parsePrEvents(original.map(serializeEvent))).toEqual(original);
  });

  it("emits the canonical §10.1 key order (v, type, ts, author, data)", () => {
    expect(serializeEvent(makeIssueComment("x", "a", 5))).toBe(
      '{"v":1,"type":"comment","ts":5,"author":"a","data":{"body":"x"}}',
    );
  });
});

describe("format helpers", () => {
  it("relativeTime buckets", () => {
    const now = 1_000_000_000 * 1000; // ms
    const at = (secAgo: number) => relativeTime(1_000_000_000 - secAgo, now);
    expect(at(5)).toBe("たった今");
    expect(at(90)).toBe("1分前");
    expect(at(3 * 3600)).toBe("3時間前");
    expect(at(2 * 86400)).toBe("2日前");
    expect(at(70 * 86400)).toBe("2か月前");
    expect(at(400 * 86400)).toBe("1年前");
    // Clock skew (event in the future) clamps to now.
    expect(relativeTime(1_000_000_000 + 999, now)).toBe("たった今");
  });

  it("anchorLabel renders page#block and page-only", () => {
    expect(anchorLabel("Notes.md", 3)).toBe("Notes.md#3");
    expect(anchorLabel("Notes.md", null)).toBe("Notes.md");
  });
});
