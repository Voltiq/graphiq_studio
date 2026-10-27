// The engine's retouch brushes (TODO 1.6): the History brush, blur, dodge and
// burn, sponge, and smudge with the mixer. Each runs a session of its own beside
// the stroke pipeline: the layer's pixels at its start kept, a coverage buffer
// built dab by dab (blur, dodge, sponge, the History brush: the result is always
// effect(original) by coverage, so a stroke stays even and compounds across
// strokes) or a working copy smeared in place (smudge, the mixer), and one undo
// step at its end.
//
// What they need of the rest of the engine — which surface to paint, the
// selection as a mask, the History brush's source, the pixel commit — comes
// through `RetouchHost`.

import { DocumentScoped, type DocCursor, type Layer } from "../doc-state";
import { boxBlurPass } from "../blur";
import {
  averageColor,
  initialMixerState,
  afterStroke as mixerAfterStroke,
  mixerBlend,
  mixerDab,
  type MixerSettings,
  type MixerState,
  type Rgba,
} from "../mixer";
import type { BlurSettings, DodgeSettings, SmudgeSettings, SpongeSettings } from "../tools";
import type { BrushSettings, HistorySide } from "../paint";
import type { Rect } from "../view";

/** What the retouch brushes need of the rest of the engine. */
export interface RetouchHost {
  /** A layer's raster; which surface a brush on `id` paints, and its mask key. */
  layer(id: string): Layer;
  activeSurface(id: string): "pixels" | "mask";
  maskKeyOf(id: string): string;
  /** A mask was painted within `rect`: re-derive its alpha. */
  deriveMaskAlpha(id: string, rect?: Rect): void;
  /** The selection as a white-inside mask. */
  selectionMask(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement;
  /** The History brush's source: a layer at a history state, or in a snapshot. */
  reconstructLayerAt(layerId: string, index: number): Layer;
  snapshotLayer(snapId: string, layerId: string): Layer;
  /** A live adjustment preview is finished before a brush begins. */
  endAdjust(): void;
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
  /** The layers' pixels changed under the magic wand's cached source. */
  dropWandSource(): void;
  /** The working colour space, and the view's context ("all layers"). */
  cs(): PredefinedColorSpace;
  viewContext(): CanvasRenderingContext2D | null;
  emitChange(): void;
}

export class EngineRetouch extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: RetouchHost,
  ) {
    super(cursor);
  }

  // Blur-brush session. We never destroy the original pixels mid-stroke: `blurOrig`
  // holds them, `blurCov` accumulates per-pixel brush coverage (0–1), and the live
  // result is always lerp(orig, blur(orig), cov × strength). This keeps a stroke
  // even (no blotches on slow drags) while still compounding across strokes (each
  // new stroke re-reads the layer, i.e. the previous result).
  blurring = false;
  blurLayer: string | null = null;
  private blurOnMask = false;
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
  dodging = false;
  dodgeLayer: string | null = null;
  private dodgeOnMask = false;
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

  // Sponge session — the exact dodge/burn coverage-mask model (orig snapshot +
  // 0–1 coverage, re-baked as saturate/desaturate(orig, coverage × flow)).
  private sponging = false;
  private spongeLayer: string | null = null;
  private spongeOnMask = false;
  private spongeOrig: ImageData | null = null;
  private spongeCov: Float32Array | null = null;
  private spongeTip: { data: Float32Array; size: number; r: number } | null = null;
  private spongeOpts: SpongeSettings | null = null;
  private spongeDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private spongeStep = 1;
  private spongeResidual = 0;
  private spongeLast = { x: 0, y: 0 };
  private spongeLastRaw = { x: 0, y: 0 };
  private spongeSmoothPt = { x: 0, y: 0 };
  private spongeSelMask: Uint8ClampedArray | null = null;

  // Smudge session — NOT the coverage model: a stateful smear. `smudgeData` is a
  // live working copy of the layer bytes (mutated in place, blitted per segment);
  // `smudgeCarried` is a tip-sized RGBA buffer of the colour the finger drags,
  // updated each dab (pickup) and laid back down (deposit). `smudgeImage` wraps
  // smudgeData so a dirty-rect putImageData repaints only the touched region.
  private smudging = false;
  private smudgeLayer: string | null = null;
  private smudgeOnMask = false;
  private smudgeOrig: ImageData | null = null; // for the history before-image
  private smudgeData: Uint8ClampedArray | null = null; // live working bytes
  private smudgeImage: ImageData | null = null; // wraps smudgeData for blitting
  private smudgePickup: Uint8ClampedArray | null = null; // sampleAll composite, or null → smudgeData
  private smudgeCarried: Float32Array | null = null; // tip-sized RGBA the finger carries
  private smudgeTip: { data: Float32Array; size: number; r: number } | null = null;
  private smudgeOpts: SmudgeSettings | null = null;
  private smudgeDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private smudgeStep = 1;
  private smudgeResidual = 0;
  private smudgeLast = { x: 0, y: 0 };
  private smudgeLastRaw = { x: 0, y: 0 };
  private smudgeSmoothPt = { x: 0, y: 0 };
  private smudgeSelMask: Uint8ClampedArray | null = null;
  // Mixer-brush mode for the smudge session. The scaffolding — working buffer,
  // carried tip buffer, sampleAll pickup, dirty-rect blit, history — is
  // identical; only the per-pixel kernel differs, so the session carries an
  // optional mixer config rather than being duplicated. See mixer.ts: smudge IS
  // a mixer with Mix 100 and no reservoir.
  private smudgeMix: { m: MixerSettings; blend: number } | null = null;
  /** The loaded brush, kept BETWEEN strokes — that is what Clean / Load after
   *  each stroke are about, and it has to outlive the session to mean anything. */
  private mixerState: MixerState | null = null;

  /** The working colour space, as it is now. */
  private get cs(): PredefinedColorSpace {
    return this.host.cs();
  }

  /** The view's context — what a brush samples for "all layers". */
  private get vctx(): CanvasRenderingContext2D | null {
    return this.host.viewContext();
  }

  // ---- History brush -------------------------------------------------------
  // Repaints the active layer from its OWN pixels at the source history state.
  // Reverting must be able to REDUCE alpha (e.g. back to the blank original), so
  // it can't use source-over compositing — it uses the same coverage-mask model
  // as blur/dodge: an original snapshot + a 0–1 coverage buffer that builds with
  // flow, re-baked as a premultiplied LERP from `orig` toward the source pixels
  // by coverage × opacity. Always targets the LAYER (not a mask surface).
  private historying = false;
  private historyLayer: string | null = null;
  private historyOrig: ImageData | null = null;
  private historySource: ImageData | null = null; // pixels at the source state
  private historyCov: Float32Array | null = null;
  private historyTip: { data: Float32Array; size: number; r: number } | null = null;
  private historyOpacity = 1;
  private historyFlow = 1;
  private historySmoothing = 0;
  private historyDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private historyStep = 1;
  private historyResidual = 0;
  private historyLast = { x: 0, y: 0 };
  private historyLastRaw = { x: 0, y: 0 };
  private historySmoothPt = { x: 0, y: 0 };
  private historySelMask: Uint8ClampedArray | null = null;
  private historyLabel = "History Brush";

  beginHistory(
    layerId: string,
    brush: BrushSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
    /** History-step label. The eraser's "Erase to History" runs this exact
     *  stroke, and the undo list should name the tool the user actually used. */
    label = "History Brush",
  ) {
    if (this.w < 1 || this.h < 1) return;
    this.host.endAdjust();
    const l = this.host.layer(layerId);
    this.historying = true;
    this.historyLabel = label;
    this.historyLayer = layerId;
    this.historyOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    // The source: a pinned snapshot when one is selected (exact pixels), else
    // this layer's pixels reconstructed at the source history state.
    const src = this.historySourceSnap
      ? this.host.snapshotLayer(this.historySourceSnap, layerId)
      : this.host.reconstructLayerAt(layerId, this.historySourceIndex);
    this.historySource = src.ctx.getImageData(0, 0, this.w, this.h);
    this.historyCov = new Float32Array(this.w * this.h);
    this.historyOpacity = Math.max(0, Math.min(1, brush.opacity / 100));
    this.historyFlow = Math.max(0, Math.min(1, brush.flow / 100));
    this.historySmoothing = brush.smoothing;
    this.historySelMask = null;
    if (clip && clip.length) {
      const mask = this.host.selectionMask(clip, clipAngle, clipPivot);
      const md = mask.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      this.historySelMask = sa;
    }
    this.historyTip = this.buildCoverageTip(Math.max(0.5, brush.size / 2), brush.hardness);
    this.historyStep = Math.max(1, brush.size * 0.1);
    this.historyResidual = 0;
    this.historyDirty = null;
    this.historyLast = { x, y };
    this.historyLastRaw = { x, y };
    this.historySmoothPt = { x, y };
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stampHistory(x, y, seg);
    this.historyResidual = this.historyStep;
    if (seg.x1 >= seg.x0) this.bakeHistory(seg.x0, seg.y0, seg.x1, seg.y1);
    this.host.emitChange();
  }

  moveHistory(rawX: number, rawY: number) {
    if (!this.historying) return;
    this.historyLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.historySmoothing / 100) * 0.85;
    this.historySmoothPt.x += (rawX - this.historySmoothPt.x) * alpha;
    this.historySmoothPt.y += (rawY - this.historySmoothPt.y) * alpha;
    this.historyLineTo(this.historySmoothPt.x, this.historySmoothPt.y);
    this.host.emitChange();
  }

  private historyLineTo(x: number, y: number) {
    const dx = x - this.historyLast.x;
    const dy = y - this.historyLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let d = this.historyResidual;
    while (d <= dist) {
      const t = d / dist;
      this.stampHistory(this.historyLast.x + dx * t, this.historyLast.y + dy * t, seg);
      d += this.historyStep;
    }
    this.historyResidual = d - dist;
    this.historyLast = { x, y };
    if (seg.x1 >= seg.x0) this.bakeHistory(seg.x0, seg.y0, seg.x1, seg.y1);
  }

  /** Build coverage with flow: each dab adds `tip × flow` toward 1 (opacity caps
   *  the effect at bake time), so overlapping dabs build up like a real brush. */
  private stampHistory(
    cx: number,
    cy: number,
    seg: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const tip = this.historyTip;
    const cov = this.historyCov;
    if (!tip || !cov) return;
    const size = tip.size;
    const half = size / 2;
    const left = Math.floor(cx - half);
    const top = Math.floor(cy - half);
    const flow = this.historyFlow;
    for (let py = 0; py < size; py++) {
      const gy = top + py;
      if (gy < 0 || gy >= this.h) continue;
      for (let px = 0; px < size; px++) {
        const gx = left + px;
        if (gx < 0 || gx >= this.w) continue;
        const f = tip.data[py * size + px];
        if (f <= 0) continue;
        const idx = gy * this.w + gx;
        const c = cov[idx];
        const nc = c + (1 - c) * f * flow;
        if (nc > cov[idx]) cov[idx] = nc;
        if (gx < seg.x0) seg.x0 = gx;
        if (gy < seg.y0) seg.y0 = gy;
        if (gx > seg.x1) seg.x1 = gx;
        if (gy > seg.y1) seg.y1 = gy;
        const D = this.historyDirty;
        if (!D) this.historyDirty = { x0: gx, y0: gy, x1: gx, y1: gy };
        else {
          if (gx < D.x0) D.x0 = gx;
          if (gy < D.y0) D.y0 = gy;
          if (gx > D.x1) D.x1 = gx;
          if (gy > D.y1) D.y1 = gy;
        }
      }
    }
  }

  /** Re-bake a region as a premultiplied lerp orig → source by coverage×opacity. */
  private bakeHistory(x0: number, y0: number, x1: number, y1: number) {
    const orig = this.historyOrig;
    const src = this.historySource;
    const cov = this.historyCov;
    if (!orig || !src || !cov || this.historyLayer == null) return;
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const ax = Math.min(this.w - 1, x1);
    const ay = Math.min(this.h - 1, y1);
    const iw = ax - ix + 1;
    const ih = ay - iy + 1;
    if (iw <= 0 || ih <= 0) return;
    const od = orig.data;
    const sd = src.data;
    const sel = this.historySelMask;
    const opacity = this.historyOpacity;
    const out = new Uint8ClampedArray(iw * ih * 4);
    for (let yy = 0; yy < ih; yy++) {
      for (let xx = 0; xx < iw; xx++) {
        const gx = ix + xx;
        const gy = iy + yy;
        const ci = gy * this.w + gx;
        const oi = ci * 4;
        let m = cov[ci] * opacity;
        if (sel) m *= sel[ci] / 255;
        const doI = (yy * iw + xx) * 4;
        if (m <= 0) {
          out[doI] = od[oi];
          out[doI + 1] = od[oi + 1];
          out[doI + 2] = od[oi + 2];
          out[doI + 3] = od[oi + 3];
          continue;
        }
        // Premultiplied lerp orig → source (so reducing alpha reads clean).
        const oa = od[oi + 3];
        const sa = sd[oi + 3];
        const na = oa + (sa - oa) * m;
        const opr = od[oi] * oa + (sd[oi] * sa - od[oi] * oa) * m;
        const opg = od[oi + 1] * oa + (sd[oi + 1] * sa - od[oi + 1] * oa) * m;
        const opb = od[oi + 2] * oa + (sd[oi + 2] * sa - od[oi + 2] * oa) * m;
        const inv = na > 0 ? 1 / na : 0;
        out[doI] = opr * inv;
        out[doI + 1] = opg * inv;
        out[doI + 2] = opb * inv;
        out[doI + 3] = na;
      }
    }
    this.host.layer(this.historyLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
  }

  /**
   * The end of a retouch stroke — history brush, blur, dodge/burn, sponge,
   * smudge/mixer. Each paints its target LIVE over a snapshot of how it was
   * (`orig`), tracking the touched box (`D`). Committed, that box becomes one
   * history step. Abandoned (`commit` false: a second finger began a pinch),
   * it goes back to the snapshot and nothing is recorded — what cancelStroke
   * is to the brush, whose stroke lives in a scratch buffer instead.
   */
  private settleRetouch(
    layerId: string | null,
    onMask: boolean,
    orig: ImageData | null,
    D: { x0: number; y0: number; x1: number; y1: number } | null,
    label: string,
    commit: boolean,
  ) {
    if (!D || layerId == null || !orig) return;
    const x = Math.max(0, D.x0);
    const y = Math.max(0, D.y0);
    const w = Math.min(this.w - 1, D.x1) - x + 1;
    const h = Math.min(this.h - 1, D.y1) - y + 1;
    if (w <= 0 || h <= 0) return;
    const mid = onMask ? this.host.maskKeyOf(layerId) : layerId;
    const target = onMask ? this.masks.get(mid)! : this.host.layer(layerId);
    if (!commit) {
      // The snapshot was read from this very canvas: same size, same colour
      // space, so putting its sub-rect back is exact. A mask's alpha cache was
      // refreshed as the stroke went, so it is refreshed back. The pixel
      // version is left alone: the pixels are again exactly what it describes,
      // and nothing was cached under it mid-stroke (a live layer bypasses the
      // cache) — a bump would only throw good caches away.
      target.ctx.putImageData(orig, 0, 0, x, y, w, h);
      if (onMask) this.host.deriveMaskAlpha(mid, { x, y, w, h });
      return;
    }
    const before = this.subImage(orig, x, y, w, h);
    const after = target.ctx.getImageData(x, y, w, h);
    this.host.pushEntry(mid, { x, y, w, h }, before, after, label, undefined, onMask ? "mask" : "layer");
  }

  /** End the history-brush stroke: one step — or, with `commit` false, none,
   *  and the layer as it was (see settleRetouch). */
  endHistory(commit = true) {
    if (!this.historying) return;
    if (commit) this.historyLineTo(this.historyLastRaw.x, this.historyLastRaw.y);
    this.settleRetouch(this.historyLayer, false, this.historyOrig, this.historyDirty, this.historyLabel, commit);
    this.historying = false;
    this.historyLayer = null;
    this.historyOrig = null;
    this.historySource = null;
    this.historyCov = null;
    this.historyTip = null;
    this.historyDirty = null;
    this.historySelMask = null;
    this.host.dropWandSource();
    this.host.emitChange();
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
    this.host.endAdjust();
    // Mask surface active → the blur brush softens the MASK's pixels instead
    // (same session; grayscale target, history lands on the mask surface).
    this.blurOnMask = this.host.activeSurface(layerId) === "mask";
    const l = this.blurOnMask ? this.masks.get(this.host.maskKeyOf(layerId))! : this.host.layer(layerId);
    this.blurring = true;
    this.blurLayer = layerId;
    this.blurOpts = { ...blur };
    this.blurOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    if (blur.sampleAll && !this.blurOnMask && this.vctx) {
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
      const mask = this.host.selectionMask(clip, clipAngle, clipPivot);
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
    this.host.emitChange();
  }

  moveBlur(rawX: number, rawY: number) {
    if (!this.blurring || !this.blurOpts) return;
    this.blurLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.blurOpts.smoothing / 100) * 0.85;
    this.blurSmoothPt.x += (rawX - this.blurSmoothPt.x) * alpha;
    this.blurSmoothPt.y += (rawY - this.blurSmoothPt.y) * alpha;
    this.blurLineTo(this.blurSmoothPt.x, this.blurSmoothPt.y);
    this.host.emitChange();
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
    if (this.blurOnMask) {
      // Masks are colour-agnostic (sRGB) — untagged ImageData, then refresh the
      // alpha cache for the baked rect so the softened mask previews live.
      this.masks.get(this.host.maskKeyOf(this.blurLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.host.deriveMaskAlpha(this.host.maskKeyOf(this.blurLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.host.layer(this.blurLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
  }

  /** End the blur stroke (`commit` false: abandon it — see settleRetouch). */
  endBlur(commit = true) {
    if (!this.blurring) return;
    if (commit) this.blurLineTo(this.blurLastRaw.x, this.blurLastRaw.y);
    this.settleRetouch(this.blurLayer, this.blurOnMask, this.blurOrig, this.blurDirty, "Blur", commit);
    this.blurring = false;
    this.blurOnMask = false;
    this.blurLayer = null;
    this.blurOrig = null;
    this.blurSrc = null;
    this.blurCov = null;
    this.blurTip = null;
    this.blurOpts = null;
    this.blurDirty = null;
    this.blurSelMask = null;
    this.host.dropWandSource();
    this.host.emitChange();
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
    this.host.endAdjust();
    // Mask surface active → dodge/burn lightens/darkens the MASK (reveal/hide).
    this.dodgeOnMask = this.host.activeSurface(layerId) === "mask";
    const l = this.dodgeOnMask ? this.masks.get(this.host.maskKeyOf(layerId))! : this.host.layer(layerId);
    this.dodging = true;
    this.dodgeLayer = layerId;
    this.dodgeOpts = { ...opts };
    this.dodgeOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    this.dodgeCov = new Float32Array(this.w * this.h);
    this.dodgeSelMask = null;
    if (clip && clip.length) {
      const mask = this.host.selectionMask(clip, clipAngle, clipPivot);
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
    this.host.emitChange();
  }

  moveDodge(rawX: number, rawY: number) {
    if (!this.dodging || !this.dodgeOpts) return;
    this.dodgeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.dodgeOpts.smoothing / 100) * 0.85;
    this.dodgeSmoothPt.x += (rawX - this.dodgeSmoothPt.x) * alpha;
    this.dodgeSmoothPt.y += (rawY - this.dodgeSmoothPt.y) * alpha;
    this.dodgeLineTo(this.dodgeSmoothPt.x, this.dodgeSmoothPt.y);
    this.host.emitChange();
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
    if (this.dodgeOnMask) {
      this.masks.get(this.host.maskKeyOf(this.dodgeLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.host.deriveMaskAlpha(this.host.maskKeyOf(this.dodgeLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.host.layer(this.dodgeLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
  }

  /** End the dodge/burn stroke (`commit` false: abandon it — see settleRetouch). */
  endDodge(commit = true) {
    if (!this.dodging) return;
    if (commit) this.dodgeLineTo(this.dodgeLastRaw.x, this.dodgeLastRaw.y);
    const label = this.dodgeOpts?.mode === "burn" ? "Burn" : "Dodge";
    this.settleRetouch(this.dodgeLayer, this.dodgeOnMask, this.dodgeOrig, this.dodgeDirty, label, commit);
    this.dodging = false;
    this.dodgeOnMask = false;
    this.dodgeLayer = null;
    this.dodgeOrig = null;
    this.dodgeCov = null;
    this.dodgeTip = null;
    this.dodgeOpts = null;
    this.dodgeDirty = null;
    this.dodgeSelMask = null;
    this.host.dropWandSource();
    this.host.emitChange();
  }

  // ---- Sponge brush (saturate / desaturate) --------------------------------
  // Structurally identical to dodge/burn: an original snapshot plus a 0–1
  // coverage buffer, each affected region re-baked from the original so a
  // stroke stays even and repeated strokes compound. `bakeSponge` is the only
  // difference — it pushes chroma toward or away from luma.
  beginSponge(
    layerId: string,
    opts: SpongeSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    if (this.w < 1 || this.h < 1) return;
    this.host.endAdjust();
    this.spongeOnMask = this.host.activeSurface(layerId) === "mask";
    const l = this.spongeOnMask ? this.masks.get(this.host.maskKeyOf(layerId))! : this.host.layer(layerId);
    this.sponging = true;
    this.spongeLayer = layerId;
    this.spongeOpts = { ...opts };
    this.spongeOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    this.spongeCov = new Float32Array(this.w * this.h);
    this.spongeSelMask = null;
    if (clip && clip.length) {
      const mask = this.host.selectionMask(clip, clipAngle, clipPivot);
      const md = mask.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      this.spongeSelMask = sa;
    }
    this.spongeTip = this.buildCoverageTip(Math.max(0.5, opts.size / 2), opts.hardness);
    this.spongeStep = Math.max(1, opts.size * (opts.spacing / 100));
    this.spongeResidual = 0;
    this.spongeDirty = null;
    this.spongeLast = { x, y };
    this.spongeLastRaw = { x, y };
    this.spongeSmoothPt = { x, y };
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stampSponge(x, y, seg);
    this.spongeResidual = this.spongeStep;
    if (seg.x1 >= seg.x0) this.bakeSponge(seg.x0, seg.y0, seg.x1, seg.y1);
    this.host.emitChange();
  }

  moveSponge(rawX: number, rawY: number) {
    if (!this.sponging || !this.spongeOpts) return;
    this.spongeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.spongeOpts.smoothing / 100) * 0.85;
    this.spongeSmoothPt.x += (rawX - this.spongeSmoothPt.x) * alpha;
    this.spongeSmoothPt.y += (rawY - this.spongeSmoothPt.y) * alpha;
    this.spongeLineTo(this.spongeSmoothPt.x, this.spongeSmoothPt.y);
    this.host.emitChange();
  }

  private spongeLineTo(x: number, y: number) {
    const dx = x - this.spongeLast.x;
    const dy = y - this.spongeLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let d = this.spongeResidual;
    while (d <= dist) {
      const t = d / dist;
      this.stampSponge(this.spongeLast.x + dx * t, this.spongeLast.y + dy * t, seg);
      d += this.spongeStep;
    }
    this.spongeResidual = d - dist;
    this.spongeLast = { x, y };
    if (seg.x1 >= seg.x0) this.bakeSponge(seg.x0, seg.y0, seg.x1, seg.y1);
  }

  private stampSponge(
    cx: number,
    cy: number,
    seg: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const tip = this.spongeTip;
    const cov = this.spongeCov;
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
        const D = this.spongeDirty;
        if (!D) this.spongeDirty = { x0: gx, y0: gy, x1: gx, y1: gy };
        else {
          if (gx < D.x0) D.x0 = gx;
          if (gy < D.y0) D.y0 = gy;
          if (gx > D.x1) D.x1 = gx;
          if (gy > D.y1) D.y1 = gy;
        }
      }
    }
  }

  /** Re-bake one region as saturate/desaturate(orig) by coverage × flow. */
  private bakeSponge(x0: number, y0: number, x1: number, y1: number) {
    const orig = this.spongeOrig;
    const cov = this.spongeCov;
    const opts = this.spongeOpts;
    if (!orig || !cov || !opts || this.spongeLayer == null) return;
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const ax = Math.min(this.w - 1, x1);
    const ay = Math.min(this.h - 1, y1);
    const iw = ax - ix + 1;
    const ih = ay - iy + 1;
    if (iw <= 0 || ih <= 0) return;
    const od = orig.data;
    const sel = this.spongeSelMask;
    const flow = opts.flow / 100;
    const desat = opts.mode === "desaturate";
    const vibrance = opts.vibrance;
    const MASTER = 0.6; // flow 100% in-range ≈ a 60% push per full-coverage pass
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
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        let k = m * flow * MASTER;
        if (k > 0.95) k = 0.95;
        let nr: number;
        let ng: number;
        let nb: number;
        if (desat) {
          nr = r + (gray - r) * k;
          ng = g + (gray - g) * k;
          nb = b + (gray - b) * k;
        } else {
          // Saturate: push chroma away from luma. Vibrance eases the push on
          // already-saturated pixels so they don't clip to a flat primary.
          if (vibrance) {
            const maxc = r > g ? (r > b ? r : b) : g > b ? g : b;
            const minc = r < g ? (r < b ? r : b) : g < b ? g : b;
            const s = maxc > 0 ? (maxc - minc) / maxc : 0; // 0..1
            k *= 1 - s;
          }
          nr = r + (r - gray) * k;
          ng = g + (g - gray) * k;
          nb = b + (b - gray) * k;
        }
        out[doI] = nr;
        out[doI + 1] = ng;
        out[doI + 2] = nb;
        out[doI + 3] = od[oi + 3];
      }
    }
    if (this.spongeOnMask) {
      this.masks.get(this.host.maskKeyOf(this.spongeLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.host.deriveMaskAlpha(this.host.maskKeyOf(this.spongeLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.host.layer(this.spongeLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
  }

  /** End the sponge stroke (`commit` false: abandon it — see settleRetouch). */
  endSponge(commit = true) {
    if (!this.sponging) return;
    if (commit) this.spongeLineTo(this.spongeLastRaw.x, this.spongeLastRaw.y);
    this.settleRetouch(this.spongeLayer, this.spongeOnMask, this.spongeOrig, this.spongeDirty, "Sponge", commit);
    this.sponging = false;
    this.spongeOnMask = false;
    this.spongeLayer = null;
    this.spongeOrig = null;
    this.spongeCov = null;
    this.spongeTip = null;
    this.spongeOpts = null;
    this.spongeDirty = null;
    this.spongeSelMask = null;
    this.host.dropWandSource();
    this.host.emitChange();
  }

  // ---- Smudge brush (drag colour along the stroke) -------------------------
  // A stateful smear, so NOT the coverage model: the layer bytes are mutated in
  // place (a working copy blitted per segment), and a tip-sized "carried" RGBA
  // buffer holds the colour the finger drags — deposited each dab, then refreshed
  // from the pixels beneath (pickup). `strength` sets how long the colour is
  // carried (pickup = 1 − strength); premultiplied blending keeps soft edges clean.
  beginSmudge(
    layerId: string,
    opts: SmudgeSettings,
    x: number,
    y: number,
    fingerColor: { r: number; g: number; b: number; a: number } | null = null,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    if (this.w < 1 || this.h < 1) return;
    this.host.endAdjust();
    this.smudgeOnMask = this.host.activeSurface(layerId) === "mask";
    const l = this.smudgeOnMask ? this.masks.get(this.host.maskKeyOf(layerId))! : this.host.layer(layerId);
    this.smudging = true;
    this.smudgeLayer = layerId;
    this.smudgeOpts = { ...opts };
    this.smudgeOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    const data = new Uint8ClampedArray(this.smudgeOrig.data);
    this.smudgeData = data;
    // Wrap the SAME buffer so a dirty-rect putImageData repaints only the dab.
    this.smudgeImage = this.smudgeOnMask
      ? new ImageData(data, this.w, this.h)
      : new ImageData(data, this.w, this.h, { colorSpace: this.cs });
    // Sample-all pickup source (static composite snapshot); layer smudging only.
    this.smudgePickup = null;
    if (opts.sampleAll && !this.smudgeOnMask && this.vctx) {
      try {
        this.smudgePickup = this.vctx.getImageData(0, 0, this.w, this.h).data;
      } catch {
        this.smudgePickup = null;
      }
    }
    this.smudgeSelMask = null;
    if (clip && clip.length) {
      const mask = this.host.selectionMask(clip, clipAngle, clipPivot);
      const md = mask.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      const sa = new Uint8ClampedArray(this.w * this.h);
      for (let i = 0; i < sa.length; i++) sa[i] = md[i * 4 + 3];
      this.smudgeSelMask = sa;
    }
    const tip = this.buildCoverageTip(Math.max(0.5, opts.size / 2), opts.hardness);
    this.smudgeTip = tip;
    this.smudgeStep = Math.max(1, opts.size * (opts.spacing / 100));
    this.smudgeResidual = 0;
    this.smudgeDirty = null;
    this.smudgeLast = { x, y };
    this.smudgeLastRaw = { x, y };
    this.smudgeSmoothPt = { x, y };
    // Seed the carried colour: the foreground (finger painting) or the pixels
    // under the brush at the start point.
    const size = tip.size;
    const carried = new Float32Array(size * size * 4);
    this.smudgeCarried = carried;
    const src = this.smudgePickup ?? data;
    const half = size / 2;
    const left = Math.floor(x - half);
    const top = Math.floor(y - half);
    for (let py = 0; py < size; py++) {
      const gy = top + py;
      for (let px = 0; px < size; px++) {
        const gx = left + px;
        const coff = (py * size + px) * 4;
        if (fingerColor) {
          carried[coff] = fingerColor.r;
          carried[coff + 1] = fingerColor.g;
          carried[coff + 2] = fingerColor.b;
          carried[coff + 3] = fingerColor.a;
        } else if (gx >= 0 && gx < this.w && gy >= 0 && gy < this.h) {
          const gi = (gy * this.w + gx) * 4;
          carried[coff] = src[gi];
          carried[coff + 1] = src[gi + 1];
          carried[coff + 2] = src[gi + 2];
          carried[coff + 3] = src[gi + 3];
        } // else off-canvas → stays transparent (0)
      }
    }
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.stampSmudge(x, y, seg);
    this.smudgeResidual = this.smudgeStep;
    if (seg.x1 >= seg.x0) this.blitSmudge(seg.x0, seg.y0, seg.x1, seg.y1);
    this.host.emitChange();
  }

  moveSmudge(rawX: number, rawY: number) {
    if (!this.smudging || !this.smudgeOpts) return;
    this.smudgeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.smudgeOpts.smoothing / 100) * 0.85;
    this.smudgeSmoothPt.x += (rawX - this.smudgeSmoothPt.x) * alpha;
    this.smudgeSmoothPt.y += (rawY - this.smudgeSmoothPt.y) * alpha;
    this.smudgeLineTo(this.smudgeSmoothPt.x, this.smudgeSmoothPt.y);
    this.host.emitChange();
  }

  private smudgeLineTo(x: number, y: number) {
    const dx = x - this.smudgeLast.x;
    const dy = y - this.smudgeLast.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const seg = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let d = this.smudgeResidual;
    while (d <= dist) {
      const t = d / dist;
      this.stampSmudge(this.smudgeLast.x + dx * t, this.smudgeLast.y + dy * t, seg);
      d += this.smudgeStep;
    }
    this.smudgeResidual = d - dist;
    this.smudgeLast = { x, y };
    if (seg.x1 >= seg.x0) this.blitSmudge(seg.x0, seg.y0, seg.x1, seg.y1);
  }

  /** One dab: deposit the carried colour (premultiplied), then refresh it from
   *  the underlying pixels. Mutates smudgeData; grows the segment + total dirty. */
  private stampSmudge(
    cx: number,
    cy: number,
    seg: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const tip = this.smudgeTip;
    const carried = this.smudgeCarried;
    const data = this.smudgeData;
    const opts = this.smudgeOpts;
    if (!tip || !carried || !data || !opts) return;
    const size = tip.size;
    const half = size / 2;
    const left = Math.floor(cx - half);
    const top = Math.floor(cy - half);
    const w = this.w;
    const h = this.h;
    const pick = this.smudgePickup; // sampleAll composite, else the live layer
    const sel = this.smudgeSelMask;
    const mixCfg = this.smudgeMix;
    // Mixer mode: the reservoir is updated ONCE per dab from the tip-weighted
    // average under the tip (premultiplied — see averageColor), and supplies the
    // dab's strength. Smudge mode keeps its own pickup rate.
    let deposit = 1;
    let mixBlend = 0;
    let paint: Rgba | null = null;
    let pickup = 0;
    if (mixCfg) {
      const src = pick ?? data;
      const avg = averageColor(src, tip.data, size, this.w, left, top, this.w, h);
      const step = mixerDab(this.mixerState!, avg, avg, mixCfg.m);
      this.mixerState = step.next;
      deposit = step.alpha;
      mixBlend = mixCfg.blend;
      paint = this.mixerState.paint;
      pickup = Math.max(0, Math.min(1, mixCfg.m.wet / 100));
    } else {
      const strength = opts.strength / 100;
      pickup = 1 - strength; // high strength → carried persists → long smear
    }
    for (let py = 0; py < size; py++) {
      const gy = top + py;
      if (gy < 0 || gy >= h) continue;
      for (let px = 0; px < size; px++) {
        const gx = left + px;
        if (gx < 0 || gx >= w) continue;
        const f = tip.data[py * size + px];
        if (f <= 0) continue;
        const coff = (py * size + px) * 4;
        const gi = (gy * w + gx) * 4;
        // Underlying colour (pre-deposit) — the pickup source.
        const ur = pick ? pick[gi] : data[gi];
        const ug = pick ? pick[gi + 1] : data[gi + 1];
        const ub = pick ? pick[gi + 2] : data[gi + 2];
        const ua = pick ? pick[gi + 3] : data[gi + 3];
        let lay = f * deposit;
        if (sel) lay *= sel[gy * w + gx] / 255;
        if (lay > 0) {
          // Mixer: the paint laid down is the reservoir pulled toward what this
          // part of the tip picked up. Blended per pixel because the carried
          // buffer varies across the tip — a soft edge that dragged through two
          // colours must lay both back down, not one averaged smear.
          const cr = paint ? paint.r + (carried[coff] - paint.r) * mixBlend : carried[coff];
          const cg = paint ? paint.g + (carried[coff + 1] - paint.g) * mixBlend : carried[coff + 1];
          const cb = paint ? paint.b + (carried[coff + 2] - paint.b) * mixBlend : carried[coff + 2];
          const ca = paint ? paint.a + (carried[coff + 3] - paint.a) * mixBlend : carried[coff + 3];
          const dr = data[gi];
          const dg = data[gi + 1];
          const db = data[gi + 2];
          const da = data[gi + 3];
          // Premultiplied lerp: data → carried by `lay`.
          const oa = da + (ca - da) * lay;
          const opr = dr * da + (cr * ca - dr * da) * lay;
          const opg = dg * da + (cg * ca - dg * da) * lay;
          const opb = db * da + (cb * ca - db * da) * lay;
          const inv = oa > 0 ? 1 / oa : 0;
          data[gi] = opr * inv;
          data[gi + 1] = opg * inv;
          data[gi + 2] = opb * inv;
          data[gi + 3] = oa;
        }
        // Pickup: the finger absorbs some of the underlying colour.
        const pk = pickup * f;
        if (pk > 0) {
          carried[coff] += (ur - carried[coff]) * pk;
          carried[coff + 1] += (ug - carried[coff + 1]) * pk;
          carried[coff + 2] += (ub - carried[coff + 2]) * pk;
          carried[coff + 3] += (ua - carried[coff + 3]) * pk;
        }
        if (gx < seg.x0) seg.x0 = gx;
        if (gy < seg.y0) seg.y0 = gy;
        if (gx > seg.x1) seg.x1 = gx;
        if (gy > seg.y1) seg.y1 = gy;
        const D = this.smudgeDirty;
        if (!D) this.smudgeDirty = { x0: gx, y0: gy, x1: gx, y1: gy };
        else {
          if (gx < D.x0) D.x0 = gx;
          if (gy < D.y0) D.y0 = gy;
          if (gx > D.x1) D.x1 = gx;
          if (gy > D.y1) D.y1 = gy;
        }
      }
    }
  }

  /** Blit only the touched sub-rect of the working buffer to the layer/mask. */
  private blitSmudge(x0: number, y0: number, x1: number, y1: number) {
    const img = this.smudgeImage;
    if (!img || this.smudgeLayer == null) return;
    const ix = Math.max(0, x0);
    const iy = Math.max(0, y0);
    const ax = Math.min(this.w - 1, x1);
    const ay = Math.min(this.h - 1, y1);
    const iw = ax - ix + 1;
    const ih = ay - iy + 1;
    if (iw <= 0 || ih <= 0) return;
    if (this.smudgeOnMask) {
      const mid = this.host.maskKeyOf(this.smudgeLayer);
      this.masks.get(mid)!.ctx.putImageData(img, 0, 0, ix, iy, iw, ih);
      this.host.deriveMaskAlpha(mid, { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.host.layer(this.smudgeLayer).ctx.putImageData(img, 0, 0, ix, iy, iw, ih);
    }
  }

  /**
   * Begin a mixer-brush stroke.
   *
   * Runs the smudge session with a mixer kernel: the tip drags a picked-up
   * colour buffer exactly as smudge does, but what it lays down is a blend of
   * that with a paint reservoir, and the reservoir is spent and replenished as
   * it goes (mixer.ts owns all of that arithmetic).
   */
  beginMixer(
    layerId: string,
    opts: MixerSettings,
    x: number,
    y: number,
    fg: { r: number; g: number; b: number; a: number },
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    // A stroke always starts from a defined reservoir; without a previous one
    // (first stroke of the session) that means a freshly loaded brush.
    // Clean / Load are resolved HERE, at the start of the next stroke, rather
    // than when the previous one ended. Same rule, but evaluated against the
    // CURRENT foreground — resolving it at lift meant the brush reloaded with
    // whatever colour was selected then, so picking a new colour and painting
    // again silently kept using the old one.
    this.mixerState = this.mixerState
      ? mixerAfterStroke(this.mixerState, fg, opts)
      : initialMixerState(fg, opts);
    this.smudgeMix = { m: { ...opts }, blend: mixerBlend(opts) };
    // The shared scaffolding only reads the mechanical fields. `strength` is
    // unused in mixer mode (the kernel branches before it), and fingerColor is
    // null so the carried buffer seeds from the canvas — a mixer picks up what
    // it is passing over, and the reservoir is what supplies the paint.
    this.beginSmudge(
      layerId,
      {
        size: opts.size,
        hardness: opts.hardness,
        strength: 50,
        spacing: opts.spacing,
        smoothing: opts.smoothing,
        sampleAll: opts.sampleAll,
        fingerPaint: false,
      },
      x,
      y,
      null,
      clip,
      clipAngle,
      clipPivot,
    );
  }

  /** Reset the loaded brush (tool switch / explicit Clean). */
  cleanMixer() {
    this.mixerState = null;
  }

  /** End the smudge / mixer stroke (`commit` false: abandon it — see
   *  settleRetouch). */
  endSmudge(commit = true) {
    if (!this.smudging) return;
    if (commit) this.smudgeLineTo(this.smudgeLastRaw.x, this.smudgeLastRaw.y);
    const label = this.smudgeMix ? "Mixer Brush" : "Smudge";
    this.settleRetouch(this.smudgeLayer, this.smudgeOnMask, this.smudgeOrig, this.smudgeDirty, label, commit);
    this.smudging = false;
    this.smudgeOnMask = false;
    this.smudgeLayer = null;
    this.smudgeOrig = null;
    this.smudgeData = null;
    this.smudgeImage = null;
    this.smudgePickup = null;
    this.smudgeCarried = null;
    this.smudgeTip = null;
    this.smudgeOpts = null;
    this.smudgeDirty = null;
    this.smudgeSelMask = null;
    this.smudgeMix = null;
    this.host.dropWandSource();
    this.host.emitChange();
  }
}
