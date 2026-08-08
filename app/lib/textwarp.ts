/**
 * Warp-text presets (arc, bulge, flag, …). Pure and dependency-free (Node-
 * testable): the engine renders flat text into a buffer, then texture-maps it
 * onto a mesh whose vertices come from `warpPoint`. The math works in normalized
 * coordinates (u, v ∈ [0,1] over the flat text's bounding box).
 */

export type TextWarpStyle =
  | "none"
  | "arc"
  | "arcLower"
  | "arcUpper"
  | "arch"
  | "bulge"
  | "flag"
  | "wave"
  | "rise"
  | "fish";

export interface TextWarp {
  style: TextWarpStyle;
  /** Bend −100…100 (the primary warp amount). */
  bend: number;
  /** Horizontal distortion −100…100 (perspective taper across rows). */
  distH: number;
  /** Vertical distortion −100…100 (perspective taper across columns). */
  distV: number;
}

export const WARP_STYLES: { id: TextWarpStyle; label: string }[] = [
  { id: "none", label: "None" },
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

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/** True when a warp actually deforms anything (drives the flat fast-path). */
export function warpActive(warp: TextWarp | undefined): warp is TextWarp {
  return (
    !!warp &&
    warp.style !== "none" &&
    (warp.bend !== 0 || warp.distH !== 0 || warp.distV !== 0)
  );
}

/**
 * Map a normalized source point (u, v ∈ [0,1] over the flat bounds) to its
 * warped normalized position. Results can fall outside [0,1] — the warped text
 * extends past its flat box, which the caller accounts for.
 */
export function warpPoint(warp: TextWarp, u: number, v: number): { u: number; v: number } {
  const b = clamp(warp.bend / 100, -1, 1);
  const dh = clamp(warp.distH / 100, -1, 1);
  const dv = clamp(warp.distV / 100, -1, 1);
  const cx = u - 0.5; // [-0.5, 0.5]
  const cy = v - 0.5;
  const env = 1 - 4 * cx * cx; // 1 at the centre column, 0 at the left/right edges
  let nu = u;
  let nv = v;
  switch (warp.style) {
    case "arc":
      // The whole block bows along a parabola (a curved baseline).
      nv = v - b * 0.5 * env;
      break;
    case "arcUpper":
      // Only the top edge curves (weight by distance from the bottom).
      nv = v - b * 0.6 * env * (1 - v);
      break;
    case "arcLower":
      // Only the bottom edge curves.
      nv = v - b * 0.6 * env * v;
      break;
    case "arch": {
      // Bow + the block grows taller through the middle.
      const scaleY = 1 + b * 0.5 * env;
      nv = 0.5 + (v - 0.5) * scaleY - b * 0.35 * env;
      break;
    }
    case "bulge": {
      // Vertical scale expands in the middle (a barrel).
      const scaleY = 1 + b * env;
      nv = 0.5 + (v - 0.5) * scaleY;
      break;
    }
    case "flag":
      // Sine wave whose amplitude grows toward the right (a flag).
      nv = v + b * 0.25 * Math.sin(u * Math.PI * 3) * (0.3 + 0.7 * u);
      break;
    case "wave":
      // Uniform sine wave.
      nv = v + b * 0.25 * Math.sin(u * Math.PI * 3);
      break;
    case "rise":
      // Linear ramp — the whole block shears upward left→right.
      nv = v - b * 0.5 * u;
      break;
    case "fish": {
      // Fisheye: horizontal stretch at the vertical centre, pinch at the edges.
      const scaleX = 1 + b * (1 - 4 * cy * cy);
      nu = 0.5 + (u - 0.5) * scaleX;
      break;
    }
    default:
      break;
  }
  // Perspective distortions applied on top: horizontal tapers width by row,
  // vertical tapers height by column.
  if (dh) nu = 0.5 + (nu - 0.5) * (1 + dh * (v - 0.5));
  if (dv) nv = 0.5 + (nv - 0.5) * (1 + dv * (u - 0.5));
  return { u: nu, v: nv };
}

/**
 * The pixel bounding box the warped text occupies, given the flat bounds. Sampled
 * over a grid (the warp is smooth, so a coarse grid captures the extent). Used
 * for the re-edit hit-test bbox.
 */
export function warpedBounds(
  flat: { x: number; y: number; w: number; h: number },
  warp: TextWarp,
): { x: number; y: number; w: number; h: number } {
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  const N = 16;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const { u, v } = warpPoint(warp, i / N, j / N);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  const x = flat.x + minU * flat.w;
  const y = flat.y + minV * flat.h;
  return {
    x,
    y,
    w: Math.max(1, (maxU - minU) * flat.w),
    h: Math.max(1, (maxV - minV) * flat.h),
  };
}
