// Measure: a ruler line between two points — drag one out, or grab an end to
// adjust it. The line itself is the editor's (the options bar shows its angle
// and length; Straighten levels the image by it): this is the gesture, and the
// line on the canvas while the tool is selected.

import { measureInfo } from "../lib/tools";
import type { Pt, ToolController, ToolHost } from "./types";

/** Which end of the line (if either) is under `p`: the nearer, within reach. */
function endAt(h: ToolHost, p: Pt): "start" | "end" | null {
  const m = h.measure.line;
  if (!m) return null;
  const hit = h.grab(10);
  const dEnd = Math.hypot(p.x - m.x2, p.y - m.y2);
  const dStart = Math.hypot(p.x - m.x1, p.y - m.y1);
  if (Math.min(dEnd, dStart) > hit) return null;
  return dEnd <= dStart ? "end" : "start";
}

export function measureTool(): ToolController {
  /** The end being dragged, and the line as it was before the press. */
  let drag: "start" | "end" | null = null;
  let before: ToolHost["measure"]["line"] = null;
  return {
    layer: "measure",
    down(e, h) {
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      const hit = endAt(h, p);
      before = h.measure.line;
      if (hit && h.measure.line) {
        drag = hit; // grab an existing endpoint to adjust
      } else {
        h.measure.set({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }); // start fresh
        drag = "end";
      }
      h.redraw();
    },
    hover(cur, _e, h) {
      h.setCursor(drag ? "grabbing" : endAt(h, cur) ? "grab" : "crosshair");
    },
    move(e, h) {
      const m = h.measure.line;
      if (!drag || !m) return false;
      const p = h.toDoc(e);
      let nx = p.x;
      let ny = p.y;
      // Shift constrains the line to 45° increments from the anchored endpoint.
      if (e.shiftKey) {
        const ax = drag === "end" ? m.x1 : m.x2;
        const ay = drag === "end" ? m.y1 : m.y2;
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(p.y - ay, p.x - ax) / step) * step;
        const len = Math.hypot(p.x - ax, p.y - ay);
        nx = ax + Math.cos(ang) * len;
        ny = ay + Math.sin(ang) * len;
      }
      h.measure.set(drag === "end" ? { ...m, x2: nx, y2: ny } : { ...m, x1: nx, y1: ny });
      h.redraw();
      return true;
    },
    up(e, h) {
      if (!drag) return;
      drag = null;
      h.release(e);
      // A bare click (no drag) clears the measurement rather than leaving a dot.
      const m = h.measure.line;
      if (m && Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 1) h.measure.set(null);
      h.setCursor(endAt(h, h.toDoc(e)) ? "grab" : null);
      h.redraw();
    },
    // A pinch puts the line back as it was before the press.
    cancel(h) {
      if (!drag) return;
      drag = null;
      h.measure.set(before);
      h.redraw();
    },
    // The line + endpoint dots + a compact angle/length label.
    drawOverlay(o, h) {
      const meas = h.measure.line;
      if (!o.selected || !meas) return;
      const { ctx, p, s } = o;
      const ax = p.x + meas.x1 * s;
      const ay = p.y + meas.y1 * s;
      const bx = p.x + meas.x2 * s;
      const by = p.y + meas.y2 * s;
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      for (const [w, col] of [
        [3, "rgba(0,0,0,0.55)"],
        [1, "#ffd24a"],
      ] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      const dot = (x: number, y: number) => {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd24a";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
      };
      dot(ax, ay);
      dot(bx, by);
      ctx.lineCap = "butt";
      // Floating label near the far endpoint: angle + pixel length.
      const info = measureInfo(meas);
      if (info.length > 0.5) {
        const label = `${info.angle.toFixed(1)}° · ${Math.round(info.length)} px`;
        ctx.font = "11px var(--font-mono, monospace)";
        const tw = ctx.measureText(label).width;
        const lx = bx + 10;
        const ly = by - 10;
        ctx.fillStyle = "rgba(12,14,20,0.82)";
        ctx.fillRect(lx - 4, ly - 11, tw + 8, 16);
        ctx.fillStyle = "#ffe9a6";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx, ly - 2);
      }
    },
    wantsOverlay: (selected, h) => selected && !!h.measure.line,
    busy: () => drag !== null,
  };
}
