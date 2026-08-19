import { describe, expect, it } from "vitest";

import {
  REGION_WORTH_IT,
  addReach,
  effectsPositionDependent,
  effectsReach,
  filterReach,
  nodeReach,
  padRect,
  regionWorthIt,
  stackReach,
  type Reach,
} from "@/app/lib/reach";
import type { SmartFilter } from "@/app/lib/filters";
import type { LayerEffects } from "@/app/lib/effects";

/* These numbers are a CORRECTNESS contract, not a tuning knob. The region-scoped
   recompute repaints a rect grown by the reach and keeps the cached pixels
   outside it, so an UNDER-estimate leaves a seam at the border of the repaint —
   wrong pixels that no test looking only at the middle would notice. Over-
   estimating merely costs efficiency. Every check below is written from that
   asymmetry: bigger-is-safe, smaller-is-a-bug. */

const f = (type: string, params: Record<string, unknown>, enabled = true) =>
  ({ type, enabled, params } as unknown as SmartFilter);

/** Every filter type reach.ts claims to know about. */
const SAFE_BLURS = ["box", "gaussian", "bokeh", "surface", "spread", "motion"];
const UNSAFE_BLURS = ["zoom", "spin", "tiltshift"];

describe("combining reaches", () => {
  it("adds two bounded reaches — a stack spreads what the previous one spread", () => {
    expect(addReach(3, 4)).toBe(7);
    expect(addReach(0, 0)).toBe(0);
  });

  it("lets an unsafe member poison the whole stack", () => {
    expect(addReach(null, 4)).toBeNull();
    expect(addReach(4, null)).toBeNull();
    expect(addReach(null, null)).toBeNull();
  });

  it("makes a stack unsafe if ANY filter is", () => {
    expect(stackReach([f("blur", { kind: "gaussian", amount: 5 })])).toBe(5);
    expect(
      stackReach([
        f("blur", { kind: "gaussian", amount: 5 }),
        f("noise", { amount: 10 }),
        f("blur", { kind: "gaussian", amount: 7 }),
      ]),
    ).toBeNull();
  });

  it("sums a stack of safe filters", () => {
    expect(
      stackReach([
        f("blur", { kind: "gaussian", amount: 5 }),
        f("sharpen", { radius: 3 }),
        f("median", { radius: 2 }),
      ]),
    ).toBe(10);
  });

  it("treats an empty or missing stack as reaching nothing", () => {
    expect(stackReach([])).toBe(0);
    expect(stackReach(undefined)).toBe(0);
  });

  it("ignores DISABLED filters entirely — including unsafe ones", () => {
    expect(filterReach(f("noise", { amount: 10 }, false))).toBe(0);
    expect(stackReach([f("noise", { amount: 10 }, false)])).toBe(0);
  });
});

