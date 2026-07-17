// Local-storage inspection for Settings ▸ Scratch disks / storage.
//
// A browser app has no scratch-disk files: work in progress lives in memory,
// and what persists sits in origin storage — IndexedDB (autosave snapshots,
// the recent-files store) and localStorage (settings + saved presets). These
// helpers surface what is stored, how much space the origin uses, and honest
// clear actions. Everything is best-effort: a blocked storage API must never
// break the dialog (nulls mean "unknown", not an error).

import { readAutosave } from "./autosave";
import { SETTINGS_KEYS } from "./settings";

/** localStorage keys that hold user CONTENT (presets), not configuration —
 *  deliberately excluded from settings export/reset (see settings.ts), so the
 *  Storage tab is the one place they can be cleared. Legacy `aperture:*`
 *  twins are pre-rebrand keys that older sessions may still hold. */
export const PRESET_KEYS: readonly string[] = [
  "graphiq:swatches",
  "graphiq:gradient-presets",
  "graphiq:gradient-presets-fx",
  "graphiq:adjust-presets", // AdjustmentsPanel's saved filters
  "graphiq:export-presets",
  "graphiq:actions", // Actions panel macros
  "aperture:swatches",
  "aperture:gradient-presets",
  "aperture:adjust-presets",
];

/** 1234567 → "1.2 MB" (SI steps of 1024, one decimal below 10). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Origin-wide storage estimate (covers IndexedDB + caches for this site). */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    if (typeof e.usage !== "number" || typeof e.quota !== "number") return null;
    return { usage: e.usage, quota: e.quota };
  } catch {
    return null;
  }
}

/** Is this origin's storage persistent (protected from browser eviction)?
 *  null = the API is unavailable. */
export async function isPersisted(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/** Ask the browser to protect this origin's storage from automatic cleanup.
 *  Browsers grant it silently based on engagement — no prompt is guaranteed. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

const bytesOfKeys = (keys: readonly string[]): number => {
  let total = 0;
  try {
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v !== null) total += k.length + v.length; // UTF-16 units ≈ bytes for this data
    }
  } catch {
    /* storage blocked — report what we could read */
  }
  return total;
};

/** Approximate bytes localStorage holds for app settings / saved presets. */
export const settingsBytes = (): number => bytesOfKeys(SETTINGS_KEYS);
export const presetsBytes = (): number => bytesOfKeys(PRESET_KEYS);

/** Delete every saved preset (swatches, gradients, filters, export presets). */
export function clearPresets(): void {
  try {
    for (const k of PRESET_KEYS) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** The stored crash-recovery snapshot, summarized (null = none / unreadable). */
export async function autosaveInfo(): Promise<{ savedAt: number; docs: number; bytes: number } | null> {
  const snap = await readAutosave();
  if (!snap) return null;
  let bytes = 0;
  for (const d of snap.docs) bytes += d.json.length + d.name.length;
  return { savedAt: snap.savedAt, docs: snap.docs.length, bytes };
}
