// Curves & Levels tone math. Pure: no tree / engine / React knowledge. Both tools
// compile to per-channel 256-entry uint8 LUTs; the engine applies them in one
// typed-array pass. (8-bit only — matches the Canvas2D ImageData bit depth.)

/** Per-channel Levels parameters. */
export interface ChannelParams {
  inBlack: number; // 0–255
  gamma: number; // ~0.1–9.99 midtone; 1 = linear
  inWhite: number; // 0–255 (inWhite > inBlack enforced)
  outBlack: number; // 0–255
  outWhite: number; // 0–255 (may be < outBlack → per-channel negative)
}

/** A Curves control point (0–255 each); the point list is kept sorted by x. */
export interface CurvePoint {
  x: number;
  y: number;
}

export type ChannelKey = "rgb" | "r" | "g" | "b";

/** The non-destructive tone adjustments (added to AdjustmentSpec in adjust.ts). */
export type ToneAdjustment =
  | { type: "levels"; channels: { rgb: ChannelParams; r: ChannelParams; g: ChannelParams; b: ChannelParams } }
  | { type: "curves"; channels: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] } };

export interface ToneLUTs {
  r: Uint8ClampedArray;
  g: Uint8ClampedArray;
  b: Uint8ClampedArray;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Neutral Levels params (identity). */
export const IDENTITY_LEVELS: ChannelParams = {
  inBlack: 0,
  gamma: 1,
  inWhite: 255,
  outBlack: 0,
  outWhite: 255,
};

/** A fresh, identity Levels spec (all four channels neutral). */
export function defaultLevels(): Extract<ToneAdjustment, { type: "levels" }> {
  return {
    type: "levels",
    channels: {
      rgb: { ...IDENTITY_LEVELS },
      r: { ...IDENTITY_LEVELS },
      g: { ...IDENTITY_LEVELS },
      b: { ...IDENTITY_LEVELS },
    },
  };
}

/** Identity curve endpoints. */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 255, y: 255 },
];

/** A fresh, identity Curves spec (linear on all channels). */
export function defaultCurves(): Extract<ToneAdjustment, { type: "curves" }> {
  return {
    type: "curves",
    channels: {
      rgb: IDENTITY_CURVE.map((p) => ({ ...p })),
      r: IDENTITY_CURVE.map((p) => ({ ...p })),
      g: IDENTITY_CURVE.map((p) => ({ ...p })),
      b: IDENTITY_CURVE.map((p) => ({ ...p })),
    },
  };
}

/** Levels → 256-entry LUT. Safe against inWhite==inBlack and extreme gamma. */
export function levelsLUT(p: ChannelParams): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const inB = clamp(p.inBlack, 0, 255);
  const inW = clamp(p.inWhite, 0, 255);
  const span = inW - inB || 1; // min gap of 1 → never divide by zero
  const g = 1 / clamp(p.gamma, 0.01, 9.99);
  const oB = clamp(p.outBlack, 0, 255);
  const oW = clamp(p.outWhite, 0, 255);
  for (let v = 0; v < 256; v++) {
    let t = (v - inB) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = Math.pow(t, g);
    lut[v] = oB + t * (oW - oB);
  }
  return lut;
}

/**
 * Continuous monotone-cubic curve evaluator. Uses the Fritsch–Carlson method
 * (Fritsch & Carlson 1980): compute secant slopes between sorted points, then
 * limit the tangents so the interpolant is monotone (no overshoot). Returns
 * the UNROUNDED value (clamped to [0,255]) at any real x — the graph plots
 * this directly so the drawn curve is smooth; the pixel LUT samples it at the
 * 256 integers. Extends linearly past the end points.
 */
