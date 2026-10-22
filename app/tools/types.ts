// Tool controllers (TODO 1.4): what a tool on the canvas does, one module per
// tool family, instead of a branch in each of CanvasArea's three pointer
// handlers.
//
// CanvasArea keeps what is NOT a tool's business: mapping the pointer into the
// document, and deciding who owns it — a pinch, a rejected palm, the brush HUD,
// bird's-eye, pan mode, a dialog's eyedropper. What is left of a press after
// that is handed to the active tool's controller, and the rest of that gesture
// goes to the SAME controller, whatever the tool is by then: a stroke begun
// with the Blur tool ends as a Blur stroke even if a shortcut switched tools
// half way (as it always has).

import type { StrokeStep } from "../lib/actions";
import type { BrushSettings, PaintEngine, WandSelection } from "../lib/paint";
import type { LayerNode } from "../lib/layers";
import type { ColorSampler, GestureReadout } from "../lib/samplers";
import type { ShapeGeom, StarGeom, TrapInsets } from "../lib/shapes";
import type { SelOp } from "./shared";
import type { Rect } from "../lib/view";
import type {
  BlurSettings,
  CloneSettings,
  DodgeSettings,
  CropGrid,
  CropQuad,
  GradientStop,
  GradientType,
  HealSettings,
  LassoMode,
  MarqueeShape,
  MeasureLine,
  MoveMode,
  PenAnchor,
  QuickSelectSettings,
  ShapeKind,
  RedEyeSettings,
  SmudgeSettings,
  SpongeSettings,
  ToolId,
  VectorText,
} from "../lib/tools";
import type { MixerSettings } from "../lib/mixer";

export interface Pt {
  x: number;
  y: number;
}

/** One sample of a pointer: a coalesced pen sample is one. */
export interface ToolSample {
  clientX: number;
  clientY: number;
  pointerType: string;
  /** As the device reports it (a mouse: 0.5 while held). */
  pressure: number;
}

/** The parts of a pointer event a tool reads. A React.PointerEvent is one. */
export interface ToolPointer extends ToolSample {
  pointerId: number;
  button: number;
  /** The buttons held, as a bitmask (a stylus's eraser end is bit 5). */
  buttons: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
  /** The samples a pen took since the last event (where the browser has them). */
  nativeEvent?: { getCoalescedEvents?(): ToolSample[] };
}

export interface BucketSettings {
  tolerance: number;
  opacity: number;
  contiguous: boolean;
  antialias: boolean;
}

export interface GradientSettings {
  type: GradientType;
  reverse: boolean;
  smooth: boolean;
  /** Snap the midpoint to the centre (Preferences). */
  snap: boolean;
  stops: GradientStop[] | null;
  fg: string;
  bg: string;
}

/** A live shape's draggable node: a trapezoid's side, a triangle's apex, a
 *  star's spoke and waist, a rectangle's corner radius. */
export type ShapeNode = "l" | "r" | "apex" | "starOuter" | "starInner" | "radius";

/** A text editor to open over the canvas: point text (no box width) or a
 *  paragraph box. */
export interface TextStart {
  x: number;
  y: number;
  boxW: number | null;
  value: string;
  /** Bumped per open — seeds the editor once. */
  seed: number;
}

/**
 * What a controller may see and do — the canvas it works on. CanvasArea builds
 * a fresh one every render (so every value is the current one) and passes it to
 * each call; a controller never keeps it.
 */
