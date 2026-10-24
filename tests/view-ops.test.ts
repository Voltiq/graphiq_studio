import { describe, expect, it } from "vitest";
import { viewOps } from "../app/commands/view";
import type { SelState } from "../app/commands/selection";
import type { Guide } from "../app/lib/guides";
import type { Layer, LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The view family (TODO 1.10, app/commands/view.ts): Quick Mask entered and
 * left as steps, Isolate, and the guides' commit — against the documents store
 * and an engine that records the steps it is handed.
 */

const leaf = (id: string, extra: object = {}): Layer =>
  ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal", ...extra }) as Layer;
const group = (id: string, children: LayerNode[]): LayerNode =>
  ({ id, type: "group", name: id, visible: true, opacity: 100, blend: "Normal", children }) as LayerNode;
const sel = (rects: SelState["rects"], angle = 0): SelState => ({ rects, angle, pivot: null });

function editor(start: Partial<Doc> = {}, engine = true) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 200, height: 100, ...start }] }));
  const docId = documents.get().docs[0].id;
  const calls: unknown[] = [];
  const toasts: string[] = [];
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const sels = new Map<string, SelState>();
  let qmDocs: string[] = [];
  let quickMask: string | null = null;
  let coverage: SelState["rects"] = [];
  let soft = false;
  let isolatedIds: string[] | null = null;
  let isolate: unknown = "untouched";
  const paintRef = {
    current: engine
      ? ({
          quickMaskActive: () => quickMask !== null,
          quickMaskRects: () => coverage,
          isSoftSelection: () => soft,
          setQuickMask: (key: string | null) => (calls.push(["setQuickMask", key]), (quickMask = key)),
          enterQuickMask: (key: string, ...rest: unknown[]) => (calls.push(["enter", key, ...rest]), (quickMask = key)),
          pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
        } as unknown as EngineHandle)
      : null,
  };
  const ops = () => {
    const doc = activeDoc(documents.get());
    return viewOps({
      documents,
      active: doc,
      activeIdRef: { current: doc.id },
      activeDocRef: { current: doc },
      paintRef,
      showToast: (m) => toasts.push(m),
      selStateOf: (d) => sels.get(d.id) ?? sel([]),
      setSelState: (id, s) => sels.set(id, s),
      setQuickMaskDocs: (update) => (qmDocs = update(qmDocs)),
      isolatedIds,
      setIsolate: (i) => (isolate = i),
    });
  };
  return {
    documents,
    docId,
    ops,
    calls,
    toasts,
    steps,
    sels,
    qmDocs: () => qmDocs,
    quickMask: () => quickMask,
    cover: (rects: SelState["rects"], isSoft = false) => ((coverage = rects), (soft = isSoft)),
    isolateWith: (ids: string[] | null) => (isolatedIds = ids),
    isolate: () => isolate,
  };
}

describe("Quick Mask", () => {
  it("enters on the selection as a step, which undoes to the selection and redoes into the mask", () => {
    const e = editor();
    const before = sel([{ x: 10, y: 10, w: 50, h: 20 }], 15);
    e.sels.set(e.docId, before);
    e.ops().toggleQuickMask();
    const key = `qm:${e.docId}`;
    expect(e.calls).toEqual([["enter", key, before.rects, 15, null]]);
    expect([e.qmDocs(), e.sels.get(e.docId), e.toasts]).toEqual([
      [e.docId],
      sel([]),
      ["Quick Mask on — paint black to mask (red), white to select"],
    ]);
    expect(e.steps.map((s) => s.label)).toEqual(["Quick Mask"]);
    e.steps[0].undo();
    expect([e.quickMask(), e.qmDocs(), e.sels.get(e.docId)]).toEqual([null, [], before]);
    e.steps[0].redo();
    e.steps[0].redo(); // marking a document twice keeps it once
    expect([e.quickMask(), e.qmDocs(), e.sels.get(e.docId)]).toEqual([key, [e.docId], sel([])]);
  });

  it("leaves with what it covers as the selection; undo re-enters it as it was left", () => {
    const e = editor();
    e.sels.set(e.docId, sel([{ x: 1, y: 2, w: 3, h: 4 }]));
    e.ops().toggleQuickMask();
    const inside = e.sels.get(e.docId);
    const covered = [{ x: 20, y: 20, w: 40, h: 30 }];
    e.cover(covered);
    e.ops().toggleQuickMask();
    expect([e.quickMask(), e.qmDocs(), e.sels.get(e.docId)]).toEqual([null, [], sel(covered)]);
    expect(e.steps.map((s) => s.label)).toEqual(["Quick Mask", "Exit Quick Mask"]);
    expect(e.toasts.at(-1)).toBe("Quick Mask off — coverage is now the selection");
    e.steps[1].undo();
    expect([e.quickMask(), e.qmDocs(), e.sels.get(e.docId)]).toEqual([`qm:${e.docId}`, [e.docId], inside]);
    e.steps[1].redo();
    expect([e.quickMask(), e.qmDocs(), e.sels.get(e.docId)]).toEqual([null, [], sel(covered)]);
  });

  it("covering the whole canvas is no selection — unless the coverage is soft", () => {
    const e = editor();
    e.ops().toggleQuickMask();
    e.cover([{ x: 0, y: 0, w: 200, h: 100 }]);
    e.ops().toggleQuickMask();
    expect([e.sels.get(e.docId), e.toasts.at(-1)]).toEqual([sel([]), "Quick Mask off"]);
    const s = editor();
    s.ops().toggleQuickMask();
    const all = [
      { x: 0, y: 0, w: 200, h: 50 },
      { x: 0, y: 50, w: 200, h: 50 },
    ];
    s.cover(all, true);
    s.ops().toggleQuickMask();
    expect(s.sels.get(s.docId)).toEqual(sel(all));
    const most = editor();
    most.ops().toggleQuickMask();
    most.cover([{ x: 0, y: 0, w: 200, h: 99 }]);
    most.ops().toggleQuickMask();
    expect(most.sels.get(most.docId)?.rects, "a row short is a selection").toHaveLength(1);
  });

  it("does nothing without an engine", () => {
    const e = editor({}, false);
    e.ops().toggleQuickMask();
    expect([e.qmDocs(), e.steps, e.toasts]).toEqual([[], [], []]);
  });
});

