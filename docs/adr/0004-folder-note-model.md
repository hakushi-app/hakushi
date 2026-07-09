# ADR-0004: Folder-note model — a folder is a computed view, not a stored type

- Status: Accepted
- Date: 2026-07-04

## Context

Notion-style nesting requires pages that contain child pages. On disk we want
nothing but Markdown files and directories — no manifest files, no sidecar
metadata that could drift or bloat sync. The Obsidian ecosystem's
"folder note" pattern is proven for exactly this shape.

## Decision

1. A **page** is either `Foo.md` (leaf) or `Foo/index.md` (page that can have
   children: sibling files/dirs inside `Foo/`).
2. **"Folder-ness" is computed, never stored**: if the body of an `index.md`
   parses to embed nodes only (ignoring frontmatter and headings), the
   sidebar renders it as a folder. The "convert to folder" operation just
   rewrites the body to contain only child embeds.
3. No special file kinds, flags, or registries exist for folders; identity
   lives in the frontmatter `id` (ULID), so moves/renames don't break
   references.

## Consequences

- The sync surface is exactly the file tree; git sees ordinary md files.
- Any external tool (or a human with an editor) can create/convert folders by
  editing plain Markdown.
- The tree view must parse `index.md` bodies to classify nodes — mitigated by
  the SQLite index cache (`.hakushi/index.db`, rebuildable, gitignored).
- Edge case accepted: an `index.md` with mixed content renders as a normal
  page that happens to have children.
