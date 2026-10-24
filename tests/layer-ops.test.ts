import { describe, expect, it } from "vitest";
import { layerOps, type Sel } from "../app/commands/layers";
import { collectLeafIds, type Layer, type LayerGroup, type LayerNode } from "../app/lib/layers";
import type { EngineHandle, LeafSnapshot } from "../app/lib/paint";
import { activeDoc, createDocuments, makeDoc } from "../app/state/documents";

/**
 * The layers family (TODO 1.10, app/commands/layers.ts): the structural layer
 * operations, and the undoable change they all go through — run against the
 * documents store and an engine that only remembers what was done to it.
 */

const leaf = (id: string, extra: Partial<Layer> = {}): Layer => ({
  id,
  type: "layer",
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  ...extra,
});
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
/** The tree as ids, groups as [id, children]. */
const shape = (ns: LayerNode[]): unknown[] => ns.map((n) => (n.type === "group" ? [n.id, shape(n.children)] : n.id));

/** An editor of one document holding `layers`; `ops()` is what one render of Editor builds. */
function editor(layers: LayerNode[], start: Sel = { active: null, selected: [] }) {
  const documents = createDocuments();
  documents.set((s) => ({
    docs: [{ ...s.docs[0], layers, activeLayerId: start.active, selectedLayerIds: start.selected }],
  }));
  // Each leaf's pixels, as a token; a merge's are the leaves it was made of.
  const pixels = new Map<string, string>(collectLeafIds(layers).map((id) => [id, `px:${id}`]));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const engine = {
    captureLeaves: (ids: string[]) =>
      new Map(ids.map((id) => [id, { layer: pixels.get(id) ?? null, mask: null } as unknown as LeafSnapshot])),
    restoreLeaves: (snaps: Map<string, LeafSnapshot>) =>
      snaps.forEach((s, id) => (s.layer ? pixels.set(id, s.layer as unknown as string) : pixels.delete(id))),
    removeLayer: (id: string) => pixels.delete(id),
    duplicateLayer: (from: string, to: string) => pixels.set(to, pixels.get(from)!),
    rasterize: (to: string, nodes: LayerNode[]) => pixels.set(to, `merged:${collectLeafIds(nodes).join("+")}`),
    pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
  } as unknown as EngineHandle;
  const toasts: string[] = [];
  const layerSeqRef = { current: 0 };
  const activeIdRef = {
    get current() {
      return documents.get().activeId;
    },
  };
  const ops = () =>
    layerOps({
      active: activeDoc(documents.get()),
      activeIdRef,
      documents,
      paintRef: { current: engine },
      layerSeqRef,
      showToast: (m) => toasts.push(m),
    });
  const doc = () => activeDoc(documents.get());
  const sel = () => ({ active: doc().activeLayerId, selected: doc().selectedLayerIds });
  return { documents, ops, doc, sel, tree: () => shape(doc().layers), pixels, steps, toasts };
}

