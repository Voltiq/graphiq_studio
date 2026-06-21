export interface Adjustments {
  // Light
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  // Color
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  // Detail
  sharpen: number;
  clarity: number;
  noise: number;
}

export const DEFAULT_ADJUST: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  sharpen: 0,
  clarity: 0,
  noise: 0,
};

export const FILTERS = ["Original", "Vivid", "Mono", "Noir", "Warm", "Cool", "Vintage", "Fade"];

/** A user-saved adjustment preset (name + full slider values). */
export interface AdjustPreset {
  id: string;
  name: string;
  adjust: Adjustments;
}

/** Each filter is a preset of adjustment values applied on top of the neutral base. */
export const FILTER_PRESETS: Record<string, Partial<Adjustments>> = {
  Original: {},
  Vivid: { vibrance: 40, saturation: 12, contrast: 18 },
  Mono: { saturation: -100, contrast: 6 },
  Noir: { saturation: -100, contrast: 40, blacks: -22, clarity: 22 },
  Warm: { temperature: 35, vibrance: 12 },
  Cool: { temperature: -32, tint: -8, vibrance: 8 },
  Vintage: { temperature: 16, tint: 12, contrast: -12, saturation: -20, blacks: 18, exposure: 5 },
  Fade: { blacks: 24, contrast: -24, saturation: -10, exposure: 6 },
};

export function isDefaultAdjust(a: Adjustments): boolean {
  return (Object.keys(DEFAULT_ADJUST) as (keyof Adjustments)[]).every((k) => a[k] === 0);
}

export function filterToAdjust(name: string): Adjustments {
  return { ...DEFAULT_ADJUST, ...(FILTER_PRESETS[name] ?? {}) };
}

// ---- Filter preset files (.aifp = one preset, .aifpack = a bundle) ----
export const FILTER_EXT = "aifp";
export const FILTER_PACK_EXT = "aifpack";
const ADJUST_KEYS = Object.keys(DEFAULT_ADJUST) as (keyof Adjustments)[];

/** Clamp arbitrary parsed data into a valid Adjustments (unknown keys dropped). */
export function coerceAdjust(raw: unknown): Adjustments {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_ADJUST };
  for (const k of ADJUST_KEYS) {
    const v = typeof src[k] === "number" ? (src[k] as number) : Number(src[k]);
    if (Number.isFinite(v)) out[k] = Math.max(-100, Math.min(100, Math.round(v)));
  }
  return out;
}

/** Serialize one preset to an .aifp file body. */
export function presetToFileJSON(p: AdjustPreset): string {
  return JSON.stringify({ format: "aperture-filter", version: 1, name: p.name, adjust: p.adjust }, null, 2);
}

/** Serialize several presets to an .aifpack bundle body. */
export function packToFileJSON(presets: AdjustPreset[]): string {
  return JSON.stringify(
    { format: "aperture-filter-pack", version: 1, presets: presets.map((p) => ({ name: p.name, adjust: p.adjust })) },
    null,
    2,
  );
}

export interface ParsedPreset {
  name: string;
  adjust: Adjustments;
}

/**
 * Parse a filter file's text into presets. Tolerant of single presets, bundles,
 * bare arrays, and bare adjust objects — anything with at least one known
 * adjustment key is accepted; everything else is ignored.
 */
export function parsePresetFileText(text: string): ParsedPreset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: ParsedPreset[] = [];
  const one = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const adjustSrc = (o.adjust && typeof o.adjust === "object" ? o.adjust : o) as Record<string, unknown>;
    if (!ADJUST_KEYS.some((k) => k in adjustSrc)) return; // not a recognizable filter
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Imported Filter";
    out.push({ name, adjust: coerceAdjust(adjustSrc) });
  };
  const d = data as Record<string, unknown> | unknown[];
  if (Array.isArray(d)) d.forEach(one);
  else if (Array.isArray((d as Record<string, unknown>)?.presets)) {
    ((d as Record<string, unknown>).presets as unknown[]).forEach(one);
  } else one(data);
  return out;
}

/**
 * Translate adjustment values into a CSS `filter` string for a preset thumbnail,
 * so a saved preset's swatch previews its look: warmer presets read warmer, less
 * saturated ones look faded, brighter/contrastier ones show it, etc. Applied over
 * the shared gradient swatch (so it mirrors the built-in filter chips).
 */
