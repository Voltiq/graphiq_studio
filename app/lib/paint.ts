import { parseColor, toHex8 } from "./color";
import type { Rect } from "./view";
import type { LayerNode } from "./layers";
import { applyAdjustments, isDefaultAdjust, type Adjustments } from "./adjust";
import { renderShape, type ShapeGeom } from "./shapes";
import { buildCanvasGradient } from "./gradient";
import { renderPenStroke } from "./pen";
import type {
  BlurSettings,
  DodgeSettings,
  GradientStop,
  GradientType,
  PenAnchor,
  PenSettings,
  ShapeKind,
} from "./tools";

export interface BrushSettings {
  size: number; // px (document space)
  hardness: number; // 0–100
  opacity: number; // 0–100 (per-stroke cap)
  flow: number; // 0–100 (build-up within a stroke)
  blend: string;
  smoothing: number; // 0–100
}

/** A doc-space line segment (marching-ants outline edge). */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Magic-wand result: rects drive the selection pipeline; segs draw the ants. */
export interface WandSelection {
  rects: Rect[];
  segments: Seg[];
}

/** Tight, half-open bounding box of a mask region: [x0,x1) × [y0,y1). */
interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Decompose a boolean mask into rectangles: per-row runs greedily extended
 * downward while the run directly below is identical (cuts the rect count for
 * solid regions). Non-overlapping; covers exactly the masked pixels. Scans only
 * the region's bounding box.
 */
function maskToRects(mask: Uint8Array, w: number, b: Bounds): Rect[] {
  const rects: Rect[] = [];
  let open: Rect[] = [];
  for (let y = b.y0; y < b.y1; y++) {
    const next: Rect[] = [];
    const used = new Uint8Array(open.length);
    let x = b.x0;
    const row = y * w;
    while (x < b.x1) {
      if (!mask[row + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < b.x1 && mask[row + x]) x++;
      const rw = x - start;
      // Continue an open rect with the same x/width directly above.
      let matched = -1;
      for (let k = 0; k < open.length; k++) {
        if (!used[k] && open[k].x === start && open[k].w === rw) {
          matched = k;
          break;
        }
      }
      if (matched >= 0) {
        open[matched].h++;
        used[matched] = 1;
        next.push(open[matched]);
      } else {
        next.push({ x: start, y, w: rw, h: 1 });
      }
    }
    for (let k = 0; k < open.length; k++) if (!used[k]) rects.push(open[k]);
    open = next;
  }
  for (const o of open) rects.push(o);
  return rects;
}

/**
 * Trace the boundary of a boolean mask into merged collinear ants segments.
 * Scans only the region's bounding box, with the mask indexed inline (no
 * per-pixel closure) — this is the hot path during live tolerance updates.
 */
function maskToSegments(mask: Uint8Array, w: number, h: number, b: Bounds): Seg[] {
  const segs: Seg[] = [];
  // Horizontal edges: grid line y in [y0,y1], columns [x0,x1).
  for (let y = b.y0; y <= b.y1; y++) {
    const above = y > 0 ? (y - 1) * w : -1;
    const cur = y < h ? y * w : -1;
    let run = -1;
    for (let x = b.x0; x <= b.x1; x++) {
      const a = above >= 0 && x < b.x1 && mask[above + x] === 1;
      const c = cur >= 0 && x < b.x1 && mask[cur + x] === 1;
      const edge = x < b.x1 && a !== c;
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) {
        segs.push({ x1: run, y1: y, x2: x, y2: y });
        run = -1;
      }
    }
  }
  // Vertical edges: grid line x in [x0,x1], rows [y0,y1).
  for (let x = b.x0; x <= b.x1; x++) {
    const left = x > 0 ? x - 1 : -1;
    const cur = x < w ? x : -1;
    let run = -1;
    for (let y = b.y0; y <= b.y1; y++) {
      const row = y < b.y1 ? y * w : -1;
      const a = row >= 0 && left >= 0 && mask[row + left] === 1;
      const c = row >= 0 && cur >= 0 && mask[row + cur] === 1;
      const edge = y < b.y1 && a !== c;
      if (edge && run < 0) run = y;
      else if (!edge && run >= 0) {
        segs.push({ x1: x, y1: run, x2: x, y2: y });
        run = -1;
      }
    }
  }
  return segs;
}

export interface HistorySummary {
  items: { label: string }[];
  index: number;
}

/** Per-channel tonal distribution of the composite (256 bins per channel). */
export interface ChannelHistogram {
  r: number[];
  g: number[];
  b: number[];
}

export interface EngineHandle {
  undo: () => void;
  redo: () => void;
  jumpTo: (index: number) => void;
  fillSelection: (
    layerId: string,
    rects: Rect[],
    colorHex: string,
    angle?: number,
    pivot?: { x: number; y: number } | null,
    feather?: number,
  ) => void;
  eraseSelection: (
    layerId: string,
    rects: Rect[],
    angle?: number,
    pivot?: { x: number; y: number } | null,
    label?: string,
    feather?: number,
  ) => void;
  copyRegion: (
    rects: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => CopyResult | null;
  isFloating: () => boolean;
  commitFloat: () => void;
  discardFloat: () => void;
  duplicateLayer: (srcId: string, dstId: string) => void;
  rasterize: (targetId: string, nodes: LayerNode[], deleteIds: string[]) => void;
  removeLayer: (id: string) => void;
  getLayerImage: (id: string) => string | null;
  setLayerImage: (id: string, source: CanvasImageSource) => void;
  exportComposite: (tree: LayerNode[]) => HTMLCanvasElement;
  /** Per-channel tonal distribution of the composited canvas. */
  histogram: (tree: LayerNode[]) => ChannelHistogram;
  /** Subscribe to content changes (returns an unsubscribe fn). */
  subscribe: (cb: () => void) => () => void;
  resizeImage: (w: number, h: number, ids?: string[], smooth?: boolean) => void;
  /** Rotate/flip the whole image (90° rotations swap the dimensions). */
  transformImage: (kind: ImageTransform, ids?: string[]) => void;
  /** Erase a layer's pixels (e.g. to hide a vector layer while re-editing it). */
  clearLayerPixels: (layerId: string) => void;
  /** Rasterise styled text onto a layer (no history; caller folds into a step). */
  renderText: (layerId: string, spec: TextRenderSpec) => void;
  /** The bounds styled text would rasterize into (for re-edit hit-testing). */
  textBounds: (spec: TextRenderSpec) => { x: number; y: number; w: number; h: number };
  /** Rasterise a shape onto a layer, clearing it first (no history). */
  rasterizeShape: (
    layerId: string,
    box: Rect,
    angle: number,
    kind: ShapeKind,
    fill: string,
    stroke: string,
    strokeWidth: number,
    radius: number,
    geom?: ShapeGeom,
  ) => void;
  /** Blur brush: begin / extend / finish a focus-softening stroke. */
  beginBlur: (
    layerId: string,
    blur: BlurSettings,
    x: number,
    y: number,
    clip?: Rect[] | null,
    clipAngle?: number,
    clipPivot?: { x: number; y: number } | null,
  ) => void;
  moveBlur: (x: number, y: number) => void;
  endBlur: () => void;
  /** Blur Gallery: begin / preview / commit / cancel a live blur-effect session. */
  beginBlurFx: (
    ids: string[],
    sel: Rect[] | null,
    selAngle?: number,
    selPivot?: { x: number; y: number } | null,
  ) => void;
  previewBlurFx: (
    kind: string,
    amount: number,
    angle: number,
    anchorX?: number,
    anchorY?: number,
  ) => void;
  commitBlurFx: (label: string) => void;
  cancelBlurFx: () => void;
  /** Snapshot owned layers + size for an undoable crop. */
  cropSnapshot: (ids: string[]) => CropSnapshot;
  /** Crop (and optionally straighten) owned layers to `rect`, resizing the doc. */
  applyCrop: (rect: Rect, ids: string[], angle?: number) => void;
  /** Restore a pre-crop snapshot (crop undo/redo). */
  cropRestore: (snap: CropSnapshot) => void;
  applyAdjust: (
    layerId: string,
    adj: Adjustments,
    sel?: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => void;
  /** Finalize the live adjustment session, keeping its history entry. */
  endAdjust: () => void;
  /** Discard the live adjustment session (restore original, drop its entry). */
  revertAdjust: () => void;
  setColorSpace: (cs: PredefinedColorSpace) => void;
  captureLeaves: (ids: string[]) => Map<string, ImageData | null>;
  restoreLeaves: (snaps: Map<string, ImageData | null>) => void;
  pushStructural: (label: string, undo: () => void, redo: () => void) => void;
}

export interface CopyResult {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/** A paste waiting to be drawn once its target document is active & sized. */
export interface PendingPaste {
  docId: string;
  layerId: string;
  source: ImageBitmap | HTMLCanvasElement;
  x: number;
  y: number;
  /** Structural undo/redo (layer added, canvas resized) folded into this step. */
  side?: HistorySide;
  /** Paste as a floating selection (merged on deselect) instead of baking now. */
  float?: boolean;
}

const BLEND_MAP: Record<string, GlobalCompositeOperation> = {
  Normal: "source-over",
  Dissolve: "source-over",
  Darken: "darken",
  Multiply: "multiply",
  "Color Burn": "color-burn",
  "Linear Burn": "multiply",
  Lighten: "lighten",
  Screen: "screen",
  "Color Dodge": "color-dodge",
  Add: "lighter",
  Overlay: "overlay",
  "Soft Light": "soft-light",
  "Hard Light": "hard-light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
};
const blendOp = (b: string): GlobalCompositeOperation => BLEND_MAP[b] ?? "source-over";

const makeCanvas = (
  w: number,
  h: number,
  readFreq = false,
  colorSpace: PredefinedColorSpace = "srgb",
) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: readFreq, colorSpace })!;
  return { c, ctx };
};

