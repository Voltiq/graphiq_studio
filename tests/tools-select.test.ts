import { describe, expect, it } from "vitest";
import { lassoTool } from "../app/tools/lasso";
import { marqueeSelRects, marqueeTool } from "../app/tools/marquee";
import { quickSelectTool } from "../app/tools/quickselect";
import { wandTool } from "../app/tools/wand";
import { DEFAULT_QUICKSELECT } from "../app/lib/tools";
import { fake, names, painter, pointer } from "./tools-bench";

/**
 * The selection tools, driven without a browser (see tests/tools.test.ts for
 * the bench). The pointer is at twice the document's scale: client (x, y) is
 * document (x/2, y/2). The selection itself is the editor's: these check what
 * each tool asks of it.
 */

const region = { rects: [{ x: 1, y: 1, w: 4, h: 4 }], segments: [{ x1: 1, y1: 1, x2: 5, y2: 1 }] };
const said = (told: unknown[][], what: string) => told.filter((c) => c[0] === what).map((c) => c.slice(1));

describe("the marquee", () => {
  it("a drag replaces the selection with the rectangle; a click clears it", () => {
    const { h, told, captured } = fake({ tool: "select" });
    const t = marqueeTool();
    t.down(pointer(40, 60), h);
    expect(captured).toEqual([7]);
    expect([t.anchor.current, t.rect.current]).toEqual([
      { x: 20, y: 30, mode: "new" },
      { x: 20, y: 30, w: 0, h: 0 },
    ]);
    expect(t.move!(pointer(140, 160), h)).toBe(true);
    expect(t.rect.current).toEqual({ x: 20, y: 30, w: 50, h: 50 });
    t.up!(pointer(140, 160), h);
    expect(said(told, "select")).toEqual([[[{ x: 20, y: 30, w: 50, h: 50 }], null]]);
    expect(names(told)).toEqual(["snapEnd", "triangle", "select", "release"]);
    expect([t.anchor.current, t.rect.current, t.busy()]).toEqual([null, null, false]);
    told.length = 0;
    t.down(pointer(40, 60), h);
    t.up!(pointer(40, 60), h);
    expect(said(told, "select"), "a click: nothing selected").toEqual([[[], null]]);
  });

  it("snaps its corners — the anchor at the press, the free one as it goes (Ctrl suspends it)", () => {
    const begins: unknown[] = [];
    const points: unknown[] = [];
    const { h } = fake({ tool: "select" });
    h.snap = {
      ...h.snap,
      begin: (x, y, suspend) => (begins.push([x, y, suspend]), { x: 22, y: 32 }),
      point: (x, y, suspend) => (points.push([x, y, suspend]), { x: x + 1, y }),
    };
    const t = marqueeTool();
    t.down(pointer(40, 60), h);
    expect(t.anchor.current).toMatchObject({ x: 22, y: 32 });
    t.move!(pointer(140, 160, { ctrlKey: true }), h);
    expect(begins).toEqual([[20, 30, false]]);
    expect(points).toEqual([[70, 80, true]]);
    expect(t.rect.current).toEqual({ x: 22, y: 32, w: 49, h: 48 });
  });

  it("Shift holds it square, inside the canvas, and does not snap", () => {
    const points: unknown[] = [];
    const { h } = fake({ tool: "select" });
    h.snap = { ...h.snap, point: (x, y) => (points.push([x, y]), { x, y }) };
    const t = marqueeTool();
    t.down(pointer(1900, 100), h); // (950, 50): 50 px from the right edge
    t.move!(pointer(1700, 400, { shiftKey: true }), h); // 100 left, 150 down
    expect(t.rect.current).toEqual({ x: 800, y: 50, w: 150, h: 150 });
    t.move!(pointer(2200, 400, { shiftKey: true }), h); // right: only 50 px of canvas
    expect(t.rect.current).toEqual({ x: 950, y: 50, w: 50, h: 50 });
    expect(points).toEqual([]);
  });

  it("rounds to whole pixels when Snap is on", () => {
    const { h } = fake({ tool: "select" });
    h.settings = { ...h.settings, snapPixels: true };
    const t = marqueeTool();
    t.down(pointer(41, 61), h);
    t.move!(pointer(142, 163), h); // (20.5, 30.5) to (71, 81.5)
    expect(t.rect.current).toEqual({ x: 21, y: 31, w: 51, h: 51 });
  });

  it("Ctrl adds the region, Alt subtracts it — through the engine's combine", () => {
    for (const [mod, op] of [
      [{ ctrlKey: true }, "add"],
      [{ altKey: true }, "subtract"],
    ] as const) {
      const all = [{ x: 0, y: 0, w: 10, h: 10 }];
      const { h, calls, told } = fake({ tool: "select", selection: { rects: all } }, false, { combined: region });
      const t = marqueeTool();
      t.down(pointer(40, 60, mod), h);
      t.move!(pointer(140, 160), h);
      t.up!(pointer(140, 160), h);
      expect(calls).toEqual([["combineSelection", all, [{ x: 20, y: 30, w: 50, h: 50 }], op]]);
      expect(said(told, "combine")).toEqual([[region]]);
    }
  });

  it("an ellipse is traced row by row and combined — even replacing, from nothing", () => {
    const { h, calls } = fake({ tool: "select", selection: { rects: [{ x: 0, y: 0, w: 3, h: 3 }] } }, false, {
      combined: region,
    });
    h.settings = { ...h.settings, marquee: { shape: "ellipse", apex: 0.5 } };
    const t = marqueeTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(20, 20), h);
    t.up!(pointer(20, 20), h);
    expect(calls).toEqual([["combineSelection", [], marqueeSelRects({ x: 0, y: 0, w: 10, h: 10 }, "ellipse"), "add"]]);
  });

  it("a triangle is remembered for the Apex slider — pointing the way it was dragged", () => {
    const { h, told } = fake({ tool: "select" }, false, { combined: region });
    h.settings = { ...h.settings, marquee: { shape: "triangle", apex: 0.25 } };
    const t = marqueeTool();
    t.down(pointer(0, 0), h); // anchored at the top: dragged down, so it points down
    t.move!(pointer(20, 20), h);
    t.up!(pointer(20, 20), h);
    expect(said(told, "triangle")).toEqual([
      [null],
      [{ box: { x: 0, y: 0, w: 10, h: 10 }, pointDown: true, base: [], mode: "new", key: region.rects }],
    ]);
  });

  it("a plain press on the selection's handles transforms it; Ctrl, Alt or Shift always draws", () => {
    const tries: unknown[] = [];
    const { h } = fake({ tool: "select" });
    h.transform = { ...h.transform, start: (_e, p) => (tries.push(p), true) };
    const t = marqueeTool();
    t.down(pointer(40, 60), h);
    expect([tries.length, t.busy()]).toEqual([1, false]);
    for (const mod of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      t.down(pointer(40, 60, mod), h);
      expect(t.busy()).toBe(true);
      t.cancel!(h);
    }
    expect(tries.length).toBe(1);
  });

  it("merges a floating selection before reselecting", () => {
    const { h, calls } = fake({ tool: "select" }, true);
    marqueeTool().down(pointer(0, 0), h);
    expect(names(calls)).toEqual(["commitFloat"]);
  });

  it("a pinch drops it: nothing selected, then or on the lift", () => {
    const { h, told } = fake({ tool: "select" });
    const t = marqueeTool();
    t.down(pointer(40, 60), h);
    t.move!(pointer(140, 160), h);
    t.cancel!(h);
    t.up!(pointer(140, 160), h);
    expect(said(told, "select")).toEqual([]);
    expect([t.rect.current, t.wantsOverlay!(true, h)]).toEqual([null, false]);
  });

  it("shows what a press over the selection would do", () => {
    const { h, told } = fake({ tool: "select" });
    marqueeTool().hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    expect(names(told)).toEqual(["transformCursor"]);
  });

  it("draws an ellipse's, a triangle's or an added region's outline; a replacing rectangle is the ants'", () => {
    const drawn = (shape: "rect" | "ellipse" | "triangle", mod = {}) => {
      const { h } = fake({ tool: "select" });
      h.settings = { ...h.settings, marquee: { shape, apex: 0.5 } };
      const t = marqueeTool();
      t.down(pointer(0, 0, mod), h);
      t.move!(pointer(40, 40), h);
      const { o, ops } = painter();
      t.drawOverlay!(o, h);
      return ops;
    };
    expect(drawn("rect")).toEqual([]);
    expect(drawn("ellipse")).toContain("ellipse");
    expect(drawn("triangle")).toContain("closePath");
    expect(drawn("rect", { ctrlKey: true })).toContain("rect");
  });

  it("shows a subtracted region in red, over the part of the selection it cuts", () => {
    const { h } = fake({ tool: "select", selection: { rects: [{ x: 0, y: 0, w: 10, h: 10 }] } });
    const t = marqueeTool();
    t.down(pointer(0, 0, { altKey: true }), h);
    t.move!(pointer(40, 40), h);
    const { o, ops } = painter();
    t.drawOverlay!(o, h);
    expect(ops).toContain("clip"); // the cut part, filled
    expect(ops.filter((x) => x === "stroke").length).toBe(2); // its outline, two passes
  });
});

