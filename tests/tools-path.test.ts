import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPathTools, makeAnchor, penHandlePos, penHitAt } from "../app/tools/path";
import { shapeTool } from "../app/tools/shape";
import type { ShapeNode, ToolHost } from "../app/tools";
import type { PenAnchor } from "../app/lib/tools";
import { STAR_DEFAULT, starCollinearInner } from "../app/lib/shapes";
import { fake, names, painter, pointer } from "./tools-bench";

/**
 * Shapes, the Pen and Direct selection, driven without a browser (see
 * tests/tools.test.ts for the bench). The pointer is at twice the document's
 * scale: client (x, y) is document (x/2, y/2).
 */

const said = (told: unknown[][], what: string) => told.filter((c) => c[0] === what).map((c) => c.slice(1));

// The node colour follows the UI's accent (a CSS variable): no DOM here.
beforeAll(() => {
  vi.stubGlobal("document", { documentElement: { getAttribute: () => null } });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#1868db" }));
});

/** A live shape, with a node under the pointer when it is asked for. */
function liveShape(h: ToolHost, box = { x: 100, y: 100, w: 200, h: 100 }, kind = "rect", node?: ShapeNode) {
  h.shape = {
    ...h.shape,
    live: { current: { layerId: "L1", box } },
    opts: { ...h.shape.opts, kind: kind as "rect" },
    nodeAt: () => node ?? null,
  };
}