export interface ToolHost {
  engine: PaintEngine;
  /** The tool selected now (a gesture's own tool may differ, see above). */
  tool: ToolId;
  /** Client px → document px. */
  toDoc(e: { clientX: number; clientY: number }): Pt;
  /** The host as it is NOW — for a timer or a frame that fires after the event
   *  this one was built for. */
  latest(): ToolHost;
  /** The document's size, px. */
  doc: { width: number; height: number };
  /** The view's zoom, percent. */
  zoom: number;
  /** Keep the rest of this pointer's gesture coming to the canvas. */
  capture(e: ToolPointer): void;
  /** Let the pointer go again (if it was kept). */
  release(e: ToolPointer): void;
  /** The canvas's cursor while it hovers here (null: the tool's own). */
  setCursor(cursor: string | null): void;
  /** Tell the status bar and Info panel where the pointer is (doc px; null:
   *  off the canvas). */
  cursorAt(p: Pt | null): void;
  /** A grab radius in document px: `screenPx` scaled for the pointer in use
   *  (a fingertip gets a bigger one than a mouse), at most `limitDoc` — for a
   *  target whose neighbours are close by. */
  grab(screenPx: number, limitDoc?: number): number;
  /** Show the touch loupe under the pointer — or over `at` (doc px), when
   *  what is being placed is not under the finger. A mouse gets none. */
  loupe(e: ToolPointer, at?: Pt): void;
  /** The pressure a sample paints with: the user's curve applied, and always
   *  1 for a mouse or a pen that doesn't measure it. */
  pressure(e: ToolSample): number;
  /** Redraw the overlay (rings, ants, handles) on the next frame. */
  redraw(): void;
  activeLayerId: string | null;
  layers: LayerNode[];
  /** True — after telling the user why — when the layer's pixels may not be
   *  painted (a lock, a fill layer). */
  paintBlocked(id: string | null): boolean;
  /** The layer to paint on: the active one, or a new one when there is none. */
  ensureLayer(): string;
  /** The topmost layer with a pixel at `p` (null: none). */
  layerAt(p: Pt): string | null;
  /** Make a layer the active one. */
  pickLayer(id: string): void;
  /** True — after telling the user why — when the layer may not be moved (a
   *  position lock, a fill layer). */
  moveBlocked(id: string | null): boolean;
  /** The layers linked to `id`, which ride along when it moves whole. */
  linkedExtras(id: string): { id: string; maskLinked: boolean }[];
  /** The live path the Pen and Direct selection edit (CanvasArea's: the keys
   *  and the Paths panel reach it too). */
  path: {
    current: { current: { anchors: PenAnchor[]; closed: boolean; layerId: string } | null };
    /** The anchors Direct selection has picked. */
    picked: { current: Set<number> };
    /** Re-stroke it from its anchors (it is drawn live by the engine). */
    render(): void;
    /** Commit it (a stored path's edit goes back to it). */
    finish(): void;
  };
  /** The live shape (CanvasArea's): its box and node geometry, kept between
   *  gestures, and what the options bar sets. */
  shape: {
    live: { current: { layerId: string; box: Rect } | null };
    opts: { kind: ShapeKind; strokeWidth: number; radius: number; fill: string; stroke: string; starPoints?: number };
    trap: { current: TrapInsets };
    apex: { current: number };
    star: { current: StarGeom };
    /** The node (if any) under `p`. */
    nodeAt(p: Pt): ShapeNode | null;
    /** A new shape starts symmetric, centred and upright. */
    fresh(): void;
    /** Rebuild the live shape from its nodes, once a frame. */
    schedule(): void;
    /** The node-adjustable geometry for a kind. */
    geom(kind: ShapeKind): ShapeGeom | undefined;
    /** The rectangle's corner radius (the options bar's Radius). */
    setRadius(r: number): void;
    /** Draw a new live shape in `box` on layer `id`, `box` its selection —
     *  one "Shape" step. */
    place(id: string, box: Rect): void;
  };
  /** The crop — the editor's box (or perspective quad) and its options. */
  crop: {
    box: Rect | null;
    quad: CropQuad | null;
    /** Degrees. */
    straighten: number;
    /** Width / height, or null: free. */
    aspect: number | null;
    grid: CropGrid;
    /** The shield's opacity, percent. */
    shield: number;
    setBox(box: Rect): void;
    setQuad(quad: CropQuad): void;
    apply(): void;
  };
  /** Something Enter would commit and Escape drop came or went (a polygon):
   *  the phone's on-canvas ✓/✕ follow it. */
  committable(): void;
  /** The selection: what an edit is confined to (null rects for none), and
   *  how a selection tool sets it. */
  selection: {
    rects: Rect[] | null;
    /** The rects as they are (empty: none). */
    all: Rect[];
    angle: number;
    pivot: Pt | null;
    /** Replace it — with its outline, when the engine traced one (the ants
     *  then need not trace it again). */
    set(rects: Rect[], segments?: WandSelection["segments"]): void;
    /** Take an engine-combined selection (an empty one deselects). */
    combine(result: WandSelection | null): void;
    /** Put it somewhere new, keeping its rotation (a Move drag). */
    place(rects: Rect[], angle: number, pivot: Pt | null): void;
    /** The magic wand's seed, so a Tolerance change can re-run it. */
    seedWand(seed: { x: number; y: number; layerId: string | null; base: Rect[]; mode: SelOp }): void;
    /** A just-made triangle the Apex slider can re-shape (null: none). */
    triangle(
      t: { box: Rect; pointDown: boolean; base: Rect[]; mode: SelOp; key: Rect[] } | null,
    ): void;
  };
  /** The selection's own transform box (CanvasArea's, shared by the tools
   *  that select). */
  transform: {
    /** A press on its handles, ring or anchor starts transforming it: true
     *  when it did (the press is then the transform's). */
    start(e: ToolPointer, p: Pt): boolean;
    /** Show what a press here would do (resize, rotate, move the anchor). */
    hoverCursor(e: { clientX: number; clientY: number }): void;
    /** The same for the active LAYER's box (Move ▸ transform controls). */
    startLayer(e: ToolPointer, p: Pt): boolean;
    /** Over a guide or the layer's box: the cursor for picking it up. */
    layerHoverCursor(e: { clientX: number; clientY: number }): void;
  };
  /** Snapping a dragged point to guides, the canvas and other layers. */
  snap: {
    /** Start a drag at (x, y): the point, snapped (`suspend`: as it is). */
    begin(x: number, y: number, suspend: boolean): Pt;
    point(x: number, y: number, suspend: boolean): Pt;
    /** Start a Move drag: what moves, measured once. */
    beginMove(): void;
    /** A Move drag's delta, snapped (`suspend`: as it is). */
    move(dx: number, dy: number, suspend: boolean): { dx: number; dy: number };
    /** The drag is over: the hints go. */
    end(): void;
  };
  foreground: string;
  background: string;
  settings: {
    /** The selected paint tool's (brush, pencil or eraser). */
    brush: BrushSettings;
    history: BrushSettings;
    clone: CloneSettings;
    blur: BlurSettings;
    smudge: SmudgeSettings;
    mixer: MixerSettings;
    dodge: DodgeSettings;
    sponge: SpongeSettings;
    heal: HealSettings;
    redEye: RedEyeSettings;
    bucket: BucketSettings;
    gradient: GradientSettings;
    /** The Eyedropper's sample: its size (px square) and whether it reads
     *  every layer or the active one. */
    sample: { size: number; all: boolean };
    marquee: { shape: MarqueeShape; apex: number };
    lasso: LassoMode;
    wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
    quickSelect: QuickSelectSettings;
    /** Snap a selection to whole pixels. */
    snapPixels: boolean;
    move: { mode: MoveMode; autoSelect: boolean };
    /** How close (screen px) a dragged node comes before it snaps. */
    snapDistance: number;
  };
  /** A colour the Eyedropper sampled: it becomes the foreground. */
  pick(hex: string): void;
  /** The Info panel's colour samplers (the Eyedropper places and drags them). */
  samplers: {
    list(): ColorSampler[];
    hit(x: number, y: number, tol: number): ColorSampler | null;
    add(x: number, y: number): void;
    remove(id: string): void;
    moveLive(id: string, x: number, y: number): void;
    /** End a drag as one undo step, from the list as it was. */
    commitMove(before: ColorSampler[]): void;
  };
  /** The Measure tool's line — the editor's (the options bar reads it). */
  measure: { line: MeasureLine | null; set(line: MeasureLine | null): void };
  /** The Frame tool's next frame shape, and where a dragged-out one goes. */
  frame: {
    shape: "rect" | "ellipse";
    drawn?(rect: Rect, shape: "rect" | "ellipse"): void;
  };
  /** The text editor over the canvas (CanvasArea's). */
  text: {
    /** One is open. */
    editing: boolean;
    /** Turn what is being edited into its layer, and close the editor. */
    commit(): void;
    /** The topmost visible text layer under `p`. */
    layerAt(p: Pt): { id: string; vector: VectorText } | null;
    /** Open a text layer in the editor again. */
    reedit(id: string, vector: VectorText): void;
    /** Open a new editor (in the foreground colour). */
    open(start: TextStart): void;
  };
  /** Zoom one step in (1) or out (-1) about a client point. */
  zoomToPoint(dir: 1 | -1, clientX: number, clientY: number): void;
  /** The Actions recorder: whether it is recording, and where a finished
   *  stroke goes. */
  strokes: { recording: boolean; record(step: StrokeStep): void };
}

