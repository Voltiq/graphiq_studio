import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, type Layer } from "../app/lib/doc-state";
import { EngineSelection, type SelectionHost } from "../app/lib/engine/selection";
import { coverage } from "../app/lib/selection-mask";
import type { Rect } from "../app/lib/view";

/**
 * The engine's selection (TODO 1.6, app/lib/engine/selection.ts): a
 * selection's coverage and outline, the operations on it, its shape for
 * clipping and masking, and the tools that make one — on documents of its own,
 * with layers whose pixels are byte arrays and a host whose canvases record
 * what is drawn on them.
 */

type Call = [string, string, ...unknown[]];

/** A 2D context that records every call; `getImageData` answers from `data`. */
function fakeCtx(name: string, calls: Call[], data?: Uint8ClampedArray): CanvasRenderingContext2D {
  const props: Record<string, unknown> = {};
  return new Proxy(props, {
    get: (_t, k: string) => {
      if (k in props) return props[k];
      if (k === "getImageData")
        return (x: number, y: number, w: number, h: number) => {
          calls.push([name, k, x, y, w, h]);
          return { data: data ?? new Uint8ClampedArray(w * h * 4) };
        };
      return (...a: unknown[]) => calls.push([name, k, ...a]);
    },
    set: (_t, k: string, v) => {
      props[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** RGBA pixels for a `w × h` image, coloured by `at(x, y)`. */
function pixels(w: number, h: number, at: (x: number, y: number) => [number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      d.set([r, g, b, 255], (y * w + x) * 4);
    }
  return d;
}

function engine(w = 8, h = 6) {
  const cursor = new DocCursor();
  cursor.doc.w = w;
  cursor.doc.h = h;
  const calls: Call[] = [];
  let made = 0;
  let mkData: Uint8ClampedArray | undefined;
  let view: CanvasRenderingContext2D | null = null;
  const host: SelectionHost = {
    mk: (cw, ch) => {
      const name = `mk${++made} ${cw}x${ch}`;
      return { c: { name } as unknown as HTMLCanvasElement, ctx: fakeCtx(name, calls, mkData) };
    },
    cs: () => "srgb",
    viewContext: () => view,
  };
  const s = new EngineSelection(cursor, host);
  /** A soft selection from per-pixel coverage, `softness` remembered. */
  const soft = (at: (x: number, y: number) => number, softness?: number) =>
    s.selectionFromCoverage((i) => at(i % cursor.doc.w, Math.floor(i / cursor.doc.w)), softness);
  const layer = (id: string, data: Uint8ClampedArray) =>
    cursor.doc.layers.set(id, { c: { name: id }, ctx: fakeCtx(id, calls, data) } as unknown as Layer);
  /** A selection's coverage over the whole canvas, one byte a pixel. */
  const cov = (rects: Rect[]) => coverage(rects, s.coverageOf(rects), cursor.doc.w, cursor.doc.h);
  return {
    s,
    cursor,
    calls,
    soft,
    layer,
    cov,
    made: () => made,
    setView: (v: CanvasRenderingContext2D) => (view = v),
    setMkData: (d: Uint8ClampedArray) => (mkData = d),
  };
}

/** A 4×2 block at (2, 2), with a soft pixel at (1, 2). */
const fringed = (x: number, y: number) => (y >= 2 && y < 4 && x >= 2 && x < 6 ? 255 : x === 1 && y === 2 ? 100 : 0);
const box = (rects: Rect[]) => {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  return {
    x: x0,
    y: y0,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x0,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y0,
  };
};

beforeEach(() => {
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a selection's coverage", () => {
  it("soft coverage is kept behind its ≥50% rects, with how far it reaches; a hard one is just its rects", () => {
    const e = engine();
    const rects = e.soft(fringed, 5);
    expect(box(rects)).toEqual({ x: 2, y: 2, w: 4, h: 2 });
    expect([e.s.isSoftSelection(rects), e.s.selectionSoftness(rects), e.s.isFaintSelection(rects)]).toEqual([
      true,
      5,
      false,
    ]);
    expect(e.cov(rects)[2 * 8 + 1], "the soft pixel, kept").toBe(100);
    const hard = e.soft((x, y) => (y < 2 && x < 3 ? 255 : 0));
    expect([e.s.isSoftSelection(hard), e.s.selectionSoftness(hard), e.s.coverageOf(hard)]).toEqual([false, 0, null]);
    const faint = e.soft((x) => (x < 4 ? 100 : 0));
    expect([faint.length > 0, e.s.isFaintSelection(faint)], "under 50% everywhere, still a selection").toEqual([
      true,
      true,
    ]);
    e.cursor.doc.w = 9;
    expect(e.s.isSoftSelection(rects), "a mask for another canvas size does not count").toBe(false);
  });

  it("the outline is traced once and kept with the selection", () => {
    const e = engine();
    const rects = [{ x: 1, y: 1, w: 2, h: 2 }];
    const segs = e.s.selectionOutline(rects);
    expect(segs).toHaveLength(4);
    expect(e.s.selectionOutline(rects), "the same object: not traced again").toBe(segs);
    expect(e.s.selectionOutline([{ x: 1, y: 1, w: 2, h: 2 }]), "another selection is traced afresh").not.toBe(segs);
    expect(e.s.selectionOutline([])).toEqual([]);
  });
});

describe("combining", () => {
  it("keeps a soft edge — add, subtract, intersect, invert — and leaves two hard ones to the rect path", () => {
    const e = engine();
    const hardA = [{ x: 0, y: 0, w: 4, h: 6 }];
    const hardB = [{ x: 2, y: 0, w: 4, h: 6 }];
    expect(e.s.combineSelectionSoft(hardA, hardB, "add")).toBeNull();
    const a = e.soft(fringed);
    const at = (r: Rect[] | null, x: number, y: number) => e.cov(r!)[y * 8 + x];
    const add = e.s.combineSelectionSoft(a, [{ x: 0, y: 5, w: 8, h: 1 }], "add");
    expect([at(add, 1, 2), at(add, 3, 2), at(add, 0, 5), at(add, 0, 0)]).toEqual([100, 255, 255, 0]);
    const sub = e.s.combineSelectionSoft(a, [{ x: 4, y: 0, w: 4, h: 6 }], "subtract");
    expect([at(sub, 1, 2), at(sub, 3, 2), at(sub, 4, 2)]).toEqual([100, 255, 0]);
    const both = e.s.combineSelectionSoft(a, [{ x: 0, y: 2, w: 3, h: 1 }], "intersect");
    expect([at(both, 1, 2), at(both, 2, 2), at(both, 3, 2), at(both, 2, 3)]).toEqual([100, 255, 0, 0]);
    const inv = e.s.combineSelectionSoft(a, null, "invert");
    expect([at(inv, 1, 2), at(inv, 3, 2), at(inv, 0, 0)]).toEqual([155, 0, 255]);
  });

  it("a hard add and subtract on the shared buffer, whatever the last call left in it, at any canvas shape", () => {
    const e = engine();
    const add = e.s.combineSelection([{ x: 0, y: 0, w: 2, h: 2 }], [{ x: 4, y: 4, w: 4, h: 2 }], "add")!;
    expect(add.rects.reduce((n, r) => n + r.w * r.h, 0)).toBe(12);
    expect(add.segments.length).toBeGreaterThan(0);
    const corners = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 7, y: 5, w: 1, h: 1 },
    ];
    const next = e.s.combineSelection(corners, [], "add")!; // spans the canvas: anything left would show
    expect(next.rects, "nothing left over from the last call").toEqual(corners);
    const sub = e.s.combineSelection([{ x: 0, y: 0, w: 4, h: 2 }], [{ x: 2, y: 0, w: 2, h: 2 }], "subtract")!;
    expect(box(sub.rects)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(e.s.combineSelection([{ x: 0, y: 0, w: 2, h: 2 }], [{ x: 0, y: 0, w: 2, h: 2 }], "subtract")).toEqual({
      rects: [],
      segments: [],
    });
    e.s.combineSelection([{ x: 0, y: 0, w: 8, h: 6 }], [], "add"); // every cell set
    e.cursor.doc.w = 6;
    e.cursor.doc.h = 8; // as many cells, other rows
    const far = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 5, y: 7, w: 1, h: 1 },
    ];
    expect(e.s.combineSelection(far, [], "add")!.rects, "a fresh buffer for the new shape").toEqual(far);
    e.cursor.doc.w = 0;
    expect(e.s.combineSelection([{ x: 0, y: 0, w: 1, h: 1 }], [], "add")).toBeNull();
  });

  it("onto a soft selection, the combine is soft", () => {
    const e = engine();
    const a = e.soft(fringed);
    const out = e.s.combineSelection(a, [{ x: 6, y: 0, w: 2, h: 1 }], "add")!;
    expect([e.s.isSoftSelection(out.rects), out.segments.length > 0, e.cov(out.rects)[1 * 8 + 0]]).toEqual([
      true,
      true,
      0,
    ]);
    expect(e.cov(out.rects)[7]).toBe(255);
    expect(e.s.combineSelection(a, [{ x: 0, y: 0, w: 8, h: 6 }], "subtract")).toEqual({ rects: [], segments: [] });
  });
});

describe("operations on a selection", () => {
  it("Feather and Refine Edge make it soft, adding to how far it reaches; nothing to do leaves it be", () => {
    const e = engine(16, 12);
    const rect = [{ x: 4, y: 4, w: 6, h: 4 }];
    const f = e.s.featherSelection(rect, 0, null, 2);
    expect([e.s.isSoftSelection(f), e.s.selectionSoftness(f) > 0]).toEqual([true, true]);
    const twice = e.s.featherSelection(f, 0, null, 2);
    expect(e.s.selectionSoftness(twice), "the reach adds up").toBeGreaterThan(e.s.selectionSoftness(f));
    expect([e.s.featherSelection(rect, 0, null, 0), e.s.featherSelection([], 0, null, 2)]).toEqual([rect, []]);
    expect(e.s.featherSelection(rect, 0, null, 0)).toBe(rect);
    const r = e.s.refineSelection(rect, 0, null, { smooth: 0, contrast: 0, shift: 0, feather: 2 });
    expect([e.s.isSoftSelection(r), e.s.selectionSoftness(r) > 0]).toEqual([true, true]);
    const shifted = e.s.refineSelection(rect, 0, null, { smooth: 0, contrast: 0, shift: 50, feather: 0 });
    expect(e.s.selectionSoftness(shifted), "a shift alone reaches nowhere").toBe(0);
    expect(e.s.refineSelection([], 0, null, { smooth: 0, contrast: 0, shift: 0, feather: 2 })).toEqual([]);
  });

  it("Grow, Expand and Contract move a soft edge without hardening it; a hard selection grows elsewhere", () => {
    const e = engine(16, 12);
    const hard = [{ x: 4, y: 4, w: 6, h: 4 }];
    expect(e.s.growSoftSelection(hard, 2)).toBeNull();
    const f = e.s.featherSelection(hard, 0, null, 1);
    const g = e.s.growSoftSelection(f, 2)!;
    expect([e.s.isSoftSelection(g), e.s.selectionSoftness(g)]).toEqual([true, e.s.selectionSoftness(f)]);
    expect(box(g).w).toBeGreaterThan(box(f).w);
    const big = e.s.modifySelection(f, 0, null, "expand", 2);
    const small = e.s.modifySelection(f, 0, null, "contract", 2);
    expect([e.s.isSoftSelection(big), e.s.selectionSoftness(big)]).toEqual([true, e.s.selectionSoftness(f)]);
    expect([box(big).w > box(f).w, box(small).w < box(f).w]).toEqual([true, true]);
    expect(e.s.modifySelection([], 0, null, "expand", 2)).toEqual([]);
  });

  it("a nudge carries the mask with the outline; a resize gives the new outline the old mask, resampled", () => {
    const e = engine();
    const a = e.soft(fringed);
    const moved = e.s.shiftSelection(a, 1, 1);
    expect(moved.map((r) => [r.x, r.y])).toEqual(a.map((r) => [r.x + 1, r.y + 1]));
    expect(e.cov(moved)[3 * 8 + 2], "the soft pixel, moved with it").toBe(100);
    const hardMoved = e.s.shiftSelection([{ x: 0, y: 0, w: 2, h: 2 }], 1, 0);
    expect([hardMoved, e.s.coverageOf(hardMoved)]).toEqual([[{ x: 1, y: 0, w: 2, h: 2 }], null]);
    const to = [{ x: 0, y: 0, w: 8, h: 4 }];
    e.s.carryResizedSelection(a, to, { x: 1, y: 2, w: 5, h: 2 }, { x: 0, y: 0, w: 8, h: 4 });
    expect(e.s.isSoftSelection(to)).toBe(true);
    const hardTo = [{ x: 0, y: 0, w: 4, h: 4 }];
    e.s.carryResizedSelection([{ x: 0, y: 0, w: 2, h: 2 }], hardTo, { x: 0, y: 0, w: 2, h: 2 }, hardTo[0]);
    expect(e.s.isSoftSelection(hardTo)).toBe(false);
  });
});

describe("its shape, for clipping and masking", () => {
  it("its bounds: the rects, or the soft edge's reach, turned when it is, held to the canvas", () => {
    const e = engine();
    expect(e.s.boundsOf([{ x: -2, y: 1, w: 4, h: 2 }])).toEqual({ x: 0, y: 1, w: 2, h: 2 });
    expect(e.s.boundsOf(e.soft(fringed)), "the soft pixel at x 1 is inside").toEqual({ x: 1, y: 2, w: 5, h: 2 });
    // A quarter turn: 4 × 2 stands up as 2 × 4 (the floor and ceiling may take one
    // more pixel of cos(π/2)'s rounding).
    const stood = e.s.boundsOf([{ x: 2, y: 2, w: 4, h: 2 }], Math.PI / 2, { x: 4, y: 3 })!;
    expect([stood.x, stood.w, stood.y <= 1, stood.y + stood.h >= 5, stood.h <= 6]).toEqual([3, 2, true, true, true]);
    expect(e.s.boundsOf([{ x: 2, y: 2, w: 4, h: 2 }], Math.PI / 2), "about its own centre").toEqual(stood);
    expect(e.s.boundsOf([{ x: 20, y: 20, w: 2, h: 2 }])).toBeNull();
  });

  it("a clip is its path — the rects, or turned quads about the pivot — and none without a selection", () => {
    const e = engine();
    const ctx = fakeCtx("view", e.calls);
    e.s.clipTo(ctx, null);
    e.s.clipTo(ctx, []);
    expect(e.calls).toEqual([]);
    e.s.clipTo(ctx, [{ x: 1, y: 2, w: 3, h: 4 }]);
    expect(e.calls).toEqual([
      ["view", "beginPath"],
      ["view", "rect", 1, 2, 3, 4],
      ["view", "clip"],
    ]);
    e.calls.length = 0;
    e.s.clipTo(ctx, [{ x: 0, y: 0, w: 2, h: 2 }], Math.PI, { x: 2, y: 2 });
    const pts = e.calls
      .filter((c) => c[1] === "moveTo" || c[1] === "lineTo")
      .map((c) => (c.slice(2) as number[]).map(Math.round));
    expect(pts).toEqual([
      [4, 4],
      [2, 4],
      [2, 2],
      [4, 2],
    ]);
    expect(e.calls.map((c) => c[1]).slice(-2)).toEqual(["closePath", "clip"]);
  });

  it("its mask is built once and kept while nothing it depends on moves; soft coverage is painted, not traced", () => {
    const e = engine();
    const rects = [{ x: 1, y: 1, w: 2, h: 2 }];
    const m = e.s.selectionMask(rects, 0, null);
    expect(e.s.selectionMask(rects, 0, null), "kept").toBe(m);
    expect(e.made()).toBe(1);
    expect(e.calls.map((c) => c[1])).toEqual(["beginPath", "rect", "fill"]);
    e.calls.length = 0;
    expect(e.s.selectionMask(rects, 0.5, null), "turned: built again").not.toBe(m);
    expect(e.calls.filter((c) => c[1] === "translate")[0].slice(2), "about the selection's centre").toEqual([2, 2]);
    expect(e.s.selectionMask([{ x: 1, y: 1, w: 2, h: 2 }], 0, null), "another selection: built again").not.toBe(m);
    const kept = e.s.selectionMask(rects, 0, null);
    e.cursor.doc.w = 9;
    expect(e.s.selectionMask(rects, 0, null), "another canvas size: built again").not.toBe(kept);
    e.calls.length = 0;
    e.cursor.doc.w = 8;
    const soft = e.soft(fringed);
    e.s.selectionMask(soft, 0, null);
    expect(e.calls.map((c) => c[1]), "the coverage, put down as pixels").toEqual(["putImageData"]);
    expect(e.made(), "a turned one takes two: the flat shape, then turned").toBe(7);
  });
});

describe("the tools that make one", () => {
  const halves = (x: number): [number, number, number] => (x < 4 ? [220, 30, 30] : [30, 30, 220]);

  it("the magic wand selects what is like the pixel clicked, from the layer or every layer", () => {
    const e = engine();
    e.layer("a", pixels(8, 6, (x) => halves(x)));
    const opts = { tolerance: 32, contiguous: true, sampleAll: false };
    const left = e.s.magicWand("a", 1, 1, opts)!;
    expect(box(left.rects)).toEqual({ x: 0, y: 0, w: 4, h: 6 });
    expect(e.s.magicWand("a", 1, 1, { ...opts, tolerance: 255 })!.rects, "everything, at full tolerance").toEqual([
      { x: 0, y: 0, w: 8, h: 6 },
    ]);
    const added = e.s.magicWand("a", 6, 1, opts, false, [{ x: 0, y: 0, w: 1, h: 1 }])!;
    expect(box(added.rects), "Ctrl adds to what is there").toEqual({ x: 0, y: 0, w: 8, h: 6 });
    expect([e.s.magicWand("a", -1, 0, opts), e.s.magicWand("a", 8, 0, opts), e.s.magicWand("x", 0, 0, opts)]).toEqual([
      null,
      null,
      null,
    ]);
    e.setView(fakeCtx("view", e.calls, pixels(8, 6, () => [0, 200, 0])));
    expect(e.s.magicWand("", 6, 1, { ...opts, sampleAll: true })!.rects, "the view, for all layers").toEqual([
      { x: 0, y: 0, w: 8, h: 6 },
    ]);
  });

  it("the wand reuses its source only for a re-run of the same layer at the same size", () => {
    const e = engine();
    e.layer("a", pixels(8, 6, (x) => halves(x)));
    e.layer("b", pixels(8, 6, (x) => halves(x)));
    const opts = { tolerance: 32, contiguous: true, sampleAll: false };
    const reads = () => e.calls.filter((c) => c[1] === "getImageData").length;
    e.s.magicWand("a", 1, 1, opts);
    e.s.magicWand("a", 1, 1, { ...opts, tolerance: 60 }, true);
    expect(reads(), "a re-run reads nothing").toBe(1);
    e.s.magicWand("a", 1, 1, opts);
    expect(reads(), "a fresh click reads again").toBe(2);
    e.s.magicWand("b", 1, 1, opts, true);
    e.s.magicWand("b", 1, 1, { ...opts, sampleAll: true }, true);
    expect(reads(), "another layer, or all of them, read afresh").toBe(3);
    e.s.wandSrc = null;
    e.s.magicWand("b", 1, 1, opts, true);
    expect(reads(), "dropped by an edit: read again").toBe(4);
    const contiguous = e.s.magicWand("a", 1, 1, opts)!;
    e.layer("c", pixels(8, 6, (x) => (x === 0 || x === 7 ? [220, 30, 30] : [30, 30, 220])));
    const apart = e.s.magicWand("c", 0, 0, { ...opts, contiguous: false })!;
    expect([box(contiguous.rects).w, apart.rects, box(apart.rects).w]).toEqual([
      4,
      [
        { x: 0, y: 0, w: 1, h: 6 },
        { x: 7, y: 0, w: 1, h: 6 },
      ],
      8,
    ]);
  });

  it("the lasso fills its polygon and keeps what is at least half in", () => {
    const e = engine();
    const bw = 4;
    const bh = 3;
    const half = new Uint8ClampedArray(bw * bh * 4);
    for (let i = 0; i < bw * bh; i++) half[i * 4 + 3] = i % bw < 2 ? 255 : 100; // the left two columns in
    e.setMkData(half);
    expect(e.s.lassoSelect([{ x: 0, y: 0 }, { x: 2, y: 2 }]), "two points are no polygon").toBeNull();
    expect(e.s.lassoSelect([{ x: -5, y: -5 }, { x: -1, y: -5 }, { x: -1, y: -1 }]), "off the canvas").toBeNull();
    e.calls.length = 0;
    const out = e.s.lassoSelect([
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 4 },
    ])!;
    expect(e.calls.filter((c) => c[0].endsWith("4x3")).map((c) => c[1])).toEqual([
      "translate",
      "beginPath",
      "moveTo",
      "lineTo",
      "lineTo",
      "closePath",
      "fill",
      "getImageData",
    ]);
    expect(box(out.rects)).toEqual({ x: 1, y: 1, w: 2, h: 3 });
  });

  it("quick select grows from the brush through like colour, stops at an edge, takes away with Alt, then ends", () => {
    const e = engine(12, 6);
    e.layer("a", pixels(12, 6, (x) => (x < 6 ? [200, 40, 40] : [40, 40, 200])));
    const opts = { tolerance: 20, sampleAll: false };
    e.s.beginQuickSelect("a", opts, null, false);
    const grown = e.s.quickSelectDab(2, 2, 1)!;
    expect(box(grown.rects), "the red half, not across the edge").toEqual({ x: 0, y: 0, w: 6, h: 6 });
    e.s.endQuickSelect();
    expect(e.s.quickSelectDab(2, 2, 1), "ended").toBeNull();
    e.s.beginQuickSelect("a", opts, grown.rects, true);
    const less = e.s.quickSelectDab(2, 2, 1);
    expect(less, "taken away, all of the like colour").toBeNull();
    e.s.beginQuickSelect("a", opts, [{ x: 8, y: 0, w: 2, h: 2 }], false);
    const kept = e.s.quickSelectDab(1, 1, 1)!;
    expect(box(kept.rects), "the base is kept").toEqual({ x: 0, y: 0, w: 10, h: 6 });
    e.s.beginQuickSelect("none", opts, null, false);
    expect(e.s.quickSelectDab(1, 1, 1), "no layer, no session").toBeNull();
    // Close enough in colour to cross, but an edge is a wall: from inside a small
    // island edged all round (no way around it along the border), nothing past it.
    const walled = engine(16, 8);
    const island = (x: number, y: number) => x >= 3 && x < 9 && y >= 2 && y < 6;
    walled.layer("near", pixels(16, 8, (x, y) => (island(x, y) ? [100, 100, 100] : [120, 100, 100])));
    walled.s.beginQuickSelect("near", { tolerance: 60, sampleAll: false }, null, false);
    const stopped = box(walled.s.quickSelectDab(5, 4, 1)!.rects);
    expect(stopped.x + stopped.w, "held at the edge, though the colour would pass").toBeLessThan(10);
  });
});
