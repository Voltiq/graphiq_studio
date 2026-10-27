import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, type Layer } from "../app/lib/doc-state";
import { EngineStroke, brushDynamics, type StrokeHost } from "../app/lib/engine/stroke";
import type { BrushSettings } from "../app/lib/paint";
import { pressureScale } from "../app/lib/pointer";
import type { SelectionMask } from "../app/lib/selection-mask";
import type { Rect } from "../app/lib/view";
import { canvas, fc, installFakeCanvas, type FakeCanvas } from "./fake-canvas";

/**
 * The engine's stroke (TODO 1.6, app/lib/engine/stroke.ts): a brush or eraser
 * stroke from its first dab to its last, its tips and dabs, the stroke drawn
 * through the selection, and the clone stamp — on documents of its own, with
 * canvases that are plain RGBA arrays (tests/fake-canvas.ts), the tips checked
 * by value and the dabs by where and how they were drawn.
 */

const brush = (b: Partial<BrushSettings> = {}): BrushSettings => ({
  size: 6,
  hardness: 100,
  opacity: 100,
  flow: 100,
  blend: "Normal",
  smoothing: 0,
  pressureSize: false,
  pressureFlow: false,
  ...b,
});

function engine(w = 40, h = 30) {
  const cursor = new DocCursor();
  cursor.doc.w = w;
  cursor.doc.h = h;
  const buf = canvas(w, h);
  let made = false;
  const calls: unknown[][] = [];
  const entries: unknown[] = [];
  const surfaces: Record<string, "pixels" | "mask"> = {};
  const soft = new Set<Rect[]>();
  let view: Layer | null = null;
  const selMask = canvas(w, h);
  const host: StrokeHost = {
    ensureOpBuffers: () => (made = cursor.doc.w > 0 && cursor.doc.h > 0), // as the engine: none without a size
    strokeBuf: () => (made ? buf : null),
    view: () => view?.c ?? null,
    mk: (cw, ch) => canvas(cw, ch),
    layer: (id) => {
      let l = cursor.doc.layers.get(id);
      if (!l) cursor.doc.layers.set(id, (l = canvas(cursor.doc.w, cursor.doc.h)));
      return l;
    },
    activeSurface: (id) => surfaces[id] ?? "pixels",
    maskKeyOf: (id) => `m:${id}`,
    deriveMaskAlpha: (id, rect) => calls.push(["derive", id, rect]),
    clipTo: (_ctx, rects, angle, pivot) => calls.push(["clipTo", rects, angle, pivot]),
    coverageOf: (rects) => (rects && soft.has(rects) ? ({} as SelectionMask) : null),
    selectionMask: (rects, angle, pivot) => (calls.push(["selectionMask", rects, angle, pivot]), selMask.c),
    pushEntry: (layerId, rect, _before, _after, label, side, surface) =>
      entries.push({ layerId, rect, label, side, surface }),
    dropLiveProduct: () => calls.push(["dropLive"]),
    emitChange: () => calls.push(["change"]),
  };
  const s = new EngineStroke(cursor, host);
  /** The dabs drawn into the stroke buffer, as [x, y, tip width]. */
  const dabs = () => fc(buf).draws.map((d) => [d.args[0], d.args[1], (d.src as FakeCanvas).width]);
  const layer = (id: string) => fc(cursor.doc.layers.get(id));
  return {
    s,
    cursor,
    buf: fc(buf),
    calls,
    entries,
    surfaces,
    soft,
    dabs,
    layer,
    selMask: fc(selMask),
    setView: (v: Layer) => (view = v),
  };
}

