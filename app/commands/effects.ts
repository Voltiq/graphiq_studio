// The effects family (TODO 1.10): layer styles — the dialog's live edits as
// one step per gesture, an effect turned on or off, a saved style applied,
// copy / paste / clear, and Add Layer Effect from the menu.
//
// `effectOps` is called on every render of Editor, as `layerOps` is. The
// style clipboard and the live edit's refs are Editor's hooks, passed in.

import { DEFAULT_FX, type FxKey, type LayerEffects } from "../lib/effects";
import { findNode, updateNode, type LayerNode } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { styleToPatch, type LayerStylePreset } from "../lib/styleio";
import type { Doc } from "../state/documents";
import type { Sel } from "./layers";

/** What the layer-style operations need of the editor. */
export interface EffectContext {
  /** The active document's id — the latest, read when a step is made. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  selNow(): Sel;
  setDocSel(docId: string, layers: LayerNode[], sel: Sel): void;
  /** A gesture in the Layer Style dialog: the tree from before it, until it ends. */
  fxEditRef: { current: { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  fxEditTimer: { current: number };
  /** Copy Layer Style's clipboard, as this render sees it. */
  fxClipboard: LayerEffects | null;
  setFxClipboard(fx: LayerEffects | null): void;
  /** The layer whose Layer Style dialog is open. */
  setLayerStyleTarget(id: string | null): void;
  selectLayer(id: string, mode: "replace" | "toggle" | "range"): void;
}

export function effectOps(ctx: EffectContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    selNow,
    setDocSel,
    fxEditRef,
    fxEditTimer,
    fxClipboard,
    setFxClipboard,
    setLayerStyleTarget,
    selectLayer,
  } = ctx;

  const commitFxEdit = () => {
    const sess = fxEditRef.current;
    fxEditRef.current = null;
    if (fxEditTimer.current) {
      window.clearTimeout(fxEditTimer.current);
      fxEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Layer Style",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Live FX edit from the dialog (no per-tick history; one step per gesture).
  const setLayerEffectsOp = (id: string, effects: LayerEffects) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    if (!fxEditRef.current || fxEditRef.current.layerId !== id) {
      commitFxEdit();
      fxEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, id, { effects }), selNow());
    if (fxEditTimer.current) window.clearTimeout(fxEditTimer.current);
    fxEditTimer.current = window.setTimeout(commitFxEdit, 500);
  };

  // Discrete structural style op (toggle / paste / clear / preset) — one history
  // step. Takes a whole patch because a style preset sets the blending fields
  // alongside the effects, and undo has to take all of it back together.
  const stylePatchStructural = (id: string, patch: Partial<LayerNode>, label: string) => {
    commitFxEdit();
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, patch);
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  const fxStructural = (id: string, effects: LayerEffects | undefined, label: string) =>
    stylePatchStructural(id, { effects }, label);

  /** Apply a saved layer style: effects AND blending, replacing what was there. */
  const applyStylePresetOp = (id: string, p: LayerStylePreset) => {
    const patch = styleToPatch(p);
    stylePatchStructural(
      id,
      {
        effects: patch.effects,
        fillOpacity: patch.fillOpacity,
        knockout: patch.knockout,
        blendIf: patch.blendIf,
      },
      "Apply Layer Style",
    );
  };

  const toggleEffectOp = (id: string, key: FxKey, enabled: boolean) => {
    const node = findNode(activeDocRef.current.layers, id);
    if (!node) return;
    const cur = node.effects ?? {};
    const existing = cur[key];
    const eff = existing ? { ...existing, enabled } : { ...DEFAULT_FX[key](), enabled };
    fxStructural(id, { ...cur, [key]: eff } as LayerEffects, enabled ? "Enable Effect" : "Disable Effect");
  };

  const copyLayerStyleOp = (id: string) => {
    const fx = findNode(activeDocRef.current.layers, id)?.effects;
    setFxClipboard(fx ? structuredClone(fx) : null);
  };
  const pasteLayerStyleOp = (id: string) => {
    if (!fxClipboard) return;
    fxStructural(id, structuredClone(fxClipboard), "Paste Layer Style");
  };
  const clearLayerStyleOp = (id: string) => fxStructural(id, undefined, "Clear Layer Style");

  const openLayerStyleOp = (id: string) => {
    selectLayer(id, "replace");
    setLayerStyleTarget(id);
  };
  // Add an effect (default params) and open the dialog to it.
  const addEffectOp = (key: FxKey) => {
    const id = activeDocRef.current.activeLayerId;
    if (!id) return;
    const node = findNode(activeDocRef.current.layers, id);
    if (!node || node.type === "adjustment") return; // adjustments carry no fill to style
    const cur = node.effects ?? {};
    fxStructural(id, { ...cur, [key]: DEFAULT_FX[key]() } as LayerEffects, "Add Layer Effect");
    setLayerStyleTarget(id);
  };

  return {
    commitFxEdit,
    setLayerEffectsOp,
    stylePatchStructural,
    applyStylePresetOp,
    toggleEffectOp,
    copyLayerStyleOp,
    pasteLayerStyleOp,
    clearLayerStyleOp,
    openLayerStyleOp,
    addEffectOp,
  };
}
