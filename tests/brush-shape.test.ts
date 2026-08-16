/**
 * brush-tip.ts — elliptical tips and scatter.
 *
 * Both are geometry, so the tests are geometric: an angled ellipse is checked at
 * the points where its shape is decidable by hand (on each axis, and at the
 * angle itself), and scatter is checked for the properties that make it scatter
 * rather than noise — bounded reach, across-only unless both axes are asked
 * for, and an exact no-op when it is switched off.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCATTER,
  DEFAULT_TIP_SHAPE,
  makeRng,
  scatterActive,
  sanitizeScatter,
  sanitizeTipShape,
  scatterOffsets,
  tipRadius,
  tipShapeActive,
  type ScatterSettings,
} from "@/app/lib/brush-tip";

describe("tipRadius", () => {
  it("is an ordinary circle at 100% roundness", () => {
    for (const [dx, dy] of [[10, 0], [0, 10], [7.071, 7.071], [-10, 0]]) {
      expect(tipRadius(dx, dy, 10, 0, 100)).toBeCloseTo(1, 3);
    }
  });

  it("ignores the angle when it is a circle", () => {
    expect(tipRadius(6, 8, 10, 37, 100)).toBeCloseTo(1, 6);
  });

  it("keeps the LONG axis at the tip's radius, so a stroke never gets wider", () => {
    // 30% roundness, unrotated: the x extent is still r…
    expect(tipRadius(10, 0, 10, 0, 30)).toBeCloseTo(1, 6);
    // …and the y extent is r × roundness.
    expect(tipRadius(0, 3, 10, 0, 30)).toBeCloseTo(1, 6);
    expect(tipRadius(0, 10, 10, 0, 30)).toBeCloseTo(1 / 0.3, 3); // far outside
  });

  it("turns with the angle", () => {
    // At 90° the long axis is vertical, so the roles swap exactly.
    expect(tipRadius(0, 10, 10, 90, 30)).toBeCloseTo(1, 6);
    expect(tipRadius(3, 0, 10, 90, 30)).toBeCloseTo(1, 6);
  });

  it("puts the edge on the ellipse for an arbitrary angle", () => {
    // A point r along the 37° direction must sit exactly on the rim.
    const a = (37 * Math.PI) / 180;
    expect(tipRadius(10 * Math.cos(a), 10 * Math.sin(a), 10, 37, 25)).toBeCloseTo(1, 6);
    // …and r × roundness across it.
    const p = a + Math.PI / 2;
    expect(tipRadius(2.5 * Math.cos(p), 2.5 * Math.sin(p), 10, 37, 25)).toBeCloseTo(1, 6);
  });

  it("is inside at the centre and grows outward", () => {
    expect(tipRadius(0, 0, 10, 45, 20)).toBe(0);
    expect(tipRadius(4, 0, 10, 0, 100)).toBeLessThan(tipRadius(8, 0, 10, 0, 100));
  });

  it("does not divide by zero on a degenerate tip", () => {
    expect(tipRadius(1, 1, 0, 0, 100)).toBe(Infinity);
    expect(Number.isFinite(tipRadius(1, 1, 10, 0, 0))).toBe(true); // roundness clamped
  });

  it("knows when it has anything to do", () => {
    expect(tipShapeActive(DEFAULT_TIP_SHAPE)).toBe(false); // round by default
    expect(tipShapeActive({ angle: 45, roundness: 100 })).toBe(false); // a turned circle
    expect(tipShapeActive({ angle: 0, roundness: 40 })).toBe(true);
    expect(tipShapeActive(undefined)).toBe(false);
  });
});

describe("scatterOffsets", () => {
  const S = (over: Partial<ScatterSettings> = {}): ScatterSettings => ({
    ...DEFAULT_SCATTER,
    enabled: true,
    ...over,
  });

  it("lays down one dab per count", () => {
    expect(scatterOffsets(S({ count: 1 }), 20, makeRng(1))).toHaveLength(1);
    expect(scatterOffsets(S({ count: 5 }), 20, makeRng(1))).toHaveLength(5);
  });

  it("clamps a silly count instead of hanging", () => {
    expect(scatterOffsets(S({ count: 9999 }), 20, makeRng(1))).toHaveLength(16);
    expect(scatterOffsets(S({ count: 0 }), 20, makeRng(1))).toHaveLength(1);
  });

  it("stays within the reach it was given", () => {
    const reach = (60 / 100) * 20;
    for (const o of scatterOffsets(S({ amount: 60, count: 16 }), 20, makeRng(7))) {
      expect(Math.abs(o.across)).toBeLessThanOrEqual(reach);
      expect(Math.abs(o.along)).toBeLessThanOrEqual(reach);
    }
  });

  it("scales with the tip, so a big brush scatters proportionally", () => {
    const small = scatterOffsets(S({ count: 16 }), 10, makeRng(3));
    const big = scatterOffsets(S({ count: 16 }), 100, makeRng(3));
    const spread = (xs: { across: number }[]) => Math.max(...xs.map((o) => Math.abs(o.across)));
    expect(spread(big)).toBeGreaterThan(spread(small) * 5);
  });

  it("scatters ACROSS the stroke only, unless both axes are asked for", () => {
    const across = scatterOffsets(S({ count: 16 }), 20, makeRng(5));
    expect(across.every((o) => o.along === 0)).toBe(true);
    const both = scatterOffsets(S({ count: 16, bothAxes: true }), 20, makeRng(5));
    expect(both.some((o) => o.along !== 0)).toBe(true);
  });

  it("is an exact no-op at zero amount — a scatter of nothing is a plain stroke", () => {
    expect(scatterOffsets(S({ amount: 0, count: 3 }), 20, makeRng(1))).toEqual([
      { along: 0, across: 0 },
      { along: 0, across: 0 },
      { along: 0, across: 0 },
    ]);
  });

  it("actually varies between dabs", () => {
    // A "scatter" that returned the same offset every time would pass every
    // bound above and still be a solid stroke.
    const os = scatterOffsets(S({ count: 12 }), 20, makeRng(11));
    expect(new Set(os.map((o) => o.across.toFixed(4))).size).toBeGreaterThan(6);
  });

  it("knows when it has anything to do", () => {
    expect(scatterActive(DEFAULT_SCATTER)).toBe(false);
    expect(scatterActive({ ...DEFAULT_SCATTER, enabled: true })).toBe(true);
    expect(scatterActive({ enabled: true, amount: 0, count: 1, bothAxes: false })).toBe(false);
    expect(scatterActive({ enabled: true, amount: 0, count: 3, bothAxes: false })).toBe(true);
  });
});

describe("makeRng", () => {
  it("repeats exactly for a seed, so a stroke can be replayed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("differs between seeds", () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it("stays in [0, 1)", () => {
    const r = makeRng(9);
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("survives a zero seed", () => {
    expect(Number.isFinite(makeRng(0)())).toBe(true);
  });
});

describe("sanitizers", () => {
  it("defaults a missing tip shape to a plain round tip", () => {
    expect(sanitizeTipShape(undefined)).toEqual({ angle: 0, roundness: 100 });
    expect(sanitizeTipShape(null)).toEqual({ angle: 0, roundness: 100 });
  });

  it("wraps the angle rather than clamping it — -190° is a direction, not an error", () => {
    expect(sanitizeTipShape({ angle: 190 }).angle).toBe(-170);
    expect(sanitizeTipShape({ angle: -190 }).angle).toBe(170);
    expect(sanitizeTipShape({ angle: 720 }).angle).toBe(0);
  });

  it("keeps roundness in range and off zero", () => {
    expect(sanitizeTipShape({ roundness: 0 }).roundness).toBe(1);
    expect(sanitizeTipShape({ roundness: 500 }).roundness).toBe(100);
    expect(sanitizeTipShape({ roundness: NaN }).roundness).toBe(100);
  });

  it("coerces scatter, including a fractional count", () => {
    expect(sanitizeScatter(undefined)).toEqual(DEFAULT_SCATTER);
    expect(sanitizeScatter({ enabled: true, count: 3.7 }).count).toBe(4);
    expect(sanitizeScatter({ count: 99 }).count).toBe(16);
    expect(sanitizeScatter({ count: 0 }).count).toBe(1);
    expect(sanitizeScatter({ amount: -5 }).amount).toBe(0);
    expect(sanitizeScatter({ amount: 999 }).amount).toBe(200);
    expect(sanitizeScatter("nonsense").enabled).toBe(false);
  });
});