describe("filter reach", () => {
  it("is the radius for the isotropic blurs", () => {
    for (const kind of SAFE_BLURS) expect(filterReach(f("blur", { kind, amount: 12 }))).toBe(12);
  });

  /* These read the pixel's absolute position (an anchor, or a band in document
     coordinates), so a crop changes the answer no matter how much padding it
     gets. That is a different property from reach, and conflating them is the
     bug this module exists to prevent. */
  it("refuses the position-dependent blurs whatever their radius", () => {
    for (const kind of UNSAFE_BLURS) {
      expect(filterReach(f("blur", { kind, amount: 1 }))).toBeNull();
      expect(filterReach(f("blur", { kind, amount: 500 }))).toBeNull();
    }
  });

  it("refuses every filter anchored to the image origin or a global statistic", () => {
    const unsafe: [string, Record<string, unknown>][] = [
      ["noise", { amount: 20 }],
      ["pixelate", { size: 8 }],
      ["distort", { mode: "twirl", amount: 30 }],
      ["halftone", { size: 6 }],
      ["crystallize", { size: 10 }],
      ["glitch", { amount: 20 }],
      ["dehaze", { amount: 40 }],
      ["grain", { amount: 20, size: 2 }],
      ["lens", { distortion: 10 }],
    ];
    for (const [type, params] of unsafe) expect(filterReach(f(type, params))).toBeNull();
  });

  it("gives the local window filters their radius", () => {
    expect(filterReach(f("sharpen", { radius: 4 }))).toBe(4);
    expect(filterReach(f("highpass", { radius: 6 }))).toBe(6);
    expect(filterReach(f("median", { radius: 3 }))).toBe(3);
    expect(filterReach(f("dustscratches", { radius: 5 }))).toBe(5);
    expect(filterReach(f("oil", { radius: 7 }))).toBe(7);
    expect(filterReach(f("clarity", { radius: 9 }))).toBe(9);
  });

  it("doubles denoise's radius, because its chroma pass reaches twice as far", () => {
    expect(filterReach(f("denoise", { radius: 5 }))).toBe(10);
  });

  it("handles the stylize modes by what they actually sample", () => {
    expect(filterReach(f("stylize", { mode: "posterize", levels: 4 }))).toBe(0);
    expect(filterReach(f("stylize", { mode: "threshold", level: 128 }))).toBe(0);
    expect(filterReach(f("stylize", { mode: "findEdges" }))).toBe(1);
    expect(filterReach(f("stylize", { mode: "emboss", height: 5 }))).toBe(6);
    // A negative height is still a distance.
    expect(filterReach(f("stylize", { mode: "emboss", height: -5 }))).toBe(6);
  });

  it("adds canvasshadow's offset to its blur, in either direction", () => {
    expect(filterReach(f("canvasshadow", { distance: 8, size: 10 }))).toBe(18);
    expect(filterReach(f("canvasshadow", { distance: -8, size: 10 }))).toBe(18);
  });

  /* A filter type nobody has taught this module about must NOT be assumed safe —
     the default has to be "refuse", or adding a filter silently corrupts every
     region-scoped render that uses it. */
  it("refuses an unknown filter type rather than guessing", () => {
    expect(filterReach(f("something-invented-later", { radius: 3 }))).toBeNull();
  });

  it("never shrinks when a spatial parameter grows", () => {
    for (const r of [0, 1, 2, 5, 13, 60, 250]) {
      const prev = filterReach(f("blur", { kind: "gaussian", amount: r === 0 ? 0 : r - 1 })) as number;
      expect(filterReach(f("blur", { kind: "gaussian", amount: r })) as number).toBeGreaterThanOrEqual(prev);
    }
  });

  it("rounds fractional radii UP", () => {
    expect(filterReach(f("blur", { kind: "gaussian", amount: 4.1 }))).toBe(5);
    expect(filterReach(f("sharpen", { radius: 0.2 }))).toBe(1);
  });
});

