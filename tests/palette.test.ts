import { describe, expect, it } from "vitest";
import {
  buildPaletteCommands,
  disabledActionIds,
  menuActionIds,
  type PaletteCommandSpec,
} from "../app/lib/palette";
import { MENUS } from "../app/lib/menus";
import { TOOL_GROUPS } from "../app/lib/tools";

/**
 * The palette is the phone's primary menu, so "can search reach it?" stops
 * being a convenience question and becomes the reachability question: a
 * command missing from the palette is a command a phone user has to find by
 * scrolling 151 rows, and one missing from BOTH is unreachable.
 *
 * The property asserted throughout is **palette ∪ tree == every menu action**,
 * not "palette == every menu action". Disabled rows are placeholders with no
 * handler; they stay visible and greyed in the tree and are deliberately kept
 * out of search, because a search result that does nothing is worse than no
 * search result.
 */

const build = (): PaletteCommandSpec[] =>
  buildPaletteCommands({ keyFor: (_k, _id, fallback) => fallback });

describe("palette command coverage", () => {
  it("offers every tool", () => {
    const tools = TOOL_GROUPS.flat();
    const keys = new Set(build().map((c) => c.key));
    const missing = tools.filter((t) => !keys.has(`tool:${t.id}`)).map((t) => t.id);
    expect(missing).toEqual([]);
    expect(tools.length).toBeGreaterThan(20); // the registry is not empty
  });

  it("offers every runnable menu action", () => {
    const reachable = new Set(build().flatMap((c) => (c.action ? [c.action] : [])));
    const disabled = new Set(disabledActionIds());
    const missing = menuActionIds().filter((id) => !disabled.has(id) && !reachable.has(id));
    expect(missing).toEqual([]);
  });

  it("leaves nothing reachable by neither the palette nor the tree", () => {
    const inPalette = new Set(build().flatMap((c) => (c.action ? [c.action] : [])));
    const inTree = new Set(menuActionIds());
    const stranded = menuActionIds().filter((id) => !inPalette.has(id) && !inTree.has(id));
    expect(stranded).toEqual([]);
  });

  /* The one thing search withholds is withheld for a stated reason, so the rule
     is checked rather than trusted.

     Against the live MENUS this proves nothing, and saying so is the point:
     NO menu item is currently `disabled`, so "withheld == disabled" compares an
     empty set with an empty set and passes whatever the code does — a mutation
     that deleted the `item.disabled` guard sailed through it. The rule is real
     (the field is in `MenuItem` and the tree greys such rows), so the fixture
     supplies the case the registry does not. */
  it("withholds nothing at all from the live menus, because none are disabled", () => {
    const inPalette = new Set(build().flatMap((c) => (c.action ? [c.action] : [])));
    expect(menuActionIds().filter((id) => !inPalette.has(id))).toEqual([]);
    expect(disabledActionIds()).toEqual([]); // the premise of the line above
  });

  it("withholds a disabled placeholder from search but keeps it in the tree", () => {
    const menus = [
      {
        label: "Fixture",
        items: [
          { label: "Runnable", action: "fixture-runnable" },
          { label: "Placeholder", action: "fixture-placeholder", disabled: true },
        ],
      },
    ];
    const inPalette = new Set(
      buildPaletteCommands({ keyFor: (_k, _i, f) => f, menus, tools: [] }).flatMap((c) =>
        c.action ? [c.action] : [],
      ),
    );
    expect([...inPalette]).toEqual(["fixture-runnable"]);
    // …and it is still reachable, because the tree lists it.
    expect(menuActionIds(menus)).toContain("fixture-placeholder");
    expect(disabledActionIds(menus)).toEqual(["fixture-placeholder"]);
  });

  it("subtitles every command with where it came from", () => {
    const menuNames = new Set(MENUS.map((m) => `${m.label} menu`));
    const bad = build().filter((c) => c.sub !== "Tool" && !menuNames.has(c.sub));
    expect(bad.map((c) => c.key)).toEqual([]);
  });

  /* Keys index the palette's recents list in localStorage, so a duplicate
     silently makes one command shadow another across reloads. */
  it("gives every command a unique key", () => {
    const keys = build().map((c) => c.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("strips the trailing ellipsis that only makes sense in a menu", () => {
    expect(build().some((c) => c.label.endsWith("…"))).toBe(false);
    // …and the source really does contain some, or this proves nothing.
    expect(MENUS.some((m) => m.items.some((i) => i.label.endsWith("…")))).toBe(true);
  });

  it("prefers the registry's shortcut label over the static default", () => {
    const cmds = buildPaletteCommands({
      keyFor: (kind, id, fallback) => (kind === "menu" && id === "save" ? "Ctrl+Alt+7" : fallback),
    });
    expect(cmds.find((c) => c.action === "save")?.shortcut).toBe("Ctrl+Alt+7");
    expect(cmds.find((c) => c.action === "open")?.shortcut).toBe("Ctrl+O");
  });

  it("runs the handler it was given, with the action it belongs to", () => {
    const fired: string[] = [];
    const cmds = buildPaletteCommands({
      keyFor: (_k, _id, f) => f,
      onMenuAction: (a) => fired.push(`menu:${a}`),
      onSelectTool: (t) => fired.push(`tool:${t}`),
    });
    cmds.find((c) => c.action === "layer-new")!.run();
    cmds.find((c) => c.key === "tool:brush")!.run();
    expect(fired).toEqual(["menu:layer-new", "tool:brush"]);
  });
});
