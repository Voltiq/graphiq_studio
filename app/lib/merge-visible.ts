/**
 * Merge Visible and Stamp Visible.
 *
 * Both composite everything currently on screen into one flat layer. They differ
 * only in what happens to the originals: Merge consumes them, Stamp leaves them
 * alone and adds the result as a new layer on top.
 *
 * THE RULE THAT MATTERS: nothing hidden is ever destroyed. Photoshop's Merge
 * Visible will eat a hidden layer that happens to live inside a visible group;
 * this one will not. A visible group containing hidden children survives as a
 * group holding exactly those children, and only its visible content is merged
 * out of it. Losing work you had merely switched off — and could not see go — is
 * not a trade worth making for a tidier tree.
 *
 * The merged layer takes the position of the bottom-most node that had visible
 * content, which is where Photoshop puts it too. Everything left in the tree is
 * hidden by definition, so that choice is invisible today; it decides what sits
 * above what when someone switches a hidden layer back on.
 *
 * Pure: builds the new tree and reports which engine leaves to free. The caller
 * does the compositing and owns the history step.
 */

import { collectLeafIds, type LayerNode } from "./layers";

/** Is any of this node actually on screen? A visible group whose children are
 *  all hidden contributes nothing, and must not anchor the merged layer. */
export function hasVisibleContent(n: LayerNode): boolean {
  if (!n.visible) return false;
  if (n.type !== "group") return true;
  return n.children.some(hasVisibleContent);
}

/** Every visible leaf in the tree — what the merged pixels will be made of. */
export function visibleLeafIds(nodes: LayerNode[]): string[] {
  const out: string[] = [];
  const walk = (list: LayerNode[]) => {
    for (const n of list) {
      if (!n.visible) continue;
      if (n.type === "group") walk(n.children);
      else if (n.type === "layer") out.push(n.id);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Strip the visible content out of a node.
 *
 * `null` means the node is entirely visible and is consumed by the merge. A
 * hidden node comes back untouched — it contributed nothing, so it loses
 * nothing. A visible group comes back holding whatever its children kept.
 */
function prune(n: LayerNode, consumed: LayerNode[]): LayerNode | null {
  if (!n.visible) return n;
  if (n.type !== "group") {
    consumed.push(n);
    return null;
  }
  const kept: LayerNode[] = [];
  for (const c of n.children) {
    const p = prune(c, consumed);
    if (p) kept.push(p);
  }
  if (!kept.length) return null; // nothing hidden inside — the group goes too
  return { ...n, children: kept };
}

export interface MergePlan {
  /** The tree after the merge, with the flat layer in place. */
  tree: LayerNode[];
  /** Engine leaf ids whose pixels are no longer referenced. */
  freeIds: string[];
  /** Name the merged layer should take (the bottom-most visible node's). */
  name: string;
}

/**
 * Would Merge Visible actually change anything?
 *
 * True only when the whole visible document is already one plain top-level
 * layer — no group around it, no mask, no effects, no filters, nothing to bake.
 * Anything else (two layers, a group, a layer with a drop shadow) is a real
 * operation even if it does not look like one.
 */
export function mergeVisibleIsNoop(nodes: LayerNode[]): boolean {
  const visible = nodes.filter(hasVisibleContent);
  if (visible.length !== 1) return visible.length === 0;
  const only = visible[0];
  return (
    only.type === "layer" &&
    !only.mask &&
    !only.vectorMask &&
    !only.effects &&
    !only.filters?.length &&
    !only.fill &&
    only.opacity === 100 &&
    only.blend === "Normal" &&
    !only.clipped
  );
}

/** Build the post-merge tree. `mergedId` is the new layer's id. */
export function mergeVisiblePlan(nodes: LayerNode[], mergedId: string): MergePlan {
  // Bottom-most node with visible content: the merged layer's slot, and the
  // name it inherits (both matching Merge Down and Photoshop).
  let anchor = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (hasVisibleContent(nodes[i])) {
      anchor = i;
      break;
    }
  }
  const consumed: LayerNode[] = [];
  const merged: LayerNode = {
    id: mergedId,
    type: "layer",
    name: anchor >= 0 ? nodes[anchor].name : "Merged",
    visible: true,
    opacity: 100,
    blend: "Normal",
  };

  const tree: LayerNode[] = [];
  nodes.forEach((n, i) => {
    const kept = hasVisibleContent(n) ? prune(n, consumed) : n;
    if (kept) tree.push(kept);
    // The merged layer goes just BELOW whatever survived of the anchor, so it
    // ends up exactly where the bottom-most visible content used to be.
    if (i === anchor) tree.push(merged);
  });
  if (anchor < 0) tree.push(merged); // nothing visible — caller guards this

  return { tree, freeIds: collectLeafIds(consumed), name: merged.name };
}

/**
 * Where Stamp Visible puts its result: directly above the active layer when
 * that layer is top-level, otherwise at the very top.
 *
 * Photoshop inserts above the current layer, and following that keeps the new
 * layer where you are already looking. Falling back to the top for a layer
 * nested in a group is deliberate — a flattened copy of the WHOLE document
 * dropped inside one group would be clipped by that group's mask and blend, so
 * it would not look like what it is a copy of.
 */
export function stampInsertIndex(nodes: LayerNode[], activeId: string | null): number {
  const at = nodes.findIndex((n) => n.id === activeId);
  return at >= 0 ? at : 0;
}

export function stampVisiblePlan(
  nodes: LayerNode[],
  stampId: string,
  activeId: string | null,
  name = "Stamp Visible",
): LayerNode[] {
  const stamp: LayerNode = {
    id: stampId,
    type: "layer",
    name,
    visible: true,
    opacity: 100,
    blend: "Normal",
  };
  const at = stampInsertIndex(nodes, activeId);
  return [...nodes.slice(0, at), stamp, ...nodes.slice(at)];
}
