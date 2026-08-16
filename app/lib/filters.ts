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

export type FilterType =
  | "blur"
  | "sharpen"
  | "noise"
  | "pixelate"
  | "distort"
  | "stylize"
  | "highpass"
  | "median"
  | "dustscratches"
  | "denoise"
  | "lens"
  | "dehaze"
  | "clarity"
  | "grain"
  | "oil"
  | "halftone"
  | "crystallize"
  | "glitch"
  | "canvasshadow";

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
export interface OilParams {
  radius: number; // px — brush neighbourhood
  levels: number; // intensity buckets; fewer = broader, flatter strokes
}
export interface HalftoneParams {
  size: number; // px — screen cell (max dot pitch)
  angle: number; // ° — base screen angle
  mono: boolean; // true = single black screen; false = C/M/Y at classic offsets
}
export interface CrystallizeParams {
  size: number; // px — average cell size
}
export interface GlitchParams {
  amount: number; // % — horizontal band displacement
  blockSize: number; // px — band height
  rgbShift: number; // px — channel separation
  scanlines: number; // % — darkening of alternate rows
  seed: number;
}
export interface CanvasShadowParams {
  distance: number; // px
  angle: number; // °
  size: number; // px blur
  opacity: number; // %
  color: string;
}
export interface DehazeParams {
  amount: number; // % — how much of the estimated haze to remove
  radius: number; // px — dark-channel patch radius
}
export interface ClarityParams {
  clarity: number; // −100…100 large-scale local contrast (midtone-weighted)
  texture: number; // −100…100 fine detail
  radius: number; // px — the clarity radius; texture uses a small fraction of it
}
export interface GrainParams {
  amount: number; // %
  size: number; // px — grain clump size (1 = per-pixel)
  roughness: number; // % — how unevenly the grain is distributed
  seed: number;
}
/**
 * Lens corrections. All three are radial functions of distance from the image
 * centre, and two of them (distortion, chromatic aberration) are RESAMPLES — so
 * they share one sampling pass rather than being three filters stacked, which
 * would resample the image twice and visibly soften it.
 */
export interface LensParams {
  /** −100…100. Positive removes BARREL (corners pull in), negative removes pincushion. */
  distortion: number;
  /** −100…100 lateral chromatic aberration: red scaled against green. */
  redCyan: number;
  /** −100…100 lateral chromatic aberration: blue scaled against green. */
  blueYellow: number;
  /** −100…100 vignette: negative darkens the corners, positive lightens them. */
  vignette: number;
  /** 0…100 — how far out from the centre the vignette starts falling off. */
  midpoint: number;
}
export interface HighPassParams {
  radius: number; // px — everything coarser than this is flattened to mid-grey
}
export interface MedianParams {
  radius: number; // px
}
export interface DustScratchesParams {
  radius: number; // px
  threshold: number; // 0–255 luma difference; only pixels differing MORE are replaced
}
export interface DenoiseParams {
  strength: number; // % → how close in luma a neighbour must be to be averaged in
  radius: number; // px
  color: number; // % → extra chroma-only smoothing (colour speckle is low-frequency)
}
export interface StylizeParams {
  mode: "findEdges" | "emboss" | "posterize" | "threshold";
  angle: number; // emboss light direction
  height: number; // emboss px offset
  amount: number; // emboss strength %
  levels: number; // posterize 2–32
  level: number; // threshold 0–255
}

/** Scale a filter's SPATIAL (pixel-unit) parameters by `s` — the progressive
 *  half-resolution preview runs the stack on a downscaled source, so a blur
 *  radius (etc.) must shrink with it to look the same. Percent / degree /
 *  value-threshold params pass through untouched. */
export function scaleFilterParams(f: SmartFilter, s: number): SmartFilter {
  switch (f.type) {
    case "blur": {
      // zoom is %, spin is degrees; every other kind's amount is pixels.
      const px = f.params.kind !== "zoom" && f.params.kind !== "spin";
      return px ? { ...f, params: { ...f.params, amount: Math.max(1, f.params.amount * s) } } : f;
    }
    case "sharpen":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "pixelate":
      return { ...f, params: { ...f.params, cellSize: Math.max(1, f.params.cellSize * s) } };
    case "distort":
      return f.params.mode === "wave"
        ? {
            ...f,
            params: {
              ...f.params,
              amplitude: f.params.amplitude * s,
              wavelength: Math.max(1, f.params.wavelength * s),
            },
          }
        : f; // twirl/pinch params are degrees / % of the shorter side
    case "stylize":
      return f.params.mode === "emboss"
        ? { ...f, params: { ...f.params, height: Math.max(1, f.params.height * s) } }
        : f;
    // Each of these carries a PIXEL radius, so the half-res preview must shrink
    // it or the preview shows a different filter. `threshold` / `strength` /
    // `color` are value-space and pass through untouched. The cases are written
    // out separately rather than sharing one body because a combined case widens
    // `f.params` to the union of all four and loses the narrowing.
    case "highpass":
      return { ...f, params: { ...f.params, radius: Math.max(0.1, f.params.radius * s) } };
    case "median":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "dustscratches":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "denoise":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "dehaze":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "clarity":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "grain":
      return { ...f, params: { ...f.params, size: Math.max(1, f.params.size * s) } };
    case "oil":
      return { ...f, params: { ...f.params, radius: Math.max(1, f.params.radius * s) } };
    case "halftone":
      return { ...f, params: { ...f.params, size: Math.max(2, f.params.size * s) } };
    case "crystallize":
      return { ...f, params: { ...f.params, size: Math.max(2, f.params.size * s) } };
    case "glitch":
      return {
        ...f,
        params: {
          ...f.params,
          blockSize: Math.max(1, f.params.blockSize * s),
          rgbShift: f.params.rgbShift * s,
        },
      };
    case "canvasshadow":
      return {
        ...f,
        params: {
          ...f.params,
          distance: f.params.distance * s,
          size: Math.max(0, f.params.size * s),
        },
      };
    default:
      return f;
  }
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
    | { type: "highpass"; params: HighPassParams }
    | { type: "median"; params: MedianParams }
    | { type: "dustscratches"; params: DustScratchesParams }
    | { type: "denoise"; params: DenoiseParams }
    | { type: "lens"; params: LensParams }
    | { type: "dehaze"; params: DehazeParams }
    | { type: "clarity"; params: ClarityParams }
    | { type: "grain"; params: GrainParams }
    | { type: "oil"; params: OilParams }
    | { type: "halftone"; params: HalftoneParams }
    | { type: "crystallize"; params: CrystallizeParams }
    | { type: "glitch"; params: GlitchParams }
    | { type: "canvasshadow"; params: CanvasShadowParams }
  );

