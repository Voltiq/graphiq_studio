// The engine's Blur Gallery (TODO 1.6): Effects ▸ Blur Gallery as a session
// over the chosen layers — their pixels as they began and the selection as a
// mask kept, the preview rendered from those, off the main thread when a worker
// is there (each render sequence-numbered, each session numbered, so a reply
// that arrives late is dropped) and in line when not; the commit is one step
// whose undo and redo swap the pixels, the cancel puts them back.
//
// What it needs of the rest of the engine — the layers, the selection as a
// mask, the step, the live sessions it ends — comes through `BlurGalleryHost`.

import { DocumentScoped, type DocCursor, type Layer } from "../doc-state";
import { computeBlurFx } from "../filters";
import type { Rect } from "../view";

/** What the Blur Gallery needs of the rest of the engine. */
export interface BlurGalleryHost {
  /** A layer's raster; its pixels changed, so what it renders is stale. */
  layer(id: string): Layer;
  bumpPixel(id: string): void;
  emitChange(): void;
  /** Every other live session finished before this one begins. */
  endLive(): void;
  /** The selection as a white-inside mask. */
  selectionMask(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement;
  /** One step whose undo and redo do the work. */
  pushStructural(label: string, undo: () => void, redo: () => void): void;
  /** The layers' pixels changed under the magic wand's cached source. */
  dropWandSource(): void;
  /** The working colour space, and whether background compute is on. */
  cs(): PredefinedColorSpace;
  workersOn(): boolean;
}

export class EngineBlurGallery extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: BlurGalleryHost,
  ) {
    super(cursor);
  }

  // Blur Gallery (Effects ▸ Blur Gallery) live preview session: the affected
  // layers' original pixels + a selection mask + the zoom/spin centre.
  blurFx: {
    ids: string[];
    orig: Map<string, ImageData>;
    mask: Uint8ClampedArray | null;
  } | null = null;

  // ---- Blur Gallery (Effects) ----------------------------------------------
  // Preview compute runs in a dedicated Worker when available (the kernel in
  // filters.ts is pure), so slider drags never block the UI thread. Replies
  // are session- and sequence-guarded: stale results are dropped, and nothing
  // is ever applied after cancel/commit. Falls back to the sync path.
  private blurWorker: Worker | null = null;
  private blurWorkerBroken = false;
  private blurSessionId = 0;
  private blurRenderSeq = 0;
  blurPending = new Map<number, (applied: boolean) => void>();

  /** The engine's state these read as they did: the colour space, background compute. */
  private get cs(): PredefinedColorSpace {
    return this.host.cs();
  }
  private get workersOn(): boolean {
    return this.host.workersOn();
  }

  private ensureBlurWorker(): Worker | null {
    if (!this.workersOn || this.blurWorkerBroken) return null;
    if (this.blurWorker) return this.blurWorker;
    if (typeof Worker === "undefined") {
      this.blurWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../../workers/blurfx.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e) => this.onBlurWorkerMessage(e);
      w.onerror = () => {
        // Permanent sync fallback; release any awaiting previews.
        this.blurWorkerBroken = true;
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
        this.blurWorker = null;
        for (const r of this.blurPending.values()) r(false);
        this.blurPending.clear();
      };
      this.blurWorker = w;
      return w;
    } catch {
      this.blurWorkerBroken = true;
      return null;
    }
  }

  private onBlurWorkerMessage(
    e: MessageEvent<{
      session: number;
      seq: number;
      results: { id: string; w: number; h: number; data: ArrayBuffer }[];
    }>,
  ) {
    const { session, seq, results } = e.data;
    const resolve = this.blurPending.get(seq);
    this.blurPending.delete(seq);
    // Stale session (cancelled/committed/new one) or superseded seq → drop.
    if (session !== this.blurSessionId || !this.blurFx || seq !== this.blurRenderSeq) {
      resolve?.(false);
      return;
    }
    for (const r of results) {
      if (!this.blurFx.ids.includes(r.id)) continue;
      const bytes = new Uint8ClampedArray(r.data);
      let img: ImageData;
      try {
        img = new ImageData(bytes, r.w, r.h, { colorSpace: this.cs });
      } catch {
        img = new ImageData(bytes, r.w, r.h);
      }
      this.host.layer(r.id).ctx.putImageData(img, 0, 0);
      this.host.bumpPixel(r.id);
    }
    this.host.emitChange();
    resolve?.(true);
  }

  /** Send the session's original pixels (+ selection mask) to the worker once. */
  private blurWorkerInit() {
    const fx = this.blurFx;
    const w = fx ? this.ensureBlurWorker() : null;
    if (!fx || !w) return;
    this.blurSessionId++;
    const layers: { id: string; w: number; h: number; data: ArrayBuffer }[] = [];
    const transfers: ArrayBuffer[] = [];
    for (const [id, img] of fx.orig) {
      const copy = img.data.slice(); // keep the engine's own snapshot intact
      layers.push({ id, w: img.width, h: img.height, data: copy.buffer });
      transfers.push(copy.buffer);
    }
    let mask: ArrayBuffer | null = null;
    if (fx.mask) {
      const mc = fx.mask.slice();
      mask = mc.buffer;
      transfers.push(mc.buffer);
    }
    w.postMessage({ type: "init", session: this.blurSessionId, cs: this.cs, mask, layers }, transfers);
  }

  private blurWorkerEnd() {
    this.blurWorker?.postMessage({ type: "end", session: this.blurSessionId });
    this.blurSessionId++; // any in-flight replies become stale
  }

  /**
   * Off-thread preview: resolves true when this render reached the layers,
   * false when it was superseded/cancelled. Falls back to the synchronous
   * path (and resolves true) when the worker is unavailable.
   */
  previewBlurFxAsync(
    kind: string,
    amount: number,
    angle: number,
    anchorX = 0.5,
    anchorY = 0.5,
    extra?: { band: number; feather: number; threshold: number },
  ): Promise<boolean> {
    if (!this.blurFx) return Promise.resolve(false);
    const w = this.ensureBlurWorker();
    if (!w) {
      this.previewBlurFx(kind, amount, angle, anchorX, anchorY, extra);
      return Promise.resolve(true);
    }
    const seq = ++this.blurRenderSeq;
    return new Promise((resolve) => {
      this.blurPending.set(seq, resolve);
      w.postMessage({
        type: "render",
        session: this.blurSessionId,
        seq,
        kind,
        amount,
        angle,
        ax: anchorX,
        ay: anchorY,
        extra: extra ?? { band: 20, feather: 30, threshold: 40 },
      });
    });
  }

  /** Begin a blur-effect preview session over `ids` (clipped to `sel` if given). */
  beginBlurFx(
    ids: string[],
    sel: Rect[] | null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    this.host.endLive();
    const orig = new Map<string, ImageData>();
    for (const id of ids) orig.set(id, this.host.layer(id).ctx.getImageData(0, 0, this.w, this.h));
    let mask: Uint8ClampedArray | null = null;
    if (sel && sel.length) {
      const m = this.host.selectionMask(sel, selAngle, selPivot);
      const md = m.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      mask = sa;
    }
    this.blurFx = { ids, orig, mask };
    this.blurWorkerInit(); // ship the originals off-thread once per session
  }

  /**
   * Re-render the preview from the originals. `anchorX/anchorY` (0–1 of the doc)
   * is the centre for zoom/spin blur; ignored by the other kinds.
   */
  previewBlurFx(
    kind: string,
    amount: number,
    angle: number,
    anchorX = 0.5,
    anchorY = 0.5,
    extra?: { band: number; feather: number; threshold: number },
  ) {
    const fx = this.blurFx;
    if (!fx) return;
    const cx = anchorX * this.w;
    const cy = anchorY * this.h;
    for (const id of fx.ids) {
      const o = fx.orig.get(id);
      if (!o) continue;
      const out = computeBlurFx(o, kind, amount, angle, fx.mask, cx, cy, this.cs, extra);
      this.host.layer(id).ctx.putImageData(out, 0, 0);
      this.host.bumpPixel(id); // direct pixel write — keep render/styled caches honest
    }
    this.host.emitChange();
  }

  /** Keep the previewed blur as one undoable step (undo/redo swap the snapshots). */
  commitBlurFx(label: string) {
    const fx = this.blurFx;
    if (!fx) return;
    const { ids, orig } = fx;
    const after = new Map<string, ImageData>();
    for (const id of ids) after.set(id, this.host.layer(id).ctx.getImageData(0, 0, this.w, this.h));
    this.blurFx = null;
    this.blurWorkerEnd();
    this.host.dropWandSource();
    this.host.pushStructural(
      label,
      () => {
        for (const id of ids) {
          const o = orig.get(id);
          if (o) this.host.layer(id).ctx.putImageData(o, 0, 0);
        }
        this.host.dropWandSource();
        this.host.emitChange();
      },
      () => {
        for (const id of ids) {
          const a = after.get(id);
          if (a) this.host.layer(id).ctx.putImageData(a, 0, 0);
        }
        this.host.dropWandSource();
        this.host.emitChange();
      },
    );
  }

  /** Discard the blur preview, restoring the original pixels. */
  cancelBlurFx() {
    const fx = this.blurFx;
    if (!fx) return;
    for (const id of fx.ids) {
      const o = fx.orig.get(id);
      if (o) {
        this.host.layer(id).ctx.putImageData(o, 0, 0);
        this.host.bumpPixel(id);
      }
    }
    this.blurFx = null;
    this.blurWorkerEnd();
    this.host.emitChange();
  }
}
