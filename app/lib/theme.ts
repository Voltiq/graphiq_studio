/** Client-safe theme constants & types (no server-only imports here). */

/** `system` follows the OS via prefers-color-scheme (Magiq's "Match system"). */
export type Theme = "dark" | "light" | "system";

export const THEME_COOKIE = "pe-theme";
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light" || v === "system";
}

/* ------------------------------ Accent -------------------------------------
   The Magiq accent set: six hues that recolour `--accent` (and everything
   derived from it — selected fills, focus ring, active tools) per theme.
   Persisted in a cookie and rendered server-side as `data-accent` on <html>. */

export type Accent = "blue" | "teal" | "green" | "purple" | "magenta" | "orange";

export const ACCENT_COOKIE = "pe-accent";
export const DEFAULT_ACCENT: Accent = "blue";

/** Picker metadata: the light + dark swatches (shown per current theme). */
export const ACCENTS: { id: Accent; label: string; light: string; dark: string }[] = [
  { id: "blue", label: "Blue", light: "#1868DB", dark: "#669DF1" },
  { id: "teal", label: "Teal", light: "#2898BD", dark: "#42B2D7" },
  { id: "green", label: "Green", light: "#22A06B", dark: "#2ABB7F" },
  { id: "purple", label: "Purple", light: "#964AC0", dark: "#BF63F3" },
  { id: "magenta", label: "Magenta", light: "#CD519D", dark: "#DA62AC" },
  { id: "orange", label: "Orange", light: "#E06C00", dark: "#F68909" },
];

export function isAccent(v: unknown): v is Accent {
  return typeof v === "string" && ACCENTS.some((a) => a.id === v);
}
