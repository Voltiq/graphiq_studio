/**
 * Refine Edge — smooth / feather / contrast / shift-edge for a selection, plus
 * colour decontamination.
 *
 * Selections in this app are `Rect[]` geometry plus a scalar softness applied
 * when the mask is built (`selectionMask`), NOT a stored grayscale raster. That
 * is the seam this extends: the whole refinement is a pipeline over the mask's
 * alpha plane, so a refined selection stays as cheap to store and as easy to
 * transform as an unrefined one, and every existing consumer of the mask picks
 * the refinement up for free.
 *
 * Pure and dependency-free apart from the shared blur — Node-testable.
 */

import { gaussianChannel } from "./blur";

export interface RefineEdge {
  /** px — rounds off jagged, stair-stepped boundaries without softening them. */
  smooth: number;
  /** px — Gaussian softness. */
  feather: number;
  /** % 0…100 — steepens the transition, up to a hard cut. */
  contrast: number;
  /** % −100…100 — moves the boundary outward (+) or inward (−). */
  shift: number;
}

export const NO_REFINE: RefineEdge = { smooth: 0, feather: 0, contrast: 0, shift: 0 };

export function refineActive(r: RefineEdge | undefined): r is RefineEdge {
  return !!r && (r.smooth > 0 || r.feather > 0 || r.contrast !== 0 || r.shift !== 0);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The tone transfer that implements contrast AND shift together.
 *
 * Shift moves the level the boundary sits at; contrast steepens the ramp around
 * it. They are applied as one affine remap so the two cannot fight each other,
 * and the gain has a FLOOR derived from the shift:
 *
 *   gain ≥ 0.5 / min(threshold, 1 − threshold)
 *
 * Without that floor, shifting the threshold on a ramp with gain 1 translates
 * the whole plane — the fully-unselected exterior would come back at 50%
 * instead of staying at 0. The floor pins both ends: alpha 0 still maps to ≤ 0
 * and alpha 1 still maps to ≥ 1, whatever the shift.
 *
 * The consequence is honest rather than hidden: a large shift necessarily
 * hardens the edge somewhat, because a ramp with pinned ends cannot be moved far
 * without steepening. Photoshop presents the two as independent; they are not.
 */
export function edgeTransfer(a: number, contrast: number, shift: number): number {
  const k = Math.max(0, Math.min(100, contrast)) / 100;
  const s = Math.max(-100, Math.min(100, shift)) / 100;
  // Held off the extremes: at threshold exactly 0 (or 1) the pinned end sits ON
  // the boundary and maps to 0.5 whatever the gain, which put the fully
  // unselected exterior back at half strength. ±100 therefore means "select
  // everything above 2%", not "including alpha exactly 0".
  const threshold = Math.max(0.02, Math.min(0.98, 0.5 - s * 0.5));
  const gainFromContrast = 1 / Math.max(0.02, 1 - k);
  const gainFloor = 0.5 / Math.max(1e-6, Math.min(threshold, 1 - threshold));
  const gain = Math.max(gainFromContrast, gainFloor);
  return clamp01(0.5 + (a - threshold) * gain);
}

/**
 * Round off jagged boundaries WITHOUT softening them: blur, then re-threshold
 * at the halfway point. A blur alone would just make the staircase fuzzy; the
 * re-threshold snaps it back to a hard edge that now follows a smoother path.
 * (This is the standard morphological open-then-close approximation.)
 */
function smoothPass(alpha: Float32Array, w: number, h: number, radius: number) {
  gaussianChannel(alpha, w, h, radius);
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i] >= 127.5 ? 255 : 0;
}

/**
 * Apply the whole pipeline in place. Alpha is 0…255.
 *
 * ORDER IS LOAD-BEARING: smooth must precede feather (it re-thresholds, so
 * running it after feather would throw the softness away), and contrast/shift
 * must come last because both need a ramp to act on — applied to a hard binary
 * mask, shift can only move the boundary by whole pixels or not at all.
 */
