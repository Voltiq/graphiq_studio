import { describe, expect, it } from "vitest";
import { cropDragTo, cropHandleAt, cropTool } from "../app/tools/crop";
import { moveTool } from "../app/tools/move";
import type { CropQuad } from "../app/lib/tools";
import { fake, names, painter, pointer } from "./tools-bench";

/**
 * Move and Crop, driven without a browser (see tests/tools.test.ts for the
 * bench). The pointer is at twice the document's scale: client (x, y) is
 * document (x/2, y/2).
 */

const said = (told: unknown[][], what: string) => told.filter((c) => c[0] === what).map((c) => c.slice(1));

describe("the Move tool", () => {
  it("drags the whole layer when nothing is selected — snapped, in whole pixels — as one move", () => {
    const { h, calls, told, captured } = fake({ tool: "move" });
    const t = moveTool();
    t.down(pointer(40, 60), h);
    expect([captured, t.busy()]).toEqual([[7], true]);
    expect(t.session.current).toEqual({ sx: 20, sy: 30, mode: "pixels" });
    expect(calls).toEqual([["beginMove", "L1", null, false, []]]);
    expect(names(told)).toEqual(["snapMove"]);
    h.snap = { ...h.snap, move: (dx, dy) => ({ dx: dx + 0.4, dy }) };
    expect(t.move!(pointer(61, 80), h)).toBe(true);
    expect(calls.at(-1), "the snapped delta, rounded").toEqual(["moveTo", 11, 10]);
    expect(t.delta.current).toEqual({ x: 11, y: 10 });
    expect(t.readout!()).toEqual({ kind: "delta", dx: 11, dy: 10 });
    t.up!(pointer(61, 80), h);
    expect(calls.at(-1)).toEqual(["endMove"]);
    expect(said(told, "place"), "no selection to move along").toEqual([]);
    expect([t.busy(), t.delta.current, t.readout!()]).toEqual([false, { x: 0, y: 0 }, null]);
  });

  it("Ctrl suspends the snap", () => {
    const suspended: boolean[] = [];
    const { h } = fake({ tool: "move" });
    h.snap = { ...h.snap, move: (dx, dy, s) => (suspended.push(s), { dx, dy }) };
    const t = moveTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(10, 10, { ctrlKey: true }), h);
    t.move!(pointer(20, 10), h);
    expect(suspended).toEqual([true, false]);
  });

  it("carries a linked mask, and the layers linked to it", () => {
    const extras = [{ id: "L9", maskLinked: true }];
    const { h, calls } = fake({ tool: "move", linkedExtras: () => extras });
    h.layers = [{ ...h.layers[0], mask: { linked: true } } as (typeof h.layers)[0], h.layers[1]];
    moveTool().down(pointer(0, 0), h);
    expect(calls).toEqual([["beginMove", "L1", null, true, extras]]);
  });

  it("lifts a selection onto a float and moves that — and the selection with it", () => {
    const rects = [{ x: 1, y: 1, w: 9, h: 9 }];
    const moved = [{ x: 6, y: 1, w: 9, h: 9 }];
    const { h, calls, told } = fake(
      { tool: "move", selection: { rects, angle: 0.5, pivot: { x: 5, y: 5 } } },
      false,
      { floatOffset: { x: 3, y: 4 }, shifted: moved },
    );
    const t = moveTool();
    t.down(pointer(0, 0), h);
    expect(calls).toEqual([["beginFloatFromSelection", "L1", rects, 0.5, { x: 5, y: 5 }]]);
    expect(t.session.current).toMatchObject({ float: true, baseOff: { x: 3, y: 4 } });
    t.move!(pointer(10, 0), h);
    expect(calls.at(-1)).toEqual(["setFloatOffset", 8, 4]);
    t.up!(pointer(10, 0), h);
    expect(names(calls), "a float stays a float").not.toContain("endMove");
    expect(calls.at(-1)).toEqual(["shiftSelection", rects, 5, 0]);
    expect(said(told, "place")).toEqual([[moved, 0.5, { x: 10, y: 5 }]]);
  });

  it("moves the float already up on that layer, without lifting again", () => {
    const { h, calls } = fake({ tool: "move" }, true, { floatLayerId: "L1" });
    moveTool().down(pointer(0, 0), h);
    expect(names(calls)).toEqual([]);
  });

  it("a click that does not move leaves the selection where it is", () => {
    const rects = [{ x: 1, y: 1, w: 9, h: 9 }];
    const { h, told } = fake({ tool: "move", selection: { rects } });
    const t = moveTool();
    t.down(pointer(0, 0), h);
    t.up!(pointer(0, 0), h);
    expect(said(told, "place")).toEqual([]);
  });

  it("in Selection mode moves only the outline", () => {
    const rects = [{ x: 1, y: 1, w: 9, h: 9 }];
    const { h, calls, told } = fake({ tool: "move", selection: { rects } }, false, { shifted: rects });
    h.settings = { ...h.settings, move: { mode: "selection", autoSelect: false } };
    const t = moveTool();
    t.down(pointer(0, 0), h);
    expect(t.session.current).toEqual({ sx: 0, sy: 0, mode: "selection" });
    t.move!(pointer(10, 0), h);
    t.up!(pointer(10, 0), h);
    expect(names(calls)).toEqual(["shiftSelection"]);
    expect(said(told, "place").length).toBe(1);
    const none = fake({ tool: "move" });
    none.h.settings = h.settings;
    const u = moveTool();
    u.down(pointer(0, 0), none.h);
    expect(u.busy(), "nothing selected: nothing to move").toBe(false);
  });

  it("with Auto-select, a press picks the layer under it and moves that one", () => {
    const { h, calls, told } = fake({ tool: "move", layerAt: () => "L7" });
    h.settings = { ...h.settings, move: { mode: "pixels", autoSelect: true } };
    moveTool().down(pointer(0, 0), h);
    expect(said(told, "pickLayer")).toEqual([["L7"]]);
    expect(calls[0].slice(0, 2)).toEqual(["beginMove", "L7"]);
  });

  it("Auto-select leaves the layer alone while a selection is up", () => {
    const { h, told } = fake({ tool: "move", layerAt: () => "L7", selection: { rects: [{ x: 0, y: 0, w: 5, h: 5 }] } });
    h.settings = { ...h.settings, move: { mode: "pixels", autoSelect: true } };
    moveTool().down(pointer(0, 0), h);
    expect(said(told, "pickLayer")).toEqual([]);
  });

  it("a locked layer, or none, is not moved", () => {
    for (const over of [{ moveBlocked: () => true }, { activeLayerId: null }]) {
      const { h, calls } = fake({ tool: "move", ...over });
      const t = moveTool();
      t.down(pointer(0, 0), h);
      expect([calls, t.busy()]).toEqual([[], false]);
    }
  });

  it("a press on the layer's transform handles transforms it instead", () => {
    const { h, calls } = fake({ tool: "move" });
    h.transform = { ...h.transform, startLayer: () => true };
    const t = moveTool();
    t.down(pointer(0, 0), h);
    expect([calls, t.busy()]).toEqual([[], false]);
  });

  it("a pinch puts a moved layer back where it began; a float just stays", () => {
    const layer = fake({ tool: "move" });
    const t = moveTool();
    t.down(pointer(0, 0), layer.h);
    t.move!(pointer(20, 0), layer.h);
    t.cancel!(layer.h);
    expect(layer.calls.at(-1)).toEqual(["cancelMove"]);
    expect([t.busy(), t.delta.current]).toEqual([false, { x: 0, y: 0 }]);
    expect(names(layer.told)).toContain("snapEnd");
    t.up!(pointer(20, 0), layer.h);
    expect(names(layer.calls), "the lift bakes nothing").not.toContain("endMove");
    const float = fake({ tool: "move", selection: { rects: [{ x: 0, y: 0, w: 5, h: 5 }] } });
    const u = moveTool();
    u.down(pointer(0, 0), float.h);
    u.cancel!(float.h);
    expect(names(float.calls)).not.toContain("cancelMove");
  });

  it("shows what a press would pick up — but not while moving", () => {
    const { h, told } = fake({ tool: "move" });
    const t = moveTool();
    t.hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    t.down(pointer(0, 0), h);
    t.hover!({ x: 5, y: 0 }, pointer(10, 0), h);
    expect(said(told, "layerCursor").length).toBe(1);
  });

  it("is the tool that grabs guides and shows the layer's transform controls", () => {
    const t = moveTool();
    expect([t.grabsGuides, t.showsLayerTransform]).toEqual([true, true]);
  });
});

