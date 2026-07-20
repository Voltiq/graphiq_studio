import { parseColor, toHex8 } from "./color";
import type { Rect } from "./view";
import { blendOp, clipGroupsOf, filterMaskKey, type ClipGroup } from "./layers";
import type { ActiveSurface, LayerAdjustment, LayerGroup, LayerNode } from "./layers";
import { applyAdjustments, applyAdjustments16, isDefaultAdjust, type Adjustments } from "./adjust";
import { applyExtraAdjustment, extraIsDefault, isExtraSpec, type ExtraAdjustment } from "./adjust-extra";
import { removeRedEyeInPlace } from "./redeye";
import { renderShape, type ShapeGeom } from "./shapes";
import { boxBlurPass, clampi } from "./blur";
import { fxHash, hasEnabledFx, renderStyled } from "./effects";
import {
  clampRect,
  fnv,
  rectsOverlap,
  selectEvictions,
  TILE_ID_SEP,
  tileGrid,
  tileRect,
  unionRect,
  type RenderNodeCache,
  type TileGrid,
} from "./render-graph";
import {
  applyFilter,
  computeBlurFx,
  filterStackHash,
  hasEnabledFilters,
  scaleFilterParams,
  type SmartFilter,
} from "./filters";
import {
  adobe16ToSrgbBytes,
  adobeToSrgbInPlace,
  canvasSpaceOf,
  proofIsIdentity,
  proofTransformInPlace,
  srgbBytesToAdobe16,
  srgbToAdobeInPlace,
  type ProofTarget,
  type WorkingSpace,
} from "./colorspace";
import { GpuToneRenderer } from "./gpu";
import { healPadding, healRegion } from "./heal";
import { buildCanvasGradient } from "./gradient";
import {
  applyToneLUTs,
  applyToneLUTs16,
  buildCurvesLUTs,
  buildCurvesLUTs16,
  buildLevelsLUTs,
  buildLevelsLUTs16,
  type ToneAdjustment,
  type ToneLUTs,
  type ToneLUTs16,
} from "./tone";
import { renderPenStroke } from "./pen";
import { baseRunStyle, cssFontString, fontFeatureCSS, layoutRuns, type MeasureFn } from "./richtext";
import type {
  BlurSettings,
  DodgeSettings,
  GradientStop,
  GradientType,
  PenAnchor,
  PenSettings,
  ShapeKind,
  TextAlign,
  TextAxes,
  TextOpenType,
  TextRun,
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
  /** Luminosity (Rec.709 weights) bins. */
  l: number[];
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
  /** Rasterize a polygon into selection rects + ants (Paths panel). */
  lassoSelect: (points: { x: number; y: number }[]) => WandSelection | null;
  /** Combine two selections at the pixel level (add/subtract). */
  combineSelection: (base: Rect[], region: Rect[], mode: "add" | "subtract") => WandSelection | null;
  /** Stroke a pen path onto a layer as one undoable "Path" step (Paths panel). */
  strokePath: (
    layerId: string,
    anchors: PenAnchor[],
    closed: boolean,
    settings: PenSettings,
    color: string,
  ) => void;
  /** Replay a recorded paint stroke (Actions panel) through the live stroke
   *  pipeline — one undoable step, clipped to the given selection. */
  playStroke: (
    layerId: string,
    tool: "brush" | "pencil" | "eraser",
    settings: BrushSettings,
    color: string,
    points: { x: number; y: number }[],
    sel: Rect[] | null,
    angle: number,
    pivot: { x: number; y: number } | null,
  ) => void;
  isFloating: () => boolean;
  commitFloat: () => void;
  discardFloat: () => void;
  duplicateLayer: (srcId: string, dstId: string) => void;
  rasterize: (targetId: string, nodes: LayerNode[], deleteIds: string[]) => void;
  removeLayer: (id: string) => void;
  getLayerImage: (id: string) => string | null;
  /** Doc-sized copy of a layer's raster (blank canvas if none yet). */
  getLayerCanvas: (id: string) => HTMLCanvasElement;
  getMaskImage: (id: string) => string | null;
  setMaskImage: (id: string, source: CanvasImageSource) => void;
  setLayerImage: (id: string, source: CanvasImageSource, x?: number, y?: number) => void;
  /** Replace a layer's pixels as one undoable history step (HDR re-tonemap…). */
  applyLayerImage: (id: string, source: CanvasImageSource, label: string) => void;
  exportComposite: (tree: LayerNode[]) => HTMLCanvasElement;
  /** Per-channel + luminosity tonal distribution of the composited canvas —
   *  scoped to the selection when one is passed. */
  histogram: (
    tree: LayerNode[],
    sel?: Rect[] | null,
    selAngle?: number,
    selPivot?: { x: number; y: number } | null,
  ) => ChannelHistogram;
  /** Tonal distribution of a layer's mask (effective grayscale); null = no mask. */
  maskHistogram: (id: string, surface?: "mask" | "filterMask") => Uint32Array | null;
  /** Show a mask grayscale on the canvas instead of the composite (null = off). */
  setMaskView: (id: string | null, surface?: "mask" | "filterMask") => void;
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
    extra?: { band: number; feather: number; threshold: number },
  ) => void;
  /** Off-thread preview (worker; sync fallback). Resolves false if superseded. */
  previewBlurFxAsync: (
    kind: string,
    amount: number,
    angle: number,
    anchorX?: number,
    anchorY?: number,
    extra?: { band: number; feather: number; threshold: number },
  ) => Promise<boolean>;
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
  /** Destructive Curves/Levels live preview (same session as applyAdjust). */
  previewTone: (
    layerId: string,
    spec: ToneAdjustment,
    sel?: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => void;
  /** Finalize the live adjustment session, keeping its history entry. */
  endAdjust: () => void;
  /** Discard the live adjustment session (restore original, drop its entry). */
  revertAdjust: () => void;
  setColorSpace: (ws: WorkingSpace) => void;
  setProofing: (simulate: boolean, warn: boolean, target: ProofTarget) => void;
  captureLeaves: (ids: string[]) => Map<string, LeafSnapshot>;
  restoreLeaves: (snaps: Map<string, LeafSnapshot>) => void;
  pushStructural: (label: string, undo: () => void, redo: () => void) => void;
  // ---- Layer masks (pixel lifecycle; history coordinated by the caller) ----
  hasMask: (id: string) => boolean;
  allocMask: (
    id: string,
    init: "reveal" | "hide" | "selection",
    rects?: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => void;
  freeMask: (id: string) => void;
  captureMask: (id: string) => ImageData | null;
  restoreMask: (id: string, img: ImageData) => void;
  applyMaskToLayer: (id: string) => void;
  offsetMask: (id: string, dx: number, dy: number) => void;
  maskSelectionRects: (id: string) => Rect[];
  setActiveSurface: (id: string, surface: ActiveSurface) => void;
  getActiveSurface: (id: string) => ActiveSurface;
  /** Spec 07: bake a smart-filter stack into pixels (one combined step). */
  applySmartFilters: (layerId: string, filters: SmartFilter[], side?: HistorySide, useFilterMask?: boolean) => void;
  /** Anchored canvas reframe (Canvas Size dialog) — call before the dims patch. */
  resizeCanvasAnchored: (w: number, h: number, dx: number, dy: number, ownLayerIds?: string[]) => void;
  /** Fill the selection with synthesized surrounding content (one entry). */
  contentAwareFill: (
    layerId: string,
    sel: Rect[],
    selAngle?: number,
    selPivot?: { x: number; y: number } | null,
  ) => void;
  /** Red-eye click: neutralize + darken the red pupil blob near (x, y). */
  redEye: (
    layerId: string,
    x: number,
    y: number,
    size: number,
    darken: number,
    sel?: Rect[] | null,
    selAngle?: number,
    selPivot?: { x: number; y: number } | null,
  ) => boolean;
  /** Spec 06 debug: toggle the render cache for A/B pixel-identity checks. */
  setRenderCacheEnabled: (on: boolean) => void;
  renderCacheStats: () => {
    enabled: boolean;
    entries: number;
    bytes: number;
    budget: number;
    hits: number;
    misses: number;
    /** Resident tiles across tiled products (large documents; 0 = untiled). */
    tiles: number;
  };
  setRenderCacheBudget: (mb: number) => void;
  setHistoryLimit: (n: number) => void;
  setWorkersEnabled: (on: boolean) => void;
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

// BLEND_MAP / blendOp moved to layers.ts (shared with the filters worker).

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

/** One resident tile of a tiled adjustment product (its own LRU entry). */
interface AdjTile {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  bytes: number;
  tick: number;
}

/** A cached adjustment product stored as a tile grid (very large documents). */
interface TiledAdjProduct {
  key: string;
  grid: TileGrid;
  tiles: (AdjTile | null)[];
  bytes: number;
  tick: number;
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
  align: TextAlign;
  lineHeight: number;
  tracking: number;
  color: string;
  /** Anti-alias edges; false thresholds the alpha to hard 1-bit edges. */
  antialias: boolean;
  /** Rich runs (mixed fonts/sizes/colours) covering `text` exactly; absent =
   *  the uniform legacy path using the flat fields above. */
  runs?: TextRun[];
  /** OpenType feature toggles (block-level; absent = the font's defaults). */
  features?: TextOpenType;
  /** Variable-font axes (block-level; wght overrides `bold`). */
  axes?: TextAxes;
}

/** Pre-crop layer pixels + document size, captured so a crop can be undone. */
export interface CropSnapshot {
  w: number;
  h: number;
  layers: { id: string; c: HTMLCanvasElement }[];
  /** Per-layer masks (grayscale) present at snapshot time, for crop undo/redo. */
  masks?: { id: string; c: HTMLCanvasElement }[];
}

/** A structural-history snapshot of one leaf: its pixels plus its mask grayscale
 *  (either may be null when absent). Lets layer add/delete/duplicate undo restore
 *  both surfaces; the mask *metadata* is restored separately via the layer tree. */
export interface LeafSnapshot {
  layer: ImageData | null;
  mask: ImageData | null;
  /** The smart-filter mask grayscale (Spec 07 addendum), when the leaf has one. */
  fmMask?: ImageData | null;
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
  // Which surface the pixel payload patches; absent ⇒ "layer" (back-compat).
  surface?: "layer" | "mask";
}

// (premultChannels + computeBlurFx moved to filters.ts — shared by the Blur
// Gallery and the blur smart-filter type.)

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
  private cs: PredefinedColorSpace = "srgb"; // canvas (storage/display) space
  private ws: WorkingSpace = "srgb"; // working space (adjustment math)
  // Soft proofing (VIEW-only): simulate the target space / mark its gamut.
  private proofTarget: ProofTarget = "srgb";
  private proofSimulate = false;
  private gamutWarn = false;

  // --- Layer masks (non-destructive) -----------------------------------------
  // Grayscale mask per layer id (R=G=B=value); absent ⇒ no mask. Colour-agnostic
  // (always sRGB) — never gamut-converted — and editable by the brush pipeline.
  private masks = new Map<string, Layer>();
  // Derived alpha cache per id (RGB=0, A=coverage). Recomputed only on mask
  // mutation, scoped to the changed rect — never per composite frame. The mask's
  // own alpha is folded in (A = R × maskAlpha/255) so eraser strokes read right.
  private maskAlpha = new Map<string, Layer>();
  // Which surface paint tools target, per layer ("pixels" default; "mask" only
  // while that layer has a mask).
  private surfaces = new Map<string, ActiveSurface>();
  // True while the in-progress stroke paints the mask (set in beginStroke).
  private strokeOnMask = false;
  // Reused buffers for the live mask-paint preview (grayscale + derived alpha).
  private maskPrevG: Layer | null = null;
  private maskPrevA: Layer | null = null;
  // Mask VIEW mode (Alt-click a mask chip / Channels panel): while set, the
  // view canvas shows this mask's grayscale instead of the composite.
  private maskView: { id: string; surface: "mask" | "filterMask" } | null = null;
  // Reused scratch for the per-node masked composite (src ⊗ mask alpha).
  private maskTmp: Layer | null = null;
  // Reused buffers for the adjustment-layer composite (offscreen accumulator that
  // adjustment nodes read back, plus the adjusted/modulation/clip-base scratch).
  private adjBufs: { [k: string]: Layer | undefined } = {};

  // --- Render graph (Spec 06) -------------------------------------------------
  // ONE per-node cache of intrinsic renders (a node's own composited pixels —
  // mask/effects folded in, opacity/blend NOT). Every entry is keyed by a hash
  // of exactly what it depends on (see nodeKey/effectiveKey); an entry is valid
  // iff its stored key still matches, so invalidation is automatic: bumping a
  // version changes the keys of the node and every dependent (parents via
  // childrenSig, adjustments above via belowSig) and they simply miss.
  // Caches are an optimization, never truth — dropping any entry only costs time.
  private renderCache = new Map<string, RenderNodeCache>();
  private renderCacheOn = true; // debug A/B toggle (disabled ⇒ full recompute)
  private renderTick = 0; // LRU clock
  private renderBytes = 0; // owned bytes currently cached
  private renderBudget = 256 * 1024 * 1024; // LRU eviction beyond this (Preferences ▸ Performance)
  private cacheHits = 0;
  private cacheMisses = 0;
  private historyLimit = 60; // max undoable steps kept (Preferences ▸ Performance)
  private workersOn = true; // background compute (blur/filters/heal) toggle
  private frameProtect = new Set<string>(); // entries used by the current frame
  private keyMemo = new Map<string, string>(); // per-composite effectiveKey memo
  private liveBypass = new Set<string>(); // live layer ids + their ancestor path
  // Pending dirty region (document space) + whether the next view blit must be
  // full. Partial blits are only taken when the tree reference is unchanged
  // (same immutable tree ⇒ no structural/props change slipped past the rects).
  private pendingDirty: Rect | null = null;
  private lastTree: LayerNode[] | null = null;
  // Monotonic per-layer pixel version (bumped on any committed pixel write), a
  // per-id mask version (bumped on any mask mutation), and a document epoch
  // (bumped on resize/crop/transform/colour-space) — the key ingredients.
  private pixelVersion = new Map<string, number>();
  private maskVersion = new Map<string, number>();
  private docEpoch = 0;
  // Compiled Curves/Levels LUTs per adjustment-node id, keyed by the spec JSON.
  // (Param→LUT math memo, not a pixel cache — stays separate from renderCache.)
  private toneCache = new Map<string, { key: string; luts: ToneLUTs; luts16?: ToneLUTs16 }>();
  // The tree the current/last composite ran against (for dirty-region proofs).
  private curTree: LayerNode[] | null = null;
  // Dirty-region bookkeeping per cached ADJUSTMENT product: which document
  // region changed beneath it since the product was cached, and the state it
  // was cached against. Lets a key miss re-process only that region instead of
  // the whole document (adjustments are strictly per-pixel, so this is exact).
  private adjMeta = new Map<
    string,
    { ownSig: string; tree: LayerNode[]; dirty: Rect | null; unbounded: boolean }
  >();
  // Tiled adjustment products (very large documents — see render-graph.ts).
  // On docs where one full product would rival the whole cache budget, the
  // cached accumulator is stored as a grid of tiles instead of one canvas:
  // eviction frees single tiles, and a missing/stale tile is recomputed alone
  // from the below-accumulator (adjustment math is strictly per-pixel, so a
  // tile recompute is byte-identical to the full pass inside that tile).
  // Entries share adjMeta with the whole-canvas path — exactly one of the two
  // paths ever runs for a given document size.
  private tiledAdj = new Map<string, TiledAdjProduct>();

  /** Mark a layer's pixels changed: its key (and every dependent's) changes, so
   *  caches miss next composite. `rect` bounds the change for the view blit and
   *  for region-scoped adjustment recompute — but only when the change really
   *  is local (see changeReaches: effects/filters spread pixels past the rect). */
  private bumpPixel(id: string, rect?: Rect) {
    this.pixelVersion.set(id, (this.pixelVersion.get(id) ?? 0) + 1);
    this.dropCache(id);
    const bounded = rect && !this.changeReaches(id, "pixel") ? rect : null;
    this.pendingDirty = unionRect(this.pendingDirty, bounded);
    if (!bounded) this.lastTree = null; // unbounded change → next blit is full
    this.noteBelowChange(bounded);
  }

  /** Mark a node's mask changed (same key mechanics as bumpPixel). A plain
   *  layer mask multiplies the FINAL styled render, so its change is per-pixel;
   *  a filter mask (fm:*) feeds the filter stack and inherits its reach. */
  private bumpMask(id: string, rect?: Rect) {
    this.maskVersion.set(id, (this.maskVersion.get(id) ?? 0) + 1);
    this.dropCache(id, true);
    const bounded = rect && !this.changeReaches(id, "mask") ? rect : null;
    this.pendingDirty = unionRect(this.pendingDirty, bounded);
    if (!bounded) this.lastTree = null;
    this.noteBelowChange(bounded);
  }

  /** Does a rect-bounded change on `id` alter rendered pixels OUTSIDE the rect?
   *  True when the node's own render spreads pixels (enabled smart filters for
   *  any change; layer effects for pixel changes — a shadow/glow follows the
   *  silhouette) or when ANY ancestor group is styled. Unknown ids (no tree
   *  seen yet) are conservatively treated as reaching. */
  private changeReaches(id: string, kind: "pixel" | "mask"): boolean {
    const tree = this.curTree;
    if (!tree) return true;
    const fm = id.startsWith("fm:");
    const target = fm ? id.slice(3) : id;
    let reach = true; // stays true when the id isn't in the tree (conservative)
    const walk = (nodes: LayerNode[], ancStyled: boolean): boolean => {
      for (const n of nodes) {
        const own = hasEnabledFx(n.effects) || hasEnabledFilters(n.filters);
        if (n.id === target) {
          if (ancStyled) reach = true;
          else if (fm) reach = hasEnabledFilters(n.filters);
          else if (kind === "mask") reach = false; // applied after fx/filters
          else reach = own;
          return true;
        }
        if (n.type === "group" && walk(n.children, ancStyled || own)) return true;
      }
      return false;
    };
    walk(tree, false);
    return reach;
  }

  /** Fold a committed change into every cached adjustment product's dirty
   *  region (null = unbounded → that product needs a full recompute on miss).
   *  Unioning changes that are above/apart from an adjustment is harmless —
   *  re-processing an unchanged region reproduces the same pixels. */
  private noteBelowChange(rect: Rect | null) {
    if (!this.adjMeta.size) return;
    for (const m of this.adjMeta.values()) {
      if (!rect) m.unbounded = true;
      else if (!m.unbounded) m.dirty = unionRect(m.dirty, rect);
    }
  }

  /** Free a node's cached render (also used by LRU eviction + deletion).
   *  `keepTiles` (mask bumps only): a tiled adjustment product survives its own
   *  mask paint — the key's mask version forces a miss, and the meta path then
   *  recomputes just the tiles under the changed rect with the current mask. */
  private dropCache(id: string, keepTiles = false) {
    const e = this.renderCache.get(id);
    if (e) {
      this.renderBytes -= e.bytes;
      this.renderCache.delete(id);
    }
    if (!keepTiles) this.dropTiled(id);
    // A clip group led by this node caches under a prefixed id.
    const clip = this.renderCache.get(`clip:${id}`);
    if (clip) {
      this.renderBytes -= clip.bytes;
      this.renderCache.delete(`clip:${id}`);
    }
  }

  /** Free a tiled adjustment product (deletion / eviction cleanup). */
  private dropTiled(id: string) {
    const t = this.tiledAdj.get(id);
    if (t) {
      this.renderBytes -= t.bytes;
      this.tiledAdj.delete(id);
    }
  }

  /** Drop every cached product (whole-canvas AND tiled) + the dirty metadata.
   *  The one honest way to invalidate wholesale — always resets the byte count. */
  private clearRenderCaches() {
    this.renderCache.clear();
    this.tiledAdj.clear();
    this.renderBytes = 0;
    this.lastTree = null;
    this.adjMeta.clear();
  }

  /** Invalidate every intrinsic render (geometry or colour space changed):
   *  the epoch keys every entry, and the buffers are freed eagerly. */
  private invalidateStyled() {
    this.docEpoch++;
    this.clearRenderCaches();
  }

  // ---- GPU tone stage (WebGL2 LUTs; Canvas2D is the always-correct fallback) --
  private gpuTone: GpuToneRenderer | null | undefined; // undefined = not tried yet
  private gpuOn = true;

  /** Is the GPU LUT pass usable for the working colour space (lazy init)? */
  private gpuAvailable(): boolean {
    if (!this.gpuOn) return false;
    if (this.ws === "adobe-rgb") return false; // LUT math must run in Adobe primaries (CPU)
    if (this.gpuTone === undefined || (this.gpuTone && this.gpuTone.cs !== this.cs))
      this.gpuTone = GpuToneRenderer.create(this.cs);
    return !!this.gpuTone;
  }

  /** The GPU LUT pass for the working colour space (null = CPU path). */
  private gpuToneRender(src: HTMLCanvasElement, w: number, h: number, luts: ToneLUTs): HTMLCanvasElement | null {
    return this.gpuAvailable() ? this.gpuTone!.render(src, w, h, luts) : null;
  }

  /** Debug A/B toggle (window.__gqGPU): GPU vs CPU tone stage. Clears cached
   *  adjustment products so the whole document re-renders on the chosen path. */
  setGpuEnabled(on: boolean) {
    this.gpuOn = on;
    this.clearRenderCaches();
    this.emitChange();
  }

  gpuStatus(): { enabled: boolean; active: boolean } {
    return { enabled: this.gpuOn, active: this.gpuOn && !!this.gpuTone };
  }

  /** Debug A/B toggle: with the cache off, every composite fully recomputes —
   *  output must be pixel-identical to the cached path. */
  setRenderCacheEnabled(on: boolean) {
    this.renderCacheOn = on;
    if (!on) this.clearRenderCaches();
    this.lastTree = null;
    this.emitChange();
  }

  /** Cache occupancy (dev overlay / console). */
  renderCacheStats(): {
    enabled: boolean;
    entries: number;
    bytes: number;
    budget: number;
    hits: number;
    misses: number;
    tiles: number;
  } {
    let tiles = 0;
    for (const t of this.tiledAdj.values()) for (const tile of t.tiles) if (tile) tiles++;
    return {
      enabled: this.renderCacheOn,
      entries: this.renderCache.size + this.tiledAdj.size,
      bytes: this.renderBytes,
      budget: this.renderBudget,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      tiles,
    };
  }

  /** Cap the undo history (Preferences ▸ Performance): oldest steps drop off
   *  the far end — their pixel patches are the biggest memory holders. */
  setHistoryLimit(n: number): void {
    this.historyLimit = Math.max(10, Math.min(200, Math.round(n)));
    this.trimHistory();
  }

  private trimHistory(): void {
    let dropped = 0;
    while (this.entries.length > this.historyLimit) {
      this.entries.shift();
      dropped++;
    }
    if (dropped) {
      this.pos = Math.max(0, this.pos - dropped);
      this.emitHistory();
    }
  }

  /** Route heavy compute through workers (on) or the synchronous fallbacks
   *  (off — a debugging aid). In-flight jobs still land; new work obeys. */
  setWorkersEnabled(on: boolean): void {
    this.workersOn = on;
  }

  /** Set the render-cache LRU byte budget (Preferences ▸ Performance). Evicts
   *  immediately when shrinking; entries used by the last frame stay protected. */
  setRenderCacheBudget(mb: number): void {
    const clamped = Math.max(64, Math.min(2048, Math.round(mb)));
    this.renderBudget = clamped * 1024 * 1024;
    this.evictOverBudget();
  }

  /** Make a canvas in the working colour space (for layer-content buffers). */
  private mk(w: number, h: number, readFreq = false) {
    return makeCanvas(w, h, readFreq, this.cs);
  }

  /** Make a colour-agnostic (sRGB) buffer for mask data — masks are coverage,
   *  not colour, so they never participate in gamut conversion. */
  private mkMask(readFreq = true): Layer {
    return makeCanvas(this.w, this.h, readFreq, "srgb");
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
  private dodging = false;
  private dodgeLayer: string | null = null;
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
  /** Whole-layer move with a linked mask: shift the mask with the pixels. */
  private moveMaskLinked = false;

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
  private adjTone: ToneAdjustment | null = null; // pending Curves/Levels (destructive)
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
  private fillOnMask = false; // the live bucket fill targets the active layer's mask
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

  /** Switch the working colour space. Native spaces (sRGB / Display P3) convert
   *  the stored pixels between canvas spaces; the emulated Adobe RGB space only
   *  redirects the adjustment MATH — bytes stay on the sRGB canvas, so toggling
   *  it is lossless (adjustment products recompute via the epoch bump). */
  setColorSpace(ws: WorkingSpace) {
    if (ws === this.ws) return;
    const nextCanvas = canvasSpaceOf(ws);
    const canvasChanged = nextCanvas !== this.cs;
    this.wandSrc = null;
    this.invalidateStyled();
    this.ws = ws;
    this.cs = nextCanvas;
    if (canvasChanged) {
      if (this.scratch) this.scratch = this.mk(this.w, this.h);
      // drawImage converts each layer's pixels from the old space into the new one.
      for (const [id, l] of this.layers) {
        const next = this.mk(this.w, this.h, true);
        next.ctx.drawImage(l.c, 0, 0);
        this.layers.set(id, next);
      }
    }
    this.endAdjust();
    this.emitChange();
  }

  get colorSpace() {
    return this.cs;
  }

  get workingSpace(): WorkingSpace {
    return this.ws;
  }

  /** Soft-proof settings (Ctrl+Alt+Y / Ctrl+Alt+Shift+Y; target from the
   *  Color Management dialog). View-only — exports never proof. */
  setProofing(simulate: boolean, warn: boolean, target: ProofTarget): void {
    if (simulate === this.proofSimulate && warn === this.gamutWarn && target === this.proofTarget) return;
    this.proofSimulate = simulate;
    this.gamutWarn = warn;
    this.proofTarget = target;
    this.lastTree = null; // next view blit must repaint everything
    this.emitChange();
  }

  private proofingActive(): boolean {
    return (this.proofSimulate || this.gamutWarn) && !proofIsIdentity(this.cs, this.proofTarget);
  }

  /** Slider / tone maths on `src` in the WORKING space.
   *  Native spaces run the existing 8-bit path (a single pass quantizes once
   *  already). The emulated Adobe RGB space runs the 16-BIT pipeline: canvas
   *  bytes decode straight to Adobe RGBA16, the math runs at 16 bits (65k-entry
   *  tone LUTs), and ONE final quantization writes the sRGB bytes — so an
   *  identity edit roundtrips byte-exact and nothing quantizes mid-pipeline.
   *  `ownSrc` marks a caller-owned buffer the native tone path may mutate
   *  in place (the adjustment sites hand in fresh getImageData copies). */
  private applyColorMath(
    src: ImageData,
    op:
      | { kind: "sliders"; params: Adjustments }
      | { kind: "tone"; luts: ToneLUTs; luts16: () => ToneLUTs16 }
      | { kind: "extra"; spec: ExtraAdjustment },
    ownSrc = false,
  ): ImageData {
    if (this.ws !== "adobe-rgb") {
      if (op.kind === "sliders") return applyAdjustments(src, op.params, this.cs);
      const target = ownSrc
        ? src
        : new ImageData(new Uint8ClampedArray(src.data), src.width, src.height, {
            colorSpace: this.cs,
          });
      if (op.kind === "extra") return applyExtraAdjustment(target, op.spec); // in place
      return applyToneLUTs(target, op.luts); // mutates target in place
    }
    if (op.kind === "extra") {
      // The extra types run at 8 bits in the emulated working space (the
      // pre-16-bit in-place conversion pair) — their 16-bit twins remain a
      // follow-up, like the filter path.
      const target = ownSrc
        ? src
        : new ImageData(new Uint8ClampedArray(src.data), src.width, src.height, {
            colorSpace: this.cs,
          });
      srgbToAdobeInPlace(target.data);
      applyExtraAdjustment(target, op.spec);
      adobeToSrgbInPlace(target.data);
      return target;
    }
    const wide = srgbBytesToAdobe16(src.data);
    if (op.kind === "sliders") applyAdjustments16(wide, src.width, src.height, op.params);
    else applyToneLUTs16(wide, op.luts16());
    const out = new ImageData(src.width, src.height, { colorSpace: this.cs });
    adobe16ToSrgbBytes(wide, out.data);
    return out;
  }

  setDoc(w: number, h: number, ownLayerIds?: string[]) {
    if (this.w === w && this.h === h && this.stroke) return;
    this.wandSrc = null;
    this.invalidateStyled();
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
    // Masks track the canvas size; any extended area reveals (white) while the old
    // footprint (including erased transparency) is preserved.
    this.transformMasks(ownLayerIds, (ctx, src) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.clearRect(0, 0, src.width, src.height);
      ctx.drawImage(src, 0, 0);
    });
  }

  /**
   * Canvas resize (reframe) with an anchor: existing content lands at (dx,dy)
   * in the new frame — this is what makes the Canvas Size dialog's anchor grid
   * real. Call BEFORE updating the doc's width/height so the follow-up setDoc
   * is a no-op (same convention as resizeImage).
   */
  resizeCanvasAnchored(w: number, h: number, dx: number, dy: number, ownLayerIds?: string[]) {
    if ((this.w === w && this.h === h && dx === 0 && dy === 0) || w < 1 || h < 1) return;
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    this.invalidateStyled();
    this.w = w;
    this.h = h;
    this.stroke = makeCanvas(w, h);
    this.scratch = this.mk(w, h);
    for (const [id, l] of this.layers) {
      if (ownLayerIds && !ownLayerIds.includes(id)) continue;
      const next = this.mk(w, h, true);
      next.ctx.drawImage(l.c, dx, dy);
      this.layers.set(id, next);
      this.bumpPixel(id);
    }
    // Masks track their layers; any extended area reveals (white).
    this.transformMasks(ownLayerIds, (ctx, src) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.clearRect(dx, dy, src.width, src.height);
      ctx.drawImage(src, dx, dy);
    });
    if (dx !== 0 || dy !== 0) {
      // Shifted content invalidates history patch coordinates (same rule as
      // resampling): clear rather than restore patches at wrong places.
      this.entries.length = 0;
      this.pos = 0;
      this.emitHistory();
    }
    this.emitChange();
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
    this.invalidateStyled();
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
    this.transformMasks(ownLayerIds, (ctx, src) => {
      ctx.imageSmoothingEnabled = smooth;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, src.width || ow, src.height || oh, 0, 0, w, h);
    });
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
    this.invalidateStyled();
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
    this.transformMasks(ownLayerIds, (ctx, src) => {
      ctx.imageSmoothingEnabled = false; // axis-aligned: keep mask pixels exact
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
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    });
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
    const masks: { id: string; c: HTMLCanvasElement }[] = [];
    for (const [id, m] of this.masks) {
      if (!ownLayerIds.includes(id)) continue;
      const snap = this.mkMask(false);
      snap.ctx.drawImage(m.c, 0, 0);
      masks.push({ id, c: snap.c });
    }
    return { w: this.w, h: this.h, layers, masks };
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
    this.invalidateStyled();
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
    this.transformMasks(ownLayerIds, (ctx, src) => {
      if (angle) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.translate(nw / 2, nh / 2);
        ctx.rotate(rad);
        ctx.translate(-cx, -cy);
        ctx.drawImage(src, 0, 0);
      } else {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, -Math.round(rect.x), -Math.round(rect.y));
      }
    });
    this.emitChange();
  }

  /** Restore a pre-crop snapshot (layers + masks + document size) for crop undo/redo. */
  cropRestore(snap: CropSnapshot) {
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    this.invalidateStyled();
    this.w = snap.w;
    this.h = snap.h;
    this.stroke = makeCanvas(snap.w, snap.h);
    this.scratch = this.mk(snap.w, snap.h);
    for (const { id, c } of snap.layers) {
      const next = this.mk(c.width, c.height, true);
      next.ctx.drawImage(c, 0, 0);
      this.layers.set(id, next);
    }
    for (const { id, c } of snap.masks ?? []) {
      const next = this.mkMask(true);
      next.ctx.drawImage(c, 0, 0);
      this.masks.set(id, next);
      this.deriveMaskAlpha(id);
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

  // ---- Layer-mask surface resolution & alpha derivation --------------------

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
   *  via maskKeyOf(). */
  private activeSurface(id: string): "pixels" | "mask" {
    return this.getActiveSurface(id) === "pixels" ? "pixels" : "mask";
  }

  /** The masks-map key `id`'s current mask surface resolves to: the node id for
   *  the layer mask, `filterMaskKey(id)` for the filter mask. History entries for
   *  mask paint record THIS key as their layerId, so undo lands on the right raster. */
  private maskKeyOf(id: string): string {
    return this.surfaces.get(id) === "filterMask" ? filterMaskKey(id) : id;
  }

  setActiveSurface(id: string, surface: ActiveSurface): void {
    if (surface === "mask" && !this.masks.has(id)) return; // no mask to paint
    if (surface === "filterMask" && !this.masks.has(filterMaskKey(id))) return;
    this.surfaces.set(id, surface);
    this.emitChange();
  }

  /** The canvas a paint op should draw into for `id`: the active mask (layer or
   *  filter) when one is targeted, otherwise the layer. The single chokepoint
   *  that lets every tool paint either mask with no per-tool changes. */
  private surfaceTarget(id: string): Layer {
    if (this.activeSurface(id) === "mask") return this.masks.get(this.maskKeyOf(id))!;
    return this.layer(id);
  }

  /** Recompute the alpha cache from the grayscale mask, scoped to `rect` (whole
   *  mask if omitted): out.A = R × maskAlpha / 255, out.RGB = 0. Runs only on
   *  mask mutation, never per composite frame. */
  private deriveMaskAlpha(id: string, rect?: Rect): void {
    const mask = this.masks.get(id);
    if (!mask) return;
    this.bumpMask(id, rect); // every mask mutation funnels through here
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
  private maskDisplay(id: string): HTMLCanvasElement | null {
    // `id` here is a masks-map key: a node id (layer mask) or fm:<id> (filter
    // mask) — resolve the live stroke's target key so either previews live.
    if (this.painting && this.strokeOnMask && this.stroke && this.strokeLayer && this.maskKeyOf(this.strokeLayer) === id) {
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
        this.drawStroke(g.ctx); // live stroke onto the grayscale preview
        const a = this.maskPrevA;
        a.ctx.globalAlpha = 1;
        a.ctx.globalCompositeOperation = "source-over";
        a.ctx.clearRect(0, 0, this.w, this.h);
        const cache = this.maskAlpha.get(id);
        if (cache) a.ctx.drawImage(cache.c, 0, 0); // seed with committed alpha (GPU)
        const r = this.dirtyRect();
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

  // ---- Layer-mask pixel lifecycle (history is coordinated by the caller) ----

  /** True when `id` currently carries a mask. */
  hasMask(id: string): boolean {
    return this.masks.has(id);
  }

  /** Toggle the mask-view render mode (null = back to the normal composite). */
  setMaskView(id: string | null, surface: "mask" | "filterMask" = "mask") {
    this.maskView = id ? { id, surface } : null;
    this.emitChange();
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
      m.ctx.drawImage(this.selectionMask(rects, angle, pivot, 0), 0, 0); // white inside
    } else {
      m.ctx.fillStyle = init === "hide" ? "#000" : "#fff";
      m.ctx.fillRect(0, 0, this.w, this.h);
    }
    this.masks.set(id, m);
    this.deriveMaskAlpha(id);
    this.emitChange();
  }

  /** Free a mask + its alpha cache, resetting the active surface to pixels.
   *  Accepts either a node id (layer mask) or a filterMaskKey (filter mask). */
  freeMask(id: string): void {
    this.masks.delete(id);
    this.maskAlpha.delete(id);
    this.bumpMask(id); // the node's masked render changed
    if (this.surfaces.get(id) === "mask") this.surfaces.set(id, "pixels");
    if (id.startsWith("fm:")) {
      const base = id.slice(3);
      if (this.surfaces.get(base) === "filterMask") this.surfaces.set(base, "pixels");
    }
    this.emitChange();
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
    this.emitChange();
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

  /** Threshold a mask's coverage (≥ 50%) into run-length selection rects. */
  maskSelectionRects(id: string): Rect[] {
    const cache = this.maskAlpha.get(id);
    if (!cache) return [];
    const d = cache.ctx.getImageData(0, 0, this.w, this.h).data;
    const out: Rect[] = [];
    for (let y = 0; y < this.h; y++) {
      let x0 = -1;
      const row = y * this.w;
      for (let x = 0; x < this.w; x++) {
        const on = d[(row + x) * 4 + 3] >= 128;
        if (on && x0 < 0) x0 = x;
        else if (!on && x0 >= 0) {
          out.push({ x: x0, y, w: x - x0, h: 1 });
          x0 = -1;
        }
      }
      if (x0 >= 0) out.push({ x: x0, y, w: this.w - x0, h: 1 });
    }
    return out;
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
    this.emitChange();
  }

  /** Re-make every owned mask through `fn` (which draws the old mask canvas into a
   *  fresh, current-doc-sized target ctx) and re-derive its alpha cache. Used by
   *  the resize / rotate / flip / crop paths so masks track their layers exactly.
   *  Callers must have set this.w/this.h to the new dimensions first. */
  private transformMasks(
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
    surface: "layer" | "mask" = "layer",
  ) {
    this.endAdjust(); // any other pixel op finalizes a live adjustment / shape / gradient / path / fill
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
    if (this.pos < this.entries.length) this.entries.length = this.pos;
    this.entries.push({ layerId, rect, before, after, label, side, surface });
    this.pos = this.entries.length;
    this.trimHistory();
    if (surface !== "mask") this.bumpPixel(layerId, rect); // layer pixels changed → restyle
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
    this.trimHistory();
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
    const onMask = this.activeSurface(layerId) === "mask";
    const mid = onMask ? this.maskKeyOf(layerId) : layerId; // history/derive key
    const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
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
    this.pushEntry(mid, bounds, before, after, "Fill", undefined, onMask ? "mask" : "layer");
    if (onMask) this.deriveMaskAlpha(mid, bounds);
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
    this.bumpPixel(layerId);
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
    const onMask = this.activeSurface(layerId) === "mask";
    const mid = onMask ? this.maskKeyOf(layerId) : layerId;
    const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
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
      this.gradEntry = {
        layerId: mid,
        rect: b,
        before: this.gradOrig!,
        after,
        label: "Gradient",
        surface: onMask ? "mask" : "layer",
      };
      this.entries.push(this.gradEntry);
      this.pos = this.entries.length;
      this.emitHistory();
    } else {
      this.gradEntry.after = after;
    }
    if (onMask) this.deriveMaskAlpha(mid, b);
    else this.bumpPixel(layerId);
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
    this.bumpPixel(layerId);
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
    this.fillOnMask = this.activeSurface(layerId) === "mask";
    const l = this.fillOnMask ? this.masks.get(this.maskKeyOf(layerId))! : this.layer(layerId);
    if (this.fillLayer !== layerId || !this.fillOrig) {
      this.fillLayer = layerId;
      this.fillOrig = this.fillOnMask ? this.mkMask(true) : this.mk(this.w, this.h, true);
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
    if (this.fillOnMask) this.deriveMaskAlpha(this.maskKeyOf(layerId)); // refresh cache so the mask preview updates
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
        const onMask = this.fillOnMask;
        const mid = onMask ? this.maskKeyOf(layerId) : layerId;
        const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
        const before = orig.ctx.getImageData(b.x, b.y, b.w, b.h);
        const after = l.ctx.getImageData(b.x, b.y, b.w, b.h);
        this.pushEntry(mid, b, before, after, "Fill", undefined, onMask ? "mask" : "layer");
        if (onMask) this.deriveMaskAlpha(mid, b);
      }
    }
    this.fillOnMask = false;
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
    const onMask = this.activeSurface(layerId) === "mask";
    const mid = onMask ? this.maskKeyOf(layerId) : layerId;
    const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
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
    this.pushEntry(mid, bounds, before, after, label, undefined, onMask ? "mask" : "layer");
    if (onMask) this.deriveMaskAlpha(mid, bounds);
    this.emitChange();
  }

  /** Copy a layer's pixels (and mask) into another (new) layer id. Adjustment
   *  nodes have no canvas, so only their mask (if any) is copied. */
  duplicateLayer(srcId: string, dstId: string) {
    const src = this.layers.get(srcId);
    if (src) {
      const dst = this.layer(dstId);
      dst.ctx.globalAlpha = 1;
      dst.ctx.globalCompositeOperation = "source-over";
      dst.ctx.clearRect(0, 0, this.w, this.h);
      dst.ctx.drawImage(src.c, 0, 0);
    }
    // Carry both masks too (the clone keeps its meta via clone-subtree).
    for (const key of [dstId, filterMaskKey(dstId)]) {
      const srcMask = this.masks.get(key === dstId ? srcId : filterMaskKey(srcId));
      if (srcMask) {
        const m = this.mkMask(true);
        m.ctx.drawImage(srcMask.c, 0, 0);
        this.masks.set(key, m);
        this.deriveMaskAlpha(key);
      } else {
        this.freeMask(key);
      }
    }
    this.bumpPixel(dstId);
    this.emitChange();
  }

  /** Composite `nodes` (top→bottom) into one new layer, dropping `deleteIds`.
   *  Uses drawStack so masks, adjustment layers, AND layer effects all bake in. */
  rasterize(targetId: string, nodes: LayerNode[], deleteIds: string[]) {
    const { c, ctx } = this.mk(this.w, this.h, true);
    this.drawStack(ctx, nodes);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const id of deleteIds) {
      this.layers.delete(id);
      this.freeMask(id);
      this.freeMask(filterMaskKey(id));
      this.dropCache(id);
    }
    this.freeMask(targetId); // the merged result is flat — no masks
    this.freeMask(filterMaskKey(targetId));
    this.dropCache(targetId);
    this.layers.set(targetId, { c, ctx });
    this.bumpPixel(targetId);
    this.emitChange();
  }

  /** Bake a layer's smart-filter stack into its stored pixels (the explicit
   *  destructive "Apply Smart Filters"): one combined history step — the pixel
   *  patch plus the structural stack-removal passed in as `side`. */
  applySmartFilters(layerId: string, filters: SmartFilter[], side?: HistorySide, useFilterMask = false) {
    const l = this.layers.get(layerId);
    if (!l || !filters.length) return;
    const before = l.ctx.getImageData(0, 0, this.w, this.h);
    // Baking honours an enabled filter mask — the baked pixels must equal what
    // the stack rendered. The caller frees the fm raster via its structural side.
    const fm = useFilterMask ? this.maskDisplay(filterMaskKey(layerId)) : null;
    const filtered = this.renderFiltered(l.c, filters, fm);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(filtered, 0, 0);
    const after = l.ctx.getImageData(0, 0, this.w, this.h);
    this.pushEntry(layerId, { x: 0, y: 0, w: this.w, h: this.h }, before, after, "Apply Smart Filters", side);
    this.bumpPixel(layerId);
    this.emitChange();
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
  private clipCoverageToSelection(
    coverage: Uint8ClampedArray,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    sel: Rect[],
    selAngle: number,
    selPivot: { x: number; y: number } | null,
  ) {
    const m = this.selectionMask(sel, selAngle, selPivot);
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
    const b = this.boundsOf(sel);
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

  /** Red-eye click: find the red pupil blob near (x, y) and neutralize +
   *  darken it (redeye.ts). One "Red Eye" history entry; a no-op (nothing red
   *  found) pushes nothing. Returns whether anything changed. */
  redEye(
    layerId: string,
    x: number,
    y: number,
    size: number,
    darken: number,
    sel: Rect[] | null = null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ): boolean {
    const l = this.layers.get(layerId);
    if (!l) return false;
    const radius = Math.max(2, size / 2);
    const pad = 2; // mask blur margin
    const rx = Math.max(0, Math.floor(x - radius - pad));
    const ry = Math.max(0, Math.floor(y - radius - pad));
    const rw = Math.min(this.w, Math.ceil(x + radius + pad)) - rx;
    const rh = Math.min(this.h, Math.ceil(y + radius + pad)) - ry;
    if (rw <= 0 || rh <= 0) return false;
    const before = l.ctx.getImageData(rx, ry, rw, rh);
    const after = new ImageData(new Uint8ClampedArray(before.data), rw, rh, { colorSpace: this.cs });
    const changed = removeRedEyeInPlace(after.data, rw, rh, x - rx, y - ry, radius, darken);
    if (!changed) return false;
    // Confine to the active selection: outside it, keep the original bytes.
    if (sel && sel.length) {
      const coverage = new Uint8ClampedArray(rw * rh);
      coverage.fill(255);
      this.clipCoverageToSelection(coverage, rx, ry, rw, rh, sel, selAngle, selPivot);
      const a = after.data;
      const b = before.data;
      for (let i = 0; i < coverage.length; i++) {
        if (coverage[i] === 255) continue;
        const o = i * 4;
        const t = coverage[i] / 255;
        a[o] = Math.round(b[o] + (a[o] - b[o]) * t);
        a[o + 1] = Math.round(b[o + 1] + (a[o + 1] - b[o + 1]) * t);
        a[o + 2] = Math.round(b[o + 2] + (a[o + 2] - b[o + 2]) * t);
        a[o + 3] = Math.round(b[o + 3] + (a[o + 3] - b[o + 3]) * t);
      }
    }
    l.ctx.putImageData(after, rx, ry);
    this.pushEntry(layerId, { x: rx, y: ry, w: rw, h: rh }, before, after, "Red Eye");
    this.emitChange();
    return true;
  }

  /** Forget a layer's offscreen canvas + masks + cached render (after removal). */
  removeLayer(id: string) {
    this.layers.delete(id);
    this.freeMask(id);
    this.freeMask(filterMaskKey(id));
    this.dropCache(id);
    this.pixelVersion.delete(id);
    this.maskVersion.delete(id);
    this.maskVersion.delete(filterMaskKey(id));
    this.toneCache.delete(id);
    this.filteredCache.delete(id);
    this.filterPending.delete(id);
    this.adjMeta.delete(id);
  }

  /** A leaf layer's pixels as a PNG data URL (null if it has no canvas yet). */
  getLayerImage(id: string): string | null {
    const l = this.layers.get(id);
    return l ? l.c.toDataURL("image/png") : null;
  }

  /** A doc-sized COPY of a layer's raster as a canvas (blank if it has none
   *  yet — a fresh empty layer simply liquifies/reads as transparency). */
  getLayerCanvas(id: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    const l = this.layers.get(id);
    if (l) c.getContext("2d")!.drawImage(l.c, 0, 0);
    return c;
  }

  /** A layer's grayscale mask as a PNG data URL (null if it has no mask). */
  getMaskImage(id: string): string | null {
    const m = this.masks.get(id);
    return m ? m.c.toDataURL("image/png") : null;
  }

  /** Restore a mask from a decoded image (project load) + derive its alpha. */
  setMaskImage(id: string, source: CanvasImageSource): void {
    const m = this.mkMask(true);
    m.ctx.drawImage(source, 0, 0);
    this.masks.set(id, m);
    this.deriveMaskAlpha(id);
    this.emitChange();
  }

  // ---- Adjustments (live preview on a leaf, baked on commit) ----
  /** Preview adjustments on a layer. Snapshots the original on first use; a
      default (all-zero) adjustment cancels the preview. */
  /**
   * Adjust `before` everywhere, then (if a selection is active) keep the result
   * only inside the selection region and the original pixels outside it.
   */
  /** Process the live-adjustment session's `before` snapshot with whichever spec
   *  is pending — slider `Adjustments` or a Curves/Levels tone spec — then confine
   *  to the active selection (if any). One path for both destructive tools. */
  private processAdjust(before: ImageData): ImageData {
    let res: ImageData;
    if (this.adjTone) {
      const tone = this.adjTone;
      const luts = tone.type === "levels" ? buildLevelsLUTs(tone) : buildCurvesLUTs(tone);
      // ownSrc=false: the session snapshot must never be mutated.
      res = this.applyColorMath(before, {
        kind: "tone",
        luts,
        luts16: () => (tone.type === "levels" ? buildLevelsLUTs16(tone) : buildCurvesLUTs16(tone)),
      });
    } else if (this.adjPending) {
      res = this.applyColorMath(before, { kind: "sliders", params: this.adjPending });
    } else {
      return before;
    }
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
    this.adjTone = null;
    // First change bakes + pushes synchronously (so the entry always exists);
    // rapid follow-ups are rAF-throttled and only refresh that entry.
    if (fresh) this.flushAdjust();
    else if (!this.adjRaf) this.adjRaf = requestAnimationFrame(() => this.flushAdjust());
  }

  /** Destructive Curves/Levels: live-preview a tone spec on a layer through the
   *  same session as the slider adjustments (Apply = endAdjust, Reset = revertAdjust). */
  previewTone(
    layerId: string,
    spec: ToneAdjustment,
    sel: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    if (this.adjLayer && this.adjLayer !== layerId) this.endAdjust();
    const fresh = this.adjLayer !== layerId || !this.adjOrig;
    if (fresh) {
      const l = this.layers.get(layerId);
      if (!l) return;
      this.adjLayer = layerId;
      this.adjOrig = l.ctx.getImageData(0, 0, this.w, this.h);
      this.adjEntry = null;
    }
    this.adjSel = sel && sel.length ? sel : null;
    this.adjSelAngle = angle;
    this.adjSelPivot = pivot;
    this.adjTone = spec;
    this.adjPending = null;
    if (fresh) this.flushAdjust();
    else if (!this.adjRaf) this.adjRaf = requestAnimationFrame(() => this.flushAdjust());
  }

  /** Bake the pending adjustment into the layer; push or refresh its entry. */
  private flushAdjust() {
    this.adjRaf = 0;
    if ((!this.adjPending && !this.adjTone) || !this.adjOrig || !this.adjLayer) return;
    const after = this.processAdjust(this.adjOrig);
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
        label: this.adjTone ? (this.adjTone.type === "levels" ? "Levels" : "Curves") : "Adjustments",
      };
      this.entries.push(this.adjEntry);
      this.pos = this.entries.length;
      this.emitHistory();
    } else {
      this.adjEntry.after = after; // same entry, newer pixels (list unchanged)
    }
    if (this.adjLayer) this.bumpPixel(this.adjLayer);
    this.emitChange();
  }

  /** Finalize the live adjustment session, keeping its history entry. */
  endAdjust() {
    if (!this.adjLayer) return;
    if (this.adjRaf) {
      cancelAnimationFrame(this.adjRaf);
      this.adjRaf = 0;
    }
    if ((this.adjPending || this.adjTone) && !this.adjEntry) this.flushAdjust(); // safety: never-flushed
    this.adjLayer = null;
    this.adjOrig = null;
    this.adjEntry = null;
    this.adjPending = null;
    this.adjTone = null;
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
    this.adjTone = null;
    this.adjSel = null;
    this.adjSelAngle = 0;
    this.adjSelPivot = null;
    this.emitHistory();
    this.emitChange();
  }

  /** Replace a leaf layer's pixels with an image (used when loading a project). */
  setLayerImage(id: string, source: CanvasImageSource, x = 0, y = 0) {
    this.wandSrc = null;
    const l = this.layer(id);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(source, x, y);
    this.bumpPixel(id);
    this.emitChange();
  }

  /** Like setLayerImage, but journaled as ONE undoable whole-layer pixel step
   *  (HDR re-tonemap and other "replace the layer with a computed image" ops). */
  applyLayerImage(id: string, source: CanvasImageSource, label: string) {
    this.wandSrc = null;
    const l = this.layer(id);
    const before = l.ctx.getImageData(0, 0, this.w, this.h);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.drawImage(source, 0, 0);
    const after = l.ctx.getImageData(0, 0, this.w, this.h);
    this.pushEntry(id, { x: 0, y: 0, w: this.w, h: this.h }, before, after, label);
    this.emitChange();
  }

  /** Snapshot the full pixels + mask of the given leaf layers (null = absent). */
  captureLeaves(ids: string[]): Map<string, LeafSnapshot> {
    const m = new Map<string, LeafSnapshot>();
    for (const id of ids) {
      const l = this.layers.get(id);
      const mk = this.masks.get(id);
      const fm = this.masks.get(filterMaskKey(id));
      m.set(id, {
        layer: l ? l.ctx.getImageData(0, 0, this.w, this.h) : null,
        mask: mk ? mk.ctx.getImageData(0, 0, this.w, this.h) : null,
        fmMask: fm ? fm.ctx.getImageData(0, 0, this.w, this.h) : null,
      });
    }
    return m;
  }

  /** Restore leaf layers + masks from snapshots (null surface = delete it). */
  restoreLeaves(snaps: Map<string, LeafSnapshot>) {
    for (const [id, snap] of snaps) {
      if (snap.layer) {
        const l = this.layer(id);
        l.ctx.globalAlpha = 1;
        l.ctx.globalCompositeOperation = "source-over";
        l.ctx.clearRect(0, 0, this.w, this.h);
        l.ctx.putImageData(snap.layer, 0, 0);
        this.bumpPixel(id);
      } else {
        this.layers.delete(id);
        this.dropCache(id);
      }
      if (snap.mask) this.restoreMask(id, snap.mask);
      else this.freeMask(id);
      if (snap.fmMask) this.restoreMask(filterMaskKey(id), snap.fmMask);
      else this.freeMask(filterMaskKey(id));
    }
    this.emitChange();
  }

  /** The pixels to draw for a leaf, with any live stroke/move/float merged in. */
  private leafDisplay(id: string): HTMLCanvasElement | null {
    const l = this.layers.get(id);
    const s = this.scratch?.ctx;
    if (this.painting && !this.strokeOnMask && this.stroke && s && id === this.strokeLayer) {
      // A pixel stroke previews on the layer; a mask stroke leaves layer pixels
      // untouched and previews through maskDisplay() instead.
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

  /** Multiply an enabled mask's alpha into `src`, returning a transient buffer;
   *  returns `src` unchanged when the node has no enabled mask. One extra
   *  destination-in drawImage against the cached alpha — no per-pixel JS loop. */
  private maskedSource(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    if (!node.mask?.enabled) return src;
    const alpha = this.maskDisplay(node.id);
    if (!alpha) return src;
    if (!this.maskTmp || this.maskTmp.c.width !== this.w || this.maskTmp.c.height !== this.h)
      this.maskTmp = this.mk(this.w, this.h);
    const t = this.maskTmp;
    t.ctx.globalAlpha = 1;
    t.ctx.globalCompositeOperation = "source-over";
    t.ctx.clearRect(0, 0, this.w, this.h);
    t.ctx.drawImage(src, 0, 0);
    t.ctx.globalCompositeOperation = "destination-in";
    t.ctx.drawImage(alpha, 0, 0);
    t.ctx.globalCompositeOperation = "source-over";
    return t.c;
  }

  // ---- render-graph keys (Spec 06) ------------------------------------------
  // The one rule: does a change alter the node's own composited pixels?
  // Yes (pixels / mask / effects / adjustment params / lower-sibling content)
  // → it is part of nodeKey (intrinsic). No (opacity / blend / visible /
  // clipped / position) → it only affects HOW the buffer is drawn, so it lives
  // in effectiveKey, which parents fold into childrenSig — the parent's merge
  // invalidates, the child's intrinsic render is reused.

  /** Memoized spec serialization — tree objects are immutable, and these are
   *  hashed every composite frame (adjustment keys, tone LUT keys). */
  private specHashMemo = new WeakMap<object, string>();
  private specHash(spec: object): string {
    let h = this.specHashMemo.get(spec);
    if (h === undefined) {
      h = JSON.stringify(spec);
      this.specHashMemo.set(spec, h);
    }
    return h;
  }

  /** Intrinsic dependency key of a leaf/group (pre-opacity/blend render). */
  private nodeKey(node: LayerNode): string {
    const mv = node.mask?.enabled ? (this.maskVersion.get(node.id) ?? 0) : "x";
    const fx = hasEnabledFx(node.effects) ? fnv(fxHash(node.effects)) : "0";
    const flt = hasEnabledFilters(node.filters) ? fnv(filterStackHash(node.filters)) : "0";
    // The filter mask only shapes the render while the stack actually runs.
    const fmv =
      flt !== "0" && node.filterMask?.enabled
        ? (this.maskVersion.get(filterMaskKey(node.id)) ?? 0)
        : "x";
    if (node.type === "group") {
      let sig = "";
      for (const c of node.children) sig += this.effectiveKey(c) + ";";
      return `G${fnv(sig)}|${flt}|${fmv}|${fx}|${mv}|${this.cs}|${this.docEpoch}`;
    }
    const pv = this.pixelVersion.get(node.id) ?? 0;
    return `L${pv}|${flt}|${fmv}|${fx}|${mv}|${this.cs}|${this.docEpoch}`;
  }

  /** What a parent's merge depends on for one child: the child's intrinsic key
   *  plus its draw-time props. Memoized per composite pass. */
  private effectiveKey(node: LayerNode): string {
    const memo = this.keyMemo.get(node.id);
    if (memo !== undefined) return memo;
    let base: string;
    if (node.type === "adjustment") {
      // An adjustment member/child contributes its params + its own mask.
      const mv = node.mask?.enabled ? (this.maskVersion.get(node.id) ?? 0) : "x";
      base = `A${fnv(this.specHash(node.adjustment))}|${mv}`;
    } else {
      base = this.nodeKey(node);
    }
    const key = fnv(`${base}|${node.opacity}|${node.blend}|${node.visible ? 1 : 0}|${node.clipped ? 1 : 0}`);
    this.keyMemo.set(node.id, key);
    return key;
  }

  /** Key of everything an adjustment node reads: the ordered effective keys of
   *  its lower siblings (the composite beneath it) — plus its own params, mask
   *  and draw-time modulation, which are baked into its cached product. */
  private adjustmentKey(node: LayerAdjustment, siblings: LayerNode[]): string {
    const idx = siblings.indexOf(node);
    let below = "";
    for (let i = idx + 1; i < siblings.length; i++) below += this.effectiveKey(siblings[i]) + ";";
    const mv = node.mask?.enabled ? (this.maskVersion.get(node.id) ?? 0) : "x";
    return `ADJ${fnv(this.specHash(node.adjustment))}|${fnv(below)}|${mv}|${node.opacity}|${node.blend}|${this.cs}|${this.docEpoch}`;
  }

  /** Ids that must bypass the cache this frame: layers with a live session
   *  (scratch-previewed or directly mutated without version bumps) plus every
   *  ancestor group on their path — their merges must recompute each frame. */
  private computeLiveBypass(tree: LayerNode[]): Set<string> {
    const live = new Set<string>();
    if (this.painting && this.strokeLayer) live.add(this.strokeLayer);
    if (this.moving && this.moveLayer) live.add(this.moveLayer);
    if (this.floatActive && this.floatLayer) live.add(this.floatLayer);
    if (this.blurring && this.blurLayer) live.add(this.blurLayer);
    if (this.dodging && this.dodgeLayer) live.add(this.dodgeLayer);
    if (this.adjLayer) live.add(this.adjLayer);
    if (this.shapeLayer) live.add(this.shapeLayer);
    if (this.gradLayer) live.add(this.gradLayer);
    if (this.pathLayer) live.add(this.pathLayer);
    if (this.fillLayer) live.add(this.fillLayer);
    if (this.blurFx) for (const id of this.blurFx.ids) live.add(id);
    const out = new Set<string>();
    if (!live.size) return out;
    const walk = (nodes: LayerNode[], path: string[]): void => {
      for (const n of nodes) {
        if (live.has(n.id)) {
          out.add(n.id);
          for (const p of path) out.add(p);
        }
        if (n.type === "group") {
          path.push(n.id);
          walk(n.children, path);
          path.pop();
        }
      }
    };
    walk(tree, []);
    return out;
  }

  /** Store an intrinsic render (owned unless `bytes` is 0 for an alias). */
  private cacheStore(id: string, key: string, c: HTMLCanvasElement, owned: boolean) {
    const prev = this.renderCache.get(id);
    if (prev) this.renderBytes -= prev.bytes;
    const bytes = owned ? c.width * c.height * 4 : 0;
    this.renderBytes += bytes;
    this.renderCache.set(id, { c, key, bytes, tick: ++this.renderTick });
    this.frameProtect.add(id);
  }

  /** LRU-evict past the byte budget (never entries used by this frame).
   *  Tiled adjustment products expose each resident tile as its own candidate
   *  (`<id>${TILE_ID_SEP}<index>`), so a large product sheds exactly the
   *  overage instead of vanishing whole — the surviving tiles stay valid and a
   *  freed tile is recomputed alone on next use. */
  private evictOverBudget() {
    if (this.renderBytes <= this.renderBudget) return;
    const self = this;
    function* candidates(): Generator<[string, { bytes: number; tick: number }]> {
      yield* self.renderCache;
      for (const [id, t] of self.tiledAdj) {
        if (self.frameProtect.has(id)) continue; // whole product in use this frame
        for (let i = 0; i < t.tiles.length; i++) {
          const tile = t.tiles[i];
          if (tile) yield [id + TILE_ID_SEP + i, tile];
        }
      }
    }
    for (const id of selectEvictions(candidates(), this.renderBytes, this.renderBudget, this.frameProtect)) {
      const sep = id.lastIndexOf(TILE_ID_SEP);
      if (sep >= 0) {
        const base = id.slice(0, sep);
        const idx = Number(id.slice(sep + 1));
        const t = this.tiledAdj.get(base);
        const tile = t?.tiles[idx];
        if (t && tile) {
          t.tiles[idx] = null;
          t.bytes -= tile.bytes;
          this.renderBytes -= tile.bytes;
          // Nothing resident left → drop the husk (key/meta would force a
          // full rebuild anyway).
          if (t.tiles.every((x) => !x)) this.dropTiled(base);
        }
        continue;
      }
      const e = this.renderCache.get(id);
      if (e) {
        this.renderBytes -= e.bytes;
        this.renderCache.delete(id);
      }
    }
  }

  /**
   * The intrinsic render of a leaf/group — pixels ⊗ effects ⊗ mask, WITHOUT
   * opacity/blend (those are applied by the caller at draw time) — through the
   * render cache. Live-session layers (and their ancestors) bypass the cache
   * entirely so in-progress edits render fresh every frame, exactly as before.
   */
  private renderNode(node: LayerNode): HTMLCanvasElement | null {
    if (node.type === "adjustment") return null; // handled by drawStack
    // Plain leaf (no mask, no effects, no smart filters): its layer canvas IS
    // the intrinsic render — alias it, no copy, no cache entry needed.
    if (
      node.type === "layer" &&
      !node.mask?.enabled &&
      !hasEnabledFx(node.effects) &&
      !hasEnabledFilters(node.filters)
    ) {
      return this.leafDisplay(node.id);
    }
    const bypass = !this.renderCacheOn || this.liveBypass.has(node.id);
    const key = bypass ? "" : this.nodeKey(node);
    if (!bypass) {
      const hit = this.renderCache.get(node.id);
      if (hit && hit.key === key) {
        this.cacheHits++;
        hit.tick = ++this.renderTick;
        this.frameProtect.add(node.id);
        return hit.c;
      }
      this.cacheMisses++;
    }
    // Miss → recompute with the SAME ops as the uncached path.
    const styled = this.styledSource(node);
    if (!styled) return null;
    let result: HTMLCanvasElement;
    let owned: boolean;
    if (node.mask?.enabled) {
      // maskedSource writes into a shared temp — copy into an owned buffer.
      const src = this.maskedSource(node, styled);
      const own = this.mk(this.w, this.h);
      own.ctx.drawImage(src, 0, 0);
      result = own.c;
      owned = true;
    } else {
      // styledSource allocated this buffer fresh (fx render / group merge) —
      // own it directly, no copy. (The plain-leaf alias returned above.)
      result = styled;
      owned = true;
    }
    if (!bypass) this.cacheStore(node.id, key, result, owned);
    return result;
  }

  /** Composite a group's children + its own effects into a fresh buffer — the
   *  merged group result BEFORE the group's mask / opacity / blend. Reused by the
   *  normal group draw and by clip groups (a group base/member). */
  private groupMerged(node: LayerGroup): HTMLCanvasElement {
    // A CPU-readable buffer is needed when a child adjustment reads it back.
    const hasAdj = node.children.some((c) => c.type === "adjustment");
    const styled = hasEnabledFx(node.effects);
    const { c: bc, ctx: bctx } = this.mk(this.w, this.h, hasAdj || styled);
    this.drawStack(bctx, node.children); // sub-stack: clip groups / adjustments stay group-isolated
    // Group smart filters run on the merged children (group isolation), below
    // the group's own effects — same order as a leaf: pixels → filters → fx.
    const filtered = hasEnabledFilters(node.filters) ? this.filteredProduct(node, bc) : bc;
    return styled ? renderStyled(filtered, node.effects!, this.cs).canvas : filtered;
  }

  /** The alpha buffer confining a node's smart-filter stack (null = unmasked).
   *  Routed through maskDisplay so painting the filter mask previews live. */
  private filterMaskAlpha(node: LayerNode): HTMLCanvasElement | null {
    return node.filterMask?.enabled ? this.maskDisplay(filterMaskKey(node.id)) : null;
  }

  /** The display source for a single leaf/group node WITH its effects (but without
   *  its mask / opacity / blend). Null when a leaf has no canvas. */
  private styledSource(node: LayerNode): HTMLCanvasElement | null {
    if (node.type === "group") return node.children.length ? this.groupMerged(node) : null;
    const disp = this.leafDisplay(node.id);
    if (!disp) return null;
    // Order within a layer: raw pixels → smart filters → layer effects.
    // (Effects derive their silhouette from the FILTERED display — Spec 07 §5.3.)
    const filtered = hasEnabledFilters(node.filters) ? this.filteredProduct(node, disp) : disp;
    return hasEnabledFx(node.effects) ? this.styledLeaf(node, filtered) : filtered;
  }

  /** Draw one (non-clipped, non-adjustment) layer node onto `ctx`: the cached
   *  intrinsic render, with opacity/blend applied HERE (draw time) — so those
   *  props never invalidate the node's own render. Clip groups + adjustments
   *  are handled by drawStack. */
  private drawNode(ctx: CanvasRenderingContext2D, node: LayerNode) {
    if (!node.visible || node.type === "adjustment") return;
    const src = this.renderNode(node);
    if (!src) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity / 100));
    ctx.globalCompositeOperation = blendOp(node.blend);
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** The styled buffer for a leaf with effects. Only reached on a render-cache
   *  miss (renderNode caches the product, keyed by pixelVersion/fxHash/space/
   *  epoch — the old standalone effectsCache is folded into that node cache). */
  private styledLeaf(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    return renderStyled(src, node.effects!, this.cs).canvas;
  }

  /** Smart filters (Spec 07): run a node's enabled filter stack over `src`
   *  (its raw pixels / merged group buffer), each filter blended back over the
   *  pre-filter result with its own blend mode + opacity. Returns a fresh
   *  layer-sized canvas; the node's stored pixels are never touched. Only
   *  reached on a render-cache miss — the product is cached by renderNode. */
  private renderFiltered(
    src: HTMLCanvasElement,
    filters: SmartFilter[],
    fmAlpha: HTMLCanvasElement | null = null,
  ): HTMLCanvasElement {
    const out = this.mk(this.w, this.h, true);
    out.ctx.drawImage(src, 0, 0);
    let cur = out.ctx.getImageData(0, 0, this.w, this.h);
    const base = fmAlpha ? cur : null; // pristine pixels; never mutated by the loop below
    for (const f of filters) {
      if (!f.enabled) continue;
      const applied = applyFilter(cur, f, this.cs);
      const op = blendOp(f.blendMode);
      const alpha = Math.max(0, Math.min(1, f.opacity / 100));
      if (op === "source-over" && alpha >= 1) {
        cur = applied; // the common case: full replace
        continue;
      }
      // Blend the filtered result back over the pre-filter pixels.
      out.ctx.putImageData(cur, 0, 0);
      const tmp = this.mk(this.w, this.h);
      tmp.ctx.putImageData(applied, 0, 0);
      out.ctx.globalAlpha = alpha;
      out.ctx.globalCompositeOperation = op;
      out.ctx.drawImage(tmp.c, 0, 0);
      out.ctx.globalAlpha = 1;
      out.ctx.globalCompositeOperation = "source-over";
      cur = out.ctx.getImageData(0, 0, this.w, this.h);
    }
    // Filter mask: confine the WHOLE stack — result = orig + (filtered − orig) ×
    // mask, interpolated premultiplied so partially-covered edge pixels don't
    // tint. The mask alpha lives in fmAlpha's A channel (the derived cache).
    if (base && cur !== base) {
      const m = fmAlpha!.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
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
    out.ctx.putImageData(cur, 0, 0);
    return out.c;
  }

  /** Borrow a reusable doc-sized buffer (lazily (re)allocated on size change). */
  private adjBuf(key: string, readFreq = false): Layer {
    let b = this.adjBufs[key];
    if (!b || b.c.width !== this.w || b.c.height !== this.h) {
      b = this.mk(this.w, this.h, readFreq);
      this.adjBufs[key] = b;
    }
    return b;
  }

  /** Composite a sibling list bottom→top into `ctx`. The list is first partitioned
   *  into clip groups (`clipGroupsOf`): a plain node draws on its own; a base with
   *  clipped members above it is assembled and clipped to the base's silhouette.
   *  Adjustment nodes (solo) read what is already beneath them in `ctx`.
   *  Every product routes through the render cache (Spec 06). */
  private drawStack(ctx: CanvasRenderingContext2D, nodes: LayerNode[]) {
    for (const unit of clipGroupsOf(nodes)) {
      if (unit.maskFrom) {
        this.drawBorrowedClipRun(ctx, unit);
        continue;
      }
      if (unit.members.length) {
        this.drawClipGroup(ctx, unit.base, unit.members);
        continue;
      }
      const node = unit.base;
      if (!node.visible) continue;
      if (node.type === "adjustment") this.drawAdjustment(ctx, node, nodes);
      else this.drawNode(ctx, node);
    }
  }

  /** §16.9: a clipped run separated from its pixel base by non-clipped
   *  adjustments. Photoshop semantics: the run renders at its OWN stack
   *  position (the adjustments beneath never touch its pixels) while every
   *  node in it clips to the borrowed base's silhouette; each node composites
   *  in place with its own blend/opacity, so blends interact with the
   *  already-adjusted backdrop. Deliberately uncached — the node intrinsics
   *  behind renderNode still cache; assembly is two drawImages per node. */
  private drawBorrowedClipRun(ctx: CanvasRenderingContext2D, unit: ClipGroup) {
    const from = unit.maskFrom!;
    if (!from.visible) return; // hidden base ⇒ clipped content shows nothing
    const sil = this.renderNode(from);
    if (!sil) return;
    for (const m of [unit.base, ...unit.members]) {
      if (!m.visible) continue;
      if (m.type === "adjustment") {
        this.applyAdjustmentNode(ctx, m, sil);
        continue;
      }
      const ms = this.renderNode(m);
      if (!ms) continue;
      const { c: tc, ctx: t } = this.mk(this.w, this.h);
      t.drawImage(ms, 0, 0);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(sil, 0, 0);
      t.globalCompositeOperation = "source-over";
      ctx.globalAlpha = Math.max(0, Math.min(1, m.opacity / 100));
      ctx.globalCompositeOperation = blendOp(m.blend);
      ctx.drawImage(tc, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  /** Cache-backed adjustment step. The cached product is the WHOLE accumulator
   *  after the adjustment applied — keyed by the adjustment's params/mask/blend
   *  and the effective keys of every lower sibling (belowSig), so editing below
   *  invalidates it while editing the adjustment alone never re-renders its
   *  lower siblings. Bypassed while any lower sibling hosts a live session. */
  private drawAdjustment(ctx: CanvasRenderingContext2D, node: LayerAdjustment, siblings: LayerNode[]) {
    let bypass = !this.renderCacheOn || this.liveBypass.has(node.id);
    if (!bypass) {
      const idx = siblings.indexOf(node);
      for (let i = idx + 1; i < siblings.length && !bypass; i++) {
        if (this.liveBypass.has(siblings[i].id)) bypass = true;
      }
    }
    // Only cache against the document-level accumulator geometry (doc-sized).
    if (ctx.canvas.width !== this.w || ctx.canvas.height !== this.h) bypass = true;
    const key = bypass ? "" : this.adjustmentKey(node, siblings);
    // Very large documents store this product as a tile grid instead of one
    // canvas (per-tile eviction + per-tile recompute) — exactly one of the two
    // paths runs for a given document size, so the caches never mix.
    const grid = bypass ? null : tileGrid(this.w, this.h);
    if (grid) {
      this.drawAdjustmentTiled(ctx, node, key, grid);
      return;
    }
    if (!bypass) {
      const hit = this.renderCache.get(node.id);
      if (hit && hit.key === key) {
        hit.tick = ++this.renderTick;
        this.frameProtect.add(node.id);
        // A key match proves the product equals f(current below-state): reset
        // the dirty bookkeeping so the next miss can be region-scoped.
        if (this.curTree)
          this.adjMeta.set(node.id, {
            ownSig: this.adjustmentOwnSig(node),
            tree: this.curTree,
            dirty: null,
            unbounded: false,
          });
        ctx.globalCompositeOperation = "copy"; // replace the accumulator wholesale
        ctx.drawImage(hit.c, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        return;
      }
      // Miss. If everything that changed beneath since the cached product was
      // built is rect-bounded (same immutable tree, per-pixel changes only, no
      // effect/filter reach — see bumpPixel/changeReaches), the adjustment only
      // needs re-processing INSIDE that rect: adjustments are strictly
      // per-pixel, so outside it f(below) is byte-identical to the old product.
      const prev = this.renderCache.get(node.id);
      const meta = this.adjMeta.get(node.id);
      if (
        prev &&
        meta &&
        !meta.unbounded &&
        meta.dirty &&
        this.curTree !== null &&
        meta.tree === this.curTree &&
        meta.ownSig === this.adjustmentOwnSig(node) &&
        // Equalize reads the WHOLE image's histogram — a bounded change below
        // it changes every output pixel, so it can never be region-scoped.
        node.adjustment.type !== "equalize" &&
        // Tone specs with the GPU pass active take the full path instead: it is
        // already cheap (no readback / JS loop), and patching a GPU product
        // with CPU pixels could seam at the region border (sub-LSB
        // unpremultiply differences on semi-transparent pixels).
        (!(node.adjustment.type === "levels" || node.adjustment.type === "curves") ||
          !this.gpuAvailable())
      ) {
        const r = clampRect(meta.dirty, this.w, this.h);
        // Worth it only while the region is clearly smaller than the document.
        if (r && r.w * r.h <= 0.7 * this.w * this.h) {
          const own = this.mk(this.w, this.h);
          own.ctx.drawImage(prev.c, 0, 0); // old post-apply pixels everywhere
          // Fresh BELOW pixels inside the region…
          own.ctx.save();
          own.ctx.beginPath();
          own.ctx.rect(r.x, r.y, r.w, r.h);
          own.ctx.clip();
          own.ctx.clearRect(r.x, r.y, r.w, r.h);
          own.ctx.drawImage(ctx.canvas, 0, 0);
          own.ctx.restore();
          // …processed by the same math as the full path, region-scoped.
          this.applyAdjustmentRegion(own.ctx, node, r);
          ctx.globalCompositeOperation = "copy";
          ctx.drawImage(own.c, 0, 0);
          ctx.globalCompositeOperation = "source-over";
          this.cacheStore(node.id, key, own.c, true);
          this.adjMeta.set(node.id, {
            ownSig: meta.ownSig,
            tree: meta.tree,
            dirty: null,
            unbounded: false,
          });
          return;
        }
      }
    }
    this.applyAdjustmentNode(ctx, node); // the full-document read-back path
    if (!bypass) {
      const own = this.mk(this.w, this.h);
      own.ctx.drawImage(ctx.canvas, 0, 0);
      this.cacheStore(node.id, key, own.c, true);
      if (this.curTree)
        this.adjMeta.set(node.id, {
          ownSig: this.adjustmentOwnSig(node),
          tree: this.curTree,
          dirty: null,
          unbounded: false,
        });
    }
  }

  /** Tiled twin of the cached-adjustment step (very large documents — §8 tiled
   *  compositing). The product (the WHOLE accumulator after the adjustment)
   *  lives as a grid of tiles. A full key hit draws the resident tiles and
   *  recomputes only evicted ones from the below-accumulator; a key miss whose
   *  changes since caching were all rect-bounded (same immutable tree,
   *  per-pixel changes — the adjMeta proof) recomputes just the tiles under
   *  that rect. Anything else rebuilds every tile from one full pass. The
   *  adjustment math + modulation are strictly per-pixel, so a lone tile
   *  recompute is byte-identical to the full pass inside that tile. GPU tone
   *  products are never patched with CPU tiles (sub-LSB unpremultiply
   *  divergence could seam at tile borders): with the GPU pass active, ANY
   *  staleness takes the full pass — itself cheap, no readback — and every
   *  tile re-slices from that single consistent source. */
  private drawAdjustmentTiled(
    ctx: CanvasRenderingContext2D,
    node: LayerAdjustment,
    key: string,
    grid: TileGrid,
  ) {
    const id = node.id;
    const n = grid.cols * grid.rows;
    let entry = this.tiledAdj.get(id) ?? null;
    if (entry && (entry.tiles.length !== n || entry.grid.cols !== grid.cols)) {
      // Stale grid (resize bumps the epoch and clears — belt and braces only).
      this.dropTiled(id);
      entry = null;
    }
    const ownSig = this.adjustmentOwnSig(node, false);
    // Which tiles need recomputing? null = all of them (full rebuild).
    let stale: boolean[] | null = null;
    if (entry && entry.key === key) {
      stale = entry.tiles.map((t) => !t); // valid product — only evicted tiles
    } else if (entry) {
      const meta = this.adjMeta.get(id);
      if (
        meta &&
        !meta.unbounded &&
        meta.dirty &&
        this.curTree !== null &&
        meta.tree === this.curTree &&
        meta.ownSig === ownSig
      ) {
        const r = clampRect(meta.dirty, this.w, this.h);
        if (r)
          stale = entry.tiles.map(
            (t, i) => !t || rectsOverlap(tileRect(i, grid, this.w, this.h), r),
          );
      }
    }
    const specT = node.adjustment.type;
    if (
      stale &&
      stale.some(Boolean) &&
      (specT === "equalize" || // whole-image histogram — a tile can't recompute alone
        ((specT === "levels" || specT === "curves") && this.gpuAvailable()))
    )
      stale = null; // rebuild every tile from one full pass, never mix sources
    if (!entry || !stale) {
      // Full rebuild: the existing full-document math leaves the post-state in
      // the accumulator; slice it into (reused) tile canvases.
      this.applyAdjustmentNode(ctx, node);
      if (!entry) {
        entry = { key, grid, tiles: new Array<AdjTile | null>(n).fill(null), bytes: 0, tick: 0 };
        this.tiledAdj.set(id, entry);
      }
      for (let i = 0; i < n; i++) {
        const tr = tileRect(i, grid, this.w, this.h);
        const tile = this.tileFor(entry, i, tr);
        tile.ctx.clearRect(0, 0, tr.w, tr.h);
        tile.ctx.drawImage(ctx.canvas, tr.x, tr.y, tr.w, tr.h, 0, 0, tr.w, tr.h);
        tile.tick = ++this.renderTick;
      }
    } else {
      // Recompute stale tiles alone: copy the below pixels (the accumulator)
      // into the tile, then run the same region math the partial path uses.
      for (let i = 0; i < n; i++) {
        if (!stale[i]) continue;
        const tr = tileRect(i, grid, this.w, this.h);
        const tile = this.tileFor(entry, i, tr);
        tile.ctx.globalAlpha = 1;
        tile.ctx.globalCompositeOperation = "source-over";
        tile.ctx.clearRect(0, 0, tr.w, tr.h);
        tile.ctx.drawImage(ctx.canvas, tr.x, tr.y, tr.w, tr.h, 0, 0, tr.w, tr.h);
        this.applyAdjustmentRegion(tile.ctx, node, tr, true);
      }
      // Every tile is valid now — replace the accumulator with the product.
      // The tiles partition the document exactly, so clearing + drawing each
      // is equivalent to the whole-canvas path's `copy` blit.
      ctx.clearRect(0, 0, this.w, this.h);
      for (let i = 0; i < n; i++) {
        const tr = tileRect(i, grid, this.w, this.h);
        const tile = entry.tiles[i]!;
        ctx.drawImage(tile.c, tr.x, tr.y);
        tile.tick = ++this.renderTick;
      }
    }
    entry.key = key;
    entry.tick = ++this.renderTick;
    this.frameProtect.add(id);
    if (this.curTree)
      this.adjMeta.set(id, { ownSig, tree: this.curTree, dirty: null, unbounded: false });
  }

  /** The tile at `i`, allocated (and byte-accounted) on first need. Dimensions
   *  per index are fixed for a given grid, so reuse never needs a resize. */
  private tileFor(entry: TiledAdjProduct, i: number, tr: Rect): AdjTile {
    let tile = entry.tiles[i];
    if (!tile) {
      const { c, ctx } = this.mk(tr.w, tr.h);
      tile = { c, ctx, bytes: tr.w * tr.h * 4, tick: 0 };
      entry.tiles[i] = tile;
      entry.bytes += tile.bytes;
      this.renderBytes += tile.bytes;
    }
    return tile;
  }

  /** The adjustment-key components that are NOT the below signature — a partial
   *  (region-scoped) product update is only sound when these are unchanged.
   *  The tiled path excludes the mask version (`includeMask: false`): mask
   *  modulation is per-pixel, so a rect-bounded mask paint keeps untouched
   *  tiles valid — the changed rect arrives via adjMeta.dirty (bumpMask →
   *  noteBelowChange), and structural mask changes (attach/enable) build a new
   *  tree, which the meta tree-identity check catches. */
  private adjustmentOwnSig(node: LayerAdjustment, includeMask = true): string {
    const mv = !includeMask ? "m" : node.mask?.enabled ? (this.maskVersion.get(node.id) ?? 0) : "x";
    return `${fnv(this.specHash(node.adjustment))}|${mv}|${node.opacity}|${node.blend}|${this.cs}|${this.docEpoch}`;
  }

  /** Cache-backed clip-group step: the assembled group (pre base opacity/blend)
   *  is cached under `clip:<base id>`, keyed by the base's intrinsic key plus
   *  every member's effective key. */
  private drawClipGroup(ctx: CanvasRenderingContext2D, base: LayerNode, members: LayerNode[]) {
    if (!base.visible) return; // hidden base ⇒ the whole group shows nothing
    let bypass = !this.renderCacheOn || this.liveBypass.has(base.id);
    for (const m of members) if (this.liveBypass.has(m.id)) bypass = true;
    let key = "";
    if (!bypass) {
      let sig = base.type === "adjustment" ? "" : this.nodeKey(base);
      for (const m of members) sig += "|" + this.effectiveKey(m);
      key = `CLIP${fnv(sig)}|${this.cs}|${this.docEpoch}`;
    }
    const cacheId = `clip:${base.id}`;
    let cg: HTMLCanvasElement | null = null;
    if (!bypass) {
      const hit = this.renderCache.get(cacheId);
      if (hit && hit.key === key) {
        hit.tick = ++this.renderTick;
        this.frameProtect.add(cacheId);
        cg = hit.c;
      }
    }
    if (!cg) {
      cg = this.buildClipGroup(base, members);
      if (!cg) return;
      if (!bypass) this.cacheStore(cacheId, key, cg, true);
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, base.opacity / 100));
    ctx.globalCompositeOperation = blendOp(base.blend);
    ctx.drawImage(cg, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Assemble a clip group — the base plus its clipped members (bottom→top) —
   *  into a fresh buffer (pre base opacity/blend; drawClipGroup applies those).
   *  Members blend within the group; the whole group is clipped to the base's
   *  masked silhouette. Fresh buffers so nested clip groups never clobber. */
  private buildClipGroup(base: LayerNode, members: LayerNode[]): HTMLCanvasElement | null {
    const w = this.w;
    const h = this.h;
    // 1. base pixels (styled ⊗ masked — the base's own cached intrinsic render).
    const baseIntrinsic = this.renderNode(base);
    if (!baseIntrinsic) return null;
    const hasAdj = members.some((m) => m.type === "adjustment");
    const { c: cgC, ctx: cg } = this.mk(w, h, hasAdj);
    cg.drawImage(baseIntrinsic, 0, 0);
    // 2. snapshot the clip silhouette (base alpha, post-mask) before members grow it.
    const { c: clipC, ctx: clipCtx } = this.mk(w, h);
    clipCtx.drawImage(cgC, 0, 0);
    // 3. draw each visible member with its own blend + opacity + mask (adjustments
    //    process the base-shaped buffer in place).
    for (const m of members) {
      if (!m.visible) continue;
      if (m.type === "adjustment") {
        this.applyAdjustmentNode(cg, m);
        continue;
      }
      const ms = this.renderNode(m);
      if (!ms) continue;
      cg.globalAlpha = Math.max(0, Math.min(1, m.opacity / 100));
      cg.globalCompositeOperation = blendOp(m.blend);
      cg.drawImage(ms, 0, 0);
      cg.globalAlpha = 1;
      cg.globalCompositeOperation = "source-over";
    }
    // 4. clip the assembled group to the base silhouette.
    cg.globalCompositeOperation = "destination-in";
    cg.drawImage(clipC, 0, 0);
    cg.globalCompositeOperation = "source-over";
    return cgC;
  }

  /** Build (and cache per spec) the LUTs for a Curves/Levels node. */
  private toneLUTs(id: string, spec: ToneAdjustment): ToneLUTs {
    const key = this.specHash(spec);
    const hit = this.toneCache.get(id);
    if (hit && hit.key === key) return hit.luts;
    const luts = spec.type === "levels" ? buildLevelsLUTs(spec) : buildCurvesLUTs(spec);
    this.toneCache.set(id, { key, luts });
    return luts;
  }

  /** The 65k-entry twin, cached beside the 8-bit tables (same spec key). */
  private toneLUTs16(id: string, spec: ToneAdjustment): ToneLUTs16 {
    const key = this.specHash(spec);
    let hit = this.toneCache.get(id);
    if (!hit || hit.key !== key) {
      this.toneLUTs(id, spec); // (re)build + cache the 8-bit entry first
      hit = this.toneCache.get(id)!;
    }
    if (!hit.luts16)
      hit.luts16 = spec.type === "levels" ? buildLevelsLUTs16(spec) : buildCurvesLUTs16(spec);
    return hit.luts16;
  }

  /** Re-process everything in `ctx` beneath this adjustment node, modulated by the
   *  node's opacity × layer-mask and blended with its blend mode. Sliders reuse
   *  `applyAdjustments`; Curves/Levels apply cached LUTs. Clipping is NOT handled
   *  here — a clipped adjustment is a clip-group member processed against the
   *  already-base-shaped buffer (see renderClipGroup). */
  /** Region-scoped twin of applyAdjustmentNode: reads the below pixels only in
   *  `r`, processes them with the SAME math, and composes them back modulated
   *  by opacity × mask × blend — all confined to `r`. Every operation involved
   *  (the adjustment itself, the alpha modulation, canvas blend modes) is
   *  per-pixel, so the result is byte-identical to a full re-process inside `r`
   *  and untouched outside it. `local` = `ctx` is an r-sized canvas whose (0,0)
   *  is the document's (r.x, r.y) — a tile — so pixel reads/writes drop the
   *  offset while the (doc-sized) mask still samples at doc coords. */
  private applyAdjustmentRegion(
    ctx: CanvasRenderingContext2D,
    node: LayerAdjustment,
    r: Rect,
    local = false,
  ) {
    const ox = local ? 0 : r.x;
    const oy = local ? 0 : r.y;
    const spec = node.adjustment;
    if (this.specIsNeutral(spec)) return; // neutral → no-op
    const out = this.applyColorMath(ctx.getImageData(ox, oy, r.w, r.h), this.colorOpFor(node), true);
    const maskAlpha = node.mask?.enabled ? this.maskDisplay(node.id) : null;
    const opacity = Math.max(0, Math.min(1, node.opacity / 100));
    const op = blendOp(node.blend);
    if (opacity >= 1 && !maskAlpha && op === "source-over") {
      ctx.putImageData(out, ox, oy); // fast path: unmasked Normal replace
      return;
    }
    // Region-sized buffers (the full path uses doc-sized shared ones).
    const tmp = this.mk(r.w, r.h);
    tmp.ctx.putImageData(out, 0, 0);
    const mod = this.mk(r.w, r.h);
    mod.ctx.fillStyle = `rgba(0,0,0,${opacity})`;
    mod.ctx.fillRect(0, 0, r.w, r.h);
    if (maskAlpha) {
      mod.ctx.globalCompositeOperation = "destination-in";
      mod.ctx.drawImage(maskAlpha, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      mod.ctx.globalCompositeOperation = "source-over";
    }
    tmp.ctx.globalCompositeOperation = "destination-in";
    tmp.ctx.drawImage(mod.c, 0, 0);
    tmp.ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(tmp.c, ox, oy);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** The applyColorMath op for a node's spec (sliders / tone LUTs / extra). */
  private colorOpFor(node: LayerAdjustment) {
    const spec = node.adjustment;
    if (spec.type === "sliders") return { kind: "sliders" as const, params: spec.params };
    if (isExtraSpec(spec)) return { kind: "extra" as const, spec };
    return {
      kind: "tone" as const,
      luts: this.toneLUTs(node.id, spec),
      luts16: () => this.toneLUTs16(node.id, spec),
    };
  }

  /** True when the spec provably changes nothing (skip the whole pass). */
  private specIsNeutral(spec: LayerAdjustment["adjustment"]): boolean {
    if (spec.type === "sliders") return isDefaultAdjust(spec.params);
    if (isExtraSpec(spec)) return extraIsDefault(spec);
    return false; // tone specs: identity LUTs are cheap enough
  }

  private applyAdjustmentNode(
    ctx: CanvasRenderingContext2D,
    node: LayerAdjustment,
    clipAlpha: HTMLCanvasElement | null = null,
  ) {
    const w = this.w;
    const h = this.h;
    if (w < 1 || h < 1) return;
    const spec = node.adjustment;
    if (this.specIsNeutral(spec)) return; // neutral → no-op
    // Tone specs (Curves/Levels) take the GPU LUT pass when available: the
    // accumulator uploads straight to a texture and the result comes back via
    // drawImage — no full-document getImageData, no JS per-pixel loop. The
    // extra kinds are cross-channel (not per-channel LUTs), so they stay CPU.
    const toneSpec = spec.type === "levels" || spec.type === "curves" ? spec : null;
    const gpuOut = toneSpec ? this.gpuToneRender(ctx.canvas, w, h, this.toneLUTs(node.id, toneSpec)) : null;
    const out = gpuOut
      ? null
      : this.applyColorMath(
          ctx.getImageData(0, 0, w, h),
          this.colorOpFor(node),
          true, // fresh getImageData — the tone/extra paths may mutate it in place
        );
    const maskAlpha = node.mask?.enabled ? this.maskDisplay(node.id) : null;
    const opacity = Math.max(0, Math.min(1, node.opacity / 100));
    const op = blendOp(node.blend);
    if (opacity >= 1 && !maskAlpha && !clipAlpha && op === "source-over") {
      // Fast path: full, unmasked, Normal replace.
      if (gpuOut) {
        ctx.globalCompositeOperation = "copy";
        ctx.drawImage(gpuOut, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.putImageData(out!, 0, 0);
      }
      return;
    }
    // Adjusted pixels in a temp, then confine them to the modulation alpha.
    const tmp = this.adjBuf("tmp");
    tmp.ctx.globalAlpha = 1;
    tmp.ctx.globalCompositeOperation = "source-over";
    tmp.ctx.clearRect(0, 0, w, h);
    if (gpuOut) tmp.ctx.drawImage(gpuOut, 0, 0);
    else tmp.ctx.putImageData(out!, 0, 0);
    const mod = this.adjBuf("mod");
    mod.ctx.globalAlpha = 1;
    mod.ctx.globalCompositeOperation = "source-over";
    mod.ctx.clearRect(0, 0, w, h);
    mod.ctx.fillStyle = `rgba(0,0,0,${opacity})`; // uniform opacity as alpha
    mod.ctx.fillRect(0, 0, w, h);
    if (maskAlpha) {
      mod.ctx.globalCompositeOperation = "destination-in";
      mod.ctx.drawImage(maskAlpha, 0, 0);
    }
    if (clipAlpha) {
      // Borrowed-silhouette confinement (§16.9 orphan clipped adjustments).
      mod.ctx.globalCompositeOperation = "destination-in";
      mod.ctx.drawImage(clipAlpha, 0, 0);
    }
    mod.ctx.globalCompositeOperation = "source-over";
    tmp.ctx.globalCompositeOperation = "destination-in";
    tmp.ctx.drawImage(mod.c, 0, 0);
    tmp.ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(tmp.c, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Flatten the layer tree into a new doc-sized canvas (for image export).
   *  Always composes the ENTIRE document (never region-scoped). It may reuse
   *  valid caches; pass `clean` to force a full recompute for byte-certain
   *  output regardless of cache state. */
  exportComposite(tree: LayerNode[], clean = false): HTMLCanvasElement {
    const wasOn = this.renderCacheOn;
    const gpuWas = this.gpuOn;
    this.exporting = true; // no preview/stale filter products in exports
    if (clean) {
      this.renderCacheOn = false;
      this.gpuOn = false; // byte-certain output = the always-correct CPU path
    }
    this.keyMemo.clear();
    this.frameProtect.clear();
    this.liveBypass = this.computeLiveBypass(tree);
    this.curTree = tree;
    const { c, ctx } = this.mk(this.w, this.h, true); // readback for adjustment nodes
    this.drawStack(ctx, tree);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    this.renderCacheOn = wasOn;
    this.gpuOn = gpuWas;
    this.exporting = false;
    return c;
  }

  /**
   * Per-channel + luminosity tonal distribution of the composited canvas (256
   * bins each). Fully transparent pixels are skipped; with a selection, only
   * pixels inside it count (the mask downsamples with the composite). The
   * composite is read back at a capped resolution so the scan stays fast on
   * large documents — the shape of the distribution is what the panel
   * displays, so downsampling is harmless.
   */
  histogram(
    tree: LayerNode[],
    sel: Rect[] | null = null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ): ChannelHistogram {
    const r = new Array<number>(256).fill(0);
    const g = new Array<number>(256).fill(0);
    const b = new Array<number>(256).fill(0);
    const l = new Array<number>(256).fill(0);
    if (this.w < 1 || this.h < 1) return { r, g, b, l };
    // Same frame setup as composite()/exportComposite(): the per-frame key memo
    // must not leak across states — this runs from a debounced timer, which can
    // fire with NO composite in between (e.g. a background tab suspends rAF but
    // not timeouts), and a stale memoized key would validate a stale cache hit.
    this.keyMemo.clear();
    this.frameProtect.clear();
    this.liveBypass = this.computeLiveBypass(tree);
    this.curTree = tree;
    // Reused accumulator — this recomputes on every (debounced) content change,
    // so a fresh doc-sized canvas per call was pure allocation churn.
    const full = this.adjBuf("hist", true);
    full.ctx.globalAlpha = 1;
    full.ctx.globalCompositeOperation = "source-over";
    full.ctx.clearRect(0, 0, this.w, this.h);
    this.drawStack(full.ctx, tree);
    full.ctx.globalAlpha = 1;
    full.ctx.globalCompositeOperation = "source-over";

    const cap = 480;
    const scale = Math.min(1, cap / Math.max(this.w, this.h));
    const maskCanvas = sel?.length ? this.selectionMask(sel, selAngle, selPivot, 0) : null;
    let data: Uint8ClampedArray;
    let mask: Uint8ClampedArray | null = null;
    if (scale < 1) {
      const sw = Math.max(1, Math.round(this.w * scale));
      const sh = Math.max(1, Math.round(this.h * scale));
      const small = this.mk(sw, sh, true);
      small.ctx.imageSmoothingEnabled = true;
      small.ctx.imageSmoothingQuality = "low";
      small.ctx.drawImage(full.c, 0, 0, sw, sh);
      data = small.ctx.getImageData(0, 0, sw, sh).data;
      if (maskCanvas) {
        const sm = this.mk(sw, sh, true);
        sm.ctx.imageSmoothingEnabled = true;
        sm.ctx.drawImage(maskCanvas, 0, 0, sw, sh);
        mask = sm.ctx.getImageData(0, 0, sw, sh).data;
      }
    } else {
      data = full.ctx.getImageData(0, 0, this.w, this.h).data;
      if (maskCanvas) {
        mask = maskCanvas.getContext("2d")!.getImageData(0, 0, this.w, this.h).data;
      }
    }
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // ignore fully transparent pixels
      if (mask && mask[i + 3] < 128) continue; // outside the selection
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      r[R]++;
      g[G]++;
      b[B]++;
      l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    }
    return { r, g, b, l };
  }

  /** Composite the layer tree (bottom→top, nested groups) onto the view canvas.
   *  Builds into an offscreen accumulator first so adjustment nodes can read back
   *  what is beneath them from a willReadFrequently buffer, then blits to the view. */
  composite(tree: LayerNode[]) {
    const ctx = this.vctx;
    if (!ctx) return;
    if (this.maskView) {
      // Mask view (Alt-click on a mask chip / Channels panel): the mask's
      // EFFECTIVE grayscale (R×A/255 — the same math the alpha derivation
      // uses) replaces the composite; a live stroke targeting this mask
      // previews through the same drawStroke path the normal view uses.
      const key =
        this.maskView.surface === "filterMask" ? filterMaskKey(this.maskView.id) : this.maskView.id;
      const mask = this.masks.get(key);
      if (mask) {
        if (!this.maskPrevG || this.maskPrevG.c.width !== this.w || this.maskPrevG.c.height !== this.h)
          this.maskPrevG = this.mkMask(true);
        const g = this.maskPrevG;
        g.ctx.globalAlpha = 1;
        g.ctx.globalCompositeOperation = "source-over";
        g.ctx.clearRect(0, 0, this.w, this.h);
        g.ctx.drawImage(mask.c, 0, 0);
        if (
          this.painting &&
          this.strokeOnMask &&
          this.stroke &&
          this.strokeLayer &&
          this.maskKeyOf(this.strokeLayer) === key
        ) {
          this.drawStroke(g.ctx);
        }
        const img = g.ctx.getImageData(0, 0, this.w, this.h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = (d[i] * d[i + 3]) / 255;
          d[i] = v;
          d[i + 1] = v;
          d[i + 2] = v;
          d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        this.pendingDirty = null;
        this.lastTree = tree;
        return;
      }
    }
    // Frame setup for the render graph: fresh key memo + used-entry protection,
    // and the set of live-session layers (+ ancestors) that bypass the cache.
    this.keyMemo.clear();
    this.frameProtect.clear();
    this.liveBypass = this.computeLiveBypass(tree);
    this.curTree = tree;
    const acc = this.adjBuf("comp", true);
    acc.ctx.globalAlpha = 1;
    acc.ctx.globalCompositeOperation = "source-over";
    acc.ctx.clearRect(0, 0, this.w, this.h);
    this.drawStack(acc.ctx, tree);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // Dirty-region view blit: taken only when every change since the last
    // composite was rect-bounded AND the tree reference is unchanged (the same
    // immutable tree ⇒ no structural / props change slipped past the rects).
    // Anything else — including cache-disabled A/B mode — blits the full doc.
    const d =
      this.renderCacheOn && this.lastTree === tree && this.pendingDirty
        ? clampRect(this.pendingDirty, this.w, this.h)
        : null;
    if (this.proofingActive()) {
      // Soft proof: transform the blitted pixels through the target space on
      // the way to the view (the document itself is untouched). Reuses the
      // dirty-rect bound so painting under a proof stays region-priced.
      const x = d?.x ?? 0;
      const y = d?.y ?? 0;
      const w = d?.w ?? this.w;
      const h = d?.h ?? this.h;
      if (w > 0 && h > 0) {
        const img = acc.ctx.getImageData(x, y, w, h);
        proofTransformInPlace(img.data, this.cs, this.proofTarget, this.proofSimulate, this.gamutWarn);
        ctx.putImageData(img, x, y);
      }
    } else if (d) {
      ctx.clearRect(d.x, d.y, d.w, d.h);
      ctx.drawImage(acc.c, d.x, d.y, d.w, d.h, d.x, d.y, d.w, d.h);
    } else {
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.drawImage(acc.c, 0, 0);
    }
    this.pendingDirty = null;
    this.lastTree = tree;
    this.evictOverBudget();
  }

  /** Begin moving pixels: lift the selection (or whole layer) into a float buffer.
   *  `linkedMask` (whole-layer moves only): shift the layer's mask along with the
   *  pixels on commit — the Layers-panel chain toggle. */
  beginMove(layerId: string, rects: Rect[] | null, linkedMask = false) {
    if (!this.stroke) return;
    this.moving = true;
    this.moveMaskLinked = linkedMask && !rects;
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
      // Linked mask (whole-layer move): shift the mask by the same delta and
      // fold its patch into the SAME history step via side callbacks, so one
      // undo restores pixels and mask together.
      let side: HistorySide | undefined;
      const mask = this.moveMaskLinked ? this.masks.get(this.moveLayer) : undefined;
      if (mask) {
        const id = this.moveLayer;
        const maskBefore = mask.ctx.getImageData(0, 0, this.w, this.h);
        mask.ctx.globalAlpha = 1;
        mask.ctx.globalCompositeOperation = "source-over";
        mask.ctx.fillStyle = "#000"; // vacated area = hidden (matches offsetMask)
        mask.ctx.fillRect(0, 0, this.w, this.h);
        mask.ctx.putImageData(maskBefore, Math.round(this.moveOff.x), Math.round(this.moveOff.y));
        this.deriveMaskAlpha(id);
        const maskAfter = mask.ctx.getImageData(0, 0, this.w, this.h);
        side = {
          undo: () => {
            const m = this.masks.get(id);
            if (m) {
              m.ctx.putImageData(maskBefore, 0, 0);
              this.deriveMaskAlpha(id);
            }
          },
          redo: () => {
            const m = this.masks.get(id);
            if (m) {
              m.ctx.putImageData(maskAfter, 0, 0);
              this.deriveMaskAlpha(id);
            }
          },
        };
      }
      if (region.w > 0 && region.h > 0) {
        const before = this.moveOrig.ctx.getImageData(region.x, region.y, region.w, region.h);
        const after = l.ctx.getImageData(region.x, region.y, region.w, region.h);
        this.pushEntry(this.moveLayer, region, before, after, "Move", side);
      }
    }
    this.moving = false;
    this.moveMaskLinked = false;
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
    this.strokeOnMask = this.activeSurface(layerId) === "mask"; // paint the mask when it's active
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
    const mid = this.maskKeyOf(layerId);
    const onMask = this.strokeOnMask && this.masks.has(mid);
    const target = onMask ? this.masks.get(mid)! : this.layer(layerId);
    const rect = this.dirtyRect();
    if (rect) {
      const before = target.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.drawStroke(target.ctx);
      const after = target.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      this.pushEntry(
        onMask ? mid : layerId,
        rect,
        before,
        after,
        onMask ? `Mask ${this.strokeLabel}` : this.strokeLabel,
        undefined,
        onMask ? "mask" : "layer",
      );
      if (onMask) this.deriveMaskAlpha(mid, rect); // refresh the alpha cache for the painted region
    }

    this.stroke.ctx.clearRect(0, 0, this.w, this.h);
    this.painting = false;
    this.strokeLayer = null;
    this.strokeOnMask = false;
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
    this.bumpPixel(layerId);
    this.emitChange();
  }

  // ---- Text ----------------------------------------------------------------
  /** Configure a context for `spec` and split the text into (wrapped) lines. */
  /** Hidden display:none host: canvas font-feature-settings only applies while
   *  the canvas element is CONNECTED (verified in Chromium) — so feature-bearing
   *  text mounts its canvas here for the duration of the draw/measure. */
  private static textFeatureHost: HTMLDivElement | null = null;

  /** Run `fn` with `features` active on `canvas` — mounted into the hidden host
   *  when detached, style restored after. Default features skip all DOM work,
   *  keeping legacy text byte-stable and free of layout churn. */
  private static withTextFeatures<T>(
    canvas: HTMLCanvasElement,
    features: TextOpenType | undefined,
    fn: () => T,
  ): T {
    const css = fontFeatureCSS(features);
    if (!css) return fn();
    let host = PaintEngine.textFeatureHost;
    if (!host) {
      host = document.createElement("div");
      host.style.display = "none";
      host.setAttribute("data-graphiq", "text-feature-host");
      document.body.appendChild(host);
      PaintEngine.textFeatureHost = host;
    }
    const detached = !canvas.isConnected;
    canvas.style.fontFeatureSettings = css;
    if (detached) host.appendChild(canvas);
    try {
      return fn();
    } finally {
      if (detached) host.removeChild(canvas);
      canvas.style.fontFeatureSettings = "";
    }
  }

  private textLines(ctx: CanvasRenderingContext2D, spec: TextRenderSpec): string[] {
    ctx.font = cssFontString(spec, spec.axes);
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

  /** Is a spec on the rich path (mixed runs or justified — laid out by
   *  richtext.ts) rather than the legacy uniform fast path? */
  private static isRichSpec(spec: TextRenderSpec): boolean {
    return (spec.runs?.length ?? 0) > 0 || spec.align === "justify";
  }

  /** Measurement hook for the rich layout: per-style canvas metrics with the
   *  block's tracking applied (letterSpacing), font metrics memoized. */
  private richMeasurer(ctx: CanvasRenderingContext2D, tracking: number, axes?: TextAxes): MeasureFn {
    const fontMetrics = new Map<string, { ascent: number; descent: number }>();
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing: string };
    return (text, style) => {
      const font = cssFontString(style, axes);
      ctx.font = font;
      if ("letterSpacing" in ctx) lsCtx.letterSpacing = `${tracking}px`;
      let met = fontMetrics.get(font);
      if (!met) {
        const m = ctx.measureText("Mg");
        met = {
          ascent: m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || style.fontSize * 0.8,
          descent: m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || style.fontSize * 0.2,
        };
        fontMetrics.set(font, met);
      }
      return { width: ctx.measureText(text).width, ascent: met.ascent, descent: met.descent };
    };
  }

  /** Bounding box (doc px) the text would rasterize into — for re-edit hit-testing. */
  textBounds(spec: TextRenderSpec): { x: number; y: number; w: number; h: number } {
    if (!this.measureCtx) this.measureCtx = makeCanvas(8, 8).ctx;
    const ctx = this.measureCtx;
    return PaintEngine.withTextFeatures(ctx.canvas, spec.features, () => this.textBoundsInner(ctx, spec));
  }

  private textBoundsInner(
    ctx: CanvasRenderingContext2D,
    spec: TextRenderSpec,
  ): { x: number; y: number; w: number; h: number } {
    if (PaintEngine.isRichSpec(spec)) {
      const layout = layoutRuns(
        spec.text,
        spec.runs,
        baseRunStyle(spec),
        spec.boxW,
        spec.lineHeight,
        spec.align,
        this.richMeasurer(ctx, spec.tracking, spec.axes),
      );
      const w = spec.boxW != null ? spec.boxW : Math.max(1, Math.ceil(layout.maxX - layout.minX));
      const x = spec.boxW != null ? spec.x : spec.x + layout.minX;
      return {
        x: Math.round(x),
        y: Math.round(spec.y),
        w: Math.round(w),
        h: Math.round(Math.max(1, layout.height)),
      };
    }
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
    const layer = this.layer(layerId);
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    // Non-default OpenType features need the layer canvas mounted (hidden) so
    // its font-feature-settings CSS reaches the canvas text pipeline.
    PaintEngine.withTextFeatures(layer.c, spec.features, () => {
      if (PaintEngine.isRichSpec(spec)) this.drawRichText(ctx, spec);
      else this.drawUniformText(ctx, spec);
    });
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

  /** The legacy uniform-style text body (single font/colour, canvas textAlign
   *  does the anchoring) — byte-stable for existing text layers. */
  private drawUniformText(ctx: CanvasRenderingContext2D, spec: TextRenderSpec) {
    const lines = this.textLines(ctx, spec); // sets font + letterSpacing, wraps
    ctx.fillStyle = spec.color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = spec.align as CanvasTextAlign; // never "justify" on this path

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
  }

  /** The rich path: mixed-style runs and/or justification, laid out by
   *  richtext.ts and painted segment by segment. */
  private drawRichText(ctx: CanvasRenderingContext2D, spec: TextRenderSpec) {
    const measure = this.richMeasurer(ctx, spec.tracking, spec.axes);
    const layout = layoutRuns(
      spec.text,
      spec.runs,
      baseRunStyle(spec),
      spec.boxW,
      spec.lineHeight,
      spec.align,
      measure,
    );
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; // segs carry explicit positions
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing: string };
    for (const line of layout.lines) {
      const by = spec.y + line.baseline;
      for (let i = 0; i < line.segs.length; i++) {
        const seg = line.segs[i];
        const st = seg.style;
        ctx.font = cssFontString(st, spec.axes);
        if ("letterSpacing" in ctx) lsCtx.letterSpacing = `${spec.tracking}px`;
        ctx.fillStyle = st.color;
        if (!seg.space && seg.text) ctx.fillText(seg.text, spec.x + seg.x, by);
        if (st.underline || st.strike) {
          // Span to the next segment so justify-stretched gaps stay decorated.
          const next = line.segs[i + 1];
          const w = next ? next.x - seg.x : seg.width;
          if (w > 0) {
            const met = measure("Mg", st);
            const th = Math.max(1, st.fontSize / 16);
            if (st.underline) ctx.fillRect(spec.x + seg.x, by + met.descent * 0.45, w, th);
            if (st.strike) ctx.fillRect(spec.x + seg.x, by - met.ascent * 0.32, w, th);
          }
        }
      }
    }
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
    // Mask surface active → the blur brush softens the MASK's pixels instead
    // (same session; grayscale target, history lands on the mask surface).
    this.blurOnMask = this.activeSurface(layerId) === "mask";
    const l = this.blurOnMask ? this.masks.get(this.maskKeyOf(layerId))! : this.layer(layerId);
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
    if (this.blurOnMask) {
      // Masks are colour-agnostic (sRGB) — untagged ImageData, then refresh the
      // alpha cache for the baked rect so the softened mask previews live.
      this.masks.get(this.maskKeyOf(this.blurLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.deriveMaskAlpha(this.maskKeyOf(this.blurLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.layer(this.blurLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
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
        const mid = this.blurOnMask ? this.maskKeyOf(layerId) : layerId;
        const target = this.blurOnMask ? this.masks.get(mid)! : this.layer(layerId);
        const before = this.subImage(this.blurOrig, x, y, w, h);
        const after = target.ctx.getImageData(x, y, w, h);
        this.pushEntry(mid, { x, y, w, h }, before, after, "Blur", undefined, this.blurOnMask ? "mask" : "layer");
      }
    }
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
    // Mask surface active → dodge/burn lightens/darkens the MASK (reveal/hide).
    this.dodgeOnMask = this.activeSurface(layerId) === "mask";
    const l = this.dodgeOnMask ? this.masks.get(this.maskKeyOf(layerId))! : this.layer(layerId);
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
    if (this.dodgeOnMask) {
      this.masks.get(this.maskKeyOf(this.dodgeLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.deriveMaskAlpha(this.maskKeyOf(this.dodgeLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.layer(this.dodgeLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
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
        const mid = this.dodgeOnMask ? this.maskKeyOf(layerId) : layerId;
        const target = this.dodgeOnMask ? this.masks.get(mid)! : this.layer(layerId);
        const before = this.subImage(this.dodgeOrig, x, y, w, h);
        const after = target.ctx.getImageData(x, y, w, h);
        const label = this.dodgeOpts?.mode === "burn" ? "Burn" : "Dodge";
        this.pushEntry(mid, { x, y, w, h }, before, after, label, undefined, this.dodgeOnMask ? "mask" : "layer");
      }
    }
    this.dodging = false;
    this.dodgeOnMask = false;
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
  // Preview compute runs in a dedicated Worker when available (the kernel in
  // filters.ts is pure), so slider drags never block the UI thread. Replies
  // are session- and sequence-guarded: stale results are dropped, and nothing
  // is ever applied after cancel/commit. Falls back to the sync path.
  private blurWorker: Worker | null = null;

  // ---- Heal worker (one-shot jobs; sync fallback if workers are unavailable) --
  private healWorker: Worker | null = null;
  private healWorkerBroken = false;
  private healJobSeq = 0;
  private healPending = new Map<
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
      before: ImageData;
      coverage: Uint8ClampedArray; // kept for the sync fallback on worker error
    }
  >();

  private ensureHealWorker(): Worker | null {
    if (!this.workersOn || this.healWorkerBroken) return null;
    if (this.healWorker) return this.healWorker;
    if (typeof Worker === "undefined") {
      this.healWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../workers/heal.worker.ts", import.meta.url), {
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
   *  the captured coordinates would no longer be valid. */
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
      before: ImageData;
      coverage: Uint8ClampedArray;
    },
    bytes: Uint8ClampedArray<ArrayBuffer> | null,
  ) {
    if (job.epoch !== this.docEpoch || job.docW !== this.w || job.docH !== this.h) return;
    const l = this.layers.get(job.layerId);
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
    l.ctx.putImageData(healed, job.rx, job.ry);
    this.pushEntry(
      job.layerId,
      { x: job.rx, y: job.ry, w: job.rw, h: job.rh },
      job.before,
      healed,
      job.label,
    );
    this.bumpPixel(job.layerId, { x: job.rx, y: job.ry, w: job.rw, h: job.rh });
    this.emitChange();
  }

  // ---- Smart-filter worker (stale-while-refresh product cache) ---------------
  // A node's filtered pixels are cached per node id, keyed by its nodeKey. On a
  // key miss WITH a stale product available, the recompute runs in the worker
  // while the stale product draws this frame — so param drags stay fluid; the
  // fresh result lands via onFilterWorkerMessage and triggers a recomposite.
  private filterWorker: Worker | null = null;
  private filterWorkerBroken = false;
  private filterJobSeq = 0;
  /** Per-node newest in-flight job (older replies are dropped). */
  private filterPending = new Map<
    string,
    { seq: number; key: string; quality: "preview" | "full"; docW: number; docH: number }
  >();
  private filteredCache = new Map<
    string,
    { key: string; canvas: HTMLCanvasElement; quality: "preview" | "full" }
  >();

  /** Progressive preview kicks in above this many document pixels — below it a
   *  half-res pass saves nothing worth the resample. */
  private static PREVIEW_MIN_PIXELS = 2_000_000;
  /** True while exportComposite runs: exports must never contain half-res
   *  preview or stale-param products, so anything but an exact full-quality
   *  cache hit computes synchronously at full resolution. */
  private exporting = false;

  private ensureFilterWorker(): Worker | null {
    if (!this.workersOn || this.filterWorkerBroken) return null;
    if (this.filterWorker) return this.filterWorker;
    if (typeof Worker === "undefined") {
      this.filterWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../workers/filters.worker.ts", import.meta.url), {
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
        this.clearRenderCaches();
        this.emitChange();
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
      const cv = this.mk(w, h);
      cv.ctx.putImageData(img, 0, 0);
      out = cv.c;
    } else {
      // Half-res preview → upscale to document size so consumers stay agnostic.
      const small = this.mk(w, h);
      small.ctx.putImageData(img, 0, 0);
      const cv = this.mk(this.w, this.h);
      cv.ctx.imageSmoothingEnabled = true;
      cv.ctx.imageSmoothingQuality = "high";
      cv.ctx.drawImage(small.c, 0, 0, w, h, 0, 0, this.w, this.h);
      out = cv.c;
    }
    this.storeFiltered(nodeId, key, out, pend.quality);
    // Frames composited while this was in flight cached STALE products under
    // fresh keys (the node itself, its ancestors, clip groups, adjustment
    // accumulators — tiled ones included). One cache clear is the safe, cheap
    // invalidation — the expensive part (the filter product) is warm in
    // filteredCache.
    this.clearRenderCaches();
    this.emitChange();
  }

  private storeFiltered(id: string, key: string, canvas: HTMLCanvasElement, quality: "preview" | "full") {
    this.filteredCache.delete(id); // re-insert to refresh Map order (LRU-ish)
    this.filteredCache.set(id, { key, canvas, quality });
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
    const readScaled = (source: HTMLCanvasElement): ImageData => {
      if (scale === 1) return source.getContext("2d")!.getImageData(0, 0, this.w, this.h);
      const small = this.mk(sw, sh, true);
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
  private filteredProduct(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    // Cache-disabled covers the A/B toggle AND clean exports — both must never
    // see a half-res preview product.
    const live = this.liveBypass.has(node.id) || !this.renderCacheOn;
    if (!live) {
      const key = this.nodeKey(node);
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
            this.w * this.h >= PaintEngine.PREVIEW_MIN_PIXELS ? ("preview" as const) : ("full" as const);
          if (this.kickFilterJob(node, src, key, quality)) return ent.canvas; // stale + refresh
        }
      }
      const out = this.renderFiltered(src, node.filters!, this.filterMaskAlpha(node));
      this.storeFiltered(node.id, key, out, "full");
      return out;
    }
    // A live paint/move session mutates `src` without version bumps — the key
    // can't see those changes, so always compute in-line and never cache.
    return this.renderFiltered(src, node.filters!, this.filterMaskAlpha(node));
  }
  private blurWorkerBroken = false;
  private blurSessionId = 0;
  private blurRenderSeq = 0;
  private blurPending = new Map<number, (applied: boolean) => void>();

  private ensureBlurWorker(): Worker | null {
    if (!this.workersOn || this.blurWorkerBroken) return null;
    if (this.blurWorker) return this.blurWorker;
    if (typeof Worker === "undefined") {
      this.blurWorkerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL("../workers/blurfx.worker.ts", import.meta.url), {
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
      this.layer(r.id).ctx.putImageData(img, 0, 0);
      this.bumpPixel(r.id);
    }
    this.emitChange();
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
      this.layer(id).ctx.putImageData(out, 0, 0);
      this.bumpPixel(id); // direct pixel write — keep render/styled caches honest
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
    this.blurWorkerEnd();
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
      if (o) {
        this.layer(id).ctx.putImageData(o, 0, 0);
        this.bumpPixel(id);
      }
    }
    this.blurFx = null;
    this.blurWorkerEnd();
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
  /** Put a pixel patch onto the entry's surface (layer or mask), re-deriving the
   *  mask alpha cache for the patched rect when it targets a mask. */
  private putPatch(e: Entry, img: ImageData) {
    if (!e.layerId || !e.rect) return;
    if (e.surface === "mask") {
      const mask = this.masks.get(e.layerId);
      if (!mask) return;
      mask.ctx.putImageData(img, e.rect.x, e.rect.y);
      this.deriveMaskAlpha(e.layerId, e.rect);
    } else {
      this.layer(e.layerId).ctx.putImageData(img, e.rect.x, e.rect.y);
      this.bumpPixel(e.layerId, e.rect); // invalidate + bound the repaint region
    }
  }
  private apply(e: Entry) {
    if (e.after) this.putPatch(e, e.after);
  }
  private revert(e: Entry) {
    if (e.before) this.putPatch(e, e.before);
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
