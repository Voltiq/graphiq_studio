// The view tools that are tools (the Hand's pan is CanvasArea's own gesture:
// pan mode lends it to every tool).

import type { ToolController } from "./types";

/** Zoom: a click steps in toward the cursor; right-click or Alt steps out. */
export function zoomTool(): ToolController {
  return {
    overPan: true, // a tap zooms even with pan mode on
    down(e, h) {
      e.preventDefault();
      h.zoomToPoint(e.button === 2 || e.altKey ? -1 : 1, e.clientX, e.clientY);
    },
    busy: () => false,
  };
}
