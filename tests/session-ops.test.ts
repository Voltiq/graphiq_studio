import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionOps } from "../app/commands/sessions";
import type { Layer, LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import { DEFAULT_BLUR_FX, type BlurFxSettings } from "../app/lib/tools";
import type { DialogState } from "../app/state/dialogs";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The sessions family (TODO 1.10, app/commands/sessions.ts): the Blur
 * Gallery's live preview session, Liquify and Warp — against the documents
 * store and an engine that records the session it is asked to keep.
 */

const leaf = (id: string, extra: object = {}): Layer =>
  ({ id, type: "layer", name: `${id}!`, visible: true, opacity: 100, blend: "Normal", ...extra }) as Layer;

function editor(start: Partial<Doc> = {}, open = true) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 200, height: 100, ...start }] }));
  const calls: unknown[] = [];
  const toasts: string[] = [];
  let blurFx: BlurFxSettings = { ...DEFAULT_BLUR_FX };
  let preview: unknown = "stale";
  let dialog = false;
  let liquify: DialogState["liquify"] = null;
  let warping: DialogState["warping"] = null;
  const blurFxOpenRef = { current: open };
  const blurFxSessionRef = { current: null as string[] | null };
  const blurFxTimerRef = { current: 0 };
  const paintRef = {
    current: {
      beginBlurFx: (ids: string[], sel: unknown) => calls.push(["begin", ids, sel]),
      cancelBlurFx: () => calls.push(["cancel"]),
      previewBlurFxAsync: async (kind: string, amount: number) => (calls.push(["preview", kind, amount]), true),
      commitBlurFx: (label: string) => calls.push(["commit", label]),
      exportComposite: () => "composite",
      getLayerCanvas: (id: string) => `canvas:${id}`,
      applyLayerImage: (id: string, _c: unknown, label: string) => calls.push(["apply", id, label]),
    } as unknown as EngineHandle,
  };
  const ops = () =>
    sessionOps({
      activeDocRef: { current: activeDoc(documents.get()) },
      paintRef,
      showToast: (m) => toasts.push(m),
      blurFx,
      setBlurFx: (s) => (blurFx = s),
      setBlurPreview: (p) => (preview = p),
      setBlurFxOpen: (o) => (dialog = o),
      blurFxOpenRef,
      blurFxSessionRef,
      blurFxTimerRef,
      liquify,
      setLiquify: (l) => (liquify = l),
      warping,
      setWarping: (w) => (warping = w),
    });
  const read = {
    blurFx: () => blurFx,
    preview: () => preview,
    dialog: () => dialog,
    liquify: () => liquify,
    warping: () => warping,
  };
  return { documents, ops, calls, toasts, blurFxSessionRef, blurFxOpenRef, engine: paintRef.current, ...read };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Blur Gallery", () => {
  it("opens centred on the selection, then holds the layer and previews it", async () => {
    const selection = [{ x: 20, y: 10, w: 60, h: 40 }];
    const e = editor({ layers: [leaf("a"), leaf("b")], activeLayerId: "a", selection });
    e.ops().openBlurFx();
    expect([e.blurFx().anchor, e.preview(), e.dialog(), e.calls]).toEqual([{ x: 0.25, y: 0.3 }, null, true, []]);
    await vi.runAllTimersAsync();
    expect(e.calls.slice(0, 2)).toEqual([
      ["begin", ["a"], [{ x: 20, y: 10, w: 60, h: 40 }]],
      ["preview", "gaussian", 12],
    ]);
    expect(e.preview(), "the dialog shows the result").toBe("composite");
    expect(e.blurFxSessionRef.current).toEqual(["a"]);
    const none = editor();
    none.ops().openBlurFx();
    expect(none.dialog(), "nothing to blur").toBe(false);
  });

  it("a change re-renders after a pause; the canvas scope takes every layer, putting the last scope back", async () => {
    const e = editor({ layers: [leaf("a"), leaf("b")], activeLayerId: "a" });
    e.ops().openBlurFx();
    await vi.runAllTimersAsync();
    e.calls.length = 0;
    e.ops().changeBlurFx({ amount: 30 });
    expect(e.calls, "not yet").toEqual([]);
    await vi.advanceTimersByTimeAsync(90);
    expect(e.calls).toEqual([["preview", "gaussian", 30]]);
    e.calls.length = 0;
    e.ops().changeBlurFx({ scope: "canvas" });
    await vi.advanceTimersByTimeAsync(90);
    expect(e.calls.slice(0, 2)).toEqual([["cancel"], ["begin", ["a", "b"], null]]);
  });

  it("Apply flushes the newest settings and commits them as one step; Cancel puts the pixels back", async () => {
    const e = editor({ layers: [leaf("a")], activeLayerId: "a" });
    e.ops().openBlurFx();
    await vi.runAllTimersAsync();
    e.ops().changeBlurFx({ kind: "motion", amount: 40 });
    await e.ops().applyBlurFx();
    expect(e.calls.slice(-2)).toEqual([
      ["preview", "motion", 40],
      ["commit", "Motion Blur"],
    ]);
    expect([e.blurFxSessionRef.current, e.preview(), e.dialog()]).toEqual([null, null, false]);
    const c = editor({ layers: [leaf("a")], activeLayerId: "a" });
    c.ops().openBlurFx();
    await vi.runAllTimersAsync();
    c.ops().closeBlurFx();
    expect([c.calls.at(-1), c.blurFxSessionRef.current, c.dialog()]).toEqual([["cancel"], null, false]);
  });

  it("a preview that lands after the gallery closed is not shown", async () => {
    const e = editor({ layers: [leaf("a")], activeLayerId: "a" });
    let land: (ok: boolean) => void = () => {};
    (e.engine as unknown as { previewBlurFxAsync: () => Promise<boolean> }).previewBlurFxAsync = () =>
      new Promise((r) => (land = r));
    e.ops().openBlurFx();
    await vi.runAllTimersAsync(); // the render has begun, and waits on the engine
    e.blurFxOpenRef.current = false; // closed meanwhile
    land(true);
    await vi.runAllTimersAsync();
    expect(e.preview()).toBeNull();
  });
});

