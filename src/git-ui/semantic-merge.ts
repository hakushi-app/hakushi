// Track C2 — semantic 3-way merge over the canonical markdown pipeline
// (INTERFACES.md §12.2, M7-M8-PLAN §2.1.2).
//
// `semanticMerge3(base, ours, theirs)` aligns the two edited versions against
// their common ancestor at mdast top-level-block granularity (reusing the
// block LCS from block-align.ts, shared with the M4 semantic diff) and
// classifies every block into an `auto` (confidently resolvable) or `conflict`
// (needs a human choice) `MergeBlock`. The result is a flat list of blocks in
// document order — the ConflictResolver renders it top to bottom, and on
// completion the chosen blocks are concatenated and canonicalized.
//
// Design decisions (per the plan / INTERFACES §12.2):
//   - Frontmatter is merged KEY BY KEY, not as an opaque block: `id` is
//     assumed stable, non-colliding keys auto-merge (the side that changed
//     wins; ties on a both-changed break toward the newer `updated`), and only
//     genuinely diverging `template`/`kanban` settings conflict. It always
//     comes out as the first block (auto, or conflict on a settings divergence).
//   - Lists are aligned at TOP-LEVEL ITEM granularity so editing different
//     items (or moving a Kanban card while the other side adds a different card)
//     auto-merges instead of conflicting the whole list.
//   - When in doubt we CONFLICT rather than guess: a wrong auto-merge is silent
//     data loss, whereas an over-eager conflict only costs one click.

import type { List, ListItem, RootContent } from "mdast";

import {
  joinFrontmatter,
  normalizeMarkdown,
  parseMarkdown,
  readFrontmatter,
  splitFrontmatter,
} from "../markdown";
import { blockToMd, diffScript, type ScriptEntry } from "./block-align";

// ---------------------------------------------------------------------------
// Public API (INTERFACES.md §12.2)
// ---------------------------------------------------------------------------

export type MergeBlock =
  | { kind: "auto"; md: string }
  | { kind: "conflict"; base: string | null; ours: string; theirs: string };

export interface MergeResult {
  blocks: MergeBlock[];
  /** True when no `conflict` block is present (the merge fully auto-resolved). */
  autoMerged: boolean;
}

/**
 * Three-way merge of canonical markdown documents. `base` is the common
 * ancestor; `ours`/`theirs` are the two divergent versions. Returned blocks
 * are in document order (frontmatter first, then body).
 */
export function semanticMerge3(
  baseMd: string,
  oursMd: string,
  theirsMd: string,
): MergeResult {
  const blocks: MergeBlock[] = [];

  const fmBlock = mergeFrontmatter(baseMd, oursMd, theirsMd);
  if (fmBlock !== null) blocks.push(fmBlock);

  for (const b of mergeBody(baseMd, oursMd, theirsMd)) blocks.push(b);

  return { blocks, autoMerged: blocks.every((b) => b.kind === "auto") };
}

/**
 * Assemble one file's resolved blocks into canonical markdown. `frontmatterMd`
 * is the resolved frontmatter block's md (or null when the page has none);
 * `bodyBlocksMd` are the resolved body blocks in order. The whole document is
 * run through `normalizeMarkdown` so the on-disk output is always canonical —
 * remark-frontmatter re-emits the YAML block verbatim, so `id`/settings bytes
 * survive exactly while the body and the fence↔body spacing are canonicalized.
 * Idempotent by construction: `normalizeMarkdown(connect(...)) === connect(...)`.
 */
export function connectMergedBlocks(
  frontmatterMd: string | null,
  bodyBlocksMd: readonly string[],
): string {
  const body = bodyBlocksMd
    .map((b) => b.trim())
    .filter((b) => b !== "")
    .join("\n\n");
  const fm = frontmatterMd === null ? null : ensureFrontmatterFences(frontmatterMd);
  const doc = joinFrontmatter(fm, body === "" ? "" : `${body}\n`);
  return doc.trim() === "" ? "" : normalizeMarkdown(doc);
}

/**
 * A frontmatter block's md may or may not carry `---` fences; add them.
 * Returns null for an empty block (treated as no frontmatter).
 */
function ensureFrontmatterFences(md: string): string | null {
  const trimmed = md.replace(/^\n+/, "").replace(/\n+$/, "");
  if (trimmed === "") return null;
  if (/^---\r?\n/.test(trimmed)) return `${trimmed}\n`;
  return `---\n${trimmed}\n---\n`;
}

// ---------------------------------------------------------------------------
// Frontmatter: key-level merge (INTERFACES.md §12.2)
// ---------------------------------------------------------------------------

