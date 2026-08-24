"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";

/**
 * Rename the open document.
 *
 * Renaming used to be reachable exactly one way — clicking the already-active
 * tab — which made it a casualty of reclaiming the tab strip on a phone, and
 * meant a desktop keyboard user could never do it at all. As a menu action it
 * is in the command palette too, so on a phone it is one search away.
 *
 * Deliberately the same shape as `SaveAsDialog`: one field, Enter commits,
 * Escape closes.
 */
export default function RenameDocDialog({
  defaultName,
  onRename,
  onClose,
}: {
  defaultName: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) onRename(trimmed);
    onClose();
  };

  const field: React.CSSProperties = {
    width: "100%",
    height: 34,
    padding: "0 10px",
    fontSize: 13,
    color: "var(--text)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    outline: "none",
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Rename document"
        data-rename-doc
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") commit();
        }}
      >
        <header className={styles.head}>
          <h2>Rename document</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <span className={styles.groupLabel}>Name</span>
          <input
            autoFocus
            style={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-label="Document name"
          />
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={commit}
            disabled={!name.trim()}
          >
            Rename
          </button>
        </footer>
      </div>
    </div>
  );
}
