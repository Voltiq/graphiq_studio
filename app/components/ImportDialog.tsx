"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";

export type ImportMode = "layers" | "canvas";

export interface ImportItem {
  name: string;
  bitmap: ImageBitmap;
}

function Thumb({ bitmap }: { bitmap: ImageBitmap }) {
  return (
    <canvas
      width={44}
      height={44}
      className={styles.preview}
      style={{ width: 44, height: 44, flexShrink: 0 }}
      ref={(el) => {
        const ctx = el?.getContext("2d");
        if (!el || !ctx) return;
        const s = Math.min(el.width / bitmap.width, el.height / bitmap.height, 1);
        const w = bitmap.width * s;
        const h = bitmap.height * s;
        ctx.clearRect(0, 0, el.width, el.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bitmap, (el.width - w) / 2, (el.height - h) / 2, w, h);
      }}
    />
  );
}

export default function ImportDialog({
  items,
  onImport,
  onClose,
}: {
  items: ImportItem[];
  onImport: (mode: ImportMode) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>("layers");
  const many = items.length > 1;

  const OPTIONS: { value: ImportMode; title: string; desc: string }[] = [
    {
      value: "layers",
      title: many ? "Add as layers" : "Add as a layer",
      desc: `Place ${many ? "each image" : "the image"} on a new layer in the current canvas`,
    },
    {
      value: "canvas",
      title: many ? "New canvas for each" : "New canvas",
      desc: `Open ${many ? "each image as its own document" : "the image as its own document"}`,
    },
  ];

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Import images"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") onImport(mode);
        }}
      >
        <header className={styles.head}>
          <h2>Import {items.length > 1 ? `${items.length} images` : "image"}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {items.slice(0, 8).map((it, i) => (
              <Thumb key={i} bitmap={it.bitmap} />
            ))}
            {items.length > 8 && (
              <span
                className={styles.preview}
                style={{
                  width: 44,
                  height: 44,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 12,
                  color: "var(--text-3)",
                }}
              >
                +{items.length - 8}
              </span>
            )}
          </div>

          <span className={styles.groupLabel}>Import as</span>
          <div className={styles.options}>
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={styles.option}
                data-active={mode === o.value}
                onClick={() => setMode(o.value)}
              >
                <span className={styles.radio} />
                <span className={styles.optText}>
                  <strong>{o.title}</strong>
                  <em>{o.desc}</em>
                </span>
              </button>
            ))}
          </div>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => onImport(mode)}
          >
            Import
          </button>
        </footer>
      </div>
    </div>
  );
}
