import { describe, expect, it } from "vitest";
import {
  MOBILE_TOUR_STEPS,
  TOUR_STEPS,
  passesThrough,
  tourSteps,
  type TourStep,
  type TourWatch,
} from "../app/lib/tour";

/**
 * The onboarding tour has two laps, and the reason is measured rather than
 * stylistic: three of the desktop lap's spotlights pointed at nothing on a
 * phone. The tools rail is a closed drawer at x=-320 (visible area **zero**),
 * the panels sheet is parked below the fold with only the MobileBar's own strip
 * showing, and the desktop status bar is `display: none`, which collapses its
 * spotlight to the 12×12 dot the padding leaves in the corner.
 *
 * What a browser has to prove — that each spotlight lands on live chrome, that
 * a try-it reaches the app and notices — is in `e2e/tour.spec.ts`. What is
 * worth pinning here is the shape of the lists, what each try-it counts as
 * done, and the rules that would silently undo a fix.
 */

/** The three the mobile shell hides or parks off-screen. Measured; see above. */
const HIDDEN_ON_MOBILE = ["toolbar", "dock", "status"];

/** Every word a stop shows: what a phone user reads, not only the body. */
const wordsOf = (s: TourStep) =>
  [
    s.eyebrow,
    s.title,
    s.body,
    ...(s.tips ?? []).flatMap((t) => [t.text, ...(t.keys ?? [])]),
    s.try?.prompt ?? "",
    s.try?.praise ?? "",
  ].join(" ");

