"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_COOKIE, type Theme } from "../lib/theme";
import styles from "./TopBar.module.scss";

const ONE_YEAR = 60 * 60 * 24 * 365;

export default function ThemeToggle({ initialTheme }: { initialTheme: Theme }) {
  // Read the live theme on mount (e.g. when re-opening Preferences) so the switch
  // reflects the current document, not the possibly-stale server value.
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document !== "undefined") {
      const t = document.documentElement.getAttribute("data-theme");
      if (t === "light" || t === "dark") return t;
    }
    return initialTheme;
  });

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    // Persist for next visit and reflect immediately on the document.
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
  };

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className={styles.themeToggle}
      onClick={toggle}
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      <span className={styles.themeTrack} data-dark={isDark}>
        <span className={styles.themeThumb}>
          {isDark ? <Moon size={12} /> : <Sun size={12} />}
        </span>
      </span>
    </button>
  );
}
