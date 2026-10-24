// The layers family (TODO 1.10): the structural layer operations — New,
// Duplicate, Delete, Group, Ungroup, Merge, Merge Visible, Stamp Visible,
// Flatten — and the undoable change they all go through, which the rest of the
// editor uses too (the Layers panel, masks, adjustments, effects, import).
//
// `layerOps` is called on every render of Editor and closes over that render's
// active document, exactly as these did when they were written inside it.

import {
  cloneSubtree,
  collectLeafIds,
  findNode,
  insertInGroup,
  insertRelative,
  mergeDownInTree,
  removeMany,
  replaceNodeWith,
  topLevelSelected,
  ungroupNode,
  type Layer,
  type LayerGroup,
  type LayerNode,
} from "../lib/layers";
import { mergeVisibleIsNoop, mergeVisiblePlan, stampVisiblePlan, visibleLeafIds } from "../lib/merge-visible";
import type { EngineHandle, LeafSnapshot } from "../lib/paint";
import type { Doc, DocumentsState } from "../state/documents";
import type { Store } from "../state/store";

/** A layer selection: the primary (active) id plus the full selected set. */
export type Sel = { active: string | null; selected: string[] };

/** What the layer operations need of the editor. */
export interface LayerContext {
  /** The active document, as this render sees it. */
  active: Doc;
  /** The active document's id — the latest, read when a step is made. */
  activeIdRef: { readonly current: string };
  documents: Store<DocumentsState>;
  paintRef: { readonly current: EngineHandle | null };
  /** What new layers and groups are numbered from. */
  layerSeqRef: { current: number };
  showToast(message: string): void;
}

