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

/** Apply tonal / colour / detail adjustments, returning a new ImageData. */
export function applyAdjustments(src: ImageData, a: Adjustments): ImageData {
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

  return new ImageData(out, w, h);
}
