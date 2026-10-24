// The adjustments family (TODO 1.10): adjustment layers — added above the
// active layer, masked by the selection — their sliders as one step per
// gesture, clipping to the layer below, Curves and Levels (as layers, or
// applied to a pixel layer), and the extra kinds (Hue/Saturation, Selective
// Color, Channel Mixer, Gradient Map, Invert, Equalize, Color Lookup).
//
// `adjustmentOps` is called on every render of Editor, as `layerOps` is. The
// live edit's refs and the .cube picker's are Editor's hooks, passed in.

import {
  EXTRA_LABELS,
  defaultExtra,
  type ExtraAdjustmentType,
} from "../lib/adjust-extra";
import type { AdjustmentSpec, Adjustments } from "../lib/adjust";
import { specFromPreset, specFromType, specLabel } from "../lib/adjustment-types";
import {
  findNode,
  insertInGroup,
  insertRelative,
  updateNode,
  type LayerAdjustment,
  type LayerNode,
} from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { defaultCurves, defaultLevels } from "../lib/tone";
import type { DialogState, ToneEdit } from "../state/dialogs";
import type { Doc } from "../state/documents";
import type { Sel } from "./layers";

/** What the adjustment operations need of the editor. */
export interface AdjustmentContext {
  /** The active document's id — the latest, read when a step is made. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  selNow(): Sel;
  single(id: string | null): Sel;
  setDocSel(docId: string, layers: LayerNode[], sel: Sel): void;
  /** What adjustment layers are numbered from. */
  adjSeqRef: { current: number };
  /** A slider gesture on an adjustment: the tree from before it, until it ends. */
  adjEditRef: { current: { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  adjEditTimer: { current: number };
  /** The hidden .cube picker, and what its file is for. */
  cubeInputRef: { readonly current: HTMLInputElement | null };
  cubeTargetRef: { current: "new" | string | null };
  setToneEdit(edit: ToneEdit | null): void;
  setExtraEdit(edit: DialogState["extraEdit"]): void;
  /** The active layer when it is a pixel layer, as this render sees it. */
  activeLeafId: string | null;
}

export function adjustmentOps(ctx: AdjustmentContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    selNow,
    single,
    setDocSel,
    adjSeqRef,
    adjEditRef,
    adjEditTimer,
    cubeInputRef,
    cubeTargetRef,
    setToneEdit,
    setExtraEdit,
    activeLeafId,
  } = ctx;

  const commitAdjustEdit = () => {
    const sess = adjEditRef.current;
    adjEditRef.current = null;
    if (adjEditTimer.current) {
      window.clearTimeout(adjEditTimer.current);
      adjEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Adjustment",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Insert an adjustment layer above the active layer (same parent); mask it from
  // the current selection if one exists, then select it so the panel binds live.
  const addAdjustmentOp = (
    typeId: string,
    fromPreset?: string,
    params?: Adjustments,
    explicitSpec?: AdjustmentSpec,
  ): string | null => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return null;
    commitAdjustEdit();
    const docId = d.id;
    const selBefore = selNow();
    const before = d.layers;
    const id = `adj-${(adjSeqRef.current += 1)}`;
    const spec: AdjustmentSpec = explicitSpec
      ? explicitSpec
      : params
        ? { type: "sliders", params }
        : fromPreset
          ? specFromPreset(fromPreset)
          : specFromType(typeId);
    const node: LayerAdjustment = {
      id,
      type: "adjustment",
      name: fromPreset ?? specLabel(spec),
      visible: true,
      opacity: 100,
      blend: "Normal",
      adjustment: spec,
      clipped: false,
    };
    const anchor = d.activeLayerId ? findNode(before, d.activeLayerId) : null;
    let after: LayerNode[];
    if (anchor && anchor.type === "group") after = insertInGroup(before, node, anchor.id);
    else if (anchor) after = insertRelative(before, node, anchor.id, true);
    else after = [node, ...before];
    const hasSel = d.selection.length > 0;
    if (hasSel) {
      after = updateNode(after, id, { mask: { enabled: true, linked: true } });
      eng.allocMask(id, "selection", d.selection, d.selectionAngle, d.selectionPivot);
    }
    const maskSnap = hasSel ? eng.captureMask(id) : null;
    setDocSel(docId, after, single(id));
    eng.pushStructural(
      "New Adjustment Layer",
      () => {
        if (hasSel) eng.freeMask(id);
        setDocSel(docId, before, selBefore);
      },
      () => {
        if (maskSnap) eng.restoreMask(id, maskSnap);
        setDocSel(docId, after, single(id));
      },
    );
    return id;
  };

  // Live param edit from the panel (no per-tick history; one step per gesture).
  const editAdjustmentParams = (patch: Partial<Adjustments>) => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id) return;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "adjustment" || node.adjustment.type !== "sliders") return;
    if (!adjEditRef.current || adjEditRef.current.layerId !== id) {
      commitAdjustEdit();
      adjEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    const spec: AdjustmentSpec = {
      type: "sliders",
      params: { ...node.adjustment.params, ...patch },
    };
    setDocSel(d.id, updateNode(d.layers, id, { adjustment: spec }), selNow());
    if (adjEditTimer.current) window.clearTimeout(adjEditTimer.current);
    adjEditTimer.current = window.setTimeout(commitAdjustEdit, 500); // gesture-end commit
  };