describe("Isolate", () => {
  const tree = () => [leaf("a"), leaf("b"), group("g", [leaf("c"), leaf("d")])];

  it("isolates the selected layers, else the active one; with isolation on, turns it off", () => {
    const e = editor({ layers: tree(), activeLayerId: "a", selectedLayerIds: ["b", "c"] });
    e.ops().toggleIsolate();
    expect(e.isolate()).toEqual({ docId: e.docId, ids: ["b", "c"] });
    const one = editor({ layers: tree(), activeLayerId: "a", selectedLayerIds: [] });
    one.ops().toggleIsolate();
    expect(one.isolate()).toEqual({ docId: one.docId, ids: ["a"] });
    one.isolateWith(["a"]);
    one.ops().toggleIsolate();
    expect([one.isolate(), one.toasts]).toEqual([null, []]);
  });

  it("refuses with no layer, and when nothing else is visible to hide", () => {
    const none = editor({ layers: tree(), activeLayerId: null, selectedLayerIds: [] });
    none.ops().toggleIsolate();
    const all = editor({ layers: tree(), activeLayerId: "a", selectedLayerIds: ["a", "b", "g"] });
    all.ops().toggleIsolate();
    const hidden = editor({ layers: [leaf("a"), leaf("b", { visible: false })], activeLayerId: "a" });
    hidden.ops().toggleIsolate();
    expect([none.isolate(), all.isolate(), hidden.isolate()]).toEqual(["untouched", "untouched", "untouched"]);
    expect([...none.toasts, ...all.toasts, ...hidden.toasts]).toEqual([
      "Select a layer to isolate.",
      "Nothing else is visible to hide.",
      "Nothing else is visible to hide.",
    ]);
  });
});

describe("the guides' commit", () => {
  const v = (pos: number): Guide => ({ axis: "v", pos }) as Guide;
  const h = (pos: number): Guide => ({ axis: "h", pos }) as Guide;
  const guides = (e: ReturnType<typeof editor>) => e.documents.get().docs.find((d) => d.id === e.docId)!.guides;

  it("is a step, which undoes on the document it was made in", () => {
    const e = editor({ guides: [v(10)] });
    e.ops().commitGuides("Add Guide", [v(10), h(40)]);
    expect([guides(e), e.steps.map((s) => s.label)]).toEqual([[v(10), h(40)], ["Add Guide"]]);
    e.documents.set((s) => ({
      docs: [...s.docs, { ...s.docs[0], id: "other", guides: [] }],
      activeId: "other",
    }));
    e.steps[0].undo();
    expect([guides(e), e.documents.get().docs[1].guides]).toEqual([[v(10)], []]);
    e.steps[0].redo();
    expect(guides(e)).toEqual([v(10), h(40)]);
  });

  it("the same guides again are no step; a guide moved or turned is", () => {
    const e = editor({ guides: [v(10), h(40)] });
    e.ops().commitGuides("Move Guide", [v(10), h(40)]);
    const none = editor();
    none.ops().commitGuides("Clear Guides", []);
    expect([e.steps, none.steps]).toEqual([[], []]);
    e.ops().commitGuides("Move Guide", [v(10), h(41)]);
    const turned = editor({ guides: [v(10)] });
    turned.ops().commitGuides("Move Guide", [h(10)]);
    expect([e.steps.length, turned.steps.length, guides(turned)]).toEqual([1, 1, [h(10)]]);
  });
});