describe("the Shape tool", () => {
  it("drags out a shape — and on the lift it is placed live", () => {
    const { h, calls, told } = fake({ tool: "shape" });
    const t = shapeTool();
    t.down(pointer(100, 100), h);
    expect(t.busy()).toBe(true);
    expect(names(calls), "a live one is committed first").toEqual(["endShape"]);
    expect(names(told)).toEqual(["freshShape"]);
    t.move!(pointer(301, 181), h);
    t.up!(pointer(301, 181), h);
    const placed = said(told, "placeShape");
    expect(placed).toEqual([["L1", { x: 50, y: 50, w: 101, h: 41 }]]);
    expect(said(told, "select"), "placing it makes its box the selection, in the same step").toEqual([]);
    expect(t.busy()).toBe(false);
  });

  it("Shift makes it 1:1, whichever way it is dragged", () => {
    const { h, told } = fake({ tool: "shape" });
    const t = shapeTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(100, 160, { shiftKey: true }), h);
    t.up!(pointer(100, 160), h);
    expect(said(told, "placeShape")[0][1]).toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  it("a click is not a shape", () => {
    const { h, told } = fake({ tool: "shape" });
    const t = shapeTool();
    t.down(pointer(200, 200), h);
    t.up!(pointer(200, 200), h);
    expect([said(told, "placeShape"), said(told, "select")]).toEqual([[], []]);
  });

  it("a node is grabbed before anything else; then the selection's handles", () => {
    const { h, calls, told } = fake({ tool: "shape" });
    liveShape(h, undefined, "tri", "apex");
    h.transform = { ...h.transform, start: () => true };
    const t = shapeTool();
    t.down(pointer(400, 200), h);
    expect([t.node.current, names(calls), said(told, "cursor")]).toEqual(["apex", [], [["grabbing"]]]);
    const u = shapeTool();
    liveShape(h, undefined, "tri");
    u.down(pointer(400, 200), h);
    expect([u.busy(), names(calls)], "the handles took it: no shape begun").toEqual([false, []]);
  });

  it("the apex slides along the top edge, snapping to the centre", () => {
    const { h, told } = fake({ tool: "shape" });
    liveShape(h, undefined, "tri", "apex");
    const t = shapeTool();
    t.down(pointer(400, 200), h);
    t.move!(pointer(260, 200), h); // x = 130: 0.15 of the box
    expect(h.shape.apex.current).toBeCloseTo(0.15, 9);
    expect(t.snapped.current).toBe(false);
    t.move!(pointer(404, 200), h); // x = 202: within the snap of the centre
    expect([h.shape.apex.current, t.snapped.current]).toEqual([0.5, true]);
    t.move!(pointer(900, 200), h); // past the right edge: held at it
    expect(h.shape.apex.current).toBe(1);
    t.move!(pointer(404, 200), h);
    expect(said(told, "scheduleShape").length, "rebuilt once a frame").toBe(4);
    t.up!(pointer(404, 200), h);
    expect([t.node.current, t.snapped.current]).toEqual([null, false]);
  });

  it("a trapezoid's sides snap to each other; a corner radius to square and to round", () => {
    const { h, told } = fake({ tool: "shape" });
    liveShape(h, undefined, "trapezoid", "l");
    h.shape = { ...h.shape, trap: { current: { l: 0.1, r: 0.3 } } };
    const t = shapeTool();
    t.down(pointer(220, 200), h);
    t.move!(pointer(330, 200), h); // l = 0.325: within reach of the right's 0.3
    expect(h.shape.trap.current).toEqual({ l: 0.3, r: 0.3 });
    t.up!(pointer(320, 200), h);
    liveShape(h, undefined, "rect", "radius");
    t.down(pointer(220, 200), h);
    t.move!(pointer(210, 200), h); // 5 px in: snaps to square
    t.move!(pointer(271, 200), h); // 35.5 px: a whole one
    t.move!(pointer(290, 200), h); // 45 of a 50 max: snaps to round
    expect(said(told, "radius").map((r) => r[0])).toEqual([0, 36, 50]);
  });

  it("a star's outer node turns it in 15° steps; its inner node snaps to the proper waist", () => {
    const { h } = fake({ tool: "shape" });
    const box = { x: 100, y: 100, w: 200, h: 200 };
    liveShape(h, box, "star", "starOuter");
    const t = shapeTool();
    t.down(pointer(400, 200), h);
    t.move!(pointer(400 + 200 * Math.sin(Math.PI / 6.1), 400 - 200 * Math.cos(Math.PI / 6.1)), h); // ~29.5°
    expect(h.shape.star.current.angle).toBe(30);
    t.up!(pointer(0, 0), h);
    liveShape(h, box, "star", "starInner");
    t.down(pointer(400, 400), h);
    const waist = starCollinearInner(STAR_DEFAULT.points)!;
    t.move!(pointer(400, 400 - 200 * waist - 2), h);
    expect(h.shape.star.current.inner).toBeCloseTo(waist, 9);
  });

  it("works in a rotated shape's own frame", () => {
    const { h } = fake({ tool: "shape", selection: { angle: Math.PI / 2, pivot: { x: 200, y: 150 } } });
    liveShape(h, undefined, "tri", "apex");
    const t = shapeTool();
    t.down(pointer(400, 300), h);
    t.move!(pointer(400, 240), h); // (200, 120): rotated back, x = 170 — 0.35 along
    expect(h.shape.apex.current).toBeCloseTo(0.35, 9);
  });

  it("drops a node drag when the live shape has gone", () => {
    const { h } = fake({ tool: "shape" });
    liveShape(h, undefined, "tri", "apex");
    const t = shapeTool();
    t.down(pointer(400, 200), h);
    h.shape = { ...h.shape, live: { current: null } };
    expect(t.move!(pointer(300, 200), h)).toBe(true);
    expect(t.busy()).toBe(false);
  });

  it("a pinch drops a shape being drawn and a node drag", () => {
    const { h, told } = fake({ tool: "shape" });
    const t = shapeTool();
    t.down(pointer(100, 100), h);
    t.move!(pointer(300, 300), h);
    t.cancel!(h);
    expect(t.busy(), "over at once").toBe(false);
    t.up!(pointer(300, 300), h);
    expect([said(told, "placeShape"), t.wantsOverlay!(true, h)]).toEqual([[], false]);
  });

  it("draws the shape being dragged out, filled and stroked, whatever tool is selected", () => {
    const { h } = fake({ tool: "shape" });
    const t = shapeTool();
    t.down(pointer(100, 100), h);
    t.move!(pointer(300, 300), h);
    const { o, ops } = painter();
    t.drawOverlay!({ ...o, selected: false }, h);
    expect(ops).toContain("fill");
  });

  it("shows what a press over its selection would do", () => {
    const { h, told } = fake({ tool: "shape" });
    shapeTool().hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    expect(names(told)).toEqual(["transformCursor"]);
  });
});

/** A path of `anchors` (corners unless given handles), live on the host. */
function withPath(h: ToolHost, anchors: PenAnchor[], closed = false) {
  h.path = { ...h.path, current: { current: { anchors, closed, layerId: "L1" } } };
  return h.path.current;
}

describe("the Pen", () => {
  it("a click starts a path; a drag gives the anchor handles, mirrored — Shift breaks them", () => {
    const { h, told, captured } = fake({ tool: "pen" });
    const { pen, penDrag } = createPathTools();
    pen.down(pointer(100, 100), h);
    expect(captured).toEqual([7]);
    expect(h.path.current.current).toEqual({ anchors: [makeAnchor(50, 50)], closed: false, layerId: "L1" });
    expect([penDrag.current, names(told)]).toEqual([{ kind: "new", index: 0 }, ["committable"]]);
    pen.move!(pointer(140, 100), h);
    expect(h.path.current.current!.anchors[0]).toMatchObject({ ox: 70, oy: 50, ix: 30, iy: 50 });
    pen.move!(pointer(140, 120, { shiftKey: true }), h);
    expect(h.path.current.current!.anchors[0]).toMatchObject({ ox: 70, oy: 60, ix: 30, iy: 50 });
    pen.up!(pointer(140, 120), h);
    expect([pen.busy(), said(told, "release")]).toEqual([false, [[7]]]);
  });

  it("each click adds an anchor; one on the first closes the path; on a closed one, starts anew", () => {
    const { h, calls } = fake({ tool: "pen" });
    const { pen } = createPathTools();
    withPath(h, [makeAnchor(50, 50), makeAnchor(150, 50)]);
    pen.down(pointer(300, 200), h);
    pen.up!(pointer(300, 200), h);
    expect(h.path.current.current!.anchors.length).toBe(3);
    pen.down(pointer(100, 100), h); // the first anchor
    expect([h.path.current.current!.closed, pen.busy()]).toEqual([true, false]);
    pen.down(pointer(600, 600), h);
    expect(names(calls)).toEqual(["endPath"]);
    expect(h.path.current.current!.anchors).toEqual([makeAnchor(300, 300)]);
  });

  it("an anchor is grabbed and moved with its handles; a handle takes priority", () => {
    const { h } = fake({ tool: "pen" });
    const { pen } = createPathTools();
    const a = { x: 50, y: 50, ix: 30, iy: 50, ox: 90, oy: 50 };
    withPath(h, [makeAnchor(150, 250), a]); // the second anchor (a click on the first would close it)
    pen.down(pointer(100, 100), h);
    pen.move!(pointer(120, 140), h);
    expect(h.path.current.current!.anchors[1]).toEqual({ x: 60, y: 70, ix: 40, iy: 70, ox: 100, oy: 70 });
    pen.up!(pointer(120, 140), h);
    pen.down(pointer(80, 140), h); // its in-handle, at (40, 70)
    pen.move!(pointer(80, 180), h);
    expect(h.path.current.current!.anchors[1]).toMatchObject({ ix: 40, iy: 90, ox: 80, oy: 50 });
  });

  it("a double-click finishes the path; a pinch ends a drag, never the path", () => {
    const { h, told } = fake({ tool: "pen" });
    const { pen } = createPathTools();
    pen.doubleClick!(pointer(0, 0), h);
    expect(said(told, "finishPath"), "no path: nothing").toEqual([]);
    pen.down(pointer(100, 100), h);
    pen.cancel!(h);
    expect([pen.busy(), h.path.current.current !== null]).toEqual([false, true]);
    pen.doubleClick!(pointer(0, 0), h);
    expect(said(told, "finishPath").length).toBe(1);
  });

  it("merges a floating selection before drawing", () => {
    const { h, calls } = fake({ tool: "pen" }, true);
    createPathTools().pen.down(pointer(0, 0), h);
    expect(names(calls)).toEqual(["commitFloat"]);
  });

  it("draws the path with its handles and anchors — the first one bigger", () => {
    const { h } = fake({ tool: "pen" });
    const { pen } = createPathTools();
    expect(pen.wantsOverlay!(false, h)).toBe(false);
    withPath(h, [makeAnchor(50, 50), makeAnchor(150, 50)]);
    expect(pen.wantsOverlay!(false, h), "whatever tool is selected").toBe(true);
    const { o, ops } = painter();
    pen.drawOverlay!(o, h);
    expect(ops).toContain("bezierCurveTo");
    expect(ops.filter((x) => x === "arc").length).toBe(2 + 2); // two handle dots + two anchors
  });
});

describe("Direct selection", () => {
  const path3 = () => [makeAnchor(50, 50), makeAnchor(150, 50), makeAnchor(150, 150)];

  it("does nothing without a path", () => {
    const { h, captured } = fake({ tool: "directselect" });
    const { directSelect } = createPathTools();
    directSelect.down(pointer(100, 100), h);
    expect([captured, directSelect.busy()]).toEqual([[], false]);
  });

  it("a click picks an anchor (Shift adds and takes away) and drags every picked one", () => {
    const { h, told } = fake({ tool: "directselect" });
    const { directSelect } = createPathTools();
    withPath(h, path3());
    directSelect.down(pointer(100, 100), h);
    expect([...h.path.picked.current]).toEqual([0]);
    directSelect.up!(pointer(100, 100), h);
    directSelect.down(pointer(300, 100, { shiftKey: true }), h);
    expect([...h.path.picked.current].sort()).toEqual([0, 1]);
    directSelect.move!(pointer(310, 120), h);
    directSelect.move!(pointer(320, 140), h); // the drag goes on from where it got to
    const a = h.path.current.current!.anchors;
    expect([a[0].x, a[0].y, a[1].x, a[1].y, a[2].x]).toEqual([60, 70, 160, 70, 150]);
    directSelect.up!(pointer(320, 140), h);
    expect(said(told, "renderPath").length).toBeGreaterThan(1);
    directSelect.down(pointer(320, 140, { shiftKey: true }), h); // the second again: Shift takes it away
    expect([...h.path.picked.current]).toEqual([0]);
  });

  it("Alt on a point turns it smooth; Alt on a segment adds a point there", () => {
    const { h } = fake({ tool: "directselect" });
    const { directSelect } = createPathTools();
    withPath(h, path3());
    directSelect.down(pointer(300, 100, { altKey: true }), h);
    const b = h.path.current.current!.anchors[1];
    expect(b.ix !== b.x || b.ox !== b.x, "handles pulled out").toBe(true);
    directSelect.up!(pointer(300, 100), h);
    withPath(h, path3());
    directSelect.down(pointer(200, 100, { altKey: true }), h); // midway along the first segment
    expect(h.path.current.current!.anchors.length).toBe(4);
    expect([...h.path.picked.current]).toEqual([1]);
  });

  it("a click on the path takes it all; a marquee gathers the anchors it covers", () => {
    const { h } = fake({ tool: "directselect" });
    const { directSelect, dsMarquee } = createPathTools();
    withPath(h, path3());
    directSelect.down(pointer(200, 100), h);
    expect([...h.path.picked.current].sort()).toEqual([0, 1, 2]);
    directSelect.down(pointer(500, 500), h); // nowhere: a marquee, the picks cleared
    expect([...h.path.picked.current]).toEqual([]);
    expect(dsMarquee.current).toEqual({ x0: 250, y0: 250, x1: 250, y1: 250 });
    directSelect.move!(pointer(200, 60), h);
    directSelect.up!(pointer(200, 60), h);
    expect([...h.path.picked.current].sort()).toEqual([1, 2]);
    expect(dsMarquee.current).toBeNull();
  });

  it("draws its marquee, and the picked anchors filled", () => {
    const { h } = fake({ tool: "directselect" });
    const { pen, directSelect } = createPathTools();
    withPath(h, path3());
    directSelect.down(pointer(500, 500), h);
    directSelect.move!(pointer(200, 60), h);
    const { o, ops } = painter();
    pen.drawOverlay!(o, h); // the family's one drawing
    expect(ops.filter((x) => x === "strokeRect").length).toBe(2);
    expect(pen.wantsOverlay!(false, h)).toBe(true);
  });

  it("a pinch ends its drag and marquee, never the path", () => {
    const { h } = fake({ tool: "directselect" });
    const { directSelect, dsMarquee, dsDrag } = createPathTools();
    withPath(h, path3());
    directSelect.down(pointer(500, 500), h);
    directSelect.cancel!(h);
    expect([dsMarquee.current, dsDrag.current, directSelect.busy()]).toEqual([null, null, false]);
    expect(h.path.current.current).not.toBeNull();
  });
});

describe("pen handles", () => {
  it("a handle is hit where it is drawn — a stub on a retracted one", () => {
    const { h } = fake({ tool: "pen", zoom: 100 });
    withPath(h, [makeAnchor(50, 50), makeAnchor(150, 50)]);
    const stub = penHandlePos(h.path.current.current!.anchors, 0, false, true, 1);
    expect(stub).toEqual({ x: 74, y: 50 }); // 24 screen px along the path
    expect(penHitAt(h, stub)).toEqual({ kind: "out", index: 0 });
    expect(penHitAt(h, { x: 126, y: 50 })).toEqual({ kind: "in", index: 1 });
    expect(penHitAt(h, { x: 51, y: 51 })).toEqual({ kind: "anchor", index: 0 });
    expect(penHitAt(h, { x: 100, y: 90 })).toBeNull();
  });
});
