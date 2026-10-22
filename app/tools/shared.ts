// Small things more than one tool family needs.

import type { Rect } from "../lib/view";
import type { OverlayPainter, ToolHost } from "./types";

/** The selection an edit is confined to, as the engine's trailing arguments. */
export const confined = (h: ToolHost) => [h.selection.rects, h.selection.angle, h.selection.pivot] as const;

/* Shape/pen node handles follow the UI accent (`--accent`). Reading a computed
   style is not free, so the value is cached per theme. */
let shapeNodeCache = { key: "", color: "#1868db" };
export function shapeNodeColor(): string {
  const el = document.documentElement;
  const key = el.getAttribute("data-theme") ?? "";
  if (key !== shapeNodeCache.key) {
    const v = getComputedStyle(el).getPropertyValue("--accent").trim();
    shapeNodeCache = { key, color: v || "#1868db" };
  }
  return shapeNodeCache.color;
}

/** How a selection tool's region combines: replace, Ctrl/Cmd adds, Alt subtracts. */
export type SelOp = "new" | "add" | "subtract";

export const selectOp = (e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): SelOp =>
  e.ctrlKey || e.metaKey ? "add" : e.altKey ? "subtract" : "new";

/** A region being SUBTRACTED from the selection, in red: a faint red fill
 *  marks the part that overlaps the current selection (what's cut), and a red
 *  marching-ants outline traces the whole region. `trace` adds the region's
 *  path to the overlay's context (in overlay px). */
export function drawSubtract(o: OverlayPainter, selection: Rect[], trace: () => void) {
  const { ctx, p, s } = o;
  // Red fill of the overlap with the current selection = exactly what's cut.
  if (selection.length) {
    ctx.save();
    ctx.beginPath();
    for (const r of selection) ctx.rect(p.x + r.x * s, p.y + r.y * s, r.w * s, r.h * s);
    ctx.clip();
    ctx.beginPath();
    trace();
    ctx.fillStyle = "rgba(255, 64, 64, 0.22)";
    ctx.fill();
    ctx.restore();
  }
  // Red marching-ants outline of the whole region being dragged.
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass === 0 ? "rgba(255, 255, 255, 0.9)" : "#ff3b3b";
    ctx.lineDashOffset = -o.ants + (pass === 0 ? 0 : 4);
    ctx.beginPath();
    trace();
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
