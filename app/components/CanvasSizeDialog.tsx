"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Link2Off, X } from "lucide-react";
import styles from "./CanvasSizeDialog.module.scss";
import { Select } from "./Select";

export interface CanvasSize {
  width: number;
  height: number;
}

const MIN = 1;
const MAX = 10000;
const clampDim = (n: number) => Math.min(MAX, Math.max(MIN, n));

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Full HD — 1920 × 1080", w: 1920, h: 1080 },
  { label: "HD — 1280 × 720", w: 1280, h: 720 },
  { label: "4K UHD — 3840 × 2160", w: 3840, h: 2160 },
  { label: "Square — 1080 × 1080", w: 1080, h: 1080 },
  { label: "Portrait — 1080 × 1350", w: 1080, h: 1350 },
  { label: "Story — 1080 × 1920", w: 1080, h: 1920 },
];

export default function CanvasSizeDialog({
  size,
  onApply,
  onClose,
  mode = "canvas",
}: {
  size: CanvasSize;
  onApply: (s: CanvasSize) => void;
  onClose: () => void;
  /** "canvas" = change bounds (content stays); "image" = resample (scale content). */
  mode?: "canvas" | "image";
}) {
  const title = mode === "image" ? "Image Size" : "Canvas Size";
  // Mounted only while open, so state initialises from the current size.
  const [w, setW] = useState(String(size.width));
  const [h, setH] = useState(String(size.height));
  const [locked, setLocked] = useState(true);
  const [anchor, setAnchor] = useState(4); // 3×3 grid index, centre by default
  const ratioRef = useRef(size.width / size.height);
  const widthInputRef = useRef<HTMLInputElement>(null);

  // Select the width field on open.
  useEffect(() => {
    const t = setTimeout(() => widthInputRef.current?.select(), 30);
    return () => clearTimeout(t);
  }, []);

  const onWidth = (val: string) => {
    setW(val);
    const n = parseInt(val, 10);
    if (locked && !isNaN(n)) setH(String(clampDim(Math.round(n / ratioRef.current))));
  };
  const onHeight = (val: string) => {
    setH(val);
    const n = parseInt(val, 10);
    if (locked && !isNaN(n)) setW(String(clampDim(Math.round(n * ratioRef.current))));
  };
  const toggleLock = () => {
    setLocked((l) => {
      const next = !l;
      const nw = parseInt(w, 10);
      const nh = parseInt(h, 10);
      if (next && nw > 0 && nh > 0) ratioRef.current = nw / nh;
      return next;
    });
  };

  const apply = () => {
    onApply({
      width: clampDim(parseInt(w, 10) || size.width),
      height: clampDim(parseInt(h, 10) || size.height),
    });
    onClose();
  };

  const selectPreset = (label: string) => {
    const p = PRESETS.find((x) => x.label === label);
    if (!p) return;
    setW(String(p.w));
    setH(String(p.h));
    ratioRef.current = p.w / p.h;
  };
  const currentPreset =
    PRESETS.find((p) => String(p.w) === w && String(p.h) === h)?.label ?? "";

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter") apply();
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <h2>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.current}>
            Current&nbsp;
            <strong>
              {size.width} × {size.height} px
            </strong>
          </p>

          <div className={styles.row}>
            <span className={styles.rowLabel}>Preset</span>
            <div className={styles.presetField}>
              <Select
                block
                options={["Custom", ...PRESETS.map((p) => p.label)]}
                value={currentPreset || "Custom"}
                onChange={(label) => label !== "Custom" && selectPreset(label)}
              />
            </div>
          </div>

          <div className={styles.dims}>
            <div className={styles.dimFields}>
              <label className={styles.row}>
                <span className={styles.rowLabel}>Width</span>
                <span className={styles.numBox}>
                  <input
                    ref={widthInputRef}
                    type="number"
                    inputMode="numeric"
                    min={MIN}
                    max={MAX}
                    value={w}
                    onChange={(e) => onWidth(e.target.value)}
                  />
                  <span className={styles.unit}>px</span>
                </span>
              </label>
              <label className={styles.row}>
                <span className={styles.rowLabel}>Height</span>
                <span className={styles.numBox}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN}
                    max={MAX}
                    value={h}
                    onChange={(e) => onHeight(e.target.value)}
                  />
                  <span className={styles.unit}>px</span>
                </span>
              </label>
            </div>
            <button
              type="button"
              className={styles.lock}
              data-locked={locked}
              onClick={toggleLock}
              title={locked ? "Proportions locked" : "Proportions unlocked"}
              aria-pressed={locked}
            >
              {locked ? <Link2 size={15} /> : <Link2Off size={15} />}
            </button>
          </div>

          {mode === "canvas" ? (
            <div className={styles.anchorWrap}>
              <span className={styles.rowLabel}>Anchor</span>
              <div className={styles.anchor} role="group" aria-label="Anchor">
                {Array.from({ length: 9 }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    data-active={anchor === i}
                    onClick={() => setAnchor(i)}
                    aria-label={`Anchor ${i + 1}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className={styles.hint}>All layers are scaled to the new dimensions.</p>
          )}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={apply}>
            Resize
          </button>
        </footer>
      </div>
    </div>
  );
}
