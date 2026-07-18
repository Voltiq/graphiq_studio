import { cookies } from "next/headers";
import {
  ACCENT_COOKIE,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  THEME_COOKIE,
  isAccent,
  isTheme,
  type Accent,
  type Theme,
} from "./theme";
import { DEFAULT_UISCALE, UISCALE_COOKIE, isUiScale, type UiScale } from "./ui-scale";

/**
 * Server-side helper. Reads the persisted theme from cookies so the correct
 * `data-theme` can be rendered on the very first paint (no flash of wrong theme).
 */
export async function getServerTheme(): Promise<Theme> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : DEFAULT_THEME;
}

/** Same for the accent colour (`data-accent`). */
export async function getServerAccent(): Promise<Accent> {
  const store = await cookies();
  const value = store.get(ACCENT_COOKIE)?.value;
  return isAccent(value) ? value : DEFAULT_ACCENT;
}

/** Same for the interface scale (`data-uiscale`). */
export async function getServerUiScale(): Promise<UiScale> {
  const store = await cookies();
  const value = store.get(UISCALE_COOKIE)?.value;
  return isUiScale(value) ? value : DEFAULT_UISCALE;
}
