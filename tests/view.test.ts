/**
 * view.ts — selection-rect geometry and pan clamping.
 *
 * `invertRects` is the interesting one: it slices the canvas along every rect
 * edge and merges the outside cells back into runs, which is easy to get subtly
 * wrong (a missed edge, an off-by-one on a shared boundary) in ways that only
 * show up as a sliver of un-inverted selection. So it is checked against an
 * independent per-pixel oracle rather than against hand-written expectations:
 * rasterize the input, rasterize the output, and demand that they be exact
 * complements. Hand-written cases then pin down the *shape* of the answer
 * (how many rects, merged how), which the oracle can't see.
 */
import { describe, expect, it } from "vitest";
import { KEEP, clampPan, invertRects, normalizeRect, type Rect } from "@/app/lib/view";

/** Pixel indices covered by `rects`, by pixel-centre membership. */
function rasterize(rects: Rect[], w: number, h: number): Set<number> {
  const s = new Set<number>();
  for (const r of rects) {
    const x0 = Math.max(0, Math.min(r.x, r.x + r.w));
    const x1 = Math.min(w, Math.max(r.x, r.x + r.w));
    const y0 = Math.max(0, Math.min(r.y, r.y + r.h));
    const y1 = Math.min(h, Math.max(r.y, r.y + r.h));
    for (let y = Math.floor(y0); y < y1; y++) {
      for (let x = Math.floor(x0); x < x1; x++) {
        if (x + 0.5 > x0 && x + 0.5 < x1 && y + 0.5 > y0 && y + 0.5 < y1) s.add(y * w + x);
      }
    }
  }
  return s;
}

const area = (rects: Rect[]) => rects.reduce((n, r) => n + r.w * r.h, 0);

/** A raster as rows of `#`/`.`, so a mismatch prints as a readable picture. */
const picture = (s: Set<number>, w: number, h: number) =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => (s.has(y * w + x) ? "#" : ".")).join(""),
  ).join("\n");

/** The property every inversion must satisfy, whatever the input looks like. */
function expectExactComplement(rects: Rect[], w: number, h: number) {
  const out = invertRects(rects, w, h);
  const covered = rasterize(rects, w, h);
  const inverted = rasterize(out, w, h);
  const complement = new Set<number>();
  for (let i = 0; i < w * h; i++) if (!covered.has(i)) complement.add(i);
  expect(picture(inverted, w, h)).toBe(picture(complement, w, h));
  // Disjointness + integer alignment: if any two output rects overlapped, or a
  // rect strayed off the pixel grid, the summed area would exceed the raster.
  expect(area(out)).toBe(inverted.size);
  for (const r of out) {
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(w);
    expect(r.y + r.h).toBeLessThanOrEqual(h);
  }
  return out;
}

