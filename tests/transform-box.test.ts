import { describe, expect, it } from "vitest";

import {
  MOVE_ROTATE_REACH,
  inRotateZone,
  resizeBox,
  transformBlock,
  type BoxEdges,
  type BoxRect,
} from "@/app/lib/transform-box";

const BOX: BoxRect = { x: 100, y: 50, w: 200, h: 100 }; // 2:1
const SE: BoxEdges = { right: true, bottom: true };
const NW: BoxEdges = { left: true, top: true };
const E: BoxEdges = { right: true };
const S: BoxEdges = { bottom: true };

const aspect = (b: BoxRect) => b.w / b.h;

describe("free drag", () => {
  it("moves only the grabbed edges", () => {
    expect(resizeBox(BOX, E, 400, 999)).toEqual({ x: 100, y: 50, w: 300, h: 100 });
    expect(resizeBox(BOX, S, 999, 200)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
  });

  it("takes a corner on both axes at once", () => {
    expect(resizeBox(BOX, SE, 400, 200)).toEqual({ x: 100, y: 50, w: 300, h: 150 });
    expect(resizeBox(BOX, NW, 50, 25)).toEqual({ x: 50, y: 25, w: 250, h: 125 });
  });

  it("holds the opposite edge still", () => {
    for (const px of [0, 120, 250, 900]) {
      const r = resizeBox(BOX, E, px, 100);
      expect(r.x).toBe(BOX.x); // the left edge never moves
    }
    for (const px of [0, 120, 250, 900]) {
      const r = resizeBox(BOX, { left: true }, px, 100);
      expect(r.x + r.w).toBe(BOX.x + BOX.w); // the right edge never moves
    }
  });

  it("never flips through zero — dragging an edge past its opposite stops at 1px", () => {
    const r = resizeBox(BOX, E, -500, 100);
    expect(r.w).toBe(1);
    expect(r.x).toBe(BOX.x);
    const l = resizeBox(BOX, { left: true }, 9999, 100);
    expect(l.w).toBe(1);
    expect(l.x + l.w).toBe(BOX.x + BOX.w);
  });

  it("leaves the box alone when no edge is grabbed", () => {
    expect(resizeBox(BOX, {}, 999, 999)).toEqual(BOX);
    expect(resizeBox(BOX, {}, 999, 999, { constrain: true })).toEqual(BOX);
  });
});

describe("Shift — constrain the aspect", () => {
  it("keeps the original ratio on a corner drag", () => {
    for (const [px, py] of [
      [400, 200],
      [400, 60],
      [150, 300],
      [500, 500],
    ]) {
      const r = resizeBox(BOX, SE, px, py, { constrain: true });
      expect(aspect(r)).toBeCloseTo(aspect(BOX), 6);
    }
  });

  it("follows whichever axis the pointer went further along", () => {
    // Dragged far right, barely down → the WIDTH leads and the height follows.
    const wide = resizeBox(BOX, SE, 500, 155, { constrain: true });
    expect(wide.w).toBe(400);
    expect(wide.h).toBeCloseTo(200, 6);
    // Dragged far down, barely right → the HEIGHT leads.
    const tall = resizeBox(BOX, SE, 310, 450, { constrain: true });
    expect(tall.h).toBe(400);
    expect(tall.w).toBeCloseTo(800, 6);
  });

  it("scales uniformly from an EDGE handle too — the point of constraining", () => {
    const r = resizeBox(BOX, E, 500, 999, { constrain: true });
    expect(r.w).toBe(400);
    expect(r.h).toBeCloseTo(200, 6);
    expect(aspect(r)).toBeCloseTo(aspect(BOX), 6);
  });

  it("keeps an un-dragged axis centred on itself, so an edge drag does not slide the box", () => {
    // East handle: the box grows vertically, but stays centred on its old y-centre.
    const r = resizeBox(BOX, E, 500, 999, { constrain: true });
    expect(r.y + r.h / 2).toBeCloseTo(BOX.y + BOX.h / 2, 6);
    expect(r.x).toBe(BOX.x); // and the un-dragged left edge is still pinned
  });

  it("anchors on the corner opposite the one being dragged", () => {
    const se = resizeBox(BOX, SE, 500, 300, { constrain: true });
    expect(se.x).toBe(BOX.x);
    expect(se.y).toBe(BOX.y);
    const nw = resizeBox(BOX, NW, -100, -100, { constrain: true });
    expect(nw.x + nw.w).toBeCloseTo(BOX.x + BOX.w, 6);
    expect(nw.y + nw.h).toBeCloseTo(BOX.y + BOX.h, 6);
  });

  it("holds the ratio of a tall box as faithfully as a wide one", () => {
    const tall: BoxRect = { x: 10, y: 10, w: 40, h: 300 };
    for (const [px, py] of [
      [200, 400],
      [15, 900],
      [300, 20],
    ]) {
      const r = resizeBox(tall, SE, px, py, { constrain: true });
      expect(aspect(r)).toBeCloseTo(aspect(tall), 6);
    }
  });

  it("holds a square square", () => {
    const sq: BoxRect = { x: 0, y: 0, w: 100, h: 100 };
    const r = resizeBox(sq, SE, 400, 130, { constrain: true });
    expect(r.w).toBeCloseTo(r.h, 6);
  });
});

describe("Alt — resize about the centre", () => {
  it("holds the centre still", () => {
    for (const edges of [SE, NW, E, S]) {
      const r = resizeBox(BOX, edges, 420, 260, { fromCentre: true });
      expect(r.x + r.w / 2).toBeCloseTo(BOX.x + BOX.w / 2, 6);
      expect(r.y + r.h / 2).toBeCloseTo(BOX.y + BOX.h / 2, 6);
    }
  });

  it("still lets the DRAGGED edge track the pointer exactly", () => {
    const r = resizeBox(BOX, E, 400, 100, { fromCentre: true });
    expect(r.x + r.w).toBeCloseTo(400, 6);
    // ...which means the opposite edge mirrored inward by the same amount.
    expect(r.x).toBeCloseTo(0, 6);
  });

  it("leaves an axis with no grabbed edge completely alone", () => {
    const r = resizeBox(BOX, E, 400, 999, { fromCentre: true });
    expect(r.y).toBe(BOX.y);
    expect(r.h).toBe(BOX.h);
  });

  it("combines with Shift: centred AND proportional", () => {
    const r = resizeBox(BOX, SE, 420, 300, { constrain: true, fromCentre: true });
    expect(aspect(r)).toBeCloseTo(aspect(BOX), 6);
    expect(r.x + r.w / 2).toBeCloseTo(BOX.x + BOX.w / 2, 6);
    expect(r.y + r.h / 2).toBeCloseTo(BOX.y + BOX.h / 2, 6);
  });

  it("does not collapse through the centre", () => {
    const r = resizeBox(BOX, E, 200, 100, { fromCentre: true });
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});

describe("clamping to the canvas", () => {
  const clamp = { w: 500, h: 400 };

  it("keeps a free drag inside the canvas", () => {
    const r = resizeBox(BOX, SE, 9999, 9999, { clamp });
    expect(r.x + r.w).toBe(500);
    expect(r.y + r.h).toBe(400);
    const l = resizeBox(BOX, NW, -9999, -9999, { clamp });
    expect(l.x).toBe(0);
    expect(l.y).toBe(0);
  });

  /* Clamping a constrained drag would quietly change one side's length and so
     break the very ratio the user asked to hold. */
  it("does NOT clamp a constrained drag — that would break the aspect it promised", () => {
    const r = resizeBox(BOX, SE, 9999, 9999, { clamp, constrain: true });
    expect(aspect(r)).toBeCloseTo(aspect(BOX), 6);
    expect(r.x + r.w).toBeGreaterThan(clamp.w);
  });

  it("does nothing when no clamp is given (a rotated box's frame is not the canvas)", () => {
    const r = resizeBox(BOX, SE, 9999, 9999, { clamp: null });
    expect(r.w).toBeGreaterThan(500);
  });
});

describe("pixel rounding", () => {
  it("returns whole pixels when asked", () => {
    const r = resizeBox(BOX, SE, 400.6, 200.4, { round: true });
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
    expect(Number.isInteger(r.w)).toBe(true);
    expect(Number.isInteger(r.h)).toBe(true);
    expect(r.w).toBe(301);
    expect(r.h).toBe(150);
  });

  it("rounds the EDGES, not the size — so the un-dragged edge cannot drift", () => {
    const odd: BoxRect = { x: 10.5, y: 20.5, w: 100, h: 100 };
    const r = resizeBox(odd, E, 200.4, 0, { round: true });
    expect(r.x).toBe(Math.round(odd.x));
    expect(r.x + r.w).toBe(200);
  });

  it("still returns a usable box at the 1px floor", () => {
    const r = resizeBox(BOX, E, -9999, 0, { round: true });
    expect(r.w).toBe(1);
  });

  it("leaves fractions alone when rounding was not asked for", () => {
    const r = resizeBox(BOX, SE, 400.6, 200.4);
    expect(r.w).toBeCloseTo(300.6, 6);
    expect(r.h).toBeCloseTo(150.4, 6);
    expect(Number.isInteger(r.w)).toBe(false);
  });
});

describe("the rotate zone", () => {
  const B: BoxRect = { x: 100, y: 100, w: 200, h: 100 };

  it("takes a point just outside a corner", () => {
    for (const [x, y] of [
      [95, 95],
      [305, 95],
      [305, 205],
      [95, 205],
    ])
      expect(inRotateZone(B, x, y)).toBe(true);
  });

  it("never takes a point inside the box — that is the move gesture", () => {
    for (const [x, y] of [
      [101, 101],
      [200, 150],
      [299, 199],
      [100, 100],
    ])
      expect(inRotateZone(B, x, y)).toBe(false);
  });

  /* The whole reason this is not the marquee's 44 px ring: that band lies over
     whatever is painted next to the active layer, so a click meant to select a
     neighbour would spin this layer instead. */
  it("does NOT cover the middle of an edge, where a neighbouring layer may sit", () => {
    expect(inRotateZone(B, 200, 90)).toBe(false); // above the top edge, mid-span
    expect(inRotateZone(B, 200, 210)).toBe(false);
    expect(inRotateZone(B, 90, 150)).toBe(false); // left of the left edge, mid-span
    expect(inRotateZone(B, 310, 150)).toBe(false);
  });

  it("stops at the stated reach", () => {
    expect(inRotateZone(B, 100 - MOVE_ROTATE_REACH + 1, 100)).toBe(true);
    expect(inRotateZone(B, 100 - MOVE_ROTATE_REACH - 1, 100)).toBe(false);
    expect(inRotateZone(B, 80, 80, 5)).toBe(false);
    expect(inRotateZone(B, 96, 96, 6)).toBe(true);
  });

  /* The default reach is a real decision, not an implementation detail, so it is
     pinned in ABSOLUTE coordinates. Asserting only against MOVE_ROTATE_REACH
     itself would move both sides of the comparison together and pass at any
     value — including the 44 px marquee ring this exists to avoid. */
  it("reaches well short of the marquee's 44 px ring", () => {
    expect(MOVE_ROTATE_REACH).toBeGreaterThanOrEqual(12); // still grabbable
    expect(MOVE_ROTATE_REACH).toBeLessThanOrEqual(30);
    expect(inRotateZone(B, 75, 100)).toBe(false); // 25 px out: past the zone
    expect(inRotateZone(B, 60, 100)).toBe(false); // 40 px out: the marquee ring
    expect(inRotateZone(B, 90, 100)).toBe(true); // 10 px out: comfortably in
  });

  it("measures radially, so the reach is the same in every direction", () => {
    // A point diagonally out from the corner at exactly the reach is in;
    // the same distance broken into a bigger diagonal is out.
    const d = MOVE_ROTATE_REACH / Math.SQRT2;
    expect(inRotateZone(B, 100 - d + 0.5, 100 - d + 0.5)).toBe(true);
    expect(inRotateZone(B, 100 - MOVE_ROTATE_REACH, 100 - MOVE_ROTATE_REACH)).toBe(false);
  });

  it("works on a box small enough for its corner zones to meet", () => {
    const tiny: BoxRect = { x: 0, y: 0, w: 4, h: 4 };
    expect(inRotateZone(tiny, -2, -2)).toBe(true);
    expect(inRotateZone(tiny, 2, 2)).toBe(false); // still inside
  });
});

describe("when the handles may be shown at all", () => {
  const b: BoxRect = { x: 0, y: 0, w: 10, h: 10 };

  it("needs a layer", () => {
    expect(transformBlock(null, false, b)).toBe("no-layer");
  });

  /* Same rule as an actual move: a handle you cannot drag is a worse affordance
     than no handle. */
  it("hides them on a layer that cannot be moved", () => {
    expect(transformBlock("l1", true, b)).toBe("locked");
  });

  it("hides them on an empty layer — there is nothing to put a box around", () => {
    expect(transformBlock("l1", false, null)).toBe("empty");
    expect(transformBlock("l1", false, { x: 0, y: 0, w: 0, h: 0 })).toBe("empty");
    expect(transformBlock("l1", false, { x: 0, y: 0, w: 5, h: 0 })).toBe("empty");
  });

  it("shows them on an ordinary layer with pixels", () => {
    expect(transformBlock("l1", false, b)).toBe(null);
  });

  it("reports the blocking reason in priority order", () => {
    // No layer at all outranks everything else — there is nothing to report on.
    expect(transformBlock(null, true, null)).toBe("no-layer");
    expect(transformBlock("l1", true, null)).toBe("locked");
  });
});