export function adjustToThumbFilter(a: Adjustments): string {
  const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const sat = clampN(1 + (a.saturation + a.vibrance * 0.6) / 100, 0, 3);
  const bright = clampN(1 + (a.exposure * 0.5 + a.whites * 0.25 + a.shadows * 0.15) / 100, 0.4, 1.8);
  const con = clampN(1 + (a.contrast + a.clarity * 0.5) / 100, 0.4, 2);
  const parts = [
    `saturate(${sat.toFixed(3)})`,
    `brightness(${bright.toFixed(3)})`,
    `contrast(${con.toFixed(3)})`,
  ];
  // Temperature: warm (+) → sepia toward orange; cool (−) → hue-rotate toward blue.
  if (a.temperature > 0) parts.push(`sepia(${clampN((a.temperature / 100) * 0.6, 0, 0.8).toFixed(3)})`);
  else if (a.temperature < 0) parts.push(`hue-rotate(${clampN(-a.temperature * 0.5, 0, 60).toFixed(1)}deg)`);
  // Tint: green/magenta nudge.
  if (a.tint) parts.push(`hue-rotate(${clampN(a.tint * 0.2, -30, 30).toFixed(1)}deg)`);
  // Noise reduction softens.
  if (a.noise > 0) parts.push(`blur(${clampN((a.noise / 100) * 0.6, 0, 0.6).toFixed(2)}px)`);
  return parts.join(" ");
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A small 3×3 box blur over RGB (alpha copied) — used for sharpen / noise. */
function blur3(d: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += d[(yy * w + xx) * 4 + c];
            n++;
          }
        }
        o[i + c] = sum / n;
      }
      o[i + 3] = d[i + 3];
    }
  }
  return o;
}

/** Apply tonal / colour / detail adjustments, returning a new ImageData in the
    given colour space (must match the target canvas to avoid a conversion). */
export function applyAdjustments(
  src: ImageData,
  a: Adjustments,
  colorSpace: PredefinedColorSpace = "srgb",
): ImageData {
  const w = src.width;
  const h = src.height;
  const s = src.data;
  const out = new Uint8ClampedArray(s.length);

  const expF = Math.pow(2, a.exposure / 100); // ±1 stop at ±100
  const conF = 1 + a.contrast / 100;
  const T = a.temperature / 100;
  const Ti = a.tint / 100;
  const Hi = a.highlights / 100;
  const Sh = a.shadows / 100;
  const Wh = a.whites / 100;
  const Bl = a.blacks / 100;
  const Sat = a.saturation / 100;
  const Vib = a.vibrance / 100;
  const Cla = a.clarity / 100;
  const tonal = Hi || Sh || Wh || Bl;

  for (let i = 0; i < s.length; i += 4) {
    let r = s[i] / 255;
    let g = s[i + 1] / 255;
    let b = s[i + 2] / 255;

    if (expF !== 1) {
      r *= expF;
      g *= expF;
      b *= expF;
    }
    if (conF !== 1) {
      r = (r - 0.5) * conF + 0.5;
      g = (g - 0.5) * conF + 0.5;
      b = (b - 0.5) * conF + 0.5;
    }
    if (T) {
      r += T * 0.12;
      b -= T * 0.12;
    }
    if (Ti) {
      g -= Ti * 0.12;
      r += Ti * 0.06;
      b += Ti * 0.06;
    }
    if (tonal) {
      const lum = clamp01(0.299 * r + 0.587 * g + 0.114 * b);
      const add =
        Hi * 0.5 * Math.max(0, (lum - 0.5) * 2) +
        Sh * 0.5 * Math.max(0, (0.5 - lum) * 2) +
        Wh * 0.45 * (lum * lum) +
        Bl * 0.45 * ((1 - lum) * (1 - lum));
      r += add;
      g += add;
      b += add;
    }
    if (Cla) {
      const lum = clamp01(0.299 * r + 0.587 * g + 0.114 * b);
      const mid = 1 - Math.pow(Math.abs(lum - 0.5) * 2, 2); // midtone weight
      const f = 1 + Cla * 0.5 * mid;
      r = (r - 0.5) * f + 0.5;
      g = (g - 0.5) * f + 0.5;
      b = (b - 0.5) * f + 0.5;
    }
    if (Sat || Vib) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let f = 1 + Sat;
      if (Vib) {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const cur = mx <= 0 ? 0 : (mx - mn) / mx;
        f += Vib * (1 - clamp01(cur));
      }
      r = lum + (r - lum) * f;
      g = lum + (g - lum) * f;
      b = lum + (b - lum) * f;
    }

    out[i] = clamp01(r) * 255;
    out[i + 1] = clamp01(g) * 255;
    out[i + 2] = clamp01(b) * 255;
    out[i + 3] = s[i + 3];
  }

  if (a.noise > 0 || a.sharpen > 0) {
    const blur = blur3(out, w, h);
    const nAmt = a.noise / 100;
    const sAmt = (a.sharpen / 100) * 1.4;
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = out[i + c];
        if (nAmt) v += (blur[i + c] - v) * nAmt;
        if (sAmt) v += (v - blur[i + c]) * sAmt;
        out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  return new ImageData(out, w, h, { colorSpace });
}
