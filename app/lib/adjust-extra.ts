// The "extra" adjustment-layer types (TODO §4 "more adjustment types"):
// Hue/Saturation with per-range targeting, Selective Color, Gradient Map,
// Channel Mixer, Color Lookup (.cube LUT import), Invert and Equalize.
//
// Pure, dependency-free pixel math. Every type except Equalize is strictly
// per-pixel (safe for the engine's region-scoped / tiled recompute paths);
// Equalize depends on the WHOLE image's histogram, and the engine must treat
// it as non-region-scopable (see paint.ts specRegionScopable).
//
// The byte-level cores (`…Bytes`) exist so the math is verifiable in Node;
// `applyExtraAdjustment` is the ImageData wrapper the engine uses.

import { parseColor } from "./color";
import type { GradientStop } from "./tools";

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

/** Per-range Hue/Saturation values (hue −180..180, sat/light −100..100). */
export interface HueSatRange {
  hue: number;
  sat: number;
  light: number;
}

/** Hue/Saturation with per-range targeting: ranges[0] = Master, then the six
 *  colour ranges (reds, yellows, greens, cyans, blues, magentas) with a
 *  feathered hue-wheel membership. */
export interface HueSatAdjustment {
  type: "huesat";
  ranges: HueSatRange[]; // length 7: [master, R, Y, G, C, B, M]
}

export const SELECTIVE_RANGES = [
  "reds",
  "yellows",
  "greens",
  "cyans",
  "blues",
  "magentas",
  "whites",
  "neutrals",
  "blacks",
] as const;
export type SelectiveRangeName = (typeof SELECTIVE_RANGES)[number];

/** CMYK deltas for one selective-colour range (−100..100). */
export interface SelectiveRange {
  c: number;
  m: number;
  y: number;
  k: number;
}

/** Selective Color (Photoshop-approximate): per-range CMYK adjustments with
 *  relative (proportional to the current component) or absolute amounts. */
export interface SelectiveColorAdjustment {
  type: "selective";
  relative: boolean;
  ranges: Record<SelectiveRangeName, SelectiveRange>;
}

/** Gradient Map: composite luminance looked up through a gradient. */
export interface GradientMapAdjustment {
  type: "gradientmap";
  stops: GradientStop[];
  reverse: boolean;
}

/** One output channel's mix (percentages −200..200; k = constant −100..100). */
export interface ChannelMixerChannel {
  r: number;
  g: number;
  b: number;
  k: number;
}

/** Channel Mixer: each output channel is a linear combination of the input
 *  channels plus a constant. `mono` uses the R row for all three outputs. */
export interface ChannelMixerAdjustment {
  type: "chanmix";
  mono: boolean;
  r: ChannelMixerChannel;
  g: ChannelMixerChannel;
  b: ChannelMixerChannel;
}

/** Color Lookup: a 3D LUT imported from a .cube file (red index fastest). */
export interface ColorLookupAdjustment {
  type: "colorlookup";
  name: string;
  size: number;
  /** size³ RGB triples in 0..1, flattened [r,g,b, r,g,b, …]. */
  table: number[];
}

export interface InvertAdjustment {
  type: "invert";
}

/** Equalize: luminance histogram equalization (NOT per-pixel — whole-image). */
export interface EqualizeAdjustment {
  type: "equalize";
}

export type ExtraAdjustment =
  | HueSatAdjustment
  | SelectiveColorAdjustment
  | GradientMapAdjustment
  | ChannelMixerAdjustment
  | ColorLookupAdjustment
  | InvertAdjustment
  | EqualizeAdjustment;

export type ExtraAdjustmentType = ExtraAdjustment["type"];

export const EXTRA_LABELS: Record<ExtraAdjustmentType, string> = {
  huesat: "Hue / Saturation",
  selective: "Selective Color",
  gradientmap: "Gradient Map",
  chanmix: "Channel Mixer",
  colorlookup: "Color Lookup",
  invert: "Invert",
  equalize: "Equalize",
};

