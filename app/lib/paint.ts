import { parseColor, toHex8 } from "./color";
import type { DualTipSettings, ScatterSettings, TextureSettings, TipShapeSettings } from "./brush-tip";
import type { MixerSettings } from "./mixer";
import type { Rect } from "./view";
import { blendOp, clipGroupsOf, filterMaskKey, findNode, type ClipGroup } from "./layers";
import type { ActiveSurface, LayerAdjustment, LayerGroup, LayerLeaf, LayerNode } from "./layers";
import { applyAdjustments, applyAdjustments16, isDefaultAdjust, type Adjustments } from "./adjust";
import { applyExtraAdjustment, extraIsDefault, isExtraSpec, type ExtraAdjustment } from "./adjust-extra";
import { removeRedEyeInPlace } from "./redeye";
import { renderShape, type ShapeGeom } from "./shapes";

import {
  blendIfActive,
  buildLut,
  channelValue,
  rangeActive,
  type BlendIf,
} from "./blendif";
import { DocumentScoped, DocumentState, type Entry, type Layer } from "./doc-state";
import { EngineBlurGallery } from "./engine/blur-gallery";
import { checkAllocation, makeCanvas } from "./engine/canvas";
import { EngineHeal } from "./engine/heal";
import { EngineHistory } from "./engine/history";
import { EngineMasks } from "./engine/masks";
import { EngineRetouch } from "./engine/retouch";
import { EngineSelection } from "./engine/selection";
import { EngineSmartFilters } from "./engine/smart-filters";
import { EngineStroke } from "./engine/stroke";
import { ROOT } from "./history-tree";
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
import { filterStackHash, hasEnabledFilters, type SmartFilter } from "./filters";
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
import type { RefineEdge } from "./refine-edge";
import type { SavedSelectionMask } from "./project";
import type { SelectionMask } from "./selection-mask";
import type { ModifyOp } from "./select-modify";
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
import { buildCanvasGradient, gradientGeometry } from "./gradient";
import { flattenPath, layoutTextOnPath, type PathTextSpec } from "./textpath";
import type { PatternPlacement } from "./patterns";
import { parsePath } from "./svgpath";
import { solveHomography } from "./homography";
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
// brushDynamics moved to engine/stroke.ts (TODO 1.6); OptionsBar imports it from here.
export { brushDynamics } from "./engine/stroke";

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
export interface Bounds {
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
  /** A live fill or pen path is on the canvas, not yet a step (it becomes one
   *  as it ends): Undo has something to take. */
  open: boolean;
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
    /** A colour, or a tile to repeat — see the implementation. */
    colorHex: string | PatternFill,
    angle?: number,
    pivot?: { x: number; y: number } | null,
  ) => void;
  eraseSelection: (
    layerId: string,
    rects: Rect[],
    angle?: number,
    pivot?: { x: number; y: number } | null,
    label?: string,
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
  /** `commit` false abandons the stroke: pixels back, no history step. */
  endBlur: (commit?: boolean) => void;
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
  endSmudge: (commit?: boolean) => void;
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
  endSponge: (commit?: boolean) => void;
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
  /** Select ▸ Feather: the selection's coverage blurred by `px` (soft, unrotated). */
  featherSelection: (rects: Rect[], angle: number, pivot: { x: number; y: number } | null, px: number) => Rect[];
  /** Refine Edge baked into the selection it was made for (soft, unrotated). */
  refineSelection: (rects: Rect[], angle: number, pivot: { x: number; y: number } | null, r: RefineEdge) => Rect[];
  /** Select ▸ Grow on a soft selection (square kernel); null for a hard one. */
  growSoftSelection: (rects: Rect[], px: number) => Rect[] | null;
  /** The outline moved by (dx, dy), its soft coverage moved with it. */
  shiftSelection: (rects: Rect[], dx: number, dy: number) => Rect[];
  /** `to` is `from` resized between two boxes: carry `from`'s coverage over. */
  carryResizedSelection: (from: Rect[], to: Rect[], fromBox: Rect, toBox: Rect) => void;
  /** The selection's coverage as a canvas the caller may keep. */
  selectionCoverageCanvas: (rects: Rect[], angle: number, pivot: { x: number; y: number } | null) => HTMLCanvasElement;
  /** How far a feathered selection's soft edge reaches, for the ants (0 = unknown / hard). */
  selectionSoftness: (rects: Rect[]) => number;
  /** The selection's outline (the ants' path), traced once and cached. */
  selectionOutline: (rects: Rect[]) => Seg[];
  /** Under 50% everywhere: its outline marks half its peak strength. */
  isFaintSelection: (rects: Rect[]) => boolean;
  /** A soft selection's coverage as a PNG over its bounds (null when hard). */
  selectionMaskImage: (rects: Rect[]) => SavedSelectionMask | null;
  /** Restore a saved soft selection's coverage behind its rects. */
  adoptSelectionMask: (
    rects: Rect[],
    at: { x: number; y: number; softness?: number },
    source: CanvasImageSource & { width: number; height: number },
  ) => void;
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
  /** Does this selection carry partial coverage beyond its ≥50% rects? */
  isSoftSelection: (rects: Rect[]) => boolean;
  /** Combine selections keeping soft coverage; null when neither is soft. */
  combineSelectionSoft: (
    a: Rect[],
    b: Rect[] | null,
    op: "add" | "subtract" | "intersect" | "invert",
  ) => Rect[] | null;
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
  /** Let go of a closed document: its rasters, caches and history. */
  closeDocument: (docId: string) => void;
  /** Composite any open document at its own size, without bringing it
   *  forward (null if the engine has never held it). */
  compositeDocument: (docId: string, tree: LayerNode[]) => HTMLCanvasElement | null;
  /** Finish edits that live in the canvas UI rather than the engine (a text
   *  session) — call BEFORE the active document changes, so they land in it. */
  commitPendingEdits: () => void;
  /** Any open document's history labels + position (for writing its file). */
  historyOf: (docId: string) => { labels: string[]; index: number } | null;
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

// The canvas allocator moved to engine/canvas.ts (TODO 1.6); its failure report
// is still set from here.
export { resetCanvasFailureReport, setCanvasFailureHandler } from "./engine/canvas";

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
  /** Set along a path, one placement per glyph, instead of on lines. Takes
   *  precedence over `runs`/`align`, which describe a block that has lines. */
  onPath?: PathTextSpec;
}

