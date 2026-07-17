// Actions (macro) model — TODO §13 Actions panel / §14 recorder core.
//
// An action is a named list of MENU COMMANDS (the ids `handleMenuAction`
// dispatches — menus, palette, shortcuts all funnel through it). Recording
// hooks that one chokepoint; playback re-dispatches the ids with a short gap
// so React state (and the refs the handlers read) commit between steps.
//
// Honest scope: only commands that complete WITHOUT further input are
// recordable. Dialog-openers (Export as…, Image size…, the parameterized
// adjustment/tone editors, smart-filter adds — they open their stack dialog),
// interactive modes (free transform) and UI-only commands (view/window/help)
// are deliberately excluded — a recorded action must replay unattended.
// Tool strokes and dialog settings are NOT captured (§14 leftovers).

import { MENUS } from "./menus";

export interface ActionStep {
  /** The handleMenuAction id to dispatch. */
  action: string;
  /** Label at record time (survives menu renames for display). */
  label: string;
}

export interface SavedAction {
  id: string;
  name: string;
  /** Assigned function key ("F2"…"F10"), or null. */
  fkey: string | null;
  steps: ActionStep[];
}

export const ACTIONS_KEY = "graphiq:actions";

/** Assignable keys — F1/F5/F11/F12 stay with the browser (help, reload,
 *  fullscreen, devtools). */
export const FKEY_CHOICES = ["F2", "F3", "F4", "F6", "F7", "F8", "F9", "F10"] as const;

/** Gap between played steps: lets React commit state + re-point the refs the
 *  next handler reads (they update during render). */
export const PLAYBACK_STEP_MS = 60;

const RECORDABLE_EXACT = new Set<string>([
  "undo",
  "redo",
  "edit-cut",
  "edit-copy",
  "edit-paste",
  "edit-caf",
  "save",
  "print",
  "image-crop",
  "image-rotate-cw",
  "image-rotate-ccw",
  "image-flip-h",
  "image-flip-v",
  "layer-new",
  "layer-duplicate",
  "layer-delete",
  "layer-group",
  "layer-ungroup",
  "layer-merge-down",
  "layer-flatten",
  "layer-clip",
  "mask-add",
  "mask-add-hide",
  "mask-from-sel",
  "mask-delete",
  "mask-apply",
  "mask-to-sel",
  "select-all",
  "select-deselect",
  "select-reselect",
  "select-inverse",
  // Preset (non-dialog) adjustment layers — the parameterized kinds
  // (curves/levels/huesat/selective/chanmix/gradientmap/colorlookup) open
  // their editors, so they are not recordable.
  "adj-brightness-contrast",
  "adj-exposure",
  "adj-vibrance",
  "adj-color-balance",
  "adj-black-white",
  "adj-photo-filter-warm",
  "adj-photo-filter-cool",
  "adj-x-invert",
  "adj-x-equalize",
  "fx-clear",
]);

/** fx-add-* adds a layer effect with defaults — no dialog, replayable. */
const RECORDABLE_PREFIXES = ["fx-add-"];

/** Can this menu command be recorded into an action (replays unattended)? */
export function isRecordable(action: string): boolean {
  if (RECORDABLE_EXACT.has(action)) return true;
  return RECORDABLE_PREFIXES.some((p) => action.startsWith(p));
}

let labelCache: Map<string, string> | null = null;

/** Display label for a menu-action id (trailing … stripped); falls back to the id. */
export function actionLabel(action: string): string {
  if (!labelCache) {
    labelCache = new Map();
    for (const menu of MENUS) {
      for (const item of menu.items) {
        if (item.action && !labelCache.has(item.action)) {
          labelCache.set(item.action, item.label.replace(/…$/, ""));
        }
      }
    }
  }
  return labelCache.get(action) ?? action;
}

/** Every recordable id must exist in the menus — a menus.ts rename would
 *  otherwise silently orphan the allowlist. Exposed for the verify script. */
export function recordableIdsMissingFromMenus(): string[] {
  const known = new Set<string>();
  for (const menu of MENUS) for (const item of menu.items) if (item.action) known.add(item.action);
  return [...RECORDABLE_EXACT].filter((id) => !known.has(id));
}

let actionSeq = 0;
export function freshActionId(): string {
  return `act-${Date.now().toString(36)}-${(actionSeq += 1)}`;
}

/** Coerce arbitrary parsed data into a valid SavedAction list. */
export function coerceActions(raw: unknown): SavedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Partial<SavedAction>;
    if (typeof o.id !== "string" || typeof o.name !== "string" || !Array.isArray(o.steps)) continue;
    const steps = o.steps
      .filter(
        (s): s is ActionStep =>
          !!s && typeof s === "object" && typeof (s as ActionStep).action === "string",
      )
      .map((s) => ({ action: s.action, label: typeof s.label === "string" ? s.label : s.action }));
    const fkey =
      typeof o.fkey === "string" && (FKEY_CHOICES as readonly string[]).includes(o.fkey)
        ? o.fkey
        : null;
    out.push({ id: o.id, name: o.name, fkey, steps });
  }
  return out;
}

export function loadActions(): SavedAction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACTIONS_KEY);
    return raw ? coerceActions(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveActions(list: SavedAction[]): void {
  try {
    window.localStorage.setItem(ACTIONS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Everything the Actions panel needs (implemented by Editor, like LayersApi). */
export interface ActionsApi {
  actions: SavedAction[];
  /** Action id currently recording, or null. */
  recordingId: string | null;
  /** Action id currently playing back, or null. */
  playingId: string | null;
  /** Create a named action and start recording into it. */
  record: (name: string) => void;
  stop: () => void;
  play: (id: string) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  setFKey: (id: string, fkey: string | null) => void;
  removeStep: (id: string, index: number) => void;
}
