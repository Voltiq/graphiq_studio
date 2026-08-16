/**
 * Brush texture and dual tip — the two remaining tip-shaping options.
 *
 * Both work the same way: they multiply a dab's coverage, so a stroke picks up
 * a surface grain or breaks into bristles instead of laying down a smooth disc.
 * Neither touches colour, and both apply to the ordinary brush (and the pencil
 * and eraser, which share the tip path), not just the mixer.
 *
 * TEXTURE IS ANCHORED TO THE CANVAS, NOT THE DAB. `texel(pattern, x, y, …)` is a
 * function of DOCUMENT coordinates, so overlapping dabs hit the same grain and
 * the stroke reads as paint catching on a surface. Anchoring it to the tip
 * instead — the obvious shortcut, since the tip is what gets baked — stamps the
 * same little swatch over and over, which looks like a rubber stamp rather than
 * a texture. That property is what the tests below are mostly checking.
 *
 * The patterns are PROCEDURAL rather than image assets: a handful of functions
 * with no files to load, no pattern picker to build, and nothing to serialize
 * beyond a name. That is also the honest boundary — a user-supplied pattern
 * library is a separate feature (the same picker fill layers and pattern text
 * fills are waiting on).
 *
 * Pure and DOM-free.
 */

export const TEXTURE_PATTERNS = ["canvas", "burlap", "grain", "speckle", "grid"] as const;
export type TexturePatternId = (typeof TEXTURE_PATTERNS)[number];

export const TEXTURE_LABELS: Record<TexturePatternId, string> = {
  canvas: "Canvas",
  burlap: "Burlap",
  grain: "Grain",
  speckle: "Speckle",
  grid: "Grid",
};

export interface TextureSettings {
  enabled: boolean;
  pattern: TexturePatternId;
  /** Pattern size, 10–400%. */
  scale: number;
  /** How deeply the texture bites into the dab, 0–100. */
  depth: number;
  invert: boolean;
}

export const DEFAULT_TEXTURE: TextureSettings = {
  enabled: false,
  pattern: "canvas",
  scale: 100,
  depth: 50,
  invert: false,
};

export interface DualTipSettings {
  enabled: boolean;
  /** Secondary tip diameter as a % of the primary. */
  size: number;
  /** Secondary tip edge softness, 0–100. */
  hardness: number;
  /** How far the secondary dabs are flung from the centre, as a % of the radius. */
  scatter: number;
  /** How many secondary dabs make up one primary dab. */
  count: number;
}

/**
 * Sparse on purpose. Six secondary dabs at 45% of the primary radius overlap
 * into a near-solid disc, so switching the option on merely made the stroke
 * slightly narrower — visually indistinguishable from turning the size down,
 * and measured as exactly that. Fewer, smaller, further-flung dabs leave gaps
 * BETWEEN them, which is what separates bristles from a plain round tip.
 */
export const DEFAULT_DUAL_TIP: DualTipSettings = {
  enabled: false,
  size: 22,
  hardness: 60,
  scatter: 120,
  count: 4,
};

/**
 * How many distinct bristle patterns a brush can have. ONE is chosen per stroke.
 *
 * Cycling them per DAB was the first attempt and it was wrong: at normal spacing
 * consecutive dabs overlap by ~90%, so eight different patterns simply filled in
 * each other's gaps and the stroke came out as solid as an ordinary brush —
 * measured identical, pixel for pixel. Holding one pattern for the whole stroke
 * makes the gaps line up dab to dab into continuous streaks, which is both
 * visible and what a real bristle brush actually does. Successive strokes pick
 * different patterns, so a repeated stroke does not trace the same bristles.
 */
export const DUAL_VARIANTS = 8;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Deterministic hash → [0,1). Integer inputs; no state, so it is testable. */
function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothed value noise on the unit grid. */
function valueNoise(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx); // smoothstep
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * Coverage multiplier of a pattern at a DOCUMENT point, before depth/invert.
 *
 * 1 = the surface is proud here and takes full paint; 0 = a pit the brush skips.
 */
export function texel(pattern: TexturePatternId, x: number, y: number, scale: number): number {
  // Scale is a size in percent, so a bigger number means a coarser pattern.
  const s = Math.max(0.1, scale / 100);
  const u = x / (8 * s);
  const v = y / (8 * s);
  switch (pattern) {
    case "canvas": {
      // A woven crosshatch: two perpendicular thread sets, gently noised so it
      // does not look like a printed grid.
      const warp = 0.5 + 0.5 * Math.sin(u * Math.PI * 2);
      const weft = 0.5 + 0.5 * Math.sin(v * Math.PI * 2);
      return clamp01(0.35 + 0.5 * Math.max(warp, weft) + 0.15 * (valueNoise(u * 2, v * 2, 11) - 0.5));
    }
    case "burlap": {
      // Coarser and more irregular than canvas: wider threads, more noise.
      const warp = 0.5 + 0.5 * Math.sin(u * Math.PI);
      const weft = 0.5 + 0.5 * Math.sin(v * Math.PI * 1.13);
      const n = valueNoise(u, v, 23);
      return clamp01(0.15 + 0.55 * (warp * 0.6 + weft * 0.6) + 0.4 * (n - 0.5));
    }
    case "grain":
      // Smooth clouded variation — paper rather than weave.
      return clamp01(
        0.25 + 0.75 * (0.6 * valueNoise(u, v, 5) + 0.4 * valueNoise(u * 2.7, v * 2.7, 7)),
      );
    case "speckle": {
      // Hard, per-cell dots: the pattern with the sharpest bite.
      const n = hash2(Math.floor(u * 3), Math.floor(v * 3), 31);
      return n < 0.35 ? 0 : 1;
    }
    case "grid": {
      const gx = Math.abs(((u % 1) + 1) % 1 - 0.5) * 2;
      const gy = Math.abs(((v % 1) + 1) % 1 - 0.5) * 2;
      return Math.min(gx, gy) < 0.18 ? 0.1 : 1;
    }
  }
}

