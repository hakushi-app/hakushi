// Track V — embed cycle / depth guard (INTERFACES.md §5.6).
//
// Pure function, no DOM, no Tauri. The resolution chain is the list of
// workspace-relative page paths that are already being rendered, outermost
// first — chain[0] is the page open in the editor, deeper entries are the
// pages of enclosing embed previews.

/** Maximum embed nesting depth (DESIGN.md M2: 深さ制限). */
export const MAX_EMBED_DEPTH = 3;

/**
 * Whether an embed of `next` may be rendered given the current resolution
 * `chain`.
 *
 * Returns `false` when:
 *   - `next` is already somewhere in the chain (a cycle: A → … → A), or
 *   - the chain already holds `maxDepth` pages (depth exceeded — rendering
 *     `next` would nest deeper than allowed).
 */
export function canRenderEmbed(
  chain: readonly string[],
  next: string,
  maxDepth: number = MAX_EMBED_DEPTH,
): boolean {
  if (chain.includes(next)) return false;
  if (chain.length >= maxDepth) return false;
  return true;
}
