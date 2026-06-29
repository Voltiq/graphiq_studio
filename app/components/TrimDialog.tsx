"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { Toggle } from "./Controls";

export type TrimMode = "transparent" | "top-left" | "bottom-right";
export interface TrimSides {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

const MODES: { value: TrimMode; title: string; desc: string }[] = [
  { value: "transparent", title: "Transparent Pixels", desc: "Trim away fully transparent edges" },
  { value: "top-left", title: "Top-Left Pixel Color", desc: "Trim edges matching the top-left pixel" },
  { value: "bottom-right", title: "Bottom-Right Pixel Color", desc: "Trim edges matching the bottom-right pixel" },
];

export default function TrimDialog({
  onTrim,
  onClose,
}: {
  onTrim: (mode: TrimMode, sides: TrimSides) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TrimMode>("transparent");
  const [sides, setSides] = useState<TrimSides>({ top: true, bottom: true, left: true, right: true });
  const apply = () => onTrim(mode, sides);

  // Escape/Enter close/apply — captured so they don't leak to the editor shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        apply();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sides, onTrim, onClose]);

  const SIDES: { key: keyof TrimSides; label: string }[] = [
    { key: "top", label: "Top" },
    { key: "bottom", label: "Bottom" },
    { key: "left", label: "Left" },
    { key: "right", label: "Right" },
  ];

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Trim"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Trim</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <span className={styles.groupLabel}>Based on</span>
            <div className={styles.options}>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={styles.option}
                  data-active={mode === m.value}
                  onClick={() => setMode(m.value)}
                >
                  <span className={styles.radio} />
                  <span className={styles.optText}>
                    <strong>{m.title}</strong>
                    <em>{m.desc}</em>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <span className={styles.groupLabel}>Trim away</span>
            {SIDES.map((s) => (
              <div key={s.key} className={styles.row}>
                <div className={styles.rowText}>
                  <strong>{s.label}</strong>
                </div>
                <Toggle
                  label=""
                  checked={sides[s.key]}
                  onChange={(v) => setSides((prev) => ({ ...prev, [s.key]: v }))}
                />
              </div>
            ))}
          </section>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={apply}>
            Trim
          </button>
        </footer>
      </div>
    </div>
  );
}