/**
 * The alpha multiplier a textured brush applies at a document point.
 *
 * Depth 0 returns exactly 1 everywhere — the texture is off, not "very faint",
 * so turning depth down is a real bypass rather than a slow fade into noise.
 */
export function textureAlpha(t: TextureSettings, x: number, y: number): number {
  if (!t.enabled) return 1;
  const depth = clamp01(t.depth / 100);
  if (depth <= 0) return 1;
  const raw = texel(t.pattern, x, y, t.scale);
  const v = t.invert ? 1 - raw : raw;
  // Lerp from "no texture" toward the pattern, so depth is a strength knob.
  return clamp01(1 - depth * (1 - v));
}

/**
 * One dual-tip variant's coverage mask, `size`×`size`, values 0–1.
 *
 * The secondary dabs are scattered on a ring rather than uniformly in the disc:
 * a uniform scatter clumps in the middle (there is more area near the centre in
 * polar terms only if you weight by r), and the middle is exactly where the
 * primary tip is already solid, so those dabs do nothing visible. Pushing them
 * outward is what actually breaks the edge up.
 */
export function dualMask(
  size: number,
  primaryR: number,
  d: DualTipSettings,
  /** Which bristle pattern — one is chosen per stroke, not per dab. */
  variant: number,
): Float32Array {
  const out = new Float32Array(size * size);
  if (!d.enabled || d.count < 1) {
    out.fill(1);
    return out;
  }
  const centre = size / 2;
  const r2 = Math.max(0.5, (primaryR * Math.max(1, Math.min(400, d.size))) / 100);
  const inner = clamp01(d.hardness / 100) * r2;
  const span = Math.max(0.0001, r2 - inner);
  const spread = (clamp01(d.scatter / 100) * primaryR);

  for (let k = 0; k < d.count; k++) {
    // Deterministic per (variant, k): the same variant always bakes the same
    // mask, which is what makes cycling them reproducible and testable.
    const a = hash2(variant, k, 101) * Math.PI * 2;
    const rr = spread * (0.35 + 0.65 * hash2(variant, k, 202));
    const cx = centre + Math.cos(a) * rr;
    const cy = centre + Math.sin(a) * rr;
    const x0 = Math.max(0, Math.floor(cx - r2));
    const x1 = Math.min(size - 1, Math.ceil(cx + r2));
    const y0 = Math.max(0, Math.floor(cy - r2));
    const y1 = Math.min(size - 1, Math.ceil(cy + r2));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        const v = dist <= inner ? 1 : dist >= r2 ? 0 : 1 - (dist - inner) / span;
        if (v > 0) {
          const i = py * size + px;
          // Union: the secondary dabs overlap into one bristle cluster rather
          // than multiplying each other away to nothing.
          if (v > out[i]) out[i] = v;
        }
      }
    }
  }
  return out;
}

export function sanitizeTexture(raw: unknown): TextureSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TEXTURE };
  const o = raw as Partial<TextureSettings>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_TEXTURE.enabled,
    pattern: TEXTURE_PATTERNS.includes(o.pattern as TexturePatternId)
      ? (o.pattern as TexturePatternId)
      : DEFAULT_TEXTURE.pattern,
    scale: num(o.scale, DEFAULT_TEXTURE.scale, 10, 400),
    depth: num(o.depth, DEFAULT_TEXTURE.depth, 0, 100),
    invert: typeof o.invert === "boolean" ? o.invert : DEFAULT_TEXTURE.invert,
  };
}

export function sanitizeDualTip(raw: unknown): DualTipSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DUAL_TIP };
  const o = raw as Partial<DualTipSettings>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_DUAL_TIP.enabled,
    size: num(o.size, DEFAULT_DUAL_TIP.size, 5, 200),
    hardness: num(o.hardness, DEFAULT_DUAL_TIP.hardness, 0, 100),
    scatter: num(o.scatter, DEFAULT_DUAL_TIP.scatter, 0, 200),
    count: Math.round(num(o.count, DEFAULT_DUAL_TIP.count, 1, 32)),
  };
}

/** True when either option would actually change a dab — the engine's fast path. */
export const tipShapingActive = (t?: TextureSettings, d?: DualTipSettings): boolean =>
  !!(t?.enabled && t.depth > 0) || !!(d?.enabled && d.count >= 1);