export function curveSampler(points: CurvePoint[]): (x: number) => number {
  // Sort + dedupe by x (a later point at the same x replaces the earlier one).
  const pts = [...points]
    .map((p) => ({ x: clamp(Math.round(p.x), 0, 255), y: clamp(p.y, 0, 255) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, a) => i === 0 || p.x !== a[i - 1].x);
  const n = pts.length;
  if (n === 0) return (x) => clamp(x, 0, 255);
  if (n === 1) return () => pts[0].y;
  // Secant slopes.
  const dx = new Float64Array(n - 1);
  const dy = new Float64Array(n - 1);
  const slope = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    dy[i] = pts[i + 1].y - pts[i].y;
    slope[i] = dy[i] / dx[i];
  }
  // Tangents (Fritsch–Carlson).
  const m = new Float64Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0; // local extremum → flat (keeps monotone)
    else m[i] = (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * slope[i];
      m[i + 1] = tau * b * slope[i];
    }
  }
  return (x: number): number => {
    if (x <= pts[0].x) return clamp(pts[0].y + m[0] * (x - pts[0].x), 0, 255); // linear extension left
    if (x >= pts[n - 1].x) return clamp(pts[n - 1].y + m[n - 1] * (x - pts[n - 1].x), 0, 255); // right
    let seg = 0;
    while (seg < n - 2 && x > pts[seg + 1].x) seg++;
    const h = dx[seg];
    const t = (x - pts[seg].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    // Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return clamp(h00 * pts[seg].y + h10 * h * m[seg] + h01 * pts[seg + 1].y + h11 * h * m[seg + 1], 0, 255);
  };
}

/** Curves → 256-entry LUT: the continuous curve sampled at x = 0..255
 *  (Uint8ClampedArray rounds + clamps, matching what's applied to pixels). */
export function curveLUT(points: CurvePoint[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const f = curveSampler(points);
  for (let v = 0; v < 256; v++) lut[v] = f(v);
  return lut;
}

/** Compose two LUTs: out[v] = channel[composite[v]] (composite applied first). */
export function composeLUT(composite: Uint8ClampedArray, channel: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) out[v] = channel[composite[v]];
  return out;
}

function buildEffective(
  rgb: Uint8ClampedArray,
  r: Uint8ClampedArray,
  g: Uint8ClampedArray,
  b: Uint8ClampedArray,
): ToneLUTs {
  return { r: composeLUT(rgb, r), g: composeLUT(rgb, g), b: composeLUT(rgb, b) };
}

// ---- 16-bit/channel tone path ---------------------------------------------
// The 8-bit LUTs quantize at 256 steps; the high-bit adjustment path (emulated
// working spaces convert once into 16-bit, run the math, and quantize once at
// the end) uses 65 536-entry tables built by sampling the SAME continuous
// evaluators — composed continuously (channel ∘ master) so no intermediate
// 8-bit rounding sneaks back in. Byte v widens to v·257 (0→0, 255→65535).

export interface ToneLUTs16 {
  r: Uint16Array;
  g: Uint16Array;
  b: Uint16Array;
}

/** Continuous Levels evaluator — the levelsLUT formula, unrounded. */
function levelsF(p: ChannelParams): (x: number) => number {
  const inB = clamp(p.inBlack, 0, 255);
  const inW = clamp(p.inWhite, 0, 255);
  const span = inW - inB || 1;
  const g = 1 / clamp(p.gamma, 0.01, 9.99);
  const oB = clamp(p.outBlack, 0, 255);
  const oW = clamp(p.outWhite, 0, 255);
  return (x) => {
    let t = (x - inB) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return oB + Math.pow(t, g) * (oW - oB);
  };
}

/** 65k table of channel(master(x)) over the continuous 0–255 domain. */
function lut16(master: (x: number) => number, channel: (x: number) => number): Uint16Array {
  const out = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const x = i / 257; // exact 0..255 domain (65535/257 = 255)
    let v = master(x);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    v = channel(v);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    out[i] = v * 257 + 0.5;
  }
  return out;
}

export function buildLevelsLUTs16(spec: Extract<ToneAdjustment, { type: "levels" }>): ToneLUTs16 {
  const c = spec.channels;
  const master = levelsF(c.rgb);
  return { r: lut16(master, levelsF(c.r)), g: lut16(master, levelsF(c.g)), b: lut16(master, levelsF(c.b)) };
}

export function buildCurvesLUTs16(spec: Extract<ToneAdjustment, { type: "curves" }>): ToneLUTs16 {
  const c = spec.channels;
  const master = curveSampler(c.rgb);
  return {
    r: lut16(master, curveSampler(c.r)),
    g: lut16(master, curveSampler(c.g)),
    b: lut16(master, curveSampler(c.b)),
  };
}