export function applyRefine(alpha: Float32Array, w: number, h: number, r: RefineEdge) {
  if (!refineActive(r)) return;
  if (r.smooth > 0) smoothPass(alpha, w, h, r.smooth);
  if (r.feather > 0) gaussianChannel(alpha, w, h, r.feather);
  if (r.contrast !== 0 || r.shift !== 0) {
    // A shift with no ramp to move would be a no-op, so give it one: a hard mask
    // gets a minimal blur first, matching what feather would have provided.
    if (r.feather <= 0 && r.smooth <= 0 && r.shift !== 0) gaussianChannel(alpha, w, h, 1);
    for (let i = 0; i < alpha.length; i++) {
      alpha[i] = edgeTransfer(alpha[i] / 255, r.contrast, r.shift) * 255;
    }
  }
}

/**
 * Colour decontamination — strip the old background's colour out of the
 * partially-selected fringe.
 *
 * A pixel on a soft edge is a MIXTURE: `C = a·F + (1−a)·B`, where F is the
 * foreground colour we want and B is whatever it was composited against. Cutting
 * the selection out keeps C and merely varies the alpha, which is why an object
 * lifted off a blue sky keeps a blue halo no matter how good the mask is. Given
 * an estimate of B the mixture inverts exactly: `F = (C − (1−a)·B) / a`.
 *
 * B is estimated from the pixels the selection EXCLUDES, blurred so each fringe
 * pixel sees a local average of the background it was sitting on rather than one
 * arbitrary neighbour. Below `MIN_ALPHA` the inversion divides by almost nothing
 * and amplifies noise into confetti, so it is left alone.
 *
 * `amount` (0…100) blends between the original and the decontaminated colour.
 */
const MIN_ALPHA = 0.15;
export function decontaminate(
  rgba: Uint8ClampedArray,
  alpha: Float32Array,
  w: number,
  h: number,
  amount: number,
) {
  const k = Math.max(0, Math.min(100, amount)) / 100;
  if (k <= 0) return;
  const n = w * h;
  // Background estimate: the excluded pixels' colour, area-weighted and spread.
  const bR = new Float32Array(n);
  const bG = new Float32Array(n);
  const bB = new Float32Array(n);
  const bW = new Float32Array(n);
  // Only pixels that are essentially FULLY outside contribute. Weighting every
  // pixel by (1 − a) instead lets the fringe vote for its own background, and
  // the fringe is a mixture — the estimate then drifts toward the very colour
  // being removed, which measured as barely half the contamination cleared.
  for (let i = 0; i < n; i++) {
    if (alpha[i] > 0.05 * 255) continue;
    const o = i * 4;
    bR[i] = rgba[o];
    bG[i] = rgba[o + 1];
    bB[i] = rgba[o + 2];
    bW[i] = 1;
  }
  // Wide enough that pure background reaches across the fringe to the pixels
  // that need it — a soft edge can be several pixels of ramp on its own.
  const spread = Math.max(6, Math.round(Math.min(w, h) / 32));
  for (const ch of [bR, bG, bB, bW]) gaussianChannel(ch, w, h, spread);

  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255;
    if (a <= MIN_ALPHA || a >= 0.999) continue;
    const wgt = bW[i];
    if (wgt <= 1e-4) continue; // no background nearby to unmix against
    const o = i * 4;
    const br = bR[i] / wgt;
    const bg = bG[i] / wgt;
    const bb = bB[i] / wgt;
    const inv = 1 / a;
    const fr = (rgba[o] - (1 - a) * br) * inv;
    const fg = (rgba[o + 1] - (1 - a) * bg) * inv;
    const fb = (rgba[o + 2] - (1 - a) * bb) * inv;
    rgba[o] = rgba[o] + (fr - rgba[o]) * k;
    rgba[o + 1] = rgba[o + 1] + (fg - rgba[o + 1]) * k;
    rgba[o + 2] = rgba[o + 2] + (fb - rgba[o + 2]) * k;
  }
}