describe("effects reach", () => {
  const fx = (over: Partial<LayerEffects>): LayerEffects => over as LayerEffects;
  const on = <T,>(o: T) => ({ enabled: true, ...o }) as never;

  it("is nothing for no effects", () => {
    expect(effectsReach(undefined)).toBe(0);
    expect(effectsReach(fx({}))).toBe(0);
  });

  it("adds a shadow's travel to its blur", () => {
    expect(effectsReach(fx({ dropShadow: on({ distance: 8, size: 10 }) }))).toBe(18);
    expect(effectsReach(fx({ innerShadow: on({ distance: 6, size: 4 }) }))).toBe(10);
  });

  it("takes the size of the glows, the stroke and the bevel", () => {
    expect(effectsReach(fx({ outerGlow: on({ size: 12 }) }))).toBe(12);
    expect(effectsReach(fx({ innerGlow: on({ size: 9 }) }))).toBe(9);
    expect(effectsReach(fx({ stroke: on({ size: 3, fillType: "color" }) }))).toBe(3);
    expect(effectsReach(fx({ bevel: on({ size: 8, soften: 4 }) }))).toBe(12);
  });

  it("takes the MAXIMUM across effects, not the sum — they render independently", () => {
    const r = effectsReach(
      fx({ dropShadow: on({ distance: 8, size: 10 }), outerGlow: on({ size: 40 }) }),
    );
    expect(r).toBe(40);
  });

  it("ignores disabled effects", () => {
    expect(effectsReach(fx({ dropShadow: { enabled: false, distance: 99, size: 99 } as never }))).toBe(0);
  });

  it("scales with fx.scale, which resizes every spatial param at render time", () => {
    const base = fx({ outerGlow: on({ size: 20 }) });
    expect(effectsReach({ ...base, scale: 100 })).toBe(20);
    expect(effectsReach({ ...base, scale: 200 })).toBe(40);
    expect(effectsReach({ ...base, scale: 50 })).toBe(10);
  });

  it("treats a colour overlay as per-pixel — inside the silhouette, no spread", () => {
    expect(effectsReach(fx({ colorOverlay: on({}) }))).toBe(0);
  });

  it("never shrinks when an effect grows", () => {
    let prev = 0;
    for (const size of [0, 1, 5, 20, 100, 250]) {
      const r = effectsReach(fx({ outerGlow: on({ size }) })) as number;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe("position dependence", () => {
  const fx = (over: Partial<LayerEffects>): LayerEffects => over as LayerEffects;

  /* Both of these read the canvas they are handed — `cx = w/2`, `half = max(w,h)/2`
     — so a sub-canvas silently moves and rescales the gradient. Reach cannot
     express that, which is why it is a separate predicate. */
  it("flags a gradient overlay", () => {
    expect(effectsPositionDependent(fx({ gradientOverlay: { enabled: true } as never }))).toBe(true);
  });

  it("flags a gradient-filled stroke but not a colour one", () => {
    expect(
      effectsPositionDependent(fx({ stroke: { enabled: true, fillType: "gradient" } as never })),
    ).toBe(true);
    expect(
      effectsPositionDependent(fx({ stroke: { enabled: true, fillType: "color" } as never })),
    ).toBe(false);
  });

  it("does not let a DISABLED effect disqualify the stack", () => {
    expect(effectsPositionDependent(fx({ gradientOverlay: { enabled: false } as never }))).toBe(false);
    expect(
      effectsPositionDependent(fx({ stroke: { enabled: false, fillType: "gradient" } as never })),
    ).toBe(false);
  });

  it("passes everything derived from nearby alpha", () => {
    expect(
      effectsPositionDependent(
        fx({
          dropShadow: { enabled: true } as never,
          outerGlow: { enabled: true } as never,
          innerGlow: { enabled: true } as never,
          bevel: { enabled: true } as never,
          colorOverlay: { enabled: true } as never,
        }),
      ),
    ).toBe(false);
    expect(effectsPositionDependent(undefined)).toBe(false);
  });
});

describe("a node's total reach", () => {
  it("adds the filters to the effects — filters run first, then fx", () => {
    const r = nodeReach(
      [f("blur", { kind: "gaussian", amount: 5 })],
      { outerGlow: { enabled: true, size: 10 } } as LayerEffects,
    );
    expect(r).toBe(15);
  });

  it("is unsafe when either half is", () => {
    expect(nodeReach([f("noise", { amount: 1 })], undefined)).toBeNull();
  });

  it("is zero for a bare node", () => {
    expect(nodeReach(undefined, undefined)).toBe(0);
  });
});

describe("padding a rect", () => {
  it("grows it in every direction", () => {
    expect(padRect({ x: 50, y: 40, w: 10, h: 20 }, 5, 1000, 1000)).toEqual({ x: 45, y: 35, w: 20, h: 30 });
  });

  it("clamps to the document rather than going negative or overhanging", () => {
    expect(padRect({ x: 2, y: 3, w: 10, h: 10 }, 20, 100, 100)).toEqual({ x: 0, y: 0, w: 32, h: 33 });
    expect(padRect({ x: 90, y: 90, w: 10, h: 10 }, 20, 100, 100)).toEqual({ x: 70, y: 70, w: 30, h: 30 });
  });

  it("covers the whole document when the padding swamps it", () => {
    expect(padRect({ x: 40, y: 40, w: 5, h: 5 }, 9999, 100, 80)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
  });

  it("rounds outward, never inward — a half-pixel lost is a seam", () => {
    const r = padRect({ x: 10.6, y: 10.6, w: 5.5, h: 5.5 }, 0, 100, 100);
    expect(r.x).toBe(10);
    expect(r.y).toBe(10);
    expect(r.x + r.w).toBeGreaterThanOrEqual(16.1);
  });

  it("never returns a negative size", () => {
    const r = padRect({ x: 5, y: 5, w: 0, h: 0 }, 0, 100, 100);
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.h).toBeGreaterThanOrEqual(0);
  });
});

describe("is the region worth it", () => {
  it("says yes for a small region", () => {
    expect(regionWorthIt({ w: 100, h: 100 }, 1920, 1080)).toBe(true);
  });

  it("says no once it covers most of the document — the full pass is cheaper", () => {
    expect(regionWorthIt({ w: 1920, h: 1080 }, 1920, 1080)).toBe(false);
  });

  it("switches at the documented share", () => {
    // Just under REGION_WORTH_IT of the document, and just over.
    expect(regionWorthIt({ w: 1000, h: Math.floor(REGION_WORTH_IT * 1000) - 1 }, 1000, 1000)).toBe(true);
    expect(regionWorthIt({ w: 1000, h: Math.ceil(REGION_WORTH_IT * 1000) + 1 }, 1000, 1000)).toBe(false);
  });

  it("refuses a degenerate document instead of dividing by zero", () => {
    expect(regionWorthIt({ w: 10, h: 10 }, 0, 0)).toBe(false);
  });
});

describe("the reaches the engine actually relies on", () => {
  /* The default drop shadow is the shape the big-document benchmark measures and
     the one the region rail proves byte-identical. Pin it so a change to the
     defaults cannot quietly widen or narrow the repainted rect. */
  it("pins the default drop shadow", () => {
    const r: Reach = effectsReach({
      dropShadow: { enabled: true, distance: 8, size: 10, spread: 0 },
    } as LayerEffects);
    expect(r).toBe(18);
  });
});
