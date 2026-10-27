// The engine's smart filters (TODO 1.6): a node's filter stack over its pixels,
// and the scheduling around it. A product is cached per node, keyed by what the
// node renders from; a miss with a stale product draws the stale one and has
// the worker refresh it (at half resolution while the params move on a big
// document, refined to full once they settle); a cold miss computes in line.
// A stroke on a filtered layer draws live frames: its own region re-filtered at
// full resolution into a copy of the settled product, or else a draft of the
// whole stack at a reduced scale.
//
// What they need of the rest of the engine — the node keys, the live set, the
// render cache, the mask a stack is confined by, the stroke under way — comes
// through `SmartFilterHost`.

import { DocumentScoped, type DocCursor, type Layer } from "../doc-state";
import { blendInto } from "../blend";
import { budgets } from "../budgets";
import { applyFilter, hasEnabledFilters, scaleFilterParams, type SmartFilter } from "../filters";
import { blendOp, filterMaskKey, findNode, type LayerLeaf, type LayerNode } from "../layers";
import { padRect, stackReach } from "../reach";

/** What the smart filters need of the rest of the engine. */
export interface SmartFilterHost {
  /** A raster in the working colour space. */
  mk(w: number, h: number, readFreq?: boolean): Layer;
  cs(): PredefinedColorSpace;
  /** What a node renders from: its product is current while the key matches. */
  nodeKey(node: LayerNode): string;
  /** `id` is in a cache every document shares (dropped with its document). */
  noteShared(id: string): void;
  /** A product landed late: the frames drawn meanwhile cached it stale. */
  clearRenderCaches(): void;
  emitChange(): void;
  /** A mask as it displays — painting it previews live. */
  maskDisplay(id: string): HTMLCanvasElement | null;
  /** A node's own pixels: a fill layer's from its spec, else the layer's display. */
  renderFill(node: LayerLeaf): HTMLCanvasElement;
  leafDisplay(id: string): HTMLCanvasElement | null;
  /** The tree last composited. */
  curTree(): LayerNode[] | null;
  /** The layers live this frame (and their groups), the render cache's switch,
   *  an export under way, and background compute's. */
  liveBypass(): ReadonlySet<string>;
  renderCacheOn(): boolean;
  exporting(): boolean;
  workersOn(): boolean;
  /** The brush stroke under way: whether, on which layer, on its mask, and
   *  where it has painted. */
  painting(): boolean;
  strokeLayer(): string | null;
  strokeOnMask(): boolean;
  dirtyRect(): { x: number; y: number; w: number; h: number } | null;
  /** A draft frame reached the view: the next settled one repaints it all. */
  markDraftPainted(): void;
}

