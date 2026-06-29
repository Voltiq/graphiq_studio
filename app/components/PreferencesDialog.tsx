"use client";

import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import ThemeToggle from "./ThemeToggle";
import { Slider, Toggle } from "./Controls";
import type { Theme } from "../lib/theme";
import type { PasteDefault, Preferences } from "../lib/prefs";

const PASTE_OPTIONS: { value: PasteDefault; title: string; desc: string }[] = [
  { value: "ask", title: "Ask every time", desc: "Show the paste dialog to choose each time" },
  { value: "new-layer", title: "New layer", desc: "Add a new layer with the pasted image" },
  { value: "current-layer", title: "Current layer", desc: "Draw onto the selected layer" },
  { value: "new-canvas", title: "New canvas", desc: "Open the image as its own document" },
];

export default function PreferencesDialog({
  initialTheme,
  prefs,
  onChange,
  onClose,
}: {
  initialTheme: Theme;
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Preferences</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <span className={styles.groupLabel}>Appearance</span>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <strong>Theme</strong>
                <em>Switch between light and dark mode</em>
              </div>
              <ThemeToggle initialTheme={initialTheme} />
            </div>
          </section>

          <section className={styles.section}>
            <span className={styles.groupLabel}>Pasting</span>
            <div className={styles.options}>
              {PASTE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={styles.option}
                  data-active={prefs.defaultPaste === o.value}
                  onClick={() => onChange({ defaultPaste: o.value })}
                >
                  <span className={styles.radio} />
                  <span className={styles.optText}>
                    <strong>{o.title}</strong>
                    <em>{o.desc}</em>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <span className={styles.groupLabel}>Gradient</span>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <strong>Snap midpoint to centre</strong>
                <em>Snap the gradient's middle line to the centre when it's close</em>
              </div>
              <Toggle
                label=""
                checked={prefs.gradientSnap}
                onChange={(v) => onChange({ gradientSnap: v })}
              />
            </div>
          </section>

          <section className={styles.section}>
            <span className={styles.groupLabel}>History</span>
            <div className={styles.rowText}>
              <em>Max actions shown before the History panel starts scrolling.</em>
            </div>
            <Slider
              label="Max visible actions"
              min={5}
              max={100}
              value={prefs.maxHistory}
              onChange={(n) => onChange({ maxHistory: n })}
            />
          </section>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
