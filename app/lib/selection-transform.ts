/**
 * Transform a selection by numbers — the x / y / w / h / angle fields in the
 * options bar.
 *
 * A selection is a LIST of rectangles, and that is what makes this less trivial
 * than scaling one box. Scaling each rectangle independently and rounding its
 * position and size separately tears the selection apart: two rectangles that
 * abut exactly can round to a one-pixel gap or a one-pixel overlap, which shows
 * up as hairline seams through a filled selection and as double-darkened rows
 * where the overlap composites twice.
 *
 * The fix is to round EDGES, never sizes. Both rectangles compute their shared
 * boundary from the same source coordinate through the same function, so they
 * land on the same integer by construction and the seam cannot appear.
 *
 * Pure and dependency-free — Node-testable.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The axis-aligned bounding box of a rect list (null when empty). */
export function boxOf(rects: Rect[]): SelBox | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Map `rects` so their bounding box goes from `from` to `to`.
 *
 * Rectangles that collapse below one pixel after scaling are dropped rather
 * than clamped to width 1 — clamping would make a heavily shrunk selection grow
 * a fringe of stray single-pixel columns that were never part of it.
 */
export function transformRects(rects: Rect[], from: SelBox, to: SelBox): Rect[] {
  if (!rects.length) return [];
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  // Edge mapping, shared by both sides of every boundary.
  const mapX = (v: number) => Math.round(to.x + (v - from.x) * sx);
  const mapY = (v: number) => Math.round(to.y + (v - from.y) * sy);
  const out: Rect[] = [];
  for (const r of rects) {
    const x0 = mapX(r.x);
    const x1 = mapX(r.x + r.w);
    const y0 = mapY(r.y);
    const y1 = mapY(r.y + r.h);
    if (x1 <= x0 || y1 <= y0) continue; // collapsed away entirely
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/** Clamp a requested box to something usable: at least 1×1, finite, integral. */
export function sanitizeBox(b: SelBox): SelBox {
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? Math.round(v) : fallback);
  return {
    x: num(b.x, 0),
    y: num(b.y, 0),
    w: Math.max(1, num(b.w, 1)),
    h: Math.max(1, num(b.h, 1)),
  };
}

/**
 * The pivot a numeric rotation turns about: the bounding box centre.
 *
 * Not the document centre and not the first rect's corner — the centre is the
 * only choice where typing an angle leaves the selection where the user can
 * still see it, and it matches what the on-canvas rotate handle already uses.
 */
export function pivotOf(box: SelBox): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}
