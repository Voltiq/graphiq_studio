import { parseColor, toHex8 } from "./color";
import type { Rect } from "./view";
import type { LayerNode } from "./layers";
import { applyAdjustments, isDefaultAdjust, type Adjustments } from "./adjust";

export interface BrushSettings {
  size: number; // px (document space)
  hardness: number; // 0–100
  opacity: number; // 0–100 (per-stroke cap)
  flow: number; // 0–100 (build-up within a stroke)
  blend: string;
  smoothing: number; // 0–100
}

export interface HistorySummary {
  items: { label: string }[];
  index: number;
}

export interface EngineHandle {
  undo: () => void;
  redo: () => void;
  jumpTo: (index: number) => void;
  fillSelection: (layerId: string, rects: Rect[], colorHex: string) => void;
  eraseSelection: (layerId: string, rects: Rect[]) => void;
  copyRegion: (rects: Rect[] | null) => CopyResult | null;
  isFloating: () => boolean;
  commitFloat: () => void;
  discardFloat: () => void;
  duplicateLayer: (srcId: string, dstId: string) => void;
  rasterize: (targetId: string, nodes: LayerNode[], deleteIds: string[]) => void;
  removeLayer: (id: string) => void;
  getLayerImage: (id: string) => string | null;
  setLayerImage: (id: string, source: CanvasImageSource) => void;
  exportComposite: (tree: LayerNode[]) => HTMLCanvasElement;
  applyAdjust: (layerId: string, adj: Adjustments) => void;
  commitAdjust: (layerId: string, adj: Adjustments) => void;
  cancelAdjust: () => void;
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

const makeCanvas = (w: number, h: number, readFreq = false) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", readFreq ? { willReadFrequently: true } : undefined)!;
  return { c, ctx };
};

interface Layer {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export type StrokeMode = "paint" | "erase";

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

  private painting = false;
  private strokeLayer: string | null = null;
  private brush: BrushSettings | null = null;
  private mode: StrokeMode = "paint";
  private clip: Rect[] | null = null;
  private col = { r: 0, g: 0, b: 0, a: 1 };
  // Aliased hard-brush tip (used for 100% hardness / 1px), stamped crisply.
  private tip: HTMLCanvasElement | null = null;

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

  // Live adjustment preview: the target leaf, a snapshot of its original pixels,
  // and the adjusted result shown in its place until committed.
  private adjLayer: string | null = null;
  private adjOrig: ImageData | null = null;
  private adjCanvas: HTMLCanvasElement | null = null;
  private adjPending: Adjustments | null = null;
  private adjRaf = 0;
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

  get isPainting() {
    return this.painting;
  }

  setView(v: HTMLCanvasElement | null) {
    this.view = v;
    this.vctx = v ? v.getContext("2d") : null;
  }

  setDoc(w: number, h: number, ownLayerIds?: string[]) {
    if (this.w === w && this.h === h && this.stroke) return;
    this.w = w;
    this.h = h;
    this.stroke = makeCanvas(w, h);
    this.scratch = makeCanvas(w, h);
    for (const [id, l] of this.layers) {
      // Only resize the active document's layers; leave other docs' layers alone.
      if (ownLayerIds && !ownLayerIds.includes(id)) continue;
      if (l.c.width !== w || l.c.height !== h) {
        const next = makeCanvas(w, h, true);
        next.ctx.drawImage(l.c, 0, 0);
        this.layers.set(id, next);
      }
    }
  }

