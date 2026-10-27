// The engine's selection (TODO 1.6): a selection's coverage and its outline —
// a soft one keeps a mask behind its ≥50% rects (selection-mask.ts, TODO 1.3) —
// the shape every other area clips and masks through, the operations on it
// (feather, refine, grow, modify, shift, carry a resize, combine), and the
// tools that make one: the magic wand, quick select, the lasso.
//
// The masks and outlines live on each document (doc-state.ts), keyed by the
// outline's rects; this works on the one in front through the cursor it shares
// with the engine. What it needs of the rest of the engine — a canvas in the
// working space, the view it samples for "all layers" — comes through
// `SelectionHost`.

import { DocumentScoped, type DocCursor } from "../doc-state";
import { maskToRects, maskToSegments, type Seg } from "../mask-trace";
import type { SavedSelectionMask } from "../project";
import { applyRefine, effectiveSoftness, type RefineEdge } from "../refine-edge";
import { modifyMask, type ModifyOp } from "../select-modify";
import {
  combine as combineMasks,
  coverage as selectionCoverage,
  feather as featherMask,
  fromCoverage,
  growSquare,
  morphRound,
  peakOf,
  resample as resampleMask,
  shift as shiftMask,
  type SelectionMask,
} from "../selection-mask";
import type { WandSelection } from "../paint";
import { buildEdgeField, type EdgeField } from "../magnetic";
import type { Bounds } from "../paint";
import type { Rect } from "../view";
import { makeCanvas } from "./canvas";

/** What the selection needs of the rest of the engine. */
export interface SelectionHost {
  /** A canvas in the working colour space. */
  mk(w: number, h: number, readFreq?: boolean): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  /** The working colour space, as it is now. */
  cs(): PredefinedColorSpace;
  /** The view's context — what the tools sample for "all layers". */
  viewContext(): CanvasRenderingContext2D | null;
}

