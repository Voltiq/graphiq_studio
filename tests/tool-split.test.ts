import { describe, expect, it } from "vitest";
import { ALL_TOOLS, TOOL_GROUPS } from "../app/lib/tools";

/**
 * Every tool has a name worth showing, and every tool is in the rail's groups.
 *
 * The phone's tools sheet captions each tile with the tool's name (since 3.0
 * the sheet is the rail's families as titled groups — RAIL_SLOTS, whose
 * partition is tests/rail-slots.test.ts). A blank name renders an icon with an
 * empty caption, which looks like a layout bug rather than a missing string.
 * (The pre-3.0 sheet's six-up-front split, and its partition tests, went with
 * the layout that used it.)
 */

describe("the tools", () => {
  it("each have a name worth showing", () => {
    for (const t of ALL_TOOLS) {
      expect(t.name.trim().length).toBeGreaterThan(1);
      expect(t.name).not.toBe(t.id);
    }
  });

  it("are all reachable from TOOL_GROUPS, which the desktop renders", () => {
    expect(TOOL_GROUPS.flat().map((t) => t.id).sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
  });
});
