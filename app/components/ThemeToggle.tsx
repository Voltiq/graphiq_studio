"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_COOKIE, isTheme, type Theme } from "../lib/theme";
import styles from "./TopBar.module.scss";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Set + persist the theme (shared with the Preferences appearance tab). */
export function applyTheme(next: Theme) {
  document.documentElement.setAttribute("data-theme", next);
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
}

/** The theme currently rendered on <html> (live, not the stale server value). */
export function currentTheme(fallback: Theme): Theme {
  if (typeof document !== "undefined") {
    const t = document.documentElement.getAttribute("data-theme");
    if (isTheme(t)) return t;
  }
  return fallback;
}

/** Is the document visually dark right now (resolves `system` via the OS)? */
export function resolvedDark(theme: Theme): boolean {
  if (theme === "system")
    return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return theme === "dark";
}

/** Magiq-style quick toggle: a quiet icon button that flips light ↔ dark.
 *  From `system` it jumps to the explicit opposite of the current look. */
export default function ThemeToggle({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme(initialTheme));

  const isDark = resolvedDark(theme);

  const toggle = () => {
    const next: Theme = isDark ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={toggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