export function layerOps(ctx: LayerContext) {
  const { active, activeIdRef, paintRef, layerSeqRef, showToast } = ctx;
  const setDocs = ctx.documents.setter("docs");

  const setDocSel = (docId: string, layers: LayerNode[], sel: Sel) =>
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? { ...d, layers, activeLayerId: sel.active, selectedLayerIds: sel.selected }
          : d,
      ),
    );

  const nextLeafId = () => `layer-${(layerSeqRef.current += 1)}`;
  const single = (id: string | null): Sel => ({ active: id, selected: id ? [id] : [] });
  // Current selection of the active doc (before snapshot for undo).
  const selNow = (): Sel => ({ active: active.activeLayerId, selected: active.selectedLayerIds });
  // The ids an action operates on: the multi-selection, or just the active layer.
  const targetIds = (): string[] =>
    active.selectedLayerIds.length
      ? active.selectedLayerIds
      : active.activeLayerId
        ? [active.activeLayerId]
        : [];

  // Run an undoable structural layer change. `forward` does the engine pixel work
  // (duplicate / rasterize). Created & deleted leaves (from the tree diff) drive
  // canvas undo/redo; the tree + selection are restored through setDocSel.
  const commitLayerChange = (
    label: string,
    treeBefore: LayerNode[],
    selBefore: Sel,
    treeAfter: LayerNode[],
    selAfter: Sel,
    forward: () => void = () => {},
    /** Canvas-size change folded into the same step (import-expand). */
    dims?: { bw: number; bh: number; aw: number; ah: number },
  ) => {
    const docId = activeIdRef.current;
    const patchDims = (w: number, h: number) =>
      setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, width: w, height: h } : d)));
    if (dims) patchDims(dims.aw, dims.ah);
    const eng = paintRef.current;
    const beforeIds = new Set(collectLeafIds(treeBefore));
    const afterIds = new Set(collectLeafIds(treeAfter));
    const deletedIds = [...beforeIds].filter((id) => !afterIds.has(id));
    const createdIds = [...afterIds].filter((id) => !beforeIds.has(id));
    const beforeSnaps = eng ? eng.captureLeaves(deletedIds) : new Map<string, LeafSnapshot>();
    forward();
    if (eng) deletedIds.forEach((id) => eng.removeLayer(id));
    const afterSnaps = eng ? eng.captureLeaves(createdIds) : new Map<string, LeafSnapshot>();
    setDocSel(docId, treeAfter, selAfter);
    if (!eng) return;
    const empty: LeafSnapshot = { layer: null, mask: null };
    const undoSnaps = new Map<string, LeafSnapshot>();
    deletedIds.forEach((id) => undoSnaps.set(id, beforeSnaps.get(id) ?? empty));
    createdIds.forEach((id) => undoSnaps.set(id, empty));
    const redoSnaps = new Map<string, LeafSnapshot>();
    createdIds.forEach((id) => redoSnaps.set(id, afterSnaps.get(id) ?? empty));
    deletedIds.forEach((id) => redoSnaps.set(id, empty));
    eng.pushStructural(
      label,
      () => {
        if (dims) patchDims(dims.bw, dims.bh);
        eng.restoreLeaves(undoSnaps);
        setDocSel(docId, treeBefore, selBefore);
      },
      () => {
        if (dims) patchDims(dims.aw, dims.ah);
        eng.restoreLeaves(redoSnaps);
        setDocSel(docId, treeAfter, selAfter);
      },
    );
  };

  const addLayerOp = () => {
    const before = active.layers;
    const leaf: Layer = {
      id: nextLeafId(),
      type: "layer",
      name: `Layer ${layerSeqRef.current}`,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const node = active.activeLayerId ? findNode(before, active.activeLayerId) : null;
    let after: LayerNode[];
    if (node && node.type === "group") after = insertInGroup(before, leaf, node.id);
    else if (node) after = insertRelative(before, leaf, node.id, true);
    else after = [leaf, ...before];
    commitLayerChange("New Layer", before, selNow(), after, single(leaf.id));
  };

  const removeSelected = () => {
    const before = active.layers;
    const ids = new Set(targetIds());
    if (!ids.size) return;
    const after = removeMany(before, ids);
    const next = collectLeafIds(after)[0] ?? null;
    commitLayerChange(
      ids.size > 1 ? "Delete Layers" : "Delete Layer",
      before,
      selNow(),
      after,
      single(next),
    );
  };

  const duplicateSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    let after = before;
    const pairs: [string, string][] = [];
    const newIds: string[] = [];
    for (const top of tops) {
      const { node: clone, leafPairs } = cloneSubtree(top, nextLeafId);
      const named = { ...clone, name: `${top.name} copy` } as LayerNode;
      after = insertRelative(after, named, top.id, true);
      pairs.push(...leafPairs);
      newIds.push(named.id);
    }
    commitLayerChange(
      tops.length > 1 ? "Duplicate Layers" : "Duplicate Layer",
      before,
      selNow(),
      after,
      { active: newIds[0], selected: newIds },
      () => pairs.forEach(([from, to]) => paintRef.current?.duplicateLayer(from, to)),
    );
  };

  const groupSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    const gid = `grp-${(layerSeqRef.current += 1)}`;
    const group: LayerGroup = {
      id: gid,
      type: "group",
      name: "Group",
      visible: true,
      opacity: 100,
      blend: "Normal",
      expanded: true,
      children: tops,
    };
    const rest = new Set(tops.slice(1).map((n) => n.id));
    const after = replaceNodeWith(removeMany(before, rest), tops[0].id, group);
    commitLayerChange("Group Layers", before, selNow(), after, single(gid));
  };

  const ungroupLayerOp = (id: string) => {
    const before = active.layers;
    const node = findNode(before, id);
    if (!node || node.type !== "group") return;
    const after = ungroupNode(before, id);
    commitLayerChange("Ungroup", before, selNow(), after, single(node.children[0]?.id ?? null));
  };

  const mergeDownOp = (id: string) => {
    const before = active.layers;
    const tid = nextLeafId();
    const res = mergeDownInTree(before, id, (_top, b) => ({
      id: tid,
      type: "layer",
      name: b.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    }));
    if (!res.top || !res.bottom) return; // nothing below it at this level
    const top = res.top;
    const bottom = res.bottom;
    commitLayerChange("Merge Down", before, selNow(), res.tree, single(tid), () => {
      paintRef.current?.rasterize(tid, [top, bottom], collectLeafIds([top, bottom]));
    });
  };

  const mergeSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (tops.length <= 1) {
      if (tops.length === 1) mergeDownOp(tops[0].id); // single → merge down
      return;
    }
    const tid = nextLeafId();
    const bottommost = tops[tops.length - 1];
    const others = new Set(tops.slice(0, -1).map((n) => n.id));
    const merged: Layer = {
      id: tid,
      type: "layer",
      name: bottommost.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const after = replaceNodeWith(removeMany(before, others), bottommost.id, merged);
    const leafIds = collectLeafIds(tops);
    commitLayerChange("Merge Layers", before, selNow(), after, single(tid), () => {
      paintRef.current?.rasterize(tid, tops, leafIds);
    });
  };

  /**
   * Merge Visible — collapse everything on screen into one layer.
   *
   * Reads `active.layers`, never the isolate-derived view: a document operation
   * must see the document. Merging while isolated therefore merges everything
   * that is really visible, not just what is being soloed.
   */
  const mergeVisibleOp = () => {
    const before = active.layers;
    if (!visibleLeafIds(before).length) {
      showToast("Nothing visible to merge.");
      return;
    }
    if (mergeVisibleIsNoop(before)) {
      showToast("Only one visible layer — nothing to merge into.");
      return;
    }
    const tid = nextLeafId();
    const plan = mergeVisiblePlan(before, tid);
    commitLayerChange("Merge Visible", before, selNow(), plan.tree, single(tid), () => {
      // Composite from the PRE-merge tree: it still has the layers being merged,
      // and drawStack already honours visibility, so the result is exactly what
      // was on screen.
      paintRef.current?.rasterize(tid, before, plan.freeIds);
    });
  };

  /** Stamp Visible — the same composite, as a NEW layer, originals untouched. */
  const stampVisibleOp = () => {
    const before = active.layers;
    if (!visibleLeafIds(before).length) {
      showToast("Nothing visible to stamp.");
      return;
    }
    const tid = nextLeafId();
    const after = stampVisiblePlan(before, tid, active.activeLayerId);
    commitLayerChange("Stamp Visible", before, selNow(), after, single(tid), () => {
      // No ids to free — that is the entire difference from Merge Visible.
      paintRef.current?.rasterize(tid, before, []);
    });
  };

  const flattenImage = () => {
    const before = active.layers;
    if (before.length === 0) return;
    const tid = nextLeafId();
    const flat: Layer = {
      id: tid,
      type: "layer",
      name: "Flattened",
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const all = collectLeafIds(before);
    commitLayerChange("Flatten Image", before, selNow(), [flat], single(tid), () => {
      paintRef.current?.rasterize(tid, before, all);
    });
  };

  return {
    setDocSel,
    nextLeafId,
    single,
    selNow,
    targetIds,
    commitLayerChange,
    addLayerOp,
    removeSelected,
    duplicateSelected,
    groupSelected,
    ungroupLayerOp,
    mergeSelected,
    mergeVisibleOp,
    stampVisibleOp,
    flattenImage,
  };
}
