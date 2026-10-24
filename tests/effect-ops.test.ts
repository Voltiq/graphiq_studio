import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectOps } from "../app/commands/effects";
import { layerOps, type Sel } from "../app/commands/layers";
import { DEFAULT_FX, type LayerEffects } from "../app/lib/effects";
import { findNode, type Layer, type LayerAdjustment, type LayerNode } from "../app/lib/layers";
import { DEFAULT_ADJUST } from "../app/lib/adjust";
import type { EngineHandle } from "../app/lib/paint";
import { BUILTIN_STYLES, type LayerStylePreset } from "../app/lib/styleio";
import { activeDoc, createDocuments } from "../app/state/documents";

/**
 * The effects family (TODO 1.10, app/commands/effects.ts): layer styles —
 * their live edits, toggles, presets, copy / paste / clear and Add Layer
 * Effect — against the documents store and the layer family's helpers.
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
const adjustment = (id: string): LayerAdjustment => ({
  id,
  type: "adjustment",
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  adjustment: { type: "sliders", params: { ...DEFAULT_ADJUST } },
});
const SHADOW = { dropShadow: DEFAULT_FX.dropShadow() } as LayerEffects;

function editor(layers: LayerNode[]) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], layers, activeLayerId: layers[0]?.id ?? null }] }));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const paintRef = {
    current: {
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
    } as unknown as EngineHandle,
  };
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
  const fxEditRef = { current: null as { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  const fxEditTimer = { current: 0 };
  let clipboard: LayerEffects | null = null;
  let target: string | null = null;
  const selected: string[] = [];
  const ops = () => {
    const { selNow, setDocSel } = layerOps({
      active: activeDoc(documents.get()),
      activeIdRef,
      documents,
      paintRef,
      layerSeqRef: { current: 0 },
      showToast: () => {},
    });
    return effectOps({
      activeIdRef,
      activeDocRef,
      paintRef,
      selNow,
      setDocSel,
      fxEditRef,
      fxEditTimer,
      fxClipboard: clipboard,
      setFxClipboard: (fx) => (clipboard = fx),
      setLayerStyleTarget: (id) => (target = id),
      selectLayer: (id, mode) => selected.push(`${mode}:${id}`),
    });
  };
  const node = (id: string) => findNode(activeDoc(documents.get()).layers, id)!;
  return { ops, node, steps, selected, clipboard: () => clipboard, target: () => target };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("layer styles", () => {
  it("a gesture in the dialog is one step, ended half a second after the last change", () => {
    const e = editor([leaf("a")]);
    e.ops().setLayerEffectsOp("a", SHADOW);
    e.ops().setLayerEffectsOp("a", { dropShadow: { ...SHADOW.dropShadow!, distance: 30 } });
    vi.advanceTimersByTime(499);
    expect(e.steps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Layer Style"]);
    expect(e.node("a").effects?.dropShadow?.distance).toBe(30);
    e.steps[0].undo();
    expect(e.node("a").effects).toBeUndefined();
    e.steps[0].redo();
    expect(e.node("a").effects?.dropShadow?.distance).toBe(30);
    // A second gesture on the same layer is its own step, back to where the first left it.
    e.ops().setLayerEffectsOp("a", { dropShadow: { ...SHADOW.dropShadow!, distance: 80 } });
    vi.advanceTimersByTime(500);
    e.steps[1].undo();
    expect(e.node("a").effects?.dropShadow?.distance).toBe(30);
    e.steps.splice(1);
    e.ops().setLayerEffectsOp("nowhere", SHADOW);
    vi.advanceTimersByTime(600);
    expect(e.steps).toHaveLength(1);
  });

  it("an edit on another layer, or a structural style change, closes the gesture open first", () => {
    const e = editor([leaf("a"), leaf("b")]);
    e.ops().setLayerEffectsOp("a", SHADOW);
    e.ops().setLayerEffectsOp("b", SHADOW);
    e.ops().clearLayerStyleOp("a");
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Layer Style", "Edit Layer Style", "Clear Layer Style"]);
    e.steps[2].undo();
    expect(e.node("a").effects).toEqual(SHADOW);
  });

  it("a saved style replaces the effects and the blending, and undoes as one", () => {
    const preset: LayerStylePreset = { ...BUILTIN_STYLES[0], fillOpacity: 40, knockout: "shallow" };
    const e = editor([leaf("a", { effects: { stroke: DEFAULT_FX.stroke() } as LayerEffects, fillOpacity: 80 })]);
    e.ops().applyStylePresetOp("a", preset);
    expect(e.node("a")).toMatchObject({ effects: preset.effects, fillOpacity: 40, knockout: "shallow" });
    expect(e.node("a").effects?.stroke, "replaced, not merged").toBeUndefined();
    expect(e.steps.map((s) => s.label)).toEqual(["Apply Layer Style"]);
    e.steps[0].undo();
    expect(e.node("a")).toMatchObject({ fillOpacity: 80, effects: { stroke: DEFAULT_FX.stroke() } });
  });

  it("an effect turned on or off — one the layer never had arrives with its defaults", () => {
    const e = editor([leaf("a", { effects: SHADOW })]);
    e.ops().toggleEffectOp("a", "dropShadow", false);
    expect(e.node("a").effects?.dropShadow).toEqual({ ...SHADOW.dropShadow, enabled: false });
    e.ops().toggleEffectOp("a", "outerGlow", true);
    expect(e.node("a").effects?.outerGlow).toEqual({ ...DEFAULT_FX.outerGlow(), enabled: true });
    expect(e.steps.map((s) => s.label)).toEqual(["Disable Effect", "Enable Effect"]);
  });

  it("copy takes the style as it is now; paste puts a copy of it down; nothing copied, nothing pasted", () => {
    const e = editor([leaf("a", { effects: SHADOW }), leaf("b")]);
    e.ops().pasteLayerStyleOp("b");
    expect(e.steps).toEqual([]);
    e.ops().copyLayerStyleOp("a");
    expect(e.clipboard()).toEqual(SHADOW);
    expect(e.clipboard(), "a copy").not.toBe(e.node("a").effects);
    e.ops().pasteLayerStyleOp("b");
    expect([e.node("b").effects, e.steps.map((s) => s.label)]).toEqual([SHADOW, ["Paste Layer Style"]]);
    expect(e.node("b").effects, "its own copy").not.toBe(e.clipboard());
    e.ops().copyLayerStyleOp("b");
    e.ops().copyLayerStyleOp("nowhere");
    expect(e.clipboard()).toBeNull();
  });

  it("Layer Style opens on the layer, selected; Add Layer Effect adds and opens, but not on an adjustment", () => {
    const e = editor([leaf("a"), adjustment("j")]);
    e.ops().openLayerStyleOp("j");
    expect([e.selected, e.target()]).toEqual([["replace:j"], "j"]);
    e.ops().addEffectOp("stroke");
    expect([e.node("a").effects, e.target(), e.steps.map((s) => s.label)]).toEqual([
      { stroke: DEFAULT_FX.stroke() },
      "a",
      ["Add Layer Effect"],
    ]);
    const adj = editor([adjustment("j")]);
    adj.ops().addEffectOp("stroke");
    const none = editor([]);
    none.ops().addEffectOp("stroke");
    expect([adj.steps, adj.target(), none.steps]).toEqual([[], null, []]);
  });
});
