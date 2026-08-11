// Straighten gaps (TODO §2 Crop) — pure geometry, no pixels.
//
// Straightening rotates the document inside the crop box, so unless the box sits
// well inside the image the output corners fall OUTSIDE the source and come out
// transparent. This works out exactly where those wedges are, so the engine can
// fill them with synthesized content instead of leaving holes.
//
// Everything is in OUTPUT space (the cropped canvas, origin at its top-left).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * The source document's four corners mapped into the cropped output.
 *
 * Mirrors the engine's own draw transform exactly — translate to the output
 * centre, rotate by −angle, translate back by the crop centre — because if the
 * two ever disagreed the gaps would be computed for a picture that wasn't drawn.
 */
export function sourceQuad(docW: number, docH: number, rect: Rect, angleDeg: number): Pt[] {
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const map = (sx: number, sy: number): Pt => ({
    x: rect.w / 2 + (sx - cx) * cos - (sy - cy) * sin,
    y: rect.h / 2 + (sx - cx) * sin + (sy - cy) * cos,
  });
  return [map(0, 0), map(docW, 0), map(docW, docH), map(0, docH)];
}

/** Horizontal span of a convex polygon at scanline centre `y` (null = no cover). */
function spanAt(poly: Pt[], y: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // Half-open on y so a vertex shared by two edges is counted once.
    if (a.y === b.y) continue;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (y < y0 || y >= y1) continue;
    const t = (y - a.y) / (b.y - a.y);
    const x = a.x + (b.x - a.x) * t;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi >= lo ? [lo, hi] : null;
}

/**
 * The parts of the `outW × outH` output NOT covered by `poly`, as one or two
 * run-length rects per scanline (the same shape the selection model uses).
 *
 * Scanlines are sampled at their CENTRE (y + 0.5), and a pixel counts as covered
 * only when its WHOLE cell [x, x+1] falls inside the span. A pixel the rotation
 * covers partially is left semi-transparent, and calling that "covered" would
 * leave a feathered rim of the old edge around the filled area — so those go in
 * the gap and get repainted. An exactly-aligned edge (span [0, w]) still yields
 * no gap, because whole cells fit exactly.
 */
export function gapRects(outW: number, outH: number, poly: Pt[]): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < outH; y++) {
    const span = spanAt(poly, y + 0.5);
    if (!span) {
      out.push({ x: 0, y, w: outW, h: 1 }); // this row misses the source entirely
      continue;
    }
    const lo = Math.ceil(span[0]); // first x with x >= span start
    const hi = Math.floor(span[1]) - 1; // last x with x + 1 <= span end
    if (hi < lo) {
      out.push({ x: 0, y, w: outW, h: 1 });
      continue;
    }
    if (lo > 0) out.push({ x: 0, y, w: Math.min(lo, outW), h: 1 });
    if (hi < outW - 1) out.push({ x: hi + 1, y, w: outW - hi - 1, h: 1 });
  }
  return out.filter((r) => r.w > 0);
}

/**
 * Split gap rects into disjoint clusters — in practice the (up to four) corner
 * wedges.
 *
 * Worth doing rather than healing one bounding box: with wedges in all four
 * corners that box IS the whole canvas, and the synthesis would run over every
 * pixel of the image to repair a few thousand at the edges.
 */
export function groupGaps(rects: Rect[]): Rect[][] {
  const groups: { rects: Rect[]; lastY: number; x0: number; x1: number }[] = [];
  const open: typeof groups = [];
  for (const r of rects) {
    // A cluster continues if it reached the previous row and overlaps in x.
    let hit = open.find((g) => g.lastY === r.y - 1 && r.x <= g.x1 && r.x + r.w >= g.x0);
    if (!hit) {
      hit = { rects: [], lastY: r.y, x0: r.x, x1: r.x + r.w };
      open.push(hit);
      groups.push(hit);
    }
    hit.rects.push(r);
    hit.lastY = r.y;
    hit.x0 = Math.min(hit.x0, r.x);
    hit.x1 = Math.max(hit.x1, r.x + r.w);
  }
  return groups.map((g) => g.rects).filter((g) => g.length > 0);
}

