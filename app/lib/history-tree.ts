// Non-linear history (TODO §10) — the tree arithmetic behind Photoshop's
// "keep the redo branch when you edit after undoing".
//
// The engine's history is a list of REVERSIBLE deltas (before/after pixel
// patches, plus structural undo/redo callbacks). Photoshop can offer non-linear
// history because each of its states is a full document copy; a delta list
// can't just "keep" the discarded tail, because those deltas describe a
// document that no longer exists once you edit from an earlier point.
//
// What a delta list CAN do is branch: give every entry a parent, and moving
// between any two states is "revert up to the common ancestor, then apply back
// down". That is an undo tree, and it costs one number per entry. Linear mode
// then becomes a special case — prune the old branch instead of keeping it —
// so there is one traversal implementation, not two.
//
// Pure and DOM-free: `parents[i]` is the index of entry i's parent, or -1 when
// its parent is the original document state.

/** Node index of the original document — the root every branch grows from. */
export const ROOT = -1;

/** `node` and every ancestor above it, nearest first (the root is not a node). */
export function ancestry(parents: number[], node: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let n = node;
  // A malformed parent chain (a cycle) must not hang the editor.
  while (n >= 0 && n < parents.length && !seen.has(n)) {
    seen.add(n);
    out.push(n);
    n = parents[n];
  }
  return out;
}

/** Steps from the root down to `node`, root-first. Depth = its length. */
export const pathTo = (parents: number[], node: number): number[] =>
  ancestry(parents, node).reverse();

/** Is `node` on the chain from the root to `target` (or the target itself)? */
export function onPath(parents: number[], node: number, target: number): boolean {
  if (node === ROOT) return true; // the original state is on every path
  return ancestry(parents, target).includes(node);
}

/**
 * How to get from state `from` to state `to`: revert these entries in order,
 * then apply those. Both states are node indices (ROOT = the original).
 *
 * For a linear history this reduces exactly to today's behaviour — walking back
 * to a common ancestor is walking back down the single chain.
 */
export function transition(
  parents: number[],
  from: number,
  to: number,
): { revert: number[]; apply: number[] } {
  if (from === to) return { revert: [], apply: [] };
  const fromChain = ancestry(parents, from); // nearest first
  const toChain = ancestry(parents, to);
  const toSet = new Set(toChain);
  // The lowest common ancestor is the first node of `from`'s chain that also
  // appears on `to`'s; ROOT if the two branches share nothing.
  let lca = ROOT;
  for (const n of fromChain) {
    if (toSet.has(n)) {
      lca = n;
      break;
    }
  }
  const revert: number[] = [];
  for (const n of fromChain) {
    if (n === lca) break;
    revert.push(n); // nearest first — undo order
  }
  const apply: number[] = [];
  for (const n of toChain) {
    if (n === lca) break;
    apply.push(n);
  }
  apply.reverse(); // root-ward first — redo order
  return { revert, apply };
}

/** Direct children of `node`, oldest first. */
export const childrenOf = (parents: number[], node: number): number[] =>
  parents.map((p, i) => (p === node ? i : -1)).filter((i) => i >= 0);

/** The child a Redo should follow: the most recently created one, because that
 *  is the branch you were last working on. -1 when the node is a leaf. */
export function newestChild(parents: number[], node: number): number {
  const kids = childrenOf(parents, node);
  return kids.length ? kids[kids.length - 1] : -1;
}

/** Every node NOT on the chain to `keep` — what linear mode discards when a new
 *  entry is pushed from an earlier state. */
export function offPath(parents: number[], keep: number): number[] {
  const on = new Set(ancestry(parents, keep));
  return parents.map((_, i) => i).filter((i) => !on.has(i));
}

/**
 * Remove nodes and renumber what's left. A removed node's children are re-parented
 * to its own parent, so the chain never breaks — dropping the oldest step just
 * means you can't go back past its result any more, which is what the history
 * cap has always meant.
 *
 * Returns the new parent table plus a remap (old index → new index, or -1).
 */
export function removeNodes(
  parents: number[],
  remove: Iterable<number>,
): { parents: number[]; remap: number[] } {
  const gone = new Set<number>();
  for (const r of remove) if (r >= 0 && r < parents.length) gone.add(r);
  const remap: number[] = [];
  let next = 0;
  for (let i = 0; i < parents.length; i++) remap[i] = gone.has(i) ? -1 : next++;

  // Walk each survivor's chain up past any removed ancestors.
  const survivingParent = (i: number): number => {
    let p = parents[i];
    const seen = new Set<number>();
    while (p >= 0 && gone.has(p) && !seen.has(p)) {
      seen.add(p);
      p = parents[p];
    }
    return p >= 0 ? remap[p] : ROOT;
  };
  const out: number[] = [];
  for (let i = 0; i < parents.length; i++) {
    if (!gone.has(i)) out[remap[i]] = survivingParent(i);
  }
  return { parents: out, remap };
}

/**
 * Which entry the history cap should drop next, or -1 when nothing can safely go.
 *
 * Safety is the constraint, not preference: these are DELTAS, so a node may only
 * be dropped if nothing still depends on the state it produced.
 *  1. An abandoned LEAF (no children, not on the way to where you are) — nothing
 *     depends on it at all, so it is always safe and always the least valuable.
 *  2. Otherwise the oldest step, and only when it is the SOLE branch off the
 *     original state — dropping it redefines "the original" as the state after
 *     it, which every remaining delta still chains onto. If a second branch also
 *     hangs off the original, that redefinition would be wrong for the sibling
 *     (its deltas were captured against the real original), so the cap goes soft
 *     rather than silently corrupting a branch.
 *
 * `protect` (the History brush's source state) is never dropped, so the brush
 * can't silently start sampling something else.
 */
export function trimVictim(
  parents: number[],
  current: number,
  protect: number = ROOT,
): number {
  if (!parents.length) return -1;
  const hasChild = new Set(parents.filter((p) => p >= 0));
  const path = new Set(ancestry(parents, current));
  for (let i = 0; i < parents.length; i++) {
    if (i === protect || path.has(i) || hasChild.has(i)) continue;
    return i; // oldest abandoned leaf
  }
  const roots = childrenOf(parents, ROOT);
  if (roots.length === 1 && roots[0] !== protect) return roots[0];
  return -1;
}
