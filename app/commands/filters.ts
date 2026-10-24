// The smart-filters family (TODO 1.10): a layer's filter stack — the dialog's
// live edits as one step per gesture, its structural changes (add, turn off
// and on, reorder, remove, clear), the dialog opened on a layer, a filter
// added from the menu, and the stack baked into the pixels with its mask.
//
// `filterOps` is called on every render of Editor, as `layerOps` is. The live
// edit's refs are Editor's hooks, passed in.

import { defaultFilter, filterLabel, type FilterType, type SmartFilter } from "../lib/filters";
import { filterMaskKey, findNode, updateNode, type LayerNode } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import type { Doc } from "../state/documents";
import type { Sel } from "./layers";

/** What the smart-filter operations need of the editor. */
export interface FilterContext {
  /** The active document's id — the latest, read when a step is made. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  selNow(): Sel;
  setDocSel(docId: string, layers: LayerNode[], sel: Sel): void;
  /** A gesture in the Smart filters dialog: the tree from before it, until it ends. */
  filterEditRef: { current: { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  filterEditTimer: { current: number };
  /** The layer whose Smart filters dialog is open. */
  setFilterTarget(id: string | null): void;
  selectLayer(id: string, mode: "replace" | "toggle" | "range"): void;
}

export function filterOps(ctx: FilterContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    selNow,
    setDocSel,
    filterEditRef,
    filterEditTimer,
    setFilterTarget,
    selectLayer,
  } = ctx;

  const commitFilterEdit = () => {
    const sess = filterEditRef.current;
    filterEditRef.current = null;
    if (filterEditTimer.current) {
      window.clearTimeout(filterEditTimer.current);
      filterEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Smart Filter",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Live param edit from the dialog (no per-tick history; one step per gesture).
  const setFiltersLive = (id: string, filters: SmartFilter[]) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    if (!filterEditRef.current || filterEditRef.current.layerId !== id) {
      commitFilterEdit();
      filterEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, id, { filters }), selNow());
    if (filterEditTimer.current) window.clearTimeout(filterEditTimer.current);
    filterEditTimer.current = window.setTimeout(commitFilterEdit, 500);
  };

  // Discrete structural filter op (add / toggle / reorder / remove / clear).
  const setFiltersOp = (id: string, filters: SmartFilter[] | undefined, label: string) => {
    commitFilterEdit();
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { filters });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  const openFiltersOp = (id: string) => {
    selectLayer(id, "replace");
    setFilterTarget(id);
  };

  // Menu entry: append a default filter of `type` and open the stack dialog.
  const addFilterOp = (type: FilterType) => {
    const id = activeDocRef.current.activeLayerId;
    if (!id) return;
    const node = findNode(activeDocRef.current.layers, id);
    if (!node || node.type === "adjustment") return;
    const f = defaultFilter(type);
    setFiltersOp(id, [...(node.filters ?? []), f], `Add ${filterLabel(f)}`);
    openFiltersOp(id);
  };

  // Bake the stack into the layer's pixels: one combined pixel+structural step.
  const applyFiltersOp = (id: string) => {
    commitFilterEdit();
    const d = activeDocRef.current;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "layer" || !node.filters?.length) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    // Baking consumes the filter mask too — it shaped the baked pixels.
    const after = updateNode(before, id, { filters: undefined, filterMask: undefined });
    const eng = paintRef.current;
    const key = filterMaskKey(id);
    const fmSnap = node.filterMask ? (eng?.captureMask(key) ?? null) : null;
    setDocSel(docId, after, sel);
    eng?.applySmartFilters(
      id,
      node.filters,
      {
        undo: () => {
          if (fmSnap) eng.restoreMask(key, fmSnap);
          setDocSel(docId, before, sel);
        },
        redo: () => {
          eng.freeMask(key);
          setDocSel(docId, after, sel);
        },
      },
      !!node.filterMask?.enabled,
    );
    eng?.freeMask(key);
    setFilterTarget(null);
  };

  return {
    commitFilterEdit,
    setFiltersLive,
    setFiltersOp,
    openFiltersOp,
    addFilterOp,
    applyFiltersOp,
  };
}
