// Text: a click places point text, a drag lays out a paragraph box, and a click
// on a text layer opens it again. The editing itself — the editor over the
// canvas, and turning it into a layer — is CanvasArea's (h.text); this is the
// press that opens it.

import { normalizeRect, type Rect } from "../lib/view";
import type { Pt, ToolController } from "./types";

export function textTool(): ToolController {
  /** Where the press landed; a release turns it into an editor. */
  let press: Pt | null = null;
  /** The paragraph box the drag is laying out (doc px). */
  let drag: Rect | null = null;
  return {
    cursor: "text",
    layer: "text",
    down(e, h) {
      e.preventDefault();
      // Clicking the canvas (outside the editor) commits any text being edited.
      if (h.text.editing) h.text.commit();
      const p = h.toDoc(e);
      // Click on an existing text layer → re-edit it as a vector.
      const hit = h.text.layerAt(p);
      if (hit) {
        h.text.reedit(hit.id, hit.vector);
        return;
      }
      // Otherwise arm a press → click = point text, drag = paragraph box on release.
      press = { x: p.x, y: p.y };
      drag = null;
      h.capture(e);
    },
    // A drag from the press point rubber-bands a paragraph box (preview).
    move(e, h) {
      if (!press) return false;
      const cur = h.toDoc(e);
      drag = normalizeRect(press.x, press.y, cur.x, cur.y, h.doc.width, h.doc.height);
      h.redraw();
      return true;
    },
    up(e, h) {
      if (!press) return;
      const start = press;
      const box = drag;
      press = null;
      drag = null;
      const pt = h.toDoc(e);
      // A real drag → paragraph box; a click → point text (auto-width).
      h.text.open(
        box && Math.abs(pt.x - start.x) > 6 && Math.abs(pt.y - start.y) > 6
          ? { x: box.x, y: box.y, boxW: Math.max(24, box.w), value: "", seed: Date.now() }
          : { x: start.x, y: start.y, boxW: null, value: "", seed: Date.now() },
      );
      h.release(e);
      h.redraw();
    },
    // A pinch drops the press: no editor opens.
    cancel(h) {
      if (!press) return;
      press = null;
      drag = null;
      h.redraw();
    },
    drawOverlay(o) {
      if (!o.selected || !drag) return;
      const { ctx, p, s } = o;
      const rx = p.x + drag.x * s;
      const ry = p.y + drag.y * s;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeRect(rx + 0.5, ry + 0.5, drag.w * s, drag.h * s);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeRect(rx + 0.5, ry + 0.5, drag.w * s, drag.h * s);
      ctx.setLineDash([]);
    },
    wantsOverlay: (selected) => selected && !!drag,
    busy: () => press !== null,
  };
}
