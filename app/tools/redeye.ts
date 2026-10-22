// Red eye: one click darkens the red pupil under the ring.

import { findNode } from "../lib/layers";
import type { Pt, ToolController } from "./types";

export function redEyeTool(): ToolController {
  let hover: Pt | null = null;
  return {
    down(e, h) {
      const id = h.activeLayerId;
      if (!id) return;
      const node = findNode(h.layers, id);
      if (!node || node.type !== "layer") return; // pixel leaves only
      if (h.paintBlocked(id)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      const p = h.toDoc(e);
      const r = h.settings.redEye;
      h.engine.redEye(id, p.x, p.y, r.size, r.darken, h.selection.rects, h.selection.angle, h.selection.pivot);
    },
    hover(cur, _e, h) {
      hover = { x: cur.x, y: cur.y };
      h.redraw();
    },
    // A click tool: nothing is ever mid-stroke, so the ring always goes.
    leave(h) {
      hover = null;
      h.redraw();
    },
    drawOverlay(o, h) {
      if (!hover) return;
      const { p, s } = o;
      const hx = p.x + hover.x * s;
      const hy = p.y + hover.y * s;
      o.ring(hx, hy, Math.max(1, (h.settings.redEye.size / 2) * s), 100);
    },
    wantsOverlay: () => !!hover,
    busy: () => false,
  };
}