interface Layer {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export type StrokeMode = "paint" | "erase";

/** Everything needed to rasterise a block of styled text onto a layer. */
export interface TextRenderSpec {
  text: string;
  /** Top-left of the text block, doc coords. */
  x: number;
  y: number;
  /** Paragraph box width (doc px) for word-wrap; null = point text (no wrap). */
  boxW: number | null;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
  tracking: number;
  color: string;
  /** Anti-alias edges; false thresholds the alpha to hard 1-bit edges. */
  antialias: boolean;
}

/** Pre-crop layer pixels + document size, captured so a crop can be undone. */
export interface CropSnapshot {
  w: number;
  h: number;
  layers: { id: string; c: HTMLCanvasElement }[];
}

/** Whole-image transforms (Image menu). 90° rotations swap the dimensions. */
export type ImageTransform = "rotate-cw" | "rotate-ccw" | "flip-h" | "flip-v";

/** Optional document-structure changes tied to a history step (e.g. a paste
    that also added a layer / resized the canvas). */
export interface HistorySide {
  undo: () => void;
  redo: () => void;
}

interface Entry {
  label: string;
  side?: HistorySide;
  // Pixel payload — absent for purely structural entries (layer add/group/etc.),
  // whose effect lives entirely in `side`.
  layerId?: string;
  rect?: { x: number; y: number; w: number; h: number };
  before?: ImageData;
  after?: ImageData;
}

const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * One running-sum box-blur pass over a single float channel of a w×h block, along
 * the horizontal or vertical axis. Edges extend (clamp the sample index). Three
 * passes per axis approximate a Gaussian; O(1) per pixel regardless of radius, so
 * even large blur radii on big brushes stay cheap.
 */
function boxBlurPass(ch: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  if (r < 1) return;
  const norm = 1 / (2 * r + 1);
  if (horizontal) {
    const tmp = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += ch[row + clampi(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[x] = sum * norm;
        sum += ch[row + clampi(x + r + 1, 0, w - 1)] - ch[row + clampi(x - r, 0, w - 1)];
      }
      ch.set(tmp, row);
    }
  } else {
    const tmp = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += ch[clampi(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        tmp[y] = sum * norm;
        sum += ch[clampi(y + r + 1, 0, h - 1) * w + x] - ch[clampi(y - r, 0, h - 1) * w + x];
      }
      for (let y = 0; y < h; y++) ch[y * w + x] = tmp[y];
    }
  }
}

/** Premultiply an RGBA8 region into per-channel float arrays (alpha kept 0–255). */
function premultChannels(d: Uint8ClampedArray, n: number) {
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
 * alpha edges don't darken). When `mask` is given the blurred result is blended
 * back only inside it (a selection), reading neighbours from the full image so
 * the selection edge isn't darkened. `cx,cy` is the centre for zoom/spin.
 */
function computeBlurFx(
  orig: ImageData,
  kind: string,
  amount: number,
  angle: number,
  mask: Uint8ClampedArray | null,
  cx: number,
  cy: number,
  cs: PredefinedColorSpace,
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

/**
 * Imperative raster paint engine. Holds one offscreen canvas per layer plus a
 * per-stroke buffer. Painting accumulates into the stroke buffer; the buffer is
 * composited onto the layer once (at brush opacity) when the stroke ends — this
 * is what stops a single stroke from darkening where it overlaps itself, while
 * still letting a new stroke stack on top of the previous result.
 */
export class PaintEngine {
  private w = 0;
  private h = 0;
  private view: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private layers = new Map<string, Layer>();
  private stroke: Layer | null = null;
  private scratch: Layer | null = null;
  private measureCtx: CanvasRenderingContext2D | null = null; // throwaway ctx for text measuring
  // Working colour space. Layer/scratch/float/export buffers use it (wide-gamut
  // preserved); the stroke buffer + brush tip stay sRGB so brush colours, which
  // are authored from sRGB hex, convert correctly when composited onto layers.
  private cs: PredefinedColorSpace = "srgb";

  /** Make a canvas in the working colour space (for layer-content buffers). */
  private mk(w: number, h: number, readFreq = false) {
    return makeCanvas(w, h, readFreq, this.cs);
  }

  private painting = false;
  private strokeLayer: string | null = null;
  private brush: BrushSettings | null = null;
  private mode: StrokeMode = "paint";
  private strokeLabel = "Brush"; // history label for the current stroke
  private clip: Rect[] | null = null;
  private clipAngle = 0;
  private clipPivot: { x: number; y: number } | null = null;
  private col = { r: 0, g: 0, b: 0, a: 1 };
  // Pre-baked brush tip for the current stroke (rebuilt per beginStroke). Hard
  // tips are stamped crisp on the integer grid; soft tips at sub-pixel with
  // smoothing. Baking once avoids re-dithering a gradient on every stamp.
  private tip: HTMLCanvasElement | null = null;
  private tipHard = false;

  // Blur-brush session. We never destroy the original pixels mid-stroke: `blurOrig`
  // holds them, `blurCov` accumulates per-pixel brush coverage (0–1), and the live
  // result is always lerp(orig, blur(orig), cov × strength). This keeps a stroke
  // even (no blotches on slow drags) while still compounding across strokes (each
  // new stroke re-reads the layer, i.e. the previous result).
  private blurring = false;
  private blurLayer: string | null = null;
  private blurOrig: ImageData | null = null; // layer pixels at stroke start
  private blurSrc: ImageData | null = null; // blur source (orig, or composite for sampleAll)
  private blurCov: Float32Array | null = null; // per-pixel coverage 0–1, doc-sized
  private blurTip: { data: Float32Array; size: number; r: number } | null = null;
  private blurOpts: BlurSettings | null = null;
  private blurDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private blurStep = 1;
  private blurResidual = 0;
  private blurLast = { x: 0, y: 0 };
  private blurLastRaw = { x: 0, y: 0 };
  private blurSmoothPt = { x: 0, y: 0 };
  private blurSelMask: Uint8ClampedArray | null = null;

  // Dodge/Burn session. Same coverage-mask model as blur (orig snapshot + a 0–1
  // coverage buffer, re-baked as effect(orig, coverage × exposure)), so a stroke
  // stays even and compounds across strokes. `bakeDodge` applies the tonal curve.
  private dodging = false;
  private dodgeLayer: string | null = null;
  private dodgeOrig: ImageData | null = null;
  private dodgeCov: Float32Array | null = null;
  private dodgeTip: { data: Float32Array; size: number; r: number } | null = null;
  private dodgeOpts: DodgeSettings | null = null;
  private dodgeDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private dodgeStep = 1;
  private dodgeResidual = 0;
  private dodgeLast = { x: 0, y: 0 };
  private dodgeLastRaw = { x: 0, y: 0 };
  private dodgeSmoothPt = { x: 0, y: 0 };
  private dodgeSelMask: Uint8ClampedArray | null = null;

  // Blur Gallery (Effects ▸ Blur Gallery) live preview session: the affected
  // layers' original pixels + a selection mask + the zoom/spin centre.
  private blurFx: {
    ids: string[];
    orig: Map<string, ImageData>;
    mask: Uint8ClampedArray | null;
  } | null = null;

  // Clone-stamp session. Reuses the brush stroke buffer/flow/opacity pipeline, but
  // each dab paints pixels sampled from `cloneSample` at (brushPoint + cloneOff)
  // instead of a solid colour. `cloneSample` is snapshotted at stroke start so the
  // clone never feeds back on itself mid-stroke.
  private cloneActive = false;
  private cloneSample: Layer | null = null;
  private cloneDab: Layer | null = null;
  private cloneOff: { x: number; y: number } | null = null;

  // Move session
  private moving = false;
  private moveLayer: string | null = null;
  private moveFloat: Layer | null = null;
  private moveOrig: Layer | null = null;
  private moveSrc: Rect | null = null;
  private moveOff = { x: 0, y: 0 };

  // Floating content sitting above a layer, not yet merged (paste, or a moved selection).
  private floatActive = false;
  private floatLayer: string | null = null;
  private floatSource: ImageBitmap | HTMLCanvasElement | null = null;
  private floatBase = { x: 0, y: 0 };
  private floatOff = { x: 0, y: 0 };
  private floatSide: HistorySide | undefined = undefined;
  // When the float was lifted from the layer (move-a-selection): pristine copy
  // for history/discard, and the lifted region's original bounds.
  private floatOrig: Layer | null = null;
  private floatSrcRect: Rect | null = null;
  // When set, the float is drawn scaled into this rect (resize-content) instead
  // of translated by floatOff.
  private floatDst: Rect | null = null;
  // When non-zero, the float is drawn rotated by this many radians about
  // floatPivot (or the lifted region's centre). Takes precedence over floatDst.
  private floatAngle = 0;
  private floatPivot: { x: number; y: number } | null = null;
  // Resize-content of an ALREADY-ROTATED selection: scale the lifted (world)
  // pixels within the rotated frame — local src→dst, then rotate by frameAngle
  // about framePivot. Takes precedence over the plain floatDst scale.
  private floatScaleSrc: Rect | null = null;
  private floatFrameAngle = 0;
  private floatFramePivot: { x: number; y: number } | null = null;

  // Live adjustment preview: the target leaf, a snapshot of its original pixels,
  // and the adjusted result shown in its place until committed.
  private adjLayer: string | null = null;
  private adjOrig: ImageData | null = null;
  private adjEntry: Entry | null = null;
  private adjPending: Adjustments | null = null;
  private adjRaf = 0;
  // Live shape session (re-renderable until finalized by endShape).
  private shapeLayer: string | null = null;
  private shapeOrig: ImageData | null = null;
  private shapeBounds: Rect | null = null;
  private shapeEntry: Entry | null = null;
  // Live gradient session (re-renderable until finalized by endGradient).
  private gradLayer: string | null = null;
  private gradOrig: ImageData | null = null;
  private gradBounds: Rect | null = null;
  private gradEntry: Entry | null = null;
  // Live pen-path session (re-renderable until finalized by endPath). The path
  // grows as anchors are added, so the whole layer is snapshotted for restores
  // and the history entry is captured once — tightly — at commit time.
  private pathLayer: string | null = null;
  private pathOrig: Layer | null = null;
  private pathState: {
    anchors: PenAnchor[];
    closed: boolean;
    settings: PenSettings;
    color: string;
  } | null = null;
  // Live bucket-fill session (re-renderable from its region + colour until
  // finalized by endFill). The region can grow with tolerance, so the whole
  // layer is snapshotted for restores; the tight entry is captured at commit.
  private fillLayer: string | null = null;
  private fillOrig: Layer | null = null;
  private fillState: { rects: Rect[]; color: string; antialias: boolean } | null = null;
  // Cached magic-wand source pixels, reused across live (tolerance) re-runs and
  // dropped on any layer mutation (see invalidateWandSrc).
  private wandSrc: {
    data: Uint8ClampedArray;
    w: number;
    h: number;
    layerId: string;
    sampleAll: boolean;
  } | null = null;
  // Reused magic-wand scratch buffers (mask / flood-fill stack / visited).
  private wandBuf: { mask: Uint8Array; stack: Int32Array; seen: Uint8Array; n: number } | null = null;
  // When set, adjustments only affect this (possibly rotated) selection region.
  private adjSel: Rect[] | null = null;
  private adjSelAngle = 0;
  private adjSelPivot: { x: number; y: number } | null = null;
  // Whether scaled float content is interpolated (smooth) or nearest-neighbour.
  private floatSmooth = true;
  private last = { x: 0, y: 0 };
  private lastRaw = { x: 0, y: 0 };
  private smooth = { x: 0, y: 0 };
  private residual = 0;
  private step = 1;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  private entries: Entry[] = [];
  private pos = 0;

  onChange: () => void = () => {};
  onHistory: (s: HistorySummary) => void = () => {};
  /** Fired when a live adjustment session ends (so the UI can reset its sliders). */
  onAdjustEnd: () => void = () => {};
  /** Fired when a live shape session ends (so the UI can drop its handle). */
  onShapeEnd: () => void = () => {};
  /** Fired when a live gradient session ends (so the UI can drop its handles). */
  onGradientEnd: () => void = () => {};
  /** Fired when a live pen-path session ends (so the UI can drop the path). */
  onPathEnd: () => void = () => {};
  /** Fired when a live bucket-fill session ends (so the UI can drop its marker). */
  onFillEnd: () => void = () => {};
  /** Extra content-change listeners (e.g. the live histogram panel). */
  private changeListeners = new Set<() => void>();

  get isPainting() {
    return this.painting;
  }

  /** Subscribe to content changes; returns an unsubscribe function. */
  addChangeListener(cb: () => void) {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  /** Notify the canvas renderer plus any extra listeners that content changed. */
  private emitChange() {
    this.onChange();
    this.changeListeners.forEach((cb) => cb());
  }

  setView(v: HTMLCanvasElement | null) {
    this.view = v;
    this.vctx = v ? v.getContext("2d", { colorSpace: this.cs }) : null;
  }

  /** Switch the working colour space, converting existing layers into it. */
  setColorSpace(cs: PredefinedColorSpace) {
    if (cs === this.cs) return;
    this.wandSrc = null;
    this.cs = cs;
    if (this.scratch) this.scratch = this.mk(this.w, this.h);
    // drawImage converts each layer's pixels from the old space into the new one.
    for (const [id, l] of this.layers) {
      const next = this.mk(this.w, this.h, true);
      next.ctx.drawImage(l.c, 0, 0);
      this.layers.set(id, next);
    }
    this.endAdjust();
    this.emitChange();
  }

  get colorSpace() {
    return this.cs;
  }

  setDoc(w: number, h: number, ownLayerIds?: string[]) {
    if (this.w === w && this.h === h && this.stroke) return;
    this.wandSrc = null;
    this.w = w;
    this.h = h;
    this.stroke = makeCanvas(w, h); // sRGB (brush colours authored from sRGB hex)
    this.scratch = this.mk(w, h);
    for (const [id, l] of this.layers) {
      // Only resize the active document's layers; leave other docs' layers alone.
      if (ownLayerIds && !ownLayerIds.includes(id)) continue;
      if (l.c.width !== w || l.c.height !== h) {
        const next = this.mk(w, h, true);
        next.ctx.drawImage(l.c, 0, 0);
        this.layers.set(id, next);
      }
    }
  }

  /**
   * Image resize (resample): scale every owned layer from the current size to
   * w×h. Unlike setDoc (canvas resize), content is stretched to the new bounds.
   * Call this BEFORE updating the doc's width/height so the follow-up setDoc is
   * a no-op.
   */
  resizeImage(w: number, h: number, ownLayerIds?: string[], smooth = true) {
    if ((this.w === w && this.h === h) || w < 1 || h < 1) return;
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    const ow = this.w;
    const oh = this.h;
    this.w = w;
    this.h = h;
    this.stroke = makeCanvas(w, h);
    this.scratch = this.mk(w, h);
    for (const [id, l] of this.layers) {
      if (ownLayerIds && !ownLayerIds.includes(id)) continue;
      const next = this.mk(w, h, true);
      next.ctx.imageSmoothingEnabled = smooth;
      next.ctx.imageSmoothingQuality = "high";
      next.ctx.drawImage(l.c, 0, 0, l.c.width || ow, l.c.height || oh, 0, 0, w, h);
      this.layers.set(id, next);
    }
    // Resampling rewrites all pixels; a prior history would restore wrong sizes.
    this.entries.length = 0;
    this.pos = 0;
    this.emitHistory();
    this.emitChange();
  }

  /**
   * Rotate or flip the whole image (every owned layer), swapping the document
   * dimensions for 90° rotations. This is the raw pixel/size work only — it does
   * NOT touch history, so the caller folds it into one undoable structural step
   * (and undoes it by applying the inverse transform, which is pixel-exact since
   * 90° rotations and flips are lossless permutations). Call BEFORE updating the
   * doc's width/height (the follow-up setDoc is then a no-op).
   */
  transformImage(kind: ImageTransform, ownLayerIds?: string[]) {
    if (this.w < 1 || this.h < 1) return;
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    const rot = kind === "rotate-cw" || kind === "rotate-ccw";
    const nw = rot ? this.h : this.w;
    const nh = rot ? this.w : this.h;
    for (const [id, l] of this.layers) {
      if (ownLayerIds && !ownLayerIds.includes(id)) continue;
      const next = this.mk(nw, nh, true);
      const ctx = next.ctx;
      ctx.imageSmoothingEnabled = false; // axis-aligned: keep pixels exact
      ctx.save();
      if (kind === "rotate-cw") {
        ctx.translate(nw, 0);
        ctx.rotate(Math.PI / 2);
      } else if (kind === "rotate-ccw") {
        ctx.translate(0, nh);
        ctx.rotate(-Math.PI / 2);
      } else if (kind === "flip-h") {
        ctx.translate(nw, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, nh);
        ctx.scale(1, -1);
      }
      ctx.drawImage(l.c, 0, 0);
      ctx.restore();
      this.layers.set(id, next);
    }
    this.w = nw;
    this.h = nh;
    this.stroke = makeCanvas(nw, nh);
    this.scratch = this.mk(nw, nh);
    this.emitChange();
  }

  /**
   * Clone every owned layer plus the current document size into a snapshot, so an
   * (otherwise destructive) crop can be undone pixel-perfectly. Cheap relative to
   * the crop itself and held only by the crop's history step.
   */
  cropSnapshot(ownLayerIds: string[]): CropSnapshot {
    const layers = ownLayerIds.map((id) => {
      const l = this.layer(id);
      const snap = this.mk(l.c.width, l.c.height, true);
      snap.ctx.drawImage(l.c, 0, 0);
      return { id, c: snap.c };
    });
    return { w: this.w, h: this.h, layers };
  }

  /**
   * Crop (and optionally straighten) every owned layer to `rect`, resizing the
   * document to the rectangle. With a non-zero `angle` the content is rotated by
   * −angle about the rectangle's centre first, so a tilted crop comes out level.
   * Destructive — the caller pairs it with cropSnapshot/cropRestore for undo. Call
   * BEFORE updating the doc width/height (the follow-up setDoc is then a no-op).
   */
  applyCrop(rect: Rect, ownLayerIds: string[], angle = 0) {
    const nw = Math.max(1, Math.round(rect.w));
    const nh = Math.max(1, Math.round(rect.h));
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    const rad = (-angle * Math.PI) / 180;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    for (const [id, l] of this.layers) {
      if (!ownLayerIds.includes(id)) continue;
      const next = this.mk(nw, nh, true);
      const ctx = next.ctx;
      if (angle) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.translate(nw / 2, nh / 2);
        ctx.rotate(rad);
        ctx.translate(-cx, -cy);
        ctx.drawImage(l.c, 0, 0);
      } else {
        ctx.imageSmoothingEnabled = false; // axis-aligned: keep pixels exact
        ctx.drawImage(l.c, -Math.round(rect.x), -Math.round(rect.y));
      }
      this.layers.set(id, next);
    }
    this.w = nw;
    this.h = nh;
    this.stroke = makeCanvas(nw, nh);
    this.scratch = this.mk(nw, nh);
    this.emitChange();
  }

  /** Restore a pre-crop snapshot (layers + document size) for crop undo/redo. */
  cropRestore(snap: CropSnapshot) {
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    this.w = snap.w;
    this.h = snap.h;
    this.stroke = makeCanvas(snap.w, snap.h);
    this.scratch = this.mk(snap.w, snap.h);
    for (const { id, c } of snap.layers) {
      const next = this.mk(c.width, c.height, true);
      next.ctx.drawImage(c, 0, 0);
      this.layers.set(id, next);
    }
    this.emitChange();
  }

  private layer(id: string): Layer {
    let l = this.layers.get(id);
    if (!l) {
      l = this.mk(this.w, this.h, true);
      this.layers.set(id, l);
    }
    return l;
  }

  /** Final alpha the whole stroke is composited at. Erasing ignores colour alpha. */
  private strokeAlpha() {
    const o = this.brush!.opacity / 100;
    return this.mode === "erase" ? o : o * this.col.a;
  }
  /** Composite op for stroke → layer: erase removes alpha, paint uses the blend mode. */
  private strokeComposite(): GlobalCompositeOperation {
    return this.mode === "erase" ? "destination-out" : blendOp(this.brush!.blend);
  }

  /** Geometric centre of the rects' bounding box (un-clamped). */
  private centerOf(rects: Rect[]): { x: number; y: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }

  /** Clip to the selection — a rotated quad path about `pivot` when `angle` ≠ 0. */
  /** Trace the selection rects (optionally rotated about `pivot`) into a path. */
  private pathOf(
    ctx: CanvasRenderingContext2D,
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    ctx.beginPath();
    if (!angle) {
      for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
    } else {
      const c = pivot ?? this.centerOf(rects);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rx = (x: number, y: number) => c.x + (x - c.x) * cos - (y - c.y) * sin;
      const ry = (x: number, y: number) => c.y + (x - c.x) * sin + (y - c.y) * cos;
      for (const r of rects) {
        ctx.moveTo(rx(r.x, r.y), ry(r.x, r.y));
        ctx.lineTo(rx(r.x + r.w, r.y), ry(r.x + r.w, r.y));
        ctx.lineTo(rx(r.x + r.w, r.y + r.h), ry(r.x + r.w, r.y + r.h));
        ctx.lineTo(rx(r.x, r.y + r.h), ry(r.x, r.y + r.h));
        ctx.closePath();
      }
    }
  }

  private clipTo(
    ctx: CanvasRenderingContext2D,
    rects: Rect[] | null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    if (!rects || !rects.length) return;
    this.pathOf(ctx, rects, angle, pivot);
    ctx.clip();
  }

  /**
   * Render the selection to an opaque-white alpha mask (full doc size), used via
   * destination-in / -out instead of clip() when lifting content.
   *
   * For a ROTATED irregular selection the shape is filled AXIS-ALIGNED first and
   * then the bitmap is rotated — the same way the content itself is baked. Filling
   * hundreds of thin *rotated* scanline rects directly leaves hairline interior
   * seams (rasterizers don't perfectly cancel adjacent rotated edges) and a
   * rotated complex clip path drops whole rows; rotating one solid bitmap can do
   * neither, and it lines up pixel-for-pixel with the rotated pixels.
   */
  private selectionMask(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
    feather = 0,
  ): HTMLCanvasElement {
    const base = this.mk(this.w, this.h);
    base.ctx.fillStyle = "#fff";
    if (!angle) {
      this.pathOf(base.ctx, rects, 0, null);
      base.ctx.fill();
    } else {
      // Solid axis-aligned shape (abutting upright rects fill without seams)…
      const flat = this.mk(this.w, this.h);
      flat.ctx.fillStyle = "#fff";
      this.pathOf(flat.ctx, rects, 0, null);
      flat.ctx.fill();
      // …then rotate that bitmap about the same pivot as the content.
      const c = pivot ?? this.centerOf(rects);
      base.ctx.save();
      base.ctx.translate(c.x, c.y);
      base.ctx.rotate(angle);
      base.ctx.translate(-c.x, -c.y);
      base.ctx.imageSmoothingEnabled = true;
      base.ctx.drawImage(flat.c, 0, 0);
      base.ctx.restore();
    }
    if (feather <= 0) return base.c;
    // Feather = soften the mask edges with a Gaussian blur.
    const out = this.mk(this.w, this.h);
    out.ctx.filter = `blur(${feather}px)`;
    out.ctx.drawImage(base.c, 0, 0);
    out.ctx.filter = "none";
    return out.c;
  }

  /** Draw the current stroke buffer onto a context, clipped to the selection. */
  private drawStroke(ctx: CanvasRenderingContext2D) {
    ctx.save();
    this.clipTo(ctx, this.clip, this.clipAngle, this.clipPivot);
    ctx.globalAlpha = this.strokeAlpha();
    ctx.globalCompositeOperation = this.strokeComposite();
    ctx.drawImage(this.stroke!.c, 0, 0);
    ctx.restore();
  }

  private boundsOf(
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    if (!angle) {
      for (const r of rects) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
    } else {
      const c = pivot ?? this.centerOf(rects);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (const r of rects) {
        for (const [x, y] of [
          [r.x, r.y],
          [r.x + r.w, r.y],
          [r.x + r.w, r.y + r.h],
          [r.x, r.y + r.h],
        ]) {
          const px = c.x + (x - c.x) * cos - (y - c.y) * sin;
          const py = c.y + (x - c.x) * sin + (y - c.y) * cos;
          x0 = Math.min(x0, px);
          y0 = Math.min(y0, py);
          x1 = Math.max(x1, px);
          y1 = Math.max(y1, py);
        }
      }
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.w, Math.ceil(x1));
    y1 = Math.min(this.h, Math.ceil(y1));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    return { x: x0, y: y0, w, h };
  }

  private pushEntry(
    layerId: string,
    rect: { x: number; y: number; w: number; h: number },
    before: ImageData,
    after: ImageData,
    label: string,
    side?: HistorySide,
  ) {
    this.endAdjust(); // any other pixel op finalizes a live adjustment / shape / gradient / path / fill
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
    if (this.pos < this.entries.length) this.entries.length = this.pos;
    this.entries.push({ layerId, rect, before, after, label, side });
    this.pos = this.entries.length;
    this.emitHistory();
  }

  /** Push a structural undo step (no pixel payload — `undo`/`redo` do the work). */
  pushStructural(label: string, undo: () => void, redo: () => void) {
    this.endAdjust();
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
    if (this.pos < this.entries.length) this.entries.length = this.pos;
    this.entries.push({ label, side: { undo, redo } });
    this.pos = this.entries.length;
    this.emitHistory();
  }

  /** Fill the selection on a layer with a colour (records history). */
  fillSelection(
    layerId: string,
    rects: Rect[],
    colorHex: string,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
    feather = 0,
  ) {
    const bounds = this.featherBounds(this.boundsOf(rects, angle, pivot), feather);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    if (feather > 0) {
      // Lay the colour down only where a feathered mask is opaque (soft edges).
      const mask = this.selectionMask(rects, angle, pivot, feather);
      const tmp = this.mk(this.w, this.h);
      tmp.ctx.fillStyle = colorHex;
      tmp.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      tmp.ctx.globalCompositeOperation = "destination-in";
      tmp.ctx.drawImage(mask, 0, 0);
      l.ctx.drawImage(tmp.c, 0, 0);
    } else {
      l.ctx.save();
      this.clipTo(l.ctx, rects, angle, pivot);
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.fillStyle = colorHex;
      l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      l.ctx.restore();
    }
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(layerId, bounds, before, after, "Fill");
    this.emitChange();
  }

  /** Expand a selection bounds by a feather radius (3σ reach), clamped to canvas. */
  private featherBounds(b: Rect | null, feather: number): Rect | null {
    if (!b || feather <= 0) return b;
    const pad = Math.ceil(feather * 3) + 2;
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    const x1 = Math.min(this.w, b.x + b.w + pad);
    const y1 = Math.min(this.h, b.y + b.h + pad);
    return { x, y, w: x1 - x, h: y1 - y };
  }

  /** Paint a shape (filled + stroked) into ctx, rotated about its box centre.
      The path is inset by half the stroke so the whole shape stays in `box`. */
  private paintShape(
    ctx: CanvasRenderingContext2D,
    box: Rect,
    angle: number,
    kind: ShapeKind,
    fill: string,
    stroke: string,
    strokeWidth: number,
    radius: number,
    geom?: ShapeGeom,
  ) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (angle) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.translate(-cx, -cy);
    }
    renderShape(ctx, kind, box, fill, stroke, strokeWidth, radius, geom);
    ctx.restore();
  }

  /**
   * Draw / redraw a "live" shape: it stays editable (re-rendered from its box +
   * settings) until the session is finalized by `endShape`. Mirrors the live
   * adjustment session — one coalescing "Shape" history entry; rapid setting
   * tweaks just refresh it. Call repeatedly with the same box to restyle.
   */
  liveShape(
    layerId: string,
    box: Rect,
    angle: number,
    kind: ShapeKind,
    fill: string,
    stroke: string,
    strokeWidth: number,
    radius: number,
    geom?: ShapeGeom,
  ) {
    if (box.w < 1 || box.h < 1) return;
    this.endAdjust(); // a shape and an adjustment / gradient / path / fill can't be live at once
    this.endGradient();
    this.endPath();
    this.endFill();
    if (this.shapeLayer && this.shapeLayer !== layerId) this.endShape();
    const l = this.layer(layerId);
    const fresh = this.shapeLayer !== layerId || !this.shapeOrig || !this.shapeBounds;
    let b: Rect;
    if (fresh) {
      // The shape sits inside its box (stroke is inset); pad a little for AA.
      const x0 = Math.max(0, Math.floor(box.x - 2));
      const y0 = Math.max(0, Math.floor(box.y - 2));
      const x1 = Math.min(this.w, Math.ceil(box.x + box.w + 2));
      const y1 = Math.min(this.h, Math.ceil(box.y + box.h + 2));
      if (x1 <= x0 || y1 <= y0) return;
      b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      this.shapeLayer = layerId;
      this.shapeBounds = b;
      this.shapeOrig = l.ctx.getImageData(b.x, b.y, b.w, b.h);
      this.shapeEntry = null;
    } else {
      b = this.shapeBounds!;
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.putImageData(this.shapeOrig!, b.x, b.y); // restore pre-shape pixels
    }
    this.paintShape(l.ctx, box, angle, kind, fill, stroke, strokeWidth, radius, geom);
    const after = l.ctx.getImageData(b.x, b.y, b.w, b.h);
    if (!this.shapeEntry) {
      if (this.pos < this.entries.length) this.entries.length = this.pos;
      this.shapeEntry = { layerId, rect: b, before: this.shapeOrig!, after, label: "Shape" };
      this.entries.push(this.shapeEntry);
      this.pos = this.entries.length;
      this.emitHistory();
    } else {
      this.shapeEntry.after = after; // same entry, restyled pixels
    }
    this.emitChange();
  }

  /**
   * Rasterise a shape onto a (dedicated) layer, clearing it first. No history of
   * its own — the caller folds it into a structural step (like renderText). Used
   * to bake a vector shape layer on create and re-edit.
   */
  rasterizeShape(
    layerId: string,
    box: Rect,
    angle: number,
    kind: ShapeKind,
    fill: string,
    stroke: string,
    strokeWidth: number,
    radius: number,
    geom?: ShapeGeom,
  ) {
    const ctx = this.layer(layerId).ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.paintShape(ctx, box, angle, kind, fill, stroke, strokeWidth, radius, geom);
    this.emitChange();
  }

  /** Finalize the live shape session, keeping its history entry. */
  endShape() {
    if (!this.shapeLayer) return;
    this.shapeLayer = null;
    this.shapeOrig = null;
    this.shapeBounds = null;
    this.shapeEntry = null;
    this.onShapeEnd();
  }

  /**
   * Draw / redraw a "live" gradient onto a layer, clipped to the selection (or
   * the whole layer). Re-renderable from its endpoints / midpoint / stops until
   * finalized by endGradient — one coalescing "Gradient" history entry.
   */
  liveGradient(
    layerId: string,
    type: GradientType,
    start: { x: number; y: number },
    end: { x: number; y: number },
    midpoint: number,
    stops: GradientStop[],
    sel: Rect[] | null = null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
    smooth = false,
  ) {
    this.endAdjust();
    this.endShape();
    this.endPath();
    this.endFill();
    if (this.gradLayer && this.gradLayer !== layerId) this.endGradient();
    const l = this.layer(layerId);
    const fresh = this.gradLayer !== layerId || !this.gradOrig || !this.gradBounds;
    let b: Rect;
    if (fresh) {
      // Affected region: the selection bounds, else the whole layer.
      const sb = sel && sel.length ? this.boundsOf(sel, selAngle, selPivot) : null;
      b = sb ?? { x: 0, y: 0, w: this.w, h: this.h };
      if (b.w < 1 || b.h < 1) return;
      this.gradLayer = layerId;
      this.gradBounds = b;
      this.gradOrig = l.ctx.getImageData(b.x, b.y, b.w, b.h);
      this.gradEntry = null;
    } else {
      b = this.gradBounds!;
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.putImageData(this.gradOrig!, b.x, b.y); // restore pre-gradient pixels
    }
    l.ctx.save();
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    if (sel && sel.length) this.clipTo(l.ctx, sel, selAngle, selPivot);
    else {
      l.ctx.beginPath();
      l.ctx.rect(b.x, b.y, b.w, b.h);
      l.ctx.clip();
    }
    l.ctx.fillStyle = buildCanvasGradient(l.ctx, type, start, end, midpoint, stops, smooth);
    l.ctx.fillRect(b.x, b.y, b.w, b.h);
    l.ctx.restore();
    const after = l.ctx.getImageData(b.x, b.y, b.w, b.h);
    if (!this.gradEntry) {
      if (this.pos < this.entries.length) this.entries.length = this.pos;
      this.gradEntry = { layerId, rect: b, before: this.gradOrig!, after, label: "Gradient" };
      this.entries.push(this.gradEntry);
      this.pos = this.entries.length;
      this.emitHistory();
    } else {
      this.gradEntry.after = after;
    }
    this.emitChange();
  }

  /** Finalize the live gradient session, keeping its history entry. */
  endGradient() {
    if (!this.gradLayer) return;
    this.gradLayer = null;
    this.gradOrig = null;
    this.gradBounds = null;
    this.gradEntry = null;
    this.onGradientEnd();
  }

  /** Tight canvas-clamped bounds of a pen path's stroke (control hull + width). */
  private penBounds(anchors: PenAnchor[], o: PenSettings): Rect | null {
    if (anchors.length < 2) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const a of anchors) {
      for (const [x, y] of [
        [a.x, a.y],
        [a.ix, a.iy],
        [a.ox, a.oy],
      ]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    const pad = Math.ceil((o.width * (1 + Math.max(0, o.bend))) / 2) + 3;
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(this.w, Math.ceil(x1 + pad));
    y1 = Math.min(this.h, Math.ceil(y1 + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Draw / redraw a "live" pen-path stroke onto a layer. Re-renderable as the
   * path's anchors / handles / stroke options change, until finalized by endPath.
   * The layer is snapshotted on the first call and restored before each redraw.
   */
  livePath(
    layerId: string,
    anchors: PenAnchor[],
    closed: boolean,
    settings: PenSettings,
    color: string,
  ) {
    this.endAdjust();
    this.endShape();
    this.endGradient();
    this.endFill();
    if (this.pathLayer && this.pathLayer !== layerId) this.endPath();
    const l = this.layer(layerId);
    if (this.pathLayer !== layerId || !this.pathOrig) {
      this.pathLayer = layerId;
      this.pathOrig = this.mk(this.w, this.h, true);
      this.pathOrig.ctx.drawImage(l.c, 0, 0);
    }
    // Restore the pre-path pixels, then stroke the current path on top.
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(this.pathOrig.c, 0, 0);
    renderPenStroke(l.ctx, anchors, closed, settings, color);
    this.pathState = { anchors, closed, settings, color };
    this.emitChange();
  }

  /** Finalize the live pen path, baking it as one tight "Path" history entry. */
  endPath() {
    if (!this.pathLayer) return;
    const layerId = this.pathLayer;
    const orig = this.pathOrig;
    const st = this.pathState;
    this.pathLayer = null; // clear first so pushEntry's own endPath() is a no-op
    this.pathOrig = null;
    this.pathState = null;
    if (st && orig && st.anchors.length >= 2) {
      const b = this.penBounds(st.anchors, st.settings);
      if (b) {
        const l = this.layer(layerId);
        const before = orig.ctx.getImageData(b.x, b.y, b.w, b.h);
        const after = l.ctx.getImageData(b.x, b.y, b.w, b.h);
        this.pushEntry(layerId, b, before, after, "Path");
      }
    }
    this.onPathEnd();
  }

  /**
   * Draw / redraw a "live" bucket fill onto a layer — re-editable from its region
   * (rects) + colour until finalized by endFill. The layer is snapshotted on the
   * first call and restored before each redraw, so re-filling with a new region
   * or colour never stacks up.
   */
  liveFill(layerId: string, rects: Rect[], color: string, antialias = false) {
    this.endAdjust();
    this.endShape();
    this.endGradient();
    this.endPath();
    if (this.fillLayer && this.fillLayer !== layerId) this.endFill();
    const l = this.layer(layerId);
    if (this.fillLayer !== layerId || !this.fillOrig) {
      this.fillLayer = layerId;
      this.fillOrig = this.mk(this.w, this.h, true);
      this.fillOrig.ctx.drawImage(l.c, 0, 0);
    }
    // Restore the pre-fill pixels, then fill the region on top.
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(this.fillOrig.c, 0, 0);
    if (rects.length) {
      if (antialias) {
        this.fillAA(l.ctx, rects, color);
      } else {
        const b = this.boundsOf(rects) ?? { x: 0, y: 0, w: this.w, h: this.h };
        l.ctx.save();
        this.clipTo(l.ctx, rects);
        l.ctx.fillStyle = color;
        l.ctx.fillRect(b.x, b.y, b.w, b.h);
        l.ctx.restore();
      }
    }
    this.fillState = { rects, color, antialias };
    this.emitChange();
  }

  // Padding (px) around an anti-aliased fill to hold the softened edge.
  private static FILL_AA_PAD = 4;

  /**
   * Fill the region with softened (anti-aliased) edges: rasterize the region as
   * an opaque mask, blur it a touch into an alpha-coverage mask, tint that to the
   * colour, and composite it — so the boundary pixels get partial coverage
   * instead of a hard pixel staircase. The interior is identical to a hard fill.
   */
  private fillAA(ctx: CanvasRenderingContext2D, rects: Rect[], color: string) {
    const r = this.boundsOf(rects);
    if (!r) return;
    const pad = PaintEngine.FILL_AA_PAD;
    const x0 = Math.max(0, r.x - pad);
    const y0 = Math.max(0, r.y - pad);
    const x1 = Math.min(this.w, r.x + r.w + pad);
    const y1 = Math.min(this.h, r.y + r.h + pad);
    const mw = x1 - x0;
    const mh = y1 - y0;
    if (mw < 1 || mh < 1) return;
    // Hard region mask (white) in a buffer offset to the region's bounds.
    const mask = this.mk(mw, mh);
    mask.ctx.translate(-x0, -y0);
    this.clipTo(mask.ctx, rects);
    mask.ctx.fillStyle = "#fff";
    mask.ctx.fillRect(x0, y0, mw, mh);
    // Blur into a coverage mask, then tint to the fill colour (keeps the colour's
    // own alpha × the edge coverage).
    const soft = this.mk(mw, mh);
    soft.ctx.filter = "blur(0.8px)";
    soft.ctx.drawImage(mask.c, 0, 0);
    soft.ctx.filter = "none";
    soft.ctx.globalCompositeOperation = "source-in";
    soft.ctx.fillStyle = color;
    soft.ctx.fillRect(0, 0, mw, mh);
    ctx.drawImage(soft.c, x0, y0);
  }

  /** Finalize the live bucket fill, baking one tight "Fill" history entry. */
  endFill() {
    if (!this.fillLayer) return;
    const layerId = this.fillLayer;
    const orig = this.fillOrig;
    const st = this.fillState;
    this.fillLayer = null; // clear first so pushEntry's own endFill() is a no-op
    this.fillOrig = null;
    this.fillState = null;
    if (st && orig && st.rects.length) {
      const r = this.boundsOf(st.rects);
      if (r) {
        // Anti-aliased fills bleed a few px past the region — include that in the
        // entry so undo restores the softened edge too.
        const pad = st.antialias ? PaintEngine.FILL_AA_PAD : 0;
        const x0 = Math.max(0, r.x - pad);
        const y0 = Math.max(0, r.y - pad);
        const x1 = Math.min(this.w, r.x + r.w + pad);
        const y1 = Math.min(this.h, r.y + r.h + pad);
        const b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const l = this.layer(layerId);
        const before = orig.ctx.getImageData(b.x, b.y, b.w, b.h);
        const after = l.ctx.getImageData(b.x, b.y, b.w, b.h);
        this.pushEntry(layerId, b, before, after, "Fill");
      }
    }
    this.onFillEnd();
  }

  /** Clear (erase to transparent) the selection on a layer (records history).
      `label` lets callers journal it as e.g. "Cut" instead of "Delete". */
  eraseSelection(
    layerId: string,
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
    label = "Delete",
    feather = 0,
  ) {
    const bounds = this.featherBounds(this.boundsOf(rects, angle, pivot), feather);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "destination-out";
    if (feather > 0) {
      // The mask's (feathered) alpha removes the layer's alpha proportionally.
      l.ctx.drawImage(this.selectionMask(rects, angle, pivot, feather), 0, 0);
    } else {
      this.clipTo(l.ctx, rects, angle, pivot);
      l.ctx.fillStyle = "#000";
      l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }
    l.ctx.restore();
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(layerId, bounds, before, after, label);
    this.emitChange();
  }

  /** Copy a layer's pixels into another (new) layer id. */
  duplicateLayer(srcId: string, dstId: string) {
    const src = this.layers.get(srcId);
    const dst = this.layer(dstId);
    dst.ctx.globalAlpha = 1;
    dst.ctx.globalCompositeOperation = "source-over";
    dst.ctx.clearRect(0, 0, this.w, this.h);
    if (src) dst.ctx.drawImage(src.c, 0, 0);
    this.emitChange();
  }

  /** Composite `nodes` (top→bottom) into one new layer, dropping `deleteIds`. */
  rasterize(targetId: string, nodes: LayerNode[], deleteIds: string[]) {
    const { c, ctx } = this.mk(this.w, this.h, true);
    for (let i = nodes.length - 1; i >= 0; i--) this.drawNode(ctx, nodes[i]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const id of deleteIds) this.layers.delete(id);
    this.layers.set(targetId, { c, ctx });
    this.emitChange();
  }

  /** Forget a layer's offscreen canvas (after it's removed from the document). */
  removeLayer(id: string) {
    this.layers.delete(id);
  }

  /** A leaf layer's pixels as a PNG data URL (null if it has no canvas yet). */
  getLayerImage(id: string): string | null {
    const l = this.layers.get(id);
    return l ? l.c.toDataURL("image/png") : null;
  }

  // ---- Adjustments (live preview on a leaf, baked on commit) ----
  /** Preview adjustments on a layer. Snapshots the original on first use; a
      default (all-zero) adjustment cancels the preview. */
  /**
   * Adjust `before` everywhere, then (if a selection is active) keep the result
   * only inside the selection region and the original pixels outside it.
   */
  private maskedAdjust(before: ImageData, adj: Adjustments): ImageData {
    const res = applyAdjustments(before, adj, this.cs);
    if (!this.adjSel || !this.adjSel.length) return res; // whole layer
    const out = this.mk(this.w, this.h);
    out.ctx.putImageData(before, 0, 0); // original everywhere
    const tmp = this.mk(this.w, this.h);
    tmp.ctx.putImageData(res, 0, 0);
    out.ctx.save();
    this.clipTo(out.ctx, this.adjSel, this.adjSelAngle, this.adjSelPivot);
    out.ctx.clearRect(0, 0, this.w, this.h); // clear the selection region only
    out.ctx.drawImage(tmp.c, 0, 0); // draw the adjusted pixels into it
    out.ctx.restore();
    return out.ctx.getImageData(0, 0, this.w, this.h);
  }

  /**
   * Apply adjustments to a layer immediately (no separate "Apply" step). The
   * whole continuous session coalesces into ONE undoable "Adjustments" entry:
   * the first change bakes + pushes it, later tweaks refresh that same entry.
   * The session is finalized by `endAdjust` (any other op / undo / layer switch).
   */
  applyAdjust(
    layerId: string,
    adj: Adjustments,
    sel: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    // Switching layers mid-session finalizes the previous one.
    if (this.adjLayer && this.adjLayer !== layerId) this.endAdjust();
    // All-neutral → discard the session (and its entry) entirely.
    if (isDefaultAdjust(adj)) {
      this.revertAdjust();
      return;
    }
    const fresh = this.adjLayer !== layerId || !this.adjOrig;
    if (fresh) {
      const l = this.layers.get(layerId);
      if (!l) return; // empty layer — nothing to adjust
      this.adjLayer = layerId;
      this.adjOrig = l.ctx.getImageData(0, 0, this.w, this.h);
      this.adjEntry = null;
    }
    this.adjSel = sel && sel.length ? sel : null;
    this.adjSelAngle = angle;
    this.adjSelPivot = pivot;
    this.adjPending = adj;
    // First change bakes + pushes synchronously (so the entry always exists);
    // rapid follow-ups are rAF-throttled and only refresh that entry.
    if (fresh) this.flushAdjust();
    else if (!this.adjRaf) this.adjRaf = requestAnimationFrame(() => this.flushAdjust());
  }

  /** Bake the pending adjustment into the layer; push or refresh its entry. */
  private flushAdjust() {
    this.adjRaf = 0;
    if (!this.adjPending || !this.adjOrig || !this.adjLayer) return;
    const after = this.maskedAdjust(this.adjOrig, this.adjPending);
    const l = this.layer(this.adjLayer);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.putImageData(after, 0, 0);
    if (!this.adjEntry) {
      if (this.pos < this.entries.length) this.entries.length = this.pos;
      this.adjEntry = {
        layerId: this.adjLayer,
        rect: { x: 0, y: 0, w: this.w, h: this.h },
        before: this.adjOrig,
        after,
        label: "Adjustments",
      };
      this.entries.push(this.adjEntry);
      this.pos = this.entries.length;
      this.emitHistory();
    } else {
      this.adjEntry.after = after; // same entry, newer pixels (list unchanged)
    }
    this.emitChange();
  }

  /** Finalize the live adjustment session, keeping its history entry. */
  endAdjust() {
    if (!this.adjLayer) return;
    if (this.adjRaf) {
      cancelAnimationFrame(this.adjRaf);
      this.adjRaf = 0;
    }
    if (this.adjPending && !this.adjEntry) this.flushAdjust(); // safety: never-flushed
    this.adjLayer = null;
    this.adjOrig = null;
    this.adjEntry = null;
    this.adjPending = null;
    this.adjSel = null;
    this.adjSelAngle = 0;
    this.adjSelPivot = null;
    this.onAdjustEnd();
  }

  /** Discard the live adjustment session: restore the original, drop its entry. */
  revertAdjust() {
    if (!this.adjLayer) return;
    if (this.adjRaf) {
      cancelAnimationFrame(this.adjRaf);
      this.adjRaf = 0;
    }
    if (this.adjOrig) {
      const l = this.layer(this.adjLayer);
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.putImageData(this.adjOrig, 0, 0);
    }
    if (this.adjEntry) {
      const idx = this.entries.indexOf(this.adjEntry);
      if (idx >= 0) {
        this.entries.splice(idx, 1);
        if (this.pos > idx) this.pos -= 1;
      }
    }
    this.adjLayer = null;
    this.adjOrig = null;
    this.adjEntry = null;
    this.adjPending = null;
    this.adjSel = null;
    this.adjSelAngle = 0;
    this.adjSelPivot = null;
    this.emitHistory();
    this.emitChange();
  }

  /** Replace a leaf layer's pixels with an image (used when loading a project). */
  setLayerImage(id: string, source: CanvasImageSource) {
    this.wandSrc = null;
    const l = this.layer(id);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(source, 0, 0);
    this.emitChange();
  }

  /** Snapshot the full pixels of the given leaf layers (null = no canvas). */
  captureLeaves(ids: string[]): Map<string, ImageData | null> {
    const m = new Map<string, ImageData | null>();
    for (const id of ids) {
      const l = this.layers.get(id);
      m.set(id, l ? l.ctx.getImageData(0, 0, this.w, this.h) : null);
    }
    return m;
  }

  /** Restore leaf layers from snapshots (null = delete that layer's canvas). */
  restoreLeaves(snaps: Map<string, ImageData | null>) {
    for (const [id, snap] of snaps) {
      if (snap) {
        const l = this.layer(id);
        l.ctx.globalAlpha = 1;
        l.ctx.globalCompositeOperation = "source-over";
        l.ctx.clearRect(0, 0, this.w, this.h);
        l.ctx.putImageData(snap, 0, 0);
      } else {
        this.layers.delete(id);
      }
    }
    this.emitChange();
  }

  /** The pixels to draw for a leaf, with any live stroke/move/float merged in. */
  private leafDisplay(id: string): HTMLCanvasElement | null {
    const l = this.layers.get(id);
    const s = this.scratch?.ctx;
    if (this.painting && this.stroke && s && id === this.strokeLayer) {
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      s.clearRect(0, 0, this.w, this.h);
      if (l) s.drawImage(l.c, 0, 0);
      this.drawStroke(s);
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      return this.scratch!.c;
    }
    if (this.moving && this.moveFloat && s && id === this.moveLayer) {
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      s.clearRect(0, 0, this.w, this.h);
      if (l) s.drawImage(l.c, 0, 0);
      s.drawImage(this.moveFloat.c, this.moveOff.x, this.moveOff.y);
      return this.scratch!.c;
    }
    if (this.floatActive && this.floatSource && s && id === this.floatLayer) {
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      s.clearRect(0, 0, this.w, this.h);
      if (l) s.drawImage(l.c, 0, 0);
      if (this.floatAngle && this.floatSrcRect) {
        // Rotate-content preview: draw the lifted region rotated about the pivot.
        const src = this.floatSrcRect;
        const cx = this.floatPivot ? this.floatPivot.x : src.x + src.w / 2;
        const cy = this.floatPivot ? this.floatPivot.y : src.y + src.h / 2;
        s.save();
        s.imageSmoothingEnabled = true;
        s.translate(cx, cy);
        s.rotate(this.floatAngle);
        s.translate(-cx, -cy);
        s.drawImage(this.floatSource, 0, 0);
        s.restore();
      } else if (this.floatFrameAngle && this.floatScaleSrc && this.floatDst) {
        // Resize-content of a rotated selection: scale in the rotated frame.
        const P =
          this.floatFramePivot ?? {
            x: this.floatScaleSrc.x + this.floatScaleSrc.w / 2,
            y: this.floatScaleSrc.y + this.floatScaleSrc.h / 2,
          };
        s.save();
        s.imageSmoothingEnabled = this.floatSmooth;
        this.applyFrameScale(s, this.floatScaleSrc, this.floatDst, this.floatFrameAngle, P);
        s.drawImage(this.floatSource, 0, 0);
        s.restore();
      } else if (this.floatDst && this.floatSrcRect) {
        const src = this.floatSrcRect;
        const d = this.floatDst;
        s.imageSmoothingEnabled = this.floatSmooth;
        s.drawImage(this.floatSource, src.x, src.y, src.w, src.h, d.x, d.y, d.w, d.h);
      } else {
        s.drawImage(
          this.floatSource,
          this.floatBase.x + this.floatOff.x,
          this.floatBase.y + this.floatOff.y,
        );
      }
      return this.scratch!.c;
    }
    return l ? l.c : null;
  }

  /** Draw one layer node (recursing into groups via their own buffer). */
  private drawNode(ctx: CanvasRenderingContext2D, node: LayerNode) {
    if (!node.visible) return;
    if (node.type === "group") {
      if (!node.children.length) return;
      const { c: bc, ctx: bctx } = this.mk(this.w, this.h);
      for (let i = node.children.length - 1; i >= 0; i--) this.drawNode(bctx, node.children[i]);
      ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity / 100));
      ctx.globalCompositeOperation = blendOp(node.blend);
      ctx.drawImage(bc, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    const disp = this.leafDisplay(node.id);
    if (!disp) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity / 100));
    ctx.globalCompositeOperation = blendOp(node.blend);
    ctx.drawImage(disp, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Flatten the layer tree into a new doc-sized canvas (for image export). */
  exportComposite(tree: LayerNode[]): HTMLCanvasElement {
    const { c, ctx } = this.mk(this.w, this.h);
    for (let i = tree.length - 1; i >= 0; i--) this.drawNode(ctx, tree[i]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return c;
  }

  /**
   * Per-channel tonal distribution of the composited canvas (256 bins each).
   * Fully transparent pixels are skipped. The composite is read back at a
   * capped resolution so the scan stays fast on large documents — the shape of
   * the distribution is what the panel displays, so downsampling is harmless.
   */
  histogram(tree: LayerNode[]): ChannelHistogram {
    const r = new Array<number>(256).fill(0);
    const g = new Array<number>(256).fill(0);
    const b = new Array<number>(256).fill(0);
    if (this.w < 1 || this.h < 1) return { r, g, b };
    const full = this.mk(this.w, this.h, true);
    for (let i = tree.length - 1; i >= 0; i--) this.drawNode(full.ctx, tree[i]);
    full.ctx.globalAlpha = 1;
    full.ctx.globalCompositeOperation = "source-over";

    const cap = 480;
    const scale = Math.min(1, cap / Math.max(this.w, this.h));
    let data: Uint8ClampedArray;
    if (scale < 1) {
      const sw = Math.max(1, Math.round(this.w * scale));
      const sh = Math.max(1, Math.round(this.h * scale));
      const small = this.mk(sw, sh, true);
      small.ctx.imageSmoothingEnabled = true;
      small.ctx.imageSmoothingQuality = "low";
      small.ctx.drawImage(full.c, 0, 0, sw, sh);
      data = small.ctx.getImageData(0, 0, sw, sh).data;
    } else {
      data = full.ctx.getImageData(0, 0, this.w, this.h).data;
    }
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // ignore fully transparent pixels
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
    }
    return { r, g, b };
  }

  /** Composite the layer tree (bottom→top, nested groups) onto the view canvas. */
  composite(tree: LayerNode[]) {
    const ctx = this.vctx;
    if (!ctx) return;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, this.w, this.h);
    for (let i = tree.length - 1; i >= 0; i--) this.drawNode(ctx, tree[i]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Begin moving pixels: lift the selection (or whole layer) into a float buffer. */
  beginMove(layerId: string, rects: Rect[] | null) {
    if (!this.stroke) return;
    this.moving = true;
    this.moveLayer = layerId;
    this.moveOff = { x: 0, y: 0 };
    const l = this.layer(layerId);
    this.moveOrig = this.mk(this.w, this.h, true);
    this.moveOrig.ctx.drawImage(l.c, 0, 0);
    this.moveFloat = this.mk(this.w, this.h);
    if (rects && rects.length) {
      this.moveSrc = this.boundsOf(rects);
      this.moveFloat.ctx.save();
      this.clipTo(this.moveFloat.ctx, rects);
      this.moveFloat.ctx.drawImage(l.c, 0, 0);
      this.moveFloat.ctx.restore();
      if (this.moveSrc) {
        l.ctx.save();
        this.clipTo(l.ctx, rects);
        l.ctx.globalCompositeOperation = "destination-out";
        l.ctx.fillStyle = "#000";
        l.ctx.fillRect(this.moveSrc.x, this.moveSrc.y, this.moveSrc.w, this.moveSrc.h);
        l.ctx.restore();
        l.ctx.globalCompositeOperation = "source-over";
      }
    } else {
      this.moveSrc = null;
      this.moveFloat.ctx.drawImage(l.c, 0, 0);
      l.ctx.clearRect(0, 0, this.w, this.h);
    }
    this.emitChange();
  }

  // ---- floating paste ----
  get isFloating() {
    return this.floatActive;
  }
  get floatLayerId() {
    return this.floatLayer;
  }
  getFloatOffset() {
    return { ...this.floatOff };
  }

  /** Start a floating paste above a layer (not merged until commit). */
  beginFloat(
    layerId: string,
    source: ImageBitmap | HTMLCanvasElement,
    x: number,
    y: number,
    side?: HistorySide,
  ) {
    if (this.floatActive) this.commitFloat(); // merge any existing float first
    this.layer(layerId); // ensure the target layer has a canvas so it composites
    this.floatActive = true;
    this.floatLayer = layerId;
    this.floatSource = source;
    this.floatBase = { x, y };
    this.floatOff = { x: 0, y: 0 };
    this.floatSide = side;
    this.floatOrig = null;
    this.floatSrcRect = null;
    this.floatDst = null;
    this.floatScaleSrc = null;
    this.floatFrameAngle = 0;
    this.floatFramePivot = null;
    this.floatAngle = 0;
    this.floatPivot = null;
    this.emitChange();
  }

  /**
   * Lift a selection's pixels off a layer into a movable float (leaving a hole).
   * The float can be repositioned repeatedly and only merges on commit.
   */
  beginFloatFromSelection(
    layerId: string,
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
    feather = 0,
  ): boolean {
    this.endShape(); // finalize a live shape / gradient / path / fill before lifting pixels to transform
    this.endGradient();
    this.endPath();
    this.endFill();
    if (this.floatActive) this.commitFloat();
    const src = this.boundsOf(rects, angle, pivot);
    if (!src) return false;
    const l = this.layer(layerId);
    // Pristine copy of the layer for history & discard.
    this.floatOrig = this.mk(this.w, this.h, true);
    this.floatOrig.ctx.drawImage(l.c, 0, 0);
    // Mask the selection with a single anti-aliased fill (not clip()) so an
    // irregular rotated selection lifts every row — a complex rotated clip path
    // drops thin scanline rects, leaving stray pixel lines behind. A feather
    // radius softens the lifted (and removed) edges.
    const mask = this.selectionMask(rects, angle, pivot, feather);
    // Lifted content: the layer kept only where the mask is opaque (full doc size).
    const lifted = this.mk(this.w, this.h);
    lifted.ctx.drawImage(l.c, 0, 0);
    lifted.ctx.globalCompositeOperation = "destination-in";
    lifted.ctx.drawImage(mask, 0, 0);
    lifted.ctx.globalCompositeOperation = "source-over";
    this.floatSource = lifted.c;
    // Remove the lifted pixels from the layer (the hole) using the same mask.
    l.ctx.globalCompositeOperation = "destination-out";
    l.ctx.drawImage(mask, 0, 0);
    l.ctx.globalCompositeOperation = "source-over";
    this.floatActive = true;
    this.floatLayer = layerId;
    this.floatBase = { x: 0, y: 0 };
    this.floatOff = { x: 0, y: 0 };
    this.floatSrcRect = src;
    this.floatDst = null;
    this.floatScaleSrc = null;
    this.floatFrameAngle = 0;
    this.floatFramePivot = null;
    this.floatAngle = 0;
    this.floatPivot = null;
    this.floatSide = undefined;
    this.emitChange();
    return true;
  }

  setFloatOffset(x: number, y: number) {
    if (!this.floatActive) return;
    this.floatOff = { x: Math.round(x), y: Math.round(y) };
    this.emitChange();
  }

  /** The original bounds of the lifted selection (for resize-content math). */
  getFloatSrcRect(): Rect | null {
    return this.floatSrcRect ? { ...this.floatSrcRect } : null;
  }

  /** Scale the float into a target rect instead of translating it. */
  setFloatDst(dst: Rect, smooth = true) {
    if (!this.floatActive) return;
    this.floatSmooth = smooth;
    this.floatDst = {
      x: Math.round(dst.x),
      y: Math.round(dst.y),
      w: Math.max(1, Math.round(dst.w)),
      h: Math.max(1, Math.round(dst.h)),
    };
    this.emitChange();
  }

  /** Rotate the float about `pivot` (or the lifted region's centre), in radians. */
  setFloatRotation(angle: number, pivot: { x: number; y: number } | null = null) {
    if (!this.floatActive) return;
    this.floatAngle = angle;
    this.floatPivot = pivot;
    this.emitChange();
  }

  /**
   * Resize the content of a ROTATED selection: scale the lifted pixels in the
   * selection's own (un-rotated) frame from `src`→`dst` (both local rects), then
   * rotate by `angle` about `pivot`. Falls back to a plain scale when angle≈0.
   */
  setFloatFrameScale(
    src: Rect,
    dst: Rect,
    angle: number,
    pivot: { x: number; y: number } | null,
    smooth = true,
  ) {
    if (!this.floatActive) return;
    this.floatSmooth = smooth;
    if (!angle) {
      // Upright: a plain axis-aligned scale of the lifted region is correct.
      this.floatScaleSrc = null;
      this.floatFrameAngle = 0;
      this.floatFramePivot = null;
      this.setFloatDst(dst);
      return;
    }
    this.floatScaleSrc = { ...src };
    this.floatDst = {
      x: Math.round(dst.x),
      y: Math.round(dst.y),
      w: Math.max(1, Math.round(dst.w)),
      h: Math.max(1, Math.round(dst.h)),
    };
    this.floatFrameAngle = angle;
    this.floatFramePivot = pivot;
    this.emitChange();
  }

  /** Apply T = R(angle,pivot) ∘ scale(src→dst) ∘ R(-angle,pivot) to a context. */
  private applyFrameScale(
    ctx: CanvasRenderingContext2D,
    src: Rect,
    dst: Rect,
    angle: number,
    pivot: { x: number; y: number },
  ) {
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.translate(-pivot.x, -pivot.y);
    ctx.translate(dst.x, dst.y);
    ctx.scale(dst.w / src.w, dst.h / src.h);
    ctx.translate(-src.x, -src.y);
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(-angle);
    ctx.translate(-pivot.x, -pivot.y);
  }

  private clearFloat() {
    this.floatActive = false;
    this.floatLayer = null;
    this.floatSource = null;
    this.floatSide = undefined;
    this.floatOff = { x: 0, y: 0 };
    this.floatOrig = null;
    this.floatSrcRect = null;
    this.floatDst = null;
    this.floatScaleSrc = null;
    this.floatFrameAngle = 0;
    this.floatFramePivot = null;
    this.floatAngle = 0;
    this.floatPivot = null;
    this.floatSmooth = true;
  }

  /** Merge the float into its layer, recording one history step. */
  commitFloat(side?: HistorySide) {
    if (!this.floatActive || !this.floatLayer || !this.floatSource) {
      this.clearFloat();
      return;
    }
    const l = this.layer(this.floatLayer);
    const layerId = this.floatLayer;
    const px = this.floatBase.x + this.floatOff.x;
    const py = this.floatBase.y + this.floatOff.y;

    if (this.floatOrig && this.floatSrcRect && this.floatAngle) {
      // Rotated content: bake the lifted region rotated about the pivot.
      const src = this.floatSrcRect;
      const cx = this.floatPivot ? this.floatPivot.x : src.x + src.w / 2;
      const cy = this.floatPivot ? this.floatPivot.y : src.y + src.h / 2;
      const cos = Math.cos(this.floatAngle);
      const sin = Math.sin(this.floatAngle);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of [
        [src.x, src.y],
        [src.x + src.w, src.y],
        [src.x + src.w, src.y + src.h],
        [src.x, src.y + src.h],
      ]) {
        const rx = cx + (x - cx) * cos - (y - cy) * sin;
        const ry = cy + (x - cx) * sin + (y - cy) * cos;
        minX = Math.min(minX, rx);
        minY = Math.min(minY, ry);
        maxX = Math.max(maxX, rx);
        maxY = Math.max(maxY, ry);
      }
      // Affected region = rotated bounds ∪ the source hole, clamped to the canvas.
      const x0 = Math.max(0, Math.floor(Math.min(minX, src.x)));
      const y0 = Math.max(0, Math.floor(Math.min(minY, src.y)));
      const x1 = Math.min(this.w, Math.ceil(Math.max(maxX, src.x + src.w)));
      const y1 = Math.min(this.h, Math.ceil(Math.max(maxY, src.y + src.h)));
      const rw = x1 - x0;
      const rh = y1 - y0;
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.imageSmoothingEnabled = true;
      const draw = () => {
        l.ctx.save();
        l.ctx.translate(cx, cy);
        l.ctx.rotate(this.floatAngle);
        l.ctx.translate(-cx, -cy);
        l.ctx.drawImage(this.floatSource!, 0, 0);
        l.ctx.restore();
      };
      if (rw > 0 && rh > 0) {
        const before = this.floatOrig.ctx.getImageData(x0, y0, rw, rh);
        draw();
        const after = l.ctx.getImageData(x0, y0, rw, rh);
        this.pushEntry(layerId, { x: x0, y: y0, w: rw, h: rh }, before, after, "Rotate", side);
      } else {
        draw();
      }
    } else if (
      this.floatOrig &&
      this.floatScaleSrc &&
      this.floatDst &&
      this.floatFrameAngle &&
      this.floatSrcRect
    ) {
      // Resize-content of a rotated selection: bake scaled-in-rotated-frame.
      const src = this.floatScaleSrc;
      const dst = this.floatDst;
      const hole = this.floatSrcRect;
      const P = this.floatFramePivot ?? { x: src.x + src.w / 2, y: src.y + src.h / 2 };
      const cos = Math.cos(this.floatFrameAngle);
      const sin = Math.sin(this.floatFrameAngle);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of [
        [dst.x, dst.y],
        [dst.x + dst.w, dst.y],
        [dst.x + dst.w, dst.y + dst.h],
        [dst.x, dst.y + dst.h],
      ]) {
        const rx = P.x + (x - P.x) * cos - (y - P.y) * sin;
        const ry = P.y + (x - P.x) * sin + (y - P.y) * cos;
        minX = Math.min(minX, rx);
        minY = Math.min(minY, ry);
        maxX = Math.max(maxX, rx);
        maxY = Math.max(maxY, ry);
      }
      // Affected region = rotated destination ∪ the source hole, clamped.
      const x0 = Math.max(0, Math.floor(Math.min(minX, hole.x)));
      const y0 = Math.max(0, Math.floor(Math.min(minY, hole.y)));
      const x1 = Math.min(this.w, Math.ceil(Math.max(maxX, hole.x + hole.w)));
      const y1 = Math.min(this.h, Math.ceil(Math.max(maxY, hole.y + hole.h)));
      const rw = x1 - x0;
      const rh = y1 - y0;
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.imageSmoothingEnabled = this.floatSmooth;
      const draw = () => {
        l.ctx.save();
        this.applyFrameScale(l.ctx, src, dst, this.floatFrameAngle, P);
        l.ctx.drawImage(this.floatSource!, 0, 0);
        l.ctx.restore();
      };
      if (rw > 0 && rh > 0) {
        const before = this.floatOrig.ctx.getImageData(x0, y0, rw, rh);
        draw();
        const after = l.ctx.getImageData(x0, y0, rw, rh);
        this.pushEntry(layerId, { x: x0, y: y0, w: rw, h: rh }, before, after, "Scale", side);
      } else {
        draw();
      }
    } else if (this.floatOrig && this.floatSrcRect && this.floatDst) {
      // Resized content: bake the lifted region scaled into its target rect.
      const src = this.floatSrcRect;
      const dst = this.floatDst;
      const x0 = Math.max(0, Math.floor(Math.min(src.x, dst.x)));
      const y0 = Math.max(0, Math.floor(Math.min(src.y, dst.y)));
      const x1 = Math.min(this.w, Math.ceil(Math.max(src.x + src.w, dst.x + dst.w)));
      const y1 = Math.min(this.h, Math.ceil(Math.max(src.y + src.h, dst.y + dst.h)));
      const rw = x1 - x0;
      const rh = y1 - y0;
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.imageSmoothingEnabled = this.floatSmooth;
      if (rw > 0 && rh > 0) {
        const before = this.floatOrig.ctx.getImageData(x0, y0, rw, rh);
        l.ctx.drawImage(this.floatSource, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
        const after = l.ctx.getImageData(x0, y0, rw, rh);
        this.pushEntry(layerId, { x: x0, y: y0, w: rw, h: rh }, before, after, "Scale", side);
      } else {
        l.ctx.drawImage(this.floatSource, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
      }
    } else if (this.floatOrig && this.floatSrcRect) {
      // Moved selection: history spans source ∪ destination; "before" is pre-lift.
      const a = this.floatSrcRect;
      const x0 = Math.max(0, Math.min(a.x, a.x + this.floatOff.x));
      const y0 = Math.max(0, Math.min(a.y, a.y + this.floatOff.y));
      const x1 = Math.min(this.w, Math.max(a.x + a.w, a.x + a.w + this.floatOff.x));
      const y1 = Math.min(this.h, Math.max(a.y + a.h, a.y + a.h + this.floatOff.y));
      const rx = Math.floor(x0);
      const ry = Math.floor(y0);
      const rw = Math.ceil(x1 - x0);
      const rh = Math.ceil(y1 - y0);
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      if (rw > 0 && rh > 0) {
        const before = this.floatOrig.ctx.getImageData(rx, ry, rw, rh);
        l.ctx.drawImage(this.floatSource, px, py);
        const after = l.ctx.getImageData(rx, ry, rw, rh);
        this.pushEntry(layerId, { x: rx, y: ry, w: rw, h: rh }, before, after, "Move");
      } else {
        l.ctx.drawImage(this.floatSource, px, py);
      }
    } else {
      // Pasted float: bake the source at its position.
      const rx = Math.max(0, Math.floor(px));
      const ry = Math.max(0, Math.floor(py));
      const rx1 = Math.min(this.w, Math.ceil(px + this.floatSource.width));
      const ry1 = Math.min(this.h, Math.ceil(py + this.floatSource.height));
      const rw = rx1 - rx;
      const rh = ry1 - ry;
      if (rw > 0 && rh > 0) {
        const before = l.ctx.getImageData(rx, ry, rw, rh);
        l.ctx.globalAlpha = 1;
        l.ctx.globalCompositeOperation = "source-over";
        l.ctx.drawImage(this.floatSource, px, py);
        const after = l.ctx.getImageData(rx, ry, rw, rh);
        this.pushEntry(layerId, { x: rx, y: ry, w: rw, h: rh }, before, after, "Paste", this.floatSide);
      }
    }
    this.clearFloat();
    this.emitChange();
  }

  /** Drop the float without merging. */
  discardFloat() {
    if (!this.floatActive) return;
    if (this.floatOrig && this.floatLayer) {
      // Moved selection: put the lifted content back where it came from.
      const l = this.layer(this.floatLayer);
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.clearRect(0, 0, this.w, this.h);
      l.ctx.drawImage(this.floatOrig.c, 0, 0);
    } else {
      this.floatSide?.undo();
    }
    this.clearFloat();
    this.emitChange();
  }

  /** Draw an image onto a layer at (x, y), recording one history step. */
  drawImageToLayer(
    layerId: string,
    source: ImageBitmap | HTMLCanvasElement,
    x: number,
    y: number,
    side?: HistorySide,
  ) {
    const l = this.layer(layerId);
    const rx = Math.max(0, Math.floor(x));
    const ry = Math.max(0, Math.floor(y));
    const rx1 = Math.min(this.w, Math.ceil(x + source.width));
    const ry1 = Math.min(this.h, Math.ceil(y + source.height));
    const rw = rx1 - rx;
    const rh = ry1 - ry;
    if (rw <= 0 || rh <= 0) return; // entirely off-canvas
    const before = l.ctx.getImageData(rx, ry, rw, rh);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.drawImage(source, x, y);
    const after = l.ctx.getImageData(rx, ry, rw, rh);
    this.pushEntry(layerId, { x: rx, y: ry, w: rw, h: rh }, before, after, "Paste", side);
    this.emitChange();
  }

  /** Copy the composite within the selection (or the whole canvas) to a new canvas. */
  copyRegion(
    rects: Rect[] | null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): CopyResult | null {
    if (!this.view) return null;
    const bounds =
      rects && rects.length ? this.boundsOf(rects, angle, pivot) : { x: 0, y: 0, w: this.w, h: this.h };
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
    const out = document.createElement("canvas");
    out.width = bounds.w;
    out.height = bounds.h;
    const octx = out.getContext("2d");
    if (!octx) return null;
    if (rects && rects.length) {
      octx.save();
      octx.translate(-bounds.x, -bounds.y); // clip + draw in document coordinates
      this.clipTo(octx, rects, angle, pivot);
    }
    octx.drawImage(this.view, 0, 0);
    if (rects && rects.length) octx.restore();
    return { canvas: out, x: bounds.x, y: bounds.y };
  }

  /**
   * Average colour over an NxN box, from the active layer or the whole composite.
   * Returns #RRGGBBff, or null if the area is fully transparent.
   */
  sampleColor(
    x: number,
    y: number,
    size: number,
    allLayers: boolean,
    layerId: string | null,
  ): string | null {
    const ctx = allLayers ? this.vctx : layerId ? this.layer(layerId).ctx : null;
    if (!ctx) return null;
    const half = Math.floor(size / 2);
    const x0 = Math.max(0, Math.min(x - half, this.w - 1));
    const y0 = Math.max(0, Math.min(y - half, this.h - 1));
    const x1 = Math.max(0, Math.min(x + half, this.w - 1));
    const y1 = Math.max(0, Math.min(y + half, this.h - 1));
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw <= 0 || bh <= 0) return null;
    // Read in sRGB so the picked hex matches the (sRGB) colour UI.
    const data = ctx.getImageData(x0, y0, bw, bh, { colorSpace: "srgb" }).data;
    const count = data.length / 4;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      sr += data[i] * a;
      sg += data[i + 1] * a;
      sb += data[i + 2] * a;
      sa += a;
    }
    if (sa === 0) return null;
    // Colour is the alpha-weighted (un-premultiplied) average; alpha is the mean
    // coverage over the sampled box, so the eyedropper also picks up opacity.
    return toHex8({ r: sr / sa, g: sg / sa, b: sb / sa, a: sa / count });
  }

  /**
   * Magic-wand select: pick the region of similar colour around (x,y). Returns a
   * run-length rect decomposition (reused by the whole selection pipeline) plus
   * the traced mask boundary as marching-ants segments (cheap to draw). Source
   * is the active layer or, with `sampleAll`, the composite.
   */
  magicWand(
    layerId: string,
    x: number,
    y: number,
    opts: { tolerance: number; contiguous: boolean; sampleAll: boolean },
    reuseSource = false,
    add: Rect[] | null = null, // existing selection to union with (Ctrl-add)
  ): WandSelection | null {
    const w = this.w;
    const h = this.h;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    // Source pixels: cached between live re-runs (dragging Tolerance doesn't
    // change the layer), so we skip the costly getImageData each time.
    const cache = this.wandSrc;
    let data: Uint8ClampedArray;
    if (
      reuseSource &&
      cache &&
      cache.w === w &&
      cache.h === h &&
      cache.layerId === layerId &&
      cache.sampleAll === opts.sampleAll
    ) {
      data = cache.data;
    } else {
      const ctx = opts.sampleAll ? this.vctx : this.layers.get(layerId)?.ctx;
      if (!ctx) return null;
      data = ctx.getImageData(0, 0, w, h, { colorSpace: "srgb" }).data;
      this.wandSrc = { data, w, h, layerId, sampleAll: opts.sampleAll };
    }
    const t = Math.max(0, opts.tolerance);
    const si = (py * w + px) * 4;
    const sr = data[si];
    const sg = data[si + 1];
    const sb = data[si + 2];
    const sa = data[si + 3];
    // Match on PREMULTIPLIED colour (the visible contribution) + alpha, rather
    // than straight RGBA. So the flood spreads by how a pixel actually looks: an
    // opaque pixel matches on its colour and joins early, while the more
    // transparent a pixel is, the less colour it contributes and the more
    // tolerance it needs to match an opaque seed. (For fully opaque pixels this
    // reduces to the plain RGB test, so opaque artwork is unchanged.) Premult is
    // scaled by 255 to keep it integer and avoid a per-pixel divide.
    const tScaled = t * 255;
    const spr = sr * sa;
    const spg = sg * sa;
    const spb = sb * sa;

    // Reuse big scratch buffers across (live) re-runs — allocating ~12MB of
    // typed arrays per slider tick was a major source of GC-driven jank.
    const n = w * h;
    let buf = this.wandBuf;
    if (!buf || buf.n !== n) {
      buf = { mask: new Uint8Array(n), stack: new Int32Array(n), seen: new Uint8Array(n), n };
      this.wandBuf = buf;
    }
    const mask = buf.mask;
    mask.fill(0);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    // Ctrl-add: rasterise the existing selection into the mask first, so the
    // result is the union (its rects + boundary segments cover both regions).
    if (add) {
      for (const r of add) {
        const x0 = Math.max(0, r.x);
        const y0 = Math.max(0, r.y);
        const x1 = Math.min(w, r.x + r.w);
        const y1 = Math.min(h, r.y + r.h);
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx < x1; xx++) mask[row + xx] = 1;
        }
        if (x0 < x1 && y0 < y1) {
          if (x0 < minX) minX = x0;
          if (x1 - 1 > maxX) maxX = x1 - 1;
          if (y0 < minY) minY = y0;
          if (y1 - 1 > maxY) maxY = y1 - 1;
        }
      }
    }
    if (opts.contiguous) {
      const stack = buf.stack;
      const seen = buf.seen;
      seen.fill(0);
      let sp = 0;
      const seed = py * w + px;
      stack[sp++] = seed;
      seen[seed] = 1;
      while (sp > 0) {
        const p = stack[--sp];
        const i = p * 4; // match test inlined (hot loop, no closure)
        const a3 = data[i + 3];
        if (
          Math.abs(data[i] * a3 - spr) > tScaled ||
          Math.abs(data[i + 1] * a3 - spg) > tScaled ||
          Math.abs(data[i + 2] * a3 - spb) > tScaled ||
          Math.abs(a3 - sa) > t
        )
          continue;
        mask[p] = 1;
        const cx = p % w;
        const cy = (p - cx) / w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0 && !seen[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1);
        if (cx < w - 1 && !seen[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1);
        if (cy > 0 && !seen[p - w]) (seen[p - w] = 1), (stack[sp++] = p - w);
        if (cy < h - 1 && !seen[p + w]) (seen[p + w] = 1), (stack[sp++] = p + w);
      }
    } else {
      let p = 0;
      for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++, p++) {
          const i = p * 4;
          const a3 = data[i + 3];
          if (
            Math.abs(data[i] * a3 - spr) <= tScaled &&
            Math.abs(data[i + 1] * a3 - spg) <= tScaled &&
            Math.abs(data[i + 2] * a3 - spb) <= tScaled &&
            Math.abs(a3 - sa) <= t
          ) {
            mask[p] = 1;
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
          }
        }
      }
    }

    if (maxX < 0) return null; // nothing matched
    const b: Bounds = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
    const rects = maskToRects(mask, w, b);
    if (!rects.length) return null;
    return { rects, segments: maskToSegments(mask, w, h, b) };
  }

  /**
   * Freeform lasso selection: rasterizes the (auto-closed) polygon into a pixel
   * mask, then reuses the wand's mask→rects + mask→ants decomposition. The
   * polygon is closed start↔end with a straight edge by the canvas fill.
   */
  lassoSelect(points: { x: number; y: number }[]): WandSelection | null {
    const w = this.w;
    const h = this.h;
    if (points.length < 3 || w < 1 || h < 1) return null;
    // Bounding box of the path, clamped to the canvas (the mask region to scan).
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(w, Math.ceil(maxX));
    const y1 = Math.min(h, Math.ceil(maxY));
    if (x1 <= x0 || y1 <= y0) return null;
    // Fill the polygon into a bbox-sized scratch canvas (vertices outside the
    // box are simply clipped by the canvas), then threshold its alpha to a mask.
    const bw = x1 - x0;
    const bh = y1 - y0;
    const { ctx } = this.mk(bw, bh, true);
    ctx.translate(-x0, -y0);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
    const data = ctx.getImageData(0, 0, bw, bh).data;
    const mask = new Uint8Array(w * h);
    for (let yy = 0; yy < bh; yy++) {
      for (let xx = 0; xx < bw; xx++) {
        if (data[(yy * bw + xx) * 4 + 3] >= 128) mask[(y0 + yy) * w + (x0 + xx)] = 1;
      }
    }
    const b: Bounds = { x0, y0, x1, y1 };
    const rects = maskToRects(mask, w, b);
    if (!rects.length) return null;
    return { rects, segments: maskToSegments(mask, w, h, b) };
  }

  /**
   * Combine an existing selection with a new region (both as rects) via a pixel
   * mask: "add" = union, "subtract" = base minus region. Returns the merged
   * selection (rects + ants); an empty `rects` means the result is now empty
   * (e.g. the subtraction removed everything).
   */
  combineSelection(base: Rect[], region: Rect[], mode: "add" | "subtract"): WandSelection | null {
    const w = this.w;
    const h = this.h;
    if (w < 1 || h < 1) return null;
    const clamp4 = (r: Rect) => ({
      x0: Math.max(0, Math.floor(r.x)),
      y0: Math.max(0, Math.floor(r.y)),
      x1: Math.min(w, Math.ceil(r.x + r.w)),
      y1: Math.min(h, Math.ceil(r.y + r.h)),
    });
    const fill = (rects: Rect[], mask: Uint8Array) => {
      for (const r of rects) {
        const c = clamp4(r);
        for (let yy = c.y0; yy < c.y1; yy++) {
          const row = yy * w;
          for (let xx = c.x0; xx < c.x1; xx++) mask[row + xx] = 1;
        }
      }
    };
    const boundsOf = (rects: Rect[]): Bounds | null => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const r of rects) {
        const c = clamp4(r);
        if (c.x0 >= c.x1 || c.y0 >= c.y1) continue;
        if (c.x0 < x0) x0 = c.x0;
        if (c.y0 < y0) y0 = c.y0;
        if (c.x1 > x1) x1 = c.x1;
        if (c.y1 > y1) y1 = c.y1;
      }
      return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
    };