export const FILTER_LABELS: Record<FilterType, string> = {
  blur: "Blur",
  sharpen: "Sharpen",
  noise: "Noise",
  pixelate: "Pixelate",
  distort: "Distort",
  stylize: "Stylize",
  highpass: "High Pass",
  median: "Median",
  dustscratches: "Dust & Scratches",
  denoise: "Reduce Noise",
  lens: "Lens Corrections",
  dehaze: "Dehaze",
  clarity: "Clarity & Texture",
  grain: "Grain",
  oil: "Oil Paint",
  halftone: "Halftone",
  crystallize: "Crystallize",
  glitch: "Glitch",
  canvasshadow: "Drop Shadow (baked)",
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
    case "highpass":
      return "High Pass";
    case "median":
      return "Median";
    case "dustscratches":
      return "Dust & Scratches";
    case "denoise":
      return "Reduce Noise";
    case "lens":
      return "Lens Corrections";
    case "dehaze":
      return "Dehaze";
    case "clarity":
      return "Clarity & Texture";
    case "grain":
      return "Grain";
    case "oil":
      return "Oil Paint";
    case "halftone":
      return f.params.mono ? "Halftone" : "Color Halftone";
    case "crystallize":
      return "Crystallize";
    case "glitch":
      return "Glitch";
    case "canvasshadow":
      return "Drop Shadow (baked)";
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
    case "highpass":
      return { ...base, type, params: { radius: 3 } };
    case "median":
      return { ...base, type, params: { radius: 2 } };
    case "dustscratches":
      return { ...base, type, params: { radius: 2, threshold: 12 } };
    case "denoise":
      return { ...base, type, params: { strength: 45, radius: 3, color: 50 } };
    case "lens":
      return { ...base, type, params: { distortion: 0, redCyan: 0, blueYellow: 0, vignette: -35, midpoint: 50 } };
    case "dehaze":
      return { ...base, type, params: { amount: 50, radius: 7 } };
    case "clarity":
      return { ...base, type, params: { clarity: 35, texture: 20, radius: 40 } };
    case "grain":
      return { ...base, type, params: { amount: 30, size: 2, roughness: 50, seed: 1 } };
    case "oil":
      return { ...base, type, params: { radius: 4, levels: 20 } };
    case "halftone":
      return { ...base, type, params: { size: 8, angle: 45, mono: false } };
    case "crystallize":
      return { ...base, type, params: { size: 12 } };
    case "glitch":
      return { ...base, type, params: { amount: 40, blockSize: 12, rgbShift: 4, scanlines: 30, seed: 1 } };
    case "canvasshadow":
      return { ...base, type, params: { distance: 8, angle: 120, size: 10, opacity: 60, color: "#000000" } };
  }
}

export function hasEnabledFilters(filters: SmartFilter[] | undefined): boolean {
  return !!filters && filters.some((f) => f.enabled);
}

/** Cache-key ingredient: the whole stack's identity (params + order + blend).
 *  Memoized per (immutable) array — evaluated every composite frame. */
