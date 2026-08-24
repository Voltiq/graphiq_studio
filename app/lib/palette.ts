import { MENUS, type Menu } from "./menus";
import { TOOL_GROUPS, type Tool, type ToolId } from "./tools";
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
  /** Menu action id; absent for tools. Lets checkable rows show their state. */
  action?: string;
  run: () => void;
}

export interface PaletteSources {
  /** Effective shortcut label for a menu action or tool, or undefined for none. */
  keyFor: (kind: "menu" | "tool", id: string, fallback?: string) => string | undefined;
  onSelectTool?: (id: ToolId) => void;
  onMenuAction?: (action: string) => void;
  /* Injectable so the tests can feed a fixture. Not a configuration knob — the
     editor never passes these. It exists because the interesting cases are the
     ones the live registries do not currently contain: today NO menu item is
     `disabled`, so a test run against `MENUS` compares an empty set with an
     empty set and proves nothing about the rule that withholds them. */
  menus?: Menu[];
  tools?: Tool[][];
}

/**
 * Every tool, then every runnable menu command, in menu order.
 *
 * `disabled` items are skipped on purpose: they are placeholders with no
 * handler, so offering them in search would be offering a row that does
 * nothing. They remain visible (and greyed) in the menu tree, which is why the
 * coverage property is "palette OR tree" rather than "palette".
 */
export function buildPaletteCommands({
  keyFor,
  onSelectTool,
  onMenuAction,
  menus = MENUS,
  tools = TOOL_GROUPS,
}: PaletteSources): PaletteCommandSpec[] {
  const out: PaletteCommandSpec[] = [];
  for (const t of tools.flat()) {
    out.push({
      key: `tool:${t.id}`,
      label: t.name,
      sub: "Tool",
      shortcut: keyFor("tool", t.id, t.shortcut),
      icon: t.icon,
      run: () => onSelectTool?.(t.id),
    });
  }
  for (const menu of menus) {
    for (const item of menu.items) {
      if (!item.action || item.disabled) continue;
      const action = item.action;
      out.push({
        key: `menu:${action}:${item.label}`,
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

/** Every action id the menus declare, runnable or not. */
export function menuActionIds(menus: Menu[] = MENUS): string[] {
  const out: string[] = [];
  for (const menu of menus) for (const item of menu.items) if (item.action) out.push(item.action);
  return out;
}

/** Action ids the menus declare but mark `disabled` — tree-only by design. */
export function disabledActionIds(menus: Menu[] = MENUS): string[] {
  const out: string[] = [];
  for (const menu of menus)
    for (const item of menu.items) if (item.action && item.disabled) out.push(item.action);
  return out;
}
