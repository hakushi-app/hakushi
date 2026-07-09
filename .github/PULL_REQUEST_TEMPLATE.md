## Summary

<!-- What does this change and why? -->

## Related issue

Closes #

## Gates (all must pass — CI runs the same five)

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `cargo check` (desktop, git-libgit2)
- [ ] `cargo check --no-default-features --features git-gix`
- [ ] `cargo check --target aarch64-apple-ios --no-default-features --features git-gix`
- [ ] `cargo check --target aarch64-linux-android --no-default-features --features git-gix`

## Design & contracts

- [ ] If a module contract changed, `docs/dev/INTERFACES.md` was updated **first**
- [ ] Only `src/markdown/pipeline.ts` produces `.md` bytes (no editor-native serialization to disk)
- [ ] On-disk format stays Markdown-native; diffs stay semantic
- [ ] Relevant ADR / `docs/DESIGN.md` notes updated (if applicable)

## Sign-off

- [ ] My commits are signed off (`git commit -s`, [DCO](https://developercertificate.org/))