const EXTRA_TYPES = new Set<string>(Object.keys(EXTRA_LABELS));

/** Type guard: is this spec one of the extra adjustment kinds? */
export function isExtraSpec(spec: { type: string }): spec is ExtraAdjustment {
  return EXTRA_TYPES.has(spec.type);
}

export const HUESAT_RANGE_NAMES = ["Master", "Reds", "Yellows", "Greens", "Cyans", "Blues", "Magentas"];

const neutralSelective = (): Record<SelectiveRangeName, SelectiveRange> => {
  const out = {} as Record<SelectiveRangeName, SelectiveRange>;
  for (const r of SELECTIVE_RANGES) out[r] = { c: 0, m: 0, y: 0, k: 0 };
  return out;
};

/** A fresh neutral spec for each type (colorlookup needs a parsed LUT instead). */
export function defaultExtra(type: Exclude<ExtraAdjustmentType, "colorlookup">): ExtraAdjustment {
  switch (type) {
    case "huesat":
      return { type: "huesat", ranges: Array.from({ length: 7 }, () => ({ hue: 0, sat: 0, light: 0 })) };
    case "selective":
      return { type: "selective", relative: true, ranges: neutralSelective() };
    case "gradientmap":
      return {
        type: "gradientmap",
        reverse: false,
        stops: [
          { color: "#000000ff", pos: 0 },
          { color: "#ffffffff", pos: 1 },
        ],
      };
    case "chanmix":
      return {
        type: "chanmix",
        mono: false,
        r: { r: 100, g: 0, b: 0, k: 0 },
        g: { r: 0, g: 100, b: 0, k: 0 },
        b: { r: 0, g: 0, b: 100, k: 0 },
      };
    case "invert":
      return { type: "invert" };
    case "equalize":
      return { type: "equalize" };
  }
}

/** True when the spec provably changes nothing (skip the whole pass). */
export function extraIsDefault(spec: ExtraAdjustment): boolean {
  switch (spec.type) {
    case "huesat":
      return spec.ranges.every((r) => !r.hue && !r.sat && !r.light);
    case "selective":
      return SELECTIVE_RANGES.every((n) => {
        const r = spec.ranges[n];
        return !r || (!r.c && !r.m && !r.y && !r.k);
      });
    case "chanmix":
      return (
        !spec.mono &&
        spec.r.r === 100 && !spec.r.g && !spec.r.b && !spec.r.k &&
        spec.g.g === 100 && !spec.g.r && !spec.g.b && !spec.g.k &&
        spec.b.b === 100 && !spec.b.r && !spec.b.g && !spec.b.k
      );
    default:
      return false; // gradient map / LUT / invert / equalize always transform
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const clamp255 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n);
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Rec.709 luma of byte channels (0..255). */
const lumaOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// (RGB↔HSL math is inlined scalar inside hueSatBytes — the per-pixel tuple
// returns of the old helper pair were a measurable allocation cost there.)

// ---------------------------------------------------------------------------
// Per-type byte cores
// ---------------------------------------------------------------------------

export function invertBytes(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
}

/** Luminance histogram equalization: remap each pixel's luma through the CDF,
 *  scaling RGB to preserve colour. Whole-image math — never region-scope it. */
export function equalizeBytes(d: Uint8ClampedArray): void {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    hist[Math.round(lumaOf(d[i], d[i + 1], d[i + 2]))]++;
    total++;
  }
  if (!total) return;
  // cdf(v) scaled so the darkest occupied bin maps to 0 and the full count to 255.
  const map = new Float32Array(256);
  let cum = 0;
  let cumMin = -1;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cumMin < 0 && cum > 0) cumMin = cum;
    map[v] = cum;
  }
  if (total <= cumMin) return; // one occupied luminance bin — nothing to spread
  const denom = total - cumMin;
  for (let v = 0; v < 256; v++) map[v] = ((map[v] - cumMin) / denom) * 255;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const l = lumaOf(d[i], d[i + 1], d[i + 2]);
    const target = map[Math.round(l)];
    if (l < 0.5) {
      // Black pixels have no colour to scale — set them to the mapped grey.
      d[i] = d[i + 1] = d[i + 2] = clamp255(Math.round(target));
      continue;
    }
    const scale = target / l;
    d[i] = clamp255(Math.round(d[i] * scale));
    d[i + 1] = clamp255(Math.round(d[i + 1] * scale));
    d[i + 2] = clamp255(Math.round(d[i + 2] * scale));
  }
}

