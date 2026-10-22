// Magic wand: a click selects the pixels like the one under it (flood or, with
// Contiguous off, everywhere); Ctrl adds, Alt subtracts. The seed is kept, so
// the selection re-runs as the Tolerance slider moves (CanvasArea does that,
// from h.selection.seedWand). A plain press on the selection's own handles or
// ring transforms it instead.

import { selectOp } from "./shared";
import type { ToolController } from "./types";

export function wandTool(): ToolController {
  return {
    transformsSelection: true,
    cursor: "crosshair",
    down(e, h) {
      if (h.engine.isFloating) h.engine.commitFloat();
      const p = h.toDoc(e);
      const op = selectOp(e);
      // With no modifier, a grab on a handle/ring/anchor transforms the existing
      // selection; Ctrl-add / Alt-subtract always start a fresh wand region.
      if (op === "new" && h.transform.start(e, p)) return;
      const w = h.settings.wand;
      const id = h.activeLayerId;
      if (!w.sampleAll && !id) return; // need a layer to sample
      e.preventDefault();
      // Ctrl/Cmd adds (union); Alt subtracts; plain click replaces.
      const base = op !== "new" && h.selection.all.length ? h.selection.all : [];
      h.selection.seedWand({ x: p.x, y: p.y, layerId: id, base, mode: op });
      const raw = h.engine.magicWand(
        id ?? "",
        p.x,
        p.y,
        { tolerance: w.tolerance, contiguous: w.contiguous, sampleAll: w.sampleAll },
        false,
        op === "add" && base.length ? base : null, // union folded in for add
      );
      if (op === "subtract") {
        if (raw) h.selection.combine(h.engine.combineSelection(base, raw.rects, "subtract"));
      } else if (raw && raw.rects.length) {
        h.selection.set(raw.rects, raw.segments);
      }
      h.redraw();
    },
    // Over the selection: the cursor for what a press there would do.
    hover(_cur, e, h) {
      h.transform.hoverCursor(e);
    },
    busy: () => false,
  };
}
