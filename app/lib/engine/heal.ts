// The engine's heal (TODO 1.6): spot heal and content-aware fill. Each works
// out the region to heal and its coverage — soft discs along the stroke, or the
// selection — padded with the surroundings the fill is drawn from; the solve
// runs in the heal worker (in line without one), and the result is baked as one
// step into the document it began in, even if that has gone to the back by the
// time it lands.
//
// What it needs of the rest of the engine — the selection, the pixel commit in
// front and behind — comes through `HealHost`.

import { DocumentScoped, type DocCursor, type DocumentState } from "../doc-state";
import { healPadding, healRegion } from "../heal";
import { makeCanvas } from "./canvas";
import type { Rect } from "../view";

/** What the heal needs of the rest of the engine. */
export interface HealHost {
  /** The selection as a white-inside mask, and the box round it. */
  selectionMask(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement;
  boundsOf(rects: Rect[], angle?: number, pivot?: { x: number; y: number } | null): Rect | null;
  /** The pixel commit, one undo step with the layer's locks enforced: to the
   *  document in front, or to one that has gone to the back. */
  pushEntry(
    layerId: string,
    rect: { x: number; y: number; w: number; h: number },
    before: ImageData,
    after: ImageData,
    label: string,
  ): void;
  landInBackground(
    d: DocumentState,
    layerId: string,
    rect: Rect,
    before: ImageData,
    after: ImageData,
    label: string,
  ): void;
  /** A layer's pixels changed within `rect`: what it renders is stale. */
  bumpPixel(id: string, rect?: Rect): void;
  emitChange(): void;
  /** The working colour space, and whether background compute is on. */
  cs(): PredefinedColorSpace;
  workersOn(): boolean;
}

export class EngineHeal extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: HealHost,
  ) {
    super(cursor);
  }

  // ---- Heal worker (one-shot jobs; sync fallback if workers are unavailable) --
  private healWorker: Worker | null = null;
  private healWorkerBroken = false;
  private healJobSeq = 0;
  healPending = new Map<
    number,
    {
      layerId: string;
      rx: number;
      ry: number;
      rw: number;
      rh: number;
      label: string;
      epoch: number;
      docW: number;
      docH: number;
      /** The document it heals, which may not be in front when it lands. */
      doc: DocumentState;
      before: ImageData;
      coverage: Uint8ClampedArray; // kept for the sync fallback on worker error
    }
  >();

  /** The engine's state these read as they did: the colour space, background compute. */
  private get cs(): PredefinedColorSpace {
    return this.host.cs();
  }
  private get workersOn(): boolean {
    return this.host.workersOn();
  }

  // ---- Spot heal / content-aware fill ---------------------------------------
  /** Shared tail: crop the padded region, heal `coverage`, bake + one entry.
   *  The solve runs in the heal worker (UI stays responsive on big blobs);
   *  finishHeal validates + bakes the reply, or computes synchronously when
   *  workers are unavailable. */
  private healApply(
    layerId: string,
    coverage: Uint8ClampedArray,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    label: string,
  ) {
    const l = this.layers.get(layerId);
    if (!l) return;
    const src = l.ctx.getImageData(rx, ry, rw, rh);
    const job = {
      layerId,
      rx,
      ry,
      rw,
      rh,
      label,
      epoch: this.docEpoch,
      docW: this.w,
      docH: this.h,
      doc: this.doc,
      before: src,
      coverage,
    };
    const w = this.ensureHealWorker();
    if (!w) {
      this.finishHeal(job, null); // sync path
      return;
    }
    const id = ++this.healJobSeq;
    this.healPending.set(id, job);
    // Ship COPIES: `before`/`coverage` stay usable for history + the fallback.
    const srcCopy = src.data.slice();
    const covCopy = coverage.slice();
    w.postMessage(
      { id, w: rw, h: rh, src: srcCopy.buffer, coverage: covCopy.buffer },
      [srcCopy.buffer, covCopy.buffer],
    );
  }

  /** Multiply a region-space coverage by the current selection's mask. */
  clipCoverageToSelection(
    coverage: Uint8ClampedArray,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    sel: Rect[],
    selAngle: number,
    selPivot: { x: number; y: number } | null,
  ) {
    const m = this.host.selectionMask(sel, selAngle, selPivot);
    const md = m.getContext("2d")!.getImageData(rx, ry, rw, rh).data;
    for (let i = 0; i < coverage.length; i++) coverage[i] = (coverage[i] * md[i * 4 + 3]) / 255;
  }

  /**
   * Spot-heal the blob painted by the heal brush: `pts` (doc space) stamp soft
   * discs into a coverage mask; the blob heals in one pass on release —
   * texture from the best-matching surroundings, tone-matched seamlessly.
   */
  healSpots(
    layerId: string,
    pts: { x: number; y: number }[],
    size: number,
    hardness: number,
    sel: Rect[] | null = null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    if (!pts.length || !this.layers.has(layerId)) return;
    const r = Math.max(1, size / 2);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x - r);
      y0 = Math.min(y0, p.y - r);
      x1 = Math.max(x1, p.x + r);
      y1 = Math.max(y1, p.y + r);
    }
    const pad = healPadding(x1 - x0, y1 - y0);
    const rx = Math.max(0, Math.floor(x0 - pad));
    const ry = Math.max(0, Math.floor(y0 - pad));
    const rw = Math.min(this.w, Math.ceil(x1 + pad)) - rx;
    const rh = Math.min(this.h, Math.ceil(y1 + pad)) - ry;
    if (rw <= 0 || rh <= 0) return;
    // Rasterize the blob (soft discs honouring hardness) into region space.
    const cov = makeCanvas(rw, rh, true, "srgb");
    const cctx = cov.ctx;
    for (const p of pts) {
      const cx = p.x - rx;
      const cy = p.y - ry;
      const g = cctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(Math.max(0, Math.min(1, hardness / 100)), "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      cctx.fillStyle = g;
      cctx.beginPath();
      cctx.arc(cx, cy, r, 0, Math.PI * 2);
      cctx.fill();
    }
    const cd = cctx.getImageData(0, 0, rw, rh).data;
    const coverage = new Uint8ClampedArray(rw * rh);
    for (let i = 0; i < coverage.length; i++) coverage[i] = cd[i * 4 + 3];
    if (sel && sel.length) this.clipCoverageToSelection(coverage, rx, ry, rw, rh, sel, selAngle, selPivot);
    this.healApply(layerId, coverage, rx, ry, rw, rh, "Spot Heal");
  }

  /** Fill the selection with synthesized surrounding content (Edit menu). */
  contentAwareFill(
    layerId: string,
    sel: Rect[],
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    if (!sel.length || !this.layers.has(layerId)) return;
    const b = this.host.boundsOf(sel);
    if (!b) return;
    const pad = healPadding(b.w, b.h);
    const rx = Math.max(0, Math.floor(b.x - pad));
    const ry = Math.max(0, Math.floor(b.y - pad));
    const rw = Math.min(this.w, Math.ceil(b.x + b.w + pad)) - rx;
    const rh = Math.min(this.h, Math.ceil(b.y + b.h + pad)) - ry;
    if (rw <= 0 || rh <= 0) return;
    const coverage = new Uint8ClampedArray(rw * rh);
    coverage.fill(255);
    this.clipCoverageToSelection(coverage, rx, ry, rw, rh, sel, selAngle, selPivot);
    this.healApply(layerId, coverage, rx, ry, rw, rh, "Content-Aware Fill");
  }

  private ensureHealWorker(): Worker | null {
    if (!this.workersOn || this.healWorkerBroken) return null;
    if (this.healWorker) return this.healWorker;
    if (typeof Worker === "undefined") {
      this.healWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../../workers/heal.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e) => this.onHealWorkerMessage(e);
      w.onerror = () => {
        // Permanent sync fallback — and finish anything already in flight
        // synchronously so no released heal blob is silently lost.
        this.healWorkerBroken = true;
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
        this.healWorker = null;
        const pending = [...this.healPending.values()];
        this.healPending.clear();
        for (const job of pending) this.finishHeal(job, null);
      };
      this.healWorker = w;
      return w;
    } catch {
      this.healWorkerBroken = true;
      return null;
    }
  }

  private onHealWorkerMessage(e: MessageEvent<{ id: number; data: ArrayBuffer }>) {
    const job = this.healPending.get(e.data.id);
    if (!job) return;
    this.healPending.delete(e.data.id);
    this.finishHeal(job, new Uint8ClampedArray(e.data.data));
  }

  /** Bake a finished heal (worker bytes, or recompute sync when bytes = null).
   *  Discards the result if the document was reframed while it was in flight —
   *  the captured coordinates would no longer be valid — or closed. */
  private finishHeal(
    job: {
      layerId: string;
      rx: number;
      ry: number;
      rw: number;
      rh: number;
      label: string;
      epoch: number;
      docW: number;
      docH: number;
      doc: DocumentState;
      before: ImageData;
      coverage: Uint8ClampedArray;
    },
    bytes: Uint8ClampedArray<ArrayBuffer> | null,
  ) {
    const d = job.doc;
    if (job.epoch !== d.epoch || job.docW !== d.w || job.docH !== d.h) return;
    if (!this.isOpen(d)) return; // closed meanwhile
    const l = d.layers.get(job.layerId);
    if (!l) return; // layer deleted while healing
    let healed: ImageData;
    if (bytes) {
      try {
        healed = new ImageData(bytes, job.rw, job.rh, { colorSpace: this.cs });
      } catch {
        healed = new ImageData(bytes, job.rw, job.rh);
      }
    } else {
      healed = healRegion({ src: job.before, coverage: job.coverage });
    }
    if (d !== this.doc) {
      this.host.landInBackground(
        d,
        job.layerId,
        { x: job.rx, y: job.ry, w: job.rw, h: job.rh },
        job.before,
        healed,
        job.label,
      );
      return;
    }
    l.ctx.putImageData(healed, job.rx, job.ry);
    this.host.pushEntry(
      job.layerId,
      { x: job.rx, y: job.ry, w: job.rw, h: job.rh },
      job.before,
      healed,
      job.label,
    );
    this.host.bumpPixel(job.layerId, { x: job.rx, y: job.ry, w: job.rw, h: job.rh });
    this.host.emitChange();
  }
}