const stackHashMemo = new WeakMap<SmartFilter[], string>();
export function filterStackHash(filters: SmartFilter[] | undefined): string {
  if (!filters || !filters.length) return "";
  let h = stackHashMemo.get(filters);
  if (h === undefined) {
    h = JSON.stringify(filters);
    stackHashMemo.set(filters, h);
  }
  return h;
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
  const mono = p.monochromatic;
  // Hoisted out of the loop, with x/y as arguments. It used to be declared per
  // pixel, which allocated a fresh closure ~400 000 times per pass and made Add
  // Noise — three multiplies and a hash — the SLOWEST of the nineteen filters,
  // slower than Oil Paint or Median. Hoisting is 2.5x faster and bit-identical
  // (the golden images did not move).
  const rnd = (x: number, y: number, lane: number) => {
    const u = hash01(x, y, seed, lane);
    if (!gauss) return (u * 2 - 1) * amp;
    const v = hash01(x, y, seed, lane + 7);
    return (u + v - 1) * amp; // triangular ≈ gaussian, cheap + bounded
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (sd[o + 3] === 0) continue;
      if (mono) {
        const d = rnd(x, y, 0);
        out[o] = clamp255(sd[o] + d);
        out[o + 1] = clamp255(sd[o + 1] + d);
        out[o + 2] = clamp255(sd[o + 2] + d);
      } else {
        out[o] = clamp255(sd[o] + rnd(x, y, 0));
        out[o + 1] = clamp255(sd[o + 1] + rnd(x, y, 1));
        out[o + 2] = clamp255(sd[o + 2] + rnd(x, y, 2));
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

/** High Pass: keep only detail FINER than `radius`, flatten the rest to mid-grey.
 *  src − gaussian(src) + 128. The blur runs on premultiplied channels (as Unsharp
 *  does) so transparent regions don't bleed darkness into the edge. */
function highPass(src: ImageData, p: HighPassParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const { R, G, B, A } = premultChannels(sd, n);
  const radius = Math.max(0.1, Math.min(250, p.radius));
  for (const ch of [R, G, B, A]) gaussianChannel(ch, w, h, radius);
  const out = new Uint8ClampedArray(sd);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue; // fully transparent stays put
    const a = A[i];
    const inv = a > 0 ? 255 / a : 0;
    out[o] = clamp255(128 + sd[o] - R[i] * inv);
    out[o + 1] = clamp255(128 + sd[o + 1] - G[i] * inv);
    out[o + 2] = clamp255(128 + sd[o + 2] - B[i] * inv);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Per-channel median over a (2r+1)² window, edges clamped.
 *
 * Sliding 256-bin histogram with an incrementally tracked median (Huang 1979):
 * moving one pixel right removes one column and adds one, so the cost is O(r)
 * per pixel rather than the O(r²·log r) of sorting each window independently.
 * The median is then nudged from its previous position instead of re-scanning
 * all 256 bins, which matters because a full scan would cost more than sorting
 * for the small radii this filter is actually used at.
 *
 * `below` is invariant: the number of samples in the window strictly less than
 * `med`. The window is a fixed (2r+1)² because clamping repeats edge pixels
 * rather than shrinking the window, so `target` never changes.
 */
function medianPlanes(sd: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sd.length);
  const side = 2 * r + 1;
  const target = (side * side) >> 1; // 0-indexed rank of the median
  const hist = new Uint32Array(256);
  // Alpha is usually constant (an opaque photo); skip a whole pass when it is.
  let flatAlpha = true;
  const a0 = sd[3];
  for (let i = 0; i < w * h; i++) {
    if (sd[i * 4 + 3] !== a0) {
      flatAlpha = false;
      break;
    }
  }
  const channels = flatAlpha ? 3 : 4;
  if (flatAlpha) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = a0;

  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const row = clampi(y + dy, 0, h - 1) * w;
        for (let dx = -r; dx <= r; dx++) hist[sd[(row + clampi(dx, 0, w - 1)) * 4 + c]]++;
      }
      let med = 0;
      let below = 0;
      while (below + hist[med] <= target) {
        below += hist[med];
        med++;
      }
      out[y * w * 4 + c] = med;
      for (let x = 1; x < w; x++) {
        const remX = clampi(x - 1 - r, 0, w - 1);
        const addX = clampi(x + r, 0, w - 1);
        for (let dy = -r; dy <= r; dy++) {
          const row = clampi(y + dy, 0, h - 1) * w;
          const rv = sd[(row + remX) * 4 + c];
          hist[rv]--;
          if (rv < med) below--;
          const av = sd[(row + addX) * 4 + c];
          hist[av]++;
          if (av < med) below++;
        }
        while (below > target) {
          med--;
          below -= hist[med];
        }
        while (below + hist[med] <= target) {
          below += hist[med];
          med++;
        }
        out[(y * w + x) * 4 + c] = med;
      }
    }
  }
  return out;
}

/** Median: flattens speckle while keeping edges straighter than a blur would. */
function medianFilter(src: ImageData, p: MedianParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const r = Math.max(1, Math.min(16, Math.round(p.radius)));
  const med = medianPlanes(sd, w, h, r);
  const out = new Uint8ClampedArray(sd);
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue; // never resurrect transparent pixels
    out[o] = med[o];
    out[o + 1] = med[o + 1];
    out[o + 2] = med[o + 2];
    out[o + 3] = med[o + 3];
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** Dust & Scratches: the median, but applied ONLY where the pixel disagrees with
 *  it by more than `threshold` — so defects are replaced and everything else is
 *  left alone. Threshold 0 therefore degenerates to a plain Median. */
function dustAndScratches(
  src: ImageData,
  p: DustScratchesParams,
  cs: PredefinedColorSpace,
): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const r = Math.max(1, Math.min(16, Math.round(p.radius)));
  const th = Math.max(0, Math.min(255, p.threshold));
  const med = medianPlanes(sd, w, h, r);
  const out = new Uint8ClampedArray(sd);
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    const dr = sd[o] - med[o];
    const dg = sd[o + 1] - med[o + 1];
    const db = sd[o + 2] - med[o + 2];
    // Luma difference, matching the threshold convention Unsharp already uses.
    if (Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db) <= th) continue;
    out[o] = med[o];
    out[o + 1] = med[o + 1];
    out[o + 2] = med[o + 2];
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Reduce Noise: the denoise-tuned sibling of the Surface blur.
 *
 * Surface bilaterally averages RGB together, which smooths luminance grain and
 * colour speckle at the same rate. Real sensor noise is not like that — chroma
 * noise is coarser and far more objectionable — so this splits the image into
 * luma and chroma (YCbCr), runs the edge-aware average on LUMA only, and blurs
 * the two chroma planes outright. That keeps edges (which live in luma) while
 * erasing the colour mottling a luma-preserving filter would leave behind.
 */
