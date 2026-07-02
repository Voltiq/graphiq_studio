// Spec 07 — smart filters: pure ImageData → ImageData filter ops + the
// SmartFilter stack model. No tree / React / history knowledge.
//
// The Blur Gallery kernel (computeBlurFx) LIVES here now — the gallery's
// destructive path (paint.ts) and the "blur" smart-filter type share the one
// implementation (moved verbatim, not duplicated). New families implemented
// here: Sharpen (Unsharp Mask), Noise, Pixelate (Mosaic), Distort
// (Twirl/Pinch/Wave) and Stylize (Find Edges/Emboss/Posterize/Threshold).
// Filters never enlarge a layer: output is always layer-sized; spatial ops
// clamp (or wrap, for Wave) at the edges.

import { boxBlurPass, clampi, gaussianChannel } from "./blur";
import type { BlurFxKind } from "./tools";

// ---------------------------------------------------------------------------
// Blur Gallery kernel (moved from paint.ts — reused by gallery + smart filters)
// ---------------------------------------------------------------------------

/** Premultiply an RGBA8 region into per-channel float arrays (alpha kept 0–255). */
export function premultChannels(d: Uint8ClampedArray, n: number) {
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    const af = a / 255;
    R[i] = d[i * 4] * af;
    G[i] = d[i * 4 + 1] * af;
    B[i] = d[i * 4 + 2] * af;
    A[i] = a;
  }
  return { R, G, B, A };
}

/**
 * Apply a Blur Gallery effect to a whole-layer RGBA region (premultiplied so
 * transparent areas don't bleed darkness). `mask` (selection alpha) confines
 * the effect; `cx/cy` is the centre for zoom/spin/tilt-shift.
 */