export class EngineSelection extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: SelectionHost,
  ) {
    super(cursor);
  }

  /** Last soft selection mask built, reused while nothing it depends on moves —
   *  a live gradient or brush asks for it every frame. */
  private softMaskMemo: {
    rects: Rect[];
    cov: SelectionMask | null;
    angle: number;
    px: number | null;
    py: number | null;
    w: number;
    h: number;
    c: HTMLCanvasElement;
  } | null = null;
  // Cached magic-wand source pixels, reused across live (tolerance) re-runs and
  // dropped on any layer mutation (see invalidateWandSrc).
  wandSrc: {
    data: Uint8ClampedArray;
    w: number;
    h: number;
    layerId: string;
    sampleAll: boolean;
  } | null = null;
  // Reused magic-wand scratch buffers (mask / flood-fill stack / visited).
  private wandBuf: { mask: Uint8Array; stack: Int32Array; n: number } | null = null;
  // Quick-select session: source pixels + edge field snapshotted at stroke start,
  // an accumulating selection mask, per-dab visit stamps, the running brushed-colour
  // mean, and the selection's growing bounds. Grows incrementally per brush dab.
  private qs: {
    data: Uint8ClampedArray;
    edge: EdgeField;
    mask: Uint8Array; // 1 = selected
    stamp: Int32Array; // last dab index that visited a pixel (avoids re-clearing)
    stack: Int32Array;
    dab: number;
    subtract: boolean;
    tol: number;
    mr: number; // running brushed-colour mean
    mg: number;
    mb: number;
    count: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null = null;
  // Reusable scratch for combineSelection, plus the bounds the last call left
  // 1s in — clearing just that beats both allocating a zeroed buffer and wiping
  // the whole one.
  private combineBuf: Uint8Array | null = null;
  private combineBufW = 0;
  private combineBufH = 0;
  private combineDirty: Bounds | null = null;

  // ---- A selection's coverage and outline -------------------------------
  /**
   * A selection from per-pixel coverage (`at(i)` for pixel i, 0–255): its ≥50%
   * outline as rects, with the coverage kept behind them when it is soft (see
   * selection-mask.ts). `softness` is how far a feather made the edge reach.
   */
  selectionFromCoverage(at: (i: number) => number, softness?: number): Rect[] {
    const { rects, mask } = fromCoverage(at, this.w, this.h);
    if (mask) this.selectionMasks.set(rects, softness ? { ...mask, softness } : mask);
    return rects;
  }

  /** A selection's coverage over the whole canvas, unrotated: its mask where it
   *  has one, otherwise its rects as 0 / 255. One byte per pixel. */
  private coverageFull(rects: Rect[]): Uint8Array {
    return selectionCoverage(rects, this.coverageOf(rects), this.w, this.h);
  }

  /** A selection's coverage over the whole canvas with its rotation applied —
   *  what a fill through it would see. */
  private coverageImage(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): Uint8Array {
    if (!angle) return this.coverageFull(rects);
    const c = this.selectionMask(rects, angle, pivot);
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, this.w, this.h).data;
    const out = new Uint8Array(this.w * this.h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
    return out;
  }

  /** The mask behind a selection, if it has one that still fits the canvas. */
  coverageOf(rects: Rect[] | null | undefined): SelectionMask | null {
    const c = rects ? this.selectionMasks.get(rects) : undefined;
    return c && c.w === this.w && c.h === this.h ? c : null;
  }

  /** Does this selection carry partial coverage (not just its ≥50% rects)? */
  isSoftSelection(rects: Rect[]): boolean {
    return !!this.coverageOf(rects);
  }

  /** Is this a FAINT selection — partly selected everywhere, nowhere 50%? Its
   *  outline then marks half its peak strength (see selection-mask.ts). */
  isFaintSelection(rects: Rect[]): boolean {
    const m = this.coverageOf(rects);
    return !!m && peakOf(m) < 128;
  }

  /** How far a selection's soft edge reaches either side of its outline, in
   *  px, when an operation that knows it made it (0 otherwise). */
  selectionSoftness(rects: Rect[]): number {
    return this.coverageOf(rects)?.softness ?? 0;
  }

  /**
   * A selection's outline as merged boundary segments — what the ants trace.
   * Traced once from its raster, in time linear in its area, and kept with the
   * selection (by its rects, like its mask). The trace it replaces was a union
   * of the rects, cubic in their number: Select ▸ Inverse of a large ellipse
   * froze the page for over two seconds, and again on every undo and redo.
   */
  selectionOutline(rects: Rect[]): Seg[] {
    const hit = this.doc.selectionOutlines.get(rects);
    if (hit) return hit;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, Math.floor(r.x));
      y0 = Math.min(y0, Math.floor(r.y));
      x1 = Math.max(x1, Math.ceil(r.x + r.w));
      y1 = Math.max(y1, Math.ceil(r.y + r.h));
    }
    let segs: Seg[] = [];
    if (x1 > x0 && y1 > y0) {
      const bw = x1 - x0;
      const bh = y1 - y0;
      const on = new Uint8Array(bw * bh);
      for (const r of rects) {
        const rx0 = Math.floor(r.x) - x0;
        const rx1 = Math.ceil(r.x + r.w) - x0;
        for (let y = Math.floor(r.y) - y0; y < Math.ceil(r.y + r.h) - y0; y++) on.fill(1, y * bw + rx0, y * bw + rx1);
      }
      segs = maskToSegments(on, bw, bh, { x0: 0, y0: 0, x1: bw, y1: bh }).map((g) => ({
        x1: g.x1 + x0,
        y1: g.y1 + y0,
        x2: g.x2 + x0,
        y2: g.y2 + y0,
      }));
    }
    this.doc.selectionOutlines.set(rects, segs);
    return segs;
  }

  /** A selection's coverage as a canvas (white, alpha = coverage), rotation
   *  applied — a copy the caller may keep (Refine Edge previews it). */
  selectionCoverageCanvas(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement {
    const src = this.selectionMask(rects, angle, pivot);
    const out = this.host.mk(this.w, this.h, true);
    out.ctx.drawImage(src, 0, 0);
    return out.c;
  }

  /** A soft selection's coverage as a grayscale PNG over its bounds, for the
   *  project file; null for a hard one (its rects say everything). */
  selectionMaskImage(rects: Rect[]): SavedSelectionMask | null {
    // Any open document's: a tab you have just left is saved after the switch.
    let m: SelectionMask | null = null;
    for (const d of this.everyDoc()) {
      const c = d.selectionMasks.get(rects);
      if (c && c.w === d.w && c.h === d.h) {
        m = c;
        break;
      }
    }
    if (!m) return null;
    const { bounds: b, alpha } = m;
    const c = makeCanvas(b.w, b.h, true, "srgb");
    const img = c.ctx.createImageData(b.w, b.h);
    for (let i = 0; i < alpha.length; i++) {
      const o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = alpha[i];
      img.data[o + 3] = 255;
    }
    c.ctx.putImageData(img, 0, 0);
    return { ...b, data: c.c.toDataURL("image/png"), ...(m.softness ? { softness: m.softness } : {}) };
  }

  /** Put a saved soft selection's coverage back behind its outline (project load). */
  adoptSelectionMask(
    rects: Rect[],
    at: { x: number; y: number; softness?: number },
    source: CanvasImageSource & { width: number; height: number },
  ): void {
    const w = source.width;
    const h = source.height;
    if (!(w > 0 && h > 0)) return;
    const c = makeCanvas(w, h, true, "srgb");
    c.ctx.drawImage(source, 0, 0);
    const d = c.ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4];
    this.selectionMasks.set(rects, {
      w: this.w,
      h: this.h,
      bounds: { x: at.x, y: at.y, w, h },
      alpha,
      ...(at.softness ? { softness: at.softness } : {}),
    });
  }

  // ---- Its shape, for clipping and masking -------------------------------
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

  /** Clip to the selection — a rotated quad path about `pivot` when `angle` ≠ 0. */
  clipTo(
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
  selectionMask(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
  ): HTMLCanvasElement {
    const cov = this.coverageOf(rects);
    const memo = this.softMaskMemo;
    if (
      memo &&
      memo.rects === rects &&
      memo.cov === cov &&
      memo.angle === angle &&
      memo.px === (pivot?.x ?? null) &&
      memo.py === (pivot?.y ?? null) &&
      memo.w === this.w &&
      memo.h === this.h
    ) {
      return memo.c; // callers only ever read it or draw from it
    }
    const out = this.buildSelectionMask(rects, cov, angle, pivot);
    // Kept for every selection, hard ones too: an edit asks for it again and
    // again while nothing it depends on moves (a live gradient every frame).
    {
      this.softMaskMemo = {
        rects,
        cov,
        angle,
        px: pivot?.x ?? null,
        py: pivot?.y ?? null,
        w: this.w,
        h: this.h,
        c: out,
      };
    }
    return out;
  }

  /** The shape of a selection, unrotated: its coverage if it is soft, else its rects. */
  private paintSelectionShape(ctx: CanvasRenderingContext2D, rects: Rect[], cov: SelectionMask | null) {
    if (!cov) {
      this.pathOf(ctx, rects, 0, null);
      ctx.fill();
      return;
    }
    const { bounds: b, alpha } = cov;
    const img = new ImageData(b.w, b.h, { colorSpace: this.host.cs() });
    const d = img.data;
    for (let i = 0; i < alpha.length; i++) {
      const o = i * 4;
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = alpha[i];
    }
    ctx.putImageData(img, b.x, b.y);
  }

  private buildSelectionMask(
    rects: Rect[],
    cov: SelectionMask | null,
    angle: number,
    pivot: { x: number; y: number } | null,
  ): HTMLCanvasElement {
    const base = this.host.mk(this.w, this.h);
    base.ctx.fillStyle = "#fff";
    if (!angle) {
      this.paintSelectionShape(base.ctx, rects, cov);
    } else {
      // Solid axis-aligned shape (abutting upright rects fill without seams)…
      const flat = this.host.mk(this.w, this.h);
      flat.ctx.fillStyle = "#fff";
      this.paintSelectionShape(flat.ctx, rects, cov);
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
    return base.c;
  }

  /** A selection's bounds on the canvas — its soft edge and its rotation
   *  included — or null when it misses the canvas. */
  boundsOf(
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    // Soft coverage reaches past the ≥50% rects; the pivot stays the rects'.
    const cov = this.coverageOf(rects);
    const extent = cov ? [cov.bounds] : rects;
    if (!angle) {
      for (const r of extent) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
    } else {
      const c = pivot ?? this.centerOf(rects);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (const r of extent) {
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

  // ---- Selection operations on the mask (TODO 1.3) -------------------------
  // Each makes a new selection from an old one by working on its COVERAGE, so a
  // soft selection stays soft. They return the new outline rects (the mask is
  // registered behind them); a result with nothing at 50% or more is empty.
  /**
   * Combine selections KEEPING soft coverage (TODO 0.2a): add = max(a, b),
   * subtract = min(a, 255 − b), intersect = min(a, b), invert = 255 − a — the
   * usual mask algebra, which for 0/255 inputs is exactly union, difference,
   * intersection and complement. Returns null when no operand is soft, so hard
   * selections keep their existing paths (and rect layout) untouched. Unrotated
   * selections only: the caller falls back for a rotated one.
   */
  combineSelectionSoft(
    a: Rect[],
    b: Rect[] | null,
    op: "add" | "subtract" | "intersect" | "invert",
  ): Rect[] | null {
    if (!this.coverageOf(a) && !(b && this.coverageOf(b))) return null;
    const r = combineMasks(this.coverageFull(a), b ? this.coverageFull(b) : null, op);
    return this.selectionFromCoverage((i) => r[i]);
  }

  /** Select ▸ Feather: blur the selection's coverage by `px`. Rotation is baked
   *  in, so the result is unrotated. */
  featherSelection(rects: Rect[], angle: number, pivot: { x: number; y: number } | null, px: number): Rect[] {
    if (!rects.length || !(px > 0)) return rects;
    const f = featherMask(this.coverageImage(rects, angle, pivot), this.w, this.h, px);
    const softness =
      (this.coverageOf(rects)?.softness ?? 0) + effectiveSoftness({ smooth: 0, contrast: 0, shift: 0, feather: px });
    return this.selectionFromCoverage((i) => f[i], softness);
  }

  /** Refine Edge, applied to the selection it was made for: smooth, feather,
   *  contrast and shift, baked into its coverage. Rotation is baked in too. */
  refineSelection(rects: Rect[], angle: number, pivot: { x: number; y: number } | null, r: RefineEdge): Rect[] {
    if (!rects.length) return rects;
    const c = this.coverageImage(rects, angle, pivot);
    const a = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) a[i] = c[i];
    applyRefine(a, this.w, this.h, r);
    const out = new Uint8ClampedArray(a); // rounded the way a canvas stores it
    return this.selectionFromCoverage((i) => out[i], effectiveSoftness(r) || undefined);
  }

  /** Select ▸ Grow on a SOFT selection: its coverage pushed out by `px` with a
   *  square kernel (a hard selection grows rect by rect). Null for a hard one. */
  growSoftSelection(rects: Rect[], px: number): Rect[] | null {
    const m = this.coverageOf(rects);
    if (!m) return null;
    const g = growSquare(this.coverageFull(rects), this.w, this.h, px);
    return this.selectionFromCoverage((i) => g[i], m.softness);
  }

  modifySelection(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
    op: ModifyOp,
    px: number,
  ): Rect[] {
    if (!rects.length) return [];
    // A SOFT selection expands and contracts as a whole: the max / min over the
    // same round kernel moves its soft edge without hardening it. (Smooth and
    // Border make a crisp edge by definition — they take the path below.)
    if (this.coverageOf(rects) && (op === "expand" || op === "contract")) {
      const out = morphRound(this.coverageImage(rects, angle, pivot), this.w, this.h, px, op === "expand");
      return this.selectionFromCoverage((i) => out[i], this.coverageOf(rects)?.softness);
    }
    // Rasterise through the existing mask builder so rotation is handled once,
    // in the place that already gets it right — then the morphology is plain
    // grid work and the result comes back as axis-aligned rects.
    const canvas = this.selectionMask(rects, angle, pivot);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return rects;
    const id = ctx.getImageData(0, 0, this.w, this.h);
    const n = this.w * this.h;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = id.data[i * 4 + 3] >= 128 ? 1 : 0;
    const outMask = modifyMask(mask, this.w, this.h, op, px);
    let x0 = this.w;
    let y0 = this.h;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (outMask[y * this.w + x]) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x + 1 > x1) x1 = x + 1;
          if (y + 1 > y1) y1 = y + 1;
        }
    if (x1 <= x0 || y1 <= y0) return [];
    return maskToRects(outMask, this.w, { x0, y0, x1, y1 });
  }

  /** The outline moved by (dx, dy) — a nudge or a drag — with its mask moved too. */
  shiftSelection(rects: Rect[], dx: number, dy: number): Rect[] {
    const moved = rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
    const m = this.coverageOf(rects);
    const next = m ? shiftMask(m, dx, dy) : null;
    if (next) this.selectionMasks.set(moved, next);
    return moved;
  }

  /** `to` is `from` resized from box `fromBox` to `toBox` (the transform
   *  handles, Transform-by-numbers): give it `from`'s mask, resampled to fit. */
  carryResizedSelection(from: Rect[], to: Rect[], fromBox: Rect, toBox: Rect): void {
    const m = this.coverageOf(from);
    const next = m ? resampleMask(m, fromBox, toBox) : null;
    if (next) this.selectionMasks.set(to, next);
  }

  // ---- The tools that make one: the wand, quick select, the lasso ----------
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
      const ctx = opts.sampleAll ? this.host.viewContext() : this.layers.get(layerId)?.ctx;
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
      // The scanline flood uses `mask` itself as the visited marker, so the old
      // `seen` byte-map is gone, and it packs each seed into ONE int (x in the
      // low 16 bits, y in the high) so the stack stays n ints rather than 2n.
      // Worst case is a checkerboard: n/2 spans, each seedable from the row
      // above and below, so n seeds — exactly what this holds. Packing is safe
      // because both axes are capped well under 65536 (the New Document dialog
      // allows 8192, and no canvas this app can allocate comes close).
      buf = { mask: new Uint8Array(n), stack: new Int32Array(n), n };
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
      /* SCANLINE flood. The per-pixel version walked one cell at a time with a
         parallel `seen` map, and paid a modulo AND a divide per pixel just to
         recover (x, y) from the packed index. This fills a whole horizontal RUN
         per pop and seeds only the runs above and below it, so the index maths
         disappears, the visited map is `mask` itself, and the stack carries
         spans rather than pixels. */
      const stack = buf.stack;
      let sp = 0;
      const match = (q: number): boolean => {
        const i2 = q * 4;
        const a3 = data[i2 + 3];
        return (
          Math.abs(data[i2] * a3 - spr) <= tScaled &&
          Math.abs(data[i2 + 1] * a3 - spg) <= tScaled &&
          Math.abs(data[i2 + 2] * a3 - spb) <= tScaled &&
          Math.abs(a3 - sa) <= t
        );
      };
      if (match(py * w + px)) {
        stack[sp++] = px | (py << 16);
        while (sp > 0) {
          const seed = stack[--sp];
          const cx = seed & 0xffff;
          const cy = seed >>> 16;
          const row = cy * w;
          if (mask[row + cx]) continue; // a later span already covered this seed
          let xl = cx;
          while (xl > 0 && !mask[row + xl - 1] && match(row + xl - 1)) xl--;
          let xr = cx;
          while (xr < w - 1 && !mask[row + xr + 1] && match(row + xr + 1)) xr++;
          for (let x = xl; x <= xr; x++) mask[row + x] = 1;
          if (xl < minX) minX = xl;
          if (xr > maxX) maxX = xr;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          // One seed per contiguous sub-run in the neighbouring rows.
          if (cy > 0) {
            const up = row - w;
            let inRun = false;
            for (let x = xl; x <= xr; x++) {
              const ok = !mask[up + x] && match(up + x);
              if (ok && !inRun) {
                stack[sp++] = x | ((cy - 1) << 16);
                inRun = true;
              } else if (!ok) inRun = false;
            }
          }
          if (cy < h - 1) {
            const dn = row + w;
            let inRun = false;
            for (let x = xl; x <= xr; x++) {
              const ok = !mask[dn + x] && match(dn + x);
              if (ok && !inRun) {
                stack[sp++] = x | ((cy + 1) << 16);
                inRun = true;
              } else if (!ok) inRun = false;
            }
          }
        }
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

  /** Begin a quick-selection stroke: snapshot the sampled surface + its edge
   *  field, and seed the accumulating mask with the current selection. */
  beginQuickSelect(
    layerId: string,
    opts: { tolerance: number; sampleAll: boolean },
    base: Rect[] | null,
    subtract: boolean,
  ): void {
    const w = this.w;
    const h = this.h;
    const ctx = opts.sampleAll ? this.host.viewContext() : this.layers.get(layerId)?.ctx;
    if (!ctx) {
      this.qs = null;
      return;
    }
    const data = ctx.getImageData(0, 0, w, h, { colorSpace: "srgb" }).data;
    const n = w * h;
    const mask = new Uint8Array(n);
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    if (base) {
      for (const r of base) {
        const rx0 = Math.max(0, r.x);
        const ry0 = Math.max(0, r.y);
        const rx1 = Math.min(w, r.x + r.w);
        const ry1 = Math.min(h, r.y + r.h);
        for (let yy = ry0; yy < ry1; yy++) {
          const row = yy * w;
          for (let xx = rx0; xx < rx1; xx++) mask[row + xx] = 1;
        }
        if (rx0 < rx1 && ry0 < ry1) {
          x0 = Math.min(x0, rx0);
          y0 = Math.min(y0, ry0);
          x1 = Math.max(x1, rx1 - 1);
          y1 = Math.max(y1, ry1 - 1);
        }
      }
    }
    this.qs = {
      data,
      edge: buildEdgeField(data, w, h),
      mask,
      stamp: new Int32Array(n),
      stack: new Int32Array(n),
      dab: 0,
      subtract,
      tol: Math.max(1, opts.tolerance),
      mr: 0,
      mg: 0,
      mb: 0,
      count: 0,
      x0,
      y0,
      x1,
      y1,
    };
  }

  /** One brush dab (centre `x,y`, pixel radius `r`): grows (add) or shrinks
   *  (subtract) the selection through the edge-aware colour region. */
  quickSelectDab(x: number, y: number, r: number): WandSelection | null {
    const qs = this.qs;
    if (!qs) return null;
    const w = this.w;
    const h = this.h;
    const { data, edge, mask, stamp, stack } = qs;
    const sub = qs.subtract;
    const dab = ++qs.dab;
    const cx = Math.round(x);
    const cy = Math.round(y);
    const rad = Math.max(1, Math.round(r));
    const rr = rad * rad;
    // Seed from the brush footprint: select those pixels outright (user intent),
    // fold their colour into the running region mean, and queue them to grow from.
    let sp = 0;
    const bx0 = Math.max(0, cx - rad);
    const bx1 = Math.min(w - 1, cx + rad);
    const by0 = Math.max(0, cy - rad);
    const by1 = Math.min(h - 1, cy + rad);
    for (let yy = by0; yy <= by1; yy++) {
      const dy = yy - cy;
      for (let xx = bx0; xx <= bx1; xx++) {
        const dx = xx - cx;
        if (dx * dx + dy * dy > rr) continue;
        const p = yy * w + xx;
        const i = p * 4;
        qs.mr += data[i];
        qs.mg += data[i + 1];
        qs.mb += data[i + 2];
        qs.count++;
        if (sub) {
          mask[p] = 0;
        } else {
          mask[p] = 1;
          if (xx < qs.x0) qs.x0 = xx;
          if (xx > qs.x1) qs.x1 = xx;
          if (yy < qs.y0) qs.y0 = yy;
          if (yy > qs.y1) qs.y1 = yy;
        }
        if (stamp[p] !== dab) {
          stamp[p] = dab;
          stack[sp++] = p;
        }
      }
    }
    if (qs.count === 0) return this.qsResult();
    const mr = qs.mr / qs.count;
    const mg = qs.mg / qs.count;
    const mb = qs.mb / qs.count;
    const tol = qs.tol * 1.6; // UI 0–100 → colour distance
    const edgeW = 0.35; // strong edges raise the colour bar
    const EDGE_STOP = 46; // an edge this strong is a wall (don't expand across it)
    // BFS grow: only step into pixels not yet handled by this dab, and — to keep
    // the whole stroke ~O(final selection) — only into pixels not already in the
    // right state (unselected for add, selected for subtract).
    while (sp > 0) {
      const p = stack[--sp];
      if (edge.mag[p] > EDGE_STOP) continue; // edge pixel: a boundary, no expansion
      const px = p % w;
      const py = (p - px) / w;
      const step = (q: number) => {
        if (stamp[q] === dab) return;
        stamp[q] = dab;
        if (sub ? mask[q] === 0 : mask[q] === 1) return; // already in target state
        const iq = q * 4;
        const cd = Math.max(
          Math.abs(data[iq] - mr),
          Math.abs(data[iq + 1] - mg),
          Math.abs(data[iq + 2] - mb),
        );
        if (cd + edgeW * edge.mag[q] > tol) return; // too far / across an edge
        if (sub) {
          mask[q] = 0;
        } else {
          mask[q] = 1;
          const qx = q % w;
          const qy = (q - qx) / w;
          if (qx < qs.x0) qs.x0 = qx;
          if (qx > qs.x1) qs.x1 = qx;
          if (qy < qs.y0) qs.y0 = qy;
          if (qy > qs.y1) qs.y1 = qy;
        }
        stack[sp++] = q;
      };
      if (px > 0) step(p - 1);
      if (px < w - 1) step(p + 1);
      if (py > 0) step(p - w);
      if (py < h - 1) step(p + w);
    }
    return this.qsResult();
  }

  private qsResult(): WandSelection | null {
    const qs = this.qs;
    if (!qs || qs.x1 < 0) return null;
    const b: Bounds = { x0: qs.x0, y0: qs.y0, x1: qs.x1 + 1, y1: qs.y1 + 1 };
    const rects = maskToRects(qs.mask, this.w, b);
    if (!rects.length) return null;
    return { rects, segments: maskToSegments(qs.mask, this.w, this.h, b) };
  }

  /** End the quick-selection stroke (free the session buffers). */
  endQuickSelect(): void {
    this.qs = null;
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
    const { ctx } = this.host.mk(bw, bh, true);
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

  /** The shared combine buffer for a `w × h` document, cleared and ready. */
  private combineScratch(w: number, h: number): Uint8Array {
    if (!this.combineBuf || this.combineBufW !== w || this.combineBufH !== h) {
      // Keyed on BOTH dimensions, not the length: a 1920×1080 and a 1080×1920
      // document have the same cell count but different row strides, and reusing
      // one for the other would smear every row.
      this.combineBuf = new Uint8Array(w * h);
      this.combineBufW = w;
      this.combineBufH = h;
      this.combineDirty = null;
      return this.combineBuf;
    }
    const d = this.combineDirty;
    if (d) {
      for (let y = d.y0; y < d.y1; y++) this.combineBuf.fill(0, y * w + d.x0, y * w + d.x1);
      this.combineDirty = null;
    }
    return this.combineBuf;
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
    // Adding to or taking from a SOFT selection is mask algebra on its coverage,
    // so its soft edge survives a Shift- or Alt-drag (TODO 0.2a / 1.3).
    const soft = this.combineSelectionSoft(base, region, mode);
    if (soft) {
      if (!soft.length) return { rects: [], segments: [] };
      const on = selectionCoverage(soft, null, w, h);
      for (let i = 0; i < on.length; i++) on[i] = on[i] ? 1 : 0;
      const b = this.boundsOf(soft)!;
      const bb = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
      return { rects: soft, segments: maskToSegments(on, w, h, bb) };
    }
    const clamp4 = (r: Rect) => ({
      x0: Math.max(0, Math.floor(r.x)),
      y0: Math.max(0, Math.floor(r.y)),
      x1: Math.min(w, Math.ceil(r.x + r.w)),
      y1: Math.min(h, Math.ceil(r.y + r.h)),
    });
    const paint = (rects: Rect[], mask: Uint8Array, v: 0 | 1) => {
      for (const r of rects) {
        const c = clamp4(r);
        for (let yy = c.y0; yy < c.y1; yy++) {
          const row = yy * w;
          mask.fill(v, row + c.x0, row + c.x1); // whole run per row, not per pixel
        }
      }
    };
    const fill = (rects: Rect[], mask: Uint8Array) => paint(rects, mask, 1);
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
    const unionBounds = (a: Bounds | null, b: Bounds | null): Bounds | null =>
      !a ? b : !b ? a : {
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
      };

    // One scratch buffer reused across calls, cleared only over what the LAST
    // call wrote. Allocating (and zeroing) a fresh 2 MB Uint8Array per call —
    // two of them for a subtract — was pure overhead on a path that runs on
    // every wand click, quick-select segment and live re-shape tick.
    const out = this.combineScratch(w, h);
    const bBase = boundsOf(base);
    const bRegion = boundsOf(region);
    fill(base, out);
    let b: Bounds | null;
    if (mode === "add") {
      fill(region, out);
      b = unionBounds(bBase, bRegion);
    } else {
      // Subtract used to build a SECOND full-document mask for `region` and then
      // scan all 2M cells looking for it. Zeroing the region's own rects in place
      // is exactly equivalent — only cells the region covers can be cleared —
      // and touches the region's area instead of the whole document.
      paint(region, out, 0);
      b = bBase; // the result is a subset of the base
    }
    // Record what may still hold 1s, so the next call clears only that. Set
    // BEFORE the tracing below so an early return can't leave it stale.
    this.combineDirty = unionBounds(bBase, mode === "add" ? bRegion : null);
    if (!b) return { rects: [], segments: [] };
    const rects = maskToRects(out, w, b);
    return { rects, segments: rects.length ? maskToSegments(out, w, h, b) : [] };
  }
}
