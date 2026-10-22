// Rectangular / elliptical / triangular marquee: drag out a region; Ctrl adds
// it to the selection, Alt subtracts it, Shift makes it 1:1. A plain press on
// the selection's own handles or ring transforms it instead (CanvasArea's
// shared transform, h.transform).

import type { MarqueeShape } from "../lib/tools";
import { normalizeRect, type Rect } from "../lib/view";
import { drawSubtract, selectOp, type SelOp } from "./shared";
import type { ToolController } from "./types";

/** Decompose a marquee region into per-row scanline rects (ellipse / triangle),
 *  or a single rect. Fed to the engine's mask-based combine for a clean selection.
 *  `pointDown` flips the triangle's apex to the bottom (when dragged downward);
 *  `apex` is the apex's horizontal position as a fraction of width (0.5 = centred). */
export function marqueeSelRects(b: Rect, shape: MarqueeShape, pointDown = false, apex = 0.5): Rect[] {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const w = Math.round(b.w);
  const h = Math.round(b.h);
  if (w < 1 || h < 1) return [];
  if (shape === "rect") return [{ x, y, w, h }];
  const out: Rect[] = [];
  if (shape === "ellipse") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    for (let i = 0; i < h; i++) {
      const dy = (y + i + 0.5 - cy) / ry;
      if (Math.abs(dy) >= 1) continue;
      const dx = rx * Math.sqrt(1 - dy * dy);
      const left = Math.round(cx - dx);
      const right = Math.round(cx + dx);
      if (right > left) out.push({ x: left, y: y + i, w: right - left, h: 1 });
    }
  } else {
    // Triangle: apex on the top edge at `apex` (or the bottom edge, when pointDown),
    // base across the opposite edge. Each row's span interpolates the two slanted
    // edges from the apex toward the base, so the apex offset slants the triangle.
    const ax = x + apex * w;
    for (let i = 0; i < h; i++) {
      const t = pointDown ? (h - i) / h : (i + 1) / h;
      const left = Math.round(ax + (x - ax) * t);
      const right = Math.round(ax + (x + w - ax) * t);
      if (right > left) out.push({ x: left, y: y + i, w: right - left, h: 1 });
    }
  }
  return out;
}

export interface MarqueeController extends ToolController {
  /** Where the drag began (the anchor corner, snapped) and how it combines.
   *  The selection's outline reads it: a plain rectangle being dragged out IS
   *  the selection-to-be, drawn through the ants. */
  readonly anchor: { current: { x: number; y: number; mode: SelOp } | null };
  /** The region dragged out so far (doc px). */
  readonly rect: { current: Rect | null };
}

