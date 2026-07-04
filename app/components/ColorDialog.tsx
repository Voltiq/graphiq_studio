"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { p3Supported } from "../lib/imageio";

export default function ColorDialog({
  colorSpace,
  onColorSpace,
  onClose,
}: {
  colorSpace: PredefinedColorSpace;
  onColorSpace: (cs: PredefinedColorSpace) => void;
  onClose: () => void;
}) {
  const [supported] = useState(() => p3Supported());

  const opt = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 12px",
    fontSize: 12.5,
    fontWeight: 550,
    textAlign: "center",
    borderRadius: "var(--r-sm)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "rgba(var(--accent-rgb), 0.12)" : "var(--surface-2)",
    color: active ? "var(--text)" : "var(--text-2)",
  });

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Color management"
        style={{ width: 360 }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className={styles.head}>
          <h2>Color management</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <span className={styles.groupLabel}>Working color space</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={opt(colorSpace === "srgb")} onClick={() => onColorSpace("srgb")}>
              sRGB
            </button>
            <button
              type="button"
              style={{ ...opt(colorSpace === "display-p3"), opacity: supported ? 1 : 0.4 }}
              disabled={!supported}
              onClick={() => onColorSpace("display-p3")}
            >
              Display P3 (wide gamut)
            </button>
          </div>
          {!supported && (
            <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0 }}>
              This browser doesn&apos;t support a Display-P3 canvas.
            </p>
          )}

          <p style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5, margin: 0 }}>
            Display P3 keeps wide-gamut color through editing and export; imported profiled images
            are converted into the working space, and the canvas is color-managed to your display.
            The choice is remembered.
          </p>
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