/** A tile to repeat, and where it sits, for `fillSelection`. */
export interface PatternFill {
  tile: CanvasImageSource;
  width: number;
  height: number;
  placement: PatternPlacement;
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

export class PaintEngine extends DocumentScoped {
  // Each open document's size, rasters, id-keyed caches and history live in its
  // own DocumentState; the engine works on the one in front (`this.doc`), which
  // every `this.layers` / `this.w` below reads through. See doc-state.ts.
  private view: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private stroke: Layer | null = null;
  private scratch: Layer | null = null;

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
    for (const d of this.everyDoc()) {
      for (const [id, l] of d.layers) add(`layer:${id}`, l.c);
      for (const [id, m] of d.masks) add(`mask:${id}`, m.c);
      for (const [id, v] of d.vectorMaskCache) add(`vmask:${id}`, v.c);
    }
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
  /** Document-level lighting angle shared by effects that opt in. */
  private globalLight: GlobalLight = { ...DEFAULT_GLOBAL_LIGHT };
  private ws: WorkingSpace = "srgb"; // working space (adjustment math)
  // Soft proofing (VIEW-only): simulate the target space / mark its gamut.
  private proofTarget: ProofTarget = "srgb";
  private proofSimulate = false;
  private gamutWarn = false;

  // --- Layer masks (non-destructive) -----------------------------------------
  // Grayscale mask per layer id (R=G=B=value), in the document's `masks`;
  // absent ⇒ no mask. Colour-agnostic (always sRGB) — never gamut-converted —
  // and editable by the brush pipeline. Its derived alpha (`maskAlpha`: RGB=0,
  // A = R × maskAlpha/255, so eraser strokes read right) is recomputed only on
  // mask mutation, scoped to the changed rect — never per composite frame.

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
  // The document's monotonic per-layer pixel version (bumped on any committed
  // pixel write) and per-id mask version (bumped on any mask mutation), plus its
  // epoch (`docEpoch`, bumped on resize/crop/transform/colour-space) — the key
  // ingredients.
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
    /** Worker renders still in flight (filters, heal, blur). A harness waits for
     *  0 before comparing pixels: a stale or draft product draws while a job is
     *  out, and a fixed sleep cannot know how long a slow machine takes. */
    workerJobs: number;
    /** Smart-filter products that came back from the worker and were stored.
     *  Proves a worker-vs-inline comparison really had a worker side. */
    filterWorkerResults: number;
  } {
    let tiles = 0;
    for (const t of this.tiledAdj.values()) for (const tile of t.tiles) if (tile) tiles++;
    return {
      regionHits: this.regionHits,
      regionPx: this.regionPx,
      liveRegionHits: this.liveRegionHits,
      liveRegionPx: this.liveRegionPx,
      liveDraftFrames: this.liveDraftFrames,
      workerJobs: this.filterPending.size + this.healPending.size + this.blurPending.size,
      filterWorkerResults: this.filterWorkerResults,
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

  /** Finish whatever live session is open, so its commit lands in the history
   *  of the document it was started in. */
  private endLiveSessions(): void {
    this.endLive();
    // A pending paste / transform is committed like before any other operation;
    // left floating, it would draw over the next tab and commit into its history.
    if (this.isFloating) this.commitFloat();
  }

  /**
   * Bring `docId` to the front: undo/redo/History, painting and compositing all
   * act on it from here, each document with its own rasters, caches and
   * history (with one undo stack between tabs, Ctrl+Z in an untouched tab once
   * undid another tab's last edit, off-screen). Call this BEFORE anything
   * journals into the newly active document; a document seen for the first
   * time is then sized by `setDoc`.
   */
  setDocument(docId: string): void {
    if (docId === this.docId) return;
    if (this.docId !== null) this.endLiveSessions(); // they belong to the tab being left
    const known = this.docs.get(docId);
    if (known) this.doc = known;
    // With no document named yet, the first one adopts what is already here.
    else if (this.docId !== null) this.doc = new DocumentState();
    this.docs.set(docId, this.doc);
    this.docId = docId;
    this.wandSrc = null;
    this.fitOpBuffers();
    this.trimHistory();
    this.emitHistory();
  }

  /** The operation buffers are shared, and sized to the document in front. */
  private fitOpBuffers(): void {
    const fits = (l: Layer | null) => !l || (l.c.width === this.w && l.c.height === this.h);
    if (!fits(this.stroke)) this.stroke = this.w && this.h ? makeCanvas(this.w, this.h) : null;
    if (!fits(this.scratch)) this.scratch = this.w && this.h ? this.mk(this.w, this.h) : null;
  }

  /**
   * Let go of a closed document: its rasters, caches, history and snapshots go
   * with its DocumentState, and its products leave the shared caches. Closing
   * used to have to find each canvas by id — and missed some (TODO 1.2).
   */
  closeDocument(docId: string): void {
    const d = this.docFor(docId);
    if (!d) return;
    if (d === this.doc) this.endLiveSessions();
    for (const id of d.sharedIds) this.dropShared(id);
    this.docs.delete(docId);
    if (d === this.doc) {
      // Nothing is in front until the editor brings the next tab forward.
      this.doc = new DocumentState();
      this.docId = null;
      this.emitHistory();
    }
  }

  /** Note that the document in front put `id` in a shared cache. */
  private noteShared(id: string): void {
    this.doc.sharedIds.add(id);
  }

  /** Take `id` out of every cache the documents share. */
  private dropShared(id: string): void {
    this.dropCache(id);
    this.filteredCache.delete(id);
    this.filterPending.delete(id);
    this.adjMeta.delete(id);
  }

  /**
   * Composite any open document — the one in front or one in the background —
   * at its own size, without bringing it forward. `tree` is that document's
   * layer tree. Null when the engine has never held the document (a restored
   * tab nobody has opened has no pixels here yet).
   */
  compositeDocument(docId: string, tree: LayerNode[]): HTMLCanvasElement | null {
    const d = this.docFor(docId);
    if (!d || !d.w || !d.h) return null;
    return this.withDocument(d, () => this.exportComposite(tree));
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
  // When set, adjustments only affect this (possibly rotated) selection region.
  private adjSel: Rect[] | null = null;
  private adjSelAngle = 0;
  private adjSelPivot: { x: number; y: number } | null = null;
  // Whether scaled float content is interpolated (smooth) or nearest-neighbour.
  private floatSmooth = true;

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
    // Every document's pixels are re-encoded below, not just this one's.
    for (const d of this.everyDoc()) if (d !== this.doc) d.epoch++;
    this.ws = ws;
    this.cs = nextCanvas;
    if (canvasChanged) {
      if (this.scratch) this.scratch = this.mk(this.w, this.h);
      // drawImage converts each layer's pixels from the old space into the new
      // one — in every open document, since the working space is the session's.
      // Each at its own size: the background tabs' are not this one's.
      for (const d of this.everyDoc()) {
        for (const [id, l] of d.layers) {
          const next = this.mk(l.c.width, l.c.height, true);
          next.ctx.drawImage(l.c, 0, 0);
          d.layers.set(id, next);
        }
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

  // ---- masks ----
  // Layer, filter and quick masks and the saved channels, the alpha each
  // derives, which surface a paint op edits, and a mask's lifecycle:
  // engine/masks.ts. These are its doors.
  private readonly masking = new EngineMasks(this.cursor, {
    bumpMask: (id, rect) => this.bumpMask(id, rect),
    emitChange: () => this.emitChange(),
    layer: (id) => this.layer(id),
    selectionMask: (rects, angle, pivot) => this.selectionMask(rects, angle, pivot),
    selectionFromCoverage: (at) => this.selectionFromCoverage(at),
    maskStrokeLayer: () => (this.painting && this.strokeOnMask && this.stroke && this.strokeLayer) || null,
    drawStroke: (ctx) => this.drawStroke(ctx),
    dirtyRect: () => this.dirtyRect(),
  });
  /** The quick mask's key while it is on — the render graph skips it. */
  private get qmKey(): string | null {
    return this.masking.qmKey;
  }
  /** Mask view: the composite shows this mask's grayscale instead. */
  private get maskView(): EngineMasks["maskView"] {
    return this.masking.maskView;
  }
  /** The mask brush's live grayscale, which mask view previews through too. */
  private get maskPrevG(): Layer | null {
    return this.masking.maskPrevG;
  }
  private set maskPrevG(v: Layer | null) {
    this.masking.maskPrevG = v;
  }
  private mkMask(readFreq = true): Layer {
    return this.masking.mkMask(readFreq);
  }
  private activeSurface(id: string): "pixels" | "mask" {
    return this.masking.activeSurface(id);
  }
  private maskKeyOf(id: string): string {
    return this.masking.maskKeyOf(id);
  }
  private deriveMaskAlpha(id: string, rect?: Rect): void {
    this.masking.deriveMaskAlpha(id, rect);
  }
  private maskDisplay(id: string): HTMLCanvasElement | null {
    return this.masking.maskDisplay(id);
  }
  private transformMasks(
    ids: string[] | undefined,
    fn: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void,
  ): void {
    this.masking.transformMasks(ids, fn);
  }
  getActiveSurface(id: string): ActiveSurface {
    return this.masking.getActiveSurface(id);
  }
  setActiveSurface(id: string, surface: ActiveSurface): void {
    this.masking.setActiveSurface(id, surface);
  }
  hasMask(id: string): boolean {
    return this.masking.hasMask(id);
  }
  setMaskView(id: string | null, surface: "mask" | "filterMask" = "mask") {
    this.masking.setMaskView(id, surface);
  }
  maskHistogram(id: string, surface: "mask" | "filterMask" = "mask"): Uint32Array | null {
    return this.masking.maskHistogram(id, surface);
  }
  allocMask(
    id: string,
    init: "reveal" | "hide" | "selection",
    rects: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): void {
    this.masking.allocMask(id, init, rects, angle, pivot);
  }
  freeMask(id: string): void {
    this.masking.freeMask(id);
  }
  captureMask(id: string): ImageData | null {
    return this.masking.captureMask(id);
  }
  restoreMask(id: string, img: ImageData): void {
    this.masking.restoreMask(id, img);
  }
  applyMaskToLayer(id: string): void {
    this.masking.applyMaskToLayer(id);
  }
  offsetMask(id: string, dx: number, dy: number): void {
    this.masking.offsetMask(id, dx, dy);
  }
  getMaskImage(id: string): string | null {
    return this.masking.getMaskImage(id);
  }
  getMaskImageCanvas(id: string): HTMLCanvasElement | null {
    return this.masking.getMaskImageCanvas(id);
  }
  setMaskImage(id: string, source: CanvasImageSource): void {
    this.masking.setMaskImage(id, source);
  }
  maskPreviewURL(id: string, maxW = 48): string | null {
    return this.masking.maskPreviewURL(id, maxW);
  }
  maskSelectionRects(id: string): Rect[] {
    return this.masking.maskSelectionRects(id);
  }
  quickMaskActive(): boolean {
    return this.masking.quickMaskActive();
  }
  enterQuickMask(
    key: string,
    rects: Rect[] | null = null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): void {
    this.masking.enterQuickMask(key, rects, angle, pivot);
  }
  setQuickMask(key: string | null): void {
    this.masking.setQuickMask(key);
  }
  quickMaskRects(): Rect[] {
    return this.masking.quickMaskRects();
  }
  quickMaskCoverage(): HTMLCanvasElement | null {
    return this.masking.quickMaskCoverage();
  }

  // ---- selection ----
  // A selection's coverage and outline, the shape the other areas clip and
  // mask through, the operations on it and the tools that make one:
  // engine/selection.ts. These are its doors.
  private readonly selection = new EngineSelection(this.cursor, {
    mk: (w, h, readFreq) => this.mk(w, h, readFreq),
    cs: () => this.cs,
    viewContext: () => this.vctx,
  });
  /** The magic wand's cached source: dropped by any layer mutation. */
  private get wandSrc(): EngineSelection["wandSrc"] {
    return this.selection.wandSrc;
  }
  private set wandSrc(v: EngineSelection["wandSrc"]) {
    this.selection.wandSrc = v;
  }
  private selectionFromCoverage(at: (i: number) => number, softness?: number): Rect[] {
    return this.selection.selectionFromCoverage(at, softness);
  }
  private coverageOf(rects: Rect[] | null | undefined): SelectionMask | null {
    return this.selection.coverageOf(rects);
  }
  private clipTo(
    ctx: CanvasRenderingContext2D,
    rects: Rect[] | null,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    this.selection.clipTo(ctx, rects, angle, pivot);
  }
  private selectionMask(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
  ): HTMLCanvasElement {
    return this.selection.selectionMask(rects, angle, pivot);
  }
  private boundsOf(
    rects: Rect[],
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ): Rect | null {
    return this.selection.boundsOf(rects, angle, pivot);
  }
  isSoftSelection(rects: Rect[]): boolean {
    return this.selection.isSoftSelection(rects);
  }
  isFaintSelection(rects: Rect[]): boolean {
    return this.selection.isFaintSelection(rects);
  }
  selectionSoftness(rects: Rect[]): number {
    return this.selection.selectionSoftness(rects);
  }
  selectionOutline(rects: Rect[]): Seg[] {
    return this.selection.selectionOutline(rects);
  }
  selectionCoverageCanvas(rects: Rect[], angle: number, pivot: { x: number; y: number } | null): HTMLCanvasElement {
    return this.selection.selectionCoverageCanvas(rects, angle, pivot);
  }
  selectionMaskImage(rects: Rect[]): SavedSelectionMask | null {
    return this.selection.selectionMaskImage(rects);
  }
  adoptSelectionMask(
    rects: Rect[],
    at: { x: number; y: number; softness?: number },
    source: CanvasImageSource & { width: number; height: number },
  ): void {
    this.selection.adoptSelectionMask(rects, at, source);
  }
  combineSelectionSoft(
    a: Rect[],
    b: Rect[] | null,
    op: "add" | "subtract" | "intersect" | "invert",
  ): Rect[] | null {
    return this.selection.combineSelectionSoft(a, b, op);
  }
  featherSelection(rects: Rect[], angle: number, pivot: { x: number; y: number } | null, px: number): Rect[] {
    return this.selection.featherSelection(rects, angle, pivot, px);
  }
  refineSelection(rects: Rect[], angle: number, pivot: { x: number; y: number } | null, r: RefineEdge): Rect[] {
    return this.selection.refineSelection(rects, angle, pivot, r);
  }
  growSoftSelection(rects: Rect[], px: number): Rect[] | null {
    return this.selection.growSoftSelection(rects, px);
  }
  modifySelection(
    rects: Rect[],
    angle: number,
    pivot: { x: number; y: number } | null,
    op: ModifyOp,
    px: number,
  ): Rect[] {
    return this.selection.modifySelection(rects, angle, pivot, op, px);
  }
  shiftSelection(rects: Rect[], dx: number, dy: number): Rect[] {
    return this.selection.shiftSelection(rects, dx, dy);
  }
  carryResizedSelection(from: Rect[], to: Rect[], fromBox: Rect, toBox: Rect): void {
    this.selection.carryResizedSelection(from, to, fromBox, toBox);
  }
  magicWand(
    layerId: string,
    x: number,
    y: number,
    opts: { tolerance: number; contiguous: boolean; sampleAll: boolean },
    reuseSource = false,
    add: Rect[] | null = null, // existing selection to union with (Ctrl-add)
  ): WandSelection | null {
    return this.selection.magicWand(layerId, x, y, opts, reuseSource, add);
  }
  beginQuickSelect(
    layerId: string,
    opts: { tolerance: number; sampleAll: boolean },
    base: Rect[] | null,
    subtract: boolean,
  ): void {
    this.selection.beginQuickSelect(layerId, opts, base, subtract);
  }
  quickSelectDab(x: number, y: number, r: number): WandSelection | null {
    return this.selection.quickSelectDab(x, y, r);
  }
  endQuickSelect(): void {
    this.selection.endQuickSelect();
  }
  lassoSelect(points: { x: number; y: number }[]): WandSelection | null {
    return this.selection.lassoSelect(points);
  }
  combineSelection(base: Rect[], region: Rect[], mode: "add" | "subtract"): WandSelection | null {
    return this.selection.combineSelection(base, region, mode);
  }

  // Per-layer edit locks (the document's `layerLocks`) are enforced at the
  // pixel-commit chokepoint (pushEntry), kept in sync from the layer tree via
  // syncLayerLocks(). Position lock is a UI-level guard and isn't tracked.
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
    this.endLive(); // any other pixel op finalizes a live adjustment / shape / gradient / path / fill
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

  /** Fill the selection on a layer with a colour (records history). */
  fillSelection(
    layerId: string,
    rects: Rect[],
    /* A colour, or a tile to repeat. The PATTERN is built here rather than
       handed in ready-made: a CanvasPattern belongs to the context that created
       it, and the context that matters is the layer's, which only the engine
       has. The caller supplies the picture and where it sits. */
    colorHex: string | PatternFill,
    angle = 0,
    pivot: { x: number; y: number } | null = null,
  ) {
    const bounds = this.boundsOf(rects, angle, pivot); // a soft mask's bounds reach its whole edge
    if (!bounds) return;
    const onMask = this.activeSurface(layerId) === "mask";
    const mid = onMask ? this.maskKeyOf(layerId) : layerId; // history/derive key
    const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    if (this.coverageOf(rects)) {
      // Lay the colour down only where a soft mask is opaque (soft edges).
      const mask = this.selectionMask(rects, angle, pivot);
      const tmp = this.mk(this.w, this.h);
      tmp.ctx.fillStyle = PaintEngine.paintStyle(tmp.ctx, colorHex);
      tmp.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      tmp.ctx.globalCompositeOperation = "destination-in";
      tmp.ctx.drawImage(mask, 0, 0);
      l.ctx.drawImage(tmp.c, 0, 0);
    } else {
      l.ctx.save();
      this.clipTo(l.ctx, rects, angle, pivot);
      l.ctx.globalAlpha = 1;
      l.ctx.globalCompositeOperation = "source-over";
      l.ctx.fillStyle = PaintEngine.paintStyle(l.ctx, colorHex);
      l.ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
      l.ctx.restore();
    }
    const after = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    this.pushEntry(mid, bounds, before, after, "Fill", undefined, onMask ? "mask" : "layer");
    if (onMask) this.deriveMaskAlpha(mid, bounds);
    this.emitChange();
  }

  /**
   * A fill's paint: a colour string as-is, or a repeating tile.
   *
   * The transform is set on the PATTERN rather than on the context, so the
   * clip, the bounds and the history rectangle all stay in document
   * coordinates — transforming the context instead would move the rectangle
   * being filled as well as the paint inside it.
   */
  private static paintStyle(
    ctx: CanvasRenderingContext2D,
    fill: string | PatternFill,
  ): string | CanvasPattern {
    if (typeof fill === "string") return fill;
    const pat = ctx.createPattern(fill.tile, "repeat");
    if (!pat) return "#00000000";
    const p = fill.placement;
    const m = new DOMMatrix()
      .translate(p.offsetX * fill.width * p.scale, p.offsetY * fill.height * p.scale)
      .rotate((p.rotate * 180) / Math.PI)
      .scale(p.scale || 1);
    pat.setTransform(m);
    return pat;
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
   * `side` rides on that entry (the shape's box becoming the selection).
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
    side?: HistorySide,
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
      this.shapeEntry = { layerId, rect: b, before: this.shapeOrig!, after, label: "Shape", side, parent: ROOT };
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
    if (sel && sel.length && this.coverageOf(sel)) {
      // A soft selection fades the gradient in, like a feathered fill.
      const g = this.mk(this.w, this.h);
      g.ctx.fillStyle = buildCanvasGradient(g.ctx, type, start, end, midpoint, stops, smooth);
      g.ctx.fillRect(b.x, b.y, b.w, b.h);
      g.ctx.globalCompositeOperation = "destination-in";
      g.ctx.drawImage(this.selectionMask(sel, selAngle, selPivot), 0, 0);
      l.ctx.drawImage(g.c, 0, 0);
    } else {
      if (sel && sel.length) this.clipTo(l.ctx, sel, selAngle, selPivot);
      else {
        l.ctx.beginPath();
        l.ctx.rect(b.x, b.y, b.w, b.h);
        l.ctx.clip();
      }
      l.ctx.fillStyle = buildCanvasGradient(l.ctx, type, start, end, midpoint, stops, smooth);
      l.ctx.fillRect(b.x, b.y, b.w, b.h);
    }
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
      this.emitHistory(); // open: Undo has it to take
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
    if (this.openTold) this.emitHistory(); // closed with no step to say so (one anchor, a locked layer)
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
      this.emitHistory(false); // open: Undo has it to take
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
    if (this.openTold) this.emitHistory(false); // closed with no step to say so (an empty region)
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
  ) {
    const bounds = this.boundsOf(rects, angle, pivot);
    if (!bounds) return;
    const onMask = this.activeSurface(layerId) === "mask";
    const mid = onMask ? this.maskKeyOf(layerId) : layerId;
    const l = onMask ? this.masks.get(mid)! : this.layer(layerId);
    const before = l.ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    l.ctx.save();
    l.ctx.globalAlpha = 1;
    l.ctx.globalCompositeOperation = "destination-out";
    if (this.coverageOf(rects)) {
      // The soft mask's alpha removes the layer's alpha proportionally.
      l.ctx.drawImage(this.selectionMask(rects, angle, pivot), 0, 0);
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

  // ---- heal ----
  // Spot heal and content-aware fill, the region and coverage each heals, the
  // heal worker and the bake: engine/heal.ts. These are its doors.
  private readonly healing = new EngineHeal(this.cursor, {
    selectionMask: (rects, angle, pivot) => this.selectionMask(rects, angle, pivot),
    boundsOf: (rects, angle, pivot) => this.boundsOf(rects, angle, pivot),
    pushEntry: (layerId, rect, before, after, label) => this.pushEntry(layerId, rect, before, after, label),
    landInBackground: (d, layerId, rect, before, after, label) =>
      this.landInBackground(d, layerId, rect, before, after, label),
    bumpPixel: (id, rect) => this.bumpPixel(id, rect),
    emitChange: () => this.emitChange(),
    cs: () => this.cs,
    workersOn: () => this.workersOn,
  });
  /** The heals out to the worker (the stats count them as jobs). */
  private get healPending(): EngineHeal["healPending"] {
    return this.healing.healPending;
  }
  healSpots(
    layerId: string,
    pts: { x: number; y: number }[],
    size: number,
    hardness: number,
    sel: Rect[] | null = null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    this.healing.healSpots(layerId, pts, size, hardness, sel, selAngle, selPivot);
  }
  contentAwareFill(
    layerId: string,
    sel: Rect[],
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    this.healing.contentAwareFill(layerId, sel, selAngle, selPivot);
  }
  /** Red-eye clips its coverage the same way. */
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
    this.healing.clipCoverageToSelection(coverage, rx, ry, rw, rh, sel, selAngle, selPivot);
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
    this.vectorMaskCache.delete(id);
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

  /** Drop the raster of every vector mask in `tree` that is no longer active.
   *  renderNode does this for the layers it draws, but a HIDDEN layer is never
   *  drawn: a vector mask deleted while its layer was hidden kept a
   *  document-sized raster until the layer was shown again. */
  private pruneVectorMasks(tree: LayerNode[]): void {
    if (!this.vectorMaskCache.size) return;
    const walk = (nodes: LayerNode[]) => {
      for (const n of nodes) {
        if (!vectorMaskActive(n.vectorMask)) this.vectorMaskCache.delete(n.id);
        if (n.type === "group") walk(n.children);
      }
    };
    walk(tree);
  }

  /**
   * Commit a pixel patch to a document that is NOT in front: work it began that
   * finished after its tab was left (a heal back from the worker). Its own
   * layer, history and locks — and nothing on screen, which is showing another
   * document. Before documents had their own state, this journalled into
   * whichever tab was in front.
   */
  private landInBackground(
    d: DocumentState,
    layerId: string,
    rect: Rect,
    before: ImageData,
    after: ImageData,
    label: string,
  ): void {
    this.withDocument(d, () => {
      const lock = this.layerLocks.get(layerId);
      if (lock?.pixels) return;
      if (lock?.transparency) after = this.freezeAlpha(before, after);
      this.layer(layerId).ctx.putImageData(after, rect.x, rect.y);
      this.linkEntry({ layerId, rect, before, after, label });
      this.bumpPixel(layerId, rect);
    });
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
    const c = this.holderOf((d) => d.frameSrc, id);
    return c ? c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getFrameSourceImage` would encode — see above. */
  getFrameSourceImageCanvas(id: string): HTMLCanvasElement | null {
    return this.holderOf((d) => d.frameSrc, id) ?? null;
  }

  clearFrameSource(id: string) {
    this.frameSrc.delete(id);
  }

  /** A leaf layer's pixels as a PNG data URL (null if it has no canvas yet).
   *  Any open document's: a background tab is saved by id too. */
  getLayerImage(id: string): string | null {
    const l = this.holderOf((d) => d.layers, id);
    return l ? l.c.toDataURL("image/png") : null;
  }

  /** Exactly the canvas `getLayerImage` would encode — its OWN raster, not the
   *  doc-sized copy `getLayerCanvas` makes, so a caller that encodes this gets
   *  byte-identical output. Autosave hands these to a worker instead of
   *  encoding on the main thread; everything else uses the getters above. */
  getLayerImageCanvas(id: string): HTMLCanvasElement | null {
    return this.holderOf((d) => d.layers, id)?.c ?? null;
  }

  setGlobalLight(l: GlobalLight) {
    this.globalLight = l;
    this.clearRenderCaches();
    this.emitChange();
  }
  getGlobalLight(): GlobalLight {
    return this.globalLight;
  }

  /** A doc-sized COPY of a layer's raster as a canvas (blank if it has none
   *  yet — a fresh empty layer simply liquifies/reads as transparency). */
  getLayerCanvas(id: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    checkAllocation(c.getContext("2d"), this.w, this.h);
    const l = this.layers.get(id);
    if (l) c.getContext("2d")!.drawImage(l.c, 0, 0);
    return c;
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
    if (this.coverageOf(this.adjSel)) {
      // Soft selection: before·(1−m) + after·m — a true lerp, so a partly
      // transparent pixel blends as well as an opaque one does.
      const m = this.selectionMask(this.adjSel, this.adjSelAngle, this.adjSelPivot);
      tmp.ctx.globalCompositeOperation = "destination-in";
      tmp.ctx.drawImage(m, 0, 0);
      out.ctx.globalCompositeOperation = "destination-out";
      out.ctx.drawImage(m, 0, 0);
      out.ctx.globalCompositeOperation = "lighter";
      out.ctx.drawImage(tmp.c, 0, 0);
      out.ctx.globalCompositeOperation = "source-over";
      return out.ctx.getImageData(0, 0, this.w, this.h);
    }
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
    this.noteShared(id);
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
    // A deleted or disabled vector mask must not keep its document-sized
    // raster. Every render path skips vectorMaskAlpha once the mask is
    // inactive, so this is the one place that sees it go.
    if (this.vectorMaskCache.size && !vectorMaskActive(node.vectorMask))
      this.vectorMaskCache.delete(node.id);
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
        this.noteShared(id);
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
    const maskCanvas = sel?.length ? this.selectionMask(sel, selAngle, selPivot) : null;
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
    if (tree !== this.lastTree) this.pruneVectorMasks(tree);
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
    if (rects && rects.length && this.coverageOf(rects)) {
      // Soft lift: the float takes each pixel in proportion to its coverage,
      // and exactly the rest stays behind.
      this.moveSrc = this.boundsOf(rects);
      const m = this.selectionMask(rects, 0, null);
      this.moveFloat.ctx.drawImage(l.c, 0, 0);
      this.moveFloat.ctx.globalCompositeOperation = "destination-in";
      this.moveFloat.ctx.drawImage(m, 0, 0);
      this.moveFloat.ctx.globalCompositeOperation = "source-over";
      l.ctx.globalCompositeOperation = "destination-out";
      l.ctx.drawImage(m, 0, 0);
      l.ctx.globalCompositeOperation = "source-over";
    } else if (rects && rects.length) {
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
    // drops thin scanline rects, leaving stray pixel lines behind. A soft
    // selection softens the lifted (and removed) edges.
    const mask = this.selectionMask(rects, angle, pivot);
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
    if (rects && rects.length && this.coverageOf(rects)) {
      // A soft selection copies each pixel at its coverage.
      octx.drawImage(this.view, -bounds.x, -bounds.y);
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(this.selectionMask(rects, angle, pivot), -bounds.x, -bounds.y);
      octx.globalCompositeOperation = "source-over";
      return { canvas: out, x: bounds.x, y: bounds.y };
    }
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

  // ---- strokes ----
  // A brush or eraser stroke, its tips and dabs, the dirty region, the stroke
  // drawn through the selection, and the clone stamp: engine/stroke.ts. These
  // are its doors; its buffer stays here, remade with the document.
  private readonly stroking = new EngineStroke(this.cursor, {
    ensureOpBuffers: () => this.ensureOpBuffers(),
    strokeBuf: () => this.stroke,
    view: () => this.view,
    mk: (w, h, readFreq) => this.mk(w, h, readFreq),
    layer: (id) => this.layer(id),
    activeSurface: (id) => this.activeSurface(id),
    maskKeyOf: (id) => this.maskKeyOf(id),
    deriveMaskAlpha: (id, rect) => this.deriveMaskAlpha(id, rect),
    clipTo: (ctx, rects, angle, pivot) => this.clipTo(ctx, rects, angle, pivot),
    coverageOf: (rects) => this.coverageOf(rects),
    selectionMask: (rects, angle, pivot) => this.selectionMask(rects, angle, pivot),
    pushEntry: (layerId, rect, before, after, label, side, surface) =>
      this.pushEntry(layerId, rect, before, after, label, side, surface),
    dropLiveProduct: () => {
      this.liveProduct = null;
    },
    emitChange: () => this.emitChange(),
  });
  /** A stroke is live, on this layer, painting its mask: the compositor shows it. */
  private get painting(): boolean {
    return this.stroking.painting;
  }
  private get strokeLayer(): string | null {
    return this.stroking.strokeLayer;
  }
  private get strokeOnMask(): boolean {
    return this.stroking.strokeOnMask;
  }
  private dirtyRect() {
    return this.stroking.dirtyRect();
  }
  private drawStroke(ctx: CanvasRenderingContext2D) {
    this.stroking.drawStroke(ctx);
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
    this.stroking.beginStroke(layerId, brush, colorHex, x, y, mode, clip, clipAngle, clipPivot, label, pressure);
  }
  moveStroke(rawX: number, rawY: number, pressure = 1) {
    this.stroking.moveStroke(rawX, rawY, pressure);
  }
  endStroke() {
    this.stroking.endStroke();
  }
  cancelStroke() {
    this.stroking.cancelStroke();
  }
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
    this.stroking.beginClone(layerId, brush, x, y, offset, sampleAll, spacing, clip, clipAngle, clipPivot);
  }

  // ---- retouch brushes ----
  // The History brush, blur, dodge and burn, sponge, and smudge with the mixer:
  // engine/retouch.ts. These are its doors.
  private readonly retouching = new EngineRetouch(this.cursor, {
    layer: (id) => this.layer(id),
    activeSurface: (id) => this.activeSurface(id),
    maskKeyOf: (id) => this.maskKeyOf(id),
    deriveMaskAlpha: (id, rect) => this.deriveMaskAlpha(id, rect),
    selectionMask: (rects, angle, pivot) => this.selectionMask(rects, angle, pivot),
    reconstructLayerAt: (layerId, index) => this.reconstructLayerAt(layerId, index),
    snapshotLayer: (snapId, layerId) => this.snapshotLayer(snapId, layerId),
    endAdjust: () => this.endAdjust(),
    pushEntry: (layerId, rect, before, after, label, side, surface) =>
      this.pushEntry(layerId, rect, before, after, label, side, surface),
    dropWandSource: () => {
      this.wandSrc = null;
    },
    cs: () => this.cs,
    viewContext: () => this.vctx,
    emitChange: () => this.emitChange(),
  });
  /** A blur or dodge stroke is live on this layer: the render graph bypasses it. */
  private get blurring(): boolean {
    return this.retouching.blurring;
  }
  private get blurLayer(): string | null {
    return this.retouching.blurLayer;
  }
  private get dodging(): boolean {
    return this.retouching.dodging;
  }
  private get dodgeLayer(): string | null {
    return this.retouching.dodgeLayer;
  }
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
    this.retouching.beginHistory(layerId, brush, x, y, clip, clipAngle, clipPivot, label);
  }
  moveHistory(rawX: number, rawY: number) {
    this.retouching.moveHistory(rawX, rawY);
  }
  endHistory(commit = true) {
    this.retouching.endHistory(commit);
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
    this.retouching.beginBlur(layerId, blur, x, y, clip, clipAngle, clipPivot);
  }
  moveBlur(rawX: number, rawY: number) {
    this.retouching.moveBlur(rawX, rawY);
  }
  endBlur(commit = true) {
    this.retouching.endBlur(commit);
  }
  beginDodge(
    layerId: string,
    opts: DodgeSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    this.retouching.beginDodge(layerId, opts, x, y, clip, clipAngle, clipPivot);
  }
  moveDodge(rawX: number, rawY: number) {
    this.retouching.moveDodge(rawX, rawY);
  }
  endDodge(commit = true) {
    this.retouching.endDodge(commit);
  }
  beginSponge(
    layerId: string,
    opts: SpongeSettings,
    x: number,
    y: number,
    clip: Rect[] | null = null,
    clipAngle = 0,
    clipPivot: { x: number; y: number } | null = null,
  ) {
    this.retouching.beginSponge(layerId, opts, x, y, clip, clipAngle, clipPivot);
  }
  moveSponge(rawX: number, rawY: number) {
    this.retouching.moveSponge(rawX, rawY);
  }
  endSponge(commit = true) {
    this.retouching.endSponge(commit);
  }
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
    this.retouching.beginSmudge(layerId, opts, x, y, fingerColor, clip, clipAngle, clipPivot);
  }
  moveSmudge(rawX: number, rawY: number) {
    this.retouching.moveSmudge(rawX, rawY);
  }
  endSmudge(commit = true) {
    this.retouching.endSmudge(commit);
  }
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
    this.retouching.beginMixer(layerId, opts, x, y, fg, clip, clipAngle, clipPivot);
  }
  cleanMixer() {
    this.retouching.cleanMixer();
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
    /* Text on a path has no lines to measure, and its bounds are wherever the
       glyphs ended up — which the layout already knows. Taken from the
       placements rather than from the path's own box: a short word on a long
       curve occupies a fraction of it, and a box the size of the path would
       give the re-edit hit test a target far larger than the type, and the
       gradient fill a span the colours never reach the ends of. */
    if (spec.onPath) {
      const flat = flattenPath(parsePath(spec.onPath.d));
      const measure = this.richMeasurer(ctx, spec.tracking, spec.axes);
      const { glyphs } = layoutTextOnPath(
        spec.text,
        spec.runs,
        baseRunStyle(spec),
        flat,
        { ...spec.onPath, tracking: spec.tracking },
        measure,
      );
      if (!glyphs.length) return { x: spec.x, y: spec.y, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const g of glyphs) {
        const met = measure(g.ch, g.style);
        const cos = Math.cos(g.angle);
        const sin = Math.sin(g.angle);
        /* The glyph's own box, rotated: (0,-ascent)…(width,descent) in the
           glyph's frame, all four corners taken so a turned glyph is not
           measured by its unrotated extent. */
        for (const [lx, ly] of [
          [0, -met.ascent],
          [met.width, -met.ascent],
          [0, met.descent],
          [met.width, met.descent],
        ]) {
          const px = g.x + lx * cos - ly * sin;
          const py = g.y + lx * sin + ly * cos;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
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
      if (spec.onPath) this.drawPathText(target, spec, spec.onPath);
      else if (PaintEngine.isRichSpec(spec)) this.drawRichText(target, spec);
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
    /* The placement lives in gradient.ts, shared with SVG export: exporting
       vector text is only worth anything if the `<linearGradient>` lands on the
       same line the pixels ramp along, and two copies of this arithmetic would
       be two answers to that. */
    const { start, end } = gradientGeometry(g, b);
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
  /**
   * Text set along a path: one glyph, turned, at a time.
   *
   * The other two text paths hand canvas a whole string and let it advance the
   * pen. Here every character has its own origin and its own rotation, so the
   * loop does the advancing and canvas draws single characters — which is also
   * why kerning between adjacent glyphs is lost, and why that is stated in
   * FEATURES rather than left to be discovered. `layoutTextOnPath` decides all
   * the geometry; this function only turns placements into draw calls.
   */
  private drawPathText(
    ctx: CanvasRenderingContext2D,
    spec: TextRenderSpec,
    onPath: PathTextSpec,
  ) {
    const flat = flattenPath(parsePath(onPath.d));
    if (flat.pts.length < 2) return;
    const measure = this.richMeasurer(ctx, spec.tracking, spec.axes);
    const { glyphs } = layoutTextOnPath(
      spec.text,
      spec.runs,
      baseRunStyle(spec),
      flat,
      { ...onPath, tracking: spec.tracking },
      measure,
    );
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    for (const g of glyphs) {
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.font = cssFontString(g.style, spec.axes);
      ctx.fillStyle = g.style.color;
      /* The run's baseline shift is a lift off the BASELINE, which here is the
         rotated one — so it is applied inside the rotation, not before it. */
      ctx.fillText(g.ch, 0, -(g.style.baseline ?? 0));
      ctx.restore();
    }
  }

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

  // ---- Blur Gallery ----
  // Effects ▸ Blur Gallery: the session over the chosen layers, its worker, the
  // preview, the commit and the cancel: engine/blur-gallery.ts. These are its doors.
  private readonly blurGallery = new EngineBlurGallery(this.cursor, {
    layer: (id) => this.layer(id),
    bumpPixel: (id) => this.bumpPixel(id),
    emitChange: () => this.emitChange(),
    endLive: () => this.endLive(),
    selectionMask: (rects, angle, pivot) => this.selectionMask(rects, angle, pivot),
    pushStructural: (label, undo, redo) => this.pushStructural(label, undo, redo),
    dropWandSource: () => {
      this.wandSrc = null;
    },
    cs: () => this.cs,
    workersOn: () => this.workersOn,
  });
  /** The session live now (the render graph bypasses its layers), and its renders out. */
  private get blurFx(): EngineBlurGallery["blurFx"] {
    return this.blurGallery.blurFx;
  }
  private get blurPending(): EngineBlurGallery["blurPending"] {
    return this.blurGallery.blurPending;
  }
  beginBlurFx(
    ids: string[],
    sel: Rect[] | null,
    selAngle = 0,
    selPivot: { x: number; y: number } | null = null,
  ) {
    this.blurGallery.beginBlurFx(ids, sel, selAngle, selPivot);
  }
  previewBlurFx(
    kind: string,
    amount: number,
    angle: number,
    anchorX = 0.5,
    anchorY = 0.5,
    extra?: { band: number; feather: number; threshold: number },
  ) {
    this.blurGallery.previewBlurFx(kind, amount, angle, anchorX, anchorY, extra);
  }
  previewBlurFxAsync(
    kind: string,
    amount: number,
    angle: number,
    anchorX = 0.5,
    anchorY = 0.5,
    extra?: { band: number; feather: number; threshold: number },
  ): Promise<boolean> {
    return this.blurGallery.previewBlurFxAsync(kind, amount, angle, anchorX, anchorY, extra);
  }
  commitBlurFx(label: string) {
    this.blurGallery.commitBlurFx(label);
  }
  cancelBlurFx() {
    this.blurGallery.cancelBlurFx();
  }

  /** True while exportComposite runs: exports must never contain half-res
   *  preview or stale-param products, so anything but an exact full-quality
   *  cache hit computes synchronously at full resolution. */
  private exporting = false;

  // ---- smart filters ----
  // A node's filter stack, its product cache and worker, the half-res preview
  // and the live frames: engine/smart-filters.ts. These are its doors.
  private readonly smartFilters = new EngineSmartFilters(this.cursor, {
    mk: (w, h, readFreq) => this.mk(w, h, readFreq),
    cs: () => this.cs,
    nodeKey: (node) => this.nodeKey(node),
    noteShared: (id) => this.noteShared(id),
    clearRenderCaches: () => this.clearRenderCaches(),
    emitChange: () => this.emitChange(),
    maskDisplay: (id) => this.maskDisplay(id),
    renderFill: (node) => this.renderFill(node),
    leafDisplay: (id) => this.leafDisplay(id),
    curTree: () => this.curTree,
    liveBypass: () => this.liveBypass,
    renderCacheOn: () => this.renderCacheOn,
    exporting: () => this.exporting,
    workersOn: () => this.workersOn,
    painting: () => this.painting,
    strokeLayer: () => this.strokeLayer,
    strokeOnMask: () => this.strokeOnMask,
    dirtyRect: () => this.dirtyRect(),
    markDraftPainted: () => {
      this.draftPainted = true;
    },
  });
  /** The products and jobs every document shares; the counters the stats report. */
  private get filteredCache(): EngineSmartFilters["filteredCache"] {
    return this.smartFilters.filteredCache;
  }
  private get filterPending(): EngineSmartFilters["filterPending"] {
    return this.smartFilters.filterPending;
  }
  private get filterWorkerResults(): number {
    return this.smartFilters.filterWorkerResults;
  }
  private get liveRegionHits(): number {
    return this.smartFilters.liveRegionHits;
  }
  private get liveRegionPx(): number {
    return this.smartFilters.liveRegionPx;
  }
  private get liveDraftFrames(): number {
    return this.smartFilters.liveDraftFrames;
  }
  /** The per-stroke product, dropped as a stroke ends. */
  private get liveProduct(): EngineSmartFilters["liveProduct"] {
    return this.smartFilters.liveProduct;
  }
  private set liveProduct(v: EngineSmartFilters["liveProduct"]) {
    this.smartFilters.liveProduct = v;
  }
  setLiveRegionEnabled(on: boolean) {
    this.smartFilters.setLiveRegionEnabled(on);
  }
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
    return this.smartFilters.compareFilterProduct(id);
  }
  draftScale(): number {
    return this.smartFilters.draftScale();
  }
  private filteredProduct(node: LayerNode, src: HTMLCanvasElement): HTMLCanvasElement {
    return this.smartFilters.filteredProduct(node, src);
  }
  private renderFiltered(
    src: HTMLCanvasElement,
    filters: SmartFilter[],
    fmAlpha: HTMLCanvasElement | null = null,
  ): HTMLCanvasElement {
    return this.smartFilters.renderFiltered(src, filters, fmAlpha);
  }

  // ---- history ----
  // Each document's undo tree, the caps that bound it, what the History panel
  // is told, the History brush's source and the snapshots: engine/history.ts.
  // These are its doors; the pixel side of a step stays here (putPatch below,
  // and pushEntry, the pixel-commit chokepoint), and so do the live sessions.
  private readonly history = new EngineHistory(this.cursor, {
    endLive: () => this.endLive(),
    putPatch: (e, img) => this.putPatch(e, img),
    emitChange: () => this.emitChange(),
    onHistory: (s) => this.onHistory(s),
    dropWandSource: () => {
      this.wandSrc = null;
    },
    sessionOpen: () => !!this.fillLayer || !!this.pathLayer,
    cropSnapshot: (ids) => this.cropSnapshot(ids),
    cropRestore: (snap) => this.cropRestore(snap),
    mk: (w, h, readFreq) => this.mk(w, h, readFreq),
    layer: (id) => this.layer(id),
  });
  private trimHistory(): void {
    this.history.trimHistory();
  }
  private linkEntry(e: Omit<Entry, "parent">): void {
    this.history.linkEntry(e);
  }
  private dropNodes(list: number[]): void {
    this.history.dropNodes(list);
  }
  private emitHistory(stale = true) {
    this.history.emitHistory(stale);
  }
  /** The last summary told the History panel a fill or a path was open. */
  private get openTold(): boolean {
    return this.history.openTold;
  }
  private snapshotLayer(snapId: string, layerId: string): Layer {
    return this.history.snapshotLayer(snapId, layerId);
  }
  private reconstructLayerAt(layerId: string, index: number): Layer {
    return this.history.reconstructLayerAt(layerId, index);
  }
  setHistoryLimit(n: number): void {
    this.history.setHistoryLimit(n);
  }
  setHistoryBudgetMB(mb: number): void {
    this.history.setHistoryBudgetMB(mb);
  }
  historyBytes(): number {
    return this.history.historyBytes();
  }
  historyOf(docId: string): { labels: string[]; index: number } | null {
    return this.history.historyOf(docId);
  }
  pushStructural(label: string, undo: () => void, redo: () => void) {
    this.history.pushStructural(label, undo, redo);
  }
  jumpTo(target: number) {
    this.history.jumpTo(target);
  }
  undo() {
    this.history.undo();
  }
  redo() {
    this.history.redo();
  }
  setNonLinearHistory(on: boolean) {
    this.history.setNonLinearHistory(on);
  }
  syncHistory() {
    this.history.syncHistory();
  }
  setHistorySourceIndex(index: number) {
    this.history.setHistorySourceIndex(index);
  }
  createSnapshot(label: string, ownLayerIds: string[]): string {
    return this.history.createSnapshot(label, ownLayerIds);
  }
  getSnapshot(id: string): DocSnapshot | null {
    return this.history.getSnapshot(id);
  }
  deleteSnapshot(id: string): void {
    this.history.deleteSnapshot(id);
  }
  restoreSnapshot(id: string): boolean {
    return this.history.restoreSnapshot(id);
  }
  setHistorySourceSnapshot(id: string | null): void {
    this.history.setHistorySourceSnapshot(id);
  }
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
  /** Finalize every live session — adjustment, shape, gradient, path, fill —
   *  so each is the history step it stands for. */
  private endLive() {
    this.endAdjust();
    this.endShape();
    this.endGradient();
    this.endPath();
    this.endFill();
  }
}
