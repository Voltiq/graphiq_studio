// Magnetic-lasso edge detection + snap search. Pure (bytes in, points out —
// Node-testable; CanvasArea only does the canvas readback and coordinate
// scaling). Reworked from the original inline version for better edges and
// longer reach:
//
//  • Edges come from a PER-CHANNEL Sobel (max of R/G/B responses), so
//    isoluminant colour boundaries — invisible to a luma-only Sobel — snap
//    like any other edge. Channels are box-blurred first to keep sensor noise
//    and fine texture from out-shouting real contours.
//  • Magnitudes are normalized to the image's own 99th percentile, so "strong
//    edge" means strong FOR THIS IMAGE — thresholds and distance trade-offs
//    behave the same on a soft portrait and a crunchy graphic.
//  • The snap search is ANISOTROPIC (candidates beside the travel direction
//    are cheaper than ahead/behind — the classic magnetic-lasso band),
//    CONTINUOUS (candidates far from the previous snapped point pay a
//    penalty, so the line doesn't hop between parallel contours), and
//    ORIENTATION-COHERENT (gradient direction similar to the previous point's
//    earns a bonus, resisting jumps onto perpendicular edges).

export interface EdgeField {
  w: number;
  h: number;
  /** Edge strength, normalized so the 99th percentile ≈ 255. */
  mag: Uint8ClampedArray;
  /** Gradient direction folded to [0, 180), degrees; 255 = no reliable edge. */
  theta: Uint8Array;
}

/** In-place separable 3×3 box blur on one float channel (edges clamp). */
function blur3(src: Float32Array, tmp: Float32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)];
      const r = src[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = (l + src[row + x] + r) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const dn = (y < h - 1 ? y + 1 : y) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      src[row + x] = (tmp[up + x] + tmp[row + x] + tmp[dn + x]) / 3;
    }
  }
}

/** Minimum normalized magnitude for a pixel to count as "an edge" at all. */
export const MAGNETIC_MIN_EDGE = 18;

/**
 * Build the edge field from RGBA bytes. Per channel: 3×3 blur → Sobel; each
 * pixel keeps its strongest channel's magnitude + gradient direction, then
 * magnitudes normalize to the 99th percentile.
 */
export function buildEdgeField(data: Uint8ClampedArray, w: number, h: number): EdgeField {
  const n = w * h;
  const chans = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    chans[0][i] = data[i * 4];
    chans[1][i] = data[i * 4 + 1];
    chans[2][i] = data[i * 4 + 2];
  }
  const tmp = new Float32Array(n);
  for (const c of chans) blur3(c, tmp, w, h);

  const magF = new Float32Array(n);
  const gxBest = new Float32Array(n);
  const gyBest = new Float32Array(n);
  for (const c of chans) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          -c[i - w - 1] - 2 * c[i - 1] - c[i + w - 1] +
          c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1];
        const gy =
          -c[i - w - 1] - 2 * c[i - w] - c[i - w + 1] +
          c[i + w - 1] + 2 * c[i + w] + c[i + w + 1];
        const m = Math.abs(gx) + Math.abs(gy);
        if (m > magF[i]) {
          magF[i] = m;
          gxBest[i] = gx;
          gyBest[i] = gy;
        }
      }
    }
  }

  // Normalize to the 99th percentile of NON-TRIVIAL responses (a flat image
  // stays flat — tiny noise maxima must not get stretched to full strength).
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  let maxM = 0;
  for (let i = 0; i < n; i++) if (magF[i] > maxM) maxM = magF[i];
  let counted = 0;
  if (maxM > 0) {
    for (let i = 0; i < n; i++) {
      if (magF[i] <= 0) continue;
      hist[Math.min(BINS - 1, Math.floor((magF[i] / maxM) * BINS))]++;
      counted++;
    }
  }
  let p99 = maxM;
  if (counted > 0) {
    const target = counted * 0.99;
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc >= target) {
        p99 = ((b + 1) / BINS) * maxM;
        break;
      }
    }
  }
  // Full-contrast Sobel tops out around 8·255; treating anything ≥ ~1/16 of
  // that as "real" keeps near-flat images from amplifying noise to 255.
  const scale = 255 / Math.max(p99, 128);

  const mag = new Uint8ClampedArray(n);
  const theta = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    const v = magF[i] * scale;
    mag[i] = v; // Uint8Clamped rounds + clamps
    if (mag[i] >= MAGNETIC_MIN_EDGE) {
      let deg = (Math.atan2(gyBest[i], gxBest[i]) * 180) / Math.PI;
      if (deg < 0) deg += 180; // fold to [0,180)
      if (deg >= 180) deg -= 180;
      theta[i] = Math.min(179, Math.round(deg));
    }
  }
  return { w, h, mag, theta };
}