function reduceNoise(src: ImageData, p: DenoiseParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const R = sd[o];
    const G = sd[o + 1];
    const B = sd[o + 2];
    Y[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    Cb[i] = -0.168736 * R - 0.331264 * G + 0.5 * B + 128;
    Cr[i] = 0.5 * R - 0.418688 * G - 0.081312 * B + 128;
  }
  // Chroma: a plain blur is right here — colour noise has no edges worth saving.
  const colorAmt = Math.max(0, Math.min(100, p.color)) / 100;
  if (colorAmt > 0) {
    const cr = Math.max(1, p.radius * colorAmt * 2);
    gaussianChannel(Cb, w, h, cr);
    gaussianChannel(Cr, w, h, cr);
  }
  // Luma: edge-aware average over a golden-angle disc (same sampling as Surface).
  const radius = Math.max(1, Math.min(64, p.radius));
  const N = 24;
  const offs = new Float32Array(N * 2);
  for (let k = 0; k < N; k++) {
    const rr = radius * Math.sqrt((k + 0.5) / N);
    const aa = k * 2.399963229728653; // golden angle → even disc coverage
    offs[k * 2] = rr * Math.cos(aa);
    offs[k * 2 + 1] = rr * Math.sin(aa);
  }
  const th = Math.max(1, (Math.max(0, Math.min(100, p.strength)) / 100) * 48);
  const Yout = new Float32Array(n);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = py * w + px;
      const y0 = Y[i];
      let acc = y0;
      let wsum = 1;
      for (let k = 0; k < N; k++) {
        const si =
          clampi(Math.round(py + offs[k * 2 + 1]), 0, h - 1) * w +
          clampi(Math.round(px + offs[k * 2]), 0, w - 1);
        const diff = Math.abs(Y[si] - y0);
        if (diff >= th) continue; // across an edge — do not average
        const wgt = 1 - diff / th;
        acc += Y[si] * wgt;
        wsum += wgt;
      }
      Yout[i] = acc / wsum;
    }
  }
  const out = new Uint8ClampedArray(sd);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    const y = Yout[i];
    const cb = Cb[i] - 128;
    const cr = Cr[i] - 128;
    out[o] = clamp255(y + 1.402 * cr);
    out[o + 1] = clamp255(y - 0.344136 * cb - 0.714136 * cr);
    out[o + 2] = clamp255(y + 1.772 * cb);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Lens Corrections: geometric distortion, lateral chromatic aberration and
 * vignette — in ONE resampling pass.
 *
 * Distortion and CA are both radial remaps, so running them as two stacked
 * filters would sample the image twice and lose real sharpness. Here each output
 * pixel resolves its source position once, and the CA correction is just a
 * per-channel tweak to that same radial scale: red and blue are sampled at
 * slightly different radii than green, which is exactly what lateral CA is.
 *
 * The radial model is `scale = 1 + k·r²` with `r` normalised so the CORNER is
 * 1.0 — normalising by the half-diagonal (rather than by pixels) is what makes
 * the parameters resolution-independent, so the half-resolution preview shows
 * the same correction and `scaleFilterParams` has nothing to scale.
 *
 * Sampling is bilinear on PREMULTIPLIED channels: CA shifts are sub-pixel by
 * nature, so nearest-neighbour would quantise the very thing being corrected,
 * and premultiplying keeps transparent regions from bleeding dark fringes in.
 */
function lensCorrection(src: ImageData, p: LensParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const { R: sR, G: sG, B: sB, A: sA } = premultChannels(sd, n);
  const out = new Uint8ClampedArray(sd);

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r0 = Math.max(1e-6, Math.hypot(cx, cy)); // half-diagonal ⇒ corner r = 1
  const k = (Math.max(-100, Math.min(100, p.distortion)) / 100) * 0.5;
  // 2% of image radius at full slider is a large lateral CA — real lenses need
  // far less, so this keeps the usable range in the middle of the slider.
  const kR = (Math.max(-100, Math.min(100, p.redCyan)) / 100) * 0.02;
  const kB = (Math.max(-100, Math.min(100, p.blueYellow)) / 100) * 0.02;
  const vig = Math.max(-100, Math.min(100, p.vignette)) / 100;
  const mid = Math.max(0, Math.min(100, p.midpoint)) / 100;
  const vigDenom = Math.max(0.01, 1 - mid);

  /** Vignette multiplier at normalised radius `rn`. Shared by both paths below
   *  so they cannot drift apart. */
  const vignetteAt = (rn: number): number => {
    if (vig === 0) return 1;
    let t = (rn - mid) / vigDenom;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t); // smoothstep
    const v = 1 + vig * t;
    return v < 0 ? 0 : v;
  };

  // Geometry is identity ⇒ the resample would return the source unchanged, so
  // skip it and apply only the vignette. This is the DEFAULT configuration
  // (vignette with no distortion or fringe correction), and the resample costs
  // ~180 ms of the ~200 ms at 1920×1080. Safe because the sampling path was
  // verified to be a BIT-EXACT identity at zero geometry before this shortcut
  // existed — see test-lens.ts, "all-zero params are an exact identity".
  if (k === 0 && kR === 0 && kB === 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (sd[o + 3] === 0) continue;
        const vf = vignetteAt(Math.hypot(x - cx, y - cy) / r0);
        if (vf === 1) continue;
        out[o] = clamp255(sd[o] * vf);
        out[o + 1] = clamp255(sd[o + 1] * vf);
        out[o + 2] = clamp255(sd[o + 2] * vf);
      }
    }
    return new ImageData(out, w, h, { colorSpace: cs });
  }

  /** Bilinear sample of one premultiplied channel + alpha, edges clamped. */
  const sample = (ch: Float32Array, fx: number, fy: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const x0c = clampi(x0, 0, w - 1);
    const x1c = clampi(x0 + 1, 0, w - 1);
    const y0c = clampi(y0, 0, h - 1);
    const y1c = clampi(y0 + 1, 0, h - 1);
    const a = ch[y0c * w + x0c];
    const b = ch[y0c * w + x1c];
    const c = ch[y1c * w + x0c];
    const d = ch[y1c * w + x1c];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ox = x - cx;
      const oy = y - cy;
      const rn = Math.hypot(ox, oy) / r0;
      const rn2 = rn * rn;
      const base = 1 + k * rn2;
      // Each channel gets its own radial scale; green is the reference, as it is
      // for real lens CA (the green channel defines the geometry). Kept as three
      // scalars rather than an array — this runs once per pixel, and allocating
      // here would mean millions of throwaway arrays per pass.
      const scR = base * (1 + kR * rn2);
      const scB = base * (1 + kB * rn2);
      const o = (y * w + x) * 4;

      const vf = vignetteAt(rn);

      // Each channel is unpremultiplied against the alpha sampled at ITS OWN
      // position — using green's alpha for all three would tint the very fringe
      // this is correcting.
      const rx = cx + ox * scR;
      const ry = cy + oy * scR;
      const aR = sample(sA, rx, ry);
      out[o] = clamp255((aR > 0 ? (sample(sR, rx, ry) * 255) / aR : 0) * vf);

      const gx = cx + ox * base;
      const gy = cy + oy * base;
      const aG = sample(sA, gx, gy);
      out[o + 1] = clamp255((aG > 0 ? (sample(sG, gx, gy) * 255) / aG : 0) * vf);

      const bx = cx + ox * scB;
      const by = cy + oy * scB;
      const aB = sample(sA, bx, by);
      out[o + 2] = clamp255((aB > 0 ? (sample(sB, bx, by) * 255) / aB : 0) * vf);

      out[o + 3] = clamp255(aG); // the silhouette follows green's geometry
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** One separable sliding-window MINIMUM pass. Min is separable exactly as a box
 *  blur is — min over a square equals min over rows then min over columns — so
 *  the patch costs O(r) per pixel instead of O(r²). */
function minPass(ch: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  if (r < 1) return;
  const tmp = new Float32Array(horizontal ? w : h);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = Infinity;
        for (let k = -r; k <= r; k++) {
          const v = ch[row + clampi(x + k, 0, w - 1)];
          if (v < m) m = v;
        }
        tmp[x] = m;
      }
      for (let x = 0; x < w; x++) ch[row + x] = tmp[x];
    }
  } else {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = Infinity;
        for (let k = -r; k <= r; k++) {
          const v = ch[clampi(y + k, 0, h - 1) * w + x];
          if (v < m) m = v;
        }
        tmp[y] = m;
      }
      for (let y = 0; y < h; y++) ch[y * w + x] = tmp[y];
    }
  }
}

