/**
 * The desktop rail combines tools into slots with flyouts. Every tool has to be
 * reachable from exactly one slot: one left out has no button at all, and one
 * listed twice would show in two places and fight over which is "current".
 */
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, RAIL_SLOTS } from "../app/lib/tools";

describe("rail slots", () => {
  const listed = RAIL_SLOTS.flat(2);

  it("cover every tool exactly once", () => {
    expect([...listed].sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("fit the rail: at most fifteen slots, none of them empty", () => {
    const slots = RAIL_SLOTS.flat(1);
    expect(slots.length).toBeLessThanOrEqual(15);
    for (const s of slots) expect(s.length).toBeGreaterThan(0);
  });
});
