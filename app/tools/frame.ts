// Frame: drag out a placeholder frame — a rectangle or an ellipse that an image
// dropped on it fills. The frame layer is the editor's to make; this is the
// rubber band while it is dragged.

import { shapeNodeColor } from "./shared";
import type { ToolController } from "./types";

/* The Frame tool's pointer: a crosshair with a small frame glyph tucked into
   the lower-right quadrant, so it reads as "drag out a frame" rather than as
   another selection. Same construction as the Eyedropper's (eyedropper.ts) — a dark wide
   stroke under a thin white one, so it stays visible on any artwork — and the
   same `, crosshair` fallback if the data URL is ever refused. The corner marks
   are drawn as four brackets rather than a closed rectangle: at 32px a full
   outline turns into a grey smudge. */
const FRAME_CURSOR_PATHS =
  // crosshair
  '<path d="M11 1v8M11 13v8M1 11h8M13 11h8"/>' +
  // frame brackets, lower right
  '<path d="M17 15h6v6M31 21v6h-6M17 27h2M29 15h2"/>';
const FRAME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="30" viewBox="0 0 34 30">' +
  '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  `<g stroke="#000" stroke-opacity="0.55" stroke-width="3.2">${FRAME_CURSOR_PATHS}</g>` +
  `<g stroke="#fff" stroke-width="1.5">${FRAME_CURSOR_PATHS}</g>` +
  "</g></svg>";
// Hotspot (11, 11): the centre of the crosshair, which is where the drag starts.
export const FRAME_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(FRAME_SVG)}") 11 11, crosshair`;

export function frameTool(): ToolController {
  let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  return {
    cursor: FRAME_CURSOR,
    layer: "frame",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      h.redraw();
    },
    move(e, h) {
      if (!drag) return false;
      const p = h.toDoc(e);
      drag.x1 = p.x;
      drag.y1 = p.y;
      h.redraw();
      return true;
    },
    up(_e, h) {
      if (!drag) return;
      const f = drag;
      drag = null;
      const w = Math.abs(f.x1 - f.x0);
      const ht = Math.abs(f.y1 - f.y0);
      // A click rather than a drag is not a frame; ignoring it beats creating a
      // one-pixel placeholder nobody can see or grab.
      if (w >= 4 && ht >= 4) {
        h.frame.drawn?.({ x: Math.min(f.x0, f.x1), y: Math.min(f.y0, f.y1), w, h: ht }, h.frame.shape);
      }
      h.redraw();
    },
    cancel() {
      drag = null;
    },
    drawOverlay(o) {
      if (!drag) return;
      const { ctx, p, s } = o;
      const rx = p.x + Math.min(drag.x0, drag.x1) * s;
      const ry = p.y + Math.min(drag.y0, drag.y1) * s;
      const rw = Math.abs(drag.x1 - drag.x0) * s;
      const rh = Math.abs(drag.y1 - drag.y0) * s;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = shapeNodeColor();
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    },
    wantsOverlay: () => !!drag,
    // The Info panel's size readout: the frame being dragged out.
    readout: () =>
      drag
        ? { kind: "size", w: Math.abs(Math.round(drag.x1 - drag.x0)), h: Math.abs(Math.round(drag.y1 - drag.y0)) }
        : null,
    busy: () => drag !== null,
  };
}
