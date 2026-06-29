"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { Slider } from "./Controls";

export default function SelectModifyDialog({
  kind,
  onApply,
  onClose,
}: {
  kind: "feather" | "grow";
  onApply: (px: number) => void;
  onClose: () => void;
}) {
  const feather = kind === "feather";
  const [value, setValue] = useState(feather ? 8 : 4);
  const apply = () => onApply(value);

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
  }, [value, onApply, onClose]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={feather ? "Feather selection" : "Grow selection"}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 360 }}
      >
        <header className={styles.head}>
          <h2>{feather ? "Feather Selection" : "Grow Selection"}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.rowText}>
              <em>
                {feather
                  ? "Soften the selection edges — applied when you fill, delete or move."
                  : "Expand the selection outward by the given number of pixels."}
              </em>
            </div>
            <Slider
              label={feather ? "Radius" : "Expand by"}
              min={feather ? 0 : 1}
              max={feather ? 250 : 500}
              unit="px"
              value={value}
              onChange={setValue}
            />
          </section>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={apply}>
            {feather ? "Feather" : "Grow"}
          </button>
        </footer>
      </div>
    </div>
  );
}
