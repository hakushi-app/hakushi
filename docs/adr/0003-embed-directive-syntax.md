# ADR-0003: Page embeds use remark-directive syntax (tolerant input, canonical output)

- Status: Accepted
- Date: 2026-07-04

## Context

Transclusion (embedding one page in another) is Hakushi's core structural
primitive — folder pages, kanban columns and templates are all built on it.
The syntax must (a) be a first-class mdast node so a single node flows to
TipTap, HTML/PDF/Docx renderers alike, (b) carry attributes (`mode`, ids),
and (c) survive the deterministic serializer byte-for-byte. Obsidian-style
`![[wikilink]]` is popular but is not structured mdast and cannot carry
attributes.

## Decision

1. Embeds are **remark-directive** nodes: container `:::embed{page="Roadmap"
   mode="folder"}` and leaf `::embed[Label]{page="..."}`. In mdast they are
   plain `leafDirective`/`containerDirective` nodes with `name === "embed"` —
   no custom node types are added.
2. Attributes: `page` (page id or workspace-relative path, required) and
   `mode` ∈ `inline | folder | preview` (default `inline`).
3. **Tolerant input**: `![[Target]]` / `![[Target|Label]]` in pasted or
   imported text is accepted and converted post-parse to the equivalent
   `embed` leaf directive (`src/markdown/remark-hakushi-embed.ts`).
4. **Canonical output**: the disk form is always the directive syntax, via
   the single remark serializer. Wikilinks never round-trip back to disk.

## Consequences

- One node type drives editor rendering and all export formats; attributes
  give embeds room to grow (kanban columns, preview depth) without new syntax.
- Files remain readable in GitHub/plain-text viewers (directives degrade to
  visible text rather than breaking rendering).
- Obsidian users can paste wikilinks, but files saved by Hakushi will show a
  one-time diff converting them to directives — accepted as the price of a
  canonical form.
