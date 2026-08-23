import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  OVERFLOW_TOOLS,
  PRIMARY_TOOLS,
  PRIMARY_TOOL_IDS,
  TOOL_GROUPS,
} from "../app/lib/tools";

/**
 * The touch layout splits the tool rail in two: six up front, the rest in a
 * labelled grid. The split has one property that matters more than any other —
 * it is a PARTITION. A tool that appears in neither list is unreachable on a
 * phone, and one that appears in both is two buttons claiming the same state.
 *
 * Worth a test rather than a careful read because the failure is silent and
 * arrives later: someone adds a tool to `TOOL_GROUPS` and nothing anywhere
 * complains that the phone cannot reach it. `OVERFLOW_TOOLS` is derived by
 * subtraction for that reason, and this is what pins the derivation down.
 */

describe("the touch tool split", () => {
  it("covers every tool exactly once", () => {
    const seen = [...PRIMARY_TOOLS, ...OVERFLOW_TOOLS].map((t) => t.id);
    expect(seen).toHaveLength(ALL_TOOLS.length);
    expect(new Set(seen).size).toBe(ALL_TOOLS.length);
    expect([...seen].sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
  });

  it("puts nothing in both lists", () => {
    const overflow = new Set(OVERFLOW_TOOLS.map((t) => t.id));
    for (const t of PRIMARY_TOOLS) expect(overflow.has(t.id)).toBe(false);
  });

  it("resolves every primary id to a real tool", () => {
    /* `PRIMARY_TOOL_IDS.map(find)` would quietly produce holes if an id were
       misspelt, and a hole renders as a crash rather than a missing button. */
    expect(PRIMARY_TOOLS).toHaveLength(PRIMARY_TOOL_IDS.length);
    for (const t of PRIMARY_TOOLS) expect(t?.name).toBeTruthy();
  });

  it("keeps the six in the order they are declared", () => {
    expect(PRIMARY_TOOLS.map((t) => t.id)).toEqual(PRIMARY_TOOL_IDS);
  });

  it("keeps the overflow in rail order", () => {
    const railOrder = ALL_TOOLS.map((t) => t.id).filter((id) => !PRIMARY_TOOL_IDS.includes(id));
    expect(OVERFLOW_TOOLS.map((t) => t.id)).toEqual(railOrder);
  });

  it("gives every tool a name worth showing", () => {
    /* The grid's whole point is the label. A blank one would render an icon
       with an empty caption, which looks like a layout bug rather than a
       missing string. */
    for (const t of ALL_TOOLS) {
      expect(t.name.trim().length).toBeGreaterThan(1);
      expect(t.name).not.toBe(t.id);
    }
  });

  it("still has every tool reachable from TOOL_GROUPS, which desktop renders", () => {
    expect(TOOL_GROUPS.flat().map((t) => t.id).sort()).toEqual(ALL_TOOLS.map((t) => t.id).sort());
  });
});
