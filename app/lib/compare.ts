// Before/after compare (TODO §11) — the pure half.
//
// "Before" here means the document WITHOUT its non-destructive colour work:
// adjustment layers off and smart filters bypassed. That is the comparison
// that actually answers "is my grade an improvement?", and it costs nothing
// extra to produce — the engine can already composite an arbitrary tree
// (`exportComposite`), so the before image is just the same tree with those
// nodes turned off, rendered through the same render graph and its caches.
//
// Layer effects (drop shadow, glow, stroke) are deliberately KEPT: they are
// styling that belongs to the artwork, not colour grading, and hiding them
// would make the "before" a different picture rather than an earlier one.

import type { LayerNode } from "./layers";

/** Which way the split view divides the canvas. */
export type CompareAxis = "vertical" | "horizontal";

/**
 * The same tree with every adjustment layer hidden and every smart-filter
 * stack removed. Nodes are only cloned where something actually changes, so an
 * unaffected subtree keeps its identity and the render cache keeps its hits.
 */
export function bypassAdjustments(tree: LayerNode[]): LayerNode[] {
  let changed = false;
  const out = tree.map((n): LayerNode => {
    if (n.type === "adjustment") {
      if (!n.visible) return n;
      changed = true;
      return { ...n, visible: false };
    }
    const hasFilters = !!n.filters?.length;
    if (n.type === "group") {
      const kids = bypassAdjustments(n.children);
      if (kids === n.children && !hasFilters) return n;
      changed = true;
      const next = { ...n, children: kids };
      if (hasFilters) delete next.filters;
      return next;
    }
    if (!hasFilters) return n;
    changed = true;
    const next = { ...n };
    delete next.filters;
    return next;
  });
  return changed ? out : tree;
}

/** Is there any non-destructive colour work to compare against? When there
 *  isn't, before and after are the same picture and the UI should say so
 *  rather than showing an invisible split. */
export function hasAdjustments(tree: LayerNode[]): boolean {
  for (const n of tree) {
    if (n.type === "adjustment" && n.visible) return true;
    if (n.filters?.length) return true;
    if (n.type === "group" && hasAdjustments(n.children)) return true;
  }
  return false;
}

/** Keep the divider on the canvas, and off the very edges where it would be
 *  ungrabbable and the comparison pointless. */
export const clampSplit = (pct: number): number =>
  Number.isFinite(pct) ? Math.max(2, Math.min(98, pct)) : 50;

/**
 * `clip-path` that reveals only the BEFORE side — the left half for a vertical
 * split, the top half for a horizontal one. `peek` reveals the whole thing,
 * which is what holding the peek key does.
 */
export function compareClip(pct: number, axis: CompareAxis, peek = false): string {
  if (peek) return "inset(0 0 0 0)";
  const p = clampSplit(pct);
  return axis === "vertical" ? `inset(0 ${100 - p}% 0 0)` : `inset(0 0 ${100 - p}% 0)`;
}

/** Divider position in viewport px, given the artwork's on-screen box. */
export function dividerPos(
  pct: number,
  axis: CompareAxis,
  box: { left: number; top: number; width: number; height: number },
): number {
  const p = clampSplit(pct) / 100;
  return axis === "vertical" ? box.left + box.width * p : box.top + box.height * p;
}

/** Turn a pointer position back into a split percentage. */
export function splitFromPointer(
  clientX: number,
  clientY: number,
  axis: CompareAxis,
  box: { left: number; top: number; width: number; height: number },
): number {
  const span = axis === "vertical" ? box.width : box.height;
  if (!(span > 0)) return 50;
  const along = axis === "vertical" ? clientX - box.left : clientY - box.top;
  return clampSplit((along / span) * 100);
}
