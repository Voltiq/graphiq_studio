import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adjustmentOps } from "../app/commands/adjustments";
import { layerOps, type Sel } from "../app/commands/layers";
import { DEFAULT_ADJUST, type AdjustmentSpec } from "../app/lib/adjust";
import { findNode, type Layer, type LayerAdjustment, type LayerGroup, type LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import type { DialogState, ToneEdit } from "../app/state/dialogs";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The adjustments family (TODO 1.10, app/commands/adjustments.ts): adjustment
 * layers, their live edits, clipping, Curves and Levels and the extra kinds —
 * against the documents store, the layer family's helpers, and an engine that
 * keeps masks as tokens.
 */

const leaf = (id: string): Layer => ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal" });
const sliders = (id: string, extra: Partial<LayerAdjustment> = {}): LayerAdjustment => ({
  id,
  type: "adjustment",
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  adjustment: { type: "sliders", params: { ...DEFAULT_ADJUST } },
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
const ids = (ns: LayerNode[]): unknown[] => ns.map((n) => (n.type === "group" ? [n.id, ids(n.children)] : n.id));

function editor(layers: LayerNode[], start: Partial<Doc> = {}) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], layers, activeLayerId: layers[0]?.id ?? null, ...start }] }));
  const masks = new Map<string, string>();
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const paintRef = {
    current: {
      allocMask: (id: string, init: string) => masks.set(id, init),
      captureMask: (id: string) => masks.get(id) ?? null,
      restoreMask: (id: string, m: string) => masks.set(id, m),
      freeMask: (id: string) => masks.delete(id),
      captureLeaves: () => new Map(),
      restoreLeaves: () => {},
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
    } as unknown as EngineHandle,
  };
  const toasts: string[] = [];
  const adjSeqRef = { current: 0 };
  const adjEditRef = { current: null as { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  const adjEditTimer = { current: 0 };
  const clicks: string[] = [];
  const cubeInputRef = { current: { click: () => clicks.push("cube") } as unknown as HTMLInputElement };
  const cubeTargetRef = { current: null as string | null };
  let tone: ToneEdit | null = null;
  let extra: DialogState["extraEdit"] = null;
  // Editor's refs are re-pointed every render, so a timer that fires later reads the latest.
  const activeIdRef = {
    get current() {
      return documents.get().activeId;
    },
  };
  const activeDocRef = {
    get current() {
      return activeDoc(documents.get());
    },
  };
  const ops = () => {
    const active = activeDoc(documents.get());
    const { selNow, single, setDocSel } = layerOps({
      active,
      activeIdRef,
      documents,
      paintRef,
      layerSeqRef: { current: 0 },
      showToast: () => {},
    });
    const node = active.activeLayerId ? findNode(active.layers, active.activeLayerId) : null;
    return adjustmentOps({
      activeIdRef,
      activeDocRef,
      paintRef,
      showToast: (m) => toasts.push(m),
      selNow,
      single,
      setDocSel,
      adjSeqRef,
      adjEditRef,
      adjEditTimer,
      cubeInputRef,
      cubeTargetRef,
      setToneEdit: (t) => (tone = t),
      setExtraEdit: (x) => (extra = x),
      activeLeafId: node?.type === "layer" ? active.activeLayerId : null,
    });
  };
  const doc = () => activeDoc(documents.get());
  const node = (id: string) => findNode(doc().layers, id)!;
  return {
    documents,
    ops,
    doc,
    node,
    /** An adjustment layer's spec. */
    spec: (id: string) => (node(id) as LayerAdjustment).adjustment,
    tree: () => ids(doc().layers),
    masks,
    steps,
    toasts,
    clicks,
    cubeTargetRef,
    tone: () => tone,
    extra: () => extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("adjustment layers", () => {
  it("go above the active layer, numbered, selected, as one step", () => {
    const e = editor([leaf("a"), leaf("b")], { activeLayerId: "b" });
    const id = e.ops().addAdjustmentOp("brightness-contrast");
    expect([id, e.tree(), e.doc().activeLayerId]).toEqual(["adj-1", ["a", "adj-1", "b"], "adj-1"]);
    // Brightness / Contrast starts with every slider at zero, so it is named for none of them.
    expect(e.node("adj-1")).toMatchObject({ name: "Adjustment", clipped: false, adjustment: { type: "sliders" } });
    expect(e.steps.map((s) => s.label)).toEqual(["New Adjustment Layer"]);
    e.steps[0].undo();
    expect([e.tree(), e.doc().activeLayerId]).toEqual([["a", "b"], "b"]);
    e.steps[0].redo();
    expect(e.tree()).toEqual(["a", "adj-1", "b"]);
  });

  it("go into an active group, or on top of nothing; a preset or explicit spec names them", () => {
    const e = editor([group("g", [leaf("a")])], { activeLayerId: "g" });
    e.ops().addAdjustmentOp("", "Noir");
    expect([e.tree(), e.node("adj-1").name, e.spec("adj-1")]).toEqual([
      [["g", ["adj-1", "a"]]],
      "Noir",
      { type: "sliders", preset: "Noir", params: expect.any(Object) },
    ]);
    // The name given wins over the spec's own label (Color Lookup's carries its file's).
    const table = new Float32Array(24);
    const lookup = { type: "colorlookup", name: "tiny", size: 2, table } as unknown as AdjustmentSpec;
    e.ops().addAdjustmentOp("", "Color Lookup — tiny", undefined, lookup);
    expect([e.node("adj-2").name, e.spec("adj-2")]).toEqual(["Color Lookup — tiny", lookup]);
    const f = editor([]);
    const spec: AdjustmentSpec = { type: "sliders", params: { ...DEFAULT_ADJUST, vibrance: 40 } };
    f.ops().addAdjustmentOp("", undefined, undefined, spec);
    expect([f.tree(), f.spec("adj-1")]).toEqual([["adj-1"], spec]);
  });

  it("are masked by the selection, and the mask comes back with a redo", () => {
    const e = editor([leaf("a")], { selection: [{ x: 1, y: 1, w: 5, h: 5 }] });
    e.ops().addAdjustmentOp("exposure");
    expect([e.node("adj-1").mask, e.masks.get("adj-1")]).toEqual([{ enabled: true, linked: true }, "selection"]);
    e.steps[0].undo();
    expect(e.masks.has("adj-1")).toBe(false);
    e.steps[0].redo();
    expect(e.masks.get("adj-1")).toBe("selection");
    const plain = editor([leaf("a")]);
    plain.ops().addAdjustmentOp("exposure");
    expect([plain.node("adj-1").mask, plain.masks.size]).toEqual([undefined, 0]);
  });

  it("a slider gesture is one step, ended half a second after the last move", () => {
    const e = editor([sliders("s")]);
    e.ops().editAdjustmentParams({ contrast: 10 });
    e.ops().editAdjustmentParams({ contrast: 20 });
    vi.advanceTimersByTime(400);
    e.ops().editAdjustmentParams({ exposure: 5 });
    vi.advanceTimersByTime(499);
    expect(e.steps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Adjustment"]);
    const params = () => e.spec("s");
    expect(params()).toMatchObject({ params: { contrast: 20, exposure: 5 } });
    e.steps[0].undo();
    expect(params()).toMatchObject({ params: { contrast: 0, exposure: 0 } });
    e.steps[0].redo();
    // A second gesture on the same layer is a step of its own, back to where the first left it.
    e.ops().editAdjustmentParams({ contrast: 70 });
    vi.advanceTimersByTime(500);
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Adjustment", "Edit Adjustment"]);
    e.steps[1].undo();
    expect(params()).toMatchObject({ params: { contrast: 20, exposure: 5 } });
  });

  it("an edit on another layer, a clip or a new layer first closes the gesture open", () => {
    const e = editor([sliders("s"), sliders("t")]);
    e.ops().editAdjustmentParams({ contrast: 10 });
    e.ops().setClippedOp("s", true);
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Adjustment", "Create Clipping Mask"]);
    e.ops().editAdjustmentParams({ contrast: 30 });
    e.ops().addAdjustmentOp("vibrance");
    expect(e.steps.map((s) => s.label).slice(2)).toEqual(["Edit Adjustment", "New Adjustment Layer"]);
  });

  it("only a slider adjustment's sliders edit it", () => {
    const e = editor([leaf("a")]);
    e.ops().editAdjustmentParams({ contrast: 10 });
    const curves = editor([leaf("a")]);
    curves.ops().addToneAdjustment("curves");
    const spec = curves.spec("adj-1");
    curves.ops().editAdjustmentParams({ contrast: 10 });
    vi.advanceTimersByTime(600);
    expect([e.steps, curves.spec("adj-1"), curves.steps.length]).toEqual([[], spec, 1]);
  });

  it("clipping is a step each way, and nothing when it is already so", () => {
    const e = editor([leaf("a"), leaf("b")]);
    e.ops().toggleClippingMask();
    expect(e.node("a").clipped).toBe(true);
    e.ops().setClippedOp("a", true);
    e.ops().toggleClippingMask();
    expect(e.node("a").clipped).toBe(false);
    expect(e.steps.map((s) => s.label)).toEqual(["Create Clipping Mask", "Release Clipping Mask"]);
    e.steps[1].undo();
    expect(e.node("a").clipped).toBe(true);
  });

  it("Curves and Levels open on a new layer, on an old one, or on a pixel layer's pixels", () => {
    const e = editor([leaf("a")]);
    e.ops().addToneAdjustment("curves");
    expect(e.tone()).toEqual({ mode: "node", tool: "curves", layerId: "adj-1" });
    expect(e.spec("adj-1").type).toBe("curves");
    e.ops().editToneNode("a");
    e.ops().addAdjustmentOp("vibrance");
    e.ops().editToneNode("adj-2"); // a sliders adjustment: its panel, not a tone dialog
    expect(e.tone()).toEqual({ mode: "node", tool: "curves", layerId: "adj-1" });
    e.ops().addToneAdjustment("levels");
    e.ops().editToneNode("adj-1");
    expect(e.tone()).toEqual({ mode: "node", tool: "curves", layerId: "adj-1" });
    const p = editor([leaf("a")]);
    p.ops().openDestructiveTone("levels");
    expect(p.tone()).toMatchObject({ mode: "dest", tool: "levels", layerId: "a", spec: { type: "levels" } });
    const none = editor([sliders("s")]);
    none.ops().openDestructiveTone("curves");
    expect([none.tone(), none.toasts]).toEqual([null, ["Select a pixel layer first."]]);
  });

  it("a Curves or Levels edit on its layer is a gesture like a slider's", () => {
    const e = editor([leaf("a")]);
    e.ops().addToneAdjustment("levels");
    const spec = e.spec("adj-1");
    e.ops().setToneNodeSpec("adj-1", { ...spec } as AdjustmentSpec);
    e.ops().setToneNodeSpec("nowhere", spec);
    vi.advanceTimersByTime(500);
    expect(e.steps.map((s) => s.label)).toEqual(["New Adjustment Layer", "Edit Adjustment"]);
  });

  it("the extra kinds: an editor for those with settings, a .cube picked for Color Lookup", () => {
    const e = editor([leaf("a")]);
    e.ops().addExtraAdjustment("invert");
    expect([e.node("adj-1").name, e.extra()]).toEqual(["Invert", null]);
    e.ops().addExtraAdjustment("huesat");
    expect(e.extra()).toEqual({ layerId: "adj-2" });
    e.ops().addExtraAdjustment("colorlookup");
    expect([e.clicks, e.cubeTargetRef.current, e.tree()]).toEqual([["cube"], "new", ["adj-2", "adj-1", "a"]]);
    e.ops().addExtraAdjustment("sparkle");
    expect(e.steps).toHaveLength(2);
  });
});
