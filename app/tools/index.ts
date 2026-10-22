// The tool controllers, by tool: every tool on the canvas is driven through its
// controller (TODO 1.4). CanvasArea maps the pointer, decides who owns it, and
// hands the rest to these.

import type { ToolId } from "../lib/tools";
import { bucketTool } from "./bucket";
import { cropTool } from "./crop";
import { eyedropperTool } from "./eyedropper";
import { frameTool } from "./frame";
import { gradientTool } from "./gradient";
import { healTool } from "./heal";
import { lassoTool } from "./lasso";
import { marqueeTool } from "./marquee";
import { measureTool } from "./measure";
import { moveTool } from "./move";
import { createPaintTools } from "./paint";
import { createPathTools } from "./path";
import { quickSelectTool } from "./quickselect";
import { redEyeTool } from "./redeye";
import { shapeTool } from "./shape";
import { blurTool, dodgeTool, smudgeTool, spongeTool } from "./retouch";
import { textTool } from "./text";
import type { ToolController } from "./types";
import { zoomTool } from "./view";
import { wandTool } from "./wand";

export type {
  OverlayLayer,
  OverlayPainter,
  Pt,
  ShapeNode,
  ToolController,
  ToolHost,
  ToolPointer,
  ToolSample,
} from "./types";

/** One set per canvas: each controller holds its own gesture's state. Tools
 *  that share a session share a controller (Smudge and the Mixer brush; the
 *  Brush, Pencil and Eraser), or its state (a brush and a clone stroke). */
export function createToolControllers() {
  const smudge = smudgeTool();
  const paint = createPaintTools();
  const bucket = bucketTool();
  const gradient = gradientTool();
  const marquee = marqueeTool();
  const lasso = lassoTool();
  const move = moveTool();
  const shape = shapeTool();
  const path = createPathTools();
  const byTool: Partial<Record<ToolId, ToolController>> = {
    zoom: zoomTool(),
    blur: blurTool(),
    smudge,
    mixer: smudge,
    dodge: dodgeTool(),
    sponge: spongeTool(),
    heal: healTool(),
    redeye: redEyeTool(),
    brush: paint.brush,
    pencil: paint.brush,
    eraser: paint.brush,
    history: paint.history,
    clone: paint.clone,
    eyedropper: eyedropperTool(),
    measure: measureTool(),
    bucket,
    gradient,
    frame: frameTool(),
    text: textTool(),
    select: marquee,
    lasso,
    wand: wandTool(),
    quickselect: quickSelectTool(),
    move,
    crop: cropTool(),
    shape,
    pen: path.pen,
    directselect: path.directSelect,
  };
  return {
    /** The controller each tool is driven by. */
    byTool,
    /** Every controller, once (in the order above). */
    all: [...new Set(Object.values(byTool))] as ToolController[],
    // The ones the editor talks to outside a gesture.
    bucket,
    gradient,
    marquee,
    lasso,
    move,
    shape,
    path,
  };
}

export type ToolControllers = ReturnType<typeof createToolControllers>;
