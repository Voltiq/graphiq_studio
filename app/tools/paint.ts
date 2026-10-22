// The paint brushes: Brush, Pencil and Eraser (one controller — they differ
// only in the stroke they ask for), the History brush and the Clone stamp.
//
// They share the engine's two sessions, so they share their state too: a brush
// stroke and a clone stroke are both the engine's STROKE (fed and ended
// alike), and the History brush and the Eraser's Erase to History are both its
// HISTORY session. Whichever began it, the same lift ends it.

import type { StrokeStep } from "../lib/actions";
import type { BrushSettings } from "../lib/paint";
import { confined } from "./shared";
import type { Pt, ToolController, ToolHost, ToolPointer } from "./types";

/** True when this pen contact is the stylus's ERASER end (barrel bit 5). */
const isEraserTip = (e: ToolPointer): boolean => e.pointerType === "pen" && (e.buttons & 32) !== 0;

export function createPaintTools() {
  /** The engine's stroke is open: a brush, pencil, eraser or clone stroke. */
  let painting = false;
  /** The engine's history session is open: the History brush, Erase to History. */
  let historying = false;
  /** The Actions recorder's copy of the stroke (null: not recording). */
  let rec: StrokeStep | null = null;
  /** Where each ring is (doc px); null = not over the canvas. */
  let paintHover: Pt | null = null;
  let historyHover: Pt | null = null;
  let cloneHover: Pt | null = null;
  /** The clone source (Alt-click), and the live source → pointer offset. */
  let src: Pt | null = null;
  let off: Pt | null = null;
  /* Offset from the pointer to the clone source while it is being dragged —
     the same shape as the Eyedropper's placement grab, and for the same reason:
     a source held at the finger's own position is a source under the finger. */
  let grab: { dx: number; dy: number } | null = null;
  /** Alt is held: the ring is the "set source" reticle. */
  let alt = false;

  /** Actions recorder: thin the stroke path to ≥0.75 doc px between points. */
  const record = (p: Pt) => {
    if (!rec) return;
    const last = rec.points[rec.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.75) rec.points.push({ x: p.x, y: p.y });
  };

  /** What every one of them does with the rest of a gesture. */
  const session = {
    move(e: ToolPointer, h: ToolHost): boolean {
      if (historying) {
        const p = h.toDoc(e);
        h.engine.moveHistory(p.x, p.y);
        return true;
      }
      if (!painting) return false;
      const p = h.toDoc(e);
      // A pen samples far faster than the browser fires move events; replaying the
      // coalesced samples keeps a fast stroke smooth AND gives each dab its own
      // pressure instead of one reading per animation frame.
      const native = e.nativeEvent;
      const samples =
        e.pointerType !== "mouse" && typeof native?.getCoalescedEvents === "function"
          ? native.getCoalescedEvents()
          : [];
      if (samples.length > 1) {
        for (const s of samples) {
          const q = h.toDoc(s);
          h.engine.moveStroke(q.x, q.y, h.pressure(s));
          record(q);
        }
        return true;
      }
      h.engine.moveStroke(p.x, p.y, h.pressure(e));
      record(p);
      return true;
    },
    up(_e: ToolPointer, h: ToolHost) {
      if (historying) {
        h.engine.endHistory();
        historying = false;
      }
      if (painting) {
        h.engine.endStroke();
        painting = false;
        if (rec) {
          h.strokes.record(rec);
          rec = null;
        }
      }
    },
    /* The stroke is thrown away (the engine has the layer as it was); the
       source grab ends where it is. */
    cancel(h: ToolHost) {
      grab = null;
      if (painting) {
        h.engine.cancelStroke();
        painting = false;
      }
      if (historying) {
        h.engine.endHistory(false);
        historying = false;
      }
    },
    busy: () => painting || historying || grab !== null,
    cursor: "none", // the ring is drawn on the overlay instead
  };

  const brush: ToolController = {
    ...session,
    rightButton: true, // paints with the secondary colour
    down(e, h) {
      const { engine, activeLayerId } = h;
      const tool = h.tool as StrokeStep["tool"]; // the tools this controller is for
      const settings = h.settings.brush;
      if (engine.isFloating) engine.commitFloat(); // merge before painting on it
      // Flip-to-erase: a stylus turned over reports its eraser end, and erases
      // for the length of that stroke without changing the selected tool.
      const erasing = tool === "eraser" || (isEraserTip(e) && !!activeLayerId);
      let layerId: string;
      if (activeLayerId && (engine.quickMaskActive() || engine.getActiveSurface(activeLayerId) !== "pixels")) {
        // Painting a mask — the active layer's (or group's) layer/filter mask, or
        // the document's quick mask. Target the layer directly so brush/pencil
        // don't auto-create a new layer via ensureLayer.
        layerId = activeLayerId;
      } else if (erasing) {
        if (!activeLayerId) return; // nothing to erase
        layerId = activeLayerId;
      } else {
        layerId = h.ensureLayer(); // brush / pencil auto-creates a layer if none is selected
      }
      if (h.paintBlocked(layerId)) return; // pixels-locked layer
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      paintHover = { x: p.x, y: p.y }; // ring tracks the stroke

      // Erase to History: the eraser paints back from the history source instead
      // of erasing to transparency. It IS the history-brush stroke, run with the
      // eraser's own size/hardness/opacity/flow — so it goes through that
      // session.
      //
      // Two deliberate limits. It applies only on LAYER PIXELS: the history
      // source is a reconstruction of this layer's pixels at an earlier state,
      // and a layer/filter/quick mask has no such past to erase back to — on a
      // mask the eraser stays an eraser. And it's read from the ERASER's
      // settings only, so a flipped stylus (which erases with the brush's
      // settings) keeps erasing to transparency rather than silently
      // resurrecting pixels.
      const onPixels = !engine.quickMaskActive() && engine.getActiveSurface(layerId) === "pixels";
      if (tool === "eraser" && settings.eraseToHistory && onPixels) {
        historying = true;
        engine.beginHistory(layerId, settings, p.x, p.y, ...confined(h), "Erase to History");
        return;
      }

      painting = true;
      // Left button paints with the primary colour, right button with the secondary.
      const paintCol = e.button === 2 ? h.background : h.foreground;
      engine.beginStroke(
        layerId,
        settings,
        paintCol,
        p.x,
        p.y,
        erasing ? "erase" : "paint",
        ...confined(h),
        erasing ? "Erase" : tool === "pencil" ? "Pencil" : "Brush",
        h.pressure(e),
      );
      // Actions recorder: snapshot the stroke's settings + gather its raw path.
      rec = h.strokes.recording
        ? { tool, brush: { ...settings }, color: paintCol, points: [{ x: p.x, y: p.y }] }
        : null;
    },
    hover(cur, _e, h) {
      paintHover = { x: cur.x, y: cur.y };
      h.redraw();
    },
    // An Erase-to-History stroke is a HISTORY session drawn with the eraser's
    // ring, so it counts as mid-stroke here too.
    leave(h) {
      if (painting || historying) return;
      paintHover = null;
      h.redraw();
    },
    drawCursor(o, h) {
      if (!paintHover) return;
      const b = h.settings.brush;
      const hx = o.p.x + paintHover.x * o.s;
      const hy = o.p.y + paintHover.y * o.s;
      o.ring(hx, hy, Math.max(1, (b.size / 2) * o.s), b.hardness);
    },
    wantsOverlay: (selected) => selected && !!paintHover,
  };

  const history: ToolController = {
    ...session,
    down(e, h) {
      const id = h.activeLayerId;
      if (!id) return; // needs a layer with history to paint from
      if (h.paintBlocked(id)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      historying = true;
      const p = h.toDoc(e);
      historyHover = { x: p.x, y: p.y };
      h.engine.beginHistory(id, h.settings.history, p.x, p.y, ...confined(h));
    },
    hover(cur, _e, h) {
      historyHover = { x: cur.x, y: cur.y };
      h.redraw();
    },
    leave(h) {
      if (historying) return;
      historyHover = null;
      h.redraw();
    },
    drawCursor(o, h) {
      if (!historyHover) return;
      const hb = h.settings.history;
      const hx = o.p.x + historyHover.x * o.s;
      const hy = o.p.y + historyHover.y * o.s;
      o.ring(hx, hy, Math.max(1, (hb.size / 2) * o.s), hb.hardness);
    },
    wantsOverlay: (selected) => selected && !!historyHover,
  };

  const clone: ToolController = {
    ...session,
    down(e, h) {
      const c = h.settings.clone;
      const p = h.toDoc(e);
      cloneHover = { x: p.x, y: p.y };
      // Alt / Option click sets the clone source (re-anchoring the offset).
      if (e.altKey) {
        e.preventDefault();
        const prev = src;
        /* Near the source already set: pick it UP by the offset the grab starts
           with, so the finger sits clear of the point being aimed. Otherwise
           the press sets a new source and the same drag refines it. Both are
           touch-only: a mouse sets a source exactly where it clicks and has
           never had a drag here, so it keeps that. */
        if (e.pointerType !== "mouse") {
          const near = prev && Math.hypot(p.x - prev.x, p.y - prev.y) <= h.grab(12);
          grab = near ? { dx: prev.x - p.x, dy: prev.y - p.y } : { dx: 0, dy: 0 };
          if (!near) src = { x: p.x, y: p.y };
          h.capture(e);
          h.loupe(e, src ?? undefined);
        } else {
          src = { x: p.x, y: p.y };
          grab = null;
        }
        off = null;
        alt = true;
        h.redraw();
        return;
      }
      if (!src) return; // no source defined yet → nothing to paint
      if (h.engine.isFloating) h.engine.commitFloat();
      const layerId = h.ensureLayer();
      if (h.paintBlocked(layerId)) return; // pixels-locked layer
      e.preventDefault();
      h.capture(e);
      painting = true;
      // Aligned keeps the previous offset; otherwise (or on the first stroke after
      // sampling) re-anchor so the stroke starts sampling from the source point.
      let o = off;
      if (!c.aligned || !o) {
        o = { x: src.x - p.x, y: src.y - p.y };
        off = o;
      }
      const cloneBrush: BrushSettings = {
        size: c.size,
        hardness: c.hardness,
        opacity: c.opacity,
        flow: c.flow,
        blend: "Normal",
        smoothing: c.smoothing,
      };
      h.engine.beginClone(layerId, cloneBrush, p.x, p.y, o, c.sampleAll, c.spacing, ...confined(h));
    },
    // Track the pointer + Alt state for the brush ring / source marker.
    hover(cur, e, h) {
      cloneHover = { x: cur.x, y: cur.y };
      alt = e.altKey;
      const g = grab;
      if (g) {
        // Refining the source: it moves with the finger, keeping the offset,
        // and the loupe magnifies the SOURCE rather than the fingertip.
        const at = { x: cur.x + g.dx, y: cur.y + g.dy };
        src = at;
        off = null;
        h.loupe(e, at);
        h.redraw();
        return true;
      }
      h.redraw();
    },
    /* The source stays where it was dragged to — only the grab ends. */
    drop(h) {
      if (!grab) return false;
      grab = null;
      h.redraw();
      return true;
    },
    leave(h) {
      if (painting) return;
      cloneHover = null;
      h.redraw();
    },
    // The source is in document coordinates: another document's would sample
    // the wrong image, or the wrong place.
    switchDoc() {
      src = null;
      off = null;
    },
    /* Hover is not required for the SOURCE marker, only for the brush ring
       around the pointer. On a mouse the two always coincide; on a touchscreen
       the finger lifts the moment the source is set, and a source you cannot
       see is one you cannot adjust. */
    drawCursor(o, h) {
      if (!cloneHover && !src) return;
      const { ctx, p, s } = o;
      const c = h.settings.clone;
      const hov = cloneHover;
      const hx = hov ? p.x + hov.x * s : 0;
      const hy = hov ? p.y + hov.y * s : 0;
      const r = Math.max(1, (c.size / 2) * s);
      // Where the clone is (or would be) sampling from.
      let srcPt: Pt | null = null;
      if (painting && off && hov) srcPt = { x: hov.x + off.x, y: hov.y + off.y };
      else if (src) srcPt = c.aligned && off && hov ? { x: hov.x + off.x, y: hov.y + off.y } : src;

      if (srcPt) {
        const sx = p.x + srcPt.x * s;
        const sy = p.y + srcPt.y * s;
        // Faint connector from source to the brush while actively cloning.
        if (painting && off && hov) {
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = o.light(0.45);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Source marker: a small ringed cross-hair.
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = o.light(0.95);
        ctx.stroke();
        o.cross(sx, sy, 5);
      }

      // Alt held → "set source" reticle; otherwise the normal brush ring.
      if (!hov) {
        /* no pointer on the canvas: the source marker above is the whole of it */
      } else if (alt) {
        ctx.beginPath();
        ctx.arc(hx, hy, 9, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = o.light(0.95);
        ctx.stroke();
        o.cross(hx, hy, 7);
      } else {
        o.ring(hx, hy, r, c.hardness);
      }
    },
    wantsOverlay: (selected) => selected && !!(cloneHover || src),
  };

  return { brush, history, clone };
}
