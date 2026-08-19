import { describe, expect, it } from "vitest";

import { maskToRects, maskToSegments, rowRuns, type Bounds } from "@/app/lib/mask-trace";

/* The ORACLE is the implementation these replaced: walk every cell of the
   bounding box and test it against its neighbour. It is obviously correct and
   obviously slow, which is exactly what an oracle should be. The run-based
   versions are only allowed to be faster, never different. */

function oracleSegments(mask: Uint8Array, w: number, h: number, b: Bounds) {
  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    const above = y > 0 ? (y - 1) * w : -1;
    const cur = y < h ? y * w : -1;
    let run = -1;
    for (let x = b.x0; x <= b.x1; x++) {
      const a = above >= 0 && x < b.x1 && mask[above + x] === 1;
      const c = cur >= 0 && x < b.x1 && mask[cur + x] === 1;
      const edge = x < b.x1 && a !== c;
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) {
        segs.push({ x1: run, y1: y, x2: x, y2: y });
        run = -1;
      }
    }
  }
  for (let x = b.x0; x <= b.x1; x++) {
    const left = x > 0 ? x - 1 : -1;
    const cur = x < w ? x : -1;
    let run = -1;
    for (let y = b.y0; y <= b.y1; y++) {
      const row = y < b.y1 ? y * w : -1;
      const a = row >= 0 && left >= 0 && mask[row + left] === 1;
      const c = row >= 0 && cur >= 0 && mask[row + cur] === 1;
      const edge = y < b.y1 && a !== c;
      if (edge && run < 0) run = y;
      else if (!edge && run >= 0) {
        segs.push({ x1: x, y1: run, x2: x, y2: y });
        run = -1;
      }
    }
  }
  return segs;
}

/** Break a segment list into unit grid edges — the canonical form. Two lists
 *  that merge differently but cover the same boundary compare equal here, which
 *  is the equivalence that actually matters. */
const unitEdges = (segs: { x1: number; y1: number; x2: number; y2: number }[]) => {
  const out = new Set<string>();
  for (const s of segs) {
    if (s.y1 === s.y2) for (let x = s.x1; x < s.x2; x++) out.add(`h${x},${s.y1}`);
    else for (let y = s.y1; y < s.y2; y++) out.add(`v${s.x1},${y}`);
  }
  return out;
};
const sameEdges = (a: Set<string>, c: Set<string>) =>
  a.size === c.size && [...a].every((k) => c.has(k));

/** The cells a rect list covers, as a canonical set. */
const coveredCells = (rects: { x: number; y: number; w: number; h: number }[]) => {
  const out = new Set<string>();
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.add(`${x},${y}`);
  return out;
};
const maskCells = (mask: Uint8Array, w: number, b: Bounds) => {
  const out = new Set<string>();
  for (let y = b.y0; y < b.y1; y++)
    for (let x = b.x0; x < b.x1; x++) if (mask[y * w + x]) out.add(`${x},${y}`);
  return out;
};

// ---- mask builders --------------------------------------------------------
const blank = (w: number, h: number) => new Uint8Array(w * h);
const rect = (m: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
};
const disc = (m: Uint8Array, w: number, cx: number, cy: number, r: number) => {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++)
      if (y >= 0 && x >= 0 && x < w && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
  return m;
};
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const full = (w: number, h: number): Bounds => ({ x0: 0, y0: 0, x1: w, y1: h });

describe("row runs", () => {
  it("finds the maximal spans of a row", () => {
    const w = 10;
    const m = blank(w, 1);
    for (const x of [1, 2, 3, 6, 9]) m[x] = 1;
    const out = new Int32Array(20);
    const n = rowRuns(m, w, 0, 0, w, out);
    expect(n).toBe(3);
    expect([...out.slice(0, 6)]).toEqual([1, 4, 6, 7, 9, 10]);
  });

  it("clips to the window it is given", () => {
    const w = 10;
    const m = rect(blank(w, 1), w, 0, 0, 10, 1);
    const out = new Int32Array(20);
    expect(rowRuns(m, w, 0, 3, 7, out)).toBe(1);
    expect([...out.slice(0, 2)]).toEqual([3, 7]);
  });

  it("reports nothing for an empty row", () => {
    expect(rowRuns(blank(10, 1), 10, 0, 0, 10, new Int32Array(20))).toBe(0);
  });
});

