/**
 * tone.ts — the Levels and Curves LUT compilers.
 *
 * Everything here compiles to a lookup table that is then applied blindly to
 * millions of pixels, so the tests aim at the properties a table must have
 * (monotone where the input is monotone, exact at the endpoints, no NaN from
 * degenerate parameters) rather than at hand-copied table values, which would
 * only restate the implementation.
 *
 * Two of these are worth flagging as the reason the file exists:
 *   - the Fritsch–Carlson check, which pins down the one thing a plain cubic
 *     spline would get wrong (overshoot, i.e. a curve that dips below a control
 *     point and posterizes shadows);
 *   - `solveGrayPoint`, which is verified by actually applying what it solved
 *     and checking the result is neutral, rather than by comparing gammas.
 */
import { describe, expect, it } from "vitest";
import {
  CURVE_PRESETS,
  IDENTITY_LEVELS,
  applyToneLUTs,
  applyToneLUTs16,
  autoLevels,
  buildCurvesLUTs,
  buildCurvesLUTs16,
  buildLevelsLUTs,
  buildLevelsLUTs16,
  composeLUT,
  curveLUT,
  curveSampler,
  defaultCurves,
  defaultLevels,
  levelsLUT,
  solveGrayPoint,
  type ChannelParams,
  type CurvePoint,
} from "@/app/lib/tone";

const levels = (o: Partial<ChannelParams>): ChannelParams => ({ ...IDENTITY_LEVELS, ...o });
const isMonotone = (lut: ArrayLike<number>, dir: 1 | -1 = 1) => {
  for (let v = 1; v < lut.length; v++) if ((lut[v] - lut[v - 1]) * dir < 0) return false;
  return true;
};
const allFinite = (lut: ArrayLike<number>) => {
  for (let v = 0; v < lut.length; v++) if (!Number.isFinite(lut[v])) return false;
  return true;
};

describe("levelsLUT", () => {
  it("is the identity for neutral parameters", () => {
    const lut = levelsLUT(IDENTITY_LEVELS);
    expect([...lut]).toEqual(Array.from({ length: 256 }, (_, v) => v));
  });

  it("clips everything below inBlack and above inWhite", () => {
    const lut = levelsLUT(levels({ inBlack: 40, inWhite: 200 }));
    expect(lut[0]).toBe(0);
    expect(lut[40]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[255]).toBe(255);
    expect(lut[120]).toBeGreaterThan(0);
    expect(lut[120]).toBeLessThan(255);
  });

  it("maps into the output range and nowhere else", () => {
    const lut = levelsLUT(levels({ outBlack: 30, outWhite: 220 }));
    expect(Math.min(...lut)).toBe(30);
    expect(Math.max(...lut)).toBe(220);
  });

  it("inverts when outWhite is below outBlack", () => {
    const lut = levelsLUT(levels({ outBlack: 255, outWhite: 0 }));
    expect(lut[0]).toBe(255);
    expect(lut[255]).toBe(0);
    expect(isMonotone(lut, -1)).toBe(true);
  });

  it("lightens for gamma above 1 and darkens below it", () => {
    expect(levelsLUT(levels({ gamma: 2 }))[128]).toBeGreaterThan(128);
    expect(levelsLUT(levels({ gamma: 0.5 }))[128]).toBeLessThan(128);
    // The endpoints are anchored whatever the gamma.
    for (const gamma of [0.1, 0.5, 1, 2, 9.99]) {
      const lut = levelsLUT(levels({ gamma }));
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
      expect(isMonotone(lut)).toBe(true);
    }
  });

  it("survives degenerate parameters instead of producing NaN", () => {
    for (const p of [
      levels({ inBlack: 128, inWhite: 128 }), // zero span
      levels({ inBlack: 200, inWhite: 50 }), // inverted span
      levels({ gamma: 0 }),
      levels({ gamma: -3 }),
      levels({ gamma: 1e9 }),
      levels({ inBlack: -50, inWhite: 400, outBlack: -20, outWhite: 900 }),
    ]) {
      const lut = levelsLUT(p);
      expect(allFinite(lut)).toBe(true);
      expect(Math.min(...lut)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...lut)).toBeLessThanOrEqual(255);
    }
  });

  it("starts from a neutral spec", () => {
    const spec = defaultLevels();
    expect(spec.type).toBe("levels");
    for (const ch of ["rgb", "r", "g", "b"] as const) {
      expect(spec.channels[ch]).toEqual(IDENTITY_LEVELS);
    }
    // ...and the four channels must not alias one shared object.
    spec.channels.r.gamma = 2;
    expect(spec.channels.g.gamma).toBe(1);
  });
});

