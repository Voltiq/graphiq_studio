/**
 * Direct selection — editing a path's anchors after it has been committed.
 *
 * The Pen tool can already drag the anchors of the path it is currently
 * building. What it cannot do is come back to a path in the Paths panel and
 * change it: add a point in the middle of a curve, pull two points at once,
 * turn a corner into a smooth bend. That is what this is for, and it is a
 * separate tool for the same reason Illustrator separates them — the pen's
 * click means "add a point at the end", and direct selection's means "grab the
 * thing under the cursor", which cannot both be the primary action.
 *
 * The geometry that matters:
 *
 *   INSERTING A POINT MUST NOT CHANGE THE CURVE. Splitting a cubic at t with de
 *   Casteljau gives two cubics whose union is the original, exactly — the six
 *   new control points are all convex combinations of the old four. Placing an
 *   anchor on the curve and retracting its handles would be far simpler and
 *   would visibly deform the shape at the click, which is the one thing a user
 *   adding a point does not want.
 *
 *   SMOOTH MEANS COLLINEAR. A smooth anchor's two handles lie opposite each
 *   other through the point, so the curve has no kink there. Dragging one
 *   handle of a smooth anchor swings the other to match; dragging one on a
 *   corner leaves the other alone.
 *
 * Pure and DOM-free: everything here is anchor arrays in, anchor arrays out.
 */

import type { PenAnchor } from "./tools";

export interface Pt {
  x: number;
  y: number;
}

export interface EditRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What sits under the cursor. `t` is the position along a segment, 0–1. */
export type PathHit =
  | { kind: "anchor"; index: number }
  | { kind: "in"; index: number }
  | { kind: "out"; index: number }
  | { kind: "segment"; index: number; t: number; x: number; y: number };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/** Does the segment starting at `i` exist? (The last one only if closed.) */
export const hasSegment = (n: number, closed: boolean, i: number): boolean =>
  n >= 2 && (i < n - 1 || (closed && i === n - 1));

/** The four control points of the cubic leaving anchor `i`. */
export function segmentPoints(
  a: PenAnchor[],
  closed: boolean,
  i: number,
): [Pt, Pt, Pt, Pt] | null {
  const n = a.length;
  if (!hasSegment(n, closed, i)) return null;
  const j = (i + 1) % n;
  return [
    { x: a[i].x, y: a[i].y },
    { x: a[i].ox, y: a[i].oy },
    { x: a[j].ix, y: a[j].iy },
    { x: a[j].x, y: a[j].y },
  ];
}

export function cubicAt(p: [Pt, Pt, Pt, Pt], t: number): Pt {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p[0].x + w1 * p[1].x + w2 * p[2].x + w3 * p[3].x,
    y: w0 * p[0].y + w1 * p[1].y + w2 * p[2].y + w3 * p[3].y,
  };
}

/**
 * What the cursor is over.
 *
 * Handles beat anchors and anchors beat segments, because a handle sitting on
 * top of its own anchor (a corner) must still be grabbable, and an anchor is
 * always on its own segments.
 */
export function hitTest(
  a: PenAnchor[],
  closed: boolean,
  p: Pt,
  tol: number,
  /** Handles are only shown — and so only hittable — for selected anchors. */
  handlesFor: ReadonlySet<number> | null = null,
): PathHit | null {
  const n = a.length;
  for (let i = 0; i < n; i++) {
    if (handlesFor && !handlesFor.has(i)) continue;
    if (dist(p.x, p.y, a[i].ox, a[i].oy) <= tol && (a[i].ox !== a[i].x || a[i].oy !== a[i].y))
      return { kind: "out", index: i };
    if (dist(p.x, p.y, a[i].ix, a[i].iy) <= tol && (a[i].ix !== a[i].x || a[i].iy !== a[i].y))
      return { kind: "in", index: i };
  }
  for (let i = 0; i < n; i++) if (dist(p.x, p.y, a[i].x, a[i].y) <= tol) return { kind: "anchor", index: i };
  return nearestOnPath(a, closed, p, tol);
}