describe("marquee regions", () => {
  it("a rectangle is itself, rounded; a sliver is nothing", () => {
    expect(marqueeSelRects({ x: 0.4, y: 0.6, w: 9.6, h: 4.4 }, "rect")).toEqual([{ x: 0, y: 1, w: 10, h: 4 }]);
    expect(marqueeSelRects({ x: 0, y: 0, w: 0.4, h: 9 }, "ellipse")).toEqual([]);
    expect(marqueeSelRects({ x: 0, y: 0, w: 9, h: 0.4 }, "rect")).toEqual([]);
  });

  it("an ellipse is symmetric, widest across its middle", () => {
    const rows = marqueeSelRects({ x: 0, y: 0, w: 20, h: 10 }, "ellipse");
    expect(rows.length).toBe(10);
    expect(rows.map((r) => r.w)).toEqual(rows.map((r) => r.w).reverse());
    expect(Math.max(...rows.map((r) => r.w))).toBe(rows[4].w);
  });

  it("a triangle narrows to its apex — up, or down when dragged down", () => {
    const up = marqueeSelRects({ x: 0, y: 0, w: 20, h: 10 }, "triangle");
    expect(up[0].w).toBeLessThan(up[9].w);
    const down = marqueeSelRects({ x: 0, y: 0, w: 20, h: 10 }, "triangle", true);
    expect(down[0].w).toBeGreaterThan(down[down.length - 1].w);
    const slanted = marqueeSelRects({ x: 0, y: 0, w: 20, h: 10 }, "triangle", false, 0);
    expect(slanted[0].x, "the apex at the left edge").toBe(0);
  });
});