  private layer(id: string): Layer {
    let l = this.layers.get(id);
    if (!l) {
      l = makeCanvas(this.w, this.h, true);
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

  private clipTo(ctx: CanvasRenderingContext2D, rects: Rect[] | null) {
    if (!rects || !rects.length) return;
    ctx.beginPath();
    for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
  }

  /** Draw the current stroke buffer onto a context, clipped to the selection. */
  private drawStroke(ctx: CanvasRenderingContext2D) {
    ctx.save();
    this.clipTo(ctx, this.clip);
    ctx.globalAlpha = this.strokeAlpha();
    ctx.globalCompositeOperation = this.strokeComposite();
    ctx.drawImage(this.stroke!.c, 0, 0);
    ctx.restore();
  }

  private boundsOf(rects: Rect[]): Rect | null {
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
    if (this.pos < this.entries.length) this.entries.length = this.pos;
    this.entries.push({ layerId, rect, before, after, label, side });
    this.pos = this.entries.length;
    this.emitHistory();
  }

  /** Push a structural undo step (no pixel payload — `undo`/`redo` do the work). */
  pushStructural(label: string, undo: () => void, redo: () => void) {
    if (this.pos < this.entries.length) this.entries.length = this.pos;
    this.entries.push({ label, side: { undo, redo } });
    this.pos = this.entries.length;
    this.emitHistory();
  }

  /** Fill the selection on a layer with a colour (records history). */
  fillSelection(layerId: string, rects: Rect[], colorHex: string) {
    const bounds = this.boundsOf(rects);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    this.clipTo(l.ctx, rects);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.fillStyle = colorHex;
    l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.restore();
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(layerId, bounds, before, after, "Fill");
    this.onChange();
  }

  /** Clear (erase to transparent) the selection on a layer (records history). */
  eraseSelection(layerId: string, rects: Rect[]) {
    const bounds = this.boundsOf(rects);
    if (!bounds) return;
    const l = this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    this.clipTo(l.ctx, rects);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "destination-out";
    l.ctx.fillStyle = "#000";
    l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.restore();
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(layerId, bounds, before, after, "Delete");
    this.onChange();
  }

  /** Copy a layer's pixels into another (new) layer id. */
  duplicateLayer(srcId: string, dstId: string) {
    const src = this.layers.get(srcId);
    const dst = this.layer(dstId);
    dst.ctx.globalAlpha = 1;
    dst.ctx.globalCompositeOperation = "source-over";
    dst.ctx.clearRect(0, 0, this.w, this.h);
    if (src) dst.ctx.drawImage(src.c, 0, 0);
    this.onChange();
  }

  /** Composite `nodes` (top→bottom) into one new layer, dropping `deleteIds`. */
  rasterize(targetId: string, nodes: LayerNode[], deleteIds: string[]) {
    const { c, ctx } = makeCanvas(this.w, this.h, true);
    for (let i = nodes.length - 1; i >= 0; i--) this.drawNode(ctx, nodes[i]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const id of deleteIds) this.layers.delete(id);
    this.layers.set(targetId, { c, ctx });
    this.onChange();
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
  applyAdjust(layerId: string, adj: Adjustments) {
    if (isDefaultAdjust(adj)) {
      this.cancelAdjust();
      return;
    }
    if (this.adjLayer !== layerId || !this.adjOrig) {
      this.clearAdjust();
      const l = this.layers.get(layerId);
      if (!l) return; // empty layer — nothing to adjust
      this.adjLayer = layerId;
      this.adjOrig = l.ctx.getImageData(0, 0, this.w, this.h);
      const made = makeCanvas(this.w, this.h);
      made.ctx.putImageData(this.adjOrig, 0, 0); // show original until first compute
      this.adjCanvas = made.c;
    }
    this.adjPending = adj;
    if (this.adjRaf) return;
    this.adjRaf = requestAnimationFrame(() => {
      this.adjRaf = 0;
      if (!this.adjPending || !this.adjOrig || !this.adjCanvas) return;
      const res = applyAdjustments(this.adjOrig, this.adjPending);
      this.adjCanvas.getContext("2d")!.putImageData(res, 0, 0);
      this.onChange();
    });
  }

  /** Bake the adjustment into the layer as one undoable step. */
  commitAdjust(layerId: string, adj: Adjustments) {
    if (this.adjLayer !== layerId || !this.adjOrig || isDefaultAdjust(adj)) {
      this.cancelAdjust();
      return;
    }
    const before = this.adjOrig;
    const after = applyAdjustments(before, adj);
    const l = this.layer(layerId);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.putImageData(after, 0, 0);
    this.pushEntry(layerId, { x: 0, y: 0, w: this.w, h: this.h }, before, after, "Adjustments");
    this.clearAdjust();
    this.onChange();
  }

  cancelAdjust() {
    if (!this.adjLayer) return;
    this.clearAdjust();
    this.onChange();
  }

  private clearAdjust() {
    if (this.adjRaf) {
      cancelAnimationFrame(this.adjRaf);
      this.adjRaf = 0;
    }
    this.adjLayer = null;
    this.adjOrig = null;
    this.adjCanvas = null;
    this.adjPending = null;
  }

  /** Replace a leaf layer's pixels with an image (used when loading a project). */
  setLayerImage(id: string, source: CanvasImageSource) {
    const l = this.layer(id);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(source, 0, 0);
    this.onChange();
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
    this.onChange();
  }

  /** The pixels to draw for a leaf, with any live stroke/move/float merged in. */
  private leafDisplay(id: string): HTMLCanvasElement | null {
    if (this.adjLayer === id && this.adjCanvas) return this.adjCanvas;
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
      if (this.floatDst && this.floatSrcRect) {
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
      const { c: bc, ctx: bctx } = makeCanvas(this.w, this.h);
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
    const { c, ctx } = makeCanvas(this.w, this.h);
    for (let i = tree.length - 1; i >= 0; i--) this.drawNode(ctx, tree[i]);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return c;
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
    this.moveOrig = makeCanvas(this.w, this.h, true);
    this.moveOrig.ctx.drawImage(l.c, 0, 0);
    this.moveFloat = makeCanvas(this.w, this.h);
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
    this.onChange();
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
    this.onChange();
  }

  /**
   * Lift a selection's pixels off a layer into a movable float (leaving a hole).
   * The float can be repositioned repeatedly and only merges on commit.
   */
  beginFloatFromSelection(layerId: string, rects: Rect[]): boolean {
    if (this.floatActive) this.commitFloat();
    const src = this.boundsOf(rects);
    if (!src) return false;
    const l = this.layer(layerId);
    // Pristine copy of the layer for history & discard.
    this.floatOrig = makeCanvas(this.w, this.h, true);
    this.floatOrig.ctx.drawImage(l.c, 0, 0);
    // Lifted content: the layer clipped to the selection (full doc size).
    const lifted = makeCanvas(this.w, this.h);
    lifted.ctx.save();
    this.clipTo(lifted.ctx, rects);
    lifted.ctx.drawImage(l.c, 0, 0);
    lifted.ctx.restore();
    this.floatSource = lifted.c;
    // Remove the lifted pixels from the layer (the hole).
    l.ctx.save();
    this.clipTo(l.ctx, rects);
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
    this.floatSide = undefined;
    this.onChange();
    return true;
  }

  setFloatOffset(x: number, y: number) {
    if (!this.floatActive) return;
    this.floatOff = { x: Math.round(x), y: Math.round(y) };
    this.onChange();
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
    this.onChange();
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
    this.floatSmooth = true;
  }

  /** Merge the float into its layer, recording one history step. */
  commitFloat() {
    if (!this.floatActive || !this.floatLayer || !this.floatSource) {
      this.clearFloat();
      return;
    }
    const l = this.layer(this.floatLayer);
    const layerId = this.floatLayer;
    const px = this.floatBase.x + this.floatOff.x;
    const py = this.floatBase.y + this.floatOff.y;

    if (this.floatOrig && this.floatSrcRect && this.floatDst) {
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
        this.pushEntry(layerId, { x: x0, y: y0, w: rw, h: rh }, before, after, "Scale");
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
    this.onChange();
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
    this.onChange();
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
    this.onChange();
  }

  /** Copy the composite within the selection (or the whole canvas) to a new canvas. */
  copyRegion(rects: Rect[] | null): CopyResult | null {
    if (!this.view) return null;
    const bounds =
      rects && rects.length ? this.boundsOf(rects) : { x: 0, y: 0, w: this.w, h: this.h };
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
    const out = document.createElement("canvas");
    out.width = bounds.w;
    out.height = bounds.h;
    const octx = out.getContext("2d");
    if (!octx) return null;
    if (rects && rects.length) {
      octx.save();
      octx.beginPath();
      for (const r of rects) octx.rect(r.x - bounds.x, r.y - bounds.y, r.w, r.h);
      octx.clip();
    }
    octx.drawImage(this.view, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
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
    const data = ctx.getImageData(x0, y0, bw, bh).data;
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

  moveTo(dx: number, dy: number) {
    if (!this.moving) return;
    this.moveOff = { x: Math.round(dx), y: Math.round(dy) };
    this.onChange();
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
    this.onChange();
  }

  beginStroke(
    layerId: string,
    brush: BrushSettings,
    colorHex: string,
    x: number,
    y: number,
    mode: StrokeMode = "paint",
    clip: Rect[] | null = null,
  ) {
    if (!this.stroke) return;
    this.layer(layerId); // ensure the target layer has a canvas so the live stroke composites
    this.painting = true;
    this.strokeLayer = layerId;
    this.brush = brush;
    this.mode = mode;
    this.clip = clip && clip.length ? clip : null;
    const c = parseColor(colorHex);
    this.col = { r: c.r, g: c.g, b: c.b, a: c.a };
    // A fully hard brush (or a 1px brush) paints crisp aliased pixels — no
    // gradient feather and no anti-aliased rim.
    const r = Math.max(0.5, brush.size / 2);
    this.tip =
      brush.hardness >= 100 || brush.size <= 1
        ? this.buildHardTip(r, c.r, c.g, c.b, Math.max(0, Math.min(1, brush.flow / 100)))
        : null;
    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.step = Math.max(1, brush.size * 0.1);
    this.last = { x, y };
    this.lastRaw = { x, y };
    this.smooth = { x, y };
    this.residual = 0;
    this.dirty = null;
    this.stamp(x, y);
    this.residual = this.step;
    this.onChange();
  }

  moveStroke(rawX: number, rawY: number) {
    if (!this.painting || !this.brush) return;
    this.lastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.brush.smoothing / 100) * 0.85;
    this.smooth.x += (rawX - this.smooth.x) * alpha;
    this.smooth.y += (rawY - this.smooth.y) * alpha;
    this.lineTo(this.smooth.x, this.smooth.y);
    this.onChange();
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
      this.pushEntry(layerId, rect, before, after, this.mode === "erase" ? "Erase" : "Brush");
    }

    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.painting = false;
    this.strokeLayer = null;
    this.brush = null;
    this.clip = null;
    this.tip = null;
    this.dirty = null;
    this.onChange();
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

  private stamp(x: number, y: number) {
    const b = this.brush!;
    const r = Math.max(0.5, b.size / 2);
    const ctx = this.stroke!.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (this.tip) {
      // Crisp hard brush: stamp the aliased tip on the integer pixel grid.
      ctx.imageSmoothingEnabled = false;
      const ix = Math.round(x - this.tip.width / 2);
      const iy = Math.round(y - this.tip.height / 2);
      ctx.drawImage(this.tip, ix, iy);
      this.expandDirty(ix, iy, ix + this.tip.width, iy + this.tip.height);
      return;
    }

    const inner = Math.min(0.999, Math.max(0, b.hardness / 100));
    const flow = Math.max(0, Math.min(1, b.flow / 100));
    const { r: cr, g: cg, b: cb } = this.col;
    const solid = `rgba(${cr},${cg},${cb},${flow})`;
    const clear = `rgba(${cr},${cg},${cb},0)`;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, solid);
    grad.addColorStop(inner, solid);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    this.expandDirty(x - r, y - r, x + r, y + r);
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
    this.onChange();
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
    this.onHistory({
      items: [{ label: "New" }, ...this.entries.map((e) => ({ label: e.label }))],
      index: this.pos,
    });
  }
}
