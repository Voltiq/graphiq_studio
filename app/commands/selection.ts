// The selection family (TODO 1.10): the selection and its journal — each
// change a step of its own, a selection tool's live gesture one step when it
// ends — and the Select menu: All, Deselect, Reselect, Inverse, Modify,
// Feather, Grow, Refine Edge, transform by numbers, Load Mask as Selection.
//
// `selectionOps` is called on every render of Editor, as `layerOps` is. The
// journal's refs are Editor's hooks, passed in.

import { findNode } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { NO_REFINE, decontaminate, refineActive, type RefineEdge } from "../lib/refine-edge";
import { boxOf, pivotOf, sanitizeBox, transformRects } from "../lib/selection-transform";
import type { ToolId } from "../lib/tools";
import { invertRects, type Rect } from "../lib/view";
import type { DialogState } from "../state/dialogs";
import type { Doc, DocumentsState } from "../state/documents";
import type { Store } from "../state/store";

/** History labels for a selection made with a tool (an emptied one is "Deselect"). */
const TOOL_SELECTION_LABEL: Partial<Record<ToolId, string>> = {
  select: "Marquee",
  lasso: "Lasso",
  wand: "Magic Wand",
  quickselect: "Quick Selection",
  move: "Move Selection",
};

/** A selection: its outline, and the rotation it is drawn with. */
export type SelState = { rects: Rect[]; angle: number; pivot: { x: number; y: number } | null };

/** What the selection operations need of the editor. */
export interface SelectionContext {
  documents: Store<DocumentsState>;
  /** The active document's id — the latest, read when a change is made. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  /** The tool in hand, which names a tool's selection step. */
  toolRef: { readonly current: ToolId };
  /** The most recent non-empty selection, for Reselect. */
  lastSelectionRef: { readonly current: SelState | null };
  /** A selection tool's gesture, open until it ends. */
  pendingToolSelRef: { current: { docId: string; before: SelState; after: SelState } | null };
  /** Refine Edge's session, while its dialog is open. */
  refineOpen: DialogState["refine"];
  setRefineOpen(next: DialogState["refine"]): void;
  /** Put a floating paste or move down before the selection changes. */
  commitFloatIfAny(): void;
}

