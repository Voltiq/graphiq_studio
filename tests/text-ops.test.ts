import { describe, expect, it } from "vitest";
import { textOps } from "../app/commands/text";
import { findNode, type Layer, type LayerNode } from "../app/lib/layers";
import type { EngineHandle, TextRenderSpec } from "../app/lib/paint";
import { anchorsToPathData } from "../app/lib/paths";
import { DEFAULT_PATH_TEXT } from "../app/lib/textpath";
import type { PenAnchor, VectorText } from "../app/lib/tools";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The text family (TODO 1.10, app/commands/text.ts): a text layer set on the
 * Work Path and taken off it, each as one step — against the documents store
 * and an engine that records what it renders.
 */

const text = (id: string, extra: object = {}): Layer =>
  ({
    id,
    type: "layer",
    name: id,
    visible: true,
    opacity: 100,
    blend: "Normal",
    vector: { type: "text", text: "Hi", ...extra },
  }) as unknown as Layer;
const leaf = (id: string, extra: object = {}): LayerNode =>
  ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal", ...extra }) as LayerNode;
const pt = (x: number, y: number): PenAnchor => ({ x, y, ix: x, iy: y, ox: x, oy: y });
const path = (id: string, anchors: PenAnchor[], closed = false) => ({ id, name: id, anchors, closed });
const three = [pt(0, 0), pt(50, 20), pt(100, 0)];

function editor(start: Partial<Doc> = {}, engine = true) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 200, height: 100, ...start }] }));
  const docId = documents.get().docs[0].id;
  const calls: unknown[] = [];
  const toasts: string[] = [];
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const paintRef = {
    current: engine
      ? ({
          renderText: (id: string, spec: unknown) => calls.push(["render", id, spec]),
          pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
        } as unknown as EngineHandle)
      : null,
  };
  const ops = () => {
    const doc = activeDoc(documents.get());
    return textOps({
      documents,
      activeIdRef: { current: doc.id },
      activeDocRef: { current: doc },
      paintRef,
      showToast: (m) => toasts.push(m),
      // The spec the engine draws, tagged so a test can tell it from the vector.
      specFromTextVector: (v) => ({ spec: v.text, onPath: v.onPath }) as unknown as TextRenderSpec,
      textVectorOf: (s) => {
        const { spec, onPath } = s as unknown as { spec: string; onPath: VectorText["onPath"] };
        return { type: "text", text: spec, onPath } as unknown as VectorText;
      },
    });
  };
  const vector = (id = "t") => {
    const doc = documents.get().docs.find((d) => d.id === docId)!;
    return (findNode(doc.layers, id) as Layer).vector;
  };
  return { documents, docId, ops, calls, toasts, steps, vector };
}

describe("text on a path", () => {
  it("sets the active text on the Work Path, resolved, as a step that undoes on its document", () => {
    const anchors = [pt(10, 10), ...three];
    const e = editor({
      layers: [text("t")],
      activeLayerId: "t",
      paths: [path("other", three), path("work", anchors, true)],
    });
    e.ops().setTextPath(true);
    const onPath = { ...DEFAULT_PATH_TEXT, d: anchorsToPathData(anchors, true) };
    expect(e.calls).toEqual([["render", "t", { spec: "Hi", onPath }]]);
    expect([e.vector(), e.steps.map((s) => s.label), e.toasts]).toEqual([
      { type: "text", text: "Hi", onPath },
      ["Text on Path"],
      [],
    ]);
    e.documents.set((s) => ({ docs: [...s.docs, { ...s.docs[0], id: "other" }], activeId: "other" }));
    e.steps[0].undo();
    expect(e.calls.at(-1)).toEqual(["render", "t", { spec: "Hi", onPath: undefined }]);
    expect(e.vector()).toEqual({ type: "text", text: "Hi" });
    const other = findNode(e.documents.get().docs[1].layers, "t") as Layer;
    expect(other.vector, "the other document untouched").toEqual({ type: "text", text: "Hi", onPath });
    e.steps[0].redo();
    expect(e.vector()).toEqual({ type: "text", text: "Hi", onPath });
  });

  it("takes the first path when there is no Work Path, and needs three points", () => {
    const e = editor({ layers: [text("t")], activeLayerId: "t", paths: [path("p1", three), path("p2", [])] });
    e.ops().setTextPath(true);
    expect((e.vector() as VectorText).onPath?.d).toBe(anchorsToPathData(three, false));
    const short = editor({ layers: [text("t")], activeLayerId: "t", paths: [path("work", three.slice(0, 2))] });
    short.ops().setTextPath(true);
    const none = editor({ layers: [text("t")], activeLayerId: "t", paths: undefined });
    none.ops().setTextPath(true);
    expect([short.steps, none.steps]).toEqual([[], []]);
    expect([...short.toasts, ...none.toasts]).toEqual([
      "Draw a path with the Pen tool first (at least 3 points).",
      "Draw a path with the Pen tool first (at least 3 points).",
    ]);
  });

  it("takes text off its path as a step, and refuses text that is not on one", () => {
    const onPath = { ...DEFAULT_PATH_TEXT, d: "M 0 0 C 1 1 2 2 3 3" };
    const e = editor({ layers: [text("t", { onPath })], activeLayerId: "t" });
    e.ops().setTextPath(false);
    expect([e.calls, e.vector(), e.steps.map((s) => s.label)]).toEqual([
      [["render", "t", { spec: "Hi", onPath: undefined }]],
      { type: "text", text: "Hi", onPath: undefined },
      ["Text off Path"],
    ]);
    e.steps[0].undo();
    expect(e.vector()).toEqual({ type: "text", text: "Hi", onPath });
    const flat = editor({ layers: [text("t")], activeLayerId: "t" });
    flat.ops().setTextPath(false);
    expect([flat.steps, flat.calls, flat.toasts]).toEqual([[], [], ["This text is not on a path."]]);
  });

  it("refuses anything but a text layer, and does nothing without an engine", () => {
    const paths = [path("work", three)];
    const cases = [
      editor({ layers: [text("t")], activeLayerId: null, paths }),
      editor({ layers: [text("t")], activeLayerId: "gone", paths }),
      editor({ layers: [leaf("p")], activeLayerId: "p", paths }),
      editor({ layers: [leaf("s", { vector: { type: "shape" } })], activeLayerId: "s", paths }),
      editor({ layers: [{ ...leaf("g"), type: "group", children: [] } as LayerNode], activeLayerId: "g", paths }),
      editor({ layers: [text("t")], activeLayerId: "t", paths }, false),
    ];
    for (const c of cases) c.ops().setTextPath(true);
    expect(cases.map((c) => [c.toasts, c.steps.length])).toEqual(
      cases.map(() => [["Select a text layer first."], 0]),
    );
  });
});
