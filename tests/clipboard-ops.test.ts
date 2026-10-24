import { describe, expect, it } from "vitest";
import { clipboardOps } from "../app/commands/clipboard";
import type { Layer } from "../app/lib/layers";
import type { EngineHandle, PendingPaste } from "../app/lib/paint";
import { DEFAULT_PREFS, type Preferences } from "../app/lib/prefs";
import type { ToolId } from "../app/lib/tools";
import type { Rect } from "../app/lib/view";
import type { DialogState } from "../app/state/dialogs";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The clipboard family (TODO 1.10, app/commands/clipboard.ts): copy, cut and
 * paste, a float put down or taken back, undo and redo — against the documents
 * store and an engine that records what it was asked to do. The OS clipboard
 * is absent under Node, so a paste falls back to the in-app copy, as it does
 * in a browser that refuses to read it.
 */

const leaf = (id: string): Layer => ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal" });
const picture = (w: number, h: number) => ({ width: w, height: h }) as HTMLCanvasElement;

function editor(start: Partial<Doc> = {}, prefs: Partial<Preferences> = {}, floating = false) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 100, height: 80, ...start }] }));
  const calls: unknown[] = [];
  let float = floating;
  const paintRef = {
    current: {
      copyRegion: (rects: Rect[] | null, angle: number) => {
        calls.push(["copy", rects, angle]);
        return { canvas: picture(30, 20), x: 7, y: 9 };
      },
      eraseSelection: (...a: unknown[]) => calls.push(["erase", ...a]),
      isFloating: () => float,
      commitFloat: () => ((float = false), calls.push(["float down"])),
      discardFloat: () => ((float = false), calls.push(["float gone"])),
      undo: () => calls.push(["undo"]),
      redo: () => calls.push(["redo"]),
    } as unknown as EngineHandle,
  };
  const live = <T,>(read: () => T) => ({
    get current() {
      return read();
    },
  });
  const doc = () => activeDoc(documents.get());
  const clipboardRef = { current: null as HTMLCanvasElement | null };
  const copyOriginRef = { current: { x: 0, y: 0 } };
  const copyDocIdRef = { current: null as string | null };
  let asked: DialogState["pasteSrc"] = null;
  let pending: PendingPaste | null = null;
  let tool: ToolId | null = null;
  const ops = () =>
    clipboardOps({
      documents,
      activeIdRef: live(() => documents.get().activeId),
      activeDocRef: live(doc),
      paintRef,
      selRef: live(() => doc().selection),
      activeLayerRef: live(() => doc().activeLayerId),
      prefsRef: { current: { ...DEFAULT_PREFS, ...prefs } },
      seqRef: { current: 1 },
      layerSeqRef: { current: 0 },
      clipboardRef,
      copyOriginRef,
      copyDocIdRef,
      pasteSrc: asked,
      setPasteSrc: (src) => (asked = src),
      setPendingPaste: (p) => (pending = p),
      setSelection: (rects) =>
        documents.set((s) => ({
          docs: s.docs.map((d) => (d.id === s.activeId ? { ...d, selection: rects, selectionAngle: 0 } : d)),
        })),
      setActiveId: (id) => documents.set({ activeId: id }),
      setTool: (t) => (tool = t),
    });
  return {
    documents,
    ops,
    doc,
    calls,
    clipboardRef,
    copyOriginRef,
    copyDocIdRef,
    asked: () => asked,
    pending: () => pending,
    tool: () => tool,
  };
}

describe("copy and cut", () => {
  it("copy keeps the selection's picture, where it came from, and from which document", () => {
    const sel = [{ x: 1, y: 2, w: 3, h: 4 }];
    const e = editor({ selection: sel, selectionAngle: 0.2 });
    e.ops().copySelection();
    expect(e.calls).toEqual([["copy", sel, 0.2]]);
    expect([e.clipboardRef.current?.width, e.copyOriginRef.current, e.copyDocIdRef.current]).toEqual([
      30,
      { x: 7, y: 9 },
      "doc-1",
    ]);
    const all = editor();
    all.ops().copySelection();
    expect(all.calls, "nothing selected: the whole canvas").toEqual([["copy", null, 0]]);
  });

  it("cut puts a float down, copies, then erases the selection from the active layer as one step", () => {
    const sel = [{ x: 1, y: 2, w: 3, h: 4 }];
    const e = editor({ layers: [leaf("a")], activeLayerId: "a", selection: sel }, {}, true);
    e.ops().cutSelection();
    expect(e.calls).toEqual([["float down"], ["copy", sel, 0], ["erase", "a", sel, 0, null, "Cut"]]);
    const none = editor({ layers: [leaf("a")], activeLayerId: "a" });
    none.ops().cutSelection();
    const nolayer = editor({ selection: sel });
    nolayer.ops().cutSelection();
    expect([none.calls, nolayer.calls]).toEqual([[], []]);
  });
});

