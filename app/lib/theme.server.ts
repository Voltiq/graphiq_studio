import { cookies } from "next/headers";
import { DEFAULT_THEME, THEME_COOKIE, type Theme } from "./theme";

/**
 * Server-side helper. Reads the persisted theme from cookies so the correct
 * `data-theme` can be rendered on the very first paint (no flash of wrong theme).
 */
export async function getServerTheme(): Promise<Theme> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : DEFAULT_THEME;
}