describe("the Crop tool", () => {
  const box = { x: 100, y: 100, w: 400, h: 300 };

  it("knows its handles: corners, edges, inside, outside — on a straightened box too", () => {
    const { h } = fake({ tool: "crop" });
    h.crop = { ...h.crop, box };
    expect(cropHandleAt(h, { x: 100, y: 100 })).toBe("nw");
    expect(cropHandleAt(h, { x: 500, y: 400 })).toBe("se");
    expect(cropHandleAt(h, { x: 300, y: 100 })).toBe("n");
    expect(cropHandleAt(h, { x: 500, y: 250 })).toBe("e");
    expect(cropHandleAt(h, { x: 300, y: 250 })).toBe("move");
    expect(cropHandleAt(h, { x: 700, y: 250 })).toBe("outside");
    h.crop = { ...h.crop, straighten: 90 }; // turned a quarter: its corners move
    expect(cropHandleAt(h, { x: 100, y: 100 })).toBe("outside");
    h.crop = { ...h.crop, box: null };
    expect(cropHandleAt(h, { x: 300, y: 250 })).toBeNull();
  });

  it("a press outside drags out a new box; inside moves it; a handle resizes it", () => {
    const { h, told, captured } = fake({ tool: "crop" });
    h.crop = { ...h.crop, box };
    const t = cropTool();
    t.down(pointer(1300, 200), h); // (650, 100): outside
    expect([captured, t.busy()]).toEqual([[7], true]);
    expect(t.hover!({ x: 750, y: 300 }, pointer(1500, 600), h), "crop takes every move").toBe(true);
    expect(said(told, "cropBox").at(-1)).toEqual([{ x: 650, y: 100, w: 100, h: 200 }]);
    t.up!(pointer(1500, 600), h);
    expect([t.busy(), said(told, "release").length]).toEqual([false, 1]);
    t.down(pointer(600, 500), h); // (300, 250): inside
    t.hover!({ x: 350, y: 270 }, pointer(700, 540), h);
    expect(said(told, "cropBox").at(-1)).toEqual([{ ...box, x: 150, y: 120 }]);
    t.up!(pointer(700, 540), h);
    t.down(pointer(1000, 800), h); // (500, 400): the se corner
    t.hover!({ x: 520, y: 450 }, pointer(1040, 900), h);
    expect(said(told, "cropBox").at(-1)).toEqual([{ ...box, w: 420, h: 350 }]);
  });

  it("a double-click inside applies it — not on a handle, outside, or with no box", () => {
    const { h, told } = fake({ tool: "crop" });
    const t = cropTool();
    t.doubleClick!(pointer(600, 500), h);
    expect(told, "no box").toEqual([]);
    h.crop = { ...h.crop, box };
    t.doubleClick!(pointer(1400, 500), h); // (700, 250): outside
    t.doubleClick!(pointer(1000, 800), h); // (500, 400): the se corner
    expect(told).toEqual([]);
    t.doubleClick!(pointer(600, 500), h); // (300, 250): inside
    expect(names(told)).toEqual(["cropApply"]);
    expect(t.busy()).toBe(false);
  });

  it("a pinch puts the box back as it was before the drag", () => {
    const { h, told } = fake({ tool: "crop" });
    h.crop = { ...h.crop, box };
    const t = cropTool();
    t.down(pointer(600, 500), h); // (300, 250): inside
    t.hover!({ x: 350, y: 270 }, pointer(700, 540), h);
    told.length = 0;
    t.cancel!(h);
    expect(told).toEqual([["cropBox", box]]);
    expect(t.busy()).toBe(false);
    t.hover!({ x: 400, y: 300 }, pointer(800, 600), h);
    expect(said(told, "cropBox").length, "the next move only hovers").toBe(1);
    t.cancel!(h);
    expect(told.length, "nothing in flight: nothing to put back").toBe(2);
  });

  it("does nothing with no box", () => {
    const { h, told } = fake({ tool: "crop" });
    const t = cropTool();
    t.down(pointer(600, 500), h);
    expect([told, t.busy()]).toEqual([[], false]);
  });

  it("shows what a press would do", () => {
    const { h, told } = fake({ tool: "crop" });
    h.crop = { ...h.crop, box };
    const t = cropTool();
    expect(t.hover!({ x: 100, y: 100 }, pointer(200, 200), h), "it takes every move").toBe(true);
    t.hover!({ x: 300, y: 250 }, pointer(600, 500), h);
    t.hover!({ x: 700, y: 250 }, pointer(1400, 500), h);
    expect(said(told, "cursor").map((c) => c[0])).toEqual(["nwse-resize", "move", "crosshair"]);
  });

  it("perspective: the nearest corner is dragged, held to the canvas; a double-click applies", () => {
    const quad: CropQuad = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 400 },
      { x: 100, y: 400 },
    ];
    const { h, told } = fake({ tool: "crop" });
    h.crop = { ...h.crop, quad };
    const t = cropTool();
    t.down(pointer(1004, 204), h); // (502, 102): corner 1
    expect(t.busy()).toBe(true);
    t.hover!({ x: 1200, y: -50 }, pointer(2400, -100), h);
    expect(said(told, "cropQuad").at(-1)![0]).toEqual([quad[0], { x: 1000, y: 0 }, quad[2], quad[3]]);
    t.up!(pointer(2400, -100), h);
    expect(t.busy()).toBe(false);
    t.down(pointer(600, 500), h); // far from every corner: nothing to grab
    expect(t.busy()).toBe(false);
    t.hover!({ x: 100, y: 100 }, pointer(200, 200), h);
    t.hover!({ x: 300, y: 300 }, pointer(600, 600), h);
    expect(said(told, "cursor").map((c) => c[0])).toEqual(["grab", "crosshair"]);
    t.doubleClick!(pointer(600, 500), h); // anywhere
    expect(said(told, "cropApply").length).toBe(1);
  });

  it("a pinch puts the quad back as it was before a corner's drag", () => {
    const quad: CropQuad = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 400 },
      { x: 100, y: 400 },
    ];
    const { h, told } = fake({ tool: "crop" });
    h.crop = { ...h.crop, quad };
    const t = cropTool();
    t.down(pointer(1004, 204), h); // corner 1
    t.hover!({ x: 600, y: 50 }, pointer(1200, 100), h);
    h.crop = { ...h.crop, quad: said(told, "cropQuad").at(-1)![0] as CropQuad };
    told.length = 0;
    t.cancel!(h);
    expect(told).toEqual([["cropQuad", quad]]);
    expect(t.busy()).toBe(false);
  });

  it("of two quad corners in reach, the nearer is taken", () => {
    const quad: CropQuad = [
      { x: 100, y: 100 },
      { x: 104, y: 100 },
      { x: 104, y: 104 },
      { x: 100, y: 104 },
    ];
    const { h, told } = fake({ tool: "crop" });
    h.crop = { ...h.crop, quad };
    const t = cropTool();
    t.down(pointer(207, 201), h); // (103.5, 100.5): corner 1, though corner 0 is in reach too
    t.hover!({ x: 120, y: 90 }, pointer(240, 180), h);
    expect(said(told, "cropQuad").at(-1)![0]).toEqual([quad[0], { x: 120, y: 90 }, quad[2], quad[3]]);
  });

  it("owns the overlay while it is up — and draws for its own tool only", () => {
    const { h } = fake({ tool: "crop" });
    const t = cropTool();
    const empty = painter();
    expect(t.drawOverlay!(empty.o, h), "no box: nothing").toBeFalsy();
    h.crop = { ...h.crop, box };
    const { o, ops } = painter();
    expect(t.drawOverlay!(o, h)).toBe(true);
    expect(ops).toContain("fillText");
    const other = painter();
    expect(t.drawOverlay!({ ...other.o, selected: false }, h)).toBeFalsy();
    expect([t.wantsOverlay!(true, h), t.wantsOverlay!(false, h)]).toEqual([true, false]);
  });
});

