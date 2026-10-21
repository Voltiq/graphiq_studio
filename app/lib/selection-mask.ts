// The selection as a mask. TODO 1.3.
//
// A selection is 8-bit coverage: 255 inside, 0 outside, anything between on a
// soft edge (a feather, a Quick Mask stroke, a channel). The editor holds its
// OUTLINE — the run-length rects of the pixels that are at least 50% selected,
// which is what the ants trace and the tools reason about — and the engine
// keeps the coverage behind it. A hard selection is exactly its rects; only a
// soft one needs the bytes.
//
// Everything here is pure arithmetic on byte arrays, so every selection
// operation can be tested without a canvas: building a selection from
// coverage, the mask algebra (add / subtract / intersect / invert), feather,
// round expand and contract, square grow, moving it and resizing it.
//
// The rule that makes soft selections survive: an operation that makes a new
// selection from an old one works on the coverage, not on the rects.

import type { Rect } from "./view";
import { gaussianChannel } from "./blur";

/** A soft selection's coverage, cropped to where it is non-zero. */
export interface SelectionMask {
  /** The canvas it was made for — a mask is only meaningful at that size. */
  w: number;
  h: number;
  /** Tight bounds of the non-zero coverage. */
  bounds: Rect;
  /** Coverage 0…255, `bounds.w × bounds.h`, row-major. */
  alpha: Uint8Array;
  /** How far its soft edge reaches either side of the 50% line, in px, when an
   *  operation that knows it made the mask (Feather): the ants draw the extent. */
  softness?: number;
}

/** What a selection is made of: its outline, and its coverage when soft. */
export interface SelectionParts {
  rects: Rect[];
  mask: SelectionMask | null;
}

/**
 * The selection a coverage image describes (`at(i)` = coverage of pixel i).
 * The rects are the ≥50% outline as one run per row; the mask is kept only
 * when some pixel is partly selected. A selection with no pixel at 50% or
 * more has no outline for the editor to hold, so it comes back empty.
 */
export function fromCoverage(at: (i: number) => number, w: number, h: number): SelectionParts {
  const rects: Rect[] = [];
  let soft = false;
  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  for (let y = 0; y < h; y++) {
    let x0 = -1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = at(row + x);
      if (a) {
        if (a < 255) soft = true;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        by1 = y;
      }
      const on = a >= 128;
      if (on && x0 < 0) x0 = x;
      else if (!on && x0 >= 0) {
        rects.push({ x: x0, y, w: x - x0, h: 1 });
        x0 = -1;
      }
    }
    if (x0 >= 0) rects.push({ x: x0, y, w: w - x0, h: 1 });
  }
  if (!soft || !rects.length) return { rects, mask: null };
  const bounds = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  const alpha = new Uint8Array(bounds.w * bounds.h);
  for (let y = 0; y < bounds.h; y++) {
    const src = (bounds.y + y) * w + bounds.x;
    for (let x = 0; x < bounds.w; x++) alpha[y * bounds.w + x] = at(src + x);
  }
  return { rects, mask: { w, h, bounds, alpha } };
}

/** A selection over the whole canvas, one byte per pixel: its mask where it
 *  has one, otherwise its rects as 0 / 255. */
export function coverage(rects: Rect[], mask: SelectionMask | null, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (mask) {
    const { bounds: b, alpha } = mask;
    for (let y = 0; y < b.h; y++) out.set(alpha.subarray(y * b.w, (y + 1) * b.w), (b.y + y) * w + b.x);
    return out;
  }
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const x1 = Math.min(w, Math.ceil(r.x + r.w));
    const y0 = Math.max(0, Math.floor(r.y));
    const y1 = Math.min(h, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) out.fill(255, y * w + x0, y * w + x1);
  }
  return out;
}

export type CombineOp = "add" | "subtract" | "intersect" | "invert";

/**
 * Mask algebra: add = max(a, b), subtract = min(a, 255 − b), intersect =
 * min(a, b), invert = 255 − a. For 0/255 inputs these are exactly union,
 * difference, intersection and complement.
 */
export function combine(a: Uint8Array, b: Uint8Array | null, op: CombineOp): Uint8Array {
  const n = a.length;
  const r = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b ? b[i] : 0;
    r[i] =
      op === "invert" ? 255 - x
      : op === "add" ? (x > y ? x : y)
      : op === "intersect" ? (x < y ? x : y)
      : Math.min(x, 255 - y);
  }
  return r;
}

