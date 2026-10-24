import { describe, expect, it } from "vitest";
import { layerOps } from "../app/commands/layers";
import { maskOps } from "../app/commands/masks";
import { filterMaskKey, findNode, type ActiveSurface, type Layer, type LayerNode } from "../app/lib/layers";
import type { EngineHandle } from "../app/lib/paint";
import { WORK_PATH_ID, type SavedPath } from "../app/lib/paths";
import type { SmartFilter } from "../app/lib/filters";
import { activeDoc, createDocuments, type Doc } from "../app/state/documents";

/**
 * The masks family (TODO 1.10, app/commands/masks.ts): layer masks, a smart
 * filter's mask and vector masks — run against the documents store, the layer
 * family it borrows its selection helpers from, and an engine that keeps each
 * mask as a token.
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
const anchor = (x: number, y: number) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
const BLUR = { id: "f1", type: "blur", enabled: true } as unknown as SmartFilter;

function editor(layers: LayerNode[], doc: Partial<Doc> = {}) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], layers, activeLayerId: layers[0]?.id ?? null, ...doc }] }));
  const masks = new Map<string, string>();
  const surfaces = new Map<string, ActiveSurface>();
  const steps: { label: string; undo: () => void; redo: () => void }[] = [];
  const pixels = new Map<string, string>(layers.map((l) => [l.id, `px:${l.id}`]));
  const engine = {
    allocMask: (id: string, init: string, rects: unknown) =>
      masks.set(id, `${init}${rects ? JSON.stringify(rects) : ""}`),
    captureMask: (id: string) => (masks.get(id) ?? null) as unknown as ImageData,
    restoreMask: (id: string, img: ImageData) => masks.set(id, img as unknown as string),
    // Freeing a filter mask that is being painted puts the brush back on the pixels.
    freeMask: (id: string) => {
      masks.delete(id);
      for (const [layer, s] of surfaces) {
        if (s === "filterMask" && filterMaskKey(layer) === id) surfaces.set(layer, "pixels");
      }
    },
    applyMaskToLayer: (id: string) => {
      pixels.set(id, `${pixels.get(id)}*${masks.get(id)}`);
      masks.delete(id);
    },
    captureLeaves: (ids: string[]) =>
      new Map(ids.map((id) => [id, { layer: pixels.get(id), mask: masks.get(id) ?? null }])),
    restoreLeaves: (snaps: Map<string, { layer: string; mask: string | null }>) =>
      snaps.forEach((s, id) => {
        pixels.set(id, s.layer);
        if (s.mask) masks.set(id, s.mask);
        else masks.delete(id);
      }),
    setActiveSurface: (id: string, s: ActiveSurface) => surfaces.set(id, s),
    getActiveSurface: (id: string) => surfaces.get(id) ?? "pixels",
    pushStructural: (label: string, undo: () => void, redo: () => void) => steps.push({ label, undo, redo }),
  } as unknown as EngineHandle;
  const paintRef = { current: engine };
  const toasts: string[] = [];
  let surface: ActiveSurface = "pixels";
  const ops = () => {
    const active = activeDoc(documents.get());
    const { selNow, setDocSel } = layerOps({
      active,
      activeIdRef: { current: documents.get().activeId },
      documents,
      paintRef,
      layerSeqRef: { current: 0 },
      showToast: (m) => toasts.push(m),
    });
    return maskOps({
      activeDocRef: { current: active },
      paintRef,
      showToast: (m) => toasts.push(m),
      setPaintSurface: (s) => (surface = s),
      selNow,
      setDocSel,
    });
  };
  const node = (id: string) => findNode(activeDoc(documents.get()).layers, id)!;
  return { documents, ops, node, masks, pixels, steps, toasts, surface: () => surface };
}

describe("the mask operations", () => {
  it("Add Layer Mask gives the active layer a mask to paint, as one step", () => {
    const e = editor([leaf("a")]);
    e.ops().addMaskOp("hide");
    expect(e.node("a").mask).toEqual({ enabled: true, linked: true });
    expect([e.masks.get("a"), e.surface()]).toEqual(["hide", "mask"]);
    e.ops().addMaskOp("reveal"); // one mask per layer
    expect([e.masks.get("a"), e.steps.map((s) => s.label)]).toEqual(["hide", ["Add Layer Mask"]]);
    e.steps[0].undo();
    expect([e.node("a").mask, e.masks.has("a"), e.surface()]).toEqual([undefined, false, "pixels"]);
    e.steps[0].redo();
    expect([e.node("a").mask, e.masks.get("a")]).toEqual([{ enabled: true, linked: true }, "hide"]);
  });

  it("a mask from the selection needs one, and takes its shape", () => {
    const e = editor([leaf("a")]);
    e.ops().addMaskOp("selection");
    expect([e.toasts, e.steps]).toEqual([["Make a selection first to create a mask from it."], []]);
    const box = [{ x: 1, y: 2, w: 3, h: 4 }];
    const f = editor([leaf("a")], { selection: box });
    f.ops().addMaskOp("selection");
    expect(f.masks.get("a")).toBe(`selection${JSON.stringify(box)}`);
  });

  it("Delete takes the mask away, and its undo brings that mask back", () => {
    const e = editor([leaf("a", { mask: { enabled: true, linked: true } })]);
    e.masks.set("a", "painted");
    e.ops().removeMaskOp();
    expect([e.node("a").mask, e.masks.has("a"), e.surface(), e.steps[0].label]).toEqual([
      undefined,
      false,
      "pixels",
      "Delete Layer Mask",
    ]);
    e.steps[0].undo();
    expect([e.node("a").mask, e.masks.get("a")]).toEqual([{ enabled: true, linked: true }, "painted"]);
  });

  it("Apply bakes an enabled mask into the pixels; a disabled one is refused", () => {
    const off = editor([leaf("a", { mask: { enabled: false, linked: true } })]);
    off.ops().applyMaskOp();
    expect([off.toasts, off.steps]).toEqual([["Enable the mask before applying."], []]);
    const e = editor([leaf("a", { mask: { enabled: true, linked: true } })]);
    e.masks.set("a", "painted");
    e.ops().applyMaskOp();
    expect([e.node("a").mask, e.pixels.get("a"), e.masks.has("a")]).toEqual([undefined, "px:a*painted", false]);
    e.steps[0].undo();
    expect([e.node("a").mask, e.pixels.get("a"), e.masks.get("a")]).toEqual([
      { enabled: true, linked: true },
      "px:a",
      "painted",
    ]);
  });

  it("a mask turned off or unlinked is a step of its own", () => {
    const e = editor([leaf("a", { mask: { enabled: true, linked: true } })]);
    e.ops().toggleMaskMeta("a", { enabled: false }, "Disable Layer Mask");
    expect(e.node("a").mask).toEqual({ enabled: false, linked: true });
    e.ops().toggleMaskMeta("a", { linked: false }, "Unlink Layer Mask");
    expect(e.node("a").mask).toEqual({ enabled: false, linked: false });
    e.steps[1].undo();
    expect(e.node("a").mask).toEqual({ enabled: false, linked: true });
    e.ops().toggleMaskMeta("b", { enabled: false }, "nothing there");
    expect(e.steps.map((s) => s.label)).toEqual(["Disable Layer Mask", "Unlink Layer Mask"]);
  });

  it("a smart filter's mask needs filters to confine, and comes and goes as steps", () => {
    // No stack at all, and a stack emptied of its last filter.
    const bare = editor([leaf("a"), leaf("b", { filters: [] })]);
    bare.ops().addFilterMaskOp("a");
    bare.ops().addFilterMaskOp("b");
    expect(bare.toasts).toEqual(Array(2).fill("Add a smart filter first — the filter mask confines the stack."));
    expect(bare.steps).toEqual([]);
    const e = editor([leaf("a", { filters: [BLUR] })]);
    e.ops().addFilterMaskOp("a");
    expect([e.node("a").filterMask, e.masks.get(filterMaskKey("a")), e.surface()]).toEqual([
      { enabled: true, linked: true },
      "reveal",
      "filterMask",
    ]);
    e.ops().setFilterMaskEnabled("a", false);
    expect(e.node("a").filterMask).toEqual({ enabled: false, linked: true });
    e.ops().removeFilterMaskOp("a");
    const gone = [e.node("a").filterMask, e.masks.has(filterMaskKey("a")), e.surface()];
    expect(gone).toEqual([undefined, false, "pixels"]);
    expect(e.steps.map((s) => s.label)).toEqual(["Add Filter Mask", "Disable Filter Mask", "Delete Filter Mask"]);
    e.steps[2].undo();
    const back = [e.node("a").filterMask, e.masks.get(filterMaskKey("a"))];
    expect(back).toEqual([{ enabled: false, linked: true }, "reveal"]);
  });

  it("a vector mask is drawn from the Work Path, inverted and deleted as steps", () => {
    const path = (id: string, name: string, anchors: ReturnType<typeof anchor>[]): SavedPath =>
      ({ id, name, anchors, closed: true });
    const work = path(WORK_PATH_ID, "Work Path", [anchor(0, 0), anchor(9, 0), anchor(9, 9)]);
    const other = path("p2", "Path 1", [anchor(1, 1), anchor(2, 2), anchor(3, 1)]);
    const e = editor([leaf("a")], { paths: [other, work] });
    e.ops().addVectorMask();
    expect(e.node("a").vectorMask).toEqual({ anchors: work.anchors, enabled: true, inverted: false, feather: 0 });
    e.ops().invertVectorMask();
    expect(e.node("a").vectorMask?.inverted).toBe(true);
    e.ops().deleteVectorMask();
    expect(e.node("a").vectorMask).toBeUndefined();
    e.ops().invertVectorMask();
    expect(e.steps.map((s) => s.label)).toEqual(["Add Vector Mask", "Invert Vector Mask", "Delete Vector Mask"]);
    expect(e.toasts).toEqual(["This layer has no vector mask."]);
    e.steps[2].undo();
    expect(e.node("a").vectorMask?.inverted).toBe(true);
  });

  it("without a Work Path the first path serves; without enough points, or a layer, nothing", () => {
    const one: SavedPath = {
      id: "p2",
      name: "Path 1",
      anchors: [anchor(1, 1), anchor(2, 2), anchor(3, 1)],
      closed: true,
    };
    const e = editor([leaf("a")], { paths: [one] });
    e.ops().addVectorMask();
    expect(e.node("a").vectorMask?.anchors).toEqual(one.anchors);
    const short = editor([leaf("a")], { paths: [{ ...one, anchors: one.anchors.slice(0, 2) }] });
    short.ops().addVectorMask();
    const none = editor([]);
    none.ops().addVectorMask();
    expect([...short.toasts, ...none.toasts]).toEqual([
      "Draw a path with the Pen tool first (at least 3 points).",
      "Select a layer to mask.",
    ]);
    expect([short.steps, none.steps]).toEqual([[], []]);
  });
});