describe("Liquify and Warp", () => {
  it("open on a pixel layer's pixels, and apply their result to it as one step", () => {
    const e = editor({ layers: [leaf("a")], activeLayerId: "a" });
    e.ops().openLiquify();
    expect(e.liquify()).toEqual({ layerId: "a", name: "a!", canvas: "canvas:a" });
    e.ops().applyLiquify({} as HTMLCanvasElement);
    e.ops().openWarp();
    expect(e.warping()).toEqual({ layerId: "a", name: "a!", canvas: "canvas:a" });
    e.ops().applyWarp({} as HTMLCanvasElement);
    expect(e.calls).toEqual([
      ["apply", "a", "Liquify"],
      ["apply", "a", "Warp"],
    ]);
    expect([e.liquify(), e.warping()]).toEqual([null, null]);
  });

  it("refuse what is not plain pixels, and apply nothing to a layer that went away", () => {
    const vec = editor({ layers: [leaf("v", { vector: { type: "path", paths: [] } })], activeLayerId: "v" });
    vec.ops().openLiquify();
    vec.ops().openWarp();
    const adj = editor({ layers: [{ ...leaf("j"), type: "adjustment" } as unknown as LayerNode], activeLayerId: "j" });
    adj.ops().openLiquify();
    adj.ops().openWarp();
    expect([...vec.toasts, ...adj.toasts]).toEqual([
      "Liquify needs plain pixels — rasterize the vector layer first.",
      "Warp needs plain pixels — rasterize the vector layer first.",
      "Select a pixel layer to liquify.",
      "Select a pixel layer to warp.",
    ]);
    const gone = editor({ layers: [leaf("a")], activeLayerId: "a" });
    gone.ops().openLiquify();
    gone.documents.set((s) => ({ docs: [{ ...s.docs[0], layers: [] }] }));
    gone.ops().applyLiquify({} as HTMLCanvasElement);
    expect([gone.calls, gone.liquify()]).toEqual([[], null]);
  });
});
