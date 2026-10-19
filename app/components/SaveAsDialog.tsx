"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { PROJECT_EXT } from "../lib/project";

export default function SaveAsDialog({
  defaultName,
  onSave,
  onClose,
}: {
  defaultName: string;
  onSave: (filename: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);

  /* Layout only — the look (and the focus halo) is `.gq-field` in
     globals.scss. No inline font-size: Safari on iOS zooms the page for a
     field under 16px, and an inline value outranks the touch floor there. */
  const field: React.CSSProperties = {
    width: "100%",
    height: 34,
    padding: "0 10px",
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Save project as"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") onSave(name);
        }}
      >
        <header className={styles.head}>
          <h2>Save as</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <span className={styles.groupLabel}>File name</span>
          <input
            autoFocus
            className="gq-field" style={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-label="File name"
          />

          <span className={styles.groupLabel}>Format</span>
          <select className="gq-field" style={{ ...field, padding: "0 8px" }} defaultValue="project" aria-label="File format">
            <option value="project">Graphiq Project (.{PROJECT_EXT})</option>
          </select>

          <p style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.45, margin: 0 }}>
            Project files keep every layer, group, blend mode and setting so you can keep editing
            later. To save a flat image (PNG / JPG), use <strong>Export</strong>.
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => onSave(name)}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
