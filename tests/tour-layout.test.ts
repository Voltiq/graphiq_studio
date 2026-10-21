import { describe, expect, it } from "vitest";
import {
  GAP,
  MARGIN,
  PAD,
  isShown,
  placeCard,
  sidesFor,
  spotlight,
  visibleFraction,
  type Box,
} from "../app/lib/tour-layout";

/**
 * Where the tour's card goes, and which stops it can show at all — the
 * geometry, with the layouts it was measured against. A browser proves the
 * same things on the real chrome (e2e/tour.spec.ts); here every rule is pinned
 * by itself, including the cases a 1400×900 window never produces.
 */

const DESK: Box = { x: 0, y: 0, w: 1400, h: 900 };
const PHONE: Box = { x: 0, y: 0, w: 390, h: 844 };
const CARD = { w: 368, h: 430 };

// The desktop chrome, measured at 1400×900.
const TOPBAR: Box = { x: 0, y: 0, w: 1400, h: 54 };
const TOOLBAR: Box = { x: 16, y: 114, w: 58, h: 770 };
const DOCK: Box = { x: 1092, y: 114, w: 292, h: 786 };
const CANVAS: Box = { x: 86, y: 114, w: 994, h: 770 };
const STATUS: Box = { x: 102, y: 822, w: 962, h: 44 };
const EXPORT: Box = { x: 1292, y: 10, w: 92, h: 34 };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const cardAt = (p: { x: number; y: number }, card = CARD): Box => ({ ...p, ...card });
/** Inside the view, MARGIN clear of its edges. */
const within = (b: Box, view: Box) =>
  b.x >= view.x + MARGIN - 0.01 &&
  b.y >= view.y + MARGIN - 0.01 &&
  b.x + b.w <= view.x + view.w - MARGIN + 0.01 &&
  b.y + b.h <= view.y + view.h - MARGIN + 0.01;

describe("visibleFraction", () => {
  it("is the share of a box inside the view", () => {
    expect(visibleFraction({ x: 10, y: 10, w: 100, h: 100 }, DESK)).toBe(1);
    expect(visibleFraction({ x: -50, y: 0, w: 100, h: 100 }, DESK)).toBe(0.5);
    expect(visibleFraction({ x: 0, y: 850, w: 100, h: 100 }, DESK)).toBe(0.5);
    expect(visibleFraction({ x: -320, y: 0, w: 320, h: 692 }, DESK)).toBe(0);
  });

  it("is nothing for an empty box, rather than 0/0", () => {
    expect(visibleFraction({ x: 10, y: 10, w: 0, h: 0 }, DESK)).toBe(0);
  });
});

describe("isShown: a stop is skipped when its chrome is not there to point at", () => {
  /* The three a phone measured, which the old tour spotlit anyway. */
  it("not a drawer parked off the side", () => {
    expect(isShown({ x: -320, y: 76, w: 320, h: 692 }, PHONE)).toBe(false);
  });

  it("not a sheet below the fold with a sliver showing", () => {
    expect(isShown({ x: 0, y: 788, w: 390, h: 422 }, PHONE)).toBe(false);
  });

  it("not a bar that is display: none", () => {
    expect(isShown({ x: 0, y: 0, w: 0, h: 0 }, PHONE)).toBe(false);
    expect(isShown(null, PHONE)).toBe(false);
  });

  /* On screen in full, and still nothing to point at: a panel collapsed to
     the hairline of its border. */
  it("not a sliver too thin to see, however much of it is on screen", () => {
    expect(isShown({ x: 1396, y: 114, w: 2, h: 770 }, DESK)).toBe(false);
    expect(isShown({ x: 100, y: 400, w: 600, h: 4 }, DESK)).toBe(false);
  });

  it("but chrome on screen, even running to its edge", () => {
    expect(isShown(TOPBAR, DESK)).toBe(true);
    expect(isShown({ x: 0, y: 766, w: 390, h: 78 }, PHONE)).toBe(true);
  });
});

describe("spotlight", () => {
  it("stands PAD clear of its target, its corners rounded to match", () => {
    expect(spotlight(TOOLBAR, 16, DESK)).toEqual({
      x: TOOLBAR.x - PAD,
      y: TOOLBAR.y - PAD,
      w: TOOLBAR.w + 2 * PAD,
      h: TOOLBAR.h + 2 * PAD,
      r: 16 + PAD,
    });
  });

  /* The phone's header runs edge to edge: padded, three sides of its ring were
     off the screen and it read as an underline. */
  it("but stays inside the view, so a bar at the edge is ringed all round", () => {
    const s = spotlight({ x: 0, y: 0, w: 390, h: 72 }, 0, PHONE);
    expect(s.x).toBeGreaterThan(0);
    expect(s.y).toBeGreaterThan(0);
    expect(s.x + s.w).toBeLessThan(390);
    expect(s.h).toBeGreaterThan(72);
  });
});

