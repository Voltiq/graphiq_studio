import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bucketTool } from "../app/tools/bucket";
import { eyedropperTool } from "../app/tools/eyedropper";
import { frameTool } from "../app/tools/frame";
import { gradientTool } from "../app/tools/gradient";
import { measureTool } from "../app/tools/measure";
import { textTool } from "../app/tools/text";
import type { VectorText } from "../app/lib/tools";
import { fake, names, painter, pointer, prevented } from "./tools-bench";

/**
 * The tools that put something on the canvas and leave it there to adjust —
 * a colour sample, a ruler, a fill, a gradient, a frame, a text box — driven
 * without a browser (see tests/tools.test.ts for the bench). The pointer is at
 * twice the document's scale here: client (x, y) is document (x/2, y/2).
 */

/** Frames and timers, by hand: the throttle and the per-frame re-runs. */
let frames: (() => void)[] = [];
const flushFrames = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};
let now = 1000;
beforeEach(() => {
  frames = [];
  now = 1000;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames[id - 1] = () => {};
  });
  vi.stubGlobal("window", { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const esc = () => {
  let stopped = 0;
  return { e: { key: "Escape", preventDefault: () => stopped++ } as unknown as KeyboardEvent, stopped: () => stopped };
};

describe("the eyedropper", () => {
  it("a click samples the colour under it into the foreground, and says where", () => {
    const { h, calls, told } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(40, 60), h);
    expect(calls).toEqual([["sampleColor", 20, 30, 1, false, "L1"]]);
    expect(told).toEqual([
      ["cursorAt", { x: 20, y: 30 }],
      ["pick", "#123456"],
    ]);
    expect(t.busy()).toBe(true);
    t.up!(pointer(40, 60), h);
    expect(t.busy()).toBe(false);
    expect(told.at(-1)).toEqual(["release", 7]);
  });

  it("samples at its size, from every layer when asked — and a blank pixel picks nothing", () => {
    const { h, calls, told } = fake({ tool: "eyedropper" }, false, { color: null });
    h.settings = { ...h.settings, sample: { size: 5, all: true } };
    eyedropperTool().down(pointer(40, 60), h);
    expect(calls[0]).toEqual(["sampleColor", 20, 30, 5, true, "L1"]);
    expect(names(told)).toEqual(["cursorAt"]);
  });

  it("tells the Info panel the pointer is off the canvas when it is", () => {
    const { h, told } = fake({ tool: "eyedropper" });
    eyedropperTool().down(pointer(-4, 60), h);
    expect(told[0]).toEqual(["cursorAt", null]);
  });

  it("a drag goes on sampling under the pointer; a hover only moves the outline", () => {
    const { h, calls } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    expect(t.hover!({ x: 5, y: 6 }, pointer(10, 12), h), "the Eyedropper takes every move").toBe(true);
    expect(calls).toEqual([]);
    expect(t.wantsOverlay!(true, h)).toBe(true);
    expect(t.wantsOverlay!(false, h), "another tool's: nothing drawn").toBe(false);
    t.down(pointer(40, 60), h);
    t.hover!({ x: 30, y: 40 }, pointer(60, 80), h);
    expect(calls.at(-1)).toEqual(["sampleColor", 30, 40, 1, false, "L1"]);
    t.up!(pointer(60, 80), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "a mouse leaves no marker").toBe(false);
  });

  it("keeps the outline while a sample is dragged out of the canvas", () => {
    const { h } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(40, 60), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
  });

  it("on touch, a tap leaves a marker; a press near it picks it up by its offset", () => {
    const { h, calls, loupes } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    const touch = { pointerType: "touch" };
    t.down(pointer(40, 60, touch), h);
    t.up!(pointer(40, 60, touch), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "the marker stays after the finger").toBe(true);
    t.down(pointer(44, 60, touch), h); // (22, 30): 2 px from the marker
    expect(calls.at(-1), "...which is sampled again, not the finger's pixel").toEqual([
      "sampleColor",
      20,
      30,
      1,
      false,
      "L1",
    ]);
    expect(loupes.at(-1), "the loupe shows the marker").toEqual({ x: 20, y: 30 });
    t.hover!({ x: 30, y: 40 }, pointer(60, 80, touch), h);
    expect(calls.at(-1)!.slice(1, 3), "it is held by the offset the grab began with").toEqual([28, 40]);
    expect(loupes.at(-1)).toEqual({ x: 28, y: 40 });
    t.up!(pointer(60, 80, touch), h);
    t.down(pointer(400, 400, touch), h);
    expect(calls.at(-1)!.slice(1, 3), "far from it, a press samples afresh").toEqual([200, 200]);
  });

  it("Shift drops a sampler; a press on one drags it, as one step; Alt or right-click removes it", () => {
    const { h, told } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(600, 600, { shiftKey: true }), h);
    expect(told).toEqual([["addSampler", 300, 300]]);
    expect(t.busy()).toBe(false);
    told.length = 0;
    t.down(pointer(202, 200), h); // the sampler at (100, 100)
    expect(t.busy()).toBe(true);
    t.hover!({ x: 150, y: 120 }, pointer(300, 240), h);
    t.up!(pointer(300, 240), h);
    expect(told).toEqual([
      ["moveSampler", "S1", 150, 120],
      ["commitSamplers", [{ id: "S1", x: 100, y: 100 }]],
      ["release", 7],
    ]);
    for (const over of [{ altKey: true }, { button: 2 }]) {
      told.length = 0;
      t.down(pointer(200, 200, over), h);
      expect(told).toEqual([["removeSampler", "S1"]]);
    }
  });

  it("a pinch puts a dragged sampler back, uncommitted, and stops a sample", () => {
    const { h, told } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(200, 200), h); // the sampler at (100, 100)
    t.hover!({ x: 150, y: 120 }, pointer(300, 240), h);
    told.length = 0;
    t.cancel!(h);
    expect(told, "back where it was").toEqual([["moveSampler", "S1", 100, 100]]);
    expect(t.busy()).toBe(false);
    t.up!(pointer(300, 240), h);
    expect(names(told), "the drag is not committed").not.toContain("commitSamplers");
    t.down(pointer(40, 60), h);
    expect(t.busy()).toBe(true);
    t.cancel!(h);
    expect(t.busy(), "the sample stops").toBe(false);
    told.length = 0;
    t.hover!({ x: 30, y: 30 }, pointer(60, 60), h);
    expect(names(told), "the pointer moving on samples nothing").not.toContain("pick");
  });

  it("Esc drops the marker and keeps the colour; another tool drops the outline too", () => {
    const { h } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(40, 60, { pointerType: "pen" }), h);
    t.up!(pointer(40, 60, { pointerType: "pen" }), h);
    const k = esc();
    t.keyDown!(k.e, h);
    expect(k.stopped()).toBe(1);
    const after = painter();
    t.drawOverlay!(after.o, h);
    expect(after.ops, "no marker (no ring)").not.toContain("arc");
    expect(after.ops, "the outline stays").toContain("strokeRect");
    const k2 = esc();
    t.keyDown!(k2.e, h);
    expect(k2.stopped(), "nothing to drop: Esc is not the Eyedropper's").toBe(0);
    t.deselect!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });

  it("another tool drops the marker", () => {
    const { h } = fake({ tool: "eyedropper" });
    const t = eyedropperTool();
    t.down(pointer(40, 60, { pointerType: "touch" }), h);
    t.up!(pointer(40, 60, { pointerType: "touch" }), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
    t.deselect!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });

  it("draws the outline at the sample's size, and the marker — only while selected", () => {
    const { h } = fake({ tool: "eyedropper" });
    h.settings = { ...h.settings, sample: { size: 3, all: false } };
    const t = eyedropperTool();
    t.down(pointer(40, 60, { pointerType: "touch" }), h);
    const { o, ops } = painter();
    t.drawOverlay!(o, h);
    expect(ops.filter((x) => x === "strokeRect").length).toBe(2);
    expect(ops).toContain("arc");
    const other = painter();
    t.drawOverlay!({ ...other.o, selected: false }, h);
    expect(other.ops).toEqual([]);
  });
});

