// Spot healing: paint a blob over a blemish, and on release the whole blob is
// healed in one pass (one history step). The blob shows as a dark veil while it
// is painted, under the tool's ring.

import { findNode } from "../lib/layers";
import type { Pt, ToolController } from "./types";

export function healTool(): ToolController {
  /** The blob being painted (doc px); null when not painting. */
  let pts: Pt[] | null = null;
  let hover: Pt | null = null;
  return {
    cursor: "none", // the ring is drawn on the overlay instead
    down(e, h) {
      const id = h.activeLayerId;
      if (!id) return; // nothing to heal on an empty doc
      const node = findNode(h.layers, id);
      if (!node || node.type !== "layer") return; // pixel leaves only
      if (h.paintBlocked(id)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      pts = [{ x: p.x, y: p.y }];
      hover = { x: p.x, y: p.y };
      h.redraw();
    },
    // The blob grows under the pointer while it is down: a dab whenever the
    // pointer has moved a sixth of the tip.
    hover(cur, _e, h) {
      hover = { x: cur.x, y: cur.y };
      if (pts) {
        const last = pts[pts.length - 1];
        if (Math.hypot(cur.x - last.x, cur.y - last.y) >= Math.max(2, h.settings.heal.size / 6)) {
          pts.push({ x: cur.x, y: cur.y });
        }
      }
      h.redraw();
    },
    up(_e, h) {
      if (!pts) return;
      const blob = pts;
      pts = null;
      if (h.activeLayerId && blob.length) {
        h.engine.healSpots(
          h.activeLayerId,
          blob,
          h.settings.heal.size,
          h.settings.heal.hardness,
          h.selection.rects,
          h.selection.angle,
          h.selection.pivot,
        );
      }
      h.redraw();
    },
    // The blob is only points until the lift: dropping it is the whole cancel.
    cancel(h) {
      if (!pts) return;
      pts = null;
      h.redraw();
    },
    leave(h) {
      if (pts) return;
      hover = null;
      h.redraw();
    },
    drawCursor(o, h) {
      const { ctx, p, s } = o;
      const hr = Math.max(1, (h.settings.heal.size / 2) * s);
      if (pts && pts.length) {
        ctx.save();
        ctx.beginPath();
        for (const q of pts) {
          ctx.moveTo(p.x + q.x * s + hr, p.y + q.y * s);
          ctx.arc(p.x + q.x * s, p.y + q.y * s, hr, 0, Math.PI * 2);
        }
        ctx.fillStyle = "rgba(0,0,0,0.32)";
        ctx.fill();
        ctx.restore();
      }
      if (hover) {
        const hx = p.x + hover.x * s;
        const hy = p.y + hover.y * s;
        o.ring(hx, hy, hr, h.settings.heal.hardness);
      }
    },
    wantsOverlay: (selected) => selected && !!(hover || pts),
    busy: () => pts !== null,
  };
}