describe("the lasso", () => {
  it("a drag is a path, closed and selected on the lift — points only every 2 screen px", () => {
    const { h, calls, told, captured } = fake({ tool: "lasso" }, false, { lassoed: region });
    const t = lassoTool();
    t.down(pointer(0, 0), h);
    expect([captured, t.busy()]).toEqual([[7], true]);
    t.move!(pointer(2, 0), h); // one doc px: too close
    t.move!(pointer(20, 0), h);
    t.move!(pointer(20, 20), h);
    t.up!(pointer(20, 20), h);
    expect(calls).toEqual([
      [
        "lassoSelect",
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      ],
    ]);
    expect(said(told, "select")).toEqual([[region.rects, region.segments]]);
    expect(t.busy()).toBe(false);
  });

  it("Ctrl adds the region, Alt subtracts it", () => {
    for (const [mod, op] of [
      [{ ctrlKey: true }, "add"],
      [{ altKey: true }, "subtract"],
    ] as const) {
      const all = [{ x: 0, y: 0, w: 3, h: 3 }];
      const { h, calls, told } = fake({ tool: "lasso", selection: { rects: all } }, false, {
        lassoed: region,
        combined: region,
      });
      const t = lassoTool();
      t.down(pointer(0, 0, mod), h);
      t.move!(pointer(20, 0), h);
      t.move!(pointer(20, 20), h);
      t.up!(pointer(20, 20), h);
      expect(calls.at(-1)).toEqual(["combineSelection", all, region.rects, op]);
      expect(said(told, "combine")).toEqual([[region]]);
    }
  });

  it("two points enclose nothing: no region is asked for", () => {
    const { h, calls, told } = fake({ tool: "lasso" }, false, { lassoed: region });
    const t = lassoTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(40, 0), h);
    t.up!(pointer(40, 0), h);
    expect(calls).toEqual([]);
    expect(said(told, "select")).toEqual([[[], null]]);
  });

  it("a click (or an empty lasso) clears the selection — unless adding or subtracting", () => {
    const plain = fake({ tool: "lasso" });
    const t = lassoTool();
    t.down(pointer(0, 0), plain.h);
    t.up!(pointer(0, 0), plain.h);
    expect(said(plain.told, "select")).toEqual([[[], null]]);
    const adding = fake({ tool: "lasso" });
    const u = lassoTool();
    u.down(pointer(0, 0, { ctrlKey: true }), adding.h);
    u.up!(pointer(0, 0), adding.h);
    expect(said(adding.told, "select")).toEqual([]);
  });

  it("a polygon is clicked out — no capture — and closed by a click on its start", () => {
    const { h, calls, told, captured } = fake({ tool: "lasso" }, false, { lassoed: region });
    h.settings = { ...h.settings, lasso: "poly" };
    const t = lassoTool();
    t.down(pointer(0, 0), h);
    expect([captured, t.busy(), names(told)]).toEqual([[], false, ["committable"]]);
    t.up!(pointer(0, 0), h);
    expect(t.hover!({ x: 30, y: 3 }, pointer(60, 6), h), "the rubber band takes the move").toBe(true);
    expect(t.polyHover.current).toEqual({ x: 30, y: 3 });
    t.down(pointer(60, 0), h);
    t.down(pointer(60, 60), h);
    t.down(pointer(10, 6), h); // (5, 3): 8 screen px of the start
    expect(calls).toEqual([
      [
        "lassoSelect",
        [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 30 },
        ],
      ],
    ]);
    expect(said(told, "select")).toEqual([[region.rects, region.segments]]);
    expect([t.poly.current, t.polyHover.current]).toEqual([null, null]);
    expect(t.hover!({ x: 1, y: 1 }, pointer(2, 2), h), "no polygon: no move taken").toBeFalsy();
  });

  it("a click near the start of a polygon of two points adds a third", () => {
    const { h } = fake({ tool: "lasso" });
    h.settings = { ...h.settings, lasso: "poly" };
    const t = lassoTool();
    t.down(pointer(0, 0), h);
    t.down(pointer(60, 0), h);
    t.down(pointer(4, 0), h);
    expect(t.poly.current!.pts.length).toBe(3);
  });

  it("a double-click closes it — its second press's corner dropped — and Enter's commit does too", () => {
    const { h, calls, told } = fake({ tool: "lasso" }, false, { lassoed: region });
    h.settings = { ...h.settings, lasso: "poly" };
    const t = lassoTool();
    t.doubleClick!(pointer(0, 0), h);
    expect([calls, told], "no polygon: nothing").toEqual([[], []]);
    t.down(pointer(0, 0), h);
    t.down(pointer(60, 0), h);
    t.down(pointer(60, 60), h); // a double-click is two presses...
    t.down(pointer(61, 62), h);
    t.doubleClick!(pointer(61, 62), h); // ...then the double-click
    expect(calls).toEqual([["lassoSelect", [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }]]]);
    expect(t.poly.current).toBeNull();
    const d = fake({ tool: "lasso" }, false, { lassoed: region });
    d.h.settings = { ...d.h.settings, lasso: "poly" };
    const v = lassoTool();
    for (const [x, y] of [[0, 0], [60, 0], [60, 60], [0, 60]]) v.down(pointer(x, y), d.h);
    v.doubleClick!(pointer(0, 60), d.h); // (the last two presses a double-click's own, in a test)
    expect(d.calls[0][1], "corners a click apart stay").toHaveLength(4);
    const k = fake({ tool: "lasso" }, false, { lassoed: region });
    k.h.settings = { ...k.h.settings, lasso: "poly" };
    const u = lassoTool();
    u.down(pointer(0, 0), k.h);
    u.down(pointer(60, 0), k.h);
    u.down(pointer(60, 60), k.h);
    u.commitPolygon(k.h);
    expect(names(k.calls)).toEqual(["lassoSelect"]);
    u.commitPolygon(k.h);
    expect(names(k.calls), "nothing open: nothing more").toEqual(["lassoSelect"]);
  });

  it("a pinch drops a dragged path, never a polygon", () => {
    const { h, calls, told } = fake({ tool: "lasso" });
    const t = lassoTool();
    t.down(pointer(0, 0), h);
    t.cancel!(h);
    expect(t.busy(), "over at once").toBe(false);
    t.up!(pointer(20, 20), h);
    expect([calls, said(told, "select")], "and its lift selects nothing").toEqual([[], []]);
    h.settings = { ...h.settings, lasso: "poly" };
    t.down(pointer(0, 0), h);
    t.cancel!(h);
    expect(t.poly.current).not.toBeNull();
  });

  it("merges a floating selection before reselecting", () => {
    const { h, calls } = fake({ tool: "lasso" }, true);
    lassoTool().down(pointer(0, 0), h);
    expect(names(calls)).toEqual(["commitFloat"]);
  });

  it("draws its path, or its polygon with a dot on each corner — whatever tool is selected", () => {
    const { h } = fake({ tool: "lasso" });
    const t = lassoTool();
    expect(t.wantsOverlay!(false, h)).toBe(false);
    t.down(pointer(0, 0), h);
    t.move!(pointer(40, 0), h);
    expect(t.wantsOverlay!(false, h)).toBe(true);
    const path = painter();
    t.drawOverlay!({ ...path.o, selected: false }, h);
    expect(path.ops).toContain("closePath");
    t.up!(pointer(40, 0), h);
    h.settings = { ...h.settings, lasso: "poly" };
    t.down(pointer(0, 0), h);
    t.down(pointer(40, 0), h);
    const poly = painter();
    t.drawOverlay!(poly.o, h);
    expect(poly.ops.filter((x) => x === "arc").length).toBe(2);
  });

  it("shows a subtracting path in red, over the part of the selection it cuts", () => {
    const { h } = fake({ tool: "lasso", selection: { rects: [{ x: 0, y: 0, w: 10, h: 10 }] } });
    const t = lassoTool();
    t.down(pointer(0, 0, { altKey: true }), h);
    t.move!(pointer(40, 0), h);
    t.move!(pointer(40, 40), h);
    const { o, ops } = painter();
    t.drawOverlay!(o, h);
    expect(ops).toContain("clip");
  });
});

