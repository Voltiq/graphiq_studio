// The tool controllers, by tool. A tool listed here is driven entirely through
// its controller; the rest still have their branches in CanvasArea's pointer
// handlers, and move here one family at a time (TODO 1.4).

import type { ToolId } from "../lib/tools";
import { healTool } from "./heal";
import { redEyeTool } from "./redeye";
import { blurTool, dodgeTool, smudgeTool, spongeTool } from "./retouch";
import type { ToolController } from "./types";
import { zoomTool } from "./view";

export type { OverlayPainter, Pt, ToolController, ToolHost, ToolPointer } from "./types";

/** One set per canvas: each controller holds its own gesture's state. Tools
 *  that share a session share a controller (Smudge and the Mixer brush). */
export function createToolControllers(): Partial<Record<ToolId, ToolController>> {
  const smudge = smudgeTool();
  return {
    zoom: zoomTool(),
    blur: blurTool(),
    smudge,
    mixer: smudge,
    dodge: dodgeTool(),
    sponge: spongeTool(),
    heal: healTool(),
    redeye: redEyeTool(),
  };
}
