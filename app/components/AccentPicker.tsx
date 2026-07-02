"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { ACCENTS, ACCENT_COOKIE, DEFAULT_ACCENT, isAccent, type Accent } from "../lib/theme";
import styles from "./PreferencesDialog.module.scss";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Theme-colour swatch row. Applies immediately (like ThemeToggle) by setting
 *  `data-accent` on <html> and persisting to a cookie for the next visit. */
export default function AccentPicker({ onPick }: { onPick?: (a: Accent) => void }) {
  // Read the live value on mount so re-opening Preferences reflects reality.
  const [accent, setAccent] = useState<Accent>(() => {
    if (typeof document !== "undefined") {
      const a = document.documentElement.getAttribute("data-accent");
      if (isAccent(a)) return a;
    }
    return DEFAULT_ACCENT;
  });

  const pick = (a: Accent) => {
    setAccent(a);
    document.documentElement.setAttribute("data-accent", a);
    document.cookie = `${ACCENT_COOKIE}=${a}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
    onPick?.(a);
  };

  return (
    <div className={styles.accentRow} role="radiogroup" aria-label="Theme colour">
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={styles.accentSwatch}
          style={{ background: a.swatch }}
          data-active={accent === a.id}
          role="radio"
          aria-checked={accent === a.id}
          aria-label={a.label}
          title={a.label}
          onClick={() => pick(a.id)}
        >
          {accent === a.id && (
            <Check size={13} strokeWidth={3} style={{ color: a.id === "mono" ? "#171717" : "rgba(20,10,4,0.8)" }} />
          )}
        </button>
      ))}
    </div>
  );
}
