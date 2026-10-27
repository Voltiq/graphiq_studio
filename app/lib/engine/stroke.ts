// The engine's stroke (TODO 1.6): a brush or eraser stroke from its first dab
// to its last — or abandoned when a gesture takes over — its tips (baked once
// per pressure bucket; texture, dual tip, shape and scatter from brush-tip.ts),
// the dirty region it grows, and the stroke drawn onto a layer or a mask
// through the selection (clipped, or masked by a soft one, respecting the
// layer's transparency lock). The clone stamp rides the same pipeline, painting
// pixels sampled from a snapshot instead of a colour.
//
// The stroke's state is its own; its buffer is the engine's, read through
// `stroke` below. What it needs of the rest of the engine — the selection to
// clip through, which surface to paint, the pixel commit — comes through
// `StrokeHost`.

import { DocumentScoped, type DocCursor, type Layer } from "../doc-state";
import {
  DUAL_VARIANTS,
  dualMask,
  makeRng,
  scatterActive,
  scatterOffsets,
  textureAlpha,
  tipRadius,
  tipShapeActive,
  tipShapingActive,
  type DualTipSettings,
  type ScatterSettings,
  type TextureSettings,
  type TipShapeSettings,
} from "../brush-tip";
import { parseColor } from "../color";
import { blendOp } from "../layers";
import {
  DEFAULT_DYNAMICS,
  PRESSURE_BUCKETS,
  bucketPressure,
  clamp01,
  pressureBucket,
  pressureScale,
  type PressureDynamics,
} from "../pointer";
import type { SelectionMask } from "../selection-mask";
import { makeCanvas } from "./canvas";
import type { BrushSettings, HistorySide, StrokeMode } from "../paint";
import type { Rect } from "../view";

const NO_DYNAMICS: PressureDynamics = { size: false, flow: false, min: 0 };

/** A brush's pressure dynamics, with the defaults filled in. */
export const brushDynamics = (b: BrushSettings): PressureDynamics => ({
  size: b.pressureSize ?? DEFAULT_DYNAMICS.size,
  flow: b.pressureFlow ?? DEFAULT_DYNAMICS.flow,
  min: b.pressureMin ?? DEFAULT_DYNAMICS.min,
});