const shapeOf = (label: string, steps: TourStep[]) => {
  describe(label, () => {
    it("has enough steps to be a lap", () => {
      expect(steps.length).toBeGreaterThanOrEqual(8);
    });

    it("gives every step a unique id", () => {
      const ids = steps.map((s) => s.id);
      expect(ids.length).toBe(new Set(ids).size);
    });

    it("gives every step something to read, and a heading to read it under", () => {
      const empty = steps.filter((s) => !s.title.trim() || !s.body.trim() || !s.eyebrow.trim());
      expect(empty.map((s) => s.id)).toEqual([]);
    });

    it("gives every tip words, and every key cap a label", () => {
      const tips = steps.flatMap((s) => s.tips ?? []);
      expect(tips.filter((t) => !t.text.trim())).toEqual([]);
      // "Ctrl+K" draws two caps; "Ctrl+" or "+K" would draw an empty one.
      const caps = tips.flatMap((t) => t.keys ?? []).flatMap((k) => k.split("+"));
      expect(caps.filter((c) => !c.trim())).toEqual([]);
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

    /* A try-it is done THROUGH the spotlight: on a centred card there is
       nothing for the pointer to reach. */
    it("asks you to try things only where it points at something", () => {
      const tries = steps.filter((s) => s.try);
      expect(tries.length).toBeGreaterThanOrEqual(2);
      expect(tries.filter((s) => !s.target).map((s) => s.id)).toEqual([]);
      expect(tries.filter((s) => !s.try!.prompt.trim() || !s.try!.praise.trim()).map((s) => s.id)).toEqual([]);
    });

    it("ends on the cheat sheet", () => {
      const last = steps[steps.length - 1];
      expect(last.sheet).toBe(true);
      expect(last.tips?.length ?? 0).toBeGreaterThanOrEqual(4);
    });
  });
};

shapeOf("the desktop lap", TOUR_STEPS);
shapeOf("the phone's lap", MOBILE_TOUR_STEPS);

describe("the try-its", () => {
  const at: TourWatch = { tool: "brush", zoom: 67 };
  const tries = [...TOUR_STEPS, ...MOBILE_TOUR_STEPS].filter((s) => s.try);

  /* The one thing every try-it must get right: the stop opens NOT done. A
     check that passed on arrival would praise you for nothing. */
  it("are not done the moment they open", () => {
    expect(tries.filter((s) => s.try!.done(at, at)).map((s) => s.id)).toEqual([]);
  });

  it("notice a different tool where they ask for one", () => {
    const tool = tries.filter((s) => s.id === "toolbar" || s.id === "mobilebar");
    expect(tool.length).toBe(2);
    for (const s of tool) {
      expect(s.try!.done({ ...at, tool: "move" }, at), s.id).toBe(true);
      expect(s.try!.done({ ...at, zoom: 200 }, at), `${s.id}: zooming is not changing tool`).toBe(false);
    }
  });

  it("notice a zoom where they ask for one, either way", () => {
    const zoom = tries.filter((s) => s.id === "canvas");
    expect(zoom.length).toBe(2);
    for (const s of zoom) {
      expect(s.try!.done({ ...at, zoom: 100 }, at), s.id).toBe(true);
      expect(s.try!.done({ ...at, zoom: 50 }, at), s.id).toBe(true);
      expect(s.try!.done({ ...at, tool: "hand" }, at), `${s.id}: a tool is not a zoom`).toBe(false);
    }
  });

  /* On the desktop the canvas try-it lets only the wheel through: a click on
     the canvas with the brush in hand would paint on the picture. The phone's
     needs two fingers on the stage, so it lets the pointer through. */
  it("reach the canvas by the wheel on a desktop, by touch on a phone", () => {
    expect(TOUR_STEPS.find((s) => s.id === "canvas")!.try!.reach).toBe("wheel");
    expect(MOBILE_TOUR_STEPS.find((s) => s.id === "canvas")!.try!.reach ?? "pointer").toBe("pointer");
  });

  /* The bottom bar's grid and stack open sheets — which would come up beneath
     the tour, out of reach. Only the four tools are let through. */
  it("let the phone reach only the bottom bar's tools", () => {
    expect(MOBILE_TOUR_STEPS.find((s) => s.id === "mobilebar")!.try!.hit).toBe("[data-quick]");
  });
});

describe("the keys a try-it lets through", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    passesThrough({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("a tool's letter, plain or shifted (Shift cycles a shared slot)", () => {
    expect(["v", "b", "m", "V", "W"].every((k) => key(k))).toBe(true);
  });

  it("the brush size keys", () => {
    expect(key("[") && key("]")).toBe(true);
  });

  it("the zoom shortcuts, with Ctrl or Cmd", () => {
    expect(["=", "+", "-", "0", "1"].every((k) => key(k, { ctrlKey: true }))).toBe(true);
    expect(key("0", { metaKey: true })).toBe(true);
  });

  /* Everything else stays the tour's: its own keys, and anything that would
     open something underneath it. */
  it("but not the tour's own keys, nor what would open something beneath it", () => {
    for (const k of ["ArrowRight", "ArrowLeft", "Enter", "Escape", "Tab", " "]) expect(key(k), k).toBe(false);
    expect(key("k", { ctrlKey: true }), "Ctrl+K, the palette").toBe(false);
    expect(key("z", { ctrlKey: true }), "Ctrl+Z").toBe(false);
    expect(key("s", { ctrlKey: true }), "Ctrl+S").toBe(false);
    expect(key("v", { altKey: true }), "Alt+V").toBe(false);
    expect(key("F2"), "an action's F-key").toBe(false);
  });
});

describe("the two laps", () => {
  /* The rule that would silently undo the fix. Adding one of these back to the
     mobile list compiles, renders, and shows a first-run phone user an empty
     rectangle — exactly the bug, and nothing else here would notice. (The
     overlay now skips a stop whose chrome is off screen, so the cost would be
     a stop silently missing from the phone's lap instead.) */
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
     card, or never on the last one. TourOverlay derives both from one lap. */
  it("really are different laps, not one list twice", () => {
    expect(MOBILE_TOUR_STEPS).not.toBe(TOUR_STEPS);
    expect(MOBILE_TOUR_STEPS.map((s) => s.body)).not.toEqual(TOUR_STEPS.map((s) => s.body));
  });

  /* The desktop teaches Ctrl+K, hovering for a shortcut, the wheel and the
     right-click. A phone has none of those — in a body, a tip, a key cap or a
     try-it. (Space-drag never existed at all: the old copy taught it.) */
  it("keeps keyboard-and-mouse instructions off the phone's lap", () => {
    // "Ctrl" alone is allowed: the phone's options card HAS Shift, Alt and Ctrl
    // keys, and the stop says so. A shortcut ("Ctrl+") is what it cannot press.
    const mouseAndKeys = /Ctrl\+|hold Ctrl|hover|wheel|scroll|right-click|\bclick|Space-drag|\bEsc\b|←|→/i;
    const offending = MOBILE_TOUR_STEPS.filter((s) => mouseAndKeys.test(wordsOf(s)));
    expect(offending.map((s) => `${s.id}: ${wordsOf(s).match(mouseAndKeys)?.[0]}`)).toEqual([]);
    // …and the desktop lap does teach them, or the pattern above proves nothing.
    expect(TOUR_STEPS.filter((s) => mouseAndKeys.test(wordsOf(s))).length).toBeGreaterThanOrEqual(5);
  });

  it("never teaches Space-drag, which the canvas does not have", () => {
    const all = [...TOUR_STEPS, ...MOBILE_TOUR_STEPS];
    const spaceDrag = /space[- ]?(drag|bar)|hold(ing)? space/i; // not "colour space"
    expect(all.filter((s) => spaceDrag.test(wordsOf(s))).map((s) => s.id)).toEqual([]);
  });
});
