"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import sizeStyles from "./CanvasSizeDialog.module.scss";
import type { ImageMetadata } from "../lib/metadata";

export type ImportMode = "layers" | "canvas";

/** Layer-import placement + oversize handling. */
export interface ImportOptions {
  /** 3×3 grid index (0 = top-left … 4 = centre … 8 = bottom-right). */
  anchor: number;
  /** Grow the canvas to fit images larger than it (else they crop). */
  expand: boolean;
}

const ANCHOR_NAMES = [
  "Top left",
  "Top center",
  "Top right",
  "Middle left",
  "Center",
  "Middle right",
  "Bottom left",
  "Bottom center",
  "Bottom right",
];

export interface ImportItem {
  name: string;
  bitmap: ImageBitmap;
  /** File/EXIF metadata captured at decode time (for the Metadata panel). */
  meta?: ImageMetadata;
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
  docWidth,
  docHeight,
  onImport,
  onClose,
}: {
  items: ImportItem[];
  docWidth: number;
  docHeight: number;
  onImport: (mode: ImportMode, opts: ImportOptions) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>("layers");
  const [anchor, setAnchor] = useState(4); // centre
  const [expand, setExpand] = useState(true);
  const many = items.length > 1;
  const oversized = items.some((it) => it.bitmap.width > docWidth || it.bitmap.height > docHeight);
  const grownW = Math.max(docWidth, ...items.map((it) => it.bitmap.width));
  const grownH = Math.max(docHeight, ...items.map((it) => it.bitmap.height));
  const opts: ImportOptions = { anchor, expand };

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
          if (e.key === "Enter") onImport(mode, opts);
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

          {mode === "layers" && (
            <>
              <span className={styles.groupLabel}>Placement</span>
              <div className={sizeStyles.anchorWrap}>
                <div className={sizeStyles.anchor} role="group" aria-label="Placement">
                  {ANCHOR_NAMES.map((name, i) => (
                    <button
                      key={name}
                      type="button"
                      data-active={anchor === i}
                      title={name}
                      aria-label={name}
                      onClick={() => setAnchor(i)}
                    />
                  ))}
                </div>
                <span className={sizeStyles.hint}>
                  Where {many ? "the images land" : "the image lands"} on the canvas —{" "}
                  {ANCHOR_NAMES[anchor].toLowerCase()}.
                </span>
              </div>

              {oversized && (
                <>
                  <span className={styles.groupLabel}>Canvas size</span>
                  <div className={styles.options}>
                    <button
                      type="button"
                      className={styles.option}
                      data-active={expand}
                      onClick={() => setExpand(true)}
                    >
                      <span className={styles.radio} />
                      <span className={styles.optText}>
                        <strong>Expand to fit</strong>
                        <em>
                          Grow the canvas to {grownW} × {grownH} px so{" "}
                          {many ? "the largest image fits" : "the image fits"}
                        </em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.option}
                      data-active={!expand}
                      onClick={() => setExpand(false)}
                    >
                      <span className={styles.radio} />
                      <span className={styles.optText}>
                        <strong>Keep canvas size</strong>
                        <em>Anything outside the {docWidth} × {docHeight} px canvas is cropped</em>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => onImport(mode, opts)}
          >
            Import
          </button>
        </footer>
      </div>
    </div>
  );
}
