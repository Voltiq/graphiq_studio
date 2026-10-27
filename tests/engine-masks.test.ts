import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, DocumentState } from "../app/lib/doc-state";
import { EngineMasks, type MaskHost } from "../app/lib/engine/masks";
import type { Rect } from "../app/lib/view";
import { canvas, fc, installFakeCanvas, type FakeCanvas } from "./fake-canvas";

/**
 * The engine's masks (TODO 1.6, app/lib/engine/masks.ts): which surface a paint
 * op edits, the alpha a mask derives, what the compositor and the view are
 * given, a mask's lifecycle and the quick mask — on documents of its own, with
 * canvases that are plain RGBA arrays (tests/fake-canvas.ts).
 */

function engine(w = 4, h = 3) {
  const cursor = new DocCursor();
  cursor.doc.w = w;
  cursor.doc.h = h;
  const calls: unknown[][] = [];
  let changes = 0;
  let live: string | null = null;
  const host: MaskHost = {
    bumpMask: (id, rect) => calls.push(["bump", id, rect]),
    emitChange: () => changes++,
    layer: (id) => {
      let l = cursor.doc.layers.get(id);
      if (!l) cursor.doc.layers.set(id, (l = canvas(cursor.doc.w, cursor.doc.h)));
      return l;
    },
    selectionMask: (rects) => {
      const m = canvas(cursor.doc.w, cursor.doc.h);
      m.ctx.fillStyle = "#fff";
      for (const r of rects) m.ctx.fillRect(r.x, r.y, r.w, r.h);
      return m.c;
    },
    selectionFromCoverage: (at) => {
      const out: Rect[] = [];
      for (let i = 0; i < cursor.doc.w * cursor.doc.h; i++)
        if (at(i) >= 128) out.push({ x: i % cursor.doc.w, y: Math.floor(i / cursor.doc.w), w: 1, h: 1 });
      return out;
    },
    maskStrokeLayer: () => live,
    drawStroke: (ctx) => {
      calls.push(["drawStroke"]);
      ctx.fillStyle = "#fff";
      ctx.fillRect(1, 1, 1, 1);
    },
    dirtyRect: () => ({ x: 1, y: 1, w: 1, h: 1 }),
  };
  const m = new EngineMasks(cursor, host);
  const mask = (id: string) => fc(cursor.doc.masks.get(id));
  const alpha = (id: string) => fc(cursor.doc.maskAlpha.get(id));
  return {
    m,
    cursor,
    calls,
    mask,
    alpha,
    changes: () => changes,
    setLive: (id: string | null) => (live = id),
  };
}

beforeEach(installFakeCanvas);
afterEach(() => vi.unstubAllGlobals());

describe("which surface a paint op edits", () => {
  it("a mask surface only while its raster is there; either kind is a mask; Quick Mask takes every layer", () => {
    const e = engine();
    e.m.setActiveSurface("a", "mask");
    expect([e.m.getActiveSurface("a"), e.cursor.doc.surfaces.get("a")], "no mask yet: refused").toEqual([
      "pixels",
      undefined,
    ]);
    e.m.allocMask("a", "reveal");
    e.m.setActiveSurface("a", "mask");
    expect([e.m.getActiveSurface("a"), e.m.activeSurface("a"), e.m.maskKeyOf("a")]).toEqual(["mask", "mask", "a"]);
    e.m.allocMask("fm:b", "reveal");
    e.m.setActiveSurface("b", "filterMask");
    expect([e.m.getActiveSurface("b"), e.m.activeSurface("b"), e.m.maskKeyOf("b")]).toEqual([
      "filterMask",
      "mask",
      "fm:b",
    ]);
    e.m.setActiveSurface("c", "filterMask");
    expect([e.m.activeSurface("c"), e.m.maskKeyOf("c")]).toEqual(["pixels", "c"]);
    e.cursor.doc.masks.delete("a");
    e.cursor.doc.masks.delete("fm:b");
    expect([e.m.getActiveSurface("a"), e.m.getActiveSurface("b")], "a deleted mask falls back").toEqual([
      "pixels",
      "pixels",
    ]);
    e.m.enterQuickMask("qm:doc");
    expect([e.m.activeSurface("c"), e.m.maskKeyOf("c"), e.m.maskKeyOf("b")]).toEqual(["mask", "qm:doc", "qm:doc"]);
  });
});

