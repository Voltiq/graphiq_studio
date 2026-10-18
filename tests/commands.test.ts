/**
 * The command registry (TODO 1.1). The compile-time half — every menu id has a
 * handler, every handler a menu id, every family suffix a real effect / filter /
 * panel — is the editor's dispatch-table type and was mutation-tested against
 * tsc. This is the runtime half: the gate that plain strings pass through, and
 * the routing that families take once the direct table has said "not mine".
 */
import { describe, expect, it } from "vitest";
import { MENUS, isCommandId } from "../app/lib/menus";
import { effectOf, extraAdjustmentOf, familyOf, filterOf, panelOf } from "../app/lib/commands";
import { isRecordable } from "../app/lib/actions";

const ids = MENUS.flatMap((m) => m.items.map((i) => i.action));

describe("the command registry", () => {
  it("has a command on every menu row", () => {
    // `action` is required by the type; this guards a cast or `any` slipping past it.
    expect(ids.filter((id) => typeof id !== "string" || !id)).toEqual([]);
  });

  it("shares an id only between rows that are the same command", () => {
    /* Listing one command in two menus is fine (Keyboard shortcuts… sits under
       Settings and Help). Two DIFFERENT rows on one id is a copy-paste error the
       recorder and palette could not tell apart — so a shared id needs the same
       label. */
    const byId = new Map<string, Set<string>>();
    for (const m of MENUS) for (const i of m.items) byId.set(i.action, (byId.get(i.action) ?? new Set()).add(i.label));
    expect([...byId].filter(([, labels]) => labels.size > 1).map(([id, l]) => `${id}: ${[...l].join(" / ")}`)).toEqual([]);
  });

  it("accepts every menu id at the string gate, and nothing else", () => {
    expect(ids.every(isCommandId)).toBe(true);
    for (const bogus of ["", "bogus", "fx-add-sparkle", "window-", "toString", "constructor"]) {
      expect(isCommandId(bogus), bogus).toBe(false);
    }
  });

  it("has a working File ▸ Close (it had no command at all)", () => {
    expect(isCommandId("doc-close")).toBe(true);
  });

  it("routes each family to its kind and reads its argument", () => {
    expect(familyOf("fx-add-stroke")).toEqual({ kind: "effect", id: "fx-add-stroke" });
    expect(effectOf("fx-add-stroke")).toBe("stroke");
    expect(familyOf("filter-add-blur").kind).toBe("filter");
    expect(filterOf("filter-add-blur")).toBe("blur");
    expect(familyOf("window-layers").kind).toBe("panel");
    expect(panelOf("window-layers")).toBe("layers");
    // adj-x- must win over adj- (the longer prefix is checked first).
    const extra = ids.find((id) => id.startsWith("adj-x-"));
    expect(extra).toBeDefined();
    expect(familyOf(extra as Parameters<typeof extraAdjustmentOf>[0]).kind).toBe("extraAdjustment");
  });

  it("only allows recording real commands", () => {
    // RECORDABLE_EXACT is typed CommandId; this checks the prefix rule too.
    expect(ids.filter(isRecordable).every(isCommandId)).toBe(true);
    expect(isRecordable("fx-add-stroke")).toBe(true);
    expect(isRecordable("export-as")).toBe(false); // opens a dialog: not replayable
  });
});