/** Hue-wheel membership for the six colour ranges (centres 0/60/…/300):
 *  full within ±15°, feathering to 0 at ±45° — adjacent ranges cross-fade so
 *  the weights partition the wheel. */
export function hueRangeWeight(h: number, centre: number): number {
  let dist = Math.abs(h - centre);
  if (dist > 180) dist = 360 - dist;
  if (dist <= 15) return 1;
  if (dist >= 45) return 0;
  return 1 - (dist - 15) / 30;
}

const HUESAT_CENTRES = [0, 60, 120, 180, 240, 300];

export function hueSatBytes(d: Uint8ClampedArray, spec: HueSatAdjustment): void {
  const ranges = spec.ranges;
  const master = ranges[0] ?? { hue: 0, sat: 0, light: 0 };
  const bands = HUESAT_CENTRES.map((c, i) => ({
    centre: c,
    r: ranges[i + 1] ?? { hue: 0, sat: 0, light: 0 },
  })).filter((b) => b.r.hue || b.r.sat || b.r.light);
  const masterActive = !!(master.hue || master.sat || master.light);
  // HSL round-trip inlined scalar — this loop runs per pixel of the document.
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const rn = d[i] / 255;
    const gn = d[i + 1] / 255;
    const bn = d[i + 2] / 255;
    const mx = Math.max(rn, gn, bn);
    const mn = Math.min(rn, gn, bn);
    let l = (mx + mn) / 2;
    const dd = mx - mn;
    let h = 0;
    let s = 0;
    if (dd !== 0) {
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      if (mx === rn) h = ((gn - bn) / dd) % 6;
      else if (mx === gn) h = (bn - rn) / dd + 2;
      else h = (rn - gn) / dd + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    let dh = masterActive ? master.hue : 0;
    let ds = masterActive ? master.sat : 0;
    let dl = masterActive ? master.light : 0;
    // Grey pixels have no hue — colour ranges never target them.
    if (s > 0 && bands.length) {
      for (const b of bands) {
        const w = hueRangeWeight(h, b.centre);
        if (w <= 0) continue;
        dh += b.r.hue * w;
        ds += b.r.sat * w;
        dl += b.r.light * w;
      }
    }
    if (!dh && !ds && !dl) continue;
    h += dh;
    const dsn = Math.max(-100, Math.min(100, ds)) / 100;
    s = clamp01(dsn >= 0 ? s + (1 - s) * dsn : s * (1 + dsn));
    const dln = Math.max(-100, Math.min(100, dl)) / 100;
    l = clamp01(dln >= 0 ? l + (1 - l) * dln : l * (1 + dln));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (hp < 1) {
      r1 = c;
      g1 = x;
    } else if (hp < 2) {
      r1 = x;
      g1 = c;
    } else if (hp < 3) {
      g1 = c;
      b1 = x;
    } else if (hp < 4) {
      g1 = x;
      b1 = c;
    } else if (hp < 5) {
      r1 = x;
      b1 = c;
    } else {
      r1 = c;
      b1 = x;
    }
    const m = l - c / 2;
    d[i] = clamp255(Math.round((r1 + m) * 255));
    d[i + 1] = clamp255(Math.round((g1 + m) * 255));
    d[i + 2] = clamp255(Math.round((b1 + m) * 255));
  }
}

