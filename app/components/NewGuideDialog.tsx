"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { NumberField, Segmented } from "./Controls";
import type { Guide, GuideAxis } from "../lib/guides";

/**
 * View ▸ New guide — place a guide at an exact coordinate instead of eyeballing
 * a drag from the ruler. Percentages are offered too, because "the middle" and
 * "the thirds" are what most layout guides actually want, and typing 33.3% beats
 * doing the arithmetic against the document size.
 */
export default function NewGuideDialog({
  width,
  height,
  onAdd,
  onClose,
}: {
  width: number;
  height: number;
  onAdd: (g: Guide) => void;
  onClose: () => void;
}) {
  const [axis, setAxis] = useState<GuideAxis>("v");
  const [mode, setMode] = useState<"px" | "%">("px");
  const [pos, setPos] = useState(50);
  const size = axis === "v" ? width : height;
  const docPos = mode === "px" ? pos : (pos / 100) * size;
  const valid = docPos >= 0 && docPos <= size;

  const submit = () => {
    if (!valid) return;
    onAdd({ axis, pos: Math.round(docPos) });
    onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        style={{ width: 340 }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New guide"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter") submit();
        }}
      >
        <header className={styles.head}>
          <h2>New Guide</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Segmented
            label="Orientation"
            options={[
              { value: "v", text: "Vertical" },
              { value: "h", text: "Horizontal" },
            ]}
            value={axis}
            onChange={(v) => setAxis(v as GuideAxis)}
          />
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <NumberField
              label="Position"
              value={pos}
              onChange={setPos}
              min={0}
              max={mode === "%" ? 100 : size}
              width={80}
            />
            <Segmented
              options={[
                { value: "px", text: "px" },
                { value: "%", text: "%" },
              ]}
              value={mode}
              onChange={(v) => {
                // Keep the same line when switching units, not the same number.
                const next = v as "px" | "%";
                setPos(
                  next === "%"
                    ? Math.round((docPos / (size || 1)) * 100)
                    : Math.round(docPos),
                );
                setMode(next);
              }}
            />
            <span className={styles.dim} style={{ marginBottom: 8 }}>
              of {size} px
            </span>
          </div>
          <span className={styles.note} style={{ margin: 0 }}>
            {axis === "v" ? "Vertical" : "Horizontal"} guide at{" "}
            {Math.round(docPos)} px. Guides are saved with the document.
          </span>
        </div>
        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={submit}
            disabled={!valid}
          >
            Add guide
          </button>
        </footer>
      </div>
    </div>
  );
}