describe("the ruler", () => {
  it("is dragged out from the press, and stays", () => {
    const { h, told, captured } = fake({ tool: "measure" });
    const t = measureTool();
    prevented.n = 0;
    t.down(pointer(40, 60), h);
    expect([prevented.n, captured]).toEqual([1, [7]]);
    expect(t.busy()).toBe(true);
    expect(t.move!(pointer(100, 60), h)).toBe(true);
    t.up!(pointer(100, 60), h);
    expect(told.filter((c) => c[0] === "measure")).toEqual([
      ["measure", { x1: 20, y1: 30, x2: 20, y2: 30 }],
      ["measure", { x1: 20, y1: 30, x2: 50, y2: 30 }],
    ]);
    expect(t.busy()).toBe(false);
    expect(h.measure.line).toEqual({ x1: 20, y1: 30, x2: 50, y2: 30 });
    expect(t.move!(pointer(1, 1), h), "a move after it is not the ruler's").toBe(false);
  });

  it("a pinch puts the line back as it was before the press", () => {
    const { h, told } = fake({ tool: "measure" });
    const line = { x1: 0, y1: 0, x2: 50, y2: 0 };
    h.measure = { ...h.measure, line };
    const t = measureTool();
    t.down(pointer(98, 2), h); // (49, 1): the far end
    t.move!(pointer(120, 40), h);
    t.cancel!(h);
    expect(h.measure.line).toEqual(line);
    expect(t.busy()).toBe(false);
    expect(t.move!(pointer(140, 40), h), "the next move is not the ruler's").toBe(false);
    t.down(pointer(300, 300), h); // a fresh line...
    t.cancel!(h);
    expect(h.measure.line, "...and the old one back").toEqual(line);
    const said = told.length;
    t.cancel!(h);
    expect(told.length, "nothing in flight: nothing to put back").toBe(said);
  });

  it("a bare click clears it rather than leaving a dot", () => {
    const { h } = fake({ tool: "measure" });
    const t = measureTool();
    t.down(pointer(40, 60), h);
    t.up!(pointer(40, 60), h);
    expect(h.measure.line).toBeNull();
  });

  it("an end is picked up to adjust — the nearer one", () => {
    const { h } = fake({ tool: "measure" });
    h.measure = { ...h.measure, line: { x1: 0, y1: 0, x2: 50, y2: 0 } };
    const t = measureTool();
    t.down(pointer(98, 2), h); // (49, 1): the far end
    t.move!(pointer(120, 40), h);
    expect(h.measure.line).toEqual({ x1: 0, y1: 0, x2: 60, y2: 20 });
    t.up!(pointer(120, 40), h);
    t.down(pointer(2, 0), h); // the start
    t.move!(pointer(0, 20), h);
    expect(h.measure.line).toEqual({ x1: 0, y1: 10, x2: 60, y2: 20 });
  });

  it("Shift holds it to 45° steps from the end that stays", () => {
    const { h } = fake({ tool: "measure" });
    const t = measureTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(100, 10, { shiftKey: true }), h);
    const m = h.measure.line!;
    expect(m.y2).toBeCloseTo(0, 9);
    expect(m.x2).toBeCloseTo(Math.hypot(50, 5), 9);
  });

  it("Shift turns about the end that stays, whichever end is dragged", () => {
    const { h } = fake({ tool: "measure" });
    h.measure = { ...h.measure, line: { x1: 0, y1: 0, x2: 50, y2: 0 } };
    const t = measureTool();
    t.down(pointer(0, 2), h); // the start
    t.move!(pointer(20, 102, { shiftKey: true }), h); // (10, 51) from the end at (50, 0)
    const m = h.measure.line!;
    expect([m.x2, m.y2], "the end stays").toEqual([50, 0]);
    // 45° steps about (50, 0): the press is at about 128°, so 135°.
    expect(m.x1).toBeCloseTo(50 - Math.hypot(40, 51) / Math.SQRT2, 9);
    expect(m.y1).toBeCloseTo(Math.hypot(40, 51) / Math.SQRT2, 9);
    t.up!(pointer(20, 102), h);
    // ...and dragging the end turns about the start.
    h.measure = { ...h.measure, line: { x1: 0, y1: 0, x2: 50, y2: 0 } };
    t.down(pointer(100, 0), h);
    t.move!(pointer(120, 16, { shiftKey: true }), h); // (60, 8): about 8°, so level
    const n = h.measure.line!;
    expect([n.x1, n.y1]).toEqual([0, 0]);
    expect(n.x2).toBeCloseTo(Math.hypot(60, 8), 9);
    expect(n.y2).toBeCloseTo(0, 9);
  });

  it("shows where it can be grabbed", () => {
    const { h, told } = fake({ tool: "measure" });
    h.measure = { ...h.measure, line: { x1: 0, y1: 0, x2: 50, y2: 0 } };
    const t = measureTool();
    t.hover!({ x: 49, y: 1 }, pointer(98, 2), h);
    t.hover!({ x: 25, y: 20 }, pointer(50, 40), h);
    t.down(pointer(98, 2), h);
    t.hover!({ x: 52, y: 1 }, pointer(104, 2), h);
    expect(told.filter((c) => c[0] === "cursor").map((c) => c[1])).toEqual(["grab", "crosshair", "grabbing"]);
  });

  it("is drawn, with its label, only while the tool is selected", () => {
    const { h } = fake({ tool: "measure" });
    const t = measureTool();
    expect(t.wantsOverlay!(true, h)).toBe(false);
    h.measure = { ...h.measure, line: { x1: 0, y1: 0, x2: 50, y2: 0 } };
    expect(t.wantsOverlay!(true, h)).toBe(true);
    expect(t.wantsOverlay!(false, h)).toBe(false);
    const { o, ops } = painter();
    t.drawOverlay!(o, h);
    expect(ops).toContain("fillText");
    const other = painter();
    t.drawOverlay!({ ...other.o, selected: false }, h);
    expect(other.ops).toEqual([]);
  });
});