/** The closest point ON the path within `tol`, or null. */
export function nearestOnPath(
  a: PenAnchor[],
  closed: boolean,
  p: Pt,
  tol: number,
  steps = 24,
): { kind: "segment"; index: number; t: number; x: number; y: number } | null {
  let best: { index: number; t: number; d: number; x: number; y: number } | null = null;
  for (let i = 0; i < a.length; i++) {
    const seg = segmentPoints(a, closed, i);
    if (!seg) continue;
    // Coarse sweep then a local refine: enough for a pointer tolerance, and far
    // cheaper than solving the quintic that exact projection needs.
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const q = cubicAt(seg, t);
      const d = dist(p.x, p.y, q.x, q.y);
      if (!best || d < best.d) best = { index: i, t, d, x: q.x, y: q.y };
    }
  }
  if (!best) return null;
  const seg = segmentPoints(a, closed, best.index)!;
  let lo = Math.max(0, best.t - 1 / steps);
  let hi = Math.min(1, best.t + 1 / steps);
  for (let iter = 0; iter < 24; iter++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const q1 = cubicAt(seg, m1);
    const q2 = cubicAt(seg, m2);
    if (dist(p.x, p.y, q1.x, q1.y) < dist(p.x, p.y, q2.x, q2.y)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const q = cubicAt(seg, t);
  const d = dist(p.x, p.y, q.x, q.y);
  return d <= tol ? { kind: "segment", index: best.index, t, x: q.x, y: q.y } : null;
}

/**
 * Insert an anchor partway along a segment, leaving the curve unchanged.
 *
 * De Casteljau: the split point and the four surrounding control points are all
 * convex combinations of the original four, so the two halves trace exactly the
 * curve the one segment did.
 */
export function insertAnchor(
  a: PenAnchor[],
  closed: boolean,
  index: number,
  t: number,
): PenAnchor[] {
  const seg = segmentPoints(a, closed, index);
  if (!seg || t <= 0 || t >= 1) return a;
  const [p0, p1, p2, p3] = seg;
  const q0 = { x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) };
  const q1 = { x: lerp(p1.x, p2.x, t), y: lerp(p1.y, p2.y, t) };
  const q2 = { x: lerp(p2.x, p3.x, t), y: lerp(p2.y, p3.y, t) };
  const r0 = { x: lerp(q0.x, q1.x, t), y: lerp(q0.y, q1.y, t) };
  const r1 = { x: lerp(q1.x, q2.x, t), y: lerp(q1.y, q2.y, t) };
  const s = { x: lerp(r0.x, r1.x, t), y: lerp(r0.y, r1.y, t) };

  const out = a.map((an) => ({ ...an }));
  const j = (index + 1) % a.length;
  out[index] = { ...out[index], ox: q0.x, oy: q0.y };
  out[j] = { ...out[j], ix: q2.x, iy: q2.y };
  const fresh: PenAnchor = { x: s.x, y: s.y, ix: r0.x, iy: r0.y, ox: r1.x, oy: r1.y };
  out.splice(index + 1, 0, fresh);
  return out;
}

/**
 * Remove anchors. An open path can drop to nothing; a path that would be left
 * with a single point is not a path, so the last two are kept.
 */
export function deleteAnchors(a: PenAnchor[], indices: ReadonlySet<number>): PenAnchor[] {
  const kept = a.filter((_, i) => !indices.has(i));
  return kept.length >= 2 ? kept : a;
}

/** Move whole anchors — the point AND its handles, so the shape rides along. */
export function moveAnchors(
  a: PenAnchor[],
  indices: ReadonlySet<number>,
  dx: number,
  dy: number,
): PenAnchor[] {
  if (!indices.size || (dx === 0 && dy === 0)) return a;
  return a.map((an, i) =>
    indices.has(i)
      ? { x: an.x + dx, y: an.y + dy, ix: an.ix + dx, iy: an.iy + dy, ox: an.ox + dx, oy: an.oy + dy }
      : an,
  );
}

/** A handle is retracted when it sits on its own anchor. */
export const isRetracted = (an: PenAnchor, which: "in" | "out"): boolean =>
  which === "in" ? an.ix === an.x && an.iy === an.y : an.ox === an.x && an.oy === an.y;

/** Collinear, opposite handles with neither retracted — no kink at the point. */
export function isSmooth(an: PenAnchor, eps = 0.5): boolean {
  if (isRetracted(an, "in") || isRetracted(an, "out")) return false;
  const ax = an.ix - an.x;
  const ay = an.iy - an.y;
  const bx = an.ox - an.x;
  const by = an.oy - an.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < eps || lb < eps) return false;
  // Opposite directions: the unit vectors must sum to roughly zero.
  return Math.hypot(ax / la + bx / lb, ay / la + by / lb) < 0.02;
}

