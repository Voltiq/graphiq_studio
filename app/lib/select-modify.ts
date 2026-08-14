/**
 * Select ▸ Modify — Border / Smooth / Expand / Contract.
 *
 * All four are thresholds of one primitive: the SIGNED DISTANCE to the
 * selection boundary. Once you have that, expand is `d ≤ +r`, contract is
 * `d ≤ −r`, and border is `|d| ≤ r/2` — no repeated passes, no accumulated
 * error, and a genuinely ROUND kernel rather than the square one you get from
 * dilating a rectangle.
 *
 * The round kernel is the point. The existing Grow expands each rect
 * independently, which is a correct *square* dilation (dilation distributes over
 * union), but it leaves square corners and it cannot be inverted for Contract —
 * erosion does NOT distribute over union, so a per-rect shrink is simply wrong
 * for any selection made of more than one rectangle.
 *
 * The distance transform is Felzenszwalb & Huttenlocher's exact algorithm: a
 * lower envelope of parabolas, separable, O(n) per row and column. Exact matters
 * here — an approximate (chamfer) transform would make "expand by 10" mean
 * something slightly different along the diagonals than along the axes.
 *
 * Pure and dependency-free apart from the shared blur — Node-testable.
 */

import { gaussianChannel } from "./blur";

const INF = 1e20;

/** Exact squared-distance transform of one row/column (Felzenszwalb–Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    // Intersection of the parabola from q with the one currently on top.
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/** Squared Euclidean distance to the nearest pixel where `inside` is true. */
function edt2d(inside: (i: number) => boolean, w: number, h: number): Float64Array {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = inside(i) ? 0 : INF;
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[row + x] = d[x];
  }
  return g;
}

/**
 * Signed distance to the selection boundary, in pixels: NEGATIVE inside,
 * positive outside. Zero-ish exactly on the edge.
 */
export function signedDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  // Computed on a 1-px border of zeros, so the CANVAS EDGE counts as a boundary.
  // Without it a selection covering the whole document has no outside anywhere,
  // its interior distance is infinite, and Select All → Contract does nothing
  // at all instead of insetting.
  const pw = w + 2;
  const ph = h + 2;
  const pad = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) pad[(y + 1) * pw + (x + 1)] = mask[y * w + x];

  const outside = edt2d((i) => pad[i] === 0, pw, ph); // distance to the nearest OUT
  const insideD = edt2d((i) => pad[i] !== 0, pw, ph); // distance to the nearest IN
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const pi = (y + 1) * pw + (x + 1);
      out[y * w + x] = pad[pi] ? -Math.sqrt(outside[pi]) : Math.sqrt(insideD[pi]);
    }
  return out;
}

/** Grow the selection by `px`, with a round kernel. */
export function expandMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.max(0, px);
  if (r === 0) return Uint8Array.from(mask);
  const d = signedDistance(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

/** Shrink the selection by `px`. Thin parts vanish entirely, as they should. */
export function contractMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.max(0, px);
  if (r === 0) return Uint8Array.from(mask);
  const d = signedDistance(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= -r ? 1 : 0;
  return out;
}

/**
 * Replace the selection with a band of width `px` straddling its boundary —
 * half inside, half outside, which is what makes a bordered selection sit ON the
 * edge rather than beside it.
 */
export function borderMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.max(1, px) / 2;
  const d = signedDistance(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.abs(d[i]) <= r ? 1 : 0;
  return out;
}

/**
 * Round off corners and speckle. Blur then re-threshold at the halfway point:
 * the blur is what lets a boundary take a shorter path, and the re-threshold is
 * what keeps the result a HARD selection rather than a soft one — Feather is
 * the control for softness, and conflating the two would leave no way to smooth
 * a jagged edge while keeping it crisp.
 */
export function smoothMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.max(0, px);
  if (r === 0) return Uint8Array.from(mask);
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 255 : 0;
  gaussianChannel(f, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = f[i] >= 127.5 ? 1 : 0;
  return out;
}

export type ModifyOp = "border" | "smooth" | "expand" | "contract";

export function modifyMask(
  mask: Uint8Array,
  w: number,
  h: number,
  op: ModifyOp,
  px: number,
): Uint8Array {
  switch (op) {
    case "border":
      return borderMask(mask, w, h, px);
    case "smooth":
      return smoothMask(mask, w, h, px);
    case "expand":
      return expandMask(mask, w, h, px);
    case "contract":
      return contractMask(mask, w, h, px);
  }
}

export const MODIFY_LABELS: Record<ModifyOp, string> = {
  border: "Border",
  smooth: "Smooth",
  expand: "Expand",
  contract: "Contract",
};