describe("the paint bucket", () => {
  const region = { rects: [{ x: 10, y: 10, w: 20, h: 20 }] };

  it("previews the fill while held, and fills it on the lift — and keeps it live", () => {
    const { h, calls } = fake({ tool: "bucket" }, false, { wand: region });
    const t = bucketTool();
    t.down(pointer(40, 60), h);
    expect(t.busy()).toBe(true);
    expect(calls).toEqual([
      ["endFill"], // a previous live fill is baked first
      ["magicWand", "L1", 20, 30, { tolerance: 32, contiguous: true, sampleAll: false }, false, null],
    ]);
    expect(t.wantsOverlay!(false, h), "the preview shows over any tool").toBe(true);
    t.up!(pointer(44, 60), h);
    expect(t.busy()).toBe(false);
    expect(calls.slice(2)).toEqual([
      ["magicWand", "L1", 22, 30, { tolerance: 32, contiguous: true, sampleAll: false }, true, null],
      ["magicWand", "L1", 22, 30, { tolerance: 32, contiguous: true, sampleAll: false }, true, null],
      ["liveFill", "L1", region.rects, "#ff8000ff", true],
    ]);
  });

  it("fills with the secondary colour from the right button, at the bucket's opacity", () => {
    const { h, calls } = fake({ tool: "bucket" }, false, { wand: region });
    h.settings = { ...h.settings, bucket: { ...h.settings.bucket, opacity: 50 } };
    const t = bucketTool();
    t.down(pointer(40, 60, { button: 2 }), h);
    t.up!(pointer(40, 60, { button: 2 }), h);
    expect(calls.at(-1)).toEqual(["liveFill", "L1", region.rects, "#0000ff80", true]);
  });

  it("a pinch drops the press: nothing is filled, then or on the lift", () => {
    const { h, calls, redraws } = fake({ tool: "bucket" }, false, { wand: region });
    const t = bucketTool();
    t.down(pointer(40, 60), h);
    t.cancel!(h);
    expect([t.busy(), t.wantsOverlay!(true, h)]).toEqual([false, false]);
    t.up!(pointer(40, 60), h);
    expect(names(calls)).not.toContain("liveFill");
    const drawn = redraws();
    t.cancel!(h);
    expect(redraws(), "nothing in flight: nothing to redraw").toBe(drawn);
  });

  it("an empty region fills nothing, and leaves nothing live", () => {
    const { h, calls } = fake({ tool: "bucket" }, false, { wand: { rects: [] } });
    const t = bucketTool();
    t.down(pointer(40, 60), h);
    t.up!(pointer(40, 60), h);
    expect(names(calls)).not.toContain("liveFill");
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });

  it("with no source to flood, fills the whole canvas; Shift fills every match", () => {
    const { h, calls } = fake({ tool: "bucket" });
    const t = bucketTool();
    t.down(pointer(40, 60, { shiftKey: true }), h);
    t.up!(pointer(40, 60, { shiftKey: true }), h);
    expect(calls[1][4]).toEqual({ tolerance: 32, contiguous: false, sampleAll: false });
    expect(calls.at(-1)![2]).toEqual([{ x: 0, y: 0, w: 1000, h: 800 }]);
  });

  it("follows the pointer, recomputing at most every 40ms — the last move is never lost", () => {
    const { h, calls } = fake({ tool: "bucket" }, false, { wand: region });
    const t = bucketTool();
    t.down(pointer(40, 60), h);
    const floods = () => calls.filter((c) => c[0] === "magicWand").length;
    now += 10;
    t.move!(pointer(50, 60), h);
    expect(floods(), "too soon: put off").toBe(1);
    now += 10;
    t.move!(pointer(60, 60), h);
    expect(floods()).toBe(1);
    now += 30;
    vi.advanceTimersByTime(30);
    expect(floods(), "the trailing recompute ran").toBe(2);
    expect(calls.at(-1)!.slice(2, 4), "...from where the pointer last was").toEqual([30, 30]);
    now += 50;
    t.move!(pointer(80, 60), h);
    expect(floods(), "long enough since: at once").toBe(3);
  });

  it("re-runs a live fill when its options change, once a frame, in the colour it was made", () => {
    const { h, calls } = fake({ tool: "bucket" }, false, { wand: region });
    const t = bucketTool();
    t.refill(h);
    expect(frames.length, "nothing live: nothing to re-run").toBe(0);
    t.down(pointer(40, 60), h);
    t.up!(pointer(40, 60), h);
    h.foreground = "#00ff00"; // a new colour does not repaint the fill
    h.settings = { ...h.settings, bucket: { ...h.settings.bucket, tolerance: 80 } };
    t.refill(h);
    t.refill(h);
    expect(frames.length, "coalesced").toBe(1);
    flushFrames();
    expect(calls.at(-2)![4]).toEqual({ tolerance: 80, contiguous: true, sampleAll: false });
    expect(calls.at(-1)).toEqual(["liveFill", "L1", region.rects, "#ff8000ff", true]);
  });

  it("bakes the live fill on Esc or another tool; the engine ending it drops the marker", () => {
    for (const end of ["esc", "deselect", "engine"] as const) {
      const { h, calls } = fake({ tool: "bucket" }, false, { wand: region });
      const t = bucketTool();
      t.down(pointer(40, 60), h);
      t.up!(pointer(40, 60), h);
      expect(t.wantsOverlay!(true, h)).toBe(true);
      const before = calls.length;
      if (end === "esc") t.keyDown!(esc().e, h);
      else if (end === "deselect") t.deselect!(h);
      else t.fillEnded(h);
      expect(t.wantsOverlay!(true, h)).toBe(false);
      expect(calls.slice(before)).toEqual(end === "engine" ? [] : [["endFill"]]);
    }
  });

  it("Esc and another tool leave the bucket alone when nothing is live", () => {
    const { h, calls } = fake({ tool: "bucket" });
    const t = bucketTool();
    const k = esc();
    t.keyDown!(k.e, h);
    t.deselect!(h);
    expect([calls, k.stopped()]).toEqual([[], 0]);
  });

  it("leaves a locked layer alone, and merges a floating selection first", () => {
    const locked = fake({ tool: "bucket", paintBlocked: () => true });
    const t = bucketTool();
    t.down(pointer(0, 0), locked.h);
    expect([locked.calls, t.busy()]).toEqual([[], false]);
    const floating = fake({ tool: "bucket" }, true);
    bucketTool().down(pointer(0, 0), floating.h);
    expect(names(floating.calls).slice(0, 2)).toEqual(["commitFloat", "endFill"]);
  });

  it("fills a new layer when none is selected", () => {
    const { h, calls } = fake({ tool: "bucket", activeLayerId: null, ensureLayer: () => "NEW" }, false, {
      wand: region,
    });
    const t = bucketTool();
    t.down(pointer(0, 0), h);
    t.up!(pointer(0, 0), h);
    expect(calls.at(-1)!.slice(0, 2)).toEqual(["liveFill", "NEW"]);
  });
});

