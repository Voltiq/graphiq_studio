// The fills family (TODO 1.10): fill layers — a solid colour or a gradient
// from the current colours, masked by the selection, their editor opened — and
// frames, drawn with the Frame tool or made from a layer around its content.
//
// `fillOps` is called on every render of Editor, as `layerOps` is; it takes
// the adjustments family's `commitAdjustEdit` and the effects family's
// `stylePatchStructural` through its context.

import { defaultFrame, framePath, type FrameSpec } from "../lib/frame";
import {
  fillLabel,
  findNode,
  insertInGroup,
  insertRelative,
  updateNode,
  type FillSpec,
  type Layer,
  type LayerNode,
} from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { defaultVectorMask } from "../lib/vector-mask";
import type { DialogState } from "../state/dialogs";
import type { Doc } from "../state/documents";
import type { Sel } from "./layers";

/** What the fill and frame operations need of the editor. */
export interface FillContext {
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  /** The colours, as this render sees them: a new fill starts from them. */
  foreground: string;
  background: string;
  selNow(): Sel;
  single(id: string | null): Sel;
  setDocSel(docId: string, layers: LayerNode[], sel: Sel): void;
  nextLeafId(): string;
  /** Close an adjustment's slider gesture before the tree changes under it. */
  commitAdjustEdit(): void;
  stylePatchStructural(id: string, patch: Partial<LayerNode>, label: string): void;
  /** The fill layer whose editor is open. */
  setFillEdit(edit: DialogState["fillEdit"]): void;
}

export function fillOps(ctx: FillContext) {
  const {
    activeDocRef,
    paintRef,
    showToast,
    foreground,
    background,
    selNow,
    single,
    setDocSel,
    nextLeafId,
    commitAdjustEdit,
    stylePatchStructural,
    setFillEdit,
  } = ctx;

  // A default fill spec for a new fill layer of the given kind (uses the current
  // colours so it's immediately meaningful, then opens the editor to tweak).
  const defaultFill = (kind: "solid" | "gradient"): FillSpec =>
    kind === "solid"
      ? { kind: "solid", color: foreground }
      : {
          kind: "gradient",
          gradient: {
            stops: [
              { color: foreground, pos: 0 },
              { color: background, pos: 1 },
            ],
            type: "linear",
            angle: 90,
            scale: 1,
            reverse: false,
            smooth: false,
          },
        };

  // Insert a new Fill layer above the active node (folding a live selection into
  // a confining mask), as one undoable structural step. Mirrors addAdjustmentOp.
  const addFillLayer = (fill: FillSpec): string | null => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return null;
    commitAdjustEdit();
    const docId = d.id;
    const selBefore = selNow();
    const before = d.layers;
    const id = nextLeafId();
    const node: Layer = {
      id,
      type: "layer",
      name: fillLabel(fill),
      visible: true,
      opacity: 100,
      blend: "Normal",
      fill,
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
      "New Fill Layer",
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

  /**
   * Create a frame: a layer carrying a FrameSpec and a vector mask in the
   * frame's shape. The mask is what actually clips, so a frame needs no new
   * compositing path — anything painted or pasted into the layer is confined to
   * the frame from the moment it exists.
   */
  const addFrameLayer = (spec: FrameSpec): string | null => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return null;
    const docId = d.id;
    const selBefore = selNow();
    const before = d.layers;
    const id = nextLeafId();
    const node: Layer = {
      id,
      type: "layer",
      name: "Frame",
      visible: true,
      opacity: 100,
      blend: "Normal",
      frame: spec,
      vectorMask: defaultVectorMask(framePath(spec)),
    };
    const anchor = d.activeLayerId ? findNode(before, d.activeLayerId) : null;
    let after: LayerNode[];
    if (anchor && anchor.type === "group") after = insertInGroup(before, node, anchor.id);
    else if (anchor) after = insertRelative(before, node, anchor.id, true);
    else after = [node, ...before];
    setDocSel(docId, after, single(id));
    eng.pushStructural(
      "New Frame",
      () => setDocSel(docId, before, selBefore),
      () => setDocSel(docId, after, single(id)),
    );
    return id;
  };

  /**
   * Turn an existing layer into a frame around its own content.
   *
   * The counterpart to drawing an empty frame: you already have the picture and
   * want a window onto it. The frame takes the layer's content bounds, so
   * nothing is cropped at the moment of conversion — the crop starts when you
   * resize the frame.
   */
  const frameFromLayerOp = (id: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, id);
    if (!eng || !node || node.type !== "layer") return;
    const b = eng.layerContentBounds(id);
    if (!b) {
      showToast("That layer has no pixels to frame.");
      return;
    }
    const spec = defaultFrame(b);
    stylePatchStructural(
      id,
      { frame: spec, vectorMask: defaultVectorMask(framePath(spec)) },
      "Frame from Layer",
    );
  };

  // Create a fill layer of the given kind and open its editor immediately.
  const addFillOp = (kind: "solid" | "gradient") => {
    const id = addFillLayer(defaultFill(kind));
    if (id) setFillEdit({ layerId: id });
  };

  return {
    addFrameLayer,
    frameFromLayerOp,
    addFillOp,
  };
}