describe("normalizeRect", () => {
  it("orders the two points", () => {
    expect(normalizeRect(80, 60, 20, 10, 100, 100)).toEqual({ x: 20, y: 10, w: 60, h: 50 });
    expect(normalizeRect(20, 10, 80, 60, 100, 100)).toEqual({ x: 20, y: 10, w: 60, h: 50 });
  });

  it("clamps to the document", () => {
    expect(normalizeRect(-50, -50, 150, 150, 100, 80)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
  });

  it("collapses a rect that lies entirely outside", () => {
    const r = normalizeRect(-40, -40, -10, -10, 100, 100);
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
  });

  it("gives a zero-area rect for a click", () => {
    expect(normalizeRect(30, 30, 30, 30, 100, 100)).toEqual({ x: 30, y: 30, w: 0, h: 0 });
  });
});

describe("invertRects", () => {
  it("returns the whole canvas when nothing is selected", () => {
    expect(invertRects([], 100, 80)).toEqual([{ x: 0, y: 0, w: 100, h: 80 }]);
  });

  it("returns nothing when everything is selected", () => {
    expect(invertRects([{ x: 0, y: 0, w: 100, h: 80 }], 100, 80)).toEqual([]);
  });

  it("frames a centred rect with four merged bands", () => {
    const out = expectExactComplement([{ x: 4, y: 3, w: 4, h: 3 }], 12, 9);
    // Top band, the two flanks of the middle band, bottom band — and no more:
    // the per-row runs must be merged back together horizontally.
    expect(out).toHaveLength(4);
    expect(out).toContainEqual({ x: 0, y: 0, w: 12, h: 3 });
    expect(out).toContainEqual({ x: 0, y: 3, w: 4, h: 3 });
    expect(out).toContainEqual({ x: 8, y: 3, w: 4, h: 3 });
    expect(out).toContainEqual({ x: 0, y: 6, w: 12, h: 3 });
  });

  it("leaves no seam between two abutting rects", () => {
    // Two rects sharing an edge cover a solid 8-wide block; the inversion must
    // not leave a zero-width sliver where they meet.
    const out = expectExactComplement(
      [
        { x: 2, y: 2, w: 4, h: 5 },
        { x: 6, y: 2, w: 4, h: 5 },
      ],
      12,
      9,
    );
    expect(out.every((r) => r.w > 0)).toBe(true);
  });

  it("handles overlapping, nested and duplicated rects", () => {
    expectExactComplement(
      [
        { x: 1, y: 1, w: 6, h: 6 },
        { x: 4, y: 4, w: 6, h: 4 },
      ],
      12,
      9,
    );
    expectExactComplement(
      [
        { x: 1, y: 1, w: 8, h: 7 },
        { x: 3, y: 3, w: 2, h: 2 },
      ],
      12,
      9,
    );
    expectExactComplement(
      [
        { x: 2, y: 2, w: 3, h: 3 },
        { x: 2, y: 2, w: 3, h: 3 },
      ],
      12,
      9,
    );
  });

  it("clips rects that hang off the canvas", () => {
    expectExactComplement([{ x: -5, y: -5, w: 10, h: 10 }], 12, 9);
    expectExactComplement([{ x: 8, y: 5, w: 20, h: 20 }], 12, 9);
  });

  it("ignores rects with no area, and negative sizes", () => {
    expect(invertRects([{ x: 3, y: 3, w: 0, h: 5 }], 12, 9)).toEqual([{ x: 0, y: 0, w: 12, h: 9 }]);
    // Drawn up-and-left: same region, expressed backwards.
    expect(invertRects([{ x: 8, y: 6, w: -4, h: -3 }], 12, 9)).toEqual(
      invertRects([{ x: 4, y: 3, w: 4, h: 3 }], 12, 9),
    );
  });

  it("inverts to an exact complement for arbitrary rect soup", () => {
    // Deterministic pseudo-random cases: the shapes that break sweep algorithms
    // are the awkward coincidences (shared edges, containment, zero spans), and
    // a few hundred random ones find them far better than hand-picked cases.
    let seed = 0x2f6e2b1;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 48271) + 11) % 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 200; trial++) {
      const rects: Rect[] = [];
      for (let k = 0, n = 1 + rnd(3); k < n; k++) {
        const x = rnd(13);
        const y = rnd(10);
        rects.push({ x, y, w: rnd(13 - x), h: rnd(10 - y) });
      }
      expectExactComplement(rects, 12, 9);
    }
  });
});

describe("clampPan", () => {
  const visible = (p: { x: number; y: number }, sw: number, sh: number, vpW: number, vpH: number) => ({
    x: Math.min(p.x + sw, vpW) - Math.max(p.x, 0),
    y: Math.min(p.y + sh, vpH) - Math.max(p.y, 0),
  });

  it("leaves a pan that is already on screen alone", () => {
    expect(clampPan(40, 30, 1, 200, 150, 800, 600)).toEqual({ x: 40, y: 30 });
  });

  it("always keeps part of the canvas reachable, however far it is thrown", () => {
    for (const scale of [0.05, 0.25, 1, 4, 16]) {
      for (const [x, y] of [
        [-100000, -100000],
        [100000, 100000],
        [-100000, 100000],
        [0, 0],
      ]) {
        const sw = 400 * scale;
        const sh = 300 * scale;
        const p = clampPan(x, y, scale, 400, 300, 800, 600);
        const v = visible(p, sw, sh, 800, 600);
        // At least `KEEP` px of canvas on screen — or the whole canvas, when it
        // is smaller than that.
        expect(v.x).toBeGreaterThanOrEqual(Math.min(KEEP, sw) - 1e-9);
        expect(v.y).toBeGreaterThanOrEqual(Math.min(KEEP, sh) - 1e-9);
      }
    }
  });

  it("never hides a canvas smaller than the keep margin", () => {
    // A 10 px canvas can't leave 80 px on screen; it must stay wholly visible.
    const p = clampPan(-9999, -9999, 1, 10, 10, 800, 600);
    expect(p).toEqual({ x: 0, y: 0 });
    const q = clampPan(9999, 9999, 1, 10, 10, 800, 600);
    expect(q).toEqual({ x: 790, y: 590 });
  });

  it("honours a custom keep margin", () => {
    const tight = clampPan(-9999, 0, 1, 400, 300, 800, 600, 10);
    expect(tight.x).toBe(10 - 400);
    const loose = clampPan(-9999, 0, 1, 400, 300, 800, 600, 200);
    expect(loose.x).toBe(200 - 400);
  });
});