describe("sidesFor", () => {
  it("reads a bar from under or over it, a rail from beside it", () => {
    expect(sidesFor(TOPBAR)[0]).toBe("below");
    expect(sidesFor(STATUS)[0]).toBe("below"); // ...then above, which is where it lands
    expect(sidesFor(TOOLBAR)[0]).toBe("right");
    expect(sidesFor(DOCK).slice(0, 2)).toEqual(["right", "left"]);
  });
});

describe("placeCard", () => {
  it("centres a stop with no target", () => {
    const p = placeCard(null, CARD, DESK);
    expect(p.side).toBe("center");
    expect(p.arrow).toBeNull();
    expect(p.x + CARD.w / 2).toBe(700);
    expect(p.y + CARD.h / 2).toBe(450);
  });

  it("puts the card under the top bar, pointing at it", () => {
    const p = placeCard(TOPBAR, CARD, DESK);
    expect(p.side).toBe("below");
    expect(p.y).toBe(TOPBAR.y + TOPBAR.h + GAP);
    expect(p.x + p.arrow!).toBeCloseTo(700); // the caret is under the bar's middle
  });

  it("beside the tool rail, and the dock on the right is read from its left", () => {
    const rail = placeCard(TOOLBAR, CARD, DESK);
    expect(rail.side).toBe("right");
    expect(rail.x).toBe(TOOLBAR.x + TOOLBAR.w + GAP);
    const dock = placeCard(DOCK, CARD, DESK);
    expect(dock.side).toBe("left");
    expect(dock.x + CARD.w).toBe(DOCK.x - GAP);
  });

  it("above the status bar at the foot of the window", () => {
    const p = placeCard(STATUS, CARD, DESK);
    expect(p.side).toBe("above");
    expect(p.y + CARD.h).toBe(STATUS.y - GAP);
  });

  /* A small button in the corner: the card cannot centre on it and stay on
     screen, so it slides along — and the caret still points at the button. */
  it("under the Export button, slid in from the edge with the caret on the button", () => {
    const p = placeCard(EXPORT, CARD, DESK);
    expect(p.side).toBe("below");
    expect(p.x + CARD.w).toBe(DESK.w - MARGIN);
    expect(p.x + p.arrow!).toBeCloseTo(EXPORT.x + EXPORT.w / 2);
  });

  /* The canvas fills the window between the rail and the dock: no side has
     room. The card goes inside it, in the corner away from the picture. */
  it("inside a target too big to stand beside, without a caret", () => {
    const p = placeCard(CANVAS, CARD, DESK);
    expect(p.side).toBe("inset");
    expect(p.arrow).toBeNull();
    const c = cardAt(p);
    expect(c.x).toBeGreaterThan(CANVAS.x);
    expect(c.x + c.w).toBeLessThanOrEqual(CANVAS.x + CANVAS.w);
    expect(c.y + c.h).toBeLessThanOrEqual(CANVAS.y + CANVAS.h);
    expect(c.x + c.w / 2).toBeGreaterThan(CANVAS.x + CANVAS.w / 2); // the right half
  });

  /* A phone on its side: 390px tall, a card that does not fit either way. It
     overlaps the small target rather than leave the screen, and drops the
     caret, which would point from inside it at itself. */
  it("over a small target when no side has room, without a caret", () => {
    const view = { x: 0, y: 0, w: 844, h: 390 };
    const p = placeCard({ x: 300, y: 170, w: 120, h: 40 }, CARD, view);
    expect(p.arrow).toBeNull();
    expect(p.y).toBe(MARGIN);
  });

  it("keeps the caret off the card's rounded corners", () => {
    const p = placeCard({ x: 1380, y: 0, w: 20, h: 20 }, CARD, DESK);
    expect(p.arrow).toBeLessThanOrEqual(CARD.w - 22);
    const q = placeCard({ x: 0, y: 0, w: 20, h: 20 }, CARD, DESK);
    expect(q.arrow).toBeGreaterThanOrEqual(22);
  });

  /* Over every target a window of these sizes can produce, the card is on
     screen; and whenever it stands BESIDE its target, it does not cover it. */
  it("is always on screen, and never covers what it points at", () => {
    const views = [DESK, PHONE, { x: 0, y: 0, w: 1024, h: 640 }, { x: 0, y: 47, w: 390, h: 750 }];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let beside = 0;
    for (const view of views) {
      const card = { w: Math.min(368, view.w - 24), h: 380 };
      for (let i = 0; i < 400; i++) {
        const w = 8 + rnd() * view.w;
        const h = 8 + rnd() * view.h;
        const t = { x: view.x + rnd() * (view.w - w), y: view.y + rnd() * (view.h - h), w, h };
        const p = placeCard(t, card, view);
        const c = cardAt(p, card);
        expect(within(c, view), `${JSON.stringify(t)} in ${JSON.stringify(view)}`).toBe(true);
        if (p.arrow !== null) {
          beside++;
          expect(overlaps(c, t), `${p.side} of ${JSON.stringify(t)}`).toBe(false);
        }
      }
    }
    expect(beside, "enough of them stood beside their target to mean something").toBeGreaterThan(400);
  });
});
