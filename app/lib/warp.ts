/**
 * Warp & Perspective Warp — mesh-based layer transforms.
 *
 * Both produce a `LiquifyMesh`, which means they inherit Liquify's renderer
 * wholesale: `renderLiquify` already does inverse-mapped, premultiplied bilinear
 * resampling with a transparent border, and `meshLines` already draws the grid
 * overlay. Nothing about resampling is reimplemented here — this module's only
 * job is to fill in the per-node BACKWARD offsets that renderer consumes.
 *
 * Backward is the operative word. A mesh node asks "for the pixel that lands
 * HERE, where do I read from?", so both warps need the INVERSE of the map a
 * human describes:
 *
 *   - Perspective inverts exactly and for free: `solveHomography(dst, src)` is
 *     literally the inverse of `solveHomography(src, dst)`.
 *   - The presets do not. `warpPoint` (shared with warp-TEXT, so an Arc means
 *     the same thing on a text layer and on pixels) is a nonlinear forward map
 *     with no closed-form inverse, so it is inverted numerically per node.
 *
 * Pure and dependency-free apart from those three modules — Node-testable.
 */

import { createMesh, defaultSpacing, type LiquifyMesh } from "./liquify";
import { applyHomography, solveHomography, type Pt } from "./homography";
import { warpPoint, type TextWarp, type TextWarpStyle } from "./textwarp";

export type WarpKind = "preset" | "perspective";

export interface WarpSpec {
  kind: WarpKind;
  /** Preset warp (shares the warp-text style set). */
  style: TextWarpStyle;
  bend: number; // −100…100
  distH: number; // −100…100
  distV: number; // −100…100
  /** Perspective: the four destination corners in doc px, tl → tr → br → bl. */
  corners: Pt[] | null;
}

export function defaultWarp(w: number, h: number, kind: WarpKind = "preset"): WarpSpec {
  return {
    kind,
    style: "arc",
    bend: 30,
    distH: 0,
    distV: 0,
    corners: cornersOf(w, h),
  };
}

