# Contributing to Hakushi

Thanks for your interest in Hakushi — a local-first, git-native Notion
alternative. This guide covers how to get set up, the rules the codebase holds
itself to, and how to submit changes.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start — read the design

Hakushi is design-led. Please read these first:

1. [`docs/DESIGN.md`](docs/DESIGN.md) — the design source of truth.
2. [`docs/dev/INTERFACES.md`](docs/dev/INTERFACES.md) — the binding inter-module
   contract. **To change a contract, edit that file first, then align both
   sides.**
3. [`docs/adr/`](docs/adr/) — architecture decision records (why TipTap not
   BlockNote, why git2 + gix, etc.).

## Non-negotiable rules

These are enforced by review and by the test harness:

- **Only `src/markdown/pipeline.ts` may produce `.md` bytes.** Never write an
  editor's native serialization to disk. Save path: editor content → md string
  → `normalizeMarkdown` → `writeFile`.
- **Editors are views over mdast.** TipTap/CodeMirror internal models are never
  the truth; mdast (unified/remark) is the only internal representation.
- **On-disk formats are Markdown-native, no opaque JSON.** Structured data
  (kanban, calendar, todos) uses GFM + directives; only settings go in
  frontmatter. Diffs must stay semantic (a card move is a one-line diff).
- **Frontmatter `id` (ULID) is page identity.** Paths are convenience; ids are
  truth. Never break id stability on move/rename.
- **Embeds:** tolerant input (`![[wikilink]]` accepted), canonical output
  (always `::embed` / `:::embed` directive on disk).

## Development setup

### Option A — Dev Container / Codespaces (recommended for the web + Linux path)

Open the repo in a
[Dev Container](https://containers.dev) or GitHub Codespace. The
[`.devcontainer`](.devcontainer/devcontainer.json) provisions Node 24, the Rust
toolchain, and the Tauri Linux system dependencies, then runs `npm ci`.

> The container is headless: `npm run typecheck`, `npm test`, and
> `cargo check` all work, but `tauri dev` cannot open a GUI window inside it.
> Use a local machine for interactive desktop/mobile runs.

### Option B — Local

Prerequisites: **Node 24+**, a **Rust** toolchain (`~/.cargo/bin`), and the
[Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for your
OS. Mobile also needs Xcode (iOS) or Android SDK + NDK.

```bash
npm install
npm run tauri dev        # desktop app
```

## Gates — all must pass before you open a PR

```bash
npm run typecheck
npm test                 # roundtrip idempotency + editor fidelity corpus

cd src-tauri
cargo check                                                              # desktop (git-libgit2, default)
cargo check --no-default-features --features git-gix                     # gix backend
cargo check --target aarch64-apple-ios     --no-default-features --features git-gix
cargo check --target aarch64-linux-android --no-default-features --features git-gix
```

CI runs the same five targets (`.github/workflows/ci.yml`). PRs cannot merge
until they are green.

## Sign your commits (DCO)

Hakushi uses the [Developer Certificate of Origin](https://developercertificate.org/).
Every commit must carry a `Signed-off-by` line certifying you wrote the patch or
otherwise have the right to submit it under the project's MIT license:

```bash
git commit -s -m "Your message"
```

This appends `Signed-off-by: Your Name <you@example.com>` using your git
`user.name` / `user.email`. Set the `--global` config once and you're done.
PRs whose commits are not signed off will be asked to amend.

## Submitting changes

1. Fork and branch from `main`.
2. Keep changes focused; update `docs/dev/INTERFACES.md` **first** if you touch
   a module contract, and update the relevant ADR/DESIGN notes.
3. Ensure all gates pass and commits are signed off.
4. Open a PR using the template; link the issue it addresses and check the
   gate boxes.

## Forking Hakushi into your own app?

If you build and distribute your own variant, **change the application
identifier** so it does not collide with the upstream app on the stores:

- `src-tauri/tauri.conf.json` → `identifier` (currently `dev.hakushi.app`)
- `src-tauri/gen/android/app/build.gradle.kts` → `applicationId`

## Where to ask

- **Questions / ideas:** GitHub Discussions.
- **Bugs / features:** GitHub Issues (use the templates).
- **Security:** see [SECURITY.md](SECURITY.md) — do not use public issues.
- **Roadmap:** the *v2 backlog* in the [README](README.md#v2-バックログ今後).