describe("crop geometry", () => {
  const base = { x: 100, y: 100, w: 400, h: 300 };

  it("a new box keeps the locked aspect and its minimum size", () => {
    const { h } = fake({ tool: "crop" });
    h.crop = { ...h.crop, aspect: 2 };
    expect(cropDragTo(h, { handle: "new", px: 0, py: 0, box: base }, { x: 300, y: 300 })).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 150,
    });
    h.crop = { ...h.crop, aspect: null };
    expect(cropDragTo(h, { handle: "new", px: 50, py: 50, box: base }, { x: 52, y: 51 })).toEqual({
      x: 50,
      y: 50,
      w: 8,
      h: 8,
    });
  });

  it("a moved box stays on the canvas — unless it is straightened", () => {
    const { h } = fake({ tool: "crop" });
    expect(cropDragTo(h, { handle: "move", px: 0, py: 0, box: base }, { x: 900, y: -200 })).toEqual({
      ...base,
      x: 600,
      y: 0,
    });
    h.crop = { ...h.crop, straighten: 5 };
    expect(cropDragTo(h, { handle: "move", px: 0, py: 0, box: base }, { x: 900, y: -200 })).toEqual({
      ...base,
      x: 1000,
      y: -100,
    });
  });

  it("an edge keeps the aspect about its middle; a corner from the opposite one", () => {
    const { h } = fake({ tool: "crop" });
    h.crop = { ...h.crop, aspect: 2 };
    expect(cropDragTo(h, { handle: "e", px: 500, py: 250, box: base }, { x: 600, y: 250 })).toEqual({
      x: 100,
      y: 125,
      w: 500,
      h: 250,
    });
    expect(cropDragTo(h, { handle: "se", px: 500, py: 400, box: base }, { x: 700, y: 700 })).toEqual({
      x: 100,
      y: 100,
      w: 600,
      h: 300,
    });
  });
});
