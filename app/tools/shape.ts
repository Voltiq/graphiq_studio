// Shape: drag out a shape (Shift: 1:1). It stays live — editable from the
// options bar, and transformed by its selection's handles — and its nodes (a
// trapezoid's sides, a triangle's apex, a star's spoke and waist, a rectangle's
// corner radius) are dragged to reshape it, snapping to the values worth
// hitting exactly. The live shape itself is CanvasArea's (h.shape).

import { clamp } from "../lib/color";
import { renderShape, sanitizeStar, starCollinearInner, STAR_DEFAULT } from "../lib/shapes";
import { normalizeRect, type Rect } from "../lib/view";
import type { Pt, ShapeNode, ToolController } from "./types";

export interface ShapeController extends ToolController {
  /** Where the shape being dragged out began. */
  readonly start: { current: Pt | null };
  /** The node being dragged, and whether it has snapped (its guides show). */
  readonly node: { current: ShapeNode | null };
  readonly snapped: { current: boolean };
}

export function shapeTool(): ShapeController {
  const start: ShapeController["start"] = { current: null };
  const node: ShapeController["node"] = { current: null };
  const snapped: ShapeController["snapped"] = { current: false };
  /** The box dragged out so far (doc px). */
  let box: Rect | null = null;
  return {
    start,
    node,
    snapped,
    layer: "shape",
    transformsSelection: true,
    cursor: "crosshair",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat();
      const p = h.toDoc(e);
      // Grab a shape node (trapezoid side / triangle apex) to reshape it live.
      const hit = h.shape.nodeAt(p);
      if (hit) {
        e.preventDefault();
        h.capture(e);
        node.current = hit;
        h.setCursor("grabbing");
        return;
      }
      // Grab a handle on the just-drawn shape's selection to transform it.
      if (h.transform.start(e, p)) return;
      h.engine.endShape(); // commit any previous live shape before drawing a new one
      e.preventDefault();
      h.capture(e);
      h.shape.fresh(); // a new shape starts symmetric, centred and upright
      start.current = { x: p.x, y: p.y };
      box = { x: p.x, y: p.y, w: 0, h: 0 };
      h.redraw();
    },
    // Over its selection: what a press would do (a node takes priority).
    hover(_cur, e, h) {
      h.transform.hoverCursor(e);
    },
    move(e, h) {
      if (node.current) {
        const live = h.shape.live.current;
        if (!live) {
          node.current = null;
          return true;
        }
        const lb = live.box;
        const p = h.toDoc(e);
        const ang = h.selection.angle;
        const piv = h.selection.pivot ?? { x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 };
        // Work in the shape's local (un-rotated) frame; only the x-position matters.
        let lx = p.x;
        if (ang) {
          const c = Math.cos(-ang);
          const sn = Math.sin(-ang);
          lx = piv.x + (p.x - piv.x) * c - (p.y - piv.y) * sn;
        }
        const sc = h.zoom / 100;
        const SNAP_PX = h.settings.snapDistance; // Preferences ▸ Guides & grid

        let hit = false;
        const n = node.current;
        if (n === "starOuter" || n === "starInner") {
          // Both star nodes are POLAR drags about the box centre, which is what
          // makes them feel like the same widget: the outer one carries the
          // angle, the inner one the radius. Local frame throughout, so a rotated
          // selection behaves identically.
          let ly = p.y;
          if (ang) {
            const c = Math.cos(-ang);
            const sn = Math.sin(-ang);
            ly = piv.y + (p.x - piv.x) * sn + (p.y - piv.y) * c;
          }
          const cx = lb.x + lb.w / 2;
          const cy = lb.y + lb.h / 2;
          const st = { ...h.shape.star.current, points: h.shape.opts.starPoints ?? STAR_DEFAULT.points };
          if (n === "starOuter") {
            // Rotation: the angle from the centre, with 0 = straight up. Snapped
            // to 15° so the common orientations are easy to hit exactly.
            let deg = (Math.atan2(ly - cy, lx - cx) * 180) / Math.PI + 90;
            const step = 15;
            const nearest = Math.round(deg / step) * step;
            if (Math.abs(deg - nearest) < 4) {
              deg = nearest;
              hit = true;
            }
            h.shape.star.current = sanitizeStar({ ...st, angle: deg });
          } else {
            // Waist: the pointer's distance from the centre as a fraction of the
            // outer radius — measured in the box's ELLIPTICAL units, so a wide
            // box's waist tracks the pointer just as a square one's does.
            const rx = Math.max(1e-6, lb.w / 2);
            const ry = Math.max(1e-6, lb.h / 2);
            let frac = Math.hypot((lx - cx) / rx, (ly - cy) / ry);
            // Snap to the proper-star ratio (a pentagram at 5 points) and to half.
            const targets = [starCollinearInner(st.points), 0.5].filter((t): t is number => t !== null);
            for (const t of targets) {
              if (Math.abs(frac - t) * Math.min(rx, ry) * sc < SNAP_PX) {
                frac = t;
                hit = true;
                break;
              }
            }
            h.shape.star.current = sanitizeStar({ ...st, inner: frac });
          }
        } else if (n === "radius") {
          // Corner radius: how far along the top edge the node has been pulled.
          const maxR = Math.min(lb.w, lb.h) / 2;
          let r = clamp(lx - lb.x, 0, maxR);
          if (r * sc < SNAP_PX) {
            r = 0; // square corners are a value worth being able to hit exactly
            hit = true;
          } else if ((maxR - r) * sc < SNAP_PX) {
            r = maxR; // ...and so is fully round
            hit = true;
          }
          h.shape.setRadius(Math.round(r));
        } else if (n === "apex") {
          // Triangle apex: slide along the top edge, snapping to centre (isosceles).
          let a = clamp((lx - lb.x) / lb.w, 0, 1);
          if (Math.abs(a - 0.5) * lb.w * sc < SNAP_PX) {
            a = 0.5;
            hit = true;
          }
          h.shape.apex.current = a;
        } else {
          const t = { ...h.shape.trap.current };
          if (n === "l") {
            let l = clamp((lx - lb.x) / lb.w, 0, 0.5);
            if (Math.abs(l - t.r) * lb.w * sc < SNAP_PX) {
              l = t.r; // snap to symmetry
              hit = true;
            }
            t.l = l;
          } else {
            let r = clamp((lb.x + lb.w - lx) / lb.w, 0, 0.5);
            if (Math.abs(r - t.l) * lb.w * sc < SNAP_PX) {
              r = t.l;
              hit = true;
            }
            t.r = r;
          }
          h.shape.trap.current = t;
        }
        snapped.current = hit;
        h.shape.schedule();
        h.redraw();
        return true;
      }
      const s0 = start.current;
      if (!s0) return false;
      const p = h.toDoc(e);
      let ex = p.x;
      let ey = p.y;
      if (e.shiftKey) {
        // Constrain to 1:1 (square / circle / equilateral), keeping drag direction.
        const sz = Math.max(Math.abs(p.x - s0.x), Math.abs(p.y - s0.y));
        ex = s0.x + (p.x < s0.x ? -sz : sz);
        ey = s0.y + (p.y < s0.y ? -sz : sz);
      }
      box = normalizeRect(s0.x, s0.y, ex, ey, h.doc.width, h.doc.height);
      h.redraw();
      return true;
    },
    up(e, h) {
      if (node.current) {
        node.current = null;
        snapped.current = false; // guides only show during the snapped drag
        h.release(e);
        h.setCursor(h.shape.nodeAt(h.toDoc(e)) ? "grab" : null);
        h.redraw();
        return;
      }
      if (!start.current) return;
      const rect = box;
      start.current = null;
      box = null;
      h.release(e);
      if (rect && rect.w >= 1 && rect.h >= 1) {
        // Drawn as a "live" shape: still editable (colour/stroke/radius, and the
        // trapezoid's side nodes) while its selection is up, and resizable /
        // rotatable via the handles.
        const b: Rect = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.w),
          h: Math.round(rect.h),
        };
        h.shape.place(h.ensureLayer(), b); // its box (`b` itself) becomes the selection: it names the shape
      }
      h.redraw();
    },
    // A pinch drops the shape being dragged out, and a node drag.
    cancel() {
      start.current = null;
      box = null;
      node.current = null;
    },
    // The shape being dragged out, filled and stroked.
    drawOverlay(o, h) {
      const b = start.current ? box : null;
      if (!b || !(b.w > 0 || b.h > 0)) return;
      const { ctx, p, s } = o;
      const so = h.shape.opts;
      const screenBox = { x: p.x + b.x * s, y: p.y + b.y * s, w: b.w * s, h: b.h * s };
      ctx.save();
      renderShape(
        ctx,
        so.kind,
        screenBox,
        so.fill,
        so.stroke,
        so.strokeWidth * s,
        so.radius * s,
        h.shape.geom(so.kind),
      );
      ctx.restore();
    },
    wantsOverlay: () => !!start.current,
    busy: () => start.current !== null || node.current !== null,
  };
}
