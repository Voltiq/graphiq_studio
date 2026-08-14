"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { Slider } from "./Controls";

/** Per-op copy and slider range. Border/Smooth/Expand/Contract change the
 *  selection's GEOMETRY; Feather only softens how it is used, which is why they
 *  are described differently even though they share one dialog. */
const META: Record<
  "feather" | "grow" | "border" | "smooth" | "expand" | "contract",
  { title: string; blurb: string; label: string; button: string; min: number; max: number; initial: number }
> = {
  feather: {
    button: "Feather",
    title: "Feather selection",
    blurb: "Soften the selection edges — applied when you fill, delete or move.",
    label: "Radius", min: 0, max: 250, initial: 8,
  },
  grow: {
    button: "Grow",
    title: "Grow selection",
    blurb: "Expand the selection outward by the given number of pixels.",
    label: "Expand by", min: 1, max: 500, initial: 4,
  },
  border: {
    button: "Border",
    title: "Border selection",
    blurb: "Replace the selection with a band straddling its edge — half inside, half outside.",
    label: "Width", min: 1, max: 200, initial: 10,
  },
  smooth: {
    button: "Smooth",
    title: "Smooth selection",
    blurb: "Round off corners and speckle. The edge stays hard — use Feather to soften it.",
    label: "Radius", min: 1, max: 100, initial: 4,
  },
  expand: {
    button: "Expand",
    title: "Expand selection",
    blurb: "Grow the selection outward with a round corner, not a square one.",
    label: "Expand by", min: 1, max: 300, initial: 8,
  },
  contract: {
    button: "Contract",
    title: "Contract selection",
    blurb: "Shrink the selection inward. Parts thinner than the amount disappear.",
    label: "Contract by", min: 1, max: 300, initial: 8,
  },
};

export default function SelectModifyDialog({
  kind,
  onApply,
  onClose,
}: {
  kind: "feather" | "grow" | "border" | "smooth" | "expand" | "contract";
  onApply: (px: number) => void;
  onClose: () => void;
}) {
  const meta = META[kind];
  const [value, setValue] = useState(meta.initial);
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
        aria-label={meta.title}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 360 }}
      >
        <header className={styles.head}>
          <h2>{meta.title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.rowText}>
              <em>{meta.blurb}</em>
            </div>
            <Slider
              label={meta.label}
              min={meta.min}
              max={meta.max}
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
            {meta.button}
          </button>
        </footer>
      </div>
    </div>
  );
}