/**
 * Dehaze via the dark-channel prior (He, Sun & Tang 2009).
 *
 * Haze is additive veiling light, so in a hazy patch NO colour channel is ever
 * really dark — whereas almost every haze-free outdoor patch has some channel
 * near zero somewhere. That gap is the whole signal: the "dark channel" (a local
 * minimum across space and across R/G/B) estimates how much veil sits in front
 * of each region, and the image is then inverted through `J = (I − A)/t + A`.
 *
 * Two deliberate simplifications from the paper, both about cost:
 *   - the atmospheric light `A` is averaged over the haziest 0.1% of pixels
 *     rather than taking a single brightest pixel — cheaper AND steadier, since
 *     one blown specular highlight would otherwise set it;
 *   - the transmission map is refined with a blur instead of the paper's soft
 *     matting / guided filter. That is edge-unaware, so very strong settings can
 *     halo along a high-contrast skyline; the blur radius is tied to the patch
 *     size to keep it modest.
 */
function dehaze(src: ImageData, p: DehazeParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const r = clampi(Math.round(p.radius), 1, 64);
  const omega = (Math.max(0, Math.min(100, p.amount)) / 100) * 0.95;
  const out = new Uint8ClampedArray(sd);
  if (omega <= 0) return new ImageData(out, w, h, { colorSpace: cs });

  // Per-pixel darkest channel, then the local minimum over the patch.
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) {
      dark[i] = 255; // transparent pixels must not drag the estimate down
      continue;
    }
    const m = sd[o] < sd[o + 1] ? sd[o] : sd[o + 1];
    dark[i] = m < sd[o + 2] ? m : sd[o + 2];
  }
  minPass(dark, w, h, r, true);
  minPass(dark, w, h, r, false);

  // Atmospheric light: mean RGB of the haziest 0.1% (highest dark-channel) pixels.
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Math.round(dark[i])))]++;
  const want = Math.max(1, Math.round(n * 0.001));
  let cut = 255;
  let acc = 0;
  while (cut > 0 && acc + hist[cut] < want) {
    acc += hist[cut];
    cut--;
  }
  // Among those candidates the paper takes the single BRIGHTEST pixel, which one
  // blown highlight can hijack. Averaging all of them instead goes too far the
  // other way: it UNDER-estimates A, which under-estimates transmission, which
  // over-divides — measured as a 26% contrast overshoot past the haze-free
  // reference on a synthetic scene. So: average only the candidates brighter
  // than the candidate mean. Robust like the mean, biased bright like the max.
  let mean = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (dark[i] < cut) continue;
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    mean += (sd[o] + sd[o + 1] + sd[o + 2]) / 3;
    cnt++;
  }
  if (cnt === 0) return new ImageData(out, w, h, { colorSpace: cs });
  mean /= cnt;
  let aR = 0;
  let aG = 0;
  let aB = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    if (dark[i] < cut) continue;
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    if ((sd[o] + sd[o + 1] + sd[o + 2]) / 3 < mean) continue;
    aR += sd[o];
    aG += sd[o + 1];
    aB += sd[o + 2];
    bright++;
  }
  if (bright === 0) return new ImageData(out, w, h, { colorSpace: cs });
  aR /= bright;
  aG /= bright;
  aB /= bright;
  const aMean = Math.max(1, (aR + aG + aB) / 3);

  // Transmission, then a cheap refinement pass.
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = 1 - omega * Math.min(1, dark[i] / aMean);
  gaussianChannel(t, w, h, Math.max(1, r * 2));

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    // t0 floor: as t → 0 the recovery divides by nothing and explodes into noise.
    const tt = Math.max(0.1, t[i]);
    out[o] = clamp255((sd[o] - aR) / tt + aR);
    out[o + 1] = clamp255((sd[o + 1] - aG) / tt + aG);
    out[o + 2] = clamp255((sd[o + 2] - aB) / tt + aB);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Clarity & Texture — local contrast at two scales.
 *
 * Both are unsharp masking, differing only in radius: Clarity works at a large
 * radius (broad tonal shaping) and Texture at a small one (fine detail). Two
 * things separate this from just adding a Sharpen filter twice:
 *   - it operates on LUMA and rescales RGB by the ratio, so boosting contrast
 *     does not drag saturation with it the way a per-channel unsharp does;
 *   - Clarity is weighted toward the MIDTONES (falling to zero at pure black and
 *     white), which is what stops it from carving halos into skies and blowing
 *     out highlights — the characteristic failure of naive clarity.
 */