describe("the alpha a mask derives", () => {
  it("is its gray times its alpha, colourless, at the document's size, re-derived only where it changed", () => {
    const e = engine();
    e.m.allocMask("a", "hide");
    e.mask("a").getContext();
    e.mask("a").px.set([200, 200, 200, 128], (1 * 4 + 2) * 4); // (2, 1): 200 at half alpha
    e.calls.length = 0;
    e.m.deriveMaskAlpha("a", { x: 2, y: 1, w: 1, h: 1 });
    expect(e.alpha("a").at(2, 1)).toEqual([0, 0, 0, Math.round((200 * 128) / 255)]);
    expect(e.calls).toEqual([["bump", "a", { x: 2, y: 1, w: 1, h: 1 }]]);
    e.mask("a").px.set([255, 255, 255, 255], 0);
    e.m.deriveMaskAlpha("a", { x: 2, y: 1, w: 1, h: 1 });
    expect(e.alpha("a").at(0, 0)[3], "outside the rect: as it was").toBe(0);
    e.m.deriveMaskAlpha("a");
    expect(e.alpha("a").at(0, 0)[3], "the whole mask").toBe(255);
    e.cursor.doc.w = 5;
    e.m.allocMask("a", "reveal");
    expect([e.alpha("a").width, e.alpha("a").at(4, 2)[3]], "a new cache at the new size").toEqual([5, 255]);
    e.m.deriveMaskAlpha("none");
    expect(e.cursor.doc.maskAlpha.has("none")).toBe(false);
  });

  it("the compositor gets the committed alpha — or, under a live mask stroke, a preview with it in", () => {
    const e = engine();
    e.m.allocMask("a", "selection", [{ x: 0, y: 0, w: 1, h: 1 }]);
    const committed = e.m.maskDisplay("a");
    expect(committed).toBe(e.cursor.doc.maskAlpha.get("a")!.c);
    e.setLive("b"); // a stroke on another layer's mask
    expect(e.m.maskDisplay("a")).toBe(committed);
    e.setLive("a");
    const live = fc(e.m.maskDisplay("a"));
    expect(live).not.toBe(fc(committed));
    const seen = [live.at(1, 1)[3], live.at(0, 0)[3], live.at(2, 2)[3], e.calls.at(-1)];
    expect(seen, "the stroke, over what was").toEqual([
      255,
      255,
      0,
      ["drawStroke"],
    ]);
    expect(fc(e.m.maskDisplay("a")), "the preview buffers are reused").toBe(live);
    expect(e.m.maskDisplay("none")).toBeNull();
  });
});

