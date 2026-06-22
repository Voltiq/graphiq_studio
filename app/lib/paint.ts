import { parseColor, toHex8 } from "./color";
import type { Rect } from "./view";
import type { LayerNode } from "./layers";
import { applyAdjustments, isDefaultAdjust, type Adjustments } from "./adjust";
import { renderShape } from "./shapes";
import { buildCanvasGradient } from "./gradient";
import type { GradientStop, GradientType, ShapeKind } from "./tools";

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
  ) => void;
  eraseSelection: (
    layerId: string,
    rects: Rect[],
    angle?: number,
    pivot?: { x: number; y: number } | null,
    label?: string,
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
  private clipTo(
    ctx: CanvasRenderingContext2D,
    rects: Rect[] | null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    if (!rects || !rects.length) return;
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
    ctx.clip();
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
    this.endAdjust(); // any other pixel op finalizes a live adjustment / shape / gradient
    this.endShape();
    this.endGradient();
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
  ) {
    const bounds = this.boundsOf(rects, angle, pivot);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    this.clipTo(l.ctx, rects, angle, pivot);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.fillStyle = colorHex;
    l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.restore();
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(layerId, bounds, before, after, "Fill");
    this.emitChange();
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
    renderShape(ctx, kind, box, fill, stroke, strokeWidth, radius);
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
  ) {
    if (box.w < 1 || box.h < 1) return;
    this.endAdjust(); // a shape and an adjustment / gradient can't be live at once
    this.endGradient();
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
    this.paintShape(l.ctx, box, angle, kind, fill, stroke, strokeWidth, radius);
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

  /** Clear (erase to transparent) the selection on a layer (records history).
      `label` lets callers journal it as e.g. "Cut" instead of "Delete". */
  eraseSelection(
    layerId: string,
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
    label = "Delete",
  ) {
    const bounds = this.boundsOf(rects, angle, pivot);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    this.clipTo(l.ctx, rects, angle, pivot);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "destination-out";
    l.ctx.fillStyle = "#000";
    l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
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
  ): boolean {
    this.endShape(); // finalize a live shape / gradient before lifting pixels to transform
    this.endGradient();
    if (this.floatActive) this.commitFloat();
    const src = this.boundsOf(rects, angle, pivot);
    if (!src) return false;
    const l = this.layer(layerId);
    // Pristine copy of the layer for history & discard.
    this.floatOrig = this.mk(this.w, this.h, true);
    this.floatOrig.ctx.drawImage(l.c, 0, 0);
    // Lifted content: the layer clipped to the selection (full doc size).
    const lifted = this.mk(this.w, this.h);
    lifted.ctx.save();
    this.clipTo(lifted.ctx, rects, angle, pivot);
    lifted.ctx.drawImage(l.c, 0, 0);
    lifted.ctx.restore();
    this.floatSource = lifted.c;
    // Remove the lifted pixels from the layer (the hole).
    l.ctx.save();
    this.clipTo(l.ctx, rects, angle, pivot);
    l.ctx.globalCompositeOperation = "destination-out";
    l.ctx.fillStyle = "#000";
    l.ctx.fillRect(src.x, src.y, src.w, src.h);
    l.ctx.restore();
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
        if (
          Math.abs(data[i] - sr) > t ||
          Math.abs(data[i + 1] - sg) > t ||
          Math.abs(data[i + 2] - sb) > t ||
          Math.abs(data[i + 3] - sa) > t
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
          if (
            Math.abs(data[i] - sr) <= t &&
            Math.abs(data[i + 1] - sg) <= t &&
            Math.abs(data[i + 2] - sb) <= t &&
            Math.abs(data[i + 3] - sa) <= t
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
    this.endAdjust(); // finalize a live adjustment / shape / gradient before navigating history
    this.endShape();
    this.endGradient();
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
