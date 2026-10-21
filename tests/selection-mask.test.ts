/**
 * The selection as a mask (TODO 1.3): the byte arithmetic every selection
 * operation now runs on. The anchor for the morphology is the existing exact
 * signed-distance Modify (select-modify.ts): on a HARD selection the new
 * coverage-based expand / contract must land on exactly the same pixels, or
 * switching a selection's representation would move its edge.
 */
import { describe, expect, it } from "vitest";
import {
  coverage,
  combine,
  feather,
  fromCoverage,
  growSquare,
  morphRound,
  peakOf,
  resample,
  shift,
  slideLine,
  tightBounds,
  type SelectionMask,
} from "../app/lib/selection-mask";
import { contractMask, expandMask } from "../app/lib/select-modify";
import { gaussianChannel } from "../app/lib/blur";

/** A deterministic pseudo-random generator, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A random hard shape: a few overlapping blobs and boxes, 0/255. */
function randomShape(w: number, h: number, seed: number): Uint8Array {
  const r = rng(seed);
  const c = new Uint8Array(w * h);
  for (let n = 0; n < 4; n++) {
    const cx = r() * w;
    const cy = r() * h;
    const rx = 2 + r() * w * 0.3;
    const ry = 2 + r() * h * 0.3;
    const box = r() < 0.4;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (box ? Math.abs(dx) <= 1 && Math.abs(dy) <= 1 : dx * dx + dy * dy <= 1) c[y * w + x] = 255;
      }
  }
  return c;
}

const bin = (c: Uint8Array) => Uint8Array.from(c, (v) => (v >= 128 ? 1 : 0));
const to255 = (m: Uint8Array) => Uint8Array.from(m, (v) => (v ? 255 : 0));

describe("slideLine", () => {
  it("is the max / min over a window of radius k, with padding past the ends", () => {
    const r = rng(7);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(r() * 40);
      const k = Math.floor(r() * 12);
      const pad = r() < 0.5 ? 0 : 255;
      const max = r() < 0.5;
      const line = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const out = new Uint8Array(n);
      slideLine(line, n, k, pad, max, out);
      for (let x = 0; x < n; x++) {
        let want = max ? 0 : 255;
        for (let j = x - k; j <= x + k; j++) {
          const v = j < 0 || j >= n ? pad : line[j];
          want = max ? Math.max(want, v) : Math.min(want, v);
        }
        expect(out[x], `n=${n} k=${k} pad=${pad} max=${max} x=${x}`).toBe(want);
      }
    }
  });
});

describe("round expand and contract", () => {
  const W = 48;
  const H = 36;
  for (const r of [1, 2, 3, 5, 8, 2.5]) {
    it(`agree exactly with the signed-distance Modify on hard shapes (r = ${r})`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const c = randomShape(W, H, seed * 31 + r * 7);
        expect(morphRound(c, W, H, r, true), `expand seed ${seed}`).toEqual(to255(expandMask(bin(c), W, H, r)));
        expect(morphRound(c, W, H, r, false), `contract seed ${seed}`).toEqual(to255(contractMask(bin(c), W, H, r)));
      }
    });
  }

  it("contracts from the canvas edge too, as Modify does (Select All → Contract insets)", () => {
    const c = new Uint8Array(20 * 10).fill(255);
    const out = morphRound(c, 20, 10, 2, false);
    expect(out).toEqual(to255(contractMask(bin(c), 20, 10, 2)));
    // Distances run between pixel centres: the edge pixel is 1 from the outside.
    expect(tightBounds(out, 20, 10)).toEqual({ x: 1, y: 1, w: 18, h: 8 });
  });

  it("moves a soft edge out or in while keeping it soft", () => {
    // A ramp from fully selected to unselected over 10 px, in every row; read
    // the middle row, far from the canvas's top and bottom edges.
    const W2 = 60;
    const H2 = 21;
    const ramp = (x: number) => (x < 20 ? 255 : x < 30 ? Math.round((255 * (30 - x)) / 10) : 0);
    const c = new Uint8Array(W2 * H2);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) c[y * W2 + x] = ramp(x);
    const mid = (m: Uint8Array) => [...m.subarray(10 * W2, 11 * W2)];
    // Out: the same ramp, five pixels further out (a max over a decreasing ramp).
    expect(mid(morphRound(c, W2, H2, 5, true))).toEqual(mid(c).map((_, x) => ramp(x - 5)));
    // In: a min over the OPEN disc (|dx| ≤ 4 on this row) — and the left canvas
    // edge, just past x = 0, counts as unselected too.
    expect(mid(morphRound(c, W2, H2, 5, false))).toEqual(mid(c).map((_, x) => (x < 4 ? 0 : ramp(x + 4))));
  });
});

describe("square grow", () => {
  it("is every selected pixel pushed out by r with a square kernel", () => {
    const W = 30;
    const H = 20;
    for (let seed = 1; seed <= 6; seed++) {
      const c = randomShape(W, H, seed);
      const r = 1 + (seed % 4);
      const out = growSquare(c, W, H, r);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let want = 0;
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H) want = Math.max(want, c[yy * W + xx]);
            }
          expect(out[y * W + x], `seed ${seed} (${x},${y})`).toBe(want);
        }
    }
  });
});