/** Apply 16-bit LUTs to an RGBA16 buffer in place (alpha untouched). */
export function applyToneLUTs16(d: Uint16Array, luts: ToneLUTs16): void {
  const { r, g, b } = luts;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

export function buildLevelsLUTs(spec: Extract<ToneAdjustment, { type: "levels" }>): ToneLUTs {
  const c = spec.channels;
  return buildEffective(levelsLUT(c.rgb), levelsLUT(c.r), levelsLUT(c.g), levelsLUT(c.b));
}

export function buildCurvesLUTs(spec: Extract<ToneAdjustment, { type: "curves" }>): ToneLUTs {
  const c = spec.channels;
  return buildEffective(curveLUT(c.rgb), curveLUT(c.r), curveLUT(c.g), curveLUT(c.b));
}

/** Apply compiled LUTs to an ImageData in place — single branch-free pass, alpha
 *  untouched. Returns the same ImageData for convenience. */
export function applyToneLUTs(img: ImageData, luts: ToneLUTs): ImageData {
  const d = img.data;
  const { r, g, b } = luts;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
  return img;
}

interface HistLike {
  r: number[];
  g: number[];
  b: number[];
}

/** Per-channel auto contrast stretch: clip `clipPct`% of pixels off each end of
 *  the channel histogram and map that range to 0..255. Flat channels stay neutral. */
export function autoLevels(hist: HistLike, clipPct: number): { r: ChannelParams; g: ChannelParams; b: ChannelParams } {
  const one = (h: number[]): ChannelParams => {
    const total = h.reduce((s, n) => s + n, 0);
    if (total === 0) return { ...IDENTITY_LEVELS };
    const clip = (total * clamp(clipPct, 0, 49)) / 100;
    let lo = 0;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc > clip) {
        lo = v;
        break;
      }
    }
    let hi = 255;
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += h[v];
      if (acc > clip) {
        hi = v;
        break;
      }
    }
    if (hi <= lo) return { ...IDENTITY_LEVELS }; // single spike → no-op
    return { inBlack: lo, gamma: 1, inWhite: hi, outBlack: 0, outWhite: 255 };
  };
  return { r: one(hist.r), g: one(hist.g), b: one(hist.b) };
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Gray eyedropper: solve a per-channel gamma that maps the sampled pixel to a
 *  neutral grey (its own luminance), neutralising a colour cast. Degenerate
 *  samples (0 or 255) fall back to identity for that channel. */
export function solveGrayPoint(sample: RGB): { r: ChannelParams; g: ChannelParams; b: ChannelParams } {
  const target = clamp(0.299 * sample.r + 0.587 * sample.g + 0.114 * sample.b, 1, 254) / 255;
  const one = (v: number): ChannelParams => {
    const s = clamp(v, 1, 254) / 255;
    // s^(1/gamma) = target → 1/gamma = ln(target)/ln(s)
    const g = Math.log(s) !== 0 ? Math.log(target) / Math.log(s) : 1;
    return { ...IDENTITY_LEVELS, gamma: clamp(g, 0.1, 9.99) };
  };
  return { r: one(sample.r), g: one(sample.g), b: one(sample.b) };
}

/** Curve presets (RGB-channel point sets). */
export const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  Linear: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  "Increase Contrast": [
    { x: 0, y: 0 },
    { x: 64, y: 48 },
    { x: 192, y: 207 },
    { x: 255, y: 255 },
  ],
  "Decrease Contrast": [
    { x: 0, y: 0 },
    { x: 64, y: 80 },
    { x: 192, y: 175 },
    { x: 255, y: 255 },
  ],
  Negative: [
    { x: 0, y: 255 },
    { x: 255, y: 0 },
  ],
  "Lighten Midtones": [
    { x: 0, y: 0 },
    { x: 128, y: 160 },
    { x: 255, y: 255 },
  ],
  "Darken Midtones": [
    { x: 0, y: 0 },
    { x: 128, y: 96 },
    { x: 255, y: 255 },
  ],
};