/**
 * Grow a coverage mask by `r` pixels (255 = hole).
 *
 * The rotated draw leaves a ~1px anti-aliased rim just inside the covered area:
 * those pixels are real, but their colour is a blend with the transparency
 * outside, and the fill's synthesis has no alpha channel — so sampling them as
 * source drags the repaired corner darker than its surroundings (measured at
 * ~0.88× before this). Dilating puts the rim inside the hole, where it gets
 * repainted instead of copied. Only pixels already adjacent to a gap are
 * affected, so a layer's own transparency is never mistaken for one.
 */
export function dilateCoverage(cov: Uint8ClampedArray, w: number, h: number, r: number): void {
  for (let pass = 0; pass < r; pass++) {
    const prev = cov.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (prev[i]) continue;
        if (
          (x > 0 && prev[i - 1]) ||
          (x < w - 1 && prev[i + 1]) ||
          (y > 0 && prev[i - w]) ||
          (y < h - 1 && prev[i + w])
        )
          cov[i] = 255;
      }
    }
  }
}

/**
 * Extend the surrounding colour into the hole before the content-aware pass.
 *
 * Necessary because the heal library is built for a blemish — a hole enclosed by
 * real pixels on every side. A straighten wedge is open along two canvas edges,
 * and measurement showed its synthesis reaches inward from the boundary but
 * leaves the deep interior alone: the alpha is forced opaque while the RGB stays
 * at the hole's original transparent BLACK, so a large angle produced a dark
 * corner (and a smaller one a ~0.88× darkened blend of black with real colour).
 *
 * This walks colour inward one ring at a time — each unknown pixel touching
 * known ones takes their average — so every hole pixel starts from a plausible
 * local colour and the heal that follows only has to add texture. Cheap
 * (O(passes × area), no search) and it cannot fail: the loop stops when nothing
 * more can be reached.
 */
export function seedFromEdges(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cov: Uint8ClampedArray,
): void {
  const unknown = Uint8Array.from(cov, (v) => (v > 0 ? 1 : 0));
  let remaining = unknown.reduce((n, v) => n + v, 0);
  while (remaining > 0) {
    const filledNow: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!unknown[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        const take = (j: number) => {
          if (unknown[j]) return;
          r += data[j * 4];
          g += data[j * 4 + 1];
          b += data[j * 4 + 2];
          a += data[j * 4 + 3];
          n++;
        };
        if (x > 0) take(i - 1);
        if (x < w - 1) take(i + 1);
        if (y > 0) take(i - w);
        if (y < h - 1) take(i + w);
        if (!n) continue;
        data[i * 4] = r / n;
        data[i * 4 + 1] = g / n;
        data[i * 4 + 2] = b / n;
        data[i * 4 + 3] = a / n;
        filledNow.push(i);
      }
    }
    if (!filledNow.length) break; // nothing borders a known pixel — give up
    for (const i of filledNow) unknown[i] = 0;
    remaining -= filledNow.length;
  }
}

/** Bounding box of a rect list (null when empty). */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Total gap area in px — used to skip the fill when there is nothing to fill. */
export const gapArea = (rects: Rect[]): number => rects.reduce((n, r) => n + r.w * r.h, 0);

/** Would this crop leave uncovered corners? Cheap pre-check for the UI. */
export function cropLeavesGaps(docW: number, docH: number, rect: Rect, angleDeg: number): boolean {
  if (!angleDeg) return rect.x < 0 || rect.y < 0 || rect.x + rect.w > docW || rect.y + rect.h > docH;
  return gapArea(gapRects(Math.round(rect.w), Math.round(rect.h), sourceQuad(docW, docH, rect, angleDeg))) > 0;
}
