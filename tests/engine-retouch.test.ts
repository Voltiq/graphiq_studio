import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, type Layer } from "../app/lib/doc-state";
import { EngineRetouch, type RetouchHost } from "../app/lib/engine/retouch";
import { DEFAULT_MIXER } from "../app/lib/mixer";
import type { BrushSettings } from "../app/lib/paint";
import { DEFAULT_BLUR, DEFAULT_DODGE, DEFAULT_SMUDGE, DEFAULT_SPONGE } from "../app/lib/tools";
import type { Rect } from "../app/lib/view";
import { canvas, fc, FakeImageData, installFakeCanvas } from "./fake-canvas";

/**
 * The engine's retouch brushes (TODO 1.6, app/lib/engine/retouch.ts): the
 * History brush, blur, dodge and burn, sponge, smudge and the mixer — each a
 * session that keeps the layer as it began, builds its effect dab by dab and
 * lands as one step — on documents of its own, the pixels checked by value
 * (tests/fake-canvas.ts).
 */

type RGBA = [number, number, number, number];
const W = 30;
const H = 10;

/** A raster painted by `at(x, y)`. */
function painted(at: (x: number, y: number) => RGBA): Layer {
  const l = canvas(W, H);
  const img = new FakeImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.data.set(at(x, y), (y * W + x) * 4);
  l.ctx.putImageData(img as unknown as ImageData, 0, 0);
  return l;
}
const halves = (left: RGBA, right: RGBA) => painted((x) => (x < 15 ? left : right));

function engine(layer: Layer) {
  const cursor = new DocCursor();
  cursor.doc.w = W;
  cursor.doc.h = H;
  cursor.doc.layers.set("a", layer);
  const calls: unknown[][] = [];
  const entries: { layerId: string; rect: Rect; label: string; surface?: string }[] = [];
  const surfaces: Record<string, "pixels" | "mask"> = {};
  let view: Layer | null = null;
  let source = painted(() => [0, 0, 0, 255]);
  const host: RetouchHost = {
    layer: (id) => cursor.doc.layers.get(id)!,
    activeSurface: (id) => surfaces[id] ?? "pixels",
    maskKeyOf: (id) => `m:${id}`,
    deriveMaskAlpha: (id, rect) => calls.push(["derive", id, rect]),
    selectionMask: (rects) => {
      const m = canvas(W, H);
      m.ctx.fillStyle = "#fff";
      for (const r of rects) m.ctx.fillRect(r.x, r.y, r.w, r.h);
      return m.c;
    },
    reconstructLayerAt: (id, index) => (calls.push(["at", id, index]), source),
    snapshotLayer: (snap, id) => (calls.push(["snapshot", snap, id]), source),
    endAdjust: () => calls.push(["endAdjust"]),
    pushEntry: (layerId, rect, _b, _a, label, _side, surface) => entries.push({ layerId, rect, label, surface }),
    dropWandSource: () => calls.push(["dropWand"]),
    cs: () => "srgb",
    viewContext: () => view?.ctx ?? null,
    emitChange: () => {},
  };
  const r = new EngineRetouch(cursor, host);
  const px = (x: number, y = 5) => fc(layer).at(x, y);
  return {
    r,
    cursor,
    calls,
    entries,
    surfaces,
    px,
    setView: (v: Layer) => (view = v),
    setSource: (s: Layer) => (source = s),
  };
}

