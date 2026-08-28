import { parseColor, toHex8 } from "./color";
import {
  DUAL_VARIANTS,
  dualMask,
  textureAlpha,
  tipShapingActive,
  type DualTipSettings,
  type TextureSettings,
  makeRng,
  scatterActive,
  scatterOffsets,
  tipRadius,
  tipShapeActive,
  type ScatterSettings,
  type TipShapeSettings,
} from "./brush-tip";
import {
  afterStroke as mixerAfterStroke,
  averageColor,
  initialMixerState,
  mixerBlend,
  mixerDab,
  type MixerSettings,
  type MixerState,
  type Rgba,
} from "./mixer";
import type { Rect } from "./view";
import { blendInto } from "./blend";
import { sentinelPasses } from "./canvas-ceiling";
import { blendOp, clipGroupsOf, filterMaskKey, findNode, type ClipGroup } from "./layers";
import type { ActiveSurface, LayerAdjustment, LayerGroup, LayerLeaf, LayerNode } from "./layers";
import { applyAdjustments, applyAdjustments16, isDefaultAdjust, type Adjustments } from "./adjust";
import { applyExtraAdjustment, extraIsDefault, isExtraSpec, type ExtraAdjustment } from "./adjust-extra";
import { removeRedEyeInPlace } from "./redeye";
import { renderShape, type ShapeGeom } from "./shapes";
import { maskToRects, maskToSegments } from "./mask-trace";

import { boxBlurPass } from "./blur";
import {
  blendIfActive,
  buildLut,
  channelValue,
  rangeActive,
  type BlendIf,
} from "./blendif";
import { clampBudgetMB, overBudget, totalBytes } from "./history-budget";
import {
  ROOT,
  ancestry,
  newestChild,
  offPath,
  removeNodes,
  transition,
  trimVictim,
} from "./history-tree";
import {
  DEFAULT_DYNAMICS,
  PRESSURE_BUCKETS,
  bucketPressure,
  clamp01,
  pressureBucket,
  pressureScale,
  type PressureDynamics,
} from "./pointer";
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
import { NO_REFINE, applyRefine, refineActive, type RefineEdge } from "./refine-edge";
import { modifyMask, type ModifyOp } from "./select-modify";
import { vectorMaskActive, vectorMaskHash } from "./vector-mask";
import { fillAlpha, fillOpacityActive, knockoutOf } from "./knockout";
import {
  DEFAULT_GLOBAL_LIGHT,
  globalLightKey,
  resolveGlobalLight,
  type GlobalLight,
} from "./global-light";
import { pathToSvgD } from "./paths";
import {
  boundsOf as gapBounds,
  dilateCoverage,
  gapArea,
  gapRects,
  groupGaps,
  seedFromEdges,
  sourceQuad,
} from "./crop-gaps";
import { buildCanvasGradient } from "./gradient";
import { solveHomography } from "./homography";
import { buildEdgeField, type EdgeField } from "./magnetic";
import { warpActive, warpPoint, type TextWarp } from "./textwarp";
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
import { isChannelKey } from "./channels";
import {
  addReach,
  effectsPositionDependent,
  effectsReach,
  nodeReach,
  padRect,
  regionWorthIt,
  stackReach,
  type Reach,
} from "./reach";
import {
  baseRunStyle,
  cssFontString,
  fontFeatureCSS,
  layoutRuns,
  renderedText,
  type MeasureFn,
} from "./richtext";
import type {
  BlurSettings,
  DodgeSettings,
  GradientStop,
  GradientType,
  PenAnchor,
  PenSettings,
  ShapeKind,
  SmudgeSettings,
  SpongeSettings,
  TextAlign,
  TextAxes,
  TextFill,
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
  /** Pen pressure drives the tip diameter (absent ⇒ on). */
  pressureSize?: boolean;
  /** Pen pressure drives flow — the paint deposited per dab (absent ⇒ off).
   *  Opacity is deliberately NOT pressure-driven: in this engine it is the
   *  whole-stroke ceiling applied when the stroke buffer is composited, so
   *  per-dab variation is exactly what `flow` means. */
  pressureFlow?: boolean;
  /** Floor at zero pressure, as a % of the full value (absent ⇒ 20). */
  pressureMin?: number;
  /** Surface grain: modulates each dab's coverage by a pattern anchored to the
   *  DOCUMENT, so overlapping dabs hit the same grain (see brush-tip.ts). */
  texture?: TextureSettings;
  /** A second, scattered tip that erodes the primary dab into bristles. */
  dualTip?: DualTipSettings;
  /** Elliptical tip: long-axis angle + short/long ratio (absent ⇒ round). */
  tipShape?: TipShapeSettings;
  /** Dabs strewn off the stroke line instead of laid along it. */
  scatter?: ScatterSettings;
  /** ERASER ONLY: paint back from the history source instead of erasing to
   *  transparency — Photoshop's "Erase to History", the eraser behaving as the
   *  History brush. Ignored by the brush and pencil, and ignored while a mask
   *  surface is active (the history stroke targets layer pixels). */
  eraseToHistory?: boolean;
}

/** Dynamics for sessions that must not respond to pressure (the clone stamp). */
const NO_DYNAMICS: PressureDynamics = { size: false, flow: false, min: 0 };

/** A brush's pressure dynamics, with the defaults filled in. */
export const brushDynamics = (b: BrushSettings): PressureDynamics => ({
  size: b.pressureSize ?? DEFAULT_DYNAMICS.size,
  flow: b.pressureFlow ?? DEFAULT_DYNAMICS.flow,
  min: b.pressureMin ?? DEFAULT_DYNAMICS.min,
});

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

/** High-resolution clock (falls back to Date.now where performance is absent). */
const nowMs = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

// maskToRects / maskToSegments now live in mask-trace.ts — see the note there
// on why they are run-based rather than per-cell.

export interface HistorySummary {
  /** Every state in CREATION order. `onPath` marks the ones on the chain from
   *  the original document to where you are now — with non-linear history on,
   *  the rest are states on branches you stepped away from. */
  items: { label: string; onPath: boolean }[];
  index: number;
  /** Non-linear history: a new edit after undoing keeps the states it replaces. */
  nonLinear: boolean;
  /** Bytes held by the undo stack's pixel patches (snapshots are separate). */
  bytes: number;
  /** Which history state the History brush paints from (0 = the original). */
  sourceIndex: number;
  /** Pinned snapshots (newest last), oldest-first as captured. */
  snapshots: { id: string; label: string }[];
  /** When set, the History brush sources from THIS snapshot, not `sourceIndex`. */
  sourceSnapshotId: string | null;
}

/** A pinned document state: every owned layer's pixels + masks and the doc size
 *  at capture time. Same payload as a crop snapshot, plus an identity — so the
 *  capture/restore code is the one already proven by the crop path. */
