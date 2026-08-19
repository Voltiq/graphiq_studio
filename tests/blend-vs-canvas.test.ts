import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { blendInto } from "@/app/lib/blend";

/* STRUCTURAL check against a real Chromium canvas.
 *
 * The canvas is NOT the reference for correctness here — it demonstrably rounds a
 * blend wrong, which is the whole reason app/lib/blend.ts exists (see its header
 * for the measurement). It is the reference for STRUCTURE: if a mode's operands
 * were swapped, a formula transcribed wrongly, or a non-separable mode's
 * luminosity/saturation steps ordered wrongly, the disagreement would be tens of
 * levels. Rounding disagreement is one or two.
 *
 * So every op must agree with the canvas to within a small tolerance, and the
 * fixture is a captured grid of 16 backdrops x 16 sources at two opacities.
 * Regenerate it with scratchpad capture if the op list ever changes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "golden", "canvas-blends.json"), "utf8")) as {
  W: number;
  H: number;
  backdrop: number[];
  source: number[];
  canvas: Record<string, number[]>;
};

/** How far an op may sit from the canvas. Set to the MEASURED maximum across
 *  every op in the fixture, not to a comfortable margin: the observed worst is 2
 *  (source-over, exclusion, difference and hard-light at 0.7; everything else is
 *  0 or 1), so 2 is as tight as this check can be while still passing, and any
 *  structural error — swapped operands, a mistranscribed formula, the
 *  non-separable steps out of order — lands tens of levels away. The fixture is
 *  captured and checked in, so this is deterministic rather than a live canvas. */
const TOLERANCE = 2;

describe("blendInto agrees structurally with the canvas", () => {
  const base = new Uint8ClampedArray(fixture.backdrop);
  const top = new Uint8ClampedArray(fixture.source);

  for (const key of Object.keys(fixture.canvas)) {
    const [op, alphaText] = key.split("@");
    const alpha = Number(alphaText);
    it(`${op} at alpha ${alpha}`, () => {
      const out = new Uint8ClampedArray(base.length);
      blendInto(out, base, top, op, alpha);
      const want = fixture.canvas[key];
      let worst = 0;
      let worstAt = -1;
      for (let i = 0; i < out.length; i++) {
        const d = Math.abs(out[i] - want[i]);
        if (d > worst) {
          worst = d;
          worstAt = i;
        }
      }
      const px = (worstAt >> 2) * 4;
      expect(
        worst,
        `worst Δ ${worst} at byte ${worstAt}: backdrop ${base.slice(px, px + 4)} source ` +
          `${top.slice(px, px + 4)} → ours ${out.slice(px, px + 4)} canvas ${want.slice(px, px + 4)}`,
      ).toBeLessThanOrEqual(TOLERANCE);
    });
  }

  it("the fixture is non-trivial (a broken capture would make every check vacuous)", () => {
    // Distinct backdrops and sources, and at least one op that actually changes
    // the pixels — otherwise "agrees with the canvas" means nothing.
    expect(new Set(fixture.backdrop.join(",").split(",")).size).toBeGreaterThan(8);
    const normal = fixture.canvas["multiply@1"];
    expect(normal.some((v, i) => v !== fixture.backdrop[i])).toBe(true);
  });
});