describe("segments match the oracle", () => {
  const cases: [string, number, number, (m: Uint8Array, w: number) => Uint8Array][] = [
    ["one solid rectangle", 40, 30, (m, w) => rect(m, w, 5, 5, 30, 22)],
    ["the whole bounding box", 24, 18, (m, w) => rect(m, w, 0, 0, 24, 18)],
    ["a single cell", 12, 12, (m, w) => rect(m, w, 6, 6, 7, 7)],
    ["a one-pixel row", 20, 10, (m, w) => rect(m, w, 2, 4, 18, 5)],
    ["a one-pixel column", 10, 20, (m, w) => rect(m, w, 4, 2, 5, 18)],
    ["a disc (ragged edges every row)", 41, 41, (m, w) => disc(m, w, 20, 20, 17)],
    ["a ring (a hole inside)", 41, 41, (m, w) => {
      disc(m, w, 20, 20, 18);
      for (let y = 0; y < 41; y++)
        for (let x = 0; x < 41; x++) if ((x - 20) ** 2 + (y - 20) ** 2 <= 64) m[y * w + x] = 0;
      return m;
    }],
    ["two disjoint blobs", 60, 30, (m, w) => { rect(m, w, 2, 2, 20, 20); return rect(m, w, 35, 6, 55, 26); }],
    ["a checkerboard (worst case: every cell an edge)", 21, 17, (m, w) => {
      for (let y = 0; y < 17; y++) for (let x = 0; x < 21; x++) if ((x + y) & 1) m[y * w + x] = 1;
      return m;
    }],
    ["comb teeth (many runs per row)", 33, 12, (m, w) => {
      for (let y = 2; y < 10; y++) for (let x = 0; x < 33; x++) if (x % 3 === 0) m[y * w + x] = 1;
      return m;
    }],
    ["touching the mask's left and top edge", 20, 20, (m, w) => rect(m, w, 0, 0, 9, 9)],
    ["touching the mask's right and bottom edge", 20, 20, (m, w) => rect(m, w, 11, 11, 20, 20)],
    ["a diagonal staircase", 30, 30, (m, w) => {
      for (let y = 0; y < 30; y++) for (let x = 0; x <= y; x++) m[y * w + x] = 1;
      return m;
    }],
  ];

  for (const [name, w, h, build] of cases) {
    it(name, () => {
      const m = build(blank(w, h), w);
      const b = full(w, h);
      const got = maskToSegments(m, w, h, b);
      const want = oracleSegments(m, w, h, b);
      expect(sameEdges(unitEdges(got), unitEdges(want))).toBe(true);
    });
  }

  it("matches on 200 random masks of varying density", () => {
    const r = rng(20260819);
    for (let t = 0; t < 200; t++) {
      const w = 6 + Math.floor(r() * 26);
      const h = 6 + Math.floor(r() * 26);
      const density = r();
      const m = blank(w, h);
      for (let i = 0; i < w * h; i++) if (r() < density) m[i] = 1;
      const b = full(w, h);
      const got = unitEdges(maskToSegments(m, w, h, b));
      const want = unitEdges(oracleSegments(m, w, h, b));
      expect(sameEdges(got, want)).toBe(true);
    }
  });

  it("matches on random masks traced through a SUB-window", () => {
    /* The bounds are not always the whole mask — a combine traces only the box it
       changed — so the offsets and strides must be right. The mask is cleared
       outside the window first, because the documented precondition is that the
       box CONTAINS the region; a box clipping through set cells would ask for an
       open boundary, which no caller ever does (see mask-trace.ts). */
    const r = rng(77);
    for (let t = 0; t < 100; t++) {
      const w = 20 + Math.floor(r() * 20);
      const h = 20 + Math.floor(r() * 20);
      const m = blank(w, h);
      for (let i = 0; i < w * h; i++) if (r() < 0.45) m[i] = 1;
      const x0 = Math.floor(r() * (w / 2));
      const y0 = Math.floor(r() * (h / 2));
      const b: Bounds = {
        x0,
        y0,
        x1: x0 + 1 + Math.floor(r() * (w - x0 - 1)),
        y1: y0 + 1 + Math.floor(r() * (h - y0 - 1)),
      };
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) m[y * w + x] = 0;
      expect(
        sameEdges(unitEdges(maskToSegments(m, w, h, b)), unitEdges(oracleSegments(m, w, h, b))),
      ).toBe(true);
    }
  });

  it("emits no more segments than the oracle — merging is at least as good", () => {
    // Equivalence alone would be satisfied by emitting every unit edge
    // separately, which would make the ants far more expensive to draw.
    const w = 60;
    const h = 40;
    const m = rect(blank(w, h), w, 5, 5, 55, 35);
    const b = full(w, h);
    expect(maskToSegments(m, w, h, b).length).toBeLessThanOrEqual(oracleSegments(m, w, h, b).length);
    // A solid rectangle's boundary is four sides, however it is traced.
    expect(maskToSegments(m, w, h, b).length).toBe(4);
  });

  it("returns nothing for an empty mask or a degenerate box", () => {
    const m = blank(10, 10);
    expect(maskToSegments(m, 10, 10, full(10, 10))).toEqual([]);
    const solid = rect(blank(10, 10), 10, 0, 0, 10, 10);
    expect(maskToSegments(solid, 10, 10, { x0: 5, y0: 5, x1: 5, y1: 9 })).toEqual([]);
    expect(maskToSegments(solid, 10, 10, { x0: 2, y0: 7, x1: 8, y1: 7 })).toEqual([]);
  });
});