function clarityTexture(src: ImageData, p: ClarityParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const kC = Math.max(-100, Math.min(100, p.clarity)) / 100;
  const kT = Math.max(-100, Math.min(100, p.texture)) / 100;
  if (kC === 0 && kT === 0) return new ImageData(out, w, h, { colorSpace: cs });

  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    Y[i] = 0.299 * sd[o] + 0.587 * sd[o + 1] + 0.114 * sd[o + 2];
  }
  const rC = Math.max(1, Math.min(400, p.radius));
  const rT = Math.max(1, rC * 0.075); // ~3 px at the default 40 px clarity radius
  let big: Float32Array | null = null;
  let small: Float32Array | null = null;
  if (kC !== 0) {
    big = Y.slice();
    gaussianChannel(big, w, h, rC);
  }
  if (kT !== 0) {
    small = Y.slice();
    gaussianChannel(small, w, h, rT);
  }

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (sd[o + 3] === 0) continue;
    const y = Y[i];
    let add = 0;
    if (big) {
      // Midtone weight: 1 at mid-grey, 0 at both ends.
      const t = y / 255;
      const mw = 1 - (2 * t - 1) * (2 * t - 1);
      add += kC * (y - big[i]) * mw;
    }
    if (small) add += kT * (y - small[i]);
    if (add === 0) continue;
    const ny = y + add;
    // Rescale RGB by the luma ratio so hue and saturation ride along unchanged.
    const ratio = y > 1 ? ny / y : 1;
    if (y > 1) {
      out[o] = clamp255(sd[o] * ratio);
      out[o + 1] = clamp255(sd[o + 1] * ratio);
      out[o + 2] = clamp255(sd[o + 2] * ratio);
    } else {
      out[o] = clamp255(sd[o] + add);
      out[o + 1] = clamp255(sd[o + 1] + add);
      out[o + 2] = clamp255(sd[o + 2] + add);
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Film grain — distinct from Add Noise in three ways that matter.
 *
 *   SIZE. Real grain is clumps of silver, not per-pixel speckle, so the noise is
 *   generated on a coarse lattice and bilinearly interpolated up. Size 1 gives
 *   the per-pixel case Add Noise already covers.
 *
 *   ROUGHNESS. A second, much coarser noise field modulates the first one's
 *   amplitude, so the grain varies across the frame instead of sitting at one
 *   uniform strength — that unevenness is most of what reads as "film".
 *
 *   TONE RESPONSE. Grain is applied to luma and weighted toward the midtones:
 *   film shows little grain in deep shadow or blown highlight, and skipping this
 *   is what makes synthetic grain look like it was pasted on top.
 */
function grain(src: ImageData, p: GrainParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const amp = (Math.max(0, Math.min(100, p.amount)) / 100) * 96;
  if (amp <= 0) return new ImageData(out, w, h, { colorSpace: cs });
  const size = Math.max(1, Math.min(32, p.size));
  const rough = Math.max(0, Math.min(100, p.roughness)) / 100;
  const seed = p.seed | 0 || 1;

  /** Value noise on a lattice of spacing `cell`, bilinearly interpolated. */
  const lattice = (x: number, y: number, cell: number, lane: number): number => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    let tx = gx - x0;
    let ty = gy - y0;
    tx = tx * tx * (3 - 2 * tx); // smoothstep keeps the lattice from showing
    ty = ty * ty * (3 - 2 * ty);
    const a = hash01(x0, y0, seed, lane);
    const b = hash01(x0 + 1, y0, seed, lane);
    const c = hash01(x0, y0 + 1, seed, lane);
    const d = hash01(x0 + 1, y0 + 1, seed, lane);
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (sd[o + 3] === 0) continue;
      const g = lattice(x, y, size, 0) * 2 - 1; // −1…1
      // Roughness: a coarse field (8× the grain size) scaling local amplitude.
      const rv = rough > 0 ? lattice(x, y, size * 8, 3) : 0.5;
      const local = 1 - rough + rough * (rv * 2);
      const yv = 0.299 * sd[o] + 0.587 * sd[o + 1] + 0.114 * sd[o + 2];
      const t = yv / 255;
      const tone = 1 - (2 * t - 1) * (2 * t - 1); // midtone-weighted, 0 at the ends
      const d = g * amp * local * tone;
      out[o] = clamp255(sd[o] + d);
      out[o + 1] = clamp255(sd[o + 1] + d);
      out[o + 2] = clamp255(sd[o + 2] + d);
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Oil Paint — the intensity-histogram painterly filter: each pixel takes the
 * AVERAGE COLOUR of whichever intensity bucket is most common in its
 * neighbourhood. Picking the modal bucket rather than the mean is what produces
 * flat strokes with hard boundaries instead of a blur.
 *
 * Uses the same sliding-window trick as Median: moving one pixel right removes a
 * column and adds a column, so the cost is O(r) per pixel rather than O(r²).
 * Here the window carries four accumulators per bucket (count + RGB sums)
 * instead of one histogram.
 */
function oilPaint(src: ImageData, p: OilParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const r = clampi(Math.round(p.radius), 1, 16);
  const levels = clampi(Math.round(p.levels), 2, 64);

  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = (sd[o] + sd[o + 1] + sd[o + 2]) / 3;
    bin[i] = Math.min(levels - 1, Math.floor((v * levels) / 256));
  }
  const cnt = new Int32Array(levels);
  const aR = new Int32Array(levels);
  const aG = new Int32Array(levels);
  const aB = new Int32Array(levels);
  const addCol = (x: number, y: number, sign: number) => {
    const xc = clampi(x, 0, w - 1);
    for (let dy = -r; dy <= r; dy++) {
      const i = clampi(y + dy, 0, h - 1) * w + xc;
      const o = i * 4;
      if (sd[o + 3] === 0) continue; // transparent pixels are not paint
      const b = bin[i];
      cnt[b] += sign;
      aR[b] += sign * sd[o];
      aG[b] += sign * sd[o + 1];
      aB[b] += sign * sd[o + 2];
    }
  };

  for (let y = 0; y < h; y++) {
    cnt.fill(0);
    aR.fill(0);
    aG.fill(0);
    aB.fill(0);
    for (let dx = -r; dx <= r; dx++) addCol(dx, y, 1);
    for (let x = 0; x < w; x++) {
      if (x > 0) {
        addCol(x - 1 - r, y, -1);
        addCol(x + r, y, 1);
      }
      const o = (y * w + x) * 4;
      if (sd[o + 3] === 0) continue;
      let best = -1;
      let bestC = 0;
      for (let b = 0; b < levels; b++) {
        if (cnt[b] > bestC) {
          bestC = cnt[b];
          best = b;
        }
      }
      if (best < 0 || bestC === 0) continue;
      out[o] = clamp255(aR[best] / bestC);
      out[o + 1] = clamp255(aG[best] / bestC);
      out[o + 2] = clamp255(aB[best] / bestC);
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Halftone — a real printing screen, not a texture overlay.
 *
 * Each pixel asks which screen cell it falls in (in a ROTATED lattice), reads
 * the source value at that cell's centre, and turns it into a dot whose AREA is
 * proportional to the value — which is how physical halftone works, and why the
 * radius goes as √value rather than value.
 *
 * Colour mode screens cyan, magenta and yellow separately at the classic
 * offsets (15° / 75° / 0° from the base angle). Those specific angles are not
 * decoration: screens at similar angles beat against each other and produce
 * moiré, and 30° separation is the standard remedy.
 */
function halftone(src: ImageData, p: HalftoneParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const cell = Math.max(2, Math.min(64, p.size));
  const maxR = cell * 0.5 * Math.SQRT2; // dots may just touch at full value
  const screens = p.mono ? [{ ang: p.angle, ch: -1 }] : [
    { ang: p.angle + 15, ch: 0 }, // cyan
    { ang: p.angle + 75, ch: 1 }, // magenta
    { ang: p.angle, ch: 2 }, // yellow
  ];
  const prep = screens.map((s) => {
    const rad = (s.ang * Math.PI) / 180;
    return { ch: s.ch, ca: Math.cos(rad), sa: Math.sin(rad) };
  });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (sd[o + 3] === 0) continue;
      const cov: number[] = [0, 0, 0];
      for (const s of prep) {
        // Rotate into screen space, snap to the nearest lattice node.
        const u = x * s.ca + y * s.sa;
        const v = -x * s.sa + y * s.ca;
        const cu = Math.round(u / cell) * cell;
        const cv = Math.round(v / cell) * cell;
        // Rotate the node back to read the source there.
        const sx = clampi(Math.round(cu * s.ca - cv * s.sa), 0, w - 1);
        const sy = clampi(Math.round(cu * s.sa + cv * s.ca), 0, h - 1);
        const so = (sy * w + sx) * 4;
        // Ink coverage: subtractive for colour, luminance for mono.
        const ink =
          s.ch < 0
            ? 1 - (0.299 * sd[so] + 0.587 * sd[so + 1] + 0.114 * sd[so + 2]) / 255
            : 1 - sd[so + s.ch] / 255;
        const dot = maxR * Math.sqrt(Math.max(0, Math.min(1, ink)));
        const d = Math.hypot(u - cu, v - cv);
        // ~1px soft edge, or the dots alias into visible stair-steps.
        const a = dot <= 0 ? 0 : Math.max(0, Math.min(1, (dot - d) / 1 + 0.5));
        if (s.ch < 0) {
          cov[0] = cov[1] = cov[2] = a;
        } else {
          cov[s.ch] = a;
        }
      }
      out[o] = clamp255(255 * (1 - cov[0]));
      out[o + 1] = clamp255(255 * (1 - cov[1]));
      out[o + 2] = clamp255(255 * (1 - cov[2]));
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Crystallize — a Voronoi mosaic. One jittered site per grid cell, every pixel
 * takes the flat AVERAGE colour of the cell it belongs to.
 *
 * Jittering the sites inside their cells is what makes the result read as
 * crystals rather than as the square Mosaic filter; searching only the 3×3
 * neighbouring cells is exact, because a jittered site can never be nearer than
 * one belonging to a cell further away than that.
 */
function crystallize(src: ImageData, p: CrystallizeParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const cell = Math.max(2, Math.min(200, p.size));
  const gw = Math.max(1, Math.ceil(w / cell) + 1);
  const gh = Math.max(1, Math.ceil(h / cell) + 1);
  const sx = new Float32Array(gw * gh);
  const sy = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      sx[i] = (gx + hash01(gx, gy, 1, 0)) * cell;
      sy[i] = (gy + hash01(gx, gy, 1, 1)) * cell;
    }

  const owner = new Int32Array(w * h);
  const accR = new Float64Array(gw * gh);
  const accG = new Float64Array(gw * gh);
  const accB = new Float64Array(gw * gh);
  const accA = new Float64Array(gw * gh);
  const accN = new Int32Array(gw * gh);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx0 = Math.min(gw - 1, Math.floor(x / cell));
      const gy0 = Math.min(gh - 1, Math.floor(y / cell));
      let bestI = -1;
      let bestD = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const gx = gx0 + dx;
          const gy = gy0 + dy;
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const i = gy * gw + gx;
          const ddx = sx[i] - x;
          const ddy = sy[i] - y;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            bestI = i;
          }
        }
      const pi = y * w + x;
      owner[pi] = bestI;
      const o = pi * 4;
      accR[bestI] += sd[o];
      accG[bestI] += sd[o + 1];
      accB[bestI] += sd[o + 2];
      accA[bestI] += sd[o + 3];
      accN[bestI]++;
    }
  }
  for (let pi = 0, nn = w * h; pi < nn; pi++) {
    const i = owner[pi];
    const c = accN[i];
    if (c === 0) continue;
    const o = pi * 4;
    out[o] = clamp255(accR[i] / c);
    out[o + 1] = clamp255(accG[i] / c);
    out[o + 2] = clamp255(accB[i] / c);
    out[o + 3] = clamp255(accA[i] / c);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Glitch — horizontal band displacement, channel separation and scanlines.
 *
 * Bands are displaced as whole blocks (all rows of a block share one offset),
 * because per-row noise reads as static rather than as a broken signal. The
 * channel shift is applied AFTER displacement so the fringe rides along with the
 * torn bands, which is what a real signal fault looks like.
 */
function glitch(src: ImageData, p: GlitchParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd.length);
  const amt = Math.max(0, Math.min(100, p.amount)) / 100;
  const block = Math.max(1, Math.min(256, Math.round(p.blockSize)));
  const shift = Math.round(p.rgbShift);
  const scan = Math.max(0, Math.min(100, p.scanlines)) / 100;
  const seed = p.seed | 0 || 1;

  for (let y = 0; y < h; y++) {
    const b = Math.floor(y / block);
    // Most bands stay put; a minority tear. A uniform jitter on every band just
    // looks like horizontal noise.
    const roll = hash01(0, b, seed, 0);
    const off =
      roll < 0.35 ? Math.round((hash01(1, b, seed, 1) * 2 - 1) * amt * w * 0.12) : 0;
    const dim = scan > 0 && y % 2 === 1 ? 1 - scan * 0.6 : 1;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const rx = clampi(x - off, 0, w - 1);
      const base = (y * w + rx) * 4;
      const rxR = clampi(x - off + shift, 0, w - 1);
      const rxB = clampi(x - off - shift, 0, w - 1);
      out[o] = clamp255(sd[(y * w + rxR) * 4] * dim);
      out[o + 1] = clamp255(sd[base + 1] * dim);
      out[o + 2] = clamp255(sd[(y * w + rxB) * 4 + 2] * dim);
      out[o + 3] = sd[base + 3];
    }
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/**
 * Drop Shadow, baked into the layer's own pixels.
 *
 * Layer Effects ▸ Drop Shadow is the better tool for the usual case: it is live,
 * re-editable, and free to spill OUTSIDE the layer. This exists for the case
 * that one cannot serve — a shadow that later filters in the stack can see,
 * because it is part of the pixels by the time they run. The tradeoff is real
 * and unavoidable: filters never enlarge a layer, so this shadow is CLIPPED at
 * the layer bounds.
 */
function canvasShadow(src: ImageData, p: CanvasShadowParams, cs: PredefinedColorSpace): ImageData {
  const w = src.width;
  const h = src.height;
  const n = w * h;
  const sd = src.data;
  const out = new Uint8ClampedArray(sd);
  const op = Math.max(0, Math.min(100, p.opacity)) / 100;
  if (op <= 0) return new ImageData(out, w, h, { colorSpace: cs });

  const rgb = parseHexRGB(p.color);
  const rad = (p.angle * Math.PI) / 180;
  const dx = Math.round(-Math.cos(rad) * p.distance);
  const dy = Math.round(Math.sin(rad) * p.distance);

  const shadow = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sxp = x - dx;
      const syp = y - dy;
      if (sxp < 0 || syp < 0 || sxp >= w || syp >= h) continue;
      shadow[y * w + x] = sd[(syp * w + sxp) * 4 + 3];
    }
  if (p.size > 0) gaussianChannel(shadow, w, h, p.size);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const sa = (shadow[i] / 255) * op;
    if (sa <= 0) continue;
    const la = sd[o + 3] / 255;
    // Shadow UNDER the layer: composite the layer over a shadow-coloured base.
    const outA = la + sa * (1 - la);
    if (outA <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const under = rgb[c] * sa * (1 - la);
      out[o + c] = clamp255((sd[o + c] * la + under) / outA);
    }
    out[o + 3] = clamp255(outA * 255);
  }
  return new ImageData(out, w, h, { colorSpace: cs });
}

/** #rgb / #rrggbb → [r,g,b]. Unparseable input falls back to black. */
function parseHexRGB(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return [0, 0, 0];
  const v = m[1];
  if (v.length === 3) {
    return [
      parseInt(v[0] + v[0], 16),
      parseInt(v[1] + v[1], 16),
      parseInt(v[2] + v[2], 16),
    ];
  }
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
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
    case "highpass":
      return highPass(src, f.params, cs);
    case "median":
      return medianFilter(src, f.params, cs);
    case "dustscratches":
      return dustAndScratches(src, f.params, cs);
    case "denoise":
      return reduceNoise(src, f.params, cs);
    case "lens":
      return lensCorrection(src, f.params, cs);
    case "dehaze":
      return dehaze(src, f.params, cs);
    case "clarity":
      return clarityTexture(src, f.params, cs);
    case "grain":
      return grain(src, f.params, cs);
    case "oil":
      return oilPaint(src, f.params, cs);
    case "halftone":
      return halftone(src, f.params, cs);
    case "crystallize":
      return crystallize(src, f.params, cs);
    case "glitch":
      return glitch(src, f.params, cs);
    case "canvasshadow":
      return canvasShadow(src, f.params, cs);
  }
}