describe("the layer operations", () => {
  it("New Layer goes above the active layer, as one step that undoes and redoes", () => {
    const e = editor([leaf("a"), leaf("b")], { active: "b", selected: ["b"] });
    e.ops().addLayerOp();
    expect(e.tree()).toEqual(["a", "layer-1", "b"]);
    expect(e.doc().layers[1].name, "named by the count").toBe("Layer 1");
    expect(e.sel()).toEqual({ active: "layer-1", selected: ["layer-1"] });
    expect(e.steps.map((s) => s.label)).toEqual(["New Layer"]);
    e.steps[0].undo();
    expect([e.tree(), e.sel()]).toEqual([["a", "b"], { active: "b", selected: ["b"] }]);
    e.steps[0].redo();
    expect([e.tree(), e.sel()]).toEqual([["a", "layer-1", "b"], { active: "layer-1", selected: ["layer-1"] }]);
  });

  it("New Layer goes to the top of an active group, or of the stack when nothing is active", () => {
    const e = editor([group("g", [leaf("a")]), leaf("b")], { active: "g", selected: ["g"] });
    e.ops().addLayerOp();
    expect(e.tree()).toEqual([["g", ["layer-1", "a"]], "b"]);
    const f = editor([leaf("a")]);
    f.ops().addLayerOp();
    expect(f.tree()).toEqual(["layer-1", "a"]);
  });

  it("Duplicate copies each top-level selected node once, pixels too, above itself", () => {
    // A layer selected together with the group it is in is duplicated with the group.
    const e = editor([group("g", [leaf("a"), leaf("b")]), leaf("c")], { active: "c", selected: ["g", "a", "c"] });
    e.ops().duplicateSelected();
    expect(e.tree()).toEqual([["layer-1", ["layer-2", "layer-3"]], ["g", ["a", "b"]], "layer-4", "c"]);
    expect(e.doc().layers.map((n) => n.name)).toEqual(["g copy", "g", "c copy", "c"]);
    expect(e.sel()).toEqual({ active: "layer-1", selected: ["layer-1", "layer-4"] });
    const copies = ["layer-2", "layer-3", "layer-4"].map((id) => e.pixels.get(id));
    expect(copies).toEqual(["px:a", "px:b", "px:c"]);
    expect(e.steps.map((s) => s.label)).toEqual(["Duplicate Layers"]);
    e.steps[0].undo();
    expect(e.tree()).toEqual([["g", ["a", "b"]], "c"]);
    expect(e.pixels.has("layer-4"), "the copies' pixels go with them").toBe(false);
  });

  it("Delete removes what is selected — or the active layer — and its undo brings the pixels back", () => {
    const e = editor([leaf("a"), leaf("b"), leaf("c")], { active: "b", selected: [] });
    e.ops().removeSelected();
    expect([e.tree(), e.sel()]).toEqual([["a", "c"], { active: "a", selected: ["a"] }]);
    expect(e.steps.map((s) => s.label)).toEqual(["Delete Layer"]);
    expect(e.pixels.has("b")).toBe(false);
    e.steps[0].undo();
    expect([e.tree(), e.pixels.get("b")]).toEqual([["a", "b", "c"], "px:b"]);
    e.documents.set((s) => ({ docs: [{ ...s.docs[0], selectedLayerIds: ["a", "c"] }] }));
    e.ops().removeSelected();
    expect([e.tree(), e.steps[1].label]).toEqual([["b"], "Delete Layers"]);
    const none = editor([leaf("a")]);
    none.ops().removeSelected();
    expect([none.tree(), none.steps]).toEqual([["a"], []]);
  });

  it("Group wraps the selection where its topmost node was; Ungroup lets it out again", () => {
    const e = editor([leaf("a"), leaf("b"), leaf("c")], { active: "c", selected: ["b", "c"] });
    e.ops().groupSelected();
    expect([e.tree(), e.sel()]).toEqual([["a", ["grp-1", ["b", "c"]]], { active: "grp-1", selected: ["grp-1"] }]);
    e.ops().ungroupLayerOp("grp-1");
    expect([e.tree(), e.sel()]).toEqual([["a", "b", "c"], { active: "b", selected: ["b"] }]);
    e.ops().ungroupLayerOp("a"); // not a group: nothing
    expect(e.steps.map((s) => s.label)).toEqual(["Group Layers", "Ungroup"]);
    e.steps[1].undo();
    expect(e.tree()).toEqual(["a", ["grp-1", ["b", "c"]]]);
  });

  it("Merge makes one layer of the selection where the bottommost was; one layer merges down", () => {
    const e = editor([leaf("a"), leaf("b"), leaf("c")], { active: "a", selected: ["a", "c"] });
    e.ops().mergeSelected();
    expect([e.tree(), e.sel()]).toEqual([["b", "layer-1"], { active: "layer-1", selected: ["layer-1"] }]);
    expect([e.doc().layers[1].name, e.pixels.get("layer-1")], "named after it").toEqual(["c", "merged:a+c"]);
    expect([e.pixels.has("a"), e.pixels.has("c")], "the merged layers are gone").toEqual([false, false]);
    e.ops().mergeSelected(); // the bottom layer: nothing below it to merge down onto
    expect(e.steps).toHaveLength(1);
    e.documents.set((s) => ({ docs: [{ ...s.docs[0], activeLayerId: "b", selectedLayerIds: ["b"] }] }));
    e.ops().mergeSelected();
    expect([e.tree(), e.doc().layers[0].name, e.pixels.get("layer-3")]).toEqual([["layer-3"], "c", "merged:b+layer-1"]);
    expect(e.steps.map((s) => s.label)).toEqual(["Merge Layers", "Merge Down"]);
    e.steps[1].undo();
    expect([e.tree(), e.pixels.get("b"), e.pixels.get("layer-1")]).toEqual([["b", "layer-1"], "px:b", "merged:a+c"]);
  });

  it("Merge Visible collapses what shows, Stamp Visible copies it to a new layer, and both say when they can't", () => {
    const e = editor([leaf("a"), leaf("b", { visible: false }), leaf("c")], { active: "a", selected: ["a"] });
    e.ops().stampVisibleOp();
    expect(e.tree(), "the originals stay").toEqual(["layer-1", "a", "b", "c"]);
    expect(e.pixels.get("layer-1")).toBe("merged:a+b+c");
    e.ops().mergeVisibleOp();
    expect(e.tree(), "the hidden one stays").toContain("b");
    expect(e.steps.map((s) => s.label)).toEqual(["Stamp Visible", "Merge Visible"]);
    const hidden = editor([leaf("a", { visible: false })]);
    hidden.ops().mergeVisibleOp();
    hidden.ops().stampVisibleOp();
    const one = editor([leaf("a")]);
    one.ops().mergeVisibleOp();
    expect([...hidden.toasts, ...one.toasts]).toEqual([
      "Nothing visible to merge.",
      "Nothing visible to stamp.",
      "Only one visible layer — nothing to merge into.",
    ]);
    expect([hidden.steps, one.steps]).toEqual([[], []]);
  });

  it("Flatten leaves one layer of everything, and nothing to do on an empty document", () => {
    const e = editor([group("g", [leaf("a")]), leaf("b", { visible: false })], { active: "b", selected: ["b"] });
    e.ops().flattenImage();
    const flat = [e.tree(), e.doc().layers[0].name, e.pixels.get("layer-1")];
    expect(flat).toEqual([["layer-1"], "Flattened", "merged:a+b"]);
    e.steps[0].undo();
    expect([e.tree(), e.pixels.get("a"), e.pixels.get("b")]).toEqual([[["g", ["a"]], "b"], "px:a", "px:b"]);
    const empty = editor([]);
    empty.ops().flattenImage();
    expect(empty.steps).toEqual([]);
  });

  it("a step belongs to the document it was made in, whichever is in front when it is undone", () => {
    const e = editor([leaf("a")], { active: "a", selected: ["a"] });
    e.ops().addLayerOp();
    e.documents.set((s) => ({ docs: [...s.docs, makeDoc(2)], activeId: "doc-2" }));
    e.steps[0].undo();
    const first = e.documents.get().docs[0];
    expect(shape(first.layers)).toEqual(["a"]);
    expect(e.doc().layers, "the one in front is untouched").toEqual([]);
  });

  it("a canvas-size change rides in the same step", () => {
    const e = editor([leaf("a")], { active: "a", selected: ["a"] });
    const { commitLayerChange, single } = e.ops();
    commitLayerChange("Import", e.doc().layers, single("a"), [leaf("b"), leaf("a")], single("b"), () => {}, {
      bw: 1920,
      bh: 1080,
      aw: 3000,
      ah: 2000,
    });
    expect([e.doc().width, e.doc().height, e.tree()]).toEqual([3000, 2000, ["b", "a"]]);
    e.steps[0].undo();
    expect([e.doc().width, e.doc().height, e.tree()]).toEqual([1920, 1080, ["a"]]);
    e.steps[0].redo();
    expect([e.doc().width, e.doc().height]).toEqual([3000, 2000]);
  });
});
