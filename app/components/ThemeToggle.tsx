"use client";

import { useEffect, useState } from "react";
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

  // `system` resolves via matchMedia, which the server can't know — so the
  // first client render must NOT consult it (hydration must match the SSR
  // markup). Resolve after mount, and track live OS theme changes while the
  // theme stays on `system`.
  const [sysDark, setSysDark] = useState(false);
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSysDark(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [theme]);

  const isDark = theme === "system" ? sysDark : theme === "dark";

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
