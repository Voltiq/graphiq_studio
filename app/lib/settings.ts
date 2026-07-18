// Whole-app settings reset / export / import (Preferences footer).
//
// "Settings" = configuration only: the Preferences model, tool options, panel
// layout/visibility, view toggles, working colour space, proof target, and the
// theme/accent/UI-scale cookies. Deliberately EXCLUDED (user content, not settings):
// saved gradient presets, swatches, adjustment presets, the recent-files list,
// and autosave snapshots (crash-recovery data).
//
// Import and reset apply by reloading the page — every consumer reads its keys
// on boot, so a reload is the one honest way to apply everything atomically.

/** localStorage keys that constitute app settings (a strict whitelist — the
 *  import path writes nothing outside this list). */
export const SETTINGS_KEYS: readonly string[] = [
  "graphiq:preferences", // the Preferences dialog model
  "graphiq:shortcuts", // keyboard-shortcut remaps (shortcuts.ts overrides)
  "graphiq:tool-settings", // options-bar state per tool, colours, marquee shape
  "graphiq:panel-order", // global panel order (both docks render from it)
  "graphiq:panel-open", // panel collapsed state
  "graphiq:panel-layout", // dock membership (left/right) + floating positions
  "graphiq:workspaces", // named workspace snapshots
  "pe-view", // rulers / grid / snap
  "pe-panels", // Window-menu panel visibility
  "pe-colorspace", // working colour space
  "pe-proof-target", // soft-proof target
  "graphiq:welcomed", // first-run tour seen (reset ⇒ the tour greets again)
];

/** Cookie-based settings (server-rendered on boot to avoid theme flash). */
const SETTINGS_COOKIES: readonly string[] = ["pe-theme", "pe-accent", "pe-uiscale"];

const ONE_YEAR = 60 * 60 * 24 * 365;

export interface SettingsFile {
  format: "graphiq-settings";
  version: 1;
  savedAt: string;
  /** localStorage values, stored opaquely (each already JSON or a plain word). */
  values: Record<string, string>;
  cookies: Record<string, string>;
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Snapshot every present setting into a portable JSON structure. */
export function exportSettings(): SettingsFile {
  const values: Record<string, string> = {};
  for (const k of SETTINGS_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) values[k] = v;
  }
  const cookies: Record<string, string> = {};
  for (const c of SETTINGS_COOKIES) {
    const v = readCookie(c);
    if (v !== null) cookies[c] = v;
  }
  return { format: "graphiq-settings", version: 1, savedAt: new Date().toISOString(), values, cookies };
}

/** Parse + apply an exported settings file. Only whitelisted keys are written.
 *  Returns false (writing nothing) when the file isn't a settings export.
 *  The caller reloads the page to apply. */
export function importSettings(text: string): boolean {
  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(text) as SettingsFile;
  } catch {
    return false;
  }
  if (!parsed || parsed.format !== "graphiq-settings" || parsed.version !== 1) return false;
  if (typeof parsed.values !== "object" || parsed.values === null) return false;
  try {
    for (const k of SETTINGS_KEYS) {
      const v = parsed.values[k];
      if (typeof v === "string") localStorage.setItem(k, v);
      else localStorage.removeItem(k); // absent in the file = that setting's default
    }
    for (const c of SETTINGS_COOKIES) {
      const v = parsed.cookies?.[c];
      if (typeof v === "string")
        document.cookie = `${c}=${encodeURIComponent(v)}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
      else document.cookie = `${c}=; path=/; max-age=0; SameSite=Lax`;
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove every setting (localStorage keys + theme/accent cookies) so the app
 *  boots with factory defaults. User content (gradients, swatches, presets,
 *  recents, autosave snapshots) is untouched. The caller reloads to apply. */
export function resetSettings(): void {
  try {
    for (const k of SETTINGS_KEYS) localStorage.removeItem(k);
  } catch {
    /* storage unavailable — nothing to reset */
  }
  for (const c of SETTINGS_COOKIES) document.cookie = `${c}=; path=/; max-age=0; SameSite=Lax`;
}

/** Download the current settings as `graphiq-settings.json`. */
export function downloadSettings(): void {
  const blob = new Blob([JSON.stringify(exportSettings(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "graphiq-settings.json";
  a.click();
  URL.revokeObjectURL(url);
}