export function selectionOps(ctx: SelectionContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    toolRef,
    lastSelectionRef,
    pendingToolSelRef,
    refineOpen,
    setRefineOpen,
    commitFloatIfAny,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  // Setting a (new) selection resets its rotation transform.
  const setSelection = (rects: Rect[]) => {
    setDocs((ds) =>
      ds.map((d) =>
        d.id === activeIdRef.current
          ? { ...d, selection: rects, selectionAngle: 0, selectionPivot: null }
          : d,
      ),
    );
  };
  // Update only the selection rects, preserving the rotation transform.
  const setSelectionRects = (rects: Rect[]) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selection: rects } : d)));
  const setSelectionAngle = (angle: number) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selectionAngle: angle } : d)));
  const setSelectionPivot = (pivot: { x: number; y: number } | null) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selectionPivot: pivot } : d)));

  // ---- Select menu (All / Deselect / Reselect / Inverse) ----
  // Selection changes from the menu are undoable: each pushes a structural
  // history entry whose undo/redo restores the selection rects + rotation.
  const selStateOf = (d: Doc): SelState => ({
    rects: d.selection,
    angle: d.selectionAngle,
    pivot: d.selectionPivot,
  });
  const setSelState = (docId: string, s: SelState) =>
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? { ...d, selection: s.rects, selectionAngle: s.angle, selectionPivot: s.pivot }
          : d,
      ),
    );
  const sameSelState = (a: SelState, b: SelState) =>
    a.angle === b.angle &&
    (a.pivot?.x ?? null) === (b.pivot?.x ?? null) &&
    (a.pivot?.y ?? null) === (b.pivot?.y ?? null) &&
    a.rects.length === b.rects.length &&
    a.rects.every(
      (r, i) => r.x === b.rects[i].x && r.y === b.rects[i].y && r.w === b.rects[i].w && r.h === b.rects[i].h,
    );

  const flushToolSelection = () => {
    const p = pendingToolSelRef.current;
    if (!p) return;
    pendingToolSelRef.current = null;
    if (sameSelState(p.before, p.after)) return;
    const label = p.after.rects.length ? (TOOL_SELECTION_LABEL[toolRef.current] ?? "Selection") : "Deselect";
    paintRef.current?.pushStructural(
      label,
      () => setSelState(p.docId, p.before),
      () => setSelState(p.docId, p.after),
    );
  };
  /** What CanvasArea's selection tools call, live, during a gesture. A rotated
   *  outline moved by a nudge or a drag keeps its rotation (and its moved
   *  pivot) — and is journalled like any other tool change; it used to bypass
   *  history, so Ctrl+Z after nudging a rotated selection undid the step before. */
  const toolSelectionChange = (rects: Rect[], angle = 0, pivot: { x: number; y: number } | null = null) => {
    const docId = activeIdRef.current;
    if (pendingToolSelRef.current && pendingToolSelRef.current.docId !== docId) flushToolSelection();
    const after: SelState = { rects, angle, pivot };
    if (pendingToolSelRef.current) pendingToolSelRef.current.after = after;
    else pendingToolSelRef.current = { docId, before: selStateOf(activeDocRef.current), after };
    if (angle === 0 && pivot === null) setSelection(rects);
    else setSelState(docId, after);
  };

  const commitSelection = (label: string, rects: Rect[], angle = 0, pivot: { x: number; y: number } | null = null) => {
    flushToolSelection(); // a tool gesture still open is its own, earlier step
    const docId = activeIdRef.current;
    const before = selStateOf(activeDocRef.current);
    const after: SelState = { rects, angle, pivot };
    if (sameSelState(before, after)) return; // no-op → don't journal it
    setSelState(docId, after);
    paintRef.current?.pushStructural(label, () => setSelState(docId, before), () => setSelState(docId, after));
  };

  // Select ▸ Grow — push the selection outward by `px` (a square kernel). A soft
  // selection grows on its coverage, so it stays soft; a hard one, rect by rect.
  const growSelection = (px: number) => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Grow needs an active selection — make one first.");
      return;
    }
    const soft = paintRef.current?.growSoftSelection(d.selection, px);
    if (soft) {
      commitSelection("Grow", soft, d.selectionAngle, d.selectionPivot);
      return;
    }
    const grown = d.selection.map((r) => {
      const x = Math.max(0, r.x - px);
      const y = Math.max(0, r.y - px);
      const right = Math.min(d.width, r.x + r.w + px);
      const bottom = Math.min(d.height, r.y + r.h + px);
      return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
    });
    commitSelection("Grow", grown, d.selectionAngle, d.selectionPivot);
  };

  // ---- Refine edge ----
  const openRefineEdge = () => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Refine edge needs an active selection — make one first.");
      return;
    }
    const eng = paintRef.current;
    if (!eng) return;
    const source = eng.exportComposite(d.layers);
    // The selection's own coverage — soft where it is soft — with its rotation.
    const mask = eng.selectionCoverageCanvas(d.selection, d.selectionAngle, d.selectionPivot);
    // Each refinement is baked into the selection it was made for, so the next
    // one starts from nothing rather than re-applying the last on top.
    setRefineOpen({ source, mask, initial: NO_REFINE });
  };
  const applyRefineEdge = (r: RefineEdge, deconAmount: number) => {
    const ctx = refineOpen;
    setRefineOpen(null);
    if (!ctx) return;
    const eng = paintRef.current;
    const sel = activeDocRef.current;
    if (!eng) return;
    /* Refine Edge makes a NEW SELECTION — the refined coverage, its rotation
       baked in — and it is undoable like any other. It used to be engine state
       applied at every later use instead, to whatever was selected by then. */
    const refined = refineActive(r)
      ? eng.refineSelection(sel.selection, sel.selectionAngle, sel.selectionPivot, r)
      : null;
    if (refined && !refined.length) {
      showToast("Nothing would be left selected by that refinement.");
      return;
    }
    if (refined) {
      commitSelection("Refine Edge", refined, 0, null);
      if (eng.isFaintSelection(refined)) showToast("No pixels are more than 50% selected — the outline marks where the selection is half as strong.");
    }
    if (deconAmount <= 0) return;
    // Decontamination edits PIXELS, so it is a real, undoable layer change —
    // unlike the edge settings, which only shape the mask.
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    const node = id ? findNode(d.layers, id) : null;
    if (!node || node.type !== "layer") {
      showToast("Decontaminate needs a pixel layer selected.");
      return;
    }
    const src = paintRef.current?.getLayerCanvas(id!);
    // The REFINED edge is what decontamination works on: its soft fringe.
    const refinedMask = refined ? eng.selectionCoverageCanvas(refined, 0, null) : ctx.mask;
    const mctx = refinedMask.getContext("2d", { willReadFrequently: true });
    const sctx = src?.getContext("2d", { willReadFrequently: true });
    if (!src || !mctx || !sctx) return;
    const w = d.width;
    const h = d.height;
    const alphaImg = mctx.getImageData(0, 0, w, h);
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = alphaImg.data[i * 4 + 3];
    const img = sctx.getImageData(0, 0, w, h);
    decontaminate(img.data, a, w, h, deconAmount);
    sctx.putImageData(img, 0, 0);
    paintRef.current?.applyLayerImage(id!, src, "Decontaminate colours");
  };

  // Transform selection by numbers (the options bar's X/Y/W/H/Angle).
  const applySelBox = (next: { x: number; y: number; w: number; h: number; angle: number }) => {
    const d = activeDocRef.current;
    const from = boxOf(d.selection);
    if (!from) return;
    const to = sanitizeBox(next);
    const rads = ((next.angle || 0) * Math.PI) / 180;
    const moved = transformRects(d.selection, from, to);
    if (!moved.length) {
      showToast("That would leave nothing selected.");
      return;
    }
    const sameBox =
      Math.round(from.x) === to.x &&
      Math.round(from.y) === to.y &&
      Math.round(from.w) === to.w &&
      Math.round(from.h) === to.h;
    if (sameBox && Math.abs(rads - d.selectionAngle) < 1e-6) return; // nothing to do
    paintRef.current?.carryResizedSelection(d.selection, moved, from, to); // soft stays soft
    // Rotation turns about the box CENTRE, matching the on-canvas handle.
    commitSelection("Transform selection", moved, rads, rads ? pivotOf(to) : null);
  };

  // Select ▸ Modify — Border / Smooth / Expand / Contract. Unlike Feather (which
  // only shapes how the mask is USED) these rewrite the selection geometry, so
  // they commit a new selection and are undoable as such.
  const modifySelectionOp = (op: "border" | "smooth" | "expand" | "contract", px: number) => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast(`${op[0].toUpperCase()}${op.slice(1)} needs an active selection — make one first.`);
      return;
    }
    const next = paintRef.current?.modifySelection(
      d.selection,
      d.selectionAngle,
      d.selectionPivot,
      op,
      px,
    );
    if (!next) return;
    if (!next.length) {
      showToast("That would leave nothing selected.");
      return;
    }
    // The morphology works on a raster, so the result is axis-aligned and any
    // rotation is already baked into the rects — carrying the old angle forward
    // would rotate the shape a second time.
    commitSelection(`${op[0].toUpperCase()}${op.slice(1)}`, next, 0, null);
  };

  /* Select ▸ Feather — soften the selection's edge by `px`. A real operation on
     its coverage, undoable, whose result is the soft selection everything then
     uses; it used to be a radius riding beside the selection, applied at each
     use and forgotten when the selection changed. */
  const featherSelection = (px: number) => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Feather needs an active selection — make one first.");
      return;
    }
    const next = paintRef.current?.featherSelection(d.selection, d.selectionAngle, d.selectionPivot, px);
    if (!next) return;
    if (!next.length) {
      showToast("Nothing would be left selected — feather by less, or select more first.");
      return;
    }
    commitSelection("Feather", next, 0, null); // the rotation is baked into the coverage
    if (paintRef.current?.isFaintSelection(next)) showToast("No pixels are more than 50% selected — the outline marks where the selection is half as strong.");
  };

  const selectAll = () => {
    commitFloatIfAny();
    const d = activeDocRef.current;
    commitSelection("Select All", [{ x: 0, y: 0, w: d.width, h: d.height }]);
  };
  const deselect = () => {
    if (!activeDocRef.current.selection.length) return;
    commitFloatIfAny(); // merge a floating paste before clearing
    commitSelection("Deselect", []);
  };
  const reselect = () => {
    const last = lastSelectionRef.current;
    if (!last?.rects.length || activeDocRef.current.selection.length) return; // only when nothing is selected
    commitSelection("Reselect", last.rects, last.angle, last.pivot);
  };
  const invertSelection = () => {
    const d = activeDocRef.current;
    if (!d.selection.length) return; // nothing selected → inverse is undefined here
    commitFloatIfAny();
    // A soft selection inverts its coverage (255 − a), not just its outline.
    const soft = d.selectionAngle ? null : paintRef.current?.combineSelectionSoft(d.selection, null, "invert");
    commitSelection("Invert Selection", soft ?? invertRects(d.selection, d.width, d.height));
  };

  const loadMaskAsSelectionOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    if (!findNode(d.layers, layerId)?.mask) return;
    commitSelection("Load Mask as Selection", eng.maskSelectionRects(layerId), 0, null);
  };

  return {
    setSelection,
    setSelectionRects,
    setSelectionAngle,
    setSelectionPivot,
    selStateOf,
    setSelState,
    flushToolSelection,
    toolSelectionChange,
    commitSelection,
    growSelection,
    openRefineEdge,
    applyRefineEdge,
    applySelBox,
    modifySelectionOp,
    featherSelection,
    selectAll,
    deselect,
    reselect,
    invertSelection,
    loadMaskAsSelectionOp,
  };
}