describe("curveSampler", () => {
  it("is the identity for the default two-point curve", () => {
    const f = curveSampler([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    for (const x of [0, 1, 63.5, 128, 200, 255]) expect(f(x)).toBeCloseTo(x, 9);
  });

  it("never overshoots a monotone control set", () => {
    // This is what Fritsch–Carlson buys over a plain cubic spline: with points
    // this asymmetric, a Catmull-Rom fit dips BELOW y=10 just after x=64 and
    // rings above 245 before x=192, which posterizes shadows and clips
    // highlights. The interpolant must stay inside each segment's y-range.
    const pts: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 64, y: 10 },
      { x: 192, y: 245 },
      { x: 255, y: 255 },
    ];
    const f = curveSampler(pts);
    for (let i = 0; i < pts.length - 1; i++) {
      const lo = Math.min(pts[i].y, pts[i + 1].y);
      const hi = Math.max(pts[i].y, pts[i + 1].y);
      for (let t = 0; t <= 1; t += 1 / 64) {
        const x = pts[i].x + (pts[i + 1].x - pts[i].x) * t;
        expect(f(x)).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(f(x)).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
    // ...and it is monotone over the whole domain, not just per segment.
    let prev = -Infinity;
    for (let x = 0; x <= 255; x += 0.25) {
      expect(f(x)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f(x);
    }
  });

  it("does not ring past a peak when the curve turns around", () => {
    // A non-monotone control set: up steeply, then down gently. Averaging the
    // two secant slopes at the peak would leave a positive tangent there, so
    // the curve would keep climbing past the control point and blow the
    // highlight it was placed to hold. The tangent must be flattened instead.
    const pts: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 40, y: 200 },
      { x: 255, y: 0 },
    ];
    const f = curveSampler(pts);
    let peak = -Infinity;
    for (let x = 0; x <= 255; x += 0.25) peak = Math.max(peak, f(x));
    expect(peak).toBeLessThanOrEqual(200 + 1e-9);
    expect(f(40)).toBeCloseTo(200, 9);
    // ...and it does not dip below the ends either.
    let low = Infinity;
    for (let x = 0; x <= 255; x += 0.25) low = Math.min(low, f(x));
    expect(low).toBeGreaterThanOrEqual(-1e-9);
  });

  it("passes exactly through its control points", () => {
    const pts: CurvePoint[] = [
      { x: 0, y: 20 },
      { x: 90, y: 40 },
      { x: 160, y: 200 },
      { x: 255, y: 230 },
    ];
    const f = curveSampler(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 9);
  });

  it("holds a flat segment perfectly flat", () => {
    // Equal y on both ends must not bow: a bulge here is visible banding.
    const f = curveSampler([
      { x: 0, y: 0 },
      { x: 80, y: 128 },
      { x: 180, y: 128 },
      { x: 255, y: 255 },
    ]);
    for (let x = 80; x <= 180; x += 5) expect(f(x)).toBeCloseTo(128, 9);
  });

  it("extends linearly past the end points, clamped to 0–255", () => {
    const f = curveSampler([
      { x: 64, y: 64 },
      { x: 192, y: 192 },
    ]);
    expect(f(0)).toBeCloseTo(0, 6);
    expect(f(255)).toBeCloseTo(255, 6);
    // A steep curve would run past the byte range; it must clamp, not wrap.
    const steep = curveSampler([
      { x: 100, y: 20 },
      { x: 150, y: 235 },
    ]);
    expect(steep(0)).toBe(0);
    expect(steep(255)).toBe(255);
  });

  it("copes with too few points, and with duplicates", () => {
    expect(curveSampler([])(77)).toBe(77); // no points → identity
    expect(curveSampler([{ x: 10, y: 200 }])(0)).toBe(200); // one point → constant
    // Two points at the same x: the first one given wins (the dedupe keeps the
    // head of each run), and the zero-width segment never divides by zero.
    const dup = curveSampler([
      { x: 0, y: 0 },
      { x: 128, y: 50 },
      { x: 128, y: 200 },
      { x: 255, y: 255 },
    ]);
    expect(dup(128)).toBeCloseTo(50, 9);
    expect(Number.isFinite(dup(64))).toBe(true);
    expect(Number.isFinite(dup(200))).toBe(true);
  });

  it("accepts points given out of order", () => {
    const a = curveSampler([
      { x: 255, y: 255 },
      { x: 0, y: 0 },
      { x: 128, y: 90 },
    ]);
    const b = curveSampler([
      { x: 0, y: 0 },
      { x: 128, y: 90 },
      { x: 255, y: 255 },
    ]);
    for (let x = 0; x <= 255; x += 17) expect(a(x)).toBeCloseTo(b(x), 12);
  });
});

describe("curveLUT", () => {
  it("samples the continuous curve at the 256 integers", () => {
    // Uint8ClampedArray rounds half-to-even, so compare against the continuous
    // curve with a half-step tolerance rather than against Math.round.
    const pts = CURVE_PRESETS["Increase Contrast"];
    const f = curveSampler(pts);
    const lut = curveLUT(pts);
    for (let v = 0; v < 256; v++) expect(Math.abs(lut[v] - f(v))).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("is the identity for the Linear preset", () => {
    expect([...curveLUT(CURVE_PRESETS.Linear)]).toEqual(Array.from({ length: 256 }, (_, v) => v));
  });

  it("inverts for the Negative preset", () => {
    const lut = curveLUT(CURVE_PRESETS.Negative);
    for (let v = 0; v < 256; v++) expect(lut[v]).toBe(255 - v);
  });

  it("moves shadows and highlights the way each preset's name claims", () => {
    const up = curveLUT(CURVE_PRESETS["Increase Contrast"]);
    expect(up[64]).toBeLessThan(64);
    expect(up[192]).toBeGreaterThan(192);
    const down = curveLUT(CURVE_PRESETS["Decrease Contrast"]);
    expect(down[64]).toBeGreaterThan(64);
    expect(down[192]).toBeLessThan(192);
    expect(curveLUT(CURVE_PRESETS["Lighten Midtones"])[128]).toBeGreaterThan(128);
    expect(curveLUT(CURVE_PRESETS["Darken Midtones"])[128]).toBeLessThan(128);
    // Every preset keeps black black and white white (except Negative).
    for (const [name, pts] of Object.entries(CURVE_PRESETS)) {
      if (name === "Negative") continue;
      const lut = curveLUT(pts);
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
      expect(isMonotone(lut)).toBe(true);
    }
  });

  it("starts from a neutral spec", () => {
    const spec = defaultCurves();
    for (const ch of ["rgb", "r", "g", "b"] as const) {
      expect([...curveLUT(spec.channels[ch])]).toEqual(Array.from({ length: 256 }, (_, v) => v));
    }
    spec.channels.r[0].y = 99;
    expect(spec.channels.g[0].y).toBe(0); // channels must not share point objects
  });
});

describe("composeLUT", () => {
  const a = new Uint8ClampedArray(Array.from({ length: 256 }, (_, v) => Math.min(255, v + 40)));
  const b = new Uint8ClampedArray(Array.from({ length: 256 }, (_, v) => Math.min(255, v * 2)));

  it("applies the composite table first", () => {
    const out = composeLUT(a, b);
    for (let v = 0; v < 256; v++) expect(out[v]).toBe(b[a[v]]);
  });

  it("...and the order really matters, so that check is not vacuous", () => {
    expect([...composeLUT(a, b)]).not.toEqual([...composeLUT(b, a)]);
  });

  it("is neutral when either side is the identity", () => {
    const id = new Uint8ClampedArray(Array.from({ length: 256 }, (_, v) => v));
    expect([...composeLUT(id, b)]).toEqual([...b]);
    expect([...composeLUT(a, id)]).toEqual([...a]);
  });
});

describe("buildLevelsLUTs / buildCurvesLUTs", () => {
  it("runs the master channel before the per-channel one", () => {
    const spec = defaultLevels();
    spec.channels.rgb = levels({ gamma: 0.5 }); // darken everything
    spec.channels.r = levels({ outBlack: 255, outWhite: 0 }); // then invert red
    const luts = buildLevelsLUTs(spec);
    const master = levelsLUT(spec.channels.rgb);
    const red = levelsLUT(spec.channels.r);
    for (let v = 0; v < 256; v++) expect(luts.r[v]).toBe(red[master[v]]);
    // Green and blue see only the master.
    for (let v = 0; v < 256; v++) expect(luts.g[v]).toBe(master[v]);
  });

  it("is the identity when nothing is adjusted", () => {
    for (const luts of [buildLevelsLUTs(defaultLevels()), buildCurvesLUTs(defaultCurves())]) {
      for (const ch of ["r", "g", "b"] as const) {
        expect([...luts[ch]]).toEqual(Array.from({ length: 256 }, (_, v) => v));
      }
    }
  });

  it("compiles curves per channel", () => {
    const spec = defaultCurves();
    spec.channels.b = CURVE_PRESETS.Negative.map((p) => ({ ...p }));
    const luts = buildCurvesLUTs(spec);
    expect(luts.b[0]).toBe(255);
    expect(luts.r[0]).toBe(0);
  });
});

describe("applyToneLUTs", () => {
  it("rewrites RGB in place and leaves alpha alone", () => {
    const img = new ImageData(new Uint8ClampedArray([10, 20, 30, 44, 200, 210, 220, 128]), 2, 1);
    const spec = defaultCurves();
    spec.channels.rgb = CURVE_PRESETS.Negative.map((p) => ({ ...p }));
    const same = applyToneLUTs(img, buildCurvesLUTs(spec));
    expect(same).toBe(img); // returned for chaining, not copied
    expect([...img.data]).toEqual([245, 235, 225, 44, 55, 45, 35, 128]);
  });
});

describe("16-bit tone path", () => {
  it("is the identity for a neutral spec", () => {
    const luts = buildLevelsLUTs16(defaultLevels());
    for (const i of [0, 1, 257, 30000, 65535]) expect(luts.r[i]).toBe(i);
  });

  it("agrees with the 8-bit table at the byte sample points", () => {
    const spec = defaultCurves();
    spec.channels.rgb = CURVE_PRESETS["Increase Contrast"].map((p) => ({ ...p }));
    spec.channels.g = CURVE_PRESETS["Lighten Midtones"].map((p) => ({ ...p }));
    const eight = buildCurvesLUTs(spec);
    const sixteen = buildCurvesLUTs16(spec);
    let sum = 0;
    for (let v = 0; v < 256; v++) {
      for (const ch of ["r", "g", "b"] as const) {
        const d = Math.abs(sixteen[ch][v * 257] / 257 - eight[ch][v]);
        // The 8-bit path rounds the master's output to a byte before the
        // per-channel curve sees it, and a steep channel curve magnifies that
        // half-step — so the two can differ by a shade over one level. Anything
        // beyond that would mean the two paths disagree about the maths, not
        // about precision.
        expect(d).toBeLessThanOrEqual(2);
        sum += d;
      }
    }
    expect(sum / (256 * 3)).toBeLessThan(0.5);
  });

  it("really is finer than 8 bits, not a widened byte table", () => {
    // The whole point of the high-bit path: composing master∘channel continuously
    // must give more than 256 distinct outputs, or nothing was gained.
    const spec = defaultCurves();
    spec.channels.rgb = CURVE_PRESETS["Increase Contrast"].map((p) => ({ ...p }));
    const luts = buildCurvesLUTs16(spec);
    const distinct = new Set<number>();
    for (let i = 0; i < 65536; i += 1) distinct.add(luts.r[i]);
    expect(distinct.size).toBeGreaterThan(4000);
    // A widened 8-bit table would land only on multiples of 257.
    let offGrid = 0;
    for (let i = 0; i < 65536; i++) if (luts.r[i] % 257 !== 0) offGrid++;
    expect(offGrid).toBeGreaterThan(1000);
  });

  it("stays monotone and in range for an extreme spec", () => {
    const spec = defaultLevels();
    spec.channels.rgb = levels({ inBlack: 30, inWhite: 210, gamma: 0.3 });
    const luts = buildLevelsLUTs16(spec);
    expect(isMonotone(luts.r)).toBe(true);
    expect(luts.r[0]).toBe(0);
    expect(luts.r[65535]).toBe(65535);
  });

  it("applies to an RGBA16 buffer in place, alpha untouched", () => {
    const spec = defaultLevels();
    spec.channels.rgb = levels({ outBlack: 255, outWhite: 0 }); // invert
    const buf = new Uint16Array([0, 32768, 65535, 12345]);
    applyToneLUTs16(buf, buildLevelsLUTs16(spec));
    expect(buf[0]).toBe(65535);
    expect(buf[1]).toBeGreaterThan(32000);
    expect(buf[1]).toBeLessThan(33500);
    expect(buf[2]).toBe(0);
    expect(buf[3]).toBe(12345); // alpha
  });
});

describe("autoLevels", () => {
  const flat = () => new Array(256).fill(0);
  const hist = (fill: (v: number) => number) => Array.from({ length: 256 }, (_, v) => fill(v));

  it("is a no-op on an empty histogram", () => {
    const h = { r: flat(), g: flat(), b: flat() };
    const a = autoLevels(h, 0.1);
    expect(a.r).toEqual(IDENTITY_LEVELS);
  });

  it("is a no-op on a single spike, where there is no range to stretch", () => {
    const spike = flat();
    spike[128] = 5000;
    const a = autoLevels({ r: spike, g: spike, b: spike }, 0.1);
    expect(a.r).toEqual(IDENTITY_LEVELS);
  });

  it("finds the occupied range with no clipping", () => {
    const h = hist((v) => (v >= 50 && v <= 200 ? 10 : 0));
    const a = autoLevels({ r: h, g: h, b: h }, 0);
    expect(a.r.inBlack).toBe(50);
    expect(a.r.inWhite).toBe(200);
    expect(a.r.outBlack).toBe(0);
    expect(a.r.outWhite).toBe(255);
    expect(a.r.gamma).toBe(1);
  });

  it("pulls the endpoints inward as the clip percentage rises", () => {
    const h = hist((v) => (v >= 50 && v <= 200 ? 10 : 0));
    const none = autoLevels({ r: h, g: h, b: h }, 0).r;
    const some = autoLevels({ r: h, g: h, b: h }, 10).r;
    expect(some.inBlack).toBeGreaterThan(none.inBlack);
    expect(some.inWhite).toBeLessThan(none.inWhite);
  });

  it("treats each channel separately, which is what neutralises a cast", () => {
    const red = hist((v) => (v >= 100 && v <= 240 ? 10 : 0));
    const blue = hist((v) => (v >= 5 && v <= 90 ? 10 : 0));
    const a = autoLevels({ r: red, g: red, b: blue }, 0);
    expect(a.r.inBlack).toBe(100);
    expect(a.b.inBlack).toBe(5);
    expect(a.b.inWhite).toBe(90);
  });

  it("clamps an absurd clip percentage instead of inverting the range", () => {
    const h = hist(() => 10);
    const a = autoLevels({ r: h, g: h, b: h }, 200).r;
    expect(a.inWhite).toBeGreaterThan(a.inBlack);
  });
});

describe("solveGrayPoint", () => {
  /** Push a sample through the gammas it solved for. */
  const neutralized = (sample: { r: number; g: number; b: number }) => {
    const s = solveGrayPoint(sample);
    return {
      r: levelsLUT(s.r)[sample.r],
      g: levelsLUT(s.g)[sample.g],
      b: levelsLUT(s.b)[sample.b],
    };
  };

  it("actually makes the sampled pixel neutral", () => {
    for (const sample of [
      { r: 200, g: 150, b: 100 },
      { r: 60, g: 90, b: 140 },
      { r: 10, g: 200, b: 40 },
      { r: 128, g: 128, b: 128 },
    ]) {
      const out = neutralized(sample);
      expect(Math.abs(out.r - out.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(out.g - out.b)).toBeLessThanOrEqual(2);
    }
  });

  it("targets the sample's own luminance, so the pixel keeps its brightness", () => {
    const sample = { r: 200, g: 150, b: 100 };
    const luma = 0.299 * 200 + 0.587 * 150 + 0.114 * 100;
    expect(Math.abs(neutralized(sample).g - luma)).toBeLessThanOrEqual(2);
  });

  it("is a near no-op on an already-neutral sample", () => {
    const s = solveGrayPoint({ r: 128, g: 128, b: 128 });
    for (const ch of ["r", "g", "b"] as const) expect(s[ch].gamma).toBeCloseTo(1, 2);
  });

  it("does not blow up on black or white", () => {
    for (const sample of [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 255, b: 0 },
    ]) {
      const s = solveGrayPoint(sample);
      for (const ch of ["r", "g", "b"] as const) {
        expect(Number.isFinite(s[ch].gamma)).toBe(true);
        expect(s[ch].gamma).toBeGreaterThanOrEqual(0.1);
        expect(s[ch].gamma).toBeLessThanOrEqual(9.99);
      }
    }
  });
});