    const out = new Uint8Array(w * h);
    fill(base, out);
    let b: Bounds | null;
    if (mode === "add") {
      fill(region, out);
      b = boundsOf([...base, ...region]);
    } else {
      const reg = new Uint8Array(w * h);
      fill(region, reg);
      for (let i = 0; i < out.length; i++) if (reg[i]) out[i] = 0;
      b = boundsOf(base); // the result is a subset of the base
    }
    if (!b) return { rects: [], segments: [] };
    const rects = maskToRects(out, w, b);
    return { rects, segments: rects.length ? maskToSegments(out, w, h, b) : [] };
  }

  moveTo(dx: number, dy: number) {
    if (!this.moving) return;
    this.moveOff = { x: Math.round(dx), y: Math.round(dy) };
    this.emitChange();
  }

  endMove() {
    if (!this.moving || !this.moveLayer || !this.moveFloat || !this.moveOrig) {
      this.moving = false;
      return;
    }
    const l = this.layer(this.moveLayer);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.drawImage(this.moveFloat.c, this.moveOff.x, this.moveOff.y);

    const moved = this.moveOff.x !== 0 || this.moveOff.y !== 0;
    if (moved) {
      let region: Rect;
      if (this.moveSrc) {
        const a = this.moveSrc;
        const x0 = Math.max(0, Math.min(a.x, a.x + this.moveOff.x));
        const y0 = Math.max(0, Math.min(a.y, a.y + this.moveOff.y));
        const x1 = Math.min(this.w, Math.max(a.x + a.w, a.x + a.w + this.moveOff.x));
        const y1 = Math.min(this.h, Math.max(a.y + a.h, a.y + a.h + this.moveOff.y));
        region = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
      } else {
        region = { x: 0, y: 0, w: this.w, h: this.h };
      }
      if (region.w > 0 && region.h > 0) {
        const before = this.moveOrig.ctx.getImageData(region.x, region.y, region.w, region.h);
        const after = l.ctx.getImageData(region.x, region.y, region.w, region.h);
        this.pushEntry(this.moveLayer, region, before, after, "Move");
      }
    }
    this.moving = false;
    this.moveLayer = null;
    this.moveFloat = null;
    this.moveOrig = null;
    this.moveSrc = null;
    this.moveOff = { x: 0, y: 0 };
    this.emitChange();
  }

  beginStroke(
    layerId: string,
    brush: BrushSettings,
    colorHex: string,
    x: number,
    y: number,
    mode: StrokeMode = "paint",
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
    label: string = mode === "erase" ? "Erase" : "Brush",
  ) {
    if (!this.stroke) return;
    this.layer(layerId); // ensure the target layer has a canvas so the live stroke composites
    this.painting = true;
    this.strokeLayer = layerId;
    this.brush = brush;
    this.mode = mode;
    this.strokeLabel = label;
    this.clip = clip && clip.length ? clip : null;
    this.clipAngle = clipAngle;
    this.clipPivot = clipPivot;
    const c = parseColor(colorHex);
    this.col = { r: c.r, g: c.g, b: c.b, a: c.a };
    const r = Math.max(0.5, brush.size / 2);
    const flow = Math.max(0, Math.min(1, brush.flow / 100));
    // The tip is BAKED once per stroke and reused for every stamp. A fully hard
    // (or 1px) brush is a crisp aliased disc; softer brushes get an analytic
    // radial falloff. Baking avoids re-dithering a canvas gradient on each stamp
    // — that per-stamp dither, accumulated over the overlapping stamps in the
    // stroke buffer, is what made solid strokes look grainy inside.
    this.tipHard = brush.hardness >= 100 || brush.size <= 1;
    this.tip = this.tipHard
      ? this.buildHardTip(r, c.r, c.g, c.b, flow)
      : this.buildSoftTip(r, c.r, c.g, c.b, flow, brush.hardness);
    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.step = Math.max(1, brush.size * 0.1);
    this.last = { x, y };
    this.lastRaw = { x, y };
    this.smooth = { x, y };
    this.residual = 0;
    this.dirty = null;
    this.stamp(x, y);
    this.residual = this.step;
    this.emitChange();
  }

  moveStroke(rawX: number, rawY: number) {
    if (!this.painting || !this.brush) return;
    this.lastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.brush.smoothing / 100) * 0.85;
    this.smooth.x += (rawX - this.smooth.x) * alpha;
    this.smooth.y += (rawY - this.smooth.y) * alpha;
    this.lineTo(this.smooth.x, this.smooth.y);
    this.emitChange();
  }

  private lineTo(x: number, y: number) {
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    let d = this.residual;
    while (d <= dist) {
      const t = d / dist;
      this.stamp(this.last.x + dx * t, this.last.y + dy * t);
      d += this.step;
    }
    this.residual = d - dist;
    this.last = { x, y };
  }

  endStroke() {
    if (!this.painting || !this.brush || !this.stroke) return;
    this.lineTo(this.lastRaw.x, this.lastRaw.y);

    const layerId = this.strokeLayer!;
    const l = this.layer(layerId);
    const rect = this.dirtyRect();
    if (rect) {
      const before = l.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.drawStroke(l.ctx);
      const after = l.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.pushEntry(layerId, rect, before, after, this.strokeLabel);
    }

    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.painting = false;
    this.strokeLayer = null;
    this.brush = null;
    this.clip = null;
    this.tip = null;
    this.dirty = null;
    if (this.cloneActive) {
      this.cloneActive = false;
      this.cloneSample = null;
      this.cloneDab = null;
      this.cloneOff = null;
    }
    this.emitChange();
  }

  // ---- Clone stamp ---------------------------------------------------------
  /**
   * Begin a clone-stamp stroke. `offset` is the source→destination vector (source
   * point = brush point + offset). The sample source (active layer, or the merged
   * composite when `sampleAll`) is snapshotted now so painting can't feed back on
   * itself. Reuses the brush stroke buffer so flow/opacity/blend work identically.
   */
  beginClone(
    layerId: string,
    brush: BrushSettings,
    x: number,
    y: number,
    offset: { x: number; y: number },
    sampleAll: boolean,
    spacing: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    if (!this.stroke) return;
    this.layer(layerId);
    this.painting = true;
    this.strokeLayer = layerId;
    this.brush = brush;
    this.mode = "paint";
    this.strokeLabel = "Clone Stamp";
    this.clip = clip && clip.length ? clip : null;
    this.clipAngle = clipAngle;
    this.clipPivot = clipPivot;
    this.col = { r: 0, g: 0, b: 0, a: 1 };
    const r = Math.max(0.5, brush.size / 2);
    const flow = Math.max(0, Math.min(1, brush.flow / 100));
    this.tipHard = brush.hardness >= 100 || brush.size <= 1;
    this.tip = this.tipHard
      ? this.buildHardTip(r, 0, 0, 0, flow)
      : this.buildSoftTip(r, 0, 0, 0, flow, brush.hardness);
    // Snapshot the source so the clone reads a stable image, not its own output.
    const sample = this.mk(this.w, this.h, true);
    if (sampleAll && this.view) sample.ctx.drawImage(this.view, 0, 0);
    else sample.ctx.drawImage(this.layer(layerId).c, 0, 0);
    this.cloneSample = sample;
    this.cloneDab = this.mk(this.tip.width, this.tip.height, true);
    this.cloneOff = offset;
    this.cloneActive = true;
    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.step = Math.max(1, brush.size * (spacing / 100));
    this.last = { x, y };
    this.lastRaw = { x, y };
    this.smooth = { x, y };
    this.residual = 0;
    this.dirty = null;
    this.stamp(x, y);
    this.residual = this.step;
    this.emitChange();
  }

  /** One clone dab: sampled source region, masked by the brush tip, into the buffer. */
  private cloneStamp(x: number, y: number) {
    const tip = this.tip;
    const sample = this.cloneSample;
    const dab = this.cloneDab;
    const off = this.cloneOff;
    if (!tip || !sample || !dab || !off) return;
    const tw = tip.width;
    const th = tip.height;
    const dctx = dab.ctx;
    // Draw the source so its (x+off, y+off) point lands at the dab centre, then
    // intersect with the tip's alpha (its flow-scaled soft falloff).
    dctx.globalCompositeOperation = "source-over";
    dctx.clearRect(0, 0, tw, th);
    dctx.imageSmoothingEnabled = true;
    dctx.drawImage(sample.c, -(x + off.x - tw / 2), -(y + off.y - th / 2));
    dctx.globalCompositeOperation = "destination-in";
    dctx.drawImage(tip, 0, 0);
    dctx.globalCompositeOperation = "source-over";
    // Composite the finished dab into the stroke buffer at the brush position.
    const ctx = this.stroke!.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (this.tipHard) {
      ctx.imageSmoothingEnabled = false;
      const ix = Math.round(x - tw / 2);
      const iy = Math.round(y - th / 2);
      ctx.drawImage(dab.c, ix, iy);
      this.expandDirty(ix, iy, ix + tw, iy + th);
    } else {
      ctx.imageSmoothingEnabled = true;
      const dx = x - tw / 2;
      const dy = y - th / 2;
      ctx.drawImage(dab.c, dx, dy);
      this.expandDirty(Math.floor(dx), Math.floor(dy), Math.ceil(dx + tw), Math.ceil(dy + th));
    }
  }

  /** Erase a layer's pixels (used to hide a vector layer while it's re-edited). */
  clearLayerPixels(layerId: string) {
    this.layer(layerId).ctx.clearRect(0, 0, this.w, this.h);
    this.emitChange();
  }

  // ---- Text ----------------------------------------------------------------
  /** Configure a context for `spec` and split the text into (wrapped) lines. */
  private textLines(ctx: CanvasRenderingContext2D, spec: TextRenderSpec): string[] {
    ctx.font = `${spec.italic ? "italic " : ""}${spec.bold ? "700" : "400"} ${spec.fontSize}px ${spec.fontFamily}`;
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing: string };
    if ("letterSpacing" in ctx) lsCtx.letterSpacing = `${spec.tracking}px`;
    const wrap = (para: string, maxW: number): string[] => {
      const out: string[] = [];
      let cur = "";
      for (const word of para.split(" ")) {
        const test = cur ? `${cur} ${word}` : word;
        if (!cur || ctx.measureText(test).width <= maxW) cur = test;
        else {
          out.push(cur);
          cur = word;
        }
      }
      out.push(cur);
      return out;
    };
    const paras = spec.text.split("\n");
    return spec.boxW != null ? paras.flatMap((p) => wrap(p, spec.boxW!)) : paras;
  }

  /** Bounding box (doc px) the text would rasterize into — for re-edit hit-testing. */
  textBounds(spec: TextRenderSpec): { x: number; y: number; w: number; h: number } {
    if (!this.measureCtx) this.measureCtx = makeCanvas(8, 8).ctx;
    const ctx = this.measureCtx;
    const lines = this.textLines(ctx, spec);
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    const leading = spec.fontSize * spec.lineHeight;
    const w = spec.boxW != null ? spec.boxW : Math.max(1, Math.ceil(maxW));
    const x =
      spec.boxW != null
        ? spec.x
        : spec.align === "left"
          ? spec.x
          : spec.align === "right"
            ? spec.x - w
            : spec.x - w / 2;
    const h = Math.max(leading, lines.length * leading);
    return { x: Math.round(x), y: Math.round(spec.y), w: Math.round(w), h: Math.round(h) };
  }

  /**
   * Rasterise styled text onto a layer (no history of its own — the caller folds
   * it into a structural "Type" step that snapshots the new layer). Handles
   * multi-line + word-wrapped paragraph text, alignment, leading, tracking and
   * underline / strike-through. `boxW` null = point text (no wrapping). Clears the
   * layer first so re-rendering an edited text layer replaces the old pixels.
   */
  renderText(layerId: string, spec: TextRenderSpec) {
    const ctx = this.layer(layerId).ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    const lines = this.textLines(ctx, spec); // sets font + letterSpacing, wraps
    ctx.fillStyle = spec.color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = spec.align;

    const m = ctx.measureText("Mg");
    const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || spec.fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || spec.fontSize * 0.2;
    const leading = spec.fontSize * spec.lineHeight;
    const baseline0 = spec.y + (leading - (ascent + descent)) / 2 + ascent;
    const thickness = Math.max(1, spec.fontSize / 16);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const baseline = baseline0 + i * leading;
      const anchorX =
        spec.boxW == null
          ? spec.x
          : spec.align === "left"
            ? spec.x
            : spec.align === "right"
              ? spec.x + spec.boxW
              : spec.x + spec.boxW / 2;
      if (line) ctx.fillText(line, anchorX, baseline);
      if ((spec.underline || spec.strike) && line) {
        const w = ctx.measureText(line).width;
        const left =
          spec.align === "left" ? anchorX : spec.align === "right" ? anchorX - w : anchorX - w / 2;
        if (spec.underline) ctx.fillRect(left, baseline + descent * 0.45, w, thickness);
        if (spec.strike) ctx.fillRect(left, baseline - ascent * 0.32, w, thickness);
      }
    }
    ctx.restore();

    // No anti-aliasing: threshold the rendered alpha to hard 1-bit edges. The
    // solid value is the colour's own alpha (so text opacity is preserved); edge
    // pixels (partial coverage) snap to fully on/off at the 50%-coverage line.
    if (!spec.antialias) {
      const b = this.textBounds(spec);
      const pad = Math.ceil(spec.fontSize * 0.5) + 2;
      const x = Math.max(0, Math.floor(b.x - pad));
      const y = Math.max(0, Math.floor(b.y - pad));
      const x1 = Math.min(this.w, Math.ceil(b.x + b.w + pad));
      const y1 = Math.min(this.h, Math.ceil(b.y + b.h + pad));
      const rw = x1 - x;
      const rh = y1 - y;
      if (rw > 0 && rh > 0) {
        const ca = Math.round(parseColor(spec.color).a * 255);
        const t = Math.max(1, ca >> 1);
        const img = ctx.getImageData(x, y, rw, rh);
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= t ? ca : 0;
        ctx.putImageData(img, x, y);
      }
    }
    this.emitChange();
  }

  // ---- Coverage brushes (blur, dodge/burn) ---------------------------------
  /** A soft falloff tip (coverage 0–1, no colour) for the coverage brushes. */
  private buildCoverageTip(r: number, hardness: number): { data: Float32Array; size: number; r: number } {
    const size = Math.max(2, Math.ceil(r * 2) + 2);
    const data = new Float32Array(size * size);
    const center = size / 2;
    const inner = Math.max(0, Math.min(0.999, hardness / 100)) * r;
    const span = Math.max(0.0001, r - inner);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px + 0.5 - center;
        const dy = py + 0.5 - center;
        const dist = Math.hypot(dx, dy);
        data[py * size + px] = dist <= inner ? 1 : dist >= r ? 0 : 1 - (dist - inner) / span;
      }
    }
    return { data, size, r };
  }

  /** Copy a rectangular sub-region of a full-doc ImageData into a new one. */
  private subImage(img: ImageData, x: number, y: number, w: number, h: number): ImageData {
    const out = new Uint8ClampedArray(w * h * 4);
    const sw = img.width;
    for (let yy = 0; yy < h; yy++) {
      const srcStart = ((y + yy) * sw + x) * 4;
      out.set(img.data.subarray(srcStart, srcStart + w * 4), yy * w * 4);
    }
    return new ImageData(out, w, h, { colorSpace: this.cs });
  }

  beginBlur(
    layerId: string,
    blur: BlurSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    if (this.w < 1 || this.h < 1) return;
    this.endAdjust();
    const l = this.layer(layerId);
    this.blurring = true;
    this.blurLayer = layerId;
    this.blurOpts = { ...blur };
    this.blurOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    if (blur.sampleAll && this.vctx) {
      try {
        this.blurSrc = this.vctx.getImageData(0, 0, this.w, this.h);
      } catch {
        this.blurSrc = this.blurOrig;
      }
    } else {
      this.blurSrc = this.blurOrig;
    }
    this.blurCov = new Float32Array(this.w * this.h);
    this.blurSelMask = null;
    if (clip && clip.length) {
      const mask = this.selectionMask(clip, clipAngle, clipPivot);
      const md = mask.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      this.blurSelMask = sa;
    }
    this.blurTip = this.buildCoverageTip(Math.max(0.5, blur.size / 2), blur.hardness);
    this.blurStep = Math.max(1, blur.size * (blur.spacing / 100));
    this.blurResidual = 0;
    this.blurDirty = null;
    this.blurLast = { x, y };
    this.blurLastRaw = { x, y };
    this.blurSmoothPt = { x, y };
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stampBlur(x, y, seg);
    this.blurResidual = this.blurStep;
    if (seg.x1 >= seg.x0) this.bakeBlur(seg.x0, seg.y0, seg.x1, seg.y1);
    this.emitChange();
  }

  moveBlur(rawX: number, rawY: number) {
    if (!this.blurring || !this.blurOpts) return;
    this.blurLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.blurOpts.smoothing / 100) * 0.85;
    this.blurSmoothPt.x += (rawX - this.blurSmoothPt.x) * alpha;
    this.blurSmoothPt.y += (rawY - this.blurSmoothPt.y) * alpha;
    this.blurLineTo(this.blurSmoothPt.x, this.blurSmoothPt.y);
    this.emitChange();
  }

  private blurLineTo(x: number, y: number) {
    const dx = x - this.blurLast.x;
    const dy = y - this.blurLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let d = this.blurResidual;
    while (d <= dist) {
      const t = d / dist;
      this.stampBlur(this.blurLast.x + dx * t, this.blurLast.y + dy * t, seg);
      d += this.blurStep;
    }
    this.blurResidual = d - dist;
    this.blurLast = { x, y };
    if (seg.x1 >= seg.x0) this.bakeBlur(seg.x0, seg.y0, seg.x1, seg.y1);
  }

  /** Accumulate one dab's coverage into blurCov, growing the seg + total bounds. */
  private stampBlur(
    cx: number,
    cy: number,
    seg: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const tip = this.blurTip;
    const cov = this.blurCov;
    if (!tip || !cov) return;
    const size = tip.size;
    const half = size / 2;
    const left = Math.floor(cx - half);
    const top = Math.floor(cy - half);
    for (let py = 0; py < size; py++) {
      const gy = top + py;
      if (gy < 0 || gy >= this.h) continue;
      for (let px = 0; px < size; px++) {
        const gx = left + px;
        if (gx < 0 || gx >= this.w) continue;
        const f = tip.data[py * size + px];
        if (f <= 0) continue;
        const idx = gy * this.w + gx;
        if (f > cov[idx]) cov[idx] = f;
        if (gx < seg.x0) seg.x0 = gx;
        if (gy < seg.y0) seg.y0 = gy;
        if (gx > seg.x1) seg.x1 = gx;
        if (gy > seg.y1) seg.y1 = gy;
        const D = this.blurDirty;
        if (!D) this.blurDirty = { x0: gx, y0: gy, x1: gx, y1: gy };
        else {
          if (gx < D.x0) D.x0 = gx;
          if (gy < D.y0) D.y0 = gy;
          if (gx > D.x1) D.x1 = gx;
          if (gy > D.y1) D.y1 = gy;
        }
      }
    }
  }

  /** Re-bake one region of the layer as lerp(orig, blur(src), coverage×strength). */
  private bakeBlur(x0: number, y0: number, x1: number, y1: number) {
    const orig = this.blurOrig;
    const src = this.blurSrc;
    const cov = this.blurCov;
    const opts = this.blurOpts;
    if (!orig || !src || !cov || !opts || this.blurLayer == null) return;
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const ax = Math.min(this.w - 1, x1);
    const ay = Math.min(this.h - 1, y1);
    const iw = ax - ix + 1;
    const ih = ay - iy + 1;
    if (iw <= 0 || ih <= 0) return;
    const R = Math.max(0, Math.round(opts.radius));
    const br = Math.max(1, Math.round(R / 2));
    // Read an R-wide margin so the blur over the inner region is seam-free.
    const rx = Math.max(0, ix - R);
    const ry = Math.max(0, iy - R);
    const ax2 = Math.min(this.w - 1, ax + R);
    const ay2 = Math.min(this.h - 1, ay + R);
    const rw = ax2 - rx + 1;
    const rh = ay2 - ry + 1;
    const sd = src.data;
    const sw = this.w;
    const n = rw * rh;
    const Rc = new Float32Array(n);
    const Gc = new Float32Array(n);
    const Bc = new Float32Array(n);
    const Ac = new Float32Array(n);
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        const si = ((ry + yy) * sw + (rx + xx)) * 4;
        const a = sd[si + 3];
        const af = a / 255;
        const di = yy * rw + xx;
        Rc[di] = sd[si] * af;
        Gc[di] = sd[si + 1] * af;
        Bc[di] = sd[si + 2] * af;
        Ac[di] = a;
      }
    }
    if (R > 0) {
      for (let p = 0; p < 3; p++) {
        boxBlurPass(Rc, rw, rh, br, true);
        boxBlurPass(Gc, rw, rh, br, true);
        boxBlurPass(Bc, rw, rh, br, true);
        boxBlurPass(Ac, rw, rh, br, true);
        boxBlurPass(Rc, rw, rh, br, false);
        boxBlurPass(Gc, rw, rh, br, false);
        boxBlurPass(Bc, rw, rh, br, false);
        boxBlurPass(Ac, rw, rh, br, false);
      }
    }
    const od = orig.data;
    const sel = this.blurSelMask;
    const strength = opts.strength / 100;
    const out = new Uint8ClampedArray(iw * ih * 4);
    for (let yy = 0; yy < ih; yy++) {
      for (let xx = 0; xx < iw; xx++) {
        const gx = ix + xx;
        const gy = iy + yy;
        const ci = gy * this.w + gx;
        let m = cov[ci] * strength;
        if (sel) m *= sel[ci] / 255;
        const oi = ci * 4;
        const ri = (gy - ry) * rw + (gx - rx);
        const a = Ac[ri];
        const inv = a > 0 ? 255 / a : 0;
        const tr = Rc[ri] * inv;
        const tg = Gc[ri] * inv;
        const tb = Bc[ri] * inv;
        const doI = (yy * iw + xx) * 4;
        out[doI] = od[oi] + (tr - od[oi]) * m;
        out[doI + 1] = od[oi + 1] + (tg - od[oi + 1]) * m;
        out[doI + 2] = od[oi + 2] + (tb - od[oi + 2]) * m;
        out[doI + 3] = od[oi + 3] + (a - od[oi + 3]) * m;
      }
    }
    this.layer(this.blurLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
  }

  endBlur() {
    if (!this.blurring) return;
    this.blurLineTo(this.blurLastRaw.x, this.blurLastRaw.y);
    const D = this.blurDirty;
    const layerId = this.blurLayer;
    if (D && layerId != null && this.blurOrig) {
      const x = Math.max(0, D.x0);
      const y = Math.max(0, D.y0);
      const w = Math.min(this.w - 1, D.x1) - x + 1;
      const h = Math.min(this.h - 1, D.y1) - y + 1;
      if (w > 0 && h > 0) {
        const before = this.subImage(this.blurOrig, x, y, w, h);
        const after = this.layer(layerId).ctx.getImageData(x, y, w, h);
        this.pushEntry(layerId, { x, y, w, h }, before, after, "Blur");
      }
    }
    this.blurring = false;
    this.blurLayer = null;
    this.blurOrig = null;
    this.blurSrc = null;
    this.blurCov = null;
    this.blurTip = null;
    this.blurOpts = null;
    this.blurDirty = null;
    this.blurSelMask = null;
    this.wandSrc = null;
    this.emitChange();
  }

  // ---- Dodge / Burn brush --------------------------------------------------
  beginDodge(
    layerId: string,
    opts: DodgeSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    if (this.w < 1 || this.h < 1) return;
    this.endAdjust();
    const l = this.layer(layerId);
    this.dodging = true;
    this.dodgeLayer = layerId;
    this.dodgeOpts = { ...opts };
    this.dodgeOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    this.dodgeCov = new Float32Array(this.w * this.h);
    this.dodgeSelMask = null;
    if (clip && clip.length) {
      const mask = this.selectionMask(clip, clipAngle, clipPivot);
      const md = mask.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      this.dodgeSelMask = sa;
    }
    this.dodgeTip = this.buildCoverageTip(Math.max(0.5, opts.size / 2), opts.hardness);
    this.dodgeStep = Math.max(1, opts.size * (opts.spacing / 100));
    this.dodgeResidual = 0;
    this.dodgeDirty = null;
    this.dodgeLast = { x, y };
    this.dodgeLastRaw = { x, y };
    this.dodgeSmoothPt = { x, y };
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stampDodge(x, y, seg);
    this.dodgeResidual = this.dodgeStep;
    if (seg.x1 >= seg.x0) this.bakeDodge(seg.x0, seg.y0, seg.x1, seg.y1);
    this.emitChange();
  }

  moveDodge(rawX: number, rawY: number) {
    if (!this.dodging || !this.dodgeOpts) return;
    this.dodgeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.dodgeOpts.smoothing / 100) * 0.85;
    this.dodgeSmoothPt.x += (rawX - this.dodgeSmoothPt.x) * alpha;
    this.dodgeSmoothPt.y += (rawY - this.dodgeSmoothPt.y) * alpha;
    this.dodgeLineTo(this.dodgeSmoothPt.x, this.dodgeSmoothPt.y);
    this.emitChange();
  }

  private dodgeLineTo(x: number, y: number) {
    const dx = x - this.dodgeLast.x;
    const dy = y - this.dodgeLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let d = this.dodgeResidual;
    while (d <= dist) {
      const t = d / dist;
      this.stampDodge(this.dodgeLast.x + dx * t, this.dodgeLast.y + dy * t, seg);
      d += this.dodgeStep;
    }
    this.dodgeResidual = d - dist;
    this.dodgeLast = { x, y };
    if (seg.x1 >= seg.x0) this.bakeDodge(seg.x0, seg.y0, seg.x1, seg.y1);
  }

  private stampDodge(
    cx: number,
    cy: number,
    seg: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const tip = this.dodgeTip;
    const cov = this.dodgeCov;
    if (!tip || !cov) return;
    const size = tip.size;
    const half = size / 2;
    const left = Math.floor(cx - half);
    const top = Math.floor(cy - half);
    for (let py = 0; py < size; py++) {
      const gy = top + py;
      if (gy < 0 || gy >= this.h) continue;
      for (let px = 0; px < size; px++) {
        const gx = left + px;
        if (gx < 0 || gx >= this.w) continue;
        const f = tip.data[py * size + px];
        if (f <= 0) continue;
        const idx = gy * this.w + gx;
        if (f > cov[idx]) cov[idx] = f;
        if (gx < seg.x0) seg.x0 = gx;
        if (gy < seg.y0) seg.y0 = gy;
        if (gx > seg.x1) seg.x1 = gx;
        if (gy > seg.y1) seg.y1 = gy;
        const D = this.dodgeDirty;
        if (!D) this.dodgeDirty = { x0: gx, y0: gy, x1: gx, y1: gy };
        else {
          if (gx < D.x0) D.x0 = gx;
          if (gy < D.y0) D.y0 = gy;
          if (gx > D.x1) D.x1 = gx;
          if (gy > D.y1) D.y1 = gy;
        }
      }
    }
  }

  /** Re-bake one region as the dodge/burn of the original, by coverage×exposure. */
  private bakeDodge(x0: number, y0: number, x1: number, y1: number) {
    const orig = this.dodgeOrig;
    const cov = this.dodgeCov;
    const opts = this.dodgeOpts;
    if (!orig || !cov || !opts || this.dodgeLayer == null) return;
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const ax = Math.min(this.w - 1, x1);
    const ay = Math.min(this.h - 1, y1);
    const iw = ax - ix + 1;
    const ih = ay - iy + 1;
    if (iw <= 0 || ih <= 0) return;
    const od = orig.data;
    const sel = this.dodgeSelMask;
    const exposure = opts.exposure / 100;
    const dodge = opts.mode === "dodge";
    const protect = opts.protect;
    const range = opts.range;
    const MASTER = 0.5; // exposure 100% in-range ≈ a 50% push per pass
    const out = new Uint8ClampedArray(iw * ih * 4);
    for (let yy = 0; yy < ih; yy++) {
      for (let xx = 0; xx < iw; xx++) {
        const gx = ix + xx;
        const gy = iy + yy;
        const ci = gy * this.w + gx;
        const oi = ci * 4;
        const r = od[oi];
        const g = od[oi + 1];
        const b = od[oi + 2];
        const doI = (yy * iw + xx) * 4;
        let m = cov[ci];
        if (sel) m *= sel[ci] / 255;
        if (m <= 0) {
          out[doI] = r;
          out[doI + 1] = g;
          out[doI + 2] = b;
          out[doI + 3] = od[oi + 3];
          continue;
        }
        const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0..1
        const w =
          range === "shadows" ? 1 - L : range === "highlights" ? L : 1 - Math.abs(2 * L - 1);
        let a = m * exposure * w * MASTER;
        if (a > 0.95) a = 0.95;
        let nr = r;
        let ng = g;
        let nb = b;
        if (dodge) {
          if (protect && L > 0.02) {
            const scale = (L + (1 - L) * a) / L;
            nr = r * scale;
            ng = g * scale;
            nb = b * scale;
          } else {
            nr = r + (255 - r) * a;
            ng = g + (255 - g) * a;
            nb = b + (255 - b) * a;
          }
        } else {
          // Burn (multiplicative toward black preserves hue inherently).
          const k = 1 - a;
          nr = r * k;
          ng = g * k;
          nb = b * k;
        }
        out[doI] = nr;
        out[doI + 1] = ng;
        out[doI + 2] = nb;
        out[doI + 3] = od[oi + 3];
      }
    }
    this.layer(this.dodgeLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
  }

  endDodge() {
    if (!this.dodging) return;
    this.dodgeLineTo(this.dodgeLastRaw.x, this.dodgeLastRaw.y);
    const D = this.dodgeDirty;
    const layerId = this.dodgeLayer;
    if (D && layerId != null && this.dodgeOrig) {
      const x = Math.max(0, D.x0);
      const y = Math.max(0, D.y0);
      const w = Math.min(this.w - 1, D.x1) - x + 1;
      const h = Math.min(this.h - 1, D.y1) - y + 1;
      if (w > 0 && h > 0) {
        const before = this.subImage(this.dodgeOrig, x, y, w, h);
        const after = this.layer(layerId).ctx.getImageData(x, y, w, h);
        const label = this.dodgeOpts?.mode === "burn" ? "Burn" : "Dodge";
        this.pushEntry(layerId, { x, y, w, h }, before, after, label);
      }
    }
    this.dodging = false;
    this.dodgeLayer = null;
    this.dodgeOrig = null;
    this.dodgeCov = null;
    this.dodgeTip = null;
    this.dodgeOpts = null;
    this.dodgeDirty = null;
    this.dodgeSelMask = null;
    this.wandSrc = null;
    this.emitChange();
  }

  // ---- Blur Gallery (Effects) ----------------------------------------------
  /** Begin a blur-effect preview session over `ids` (clipped to `sel` if given). */
  beginBlurFx(
    ids: string[],
    sel: Rect[] | null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    this.endAdjust();
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
    const orig = new Map<string, ImageData>();
    for (const id of ids) orig.set(id, this.layer(id).ctx.getImageData(0, 0, this.w, this.h));
    let mask: Uint8ClampedArray | null = null;
    if (sel && sel.length) {
      const m = this.selectionMask(sel, selAngle, selPivot);
      const md = m.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      mask = sa;
    }
    this.blurFx = { ids, orig, mask };
  }

  /**
   * Re-render the preview from the originals. `anchorX/anchorY` (0–1 of the doc)
   * is the centre for zoom/spin blur; ignored by the other kinds.
   */
  previewBlurFx(kind: string, amount: number, angle: number, anchorX = 0.5, anchorY = 0.5) {
    const fx = this.blurFx;
    if (!fx) return;
    const cx = anchorX * this.w;
    const cy = anchorY * this.h;
    for (const id of fx.ids) {
      const o = fx.orig.get(id);
      if (!o) continue;
      const out = computeBlurFx(o, kind, amount, angle, fx.mask, cx, cy, this.cs);
      this.layer(id).ctx.putImageData(out, 0, 0);
    }
    this.emitChange();
  }

  /** Keep the previewed blur as one undoable step (undo/redo swap the snapshots). */
  commitBlurFx(label: string) {
    const fx = this.blurFx;
    if (!fx) return;
    const { ids, orig } = fx;
    const after = new Map<string, ImageData>();
    for (const id of ids) after.set(id, this.layer(id).ctx.getImageData(0, 0, this.w, this.h));
    this.blurFx = null;
    this.wandSrc = null;
    this.pushStructural(
      label,
      () => {
        for (const id of ids) {
          const o = orig.get(id);
          if (o) this.layer(id).ctx.putImageData(o, 0, 0);
        }
        this.wandSrc = null;
        this.emitChange();
      },
      () => {
        for (const id of ids) {
          const a = after.get(id);
          if (a) this.layer(id).ctx.putImageData(a, 0, 0);
        }
        this.wandSrc = null;
        this.emitChange();
      },
    );
  }

  /** Discard the blur preview, restoring the original pixels. */
  cancelBlurFx() {
    const fx = this.blurFx;
    if (!fx) return;
    for (const id of fx.ids) {
      const o = fx.orig.get(id);
      if (o) this.layer(id).ctx.putImageData(o, 0, 0);
    }
    this.blurFx = null;
    this.emitChange();
  }

  /** A crisp, aliased disc tip (no anti-aliasing, no feather). */
  private buildHardTip(
    r: number,
    cr: number,
    cg: number,
    cb: number,
    flow: number,
  ): HTMLCanvasElement {
    const size = Math.max(1, Math.ceil(r * 2));
    const { c, ctx } = makeCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const center = size / 2;
    const rr = r * r;
    const a = Math.round(flow * 255);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px + 0.5 - center;
        const dy = py + 0.5 - center;
        if (dx * dx + dy * dy <= rr) {
          const i = (py * size + px) * 4;
          data[i] = cr;
          data[i + 1] = cg;
          data[i + 2] = cb;
          data[i + 3] = a;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * A soft disc tip with an analytic radial falloff (solid core out to the
   * hardness radius, then a linear fade to the edge). Computed per-pixel so it
   * carries NO gradient dithering — overlapping stamps then accumulate smoothly
   * instead of compounding dither noise into grain.
   */
  private buildSoftTip(
    r: number,
    cr: number,
    cg: number,
    cb: number,
    flow: number,
    hardness: number,
  ): HTMLCanvasElement {
    const size = Math.max(2, Math.ceil(r * 2) + 2); // +1px each side for the rim
    const { c, ctx } = makeCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const center = size / 2;
    const inner = Math.max(0, Math.min(0.999, hardness / 100)) * r; // solid core radius
    const span = Math.max(0.0001, r - inner);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px + 0.5 - center;
        const dy = py + 0.5 - center;
        const dist = Math.hypot(dx, dy);
        let a: number;
        if (dist <= inner) a = flow;
        else if (dist >= r) a = 0;
        else a = flow * (1 - (dist - inner) / span);
        if (a <= 0) continue;
        const i = (py * size + px) * 4;
        data[i] = cr;
        data[i + 1] = cg;
        data[i + 2] = cb;
        data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private stamp(x: number, y: number) {
    if (this.cloneActive) {
      this.cloneStamp(x, y);
      return;
    }
    const tip = this.tip;
    if (!tip) return;
    const ctx = this.stroke!.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (this.tipHard) {
      // Crisp hard brush: stamp the aliased tip on the integer pixel grid.
      ctx.imageSmoothingEnabled = false;
      const ix = Math.round(x - tip.width / 2);
      const iy = Math.round(y - tip.height / 2);
      ctx.drawImage(tip, ix, iy);
      this.expandDirty(ix, iy, ix + tip.width, iy + tip.height);
    } else {
      // Soft brush: stamp the baked tip at sub-pixel position (smoothed).
      ctx.imageSmoothingEnabled = true;
      const dx = x - tip.width / 2;
      const dy = y - tip.height / 2;
      ctx.drawImage(tip, dx, dy);
      this.expandDirty(Math.floor(dx), Math.floor(dy), Math.ceil(dx + tip.width), Math.ceil(dy + tip.height));
    }
  }

  private expandDirty(x0: number, y0: number, x1: number, y1: number) {
    if (!this.dirty) this.dirty = { x0, y0, x1, y1 };
    else {
      this.dirty.x0 = Math.min(this.dirty.x0, x0);
      this.dirty.y0 = Math.min(this.dirty.y0, y0);
      this.dirty.x1 = Math.max(this.dirty.x1, x1);
      this.dirty.y1 = Math.max(this.dirty.y1, y1);
    }
  }

  private dirtyRect() {
    if (!this.dirty) return null;
    const x = Math.max(0, Math.floor(this.dirty.x0));
    const y = Math.max(0, Math.floor(this.dirty.y0));
    const x1 = Math.min(this.w, Math.ceil(this.dirty.x1));
    const y1 = Math.min(this.h, Math.ceil(this.dirty.y1));
    const w = x1 - x;
    const h = y1 - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  // ---- history ----
  private apply(e: Entry) {
    if (e.layerId && e.rect && e.after)
      this.layer(e.layerId).ctx.putImageData(e.after, e.rect.x, e.rect.y);
  }
  private revert(e: Entry) {
    if (e.layerId && e.rect && e.before)
      this.layer(e.layerId).ctx.putImageData(e.before, e.rect.x, e.rect.y);
  }
  jumpTo(target: number) {
    this.endAdjust(); // finalize a live adjustment / shape / gradient / path / fill before navigating history
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
    target = Math.max(0, Math.min(this.entries.length, target));
    while (this.pos > target) {
      this.pos--;
      const e = this.entries[this.pos];
      this.revert(e);
      e.side?.undo();
    }
    while (this.pos < target) {
      const e = this.entries[this.pos];
      e.side?.redo();
      this.apply(e);
      this.pos++;
    }
    this.emitHistory();
    this.emitChange();
  }
  undo() {
    if (this.pos > 0) this.jumpTo(this.pos - 1);
  }
  redo() {
    if (this.pos < this.entries.length) this.jumpTo(this.pos + 1);
  }
  syncHistory() {
    this.emitHistory();
  }
  private emitHistory() {
    // Any history change means layer pixels changed → wand source is stale.
    this.wandSrc = null;
    this.onHistory({
      items: [{ label: "New" }, ...this.entries.map((e) => ({ label: e.label }))],
      index: this.pos,
    });
  }
}