/** Keys whose divergence is a real conflict rather than a "newer wins" merge. */
const FM_CONFLICT_KEYS = new Set(["template", "kanban"]);

/** Stable key order mirroring the pipeline's frontmatter serializer. */
const FM_KEY_ORDER = ["id", "title", "template", "created", "updated"] as const;

/**
 * Merge the YAML frontmatter of the three versions key by key. Returns `null`
 * when none of the three has frontmatter; an `auto` block (raw frontmatter
 * text) when the merge is unambiguous; a `conflict` block when a
 * `template`/`kanban` setting genuinely diverges.
 */
function mergeFrontmatter(
  baseMd: string,
  oursMd: string,
  theirsMd: string,
): MergeBlock | null {
  const rawBase = splitFrontmatter(baseMd).frontmatter;
  const rawOurs = splitFrontmatter(oursMd).frontmatter;
  const rawTheirs = splitFrontmatter(theirsMd).frontmatter;
  if (rawBase === null && rawOurs === null && rawTheirs === null) return null;

  // Fast paths: identical raw frontmatter, or one side unchanged from base.
  if (rawOurs === rawTheirs) {
    return rawOurs === null ? null : { kind: "auto", md: rawOurs };
  }
  if (rawOurs === rawBase) {
    return rawTheirs === null ? null : { kind: "auto", md: rawTheirs };
  }
  if (rawTheirs === rawBase) {
    return rawOurs === null ? null : { kind: "auto", md: rawOurs };
  }

  const base = readFrontmatter(baseMd) ?? {};
  const ours = readFrontmatter(oursMd) ?? {};
  const theirs = readFrontmatter(theirsMd) ?? {};

  const merged: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);
  const oursNewer = tsOf(ours.updated) >= tsOf(theirs.updated); // ties → ours

  for (const key of keys) {
    const bv = base[key];
    const ov = ours[key];
    const tv = theirs[key];
    const ourChanged = !valueEq(ov, bv);
    const theirChanged = !valueEq(tv, bv);

    if (ourChanged && theirChanged && !valueEq(ov, tv)) {
      // Both changed to DIFFERENT values.
      if (FM_CONFLICT_KEYS.has(key)) {
        return {
          kind: "conflict",
          base: rawBase,
          ours: rawOurs ?? "",
          theirs: rawTheirs ?? "",
        };
      }
      const winner = oursNewer ? ov : tv;
      if (winner !== undefined) merged[key] = winner;
      continue;
    }
    // At most one side changed (or both changed identically): prefer a changed
    // value, else the unchanged base/ours value.
    const chosen = ourChanged ? ov : theirChanged ? tv : (ov ?? tv ?? bv);
    if (chosen !== undefined) merged[key] = chosen;
  }

  return { kind: "auto", md: serializeFrontmatter(merged) };
}

/** Serialize a merged meta map to a raw frontmatter block (stable key order). */
function serializeFrontmatter(map: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FM_KEY_ORDER) {
    if (map[key] !== undefined) ordered[key] = map[key];
  }
  for (const key of Object.keys(map)) {
    if (!(FM_KEY_ORDER as readonly string[]).includes(key) && map[key] !== undefined) {
      ordered[key] = map[key];
    }
  }
  // Route through the pipeline: an empty-body doc with this frontmatter, then
  // split off the (now canonical) frontmatter text. Keeps YAML style identical
  // to every other page the app writes.
  const doc = `---\n${toYaml(ordered)}---\n`;
  const canon = normalizeMarkdown(doc);
  return splitFrontmatter(canon).frontmatter ?? doc;
}

// ---------------------------------------------------------------------------
// Body: block-level 3-way merge
// ---------------------------------------------------------------------------

interface BodyUnit {
  /** Canonical md of this mergeable unit (a list item, or a non-list block). */
  key: string;
  /** Nearest preceding heading (section) — Kanban column / grouping. */
  section: string | null;
}

/**
 * Split a document body into mergeable UNITS: every non-list top-level block is
 * one unit; every top-level list is expanded into one unit per direct item (so
 * different-item edits do not conflict the whole list). Headings are units too
 * (so heading edits merge) and set the section for the units that follow.
 */
function bodyUnits(md: string): BodyUnit[] {
  const tree = parseMarkdown(md);
  const out: BodyUnit[] = [];
  let section: string | null = null;
  for (const child of tree.children) {
    if (child.type === "yaml") continue;
    if (child.type === "heading") {
      section = headingText(child).trim();
      out.push({ key: blockToMd(child), section });
      continue;
    }
    if (child.type === "list") {
      for (const item of child.children) {
        out.push({ key: listItemKey(child, item), section });
      }
      continue;
    }
    out.push({ key: blockToMd(child), section });
  }
  return out;
}

