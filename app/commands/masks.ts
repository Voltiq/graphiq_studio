// The masks family (TODO 1.10): layer masks — added, deleted, applied, turned
// off and on, unlinked — a smart filter's mask, and vector masks drawn from the
// Work Path. Each is one undoable step. The menus, the Layers panel and the
// Smart filters dialog all call these.
//
// `maskOps` is called on every render of Editor, as `layerOps` is.

import { filterMaskKey, findNode, updateNode, type ActiveSurface, type LayerNode, type MaskMeta } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { WORK_PATH_ID } from "../lib/paths";
import { MIN_ANCHORS, defaultVectorMask, type VectorMask } from "../lib/vector-mask";
import type { Doc } from "../state/documents";
import type { Sel } from "./layers";

/** What the mask operations need of the editor. */
export interface MaskContext {
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  /** What the paint tools work on, as the Layers panel and options bar show it. */
  setPaintSurface(surface: ActiveSurface): void;
  selNow(): Sel;
  setDocSel(docId: string, layers: LayerNode[], sel: Sel): void;
}

export function maskOps(ctx: MaskContext) {
  const { activeDocRef, paintRef, showToast, setPaintSurface, selNow, setDocSel } = ctx;

  const addMaskOp = (init: "reveal" | "hide" | "selection") => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.mask) return; // one mask per layer; never stack
    if (init === "selection" && !d.selection.length) {
      showToast("Make a selection first to create a mask from it.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: { enabled: true, linked: true } });
    eng.allocMask(layerId, init, init === "selection" ? d.selection : null, d.selectionAngle, d.selectionPivot);
    const snap = eng.captureMask(layerId);
    setDocSel(docId, after, sel);
    eng.setActiveSurface(layerId, "mask");
    setPaintSurface("mask");
    eng.pushStructural(
      "Add Layer Mask",
      () => {
        eng.freeMask(layerId);
        setDocSel(docId, before, sel);
        setPaintSurface("pixels");
      },
      () => {
        if (snap) eng.restoreMask(layerId, snap);
        setDocSel(docId, after, sel);
      },
    );
  };

  const removeMaskOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node?.mask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: undefined });
    const snap = eng.captureMask(layerId);
    eng.freeMask(layerId);
    setDocSel(docId, after, sel);
    setPaintSurface("pixels");
    eng.pushStructural(
      "Delete Layer Mask",
      () => {
        if (snap) eng.restoreMask(layerId, snap);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.freeMask(layerId);
        setDocSel(docId, after, sel);
      },
    );
  };

  const applyMaskOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node?.mask) return;
    if (!node.mask.enabled) {
      showToast("Enable the mask before applying.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: undefined });
    const layerBefore = eng.captureLeaves([layerId]); // pixels + mask grayscale
    eng.applyMaskToLayer(layerId); // bake mask into the layer, then free it
    const layerAfter = eng.captureLeaves([layerId]); // baked pixels, no mask
    setDocSel(docId, after, sel);
    setPaintSurface("pixels");
    eng.pushStructural(
      "Apply Layer Mask",
      () => {
        eng.restoreLeaves(layerBefore);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.restoreLeaves(layerAfter);
        setDocSel(docId, after, sel);
      },
    );
  };

  const toggleMaskMeta = (layerId: string, patch: Partial<MaskMeta>, label: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, layerId);
    if (!eng || !node?.mask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: { ...node.mask, ...patch } });
    setDocSel(docId, after, sel);
    eng.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  // ---- Filter mask (Spec 07 addendum): confines a node's smart-filter stack ----
  const addFilterMaskOp = (layerId: string, init: "reveal" | "hide" | "selection" = "reveal") => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.type === "adjustment" || node.filterMask) return;
    if (!node.filters?.length) {
      showToast("Add a smart filter first — the filter mask confines the stack.");
      return;
    }
    if (init === "selection" && !d.selection.length) {
      showToast("Make a selection first to create a mask from it.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: { enabled: true, linked: true } });
    const key = filterMaskKey(layerId);
    eng.allocMask(key, init, init === "selection" ? d.selection : null, d.selectionAngle, d.selectionPivot);
    const snap = eng.captureMask(key);
    setDocSel(docId, after, sel);
    eng.setActiveSurface(layerId, "filterMask");
    setPaintSurface("filterMask");
    eng.pushStructural(
      "Add Filter Mask",
      () => {
        eng.freeMask(key);
        setDocSel(docId, before, sel);
        setPaintSurface("pixels");
      },
      () => {
        if (snap) eng.restoreMask(key, snap);
        setDocSel(docId, after, sel);
      },
    );
  };

  const removeFilterMaskOp = (layerId: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.type === "adjustment" || !node.filterMask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: undefined });
    const key = filterMaskKey(layerId);
    const snap = eng.captureMask(key);
    eng.freeMask(key); // also resets a "filterMask" active surface to pixels
    setDocSel(docId, after, sel);
    setPaintSurface(eng.getActiveSurface(layerId));
    eng.pushStructural(
      "Delete Filter Mask",
      () => {
        if (snap) eng.restoreMask(key, snap);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.freeMask(key);
        setDocSel(docId, after, sel);
      },
    );
  };

  const setFilterMaskEnabled = (layerId: string, enabled: boolean) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, layerId);
    if (!eng || !node || node.type === "adjustment" || !node.filterMask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: { ...node.filterMask, enabled } });
    setDocSel(docId, after, sel);
    eng.pushStructural(
      enabled ? "Enable Filter Mask" : "Disable Filter Mask",
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  // ---- Vector masks -------------------------------------------------------
  // The PATH stays the source of truth; the engine rasterises it and caches the
  // result by hash. Stored on the node like effects, so it rides the existing
  // structural-undo and .gproj spread for free.
  const vectorMaskStructural = (
    id: string,
    vectorMask: VectorMask | undefined,
    label: string,
  ) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { vectorMask });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };
  const addVectorMask = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id || !findNode(d.layers, id)) {
      showToast("Select a layer to mask.");
      return;
    }
    // The Work Path is whatever the Pen tool last committed — the same path the
    // Paths panel shows at the top, so "from path" means what it looks like.
    const p = (d.paths ?? []).find((x) => x.id === WORK_PATH_ID) ?? (d.paths ?? [])[0];
    if (!p || p.anchors.length < MIN_ANCHORS) {
      showToast(`Draw a path with the Pen tool first (at least ${MIN_ANCHORS} points).`);
      return;
    }
    vectorMaskStructural(id, defaultVectorMask(p.anchors), "Add Vector Mask");
  };
  const invertVectorMask = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    const node = id ? findNode(d.layers, id) : null;
    if (!node?.vectorMask) {
      showToast("This layer has no vector mask.");
      return;
    }
    vectorMaskStructural(
      id!,
      { ...node.vectorMask, inverted: !node.vectorMask.inverted },
      "Invert Vector Mask",
    );
  };
  const deleteVectorMask = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    const node = id ? findNode(d.layers, id) : null;
    if (!node?.vectorMask) {
      showToast("This layer has no vector mask.");
      return;
    }
    vectorMaskStructural(id!, undefined, "Delete Vector Mask");
  };

  return {
    addMaskOp,
    removeMaskOp,
    applyMaskOp,
    toggleMaskMeta,
    addFilterMaskOp,
    removeFilterMaskOp,
    setFilterMaskEnabled,
    addVectorMask,
    invertVectorMask,
    deleteVectorMask,
  };
}