describe("the gradient", () => {
  const sel = { rects: [{ x: 0, y: 0, w: 100, h: 100 }], angle: 0.25, pivot: { x: 50, y: 50 } };

  it("is dragged out live, clipped to the selection it began in, and stays live", () => {
    const { h, calls } = fake({ tool: "gradient", selection: sel });
    const t = gradientTool();
    t.down(pointer(40, 60), h);
    expect(t.busy()).toBe(true);
    expect(names(calls)).toEqual(["endGradient", "liveGradient"]); // the previous one is committed
    const [, layer, type, start, end, mid, , rects, angle, pivot, smooth] = calls[1];
    expect([layer, type, start, end, mid, rects, angle, pivot, smooth]).toEqual([
      "L1",
      "linear",
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      0.5,
      sel.rects,
      0.25,
      sel.pivot,
      false,
    ]);
    t.move!(pointer(200, 60), h);
    expect(calls.at(-1)![4]).toEqual({ x: 100, y: 30 });
    t.up!(pointer(200, 60), h);
    expect(t.busy()).toBe(false);
    expect(t.wantsOverlay!(false, h), "its handles show over any tool").toBe(true);
  });

  it("is moved by its handles: either end, and the midpoint (the nearest one)", () => {
    const { h, calls } = fake({ tool: "gradient" });
    const t = gradientTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(200, 0), h); // (0,0) → (100,0); the midpoint at 50
    t.up!(pointer(200, 0), h);
    const n = calls.length;
    t.down(pointer(4, 2), h); // the start
    expect(calls.length, "grabbing a handle commits nothing").toBe(n);
    t.move!(pointer(0, 40), h);
    expect(calls.at(-1)![3]).toEqual({ x: 0, y: 20 });
    t.up!(pointer(0, 40), h);
    t.down(pointer(100, 20), h); // the midpoint, now (50, 10)
    t.move!(pointer(160, 20), h);
    // (80, 10) projected onto (0, 20)→(100, 0).
    expect(calls.at(-1)![5]).toBeCloseTo((80 * 100 + -10 * -20) / (100 * 100 + 20 * 20), 9);
  });

  it("of two handles in reach, the nearer is taken — not the last tried", () => {
    const { h, calls } = fake({ tool: "gradient" });
    const t = gradientTool();
    t.down(pointer(0, 0), h);
    t.move!(pointer(16, 0), h); // (0,0) → (8,0): the midpoint at 4, all within a grab of each other
    t.up!(pointer(16, 0), h);
    t.down(pointer(15, 0), h); // (7.5, 0): the end, though the midpoint is in reach too
    t.move!(pointer(15, 30), h);
    expect(calls.at(-1)![4], "the end moved").toEqual({ x: 7.5, y: 15 });
    expect(calls.at(-1)![5], "...not the midpoint").toBe(0.5);
  });

  it("the midpoint snaps to the centre when close — unless that is turned off — and stays off the ends", () => {
    for (const snap of [true, false]) {
      const { h, calls } = fake({ tool: "gradient" });
      h.settings = { ...h.settings, gradient: { ...h.settings.gradient, snap } };
      const t = gradientTool();
      t.down(pointer(0, 0), h);
      t.move!(pointer(200, 0), h);
      t.up!(pointer(200, 0), h);
      t.down(pointer(100, 0), h);
      t.move!(pointer(106, 0), h); // 0.53
      expect(calls.at(-1)![5]).toBeCloseTo(snap ? 0.5 : 0.53, 9);
      t.move!(pointer(400, 0), h);
      expect(calls.at(-1)![5]).toBe(0.95);
    }
  });

  it("re-draws when its settings change, once a frame, only while live", () => {
    const { h, calls } = fake({ tool: "gradient" });
    const t = gradientTool();
    expect(t.rerender(h)).toBeUndefined();
    t.down(pointer(0, 0), h);
    t.up!(pointer(0, 0), h);
    const n = calls.length;
    const stop = t.rerender(h);
    expect(typeof stop).toBe("function");
    stop!();
    flushFrames();
    expect(calls.length, "called off: not drawn").toBe(n);
    t.rerender(h);
    flushFrames();
    expect(names(calls.slice(n))).toEqual(["liveGradient"]);
  });

  it("is committed by another tool, and by Esc while live; the engine ending it drops the handles", () => {
    const { h, calls } = fake({ tool: "gradient" });
    const t = gradientTool();
    t.deselect!(h);
    expect(names(calls), "another tool always commits").toEqual(["endGradient"]);
    const k = esc();
    t.keyDown!(k.e, h);
    expect(k.stopped(), "nothing live: Esc is not the gradient's").toBe(0);
    t.down(pointer(0, 0), h);
    t.up!(pointer(0, 0), h);
    t.keyDown!(k.e, h);
    expect(k.stopped()).toBe(1);
    expect(calls.at(-1)).toEqual(["endGradient"]);
    t.ended(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });

  it("a pinch drops the handles", () => {
    const { h } = fake({ tool: "gradient" });
    const t = gradientTool();
    t.down(pointer(0, 0), h);
    t.cancel!(h);
    expect([t.busy(), t.wantsOverlay!(true, h)]).toEqual([false, false]);
  });

  it("shows where it can be grabbed", () => {
    const { h, told } = fake({ tool: "gradient" });
    const t = gradientTool();
    t.hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    t.down(pointer(0, 0), h);
    t.hover!({ x: 50, y: 0 }, pointer(100, 0), h);
    t.move!(pointer(200, 0), h);
    t.up!(pointer(200, 0), h);
    expect(told.filter((c) => c[0] === "cursor").map((c) => c[1])).toEqual([null, "grabbing", "grab"]);
  });

  it("leaves a locked layer alone", () => {
    const { h, calls } = fake({ tool: "gradient", paintBlocked: () => true });
    const t = gradientTool();
    t.down(pointer(0, 0), h);
    expect([calls, t.busy()]).toEqual([[], false]);
  });
});