  // Clip / release a layer (any kind) to the layer directly below it — a cheap,
  // pixel-free structural step.
  const setClippedOp = (id: string, clipped: boolean) => {
    const d = activeDocRef.current;
    const node = findNode(d.layers, id);
    if (!node || !!node.clipped === clipped) return;
    commitAdjustEdit();
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { clipped });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      clipped ? "Create Clipping Mask" : "Release Clipping Mask",
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };
  // Toggle the active layer's clip (menu / Ctrl+Alt+G).
  const toggleClippingMask = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id) return;
    const node = findNode(d.layers, id);
    if (node) setClippedOp(id, !node.clipped);
  };

  // Live-edit an adjustment NODE's spec (debounced one-step structural history).
  // Shared by the tone dialogs and the extra-adjustment dialog.
  const setToneNodeSpec = (layerId: string, spec: AdjustmentSpec) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, layerId)) return;
    if (!adjEditRef.current || adjEditRef.current.layerId !== layerId) {
      commitAdjustEdit();
      adjEditRef.current = { layerId, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, layerId, { adjustment: spec }), selNow());
    if (adjEditTimer.current) window.clearTimeout(adjEditTimer.current);
    adjEditTimer.current = window.setTimeout(commitAdjustEdit, 500);
  };

  const addToneAdjustment = (tool: "curves" | "levels") => {
    const spec = tool === "curves" ? defaultCurves() : defaultLevels();
    const id = addAdjustmentOp("", undefined, undefined, spec);
    if (id) setToneEdit({ mode: "node", tool, layerId: id });
  };
  const editToneNode = (id: string) => {
    const n = findNode(activeDocRef.current.layers, id);
    if (n?.type !== "adjustment") return;
    const t = n.adjustment.type;
    if (t === "curves" || t === "levels") setToneEdit({ mode: "node", tool: t, layerId: id });
  };

  const addExtraAdjustment = (type: string) => {
    if (type === "colorlookup") {
      cubeTargetRef.current = "new";
      cubeInputRef.current?.click();
      return;
    }
    if (!(type in EXTRA_LABELS)) return;
    const spec = defaultExtra(type as Exclude<ExtraAdjustmentType, "colorlookup">);
    const id = addAdjustmentOp("", undefined, undefined, spec);
    // Parameterized kinds open their editor right away; invert/equalize are done.
    if (id && (type === "huesat" || type === "selective" || type === "chanmix" || type === "gradientmap"))
      setExtraEdit({ layerId: id });
  };

  const openDestructiveTone = (tool: "curves" | "levels") => {
    if (!activeLeafId) {
      showToast("Select a pixel layer first.");
      return;
    }
    setToneEdit({ mode: "dest", tool, layerId: activeLeafId, spec: tool === "curves" ? defaultCurves() : defaultLevels() });
  };

  return {
    commitAdjustEdit,
    addAdjustmentOp,
    editAdjustmentParams,
    setClippedOp,
    toggleClippingMask,
    setToneNodeSpec,
    addToneAdjustment,
    editToneNode,
    addExtraAdjustment,
    openDestructiveTone,
  };
}
