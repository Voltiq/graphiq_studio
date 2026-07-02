/** Client-safe theme constants & types (no server-only imports here). */

export type Theme = "dark" | "light";

export const THEME_COOKIE = "pe-theme";
export const DEFAULT_THEME: Theme = "dark";

/* ----------------------------- Theme colour --------------------------------
   The accent hue. Besides the accent itself, the neutral surfaces carry a
   slight tint of the chosen colour (see globals.scss: surfaces are
   color-mix'ed from neutral bases + `--tint-rgb`). Persisted in a cookie and
   rendered server-side as `data-accent` on <html> so there is no flash. */

export type Accent = "amber" | "ocean" | "violet" | "emerald" | "rose" | "mono";

export const ACCENT_COOKIE = "pe-accent";
export const DEFAULT_ACCENT: Accent = "amber";

/** Picker metadata. `swatch` is the dark-theme accent (recognisable in both). */
export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "amber", label: "Amber", swatch: "#f5a04c" },
  { id: "ocean", label: "Ocean", swatch: "#5c9bf5" },
  { id: "violet", label: "Violet", swatch: "#a78bfa" },
  { id: "emerald", label: "Emerald", swatch: "#4ade80" },
  { id: "rose", label: "Rose", swatch: "#fb7185" },
  { id: "mono", label: "Mono", swatch: "#e5e5e5" },
];

export function isAccent(v: unknown): v is Accent {
  return typeof v === "string" && ACCENTS.some((a) => a.id === v);
}