/** Canonical md of a single list item, preserving list type (ordered/task). */
function listItemKey(list: List, item: ListItem): string {
  const singleton: List = { ...list, children: [item] };
  return blockToMd(singleton);
}

function headingText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) return n.children.map(headingText).join("");
  return "";
}

/** Adapt BodyUnits to the block-align rec shape the LCS keys on. */
function toRecs(units: BodyUnit[]): { node: RootContent; key: string; section: string | null }[] {
  return units.map((u) => ({ node: {} as RootContent, key: u.key, section: u.section }));
}

type SideResult =
  | { state: "kept" } // side left this base unit unchanged
  | { state: "deleted" } // side removed this base unit
  | { state: "changed"; unit: BodyUnit }; // side replaced it in place

/**
 * Three-way merge of the two edited bodies against the base body, unit by unit.
 * Returns the merged blocks in document order.
 */
function mergeBody(baseMd: string, oursMd: string, theirsMd: string): MergeBlock[] {
  const base = bodyUnits(baseMd);
  const ours = bodyUnits(oursMd);
  const theirs = bodyUnits(theirsMd);

  const oursScript = diffScript(toRecs(base), toRecs(ours));
  const theirsScript = diffScript(toRecs(base), toRecs(theirs));

  const oursForBase = sideAlignment(oursScript, base, ours);
  const theirsForBase = sideAlignment(theirsScript, base, theirs);
  const oursInserts = insertionsByAnchor(oursScript, base, ours);
  const theirsInserts = insertionsByAnchor(theirsScript, base, theirs);

  const out: MergeBlock[] = [];
  const emitInserts = (anchor: number) => {
    mergeInsertions(oursInserts.get(anchor) ?? [], theirsInserts.get(anchor) ?? [], out);
  };

  emitInserts(-1); // additions before the first base unit
  for (let bi = 0; bi < base.length; bi++) {
    mergeBaseUnit(base[bi], oursForBase[bi], theirsForBase[bi], out);
    emitInserts(bi);
  }
  return out;
}

/**
 * For each base unit, what one side did to it. A base unit that survives
 * verbatim is `kept`; one that vanished with a same-section replacement in its
 * hunk is `changed`; otherwise `deleted`. Same-section pairing keeps a moved
 * Kanban card a delete-here + add-there rather than a spurious in-place modify.
 */
function sideAlignment(
  script: ScriptEntry[],
  base: BodyUnit[],
  side: BodyUnit[],
): SideResult[] {
  const res: SideResult[] = base.map(() => ({ state: "deleted" }));
  let i = 0;
  while (i < script.length) {
    if (script[i].op === "same") {
      res[(script[i] as { ai: number }).ai] = { state: "kept" };
      i++;
      continue;
    }
    const delIdx: number[] = [];
    const insIdx: number[] = [];
    while (i < script.length && script[i].op !== "same") {
      const h = script[i];
      if (h.op === "del") delIdx.push(h.ai);
      else if (h.op === "ins") insIdx.push(h.bi);
      i++;
    }
    let k = 0;
    for (const ai of delIdx) {
      let matched = false;
      while (k < insIdx.length) {
        const cand = side[insIdx[k]];
        k++;
        if (cand.section === base[ai].section) {
          res[ai] = { state: "changed", unit: cand };
          matched = true;
          break;
        }
      }
      if (!matched) res[ai] = { state: "deleted" };
    }
  }
  return res;
}

/**
 * Insertions each side genuinely ADDED (not consumed as in-place replacements
 * by `sideAlignment`), keyed by the base index they follow (−1 = before the
 * first base unit). Mirrors `sideAlignment`'s same-section del/ins pairing so
 * the two never double-count a unit.
 */
function insertionsByAnchor(
  script: ScriptEntry[],
  base: BodyUnit[],
  side: BodyUnit[],
): Map<number, BodyUnit[]> {
  const map = new Map<number, BodyUnit[]>();
  let baseCursor = -1;
  let i = 0;
  while (i < script.length) {
    if (script[i].op === "same") {
      baseCursor = (script[i] as { ai: number }).ai;
      i++;
      continue;
    }
    const hunkAnchor = baseCursor;
    const delSections: (string | null)[] = [];
    const inserts: number[] = [];
    while (i < script.length && script[i].op !== "same") {
      const h = script[i];
      if (h.op === "del") {
        delSections.push(base[h.ai].section);
        baseCursor = h.ai;
      } else if (h.op === "ins") {
        inserts.push(h.bi);
      }
      i++;
    }
    const remainingDel = [...delSections];
    const additions: BodyUnit[] = [];
    for (const insIdx of inserts) {
      const sec = side[insIdx].section;
      const di = remainingDel.indexOf(sec);
      if (di >= 0) remainingDel.splice(di, 1);
      else additions.push(side[insIdx]);
    }
    if (additions.length > 0) {
      map.set(hunkAnchor, [...(map.get(hunkAnchor) ?? []), ...additions]);
    }
  }
  return map;
}