describe("paste", () => {
  it("a copy from this canvas floats back in place on the current layer, the Move tool in hand", () => {
    const e = editor({ layers: [leaf("a")], activeLayerId: "a", selection: [{ x: 7, y: 9, w: 30, h: 20 }] });
    e.ops().copySelection();
    e.ops().placePaste(e.clipboardRef.current!, 30, 20);
    expect(e.tool()).toBe("move");
    expect(e.pending()).toMatchObject({ docId: "doc-1", layerId: "a", x: 7, y: 9, float: true, side: undefined });
    expect(e.doc().selection).toEqual([{ x: 7, y: 9, w: 30, h: 20 }]);
  });

  it("from elsewhere, Preferences decide: ask, or a new layer centred — whose undo takes the layer away", () => {
    const ask = editor();
    const shot = picture(40, 30);
    ask.ops().placePaste(shot, 40, 30);
    expect([ask.asked(), ask.pending()]).toEqual([{ source: shot, w: 40, h: 30 }, null]);
    const e = editor({ layers: [leaf("a")], activeLayerId: "a" }, { defaultPaste: "new-layer" });
    e.ops().placePaste(shot, 40, 30);
    expect(e.doc().layers.map((l) => l.name)).toEqual(["Pasted Layer", "a"]);
    expect(e.pending()).toMatchObject({ docId: "doc-1", layerId: "layer-1", x: 30, y: 25, float: false });
    e.pending()!.side!.undo();
    expect([e.doc().layers.map((l) => l.id), e.doc().activeLayerId]).toEqual([["a"], "a"]);
    e.pending()!.side!.redo();
    expect(e.doc().activeLayerId).toBe("layer-1");
  });

  it("an image bigger than the canvas asks about the size, or grows the canvas, as Preferences say", () => {
    const big = picture(300, 200);
    const ask = editor({}, { defaultPaste: "new-layer" });
    ask.ops().placePaste(big, 300, 200);
    expect(ask.asked()).toEqual({ source: big, w: 300, h: 200, dest: "new-layer" });
    const grow = editor({}, { defaultPaste: "new-layer", pasteOversize: "expand" });
    grow.ops().placePaste(big, 300, 200);
    expect([grow.doc().width, grow.doc().height, grow.pending()?.x, grow.pending()?.y]).toEqual([300, 200, 0, 0]);
    grow.pending()!.side!.undo();
    expect([grow.doc().width, grow.doc().height]).toEqual([100, 80]);
  });

  it("as a new canvas: a document of its own, in front, its picture on its one layer", () => {
    const e = editor({}, { defaultPaste: "new-canvas", defaultDpi: 144 });
    const shot = picture(40, 30);
    e.ops().placePaste(shot, 40, 30);
    expect(e.doc()).toMatchObject({ id: "doc-2", name: "Untitled-2", width: 40, height: 30, dpi: 144 });
    expect(e.doc().layers.map((l) => l.name)).toEqual(["Pasted Layer"]);
    expect(e.pending()).toEqual({ docId: "doc-2", layerId: "layer-1", source: shot, x: 0, y: 0 });
  });

  it("the paste dialog's answer places what it asked about, then closes", () => {
    const e = editor();
    e.ops().placePaste(picture(40, 30), 40, 30);
    e.ops().applyPaste({ dest: "new-layer", expand: false });
    expect([e.asked(), e.pending()?.layerId]).toEqual([null, "layer-1"]);
    const none = editor();
    none.ops().applyPaste({ dest: "new-layer", expand: false });
    expect(none.pending()).toBeNull();
  });

  it("Paste with the OS clipboard out of reach uses the last copy; with no copy, nothing", async () => {
    const e = editor({}, { defaultPaste: "new-layer" });
    e.ops().copySelection();
    e.copyDocIdRef.current = "elsewhere";
    await e.ops().pasteFromClipboard();
    expect(e.pending()?.source).toBe(e.clipboardRef.current);
    expect(e.pending(), "from another document: as Preferences say, not in place").toMatchObject({
      layerId: "layer-1",
      float: false,
    });
    const none = editor({}, { defaultPaste: "new-layer" });
    await none.ops().pasteFromClipboard();
    expect(none.pending()).toBeNull();
  });
});

describe("undo, redo and the float", () => {
  it("undo takes a float back first, and the selection with it; otherwise the engine steps back", () => {
    const e = editor({ selection: [{ x: 1, y: 1, w: 2, h: 2 }] }, {}, true);
    e.ops().doUndo();
    e.ops().doUndo();
    e.ops().doRedo();
    expect(e.calls).toEqual([["float gone"], ["undo"], ["redo"]]);
    expect(e.doc().selection).toEqual([]);
  });

  it("a float is put down only when there is one", () => {
    const e = editor({}, {}, true);
    e.ops().commitFloatIfAny();
    e.ops().commitFloatIfAny();
    expect(e.calls).toEqual([["float down"]]);
  });
});
