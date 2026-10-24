import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterOps } from "../app/commands/filters";
import { layerOps, type Sel } from "../app/commands/layers";
import { DEFAULT_ADJUST } from "../app/lib/adjust";
import { defaultFilter, type SmartFilter } from "../app/lib/filters";
import {
  filterMaskKey,
  findNode,
  type Layer,
  type LayerAdjustment,
  type LayerGroup,
  type LayerNode,
} from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import { activeDoc, createDocuments } from "../app/state/documents";

/**
 * The smart-filters family (TODO 1.10, app/commands/filters.ts): a layer's
 * filter stack — live edits, structural changes, the dialog opened, a filter
 * from the menu, the stack baked — against the documents store, the layer
 * family's helpers, and an engine that remembers what it was asked to bake.
 */

const BLUR = defaultFilter("blur");
const NOISE = defaultFilter("noise");
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

function editor(layers: LayerNode[]) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], layers, activeLayerId: layers[0]?.id ?? null }] }));
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const masks = new Map<string, string>();
  const baked: { id: string; filters: SmartFilter[]; masked: boolean | undefined }[] = [];
  const paintRef = {
    current: {
      pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
      captureMask: (key: string) => masks.get(key) ?? null,
      restoreMask: (key: string, m: string) => masks.set(key, m),
      freeMask: (key: string) => masks.delete(key),
      applySmartFilters: (
        id: string,
        filters: SmartFilter[],
        side: { undo: () => void; redo: () => void },
        masked?: boolean,
      ) => {
        baked.push({ id, filters, masked });
        steps.push({ label: "Apply Smart Filters", ...side });
      },
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
  const filterEditRef = { current: null as { layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null };
  const filterEditTimer = { current: 0 };
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
    return filterOps({
      activeIdRef,
      activeDocRef,
      paintRef,
      selNow,
      setDocSel,
      filterEditRef,
      filterEditTimer,
      setFilterTarget: (id) => (target = id),
      selectLayer: (id, mode) => selected.push(`${mode}:${id}`),
    });
  };
  const node = (id: string) => findNode(activeDoc(documents.get()).layers, id)! as Layer | LayerGroup;
  const setTarget = (t: string | null) => (target = t);
  return { ops, node, steps, masks, baked, selected, target: () => target, setTarget };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("smart filters", () => {
  it("a gesture in the dialog is one step, ended half a second after the last change", () => {
    const e = editor([leaf("a", { filters: [BLUR] })]);
    const moved = { ...BLUR, opacity: 40 } as SmartFilter;
    e.ops().setFiltersLive("a", [{ ...BLUR, opacity: 70 } as SmartFilter]);
    vi.advanceTimersByTime(300);
    e.ops().setFiltersLive("a", [moved]);
    vi.advanceTimersByTime(499);
    expect(e.steps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect([e.steps.map((s) => s.label), e.node("a").filters]).toEqual([["Edit Smart Filter"], [moved]]);
    // A second gesture is its own step, back to where the first left it.
    e.ops().setFiltersLive("a", [BLUR]);
    vi.advanceTimersByTime(500);
    e.steps[1].undo();
    expect(e.node("a").filters).toEqual([moved]);
    e.steps[0].undo();
    expect(e.node("a").filters).toEqual([BLUR]);
    e.ops().setFiltersLive("nowhere", [BLUR]);
    vi.advanceTimersByTime(600);
    expect(e.steps).toHaveLength(2);
  });

  it("a structural change closes the gesture open first, and is a step of its own", () => {
    const e = editor([leaf("a", { filters: [BLUR] }), leaf("b")]);
    e.ops().setFiltersLive("a", [{ ...BLUR, enabled: false } as SmartFilter]);
    e.ops().setFiltersLive("b", [NOISE]);
    e.ops().setFiltersOp("a", undefined, "Clear Smart Filters");
    expect(e.steps.map((s) => s.label)).toEqual(["Edit Smart Filter", "Edit Smart Filter", "Clear Smart Filters"]);
    expect(e.node("a").filters).toBeUndefined();
    e.steps[2].undo();
    expect(e.node("a").filters).toEqual([{ ...BLUR, enabled: false }]);
  });

  it("the stack opens on its layer, selected; the menu adds a filter on top, opens it, not on an adjustment", () => {
    const e = editor([leaf("a", { filters: [BLUR] }), adjustment("j")]);
    e.ops().openFiltersOp("a");
    expect([e.selected, e.target()]).toEqual([["replace:a"], "a"]);
    e.ops().addFilterOp("noise");
    expect(e.node("a").filters?.map((f) => f.type)).toEqual(["blur", "noise"]);
    expect(e.steps.map((s) => s.label)).toEqual(["Add Add Noise"]);
    const adj = editor([adjustment("j")]);
    adj.ops().addFilterOp("noise");
    const none = editor([]);
    none.ops().addFilterOp("noise");
    expect([adj.steps, adj.target(), none.steps]).toEqual([[], null, []]);
  });

  it("baking hands the stack to the engine, consumes the filter mask, and undoes back to both", () => {
    const e = editor([leaf("a", { filters: [BLUR], filterMask: { enabled: true, linked: true } })]);
    e.masks.set(filterMaskKey("a"), "painted");
    e.setTarget("a");
    e.ops().applyFiltersOp("a");
    expect(e.baked).toEqual([{ id: "a", filters: [BLUR], masked: true }]);
    expect([e.node("a").filters, e.node("a").filterMask, e.masks.has(filterMaskKey("a")), e.target()]).toEqual([
      undefined,
      undefined,
      false,
      null,
    ]);
    e.steps[0].undo();
    expect([e.node("a").filters, e.node("a").filterMask, e.masks.get(filterMaskKey("a"))]).toEqual([
      [BLUR],
      { enabled: true, linked: true },
      "painted",
    ]);
    e.steps[0].redo();
    expect([e.node("a").filters, e.masks.has(filterMaskKey("a"))]).toEqual([undefined, false]);
  });

  it("only a pixel layer with filters bakes; a turned-off filter mask is not used", () => {
    const off = editor([leaf("a", { filters: [BLUR], filterMask: { enabled: false, linked: true } })]);
    off.ops().applyFiltersOp("a");
    expect(off.baked[0].masked).toBe(false);
    const bare = editor([leaf("a"), leaf("b", { filters: [] })]);
    bare.ops().applyFiltersOp("a");
    bare.ops().applyFiltersOp("b");
    const adj = editor([adjustment("j")]);
    adj.ops().applyFiltersOp("j");
    expect([bare.baked, adj.baked]).toEqual([[], []]);
  });
});
