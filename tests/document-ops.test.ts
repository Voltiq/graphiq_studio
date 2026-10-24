import { describe, expect, it, vi } from "vitest";

/**
 * The documents family (TODO 1.10, app/commands/documents.ts): New (asked,
 * at the stored size, refused), Close, Rename and the sample — against the
 * documents store and an engine that records what it was told, with the
 * sample's painter (which needs a real canvas) stood in for.
 */

vi.mock("../app/lib/sample-paint", () => ({
  paintSample: () => ({ images: [{ id: "painted" }], masks: [{ id: "masked" }] }),
}));

const { documentOps } = await import("../app/commands/documents");
const { DEFAULT_PREFS } = await import("../app/lib/prefs");
const { SAMPLE_NAME } = await import("../app/lib/sample-doc");
const { activeDoc, createDocuments, makeDoc } = await import("../app/state/documents");
type EngineHandle = import("../app/lib/paint").EngineHandle;
type PendingLoad = import("../app/lib/project").PendingLoad;

function editor(opts: { docs?: number; active?: string; prefs?: object; fits?: boolean } = {}) {
  const documents = createDocuments();
  const docs = Array.from({ length: opts.docs ?? 1 }, (_, i) => makeDoc(i + 1));
  documents.set({ docs, activeId: opts.active ?? docs[0].id });
  const calls: string[] = [];
  const cache = new Map(docs.map((d) => [d.id, {} as never]));
  let dialog = false;
  let loads: PendingLoad[] = [];
  const seqRef = { current: docs.length };
  let leaf = 0;
  const ops = () =>
    documentOps({
      documents,
      docs: documents.get().docs,
      activeId: documents.get().activeId,
      prefsRef: { current: { ...DEFAULT_PREFS, newDocWidth: 640, newDocHeight: 480, defaultDpi: 150, ...opts.prefs } },
      seqRef,
      paintRef: {
        current: {
          commitPendingEdits: () => calls.push("edits finished"),
          closeDocument: (id: string) => calls.push(`freed ${id}`),
          textBounds: () => ({ x: 0, y: 0, w: 10, h: 10 }),
        } as unknown as EngineHandle,
      },
      docJsonCache: { current: cache },
      acceptSize: (w, h) => (opts.fits === false ? (calls.push(`refused ${w}x${h}`), false) : true),
      setActiveId: (id) => documents.set({ activeId: id }),
      setNewDocOpen: (open) => (dialog = open),
      nextLeafId: () => `layer-${(leaf += 1)}`,
      setPendingLoads: (update) => (loads = update(loads)),
    });
  const state = () => documents.get().docs.map((d) => `${d.id}|${d.name}|${d.width}x${d.height}|${d.dpi}`);
  return { documents, ops, state, calls, cache, seqRef, dialog: () => dialog, loads: () => loads };
}

describe("New", () => {
  it("makes a canvas at the stored size and resolution, in front, and closes the dialog", () => {
    const e = editor();
    e.ops().requestNewDoc(); // the dialog opens…
    e.ops().createDoc(); // …and its Create makes the canvas
    expect(e.state()).toEqual(["doc-1|Untitled-1|1920x1080|300", "doc-2|Untitled-2|640x480|150"]);
    expect([e.documents.get().activeId, e.dialog()]).toEqual(["doc-2", false]);
    e.ops().createDoc({ name: "Postcard", width: 120, height: 90, dpi: 72 });
    expect(e.state()[2]).toBe("doc-3|Postcard|120x90|72");
  });

  it("a size the browser cannot hold is refused before a number is spent on it", () => {
    const e = editor({ fits: false });
    e.ops().createDoc({ width: 90000, height: 90000 });
    expect([e.state().length, e.seqRef.current, e.calls]).toEqual([1, 1, ["refused 90000x90000"]]);
  });

  it("asks through its dialog, or not, as Preferences say", () => {
    const ask = editor();
    ask.ops().requestNewDoc();
    expect([ask.dialog(), ask.state().length]).toEqual([true, 1]);
    const quick = editor({ prefs: { newDocAsk: false } });
    quick.ops().requestNewDoc();
    expect([quick.dialog(), quick.state().length]).toEqual([false, 2]);
  });
});

describe("Close and Rename", () => {
  it("the last document stays open", () => {
    const e = editor();
    e.ops().closeDoc("doc-1");
    expect([e.state().length, e.calls]).toEqual([1, []]);
  });

  it("the one in front finishes its edits, is freed whole, and its neighbour comes to the front", () => {
    const e = editor({ docs: 3, active: "doc-2" });
    e.ops().closeDoc("doc-2");
    expect(e.documents.get().docs.map((d) => d.id)).toEqual(["doc-1", "doc-3"]);
    expect([e.documents.get().activeId, e.calls, e.cache.has("doc-2")]).toEqual([
      "doc-3",
      ["edits finished", "freed doc-2"],
      false,
    ]);
    e.ops().closeDoc("doc-3");
    expect(e.documents.get().activeId, "the last tab: the one before it").toBe("doc-1");
  });

  it("one behind closes without touching the one in front", () => {
    const e = editor({ docs: 2, active: "doc-2" });
    e.ops().closeDoc("doc-1");
    expect([e.documents.get().activeId, e.calls]).toEqual(["doc-2", ["freed doc-1"]]);
  });

  it("Rename names that document only", () => {
    const e = editor({ docs: 2 });
    e.ops().renameDoc("doc-2", "Holiday");
    expect(e.state().map((s) => s.split("|")[1])).toEqual(["Untitled-1", "Holiday"]);
  });
});

describe("the sample", () => {
  it("opens as a document of its own, in front, its pixels queued to load", () => {
    const e = editor();
    e.ops().openSampleDoc();
    const d = activeDoc(e.documents.get());
    expect([d.id, d.name, d.width, d.height]).toEqual(["doc-2", SAMPLE_NAME, 1500, 1000]);
    expect(d.layers.length).toBeGreaterThan(3);
    expect(d.comps?.length).toBeGreaterThan(0);
    expect(e.loads()).toEqual([
      { docId: "doc-2", images: [{ id: "painted" }], masks: [{ id: "masked" }], texts: expect.any(Array) },
    ]);
  });
});
