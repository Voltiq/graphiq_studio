import { cookies } from "next/headers";
import {
  ACCENT_COOKIE,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  THEME_COOKIE,
  isAccent,
  type Accent,
  type Theme,
} from "./theme";

/**
 * Server-side helper. Reads the persisted theme from cookies so the correct
 * `data-theme` can be rendered on the very first paint (no flash of wrong theme).
 */
export async function getServerTheme(): Promise<Theme> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : DEFAULT_THEME;
}

/** Same for the theme colour (`data-accent`). */
export async function getServerAccent(): Promise<Accent> {
  const store = await cookies();
  const value = store.get(ACCENT_COOKIE)?.value;
  return isAccent(value) ? value : DEFAULT_ACCENT;
}