describe("the frame", () => {
  it("is dragged out, any way round, and made on the lift — in the chosen shape", () => {
    const { h, told } = fake({ tool: "frame" });
    h.frame = { ...h.frame, shape: "ellipse" };
    const t = frameTool();
    t.down(pointer(200, 200), h);
    expect(t.busy()).toBe(true);
    t.move!(pointer(100, 120), h);
    expect(t.readout!()).toEqual({ kind: "size", w: 50, h: 40 });
    t.up!(pointer(100, 120), h);
    expect(told).toEqual([["frame", { x: 50, y: 60, w: 50, h: 40 }, "ellipse"]]);
    expect([t.busy(), t.readout!()]).toEqual([false, null]);
  });

  it("a click (or a sliver) is not a frame", () => {
    const { h, told } = fake({ tool: "frame" });
    const t = frameTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(300, 206), h);
    t.up!(pointer(300, 206), h);
    expect(told).toEqual([]);
  });

  it("a pinch drops it", () => {
    const { h, told } = fake({ tool: "frame" });
    const t = frameTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(300, 300), h);
    t.cancel!(h);
    t.up!(pointer(300, 300), h);
    expect([told, t.wantsOverlay!(true, h)]).toEqual([[], false]);
  });
});

describe("the text tool", () => {
  it("a click opens point text where it landed", () => {
    const { h, told } = fake({ tool: "text" });
    const t = textTool();
    t.down(pointer(40, 60), h);
    expect(t.busy()).toBe(true);
    t.up!(pointer(42, 62), h);
    expect(told[0]).toEqual(["openText", { x: 20, y: 30, boxW: null, value: "", seed: expect.any(Number) }]);
    expect(t.busy()).toBe(false);
  });

  it("a pinch drops the press: no editor opens, then or on the lift", () => {
    const { h, told, redraws } = fake({ tool: "text" });
    const t = textTool();
    t.down(pointer(40, 60), h);
    t.move!(pointer(140, 160), h);
    t.cancel!(h);
    expect([t.busy(), t.wantsOverlay!(true, h)]).toEqual([false, false]);
    t.up!(pointer(140, 160), h);
    expect(names(told)).not.toContain("openText");
    const drawn = redraws();
    t.cancel!(h);
    expect(redraws(), "nothing in flight: nothing to redraw").toBe(drawn);
  });

  it("a drag lays out a paragraph box — but only a real one", () => {
    const { h, told } = fake({ tool: "text" });
    const t = textTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(100, 180), h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
    t.up!(pointer(100, 180), h);
    expect(told[0]![1]).toMatchObject({ x: 50, y: 90, boxW: 50 });
    told.length = 0;
    t.down(pointer(200, 200), h);
    t.move!(pointer(300, 210), h); // 5 doc px tall: not a box
    t.up!(pointer(300, 210), h);
    expect(told[0]![1]).toMatchObject({ x: 100, y: 100, boxW: null });
  });

  it("a narrow box is widened to one a word fits in", () => {
    const { h, told } = fake({ tool: "text" });
    const t = textTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(214, 300), h);
    t.up!(pointer(214, 300), h);
    expect(told[0]![1]).toMatchObject({ boxW: 24 });
  });

  it("a click on a text layer opens it again; one being edited is committed first", () => {
    const vector = { type: "text" } as VectorText;
    const { h, told } = fake({ tool: "text" });
    h.text = { ...h.text, editing: true, layerAt: () => ({ id: "T1", vector }) };
    const t = textTool();
    t.down(pointer(40, 60), h);
    expect(told).toEqual([["commitText"], ["reedit", "T1"]]);
    expect(t.busy()).toBe(false);
  });

  it("draws the box being dragged only while the tool is selected", () => {
    const { h } = fake({ tool: "text" });
    const t = textTool();
    t.down(pointer(200, 200), h);
    t.move!(pointer(100, 100), h);
    const { o, ops } = painter();
    t.drawOverlay!(o, h);
    expect(ops).toContain("strokeRect");
    const other = painter();
    t.drawOverlay!({ ...other.o, selected: false }, h);
    expect(other.ops).toEqual([]);
    expect(t.wantsOverlay!(false, h)).toBe(false);
  });
});
