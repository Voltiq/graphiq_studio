// The Pen and Direct selection: two tools editing one live path. The Pen
// clicks anchors (drag one out to give it handles), closes the path on its
// first anchor, and grabs a handle or an anchor to edit; Direct selection
// picks anchors (Shift adds, a marquee gathers, a click on the path takes it
// all), drags them, and — with Alt — turns a point between corner and smooth,
// or inserts one on a segment. The live path itself, and finishing it, are
// CanvasArea's (h.path): the keyboard and the Paths panel reach it too.

import { anchorsInRect, dragHandle, hitTest, insertAnchor, moveAnchors, toggleSmooth } from "../lib/path-edit";
import type { PenAnchor } from "../lib/tools";
import { shapeNodeColor } from "./shared";
import type { Pt, ToolController, ToolHost, ToolPointer } from "./types";

/** A fresh pen anchor as a "corner" (both bezier handles sit on the point). */
export function makeAnchor(x: number, y: number): PenAnchor {
  return { x, y, ix: x, iy: y, ox: x, oy: y };
}

// Minimum on-screen length a pen handle is drawn at, so handles stay visible /
// grabbable on every anchor at any zoom (even when retracted onto the point).
const PEN_HANDLE_MIN_PX = 24;

/** Does an anchor have an outgoing / incoming segment (so its handle matters)? */
export function penHasOut(i: number, n: number, closed: boolean) {
  return closed || i < n - 1;
}
export function penHasIn(i: number, n: number, closed: boolean) {
  return closed || i > 0;
}

/**
 * The doc-space DISPLAY position of an anchor handle: its real control point when
 * pulled out far enough, otherwise a stub of length PEN_HANDLE_MIN_PX (screen) in
 * the handle's direction — or, if retracted, along the local path tangent. `s` is
 * the zoom scale. Used for both drawing and hit-testing so they always agree.
 */
export function penHandlePos(
  anchors: PenAnchor[],
  i: number,
  closed: boolean,
  isOut: boolean,
  s: number,
): { x: number; y: number } {
  const a = anchors[i];
  let dx = (isOut ? a.ox : a.ix) - a.x;
  let dy = (isOut ? a.oy : a.iy) - a.y;
  let len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    dx /= len;
    dy /= len;
  } else {
    // Retracted → point along the local tangent (toward the next/prev anchor).
    const n = anchors.length;
    const prev = i > 0 ? anchors[i - 1] : closed ? anchors[n - 1] : null;
    const next = i < n - 1 ? anchors[i + 1] : closed ? anchors[0] : null;
    let tx = 1;
    let ty = 0;
    if (prev && next) {
      tx = next.x - prev.x;
      ty = next.y - prev.y;
    } else if (next) {
      tx = next.x - a.x;
      ty = next.y - a.y;
    } else if (prev) {
      tx = a.x - prev.x;
      ty = a.y - prev.y;
    }
    const tl = Math.hypot(tx, ty) || 1;
    dx = (isOut ? tx : -tx) / tl;
    dy = (isOut ? ty : -ty) / tl;
    len = 0;
  }
  const docLen = Math.max(len, PEN_HANDLE_MIN_PX / Math.max(s, 1e-6));
  return { x: a.x + dx * docLen, y: a.y + dy * docLen };
}


export interface PathTools {
  pen: ToolController;
  directSelect: ToolController;
  /** The Pen's drag: a new anchor's handle, an existing anchor or handle. */
  readonly penDrag: { current: { kind: "new" | "anchor" | "in" | "out"; index: number } | null };
  /** Where an anchor drag began, and the anchor then. */
  readonly penGrab: { current: { px: number; py: number; anchor: PenAnchor } | null };
  /** Direct selection's drag: the picked anchors, or one handle. */
  readonly dsDrag: { current: { kind: "anchors" | "in" | "out"; index: number; px: number; py: number } | null };
  /** Direct selection's marquee, gathering anchors. */
  readonly dsMarquee: { current: { x0: number; y0: number; x1: number; y1: number } | null };
}

/** The active path's anchor or handle under `p` (handles take priority, hit
 *  at their displayed — stub — positions so even retracted ones can be grabbed). */
export function penHitAt(h: ToolHost, p: Pt): { kind: "anchor" | "in" | "out"; index: number } | null {
  const path = h.path.current.current;
  if (!path) return null;
  const s = h.zoom / 100;
  const r = 8 / s;
  const near = (ax: number, ay: number) => Math.hypot(p.x - ax, p.y - ay) <= r;
  const a = path.anchors;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    if (penHasOut(i, n, path.closed)) {
      const out = penHandlePos(a, i, path.closed, true, s);
      if (near(out.x, out.y)) return { kind: "out", index: i };
    }
    if (penHasIn(i, n, path.closed)) {
      const inn = penHandlePos(a, i, path.closed, false, s);
      if (near(inn.x, inn.y)) return { kind: "in", index: i };
    }
  }
  for (let i = 0; i < n; i++) if (near(a[i].x, a[i].y)) return { kind: "anchor", index: i };
  return null;
}