export interface SnapOptions {
  /** Search radius in field pixels. */
  r: number;
  /** Unit travel direction of the drag (omit when unknown — first point). */
  dirX?: number;
  dirY?: number;
  /** Previous SNAPPED point (field px) + its gradient direction (255 = none). */
  prev?: { x: number; y: number; theta: number } | null;
  /** Free movement allowance from `prev` before the continuity penalty (px) —
   *  pass the distance the raw cursor travelled since the last point. */
  stepFree?: number;
}

export interface SnapResult {
  x: number;
  y: number;
  mag: number;
  theta: number;
  /** False = nothing edge-like in range; (x,y) is the raw input. */
  snapped: boolean;
}

// Scoring weights (normalized-magnitude units per field pixel):
const ALONG_COST = 1.2; // moving the snap ahead/behind the travel direction
const PERP_COST = 0.5; // pulling sideways toward a contour — the cheap axis
const ISO_COST = 0.8; // no direction known yet
const CONT_COST = 0.6; // per px beyond stepFree from the previous snapped point
const CONT_CAP = 60; // continuity never outright forbids following a turn
const ORIENT_BONUS = 14; // ±: same-direction edge vs perpendicular edge

/** Angular difference of two folded directions, 0..90 degrees. */
function foldedDiff(a: number, b: number): number {
  let d = Math.abs(a - b);
  if (d > 90) d = 180 - d;
  return d;
}

/**
 * Snap (px, py) to the best nearby edge. Score = normalized magnitude minus an
 * anisotropic distance penalty minus a continuity penalty plus an orientation
 * bonus. Falls back to the raw point when nothing plausible is in range.
 */
export function snapPoint(f: EdgeField, px: number, py: number, o: SnapOptions): SnapResult {
  const mx = Math.round(px);
  const my = Math.round(py);
  const R = Math.max(2, Math.round(o.r));
  let ux = 0;
  let uy = 0;
  let hasDir = false;
  if (o.dirX !== undefined && o.dirY !== undefined) {
    const len = Math.hypot(o.dirX, o.dirY);
    if (len > 1e-6) {
      ux = o.dirX / len;
      uy = o.dirY / len;
      hasDir = true;
    }
  }
  const prev = o.prev ?? null;
  const stepFree = Math.max(2, o.stepFree ?? 8);

  let best = -Infinity;
  let bx = mx;
  let by = my;
  let bmag = 0;
  let btheta = 255;
  for (let dy = -R; dy <= R; dy++) {
    const y = my + dy;
    if (y < 1 || y >= f.h - 1) continue;
    const row = y * f.w;
    for (let dx = -R; dx <= R; dx++) {
      const x = mx + dx;
      if (x < 1 || x >= f.w - 1) continue;
      const mag = f.mag[row + x];
      if (mag < MAGNETIC_MIN_EDGE) continue;
      let dist: number;
      if (hasDir) {
        const along = Math.abs(dx * ux + dy * uy);
        const perp = Math.abs(dx * -uy + dy * ux);
        dist = ALONG_COST * along + PERP_COST * perp;
      } else {
        dist = ISO_COST * Math.hypot(dx, dy);
      }
      let score = mag - dist;
      if (prev) {
        const dPrev = Math.hypot(x - prev.x, y - prev.y);
        score -= Math.min(CONT_CAP, CONT_COST * Math.max(0, dPrev - stepFree));
        const th = f.theta[row + x];
        if (prev.theta !== 255 && th !== 255) {
          // +BONUS on the same contour direction, −BONUS across it.
          score += ORIENT_BONUS * (1 - foldedDiff(th, prev.theta) / 45);
        }
      }
      if (score > best) {
        best = score;
        bx = x;
        by = y;
        bmag = mag;
        btheta = f.theta[row + x];
      }
    }
  }
  if (bmag < MAGNETIC_MIN_EDGE) return { x: px, y: py, mag: 0, theta: 255, snapped: false };
  return { x: bx, y: by, mag: bmag, theta: btheta, snapped: true };
}
