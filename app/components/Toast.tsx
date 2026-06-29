"use client";

import { Info, X } from "lucide-react";
import styles from "./Toast.module.scss";

/** A small, non-blocking notification banner (auto-dismiss handled by the caller). */
export default function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <Info size={15} className={styles.icon} />
      <span className={styles.msg}>{message}</span>
      <button type="button" className={styles.close} onClick={onClose} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