export function createPathTools(): PathTools {
  const penDrag: PathTools["penDrag"] = { current: null };
  const penGrab: PathTools["penGrab"] = { current: null };
  const dsDrag: PathTools["dsDrag"] = { current: null };
  const dsMarquee: PathTools["dsMarquee"] = { current: null };

  /** The rest of either tool's gesture: both edit the one path. */
  const session = {
    move(e: ToolPointer, h: ToolHost): boolean {
      const path = h.path.current.current;
      if (dsMarquee.current) {
        const p = h.toDoc(e);
        dsMarquee.current.x1 = p.x;
        dsMarquee.current.y1 = p.y;
        h.redraw();
        return true;
      }
      if (dsDrag.current && path) {
        const p = h.toDoc(e);
        const d = dsDrag.current;
        if (d.kind === "anchors") {
          path.anchors = moveAnchors(path.anchors, h.path.picked.current, p.x - d.px, p.y - d.py);
        } else {
          path.anchors = dragHandle(path.anchors, d.index, d.kind, p, e.altKey);
        }
        d.px = p.x;
        d.py = p.y;
        h.path.render();
        h.redraw();
        return true;
      }
      if (penDrag.current && path) {
        const p = h.toDoc(e);
        const d = penDrag.current;
        const a = path.anchors[d.index];
        // By default the opposite handle mirrors for a smooth anchor; holding Shift
        // breaks the symmetry so only the dragged handle moves (an independent corner).
        const mirror = !e.shiftKey;
        if (d.kind === "new" || d.kind === "out") {
          a.ox = p.x;
          a.oy = p.y;
          if (mirror) {
            a.ix = 2 * a.x - p.x;
            a.iy = 2 * a.y - p.y;
          }
        } else if (d.kind === "in") {
          a.ix = p.x;
          a.iy = p.y;
          if (mirror) {
            a.ox = 2 * a.x - p.x;
            a.oy = 2 * a.y - p.y;
          }
        } else {
          // Move the whole anchor (point + both handles) by the drag delta.
          const g = penGrab.current;
          if (g) {
            const dx = p.x - g.px;
            const dy = p.y - g.py;
            a.x = g.anchor.x + dx;
            a.y = g.anchor.y + dy;
            a.ix = g.anchor.ix + dx;
            a.iy = g.anchor.iy + dy;
            a.ox = g.anchor.ox + dx;
            a.oy = g.anchor.oy + dy;
          }
        }
        h.path.render();
        h.redraw();
        return true;
      }
      return false;
    },
    up(e: ToolPointer, h: ToolHost) {
      const dsm = dsMarquee.current;
      if (dsm) {
        const path = h.path.current.current;
        if (path) {
          for (const i of anchorsInRect(path.anchors, {
            x: dsm.x0,
            y: dsm.y0,
            w: dsm.x1 - dsm.x0,
            h: dsm.y1 - dsm.y0,
          }))
            h.path.picked.current.add(i);
        }
        dsMarquee.current = null;
        h.redraw();
      }
      if (dsDrag.current) {
        dsDrag.current = null;
        h.path.render();
        h.redraw();
      }
      if (penDrag.current) {
        // Finish this anchor/handle drag; the path stays live until committed.
        penDrag.current = null;
        penGrab.current = null;
        h.release(e);
        h.redraw();
      }
    },
    // A pinch ends a drag; the PATH survives — it is finished with the ✓, not
    // by lifting a finger.
    cancel() {
      penDrag.current = null;
      penGrab.current = null;
      dsDrag.current = null;
      dsMarquee.current = null;
    },
    busy: () => !!(penDrag.current || dsDrag.current || dsMarquee.current),
  };

  const pen: ToolController = {
    ...session,
    layer: "path",
    cursor: "crosshair",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      const path = h.path.current.current;
      if (path) {
        const hit = penHitAt(h, p);
        if (hit) {
          // Clicking the first anchor closes the path; otherwise grab to edit.
          if (hit.kind === "anchor" && hit.index === 0 && !path.closed && path.anchors.length >= 2) {
            path.closed = true;
            h.path.render();
            h.redraw();
            return;
          }
          penDrag.current = hit;
          penGrab.current = { px: p.x, py: p.y, anchor: { ...path.anchors[hit.index] } };
          return;
        }
        if (path.closed) {
          h.engine.endPath(); // a closed path is complete → start a fresh one
        } else {
          // Extend the path with a new anchor (corner; drag to give it handles).
          path.anchors.push(makeAnchor(p.x, p.y));
          penDrag.current = { kind: "new", index: path.anchors.length - 1 };
          h.path.render();
          h.redraw();
          return;
        }
      }
      // Start a new path at the first anchor.
      h.path.current.current = {
        anchors: [makeAnchor(p.x, p.y)],
        closed: false,
        layerId: h.ensureLayer(),
      };
      h.committable();
      penDrag.current = { kind: "new", index: 0 };
      h.redraw();
    },
    // Direct selection's marquee, then the path's skeleton with its anchors and
    // handles — drawn whatever tool is selected (the path stays live).
    drawOverlay(o, h) {
      const { ctx, p, s } = o;
      const dsm = dsMarquee.current;
      if (dsm) {
        const rx = p.x + Math.min(dsm.x0, dsm.x1) * s;
        const ry = p.y + Math.min(dsm.y0, dsm.y1) * s;
        const rw = Math.abs(dsm.x1 - dsm.x0) * s;
        const rh = Math.abs(dsm.y1 - dsm.y0) * s;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineDashOffset = 4;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.lineDashOffset = 0;
        ctx.setLineDash([]);
      }
      const path = h.path.current.current;
      if (!path || !path.anchors.length) return;
      const sx = (x: number) => p.x + x * s;
      const sy = (y: number) => p.y + y * s;
      const a = path.anchors;
      ctx.setLineDash([]);
      // Skeleton: the bezier path through the anchors (dark underlay + white).
      if (a.length >= 2) {
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(sx(a[0].x), sy(a[0].y));
          for (let i = 1; i < a.length; i++) {
            ctx.bezierCurveTo(
              sx(a[i - 1].ox),
              sy(a[i - 1].oy),
              sx(a[i].ix),
              sy(a[i].iy),
              sx(a[i].x),
              sy(a[i].y),
            );
          }
          if (path.closed) {
            const f = a[0];
            const l = a[a.length - 1];
            ctx.bezierCurveTo(sx(l.ox), sy(l.oy), sx(f.ix), sy(f.iy), sx(f.x), sy(f.y));
          }
        };
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        trace();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = shapeNodeColor();
        trace();
        ctx.stroke();
      }
      // Bend handles: shown on EVERY anchor at all times — at the control point
      // when pulled out, otherwise as a fixed-length stub along the path tangent —
      // with a dark underlay + bright line + a dot, so they stay visible and
      // grabbable on any background and at any zoom level.
      for (let i = 0; i < a.length; i++) {
        const an = a[i];
        for (const isOut of [false, true]) {
          if (isOut ? !penHasOut(i, a.length, path.closed) : !penHasIn(i, a.length, path.closed)) {
            continue;
          }
          const hp = penHandlePos(a, i, path.closed, isOut, s);
          const ax = sx(an.x);
          const ay = sy(an.y);
          const bx = sx(hp.x);
          const by = sy(hp.y);
          for (const [w, col] of [
            [3, "rgba(0,0,0,0.45)"],
            [1, "rgba(255,255,255,0.95)"],
          ] as const) {
            ctx.lineWidth = w;
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(bx, by, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.stroke();
        }
      }
      // Anchor circles: white with a blue outline matching the path skeleton; the
      // first one is larger to show where clicking closes the path. Under Direct
      // Selection the SELECTED points are filled instead of hollow, which is the
      // only way to tell what a drag is about to move.
      a.forEach((an, i) => {
        const r = i === 0 && !path.closed && a.length >= 2 ? 6 : 5;
        const picked = h.tool === "directselect" && h.path.picked.current.has(i);
        ctx.beginPath();
        ctx.arc(sx(an.x), sy(an.y), r, 0, Math.PI * 2);
        ctx.fillStyle = picked ? shapeNodeColor() : "#fff";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = shapeNodeColor();
        ctx.stroke();
      });
    },
    wantsOverlay: (_selected, h) => !!(h.path.current.current || dsMarquee.current),
    // A double-click finishes (commits) the live path.
    doubleClick(_e, h) {
      if (h.path.current.current) h.path.finish();
    },
  };

  const directSelect: ToolController = {
    ...session,
    down(e, h) {
      const path = h.path.current.current;
      if (!path) return; // nothing loaded — pick a path in the Paths panel
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      const tol = h.grab(8);
      const sel = h.path.picked.current;
      const hit = hitTest(path.anchors, path.closed, p, tol, sel);

      if (hit?.kind === "anchor") {
        if (e.altKey) {
          // Alt on a point flips it between corner and smooth — the one edit
          // that changes the CURVE rather than moving something.
          path.anchors = toggleSmooth(path.anchors, path.closed, hit.index);
          sel.clear();
          sel.add(hit.index);
        } else if (e.shiftKey) {
          if (sel.has(hit.index)) sel.delete(hit.index);
          else sel.add(hit.index);
        } else if (!sel.has(hit.index)) {
          sel.clear();
          sel.add(hit.index);
        }
        dsDrag.current = { kind: "anchors", index: hit.index, px: p.x, py: p.y };
      } else if (hit?.kind === "in" || hit?.kind === "out") {
        dsDrag.current = { kind: hit.kind, index: hit.index, px: p.x, py: p.y };
      } else if (hit?.kind === "segment") {
        if (e.altKey) {
          // Alt on a segment inserts a point there, without moving the curve.
          path.anchors = insertAnchor(path.anchors, path.closed, hit.index, hit.t);
          sel.clear();
          sel.add(hit.index + 1);
        } else {
          // Clicking the path itself selects the whole thing, as in Illustrator.
          sel.clear();
          for (let i = 0; i < path.anchors.length; i++) sel.add(i);
        }
      } else {
        if (!e.shiftKey) sel.clear();
        dsMarquee.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      h.path.render();
      h.redraw();
    },
  };

  return { pen, directSelect, penDrag, penGrab, dsDrag, dsMarquee };
}