export function computeBlurFx(
  orig: ImageData,
  kind: string,
  amount: number,
  angle: number,
  mask: Uint8ClampedArray | null,
  cx: number,
  cy: number,
  cs: PredefinedColorSpace,
  extra: { band: number; feather: number; threshold: number } = { band: 20, feather: 30, threshold: 40 },
): ImageData {
  const w = orig.width;
  const h = orig.height;
  const n = w * h;
  const sd = orig.data;
  const { R: sR, G: sG, B: sB, A: sA } = premultChannels(sd, n);
  let dR: Float32Array;
  let dG: Float32Array;
  let dB: Float32Array;
  let dA: Float32Array;

  // Gaussian-ish blur of the premultiplied channels (3 box passes).
  const blurredCopy = (r: number): Float32Array[] => {
    const br = Math.max(1, Math.round(r / 2));
    return [sR, sG, sB, sA].map((src) => {
      const d = src.slice();
      for (let p = 0; p < 3; p++) {
        boxBlurPass(d, w, h, br, true);
        boxBlurPass(d, w, h, br, false);
      }
      return d;
    });
  };

  if (kind === "box" || kind === "gaussian") {
    dR = sR.slice();
    dG = sG.slice();
    dB = sB.slice();
    dA = sA.slice();
    const r = Math.max(1, Math.round(amount));
    const passes = kind === "gaussian" ? 3 : 1;
    const br = kind === "gaussian" ? Math.max(1, Math.round(r / 2)) : r;
    for (let p = 0; p < passes; p++) {
      for (const ch of [dR, dG, dB, dA]) {
        boxBlurPass(ch, w, h, br, true);
        boxBlurPass(ch, w, h, br, false);
      }
    }
  } else if (kind === "tiltshift") {
    // Graduated focus: sharp inside a band around the focus line (through the
    // anchor, at `angle`), blending through a half-strength ring to the full
    // blur — the classic miniature-photography look.
    const r = Math.max(1, Math.round(amount));
    const [fR, fG, fB, fA] = blurredCopy(r);
    const [hR, hG, hB, hA] = blurredCopy(Math.max(1, r / 2));
    dR = new Float32Array(n);
    dG = new Float32Array(n);
    dB = new Float32Array(n);
    dA = new Float32Array(n);
    const rad = (angle * Math.PI) / 180;
    const nx = -Math.sin(rad); // normal to the focus line
    const ny = Math.cos(rad);
    const base = Math.min(w, h);
    const bandPx = Math.max(0, (extra.band / 100) * base * 0.5);
    const featherPx = Math.max(1, (extra.feather / 100) * base * 0.5);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = py * w + px;
        const dist = Math.abs(nx * (px - cx) + ny * (py - cy));
        let t = (dist - bandPx) / featherPx;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        t = t * t * (3 - 2 * t); // smoothstep
        if (t <= 0) {
          dR[i] = sR[i];
          dG[i] = sG[i];
          dB[i] = sB[i];
          dA[i] = sA[i];
        } else if (t < 0.5) {
          const u = t * 2;
          dR[i] = sR[i] + (hR[i] - sR[i]) * u;
          dG[i] = sG[i] + (hG[i] - sG[i]) * u;
          dB[i] = sB[i] + (hB[i] - sB[i]) * u;
          dA[i] = sA[i] + (hA[i] - sA[i]) * u;
        } else {
          const u = (t - 0.5) * 2;
          dR[i] = hR[i] + (fR[i] - hR[i]) * u;
          dG[i] = hG[i] + (fG[i] - hG[i]) * u;
          dB[i] = hB[i] + (fB[i] - hB[i]) * u;
          dA[i] = hA[i] + (fA[i] - hA[i]) * u;
        }
      }
    }
  } else {
    dR = new Float32Array(n);
    dG = new Float32Array(n);
    dB = new Float32Array(n);
    dA = new Float32Array(n);
    // Per-pixel offset list: where to read N samples for the pixel at (px,py).
    // Box/gaussian don't reach here. Each branch fills dst as the sample average.
    if (kind === "motion") {
      const rad = (angle * Math.PI) / 180;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      const len = Math.max(1, amount);
      const N = clampi(Math.round(len), 3, 48);
      const half = (N - 1) / 2 || 1;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let k = 0; k < N; k++) {
            const t = ((k - half) / half) * (len / 2);
            const si =
              clampi(Math.round(py + uy * t), 0, h - 1) * w + clampi(Math.round(px + ux * t), 0, w - 1);
            r += sR[si];
            g += sG[si];
            b += sB[si];
            a += sA[si];
          }
          const di = py * w + px;
          dR[di] = r / N;
          dG[di] = g / N;
          dB[di] = b / N;
          dA[di] = a / N;
        }
      }
    } else if (kind === "zoom" || kind === "spin") {
      const zoom = kind === "zoom";
      const strength = amount / 100; // zoom: scale span
      const arc = (amount * Math.PI) / 180; // spin: angle span
      const N = clampi(zoom ? Math.round(12 + strength * 36) : Math.round(8 + amount), 8, 44);
      const half = (N - 1) / 2 || 1;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const ox = px - cx;
          const oy = py - cy;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let k = 0; k < N; k++) {
            const f = (k - half) / half; // -1..1
            let sx: number;
            let sy: number;
            if (zoom) {
              const s = 1 + f * strength;
              sx = cx + ox * s;
              sy = cy + oy * s;
            } else {
              const phi = f * arc * 0.5;
              const c = Math.cos(phi);
              const sn = Math.sin(phi);
              sx = cx + ox * c - oy * sn;
              sy = cy + ox * sn + oy * c;
            }
            const si = clampi(Math.round(sy), 0, h - 1) * w + clampi(Math.round(sx), 0, w - 1);
            r += sR[si];
            g += sG[si];
            b += sB[si];
            a += sA[si];
          }
          const di = py * w + px;
          dR[di] = r / N;
          dG[di] = g / N;
          dB[di] = b / N;
          dA[di] = a / N;
        }
      }
    } else if (kind === "surface") {
      // Surface (edge-preserving): disc samples weighted by how close each
      // neighbour's luminance is to the centre pixel — flattens texture while
      // leaving edges crisp (a fast bilateral approximation).
      const radius = Math.max(1, amount);
      const N = 40;
      const offs = new Float32Array(N * 2);
      for (let k = 0; k < N; k++) {
        const rr = radius * Math.sqrt((k + 0.5) / N);
        const aa = k * 2.399963229728653; // golden angle
        offs[k * 2] = rr * Math.cos(aa);
        offs[k * 2 + 1] = rr * Math.sin(aa);
      }
      const th = Math.max(4, extra.threshold * 2.55); // % → luma difference 0–255
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = py * w + px;
          const o0 = i * 4;
          const l0 = (sd[o0] + sd[o0 + 1] + sd[o0 + 2]) / 3;
          let r = sR[i];
          let g = sG[i];
          let b = sB[i];
          let a = sA[i];
          let wsum = 1;
          for (let k = 0; k < N; k++) {
            const si =
              clampi(Math.round(py + offs[k * 2 + 1]), 0, h - 1) * w +
              clampi(Math.round(px + offs[k * 2]), 0, w - 1);
            const so = si * 4;
            const diff = Math.abs((sd[so] + sd[so + 1] + sd[so + 2]) / 3 - l0);
            if (diff >= th) continue;
            const wgt = 1 - diff / th;
            r += sR[si] * wgt;
            g += sG[si] * wgt;
            b += sB[si] * wgt;
            a += sA[si] * wgt;
            wsum += wgt;
          }
          dR[i] = r / wsum;
          dG[i] = g / wsum;
          dB[i] = b / wsum;
          dA[i] = a / wsum;
        }
      }
    } else if (kind === "spread") {
      // Spread (diffuse): each pixel is replaced by a random neighbour within
      // the radius — a frosted-glass scatter. The hash is position-based so the
      // result is stable across re-renders.
      const radius = Math.max(1, amount);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          let hsh = (px * 374761393 + py * 668265263) | 0;
          hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
          hsh = (hsh ^ (hsh >>> 16)) >>> 0;
          const aa = ((hsh & 1023) / 1024) * Math.PI * 2;
          const rr = Math.sqrt(((hsh >>> 10) & 1023) / 1024) * radius;
          const si =
            clampi(Math.round(py + Math.sin(aa) * rr), 0, h - 1) * w +
            clampi(Math.round(px + Math.cos(aa) * rr), 0, w - 1);
          const i = py * w + px;
          dR[i] = sR[si];
          dG[i] = sG[si];
          dB[i] = sB[si];
          dA[i] = sA[si];
        }
      }
    } else {
      // Bokeh: average over a disc of `amount` radius (golden-angle sample points).
      const radius = Math.max(1, amount);
      const N = 36;
      const offs = new Float32Array(N * 2);
      for (let k = 0; k < N; k++) {
        const rr = radius * Math.sqrt((k + 0.5) / N);
        const aa = k * 2.399963229728653;
        offs[k * 2] = rr * Math.cos(aa);
        offs[k * 2 + 1] = rr * Math.sin(aa);
      }
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let k = 0; k < N; k++) {
            const si =
              clampi(Math.round(py + offs[k * 2 + 1]), 0, h - 1) * w +
              clampi(Math.round(px + offs[k * 2]), 0, w - 1);
            r += sR[si];
            g += sG[si];
            b += sB[si];
            a += sA[si];
          }
          const di = py * w + px;
          dR[di] = r / N;
          dG[di] = g / N;
          dB[di] = b / N;
          dA[di] = a / N;
        }
      }
    }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const a = dA[i];
    const inv = a > 0 ? 255 / a : 0;
    let r = dR[i] * inv;
    let g = dG[i] * inv;
    let b = dB[i] * inv;
    let al = a;
    const o = i * 4;
    if (mask) {
      const m = mask[i] / 255;
      r = sd[o] + (r - sd[o]) * m;
      g = sd[o + 1] + (g - sd[o + 1]) * m;
      b = sd[o + 2] + (b - sd[o + 2]) * m;
      al = sd[o + 3] + (al - sd[o + 3]) * m;
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = al;
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

// ---------------------------------------------------------------------------
// Smart-filter model
// ---------------------------------------------------------------------------

export type FilterType = "blur" | "sharpen" | "noise" | "pixelate" | "distort" | "stylize";

/** Blur smart filter reuses the Blur Gallery's parameter model (minus scope). */
export interface BlurFilterParams {
  kind: BlurFxKind;
  amount: number;
  angle: number;
  anchor: { x: number; y: number };
  band: number;
  feather: number;
  threshold: number;
}
export interface UnsharpParams {
  amount: number; // %
  radius: number; // px
  threshold: number; // 0–255 luma difference
}
export interface NoiseParams {
  amount: number; // %
  distribution: "gaussian" | "uniform";
  monochromatic: boolean;
  seed: number;
}
export interface MosaicParams {
  cellSize: number; // px
}
export interface DistortParams {
  mode: "twirl" | "pinch" | "wave";
  angle: number; // twirl: degrees at the centre
  radius: number; // twirl/pinch: % of the shorter side
  amount: number; // pinch: -100 (pinch) … 100 (bulge)
  amplitude: number; // wave: px
  wavelength: number; // wave: px
  edge: "clamp" | "wrap";
}
export interface StylizeParams {
  mode: "findEdges" | "emboss" | "posterize" | "threshold";
  angle: number; // emboss light direction
  height: number; // emboss px offset
  amount: number; // emboss strength %
  levels: number; // posterize 2–32
  level: number; // threshold 0–255
}

interface FilterBase {
  id: string;
  enabled: boolean;
  /** How the filtered result blends back over the pre-filter pixels. */
  blendMode: string;
  opacity: number; // 0–100
}
export type SmartFilter = FilterBase &
  (
    | { type: "blur"; params: BlurFilterParams }
    | { type: "sharpen"; params: UnsharpParams }
    | { type: "noise"; params: NoiseParams }
    | { type: "pixelate"; params: MosaicParams }
    | { type: "distort"; params: DistortParams }
    | { type: "stylize"; params: StylizeParams }
  );

export const FILTER_LABELS: Record<FilterType, string> = {
  blur: "Blur",
  sharpen: "Sharpen",
  noise: "Noise",
  pixelate: "Pixelate",
  distort: "Distort",
  stylize: "Stylize",
};

/** A human label including the variant (for list rows + history steps). */
export function filterLabel(f: SmartFilter): string {
  switch (f.type) {
    case "blur":
      return `${f.params.kind === "tiltshift" ? "Tilt-Shift" : f.params.kind[0].toUpperCase() + f.params.kind.slice(1)} Blur`;
    case "sharpen":
      return "Unsharp Mask";
    case "noise":
      return "Add Noise";
    case "pixelate":
      return "Mosaic";
    case "distort":
      return f.params.mode === "twirl" ? "Twirl" : f.params.mode === "pinch" ? "Pinch / Bulge" : "Wave";
    case "stylize":
      return f.params.mode === "findEdges"
        ? "Find Edges"
        : f.params.mode === "emboss"
          ? "Emboss"
          : f.params.mode === "posterize"
            ? "Posterize"
            : "Threshold";
  }
}

let filterSeq = 0;
export function freshFilterId(): string {
  return `flt-${Date.now().toString(36)}-${(filterSeq += 1)}`;
}

/** Factory for each type's defaults (a sensible, visible starting point). */
export function defaultFilter(type: FilterType): SmartFilter {
  const base = { id: freshFilterId(), enabled: true, blendMode: "Normal", opacity: 100 };
  switch (type) {
    case "blur":
      return {
        ...base,
        type,
        params: { kind: "gaussian", amount: 8, angle: 0, anchor: { x: 0.5, y: 0.5 }, band: 20, feather: 30, threshold: 40 },
      };
    case "sharpen":
      return { ...base, type, params: { amount: 80, radius: 2, threshold: 4 } };
    case "noise":
      return { ...base, type, params: { amount: 12, distribution: "gaussian", monochromatic: true, seed: 1 } };
    case "pixelate":
      return { ...base, type, params: { cellSize: 8 } };
    case "distort":
      return { ...base, type, params: { mode: "twirl", angle: 120, radius: 60, amount: 50, amplitude: 10, wavelength: 60, edge: "clamp" } };
    case "stylize":
      return { ...base, type, params: { mode: "findEdges", angle: 135, height: 2, amount: 100, levels: 4, level: 128 } };
  }
}

export function hasEnabledFilters(filters: SmartFilter[] | undefined): boolean {
  return !!filters && filters.some((f) => f.enabled);
}

/** Cache-key ingredient: the whole stack's identity (params + order + blend). */
export function filterStackHash(filters: SmartFilter[] | undefined): string {
  return filters && filters.length ? JSON.stringify(filters) : "";
}

// ---------------------------------------------------------------------------
// New filter implementations (pure ImageData passes)
// ---------------------------------------------------------------------------

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Unsharp Mask: src + amount · (src − gaussian(src, radius)) where the local
 *  luma difference exceeds `threshold`. The radius pass reuses the shared
 *  separable gaussian on premultiplied channels (no edge halos on alpha). */
function unsharpMask(src: ImageData, p: UnsharpParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const { R, G, B, A } = premultChannels(sd, n);
  const radius = Math.max(0.5, Math.min(250, p.radius));
  for (const ch of [R, G, B, A]) gaussianChannel(ch, w, h, radius);
  const out = new Uint8ClampedArray(sd); // start from src
  const k = Math.max(0, p.amount) / 100;
  const th = Math.max(0, Math.min(255, p.threshold));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = A[i];
    if (sd[o + 3] === 0) continue; // fully transparent stays put
    const inv = a > 0 ? 255 / a : 0;
    const br = R[i] * inv;
    const bg = G[i] * inv;
    const bb = B[i] * inv;
    const dr = sd[o] - br;
    const dg = sd[o + 1] - bg;
    const db = sd[o + 2] - bb;
    // threshold on the luma difference so flat areas stay noise-free
    if (Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db) < th) continue;
    out[o] = clamp255(sd[o] + k * dr);
    out[o + 1] = clamp255(sd[o + 1] + k * dg);
    out[o + 2] = clamp255(sd[o + 2] + k * db);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** Deterministic per-pixel hash → [0,1). Seeded so results are reproducible. */
function hash01(x: number, y: number, seed: number, lane: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041 + lane * 40503) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Add Noise: uniform or gaussian-ish (sum of two uniforms), optionally
 *  monochromatic (one delta for R/G/B). Transparent pixels stay untouched. */
function addNoise(src: ImageData, p: NoiseParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const amp = (Math.max(0, Math.min(100, p.amount)) / 100) * 128;
  const seed = p.seed | 0 || 1;
  const gauss = p.distribution === "gaussian";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (sd[o + 3] === 0) continue;
      const rnd = (lane: number) => {
        const u = hash01(x, y, seed, lane);
        if (!gauss) return (u * 2 - 1) * amp;
        const v = hash01(x, y, seed, lane + 7);
        return (u + v - 1) * amp; // triangular ≈ gaussian, cheap + bounded
      };
      if (p.monochromatic) {
        const d = rnd(0);
        out[o] = clamp255(sd[o] + d);
        out[o + 1] = clamp255(sd[o + 1] + d);
        out[o + 2] = clamp255(sd[o + 2] + d);
      } else {
        out[o] = clamp255(sd[o] + rnd(0));
        out[o + 1] = clamp255(sd[o + 1] + rnd(1));
        out[o + 2] = clamp255(sd[o + 2] + rnd(2));
      }
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** Mosaic: each cell becomes its (premultiplied) average — clean block edges,
 *  no dark fringing along transparency. */
function mosaic(src: ImageData, p: MosaicParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const cell = Math.max(2, Math.min(512, Math.round(p.cellSize)));
  const out = new Uint8ClampedArray(sd.length);
  for (let cy = 0; cy < h; cy += cell) {
    const ch = Math.min(cell, h - cy);
    for (let cx = 0; cx < w; cx += cell) {
      const cw = Math.min(cell, w - cx);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = 0; y < ch; y++) {
        let o = ((cy + y) * w + cx) * 4;
        for (let x = 0; x < cw; x++, o += 4) {
          const af = sd[o + 3] / 255;
          r += sd[o] * af;
          g += sd[o + 1] * af;
          b += sd[o + 2] * af;
          a += sd[o + 3];
        }
      }
      const count = cw * ch;
      const am = a / count;
      const inv = am > 0 ? 255 / (am * count) : 0;
      const rr = r * inv;
      const gg = g * inv;
      const bb = b * inv;
      for (let y = 0; y < ch; y++) {
        let o = ((cy + y) * w + cx) * 4;
        for (let x = 0; x < cw; x++, o += 4) {
          out[o] = rr;
          out[o + 1] = gg;
          out[o + 2] = bb;
          out[o + 3] = am;
        }
      }
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** Distort: per-output-pixel source coordinate (twirl / pinch / wave), sampled
 *  bilinearly on premultiplied channels with clamp or wrap edges. */
function distortFilter(src: ImageData, p: DistortParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const { R, G, B, A } = premultChannels(sd, n);
  const out = new Uint8ClampedArray(n * 4);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = (Math.max(2, Math.min(100, p.radius)) / 100) * (Math.min(w, h) / 2) * 2;
  const twirlRad = (p.angle * Math.PI) / 180;
  const pinch = Math.max(-100, Math.min(100, p.amount)) / 100;
  const amp = Math.max(0, Math.min(200, p.amplitude));
  const wl = Math.max(4, Math.min(1000, p.wavelength));
  const wrap = p.edge === "wrap";
  const coord = (v: number, max: number): number => {
    if (wrap) {
      v %= max;
      return v < 0 ? v + max : v;
    }
    return v < 0 ? 0 : v > max - 1 ? max - 1 : v;
  };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let sx = px;
      let sy = py;
      if (p.mode === "wave") {
        sx = px + amp * Math.sin((py / wl) * Math.PI * 2);
        sy = py + amp * Math.sin((px / wl) * Math.PI * 2);
      } else {
        const ox = px - cx;
        const oy = py - cy;
        const d = Math.hypot(ox, oy);
        if (d < maxR && d > 0) {
          const t = 1 - d / maxR;
          if (p.mode === "twirl") {
            const phi = twirlRad * t * t;
            const c = Math.cos(phi);
            const s = Math.sin(phi);
            sx = cx + ox * c - oy * s;
            sy = cy + ox * s + oy * c;
          } else {
            // pinch (<0) squeezes samples outward from centre; bulge (>0) inward
            const scale = Math.pow(d / maxR, pinch >= 0 ? 1 - pinch * t : 1 / (1 + pinch * t));
            const f = (scale * maxR) / d;
            sx = cx + ox * f;
            sy = cy + oy * f;
          }
        }
      }
      // bilinear sample (premultiplied)
      const fx = coord(sx, w);
      const fy = coord(sy, h);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = wrap ? (x0 + 1) % w : Math.min(w - 1, x0 + 1);
      const y1 = wrap ? (y0 + 1) % h : Math.min(h - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const i00 = y0 * w + x0;
      const i10 = y0 * w + x1;
      const i01 = y1 * w + x0;
      const i11 = y1 * w + x1;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const a = A[i00] * w00 + A[i10] * w10 + A[i01] * w01 + A[i11] * w11;
      const inv = a > 0 ? 255 / a : 0;
      const o = (py * w + px) * 4;
      out[o] = (R[i00] * w00 + R[i10] * w10 + R[i01] * w01 + R[i11] * w11) * inv;
      out[o + 1] = (G[i00] * w00 + G[i10] * w10 + G[i01] * w01 + G[i11] * w11) * inv;
      out[o + 2] = (B[i00] * w00 + B[i10] * w10 + B[i01] * w01 + B[i11] * w11) * inv;
      out[o + 3] = a;
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** Stylize: Find Edges (per-channel Sobel, inverted), Emboss (directional
 *  gradient over gray + bias), Posterize (per-channel LUT), Threshold (luma). */
function stylizeFilter(src: ImageData, p: StylizeParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd.length);
  const idx = (x: number, y: number) =>
    ((y < 0 ? 0 : y > h - 1 ? h - 1 : y) * w + (x < 0 ? 0 : x > w - 1 ? w - 1 : x)) * 4;

  if (p.mode === "posterize") {
    const levels = Math.max(2, Math.min(32, Math.round(p.levels)));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round((Math.floor((v / 256) * levels) / (levels - 1)) * 255);
    for (let o = 0; o < sd.length; o += 4) {
      out[o] = lut[sd[o]];
      out[o + 1] = lut[sd[o + 1]];
      out[o + 2] = lut[sd[o + 2]];
      out[o + 3] = sd[o + 3];
    }
    return new ImageData(out, w, h, { colorSpace: cs });
  }
  if (p.mode === "threshold") {
    const level = Math.max(0, Math.min(255, Math.round(p.level)));
    for (let o = 0; o < sd.length; o += 4) {
      const v = 0.299 * sd[o] + 0.587 * sd[o + 1] + 0.114 * sd[o + 2] >= level ? 255 : 0;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = sd[o + 3];
    }
    return new ImageData(out, w, h, { colorSpace: cs });
  }
  if (p.mode === "emboss") {
    const rad = (p.angle * Math.PI) / 180;
    const dist = Math.max(1, Math.min(10, Math.round(p.height)));
    const dx = Math.round(Math.cos(rad) * dist);
    const dy = Math.round(Math.sin(rad) * dist);
    const k = Math.max(0, Math.min(500, p.amount)) / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const oa = idx(x + dx, y + dy);
        const ob = idx(x - dx, y - dy);
        const d =
          (0.299 * (sd[oa] - sd[ob]) + 0.587 * (sd[oa + 1] - sd[ob + 1]) + 0.114 * (sd[oa + 2] - sd[ob + 2])) * k;
        const v = clamp255(128 + d);
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = sd[o + 3];
      }
    }
    return new ImageData(out, w, h, { colorSpace: cs });
  }
  // findEdges: per-channel Sobel magnitude, inverted (white bg, dark edges)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const gx =
          -sd[idx(x - 1, y - 1) + c] - 2 * sd[idx(x - 1, y) + c] - sd[idx(x - 1, y + 1) + c] +
          sd[idx(x + 1, y - 1) + c] + 2 * sd[idx(x + 1, y) + c] + sd[idx(x + 1, y + 1) + c];
        const gy =
          -sd[idx(x - 1, y - 1) + c] - 2 * sd[idx(x, y - 1) + c] - sd[idx(x + 1, y - 1) + c] +
          sd[idx(x - 1, y + 1) + c] + 2 * sd[idx(x, y + 1) + c] + sd[idx(x + 1, y + 1) + c];
        out[o + c] = clamp255(255 - Math.hypot(gx, gy));
      }
      out[o + 3] = sd[o + 3];
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run one smart filter over working-space pixels (pure; returns a new buffer). */
export function applyFilter(src: ImageData, f: SmartFilter, cs: PredefinedColorSpace): ImageData {
  switch (f.type) {
    case "blur": {
      const p = f.params;
      return computeBlurFx(src, p.kind, p.amount, p.angle, null, p.anchor.x * src.width, p.anchor.y * src.height, cs, {
        band: p.band,
        feather: p.feather,
        threshold: p.threshold,
      });
    }
    case "sharpen":
      return unsharpMask(src, f.params, cs);
    case "noise":
      return addNoise(src, f.params, cs);
    case "pixelate":
      return mosaic(src, f.params, cs);
    case "distort":
      return distortFilter(src, f.params, cs);
    case "stylize":
      return stylizeFilter(src, f.params, cs);
  }
}