export function marqueeTool(): MarqueeController {
  const anchor: MarqueeController["anchor"] = { current: null };
  const rect: MarqueeController["rect"] = { current: null };
  return {
    anchor,
    rect,
    layer: "selection",
    transformsSelection: true,
    cursor: "crosshair",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat(); // merge before reselecting
      const p = h.toDoc(e);
      const op = selectOp(e);
      // Plain drag may grab a transform handle; Ctrl-add / Alt-subtract and a
      // Shift (1:1-constrained) drag always start a fresh marquee.
      if (op === "new" && !e.shiftKey && h.transform.start(e, p)) return;
      e.preventDefault();
      h.capture(e);
      // Snap the anchor corner too — a marquee that snaps only on release would
      // start half a pixel off the guide it was clearly aimed at.
      const a = h.snap.begin(p.x, p.y, e.ctrlKey || e.metaKey);
      anchor.current = { x: a.x, y: a.y, mode: op };
      rect.current = { x: a.x, y: a.y, w: 0, h: 0 };
      h.redraw();
    },
    // Over the selection: the cursor for what a press there would do.
    hover(_cur, e, h) {
      h.transform.hoverCursor(e);
    },
    move(e, h) {
      const m = anchor.current;
      if (!m) return false;
      const { width, height } = h.doc;
      const p = h.toDoc(e);
      let px = p.x;
      let py = p.y;
      if (e.shiftKey) {
        // Shift constrains to a 1:1 box (square / circle / symmetric triangle).
        const sx = Math.sign(px - m.x) || 1;
        const sy = Math.sign(py - m.y) || 1;
        let side = Math.max(Math.abs(px - m.x), Math.abs(py - m.y));
        // Keep the square inside the canvas so the edge can't clamp it out of square.
        side = Math.min(
          side,
          Math.max(0, sx > 0 ? width - m.x : m.x),
          Math.max(0, sy > 0 ? height - m.y : m.y),
        );
        px = m.x + sx * side;
        py = m.y + sy * side;
      }
      // The free corner snaps to guides / canvas / layer edges (Shift's 1:1
      // constraint wins — a snapped square would stop being square).
      if (!e.shiftKey) {
        const s = h.snap.point(px, py, e.ctrlKey || e.metaKey);
        px = s.x;
        py = s.y;
      }
      const dr = normalizeRect(m.x, m.y, px, py, width, height);
      // Snap selections to whole pixels when Snap is on.
      rect.current = h.settings.snapPixels
        ? { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.w), h: Math.round(dr.h) }
        : dr;
      return true;
    },
    up(e, h) {
      const a = anchor.current;
      if (!a) return;
      const mode = a.mode;
      const r = rect.current;
      anchor.current = null;
      rect.current = null;
      h.snap.end();
      h.selection.triangle(null); // a new marquee op supersedes any live triangle
      const { shape, apex } = h.settings.marquee;
      if (r && r.w >= 1 && r.h >= 1) {
        if (mode === "new" && shape === "rect") {
          h.selection.set([r]); // plain replace — a single rect needs no tracing
        } else {
          // Rasterize the region (rect / ellipse / triangle) and mask-combine so the
          // engine hands back a clean, pre-traced selection. Routing add/subtract
          // through here — rather than [...selection, rect] — keeps it fast even when
          // the existing selection is a many-rect ellipse/triangle: a plain concat
          // would make the next repaint run an O(n³) unionSegments over the union.
          // A triangle dragged downward (anchor at the top) points its apex down.
          const pointDown = a.y <= r.y + r.h / 2;
          const sel = marqueeSelRects(r, shape, pointDown, apex);
          const base = mode === "new" ? [] : h.selection.all;
          const result = h.engine.combineSelection(base, sel, mode === "subtract" ? "subtract" : "add");
          h.selection.combine(result);
          // Remember a freshly-made triangle so the Apex slider can re-shape it.
          if (shape === "triangle" && result && result.rects.length) {
            h.selection.triangle({ box: r, pointDown, base, mode, key: result.rects });
          }
        }
      } else if (mode === "new") {
        h.selection.set([]); // a plain click clears the selection
      }
      h.release(e);
    },
    cancel() {
      anchor.current = null;
      rect.current = null;
    },
    drawOverlay(o, h) {
      const m = anchor.current;
      const mdr = rect.current;
      if (!m || !mdr) return;
      const { ctx, p, s } = o;
      const shape = h.settings.marquee.shape;
      // The region in progress: a dashed outline of the new region, drawn
      // separately from the existing ants. Ellipse/triangle marquees always use
      // this (any mode); an additive rectangle uses it too (a "new" rectangle is
      // drawn through the ants; a subtracted one shows in red below).
      if ((shape !== "rect" || m.mode === "add") && mdr.w >= 1 && mdr.h >= 1) {
        const sx = (x: number) => p.x + x * s;
        const sy = (y: number) => p.y + y * s;
        // Apex points toward the drag direction: down when the anchor (initial click)
        // sits at the top of the box (i.e. dragged downward), up otherwise.
        const triDown = m.y <= mdr.y + mdr.h / 2;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
          ctx.lineDashOffset = -o.ants + (pass === 0 ? 0 : 4);
          ctx.beginPath();
          if (shape === "ellipse") {
            ctx.ellipse(
              sx(mdr.x + mdr.w / 2),
              sy(mdr.y + mdr.h / 2),
              (mdr.w / 2) * s,
              (mdr.h / 2) * s,
              0,
              0,
              Math.PI * 2,
            );
          } else if (shape === "triangle") {
            const apexX = sx(mdr.x + h.settings.marquee.apex * mdr.w);
            if (triDown) {
              ctx.moveTo(sx(mdr.x), sy(mdr.y)); // top-left
              ctx.lineTo(sx(mdr.x + mdr.w), sy(mdr.y)); // top-right
              ctx.lineTo(apexX, sy(mdr.y + mdr.h)); // bottom apex
            } else {
              ctx.moveTo(apexX, sy(mdr.y)); // top apex
              ctx.lineTo(sx(mdr.x + mdr.w), sy(mdr.y + mdr.h)); // bottom-right
              ctx.lineTo(sx(mdr.x), sy(mdr.y + mdr.h)); // bottom-left
            }
            ctx.closePath();
          } else {
            ctx.rect(sx(mdr.x), sy(mdr.y), mdr.w * s, mdr.h * s); // additive rectangle
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // Subtracting (Alt): the region being removed, in red.
      if (m.mode === "subtract") {
        drawSubtract(o, h.selection.all, () => ctx.rect(p.x + mdr.x * s, p.y + mdr.y * s, mdr.w * s, mdr.h * s));
      }
    },
    wantsOverlay: () => !!rect.current,
    busy: () => anchor.current !== null,
  };
}