/** Membership weights for the nine selective-colour ranges (0..1). */
export function selectiveWeights(r: number, g: number, b: number): number[] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return [
    Math.max(0, r - Math.max(g, b)) / 255, // reds
    Math.max(0, Math.min(r, g) - b) / 255, // yellows
    Math.max(0, g - Math.max(r, b)) / 255, // greens
    Math.max(0, Math.min(g, b) - r) / 255, // cyans
    Math.max(0, b - Math.max(r, g)) / 255, // blues
    Math.max(0, Math.min(r, b) - g) / 255, // magentas
    Math.max(0, 2 * mn - 255) / 255, // whites
    Math.max(0, 1 - (Math.abs(mx - 128) + Math.abs(mn - 128)) / 255), // neutrals
    Math.max(0, 255 - 2 * mx) / 255, // blacks
  ];
}

/** One range's membership weight — same math as selectiveWeights, evaluated
 *  only for the ranges a spec actually uses (no 9-slot array per pixel). */
function selectiveWeightOf(idx: number, r: number, g: number, b: number): number {
  switch (idx) {
    case 0: return Math.max(0, r - Math.max(g, b)) / 255; // reds
    case 1: return Math.max(0, Math.min(r, g) - b) / 255; // yellows
    case 2: return Math.max(0, g - Math.max(r, b)) / 255; // greens
    case 3: return Math.max(0, Math.min(g, b) - r) / 255; // cyans
    case 4: return Math.max(0, b - Math.max(r, g)) / 255; // blues
    case 5: return Math.max(0, Math.min(r, b) - g) / 255; // magentas
    case 6: return Math.max(0, 2 * Math.min(r, g, b) - 255) / 255; // whites
    case 7: {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      return Math.max(0, 1 - (Math.abs(mx - 128) + Math.abs(mn - 128)) / 255); // neutrals
    }
    default: return Math.max(0, 255 - 2 * Math.max(r, g, b)) / 255; // blacks
  }
}

export function selectiveColorBytes(d: Uint8ClampedArray, spec: SelectiveColorAdjustment): void {
  // Pre-resolve the active ranges once.
  const active: { idx: number; c: number; m: number; y: number; k: number }[] = [];
  SELECTIVE_RANGES.forEach((name, idx) => {
    const r = spec.ranges[name];
    if (r && (r.c || r.m || r.y || r.k)) active.push({ idx, c: r.c / 100, m: r.m / 100, y: r.y / 100, k: r.k / 100 });
  });
  if (!active.length) return;
  const rel = spec.relative;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    let dr = 0;
    let dg = 0;
    let db = 0;
    for (const a of active) {
      const wt = selectiveWeightOf(a.idx, r, g, b);
      if (wt <= 0) continue;
      // +cyan removes red (adds its complement); +black darkens every channel.
      dr -= (a.c + a.k) * wt * (rel ? r : 255);
      dg -= (a.m + a.k) * wt * (rel ? g : 255);
      db -= (a.y + a.k) * wt * (rel ? b : 255);
    }
    d[i] = clamp255(Math.round(r + dr));
    d[i + 1] = clamp255(Math.round(g + dg));
    d[i + 2] = clamp255(Math.round(b + db));
  }
}

/** Pre-sorted, pre-parsed sampler over a stop list — the LUT build samples 256
 *  times, so sorting the stops and parsing the colours must happen ONCE, not
 *  per sample. */
function stopSampler(stops: GradientStop[]): (t: number) => [number, number, number] {
  const sorted = [...stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => ({ pos: s.pos, c: parseColor(s.color) }));
  return (t: number): [number, number, number] => {
    if (!sorted.length) return [0, 0, 0];
    const first = sorted[0];
    if (t <= first.pos) return [first.c.r, first.c.g, first.c.b];
    for (let i = 1; i < sorted.length; i++) {
      if (t <= sorted[i].pos) {
        const a = sorted[i - 1].c;
        const b = sorted[i].c;
        const span = sorted[i].pos - sorted[i - 1].pos;
        const f = span > 0 ? (t - sorted[i - 1].pos) / span : 1;
        return [a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f];
      }
    }
    const c = sorted[sorted.length - 1].c;
    return [c.r, c.g, c.b];
  };
}