/**
 * Corner ⇄ smooth.
 *
 * Smoothing aims the handles along the line between the neighbouring anchors —
 * the direction the curve is already travelling — and gives each a third of the
 * distance to its neighbour, which is the length that makes a circular-ish bend
 * rather than a bulge.
 */
export function toggleSmooth(a: PenAnchor[], closed: boolean, index: number): PenAnchor[] {
  const n = a.length;
  if (index < 0 || index >= n) return a;
  const out = a.map((an) => ({ ...an }));
  const an = out[index];
  if (isSmooth(an)) {
    out[index] = { ...an, ix: an.x, iy: an.y, ox: an.x, oy: an.y };
    return out;
  }
  const prev = index > 0 ? out[index - 1] : closed ? out[n - 1] : null;
  const next = index < n - 1 ? out[index + 1] : closed ? out[0] : null;
  // With only one neighbour the tangent is the line to it; with none there is
  // no direction to smooth along and the anchor is left as a corner.
  const from = prev ?? an;
  const to = next ?? an;
  let tx = to.x - from.x;
  let ty = to.y - from.y;
  const len = Math.hypot(tx, ty);
  if (len < 1e-6) return out;
  tx /= len;
  ty /= len;
  const dIn = prev ? dist(an.x, an.y, prev.x, prev.y) / 3 : len / 3;
  const dOut = next ? dist(an.x, an.y, next.x, next.y) / 3 : len / 3;
  out[index] = {
    ...an,
    ix: an.x - tx * dIn,
    iy: an.y - ty * dIn,
    ox: an.x + tx * dOut,
    oy: an.y + ty * dOut,
  };
  return out;
}

/**
 * Drag one handle. On a smooth anchor the opposite handle swings to stay
 * collinear, keeping its own length — which is what "smooth" has to mean if
 * dragging one side is not to silently resize the other.
 */
export function dragHandle(
  a: PenAnchor[],
  index: number,
  which: "in" | "out",
  to: Pt,
  /** Break the symmetry for this drag (Alt), turning the anchor into a corner. */
  breakSmooth = false,
): PenAnchor[] {
  const n = a.length;
  if (index < 0 || index >= n) return a;
  const out = a.map((an) => ({ ...an }));
  const an = out[index];
  const smooth = !breakSmooth && isSmooth(an);
  const next: PenAnchor = { ...an };
  if (which === "in") {
    next.ix = to.x;
    next.iy = to.y;
  } else {
    next.ox = to.x;
    next.oy = to.y;
  }
  if (smooth) {
    const dx = to.x - an.x;
    const dy = to.y - an.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      const other = which === "in" ? { x: an.ox - an.x, y: an.oy - an.y } : { x: an.ix - an.x, y: an.iy - an.y };
      const olen = Math.hypot(other.x, other.y);
      const ux = -dx / len;
      const uy = -dy / len;
      if (which === "in") {
        next.ox = an.x + ux * olen;
        next.oy = an.y + uy * olen;
      } else {
        next.ix = an.x + ux * olen;
        next.iy = an.y + uy * olen;
      }
    }
  }
  out[index] = next;
  return out;
}

/** Anchor indices inside a marquee (points only — handles are not selectable). */
export function anchorsInRect(a: PenAnchor[], r: EditRect): number[] {
  const x0 = Math.min(r.x, r.x + r.w);
  const x1 = Math.max(r.x, r.x + r.w);
  const y0 = Math.min(r.y, r.y + r.h);
  const y1 = Math.max(r.y, r.y + r.h);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++)
    if (a[i].x >= x0 && a[i].x <= x1 && a[i].y >= y0 && a[i].y <= y1) out.push(i);
  return out;
}

/** Bounding box of the anchor POINTS (not the handles). */
export function anchorBounds(a: PenAnchor[]): EditRect | null {
  if (!a.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const an of a) {
    if (an.x < x0) x0 = an.x;
    if (an.y < y0) y0 = an.y;
    if (an.x > x1) x1 = an.x;
    if (an.y > y1) y1 = an.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