/** The identity quad for a doc: tl, tr, br, bl. */
export function cornersOf(w: number, h: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

/** True when the spec actually deforms anything (drives the identity fast path). */
export function warpSpecActive(s: WarpSpec, w: number, h: number): boolean {
  if (s.kind === "perspective") {
    const id = cornersOf(w, h);
    return !!s.corners && s.corners.some((p, i) => Math.abs(p.x - id[i].x) > 0.01 || Math.abs(p.y - id[i].y) > 0.01);
  }
  return s.style !== "none" && (s.bend !== 0 || s.distH !== 0 || s.distV !== 0);
}

/**
 * Invert `warpPoint` at (u, v) — Newton's method with a numerical Jacobian.
 *
 * The obvious approach, nudging the guess by the residual (damped fixed-point),
 * is not enough: it only converges while the Jacobian stays near the identity,
 * and combinations like a strong bend with opposing horizontal and vertical
 * distortion push it far enough away that the iteration DIVERGES — measured
 * running off to Infinity at `arc bend=-60 distH=-80 distV=80`. Newton solves
 * the local 2×2 system instead and is indifferent to how far from identity the
 * map has drifted.
 *
 * Two safeguards, because Newton has its own failure mode: a near-singular
 * Jacobian (a fold in the warp, where the map is genuinely non-invertible)
 * would produce an enormous step, so the step is both bounded and backed by a
 * damped fallback. The guess is kept in a bounded neighbourhood for the same
 * reason.
 *
 * Returns the best guess regardless of convergence: a slightly-off source
 * coordinate degrades the warp smoothly, whereas bailing out would tear it.
 */
const INVERT_STEPS = 24;
const EPS = 1e-4;
const MAX_STEP = 0.5;
export function invertWarpPoint(warp: TextWarp, u: number, v: number): { u: number; v: number } {
  let gu = u;
  let gv = v;
  for (let i = 0; i < INVERT_STEPS; i++) {
    const p = warpPoint(warp, gu, gv);
    const eu = u - p.u;
    const ev = v - p.v;
    if (Math.abs(eu) < 1e-7 && Math.abs(ev) < 1e-7) break;

    const pu = warpPoint(warp, gu + EPS, gv);
    const pv = warpPoint(warp, gu, gv + EPS);
    const j00 = (pu.u - p.u) / EPS;
    const j01 = (pv.u - p.u) / EPS;
    const j10 = (pu.v - p.v) / EPS;
    const j11 = (pv.v - p.v) / EPS;
    const det = j00 * j11 - j01 * j10;

    let du: number;
    let dv: number;
    if (Math.abs(det) < 1e-9) {
      // Folded or degenerate here — take a small damped step and move on.
      du = eu * 0.25;
      dv = ev * 0.25;
    } else {
      du = (j11 * eu - j01 * ev) / det;
      dv = (-j10 * eu + j00 * ev) / det;
    }
    // Bound the step so one bad Jacobian cannot throw the guess out of range.
    const mag = Math.hypot(du, dv);
    if (mag > MAX_STEP) {
      du = (du / mag) * MAX_STEP;
      dv = (dv / mag) * MAX_STEP;
    }
    gu += du;
    gv += dv;
    if (gu < -2) gu = -2;
    else if (gu > 3) gu = 3;
    if (gv < -2) gv = -2;
    else if (gv > 3) gv = 3;
  }
  return { u: gu, v: gv };
}

/**
 * The warped unit square's bounding box, used to REFIT the result into the
 * layer. Without this an Arc simply loses whatever it pushes past the top edge,
 * because the render target is the layer and filters/transforms here never
 * enlarge one. Refitting keeps the whole warped shape visible at the cost of a
 * slight overall shrink, which is the tradeoff Photoshop's warp box makes too.
 */
function warpedUnitBounds(warp: TextWarp): { u0: number; v0: number; du: number; dv: number } {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  const N = 16;
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++) {
      const { u, v } = warpPoint(warp, i / N, j / N);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  return {
    u0: minU,
    v0: minV,
    du: Math.max(1e-6, maxU - minU),
    dv: Math.max(1e-6, maxV - minV),
  };
}

/**
 * Build the backward-offset mesh for a spec. `fit` refits a preset warp inside
 * the layer (see above); it is meaningless for perspective, where the corners
 * already say where the content goes.
 */
export function warpMesh(
  spec: WarpSpec,
  w: number,
  h: number,
  opts: { spacing?: number; fit?: boolean } = {},
): LiquifyMesh {
  const spacing = opts.spacing ?? defaultSpacing(w, h);
  const mesh = createMesh(w, h, spacing);
  if (!warpSpecActive(spec, w, h)) return mesh;

  if (spec.kind === "perspective") {
    // src → dst is what the handles describe, so dst → src is the inverse, and
    // solveHomography gives it directly by swapping the argument order.
    const src = cornersOf(w, h);
    const dst = spec.corners ?? src;
    const Hinv = solveHomography(dst, src);
    for (let j = 0; j < mesh.rows; j++) {
      for (let i = 0; i < mesh.cols; i++) {
        const x = Math.min(w, i * spacing);
        const y = Math.min(h, j * spacing);
        const p = applyHomography(Hinv, x, y);
        const k = j * mesh.cols + i;
        mesh.dx[k] = p.x - x;
        mesh.dy[k] = p.y - y;
      }
    }
    return mesh;
  }

  const warp: TextWarp = { style: spec.style, bend: spec.bend, distH: spec.distH, distV: spec.distV };
  const fit = opts.fit !== false ? warpedUnitBounds(warp) : { u0: 0, v0: 0, du: 1, dv: 1 };
  for (let j = 0; j < mesh.rows; j++) {
    for (let i = 0; i < mesh.cols; i++) {
      const x = Math.min(w, i * spacing);
      const y = Math.min(h, j * spacing);
      // Destination in the refitted box → the warped-space point it stands for.
      const U = fit.u0 + (x / w) * fit.du;
      const V = fit.v0 + (y / h) * fit.dv;
      const s = invertWarpPoint(warp, U, V);
      const k = j * mesh.cols + i;
      mesh.dx[k] = s.u * w - x;
      mesh.dy[k] = s.v * h - y;
    }
  }
  return mesh;
}

/** Labels for the warp presets, in menu order (the "none" entry is dropped —
 *  an inactive warp is expressed by closing the dialog, not by picking it). */
export const WARP_PRESETS: { id: TextWarpStyle; label: string }[] = [
  { id: "arc", label: "Arc" },
  { id: "arcLower", label: "Arc Lower" },
  { id: "arcUpper", label: "Arc Upper" },
  { id: "arch", label: "Arch" },
  { id: "bulge", label: "Bulge" },
  { id: "flag", label: "Flag" },
  { id: "wave", label: "Wave" },
  { id: "rise", label: "Rise" },
  { id: "fish", label: "Fish" },
];