describe("the magic wand", () => {
  it("a click selects what is like the pixel under it, and keeps the seed for a Tolerance change", () => {
    const { h, calls, told } = fake({ tool: "wand" }, false, { wand: region });
    wandTool().down(pointer(40, 60), h);
    expect(calls).toEqual([
      ["magicWand", "L1", 20, 30, { tolerance: 32, contiguous: true, sampleAll: false }, false, null],
    ]);
    expect(said(told, "seedWand")).toEqual([[{ x: 20, y: 30, layerId: "L1", base: [], mode: "new" }]]);
    expect(said(told, "select")).toEqual([[region.rects, region.segments]]);
  });

  it("Ctrl folds the selection into the flood; Alt cuts the region out of it", () => {
    const all = [{ x: 0, y: 0, w: 3, h: 3 }];
    const add = fake({ tool: "wand", selection: { rects: all } }, false, { wand: region });
    wandTool().down(pointer(40, 60, { ctrlKey: true }), add.h);
    expect(add.calls[0][6]).toBe(all);
    expect(said(add.told, "select")).toEqual([[region.rects, region.segments]]);
    const sub = fake({ tool: "wand", selection: { rects: all } }, false, { wand: region, combined: region });
    wandTool().down(pointer(40, 60, { altKey: true }), sub.h);
    expect(sub.calls[0][6], "nothing folded in").toBeNull();
    expect(sub.calls[1]).toEqual(["combineSelection", all, region.rects, "subtract"]);
    expect(said(sub.told, "combine")).toEqual([[region]]);
  });

  it("a plain click starts from nothing, whatever is selected", () => {
    const all = [{ x: 0, y: 0, w: 3, h: 3 }];
    const { h, calls, told } = fake({ tool: "wand", selection: { rects: all } }, false, { wand: region });
    wandTool().down(pointer(40, 60), h);
    expect(said(told, "seedWand")[0][0]).toMatchObject({ base: [], mode: "new" });
    expect(calls[0][6]).toBeNull();
  });

  it("an empty flood selects nothing new", () => {
    const { h, told } = fake({ tool: "wand" }, false, { wand: { rects: [], segments: [] } });
    wandTool().down(pointer(40, 60), h);
    expect(said(told, "select")).toEqual([]);
  });

  it("needs a layer to sample — unless it samples them all", () => {
    const none = fake({ tool: "wand", activeLayerId: null });
    wandTool().down(pointer(40, 60), none.h);
    expect(none.calls).toEqual([]);
    const all = fake({ tool: "wand", activeLayerId: null });
    all.h.settings = { ...all.h.settings, wand: { ...all.h.settings.wand, sampleAll: true } };
    wandTool().down(pointer(40, 60), all.h);
    expect(all.calls[0].slice(0, 2)).toEqual(["magicWand", ""]);
  });

  it("a plain press on the selection's handles transforms it; Ctrl or Alt always floods", () => {
    const { h, calls } = fake({ tool: "wand" });
    h.transform = { ...h.transform, start: () => true };
    const t = wandTool();
    t.down(pointer(40, 60), h);
    expect(calls).toEqual([]);
    t.down(pointer(40, 60, { ctrlKey: true }), h);
    expect(names(calls)).toEqual(["magicWand"]);
  });

  it("shows what a press over the selection would do", () => {
    const { h, told } = fake({ tool: "wand" });
    wandTool().hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    expect(names(told)).toEqual(["transformCursor"]);
  });
});

