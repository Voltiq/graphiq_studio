import { describe, expect, it } from "vitest";
import { grabRadius, grabScale } from "../app/lib/pointer";

/**
 * Grab radii, scaled by the device doing the grabbing.
 *
 * The rule that matters most here is the negative one: a mouse must come out
 * with exactly the radius the code already had. Every on-canvas radius in the
 * app was chosen against a mouse, and a scale of 1.0000001 would mean every one
 * of them silently changed on the device that was already fine.
 *
 * The second is the cap. A radius is capped so a handle cannot swallow its
 * neighbours on a small shape — and the obvious way to write that, a plain
 * `Math.min`, hands a finger a SMALLER target than a mouse gets on exactly the
 * shapes that are hardest to hit. The cap is therefore a floor as well.
 */

describe("grabScale", () => {
  it("leaves a mouse exactly as it was", () => {
    expect(grabScale("mouse")).toBe(1);
  });

  it("treats an unknown or missing pointer type as a mouse", () => {
    /* `pointerType` is "" for events synthesised by some assistive tech, and
       the safe reading of "I don't know what this is" is the untouched one. */
    expect(grabScale("")).toBe(1);
    expect(grabScale("unknown")).toBe(1);
  });

  it("gives a finger the most help and a pen something in between", () => {
    expect(grabScale("touch")).toBeGreaterThan(grabScale("pen"));
    expect(grabScale("pen")).toBeGreaterThan(grabScale("mouse"));
  });

  it("keeps a finger's radius big enough to cover a real aiming error", () => {
    /* The crop handles are 9 screen px. Measured on a phone, a touch 10px off
       the handle missed it and started a new crop; the scaled radius has to
       clear that with room to spare or the fix does not fix anything. */
    expect(grabRadius(9, "touch")).toBeGreaterThanOrEqual(20);
  });
});

describe("grabRadius", () => {
  it("returns the base radius unchanged for a mouse", () => {
    for (const base of [5, 8, 9, 10, 12]) expect(grabRadius(base, "mouse")).toBe(base);
  });

  it("scales the base radius by the pointer's factor", () => {
    expect(grabRadius(10, "touch")).toBe(10 * grabScale("touch"));
    expect(grabRadius(10, "pen")).toBe(10 * grabScale("pen"));
  });

  it("caps the radius so a handle cannot swallow its neighbours", () => {
    expect(grabRadius(9, "touch", 14)).toBe(14);
  });

  it("never lets the cap take a scaled pointer BELOW the mouse's radius", () => {
    /* A 4px cap on a 9px base: the finger keeps 9, the radius the mouse would
       have had, rather than being handed a 4px target on a tiny shape. */
    expect(grabRadius(9, "touch", 4)).toBe(9);
    expect(grabRadius(9, "mouse", 4)).toBe(9);
  });

  it("is monotonic in the base radius, so bigger handles stay bigger", () => {
    const touch = [5, 8, 9, 10, 12].map((b) => grabRadius(b, "touch"));
    expect([...touch].sort((a, b) => a - b)).toEqual(touch);
  });
});
