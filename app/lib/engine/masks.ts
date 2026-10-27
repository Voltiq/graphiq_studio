// The engine's masks (TODO 1.6): layer masks, filter masks, saved selection
// channels and the quick mask — grayscale rasters in each document's `masks`,
// coverage rather than colour — with the alpha each derives for the
// compositor; which surface a paint op edits (pixels, a mask, or while Quick
// Mask is on, the quick mask); and a mask's lifecycle — made, freed, captured
// and restored for history, baked into its layer, moved, transformed, saved,
// shown in the Channels panel, made into a selection.
//
// The rasters live on each document (doc-state.ts); this works on the one in
// front through the cursor it shares with the engine. What it needs of the
// rest of the engine — the render graph told of a change, a layer's raster,
// the selection as a mask, the live stroke for the mask brush's preview —
// comes through `MaskHost`.

import { DocumentScoped, type DocCursor, type Layer } from "../doc-state";
import { filterMaskKey, type ActiveSurface } from "../layers";
import type { Rect } from "../view";
import { makeCanvas } from "./canvas";

/** What the masks need of the rest of the engine. */
export interface MaskHost {
  /** A mask changed (within `rect`): what its node renders is stale. */
  bumpMask(id: string, rect?: Rect): void;
  /** The document's content changed: repaint. */
  emitChange(): void;
  /** A layer's raster, made if it has none yet. */
  layer(id: string): Layer;
  /** A selection as a white-inside mask, and coverage as a selection. */
  selectionMask(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement;
  selectionFromCoverage(at: (i: number) => number): Rect[];
  /** The layer whose mask a live stroke is painting, if one is — the mask
   *  brush previews through it — and the stroke drawn onto a context. */
  maskStrokeLayer(): string | null;
  drawStroke(ctx: CanvasRenderingContext2D): void;
  dirtyRect(): { x: number; y: number; w: number; h: number } | null;
}

export class EngineMasks extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: MaskHost,
  ) {
    super(cursor);
  }

  // Reused buffers for the live mask-paint preview (grayscale + derived alpha).
  maskPrevG: Layer | null = null;
  private maskPrevA: Layer | null = null;
  // Mask VIEW mode (Alt-click a mask chip / Channels panel): while set, the
  // view canvas shows this mask's grayscale instead of the composite.
  maskView: { id: string; surface: "mask" | "filterMask" } | null = null;
  //
  // A quick mask is a grayscale raster in the SAME masks map as layer and filter
  // masks, so every paint tool, fill, blur and history path works on it with no
  // per-tool change — activeSurface()/maskKeyOf() below are the whole routing.
  // What makes it "quick" is that nothing composites it: the document renders
  // exactly as if the mask were not there, and the canvas paints the red overlay
  // from quickMaskCoverage(). Coverage means SELECTED (white = inside), matching
  // allocMask("selection"), so the overlay inverts it to shade what is masked.
  qmKey: string | null = null;

  /** Make a colour-agnostic (sRGB) buffer for mask data — masks are coverage,
   *  not colour, so they never participate in gamut conversion. */
  mkMask(readFreq = true): Layer {
    return makeCanvas(this.w, this.h, readFreq, "srgb");
  }

  // ---- Which surface a paint op edits ---------------------------------------
  /** The UI-facing surface of `id` — the selected surface, but only while its
   *  raster actually exists (a deleted mask falls back to pixels). */
  getActiveSurface(id: string): ActiveSurface {
    const s = this.surfaces.get(id);
    if (s === "mask" && this.masks.has(id)) return "mask";
    if (s === "filterMask" && this.masks.has(filterMaskKey(id))) return "filterMask";
    return "pixels";
  }

  /** Binary form for paint routing: EITHER mask kind ⇒ "mask" — the stroke /
   *  fill / blur pipelines treat the two identically and resolve which raster
   *  via maskKeyOf(). Quick Mask overrides it for EVERY layer: while it is on,
   *  every paint tool edits the quick mask instead of any layer's pixels. */
  activeSurface(id: string): "pixels" | "mask" {
    if (this.qmKey) return "mask";
    return this.getActiveSurface(id) === "pixels" ? "pixels" : "mask";
  }

  /** The masks-map key `id`'s current mask surface resolves to: the node id for
   *  the layer mask, `filterMaskKey(id)` for the filter mask. History entries for
   *  mask paint record THIS key as their layerId, so undo lands on the right raster. */
  maskKeyOf(id: string): string {
    if (this.qmKey) return this.qmKey; // Quick Mask claims every layer's strokes
    return this.surfaces.get(id) === "filterMask" ? filterMaskKey(id) : id;
  }

  setActiveSurface(id: string, surface: ActiveSurface): void {
    if (surface === "mask" && !this.masks.has(id)) return; // no mask to paint
    if (surface === "filterMask" && !this.masks.has(filterMaskKey(id))) return;
    this.surfaces.set(id, surface);
    this.host.emitChange();
  }

  // ---- The derived alpha, and what the compositor and the view are given ----
  /** Recompute the alpha cache from the grayscale mask, scoped to `rect` (whole
   *  mask if omitted): out.A = R × maskAlpha / 255, out.RGB = 0. Runs only on
   *  mask mutation, never per composite frame. */
  deriveMaskAlpha(id: string, rect?: Rect): void {
    const mask = this.masks.get(id);
    if (!mask) return;
    this.host.bumpMask(id, rect); // every mask mutation funnels through here
    let cache = this.maskAlpha.get(id);
    if (!cache || cache.c.width !== this.w || cache.c.height !== this.h) {
      cache = this.mkMask(false);
      this.maskAlpha.set(id, cache);
    }
    const r = rect ?? { x: 0, y: 0, w: this.w, h: this.h };
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(this.w, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(this.h, Math.ceil(r.y + r.h)) - y;
    if (w < 1 || h < 1) return;
    const img = mask.ctx.getImageData(x, y, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = (d[i] * d[i + 3]) / 255;
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    }
    cache.ctx.putImageData(img, x, y);
  }

  /** Alpha buffer to multiply into a layer/group when compositing. Returns the
   *  committed cache, or — while a mask stroke is live on this layer — a preview
   *  derived from (committed grayscale + in-progress stroke), bounded to the
   *  stroke's dirty rect so the mask brush previews live without a full re-derive. */
  maskDisplay(id: string): HTMLCanvasElement | null {
    // `id` here is a masks-map key: a node id (layer mask) or fm:<id> (filter
    // mask) — resolve the live stroke's target key so either previews live.
    const live = this.host.maskStrokeLayer();
    if (live && this.maskKeyOf(live) === id) {
      const mask = this.masks.get(id);
      if (mask) {
        if (!this.maskPrevG || this.maskPrevG.c.width !== this.w || this.maskPrevG.c.height !== this.h)
          this.maskPrevG = this.mkMask(true);
        if (!this.maskPrevA || this.maskPrevA.c.width !== this.w || this.maskPrevA.c.height !== this.h)
          this.maskPrevA = this.mkMask(false);
        const g = this.maskPrevG;
        g.ctx.globalAlpha = 1;
        g.ctx.globalCompositeOperation = "source-over";
        g.ctx.clearRect(0, 0, this.w, this.h);
        g.ctx.drawImage(mask.c, 0, 0);
        this.host.drawStroke(g.ctx); // live stroke onto the grayscale preview
        const a = this.maskPrevA;
        a.ctx.globalAlpha = 1;
        a.ctx.globalCompositeOperation = "source-over";
        a.ctx.clearRect(0, 0, this.w, this.h);
        const cache = this.maskAlpha.get(id);
        if (cache) a.ctx.drawImage(cache.c, 0, 0); // seed with committed alpha (GPU)
        const r = this.host.dirtyRect();
        if (r) {
          const img = g.ctx.getImageData(r.x, r.y, r.w, r.h);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            d[i + 3] = (d[i] * d[i + 3]) / 255;
            d[i] = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
          }
          a.ctx.putImageData(img, r.x, r.y);
        }
        return a.c;
      }
    }
    return this.maskAlpha.get(id)?.c ?? null;
  }

  /** True when `id` currently carries a mask. */
  hasMask(id: string): boolean {
    return this.masks.has(id);
  }

  /** Toggle the mask-view render mode (null = back to the normal composite). */
  setMaskView(id: string | null, surface: "mask" | "filterMask" = "mask") {
    this.maskView = id ? { id, surface } : null;
    this.host.emitChange();
  }

  /** Tonal distribution of a mask's effective grayscale (R×A/255); null = no mask. */
  maskHistogram(id: string, surface: "mask" | "filterMask" = "mask"): Uint32Array | null {
    const key = surface === "filterMask" ? filterMaskKey(id) : id;
    const mask = this.masks.get(key);
    if (!mask) return null;
    const out = new Uint32Array(256);
    const d = mask.ctx.getImageData(0, 0, this.w, this.h).data;
    for (let i = 0; i < d.length; i += 4) out[((d[i] * d[i + 3]) / 255) | 0]++;
    return out;
  }

  // ---- A mask's lifecycle (history is coordinated by the caller) -----------
  /** Allocate a grayscale mask for `id`: white (reveal-all), black (hide-all), or
   *  the current selection rasterized white-on-black. Derives the alpha cache. */
  allocMask(
    id: string,
    init: "reveal" | "hide" | "selection",
    rects: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): void {
    const m = this.mkMask(true);
    m.ctx.globalCompositeOperation = "source-over";
    if (init === "selection" && rects && rects.length) {
      m.ctx.fillStyle = "#000"; // hidden outside the selection
      m.ctx.fillRect(0, 0, this.w, this.h);
      m.ctx.drawImage(this.host.selectionMask(rects, angle, pivot), 0, 0); // white inside
    } else {
      m.ctx.fillStyle = init === "hide" ? "#000" : "#fff";
      m.ctx.fillRect(0, 0, this.w, this.h);
    }
    this.masks.set(id, m);
    this.deriveMaskAlpha(id);
    this.host.emitChange();
  }

  /** Free a mask + its alpha cache, resetting the active surface to pixels.
   *  Accepts either a node id (layer mask) or a filterMaskKey (filter mask). */
  freeMask(id: string): void {
    this.masks.delete(id);
    this.maskAlpha.delete(id);
    this.host.bumpMask(id); // the node's masked render changed
    if (this.surfaces.get(id) === "mask") this.surfaces.set(id, "pixels");
    if (id.startsWith("fm:")) {
      const base = id.slice(3);
      if (this.surfaces.get(base) === "filterMask") this.surfaces.set(base, "pixels");
    }
    this.host.emitChange();
  }

  /** Snapshot the grayscale mask (for history); null if the layer has no mask. */
  captureMask(id: string): ImageData | null {
    const m = this.masks.get(id);
    return m ? m.ctx.getImageData(0, 0, this.w, this.h) : null;
  }

  /** Recreate a mask from a grayscale snapshot and derive its alpha cache. */
  restoreMask(id: string, img: ImageData): void {
    const m = this.mkMask(true);
    m.ctx.putImageData(img, 0, 0);
    this.masks.set(id, m);
    this.deriveMaskAlpha(id);
    this.host.emitChange();
  }

  /** Bake an enabled mask into the layer's own alpha (destructive), then free it.
   *  The caller snapshots layer pixels + mask around this for one history step. */
  applyMaskToLayer(id: string): void {
    const cache = this.maskAlpha.get(id);
    const l = this.layers.get(id);
    if (cache && l) {
      l.ctx.globalCompositeOperation = "destination-in";
      l.ctx.drawImage(cache.c, 0, 0);
      l.ctx.globalCompositeOperation = "source-over";
    }
    this.freeMask(id);
  }

  /** Translate a mask's pixels by (dx,dy) for an unlinked mask move; re-derives. */
  offsetMask(id: string, dx: number, dy: number): void {
    const m = this.masks.get(id);
    if (!m || (dx === 0 && dy === 0)) return;
    const snap = m.ctx.getImageData(0, 0, this.w, this.h);
    m.ctx.globalCompositeOperation = "source-over";
    m.ctx.fillStyle = "#000";
    m.ctx.fillRect(0, 0, this.w, this.h); // vacated area = hidden
    m.ctx.putImageData(snap, Math.round(dx), Math.round(dy));
    this.deriveMaskAlpha(id);
    this.host.emitChange();
  }

  /** Re-make every owned mask through `fn` (which draws the old mask canvas into a
   *  fresh, current-doc-sized target ctx) and re-derive its alpha cache. Used by
   *  the resize / rotate / flip / crop paths so masks track their layers exactly.
   *  Callers must have set this.w/this.h to the new dimensions first. */
  transformMasks(
    ids: string[] | undefined,
    fn: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void,
  ): void {
    for (const [id, m] of this.masks) {
      // A filter mask (fm:<id>) is owned by its base layer — transform with it.
      const owner = id.startsWith("fm:") ? id.slice(3) : id;
      if (ids && !ids.includes(owner)) continue;
      const next = this.mkMask(true);
      fn(next.ctx, m.c);
      this.masks.set(id, next);
      this.deriveMaskAlpha(id);
    }
  }

  /** A layer's grayscale mask as a PNG data URL (null if it has no mask). */
  getMaskImage(id: string): string | null {
    const m = this.holderOf((d) => d.masks, id);
    return m ? m.c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getMaskImage` would encode — see getLayerImageCanvas. */
  getMaskImageCanvas(id: string): HTMLCanvasElement | null {
    return this.holderOf((d) => d.masks, id)?.c ?? null;
  }

  /** Restore a mask from a decoded image (project load) + derive its alpha. */
  setMaskImage(id: string, source: CanvasImageSource): void {
    const m = this.mkMask(true);
    m.ctx.drawImage(source, 0, 0);
    this.masks.set(id, m);
    this.deriveMaskAlpha(id);
    this.host.emitChange();
  }

  /** A small grayscale PNG of a mask, for the Channels panel's thumbnails.
   *  Null when the key holds no raster. Scaled on the GPU rather than by
   *  reading pixels back — a thumbnail is redrawn whenever the list re-renders. */
  maskPreviewURL(id: string, maxW = 48): string | null {
    const m = this.masks.get(id);
    if (!m) return null;
    const scale = Math.min(1, maxW / Math.max(1, this.w));
    const w = Math.max(1, Math.round(this.w * scale));
    const h = Math.max(1, Math.round(this.h * scale));
    const t = makeCanvas(w, h, false, "srgb");
    t.ctx.imageSmoothingEnabled = true;
    t.ctx.imageSmoothingQuality = "low";
    t.ctx.drawImage(m.c, 0, 0, w, h);
    try {
      return t.c.toDataURL("image/png");
    } catch {
      return null; // tainted canvas (shouldn't happen — masks are engine-made)
    }
  }

  /** Threshold a mask's coverage (≥ 50%) into run-length selection rects. */
  maskSelectionRects(id: string): Rect[] {
    const cache = this.maskAlpha.get(id);
    if (!cache) return [];
    const d = cache.ctx.getImageData(0, 0, this.w, this.h).data;
    return this.host.selectionFromCoverage((i) => d[i * 4 + 3]);
  }

  // ---- Quick Mask (TODO §3): what is above, on the document's own raster ----
  /** Is a quick mask live (and its raster still present)? */
  quickMaskActive(): boolean {
    return this.qmKey !== null && this.masks.has(this.qmKey);
  }

  /** Turn Quick Mask on for `key`, seeding coverage from the current selection.
   *
   *  No selection seeds it all-WHITE, not all-black: everywhere else in the app
   *  an empty selection means "the whole document is editable", so entering the
   *  mode with nothing selected has to start from everything selected — i.e. no
   *  red at all — and let the first black stroke carve the mask out. Seeding it
   *  black would open the mode with the entire canvas shaded, which reads as a
   *  bug and inverts what every subsequent stroke does. */
  enterQuickMask(
    key: string,
    rects: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): void {
    // Set the key FIRST: allocMask derives the alpha cache, and bumpMask has to
    // already know this raster is a quick mask so it skips composite invalidation.
    this.qmKey = key;
    this.allocMask(key, rects && rects.length ? "selection" : "reveal", rects, angle, pivot);
  }

  /** Point at an existing quick-mask raster, or off with null. Used by document
   *  switches and by undo/redo of the mode toggle — never allocates, so the
   *  painted coverage survives leaving and re-entering the mode. */
  setQuickMask(key: string | null): void {
    this.qmKey = key && this.masks.has(key) ? key : null;
    this.host.emitChange();
  }

  /** The selection the live quick mask describes (coverage ≥ 50%). */
  quickMaskRects(): Rect[] {
    return this.qmKey ? this.maskSelectionRects(this.qmKey) : [];
  }

  /** Coverage canvas for the red overlay (alpha = selected). Routes through
   *  maskDisplay so an IN-PROGRESS stroke shows immediately — without it the
   *  overlay would only catch up on pointer-up. */
  quickMaskCoverage(): HTMLCanvasElement | null {
    return this.qmKey ? this.maskDisplay(this.qmKey) : null;
  }
}
