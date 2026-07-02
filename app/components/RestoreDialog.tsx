"use client";

import { useEffect } from "react";
import { History, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import type { AutosaveSnapshot } from "../lib/autosave";

/** Offered after an unclean exit: restore the last autosaved snapshot. */
export default function RestoreDialog({
  snap,
  onRestore,
  onDiscard,
}: {
  snap: AutosaveSnapshot;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onDiscard();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDiscard]);

  const when = new Date(snap.savedAt).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });

  return (
    <div className={styles.overlay} onMouseDown={onDiscard}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Restore session"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRestore();
        }}
      >
        <header className={styles.head}>
          <h2>Restore last session?</h2>
          <button type="button" className={styles.close} onClick={onDiscard} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <div className={styles.previewRow}>
            <div className={styles.meta}>
              <div className={styles.dim}>
                <History size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                {snap.name}
              </div>
              <div className={styles.sub}>Autosaved {when} — the app didn&apos;t close cleanly.</div>
            </div>
          </div>
          <span className={styles.note}>
            Restore opens the snapshot as a document; Discard deletes it. Autosave runs every few
            minutes (Settings ▸ Preferences ▸ Editing).
          </span>
        </div>
        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onRestore}>
            Restore
          </button>
        </footer>
      </div>
    </div>
  );
}