/**
 * Where in the overlay a controller's drawing goes. The overlay is painted in
 * one order, bottom to top — the order it always had — and each tool's
 * drawing keeps its place in it (a selection's outline under the handles
 * over it, the rings over both).
 */
export type OverlayLayer =
  /** The crop's shield, box and handles. */
  | "crop"
  /** A selection being drawn: the marquee's region, a lasso, a polygon. */
  | "selection"
  /** A shape being dragged out. */
  | "shape"
  /** The bucket's preview, and its live fill's seed. */
  | "fill"
  /** The live gradient's line and handles. */
  | "gradient"
  /** The ruler. */
  | "measure"
  /** A frame being dragged out (over the frames' own chrome). */
  | "frame"
  /** Direct selection's marquee and the pen's path. */
  | "path"
  /** The Eyedropper's outline and marker. */
  | "sample"
  /** Move's transform box (over the tool cursors). */
  | "transform"
  /** A text box being dragged out. */
  | "text";

/** The overlay a controller draws into: document space is `p + q·s`. */
export interface OverlayPainter {
  ctx: CanvasRenderingContext2D;
  /** Where the document's origin is on the overlay canvas. */
  p: Pt;
  /** Overlay px per document px. */
  s: number;
  /** The overlay's size, CSS px. */
  width: number;
  height: number;
  /** This controller's tool is the one selected. */
  selected: boolean;
  /** The marching ants' dash offset (they march: it moves every frame). */
  ants: number;
  /** The tool cursor: a ring at full diameter (and the hardness ring), or a
   *  crosshair — whichever the user chose. */
  ring(hx: number, hy: number, r: number, hardness: number): void;
  /** A crosshair of arm `len`, light over a dark under-stroke. */
  cross(hx: number, hy: number, len: number): void;
  /** The ring colour (Preferences ▸ Cursors) at alpha `a`. */
  light(a: number): string;
}

