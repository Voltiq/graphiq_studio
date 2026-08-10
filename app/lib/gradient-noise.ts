// Gradient dither + noise gradients (TODO §2) — both pure, both Node-testable.
//
// DITHER. A gradient across a wide area steps through 8-bit values slowly, so
// each step becomes a visible band — worst in skies and soft vignettes. This
// works POST-quantization, on the pixels the canvas gradient already produced,
// so it cannot recover the precision that was lost; what it does is break the
// contour between two levels into an ordered stipple, which is what actually
// reads as "no banding". The offset is ±1 level: enough to dissolve an edge,
// far too little to read as grain.
//
// NOISE GRADIENTS. Photoshop's other gradient kind: instead of hand-placed
// stops you get a random ramp from a seed, with roughness controlling how many
// bands there are and how hard their edges land. Generating STOPS (rather than
// pixels) is what keeps this cheap — a noise gradient then flows through the
// exact same rendering path as every other gradient, including dither, angle
// smoothing and the fill-layer and text-fill code that already exist.

import type { GradientStop } from "./tools";

/* --------------------------------- dither -------------------------------- */

/**
 * Ordered 8×8 Bayer matrix, normalized to −0.5…+0.5.
 *
 * Ordered rather than random on purpose: a fixed pattern is *stable*, so a
 * gradient dithers identically every time it is composited. Random noise would
 * shimmer whenever the layer re-rendered, which on a fill layer (re-rendered on
 * every composite) would be very visible.
 */
export const BAYER_8 = (() => {
  const m = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      // Standard recursive construction, via bit interleaving of x^y and y.
      let v = 0;
      let mask = 4;
      let bit = 0;
      const xc = x ^ y;
      while (mask) {
        v |= ((xc & mask) ? 1 : 0) << bit;
        bit++;
        v |= ((y & mask) ? 1 : 0) << bit;
        bit++;
        mask >>= 1;
      }
      m[y * 8 + x] = v / 64 - 0.5 + 1 / 128;
    }
  }
  return m;
})();

/**
 * The dither offset for a pixel, in 0–255 levels — ±`strength` at the extremes.
 *
 * The matrix is normalized to ±0.5, so it is doubled here: an offset that never
 * reaches a whole level would be a placebo, because the buffer it is added to is
 * already quantized and `Uint8ClampedArray` rounds on assignment. Working
 * post-quantization cannot recover the precision the gradient already lost —
 * what it does is break the CONTOUR between two levels into a stipple, which is
 * what reads as "no banding".
 */
export const ditherOffset = (x: number, y: number, strength = 1): number =>
  BAYER_8[(y & 7) * 8 + (x & 7)] * 2 * strength;

/**
 * Dither an RGBA buffer in place over a rectangle. Only the colour channels
 * move — nudging alpha would make a gradient's soft edge crawl.
 *
 * `strength` is in 8-bit levels; 1 spreads a band over one level, which is the
 * whole point. Fully transparent pixels are skipped so a dither can never
 * introduce colour where there is nothing.
 */
export function ditherRgba(
  data: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  strength = 1,
): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.floor(rect.x + rect.w);
  const y1 = Math.floor(rect.y + rect.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const d = ditherOffset(x, y, strength);
      data[i] += d;
      data[i + 1] += d;
      data[i + 2] += d;
    }
  }
}

/* ----------------------------- noise gradients ---------------------------- */

export type NoiseModel = "rgb" | "hsb";

export interface NoiseGradient {
  /** Any 32-bit value; the same seed always yields the same ramp. */
  seed: number;
  /** 0–100. Higher = more bands with harder edges. */
  roughness: number;
  model: NoiseModel;
  /** Keep colours out of the over-saturated corners of the space. */
  restrict: boolean;
  /** Let the ramp fade as well as change colour. */
  transparency: boolean;
}

export const DEFAULT_NOISE: NoiseGradient = {
  seed: 1,
  roughness: 50,
  model: "rgb",
  restrict: true,
  transparency: false,
};

/** Deterministic PRNG (mulberry32) — a seed must reproduce its ramp exactly,
 *  or a saved document would open with a different gradient than it was made
 *  with. `Math.random` is unusable here for that reason alone. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number): string => to255(v).toString(16).padStart(2, "0");

/** HSB (0–1 each) → r,g,b 0–255. */
export function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = b * (1 - s);
  const q = b * (1 - f * s);
  const t = b * (1 - (1 - f) * s);
  const [r, g, bl] = [
    [b, t, p],
    [q, b, p],
    [p, b, t],
    [p, q, b],
    [t, p, b],
    [b, p, q],
  ][i % 6];
  return [to255(r * 255), to255(g * 255), to255(bl * 255)];
}

/** How many colour bands a roughness produces. */
export const noiseBands = (roughness: number): number =>
  Math.max(2, Math.min(32, Math.round(2 + (Math.max(0, Math.min(100, roughness)) / 100) * 22)));

/**
 * Build the stop list for a noise gradient.
 *
 * Above the halfway mark roughness also HARDENS the ramp: each band gets a
 * second stop just before the next one, so the colour holds flat and then
 * steps — which is what makes a high-roughness noise gradient read as stripes
 * rather than as mush.
 */
export function buildNoiseStops(spec: NoiseGradient): GradientStop[] {
  const rough = Math.max(0, Math.min(100, spec.roughness));
  const bands = noiseBands(rough);
  const rnd = mulberry32(spec.seed || 1);
  const hard = rough > 50;
  // 0 at roughness 50 → 1 at 100: how much of each band holds its colour flat.
  const hold = hard ? Math.min(0.95, ((rough - 50) / 50) * 0.9) : 0;

  const colourAt = (): string => {
    let r: number;
    let g: number;
    let b: number;
    if (spec.model === "hsb") {
      const h = rnd();
      const s = spec.restrict ? 0.35 + rnd() * 0.45 : rnd();
      const v = spec.restrict ? 0.35 + rnd() * 0.5 : rnd();
      [r, g, b] = hsbToRgb(h, s, v);
    } else {
      const span = spec.restrict ? [40, 215] : [0, 255];
      const pick = () => span[0] + rnd() * (span[1] - span[0]);
      r = pick();
      g = pick();
      b = pick();
    }
    const a = spec.transparency ? to255(60 + rnd() * 195) : 255;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`;
  };

  const stops: GradientStop[] = [];
  for (let i = 0; i < bands; i++) {
    const pos = bands === 1 ? 0 : i / (bands - 1);
    const colour = colourAt();
    stops.push({ color: colour, pos });
    if (hold > 0 && i < bands - 1) {
      // Hold this colour almost to the next band, then let it step.
      const next = (i + 1) / (bands - 1);
      stops.push({ color: colour, pos: pos + (next - pos) * hold });
    }
  }
  return stops;
}

/** Validate a noise spec read from a file. */
export function sanitizeNoise(raw: unknown): NoiseGradient | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Partial<NoiseGradient>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
  return {
    seed: num(o.seed, 1, 0, 0xffffffff),
    roughness: num(o.roughness, DEFAULT_NOISE.roughness, 0, 100),
    model: o.model === "hsb" ? "hsb" : "rgb",
    restrict: o.restrict !== false,
    transparency: o.transparency === true,
  };
}