export interface DocSnapshot extends CropSnapshot {
  id: string;
  label: string;
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
  /** Point the History brush at a history state (0 = the original). */
  setHistorySourceIndex: (index: number) => void;
  /** Sample the composite (or one layer) — the Info panel's live readout. */
  sampleColor: (x: number, y: number, size: number, allLayers: boolean, layerId: string | null) => string | null;
  /** Snapshots (TODO §10): pin / restore / drop a full pixel state. */
  createSnapshot: (label: string, ids: string[]) => string;
  restoreSnapshot: (id: string) => boolean;
  deleteSnapshot: (id: string) => void;
  /** Point the History brush at a snapshot (null = back to a history step). */
  setHistorySourceSnapshot: (id: string | null) => void;
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
  /* The canvases the PNG getters would encode, for callers that encode
     elsewhere (autosave, in a worker). */
  getLayerImageCanvas: (id: string) => HTMLCanvasElement | null;
  getMaskImageCanvas: (id: string) => HTMLCanvasElement | null;
  getFrameSourceImageCanvas: (id: string) => HTMLCanvasElement | null;
  getMaskImage: (id: string) => string | null;
  setMaskImage: (id: string, source: CanvasImageSource) => void;
  setLayerImage: (id: string, source: CanvasImageSource, x?: number, y?: number) => void;
  /** Replace a layer's pixels as one undoable history step (HDR re-tonemap…). */
  applyLayerImage: (id: string, source: CanvasImageSource, label: string) => void;
  /** Frame content sources (natural size) — see PaintEngine.setFrameSource. */
  setFrameSource: (id: string, source: CanvasImageSource, w: number, h: number) => void;
  getFrameSource: (id: string) => HTMLCanvasElement | null;
  hasFrameSource: (id: string) => boolean;
  getFrameSourceImage: (id: string) => string | null;
  clearFrameSource: (id: string) => void;
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
  /** Push the current transparency/pixels lock flags for every layer so the
   *  engine can enforce them at the pixel-commit chokepoint. */
  syncLayerLocks: (list: { id: string; transparency: boolean; pixels: boolean }[]) => void;
  /** True when a layer's pixels are locked (lets menu ops short-circuit early). */
  isPixelsLocked: (id: string) => boolean;
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
  /** Smudge brush: begin / extend / finish a colour-dragging stroke. */
  beginSmudge: (
    layerId: string,
    opts: SmudgeSettings,
    x: number,
    y: number,
    fingerColor?: { r: number; g: number; b: number; a: number } | null,
    clip?: Rect[] | null,
    clipAngle?: number,
    clipPivot?: { x: number; y: number } | null,
  ) => void;
  /** Mixer brush: a smudge stroke that also carries a paint reservoir. */
  beginMixer: (
    layerId: string,
    opts: MixerSettings,
    x: number,
    y: number,
    fg: { r: number; g: number; b: number; a: number },
    clip?: Rect[] | null,
    clipAngle?: number,
    clipPivot?: { x: number; y: number } | null,
  ) => void;
  /** Empty the loaded brush (tool switch, or the explicit Clean button). */
  cleanMixer: () => void;
  moveSmudge: (x: number, y: number) => void;
  endSmudge: () => void;
  /** Sponge brush: begin / extend / finish a saturate/desaturate stroke. */
  beginSponge: (
    layerId: string,
    opts: SpongeSettings,
    x: number,
    y: number,
    clip?: Rect[] | null,
    clipAngle?: number,
    clipPivot?: { x: number; y: number } | null,
  ) => void;
  moveSponge: (x: number, y: number) => void;
  endSponge: () => void;
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
  applyCrop: (rect: Rect, ids: string[], angle?: number, fillGaps?: boolean) => void;
  /** Perspective crop: resample the quad (tl,tr,br,bl) into an outW×outH rect. */
  applyPerspectiveCrop: (
    quad: { x: number; y: number }[],
    outW: number,
    outH: number,
    ids: string[],
  ) => void;
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
  /** Refine Edge — smooth / contrast / shift applied when a selection mask is
   *  built. Feather stays the separate scalar the Feather… dialog already sets. */
  /** Select ▸ Modify — Border / Smooth / Expand / Contract. Returns the new
   *  rects; the result is axis-aligned, so any selection ROTATION is baked in. */
  modifySelection: (
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
    op: ModifyOp,
    px: number,
  ) => Rect[];
  /** Global light — one angle shared by shadows and bevels that follow it. */
  setGlobalLight: (l: GlobalLight) => void;
  getGlobalLight: () => GlobalLight;
  setRefineEdge: (r: RefineEdge) => void;
  getRefineEdge: () => RefineEdge;
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
  /** Small grayscale PNG of a mask raster (Channels-panel thumbnails). */
  maskPreviewURL: (id: string, maxW?: number) => string | null;
  /** Tight bounds of a layer's non-transparent pixels (null = empty layer). */
  layerContentBounds: (id: string) => Rect | null;
  /** Translate a layer's pixels (align/distribute); caller owns the history. */
  offsetLayerPixels: (id: string, dx: number, dy: number, alsoMask?: boolean) => void;
  setActiveSurface: (id: string, surface: ActiveSurface) => void;
  getActiveSurface: (id: string) => ActiveSurface;
  // ---- Quick Mask (document-level selection painting) ----
  quickMaskActive: () => boolean;
  enterQuickMask: (
    key: string,
    rects?: Rect[] | null,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => void;
  setQuickMask: (key: string | null) => void;
  quickMaskRects: () => Rect[];
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
  /** Spec 06 debug: toggle region-scoped LIVE filter frames (off = draft). */
  setLiveRegionEnabled: (on: boolean) => void;
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
  /** Memory cap for the undo stack's pixel patches, in MB. */
  setHistoryBudgetMB: (mb: number) => void;
  /** Photoshop-style non-linear history (branch instead of truncating). */
  setNonLinearHistory: (on: boolean) => void;
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

/**
 * Running out of canvas memory is not an error anywhere. WebKit hands back a
 * canvas that draws, composites and reads — as transparent black, for ever. The
 * user does not see "your device ran out of room"; they see the photo they just
 * opened turn into nothing, which reads as this app having destroyed it.
 *
 * So every allocation big enough to be the one that fails is checked with a
 * sentinel: a pixel written and read back at the far corner. That cannot be
 * skipped or made read-only — an empty canvas and a dead canvas read identically
 * (see `sentinelPasses`).
 *
 * WHY THERE IS A THRESHOLD, measured rather than assumed. The sentinel costs
 * 0.7–0.8ms whatever the canvas size: it is a GPU→CPU readback stall, not work
 * proportional to pixels. And a census of a real session — boot, a 4000×3000
 * document, a brush stroke — found 27 allocations, of which 20 were under a
 * quarter of a megapixel and 4 were over four. Checking everything would spend
 * most of its time on canvases that could never be the one to exhaust memory;
 * checking only the large ones costs about 3ms per document and covers every
 * allocation that could produce a blank photograph.
 *
 * The accepted limit, stated plainly: a failure below the threshold goes
 * undetected. A device that cannot allocate 4 MB has already lost the tab.
 */
const SENTINEL_MIN_PIXELS = 1_048_576;

type CanvasFailure = { w: number; h: number };
let onCanvasFailure: ((f: CanvasFailure) => void) | null = null;

/**
 * Where to report an allocation that came back dead.
 *
 * Module-level rather than a constructor argument because `makeCanvas` is a free
 * function used by the engine, its workers' helpers and the paths that build
 * scratch buffers — there is no single instance to hang it off.
 */
export function setCanvasFailureHandler(fn: ((f: CanvasFailure) => void) | null): void {
  onCanvasFailure = fn;
}

/** Reported once. Fifty dead buffers are one event, not fifty. */
let reportedFailure = false;

/** Tests only. */
export function resetCanvasFailureReport(): void {
  reportedFailure = false;
}

/** True if the canvas is real. Reports the first failure it sees. */
function checkAllocation(
  ctx: CanvasRenderingContext2D | null,
  w: number,
  h: number,
): boolean {
  if (!ctx) return false;
  if (w * h < SENTINEL_MIN_PIXELS) return true;
  if (sentinelPasses(ctx, w, h)) return true;
  if (!reportedFailure) {
    reportedFailure = true;
    onCanvasFailure?.({ w, h });
  }
  return false;
}

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
  checkAllocation(ctx, w, h);
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
  /** Base baseline shift / all-caps (runs carry their own; see TextRunStyle). */
  baseline?: number;
  caps?: boolean;
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
  /** Warp preset (absent = flat text). */
  warp?: TextWarp;
  /** Non-solid fill (gradient) painted through the glyph coverage; absent =
   *  the solid `color`. Block-level (per-run fills are a follow-on). */
  fill?: TextFill;
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
  /** Index of the entry this one was made ON TOP OF, or ROOT (-1) for the
   *  original document. In linear mode this is always the previous entry, so
   *  the tree degenerates to the list it has always been; in non-linear mode a
   *  new edit made after undoing branches here instead of truncating. */
  parent: number;
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
/** Live performance snapshot surfaced by the dev Perf HUD. */
export interface PerfStats {
  /** Last / rolling-average / peak composite duration, in milliseconds. */
  lastMs: number;
  avgMs: number;
  maxMs: number;
  /** Composites in the last second (0 when idle). */
  rate: number;
  /** Render-cache hit rate 0–1 (cumulative for the session). */
  hitRate: number;
  hits: number;
  misses: number;
  /** Cached products (incl. tiled adjustments) + resident tile count. */
  entries: number;
  tiles: number;
  /** Cache memory used vs. budget (bytes). */
  bytes: number;
  budget: number;
  enabled: boolean;
  /** The last frame's blit region (doc space), or null for a full-doc blit. */
  dirty: Rect | null;
  full: boolean;
  /** Timestamp (performance.now) the last blit was recorded — drives the fade. */
  dirtyAt: number;
}

export class PaintEngine {
  private w = 0;
  private h = 0;
  private view: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private layers = new Map<string, Layer>();
  private stroke: Layer | null = null;
  private scratch: Layer | null = null;
  /** Has a document size been applied? Replaces `stroke` as that sentinel. */
  private sized = false;

  /**
   * Make the buffers an edit needs, at the moment it needs them.
   *
   * `stroke` holds the live brush dab before it is committed; `scratch` composes
   * the layer plus that live stroke for display. Neither means anything to a
   * document nobody has drawn on, so neither is allocated until the first
   * stroke, move or float begins.
   */
  private ensureOpBuffers(): void {
    if (!this.w || !this.h) return;
    if (!this.stroke) this.stroke = makeCanvas(this.w, this.h); // sRGB: brush colours are authored from sRGB hex
    if (!this.scratch) this.scratch = this.mk(this.w, this.h);
  }

  /**
   * Every document-sized buffer the engine is holding, by name and by bytes.
   *
   * Exists because "how much does an open document cost" had no answer that did
   * not involve reading the source: the layer canvases are in a Map, the
   * operation buffers are private fields, and none of them is in the DOM where a
   * harness could see them. A number nobody can obtain is a number nobody
   * checks.
   */
  memoryReport(): {
    w: number;
    h: number;
    docBytes: number;
    total: number;
    buffers: { name: string; w: number; h: number; bytes: number }[];
  } {
    const buffers: { name: string; w: number; h: number; bytes: number }[] = [];
    const add = (name: string, c: HTMLCanvasElement | null | undefined) => {
      if (!c) return;
      buffers.push({ name, w: c.width, h: c.height, bytes: c.width * c.height * 4 });
    };
    for (const [id, l] of this.layers) add(`layer:${id}`, l.c);
    for (const [id, m] of this.masks) add(`mask:${id}`, m.c);
    add("stroke", this.stroke?.c);
    add("scratch", this.scratch?.c);
    return {
      w: this.w,
      h: this.h,
      docBytes: this.w * this.h * 4,
      total: buffers.reduce((n, b) => n + b.bytes, 0),
      buffers,
    };
  }
  private measureCtx: CanvasRenderingContext2D | null = null; // throwaway ctx for text measuring
  // Working colour space. Layer/scratch/float/export buffers use it (wide-gamut
  // preserved); the stroke buffer + brush tip stay sRGB so brush colours, which
  // are authored from sRGB hex, convert correctly when composited onto layers.
  private cs: PredefinedColorSpace = "srgb"; // canvas (storage/display) space
  /** Refine Edge state; feather rides the existing per-call scalar. */
  private refine: RefineEdge = NO_REFINE;
  /** Document-level lighting angle shared by effects that opt in. */
  private globalLight: GlobalLight = { ...DEFAULT_GLOBAL_LIGHT };
  private ws: WorkingSpace = "srgb"; // working space (adjustment math)
  // Soft proofing (VIEW-only): simulate the target space / mark its gamut.
  private proofTarget: ProofTarget = "srgb";
  private proofSimulate = false;
  private gamutWarn = false;

  // --- Layer masks (non-destructive) -----------------------------------------
  // Grayscale mask per layer id (R=G=B=value); absent ⇒ no mask. Colour-agnostic
  // (always sRGB) — never gamut-converted — and editable by the brush pipeline.
  private masks = new Map<string, Layer>();
  /** Natural-size sources for framed images (see setFrameSource). */
  private frameSrc = new Map<string, HTMLCanvasElement>();
  // Derived alpha cache per id (RGB=0, A=coverage). Recomputed only on mask
  // mutation, scoped to the changed rect — never per composite frame. The mask's
  // own alpha is folded in (A = R × maskAlpha/255) so eraser strokes read right.
  private maskAlpha = new Map<string, Layer>();
  /** Rasterised vector masks, keyed by node id; the entry carries the hash it
   *  was built from so an anchor drag re-renders and nothing else does. */
  private vectorMaskCache = new Map<string, { key: string; c: HTMLCanvasElement }>();
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
  // Region-scoped repaints: how many misses were repaired in place, and how
  // many pixels those repaints touched. Surfaced through renderCacheStats so a
  // harness can prove the region path RAN — byte-identity alone also holds when
  // it never activates and everything quietly takes the full pass.
  private regionHits = 0;
  private regionPx = 0;
  // The same two questions for the LIVE half: how many draft frames the region
  // path took over, how many pixels it filtered, and how many FILTER frames still
  // fell through to a full-document draft (the effects draft is separate and not
  // counted here). A stroke that reports 0 region frames proves the path never
  // ran, whatever the pixels look like.
  private liveRegionHits = 0;
  private liveRegionPx = 0;
  private liveDraftFrames = 0;
  private liveRegionOn = true; // dev A/B (window.__gqRenderCache.regionOff())
  /** Per-stroke full-resolution filter product: a copy of the settled one, with
   *  the stroke's own region re-filtered into it each frame. */
  private liveProduct: (Layer & { id: string; key: string }) | null = null;
  /** Reusable region-sized scratch (source, filter mask). They grow with the
   *  stroke every frame, so allocating per frame would cost more than the filter
   *  does — the lesson from alphaMask. */
  private regionBufs: (Layer | undefined)[] = [];
  private renderTick = 0; // LRU clock
  private renderBytes = 0; // owned bytes currently cached
  private renderBudget = 256 * 1024 * 1024; // LRU eviction beyond this (Preferences ▸ Performance)
  private cacheHits = 0;
  private cacheMisses = 0;
  // Perf HUD (dev): rolling composite durations (ms) + timestamps of recent
  // composites (for a "recomposites/sec" reading), and the last frame's blit
  // region so the overlay can visualize what was recomputed.
  private compositeTimes: number[] = [];
  private compositeStamps: number[] = [];
  private lastDirtyRect: Rect | null = null;
  private lastDirtyAt = 0;
  private lastFrameFull = false;
  private historyLimit = 60; // max undoable steps kept (Preferences ▸ Performance)
  /** Memory cap for those steps' pixel patches — the cap that actually bounds
   *  RAM, since one full-canvas patch can outweigh a hundred brush dabs. */
  private historyBudgetMB = 512;
  private workersOn = true; // background compute (blur/filters/heal) toggle
  private frameProtect = new Set<string>(); // entries used by the current frame
  private keyMemo = new Map<string, string>(); // per-composite effectiveKey memo
  private liveBypass = new Set<string>(); // live layer ids + their ancestor path
  /** A draft-resolution filter/effect render has been blitted to the view since
   *  the last settled frame — the next one must repaint everything. */
  private draftPainted = false;
  // Pending dirty region (document space) + whether the next view blit must be
  // full. Partial blits are only taken when the tree reference is unchanged
  // (same immutable tree ⇒ no structural/props change slipped past the rects).
  private pendingDirty: Rect | null = null;
  private lastTree: LayerNode[] | null = null;
  // Monotonic per-layer pixel version (bumped on any committed pixel write), a
  // per-id mask version (bumped on any mask mutation), and a document epoch
  // (bumped on resize/crop/transform/colour-space) — the key ingredients.
  private pixelVersion = new Map<string, number>();
  // Memoized layerContentBounds, keyed by `pixelVersion:docEpoch` (see below).
  private contentBoundsCache = new Map<string, { key: string; box: Rect | null }>();
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
    const bounded = this.boundChange(id, "pixel", rect);
    // A bounded change to a node whose own render can be repainted per-region
    // KEEPS its cached product and just records what went stale; the miss path
    // then repaints that rect instead of the whole document. Everything else
    // drops the entry exactly as before.
    if (bounded && this.regionPatchable(id)) this.markStale(id, bounded);
    else this.dropCache(id);
    this.pendingDirty = unionRect(this.pendingDirty, bounded);
    if (!bounded) this.lastTree = null; // unbounded change → next blit is full
    this.noteBelowChange(bounded);
  }

  /**
   * Can this node's cached product be repainted a region at a time?
   *
   * Deliberately narrow — the first slice covers exactly the shape the bench
   * measures (a leaf carrying effects, painted on): no group (its key folds in
   * every child, so a child edit is not a local edit of the group's own
   * product), no fill layer (its pixels come from a spec, not the canvas), no
   * mask (applied after the fact, in renderNode), no smart filters (the stack
   * has its own product cache and its own position rules), effects that do not
   * read absolute coordinates, and a bounded reach.
   */
  private regionPatchable(id: string): boolean {
    const node = this.curTree ? findNode(this.curTree, id) : null;
    if (!node || node.type !== "layer") return false;
    // A MASK is fine: both kinds multiply the styled render per-pixel, so they
    // reach nothing and can simply be re-applied over the repainted rect.
    if (node.fill) return false;
    if (hasEnabledFilters(node.filters)) return false;
    if (!hasEnabledFx(node.effects)) return false;
    if (effectsPositionDependent(node.effects)) return false;
    return effectsReach(node.effects) !== null;
  }

  /** Record that `rect` of a cached product went stale, keeping the rest. */
  private markStale(id: string, rect: Rect) {
    const e = this.renderCache.get(id);
    if (!e) {
      this.dropCache(id);
      return;
    }
    e.dirty = e.dirty ? unionRect(e.dirty, rect)! : rect;
    // The clip-group product built from this node is NOT region-tracked; it has
    // to go, or it would keep serving pixels from before the change.
    const clip = this.renderCache.get(`clip:${id}`);
    if (clip) {
      this.renderBytes -= clip.bytes;
      this.renderCache.delete(`clip:${id}`);
    }
    this.dropTiled(id);
  }

  /** Does the new key differ from the cached one ONLY in the leaf pixel version?
   *  Anything else (effects, colour space, mask, doc epoch) changes the whole
   *  product and must take the full pass. */
  private onlyPixelsChanged(oldKey: string, newKey: string): boolean {
    const a = oldKey.split("|");
    const b = newKey.split("|");
    if (a.length !== b.length || a.length < 2) return false;
    if (!a[0].startsWith("L") || !b[0].startsWith("L")) return false;
    if (a[0] === b[0]) return false; // the pixel version must be what moved
    for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** A change rect grown by everything downstream of it spreads, or null when
   *  that can't be bounded (→ full recompute, the old behaviour for every
   *  styled/filtered node). */
  private boundChange(id: string, kind: "pixel" | "mask", rect?: Rect): Rect | null {
    if (!rect) return null;
    const pad = this.changePadding(id, kind);
    if (pad === null) return null;
    const p = padRect(rect, pad, this.w, this.h);
    return p.w > 0 && p.h > 0 ? p : null;
  }

  /** Mark a node's mask changed (same key mechanics as bumpPixel). A plain
   *  layer mask multiplies the FINAL styled render, so its change is per-pixel;
   *  a filter mask (fm:*) feeds the filter stack and inherits its reach. */
  private bumpMask(id: string, rect?: Rect) {
    this.maskVersion.set(id, (this.maskVersion.get(id) ?? 0) + 1);
    // Overlay rasters — the quick mask (drawn by the canvas) and saved selection
    // channels (drawn nowhere at all) — composite into nothing, so editing one
    // must not invalidate a single cached tile. Skipping this is not merely an
    // optimization: changePadding() treats an id it has never seen in the tree
    // as unbounded, which would force a FULL document recomposite on every
    // quick-mask brush segment and on every selection save.
    if (id === this.qmKey || isChannelKey(id)) return;
    this.dropCache(id, true);
    const bounded = this.boundChange(id, "mask", rect);
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
    return this.changePadding(id, kind) === null;
  }

  /**
   * How far a rect-bounded change to `id` can spread, in px — or null when it
   * cannot be bounded at all (an unknown node, or a filter whose output depends
   * on absolute position; see reach.ts).
   *
   * This used to be a boolean: "does it reach?", answered yes for ANY node
   * carrying effects or filters, which then threw the dirty rect away and forced
   * a full-document recompute. Most of those spread by a knowable distance —
   * a blur by its radius, a shadow by distance + blur — so the rect can survive,
   * grown by that much. Reaches ACCUMULATE down the ancestor chain because each
   * styled group re-spreads whatever its children already spread.
   */
  private changePadding(id: string, kind: "pixel" | "mask"): Reach {
    const tree = this.curTree;
    if (!tree) return null; // no tree seen yet — stay conservative
    const fm = id.startsWith("fm:");
    const target = fm ? id.slice(3) : id;
    let result: Reach = null; // stays null when the id isn't in the tree
    const walk = (nodes: LayerNode[], anc: Reach): boolean => {
      for (const n of nodes) {
        const own = nodeReach(n.filters, n.effects);
        if (n.id === target) {
          // A layer MASK is applied after fx/filters, so painting it spreads
          // nothing of its own; a FILTER mask reshapes the stack, so it spreads
          // as far as the stack does.
          const self: Reach = fm ? stackReach(n.filters) : kind === "mask" ? 0 : own;
          result = addReach(anc, self);
          return true;
        }
        if (n.type === "group" && walk(n.children, addReach(anc, own))) return true;
      }
      return false;
    };
    walk(tree, 0);
    return result;
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
    if (ent.key !== this.nodeKey(node)) return null;
    const src = node.fill ? this.renderFill(node) : this.leafDisplay(id);
    if (!src) return null;
    // The stack's INPUT and its post-filter pixels, so a caller can do the blend
    // arithmetic by hand and say which of the two paths rounded it differently.
    const pre = this.mk(this.w, this.h, true);
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

  /** Cache occupancy (dev overlay / console). */
  renderCacheStats(): {
    enabled: boolean;
    entries: number;
    bytes: number;
    budget: number;
    hits: number;
    misses: number;
    tiles: number;
    regionHits: number;
    regionPx: number;
    liveRegionHits: number;
    liveRegionPx: number;
    liveDraftFrames: number;
  } {
    let tiles = 0;
    for (const t of this.tiledAdj.values()) for (const tile of t.tiles) if (tile) tiles++;
    return {
      regionHits: this.regionHits,
      regionPx: this.regionPx,
      liveRegionHits: this.liveRegionHits,
      liveRegionPx: this.liveRegionPx,
      liveDraftFrames: this.liveDraftFrames,
      enabled: this.renderCacheOn,
      entries: this.renderCache.size + this.tiledAdj.size,
      bytes: this.renderBytes,
      budget: this.renderBudget,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      tiles,
    };
  }

  /** Record one composite frame's cost + blit region (Perf HUD). */
  private recordFrame(ms: number, dirty: Rect | null, full: boolean) {
    this.compositeTimes.push(ms);
    if (this.compositeTimes.length > 120) this.compositeTimes.shift();
    const t = nowMs();
    this.compositeStamps.push(t);
    while (this.compositeStamps.length && this.compositeStamps[0] < t - 1000)
      this.compositeStamps.shift();
    this.lastDirtyRect = dirty;
    this.lastFrameFull = full;
    this.lastDirtyAt = t;
  }

  /** Live performance snapshot for the dev HUD: composite timing, recomposite
   *  rate, render-cache occupancy/hit-rate, and the last frame's blit region. */
  perfStats(): PerfStats {
    const c = this.renderCacheStats();
    const times = this.compositeTimes;
    const last = times.length ? times[times.length - 1] : 0;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const max = times.length ? Math.max(...times) : 0;
    const total = c.hits + c.misses;
    // Trim stale recomposite stamps so an idle HUD reads 0/s.
    const t = nowMs();
    while (this.compositeStamps.length && this.compositeStamps[0] < t - 1000)
      this.compositeStamps.shift();
    return {
      lastMs: last,
      avgMs: avg,
      maxMs: max,
      rate: this.compositeStamps.length,
      hitRate: total ? c.hits / total : 0,
      hits: c.hits,
      misses: c.misses,
      entries: c.entries,
      tiles: c.tiles,
      bytes: c.bytes,
      budget: c.budget,
      enabled: c.enabled,
      dirty: this.lastDirtyRect,
      full: this.lastFrameFull,
      dirtyAt: this.lastDirtyAt,
    };
  }

  /** Cap the undo history (Preferences ▸ Performance): oldest steps drop off
   *  the far end — their pixel patches are the biggest memory holders. */
  setHistoryLimit(n: number): void {
    this.historyLimit = Math.max(10, Math.min(200, Math.round(n)));
    this.trimHistory();
  }

  /** Cap the undo history by MEMORY as well as by step count. A step count is a
   *  poor proxy for bytes — one full-canvas patch can outweigh a hundred brush
   *  dabs — so whichever cap binds first wins. */
  setHistoryBudgetMB(mb: number): void {
    this.historyBudgetMB = clampBudgetMB(mb);
    this.trimHistory();
  }

  /** Bytes currently held by the undo stack's pixel patches. */
  historyBytes(): number {
    return totalBytes(this.entries);
  }

  private trimHistory(): void {
    let dropped = 0;
    while (
      this.entries.length > this.historyLimit ||
      overBudget(this.historyBytes(), this.historyBudgetMB)
    ) {
      // `trimVictim` picks a state nothing still depends on — an abandoned
      // branch tip first, otherwise the oldest step when it is the only branch
      // off the original. It returns -1 when every remaining state is load-
      // bearing, which makes the cap soft rather than corrupting a branch.
      const victim = trimVictim(this.parents(), this.cur, this.historySourceIndex - 1);
      if (victim < 0) break;
      this.dropNodes([victim]);
      dropped++;
    }
    if (dropped) this.emitHistory();
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
  // Per-layer edit locks the engine enforces at the pixel-commit chokepoint
  // (pushEntry). Kept in sync from the layer tree via syncLayerLocks(). Only the
  // two flags the engine acts on live here; position lock is a UI-level guard.
  private layerLocks = new Map<string, { transparency: boolean; pixels: boolean }>();
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
  /** Extra linked layers riding along on a whole-layer move (same delta). Each
   *  carries its own before/float surfaces; all commit in ONE undo step. */
  private moveExtra: {
    id: string;
    orig: Layer;
    float: Layer;
    maskLinked: boolean;
  }[] = [];

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

  // History is an UNDO TREE (see history-tree.ts): every entry records its
  // parent, and `cur` is the node the document currently shows (ROOT = the
  // original). A linear history is the degenerate case where every parent is
  // the previous entry, so this behaves exactly as the old array + index did.
  private entries: Entry[] = [];
  private cur = ROOT;
  /** Photoshop's "Allow Non-Linear History": keep the states a new edit would
   *  otherwise discard, as a branch, instead of truncating them. */
  private nonLinear = false;
  /** The parent table the pure tree helpers work on. */
  private parents(): number[] {
    return this.entries.map((e) => e.parent);
  }
  /** Items index (0 = the original state) ⇄ node index. */
  private get pos(): number {
    return this.cur + 1;
  }

  /**
   * Attach a freshly built entry to the tree and move onto it. In LINEAR mode
   * anything that was reachable only by redo is discarded first — the old
   * `entries.length = pos` truncation, expressed as "drop everything off the
   * path". In non-linear mode nothing is dropped and the new entry simply
   * branches off wherever you are.
   */
  private linkEntry(e: Omit<Entry, "parent">): void {
    if (!this.nonLinear) {
      const stale = offPath(this.parents(), this.cur);
      if (stale.length) this.dropNodes(stale);
    }
    const entry = e as Entry;
    entry.parent = this.cur;
    this.entries.push(entry);
    this.cur = this.entries.length - 1;
  }

  /** Remove entries and renumber everything that points at them. Callers must
   *  never drop the current node's ancestry — the document is showing it. */
  private dropNodes(list: number[]): void {
    if (!list.length) return;
    const gone = new Set(list);
    const { parents, remap } = removeNodes(this.parents(), list);
    this.entries = this.entries.filter((_, i) => !gone.has(i));
    this.entries.forEach((e, i) => (e.parent = parents[i]));
    this.cur = this.cur >= 0 && !gone.has(this.cur) ? remap[this.cur] : ROOT;
    // The History-brush source is an ITEMS index (node + 1); a dropped source
    // falls back to the original state rather than silently sliding elsewhere.
    const src = this.historySourceIndex - 1;
    this.historySourceIndex = src < 0 || gone.has(src) ? 0 : remap[src] + 1;
  }
  // History brush source: the state index the brush repaints from (0 = the
  // original). The active layer's pixels AT that index are reconstructed from
  // its patch entries on demand (beginHistory), so no full snapshots are stored.
  private historySourceIndex = 0;
  // Pinned snapshots (TODO §10): full pixel captures the user can restore to and
  // point the History brush at. Engine-owned because they hold canvases; the
  // editor pairs each with the layer TREE it was taken with.
  private snapshots: DocSnapshot[] = [];
  private snapSeq = 0;
  /** When set, the History brush sources from this snapshot instead of a step. */
  private historySourceSnap: string | null = null;

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
    /* `this.sized` rather than `this.stroke`, which used to stand in for "have
       we been sized" only because it was allocated here. It is not any more. */
    if (this.w === w && this.h === h && this.sized) return;
    this.wandSrc = null;
    this.invalidateStyled();
    this.w = w;
    this.h = h;
    this.sized = true;
    /* NOT allocated here. `stroke` and `scratch` are each a full w×h×4 buffer —
       48 MB apiece for a 12 MP photo — and neither is read except during a
       stroke, a move or a float. Allocating them with the document meant a
       picture you had merely OPENED cost two buffers for edits you had not made
       yet. They are made on the first operation that needs them instead, by
       `ensureOpBuffers()`, and every consumer already handled their being
       absent: the reads are `this.scratch?.ctx` and `this.stroke && …` because
       both were null before the first `setDoc` anyway.

       Kept once made, deliberately. Freeing after every stroke would trade
       48 MB of residency for a 48 MB allocation between one brush stroke and
       the next, which is the wrong trade on the device this is for. */
    if (this.stroke && (this.stroke.c.width !== w || this.stroke.c.height !== h)) {
      this.stroke = makeCanvas(w, h);
    }
    if (this.scratch && (this.scratch.c.width !== w || this.scratch.c.height !== h)) {
      this.scratch = this.mk(w, h);
    }
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
      this.cur = ROOT;
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
    this.cur = ROOT;
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
  /**
   * Repaint the wedges a straighten leaves uncovered with synthesized content.
   *
   * Runs SYNCHRONOUSLY through the heal library's pure core rather than the
   * worker path the heal brush uses, and pushes no history of its own: the crop
   * that called it is already bracketed by cropSnapshot/cropRestore, so one undo
   * takes the whole thing — geometry and fill together — back.
   *
   * Called AFTER the layers have been rotated into the new canvas, so `this.w/h`
   * are the output size and the gap geometry is in the same space as the pixels.
   */
  private fillStraightenGaps(
    ownLayerIds: string[],
    srcW: number,
    srcH: number,
    rect: Rect,
    angle: number,
  ): void {
    const gaps = gapRects(this.w, this.h, sourceQuad(srcW, srcH, rect, angle));
    if (!gapArea(gaps)) return;
    const clusters = groupGaps(gaps);
    for (const id of ownLayerIds) {
      const l = this.layers.get(id);
      if (!l) continue;
      let touched = false;
      for (const cluster of clusters) {
        const b = gapBounds(cluster);
        if (!b) continue;
        const pad = healPadding(b.w, b.h);
        const rx = Math.max(0, Math.floor(b.x - pad));
        const ry = Math.max(0, Math.floor(b.y - pad));
        const rw = Math.min(this.w, Math.ceil(b.x + b.w + pad)) - rx;
        const rh = Math.min(this.h, Math.ceil(b.y + b.h + pad)) - ry;
        if (rw <= 0 || rh <= 0) continue;
        const src = l.ctx.getImageData(rx, ry, rw, rh);
        // An empty layer has nothing to synthesize FROM — healing it would spend
        // a full diffusion solve to produce the transparency it already has.
        let opaque = false;
        for (let i = 3; i < src.data.length; i += 4)
          if (src.data[i] !== 0) {
            opaque = true;
            break;
          }
        if (!opaque) continue;
        const coverage = new Uint8ClampedArray(rw * rh);
        for (const r of cluster) {
          const y = r.y - ry;
          if (y < 0 || y >= rh) continue;
          const x0 = Math.max(0, r.x - rx);
          const x1 = Math.min(rw, r.x + r.w - rx);
          for (let x = x0; x < x1; x++) coverage[y * rw + x] = 255;
        }
        dilateCoverage(coverage, rw, rh, 2); // swallow the rotation's soft rim
        // Seed first, THEN heal: the seed guarantees every hole pixel has a
        // plausible local colour (the heal alone leaves a big wedge's interior
        // at transparent black), and the heal then adds texture near the edge.
        seedFromEdges(src.data, rw, rh, coverage);
        l.ctx.putImageData(healRegion({ src, coverage }), rx, ry);
        touched = true;
      }
      if (touched) this.bumpPixel(id);
    }
  }

  /** `fillGaps` repaints the corners a straighten leaves empty (content-aware). */
  applyCrop(rect: Rect, ownLayerIds: string[], angle = 0, fillGaps = false) {
    const nw = Math.max(1, Math.round(rect.w));
    const nh = Math.max(1, Math.round(rect.h));
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    this.invalidateStyled();
    const rad = (-angle * Math.PI) / 180;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const srcW = this.w; // the pre-crop document size, for the gap geometry
    const srcH = this.h;
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
    if (fillGaps) this.fillStraightenGaps(ownLayerIds, srcW, srcH, rect, angle);
    this.emitChange();
  }

  /**
   * Perspective crop: resample the picked quadrilateral `quad` (four doc-space
   * corners in tl, tr, br, bl order) into an `outW × outH` rectangle, correcting
   * perspective. Every owned layer + mask is warped through the same homography
   * and the document is resized. Destructive — paired with cropSnapshot/restore
   * for undo, exactly like applyCrop.
   */
  applyPerspectiveCrop(
    quad: { x: number; y: number }[],
    outW: number,
    outH: number,
    ownLayerIds: string[],
  ) {
    const nw = Math.max(1, Math.round(outW));
    const nh = Math.max(1, Math.round(outH));
    this.endAdjust();
    if (this.floatActive) this.discardFloat();
    this.wandSrc = null;
    this.invalidateStyled();
    // Map each OUTPUT pixel → its SOURCE location: solve output-rect corners → quad.
    const dst = [
      { x: 0, y: 0 },
      { x: nw, y: 0 },
      { x: nw, y: nh },
      { x: 0, y: nh },
    ];
    const H = solveHomography(dst, quad);
    const sw = this.w;
    const sh = this.h;
    for (const [id, l] of this.layers) {
      if (!ownLayerIds.includes(id)) continue;
      const srcData = l.ctx.getImageData(0, 0, sw, sh);
      const out = this.warpPerspective(srcData, H, nw, nh);
      const next = this.mk(nw, nh, true);
      next.ctx.putImageData(out, 0, 0);
      this.layers.set(id, next);
    }
    this.w = nw;
    this.h = nh;
    this.stroke = makeCanvas(nw, nh);
    this.scratch = this.mk(nw, nh);
    this.transformMasks(ownLayerIds, (ctx, src) => {
      const sctx = src.getContext("2d");
      if (!sctx) return;
      const srcData = sctx.getImageData(0, 0, src.width, src.height);
      ctx.putImageData(this.warpPerspective(srcData, H, nw, nh), 0, 0);
    });
    this.emitChange();
  }

  /** Inverse-map + premultiplied bilinear resample of `srcData` into an `outW×outH`
   *  buffer. `H` maps output-pixel coords → source coords. Pixels whose source
   *  falls outside the image come out transparent. */
  private warpPerspective(srcData: ImageData, H: number[], outW: number, outH: number): ImageData {
    const sw = srcData.width;
    const sh = srcData.height;
    const sd = srcData.data;
    const out = new ImageData(outW, outH);
    const od = out.data;
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
    let di = 0;
    for (let y = 0; y < outH; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < outW; x++, di += 4) {
        const xc = x + 0.5;
        const w = h6 * xc + h7 * yc + h8;
        if (w === 0) continue;
        const iw = 1 / w;
        const sx = (h0 * xc + h1 * yc + h2) * iw - 0.5;
        const sy = (h3 * xc + h4 * yc + h5) * iw - 0.5;
        if (sx <= -1 || sx >= sw || sy <= -1 || sy >= sh) continue; // outside → clear
        const x0f = Math.floor(sx);
        const y0f = Math.floor(sy);
        const fx = sx - x0f;
        const fy = sy - y0f;
        const x0 = x0f < 0 ? 0 : x0f >= sw ? sw - 1 : x0f;
        const y0 = y0f < 0 ? 0 : y0f >= sh ? sh - 1 : y0f;
        const x1 = x0f + 1 < 0 ? 0 : x0f + 1 >= sw ? sw - 1 : x0f + 1;
        const y1 = y0f + 1 < 0 ? 0 : y0f + 1 >= sh ? sh - 1 : y0f + 1;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        // Premultiplied blend so transparent edges don't darken the result.
        const o00 = (y0 * sw + x0) * 4;
        const o10 = (y0 * sw + x1) * 4;
        const o01 = (y1 * sw + x0) * 4;
        const o11 = (y1 * sw + x1) * 4;
        const a00 = sd[o00 + 3];
        const a10 = sd[o10 + 3];
        const a01 = sd[o01 + 3];
        const a11 = sd[o11 + 3];
        const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
        od[di + 3] = Math.round(a);
        if (a > 0) {
          const r =
            sd[o00] * a00 * w00 + sd[o10] * a10 * w10 + sd[o01] * a01 * w01 + sd[o11] * a11 * w11;
          const g =
            sd[o00 + 1] * a00 * w00 +
            sd[o10 + 1] * a10 * w10 +
            sd[o01 + 1] * a01 * w01 +
            sd[o11 + 1] * a11 * w11;
          const b =
            sd[o00 + 2] * a00 * w00 +
            sd[o10 + 2] * a10 * w10 +
            sd[o01 + 2] * a01 * w01 +
            sd[o11 + 2] * a11 * w11;
          od[di] = Math.round(r / a);
          od[di + 1] = Math.round(g / a);
          od[di + 2] = Math.round(b / a);
        }
      }
    }
    return out;
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
   *  via maskKeyOf(). Quick Mask overrides it for EVERY layer: while it is on,
   *  every paint tool edits the quick mask instead of any layer's pixels. */
  private activeSurface(id: string): "pixels" | "mask" {
    if (this.qmKey) return "mask";
    return this.getActiveSurface(id) === "pixels" ? "pixels" : "mask";
  }

  /** The masks-map key `id`'s current mask surface resolves to: the node id for
   *  the layer mask, `filterMaskKey(id)` for the filter mask. History entries for
   *  mask paint record THIS key as their layerId, so undo lands on the right raster. */
  private maskKeyOf(id: string): string {
    if (this.qmKey) return this.qmKey; // Quick Mask claims every layer's strokes
    return this.surfaces.get(id) === "filterMask" ? filterMaskKey(id) : id;
  }

  // ---- Quick Mask (TODO §3) -----------------------------------------------
  //
  // A quick mask is a grayscale raster in the SAME masks map as layer and filter
  // masks, so every paint tool, fill, blur and history path works on it with no
  // per-tool change — activeSurface()/maskKeyOf() above are the whole routing.
  // What makes it "quick" is that nothing composites it: the document renders
  // exactly as if the mask were not there, and the canvas paints the red overlay
  // from quickMaskCoverage(). Coverage means SELECTED (white = inside), matching
  // allocMask("selection"), so the overlay inverts it to shade what is masked.
  private qmKey: string | null = null;

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
    this.emitChange();
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
    const r: RefineEdge = { ...this.refine, feather };
    if (!refineActive(r)) return base.c;
    // One pipeline rather than a canvas blur here and a refinement elsewhere:
    // smooth RE-THRESHOLDS, so it has to run before feather or it would throw
    // the softness away, and contrast/shift need the ramp feather produces.
    const id = base.ctx.getImageData(0, 0, this.w, this.h);
    const n = this.w * this.h;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = id.data[i * 4 + 3];
    applyRefine(a, this.w, this.h, r);
    for (let i = 0; i < n; i++) {
      const v = a[i];
      const o = i * 4;
      id.data[o] = 255;
      id.data[o + 1] = 255;
      id.data[o + 2] = 255;
      id.data[o + 3] = v;
    }
    base.ctx.putImageData(id, 0, 0);
    return base.c;
  }

  /** Draw the current stroke buffer onto a context, clipped to the selection. */
  private drawStroke(ctx: CanvasRenderingContext2D) {
    ctx.save();
    this.clipTo(ctx, this.clip, this.clipAngle, this.clipPivot);
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

  /** Replace the engine's view of which layers are transparency/pixels locked.
   *  Called from the editor whenever the layer tree changes; position lock is a
   *  UI-level guard and isn't tracked here. */
  syncLayerLocks(list: { id: string; transparency: boolean; pixels: boolean }[]) {
    this.layerLocks.clear();
    for (const l of list) {
      if (l.transparency || l.pixels)
        this.layerLocks.set(l.id, { transparency: l.transparency, pixels: l.pixels });
    }
  }

  /** True when `id`'s pixels are locked — lets callers short-circuit an op before
   *  it runs (the pushEntry backstop also reverts anything that slips through). */
  isPixelsLocked(id: string) {
    return !!this.layerLocks.get(id)?.pixels;
  }

  /** Rewrite `after` so the alpha channel matches `before` (transparency lock):
   *  keep the painted colour where the pixel was already opaque, restore the
   *  original colour where it was transparent or the edit erased it. Works for
   *  every tool — paint, erase, fill, filters — from one uniform rule. */
  private freezeAlpha(before: ImageData, after: ImageData): ImageData {
    const out = new ImageData(after.width, after.height);
    const b = before.data;
    const a = after.data;
    const o = out.data;
    for (let i = 0; i < o.length; i += 4) {
      const ba = b[i + 3];
      o[i + 3] = ba; // alpha is frozen to its pre-edit value
      if (ba !== 0 && a[i + 3] > 0) {
        o[i] = a[i]; // opaque + still painted → take the new colour
        o[i + 1] = a[i + 1];
        o[i + 2] = a[i + 2];
      } else {
        o[i] = b[i]; // transparent, or erased away → keep the original colour
        o[i + 1] = b[i + 1];
        o[i + 2] = b[i + 2];
      }
    }
    return out;
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
    // ── Edit-lock enforcement (the universal pixel-commit chokepoint) ──────────
    // Transform ops (Move/Rotate/Scale) reposition existing pixels — they answer
    // to POSITION lock, guarded at the UI entry, so they're exempt here. Every
    // other layer-surface op is a pixel edit: a pixels-lock reverts it outright,
    // a transparency-lock rewrites it to leave the alpha channel untouched.
    if (surface === "layer" && label !== "Move" && label !== "Rotate" && label !== "Scale") {
      const lock = this.layerLocks.get(layerId);
      if (lock?.pixels) {
        this.layer(layerId).ctx.putImageData(before, rect.x, rect.y); // undo the edit
        this.emitChange();
        return;
      }
      if (lock?.transparency) {
        after = this.freezeAlpha(before, after);
        this.layer(layerId).ctx.putImageData(after, rect.x, rect.y);
      }
    }
    this.linkEntry({ layerId, rect, before, after, label, side, surface });
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
    this.linkEntry({ label, side: { undo, redo } });
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
      this.shapeEntry = { layerId, rect: b, before: this.shapeOrig!, after, label: "Shape", parent: ROOT };
      this.linkEntry(this.shapeEntry);
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
      this.gradEntry = {
        layerId: mid,
        rect: b,
        before: this.gradOrig!,
        after,
        label: "Gradient",
        surface: onMask ? "mask" : "layer",
        parent: ROOT,
      };
      this.linkEntry(this.gradEntry);
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
    // A duplicated frame keeps its source, or the copy could never be re-fitted.
    const fsrc = this.frameSrc.get(srcId);
    if (fsrc) this.setFrameSource(dstId, fsrc, fsrc.width, fsrc.height);
    else this.frameSrc.delete(dstId);
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
    this.frameSrc.delete(id);
    this.freeMask(id);
    this.freeMask(filterMaskKey(id));
    this.dropCache(id);
    this.pixelVersion.delete(id);
    this.contentBoundsCache.delete(id);
    this.maskVersion.delete(id);
    this.maskVersion.delete(filterMaskKey(id));
    this.toneCache.delete(id);
    this.filteredCache.delete(id);
    this.filterPending.delete(id);
    this.adjMeta.delete(id);
  }

  // ---- Frame content sources ------------------------------------------------
  // The image placed in a frame, kept at its NATURAL size so the frame can be
  // re-fitted (cover -> contain, a different scale, a nudge) without going back
  // to the file. The frame layer's own canvas holds the FITTED result at
  // document resolution; re-fitting from that would resample an already
  // resampled picture and lose whatever the frame had cropped away.
  //
  // Deliberately not the masks map: that allocates document-sized canvases and
  // derives a mask alpha, both wrong for an arbitrary-size colour source.

  /** Store (a copy of) the image placed in a frame, at its natural size. */
  setFrameSource(id: string, source: CanvasImageSource, w: number, h: number) {
    if (!(w > 0 && h > 0)) return;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    checkAllocation(ctx, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    this.frameSrc.set(id, c);
  }

  getFrameSource(id: string): HTMLCanvasElement | null {
    return this.frameSrc.get(id) ?? null;
  }

  hasFrameSource(id: string): boolean {
    return this.frameSrc.has(id);
  }

  /** For the project file. */
  getFrameSourceImage(id: string): string | null {
    const c = this.frameSrc.get(id);
    return c ? c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getFrameSourceImage` would encode — see above. */
  getFrameSourceImageCanvas(id: string): HTMLCanvasElement | null {
    return this.frameSrc.get(id) ?? null;
  }

  clearFrameSource(id: string) {
    this.frameSrc.delete(id);
  }

  /** A leaf layer's pixels as a PNG data URL (null if it has no canvas yet). */
  getLayerImage(id: string): string | null {
    const l = this.layers.get(id);
    return l ? l.c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getLayerImage` would encode — its OWN raster, not the
   *  doc-sized copy `getLayerCanvas` makes, so a caller that encodes this gets
   *  byte-identical output. Autosave hands these to a worker instead of
   *  encoding on the main thread; everything else uses the getters above. */
  getLayerImageCanvas(id: string): HTMLCanvasElement | null {
    return this.layers.get(id)?.c ?? null;
  }

  /** A doc-sized COPY of a layer's raster as a canvas (blank if it has none
   *  yet — a fresh empty layer simply liquifies/reads as transparency). */
  modifySelection(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
    op: ModifyOp,
    px: number,
  ): Rect[] {
    if (!rects.length) return [];
    // Rasterise through the existing mask builder so rotation is handled once,
    // in the place that already gets it right — then the morphology is plain
    // grid work and the result comes back as axis-aligned rects.
    const prevRefine = this.refine;
    this.refine = NO_REFINE; // Modify acts on the GEOMETRY, not the refined edge
    const canvas = this.selectionMask(rects, angle, pivot, 0);
    this.refine = prevRefine;
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

  setGlobalLight(l: GlobalLight) {
    this.globalLight = l;
    this.clearRenderCaches();
    this.emitChange();
  }
  getGlobalLight(): GlobalLight {
    return this.globalLight;
  }

  setRefineEdge(r: RefineEdge) {
    this.refine = r;
    this.emitChange();
  }
  getRefineEdge(): RefineEdge {
    return this.refine;
  }

  getLayerCanvas(id: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    checkAllocation(c.getContext("2d"), this.w, this.h);
    const l = this.layers.get(id);
    if (l) c.getContext("2d")!.drawImage(l.c, 0, 0);
    return c;
  }

  /** A layer's grayscale mask as a PNG data URL (null if it has no mask). */
  getMaskImage(id: string): string | null {
    const m = this.masks.get(id);
    return m ? m.c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getMaskImage` would encode — see getLayerImageCanvas. */
  getMaskImageCanvas(id: string): HTMLCanvasElement | null {
    return this.masks.get(id)?.c ?? null;
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
      this.adjEntry = {
        layerId: this.adjLayer,
        rect: { x: 0, y: 0, w: this.w, h: this.h },
        before: this.adjOrig,
        after,
        label: this.adjTone ? (this.adjTone.type === "levels" ? "Levels" : "Curves") : "Adjustments",
        parent: ROOT, // linkEntry sets the real parent
      };
      this.linkEntry(this.adjEntry);
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
      // Discard the live-adjustment placeholder. It is always the newest entry
      // and the one we're sitting on, so step off it before dropping the node
      // (dropNodes must never delete the state the document is showing).
      const idx = this.entries.indexOf(this.adjEntry);
      if (idx >= 0) {
        if (this.cur === idx) this.cur = this.entries[idx].parent;
        this.dropNodes([idx]);
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
    if (this.moving && s && this.moveExtra.length) {
      const ex = this.moveExtra.find((e) => e.id === id); // a linked layer riding along
      if (ex) {
        s.globalAlpha = 1;
        s.globalCompositeOperation = "source-over";
        s.clearRect(0, 0, this.w, this.h);
        if (l) s.drawImage(l.c, 0, 0); // layer was cleared at beginMove
        s.drawImage(ex.float.c, this.moveOff.x, this.moveOff.y);
        return this.scratch!.c;
      }
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
    const alpha = node.mask?.enabled ? this.maskDisplay(node.id) : null;
    // Both masks MULTIPLY: a pixel survives only where the raster mask and the
    // vector mask both let it through.
    const vec = this.vectorMaskAlpha(node);
    if (!alpha && !vec) return src;
    if (!this.maskTmp || this.maskTmp.c.width !== this.w || this.maskTmp.c.height !== this.h)
      this.maskTmp = this.mk(this.w, this.h);
    const t = this.maskTmp;
    t.ctx.globalAlpha = 1;
    t.ctx.globalCompositeOperation = "source-over";
    t.ctx.clearRect(0, 0, this.w, this.h);
    t.ctx.drawImage(src, 0, 0);
    t.ctx.globalCompositeOperation = "destination-in";
    if (alpha) t.ctx.drawImage(alpha, 0, 0);
    if (vec) t.ctx.drawImage(vec, 0, 0);
    t.ctx.globalCompositeOperation = "source-over";
    return t.c;
  }

  /**
   * The vector mask as a doc-sized alpha canvas (RGB irrelevant, alpha is the
   * coverage). Rasterised with Path2D so the edge is anti-aliased by the same
   * rasteriser that draws every other vector in the app, rather than by a
   * hand-rolled scan converter.
   *
   * An OPEN path is filled as though closed: a mask is an area, and Photoshop
   * treats a vector mask's path the same way.
   */
  private vectorMaskAlpha(node: LayerNode): HTMLCanvasElement | null {
    const vm = node.vectorMask;
    if (!vectorMaskActive(vm)) return null;
    const key = `${vectorMaskHash(vm)}|${this.w}x${this.h}`;
    const hit = this.vectorMaskCache.get(node.id);
    if (hit && hit.key === key) return hit.c;
    const buf = this.mk(this.w, this.h);
    const p = new Path2D(pathToSvgD(vm.anchors, true));
    buf.ctx.fillStyle = "#fff";
    if (vm.inverted) {
      buf.ctx.fillRect(0, 0, this.w, this.h);
      buf.ctx.globalCompositeOperation = "destination-out";
      buf.ctx.fill(p);
      buf.ctx.globalCompositeOperation = "source-over";
    } else {
      buf.ctx.fill(p);
    }
    let out = buf.c;
    if (vm.feather > 0) {
      const soft = this.mk(this.w, this.h);
      soft.ctx.filter = `blur(${vm.feather}px)`;
      soft.ctx.drawImage(buf.c, 0, 0);
      soft.ctx.filter = "none";
      out = soft.c;
    }
    this.vectorMaskCache.set(node.id, { key, c: out });
    return out;
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
    const vm = vectorMaskActive(node.vectorMask) ? fnv(vectorMaskHash(node.vectorMask)) : "x";
    // Fill opacity is baked into the styled render (effects keep theirs), so
    // it belongs in the intrinsic key rather than in effectiveKey.
    const fo = fillOpacityActive(node.fillOpacity) ? Math.round(node.fillOpacity!) : "x";
    const fx = hasEnabledFx(node.effects) ? fnv(fxHash(node.effects)) : "0";
    // The light lives on the DOCUMENT, so `fxHash` cannot see it changing.
    const gl = globalLightKey(node.effects, this.globalLight);
    const flt = hasEnabledFilters(node.filters) ? fnv(filterStackHash(node.filters)) : "0";
    // The filter mask only shapes the render while the stack actually runs.
    const fmv =
      flt !== "0" && node.filterMask?.enabled
        ? (this.maskVersion.get(filterMaskKey(node.id)) ?? 0)
        : "x";
    if (node.type === "group") {
      let sig = "";
      for (const c of node.children) sig += this.effectiveKey(c) + ";";
      return `G${fnv(sig)}|${flt}|${fmv}|${fx}|${gl}|${mv}|${vm}|${fo}|${this.cs}|${this.docEpoch}`;
    }
    const pv = this.pixelVersion.get(node.id) ?? 0;
    // A Fill layer's render depends on its spec, not stored pixels.
    const fillH = node.type === "layer" && node.fill ? fnv(this.specHash(node.fill)) : "0";
    return `L${pv}|${fillH}|${flt}|${fmv}|${fx}|${gl}|${mv}|${vm}|${fo}|${this.cs}|${this.docEpoch}`;
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
    if (this.moving) for (const ex of this.moveExtra) live.add(ex.id);
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
  /** Every entry the evictor may consider, lazily: whole products first, then
   *  each resident tile of a tiled product as its own candidate. A generator
   *  METHOD rather than a nested `function*` — a generator declaration binds its
   *  own `this`, which is what forced the `const self = this` this replaces. */
  private *evictionCandidates(): Generator<[string, { bytes: number; tick: number }]> {
    yield* this.renderCache;
    for (const [id, t] of this.tiledAdj) {
      if (this.frameProtect.has(id)) continue; // whole product in use this frame
      for (let i = 0; i < t.tiles.length; i++) {
        const tile = t.tiles[i];
        if (tile) yield [id + TILE_ID_SEP + i, tile];
      }
    }
  }

  private evictOverBudget() {
    if (this.renderBytes <= this.renderBudget) return;
    for (const id of selectEvictions(
      this.evictionCandidates(),
      this.renderBytes,
      this.renderBudget,
      this.frameProtect,
    )) {
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
  /** Render a Fill layer's parametric content full-canvas into an owned buffer
   *  (cached like any intrinsic render, keyed on the fill spec via nodeKey). */
  private renderFill(node: LayerLeaf): HTMLCanvasElement {
    const out = this.mk(this.w, this.h);
    const ctx = out.ctx;
    const fill = node.fill!;
    if (fill.kind === "solid") {
      ctx.fillStyle = fill.color;
      ctx.fillRect(0, 0, this.w, this.h);
      return out.c;
    }
    const g = fill.gradient;
    // Reverse just flips the stop positions (buildCanvasGradient re-sorts).
    const stops = g.reverse ? g.stops.map((s) => ({ color: s.color, pos: 1 - s.pos })) : g.stops;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const half = Math.max(1, ((g.scale || 1) * Math.hypot(this.w, this.h)) / 2);
    const rad = (g.angle * Math.PI) / 180;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    // Radial/angle grow from the centre; linear/reflected run through it.
    const start =
      g.type === "radial" || g.type === "angle"
        ? { x: cx, y: cy }
        : { x: cx - dir.x * half, y: cy - dir.y * half };
    const end = { x: cx + dir.x * half, y: cy + dir.y * half };
    ctx.fillStyle = buildCanvasGradient(ctx, g.type, start, end, 0.5, stops, g.smooth);
    ctx.fillRect(0, 0, this.w, this.h);
    return out.c;
  }

  private renderNode(node: LayerNode): HTMLCanvasElement | null {
    if (node.type === "adjustment") return null; // handled by drawStack
    // Plain leaf (no fill, no mask of EITHER kind, no effects, no smart
    // filters): its layer canvas IS the intrinsic render — alias it, no copy,
    // no cache entry needed.
    if (
      node.type === "layer" &&
      !node.fill &&
      !node.mask?.enabled &&
      !vectorMaskActive(node.vectorMask) &&
      !fillOpacityActive(node.fillOpacity) &&
      !hasEnabledFx(node.effects) &&
      !hasEnabledFilters(node.filters)
    ) {
      return this.leafDisplay(node.id);
    }
    const bypass = !this.renderCacheOn || this.liveBypass.has(node.id);
    const key = bypass ? "" : this.nodeKey(node);
    if (!bypass) {
      const hit = this.renderCache.get(node.id);
      if (hit && hit.key === key && !hit.dirty) {
        this.cacheHits++;
        hit.tick = ++this.renderTick;
        this.frameProtect.add(node.id);
        return hit.c;
      }
      // A stale entry whose ONLY change is a bounded pixel edit can be repaired
      // in place: repaint the padded rect and keep the rest of the product.
      if (hit && hit.dirty && this.onlyPixelsChanged(hit.key, key) && this.repaintRegion(node, hit)) {
        hit.key = key;
        hit.dirty = null;
        hit.tick = ++this.renderTick;
        this.regionHits++;
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
    // Either mask sends the render through maskedSource — a layer carrying only
    // a VECTOR mask must not take the unmasked fast path.
    if (node.mask?.enabled || vectorMaskActive(node.vectorMask)) {
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
    this.pushKnockoutScope();
    this.drawStack(bctx, node.children); // sub-stack: clip groups / adjustments stay group-isolated
    const deep = this.popKnockoutScope();
    if (deep) this.pendingDeep.set(node.id, deep);
    else this.pendingDeep.delete(node.id);
    // Group smart filters run on the merged children (group isolation), below
    // the group's own effects — same order as a leaf: pixels → filters → fx.
    const filtered = hasEnabledFilters(node.filters) ? this.filteredProduct(node, bc) : bc;
    return styled
      ? renderStyled(
          filtered,
          resolveGlobalLight(node.effects, this.globalLight)!,
          this.cs,
          fillAlpha(node.fillOpacity),
        ).canvas
      : filtered;
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
    // A Fill layer's base pixels come from its spec, not a stored canvas.
    const disp = node.type === "layer" && node.fill ? this.renderFill(node) : this.leafDisplay(node.id);
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
    let src = this.renderNode(node);
    if (!src) return;
    // Blend If: gate the layer's alpha by its own channel value and by whatever
    // is already composited beneath it. Only reached when the sliders actually
    // hide something — an inactive blend-if costs nothing at all.
    if (blendIfActive(node.blendIf)) src = this.applyBlendIf(ctx, src, node.blendIf!);

    // KNOCKOUT: punch this layer's own shape out of everything already
    // composited beneath it, THEN paint the layer back over the hole. At fill
    // opacity 100 the layer covers the hole exactly and nothing looks different
    // — which is why knockout only reads as an effect once fill drops.
    //
    // The punch uses the layer's own alpha, never the styled buffer: knocking
    // out by a drop shadow would eat a soft halo out of the backdrop.
    // A group whose descendants knocked out DEEP: their shapes have to reach the
    // parent, so punch them here, before the group's own buffer lands.
    const inherited = node.type === "group" ? this.pendingDeep.get(node.id) : undefined;
    if (inherited) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(inherited, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      this.collectDeepKnockout(inherited); // keep escaping outward
    }

    const ko = knockoutOf(node.knockout);
    if (ko !== "none") {
      const shape = this.knockoutShape(node);
      if (shape) {
        // "Shallow" is free: `ctx` here IS the enclosing group's accumulator, so
        // punching it reaches exactly to the bottom of the group. "Deep" has to
        // escape the group, so it is collected and punched again at the root.
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(shape, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        if (ko === "deep") this.collectDeepKnockout(shape);
      }
    }

    // Fill opacity is already baked into the styled buffer when the layer has
    // effects (they keep their own strength); apply it here only when it is not.
    const foAlpha = hasEnabledFx(node.effects) ? 1 : fillAlpha(node.fillOpacity);
    ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity / 100)) * foAlpha;
    ctx.globalCompositeOperation = blendOp(node.blend);
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Deep knockout, done by PROPAGATION rather than a final root punch.
   *
   * The obvious implementation — union every deep shape and punch it out of the
   * finished composite — is wrong, and measurably so: by then the knockout layer
   * has already painted itself back over its own hole, so the final punch erases
   * the layer too. A hole appeared even at fill opacity 100, where the layer is
   * supposed to cover it exactly.
   *
   * What deep actually means is "punch everything BELOW me, even outside my
   * group". A layer at the top level already gets that from the inline punch,
   * because `ctx` there IS the root accumulator. Only nesting needs more: the
   * shape has to escape upward, so each group render collects its descendants'
   * deep shapes and the parent punches them just before drawing that group.
   */
  private koScopes: { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; used: boolean }[] = [];
  /** Per-group union of descendant deep-knockout shapes, awaiting the merge. */
  private pendingDeep = new Map<string, HTMLCanvasElement>();

  private pushKnockoutScope() {
    const b = this.mk(this.w, this.h);
    this.koScopes.push({ c: b.c, ctx: b.ctx, used: false });
  }

  /** Pop the current scope, returning its union (or null if nothing deep ran). */
  private popKnockoutScope(): HTMLCanvasElement | null {
    const sc = this.koScopes.pop();
    return sc && sc.used ? sc.c : null;
  }

  /** Record a deep shape in the innermost open scope so the enclosing group can
   *  punch it out of ITS parent when it merges. */
  private collectDeepKnockout(shape: HTMLCanvasElement) {
    const sc = this.koScopes[this.koScopes.length - 1];
    if (!sc) return; // top level: the inline punch already reached the root
    sc.ctx.drawImage(shape, 0, 0);
    sc.used = true;
  }

  /** The silhouette a knockout punches with: the layer's OWN pixels (or a
   *  group's merged render), never its effects. */
  private knockoutShape(node: LayerNode): HTMLCanvasElement | null {
    if (node.type === "layer" && !node.fill) return this.leafDisplay(node.id);
    return this.renderNode(node);
  }

  /**
   * Return a copy of `src` whose alpha has been multiplied by the Blend-If
   * coverage. "This layer" reads `src`; "underlying" reads what is already in
   * the destination context — which is exactly right for a painter's-algorithm
   * compositor, because everything below this node is already there.
   *
   * Both ranges become 256-entry LUTs first, so the inner loop is two lookups
   * and a multiply per pixel.
   */
  private applyBlendIf(
    ctx: CanvasRenderingContext2D,
    src: HTMLCanvasElement,
    spec: BlendIf,
  ): HTMLCanvasElement {
    const out = this.mk(this.w, this.h);
    const sctx = src.getContext("2d");
    if (!sctx) return src;
    const layer = sctx.getImageData(0, 0, this.w, this.h);
    const under = ctx.getImageData(0, 0, this.w, this.h);
    const a = layer.data;
    const u = under.data;
    const thisOn = rangeActive(spec.this);
    const underOn = rangeActive(spec.under);
    const thisLut = thisOn ? buildLut(spec.this) : null;
    const underLut = underOn ? buildLut(spec.under) : null;
    const ch = spec.channel;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] === 0) continue; // already invisible — nothing to gate
      let cover = 255;
      if (thisLut) cover = thisLut[Math.round(channelValue(a[i], a[i + 1], a[i + 2], ch))];
      if (cover && underLut) {
        // Underlying pixels that are transparent read as black, which matches
        // Photoshop: an empty document is the darkest possible backdrop.
        const uc = u[i + 3] === 0 ? 0 : Math.round(channelValue(u[i], u[i + 1], u[i + 2], ch));
        cover = (cover * underLut[uc]) / 255;
      }
      a[i + 3] = (a[i + 3] * cover) / 255;
    }
    out.ctx.putImageData(layer, 0, 0);
    return out.c;
  }

  /** The styled buffer for a leaf with effects. Only reached on a render-cache
   *  miss (renderNode caches the product, keyed by pixelVersion/fxHash/space/
   *  epoch — the old standalone effectsCache is folded into that node cache). */
  /**
   * Repaint just the stale rect of a cached styled product, in place.
   *
   * Two rects, and the difference between them is the whole correctness story:
   *   OUT — the dirty rect grown by the effects' reach. Output can only have
   *     changed this far from the pixels that changed, so everything outside it
   *     in the cached product is still correct and is kept.
   *   IN  — OUT grown by the reach AGAIN. To compute OUT correctly the renderer
   *     needs every input pixel that can influence it, which extends one reach
   *     beyond OUT. The border of the IN render is therefore wrong (it was
   *     computed without ITS neighbours) and is discarded — only OUT is kept.
   *
   * Returns false when it declines, in which case the caller takes the full
   * pass; it must never return true having written something a full render
   * would not have produced.
   */
  private repaintRegion(node: LayerNode, entry: RenderNodeCache): boolean {
    const dirty = entry.dirty;
    if (!dirty || !this.regionPatchable(node.id)) return false;
    const reach = effectsReach(node.effects);
    if (reach === null) return false;
    const out = padRect(dirty, reach, this.w, this.h);
    const inn = padRect(out, reach, this.w, this.h);
    if (out.w <= 0 || out.h <= 0 || inn.w <= 0 || inn.h <= 0) return false;
    // Past this share the region render costs more than the full pass it saves.
    if (!regionWorthIt(inn, this.w, this.h)) return false;
    // The product must be a buffer we own and can draw into at document size.
    if (entry.c.width !== this.w || entry.c.height !== this.h || entry.bytes === 0) return false;
    const src = this.leafDisplay(node.id);
    if (!src) return false;

    const sub = this.mk(inn.w, inn.h);
    sub.ctx.drawImage(src, -inn.x, -inn.y);
    const litFx = resolveGlobalLight(node.effects, this.globalLight)!;
    const styled = renderStyled(sub.c, litFx, this.cs, fillAlpha(node.fillOpacity)).canvas;

    const dctx = entry.c.getContext("2d");
    if (!dctx) return false;
    dctx.save();
    dctx.globalAlpha = 1;
    // REPLACE, never blend: the region carries its own alpha and compositing it
    // over the stale pixels would double the shadow everywhere they overlap.
    dctx.globalCompositeOperation = "source-over";
    dctx.clearRect(out.x, out.y, out.w, out.h);
    dctx.drawImage(styled, out.x - inn.x, out.y - inn.y, out.w, out.h, out.x, out.y, out.w, out.h);
    // Masks multiply the styled render, so re-apply them over exactly the rect
    // just repainted — the same two multiplied alphas maskedSource uses, clipped
    // to OUT so nothing outside it is touched.
    const rasterAlpha = node.mask?.enabled ? this.maskDisplay(node.id) : null;
    const vecAlpha = this.vectorMaskAlpha(node);
    if (rasterAlpha || vecAlpha) {
      dctx.beginPath();
      dctx.rect(out.x, out.y, out.w, out.h);
      dctx.clip();
      dctx.globalCompositeOperation = "destination-in";
      if (rasterAlpha) dctx.drawImage(rasterAlpha, 0, 0);
      if (vecAlpha) dctx.drawImage(vecAlpha, 0, 0);
      dctx.globalCompositeOperation = "source-over";
    }
    dctx.restore();
    this.regionPx += out.w * out.h;
    return true;
  }

  private styledLeaf(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    // Effects have no worker and no product cache of their own, so a live
    // gesture re-renders them in full on every frame. Measured at ~1390 ms of
    // blocking over a 20-step stroke on a layer with one default drop shadow —
    // six times the (already-fixed) smart-filter case.
    //
    // The cost is NOT the blur kernel: a shadow at size 250 measured 1450 ms
    // against 1390 ms at the default, because renderStyled's fixed setup
    // dominates — a full-canvas getImageData plus a Float32Array alpha buffer
    // (8 MB at 1920×1080) per call, regardless of radius. Shrinking the surface
    // therefore beats making the kernel faster, and it is the same draft
    // treatment the filter path already uses.
    if (this.liveBypass.has(node.id) && !this.exporting) {
      const draft = this.draftScale();
      if (draft < 1) return this.styledLeafDraft(node, src, draft);
    }
    const litFx = resolveGlobalLight(node.effects, this.globalLight)!;
    return renderStyled(src, litFx, this.cs, fillAlpha(node.fillOpacity)).canvas;
  }

  /** Effects rendered on a downscaled silhouette and upscaled back. `fx.scale`
   *  is a percent the renderer already applies to every spatial param, so the
   *  draft factor rides in through it — a 12 px shadow over half as many pixels
   *  has to become 6 px or the preview would show a different effect. */
  private styledLeafDraft(
    node: LayerNode,
    src: HTMLCanvasElement,
    scale: number,
  ): HTMLCanvasElement {
    this.draftPainted = true; // the settled frame must repaint the whole view
    const sw = Math.max(1, Math.round(this.w * scale));
    const sh = Math.max(1, Math.round(this.h * scale));
    const small = this.mk(sw, sh, true);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = "low";
    small.ctx.drawImage(src, 0, 0, sw, sh);

    const fx = resolveGlobalLight(node.effects, this.globalLight)!;
    const scaled = { ...fx, scale: (fx.scale ?? 100) * scale };
    const styled = renderStyled(small.c, scaled, this.cs, fillAlpha(node.fillOpacity)).canvas;

    const out = this.mk(this.w, this.h);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = "high"; // the upscale is what the user sees
    out.ctx.drawImage(styled, 0, 0, styled.width, styled.height, 0, 0, this.w, this.h);
    return out.c;
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
    const cur = this.filterStack(
      out,
      filters,
      fmAlpha ? () => fmAlpha.getContext("2d")!.getImageData(0, 0, this.w, this.h).data : null,
      this.w,
      this.h,
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
    buf: Layer,
    filters: SmartFilter[],
    fm: (() => Uint8ClampedArray) | null,
    w: number,
    h: number,
  ): ImageData {
    let cur = buf.ctx.getImageData(0, 0, w, h);
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
    const t0 = nowMs();
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
        this.recordFrame(nowMs() - t0, null, true);
        return;
      }
    }
    // Frame setup for the render graph: fresh key memo + used-entry protection,
    // and the set of live-session layers (+ ancestors) that bypass the cache.
    this.keyMemo.clear();
    this.frameProtect.clear();
    this.liveBypass = this.computeLiveBypass(tree);
    this.curTree = tree;
    // A gesture that painted DRAFT filter/effect pixels leaves them wherever it
    // blitted, and those blits are region-scoped — so the first settled frame
    // after the session must repaint the whole view, not just the last dirty
    // rect, or draft pixels survive outside it. (Caught by the byte-identity
    // rail: 15,470 bytes still differed after a stroke on a shadowed layer.)
    if (this.draftPainted && this.liveBypass.size === 0) {
      this.draftPainted = false;
      this.lastTree = null; // ⇒ full blit below
    }
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
    this.recordFrame(nowMs() - t0, d, !d); // d === null ⇒ a full-document blit
  }

  /** Begin moving pixels: lift the selection (or whole layer) into a float buffer.
   *  `linkedMask` (whole-layer moves only): shift the layer's mask along with the
   *  pixels on commit — the Layers-panel chain toggle. */
  beginMove(
    layerId: string,
    rects: Rect[] | null,
    linkedMask = false,
    linked: { id: string; maskLinked: boolean }[] = [],
  ) {
    this.ensureOpBuffers();
    if (!this.stroke) return;
    this.moving = true;
    this.moveMaskLinked = linkedMask && !rects;
    this.moveLayer = layerId;
    this.moveOff = { x: 0, y: 0 };
    this.moveExtra = [];
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
      // Linked layers ride along a whole-layer move only: float each and clear it
      // so its preview follows the same delta; committed together in endMove.
      for (const { id, maskLinked } of linked) {
        if (id === layerId) continue;
        const el = this.layer(id);
        const orig = this.mk(this.w, this.h, true);
        orig.ctx.drawImage(el.c, 0, 0);
        const float = this.mk(this.w, this.h);
        float.ctx.drawImage(el.c, 0, 0);
        el.ctx.clearRect(0, 0, this.w, this.h);
        this.moveExtra.push({ id, orig, float, maskLinked });
      }
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
    checkAllocation(octx, bounds.w, bounds.h);
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

  // ---- Quick selection (edge-aware region grow) ----------------------------
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
    const ctx = opts.sampleAll ? this.vctx : this.layers.get(layerId)?.ctx;
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
  // Reusable scratch for combineSelection, plus the bounds the last call left
  // 1s in — clearing just that beats both allocating a zeroed buffer and wiping
  // the whole one.
  private combineBuf: Uint8Array | null = null;
  private combineBufW = 0;
  private combineBufH = 0;
  private combineDirty: Bounds | null = null;

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

  moveTo(dx: number, dy: number) {
    if (!this.moving) return;
    this.moveOff = { x: Math.round(dx), y: Math.round(dy) };
    this.emitChange();
  }

  /** Abort a live move: put the floated pixels back where they came from.
   *
   *  A zero offset is all it takes — `endMove` bakes the float at `moveOff`, so
   *  clearing that first draws every floated layer back exactly where it
   *  started, and its `moved` check then records no history for a move that did
   *  not happen. Used when a second finger pre-empts a one-finger drag. */
  cancelMove() {
    this.moveOff = { x: 0, y: 0 };
    this.endMove();
  }

  endMove() {
    if (!this.moving || !this.moveLayer || !this.moveFloat || !this.moveOrig) {
      this.moving = false;
      this.moveExtra = [];
      return;
    }
    const l = this.layer(this.moveLayer);
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.drawImage(this.moveFloat.c, this.moveOff.x, this.moveOff.y);
    // Bake each linked layer's float at the same delta (a zero move restores it).
    for (const ex of this.moveExtra) {
      const el = this.layer(ex.id);
      el.ctx.globalAlpha = 1;
      el.ctx.globalCompositeOperation = "source-over";
      el.ctx.drawImage(ex.float.c, this.moveOff.x, this.moveOff.y);
    }

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
      const off = { x: Math.round(this.moveOff.x), y: Math.round(this.moveOff.y) };
      // Fold-in ops so ONE undo restores the whole linked move together with the
      // primary layer (whose own before/after the pushEntry journals directly):
      // every linked mask shifts by the same delta, and each extra linked layer's
      // full-canvas pixels ride along in the same history step's side callbacks.
      const undoOps: (() => void)[] = [];
      const redoOps: (() => void)[] = [];
      const foldMask = (id: string) => {
        const m = this.masks.get(id);
        if (!m) return;
        const before = m.ctx.getImageData(0, 0, this.w, this.h);
        m.ctx.globalAlpha = 1;
        m.ctx.globalCompositeOperation = "source-over";
        m.ctx.fillStyle = "#000"; // vacated area = hidden (matches offsetMask)
        m.ctx.fillRect(0, 0, this.w, this.h);
        m.ctx.putImageData(before, off.x, off.y);
        this.deriveMaskAlpha(id);
        const after = m.ctx.getImageData(0, 0, this.w, this.h);
        undoOps.push(() => {
          const mm = this.masks.get(id);
          if (mm) {
            mm.ctx.putImageData(before, 0, 0);
            this.deriveMaskAlpha(id);
          }
        });
        redoOps.push(() => {
          const mm = this.masks.get(id);
          if (mm) {
            mm.ctx.putImageData(after, 0, 0);
            this.deriveMaskAlpha(id);
          }
        });
      };
      if (this.moveMaskLinked) foldMask(this.moveLayer);
      const full: Rect = { x: 0, y: 0, w: this.w, h: this.h };
      for (const ex of this.moveExtra) {
        const id = ex.id;
        const el = this.layer(id);
        const before = ex.orig.ctx.getImageData(0, 0, this.w, this.h);
        const after = el.ctx.getImageData(0, 0, this.w, this.h);
        undoOps.push(() => {
          this.layer(id).ctx.putImageData(before, 0, 0);
          this.bumpPixel(id, full);
        });
        redoOps.push(() => {
          this.layer(id).ctx.putImageData(after, 0, 0);
          this.bumpPixel(id, full);
        });
        if (ex.maskLinked) foldMask(id);
      }
      const side: HistorySide | undefined =
        undoOps.length || redoOps.length
          ? { undo: () => undoOps.forEach((f) => f()), redo: () => redoOps.forEach((f) => f()) }
          : undefined;
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
    this.moveExtra = [];
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
    pressure = 1,
  ) {
    this.ensureOpBuffers();
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
    this.emitChange();
  }

  private dynActive(): boolean {
    return this.dyn.size || this.dyn.flow;
  }

  /** Dab spacing at a given pressure. Spacing is a fraction of the tip DIAMETER,
   *  so when pressure narrows the tip the spacing has to narrow with it — else a
   *  light passage breaks into a row of beads. With size dynamics off this is
   *  exactly the spacing the session set (which is how the clone tool keeps its
   *  own configurable spacing). */
  /** The tip DIAMETER at this pressure — scatter is expressed as a % of it, so
   *  a pressure-tapered stroke scatters proportionally rather than at a fixed
   *  width. */
  private tipDiameter(p: number): number {
    const base = this.brush?.size ?? 1;
    return this.dyn.size ? Math.max(1, base * pressureScale(p, this.dyn.min / 100)) : base;
  }

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
    this.emitChange();
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
    this.tipSpec = null;
    this.tipCache.clear(); // per-stroke cache — the next stroke bakes fresh tips
    this.tipTexture = null;
    this.tipDual = null;
    this.tipShape = null;
    this.tipScatter = null;
    this.scatterRng = null;
    this.dirty = null;
    this.liveProduct = null; // a document-sized buffer; the next stroke reseeds
    if (this.cloneActive) {
      this.cloneActive = false;
      this.cloneSample = null;
      this.cloneDab = null;
      this.cloneOff = null;
    }
    this.emitChange();
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
    this.liveProduct = null;
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
    this.ensureOpBuffers();
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
    // Clone stamps a SAMPLED region through the tip, not the tip itself, so it
    // opts out of pressure dynamics (and keeps its own configurable spacing).
    this.dyn = NO_DYNAMICS;
    this.tipSpec = null;
    this.tipCache.clear();
    this.pressFrom = 1;
    this.pressTo = 1;
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
    this.endAdjust();
    const l = this.layer(layerId);
    this.historying = true;
    this.historyLabel = label;
    this.historyLayer = layerId;
    this.historyOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    // The source: a pinned snapshot when one is selected (exact pixels), else
    // this layer's pixels reconstructed at the source history state.
    const src = this.historySourceSnap
      ? this.snapshotLayer(this.historySourceSnap, layerId)
      : this.reconstructLayerAt(layerId, this.historySourceIndex);
    this.historySource = src.ctx.getImageData(0, 0, this.w, this.h);
    this.historyCov = new Float32Array(this.w * this.h);
    this.historyOpacity = Math.max(0, Math.min(1, brush.opacity / 100));
    this.historyFlow = Math.max(0, Math.min(1, brush.flow / 100));
    this.historySmoothing = brush.smoothing;
    this.historySelMask = null;
    if (clip && clip.length) {
      const mask = this.selectionMask(clip, clipAngle, clipPivot);
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
    this.emitChange();
  }

  moveHistory(rawX: number, rawY: number) {
    if (!this.historying) return;
    this.historyLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.historySmoothing / 100) * 0.85;
    this.historySmoothPt.x += (rawX - this.historySmoothPt.x) * alpha;
    this.historySmoothPt.y += (rawY - this.historySmoothPt.y) * alpha;
    this.historyLineTo(this.historySmoothPt.x, this.historySmoothPt.y);
    this.emitChange();
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
    this.layer(this.historyLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
  }

  endHistory() {
    if (!this.historying) return;
    this.historyLineTo(this.historyLastRaw.x, this.historyLastRaw.y);
    const D = this.historyDirty;
    const layerId = this.historyLayer;
    if (D && layerId != null && this.historyOrig) {
      const x = Math.max(0, D.x0);
      const y = Math.max(0, D.y0);
      const w = Math.min(this.w - 1, D.x1) - x + 1;
      const h = Math.min(this.h - 1, D.y1) - y + 1;
      if (w > 0 && h > 0) {
        const before = this.subImage(this.historyOrig, x, y, w, h);
        const after = this.layer(layerId).ctx.getImageData(x, y, w, h);
        this.pushEntry(layerId, { x, y, w, h }, before, after, this.historyLabel);
      }
    }
    this.historying = false;
    this.historyLayer = null;
    this.historyOrig = null;
    this.historySource = null;
    this.historyCov = null;
    this.historyTip = null;
    this.historyDirty = null;
    this.historySelMask = null;
    this.wandSrc = null;
    this.emitChange();
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
    // All-caps is a style, not an edit: the block's own text is never changed,
    // so the transform happens here — where measuring, wrapping and painting all
    // read from the same string.
    const paras = renderedText(spec.text, spec).split("\n");
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
    layer.ctx.clearRect(0, 0, this.w, this.h);
    this.composeText(layer.ctx, layer.c, spec);
    this.emitChange();
  }

  /** Render a text spec into a standalone doc-sized canvas — no layer, no
   *  history, no change event. Backs the editor's live warp/gradient preview,
   *  which overlays the canvas while a text session is open. */
  textPreview(spec: TextRenderSpec): HTMLCanvasElement {
    const c = this.mk(this.w, this.h);
    this.composeText(c.ctx, c.c, spec);
    return c.c;
  }

  /** Bounding box of a canvas's non-transparent pixels (null when fully clear). */
  canvasContentBounds(c: HTMLCanvasElement): Rect | null {
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    return PaintEngine.alphaBounds(ctx.getImageData(0, 0, c.width, c.height), c.width, c.height);
  }

  /** Bounding box of a LAYER's non-transparent pixels (null when empty/absent).
   *  Compared against what a vector recipe renders, this reveals how far the
   *  layer's pixels have been moved since the recipe was last written. */
  /** A layer's content (non-transparent) bounds, or null when it is empty.
   *
   *  Memoized on the layer's pixel version + the document epoch, because this
   *  reads the WHOLE layer — 48 MB on a 12 MP document — and the Move tool's
   *  transform box asks for it on every overlay frame. The key is the same pair
   *  the render cache uses, so a committed pixel write or a canvas resize
   *  invalidates it exactly. */
  layerContentBounds(id: string): Rect | null {
    const l = this.layers.get(id);
    if (!l) return null;
    const key = `${this.pixelVersion.get(id) ?? 0}:${this.docEpoch}`;
    const hit = this.contentBoundsCache.get(id);
    if (hit && hit.key === key) return hit.box;
    const box = PaintEngine.alphaBounds(l.ctx.getImageData(0, 0, this.w, this.h), this.w, this.h);
    this.contentBoundsCache.set(id, { key, box });
    return box;
  }

  /** Alpha (0–255) of a layer's own pixel at (x, y) — the Move tool's
   *  auto-select hit test. Reads the LAYER, not the composite, so a layer
   *  hidden behind another is still hittable when nothing above it is opaque. */
  layerAlphaAt(id: string, x: number, y: number): number {
    const l = this.layers.get(id);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (!l || ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return 0;
    return l.ctx.getImageData(ix, iy, 1, 1).data[3];
  }

  /**
   * Translate a layer's pixels by (dx, dy). The primitive align/distribute run
   * on — a move DRAG can't serve them, because that session applies one delta to
   * every layer riding along and an align gives each layer its own.
   *
   * No history of its own: the caller brackets a whole batch with
   * captureLeaves/restoreLeaves so one align is one undo step, not one per layer.
   * The vacated area clears to transparency (an offset mask fills black instead
   * — hidden — which is why this can't just call offsetMask on the layer).
   */
  offsetLayerPixels(id: string, dx: number, dy: number, alsoMask = false): void {
    const l = this.layers.get(id);
    if (!l || (dx === 0 && dy === 0)) return;
    const snap = l.ctx.getImageData(0, 0, this.w, this.h);
    l.ctx.globalCompositeOperation = "source-over";
    l.ctx.clearRect(0, 0, this.w, this.h);
    l.ctx.putImageData(snap, Math.round(dx), Math.round(dy));
    this.bumpPixel(id);
    if (alsoMask && this.masks.has(id)) this.offsetMask(id, dx, dy);
    this.emitChange();
  }

  private static alphaBounds(img: ImageData, w: number, h: number): Rect | null {
    const d = img.data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[(row + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Paint `spec` into `ctx` (whose canvas element is `host` — needed so
   *  OpenType features can reach the text pipeline): glyphs → optional 1-bit
   *  threshold → optional gradient fill → optional warp. */
  private composeText(
    ctx: CanvasRenderingContext2D,
    host: HTMLCanvasElement,
    spec: TextRenderSpec,
  ) {
    // A warp renders the flat text into a temp buffer, then texture-maps it onto
    // a deformed mesh — so the warp target is the temp, not the output directly.
    const warp = warpActive(spec.warp) ? spec.warp : null;
    const tmp = warp ? this.mk(this.w, this.h) : null;
    const target = tmp ? tmp.ctx : ctx;
    target.save();
    // Non-default OpenType features need the canvas mounted (hidden) so its
    // font-feature-settings CSS reaches the canvas text pipeline.
    PaintEngine.withTextFeatures(tmp ? tmp.c : host, spec.features, () => {
      if (PaintEngine.isRichSpec(spec)) this.drawRichText(target, spec);
      else this.drawUniformText(target, spec);
    });
    target.restore();

    const bounds = this.textBounds(spec);
    // No anti-aliasing: threshold the rendered alpha to hard 1-bit edges. The
    // solid value is the colour's own alpha (so text opacity is preserved); edge
    // pixels (partial coverage) snap to fully on/off at the 50%-coverage line.
    // Skipped under a warp — its bilinear resample would soften the hard edges
    // anyway (unchanged from the flat-vs-warp behaviour that shipped).
    if (!spec.antialias && !warp) this.thresholdTextAlpha(target, spec, bounds);
    // Gradient fill: repaint the glyph coverage with the gradient (source-in
    // keeps exactly the alpha the glyphs produced, so AA/threshold survive).
    // Applied before the warp, so the mesh carries the gradient with the text.
    if (spec.fill) this.fillTextGradient(target, spec.fill, bounds);

    if (warp && tmp) this.drawWarpedText(ctx, tmp.c, bounds, warp);
  }

  /** Threshold text alpha to hard 1-bit edges over the text's padded bounds. */
  private thresholdTextAlpha(
    ctx: CanvasRenderingContext2D,
    spec: TextRenderSpec,
    b: { x: number; y: number; w: number; h: number },
  ) {
    const pad = Math.ceil(spec.fontSize * 0.5) + 2;
    const x = Math.max(0, Math.floor(b.x - pad));
    const y = Math.max(0, Math.floor(b.y - pad));
    const x1 = Math.min(this.w, Math.ceil(b.x + b.w + pad));
    const y1 = Math.min(this.h, Math.ceil(b.y + b.h + pad));
    const rw = x1 - x;
    const rh = y1 - y;
    if (rw <= 0 || rh <= 0) return;
    const ca = Math.round(parseColor(spec.color).a * 255);
    const t = Math.max(1, ca >> 1);
    const img = ctx.getImageData(x, y, rw, rh);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= t ? ca : 0;
    ctx.putImageData(img, x, y);
  }

  /** Paint `fill`'s gradient through the glyph coverage already on `ctx`:
   *  `source-in` replaces the colour everywhere the text is opaque while keeping
   *  its exact alpha. The gradient geometry is placed relative to the text's own
   *  bounds, so it rides along as the block grows or moves. */
  private fillTextGradient(
    ctx: CanvasRenderingContext2D,
    fill: TextFill,
    b: { x: number; y: number; w: number; h: number },
  ) {
    if (b.w < 1 || b.h < 1) return;
    const g = fill.gradient;
    const stops = g.reverse ? g.stops.map((s) => ({ color: s.color, pos: 1 - s.pos })) : g.stops;
    if (!stops.length) return;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rad = (g.angle * Math.PI) / 180;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    const scale = g.scale || 1;
    // Linear/reflected: span the bounds ALONG the gradient direction (the box's
    // support function), so scale 1 uses the full colour range whatever the
    // block's aspect — a vertical gradient on a wide, short line still ramps
    // top-to-bottom. Radial/angle keep the corner-reaching diagonal radius.
    const halfLinear = Math.max(
      1,
      scale * ((Math.abs(dir.x) * b.w) / 2 + (Math.abs(dir.y) * b.h) / 2),
    );
    const halfRadial = Math.max(1, (scale * Math.hypot(b.w, b.h)) / 2);
    const radialish = g.type === "radial" || g.type === "angle";
    const half = radialish ? halfRadial : halfLinear;
    // Radial/angle grow from the centre; linear/reflected run through it.
    const start = radialish
      ? { x: cx, y: cy }
      : { x: cx - dir.x * half, y: cy - dir.y * half };
    const end = { x: cx + dir.x * half, y: cy + dir.y * half };
    ctx.save();
    ctx.globalCompositeOperation = "source-in"; // keep the glyph alpha, swap colour
    ctx.fillStyle = buildCanvasGradient(ctx, g.type, start, end, 0.5, stops, g.smooth);
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  /**
   * Texture-map the flat text (`src`, doc-sized) from its bounds `b` onto the
   * warp-deformed mesh, writing into `ctx`.
   *
   * The mesh is a grid of quads split into triangles, but it is resampled
   * PER-PIXEL rather than drawn as clipped `drawImage` calls: for every output
   * pixel inside a triangle, barycentric weights give the matching source point
   * and the source is bilinearly sampled there. Each output pixel is therefore
   * WRITTEN exactly once (never composited), which is what keeps the seams out —
   * the clip-and-overlap approach blended anti-aliased triangle edges twice
   * along the quad columns and split diagonals, leaving faint vertical/diagonal
   * lines through the glyphs.
   */
  private drawWarpedText(
    ctx: CanvasRenderingContext2D,
    src: HTMLCanvasElement,
    b: { x: number; y: number; w: number; h: number },
    warp: TextWarp,
  ) {
    if (b.w < 1 || b.h < 1) return;
    const sctx = src.getContext("2d");
    if (!sctx) return;
    const cols = 48;
    const rows = Math.max(8, Math.min(32, Math.round((b.h / b.w) * cols) || 8));
    const gw = cols + 1;
    const gh = rows + 1;
    // Grid corners: flat (source) and warped (dest), both in doc coords.
    const sxs = new Float64Array(gw * gh);
    const sys = new Float64Array(gw * gh);
    const dxs = new Float64Array(gw * gh);
    const dys = new Float64Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const u = i / cols;
        const v = j / rows;
        const k = j * gw + i;
        sxs[k] = b.x + u * b.w;
        sys[k] = b.y + v * b.h;
        const p = warpPoint(warp, u, v);
        dxs[k] = b.x + p.u * b.w;
        dys[k] = b.y + p.v * b.h;
      }
    }
    // Output region = the warped grid's bounds, clamped to the canvas.
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let k = 0; k < gw * gh; k++) {
      if (dxs[k] < bx0) bx0 = dxs[k];
      if (dxs[k] > bx1) bx1 = dxs[k];
      if (dys[k] < by0) by0 = dys[k];
      if (dys[k] > by1) by1 = dys[k];
    }
    const ox = Math.max(0, Math.floor(bx0) - 1);
    const oy = Math.max(0, Math.floor(by0) - 1);
    const ox1 = Math.min(this.w, Math.ceil(bx1) + 2);
    const oy1 = Math.min(this.h, Math.ceil(by1) + 2);
    const ow = ox1 - ox;
    const oh = oy1 - oy;
    if (ow <= 0 || oh <= 0) return;
    // Source pixels: only the flat text's own (padded) box, not the whole doc —
    // this runs per keystroke behind the live preview.
    const px0 = Math.max(0, Math.floor(b.x) - 2);
    const py0 = Math.max(0, Math.floor(b.y) - 2);
    const px1 = Math.min(this.w, Math.ceil(b.x + b.w) + 2);
    const py1 = Math.min(this.h, Math.ceil(b.y + b.h) + 2);
    const sw = px1 - px0;
    const sh = py1 - py0;
    if (sw <= 0 || sh <= 0) return;
    const sd = sctx.getImageData(px0, py0, sw, sh).data;
    const out = new ImageData(ow, oh);
    const od = out.data;

    // Rasterize one triangle: barycentric coverage → interpolated source point.
    const tri = (ka: number, kb: number, kc: number) => {
      const ax = dxs[ka];
      const ay = dys[ka];
      const bx = dxs[kb];
      const by = dys[kb];
      const cx = dxs[kc];
      const cy = dys[kc];
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(det) < 1e-12) return;
      const inv = 1 / det;
      const minX = Math.max(ox, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(ox1 - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(oy, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(oy1 - 1, Math.ceil(Math.max(ay, by, cy)));
      // Slightly generous coverage: neighbouring triangles may both claim an
      // edge pixel, but since each WRITES (never blends) the shared value is
      // effectively identical — overlap is harmless, gaps would not be.
      const EPS = -1e-3;
      for (let py = minY; py <= maxY; py++) {
        const fy = py + 0.5;
        for (let pxx = minX; pxx <= maxX; pxx++) {
          const fx = pxx + 0.5;
          const l1 = ((fx - ax) * (cy - ay) - (cx - ax) * (fy - ay)) * inv;
          if (l1 < EPS) continue;
          const l2 = ((bx - ax) * (fy - ay) - (fx - ax) * (by - ay)) * inv;
          if (l2 < EPS) continue;
          const l0 = 1 - l1 - l2;
          if (l0 < EPS) continue;
          const su = l0 * sxs[ka] + l1 * sxs[kb] + l2 * sxs[kc] - px0;
          const sv = l0 * sys[ka] + l1 * sys[kb] + l2 * sys[kc] - py0;
          this.sampleBilinear(sd, sw, sh, su - 0.5, sv - 0.5, od, ((py - oy) * ow + (pxx - ox)) * 4);
        }
      }
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k00 = j * gw + i;
        tri(k00, k00 + 1, k00 + gw + 1);
        tri(k00, k00 + gw + 1, k00 + gw);
      }
    }
    ctx.putImageData(out, ox, oy);
  }

  /** Premultiplied bilinear sample of the `sw`×`sh` RGBA buffer `sd` at (`sx`,
   *  `sy`), written (not blended) into `od` at byte offset `di`. Premultiplying
   *  keeps transparent neighbours from darkening soft edges. Samples fully
   *  outside the source leave the destination untouched. */
  private sampleBilinear(
    sd: Uint8ClampedArray,
    sw: number,
    sh: number,
    sx: number,
    sy: number,
    od: Uint8ClampedArray,
    di: number,
  ) {
    if (sx <= -1 || sx >= sw || sy <= -1 || sy >= sh) return;
    const x0f = Math.floor(sx);
    const y0f = Math.floor(sy);
    const fx = sx - x0f;
    const fy = sy - y0f;
    const x0 = x0f < 0 ? 0 : x0f >= sw ? sw - 1 : x0f;
    const y0 = y0f < 0 ? 0 : y0f >= sh ? sh - 1 : y0f;
    const x1 = x0f + 1 < 0 ? 0 : x0f + 1 >= sw ? sw - 1 : x0f + 1;
    const y1 = y0f + 1 < 0 ? 0 : y0f + 1 >= sh ? sh - 1 : y0f + 1;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const o00 = (y0 * sw + x0) * 4;
    const o10 = (y0 * sw + x1) * 4;
    const o01 = (y1 * sw + x0) * 4;
    const o11 = (y1 * sw + x1) * 4;
    const a00 = sd[o00 + 3];
    const a10 = sd[o10 + 3];
    const a01 = sd[o01 + 3];
    const a11 = sd[o11 + 3];
    const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
    od[di + 3] = Math.round(a);
    if (a <= 0) return;
    od[di] = Math.round(
      (sd[o00] * a00 * w00 + sd[o10] * a10 * w10 + sd[o01] * a01 * w01 + sd[o11] * a11 * w11) / a,
    );
    od[di + 1] = Math.round(
      (sd[o00 + 1] * a00 * w00 +
        sd[o10 + 1] * a10 * w10 +
        sd[o01 + 1] * a01 * w01 +
        sd[o11 + 1] * a11 * w11) / a,
    );
    od[di + 2] = Math.round(
      (sd[o00 + 2] * a00 * w00 +
        sd[o10 + 2] * a10 * w10 +
        sd[o01 + 2] * a01 * w01 +
        sd[o11 + 2] * a11 * w11) / a,
    );
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
    // Positive baseline raises, canvas y grows downward — hence minus. A shift
    // this far out is normally a few px inside a much taller line box, so the
    // reported text bounds (leading-based) still contain it; an extreme shift
    // can push glyphs past that box, which costs re-edit hit-test precision and
    // nothing else — the raster target is the whole document canvas.
    const baseline0 =
      spec.y + (leading - (ascent + descent)) / 2 + ascent - (spec.baseline ?? 0);
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
        // Positive baseline raises, and canvas y grows downward — hence minus.
        // The decorations below ride the same shifted baseline, so an underline
        // stays welded to its superscript rather than to the line.
        const sy = by - (st.baseline ?? 0);
        ctx.font = cssFontString(st, spec.axes);
        if ("letterSpacing" in ctx) lsCtx.letterSpacing = `${spec.tracking}px`;
        ctx.fillStyle = st.color;
        if (!seg.space && seg.text) ctx.fillText(seg.text, spec.x + seg.x, sy);
        if (st.underline || st.strike) {
          // Span to the next segment so justify-stretched gaps stay decorated.
          const next = line.segs[i + 1];
          const w = next ? next.x - seg.x : seg.width;
          if (w > 0) {
            const met = measure("Mg", st);
            const th = Math.max(1, st.fontSize / 16);
            if (st.underline) ctx.fillRect(spec.x + seg.x, sy + met.descent * 0.45, w, th);
            if (st.strike) ctx.fillRect(spec.x + seg.x, sy - met.ascent * 0.32, w, th);
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
    this.endAdjust();
    this.spongeOnMask = this.activeSurface(layerId) === "mask";
    const l = this.spongeOnMask ? this.masks.get(this.maskKeyOf(layerId))! : this.layer(layerId);
    this.sponging = true;
    this.spongeLayer = layerId;
    this.spongeOpts = { ...opts };
    this.spongeOrig = l.ctx.getImageData(0, 0, this.w, this.h);
    this.spongeCov = new Float32Array(this.w * this.h);
    this.spongeSelMask = null;
    if (clip && clip.length) {
      const mask = this.selectionMask(clip, clipAngle, clipPivot);
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
    this.emitChange();
  }

  moveSponge(rawX: number, rawY: number) {
    if (!this.sponging || !this.spongeOpts) return;
    this.spongeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.spongeOpts.smoothing / 100) * 0.85;
    this.spongeSmoothPt.x += (rawX - this.spongeSmoothPt.x) * alpha;
    this.spongeSmoothPt.y += (rawY - this.spongeSmoothPt.y) * alpha;
    this.spongeLineTo(this.spongeSmoothPt.x, this.spongeSmoothPt.y);
    this.emitChange();
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
      this.masks.get(this.maskKeyOf(this.spongeLayer))!.ctx.putImageData(new ImageData(out, iw, ih), ix, iy);
      this.deriveMaskAlpha(this.maskKeyOf(this.spongeLayer), { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.layer(this.spongeLayer).ctx.putImageData(new ImageData(out, iw, ih, { colorSpace: this.cs }), ix, iy);
    }
  }

  endSponge() {
    if (!this.sponging) return;
    this.spongeLineTo(this.spongeLastRaw.x, this.spongeLastRaw.y);
    const D = this.spongeDirty;
    const layerId = this.spongeLayer;
    if (D && layerId != null && this.spongeOrig) {
      const x = Math.max(0, D.x0);
      const y = Math.max(0, D.y0);
      const w = Math.min(this.w - 1, D.x1) - x + 1;
      const h = Math.min(this.h - 1, D.y1) - y + 1;
      if (w > 0 && h > 0) {
        const mid = this.spongeOnMask ? this.maskKeyOf(layerId) : layerId;
        const target = this.spongeOnMask ? this.masks.get(mid)! : this.layer(layerId);
        const before = this.subImage(this.spongeOrig, x, y, w, h);
        const after = target.ctx.getImageData(x, y, w, h);
        this.pushEntry(mid, { x, y, w, h }, before, after, "Sponge", undefined, this.spongeOnMask ? "mask" : "layer");
      }
    }
    this.sponging = false;
    this.spongeOnMask = false;
    this.spongeLayer = null;
    this.spongeOrig = null;
    this.spongeCov = null;
    this.spongeTip = null;
    this.spongeOpts = null;
    this.spongeDirty = null;
    this.spongeSelMask = null;
    this.wandSrc = null;
    this.emitChange();
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
    this.endAdjust();
    this.smudgeOnMask = this.activeSurface(layerId) === "mask";
    const l = this.smudgeOnMask ? this.masks.get(this.maskKeyOf(layerId))! : this.layer(layerId);
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
      const mask = this.selectionMask(clip, clipAngle, clipPivot);
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
    this.emitChange();
  }

  moveSmudge(rawX: number, rawY: number) {
    if (!this.smudging || !this.smudgeOpts) return;
    this.smudgeLastRaw = { x: rawX, y: rawY };
    const alpha = 1 - (this.smudgeOpts.smoothing / 100) * 0.85;
    this.smudgeSmoothPt.x += (rawX - this.smudgeSmoothPt.x) * alpha;
    this.smudgeSmoothPt.y += (rawY - this.smudgeSmoothPt.y) * alpha;
    this.smudgeLineTo(this.smudgeSmoothPt.x, this.smudgeSmoothPt.y);
    this.emitChange();
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
      const mid = this.maskKeyOf(this.smudgeLayer);
      this.masks.get(mid)!.ctx.putImageData(img, 0, 0, ix, iy, iw, ih);
      this.deriveMaskAlpha(mid, { x: ix, y: iy, w: iw, h: ih });
    } else {
      this.layer(this.smudgeLayer).ctx.putImageData(img, 0, 0, ix, iy, iw, ih);
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

  endSmudge() {
    if (!this.smudging) return;
    this.smudgeLineTo(this.smudgeLastRaw.x, this.smudgeLastRaw.y);
    const D = this.smudgeDirty;
    const layerId = this.smudgeLayer;
    if (D && layerId != null && this.smudgeOrig) {
      const x = Math.max(0, D.x0);
      const y = Math.max(0, D.y0);
      const w = Math.min(this.w - 1, D.x1) - x + 1;
      const h = Math.min(this.h - 1, D.y1) - y + 1;
      if (w > 0 && h > 0) {
        const mid = this.smudgeOnMask ? this.maskKeyOf(layerId) : layerId;
        const target = this.smudgeOnMask ? this.masks.get(mid)! : this.layer(layerId);
        const before = this.subImage(this.smudgeOrig, x, y, w, h);
        const after = target.ctx.getImageData(x, y, w, h);
        this.pushEntry(
          mid,
          { x, y, w, h },
          before,
          after,
          this.smudgeMix ? "Mixer Brush" : "Smudge",
          undefined,
          this.smudgeOnMask ? "mask" : "layer",
        );
      }
    }
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
    const dirty = this.dirtyRect();
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

    const key = this.nodeKey(node);
    let prod = this.liveProduct;
    if (!prod || prod.c.width !== this.w || prod.c.height !== this.h) {
      prod = this.liveProduct = { ...this.mk(this.w, this.h), id: "", key: "" };
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

    const sub = this.regionBuf(0, inn.w, inn.h, true);
    sub.ctx.drawImage(src, inn.x, inn.y, inn.w, inn.h, 0, 0, inn.w, inn.h);
    const fmFull = this.filterMaskAlpha(node);
    let fmBuf: Layer | null = null;
    if (fmFull) {
      fmBuf = this.regionBuf(1, inn.w, inn.h, true);
      fmBuf.ctx.drawImage(fmFull, inn.x, inn.y, inn.w, inn.h, 0, 0, inn.w, inn.h);
    }
    const cur = this.filterStack(
      sub,
      node.filters!,
      fmBuf ? () => fmBuf!.ctx.getImageData(0, 0, inn.w, inn.h).data : null,
      inn.w,
      inn.h,
    );
    sub.ctx.putImageData(cur, 0, 0);

    // REPLACE, never blend: the region carries its own alpha.
    prod.ctx.globalAlpha = 1;
    prod.ctx.globalCompositeOperation = "source-over";
    prod.ctx.clearRect(out.x, out.y, out.w, out.h);
    prod.ctx.drawImage(sub.c, out.x - inn.x, out.y - inn.y, out.w, out.h, out.x, out.y, out.w, out.h);
    this.liveRegionHits++;
    this.liveRegionPx += inn.w * inn.h;
    return prod.c;
  }

  /** A reusable scratch canvas at least `w`×`h`, cleared over that rect. Only
   *  the top-left `w`×`h` is ever read, so growing it in place is safe. */
  private regionBuf(slot: number, w: number, h: number, readFreq: boolean): Layer {
    let b = this.regionBufs[slot];
    if (!b || b.c.width < w || b.c.height < h) {
      // Round the allocation up in blocks. The region grows a little on EVERY
      // frame of a stroke, so an exact fit would reallocate every frame — the
      // per-frame allocation this pool exists to avoid. Blocks make it O(log n)
      // reallocations per stroke instead, at the cost of some slack that is
      // never read (only the top-left w×h ever is).
      const blk = (v: number) => Math.ceil(v / 256) * 256;
      b = this.mk(blk(Math.max(w, b?.c.width ?? 0)), blk(Math.max(h, b?.c.height ?? 0)), readFreq);
      this.regionBufs[slot] = b;
    }
    b.ctx.globalAlpha = 1;
    b.ctx.globalCompositeOperation = "source-over";
    b.ctx.clearRect(0, 0, w, h);
    return b;
  }

  /** Working scale for live filter frames: enough of a reduction to keep the
   *  pass under a per-frame pixel budget, never below a quarter (past that the
   *  preview stops resembling the result). 1 = compute at full size. */
  private draftScale(): number {
    const px = this.w * this.h;
    if (px <= PaintEngine.DRAFT_MAX_PIXELS) return 1;
    return Math.max(0.25, Math.sqrt(PaintEngine.DRAFT_MAX_PIXELS / px));
  }

  /** Pixel budget for one live filter frame. A gaussian blur runs at roughly
   *  100 MP/s here, so ~0.5 MP keeps a frame near 5 ms rather than 200. */
  private static DRAFT_MAX_PIXELS = 500_000;

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
    this.draftPainted = true; // the settled frame must repaint the whole view
    const sw = Math.max(1, Math.round(this.w * scale));
    const sh = Math.max(1, Math.round(this.h * scale));

    // Downscale the source (GPU) — the readback below is then ¼-or-less the work.
    const small = this.mk(sw, sh, true);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = "low"; // a draft frame; "high" costs more than it shows
    small.ctx.drawImage(src, 0, 0, sw, sh);

    let cur = small.ctx.getImageData(0, 0, sw, sh);
    const fmFull = this.filterMaskAlpha(node);
    let base: ImageData | null = null;
    let maskData: Uint8ClampedArray | null = null;
    if (fmFull) {
      base = new ImageData(new Uint8ClampedArray(cur.data), sw, sh);
      const m = this.mk(sw, sh, true);
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
      const tmp = this.mk(sw, sh);
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

    const out = this.mk(this.w, this.h);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = "high"; // the upscale IS what the user sees
    out.ctx.drawImage(small.c, 0, 0, sw, sh, 0, 0, this.w, this.h);
    return out.c;
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
      this.texDab = this.mk(Math.max(w, 8), Math.max(h, 8), true);
      this.texPatch = this.mk(Math.max(w, 8), Math.max(h, 8), true);
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
    // `target` is an ITEMS index (0 = the original document) — node + 1.
    const node = Math.max(ROOT, Math.min(this.entries.length - 1, target - 1));
    // Walk to the states' common ancestor and back down the other side. For a
    // linear history that is exactly the old two loops; for a branched one it
    // is what lets you jump between branches without replaying the whole tree.
    const { revert, apply } = transition(this.parents(), this.cur, node);
    for (const k of revert) {
      const e = this.entries[k];
      this.revert(e);
      e.side?.undo();
    }
    for (const k of apply) {
      const e = this.entries[k];
      e.side?.redo();
      this.apply(e);
    }
    this.cur = node;
    this.emitHistory();
    this.emitChange();
  }
  undo() {
    if (this.cur >= 0) this.jumpTo(this.entries[this.cur].parent + 1);
  }
  redo() {
    // With branches, "forward" is the most recently created continuation of
    // where you are — the branch you were last working on.
    const next = newestChild(this.parents(), this.cur);
    if (next >= 0) this.jumpTo(next + 1);
  }
  /** Photoshop's History Options ▸ Allow Non-Linear History. Turning it OFF
   *  prunes the branches you are not on, since they can no longer be reached. */
  setNonLinearHistory(on: boolean) {
    if (this.nonLinear === on) return;
    this.nonLinear = on;
    if (!on) {
      const stale = offPath(this.parents(), this.cur);
      if (stale.length) this.dropNodes(stale);
    }
    this.emitHistory();
  }
  syncHistory() {
    this.emitHistory();
  }
  private emitHistory() {
    // Any history change means layer pixels changed → wand source is stale.
    this.wandSrc = null;
    this.historySourceIndex = Math.max(0, Math.min(this.entries.length, this.historySourceIndex));
    const parents = this.parents();
    const live = new Set(ancestry(parents, this.cur));
    this.onHistory({
      items: [
        { label: "New", onPath: true }, // the original state is on every path
        ...this.entries.map((e, i) => ({ label: e.label, onPath: live.has(i) })),
      ],
      index: this.pos,
      nonLinear: this.nonLinear,
      bytes: this.historyBytes(),
      sourceIndex: this.historySourceIndex,
      snapshots: this.snapshots.map((s) => ({ id: s.id, label: s.label })),
      sourceSnapshotId: this.historySourceSnap,
    });
  }

  /** Point the History brush at a history state (0 = the original document). */
  setHistorySourceIndex(index: number) {
    this.historySourceIndex = Math.max(0, Math.min(this.entries.length, Math.round(index)));
    this.historySourceSnap = null; // a step and a snapshot are mutually exclusive
    this.emitHistory();
  }

  // ---- Snapshots (TODO §10) ------------------------------------------------
  /** Pin the current pixels of `ownLayerIds` (+ their masks + the doc size) as a
   *  named snapshot. Returns its id. Costs one full copy of those layers. */
  createSnapshot(label: string, ownLayerIds: string[]): string {
    const base = this.cropSnapshot(ownLayerIds); // same capture the crop path uses
    const id = `snap-${Date.now().toString(36)}-${(this.snapSeq += 1)}`;
    this.snapshots.push({ ...base, id, label: label.trim() || `Snapshot ${this.snapshots.length + 1}` });
    this.emitHistory();
    return id;
  }

  getSnapshot(id: string): DocSnapshot | null {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  deleteSnapshot(id: string): void {
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    if (this.historySourceSnap === id) this.historySourceSnap = null;
    this.emitHistory();
  }

  /** Restore a snapshot's PIXELS + document size (the caller restores the layer
   *  tree and journals the step — mirrors how crop undo/redo is wired). */
  restoreSnapshot(id: string): boolean {
    const snap = this.getSnapshot(id);
    if (!snap) return false;
    this.cropRestore(snap);
    return true;
  }

  /** Point the History brush at a snapshot (null = back to a history step). */
  setHistorySourceSnapshot(id: string | null): void {
    this.historySourceSnap = id && this.getSnapshot(id) ? id : null;
    this.emitHistory();
  }

  /** Reconstruct one layer's pixels AT a history state, by replaying only that
   *  layer's pixel patches between the current position and `index` onto a copy
   *  of its live canvas — non-destructive and O(patches for this layer). Mask-
   *  surface and purely-structural entries are skipped (documented: sourcing
   *  across a canvas-size change or a layer's own creation is approximate). */
  /** A doc-sized copy of `layerId`'s pixels as captured in snapshot `snapId`.
   *  A layer missing from the snapshot (created later) yields a TRANSPARENT
   *  source — which is what it looked like then, so the brush erases it back.
   *  A snapshot from a differently-sized document is drawn top-left aligned. */
  private snapshotLayer(snapId: string, layerId: string): Layer {
    const out = this.mk(this.w, this.h, true);
    const snap = this.getSnapshot(snapId);
    const hit = snap?.layers.find((l) => l.id === layerId);
    if (hit) out.ctx.drawImage(hit.c, 0, 0);
    return out;
  }

  private reconstructLayerAt(layerId: string, index: number): Layer {
    const snap = this.mk(this.w, this.h, true);
    snap.ctx.drawImage(this.layer(layerId).c, 0, 0);
    // Same walk `jumpTo` uses, but replaying only this layer's patches onto a
    // scratch copy — so a source state on ANOTHER branch reconstructs correctly
    // instead of replaying an index range that no longer describes a path.
    const node = Math.max(ROOT, Math.min(this.entries.length - 1, index - 1));
    const { revert, apply } = transition(this.parents(), this.cur, node);
    for (const k of revert) {
      const e = this.entries[k];
      if (e.layerId === layerId && e.surface !== "mask" && e.before && e.rect) {
        snap.ctx.putImageData(e.before, e.rect.x, e.rect.y);
      }
    }
    for (const k of apply) {
      const e = this.entries[k];
      if (e.layerId === layerId && e.surface !== "mask" && e.after && e.rect) {
        snap.ctx.putImageData(e.after, e.rect.x, e.rect.y);
      }
    }
    return snap;
  }
}