export interface ToolController {
  /**
   * Taken before pan mode: a click tool (Zoom) still answers a tap with pan
   * mode on, where every drag tool gives the drag to the pan.
   */
  readonly overPan?: boolean;
  /** A guide over the canvas is picked up by a press before the tool sees it
   *  (the Move tool: a guide over artwork would otherwise never be grabbed). */
  readonly grabsGuides?: boolean;
  /** The selected tool shows the active layer's transform controls. */
  readonly showsLayerTransform?: boolean;
  /** The selected tool shows the selection's transform handles (a selection
   *  tool's, or a live shape's). */
  readonly transformsSelection?: boolean;
  /** The canvas's CSS cursor while the tool is selected (a hover cursor the
   *  tool sets wins over it); "none" for a tool that draws its own. */
  readonly cursor?: string;
  /** The right button is the tool's (it zooms out, paints the secondary
   *  colour): the browser's menu stays shut. */
  readonly rightButton?: boolean;
  /** A press on the canvas, once CanvasArea has let it through. */
  down(e: ToolPointer, h: ToolHost): void;
  /** The pointer moved over the canvas while this is the selected tool —
   *  pressed or not (a ring follows it; a heal blob grows under it). True
   *  when it took the move (a grab): the handler stops there. */
  hover?(cur: Pt, e: ToolPointer, h: ToolHost): boolean | void;
  /** The pointer moved during this controller's own gesture. True when it
   *  used the move (the handler stops there). */
  move?(e: ToolPointer, h: ToolHost): boolean;
  /** The pointer lifted during this controller's own gesture. */
  up?(e: ToolPointer, h: ToolHost): void;
  /** The lift, before CanvasArea's arbitration sees it: true when it ended a
   *  grab that only carried a marker (the clone source), which is then the
   *  whole of the lift. */
  drop?(h: ToolHost): boolean;
  /** A pinch has taken the pointer: abandon the gesture — the picture as it
   *  was, and no history step. (What a lift would have committed must not be
   *  committed, and what the next contact moves must not feed it.) */
  cancel?(h: ToolHost): void;
  /** The pointer left the canvas (a ring not mid-stroke goes). */
  leave?(h: ToolHost): void;
  /** Its tool is no longer the selected one: commit what it left live (a
   *  gradient, a bucket fill), drop what only it shows. */
  deselect?(h: ToolHost): void;
  /** A key pressed while its tool is selected. */
  keyDown?(e: KeyboardEvent, h: ToolHost): void;
  /** A double-click on the canvas while its tool is selected. (Its presses
   *  came first, as two presses: a pointerdown's `detail` is always 0.) */
  doubleClick?(e: { clientX: number; clientY: number }, h: ToolHost): void;
  /** Another document became the active one: forget what was in this one's
   *  coordinates (a clone source). */
  switchDoc?(): void;
  /** Draw the tool's cursor: a ring, a blob being healed (it is the selected
   *  tool, and no dialog has the pointer). */
  drawCursor?(o: OverlayPainter, h: ToolHost): void;
  /** Where in the overlay `drawOverlay` draws. */
  readonly layer?: OverlayLayer;
  /** Draw what the tool shows on the canvas — a path, a preview, handles —
   *  whatever tool is selected (`o.selected` says whether it is this one).
   *  True when it is the whole overlay (the crop's): nothing else is drawn. */
  drawOverlay?(o: OverlayPainter, h: ToolHost): boolean | void;
  /** Something to draw: keep the overlay loop running. `selected`: its tool
   *  is the one selected. */
  wantsOverlay?(selected: boolean, h: ToolHost): boolean;
  /** The Info panel's live readout of the gesture (a size being dragged out). */
  readout?(): GestureReadout | null;
  /** A gesture is in flight: the rest of it comes here. */
  busy(): boolean;
}