describe("quick selection", () => {
  it("a stroke grows the selection a dab at a time — every quarter of the tip", () => {
    const { h, calls, told } = fake({ tool: "quickselect" }, false, { dab: region });
    const t = quickSelectTool();
    t.down(pointer(0, 0), h);
    expect(t.busy()).toBe(true);
    const step = Math.max(2, DEFAULT_QUICKSELECT.size * 0.25);
    expect(calls).toEqual([
      ["beginQuickSelect", "L1", { tolerance: DEFAULT_QUICKSELECT.tolerance, sampleAll: false }, null, false],
      ["quickSelectDab", 0, 0, DEFAULT_QUICKSELECT.size / 2],
    ]);
    t.move!(pointer(step, 0), h); // half a step
    t.move!(pointer(step * 2.2, 0), h);
    expect(names(calls).filter((n) => n === "quickSelectDab").length).toBe(2);
    t.up!(pointer(step * 2.2, 0), h);
    expect(calls.at(-1)).toEqual(["endQuickSelect"]);
    expect(said(told, "combine").length).toBe(2);
    expect(t.busy()).toBe(false);
  });

  it("a pinch puts the selection back as it was before the stroke", () => {
    const { h, calls, told } = fake({ tool: "quickselect" }, false, { dab: region });
    const rects = [{ x: 0, y: 0, w: 3, h: 3 }];
    h.selection = { ...h.selection, rects, all: rects, angle: 0.5, pivot: { x: 1, y: 2 } };
    const t = quickSelectTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(40, 0), h);
    t.cancel!(h);
    expect(said(told, "place")).toEqual([[rects, 0.5, { x: 1, y: 2 }]]);
    expect(t.busy()).toBe(false);
    expect(t.move!(pointer(80, 0), h), "the next move is not the stroke's").toBe(false);
    t.up!(pointer(80, 0), h);
    t.cancel!(h);
    expect(names(calls).filter((n) => n === "endQuickSelect").length, "ended once").toBe(1);
    expect(said(told, "place").length, "nothing in flight: nothing to put back").toBe(1);
  });

  it("Alt takes away; a dab that leaves nothing deselects", () => {
    const { h, calls, told } = fake({ tool: "quickselect" });
    quickSelectTool().down(pointer(0, 0, { altKey: true }), h);
    expect(calls[0][4]).toBe(true);
    expect(said(told, "select")).toEqual([[[], null]]);
  });

  it("needs a layer to sample — unless it samples them all", () => {
    const { h, calls } = fake({ tool: "quickselect", activeLayerId: null });
    const t = quickSelectTool();
    t.down(pointer(0, 0), h);
    expect([calls, t.busy()]).toEqual([[], false]);
  });

  it("works from the selection there is", () => {
    const rects = [{ x: 0, y: 0, w: 3, h: 3 }];
    const { h, calls } = fake({ tool: "quickselect", selection: { rects } });
    quickSelectTool().down(pointer(0, 0), h);
    expect(calls[0][3]).toBe(rects);
  });

  it("shows its tip's ring, kept while a stroke is dragged out", () => {
    const { h } = fake({ tool: "quickselect" });
    const t = quickSelectTool();
    const { o, rings } = painter();
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.drawCursor!(o, h);
    expect(rings).toEqual([[20, 32, Math.max(1, DEFAULT_QUICKSELECT.size), 100]]);
    t.down(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
    t.up!(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });
});
