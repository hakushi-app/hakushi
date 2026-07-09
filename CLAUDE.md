# CLAUDE.md — Hakushi agent instructions

Read these FIRST, in order:

1. `docs/DESIGN.md` — the design source of truth. Implementation follows it.
2. `docs/dev/INTERFACES.md` — the binding inter-module contract. To change a
   contract, edit that file first, then align both sides.
3. `docs/adr/` — decision records (why TipTap not BlockNote, why git2+gix, etc.).

## Iron rules

- **Only `src/markdown/pipeline.ts` may produce `.md` bytes.** Never write an
  editor's native serialization to disk. Save path: editor content → md string
  → `normalizeMarkdown` → `writeFile`.
- **Editors are views over mdast.** TipTap/CodeMirror internal models are
  never the truth; mdast (unified/remark) is the only internal representation.
- **On-disk formats are Markdown-native, no opaque JSON.** Structured data
  (kanban, calendar, todos) uses GFM + directives; only settings go in
  frontmatter. Diffs must stay semantic (card move = 1-line diff).
- **Frontmatter `id` (ULID) is page identity.** Paths are convenience; ids are
  truth. Never break id stability on move/rename.
- WYSIWYG never sees frontmatter: `splitFrontmatter` before TipTap,
  `joinFrontmatter` on save.
- Embeds: tolerant input (`![[wikilink]]` accepted), canonical output (always
  `::embed` / `:::embed` directive on disk).

## Gates (all must pass)

```bash
npm run typecheck
npm test                 # roundtrip idempotency + editor fidelity corpus
cd src-tauri
cargo check                                                              # desktop (git-libgit2, default)
cargo check --no-default-features --features git-gix
cargo check --target aarch64-apple-ios --no-default-features --features git-gix
cargo check --target aarch64-linux-android --no-default-features --features git-gix
```

Rust is at `~/.cargo/bin` (prefix `export PATH="$HOME/.cargo/bin:$PATH"` if needed).

## Roadmap position

**M0–M8 complete.** The full roadmap is implemented and all gates are green:
skeleton + mobile-git spike + idempotency harness + 5-target CI (M0), dual
editors / file tree / deterministic save (M1), nested pages / embeds / link
index (M2), export HTML·Docx·PDF (M3), local git UI / semantic diff (M4),
templates (M5), collab Issue/PR/review/merge over `refs/hakushi/*` (M6), remote
sync + static-site publish + keychain auth (M7), and mobile responsiveness /
in-app auto-sync / semantic 3-way conflict resolution (M8).

The mobile projects are generated: `tauri ios init` / `tauri android init` have
been run, so `src-tauri/gen/apple` (Xcode) and `src-tauri/gen/android` (Gradle)
exist. Their own `.gitignore` files exclude build outputs; the project sources
are tracked. On-device run/touch verification is the manual checklist
(`docs/dev/M8-MANUAL-CHECKS.md`).

Next: **v2 backlog** (see README §v2 バックログ) — SSH auth, multiple remotes,
gix push (or isomorphic-git fallback), OS background sync, mobile stronghold
auth, Typst PDF backend, dark mode, full-text search (SQLite FTS), and manual
on-device verification. Pick these up individually; there is no further linear
milestone. See `docs/DESIGN.md` §フェーズ別ロードマップ for the original plan.