function mergeBaseUnit(
  baseUnit: BodyUnit,
  o: SideResult,
  t: SideResult,
  out: MergeBlock[],
): void {
  const ourMd = resultMd(baseUnit, o);
  const theirMd = resultMd(baseUnit, t);

  if (ourMd === theirMd) {
    // Identical outcomes (including both-deleted → both null).
    if (ourMd !== null) out.push({ kind: "auto", md: ourMd });
    return;
  }
  if (o.state === "kept") {
    if (theirMd !== null) out.push({ kind: "auto", md: theirMd });
    return; // both-null handled above; here theirs deleted → drop
  }
  if (t.state === "kept") {
    if (ourMd !== null) out.push({ kind: "auto", md: ourMd });
    return;
  }
  // Both changed differently, or delete-vs-change → conflict.
  out.push({
    kind: "conflict",
    base: baseUnit.key,
    ours: ourMd ?? "",
    theirs: theirMd ?? "",
  });
}

function resultMd(baseUnit: BodyUnit, r: SideResult): string | null {
  switch (r.state) {
    case "kept":
      return baseUnit.key;
    case "deleted":
      return null;
    case "changed":
      return r.unit.key;
  }
}

/**
 * Merge the genuine additions both sides made at the same anchor slot: same
 * text on both sides → one auto block; both add DIFFERENT content at the same
 * slot → a conflict; only one side added → auto.
 */
function mergeInsertions(ours: BodyUnit[], theirs: BodyUnit[], out: MergeBlock[]): void {
  if (ours.length === 0 && theirs.length === 0) return;

  const theirsLeft = [...theirs];
  const oursOnly: BodyUnit[] = [];
  for (const o of ours) {
    const idx = theirsLeft.findIndex((t) => t.key === o.key);
    if (idx >= 0) {
      theirsLeft.splice(idx, 1);
      out.push({ kind: "auto", md: o.key }); // shared addition
    } else {
      oursOnly.push(o);
    }
  }

  if (oursOnly.length > 0 && theirsLeft.length > 0) {
    out.push({
      kind: "conflict",
      base: null,
      ours: oursOnly.map((u) => u.key).join("\n\n"),
      theirs: theirsLeft.map((u) => u.key).join("\n\n"),
    });
    return;
  }
  for (const u of oursOnly) out.push({ kind: "auto", md: u.key });
  for (const u of theirsLeft) out.push({ kind: "auto", md: u.key });
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function valueEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function tsOf(v: unknown): number {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  if (v instanceof Date) return v.getTime();
  return 0;
}

/**
 * Serialize a meta map to YAML body text (no fences). Kept tiny and dependency-
 * light: `serializeFrontmatter` wraps this and re-normalizes through the
 * pipeline, so the exact style here only needs to round-trip.
 */
function toYaml(map: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    lines.push(yamlLine(k, v));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function yamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === "boolean" || typeof value === "number") return `${key}: ${value}`;
  if (typeof value === "string") return `${key}: ${scalarYaml(value)}`;
  // Nested object / array (e.g. kanban settings): fall back to JSON-in-YAML,
  // which the YAML parser accepts as flow style; the pipeline re-canonicalizes.
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Quote a scalar string only when YAML would otherwise misread it as plain.
 * Unicode (Japanese titles etc.) stays unquoted; only YAML-significant leading
 * characters or an embedded `": "` / `" #"` force double-quoting.
 */
function scalarYaml(s: string): string {
  if (s === "") return '""';
  const needsQuote =
    /^[\s-?:,[\]{}#&*!|>'"%@`]/.test(s) || // YAML-significant first char
    /[\s]$/.test(s) || // trailing whitespace
    /:\s/.test(s) || // key/value separator inside the value
    /\s#/.test(s) || // inline-comment marker
    /^(?:true|false|null|~|yes|no|on|off)$/i.test(s) || // reserved words
    /^[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)$/.test(s); // looks numeric
  return needsQuote ? JSON.stringify(s) : s;
}
