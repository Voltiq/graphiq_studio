// The text family (TODO 1.10): a text layer set on the Work Path (the curve
// stored on the layer, resolved, so the next pen stroke cannot re-flow it) and
// taken off it, as one step each.
//
// `textOps` is called on every render of Editor, as `layerOps` is.

import { findNode, updateNode, type LayerNode } from "../lib/layers";
import type { EngineHandle, TextRenderSpec } from "../lib/paint";
import { WORK_PATH_ID, anchorsToPathData } from "../lib/paths";
import { DEFAULT_PATH_TEXT } from "../lib/textpath";
import type { VectorText } from "../lib/tools";
import { MIN_ANCHORS } from "../lib/vector-mask";
import type { Doc } from "../state/documents";
import type { DocumentsState } from "../state/documents";
import type { Store } from "../state/store";
/** What the text operations need of the editor. */
export interface TextContext {
  documents: Store<DocumentsState>;
  /** The active document and its id — the latest, read when an operation runs. */
  activeIdRef: { readonly current: string };
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  /** A text layer's vector, as the spec the engine draws it from, and back. */
  specFromTextVector(v: VectorText): TextRenderSpec;
  textVectorOf(spec: TextRenderSpec): VectorText;
}

export function textOps(ctx: TextContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    specFromTextVector,
    textVectorOf,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  /**
   * Put the active text layer on the Work Path, or take it off again.
   *
   * The Work Path is whatever the Pen last committed — the same path
   * "Vector mask from path" uses, and the one the Paths panel shows at the top,
   * so "on path" means the path on screen.
   *
   * The path is stored RESOLVED on the layer, as path data, rather than as a
   * reference to the Work Path. The Work Path is replaced by the next pen
   * stroke; text that silently re-flowed onto an unrelated curve, or lost its
   * shape when someone drew somewhere else, would be worse than text that keeps
   * the curve it was given.
   */
  const setTextPath = (attach: boolean) => {
    const eng = paintRef.current;
    const docId = activeIdRef.current;
    const treeBefore = activeDocRef.current.layers;
    const layerId = activeDocRef.current.activeLayerId;
    const node = layerId ? findNode(treeBefore, layerId) : null;
    if (!eng || !layerId || !node || node.type !== "layer" || node.vector?.type !== "text") {
      showToast("Select a text layer first.");
      return;
    }
    const oldVec = node.vector;
    if (!attach && !oldVec.onPath) {
      showToast("This text is not on a path.");
      return;
    }
    let onPath: VectorText["onPath"];
    if (attach) {
      const p =
        (activeDocRef.current.paths ?? []).find((x) => x.id === WORK_PATH_ID) ??
        (activeDocRef.current.paths ?? [])[0];
      if (!p || p.anchors.length < MIN_ANCHORS) {
        showToast(`Draw a path with the Pen tool first (at least ${MIN_ANCHORS} points).`);
        return;
      }
      const d = anchorsToPathData(p.anchors, p.closed);
      if (!d) {
        showToast("That path is too short to set type on.");
        return;
      }
      onPath = { ...DEFAULT_PATH_TEXT, d };
    }
    const newSpec = { ...specFromTextVector(oldVec), onPath };
    const newVec = textVectorOf(newSpec);
    const treeAfter = updateNode(treeBefore, layerId, { vector: newVec });
    const setLayers = (tree: LayerNode[]) =>
      setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, layers: tree } : d)));
    const redo = () => {
      eng.renderText(layerId, newSpec);
      setLayers(treeAfter);
    };
    const undo = () => {
      eng.renderText(layerId, specFromTextVector(oldVec));
      setLayers(treeBefore);
    };
    redo();
    eng.pushStructural(attach ? "Text on Path" : "Text off Path", undo, redo);
  };

  return {
    setTextPath,
  };
}
