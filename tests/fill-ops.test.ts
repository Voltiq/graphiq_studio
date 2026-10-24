import { describe, expect, it } from "vitest";
import { fillOps } from "../app/commands/fills";
import { layerOps } from "../app/commands/layers";
import { defaultFrame, framePath } from "../app/lib/frame";
import { findNode, type Layer, type LayerGroup, type LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import type { Rect } from "../app/lib/view";
import { defaultVectorMask } from "../app/lib/vector-mask";
import type { DialogState } from "../app/state/dialogs";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The fills family (TODO 1.10, app/commands/fills.ts): fill layers from the
 * current colours, masked by the selection, and frames — drawn, or made from a
 * layer around its content — against the documents store and the layer
 * family's helpers.
 */

const leaf = (id: string): Layer => ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal" });
const group = (id: string, children: LayerNode[]): LayerGroup => ({
  id,
  type: "group",
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  expanded: true,
  children,
});
const ids = (ns: LayerNode[]): unknown[] => ns.map((n) => (n.type === "group" ? [n.id, ids(n.children)] : n.id));

function editor(layers: LayerNode[], start: Partial<Doc> = {}, bounds: Record<string, Rect | null> = {}) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], layers, activeLayerId: layers[0]?.id ?? null, ...start }] }));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const masks = new Map<string, string>();
  const paintRef = {
    current: {
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
      allocMask: (id: string, init: string) => masks.set(id, init),
      captureMask: (id: string) => masks.get(id) ?? null,
      restoreMask: (id: string, m: string) => masks.set(id, m),
      freeMask: (id: string) => masks.delete(id),
      captureLeaves: () => new Map(),
      restoreLeaves: () => {},
      layerContentBounds: (id: string) => bounds[id] ?? null,
    } as unknown as EngineHandle,
  };
  const calls: string[] = [];
  const toasts: string[] = [];
  const patches: [string, Partial<LayerNode>, string][] = [];
  let edit: DialogState["fillEdit"] = null;
  let seq = 0;
  const ops = () => {
    const active = activeDoc(documents.get());
    const { selNow, single, setDocSel } = layerOps({
      active,
      activeIdRef: { current: documents.get().activeId },
      documents,
      paintRef,
      layerSeqRef: { current: 0 },
      showToast: () => {},
    });
    return fillOps({
      activeDocRef: { current: active },
      paintRef,
      showToast: (m) => toasts.push(m),
      foreground: "#112233",
      background: "#ddeeff",
      selNow,
      single,
      setDocSel,
      nextLeafId: () => `layer-${(seq += 1)}`,
      commitAdjustEdit: () => calls.push("adjustment gesture closed"),
      stylePatchStructural: (id, patch, label) => patches.push([id, patch, label]),
      setFillEdit: (x) => (edit = x),
    });
  };
  const doc = () => activeDoc(documents.get());
  const node = (id: string) => findNode(doc().layers, id) as Layer;
  return { ops, doc, node, tree: () => ids(doc().layers), steps, masks, calls, toasts, patches, edit: () => edit };
}

describe("fill layers", () => {
  it("a solid fill in the foreground colour goes above the active layer, selected, its editor open", () => {
    const e = editor([leaf("a"), leaf("b")], { activeLayerId: "b" });
    e.ops().addFillOp("solid");
    expect(e.tree()).toEqual(["a", "layer-1", "b"]);
    expect(e.node("layer-1")).toMatchObject({ name: "Color Fill", fill: { kind: "solid", color: "#112233" } });
    expect([e.doc().activeLayerId, e.edit(), e.calls]).toEqual([
      "layer-1",
      { layerId: "layer-1" },
      ["adjustment gesture closed"],
    ]);
    expect(e.steps.map((s) => s.label)).toEqual(["New Fill Layer"]);
    e.steps[0].undo();
    expect([e.tree(), e.doc().activeLayerId]).toEqual([["a", "b"], "b"]);
    e.steps[0].redo();
    expect(e.tree()).toEqual(["a", "layer-1", "b"]);
  });

  it("a gradient runs from the foreground to the background, top to bottom", () => {
    const e = editor([leaf("a")]);
    e.ops().addFillOp("gradient");
    expect(e.node("layer-1").fill).toEqual({
      kind: "gradient",
      gradient: {
        stops: [
          { color: "#112233", pos: 0 },
          { color: "#ddeeff", pos: 1 },
        ],
        type: "linear",
        angle: 90,
        scale: 1,
        reverse: false,
        smooth: false,
      },
    });
  });

  it("a selection becomes its mask, which a redo brings back; into an active group, or on top of nothing", () => {
    const e = editor([leaf("a")], { selection: [{ x: 1, y: 1, w: 4, h: 4 }] });
    e.ops().addFillOp("solid");
    expect([e.node("layer-1").mask, e.masks.get("layer-1")]).toEqual([{ enabled: true, linked: true }, "selection"]);
    e.steps[0].undo();
    expect(e.masks.has("layer-1")).toBe(false);
    e.steps[0].redo();
    expect(e.masks.get("layer-1")).toBe("selection");
    const g = editor([group("g", [leaf("a")])]);
    g.ops().addFillOp("solid");
    expect(g.tree()).toEqual([["g", ["layer-1", "a"]]]);
    const none = editor([]);
    none.ops().addFillOp("solid");
    expect([none.tree(), none.node("layer-1").mask]).toEqual([["layer-1"], undefined]);
  });
});

describe("frames", () => {
  it("a frame drawn is a layer with its spec, clipped by its shape, as one step", () => {
    const e = editor([leaf("a")]);
    const spec = defaultFrame({ x: 10, y: 20, w: 30, h: 40 }, "ellipse");
    const id = e.ops().addFrameLayer(spec);
    expect([id, e.tree()]).toEqual(["layer-1", ["layer-1", "a"]]);
    const vectorMask = defaultVectorMask(framePath(spec));
    expect(e.node("layer-1")).toMatchObject({ name: "Frame", frame: spec, vectorMask });
    expect([e.doc().activeLayerId, e.steps.map((s) => s.label), e.calls]).toEqual(["layer-1", ["New Frame"], []]);
    e.steps[0].undo();
    expect(e.tree()).toEqual(["a"]);
    const g = editor([group("g", [leaf("a")])]);
    g.ops().addFrameLayer(spec);
    expect(g.tree(), "into an active group").toEqual([["g", ["layer-1", "a"]]]);
  });

  it("a frame from a layer takes its content's bounds; an empty layer, or not a pixel layer, cannot", () => {
    const b = { x: 5, y: 6, w: 70, h: 80 };
    const e = editor([leaf("a"), leaf("empty"), group("g", [])], {}, { a: b });
    e.ops().frameFromLayerOp("a");
    const spec = defaultFrame(b);
    const vectorMask = defaultVectorMask(framePath(spec));
    expect(e.patches).toEqual([["a", { frame: spec, vectorMask }, "Frame from Layer"]]);
    e.ops().frameFromLayerOp("empty");
    e.ops().frameFromLayerOp("g");
    expect([e.patches.length, e.toasts]).toEqual([1, ["That layer has no pixels to frame."]]);
  });
});
