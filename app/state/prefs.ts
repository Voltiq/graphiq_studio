// Preferences (TODO 1.5): the Preferences dialog's settings, read where they
// apply — the canvas's checkerboard, grids, snapping, pen and cursors — and
// saved the moment one changes.

import { DEFAULT_PREFS, loadPrefs, savePrefs, type Preferences } from "../lib/prefs";
import { createStore, type Store } from "./store";

export const createPrefs = (): Store<Preferences> => createStore<Preferences>({ ...DEFAULT_PREFS });

/** Bring back the stored Preferences (client-only: there is no storage on the server). */
export function restorePrefs(prefs: Store<Preferences>, load: () => Preferences = loadPrefs): void {
  prefs.set(load());
}

/** Change Preferences and save them, whole, at once. */
export function updatePrefs(
  prefs: Store<Preferences>,
  patch: Partial<Preferences>,
  save: (p: Preferences) => void = savePrefs,
): void {
  prefs.set(patch);
  save(prefs.get());
}