/** Sample a stop list at t (0..1) — sRGB lerp between neighbouring stops. */
export function sampleStops(stops: GradientStop[], t: number): [number, number, number] {
  return stopSampler(stops)(t);
}

/** The 256-entry RGB lookup a gradient-map spec compiles to. */
export function gradientMapLUT(spec: GradientMapAdjustment): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const sample = stopSampler(spec.stops);
  for (let v = 0; v < 256; v++) {
    const t = spec.reverse ? 1 - v / 255 : v / 255;
    const [r, g, b] = sample(t);
    lut[v * 3] = r;
    lut[v * 3 + 1] = g;
    lut[v * 3 + 2] = b;
  }
  return lut;
}

export function gradientMapBytes(d: Uint8ClampedArray, spec: GradientMapAdjustment): void {
  const lut = gradientMapLUT(spec);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const v = Math.round(lumaOf(d[i], d[i + 1], d[i + 2])) * 3;
    d[i] = lut[v];
    d[i + 1] = lut[v + 1];
    d[i + 2] = lut[v + 2];
  }
}

export function channelMixerBytes(d: Uint8ClampedArray, spec: ChannelMixerAdjustment): void {
  const rows = spec.mono ? [spec.r, spec.r, spec.r] : [spec.r, spec.g, spec.b];
  // Twelve hoisted scalars — no nested array indexing inside the pixel loop.
  const m00 = rows[0].r / 100, m01 = rows[0].g / 100, m02 = rows[0].b / 100, m03 = (rows[0].k / 100) * 255;
  const m10 = rows[1].r / 100, m11 = rows[1].g / 100, m12 = rows[1].b / 100, m13 = (rows[1].k / 100) * 255;
  const m20 = rows[2].r / 100, m21 = rows[2].g / 100, m22 = rows[2].b / 100, m23 = (rows[2].k / 100) * 255;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    d[i] = clamp255(Math.round(r * m00 + g * m01 + b * m02 + m03));
    d[i + 1] = clamp255(Math.round(r * m10 + g * m11 + b * m12 + m13));
    d[i + 2] = clamp255(Math.round(r * m20 + g * m21 + b * m22 + m23));
  }
}

