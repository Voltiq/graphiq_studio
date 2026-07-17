// Keyboard-shortcut registry (TODO §11) — ONE source of truth for bindings.
//
// Defaults derive from the existing registries (tools.ts single letters +
// menus.ts shortcut strings), so the menus, the command palette, the
// Keyboard Shortcuts window and the actual keydown DISPATCH can never drift.
// User remaps are an override map persisted to localStorage (covered by the
// settings export/import/reset whitelist); `null` unbinds a shortcut.
//
// Pure and Node-testable: parsing, formatting, canonicalization, effective
// resolution and conflict detection have no DOM dependencies (eventToBinding
// takes a plain {key, ctrlKey, …} shape).

import { MENUS } from "./menus";
import { TOOL_GROUPS } from "./tools";

export interface KeyBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Normalized key: single chars lowercase ("z", "'", "+"), named keys as-is
   *  ("F6", "Enter"). "=" is aliased to "+" (zoom-in accepts both, layouts vary). */
  key: string;
}

export type ShortcutId = string; // "tool:<toolId>" | "menu:<action>" | "cmd:<name>"

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: string; // section title in the shortcuts window
  /** Default binding string ("Ctrl+Shift+Z"), or null (no default binding). */
  def: string | null;
  /** False = shown for reference but not rebindable (e.g. paste — the browser's
   *  paste EVENT drives it, not a keydown we dispatch). */
  remappable: boolean;
}

/** Commands that have a key but no menu item (dispatched by Editor). */
const EXTRA_COMMANDS: ShortcutDef[] = [
  { id: "cmd:swap-colors", label: "Swap foreground/background colours", group: "Tools", def: "X", remappable: true },
];

/** Menu actions the key dispatcher must NEVER fire (other machinery owns them). */
const DISPATCH_EXCLUDED = new Set<string>(["menu:edit-paste"]);
export const isDispatchable = (id: ShortcutId): boolean => !DISPATCH_EXCLUDED.has(id);

/** The full registry, in display order (defaults only — no user state). */
export function buildShortcutDefs(): ShortcutDef[] {
  const out: ShortcutDef[] = [];
  for (const t of TOOL_GROUPS.flat()) {
    out.push({ id: `tool:${t.id}`, label: t.name, group: "Tools", def: t.shortcut, remappable: true });
  }
  out.push(...EXTRA_COMMANDS);
  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (!item.action) continue; // placeholders can't dispatch
      const id = `menu:${item.action}`;
      out.push({
        id,
        label: item.label.replace(/…$/, ""),
        group: `${menu.label} menu`,
        def: item.shortcut ?? null,
        remappable: !DISPATCH_EXCLUDED.has(id),
      });
    }
  }
  return out;
}

const ALIAS_KEY: Record<string, string> = { "=": "+" }; // Ctrl+= means zoom in too

const normalizeKey = (raw: string): string => {
  const k = raw.length === 1 ? raw.toLowerCase() : raw;
  return ALIAS_KEY[k] ?? k;
};

/** Parse "Ctrl+Alt+Shift+T" / "Shift+F6" / "Ctrl++" / "V" into a binding.
 *  Modifiers are stripped from the front; whatever remains is the key VERBATIM
 *  — which is what makes a literal "+" key ("Ctrl++") unambiguous. */
export function parseShortcut(str: string): KeyBinding | null {
  if (!str) return null;
  const b: KeyBinding = { ctrl: false, alt: false, shift: false, key: "" };
  let rest = str.trim();
  const mod = /^(ctrl|cmd|meta|alt|option|shift)\+/i;
  for (let m = mod.exec(rest); m; m = mod.exec(rest)) {
    const low = m[1].toLowerCase();
    if (low === "ctrl" || low === "cmd" || low === "meta") b.ctrl = true;
    else if (low === "alt" || low === "option") b.alt = true;
    else b.shift = true;
    rest = rest.slice(m[0].length);
  }
  if (!rest) return null;
  // The key: one character, or a named key (F6, Enter, Home, …).
  if (rest.length > 1 && !/^[A-Za-z][A-Za-z0-9]*$/.test(rest)) return null;
  b.key = normalizeKey(rest);
  return b;
}

/** Display form: "Ctrl+Alt+Shift+K" (single letters uppercased). */
export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return parts.join("+");
}

/** Canonical identity for matching/conflicts. */
export const canonicalBinding = (b: KeyBinding): string =>
  `${b.ctrl ? 1 : 0}${b.alt ? 1 : 0}${b.shift ? 1 : 0}:${b.key}`;

/** Normalize a keyboard event (or event-shaped object) into a binding; null
 *  for bare modifier presses. Meta (Cmd) folds into ctrl. */
export function eventToBinding(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): KeyBinding | null {
  if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return null;
  return {
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normalizeKey(e.key),
  };
}

// ---- User overrides ---------------------------------------------------------

/** id → new shortcut string, or null = explicitly unbound. Absent = default. */
export type ShortcutOverrides = Record<ShortcutId, string | null>;

export const SHORTCUTS_KEY = "graphiq:shortcuts";

export function loadShortcutOverrides(): ShortcutOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ShortcutOverrides = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null) out[id] = null;
      else if (typeof v === "string" && parseShortcut(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveShortcutOverrides(o: ShortcutOverrides): void {
  try {
    window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

/** The effective binding of one def under the overrides (null = unbound). */
export function effectiveBinding(def: ShortcutDef, overrides: ShortcutOverrides): KeyBinding | null {
  if (def.id in overrides) {
    const v = overrides[def.id];
    return v === null ? null : parseShortcut(v);
  }
  return def.def ? parseShortcut(def.def) : null;
}

/** Effective display label ("Ctrl+Z") for a def, or "" when unbound. */
export function effectiveLabel(def: ShortcutDef, overrides: ShortcutOverrides): string {
  const b = effectiveBinding(def, overrides);
  return b ? formatBinding(b) : "";
}

/**
 * The dispatch index: canonical binding → defs bound to it, in registry order.
 * (Defaults contain benign duplicates — e.g. Bucket and Gradient both ship on
 * G — and the dispatcher takes the FIRST, matching the old TOOL_BY_KEY rule.)
 */
export function buildDispatchIndex(
  defs: ShortcutDef[],
  overrides: ShortcutOverrides,
): Map<string, ShortcutDef[]> {
  const map = new Map<string, ShortcutDef[]>();
  for (const d of defs) {
    if (!isDispatchable(d.id)) continue;
    const b = effectiveBinding(d, overrides);
    if (!b) continue;
    const c = canonicalBinding(b);
    const list = map.get(c);
    if (list) list.push(d);
    else map.set(c, [d]);
  }
  return map;
}

/** First OTHER def whose effective binding equals `binding` (for steal/warn). */
export function conflictOf(
  defs: ShortcutDef[],
  overrides: ShortcutOverrides,
  id: ShortcutId,
  binding: KeyBinding,
): ShortcutDef | null {
  const c = canonicalBinding(binding);
  for (const d of defs) {
    if (d.id === id) continue;
    const b = effectiveBinding(d, overrides);
    if (b && canonicalBinding(b) === c) return d;
  }
  return null;
}
