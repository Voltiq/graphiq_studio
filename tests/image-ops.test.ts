import { describe, expect, it } from "vitest";
import { imageOps } from "../app/commands/image";
import type { Layer, LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import type { SelectResizeMode, ToolId } from "../app/lib/tools";
import type { Rect } from "../app/lib/view";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The image family (TODO 1.10, app/commands/image.ts): the whole image
 * rotated and flipped, cropped to the selection or trimmed, a transform begun,
 * Content-Aware Fill — against the documents store and an engine that records
 * what it was asked to do.
 */

const leaf = (id: string): Layer => ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal" });

/** A composite `w`×`h`, transparent but for the box `ink` in opaque pixels. */
const composite = (w: number, h: number, ink: Rect | null) => {
  const data = new Uint8ClampedArray(w * h * 4);
  if (ink)
    for (let y = ink.y; y < ink.y + ink.h; y++)
      for (let x = ink.x; x < ink.x + ink.w; x++) data.set([10, 20, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) };
};

function editor(layers: LayerNode[], start: Partial<Doc> = {}, engine: Record<string, unknown> = {}) {
  const documents = createDocuments();
  documents.set((s) => ({
    docs: [{ ...s.docs[0], width: 100, height: 80, layers, activeLayerId: layers[0]?.id ?? null, ...start }],
  }));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const calls: unknown[] = [];
  const paintRef = {
    current: {
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
      transformImage: (kind: string, ids: string[]) => calls.push(["transform", kind, ids]),
      cropSnapshot: () => ({ w: 100, h: 80 }),
      applyCrop: (r: Rect, ids: string[], angle: number) => calls.push(["crop", r, ids, angle]),
      cropRestore: () => calls.push(["restore"]),
      contentAwareFill: (...a: unknown[]) => calls.push(["caf", ...a]),
      ...engine,
    } as unknown as EngineHandle,
  };
  const toasts: string[] = [];
  let mode: SelectResizeMode | null = null;
  let tool: ToolId | null = null;
  const ops = () =>
    imageOps({
      documents,
      activeIdRef: { current: documents.get().activeId },
      activeDocRef: { current: activeDoc(documents.get()) },
      paintRef,
      showToast: (m) => toasts.push(m),
      setSelection: (rects) =>
        documents.set((s) => ({
          docs: s.docs.map((d) => ({ ...d, selection: rects, selectionAngle: 0, selectionPivot: null })),
        })),
      setResizeMode: (m) => (mode = m),
      setTool: (t) => (tool = t),
      commitFloatIfAny: () => calls.push(["float down"]),
    });
  const doc = () => activeDoc(documents.get());
  return { ops, doc, steps, calls, toasts, mode: () => mode, tool: () => tool };
}

describe("rotate and flip", () => {
  it("a quarter turn swaps the size and drops the selection, as one step its undo turns back", () => {
    const e = editor([leaf("a"), leaf("b")], { selection: [{ x: 1, y: 1, w: 2, h: 2 }] });
    e.ops().applyImageTransform("rotate-cw");
    expect([e.doc().width, e.doc().height, e.doc().selection]).toEqual([80, 100, []]);
    expect(e.calls).toEqual([["transform", "rotate-cw", ["a", "b"]]]);
    expect(e.steps.map((s) => s.label)).toEqual(["Rotate 90° CW"]);
    e.steps[0].undo();
    expect([e.doc().width, e.doc().height, e.calls[1]]).toEqual([100, 80, ["transform", "rotate-ccw", ["a", "b"]]]);
  });

  it("a flip keeps the size and is its own undo; an empty document has nothing to turn", () => {
    const e = editor([leaf("a")]);
    e.ops().applyImageTransform("flip-v");
    e.steps[0].undo();
    expect([e.doc().width, e.doc().height, e.calls]).toEqual([
      100,
      80,
      [
        ["transform", "flip-v", ["a"]],
        ["transform", "flip-v", ["a"]],
      ],
    ]);
    expect(e.steps[0].label).toBe("Flip Vertical");
    const none = editor([]);
    none.ops().applyImageTransform("rotate-ccw");
    expect([none.steps, none.calls]).toEqual([[], []]);
  });
});

describe("crop and trim", () => {
  it("Crop takes the selection's bounds, clamped to the canvas, as one step", () => {
    const e = editor([leaf("a")], { selection: [{ x: 10, y: 5, w: 20, h: 10 }, { x: 60, y: 60, w: 60, h: 40 }] });
    e.ops().cropToSelection();
    expect(e.calls[0]).toEqual(["crop", { x: 10, y: 5, w: 90, h: 75 }, ["a"], 0]);
    expect([e.doc().width, e.doc().height, e.doc().selection, e.steps[0].label]).toEqual([90, 75, [], "Crop"]);
    e.steps[0].undo();
    expect([e.doc().width, e.doc().height, e.calls[1]]).toEqual([100, 80, ["restore"]]);
    const none = editor([leaf("a")]);
    none.ops().cropToSelection();
    expect(none.toasts).toEqual(["Crop trims the canvas to the selection — make a selection first."]);
  });

  it("a turned selection crops to the bounds of its turned corners", () => {
    const e = editor([leaf("a")], {
      selection: [{ x: 40, y: 30, w: 20, h: 20 }],
      selectionAngle: Math.PI / 4,
      selectionPivot: { x: 50, y: 40 },
    });
    e.ops().cropToSelection();
    const r = (e.calls[0] as [string, Rect])[1];
    // A 20 px square turned 45° about its centre spans 20·√2 ≈ 28.3 px.
    expect([r.x, r.y, r.w, r.h]).toEqual([36, 26, 28, 28]);
  });

  it("cropping to the whole canvas is no step; an empty document cannot be cropped", () => {
    const e = editor([leaf("a")], { selection: [{ x: -5, y: -5, w: 200, h: 200 }] });
    e.ops().cropToSelection();
    const none = editor([], { selection: [{ x: 1, y: 1, w: 5, h: 5 }] });
    none.ops().cropToSelection();
    expect([e.steps, none.steps]).toEqual([[], []]);
  });

  it("Trim crops to what is not border, on the sides asked, and says when there is none", () => {
    const all = { top: true, left: true, bottom: true, right: true };
    const e = editor([leaf("a")], {}, { exportComposite: () => composite(100, 80, { x: 20, y: 10, w: 30, h: 40 }) });
    e.ops().trimImage("transparent", all);
    expect([e.calls[0], e.steps[0].label]).toEqual([["crop", { x: 20, y: 10, w: 30, h: 40 }, ["a"], 0], "Trim"]);
    const side = editor([leaf("a")], {}, { exportComposite: () => composite(100, 80, { x: 20, y: 10, w: 30, h: 40 }) });
    side.ops().trimImage("transparent", { ...all, top: false, right: false });
    expect(side.calls[0]).toEqual(["crop", { x: 20, y: 0, w: 80, h: 50 }, ["a"], 0]);
    const empty = editor([leaf("a")], {}, { exportComposite: () => composite(100, 80, null) });
    empty.ops().trimImage("transparent", all);
    expect([empty.toasts, empty.steps]).toEqual([["Nothing to trim — the image has no border to remove."], []]);
  });
});

describe("transform and Content-Aware Fill", () => {
  it("Free Transform with nothing selected takes the whole canvas and moves the pixels", () => {
    const e = editor([leaf("a")]);
    e.ops().enterTransform(false);
    expect([e.doc().selection, e.mode(), e.tool(), e.calls]).toEqual([
      [{ x: 0, y: 0, w: 100, h: 80 }],
      "content",
      "select",
      [["float down"]],
    ]);
  });

  it("over a selection, Free Transform moves pixels, Transform Selection the outline; no layer, nothing", () => {
    const sel = { selection: [{ x: 5, y: 5, w: 10, h: 10 }] };
    const free = editor([leaf("a")], sel);
    free.ops().enterTransform(true);
    const outline = editor([leaf("a")], sel);
    outline.ops().enterTransform(false);
    expect([free.mode(), outline.mode(), outline.doc().selection]).toEqual(["content", "bounds", sel.selection]);
    const none = editor([]);
    none.ops().enterTransform(true);
    expect([none.mode(), none.tool(), none.calls]).toEqual([null, null, []]);
  });

  it("Content-Aware Fill fills the selection on a pixel layer, rotation and all", () => {
    const sel = { selection: [{ x: 5, y: 5, w: 10, h: 10 }], selectionAngle: 0.3, selectionPivot: { x: 10, y: 10 } };
    const e = editor([leaf("a")], sel);
    e.ops().contentAwareFillOp();
    expect(e.calls).toEqual([["caf", "a", sel.selection, 0.3, { x: 10, y: 10 }]]);
    const bare = editor([leaf("a")]);
    bare.ops().contentAwareFillOp();
    const g: LayerNode = {
      ...leaf("g"),
      type: "group",
      expanded: true,
      children: [],
    };
    const group = editor([g], sel);
    group.ops().contentAwareFillOp();
    expect([bare.calls, group.calls]).toEqual([[], []]);
  });
});
