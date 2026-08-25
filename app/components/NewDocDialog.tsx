"use client";

import { useEffect, useState } from "react";
import { sharedCeiling } from "../lib/canvas-ceiling";
import { X } from "lucide-react";
import styles from "./CanvasSizeDialog.module.scss";

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Full HD — 1920 × 1080", w: 1920, h: 1080 },
  { label: "4K UHD — 3840 × 2160", w: 3840, h: 2160 },
  { label: "Square — 2048 × 2048", w: 2048, h: 2048 },
  { label: "Portrait — 1080 × 1350", w: 1080, h: 1350 },
  { label: "Story — 1080 × 1920", w: 1080, h: 1920 },
  { label: "A4 @ 300 dpi — 2480 × 3508", w: 2480, h: 3508 },
];
/* 8192 is the product's own ceiling; the probed one is the browser's. Taking
   the lower of the two means a browser that cannot hold 8192 on a side — which
   is not hypothetical, WebKit's limits are far tighter than Chromium's — caps
   the dialog rather than letting it offer a document that opens blank. */
const sizeCap = () => Math.min(8192, sharedCeiling().maxSide || 8192);
const clampSize = (v: number) => Math.max(1, Math.min(sizeCap(), Math.round(v) || 0));

/** File ▸ New… — name + canvas size (presets or custom). Preferences can skip
 *  this dialog entirely and create with the stored defaults instead. */
export default function NewDocDialog({
  defaultName,
  defaultWidth,
  defaultHeight,
  defaultDpi = 300,
  onCreate,
  onClose,
}: {
  defaultName: string;
  defaultWidth: number;
  defaultHeight: number;
  defaultDpi?: number;
  onCreate: (opts: { name: string; width: number; height: number; dpi: number }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [w, setW] = useState(defaultWidth);
  const [h, setH] = useState(defaultHeight);
  const [dpi, setDpi] = useState(defaultDpi);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const create = () =>
    onCreate({
      name: name.trim() || defaultName,
      width: clampSize(w),
      height: clampSize(h),
      dpi: Math.max(1, Math.min(1200, Math.round(dpi) || 300)),
    });
  const preset = PRESETS.find((p) => p.w === w && p.h === h);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="New document"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      >
        <header className={styles.head}>
          <h2>New document</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Name</span>
            <div className={styles.numBox}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ fontFamily: "inherit", textAlign: "left" }} />
            </div>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Preset</span>
            <select
              className={styles.preset}
              value={preset ? preset.label : "custom"}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.label === e.target.value);
                if (p) {
                  setW(p.w);
                  setH(p.h);
                }
              }}
            >
              {!preset && <option value="custom">Custom</option>}
              {PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Width</span>
            <div className={styles.numBox}>
              <input type="number" min={1} max={sizeCap()} value={w} onChange={(e) => setW(Number(e.target.value))} />
              <span className={styles.unit}>px</span>
            </div>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Height</span>
            <div className={styles.numBox}>
              <input type="number" min={1} max={sizeCap()} value={h} onChange={(e) => setH(Number(e.target.value))} />
              <span className={styles.unit}>px</span>
            </div>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Resolution</span>
            <div className={styles.numBox}>
              <input type="number" min={1} max={1200} value={dpi} onChange={(e) => setDpi(Number(e.target.value))} />
              <span className={styles.unit}>ppi</span>
            </div>
          </div>
          <p className={styles.hint}>
            Tired of this dialog? Turn it off under Settings ▸ Preferences ▸ Editing — new documents
            then use your default size.
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={create}>
            Create
          </button>
        </footer>
      </div>
    </div>
  );
}
