import { describe, expect, it } from "vitest";

import { blendInto, canBlendExactly } from "@/app/lib/blend";
import { BLEND_MAP, BLEND_MODES, blendOp } from "@/app/lib/layers";

/* This module exists because two canvas implementations disagreed about a blend,
   and neither of them was right. So the tests are written against PROPERTIES and
   against the W3C formulas — not against recorded output, which is what let the
   wrong answer stand for so long in the first place.

   The headline property is the one both rasterisers failed: blending a colour
   over ITSELF with Normal must return that colour, whatever the opacity. A
   filter that changes nothing must show nothing. */

const px = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a]);
const blend = (
  base: Uint8ClampedArray,
  top: Uint8ClampedArray,
  op: string,
  alpha: number,
): number[] => {
  const out = new Uint8ClampedArray(base.length);
  blendInto(out, base, top, op, alpha);
  return Array.from(out);
};

describe("blendInto — the identity property both canvases broke", () => {
  it("returns the colour unchanged when Normal-blending it over itself, at every value and opacity", () => {
    const bad: string[] = [];
    for (const alpha of [0.01, 0.25, 0.5, 0.7, 0.9, 0.99, 1]) {
      for (let v = 0; v < 256; v++) {
        const c = px(v, 102, 241);
        const got = blend(c, c, "source-over", alpha);
        if (got[0] !== v || got[1] !== 102 || got[2] !== 241 || got[3] !== 255)
          bad.push(`alpha ${alpha} value ${v} -> ${got.join(",")}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("preserves the COLOUR of a partially transparent pixel over itself — but not its alpha", () => {
    /* Alpha is not part of the identity and must not be asserted to be:
       source-over ACCUMULATES coverage, so a translucent copy laid over itself
       is legitimately more opaque than either. Only the colour has to survive. */
    for (const a of [1, 64, 128, 254, 255]) {
      const c = px(90, 140, 200, a);
      const got = blend(c, c, "source-over", 0.7);
      expect(got.slice(0, 3)).toEqual([90, 140, 200]);
      const as = (a / 255) * 0.7;
      const ab = a / 255;
      expect(got[3]).toBe(Math.round((as + ab * (1 - as)) * 255));
      expect(got[3]).toBeGreaterThanOrEqual(a);
    }
  });
});

describe("blendInto — source-over endpoints", () => {
  it("alpha 1 over an opaque backdrop replaces it exactly", () => {
    const base = px(10, 20, 30);
    const top = px(200, 150, 100);
    expect(blend(base, top, "source-over", 1)).toEqual([200, 150, 100, 255]);
  });

  it("alpha 0 leaves the backdrop exactly", () => {
    const base = px(10, 20, 30, 200);
    expect(blend(base, px(200, 150, 100), "source-over", 0)).toEqual([10, 20, 30, 200]);
  });

  it("a fully transparent source leaves the backdrop exactly, whatever its colour", () => {
    const base = px(10, 20, 30, 77);
    expect(blend(base, px(255, 0, 255, 0), "source-over", 1)).toEqual([10, 20, 30, 77]);
    // ...including under a blend mode, where Cs would otherwise be read.
    expect(blend(base, px(255, 0, 255, 0), "multiply", 1)).toEqual([10, 20, 30, 77]);
  });

  it("over a fully transparent backdrop the source shows through unblended", () => {
    const clear = px(0, 0, 0, 0);
    // Multiply against nothing must NOT darken: the (1 − ab) term is what
    // guarantees it, and dropping that term is a classic blend bug.
    expect(blend(clear, px(200, 150, 100), "multiply", 1)).toEqual([200, 150, 100, 255]);
    expect(blend(clear, px(200, 150, 100), "source-over", 1)).toEqual([200, 150, 100, 255]);
  });

  it("scales the source alpha by the opacity", () => {
    const out = blend(px(0, 0, 0, 0), px(255, 255, 255, 255), "source-over", 0.5);
    expect(out[3]).toBe(128);
  });

  it("clamps an out-of-range opacity rather than producing nonsense", () => {
    const base = px(10, 20, 30);
    const top = px(200, 150, 100);
    expect(blend(base, top, "source-over", 5)).toEqual(blend(base, top, "source-over", 1));
    expect(blend(base, top, "source-over", -3)).toEqual(blend(base, top, "source-over", 0));
  });
});

describe("blendInto — separable modes against the W3C formulas", () => {
  /* Opaque over opaque at alpha 1, where the composite collapses to B(Cb, Cs)
     and the formula can be written out directly. */
  const cases: Array<[string, (b: number, s: number) => number]> = [
    ["multiply", (b, s) => b * s],
    ["screen", (b, s) => b + s - b * s],
    ["darken", (b, s) => Math.min(b, s)],
    ["lighten", (b, s) => Math.max(b, s)],
    ["difference", (b, s) => Math.abs(b - s)],
    ["exclusion", (b, s) => b + s - 2 * b * s],
    ["hard-light", (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1))],
    ["overlay", (b, s) => (b <= 0.5 ? s * 2 * b : s + (2 * b - 1) - s * (2 * b - 1))],
  ];
  for (const [op, f] of cases) {
    it(`${op} matches the spec at every 8-bit pair on a sampled grid`, () => {
      const bad: string[] = [];
      for (let b = 0; b < 256; b += 7)
        for (let s = 0; s < 256; s += 11) {
          const got = blend(px(b, b, b), px(s, s, s), op, 1)[0];
          const want = Math.round(f(b / 255, s / 255) * 255);
          if (got !== want) bad.push(`${op} b=${b} s=${s} got ${got} want ${want}`);
        }
      expect(bad).toEqual([]);
    });
  }

  it("color-dodge keeps a black backdrop black even under a white source", () => {
    expect(blend(px(0, 0, 0), px(255, 255, 255), "color-dodge", 1)).toEqual([0, 0, 0, 255]);
  });

  it("color-burn keeps a white backdrop white even under a black source", () => {
    expect(blend(px(255, 255, 255), px(0, 0, 0), "color-burn", 1)).toEqual([255, 255, 255, 255]);
  });

  it("color-dodge saturates to white where the source is white and the backdrop is not black", () => {
    expect(blend(px(128, 128, 128), px(255, 255, 255), "color-dodge", 1)).toEqual([255, 255, 255, 255]);
  });

  it("soft-light leaves the backdrop alone at a mid-grey source", () => {
    // s = 0.5 is the neutral point: b − (1 − 2·0.5)·b·(1 − b) = b.
    for (const v of [0, 40, 128, 200, 255])
      expect(blend(px(v, v, v), px(128, 128, 128), "soft-light", 1)[0]).toBe(
        Math.round((v / 255 - (1 - (2 * 128) / 255) * (v / 255) * (1 - v / 255)) * 255),
      );
  });

  it("multiply by white and screen by black are both identities", () => {
    for (const v of [0, 33, 128, 222, 255]) {
      expect(blend(px(v, v, v), px(255, 255, 255), "multiply", 1)[0]).toBe(v);
      expect(blend(px(v, v, v), px(0, 0, 0), "screen", 1)[0]).toBe(v);
    }
  });
});

describe("blendInto — non-separable modes", () => {
  const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

  it("luminosity takes the source's luminosity and the backdrop's colour", () => {
    const out = blend(px(200, 60, 30), px(90, 90, 90), "luminosity", 1);
    expect(lum(out[0], out[1], out[2])).toBeCloseTo(lum(90, 90, 90), 0);
  });

  it("color takes the backdrop's luminosity and the source's colour", () => {
    const out = blend(px(90, 90, 90), px(200, 60, 30), "color", 1);
    expect(lum(out[0], out[1], out[2])).toBeCloseTo(lum(90, 90, 90), 0);
  });

  it("saturation over a grey backdrop stays grey (there is no hue to saturate)", () => {
    const out = blend(px(120, 120, 120), px(200, 60, 30), "saturation", 1);
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
  });

  it("hue keeps the backdrop's luminosity", () => {
    const out = blend(px(80, 130, 200), px(200, 60, 30), "hue", 1);
    expect(lum(out[0], out[1], out[2])).toBeCloseTo(lum(80, 130, 200), 0);
  });

  it("clips back into gamut rather than emitting out-of-range channels", () => {
    // A very bright source luminosity forced onto a saturated backdrop is the
    // case that pushes a channel past 1 before ClipColor pulls it back.
    const out = blend(px(255, 0, 0), px(250, 250, 250), "luminosity", 1);
    for (const v of out.slice(0, 3)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe("blendInto — lighter is PLUS, not a blend mode", () => {
  it("adds the premultiplied colours", () => {
    expect(blend(px(10, 20, 30), px(40, 50, 60), "lighter", 1)).toEqual([50, 70, 90, 255]);
  });

  it("clamps rather than wrapping", () => {
    expect(blend(px(200, 200, 200), px(200, 200, 200), "lighter", 1)).toEqual([255, 255, 255, 255]);
  });

  it("scales the addition by the opacity", () => {
    expect(blend(px(10, 20, 30), px(40, 50, 60), "lighter", 0.5)).toEqual([30, 45, 60, 255]);
  });
});

describe("blendInto — buffer handling", () => {
  it("gives the same answer whether or not the output aliases the source", () => {
    const base = new Uint8ClampedArray([10, 20, 30, 255, 200, 150, 100, 128]);
    const top = new Uint8ClampedArray([90, 80, 70, 200, 5, 15, 25, 255]);
    const separate = new Uint8ClampedArray(base.length);
    blendInto(separate, base, top, "multiply", 0.6);
    const aliased = top.slice();
    blendInto(aliased, base, aliased, "multiply", 0.6);
    expect(Array.from(aliased)).toEqual(Array.from(separate));
  });

  it("never reads the backdrop it has already overwritten (multi-pixel run)", () => {
    // Two pixels with very different values: if the loop wrote pixel 0 and then
    // read it back as the backdrop for pixel 1, the second would be wrong.
    const base = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const top = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const out = new Uint8ClampedArray(base.length);
    blendInto(out, base, top, "source-over", 1);
    expect(Array.from(out)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it("leaves an unknown op behaving as source-over, exactly as blendOp does", () => {
    const base = px(10, 20, 30);
    const top = px(200, 150, 100);
    expect(blend(base, top, "no-such-op", 0.5)).toEqual(blend(base, top, "source-over", 0.5));
  });
});

describe("blendInto covers every mode the app can actually select", () => {
  it("evaluates every op BLEND_MAP produces without falling back", () => {
    const unhandled = BLEND_MODES.filter((m) => !canBlendExactly(blendOp(m)));
    expect(unhandled).toEqual([]);
  });

  it("…and every op in the table, including modes not offered in the UI", () => {
    const unhandled = Object.values(BLEND_MAP).filter((op) => !canBlendExactly(op));
    expect(unhandled).toEqual([]);
  });

  it("treats the approximated modes exactly as BLEND_MAP says, not as their true formula", () => {
    // Dissolve → source-over and Linear Burn → multiply are documented
    // approximations in BLEND_MAP. Keying on the OP rather than the mode name is
    // what keeps this module from silently diverging from the compositor.
    const base = px(120, 130, 140);
    const top = px(60, 70, 80);
    expect(blend(base, top, blendOp("Dissolve"), 0.5)).toEqual(blend(base, top, "source-over", 0.5));
    expect(blend(base, top, blendOp("Linear Burn"), 0.5)).toEqual(blend(base, top, "multiply", 0.5));
  });
});