/** Trilinear 3D-LUT application (.cube semantics: red index varies fastest). */
export function colorLookupBytes(d: Uint8ClampedArray, spec: ColorLookupAdjustment): void {
  const n = spec.size;
  if (n < 2 || spec.table.length < n * n * n * 3) return;
  const t = spec.table;
  const scale = (n - 1) / 255;
  const n3 = n * 3; // +1 in y
  const nn3 = n * n * 3; // +1 in z
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const fx = d[i] * scale;
    const fy = d[i + 1] * scale;
    const fz = d[i + 2] * scale;
    const x0 = Math.min(n - 2, Math.floor(fx));
    const y0 = Math.min(n - 2, Math.floor(fy));
    const z0 = Math.min(n - 2, Math.floor(fz));
    const dx = fx - x0;
    const dy = fy - y0;
    const dz = fz - z0;
    // The 8 cell-corner offsets, computed once per pixel (not per channel).
    const i000 = ((z0 * n + y0) * n + x0) * 3;
    const i100 = i000 + 3;
    const i010 = i000 + n3;
    const i110 = i010 + 3;
    const i001 = i000 + nn3;
    const i101 = i001 + 3;
    const i011 = i001 + n3;
    const i111 = i011 + 3;
    for (let ch = 0; ch < 3; ch++) {
      const c000 = t[i000 + ch];
      const c100 = t[i100 + ch];
      const c010 = t[i010 + ch];
      const c110 = t[i110 + ch];
      const c001 = t[i001 + ch];
      const c101 = t[i101 + ch];
      const c011 = t[i011 + ch];
      const c111 = t[i111 + ch];
      const c00 = c000 + (c100 - c000) * dx;
      const c10 = c010 + (c110 - c010) * dx;
      const c01 = c001 + (c101 - c001) * dx;
      const c11 = c011 + (c111 - c011) * dx;
      const c0 = c00 + (c10 - c00) * dy;
      const c1 = c01 + (c11 - c01) * dy;
      d[i + ch] = clamp255(Math.round((c0 + (c1 - c0) * dz) * 255));
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Apply an extra adjustment to bytes in place. */
export function applyExtraToBytes(d: Uint8ClampedArray, spec: ExtraAdjustment): void {
  switch (spec.type) {
    case "invert":
      return invertBytes(d);
    case "equalize":
      return equalizeBytes(d);
    case "huesat":
      return hueSatBytes(d, spec);
    case "selective":
      return selectiveColorBytes(d, spec);
    case "gradientmap":
      return gradientMapBytes(d, spec);
    case "chanmix":
      return channelMixerBytes(d, spec);
    case "colorlookup":
      return colorLookupBytes(d, spec);
  }
}

/** ImageData wrapper (mutates in place, returns the same object). */
export function applyExtraAdjustment(img: ImageData, spec: ExtraAdjustment): ImageData {
  applyExtraToBytes(img.data, spec);
  return img;
}

// (Region/tile safety note: every extra kind is strictly per-pixel EXCEPT
// Equalize, whose whole-image histogram the engine special-cases directly —
// see paint.ts drawAdjustment/drawAdjustmentTiled.)

// ---------------------------------------------------------------------------
// .cube LUT parsing
// ---------------------------------------------------------------------------

/** Parse an Adobe/IRIDAS .cube 3D LUT. Returns the LUT or a user-facing error. */
export function parseCubeLUT(
  text: string,
  fallbackName: string,
): { lut?: { name: string; size: number; table: number[] }; error?: string } {
  let name = fallbackName;
  let size = 0;
  const table: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (/^TITLE\s/i.test(line)) {
      const m = line.match(/^TITLE\s+"?([^"]*)"?$/i);
      if (m && m[1].trim()) name = m[1].trim();
      continue;
    }
    if (/^LUT_1D_SIZE\s/i.test(line)) return { error: "1D .cube LUTs aren't supported — use a 3D LUT (LUT_3D_SIZE)." };
    if (/^LUT_3D_SIZE\s/i.test(line)) {
      size = parseInt(line.split(/\s+/)[1], 10);
      if (!Number.isFinite(size) || size < 2 || size > 129) return { error: "Unsupported LUT_3D_SIZE (expected 2–129)." };
      continue;
    }
    if (/^DOMAIN_(MIN|MAX)\s/i.test(line)) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      const isMin = /MIN/i.test(line);
      const okv = isMin ? 0 : 1;
      if (parts.length !== 3 || parts.some((v) => v !== okv))
        return { error: "Only the default 0–1 LUT domain is supported." };
      continue;
    }
    if (/^LUT_3D_INPUT_RANGE|^LUT_IN_VIDEO_RANGE|^LUT_OUT_VIDEO_RANGE/i.test(line)) continue; // tolerated extensions
    const parts = line.split(/\s+/);
    if (parts.length === 3) {
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b))
        return { error: "Malformed .cube data row." };
      table.push(r, g, b);
      continue;
    }
    return { error: `Unrecognized .cube line: "${line.slice(0, 40)}"` };
  }
  if (!size) return { error: "Missing LUT_3D_SIZE — not a 3D .cube LUT." };
  if (table.length !== size * size * size * 3)
    return { error: `Expected ${size * size * size} data rows, found ${table.length / 3}.` };
  return { lut: { name, size, table } };
}
