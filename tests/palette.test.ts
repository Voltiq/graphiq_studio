import { describe, expect, it } from "vitest";
import { buildPaletteCommands, type PaletteCommandSpec } from "../app/lib/palette";
import { COMMAND_IDS, MENUS } from "../app/lib/menus";
import { TOOL_GROUPS } from "../app/lib/tools";

/**
 * The palette is the phone's primary menu, so "can search reach it?" stops
 * being a convenience question and becomes the reachability question: a
 * command missing from the palette is a command a phone user has to find by
 * scrolling 151 rows.
 *
 * Every menu command, whether or not it applies right now: one that does not
 * is offered greyed, with its reason, rather than left out (TODO 1.1).
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

  it("offers every menu command", () => {
    const reachable = new Set(build().flatMap((c) => (c.action ? [c.action] : [])));
    expect(COMMAND_IDS.filter((id) => !reachable.has(id))).toEqual([]);
    expect(COMMAND_IDS.length).toBeGreaterThan(150); // the menus are not empty
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
