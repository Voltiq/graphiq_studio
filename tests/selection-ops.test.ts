import { describe, expect, it } from "vitest";
import { selectionOps, type SelState } from "../app/commands/selection";
import type { Layer } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import type { ToolId } from "../app/lib/tools";
import type { Rect } from "../app/lib/view";
import type { DialogState } from "../app/state/dialogs";
import { activeDoc, createDocuments, makeDoc, type Doc } from "../app/state/documents";

/**
 * The selection family (TODO 1.10, app/commands/selection.ts): the selection,
 * its journal and the Select menu — run against the documents store and an
 * engine that answers with what each test asks of it.
 */

const box = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const leaf = (id: string): Layer => ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal" });

function editor(start: Partial<Doc> = {}, engine: Record<string, unknown> = {}) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 100, height: 80, ...start }] }));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const paintRef = {
    current: {
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
      combineSelectionSoft: () => null,
      growSoftSelection: () => null,
      isFaintSelection: () => false,
      carryResizedSelection: () => {},
      ...engine,
    } as unknown as EngineHandle,
  };
  const toasts: string[] = [];
  const floats: string[] = [];
  const toolRef = { current: "select" as ToolId };
  const lastSelectionRef = { current: null as SelState | null };
  const pendingToolSelRef = { current: null as { docId: string; before: SelState; after: SelState } | null };
  let refine: DialogState["refine"] = null;
  const ops = () =>
    selectionOps({
      documents,
      activeIdRef: { current: documents.get().activeId },
      activeDocRef: { current: activeDoc(documents.get()) },
      paintRef,
      showToast: (m) => toasts.push(m),
      toolRef,
      lastSelectionRef,
      pendingToolSelRef,
      refineOpen: refine,
      setRefineOpen: (r) => (refine = r),
      commitFloatIfAny: () => floats.push("put down"),
    });
  const doc = () => activeDoc(documents.get());
  const sel = () => ({ rects: doc().selection, angle: doc().selectionAngle, pivot: doc().selectionPivot });
  return { documents, ops, doc, sel, steps, toasts, floats, toolRef, lastSelectionRef, refine: () => refine };
}

describe("the selection journal", () => {
  it("a menu change is one step that undoes and redoes, rotation and all; the same selection is none", () => {
    const e = editor();
    e.ops().commitSelection("Transform selection", [box(1, 2, 3, 4)], 0.5, { x: 2, y: 3 });
    expect(e.sel()).toEqual({ rects: [box(1, 2, 3, 4)], angle: 0.5, pivot: { x: 2, y: 3 } });
    e.ops().commitSelection("again", [box(1, 2, 3, 4)], 0.5, { x: 2, y: 3 });
    expect(e.steps.map((s) => s.label)).toEqual(["Transform selection"]);
    e.ops().commitSelection("pivot moved", [box(1, 2, 3, 4)], 0.5, { x: 5, y: 3 });
    e.ops().commitSelection("pivot moved down", [box(1, 2, 3, 4)], 0.5, { x: 5, y: 6 });
    expect(e.steps.map((s) => s.label), "a moved pivot is a change").toEqual([
      "Transform selection",
      "pivot moved",
      "pivot moved down",
    ]);
    e.steps.splice(1);
    e.steps[0].undo();
    expect(e.sel()).toEqual({ rects: [], angle: 0, pivot: null });
    e.steps[0].redo();
    expect(e.sel().angle).toBe(0.5);
  });

  it("a tool's gesture is one step when it ends, named for the tool — or Deselect when it emptied", () => {
    const e = editor();
    e.ops().toolSelectionChange([box(0, 0, 5, 5)]);
    e.ops().toolSelectionChange([box(0, 0, 9, 9)]);
    expect([e.sel().rects, e.steps]).toEqual([[box(0, 0, 9, 9)], []]);
    e.ops().flushToolSelection();
    expect(e.steps.map((s) => s.label)).toEqual(["Marquee"]);
    e.steps[0].undo();
    expect(e.sel().rects, "back to before the gesture, not its middle").toEqual([]);
    e.steps[0].redo();
    e.toolRef.current = "wand";
    e.ops().toolSelectionChange([]);
    e.ops().flushToolSelection();
    e.toolRef.current = "brush";
    e.ops().toolSelectionChange([box(1, 1, 1, 1)]);
    e.ops().flushToolSelection();
    expect(e.steps.map((s) => s.label)).toEqual(["Marquee", "Deselect", "Selection"]);
  });

  it("a gesture that ends where it began is no step; a menu command closes an open one first", () => {
    const e = editor({ selection: [box(0, 0, 5, 5)] });
    e.ops().toolSelectionChange([box(0, 0, 7, 7)]);
    e.ops().toolSelectionChange([box(0, 0, 5, 5)]);
    e.ops().flushToolSelection();
    expect(e.steps).toEqual([]);
    e.ops().toolSelectionChange([box(0, 0, 7, 7)]);
    e.ops().selectAll();
    expect(e.steps.map((s) => s.label)).toEqual(["Marquee", "Select All"]);
  });

  it("a rotated outline moved by a tool keeps its rotation; a plain one drops it", () => {
    const e = editor({ selection: [box(0, 0, 5, 5)], selectionAngle: 0.3, selectionPivot: { x: 1, y: 1 } });
    e.ops().toolSelectionChange([box(2, 0, 5, 5)], 0.3, { x: 3, y: 1 });
    expect(e.sel()).toEqual({ rects: [box(2, 0, 5, 5)], angle: 0.3, pivot: { x: 3, y: 1 } });
    e.ops().toolSelectionChange([box(4, 0, 5, 5)]);
    expect(e.sel()).toEqual({ rects: [box(4, 0, 5, 5)], angle: 0, pivot: null });
  });
});

