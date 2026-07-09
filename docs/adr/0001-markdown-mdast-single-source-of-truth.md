# ADR-0001: Markdown on disk is canonical; mdast is the only internal representation

- Status: Accepted
- Date: 2026-07-04

## Context

Hakushi stores every page as a plain `.md` file managed by git. Two editors
(block WYSIWYG and Markdown source) must edit the same file without corrupting
bytes they did not touch — otherwise view-switching pollutes git diffs and
breaks YAML frontmatter. Editor-native document models (ProseMirror JSON,
BlockNote blocks) are not suitable as the source of truth: BlockNote's
Markdown export is officially lossy — their docs recommend "store as JSON for
fidelity" — which is fundamentally incompatible with md-as-truth.

## Decision

1. The canonical artifact is the Markdown file on disk. The canonical internal
   representation is **mdast** (unified/remark AST). Both editors are *views*
   over mdast; neither editor's native model is ever the truth.
2. A **single remark serializer** in `src/markdown/pipeline.ts` is the only
   code allowed to produce `.md` bytes. Serialization is deterministic
   (fixed marker/fence/indent options, single trailing newline), and
   `normalizeMarkdown` is idempotent — enforced by a CI roundtrip harness.
3. BlockNote is **rejected**. The WYSIWYG editor is **TipTap v3 with the
   official `@tiptap/markdown` extension**, because custom nodes can define
   their own md parse/serialize rules (required for embeds and templates).

## Consequences

- Save path is always: editor content → md string → `normalizeMarkdown` → disk.
- WYSIWYG never sees frontmatter; it is split off and rejoined verbatim.
- Git diffs contain only user edits; view switching is byte-neutral.
- Cost: an mdast⇄ProseMirror adapter must be maintained, and every custom
  TipTap node must prove byte-stability in the roundtrip corpus.
