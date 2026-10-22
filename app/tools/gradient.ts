// Gradient: drag out a gradient, then adjust it by its handles — either end,
// and the midpoint between the colours — until another tool, a new gradient or
// Esc commits it. It is drawn live by the engine, clipped to the selection it
// was started in.

import { clamp } from "../lib/color";
import { resolveStops } from "../lib/gradient";
import type { Rect } from "../lib/view";
import type { Pt, ToolController, ToolHost } from "./types";

type Handle = "start" | "end" | "mid";

export interface GradientController extends ToolController {
  /** Its settings changed (type, colours, stops…): draw the live one with them
   *  on the next frame — coalesced, so dragging the colour picker (many ticks a
   *  second) stays smooth. Returns how to call that frame off. */
  rerender(h: ToolHost): (() => void) | undefined;
  /** The engine ended the live gradient (committed, undone): drop its handles. */
  ended(h: ToolHost): void;
}

export function gradientTool(): GradientController {
  /** The live gradient: its endpoints + midpoint + the selection it was clipped
   *  to, re-renderable until committed. */
  let live: {
    layerId: string;
    start: Pt;
    end: Pt;
    mid: number;
    sel: Rect[];
    selAngle: number;
    selPivot: Pt | null;
  } | null = null;
  /** The handle being dragged. */
  let drag: Handle | null = null;

  // Re-render the live gradient from its current geometry + settings.
  const render = (h: ToolHost) => {
    const g = live;
    if (!g) return;
    const o = h.settings.gradient;
    h.engine.liveGradient(
      g.layerId,
      o.type,
      g.start,
      g.end,
      g.mid,
      resolveStops(o.stops, o.fg, o.bg, o.reverse),
      g.sel.length ? g.sel : null,
      g.selAngle,
      g.selPivot,
      o.smooth,
    );
  };

  // Which handle (if any) a doc-space point is over.
  const handleAt = (h: ToolHost, p: Pt): Handle | null => {
    const g = live;
    if (!g) return null;
    const hit = h.grab(10);
    const mid = {
      x: g.start.x + (g.end.x - g.start.x) * g.mid,
      y: g.start.y + (g.end.y - g.start.y) * g.mid,
    };
    /* The midpoint lies BETWEEN the other two by construction, so at a finger's
       radius a fixed end-start-mid priority would make it unreachable on any
       short gradient. Nearest wins instead. */
    let best: Handle | null = null;
    let bestD = hit;
    for (const [id, q] of [["end", g.end], ["start", g.start], ["mid", mid]] as const) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };

  return {
    layer: "gradient",
    cursor: "crosshair",
    down(e, h) {
      if (h.paintBlocked(h.activeLayerId)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      // Grab a handle of the current gradient to adjust it, otherwise draw a new one.
      const hit = handleAt(h, p);
      if (hit) {
        drag = hit;
        return;
      }
      h.engine.endGradient(); // commit the previous gradient
      live = {
        layerId: h.ensureLayer(),
        start: p,
        end: p,
        mid: 0.5,
        sel: (h.selection.rects ?? []).slice(),
        selAngle: h.selection.angle,
        selPivot: h.selection.pivot,
      };
      drag = "end";
      render(h);
      h.redraw();
    },
    // Grab over a handle / the midpoint, grabbing while dragging.
    hover(cur, _e, h) {
      h.setCursor(drag ? "grabbing" : handleAt(h, cur) ? "grab" : null);
    },
    move(e, h) {
      const g = live;
      if (!drag || !g) return false;
      const p = h.toDoc(e);
      if (drag === "end") g.end = { x: p.x, y: p.y };
      else if (drag === "start") g.start = { x: p.x, y: p.y };
      else {
        // Project the cursor onto the line to pick the midpoint position.
        const dx = g.end.x - g.start.x;
        const dy = g.end.y - g.start.y;
        const len2 = dx * dx + dy * dy;
        let t = clamp(len2 > 0 ? ((p.x - g.start.x) * dx + (p.y - g.start.y) * dy) / len2 : 0.5, 0.05, 0.95);
        // Snap to the centre when close (unless disabled in Preferences).
        if (h.settings.gradient.snap && Math.abs(t - 0.5) < 0.04) t = 0.5;
        g.mid = t;
      }
      render(h);
      h.redraw();
      return true;
    },
    // The gradient stays live (handles up) until a tool switch, a new one, or
    // another edit: only the handle is let go.
    up(e, h) {
      if (!drag) return;
      drag = null;
      h.release(e);
      // Pointer is still over the handle it just released → "grab", not "grabbing".
      h.setCursor(handleAt(h, h.toDoc(e)) ? "grab" : null);
      h.redraw();
    },
    // A pinch drops the handles (the engine keeps what it drew, live).
    cancel() {
      live = null;
      drag = null;
    },
    rerender(h) {
      if (!live) return;
      const id = requestAnimationFrame(() => render(h.latest()));
      return () => cancelAnimationFrame(id);
    },
    ended(h) {
      live = null;
      drag = null;
      h.redraw();
    },
    // Leaving the tool commits it.
    deselect(h) {
      h.engine.endGradient();
    },
    // Esc commits it — the gradient stays, its control handles vanish.
    keyDown(e, h) {
      if (e.key === "Escape" && live) {
        e.preventDefault();
        h.engine.endGradient();
      }
    },
    // The line, endpoint handles + the draggable midpoint tick.
    drawOverlay(o) {
      const grad = live;
      if (!grad) return;
      const { ctx, p, s } = o;
      const ax = p.x + grad.start.x * s;
      const ay = p.y + grad.start.y * s;
      const bx = p.x + grad.end.x * s;
      const by = p.y + grad.end.y * s;
      const mx = ax + (bx - ax) * grad.mid;
      const my = ay + (by - ay) * grad.mid;
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      // Connecting line (dark underlay + white).
      for (const [w, col] of [
        [3, "rgba(0,0,0,0.5)"],
        [1, "#fff"],
      ] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      // Endpoint dots.
      const dot = (x: number, y: number) => {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
      };
      dot(ax, ay);
      dot(bx, by);
      // Perpendicular unit for the ticks.
      const a = Math.atan2(by - ay, bx - ax) + Math.PI / 2;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const tick = (cx: number, cy: number, len: number, dw: number, lw: number) => {
        for (const [w, col] of [
          [dw, "rgba(0,0,0,0.5)"],
          [lw, "#fff"],
        ] as const) {
          ctx.lineWidth = w;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(cx - ux * len, cy - uy * len);
          ctx.lineTo(cx + ux * len, cy + uy * len);
          ctx.stroke();
        }
      };
      // Fixed marker at the geometric centre (50%) — a small reference tick.
      tick(ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, 4, 2.5, 1);
      // Draggable midpoint tick (where the colours' halfway point sits).
      tick(mx, my, 7, 4, 2);
      ctx.lineCap = "butt";
    },
    wantsOverlay: () => !!live,
    busy: () => drag !== null,
  };
}
