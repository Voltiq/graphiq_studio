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

import type { PaintEngine } from "../lib/paint";
import type { LayerNode } from "../lib/layers";
import type { Rect } from "../lib/view";
import type {
  BlurSettings,
  DodgeSettings,
  HealSettings,
  RedEyeSettings,
  SmudgeSettings,
  SpongeSettings,
  ToolId,
} from "../lib/tools";
import type { MixerSettings } from "../lib/mixer";

export interface Pt {
  x: number;
  y: number;
}

/** The parts of a pointer event a tool reads. A React.PointerEvent is one. */
export interface ToolPointer {
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
  button: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  detail: number;
  preventDefault(): void;
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
  /** Keep the rest of this pointer's gesture coming to the canvas. */
  capture(e: ToolPointer): void;
  /** Redraw the overlay (rings, ants, handles) on the next frame. */
  redraw(): void;
  activeLayerId: string | null;
  layers: LayerNode[];
  /** True — after telling the user why — when the layer's pixels may not be
   *  painted (a lock, a fill layer). */
  paintBlocked(id: string | null): boolean;
  /** The selection an edit is confined to: null rects for none. */
  selection: { rects: Rect[] | null; angle: number; pivot: Pt | null };
  foreground: string;
  settings: {
    blur: BlurSettings;
    smudge: SmudgeSettings;
    mixer: MixerSettings;
    dodge: DodgeSettings;
    sponge: SpongeSettings;
    heal: HealSettings;
    redEye: RedEyeSettings;
  };
  /** Zoom one step in (1) or out (-1) about a client point. */
  zoomToPoint(dir: 1 | -1, clientX: number, clientY: number): void;
}

/** The overlay a controller draws into: document space is `p + q·s`. */
export interface OverlayPainter {
  ctx: CanvasRenderingContext2D;
  /** Where the document's origin is on the overlay canvas. */
  p: Pt;
  /** Overlay px per document px. */
  s: number;
  /** The tool cursor: a ring at full diameter (and the hardness ring), or a
   *  crosshair — whichever the user chose. */
  ring(hx: number, hy: number, r: number, hardness: number): void;
}

export interface ToolController {
  /**
   * Taken before pan mode: a click tool (Zoom) still answers a tap with pan
   * mode on, where every drag tool gives the drag to the pan.
   */
  readonly overPan?: boolean;
  /** A press on the canvas, once CanvasArea has let it through. */
  down(e: ToolPointer, h: ToolHost): void;
  /** The pointer moved over the canvas while this is the selected tool —
   *  pressed or not (a ring follows it; a heal blob grows under it). */
  hover?(cur: Pt, e: ToolPointer, h: ToolHost): void;
  /** The pointer moved during this controller's own gesture. True when it
   *  used the move (the handler stops there). */
  move?(e: ToolPointer, h: ToolHost): boolean;
  /** The pointer lifted during this controller's own gesture. */
  up?(e: ToolPointer, h: ToolHost): void;
  /** A pinch has taken the pointer: abandon the gesture — the picture as it
   *  was, and no history step. (What a lift would have committed must not be
   *  committed, and what the next contact moves must not feed it.) */
  cancel?(h: ToolHost): void;
  /** The pointer left the canvas (a ring not mid-stroke goes). */
  leave?(h: ToolHost): void;
  /** Draw this tool's overlay (it is the selected tool). */
  drawOverlay?(o: OverlayPainter, h: ToolHost): void;
  /** Something to draw: keep the overlay loop running. */
  wantsOverlay?(): boolean;
  /** A gesture is in flight: the rest of it comes here. */
  busy(): boolean;
}
