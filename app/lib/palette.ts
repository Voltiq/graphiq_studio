import { MENUS } from "./menus";
import { TOOL_GROUPS, type ToolId } from "./tools";
import type { LucideIcon } from "lucide-react";

/**
 * What the command palette can run.
 *
 * This lived inside `TopBar` as a `useMemo`, which made it untestable: the one
 * property that matters — **nothing the menus offer is missing from search** —
 * could only be checked by rendering the whole editor. It matters more now that
 * the palette is the phone's primary way into 151 menu commands, because a
 * command the palette cannot reach is a command a phone cannot reach at all.
 *
 * Kept deliberately free of React so `tests/palette.test.ts` can assert
 * coverage directly against `MENUS` and `TOOL_GROUPS`.
 */
export interface PaletteCommandSpec {
  key: string;
  label: string;
  /** "Tool" or "<Menu> menu" — the subtitle, and how a search is disambiguated. */
  sub: string;
  shortcut?: string;
  icon?: LucideIcon;
  /** Menu action id; absent for tools. Lets checkable rows show their state,
   *  and greyed ones say why. */
  action?: string;
  run: () => void;
}

export interface PaletteSources {
  /** Effective shortcut label for a menu action or tool, or undefined for none. */
  keyFor: (kind: "menu" | "tool", id: string, fallback?: string) => string | undefined;
  onSelectTool?: (id: ToolId) => void;
  onMenuAction?: (action: string) => void;
}

/**
 * Every tool, then every menu command, in menu order.
 *
 * All of them, always: a command that does not apply right now is still
 * offered, greyed with its reason (commands/registry.ts), because a search
 * that silently omits "Crop" teaches nobody that Crop needs a selection.
 */
export function buildPaletteCommands({ keyFor, onSelectTool, onMenuAction }: PaletteSources): PaletteCommandSpec[] {
  const out: PaletteCommandSpec[] = [];
  for (const t of TOOL_GROUPS.flat()) {
    out.push({
      key: `tool:${t.id}`,
      label: t.name,
      sub: "Tool",
      shortcut: keyFor("tool", t.id, t.shortcut),
      icon: t.icon,
      run: () => onSelectTool?.(t.id),
    });
  }
  /* A command listed in two menus (Keyboard shortcuts… is under Settings AND
     Help) is ONE palette entry, from the first menu that has it. Two would both
     be noise in a search list and share a key, and keys index the palette's
     recents: one would silently shadow the other across reloads. */
  const seen = new Set<string>();
  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (!item.action) continue;
      const action = item.action;
      const key = `menu:${action}:${item.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        label: item.label.replace(/…$/, ""),
        sub: `${menu.label} menu`,
        shortcut: keyFor("menu", action, item.shortcut),
        action,
        run: () => onMenuAction?.(action),
      });
    }
  }
  return out;
}