describe("selections from coverage", () => {
  it("a hard selection is exactly its rects (no mask kept)", () => {
    const c = randomShape(20, 15, 3);
    const s = fromCoverage((i) => c[i], 20, 15);
    expect(s.mask).toBeNull();
    expect(coverage(s.rects, null, 20, 15)).toEqual(c);
  });

  it("a soft one keeps its bytes, cropped to where they are non-zero", () => {
    const c = new Uint8Array(10 * 4);
    c[1 * 10 + 3] = 255;
    c[1 * 10 + 4] = 200;
    c[2 * 10 + 5] = 40; // under 50%: in the mask, not in the outline
    const s = fromCoverage((i) => c[i], 10, 4);
    expect(s.rects).toEqual([{ x: 3, y: 1, w: 2, h: 1 }]);
    expect(s.mask!.bounds).toEqual({ x: 3, y: 1, w: 3, h: 2 });
    expect(coverage(s.rects, s.mask, 10, 4)).toEqual(c);
  });

  it("the outline is everything at 50% or more: 128 is in, 127 is out", () => {
    const c = Uint8Array.from([127, 128, 255, 0]);
    expect(fromCoverage((i) => c[i], 4, 1).rects).toEqual([{ x: 1, y: 0, w: 2, h: 1 }]);
  });

  it("a faint selection (under 50% everywhere) still selects, outlined at half its peak", () => {
    // A 30%-ish blob with a 10% rim: the outline is where it is at least half of 80.
    const c = new Uint8Array(6 * 3);
    for (let x = 1; x <= 4; x++) c[1 * 6 + x] = x === 1 || x === 4 ? 25 : 80;
    const s = fromCoverage((i) => c[i], 6, 3);
    expect(s.rects).toEqual([{ x: 2, y: 1, w: 2, h: 1 }]);
    expect(s.mask, "its true strength is kept").not.toBeNull();
    expect(peakOf(s.mask!)).toBe(80);
    expect(coverage(s.rects, s.mask, 6, 3)).toEqual(c);
  });

  it("only a selection with no coverage at all is empty", () => {
    expect(fromCoverage(() => 0, 4, 4)).toEqual({ rects: [], mask: null });
  });
});

describe("mask algebra", () => {
  const a = Uint8Array.from([0, 100, 255, 30, 255]);
  const b = Uint8Array.from([255, 50, 0, 30, 255]);
  it("add, subtract, intersect and invert", () => {
    expect([...combine(a, b, "add")]).toEqual([255, 100, 255, 30, 255]);
    expect([...combine(a, b, "subtract")]).toEqual([0, 100, 255, 30, 0]);
    expect([...combine(a, b, "intersect")]).toEqual([0, 50, 0, 30, 255]);
    expect([...combine(a, null, "invert")]).toEqual([255, 155, 0, 225, 0]);
  });
});

describe("feather", () => {
  it("is the blur the old per-use feather ran, rounded as a canvas stores it", () => {
    const W = 40;
    const H = 30;
    const c = randomShape(W, H, 9);
    const f = new Float32Array(c);
    gaussianChannel(f, W, H, 6);
    const want = new Uint8Array(new Uint8ClampedArray(f).buffer);
    const got = feather(c, W, H, 6);
    expect(got).toEqual(want);
    expect(new Set(got).size, "soft").toBeGreaterThan(20);
  });
});

describe("moving and resizing a mask", () => {
  const mask: SelectionMask = {
    w: 10,
    h: 10,
    bounds: { x: 2, y: 3, w: 3, h: 2 },
    alpha: Uint8Array.from([10, 20, 30, 40, 50, 60]),
  };

  it("shifts by whole pixels and clips at the canvas", () => {
    expect(shift(mask, 4, -1)).toMatchObject({ bounds: { x: 6, y: 2, w: 3, h: 2 } });
    expect([...shift(mask, 4, -1)!.alpha]).toEqual([10, 20, 30, 40, 50, 60]);
    const clipped = shift(mask, -3, 0)!; // the first column falls off the left edge
    expect(clipped.bounds).toEqual({ x: 0, y: 3, w: 2, h: 2 });
    expect([...clipped.alpha]).toEqual([20, 30, 50, 60]);
    expect(shift(mask, 20, 0)).toBeNull();
  });

  it("resamples through a box change: identity is lossless, doubling doubles", () => {
    const box = { x: 2, y: 3, w: 3, h: 2 };
    const same = resample(mask, box, box)!;
    expect(same.bounds).toEqual(mask.bounds);
    expect([...same.alpha]).toEqual([...mask.alpha]);
    const big = resample({ ...mask, softness: 3 }, box, { x: 2, y: 3, w: 6, h: 4 })!;
    expect(big.bounds).toEqual({ x: 2, y: 3, w: 6, h: 4 });
    expect(big.softness, "the soft edge scales with it").toBe(6);
    expect(big.alpha.length).toBe(24);
  });

  it("samples pixel centres bilinearly when it scales", () => {
    // [0, 255] doubled: each new pixel's centre maps back half a pixel at a time.
    const edge: SelectionMask = { w: 8, h: 1, bounds: { x: 0, y: 0, w: 2, h: 1 }, alpha: Uint8Array.from([0, 255]) };
    const out = resample(edge, { x: 0, y: 0, w: 2, h: 1 }, { x: 0, y: 0, w: 4, h: 1 })!;
    expect(out.bounds).toEqual({ x: 1, y: 0, w: 3, h: 1 }); // the first sample is 0
    expect([...out.alpha]).toEqual([64, 191, 191]);
  });
});
