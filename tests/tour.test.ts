import { describe, expect, it } from "vitest";
import { MOBILE_TOUR_STEPS, TOUR_STEPS, tourSteps, type TourStep } from "../app/lib/tour";

/**
 * The onboarding tour has two laps, and the reason is measured rather than
 * stylistic: three of the desktop lap's six spotlights pointed at nothing on a
 * phone. The tools rail is a closed drawer at x=-320 (visible area **zero**),
 * the panels sheet is parked below the fold with only the MobileBar's own strip
 * showing, and the desktop status bar is `display: none`, which collapses its
 * spotlight to the 12×12 dot the padding leaves in the corner.
 *
 * What a browser has to prove — that each spotlight lands on live chrome — is
 * in `tools/verify-tour.js`. What is worth pinning here is the shape of the
 * lists, and the one rule that would silently undo the fix.
 */

/** The three the mobile shell hides or parks off-screen. Measured; see above. */
const HIDDEN_ON_MOBILE = ["toolbar", "dock", "status"];

const shapeOf = (label: string, steps: TourStep[]) => {
  describe(label, () => {
    it("has enough steps to be a lap", () => {
      expect(steps.length).toBeGreaterThanOrEqual(5);
    });

    it("gives every step a unique id", () => {
      const ids = steps.map((s) => s.id);
      expect(ids.length).toBe(new Set(ids).size);
    });

    it("gives every step something to read", () => {
      const empty = steps.filter((s) => !s.title.trim() || !s.body.trim());
      expect(empty.map((s) => s.id)).toEqual([]);
    });

    /* Opening and closing on a CENTRED card is what makes the tour safe on any
       layout: those two steps depend on no element existing at all, so the
       first thing shown and the last can never be an empty rectangle. */
    it("opens and closes on a centred card", () => {
      expect(steps[0].target).toBeUndefined();
      expect(steps[steps.length - 1].target).toBeUndefined();
    });

    it("spotlights each target at most once", () => {
      const targets = steps.flatMap((s) => (s.target ? [s.target] : []));
      expect(targets.length).toBe(new Set(targets).size);
    });
  });
};

shapeOf("the desktop lap", TOUR_STEPS);
shapeOf("the phone's lap", MOBILE_TOUR_STEPS);

describe("the two laps", () => {
  /* The rule that would silently undo the fix. Adding one of these back to the
     mobile list compiles, renders, and shows a first-run phone user an empty
     rectangle — exactly the bug, and nothing else here would notice. */
  it("never sends the phone at chrome the phone hides", () => {
    const bad = MOBILE_TOUR_STEPS.filter((s) => s.target && HIDDEN_ON_MOBILE.includes(s.target));
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  it("…and the desktop lap does use them, or the list above is stale", () => {
    const used = TOUR_STEPS.flatMap((s) => (s.target ? [s.target] : []));
    expect(HIDDEN_ON_MOBILE.every((t) => used.includes(t))).toBe(true);
  });

  it("hands out the lap that matches the shell", () => {
    expect(tourSteps(true)).toBe(MOBILE_TOUR_STEPS);
    expect(tourSteps(false)).toBe(TOUR_STEPS);
  });

  /* Two lists of different lengths is the point, and also the hazard: reading
     the step from one and the length from the other lands the tour on the wrong
     card, or never on the last one. TourOverlay derives both from `steps`. */
  it("really are different laps, not one list twice", () => {
    expect(MOBILE_TOUR_STEPS).not.toBe(TOUR_STEPS);
    expect(MOBILE_TOUR_STEPS.map((s) => s.body)).not.toEqual(TOUR_STEPS.map((s) => s.body));
  });

  /* The desktop bodies teach Ctrl+K, hovering for a shortcut, Ctrl+wheel and
     Space-drag. A phone has none of those. */
  it("keeps keyboard-and-mouse instructions off the phone's lap", () => {
    const mouseAndKeys = /Ctrl\+|hover|wheel|Space-drag|right-click/i;
    const offending = MOBILE_TOUR_STEPS.filter((s) => mouseAndKeys.test(s.body));
    expect(offending.map((s) => s.id)).toEqual([]);
    // …and the desktop lap does teach them, or the pattern above proves nothing.
    expect(TOUR_STEPS.some((s) => mouseAndKeys.test(s.body))).toBe(true);
  });
});