export class EngineSmartFilters extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: SmartFilterHost,
  ) {
    super(cursor);
  }

  // The same two questions for the LIVE half: how many draft frames the region
  // path took over, how many pixels it filtered, and how many FILTER frames still
  // fell through to a full-document draft (the effects draft is separate and not
  // counted here). A stroke that reports 0 region frames proves the path never
  // ran, whatever the pixels look like.
  liveRegionHits = 0;
  liveRegionPx = 0;
  liveDraftFrames = 0;
  private liveRegionOn = true; // dev A/B (window.__gqRenderCache.regionOff())
  /** Per-stroke full-resolution filter product: a copy of the settled one, with
   *  the stroke's own region re-filtered into it each frame. */
  liveProduct: (Layer & { id: string; key: string }) | null = null;

  // ---- Smart-filter worker (stale-while-refresh product cache) ---------------
  // A node's filtered pixels are cached per node id, keyed by its nodeKey. On a
  // key miss WITH a stale product available, the recompute runs in the worker
  // while the stale product draws this frame — so param drags stay fluid; the
  // fresh result lands via onFilterWorkerMessage and triggers a recomposite.
  private filterWorker: Worker | null = null;
  private filterWorkerBroken = false;
  private filterJobSeq = 0;
  filterWorkerResults = 0;
  /** Per-node newest in-flight job (older replies are dropped). */
  filterPending = new Map<
    string,
    { seq: number; key: string; quality: "preview" | "full"; docW: number; docH: number }
  >();
  filteredCache = new Map<
    string,
    { key: string; canvas: HTMLCanvasElement; quality: "preview" | "full" }
  >();

  /** Progressive preview kicks in above this many document pixels — below it a
   *  half-res pass saves nothing worth the resample. */
  private static PREVIEW_MIN_PIXELS = 2_000_000;

  /** The engine's state these read as they did: the colour space, the live
   *  set, the render cache's switch, an export, background compute, the tree. */
  private get cs(): PredefinedColorSpace {
    return this.host.cs();
  }
  private get liveBypass(): ReadonlySet<string> {
    return this.host.liveBypass();
  }
  private get renderCacheOn(): boolean {
    return this.host.renderCacheOn();
  }
  private get exporting(): boolean {
    return this.host.exporting();
  }
  private get workersOn(): boolean {
    return this.host.workersOn();
  }
  private get curTree(): LayerNode[] | null {
    return this.host.curTree();
  }
  /** The brush stroke under way. */
  private get painting(): boolean {
    return this.host.painting();
  }
  private get strokeLayer(): string | null {
    return this.host.strokeLayer();
  }
  private get strokeOnMask(): boolean {
    return this.host.strokeOnMask();
  }

  /** Debug A/B toggle: off sends every live filter frame back through the
   *  full-document draft, so the two arms can be measured in one sitting
   *  (absolute wall-clock does not travel between runs on this machine). */
  setLiveRegionEnabled(on: boolean) {
    this.liveRegionOn = on;
    this.liveProduct = null;
  }

  /**
   * Debug: compare a node's CACHED filter product (computed by the worker)
   * against the same stack computed inline by `renderFiltered`, pixel for pixel.
   *
   * The two are supposed to be interchangeable — that is the entire premise of
   * handing the settled pass to a worker — but nothing checked it until a live
   * region frame seeded from a cached product and inherited a discrepancy. Diffing
   * whole composites cannot localise that: it drags in every group merge,
   * adjustment and blend on the way to the canvas. This compares the products
   * themselves and nothing else.
   *
   * Returns null when there is no cached product to compare against.
   */
  compareFilterProduct(id?: string): {
    differing: number;
    worst: number;
    channels: [number, number, number, number];
    total: number;
    quality: "preview" | "full";
    /** Checksum of the inline product, so a caller can prove a configuration
     *  change actually reached the pixels rather than comparing two identical
     *  renders and calling the agreement meaningful. */
    digest: number;
    sample: {
      at: number;
      cached: number[];
      inline: number[];
      preFilter: number[];
      postFilter: number[];
      opacity: number;
      blendMode: string;
    } | null;
  } | null {
    const pick = (nodes: LayerNode[]): LayerNode | null => {
      for (const n of nodes) {
        if (n.type === "group") {
          const hit = pick(n.children);
          if (hit) return hit;
        } else if (n.type === "layer" && hasEnabledFilters(n.filters)) return n;
      }
      return null;
    };
    const node = !this.curTree ? null : id ? findNode(this.curTree, id) : pick(this.curTree);
    if (!node || node.type !== "layer" || !hasEnabledFilters(node.filters)) return null;
    id = node.id;
    const ent = this.filteredCache.get(id);
    if (!ent || ent.canvas.width !== this.w || ent.canvas.height !== this.h) return null;
    // A product whose key has moved on is simply STALE — a worker job is still in
    // flight. Comparing it would report a huge difference that says nothing about
    // whether the two paths agree, so say "not ready" and let the caller wait.
    if (ent.key !== this.host.nodeKey(node)) return null;
    const src = node.fill ? this.host.renderFill(node) : this.host.leafDisplay(id);
    if (!src) return null;
    // The stack's INPUT and its post-filter pixels, so a caller can do the blend
    // arithmetic by hand and say which of the two paths rounded it differently.
    const pre = this.host.mk(this.w, this.h, true);
    pre.ctx.drawImage(src, 0, 0);
    const preData = pre.ctx.getImageData(0, 0, this.w, this.h);
    const first = node.filters!.find((f) => f.enabled)!;
    const postData = applyFilter(preData, first, this.cs);
    const inline = this.renderFiltered(src, node.filters!, this.filterMaskAlpha(node));
    const a = ent.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, this.w, this.h).data;
    const b = inline.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, this.w, this.h).data;
    const channels: [number, number, number, number] = [0, 0, 0, 0];
    let differing = 0;
    let worst = 0;
    let sample: {
      at: number;
      cached: number[];
      inline: number[];
      preFilter: number[];
      postFilter: number[];
      opacity: number;
      blendMode: string;
    } | null = null;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (!d) continue;
      differing++;
      channels[i & 3]++;
      if (d > worst) worst = d;
      if (!sample) {
        const px = (i >> 2) * 4;
        sample = {
          at: i >> 2,
          cached: [a[px], a[px + 1], a[px + 2], a[px + 3]],
          inline: [b[px], b[px + 1], b[px + 2], b[px + 3]],
          preFilter: [preData.data[px], preData.data[px + 1], preData.data[px + 2], preData.data[px + 3]],
          postFilter: [postData.data[px], postData.data[px + 1], postData.data[px + 2], postData.data[px + 3]],
          opacity: first.opacity,
          blendMode: first.blendMode,
        };
      }
    }
    let digest = 0;
    for (let i = 0; i < b.length; i += 4) digest = (digest * 31 + b[i] * 7 + b[i + 1] * 5 + b[i + 2] * 3 + b[i + 3]) >>> 0;
    return { differing, worst, channels, total: a.length, quality: ent.quality, digest, sample };
  }

  /** Smart filters (Spec 07): run a node's enabled filter stack over `src`
   *  (its raw pixels / merged group buffer), each filter blended back over the
   *  pre-filter result with its own blend mode + opacity. Returns a fresh
   *  layer-sized canvas; the node's stored pixels are never touched. Only
   *  reached on a render-cache miss — the product is cached by renderNode. */
  renderFiltered(
    src: HTMLCanvasElement,
    filters: SmartFilter[],
    fmAlpha: HTMLCanvasElement | null = null,
  ): HTMLCanvasElement {
    const out = this.host.mk(this.w, this.h, true);
    out.ctx.drawImage(src, 0, 0);
    const cur = this.filterStack(
      out.ctx.getImageData(0, 0, this.w, this.h),
      filters,
      fmAlpha ? () => fmAlpha.getContext("2d")!.getImageData(0, 0, this.w, this.h).data : null,
    );
    out.ctx.putImageData(cur, 0, 0);
    return out.c;
  }

  /**
   * Run an enabled filter stack over the top-left `w`×`h` of `buf`, which already
   * holds the source pixels, and return the result. The caller decides where it
   * lands, which is what lets the same code serve a whole document and a single
   * region of one.
   *
   * `fm` is called LAZILY so a stack that turns out to be a no-op never pays for
   * a filter-mask readback it will not use.
   *
   * Both the full-canvas path and the live region path route through here on
   * purpose: the premultiplied mask interpolation at the bottom is subtle enough
   * that two copies of it would eventually disagree.
   */
  private filterStack(
    input: ImageData,
    filters: SmartFilter[],
    fm: (() => Uint8ClampedArray) | null,
  ): ImageData {
    let cur = input;
    const base = fm ? cur : null; // pristine pixels; never mutated by the loop below
    for (const f of filters) {
      if (!f.enabled) continue;
      const applied = applyFilter(cur, f, this.cs);
      const op = blendOp(f.blendMode);
      const alpha = Math.max(0, Math.min(1, f.opacity / 100));
      if (op === "source-over" && alpha >= 1) {
        cur = applied; // the common case: full replace
        continue;
      }
      // Blend the filtered result back over the pre-filter pixels, in exact
      // arithmetic rather than through a canvas — see app/lib/blend.ts for why
      // the canvas is not trustworthy here. `applied` is always a fresh buffer
      // out of applyFilter, so it is safe to blend into (`cur` is not: `base`
      // aliases it).
      blendInto(applied.data, cur.data, applied.data, op, alpha);
      cur = applied;
    }
    // Filter mask: confine the WHOLE stack — result = orig + (filtered − orig) ×
    // mask, interpolated premultiplied so partially-covered edge pixels don't
    // tint. The mask alpha lives in the fm buffer's A channel (the derived cache).
    if (base && cur !== base) {
      const m = fm!();
      const a = base.data;
      const b = cur.data;
      for (let i = 0; i < b.length; i += 4) {
        const t = m[i + 3] / 255;
        if (t >= 1) continue; // fully filtered — the common (white) case
        const aa = a[i + 3];
        const ba = b[i + 3];
        const na = aa + (ba - aa) * t;
        const inv = na > 0 ? 1 / na : 0;
        b[i] = (a[i] * aa * (1 - t) + b[i] * ba * t) * inv;
        b[i + 1] = (a[i + 1] * aa * (1 - t) + b[i + 1] * ba * t) * inv;
        b[i + 2] = (a[i + 2] * aa * (1 - t) + b[i + 2] * ba * t) * inv;
        b[i + 3] = na;
      }
    }
    return cur;
  }

  /** The alpha buffer confining a node's smart-filter stack (null = unmasked).
   *  Routed through maskDisplay so painting the filter mask previews live. */
  private filterMaskAlpha(node: LayerNode): HTMLCanvasElement | null {
    return node.filterMask?.enabled ? this.host.maskDisplay(filterMaskKey(node.id)) : null;
  }

  private ensureFilterWorker(): Worker | null {
    if (!this.workersOn || this.filterWorkerBroken) return null;
    if (this.filterWorker) return this.filterWorker;
    if (typeof Worker === "undefined") {
      this.filterWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../../workers/filters.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e) => this.onFilterWorkerMessage(e);
      w.onerror = () => {
        // Permanent sync fallback: pending stale frames self-heal because the
        // next composite misses the product cache and recomputes in-line.
        this.filterWorkerBroken = true;
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
        this.filterWorker = null;
        this.filterPending.clear();
        this.host.clearRenderCaches();
        this.host.emitChange();
      };
      this.filterWorker = w;
      return w;
    } catch {
      this.filterWorkerBroken = true;
      return null;
    }
  }

  private onFilterWorkerMessage(
    e: MessageEvent<{ id: number; nodeId: string; key: string; w: number; h: number; data: ArrayBuffer }>,
  ) {
    const { id, nodeId, key, w, h, data } = e.data;
    const pend = this.filterPending.get(nodeId);
    if (!pend || pend.seq !== id) return; // superseded by a newer job
    this.filterPending.delete(nodeId);
    if (pend.docW !== this.w || pend.docH !== this.h) return; // reframed mid-flight
    const bytes = new Uint8ClampedArray(data);
    let img: ImageData;
    try {
      img = new ImageData(bytes, w, h, { colorSpace: this.cs });
    } catch {
      img = new ImageData(bytes, w, h);
    }
    let out: HTMLCanvasElement;
    if (w === this.w && h === this.h) {
      const cv = this.host.mk(w, h);
      cv.ctx.putImageData(img, 0, 0);
      out = cv.c;
    } else {
      // Half-res preview → upscale to document size so consumers stay agnostic.
      const small = this.host.mk(w, h);
      small.ctx.putImageData(img, 0, 0);
      const cv = this.host.mk(this.w, this.h);
      cv.ctx.imageSmoothingEnabled = true;
      cv.ctx.imageSmoothingQuality = "high";
      cv.ctx.drawImage(small.c, 0, 0, w, h, 0, 0, this.w, this.h);
      out = cv.c;
    }
    this.storeFiltered(nodeId, key, out, pend.quality);
    this.filterWorkerResults++;
    // Frames composited while this was in flight cached STALE products under
    // fresh keys (the node itself, its ancestors, clip groups, adjustment
    // accumulators — tiled ones included). One cache clear is the safe, cheap
    // invalidation — the expensive part (the filter product) is warm in
    // filteredCache.
    this.host.clearRenderCaches();
    this.host.emitChange();
  }

  private storeFiltered(id: string, key: string, canvas: HTMLCanvasElement, quality: "preview" | "full") {
    this.filteredCache.delete(id); // re-insert to refresh Map order (LRU-ish)
    this.filteredCache.set(id, { key, canvas, quality });
    this.host.noteShared(id);
    while (this.filteredCache.size > 8) {
      const oldest = this.filteredCache.keys().next().value;
      if (oldest === undefined) break;
      this.filteredCache.delete(oldest);
    }
  }

  /** Queue an async recompute of `node`'s filter stack (true = queued/running).
   *  `quality: "preview"` runs at half resolution — ¼ the pixels AND ¼ the
   *  main-thread readback (the source downscales on the GPU before the read);
   *  spatial filter params scale with it so the look matches full res. */
  private kickFilterJob(
    node: LayerNode,
    src: HTMLCanvasElement,
    key: string,
    quality: "preview" | "full",
  ): boolean {
    const w = this.ensureFilterWorker();
    if (!w) return false;
    const pend = this.filterPending.get(node.id);
    // Same state already queued at this quality (or better) → nothing to do.
    if (pend && pend.key === key && (pend.quality === "full" || pend.quality === quality))
      return true;
    const scale = quality === "preview" ? 0.5 : 1;
    const sw = Math.max(1, Math.round(this.w * scale));
    const sh = Math.max(1, Math.round(this.h * scale));
    const seq = ++this.filterJobSeq;
    this.filterPending.set(node.id, { seq, key, quality, docW: this.w, docH: this.h });
    this.host.noteShared(node.id);
    const readScaled = (source: HTMLCanvasElement): ImageData => {
      if (scale === 1) return source.getContext("2d")!.getImageData(0, 0, this.w, this.h);
      const small = this.host.mk(sw, sh, true);
      small.ctx.imageSmoothingEnabled = true;
      small.ctx.imageSmoothingQuality = "high";
      small.ctx.drawImage(source, 0, 0, this.w, this.h, 0, 0, sw, sh);
      return small.ctx.getImageData(0, 0, sw, sh);
    };
    const img = readScaled(src);
    const transfers: ArrayBuffer[] = [img.data.buffer];
    let fm: ArrayBuffer | null = null;
    const fmCanvas = this.filterMaskAlpha(node);
    if (fmCanvas) {
      const fmImg = readScaled(fmCanvas as HTMLCanvasElement);
      fm = fmImg.data.buffer;
      transfers.push(fm);
    }
    const filters =
      scale === 1 ? node.filters : node.filters!.map((f) => (f.enabled ? scaleFilterParams(f, scale) : f));
    w.postMessage(
      { id: seq, nodeId: node.id, key, w: sw, h: sh, cs: this.cs, src: img.data.buffer, fm, filters },
      transfers,
    );
    return true;
  }

  /** The node's filtered pixels via the product cache: hit → cached canvas;
   *  miss with a stale product → async worker refresh (HALF-RES during drags on
   *  large documents; the stale product draws this frame); a hit on a
   *  half-res product means the params settled → quietly refine to full res.
   *  Cold, live-session, or cache-disabled → synchronous compute, as before. */
  filteredProduct(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    // Cache-disabled covers the A/B toggle AND clean exports — both must never
    // see a half-res preview product.
    const live = this.liveBypass.has(node.id) || !this.renderCacheOn;
    if (!live) {
      const key = this.host.nodeKey(node);
      const ent = this.filteredCache.get(node.id);
      if (ent && ent.key === key && ent.quality === "full") return ent.canvas;
      if (!this.exporting) {
        if (ent && ent.key === key) {
          // Settled on a preview → refine to full res in the background.
          this.kickFilterJob(node, src, key, "full");
          return ent.canvas;
        }
        if (ent) {
          const quality =
            this.w * this.h >= EngineSmartFilters.PREVIEW_MIN_PIXELS ? ("preview" as const) : ("full" as const);
          if (this.kickFilterJob(node, src, key, quality)) return ent.canvas; // stale + refresh
        }
      }
      const out = this.renderFiltered(src, node.filters!, this.filterMaskAlpha(node));
      this.storeFiltered(node.id, key, out, "full");
      return out;
    }
    // A live paint/move session mutates `src` without version bumps — the key
    // can't see those changes, so always compute in-line and never cache.
    //
    // In-line means SYNCHRONOUS and on the main thread: measured at ~190–250 ms
    // per frame for one gaussian blur on a 1920×1080 document, which is why a
    // brush stroke or a selection drag on a filtered layer blocked for seconds
    // (≈3.9 s of long tasks over a 20-step stroke). The worker is no help here —
    // it keys jobs by node key, and a live source has no key that describes it.
    //
    // So the live frames run at DRAFT resolution instead. Not a cache and not a
    // stale product: a real filter pass over fewer pixels, with spatial params
    // scaled to match, upscaled to document size. The moment the session ends
    // the normal path resumes and recomputes at full resolution.
    if (this.liveBypass.has(node.id) && !this.exporting) {
      // Better than a draft when it applies: the same kernel over the stroke's
      // own rect, at FULL resolution, patched into the settled product.
      const region = this.liveFilterRegion(node, src);
      if (region) return region;
      const draft = this.draftScale();
      if (draft < 1) {
        this.liveDraftFrames++;
        return this.renderFilteredDraft(src, node, draft);
      }
    }
    return this.renderFiltered(src, node.filters!, this.filterMaskAlpha(node));
  }

  /**
   * A live filter frame that re-filters only the stroke's dirty rect at FULL
   * resolution, patched into a per-session copy of the settled product.
   *
   * WHAT IT REPLACES. renderFilteredDraft runs the stack over the whole document
   * at quarter resolution. Measured on a 12 MP document carrying one gaussian
   * blur, that is 58.6 ms a frame — 52.5 ms of it inside applyFilter over 750k
   * draft pixels — and it accounted for 100% of the ~1.2 s a five-stroke session
   * blocked. A stroke touches a few hundred pixels square, so filtering the dirty
   * rect instead is both far cheaper AND full quality: the draft's downscale /
   * upscale softness disappears from the preview.
   *
   * THE TWO RECTS, exactly as repaintRegion:
   *   OUT — the dirty rect grown by the stack's reach. Nothing further out can
   *     have changed, so the seeded product is still right there.
   *   IN  — OUT grown by the reach again: every input pixel that can influence
   *     OUT. The IN border is computed without ITS neighbours and is discarded.
   *
   * THE SEED. There is no cache to patch into during a live session (liveBypass
   * deliberately holds none), so the session copies the settled product out of
   * filteredCache once per stroke. That is only sound because the product's key
   * still describes the layer: pixelVersion does not move until endStroke bakes
   * the stroke, so the pre-stroke key IS the current key. Anything else — a
   * half-res product, a stale key, a resized document — declines.
   *
   * Returns null rather than guessing whenever it cannot prove the frame would
   * match a full pass; the caller then takes the draft, as before.
   */
  private liveFilterRegion(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement | null {
    if (!this.liveRegionOn) return null;
    // The render-cache A/B toggle promises that "off" uses no cached product at
    // all. This path seeds from one, so it has to honour that too — otherwise
    // the always-correct reference the rails diff against would quietly stop
    // being always-correct.
    if (!this.renderCacheOn) return null;
    // A brush stroke is the only live session that tracks a dirty rect, and only
    // a PIXEL stroke changes what the filters read — a mask stroke leaves the
    // layer's pixels alone and previews through maskDisplay instead.
    if (!this.painting || this.strokeOnMask || this.strokeLayer !== node.id) return null;
    const dirty = this.host.dirtyRect();
    if (!dirty) return null;
    const reach = stackReach(node.filters);
    if (reach === null) return null; // unbounded or position-dependent
    const out = padRect(dirty, reach, this.w, this.h);
    const inn = padRect(out, reach, this.w, this.h);
    if (out.w <= 0 || out.h <= 0 || inn.w <= 0 || inn.h <= 0) return null;
    // The alternative here is the DRAFT, not a full pass, so the test is against
    // the draft's pixel count — regionWorthIt's "share of the document" would
    // happily accept a region twelve times the draft's size. Ties go to the
    // region: same pixels, better picture.
    const draft = this.draftScale();
    const draftPx =
      Math.max(1, Math.round(this.w * draft)) * Math.max(1, Math.round(this.h * draft));
    if (inn.w * inn.h > draftPx) return null;

    const key = this.host.nodeKey(node);
    let prod = this.liveProduct;
    if (!prod || prod.c.width !== this.w || prod.c.height !== this.h) {
      prod = this.liveProduct = { ...this.host.mk(this.w, this.h), id: "", key: "" };
    }
    if (prod.id !== node.id || prod.key !== key) {
      const ent = this.filteredCache.get(node.id);
      // "full" only: patching sharp full-res pixels into an upscaled half-res
      // product would leave a visible seam around the stroke.
      if (!ent || ent.key !== key || ent.quality !== "full") return null;
      if (ent.canvas.width !== this.w || ent.canvas.height !== this.h) return null;
      prod.ctx.globalAlpha = 1;
      prod.ctx.globalCompositeOperation = "source-over";
      prod.ctx.clearRect(0, 0, this.w, this.h);
      prod.ctx.drawImage(ent.canvas, 0, 0);
      prod.id = node.id;
      prod.key = key;
    }

    /* Pixels in and out by getImageData / putImageData — exactly as the full
       pass reads and writes them, so the two agree by construction, on any
       rasterizer. This used to copy sub-rects through canvases (drawImage with a
       source rect, in and out, and the filter mask likewise), which the full
       pass never does. Windows reproduced the full pass to the byte that way;
       Linux's software raster did not: 1-level rounding on opaque pixels over
       the stroke's blur footprint, and Δ79 through a painted filter mask —
       found only once CI could say which pixels and what values. */
    const fmFull = this.filterMaskAlpha(node);
    const cur = this.filterStack(
      (src.getContext("2d") as CanvasRenderingContext2D).getImageData(inn.x, inn.y, inn.w, inn.h),
      node.filters!,
      fmFull ? () => fmFull.getContext("2d")!.getImageData(inn.x, inn.y, inn.w, inn.h).data : null,
    );

    // REPLACE, never blend: the region carries its own alpha. putImageData's
    // dirty rect writes just OUT, and writes it rather than compositing it.
    prod.ctx.putImageData(cur, inn.x, inn.y, out.x - inn.x, out.y - inn.y, out.w, out.h);
    this.liveRegionHits++;
    this.liveRegionPx += inn.w * inn.h;
    return prod.c;
  }

  /** Working scale for live filter frames: enough of a reduction to keep the
   *  pass under a per-frame pixel budget, never below a quarter (past that the
   *  preview stops resembling the result). 1 = compute at full size.
   *
   *  Public because it is the only way to observe that the pixel budget is
   *  actually being APPLIED. A harness can read the derived budget easily
   *  enough; that it reaches the engine is a separate claim, and a mutation
   *  that reverted the budget to its desktop constant went undetected until
   *  this was checkable. */
  draftScale(): number {
    const px = this.w * this.h;
    if (px <= EngineSmartFilters.DRAFT_MAX_PIXELS) return 1;
    return Math.max(0.25, Math.sqrt(EngineSmartFilters.DRAFT_MAX_PIXELS / px));
  }

  /** Pixel budget for one live filter frame. A gaussian blur runs at roughly
   *  100 MP/s here, so ~0.5 MP keeps a frame near 5 ms rather than 200 — on a
   *  desktop. That figure was measured on one, and a phone does not run this
   *  stack at the same rate, so the budget comes from the device rather than
   *  from a constant. `budgets()` returns 500_000 on a desktop, so nothing
   *  changes there. */
  private static get DRAFT_MAX_PIXELS(): number {
    return budgets().draftPixels;
  }

  /**
   * Run the filter stack at `scale` and upscale the result to document size.
   *
   * `scaleFilterParams` shrinks the spatial params with the source (a radius of
   * 8 over half as many pixels has to become 4 or the preview blurs twice as
   * hard), which is the same contract the progressive half-res preview already
   * relies on. The filter mask downsamples alongside so it still confines the
   * same region.
   */
  private renderFilteredDraft(
    src: HTMLCanvasElement,
    node: LayerNode,
    scale: number,
  ): HTMLCanvasElement {
    this.host.markDraftPainted(); // the settled frame must repaint the whole view
    const sw = Math.max(1, Math.round(this.w * scale));
    const sh = Math.max(1, Math.round(this.h * scale));

    // Downscale the source (GPU) — the readback below is then ¼-or-less the work.
    const small = this.host.mk(sw, sh, true);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = "low"; // a draft frame; "high" costs more than it shows
    small.ctx.drawImage(src, 0, 0, sw, sh);

    let cur = small.ctx.getImageData(0, 0, sw, sh);
    const fmFull = this.filterMaskAlpha(node);
    let base: ImageData | null = null;
    let maskData: Uint8ClampedArray | null = null;
    if (fmFull) {
      base = new ImageData(new Uint8ClampedArray(cur.data), sw, sh);
      const m = this.host.mk(sw, sh, true);
      m.ctx.imageSmoothingEnabled = true;
      m.ctx.drawImage(fmFull, 0, 0, sw, sh);
      maskData = m.ctx.getImageData(0, 0, sw, sh).data;
    }
    for (const f of node.filters ?? []) {
      if (!f.enabled) continue;
      const applied = applyFilter(cur, scaleFilterParams(f, scale), this.cs);
      const op = blendOp(f.blendMode);
      const alpha = Math.max(0, Math.min(1, f.opacity / 100));
      if (op === "source-over" && alpha >= 1) {
        cur = applied; // the common case: full replace
        continue;
      }
      // Same per-filter blend/opacity the full path applies, at draft size — a
      // filter set to 40% Overlay must not preview as a full replacement.
      small.ctx.putImageData(cur, 0, 0);
      const tmp = this.host.mk(sw, sh);
      tmp.ctx.putImageData(applied, 0, 0);
      small.ctx.globalAlpha = alpha;
      small.ctx.globalCompositeOperation = op;
      small.ctx.drawImage(tmp.c, 0, 0);
      small.ctx.globalAlpha = 1;
      small.ctx.globalCompositeOperation = "source-over";
      cur = small.ctx.getImageData(0, 0, sw, sh);
    }
    if (base && maskData) {
      const aD = base.data;
      const bD = cur.data;
      for (let i = 0; i < bD.length; i += 4) {
        const t = maskData[i + 3] / 255;
        if (t >= 1) continue;
        const aa = aD[i + 3];
        const ba = bD[i + 3];
        const na = aa + (ba - aa) * t;
        const inv = na > 0 ? 1 / na : 0;
        bD[i] = (aD[i] * aa * (1 - t) + bD[i] * ba * t) * inv;
        bD[i + 1] = (aD[i + 1] * aa * (1 - t) + bD[i + 1] * ba * t) * inv;
        bD[i + 2] = (aD[i + 2] * aa * (1 - t) + bD[i + 2] * ba * t) * inv;
        bD[i + 3] = na;
      }
    }
    small.ctx.putImageData(cur, 0, 0);

    const out = this.host.mk(this.w, this.h);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = "high"; // the upscale IS what the user sees
    out.ctx.drawImage(small.c, 0, 0, sw, sh, 0, 0, this.w, this.h);
    return out.c;
  }
}
