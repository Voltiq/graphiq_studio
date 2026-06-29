// User preferences, persisted to localStorage (separate from per-document state).

/** Where a clipboard paste goes by default. "ask" shows the paste dialog. */
export type PasteDefault = "ask" | "new-layer" | "current-layer" | "new-canvas";

export interface Preferences {
  /** Default destination for pasted clipboard images. */
  defaultPaste: PasteDefault;
  /** Snap the gradient midpoint to the centre when it's dragged close. */
  gradientSnap: boolean;
  /** Max history rows shown before the History panel becomes scrollable. */
  maxHistory: number;
}

export const DEFAULT_PREFS: Preferences = {
  defaultPaste: "ask",
  gradientSnap: true,
  maxHistory: 25,
};

const KEY = "graphiq:preferences";
const LEGACY_KEY = "aperture:preferences"; // pre-rebrand key, read once as a fallback

export function loadPrefs(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
