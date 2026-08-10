// Guides (TODO §11) — the pure geometry behind draggable guides, snap-to-guide
// and smart guides. Everything here is DOM-free and Node-testable: hit-testing,
// candidate building, and the one snap solver that every caller shares.
//
// A guide is one infinite line across the document: "v" sits at a document X,
// "h" at a document Y. That's the whole model — no ids, because guides are
// only ever addressed by index inside one document's array, and the array is
// never reordered while a drag is in flight.

import type { Rect } from "./view";

export type GuideAxis = "v" | "h";

export interface Guide {
  axis: GuideAxis;
  /** Document X for "v", document Y for "h". */
  pos: number;
}

/** Where a snap candidate came from — drives how the hint line is drawn. */
export type SnapKind = "guide" | "canvas" | "layer";

export interface SnapTarget {
  pos: number;
  kind: SnapKind;
  /** Perpendicular extent of the source object (doc px). Smart-guide hints span
   *  only from the matched layer to the moving one; guides/canvas edges have no
   *  span and are drawn across the whole document. */
  span?: [number, number];
}

export interface SnapHit extends SnapTarget {
  /** The moving edge that landed on it (post-snap, so hit.pos === edge). */
  edge: number;
}

export interface SnapAxisResult {
  /** Amount to ADD to the moving object's position to land on the target. */
  delta: number;
  hits: SnapHit[];
}

/** The three interesting lines of a box on one axis: start, centre, end. */
export function boxEdges(b: Rect, axis: GuideAxis): number[] {
  return axis === "v" ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h];
}

/** Guides of one orientation as snap candidates. */
export function guideTargets(guides: Guide[], axis: GuideAxis): SnapTarget[] {
  return guides.filter((g) => g.axis === axis).map((g) => ({ pos: g.pos, kind: "guide" as const }));
}

/** The document's own edges and centre line. */
export function canvasTargets(size: number): SnapTarget[] {
  return [
    { pos: 0, kind: "canvas" as const },
    { pos: size / 2, kind: "canvas" as const },
    { pos: size, kind: "canvas" as const },
  ];
}

/** Smart-guide candidates: every other layer's edges + centre, carrying the
 *  layer's perpendicular extent so the hint can be drawn between the two boxes. */
export function layerTargets(boxes: Rect[], axis: GuideAxis): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (const b of boxes) {
    const span: [number, number] = axis === "v" ? [b.y, b.y + b.h] : [b.x, b.x + b.w];
    for (const pos of boxEdges(b, axis)) out.push({ pos, kind: "layer", span });
  }
  return out;
}

/**
 * Solve one axis: find the smallest movement that puts ANY moving edge onto ANY
 * candidate, within `tol`. Returns null when nothing is close enough.
 *
 * Every edge/target pair that shares the winning delta is reported as a hit, so
 * three boxes lined up on the same X all light up rather than just the nearest.
 */
export function snapAxis(edges: number[], targets: SnapTarget[], tol: number): SnapAxisResult | null {
  if (!(tol > 0)) return null;
  let delta: number | null = null;
  let best = Infinity;
  for (const e of edges) {
    for (const t of targets) {
      const d = t.pos - e;
      const a = Math.abs(d);
      // Strictly-better wins, so an exact tie keeps the first (leading) edge —
      // which reads as "the edge you were already closest to" during a drag.
      if (a <= tol && a < best - 1e-9) {
        best = a;
        delta = d;
      }
    }
  }
  if (delta === null) return null;
  const hits: SnapHit[] = [];
  for (const e of edges) {
    for (const t of targets) {
      if (Math.abs(t.pos - e - delta) < 1e-6) hits.push({ ...t, edge: e + delta });
    }
  }
  return { delta, hits };
}

export interface MoveSnap {
  dx: number;
  dy: number;
  hitsV: SnapHit[];
  hitsH: SnapHit[];
}

/**
 * Snap a box being dragged by (dx, dy). The axes are solved independently — the
 * left edge can land on a guide while the vertical stays free, which is what
 * makes dragging along a guide feel right.
 */
export function snapMove(
  box: Rect,
  dx: number,
  dy: number,
  targetsV: SnapTarget[],
  targetsH: SnapTarget[],
  tol: number,
): MoveSnap {
  const moved: Rect = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const v = snapAxis(boxEdges(moved, "v"), targetsV, tol);
  const h = snapAxis(boxEdges(moved, "h"), targetsH, tol);
  return {
    dx: dx + (v?.delta ?? 0),
    dy: dy + (h?.delta ?? 0),
    hitsV: v?.hits ?? [],
    hitsH: h?.hits ?? [],
  };
}

/**
 * Snap a single dragged point (a marquee corner, a crop handle) on both axes.
 * Same solver, one edge per axis.
 */
export function snapPointTo(
  x: number,
  y: number,
  targetsV: SnapTarget[],
  targetsH: SnapTarget[],
  tol: number,
): { x: number; y: number; hitsV: SnapHit[]; hitsH: SnapHit[] } {
  const v = snapAxis([x], targetsV, tol);
  const h = snapAxis([y], targetsH, tol);
  return {
    x: x + (v?.delta ?? 0),
    y: y + (h?.delta ?? 0),
    hitsV: v?.hits ?? [],
    hitsH: h?.hits ?? [],
  };
}

/**
 * Index of the guide under a document-space point, or -1. Vertical guides are
 * measured against x, horizontal against y; the nearest wins so two guides
 * sitting nearly on top of each other still resolve to one.
 */
export function hitGuide(guides: Guide[], x: number, y: number, tol: number): number {
  let idx = -1;
  let best = Infinity;
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    const d = Math.abs((g.axis === "v" ? x : y) - g.pos);
    // Later guides win ties: they're drawn last, so that's the one you clicked.
    if (d <= tol && d <= best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

/** Drop duplicate candidates (same kind + position) so hint lines aren't doubled. */
export function dedupeTargets(targets: SnapTarget[]): SnapTarget[] {
  const seen = new Map<string, SnapTarget>();
  for (const t of targets) {
    const key = `${t.kind}:${Math.round(t.pos * 100)}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, t);
    else if (t.span && prev.span) {
      // Same line from two layers → widen the span so the hint covers both.
      prev.span = [Math.min(prev.span[0], t.span[0]), Math.max(prev.span[1], t.span[1])];
    }
  }
  return [...seen.values()];
}

/** Round to whole document pixels and clamp inside the document. */
export const clampGuide = (pos: number, size: number): number =>
  Math.max(0, Math.min(size, Math.round(pos)));

/** True when a guide dropped here should be discarded (dragged off the canvas). */
export function shouldDiscard(pos: number, size: number, marginDoc: number): boolean {
  return pos < -marginDoc || pos > size + marginDoc;
}

/** Validate + normalize guides read from a project file (tolerates junk). */
export function sanitizeGuides(raw: unknown, docW: number, docH: number): Guide[] {
  if (!Array.isArray(raw)) return [];
  const out: Guide[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const axis = (g as Guide).axis;
    const pos = (g as Guide).pos;
    if ((axis !== "v" && axis !== "h") || typeof pos !== "number" || !Number.isFinite(pos)) continue;
    const size = axis === "v" ? docW : docH;
    if (pos < 0 || pos > size) continue;
    out.push({ axis, pos });
  }
  return out;
}
