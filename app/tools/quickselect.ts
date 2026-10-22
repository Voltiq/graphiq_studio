// Quick selection: paint the selection on — each dab grows it to the similar
// pixels under the brush (Alt takes them away). One engine session per stroke.

import type { Rect } from "../lib/view";
import type { Pt, ToolController } from "./types";

export function quickSelectTool(): ToolController {
  /** A stroke is under way, and the selection it began from. */
  let dragging = false;
  let before: { rects: Rect[]; angle: number; pivot: Pt | null } | null = null;
  /** Where the last dab went: the next waits for a quarter of the tip. */
  let last: Pt | null = null;
  let hover: Pt | null = null;
  return {
    cursor: "none", // the ring is drawn on the overlay instead
    down(e, h) {
      const q = h.settings.quickSelect;
      const id = h.activeLayerId;
      if (!q.sampleAll && !id) return; // need a layer to sample
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      const subtract = e.altKey; // Alt = subtract; a plain brush grows the selection
      h.engine.beginQuickSelect(
        id ?? "",
        { tolerance: q.tolerance, sampleAll: q.sampleAll },
        h.selection.rects,
        subtract,
      );
      dragging = true;
      before = { rects: h.selection.all, angle: h.selection.angle, pivot: h.selection.pivot };
      last = { x: p.x, y: p.y };
      hover = { x: p.x, y: p.y };
      const r = h.engine.quickSelectDab(p.x, p.y, q.size / 2);
      if (r) h.selection.combine(r);
      else h.selection.set([]);
      h.redraw();
    },
    hover(cur, _e, h) {
      hover = { x: cur.x, y: cur.y };
      h.redraw();
    },
    move(e, h) {
      if (!dragging) return false;
      const q = h.settings.quickSelect;
      const p = h.toDoc(e);
      hover = { x: p.x, y: p.y };
      const step = Math.max(2, q.size * 0.25);
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= step) {
        last = { x: p.x, y: p.y };
        const r = h.engine.quickSelectDab(p.x, p.y, q.size / 2);
        if (r) h.selection.combine(r);
        else h.selection.set([]);
      }
      h.redraw();
      return true;
    },
    up(e, h) {
      if (!dragging) return;
      h.engine.endQuickSelect();
      dragging = false;
      last = null;
      h.release(e);
      h.redraw();
    },
    // A pinch puts the selection back as it was before the stroke.
    cancel(h) {
      if (!dragging) return;
      h.engine.endQuickSelect();
      dragging = false;
      last = null;
      if (before) h.selection.place(before.rects, before.angle, before.pivot);
      h.redraw();
    },
    leave(h) {
      if (dragging) return;
      hover = null;
      h.redraw();
    },
    drawCursor(o, h) {
      if (!hover) return;
      const hx = o.p.x + hover.x * o.s;
      const hy = o.p.y + hover.y * o.s;
      o.ring(hx, hy, Math.max(1, (h.settings.quickSelect.size / 2) * o.s), 100);
    },
    wantsOverlay: (selected) => selected && !!hover,
    busy: () => dragging,
  };
}
