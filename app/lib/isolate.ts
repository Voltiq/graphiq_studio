/**
 * Isolate mode — temporarily solo the selected layers.
 *
 * A VIEW state, not document state. Nothing here writes to the document: the
 * stored `visible` flags are untouched, no history step is pushed, and nothing
 * is saved in the `.gproj`. Isolation is applied by deriving a tree for the
 * canvas to render, so exporting, flattening and everything else that reads the
 * real document keeps seeing the real document. That is the whole design: a
 * viewing aid that cannot damage what you are working on.
 *
 * THE RULE, in full:
 *   - anything outside the isolation is hidden;
 *   - the isolated nodes and their descendants are left exactly as they are, so
 *     an isolated layer's own eye still means what it always meant;
 *   - their ANCESTOR GROUPS are forced visible, because a group is a container
 *     rather than content — isolating a layer inside a collapsed-and-hidden
 *     group and getting a blank canvas would just look broken.
 *
 * Pure and dependency-light so the rule can be tested without a canvas.
 */

import type { LayerNode } from "./layers";

/** What isolating `ids` should leave on screen, and which of those are containers. */
export interface Isolation {
  /** Nodes that survive: the isolated ids, their ancestors and descendants. */
  keep: Set<string>;
  /** Ancestor groups of the isolated ids — forced visible so their contents show. */
  open: Set<string>;
}

/**
 * Resolve the isolation set for `ids` against a tree.
 *
 * Ids that are not in the tree are ignored, so a stale isolation (its layer was
 * deleted) degrades to isolating whatever is left rather than blanking the
 * canvas.
 */
export function resolveIsolation(tree: LayerNode[], ids: readonly string[]): Isolation {
  const want = new Set(ids);
  const keep = new Set<string>();
  const open = new Set<string>();

  const addSubtree = (n: LayerNode) => {
    keep.add(n.id);
    if (n.type === "group") for (const c of n.children) addSubtree(c);
  };

  // `ancestors` is the chain above the node currently being visited.
  const walk = (nodes: LayerNode[], ancestors: string[]): boolean => {
    let hit = false;
    for (const n of nodes) {
      if (want.has(n.id)) {
        addSubtree(n);
        for (const a of ancestors) {
          keep.add(a);
          open.add(a);
        }
        hit = true;
        // Still descend: a selection can contain both a group and something
        // inside it, and the inner one must not be lost.
      }
      if (n.type === "group" && walk(n.children, [...ancestors, n.id])) hit = true;
    }
    return hit;
  };
  walk(tree, []);
  return { keep, open };
}

/**
 * The tree the canvas should render under this isolation.
 *
 * Returns the SAME array when nothing needs changing — the render graph keys off
 * node identity, so handing back a fresh tree every frame would throw away every
 * cached layer for no reason.
 */
export function applyIsolation(tree: LayerNode[], iso: Isolation): LayerNode[] {
  if (!iso.keep.size) return tree; // nothing resolved — isolate nothing rather than everything
  const walk = (nodes: LayerNode[]): LayerNode[] => {
    const out = nodes.map((n) => {
      if (!iso.keep.has(n.id)) return n.visible ? { ...n, visible: false } : n;
      // Inside the isolation. Containers are forced open; content is untouched.
      let next: LayerNode = iso.open.has(n.id) && !n.visible ? { ...n, visible: true } : n;
      if (next.type === "group") {
        const children = walk(next.children);
        if (children !== next.children) next = { ...next, children };
      }
      return next;
    });
    // Identity in, identity out: the render graph keys off node identity, so a
    // branch that did not change must come back as the very same array.
    return out.some((n, i) => n !== nodes[i]) ? out : nodes;
  };
  return walk(tree);
}

/** Drop ids that are no longer in the tree; `null` when nothing is left to solo. */
export function normalizeIsolation(
  tree: LayerNode[],
  ids: readonly string[] | null,
): string[] | null {
  if (!ids?.length) return null;
  const present = new Set<string>();
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      present.add(n.id);
      if (n.type === "group") walk(n.children);
    }
  };
  walk(tree);
  const kept = ids.filter((id) => present.has(id));
  return kept.length ? kept : null;
}

/**
 * How many nodes this isolation is actually taking off screen — nodes outside it
 * that were visible. Layers the user had already hidden are not counted: saying
 * "hiding 7" when four of them were hidden anyway would overstate what isolate
 * is responsible for.
 */
export function hiddenByIsolation(tree: LayerNode[], iso: Isolation): number {
  if (!iso.keep.size) return 0;
  let n = 0;
  const walk = (nodes: LayerNode[]) => {
    for (const node of nodes) {
      if (!iso.keep.has(node.id) && node.visible) n++;
      if (node.type === "group") walk(node.children);
    }
  };
  walk(tree);
  return n;
}