const BLACK: RGBA = [0, 0, 0, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const blur = { ...DEFAULT_BLUR, size: 6, hardness: 100, strength: 100, radius: 4, smoothing: 0 };
const sum = (p: number[]) => p[0] + p[1] + p[2];

beforeEach(installFakeCanvas);
afterEach(() => vi.unstubAllGlobals());

describe("blur", () => {
  it("softens an edge where it passes, as one step, and nothing beyond its reach", () => {
    const e = engine(halves(BLACK, WHITE));
    e.r.beginBlur("a", blur, 15, 5);
    e.r.endBlur();
    const [l, r] = [e.px(14)[0], e.px(15)[0]];
    expect([l > 0, l < 255, r > 0, r < 255], `grey at the edge: ${l}, ${r}`).toEqual([true, true, true, true]);
    expect([e.px(2), e.px(27)], "far from it: as it was").toEqual([BLACK, WHITE]);
    expect(e.entries).toEqual([{ layerId: "a", rect: { x: 12, y: 2, w: 6, h: 6 }, label: "Blur", surface: "layer" }]);
    expect([e.calls[0], e.calls.at(-1)], "an adjustment finished first; the wand told after").toEqual([
      ["endAdjust"],
      ["dropWand"],
    ]);
    expect(e.r.blurring).toBe(false);
  });

  it("keeps to the selection; its coverage holds at its strongest, so going over a spot again is no stronger", () => {
    const e = engine(halves(BLACK, WHITE));
    e.r.beginBlur("a", blur, 15, 5, [{ x: 15, y: 0, w: 15, h: 10 }]);
    e.r.endBlur();
    expect([e.px(14), e.px(15)[0] < 255], "the black side is outside it").toEqual([BLACK, true]);
    // Over a line once, and three times: a pixel beside it, part-covered, is
    // blurred as much either way (to the rounding of where each pass's dabs fall).
    const soft = { ...blur, hardness: 0 }; // coverage falls off toward the rim
    const edge = () => painted((_x, y) => (y < 7 ? BLACK : WHITE));
    const once = engine(edge());
    once.r.beginBlur("a", soft, 5, 5);
    once.r.moveBlur(25, 5);
    once.r.endBlur();
    const thrice = engine(edge());
    thrice.r.beginBlur("a", soft, 5, 5);
    for (const x of [25, 5, 25]) thrice.r.moveBlur(x, 5);
    thrice.r.endBlur();
    const [a1, a3] = [once.px(15, 7)[0], thrice.px(15, 7)[0]];
    expect([a1 < 255, Math.abs(a3 - a1) <= 3], `beside the line: ${a1} once, ${a3} thrice`).toEqual([true, true]);
  });

  it("is as strong as asked, and reaches where the pointer was when the stroke ends", () => {
    const strong = engine(halves(BLACK, WHITE));
    strong.r.beginBlur("a", blur, 15, 5);
    strong.r.endBlur();
    const weak = engine(halves(BLACK, WHITE));
    weak.r.beginBlur("a", { ...blur, strength: 30 }, 15, 5);
    weak.r.endBlur();
    expect(weak.px(14)[0], "a weaker blur greys the black less").toBeLessThan(strong.px(14)[0]);
    const lag = engine(painted((x) => (x < 22 ? BLACK : WHITE)));
    lag.r.beginBlur("a", { ...blur, smoothing: 100 }, 5, 5);
    lag.r.moveBlur(25, 5); // smoothed: the brush lags well behind
    expect(lag.px(22), "not there yet").toEqual(WHITE);
    lag.r.endBlur();
    expect(lag.px(22)[0], "the end catches up with the pointer").toBeLessThan(255);
  });

  it("samples every layer through the view when asked; cancelled, the layer is as it was and no step", () => {
    const e = engine(halves(BLACK, WHITE));
    e.setView(painted(() => [255, 0, 0, 255]));
    e.r.beginBlur("a", { ...blur, sampleAll: true }, 15, 5);
    e.r.endBlur();
    expect(e.px(15).slice(0, 3), "red, from what every layer shows").toEqual([255, 0, 0]);
    const c = engine(halves(BLACK, WHITE));
    c.r.beginBlur("a", blur, 15, 5);
    c.r.endBlur(false);
    expect([c.px(14), c.px(15), c.entries], "put back").toEqual([BLACK, WHITE, []]);
  });

  it("on a mask: the mask softened, a mask step, its alpha refreshed", () => {
    const layer = halves(WHITE, WHITE);
    const e = engine(layer);
    const mask = halves(BLACK, WHITE);
    e.cursor.doc.masks.set("m:a", mask);
    e.surfaces.a = "mask";
    e.r.beginBlur("a", blur, 15, 5);
    e.r.endBlur();
    expect(fc(mask).at(15, 5)[0]).toBeLessThan(255);
    expect([e.px(15), e.entries[0].layerId, e.entries[0].surface]).toEqual([WHITE, "m:a", "mask"]);
    expect(e.calls.some((c) => c[0] === "derive" && c[1] === "m:a")).toBe(true);
  });

  it("no session, nothing to move or end; no document size, no session", () => {
    const e = engine(halves(BLACK, WHITE));
    e.r.moveBlur(3, 3);
    e.r.endBlur();
    e.cursor.doc.w = 0;
    e.r.beginBlur("a", blur, 15, 5);
    expect([e.entries, e.r.blurring]).toEqual([[], false]);
  });
});

describe("dodge and burn, sponge", () => {
  const dodge = { ...DEFAULT_DODGE, size: 8, hardness: 100, exposure: 80, smoothing: 0 };

  it("dodge lightens and burn darkens, most in the range chosen", () => {
    const grey = (): Layer => halves([60, 60, 60, 255], [200, 200, 200, 255]);
    const d = engine(grey());
    d.r.beginDodge("a", { ...dodge, range: "shadows" }, 8, 5);
    d.r.moveDodge(22, 5);
    d.r.endDodge();
    // As a share of the room each had to lighten.
    const [dark, light] = [(d.px(8)[0] - 60) / 195, (d.px(22)[0] - 200) / 55];
    expect([dark > 0, dark > 2 * light], `the shadows lifted more: ${dark} vs ${light}`).toEqual([true, true]);
    expect(d.entries[0].label).toBe("Dodge");
    const b = engine(grey());
    b.r.beginDodge("a", { ...dodge, mode: "burn", range: "highlights" }, 8, 5);
    b.r.moveDodge(22, 5);
    b.r.endDodge();
    const [bd, bl] = [(60 - b.px(8)[0]) / 60, (200 - b.px(22)[0]) / 200];
    expect([bl > 0, bl > 2 * bd], `the highlights darkened more: ${bl} vs ${bd}`).toEqual([true, true]);
    expect(b.entries[0].label).toBe("Burn");
    const low = engine(grey());
    low.r.beginDodge("a", { ...dodge, exposure: 20 }, 15, 5);
    low.r.endDodge();
    const high = engine(grey());
    high.r.beginDodge("a", { ...dodge, exposure: 80 }, 15, 5);
    high.r.endDodge();
    expect(low.px(14)[0], "less exposure, less lift").toBeLessThan(high.px(14)[0]);
    const plain = engine(grey());
    plain.r.beginDodge("a", { ...dodge, protect: false }, 15, 5);
    plain.r.endDodge();
    const p = plain.px(14);
    expect([p[0] > 60, p[0] === p[1] && p[1] === p[2]], `lighter, and still grey: ${p}`).toEqual([true, true]);
  });

  it("the sponge saturates or desaturates", () => {
    const muted = (): Layer => painted(() => [160, 100, 100, 255]);
    const spread = (p: number[]) => p[0] - p[1];
    const s = engine(muted());
    s.r.beginSponge("a", { ...DEFAULT_SPONGE, size: 8, hardness: 100, flow: 100, smoothing: 0 }, 15, 5);
    s.r.endSponge();
    const d = engine(muted());
    const sponge = { ...DEFAULT_SPONGE, size: 8, hardness: 100, flow: 100, smoothing: 0 };
    d.r.beginSponge("a", { ...sponge, mode: "desaturate" }, 15, 5);
    d.r.endSponge();
    expect([spread(s.px(15)) > 60, spread(d.px(15)) < 60, spread(s.px(2))]).toEqual([true, true, 60]);
    // Its grey is 118: desaturating brings every channel toward it, saturating pushes each away.
    const [ds, ss] = [d.px(15), s.px(15)];
    expect([ds[0] < 160 && ds[0] >= 118, ds[1] > 100, ss[0] > 160, ss[1] < 100], `${ds} / ${ss}`).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([s.entries[0].label, d.entries[0].label]).toEqual(["Sponge", "Sponge"]);
  });
});

describe("smudge and the mixer", () => {
  const smudge = { ...DEFAULT_SMUDGE, size: 6, hardness: 100, strength: 90, smoothing: 0 };

  it("smudge drags colour along the stroke; finger painting starts with the foreground", () => {
    const e = engine(halves([255, 0, 0, 255], [0, 0, 255, 255]));
    e.r.beginSmudge("a", smudge, 10, 5);
    e.r.moveSmudge(24, 5);
    e.r.endSmudge();
    expect(e.px(18)[0], "red carried into the blue").toBeGreaterThan(40);
    expect(e.entries[0].label).toBe("Smudge");
    const f = engine(halves([255, 0, 0, 255], [0, 0, 255, 255]));
    f.r.beginSmudge("a", { ...smudge, fingerPaint: true }, 5, 5, { r: 0, g: 255, b: 0, a: 255 });
    f.r.moveSmudge(9, 5);
    f.r.endSmudge();
    expect(f.px(7)[1], "green from the finger").toBeGreaterThan(40);
    // Strength is how long the colour lasts on the finger (pickup = 1 − strength).
    const weak = engine(halves([255, 0, 0, 255], [0, 0, 255, 255]));
    weak.r.beginSmudge("a", { ...smudge, strength: 10 }, 10, 5);
    weak.r.moveSmudge(24, 5);
    weak.r.endSmudge();
    expect(e.px(22)[0], "a strong smudge carries the red further").toBeGreaterThan(weak.px(22)[0]);
  });

  it("the mixer lays down its load mixed with what is there, as one step", () => {
    const e = engine(painted(() => [0, 0, 255, 255]));
    const mixer = { ...DEFAULT_MIXER, size: 6, hardness: 100, smoothing: 0, wet: 50, load: 100, mix: 50, flow: 100 };
    e.r.beginMixer("a", mixer, 5, 5, { r: 255, g: 255, b: 0, a: 255 });
    e.r.moveSmudge(20, 5);
    e.r.endSmudge();
    const p = e.px(12);
    expect([p[0] > 10, p[1] > 10, p[2] > 100], `some yellow laid into the blue: ${p}`).toEqual([true, true, true]);
    expect(e.entries[0].label).toBe("Mixer Brush");
    // Half wet, the brush picks up half of the canvas each dab: pinned where the
    // stroke starts (recorded; a brush that picked up all of it reads 55 there).
    expect(e.px(6)).toEqual([42, 42, 213, 255]);
    e.r.cleanMixer();
    const dry = engine(painted(() => [0, 0, 255, 255]));
    dry.r.beginMixer("a", { ...mixer, wet: 0 }, 5, 5, { r: 255, g: 255, b: 0, a: 255 });
    dry.r.moveSmudge(20, 5);
    dry.r.endSmudge();
    expect(dry.px(12), "a dry brush lays its load differently from a wet one").not.toEqual(p);
  });
});

describe("the History brush", () => {
  const brush: BrushSettings = { size: 6, hardness: 100, opacity: 100, flow: 100, blend: "Normal", smoothing: 0 };

  it("paints back toward the layer at the source state, or at the snapshot that is the source", () => {
    const e = engine(painted(() => WHITE));
    e.cursor.doc.historySourceIndex = 2;
    e.r.beginHistory("a", brush, 15, 5);
    e.r.endHistory();
    expect([e.px(15), e.px(2)], "black from the source, white beyond").toEqual([BLACK, WHITE]);
    expect(e.calls).toContainEqual(["at", "a", 2]);
    expect(e.entries[0].label).toBe("History Brush");
    const s = engine(painted(() => WHITE));
    s.cursor.doc.historySourceSnap = "snap-1";
    s.r.beginHistory("a", { ...brush, opacity: 50 }, 15, 5, null, 0, null, "Erase to History");
    s.r.endHistory();
    expect(s.calls).toContainEqual(["snapshot", "snap-1", "a"]);
    const half = s.px(15)[0];
    expect([half > 60, half < 200, s.entries[0].label], `halfway at half opacity: ${half}`).toEqual([
      true,
      true,
      "Erase to History",
    ]);
  });

  it("can take alpha away — back to a blank original — and, cancelled, leaves the layer as it was", () => {
    const e = engine(painted(() => WHITE));
    e.setSource(painted(() => [0, 0, 0, 0]));
    e.r.beginHistory("a", brush, 15, 5);
    e.r.endHistory();
    expect(e.px(15)[3]).toBe(0);
    const c = engine(painted(() => WHITE));
    c.r.beginHistory("a", brush, 15, 5);
    c.r.endHistory(false);
    expect([c.px(15), c.entries]).toEqual([WHITE, []]);
    expect(sum(c.px(15))).toBe(765);
  });
});
