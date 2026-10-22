// Lasso: freehand (drag a path), magnetic (the path's points snap to the
// strongest nearby edge) and polygonal (click the corners; Enter, a click back
// on the start or a double-click closes it). Ctrl adds the region to the
// selection, Alt subtracts it.

import { buildEdgeField, snapPoint, type EdgeField } from "../lib/magnetic";
import { drawSubtract, selectOp, type SelOp } from "./shared";
import type { Pt, ToolController, ToolHost } from "./types";

// Snap reach is SCREEN-space (like a cursor affordance): ~28 screen px of
// pull regardless of zoom, so a subject outlined at fit-to-screen zoom snaps
// from just as far as one at 100%. Clamped in doc px so extreme zooms stay sane.
const MAGNETIC_SCREEN_RADIUS = 28;

export interface LassoController extends ToolController {
  /** The polygon being clicked out (open until closed or dropped). */
  readonly poly: { current: { pts: Pt[]; op: SelOp } | null };
  /** Where the rubber band runs to: the pointer. */
  readonly polyHover: { current: Pt | null };
  /** Close the polygon and select it (Enter, a click on the start). */
  commitPolygon(h: ToolHost): void;
}

export function lassoTool(): LassoController {
  /** The freehand/magnetic path being dragged (doc px); closed on the lift. */
  let path: Pt[] | null = null;
  /** How it combines with the selection (set at the press). */
  let mode: SelOp = "new";
  const poly: LassoController["poly"] = { current: null };
  const polyHover: LassoController["polyHover"] = { current: null };
  // Magnetic: per-channel-Sobel edge field of the composite, built at stroke
  // start (downscaled to a cap so big documents stay fast). The detection +
  // snap logic is the pure lib magnetic.ts (Node-verified) — this only handles
  // readback, scaling and per-stroke state.
  let edgeMap: { field: EdgeField; sx: number; sy: number } | null = null;
  // Per-stroke snap context: the last SNAPPED point (field px + gradient
  // direction) for continuity/coherence, and the last RAW cursor for the
  // travel direction. Reset at stroke start.
  let magneticPrev: { x: number; y: number; theta: number } | null = null;
  let magneticRaw: Pt | null = null;

  /** Build the edge field from the flattened composite (capped resolution). */
  const buildEdgeMap = (h: ToolHost) => {
    const comp = h.engine.exportComposite(h.layers);
    const cap = 1400;
    const scale = Math.min(1, cap / Math.max(comp.width, comp.height, 1));
    const w = Math.max(4, Math.round(comp.width * scale));
    const ht = Math.max(4, Math.round(comp.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = ht;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(comp, 0, 0, w, ht);
    const d = cx.getImageData(0, 0, w, ht).data;
    edgeMap = { field: buildEdgeField(d, w, ht), sx: w / comp.width, sy: ht / comp.height };
    magneticPrev = null;
    magneticRaw = null;
  };

  /** Snap a doc-space point to the best nearby edge. The pure search
   *  (anisotropic band + continuity + orientation coherence) lives in
   *  magnetic.ts; here: coordinate scaling, the zoom-aware radius, and the
   *  per-stroke direction/previous-point context. */
  const snapToEdge = (h: ToolHost, pt: Pt) => {
    const m = edgeMap;
    if (!m) return pt;
    const fx = pt.x * m.sx;
    const fy = pt.y * m.sy;
    const docR = Math.max(10, Math.min(96, MAGNETIC_SCREEN_RADIUS / Math.max(0.05, h.zoom / 100)));
    const r = Math.max(4, Math.min(72, Math.round(docR * m.sx)));
    const raw = magneticRaw;
    const dirX = raw ? fx - raw.x * m.sx : undefined;
    const dirY = raw ? fy - raw.y * m.sy : undefined;
    const stepFree = raw ? Math.max(3, Math.hypot((pt.x - raw.x) * m.sx, (pt.y - raw.y) * m.sy)) : 8;
    const s = snapPoint(m.field, fx, fy, {
      r,
      dirX,
      dirY,
      prev: magneticPrev,
      stepFree,
    });
    magneticRaw = { x: pt.x, y: pt.y };
    if (s.snapped) magneticPrev = { x: s.x, y: s.y, theta: s.theta };
    return { x: s.x / m.sx, y: s.y / m.sy };
  };

  /** Select a closed region, as `op` says. */
  const select = (h: ToolHost, pts: Pt[], op: SelOp) => {
    const region = pts.length >= 3 ? h.engine.lassoSelect(pts) : null;
    if (region && region.rects.length) {
      if (op === "new") h.selection.set(region.rects, region.segments);
      else h.selection.combine(h.engine.combineSelection(h.selection.all, region.rects, op));
      return true;
    }
    return false;
  };

  /** Two points a click apart (8 screen px). */
  const near = (h: ToolHost, a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) * (h.zoom / 100) <= 8;

  const commitPolygon = (h: ToolHost) => {
    const pg = poly.current;
    poly.current = null;
    h.committable();
    polyHover.current = null;
    if (!pg) return;
    select(h, pg.pts, pg.op);
    h.redraw();
  };

  return {
    poly,
    polyHover,
    layer: "selection",
    commitPolygon,
    cursor: "crosshair",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat(); // merge before reselecting
      e.preventDefault();
      const p = h.toDoc(e);
      const variant = h.settings.lasso;
      if (variant === "poly") {
        // Click-point polygon: each click drops a vertex. A click back on the
        // start point closes it (so does a double-click, below). No pointer
        // capture — the cursor roams freely between clicks (rubber band tracks
        // it on move).
        const pg = poly.current;
        if (pg) {
          if (pg.pts.length >= 3 && near(h, p, pg.pts[0])) {
            commitPolygon(h);
            return;
          }
          pg.pts.push({ x: p.x, y: p.y });
        } else {
          poly.current = { pts: [{ x: p.x, y: p.y }], op: selectOp(e) };
          h.committable();
        }
        polyHover.current = { x: p.x, y: p.y };
        h.redraw();
        return;
      }
      // Freehand or magnetic: drag a path. Magnetic snaps points to edges, so
      // build the composite's edge map once at stroke start.
      h.capture(e);
      if (variant === "magnetic") buildEdgeMap(h);
      const start = variant === "magnetic" ? snapToEdge(h, p) : p;
      path = [start];
      mode = selectOp(e); // Ctrl adds, Alt subtracts, else new
      h.redraw();
    },
    // A polygon in progress: the rubber band follows the pointer.
    hover(cur, _e, h) {
      if (!poly.current) return;
      polyHover.current = cur;
      h.redraw();
      return true;
    },
    move(e, h) {
      if (!path) return false;
      const p = h.toDoc(e);
      const last = path[path.length - 1];
      // Add a point only after moving ~2 screen px, to keep the path light.
      const minD = 2 / (h.zoom / 100);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= minD) {
        // Magnetic: pin each new point to the strongest nearby edge.
        path.push(h.settings.lasso === "magnetic" ? snapToEdge(h, p) : { x: p.x, y: p.y });
      }
      h.redraw();
      return true;
    },
    up(e, h) {
      if (!path) return;
      const pts = path;
      path = null;
      edgeMap = null; // free the magnetic edge field
      magneticPrev = null;
      magneticRaw = null;
      h.release(e);
      // Close the polygon (straight start↔end edge) and rasterize it to a region,
      // then combine with the current selection (Ctrl-add / Alt-subtract).
      // A click / an empty lasso clears (plain only).
      if (!select(h, pts, mode) && mode === "new") h.selection.set([]);
      h.redraw();
    },
    // A double-click closes the polygon. Its two presses came first, and the
    // second dropped a corner on top of the first's: that one goes again.
    doubleClick(_e, h) {
      const pg = poly.current;
      if (!pg) return;
      const n = pg.pts.length;
      if (n >= 2 && near(h, pg.pts[n - 1], pg.pts[n - 2])) pg.pts.pop();
      commitPolygon(h);
    },
    // A pinch drops a dragged path. The polygon is a series of taps finished
    // with Enter, not a drag, so a pinch has no business ending it.
    cancel() {
      path = null;
    },
    drawOverlay(o, h) {
      const { ctx, p, s } = o;
      // The freeform path, auto-closed start↔end (a subtracting one is drawn in
      // red, below).
      const lasso = path;
      if (lasso && lasso.length && mode !== "subtract") {
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
          ctx.lineDashOffset = -o.ants + (pass === 0 ? 0 : 4);
          ctx.beginPath();
          ctx.moveTo(p.x + lasso[0].x * s, p.y + lasso[0].y * s);
          for (let i = 1; i < lasso.length; i++) ctx.lineTo(p.x + lasso[i].x * s, p.y + lasso[i].y * s);
          ctx.closePath(); // straight shortest-distance edge back to the start
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // The polygon in progress: committed edges + rubber-band to the pointer,
      // with a vertex handle on each point. Subtracting draws red.
      const pg = poly.current;
      if (pg && pg.pts.length) {
        const sub = pg.op === "subtract";
        const hover = polyHover.current;
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(p.x + pg.pts[0].x * s, p.y + pg.pts[0].y * s);
          for (let i = 1; i < pg.pts.length; i++) {
            ctx.lineTo(p.x + pg.pts[i].x * s, p.y + pg.pts[i].y * s);
          }
          if (hover) ctx.lineTo(p.x + hover.x * s, p.y + hover.y * s); // rubber band
        };
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : sub ? "#ff3b3b" : "#fff";
          ctx.lineDashOffset = -o.ants + (pass === 0 ? 0 : 4);
          trace();
          ctx.stroke();
        }
        ctx.setLineDash([]);
        // Vertex handles — filled dots, larger + accented on the start point.
        for (let i = 0; i < pg.pts.length; i++) {
          const vx = p.x + pg.pts[i].x * s;
          const vy = p.y + pg.pts[i].y * s;
          const r = i === 0 ? 4 : 3;
          ctx.beginPath();
          ctx.arc(vx, vy, r, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? "#fff" : "rgba(255,255,255,0.9)";
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }
      }
      // Subtracting (Alt): the region being removed, in red.
      if (lasso && lasso.length && mode === "subtract") {
        drawSubtract(o, h.selection.all, () => {
          ctx.moveTo(p.x + lasso[0].x * s, p.y + lasso[0].y * s);
          for (let i = 1; i < lasso.length; i++) ctx.lineTo(p.x + lasso[i].x * s, p.y + lasso[i].y * s);
          ctx.closePath();
        });
      }
    },
    wantsOverlay: () => !!(path || poly.current),
    busy: () => path !== null,
  };
}