/** Tight bounds of the non-zero coverage, or null when there is none. */
export function tightBounds(c: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!c[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Feather: blur the coverage by `radius`. The same blur Refine Edge's feather
 * and the old per-use feather ran, rounded the way a canvas stores it, so a
 * fill through a feathered selection is the fill it always was.
 */
export function feather(c: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const f = new Float32Array(c.length);
  for (let i = 0; i < c.length; i++) f[i] = c[i];
  gaussianChannel(f, w, h, radius);
  const out = new Uint8ClampedArray(c.length);
  for (let i = 0; i < c.length; i++) out[i] = f[i];
  return new Uint8Array(out.buffer);
}

/** Scratch for slideLine, grown on demand. */
interface SlideBufs {
  e: Uint8Array;
  g: Uint8Array;
  h: Uint8Array;
}
const newBufs = (): SlideBufs => ({ e: new Uint8Array(0), g: new Uint8Array(0), h: new Uint8Array(0) });

/**
 * `out[x]` = the max (or min) of `line[x − k … x + k]`, reading `pad` past either
 * end — van Herk / Gil–Werman: three passes whatever `k` is, so a wide kernel
 * costs no more per pixel than a narrow one.
 */
export function slideLine(
  line: Uint8Array,
  n: number,
  k: number,
  pad: number,
  max: boolean,
  out: Uint8Array,
  bufs: SlideBufs = newBufs(),
): void {
  if (k <= 0) {
    out.set(line.subarray(0, n));
    return;
  }
  const m = 2 * k + 1;
  const L = n + 2 * k;
  if (bufs.e.length < L) {
    bufs.e = new Uint8Array(L);
    bufs.g = new Uint8Array(L);
    bufs.h = new Uint8Array(L);
  }
  const { e, g, h } = bufs;
  for (let j = 0; j < L; j++) e[j] = j < k || j >= n + k ? pad : line[j - k];
  for (let j = 0; j < L; j++) {
    if (j % m === 0) g[j] = e[j];
    else g[j] = max ? (g[j - 1] > e[j] ? g[j - 1] : e[j]) : g[j - 1] < e[j] ? g[j - 1] : e[j];
  }
  for (let j = L - 1; j >= 0; j--) {
    if (j === L - 1 || (j + 1) % m === 0) h[j] = e[j];
    else h[j] = max ? (h[j + 1] > e[j] ? h[j + 1] : e[j]) : h[j + 1] < e[j] ? h[j + 1] : e[j];
  }
  for (let x = 0; x < n; x++) {
    const a = h[x];
    const b = g[x + m - 1];
    out[x] = max ? (a > b ? a : b) : a < b ? a : b;
  }
}

/**
 * Round morphology on coverage: the max over a disc of radius `r` (expand), or
 * the min over an OPEN disc (contract) — off the canvas counts as unselected.
 * On a hard selection these are exactly Select ▸ Modify's expand (`d ≤ r`) and
 * contract (`d ≤ −r`), whose signed distance is measured to pixel centres; on a
 * soft one they move the whole soft edge out or in by `r`, keeping its softness.
 *
 * Done as horizontal runs, one per row offset of the disc (its chords), each a
 * sliding max/min — grouped by chord length, which repeats near the middle.
 */
export function morphRound(c: Uint8Array, w: number, h: number, r: number, expand: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const b = tightBounds(c, w, h);
  if (!b) return out;
  if (!(r > 0)) {
    out.set(c);
    return out;
  }
  const r2 = r * r;
  // Half-width of the chord at each row offset: the largest k with k² + dy² ≤ r²
  // (inclusive, for expand) or < r² (open, for contract).
  const byK = new Map<number, number[]>();
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    const rem = r2 - dy * dy;
    if (expand ? rem < 0 : rem <= 0) continue;
    // (Math.sqrt is exact on perfect squares, which is where these two differ.)
    const k = expand ? Math.floor(Math.sqrt(rem)) : Math.ceil(Math.sqrt(rem)) - 1;
    const list = byK.get(k);
    if (list) list.push(dy);
    else byK.set(k, [dy]);
  }
  // The window that can change: the coverage grown by the radius (expand), or
  // the coverage itself (contract never selects anything new).
  const pad = expand ? R : 0;
  const x0 = Math.max(0, b.x - pad);
  const y0 = Math.max(0, b.y - pad);
  const x1 = Math.min(w, b.x + b.w + pad);
  const y1 = Math.min(h, b.y + b.h + pad);
  const ww = x1 - x0;
  const wh = y1 - y0;
  const acc = new Uint8Array(ww * wh).fill(expand ? 0 : 255);
  const rows = new Uint8Array(ww * wh);
  const line = new Uint8Array(ww);
  const filt = new Uint8Array(ww);
  const bufs = newBufs();
  for (const [k, dys] of byK) {
    for (let y = y0; y < y1; y++) {
      line.set(c.subarray(y * w + x0, y * w + x1));
      slideLine(line, ww, k, 0, expand, filt, bufs);
      rows.set(filt, (y - y0) * ww);
    }
    for (const dy of dys) {
      for (let y = y0; y < y1; y++) {
        const ai = (y - y0) * ww;
        const sy = y + dy;
        if (sy < y0 || sy >= y1) {
          // An all-unselected row: nothing to add, everything to take away.
          if (!expand) acc.fill(0, ai, ai + ww);
          continue;
        }
        const si = (sy - y0) * ww;
        if (expand) {
          for (let x = 0; x < ww; x++) if (rows[si + x] > acc[ai + x]) acc[ai + x] = rows[si + x];
        } else {
          for (let x = 0; x < ww; x++) if (rows[si + x] < acc[ai + x]) acc[ai + x] = rows[si + x];
        }
      }
    }
  }
  for (let y = 0; y < wh; y++) out.set(acc.subarray(y * ww, (y + 1) * ww), (y0 + y) * w + x0);
  return out;
}

/** Grow by `r` with a SQUARE kernel — Select ▸ Grow, which on a hard selection
 *  is every rect pushed out by `r`, now on the coverage. */
export function growSquare(c: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const b = tightBounds(c, w, h);
  if (!b) return out;
  const k = Math.max(0, Math.round(r));
  const x0 = Math.max(0, b.x - k);
  const y0 = Math.max(0, b.y - k);
  const x1 = Math.min(w, b.x + b.w + k);
  const y1 = Math.min(h, b.y + b.h + k);
  const ww = x1 - x0;
  const wh = y1 - y0;
  const tmp = new Uint8Array(ww * wh);
  const bufs = newBufs();
  const line = new Uint8Array(Math.max(ww, wh));
  const filt = new Uint8Array(Math.max(ww, wh));
  for (let y = 0; y < wh; y++) {
    line.set(c.subarray((y0 + y) * w + x0, (y0 + y) * w + x1));
    slideLine(line, ww, k, 0, true, filt, bufs);
    tmp.set(filt.subarray(0, ww), y * ww);
  }
  for (let x = 0; x < ww; x++) {
    for (let y = 0; y < wh; y++) line[y] = tmp[y * ww + x];
    slideLine(line, wh, k, 0, true, filt, bufs);
    for (let y = 0; y < wh; y++) out[(y0 + y) * w + x0 + x] = filt[y];
  }
  return out;
}

/** The mask moved by whole pixels (the outline was nudged or dragged); null
 *  if nothing of it is left on the canvas. */
export function shift(m: SelectionMask, dx: number, dy: number): SelectionMask | null {
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  const b = m.bounds;
  const x0 = Math.max(0, b.x + ox);
  const y0 = Math.max(0, b.y + oy);
  const x1 = Math.min(m.w, b.x + ox + b.w);
  const y1 = Math.min(m.h, b.y + oy + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const nb = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const alpha = new Uint8Array(nb.w * nb.h);
  for (let y = 0; y < nb.h; y++) {
    const sy = nb.y + y - oy - b.y;
    const sx = nb.x - ox - b.x;
    alpha.set(m.alpha.subarray(sy * b.w + sx, sy * b.w + sx + nb.w), y * nb.w);
  }
  return { ...m, bounds: nb, alpha };
}

/**
 * The mask carried through a resize of the selection's box `from` → `to` (the
 * transform handles, Transform-by-numbers): every pixel of the new box samples
 * the old coverage at the corresponding point, bilinearly. Null if nothing is
 * left on the canvas.
 */
export function resample(m: SelectionMask, from: Rect, to: Rect): SelectionMask | null {
  if (!(from.w > 0 && from.h > 0 && to.w > 0 && to.h > 0)) return null;
  const sx = from.w / to.w;
  const sy = from.h / to.h;
  const b = m.bounds;
  // Where the old coverage lands, then clipped to the canvas.
  const nx0 = Math.max(0, Math.floor(to.x + (b.x - from.x) / sx));
  const ny0 = Math.max(0, Math.floor(to.y + (b.y - from.y) / sy));
  const nx1 = Math.min(m.w, Math.ceil(to.x + (b.x + b.w - from.x) / sx));
  const ny1 = Math.min(m.h, Math.ceil(to.y + (b.y + b.h - from.y) / sy));
  if (nx1 <= nx0 || ny1 <= ny0) return null;
  const at = (x: number, y: number) =>
    x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h ? 0 : m.alpha[(y - b.y) * b.w + (x - b.x)];
  const full = new Uint8Array(m.w * m.h);
  for (let y = ny0; y < ny1; y++) {
    const fy = from.y + (y + 0.5 - to.y) * sy - 0.5;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let x = nx0; x < nx1; x++) {
      const fx = from.x + (x + 0.5 - to.x) * sx - 0.5;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const v =
        (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) +
        (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
      full[y * m.w + x] = Math.round(v);
    }
  }
  const nb = tightBounds(full, m.w, m.h);
  if (!nb) return null;
  const alpha = new Uint8Array(nb.w * nb.h);
  for (let y = 0; y < nb.h; y++) {
    const row = (nb.y + y) * m.w + nb.x;
    alpha.set(full.subarray(row, row + nb.w), y * nb.w);
  }
  return { ...m, bounds: nb, alpha, softness: m.softness !== undefined ? m.softness / Math.min(sx, sy) : undefined };
}
