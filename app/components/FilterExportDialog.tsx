"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { adjustToThumbFilter, type AdjustPreset } from "../lib/adjust";
import { exportPresets } from "../lib/filterio";

export default function FilterExportDialog({
  presets,
  onClose,
}: {
  presets: AdjustPreset[];
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(presets.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const allOn = sel.size === presets.length && presets.length > 0;

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSel(allOn ? new Set() : new Set(presets.map((p) => p.id)));

  const doExport = async () => {
    const chosen = presets.filter((p) => sel.has(p.id));
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      await exportPresets(chosen);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Export filters"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Export filters</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <button type="button" className={styles.checkAll} onClick={toggleAll}>
            <span className={styles.check} data-on={allOn}>
              {allOn && <Check size={11} />}
            </span>
            Select all ({presets.length})
          </button>

          <div className={styles.checkList}>
            {presets.map((p) => {
              const on = sel.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={styles.checkRow}
                  data-on={on}
                  onClick={() => toggle(p.id)}
                >
                  <span className={styles.check} data-on={on}>
                    {on && <Check size={11} />}
                  </span>
                  <span className={styles.checkSwatch} style={{ filter: adjustToThumbFilter(p.adjust) }} />
                  <span className={styles.checkName} title={p.name}>
                    {p.name}
                  </span>
                </button>
              );
            })}
          </div>

          <p className={styles.sub}>
            {sel.size > 1
              ? "Saved as a folder of .gifp files (or a single .gifpack bundle)."
              : "Saved as a single .gifp file."}
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={!sel.size || busy}
            onClick={doExport}
          >
            Export {sel.size || ""}
          </button>
        </footer>
      </div>
    </div>
  );
}