let seed = 1;
beforeEach(() => {
  installFakeCanvas();
  seed = 1;
  vi.spyOn(Math, "random").mockImplementation(() => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a stroke", () => {
  it("bakes its tip once — hard: a crisp disc at its colour and flow — its first dab on the pixel grid", () => {
    const e = engine();
    e.s.beginStroke("a", brush({ size: 6, hardness: 100, flow: 50 }), "#ff0000", 10, 10);
    const tip = e.buf.draws[0].src as FakeCanvas;
    expect([tip.width, tip.at(3, 3), tip.at(0, 0)[3]]).toEqual([6, [255, 0, 0, 128], 0]);
    expect([e.dabs(), e.buf.draws[0].smoothing, e.s.dirtyRect()]).toEqual([
      [[7, 7, 6]],
      false,
      { x: 7, y: 7, w: 6, h: 6 },
    ]);
    expect([e.s.painting, e.s.strokeLayer, e.cursor.doc.layers.has("a")]).toEqual([true, "a", true]);
  });

  it("soft: a solid core, then a linear fade to the rim, placed off the grid", () => {
    const e = engine();
    e.s.beginStroke("a", brush({ size: 10, hardness: 50 }), "#00ff00", 10.5, 10.5);
    const tip = e.buf.draws[0].src as FakeCanvas;
    const a = (x: number) => tip.at(x, 6)[3];
    expect(tip.width, "a pixel of rim each side").toBe(12);
    expect([a(6), a(8), a(10), a(11)], "core, fading, nothing past the rim").toEqual([255, 250, 48, 0]);
    expect([e.buf.draws[0].args, e.buf.draws[0].smoothing]).toEqual([[4.5, 4.5], true]);
    expect(e.s.dirtyRect()).toEqual({ x: 4, y: 4, w: 13, h: 13 });
  });

  it("dabs every tenth of the tip along the way, carrying what is left to the next segment", () => {
    const e = engine(60, 30);
    e.s.beginStroke("a", brush({ size: 40 }), "#000", 0, 10); // a dab every 4 px
    e.s.moveStroke(20, 10);
    expect(e.dabs().map((d) => d[0] + 20)).toEqual([0, 4, 8, 12, 16, 20]);
    e.s.moveStroke(22, 10);
    expect(e.dabs()).toHaveLength(6);
    e.s.moveStroke(25, 10);
    expect(e.dabs().map((d) => d[0] + 20)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    expect(e.s.dirtyRect(), "every dab in the box, held to the canvas").toEqual({ x: 0, y: 0, w: 44, h: 30 });
  });

  it("smoothing lags the pointer; the end catches up with where it was", () => {
    const e = engine(60, 30);
    e.s.beginStroke("a", brush({ size: 40, smoothing: 100 }), "#000", 0, 10);
    e.s.moveStroke(20, 10); // 15% of the way: 3 px, short of the next dab
    expect(e.dabs()).toHaveLength(1);
    e.s.endStroke();
    expect(e.buf.draws.length).toBeGreaterThan(1);
  });

  it("pressure narrows the tip and the spacing with it, and thins the paint, only when the brush asks", () => {
    const e = engine(80, 30);
    const pressed = (b: Partial<BrushSettings>, p: number) =>
      ["a", brush(b), "#000", 30, 10, "paint", null, 0, null, "Brush", p] as const;
    e.s.beginStroke(...pressed({ size: 40, pressureSize: true, pressureMin: 20 }, 0.5));
    expect(e.dabs()[0][2], "60% of 40, to the next pixel").toBe(Math.ceil(2 * 20 * pressureScale(0.5, 0.2)));
    e.s.cancelStroke();
    const flow = engine(80, 30);
    flow.s.beginStroke(...pressed({ size: 40, pressureFlow: true, pressureMin: 0 }, 0.5));
    const tip = flow.buf.draws[0].src as FakeCanvas;
    expect([tip.width, tip.at(20, 20)[3]], "full width, half the paint").toEqual([40, 128]);
    const off = engine(80, 30);
    off.s.beginStroke(...pressed({ size: 40 }, 0.25));
    expect(off.dabs()[0][2], "no dynamics: the full tip").toBe(40);
    const unset = { ...brush(), pressureSize: undefined, pressureFlow: undefined, pressureMin: undefined };
    expect(brushDynamics(unset), "unset: size on, flow off, a 20% floor").toEqual({
      size: true,
      flow: false,
      min: 20,
    });
  });
});

describe("its end", () => {
  it("commits one step through the host — drawn onto the layer at its opacity — and resets", () => {
    const e = engine();
    e.s.beginStroke("a", brush({ opacity: 50 }), "#ff000080", 10, 10);
    e.s.endStroke();
    const draw = e.layer("a").draws.at(-1)!;
    expect([draw.src, draw.alpha, draw.composite]).toEqual([e.buf, 0.5 * (128 / 255), "source-over"]);
    expect(e.entries).toEqual([
      { layerId: "a", rect: { x: 7, y: 7, w: 6, h: 6 }, label: "Brush", side: undefined, surface: "layer" },
    ]);
    expect([e.s.painting, e.s.strokeLayer, e.s.dirtyRect(), e.calls.some((c) => c[0] === "dropLive")]).toEqual([
      false,
      null,
      null,
      true,
    ]);
    expect(e.buf.calls.at(-1), "the buffer cleared for the next").toEqual(["clearRect", 0, 0, 40, 30]);
    expect(e.buf.at(10, 10)[3], "nothing left in it").toBe(0);
  });

  it("an erase removes alpha at the brush's opacity alone; on a mask, a mask step, its alpha re-derived", () => {
    const e = engine();
    e.s.beginStroke("a", brush({ opacity: 50 }), "#ff000080", 10, 10, "erase");
    e.s.endStroke();
    const draw = e.layer("a").draws.at(-1)!;
    expect([draw.alpha, draw.composite, (e.entries[0] as { label: string }).label]).toEqual([
      0.5,
      "destination-out",
      "Erase",
    ]);
    const m = engine();
    m.surfaces.a = "mask";
    m.cursor.doc.masks.set("m:a", canvas(40, 30));
    m.s.beginStroke("a", brush(), "#000", 10, 10);
    expect(m.s.strokeOnMask).toBe(true);
    m.s.endStroke();
    expect(m.entries).toEqual([
      { layerId: "m:a", rect: { x: 7, y: 7, w: 6, h: 6 }, label: "Mask Brush", side: undefined, surface: "mask" },
    ]);
    expect(m.calls).toContainEqual(["derive", "m:a", { x: 7, y: 7, w: 6, h: 6 }]);
    expect(fc(m.cursor.doc.masks.get("m:a")).draws, "drawn onto the mask").toHaveLength(1);
  });

  it("off the canvas, nothing to commit; abandoned, nothing committed — either way, reset", () => {
    const e = engine();
    e.s.beginStroke("a", brush(), "#000", -50, -50);
    e.s.endStroke();
    expect(e.entries).toEqual([]);
    e.s.beginStroke("a", brush(), "#000", 39, 10);
    expect(e.s.dirtyRect(), "held to the canvas's edge").toEqual({ x: 36, y: 7, w: 4, h: 6 });
    e.s.cancelStroke();
    e.s.beginStroke("a", brush(), "#000", 10, 10);
    e.s.cancelStroke();
    e.s.cancelStroke(); // nothing live: nothing to do
    expect([e.entries, e.s.painting, e.s.dirtyRect()]).toEqual([[], false, null]);
    expect(e.calls.filter((c) => c[0] === "dropLive"), "every end and abandon lets go of it").toHaveLength(3);
    e.s.endStroke();
    e.s.moveStroke(5, 5);
    expect(e.entries, "nothing live: end and move do nothing").toEqual([]);
  });

  it("no buffer, no stroke", () => {
    const e = engine(0, 0);
    e.s.beginStroke("a", brush(), "#000", 1, 1);
    expect([e.s.painting, e.buf.draws]).toEqual([false, []]);
  });
});

describe("drawn through the selection", () => {
  it("a hard selection clips, turned about its pivot; a soft one masks the stroke instead", () => {
    const e = engine();
    const rects = [{ x: 0, y: 0, w: 20, h: 20 }];
    e.s.beginStroke("a", brush(), "#000", 10, 10, "paint", rects, 0.3, { x: 5, y: 5 });
    e.s.endStroke();
    expect(e.calls).toContainEqual(["clipTo", rects, 0.3, { x: 5, y: 5 }]);
    const s = engine();
    const softRects = [{ x: 0, y: 0, w: 20, h: 20 }];
    s.soft.add(softRects);
    s.s.beginStroke("a", brush(), "#000", 10, 10, "paint", softRects, 0.3, null);
    s.s.endStroke();
    expect(s.calls.some((c) => c[0] === "clipTo"), "no clip path").toBe(false);
    expect(s.calls).toContainEqual(["selectionMask", softRects, 0.3, null]);
    const final = s.layer("a").draws.at(-1)!;
    const masked = final.src as FakeCanvas;
    expect(masked.draws.map((d) => [d.src, d.composite])).toEqual([
      [s.buf, "copy"],
      [s.selMask, "destination-in"],
    ]);
    const none = engine();
    none.s.beginStroke("a", brush(), "#000", 10, 10, "paint", [], 0, null);
    none.s.endStroke();
    expect(none.calls).toContainEqual(["clipTo", null, 0, null]);
  });

  it("the brush's blend mode; a transparency-locked layer keeps its alpha — the erase still erases", () => {
    const e = engine();
    e.s.beginStroke("a", brush({ blend: "Multiply" }), "#000", 10, 10);
    e.s.endStroke();
    expect(e.layer("a").draws.at(-1)!.composite).toBe("multiply");
    const l = engine();
    l.cursor.doc.layerLocks.set("a", { transparency: true, pixels: false });
    l.s.beginStroke("a", brush(), "#000", 10, 10);
    l.s.endStroke();
    l.s.beginStroke("a", brush(), "#000", 10, 10, "erase");
    l.s.endStroke();
    expect(l.layer("a").draws.slice(-2).map((d) => d.composite)).toEqual(["source-atop", "destination-out"]);
    const m = engine();
    m.cursor.doc.layerLocks.set("a", { transparency: true, pixels: false });
    m.surfaces.a = "mask";
    m.cursor.doc.masks.set("m:a", canvas(40, 30));
    m.s.beginStroke("a", brush(), "#000", 10, 10);
    m.s.endStroke();
    expect(fc(m.cursor.doc.masks.get("m:a")).draws.at(-1)!.composite, "a mask has no transparency to lock").toBe(
      "source-over",
    );
  });
});

describe("the tip's shape, bristles, scatter and texture", () => {
  it("squashed by its roundness; eroded by a dual tip; scattered into several dabs a step", () => {
    const e = engine(80, 60);
    e.s.beginStroke("a", brush({ size: 20, tipShape: { angle: 0, roundness: 30 } }), "#000", 40, 30);
    const flat = e.buf.draws[0].src as FakeCanvas;
    expect([flat.at(19, 10)[3], flat.at(10, 1)[3]], "wide, not tall").toEqual([255, 0]);
    const d = engine(80, 60);
    const dualTip = { enabled: true, size: 40, hardness: 80, scatter: 50, count: 3 };
    d.s.beginStroke("a", brush({ size: 20, dualTip }), "#000", 40, 30);
    const bristles = d.buf.draws[0].src as FakeCanvas;
    let holes = 0;
    for (let y = 2; y < 18; y++)
      for (let x = 2; x < 18; x++) if ((x - 10) ** 2 + (y - 10) ** 2 < 49 && !bristles.at(x, y)[3]) holes++;
    expect(holes, "gaps inside the disc").toBeGreaterThan(5);
    const s = engine(200, 60);
    const scatter = { enabled: true, amount: 80, count: 3, bothAxes: true };
    s.s.beginStroke("a", brush({ size: 20, scatter }), "#000", 20, 30);
    s.s.moveStroke(40, 30);
    expect(s.dabs().length, "three a step: 1 + 10 steps × 3").toBe(31);
    expect(new Set(s.dabs().map((p) => p[1])).size, "flung across the stroke").toBeGreaterThan(3);
    // Scatter is a share of the tip's diameter: a light stroke, a narrower tip, a narrower spread.
    const spread = (p: number) => {
      seed = 1;
      const t = engine(200, 200);
      const b = brush({ size: 40, scatter, pressureSize: true, pressureMin: 0 });
      t.s.beginStroke("a", b, "#000", 20, 100, "paint", null, 0, null, "Brush", p);
      t.s.moveStroke(100, 100, p);
      const ys = t.dabs().map((d) => d[1] + d[2] / 2);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(0.25), "a quarter of the pressure").toBeLessThan(spread(1) / 2);
  });

  it("a textured dab is the tip through the texture, laid where the document's texture is", () => {
    const e = engine(80, 60);
    e.s.beginStroke(
      "a",
      brush({ size: 20, texture: { enabled: true, pattern: "canvas", scale: 100, depth: 100, invert: false } }),
      "#000",
      40,
      30,
    );
    const draw = e.buf.draws[0];
    expect([draw.args, draw.smoothing]).toEqual([[0, 0, 20, 20, 30, 20, 20, 20], false]);
    const dab = draw.src as FakeCanvas;
    expect(dab.draws.map((x) => x.composite)).toEqual(["source-over", "destination-in"]);
  });
});

describe("the clone stamp", () => {
  it("paints the layer's pixels, sampled once from where the offset points, through the tip", () => {
    const e = engine();
    const layer = canvas(40, 30);
    e.cursor.doc.layers.set("a", layer);
    e.s.beginClone("a", brush({ size: 8 }), 10, 10, { x: 5, y: -2 }, false, 25);
    const draw = e.buf.draws[0];
    const dab = draw.src as FakeCanvas;
    expect([draw.args, dab.width]).toEqual([[6, 6], 8]);
    const [sample, tip] = dab.draws;
    expect([sample.args, sample.composite, tip.composite]).toEqual([[-11, -4], "source-over", "destination-in"]);
    expect((sample.src as FakeCanvas).draws[0].src, "the sample: a copy of the layer").toBe(fc(layer));
    e.s.moveStroke(14, 10); // spacing 25% of 8: a dab every 2 px
    expect(e.dabs()).toHaveLength(3);
    e.s.endStroke();
    expect((e.entries[0] as { label: string }).label).toBe("Clone Stamp");
    e.s.beginStroke("a", brush(), "#000", 10, 10);
    expect((e.buf.draws.at(-1)!.src as FakeCanvas).width, "the next stroke is a brush again").toBe(6);
  });

  it("samples every layer through the view when asked", () => {
    const e = engine();
    const view = canvas(40, 30);
    e.setView(view);
    e.s.beginClone("a", brush({ size: 8 }), 10, 10, { x: 0, y: 0 }, true, 25);
    const sample = (e.buf.draws[0].src as FakeCanvas).draws[0].src as FakeCanvas;
    expect(sample.draws[0].src).toBe(fc(view));
  });
});