/** What a stroke needs of the rest of the engine. */
export interface StrokeHost {
  /** The live stroke's buffer, made on first use and sized with the document. */
  ensureOpBuffers(): void;
  strokeBuf(): Layer | null;
  /** The view canvas — what "all layers" samples. */
  view(): HTMLCanvasElement | null;
  /** A canvas in the working colour space, and a layer's raster. */
  mk(w: number, h: number, readFreq?: boolean): Layer;
  layer(id: string): Layer;
  /** Which surface a stroke on `id` paints, and the masks-map key it resolves to. */
  activeSurface(id: string): "pixels" | "mask";
  maskKeyOf(id: string): string;
  /** A mask was painted within `rect`: re-derive its alpha. */
  deriveMaskAlpha(id: string, rect?: Rect): void;
  /** The selection: a clip path, its soft mask, and its shape as a mask. */
  clipTo(
    ctx: CanvasRenderingContext2D,
    rects: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ): void;
  coverageOf(rects: Rect[] | null | undefined): SelectionMask | null;
  selectionMask(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement;
  /** The pixel commit: one undo step, the layer's locks enforced. */
  pushEntry(
    layerId: string,
    rect: { x: number; y: number; w: number; h: number },
    before: ImageData,
    after: ImageData,
    label: string,
    side?: HistorySide,
    surface?: "layer" | "mask",
  ): void;
  /** The live filter product is a document-sized buffer: the next stroke reseeds it. */
  dropLiveProduct(): void;
  emitChange(): void;
}

export class EngineStroke extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: StrokeHost,
  ) {
    super(cursor);
  }

  painting = false;
  strokeLayer: string | null = null;
  // True while the in-progress stroke paints the mask (set in beginStroke).
  strokeOnMask = false;
  private brush: BrushSettings | null = null;
  private mode: StrokeMode = "paint";
  private strokeLabel = "Brush"; // history label for the current stroke
  private clip: Rect[] | null = null;
  private clipAngle = 0;
  private clipPivot: { x: number; y: number } | null = null;
  /** A stroke inside a soft selection is masked through this each frame. */
  private softStrokeBuf: Layer | null = null;
  private col = { r: 0, g: 0, b: 0, a: 1 };
  // Pre-baked brush tip for the current stroke (rebuilt per beginStroke). Hard
  // tips are stamped crisp on the integer grid; soft tips at sub-pixel with
  // smoothing. Baking once avoids re-dithering a gradient on every stamp.
  private tip: HTMLCanvasElement | null = null;
  private tipHard = false;
  // Pen-pressure dynamics for the live stroke. Tips are baked ONE PER PRESSURE
  // BUCKET and cached for the stroke, so a pressure-varying stroke costs the
  // same per dab as a flat one and stays free of the per-stamp gradient dither
  // the baked-tip design exists to avoid. `tipSpec` is what a bucket's tip is
  // derived from; `pressFrom`/`pressTo` bracket the current segment so pressure
  // is interpolated between samples rather than stepping at each pointer event.
  private tipCache = new Map<number, HTMLCanvasElement>();
  // Tip shaping (brush-tip.ts). The DUAL TIP is baked into the cached tips —
  // one mask per variant, cycled per dab so the bristle pattern does not repeat
  // identically down the stroke. TEXTURE is applied at stamp time instead,
  // because it is anchored to the DOCUMENT: baking it into the tip would stamp
  // the same swatch over and over.
  private tipTexture: TextureSettings | null = null;
  private tipDual: DualTipSettings | null = null;
  private tipShape: TipShapeSettings | null = null;
  private tipScatter: ScatterSettings | null = null;
  /** Per-stroke generator, so a stroke's scatter is stable while it is drawn. */
  private scatterRng: (() => number) | null = null;
  /** Which bristle pattern this stroke is using (see DUAL_VARIANTS). */
  private dualVariant = 0;
  /** Scratch surfaces for the textured stamp path (allocated on first use). */
  private texDab: Layer | null = null;
  private texPatch: Layer | null = null;
  private tipSpec: { r: number; flow: number; hardness: number; cr: number; cg: number; cb: number } | null = null;
  private dyn: PressureDynamics = DEFAULT_DYNAMICS;
  private pressFrom = 1;
  private pressTo = 1;
  private last = { x: 0, y: 0 };
  private lastRaw = { x: 0, y: 0 };
  private smooth = { x: 0, y: 0 };
  private residual = 0;
  private step = 1;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  // Clone-stamp session. Reuses the brush stroke buffer/flow/opacity pipeline, but
  // each dab paints pixels sampled from `cloneSample` at (brushPoint + cloneOff)
  // instead of a solid colour. `cloneSample` is snapshotted at stroke start so the
  // clone never feeds back on itself mid-stroke.
  private cloneActive = false;
  private cloneSample: Layer | null = null;
  private cloneDab: Layer | null = null;
  private cloneOff: { x: number; y: number } | null = null;

  /** The live stroke's buffer — the engine's: it is sized with the document,
   *  remade by every resize, and read by the compositor while a stroke is live. */
  private get stroke(): Layer | null {
    return this.host.strokeBuf();
  }

  /** The view canvas, which a clone samples for "all layers". */
  private get view(): HTMLCanvasElement | null {
    return this.host.view();
  }

  // ---- A stroke, from its first dab to its last -----------------------------
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
    pressure = 1,
  ) {
    this.host.ensureOpBuffers();
    if (!this.stroke) return;
    this.host.layer(layerId); // ensure the target layer has a canvas so the live stroke composites
    this.painting = true;
    this.strokeLayer = layerId;
    this.strokeOnMask = this.host.activeSurface(layerId) === "mask"; // paint the mask when it's active
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
    this.tipSpec = { r, flow, hardness: brush.hardness, cr: c.r, cg: c.g, cb: c.b };
    this.dyn = brushDynamics(brush);
    // Only pay for shaping when it would change something (see tipShapingActive).
    const shaping = tipShapingActive(brush.texture, brush.dualTip);
    this.tipTexture = shaping && brush.texture?.enabled ? { ...brush.texture } : null;
    this.tipDual = shaping && brush.dualTip?.enabled ? { ...brush.dualTip } : null;
    this.tipShape = tipShapeActive(brush.tipShape) ? { ...brush.tipShape! } : null;
    this.tipScatter = scatterActive(brush.scatter) ? { ...brush.scatter! } : null;
    this.scatterRng = this.tipScatter ? makeRng((Math.random() * 0x7fffffff) | 0) : null;
    // One pattern for the whole stroke — see DUAL_VARIANTS for why per-dab
    // cycling produced a stroke indistinguishable from an ordinary brush.
    this.dualVariant = Math.floor(Math.random() * DUAL_VARIANTS);
    this.tipCache.clear();
    this.tip = this.tipFor(PRESSURE_BUCKETS); // full-pressure tip (what clone stamps use)
    this.pressFrom = clamp01(pressure);
    this.pressTo = this.pressFrom;
    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.step = Math.max(1, brush.size * 0.1);
    this.last = { x, y };
    this.lastRaw = { x, y };
    this.smooth = { x, y };
    this.residual = 0;
    this.dirty = null;
    this.stamp(x, y, this.pressFrom);
    this.residual = this.step;
    this.host.emitChange();
  }

  private dynActive(): boolean {
    return this.dyn.size || this.dyn.flow;
  }

  /** The tip DIAMETER at this pressure — scatter is expressed as a % of it, so
   *  a pressure-tapered stroke scatters proportionally rather than at a fixed
   *  width. */
  private tipDiameter(p: number): number {
    const base = this.brush?.size ?? 1;
    return this.dyn.size ? Math.max(1, base * pressureScale(p, this.dyn.min / 100)) : base;
  }

  /** Dab spacing at a given pressure. Spacing is a fraction of the tip DIAMETER,
   *  so when pressure narrows the tip the spacing has to narrow with it — else a
   *  light passage breaks into a row of beads. With size dynamics off this is
   *  exactly the spacing the session set (which is how the clone tool keeps its
   *  own configurable spacing). */
  private stepFor(p: number): number {
    if (!this.dyn.size) return this.step;
    return Math.max(1, this.step * pressureScale(p, this.dyn.min / 100));
  }

  /** The baked tip for one pressure bucket (built on first use, cached per stroke). */
  private tipFor(bucket: number, variant = 0): HTMLCanvasElement | null {
    const spec = this.tipSpec;
    if (!spec) return null;
    // One cache slot per (pressure bucket, bristle pattern). The pattern is
    // fixed for the stroke, so in practice this is one slot per bucket.
    const key = bucket * DUAL_VARIANTS + (this.tipDual ? variant % DUAL_VARIANTS : 0);
    const hit = this.tipCache.get(key);
    if (hit) return hit;
    const p = bucketPressure(bucket);
    const min = this.dyn.min / 100;
    const r = this.dyn.size ? Math.max(0.5, spec.r * pressureScale(p, min)) : spec.r;
    const flow = this.dyn.flow ? spec.flow * pressureScale(p, min) : spec.flow;
    const size = this.tipHard ? Math.max(1, Math.ceil(r * 2)) : Math.max(2, Math.ceil(r * 2) + 2);
    const mask = this.tipDual ? dualMask(size, r, this.tipDual, variant % DUAL_VARIANTS) : null;
    const tip = this.tipHard
      ? this.buildHardTip(r, spec.cr, spec.cg, spec.cb, flow, mask)
      : this.buildSoftTip(r, spec.cr, spec.cg, spec.cb, flow, spec.hardness, mask);
    this.tipCache.set(key, tip);
    return tip;
  }

  moveStroke(rawX: number, rawY: number, pressure = 1) {
    if (!this.painting || !this.brush) return;
    this.lastRaw = { x: rawX, y: rawY };
    this.pressTo = clamp01(pressure);
    const alpha = 1 - (this.brush.smoothing / 100) * 0.85;
    this.smooth.x += (rawX - this.smooth.x) * alpha;
    this.smooth.y += (rawY - this.smooth.y) * alpha;
    this.lineTo(this.smooth.x, this.smooth.y);
    this.pressFrom = this.pressTo;
    this.host.emitChange();
  }

  private lineTo(x: number, y: number) {
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const p0 = this.pressFrom;
    const dp = this.pressTo - p0;
    let d = this.residual;
    while (d <= dist) {
      const t = d / dist;
      // Pressure ramps across the segment, so a fast stroke between two widely
      // spaced samples still tapers smoothly instead of jumping a whole step.
      const p = p0 + dp * t;
      const bx = this.last.x + dx * t;
      const by = this.last.y + dy * t;
      if (this.tipScatter && this.scatterRng) {
        // Offsets come back in the stroke's own frame (along/across), so they
        // are rotated by the segment direction here: scatter is defined
        // relative to the stroke, not to the screen.
        const ux = dx / dist;
        const uy = dy / dist;
        for (const o of scatterOffsets(this.tipScatter, this.tipDiameter(p), this.scatterRng)) {
          this.stamp(bx + ux * o.along - uy * o.across, by + uy * o.along + ux * o.across, p);
        }
      } else {
        this.stamp(bx, by, p);
      }
      d += this.stepFor(p);
    }
    this.residual = d - dist;
    this.last = { x, y };
  }

  endStroke() {
    if (!this.painting || !this.brush || !this.stroke) return;
    this.lineTo(this.lastRaw.x, this.lastRaw.y);

    const layerId = this.strokeLayer!;
    const mid = this.host.maskKeyOf(layerId);
    const onMask = this.strokeOnMask && this.masks.has(mid);
    const target = onMask ? this.masks.get(mid)! : this.host.layer(layerId);
    const rect = this.dirtyRect();
    if (rect) {
      const before = target.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.drawStroke(target.ctx);
      const after = target.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.host.pushEntry(
        onMask ? mid : layerId,
        rect,
        before,
        after,
        onMask ? `Mask ${this.strokeLabel}` : this.strokeLabel,
        undefined,
        onMask ? "mask" : "layer",
      );
      if (onMask) this.host.deriveMaskAlpha(mid, rect); // refresh the alpha cache for the painted region
    }

    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.painting = false;
    this.strokeLayer = null;
    this.strokeOnMask = false;
    this.brush = null;
    this.clip = null;
    this.tip = null;
    this.tipSpec = null;
    this.tipCache.clear(); // per-stroke cache — the next stroke bakes fresh tips
    this.tipTexture = null;
    this.tipDual = null;
    this.tipShape = null;
    this.tipScatter = null;
    this.scatterRng = null;
    this.dirty = null;
    this.host.dropLiveProduct(); // a document-sized buffer; the next stroke reseeds
    if (this.cloneActive) {
      this.cloneActive = false;
      this.cloneSample = null;
      this.cloneDab = null;
      this.cloneOff = null;
    }
    this.host.emitChange();
  }

  /** Abandon the in-progress stroke WITHOUT committing it to the layer or the
   *  history — used when a gesture takes over (e.g. a second finger begins a
   *  pinch-zoom). Resets the same state endStroke() does, minus the bake. */
  cancelStroke() {
    if (!this.painting) return;
    this.stroke?.ctx.clearRect(0, 0, this.w, this.h);
    this.painting = false;
    this.strokeLayer = null;
    this.strokeOnMask = false;
    this.brush = null;
    this.clip = null;
    this.tip = null;
    this.tipSpec = null;
    this.tipCache.clear(); // per-stroke cache — the next stroke bakes fresh tips
    this.tipTexture = null;
    this.tipDual = null;
    this.dirty = null;
    this.host.dropLiveProduct();
    if (this.cloneActive) {
      this.cloneActive = false;
      this.cloneSample = null;
      this.cloneDab = null;
      this.cloneOff = null;
    }
    this.host.emitChange();
  }

  // ---- Its tips and dabs ----------------------------------------------------
  /** A crisp, aliased disc tip (no anti-aliasing, no feather). */
  private buildHardTip(
    r: number,
    cr: number,
    cg: number,
    cb: number,
    flow: number,
    /** Dual-tip coverage, size×size, multiplied into the dab's alpha. */
    mask: Float32Array | null = null,
  ): HTMLCanvasElement {
    const size = Math.max(1, Math.ceil(r * 2));
    const { c, ctx } = makeCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const center = size / 2;
    const rr = r * r;
    const a = Math.round(flow * 255);
    // An angled/squashed tip is the same disc measured in elliptical units, so
    // only the membership test changes — the long axis still spans r, which is
    // what keeps a stroke's width the same when roundness is turned down.
    const shape = this.tipShape;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px + 0.5 - center;
        const dy = py + 0.5 - center;
        const inside = shape
          ? tipRadius(dx, dy, r, shape.angle, shape.roundness) <= 1
          : dx * dx + dy * dy <= rr;
        if (inside) {
          const m = mask ? mask[py * size + px] : 1;
          if (m <= 0) continue;
          const i = (py * size + px) * 4;
          data[i] = cr;
          data[i + 1] = cg;
          data[i + 2] = cb;
          data[i + 3] = Math.round(a * m);
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
    /** Dual-tip coverage, size×size, multiplied into the dab's alpha. */
    mask: Float32Array | null = null,
  ): HTMLCanvasElement {
    const size = Math.max(2, Math.ceil(r * 2) + 2); // +1px each side for the rim
    const { c, ctx } = makeCanvas(size, size);
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const center = size / 2;
    const inner = Math.max(0, Math.min(0.999, hardness / 100)) * r; // solid core radius
    const span = Math.max(0.0001, r - inner);
    const shape = this.tipShape;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = px + 0.5 - center;
        const dy = py + 0.5 - center;
        // In elliptical units the rim sits at 1, so scaling back by r reuses the
        // existing core/rim profile unchanged — the falloff squashes with the
        // tip instead of needing an elliptical version of its own.
        const dist = shape ? tipRadius(dx, dy, r, shape.angle, shape.roundness) * r : Math.hypot(dx, dy);
        let a: number;
        if (dist <= inner) a = flow;
        else if (dist >= r) a = 0;
        else a = flow * (1 - (dist - inner) / span);
        if (mask) a *= mask[py * size + px];
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

  private stamp(x: number, y: number, pressure = 1) {
    if (this.cloneActive) {
      this.cloneStamp(x, y);
      return;
    }
    // Pick the tip baked for this pressure; with dynamics off every dab lands on
    // the top bucket, i.e. the single tip the stroke started with.
    const tip =
      this.dynActive() || this.tipDual
        ? this.tipFor(pressureBucket(pressure), this.dualVariant)
        : this.tip;
    if (!tip) return;
    const ctx = this.stroke!.ctx;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (this.tipTexture) {
      this.stampTextured(tip, x, y);
      return;
    }
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

  /**
   * Stamp a tip through the surface texture.
   *
   * The texture is evaluated at DOCUMENT coordinates for every pixel of the dab
   * rather than baked into the tip or tiled into a pattern. Baking it into the
   * tip would move the grain with the brush — the same swatch stamped over and
   * over, which reads as a rubber stamp. Tiling a fixed-size pattern would work
   * but seams wherever the (non-periodic) noise wraps. Evaluating per dab is
   * exact, and the cost is only paid when the option is switched on.
   *
   * Two scratch surfaces: the dab itself, and an alpha-only patch of texture
   * that is composited into it with `destination-in`. Building the patch by hand
   * avoids a `getImageData` read-back per dab.
   */
  private stampTextured(tip: HTMLCanvasElement, x: number, y: number) {
    const t = this.tipTexture!;
    const w = tip.width;
    const h = tip.height;
    const left = this.tipHard ? Math.round(x - w / 2) : Math.floor(x - w / 2);
    const top = this.tipHard ? Math.round(y - h / 2) : Math.floor(y - h / 2);
    if (!this.texDab || this.texDab.c.width < w || this.texDab.c.height < h) {
      this.texDab = this.host.mk(Math.max(w, 8), Math.max(h, 8), true);
      this.texPatch = this.host.mk(Math.max(w, 8), Math.max(h, 8), true);
    }
    const dab = this.texDab!;
    const patch = this.texPatch!;
    const img = patch.ctx.createImageData(w, h);
    const d = img.data;
    for (let py = 0; py < h; py++) {
      const gy = top + py;
      for (let px = 0; px < w; px++) {
        // Alpha-only: RGB is irrelevant under destination-in.
        d[(py * w + px) * 4 + 3] = Math.round(255 * textureAlpha(t, left + px, gy));
      }
    }
    patch.ctx.globalCompositeOperation = "copy";
    patch.ctx.putImageData(img, 0, 0);
    dab.ctx.globalCompositeOperation = "copy";
    dab.ctx.clearRect(0, 0, dab.c.width, dab.c.height);
    dab.ctx.globalCompositeOperation = "source-over";
    dab.ctx.imageSmoothingEnabled = false;
    dab.ctx.drawImage(tip, 0, 0);
    dab.ctx.globalCompositeOperation = "destination-in";
    dab.ctx.drawImage(patch.c, 0, 0, w, h, 0, 0, w, h);
    dab.ctx.globalCompositeOperation = "source-over";

    const ctx = this.stroke!.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(dab.c, 0, 0, w, h, left, top, w, h);
    this.expandDirty(left, top, left + w, top + h);
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

  dirtyRect() {
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

  // ---- Drawn onto a layer or a mask, through the selection ----------------
  /** Final alpha the whole stroke is composited at. Erasing ignores colour alpha. */
  private strokeAlpha() {
    const o = this.brush!.opacity / 100;
    return this.mode === "erase" ? o : o * this.col.a;
  }

  /** Composite op for stroke → layer: erase removes alpha, paint uses the blend mode. */
  private strokeComposite(): GlobalCompositeOperation {
    return this.mode === "erase" ? "destination-out" : blendOp(this.brush!.blend);
  }

  /** Draw the current stroke buffer onto a context, clipped to the selection. */
  drawStroke(ctx: CanvasRenderingContext2D) {
    ctx.save();
    let src: HTMLCanvasElement = this.stroke!.c;
    if (this.clip && this.host.coverageOf(this.clip)) {
      // A clip path is all-or-nothing; a soft selection masks the stroke instead.
      // The mask is memoized, so this is two blits a frame, not a rebuild.
      const m = this.host.selectionMask(this.clip, this.clipAngle, this.clipPivot);
      let buf = this.softStrokeBuf;
      if (!buf || buf.c.width !== this.w || buf.c.height !== this.h) {
        buf = this.softStrokeBuf = this.host.mk(this.w, this.h);
      }
      buf.ctx.globalCompositeOperation = "copy";
      buf.ctx.drawImage(src, 0, 0);
      buf.ctx.globalCompositeOperation = "destination-in";
      buf.ctx.drawImage(m, 0, 0);
      buf.ctx.globalCompositeOperation = "source-over";
      src = buf.c;
    } else {
      this.host.clipTo(ctx, this.clip, this.clipAngle, this.clipPivot);
    }
    ctx.globalAlpha = this.strokeAlpha();
    // On a transparency-locked layer, paint clips to the existing opacity live via
    // source-atop so the preview matches the alpha-frozen commit (freezeAlpha).
    // Erasing keeps its normal composite here; the commit still freezes its alpha.
    const transpLock =
      !this.strokeOnMask &&
      this.strokeLayer != null &&
      !!this.layerLocks.get(this.strokeLayer)?.transparency;
    ctx.globalCompositeOperation =
      transpLock && this.mode !== "erase" ? "source-atop" : this.strokeComposite();
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  // ---- Clone stamp: the same pipeline, painting sampled pixels -------------
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
    this.host.ensureOpBuffers();
    if (!this.stroke) return;
    this.host.layer(layerId);
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
    // Clone stamps a SAMPLED region through the tip, not the tip itself, so it
    // opts out of pressure dynamics (and keeps its own configurable spacing).
    this.dyn = NO_DYNAMICS;
    this.tipSpec = null;
    this.tipCache.clear();
    this.pressFrom = 1;
    this.pressTo = 1;
    // Snapshot the source so the clone reads a stable image, not its own output.
    const sample = this.host.mk(this.w, this.h, true);
    if (sampleAll && this.view) sample.ctx.drawImage(this.view, 0, 0);
    else sample.ctx.drawImage(this.host.layer(layerId).c, 0, 0);
    this.cloneSample = sample;
    this.cloneDab = this.host.mk(this.tip.width, this.tip.height, true);
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
    this.host.emitChange();
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
}
