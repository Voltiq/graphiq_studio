/** Client-safe theme constants & types (no server-only imports here). */

/** `system` follows the OS via prefers-color-scheme ("Match system"). */
export type Theme = "dark" | "light" | "system";

export const THEME_COOKIE = "pe-theme";
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light" || v === "system";
}

/* ------------------------------ Accent -------------------------------------
   Seven hues that recolour the accent (and everything derived from it — the
   fill gradient, selected tints, focus ring, active tool) in both themes.
   Persisted in a cookie and rendered server-side as `data-accent` on <html>.
   The CSS side is globals.scss: one `--accent-solid` per accent, with the
   per-theme text role derived by color-mix. Keep the two lists in step. */

export type Accent = "iris" | "blue" | "teal" | "green" | "purple" | "magenta" | "orange";

export const ACCENT_COOKIE = "pe-accent";
export const DEFAULT_ACCENT: Accent = "iris";

/** Picker metadata. `fill` is the accent as a fill (white text on it ≥ 5:1) and
 *  what the picker's dot shows; `light` / `dark` are the accent's TEXT role on
 *  each theme (`--accent`: the fill mixed 14% toward black, or 38% toward white,
 *  in OKLab), which is what has to stay distinct from the semantic colours. */
export const ACCENTS: { id: Accent; label: string; fill: string; light: string; dark: string }[] = [
  { id: "iris", label: "Iris", fill: "#6457F0", light: "#5046C4", dark: "#979CFB" },
  { id: "blue", label: "Blue", fill: "#2563EB", light: "#1C50C0", dark: "#77A3F8" },
  { id: "teal", label: "Teal", fill: "#0F766E", light: "#0A5F59", dark: "#77A9A2" },
  { id: "green", label: "Green", fill: "#15803D", light: "#0F6830", dark: "#7AB085" },
  { id: "purple", label: "Purple", fill: "#9333EA", light: "#7728BF", dark: "#BA8CF7" },
  { id: "magenta", label: "Magenta", fill: "#C2336A", light: "#9E2855", dark: "#E086A0" },
  { id: "orange", label: "Orange", fill: "#C2410C", light: "#9E3308", dark: "#E08D73" },
];

export function isAccent(v: unknown): v is Accent {
  return typeof v === "string" && ACCENTS.some((a) => a.id === v);
}