describe("a mask's lifecycle", () => {
  it("made white, black, or from the selection — over black — and told", () => {
    const e = engine();
    e.m.allocMask("w", "reveal");
    e.m.allocMask("k", "hide");
    e.m.allocMask("s", "selection", [{ x: 1, y: 0, w: 2, h: 2 }]);
    e.m.allocMask("n", "selection", []);
    expect([e.mask("w").at(0, 0), e.mask("k").at(0, 0)]).toEqual([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    expect([e.mask("s").at(1, 1), e.mask("s").at(0, 0), e.mask("s").at(3, 2)]).toEqual([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    expect(e.mask("n").at(0, 0), "an empty selection reveals all").toEqual([255, 255, 255, 255]);
    expect([e.changes(), e.alpha("s").at(1, 1)[3]]).toEqual([4, 255]);
  });

  it("freed — its alpha too, and a surface pointing at it back to pixels — and told", () => {
    const e = engine();
    e.m.allocMask("a", "reveal");
    e.m.setActiveSurface("a", "mask");
    e.m.allocMask("fm:b", "reveal");
    e.m.setActiveSurface("b", "filterMask");
    e.calls.length = 0;
    e.m.freeMask("a");
    e.m.freeMask("fm:b");
    expect([e.cursor.doc.masks.size, e.cursor.doc.maskAlpha.size]).toEqual([0, 0]);
    expect([e.cursor.doc.surfaces.get("a"), e.cursor.doc.surfaces.get("b")]).toEqual(["pixels", "pixels"]);
    expect(e.calls).toEqual([
      ["bump", "a", undefined],
      ["bump", "fm:b", undefined],
    ]);
  });

  it("captured and restored for history; its histogram; baked into its layer", () => {
    const e = engine();
    expect([e.m.captureMask("a"), e.m.maskHistogram("a")]).toEqual([null, null]);
    e.m.allocMask("a", "selection", [{ x: 0, y: 0, w: 1, h: 3 }]);
    const snap = e.m.captureMask("a")!;
    e.m.allocMask("a", "reveal");
    e.m.restoreMask("a", snap);
    expect([e.mask("a").at(0, 0)[0], e.mask("a").at(1, 0)[0], e.alpha("a").at(1, 0)[3]]).toEqual([255, 0, 0]);
    e.mask("a").px.set([200, 200, 200, 128], (1 * 4 + 1) * 4); // (1, 1): 200, half there
    const hist = e.m.maskHistogram("a")!;
    expect([hist[255], hist[0], hist[100]], "gray times alpha").toEqual([3, 8, 1]);
    e.m.allocMask("fm:a", "hide");
    expect(e.m.maskHistogram("a", "filterMask")![0], "the filter mask's").toBe(12);
    const layer = e.cursor.doc.layers.set("a", canvas(4, 3)).get("a")!;
    layer.ctx.fillStyle = "#c08040";
    layer.ctx.fillRect(0, 0, 4, 3);
    e.m.applyMaskToLayer("a");
    expect([fc(layer).at(0, 1), fc(layer).at(2, 1)[3], e.cursor.doc.masks.has("a")]).toEqual([
      [192, 128, 64, 255],
      0,
      false,
    ]);
  });

  it("moved unlinked — what it leaves is hidden — and remade for a transform, owned ones only", () => {
    const e = engine();
    e.m.allocMask("a", "selection", [{ x: 0, y: 0, w: 1, h: 1 }]);
    e.m.offsetMask("a", 0, 0);
    e.m.offsetMask("none", 1, 1);
    expect(e.mask("a").at(0, 0)[0]).toBe(255);
    e.m.offsetMask("a", 2, 1);
    expect([e.mask("a").at(2, 1)[0], e.mask("a").at(0, 0)[0], e.alpha("a").at(2, 1)[3]]).toEqual([255, 0, 255]);
    e.m.allocMask("fm:a", "reveal");
    e.m.allocMask("b", "reveal");
    const before = { a: e.mask("a"), fm: e.mask("fm:a"), b: e.mask("b") };
    const seen: string[] = [];
    e.m.transformMasks(["a"], (ctx, src) => {
      seen.push(String((src as unknown as FakeCanvas).width));
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 4, 3);
    });
    expect([e.mask("a") !== before.a, e.mask("fm:a") !== before.fm, e.mask("b") === before.b]).toEqual([
      true,
      true,
      true,
    ]);
    expect([seen.length, e.alpha("a").at(0, 0)[3]], "the filter mask goes with its layer").toEqual([2, 128]);
  });

  it("saved and loaded, from any open document; previewed small; made a selection", () => {
    const e = engine();
    const back = new DocumentState();
    back.w = 4;
    back.h = 3;
    back.masks.set("x", canvas(4, 3));
    e.cursor.docs.set("back", back);
    expect([e.m.getMaskImage("x"), e.m.getMaskImageCanvas("x")]).toEqual(["data:fake,4x3", back.masks.get("x")!.c]);
    expect([e.m.getMaskImage("none"), e.m.getMaskImageCanvas("none")]).toEqual([null, null]);
    const src = canvas(4, 3);
    src.ctx.fillStyle = "#fff";
    src.ctx.fillRect(3, 2, 1, 1);
    e.m.setMaskImage("a", src.c);
    expect([e.mask("a").at(3, 2)[0], e.alpha("a").at(3, 2)[3], e.alpha("a").at(0, 0)[3]]).toEqual([255, 255, 0]);
    expect(e.m.maskSelectionRects("a")).toEqual([{ x: 3, y: 2, w: 1, h: 1 }]);
    expect(e.m.maskSelectionRects("none")).toEqual([]);
    e.cursor.doc.w = 200;
    e.cursor.doc.h = 100;
    e.m.allocMask("big", "reveal");
    expect(e.m.maskPreviewURL("big", 48)).toBe("data:fake,48x24");
    expect([e.m.maskPreviewURL("big", 400), e.m.maskPreviewURL("none")]).toEqual(["data:fake,200x100", null]);
  });
});

describe("the quick mask", () => {
  it("entered from the selection or revealing all, its key set before it is made; left and pointed at again", () => {
    const e = engine();
    expect([e.m.quickMaskActive(), e.m.quickMaskRects(), e.m.quickMaskCoverage()]).toEqual([false, [], null]);
    let keyWhenBumped: string | null = "unset";
    const bump = e.calls.push.bind(e.calls);
    e.calls.push = (...items: unknown[][]) => ((keyWhenBumped = e.m.qmKey), bump(...items));
    e.m.enterQuickMask("qm:d", [{ x: 1, y: 1, w: 1, h: 1 }]);
    expect(keyWhenBumped, "known as the quick mask before its alpha is derived").toBe("qm:d");
    expect([e.m.quickMaskActive(), e.m.quickMaskRects()]).toEqual([true, [{ x: 1, y: 1, w: 1, h: 1 }]]);
    expect(e.m.quickMaskCoverage()).toBe(e.cursor.doc.maskAlpha.get("qm:d")!.c);
    e.m.setQuickMask(null);
    expect([e.m.quickMaskActive(), e.m.qmKey, e.cursor.doc.masks.has("qm:d")], "off, its raster kept").toEqual([
      false,
      null,
      true,
    ]);
    e.m.setQuickMask("qm:none");
    expect(e.m.qmKey, "never pointed at a raster that is not there").toBeNull();
    e.m.setQuickMask("qm:d");
    expect(e.m.quickMaskActive()).toBe(true);
    e.cursor.doc.masks.delete("qm:d");
    expect(e.m.quickMaskActive(), "its raster gone").toBe(false);
    e.m.enterQuickMask("qm:e");
    expect(e.mask("qm:e").at(0, 0), "nothing selected: all of it").toEqual([255, 255, 255, 255]);
  });
});