describe("rects cover exactly the mask", () => {
  it("covers the set cells and nothing else, on every shape", () => {
    const shapes: [number, number, (m: Uint8Array, w: number) => Uint8Array][] = [
      [40, 30, (m, w) => rect(m, w, 5, 5, 30, 22)],
      [41, 41, (m, w) => disc(m, w, 20, 20, 17)],
      [33, 12, (m, w) => {
        for (let y = 2; y < 10; y++) for (let x = 0; x < 33; x++) if (x % 3 === 0) m[y * w + x] = 1;
        return m;
      }],
      [21, 17, (m, w) => {
        for (let y = 0; y < 17; y++) for (let x = 0; x < 21; x++) if ((x + y) & 1) m[y * w + x] = 1;
        return m;
      }],
    ];
    for (const [w, h, build] of shapes) {
      const m = build(blank(w, h), w);
      const b = full(w, h);
      const cells = coveredCells(maskToRects(m, w, b));
      const want = maskCells(m, w, b);
      expect(cells.size).toBe(want.size);
      expect([...want].every((k) => cells.has(k))).toBe(true);
    }
  });

  it("produces non-overlapping rects", () => {
    const r = rng(4242);
    for (let t = 0; t < 60; t++) {
      const w = 8 + Math.floor(r() * 20);
      const h = 8 + Math.floor(r() * 20);
      const m = blank(w, h);
      for (let i = 0; i < w * h; i++) if (r() < 0.5) m[i] = 1;
      const rects = maskToRects(m, w, full(w, h));
      const seen = new Set<string>();
      let total = 0;
      for (const q of rects)
        for (let y = q.y; y < q.y + q.h; y++)
          for (let x = q.x; x < q.x + q.w; x++) {
            expect(seen.has(`${x},${y}`)).toBe(false);
            seen.add(`${x},${y}`);
            total++;
          }
      expect(total).toBe(seen.size);
    }
  });

  it("collapses a solid region instead of emitting one rect per row", () => {
    const m = rect(blank(50, 40), 50, 5, 5, 45, 35);
    expect(maskToRects(m, 50, full(50, 40)).length).toBe(1);
  });

  it("respects a sub-window", () => {
    const m = rect(blank(20, 20), 20, 0, 0, 20, 20);
    const rects = maskToRects(m, 20, { x0: 4, y0: 6, x1: 10, y1: 12 });
    expect(rects).toEqual([{ x: 4, y: 6, w: 6, h: 6 }]);
  });
});
