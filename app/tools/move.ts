// Move: drag the layer, the selected pixels (lifted onto a float), or — in
// Selection mode — only the selection's outline. With Auto-select a press
// picks the layer under it first. The transform controls (Move ▸ Show
// transform controls) and the guides are CanvasArea's: a press on one of
// those is theirs before it is a move.

import { findNode } from "../lib/layers";
import type { MoveMode } from "../lib/tools";
import type { Pt, ToolController } from "./types";

export interface MoveController extends ToolController {
  /** The drag in progress: where it began, and what it moves. The selection's
   *  outline and the Info panel follow it. */
  readonly session: {
    current: { sx: number; sy: number; mode: MoveMode; float?: boolean; baseOff?: Pt } | null;
  };
  /** How far it has moved, whole px (an arrow-key nudge uses it too). */
  readonly delta: { current: Pt };
}

export function moveTool(): MoveController {
  const session: MoveController["session"] = { current: null };
  const delta: MoveController["delta"] = { current: { x: 0, y: 0 } };
  return {
    session,
    delta,
    cursor: "move",
    grabsGuides: true,
    showsLayerTransform: true,
    down(e, h) {
      const p = h.toDoc(e);
      // Transform controls take the press before anything else: a handle sits
      // ON the layer, so auto-select would otherwise re-target (or a plain move
      // would start) on the very click meant to scale it. Only when the press
      // is really on a handle or the ring — inside the box it falls through to
      // the ordinary move drag, exactly as Photoshop behaves.
      if (h.transform.startLayer(e, p)) return;
      const { mode, autoSelect } = h.settings.move;
      const sel = h.selection.all;
      // Auto-select: clicking a pixel picks the layer that owns it, so you can
      // grab things on the canvas instead of hunting the Layers panel. Only
      // without a selection — with a marquee up, a click starts moving THAT,
      // and re-targeting the layer under the cursor would be a trap.
      // `moveId` shadows the active layer for this gesture so an auto-selected
      // pick takes effect immediately — the host won't have updated yet, and
      // waiting a render would drag the OLD layer on the very click that picked
      // the new one.
      let moveId = h.activeLayerId;
      if (autoSelect && mode === "pixels" && !sel.length) {
        const hit = h.layerAt(p);
        if (hit && hit !== h.activeLayerId) {
          h.pickLayer(hit);
          moveId = hit;
        }
      }
      if (mode === "selection") {
        if (!sel.length) return; // nothing to move
        e.preventDefault();
        h.capture(e);
        session.current = { sx: p.x, sy: p.y, mode: "selection" };
        h.snap.beginMove();
      } else {
        // Pixels mode: float an active selection (or keep moving the current float),
        // leaving the layer's own content untouched until deselect.
        if (h.moveBlocked(moveId)) return; // position-locked or fill layer
        const { engine } = h;
        let floating = engine.isFloating && engine.floatLayerId === moveId;
        if (!floating && moveId && sel.length) {
          floating = engine.beginFloatFromSelection(moveId, sel, h.selection.angle, h.selection.pivot);
        }
        if (floating) {
          e.preventDefault();
          h.capture(e);
          session.current = { sx: p.x, sy: p.y, mode: "pixels", float: true, baseOff: engine.getFloatOffset() };
          h.snap.beginMove();
        } else {
          if (!moveId) return; // nothing to move
          e.preventDefault();
          h.capture(e);
          session.current = { sx: p.x, sy: p.y, mode: "pixels" };
          // Snap candidates MUST be captured before beginMove: a whole-layer move
          // lifts the pixels onto a float and clears the layer's own canvas, so
          // measuring its content bounds afterwards finds an empty layer (and the
          // same goes for any linked layers riding along).
          h.snap.beginMove();
          // No selection → move the whole layer; a linked mask travels with it,
          // and any linked layers ride along by the same delta.
          const node = findNode(h.layers, moveId);
          engine.beginMove(moveId, null, !!node?.mask && node.mask.linked !== false, h.linkedExtras(moveId));
        }
      }
      delta.current = { x: 0, y: 0 };
      h.redraw();
    },
    // Not moving: show what a press here would do (pick up a guide, a
    // transform handle).
    hover(_cur, e, h) {
      if (!session.current) h.transform.layerHoverCursor(e);
    },
    move(e, h) {
      const m = session.current;
      if (!m) return false;
      const p = h.toDoc(e);
      // Snap the raw delta (guides, canvas edges/centre, other layers) before it
      // is rounded, so the box lands exactly on the line rather than a px off.
      const s = h.snap.move(p.x - m.sx, p.y - m.sy, e.ctrlKey || e.metaKey);
      const dx = Math.round(s.dx);
      const dy = Math.round(s.dy);
      delta.current = { x: dx, y: dy };
      if (m.float) {
        const b = m.baseOff!;
        h.engine.setFloatOffset(b.x + dx, b.y + dy);
      } else if (m.mode === "pixels") {
        h.engine.moveTo(dx, dy);
      }
      return true;
    },
    up(e, h) {
      const m = session.current;
      if (!m) return;
      const d = delta.current;
      session.current = null;
      h.snap.end();
      // Float stays floating; a real lift-move bakes here.
      if (!m.float && m.mode === "pixels") h.engine.endMove();
      // Selection follows whatever moved (float, lifted pixels, or selection-only).
      const sel = h.selection.all;
      if (sel.length && (d.x !== 0 || d.y !== 0)) {
        const moved = h.engine.shiftSelection(sel, d.x, d.y);
        // Keep the rotation and shift the pivot with the rects, so a rotated
        // selection's outline stays locked to its (rotated) pixels. Resetting
        // the angle here would leave an axis-aligned mask over rotated content,
        // which later clips it into scanlines.
        const piv = h.selection.pivot;
        h.selection.place(moved, h.selection.angle, piv ? { x: piv.x + d.x, y: piv.y + d.y } : null);
      }
      delta.current = { x: 0, y: 0 };
      h.release(e);
    },
    // A pinch puts a moved layer back where it started; a float or a selection
    // outline simply stays where the drag had it.
    cancel(h) {
      const m = session.current;
      if (!m) return;
      session.current = null;
      h.snap.end();
      if (!m.float && m.mode === "pixels") h.engine.cancelMove(); // put the pixels back
      delta.current = { x: 0, y: 0 };
    },
    // The Info panel's live readout: how far it has moved.
    readout: () =>
      session.current
        ? { kind: "delta", dx: Math.round(delta.current.x), dy: Math.round(delta.current.y) }
        : null,
    busy: () => session.current !== null,
  };
}