describe("the Select menu", () => {
  it("All selects the canvas; Deselect needs something; both put a float down first", () => {
    const e = editor();
    e.ops().deselect();
    expect([e.steps, e.floats]).toEqual([[], []]);
    e.ops().selectAll();
    expect(e.sel().rects).toEqual([box(0, 0, 100, 80)]);
    e.ops().deselect();
    expect([e.sel().rects, e.steps.map((s) => s.label), e.floats]).toEqual([
      [],
      ["Select All", "Deselect"],
      ["put down", "put down"],
    ]);
  });

  it("Reselect brings the last selection back, only over nothing", () => {
    const e = editor();
    e.ops().reselect();
    e.lastSelectionRef.current = { rects: [box(1, 1, 2, 2)], angle: 0.2, pivot: { x: 2, y: 2 } };
    e.ops().reselect();
    expect(e.sel()).toEqual({ rects: [box(1, 1, 2, 2)], angle: 0.2, pivot: { x: 2, y: 2 } });
    e.lastSelectionRef.current = { rects: [box(5, 5, 2, 2)], angle: 0, pivot: null };
    e.ops().reselect();
    expect([e.sel().rects, e.steps.map((s) => s.label)]).toEqual([[box(1, 1, 2, 2)], ["Reselect"]]);
  });

  it("Inverse flips the outline, or a soft selection's coverage", () => {
    const e = editor({ selection: [box(0, 0, 50, 80)] });
    e.ops().invertSelection();
    expect(e.sel().rects).toEqual([box(50, 0, 50, 80)]);
    const soft = editor({ selection: [box(0, 0, 50, 80)] }, { combineSelectionSoft: () => [box(9, 9, 9, 9)] });
    soft.ops().invertSelection();
    expect(soft.sel().rects).toEqual([box(9, 9, 9, 9)]);
    const turned = editor(
      { selection: [box(0, 0, 50, 80)], selectionAngle: 0.5 },
      { combineSelectionSoft: () => [box(9, 9, 9, 9)] },
    );
    turned.ops().invertSelection();
    expect(turned.sel().rects, "a rotated one by its outline").toEqual([box(50, 0, 50, 80)]);
    const none = editor();
    none.ops().invertSelection();
    expect([none.steps, none.floats]).toEqual([[], []]);
  });

  it("Grow pushes a hard selection out within the canvas, and a soft one on its coverage", () => {
    const e = editor({ selection: [box(2, 74, 10, 5)] });
    e.ops().growSelection(4);
    expect(e.sel().rects, "clamped at the left and the bottom").toEqual([box(0, 70, 16, 10)]);
    const soft = editor({ selection: [box(2, 2, 2, 2)] }, { growSoftSelection: () => [box(1, 1, 9, 9)] });
    soft.ops().growSelection(2);
    expect(soft.sel().rects).toEqual([box(1, 1, 9, 9)]);
    const none = editor();
    none.ops().growSelection(2);
    expect(none.toasts).toEqual(["Grow needs an active selection — make one first."]);
  });

  it("Modify names its step and its complaint after the operation, and the result is unrotated", () => {
    const e = editor(
      { selection: [box(10, 10, 20, 20)], selectionAngle: 0.4 },
      { modifySelection: () => [box(5, 5, 30, 30)] },
    );
    e.ops().modifySelectionOp("expand", 5);
    expect([e.sel(), e.steps.map((s) => s.label)]).toEqual([
      { rects: [box(5, 5, 30, 30)], angle: 0, pivot: null },
      ["Expand"],
    ]);
    const gone = editor({ selection: [box(10, 10, 2, 2)] }, { modifySelection: () => [] });
    gone.ops().modifySelectionOp("contract", 5);
    const none = editor();
    none.ops().modifySelectionOp("border", 5);
    expect([...gone.toasts, ...none.toasts]).toEqual([
      "That would leave nothing selected.",
      "Border needs an active selection — make one first.",
    ]);
  });

  it("Feather makes the soft selection, and says when what is left is faint or nothing", () => {
    const e = editor(
      { selection: [box(10, 10, 20, 20)] },
      { featherSelection: () => [box(12, 12, 16, 16)], isFaintSelection: () => true },
    );
    e.ops().featherSelection(4);
    expect([e.sel().rects, e.steps.map((s) => s.label)]).toEqual([[box(12, 12, 16, 16)], ["Feather"]]);
    expect(e.toasts[0]).toMatch(/^No pixels are more than 50% selected/);
    const gone = editor({ selection: [box(10, 10, 2, 2)] }, { featherSelection: () => [] });
    gone.ops().featherSelection(40);
    expect(gone.toasts).toEqual(["Nothing would be left selected — feather by less, or select more first."]);
  });

  it("transform by numbers moves the outline, turns it about its centre, and does nothing for the same box", () => {
    const carried: unknown[] = [];
    const e = editor(
      { selection: [box(10, 10, 20, 20)] },
      { carryResizedSelection: (...a: unknown[]) => carried.push(a) },
    );
    e.ops().applySelBox({ x: 10, y: 10, w: 20, h: 20, angle: 0 });
    expect([e.steps, carried], "a soft selection is not resampled onto the box it is in").toEqual([[], []]);
    e.ops().applySelBox({ x: 40, y: 10, w: 20, h: 20, angle: 90 });
    expect(e.sel().rects).toEqual([box(40, 10, 20, 20)]);
    expect(e.sel().angle).toBeCloseTo(Math.PI / 2);
    expect(e.sel().pivot).toEqual({ x: 50, y: 20 });
    expect(e.steps.map((s) => s.label)).toEqual(["Transform selection"]);
    expect(carried, "a soft one is carried to the new box").toHaveLength(1);
  });

  it("Load Mask as Selection takes the mask's outline, unrotated, when there is a mask", () => {
    const e = editor(
      { layers: [{ ...leaf("a"), mask: { enabled: true, linked: true } }], activeLayerId: "a", selectionAngle: 0.3 },
      { maskSelectionRects: () => [box(3, 3, 4, 4)] },
    );
    e.ops().loadMaskAsSelectionOp();
    expect([e.sel(), e.steps.map((s) => s.label)]).toEqual([
      { rects: [box(3, 3, 4, 4)], angle: 0, pivot: null },
      ["Load Mask as Selection"],
    ]);
    const bare = editor({ layers: [leaf("a")], activeLayerId: "a" }, { maskSelectionRects: () => [box(3, 3, 4, 4)] });
    bare.ops().loadMaskAsSelectionOp();
    expect(bare.steps).toEqual([]);
  });

  it("Refine Edge opens on a selection and makes a new one; decontamination needs a pixel layer", () => {
    const none = editor();
    none.ops().openRefineEdge();
    expect(none.toasts).toEqual(["Refine edge needs an active selection — make one first."]);
    const e = editor(
      { selection: [box(10, 10, 20, 20)], layers: [] },
      {
        exportComposite: () => "composite",
        selectionCoverageCanvas: () => "coverage",
        refineSelection: () => [box(9, 9, 22, 22)],
      },
    );
    e.ops().openRefineEdge();
    const initial = { smooth: 0, feather: 0, contrast: 0, shift: 0 };
    expect(e.refine()).toEqual({ source: "composite", mask: "coverage", initial });
    e.ops().applyRefineEdge({ smooth: 0, feather: 4, contrast: 0, shift: 0 }, 50);
    expect(e.refine(), "the dialog closes").toBeNull();
    expect([e.sel().rects, e.steps.map((s) => s.label)]).toEqual([[box(9, 9, 22, 22)], ["Refine Edge"]]);
    expect(e.toasts).toEqual(["Decontaminate needs a pixel layer selected."]);
    const empty = editor(
      { selection: [box(10, 10, 2, 2)] },
      { exportComposite: () => "c", selectionCoverageCanvas: () => "m", refineSelection: () => [] },
    );
    empty.ops().openRefineEdge();
    empty.ops().applyRefineEdge({ smooth: 0, feather: 0, contrast: 0, shift: -100 }, 0);
    expect([empty.toasts, empty.steps]).toEqual([["Nothing would be left selected by that refinement."], []]);
  });

  it("the setters change the document in front only", () => {
    const e = editor({ selection: [box(1, 1, 1, 1)], selectionAngle: 0.2, selectionPivot: { x: 1, y: 1 } });
    e.documents.set((s) => ({ docs: [...s.docs, makeDoc(2)] }));
    e.ops().setSelectionRects([box(2, 2, 2, 2)]);
    expect(e.sel()).toEqual({ rects: [box(2, 2, 2, 2)], angle: 0.2, pivot: { x: 1, y: 1 } });
    e.ops().setSelectionAngle(0.7);
    e.ops().setSelectionPivot({ x: 5, y: 5 });
    expect(e.sel()).toEqual({ rects: [box(2, 2, 2, 2)], angle: 0.7, pivot: { x: 5, y: 5 } });
    e.ops().setSelection([box(3, 3, 3, 3)]);
    expect(e.sel(), "a new selection drops the rotation").toEqual({ rects: [box(3, 3, 3, 3)], angle: 0, pivot: null });
    expect(e.documents.get().docs[1].selection).toEqual([]);
  });
});
