"use client";

/**
 * Fill with a pattern — the first thing the tile library is FOR.
 *
 * The library and its picker are the roadmap's prerequisite; the two features
 * named as waiting on them (pattern text fills, pattern fill layers) are their
 * own jobs. This is the smallest consumer that makes the library reachable
 * rather than dead code: it fills the selection — or the whole layer, if there
 * is none — with a repeating tile, through the same `fillSelection` that a
 * colour fill goes through, so it lands as one undoable "Fill".
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import PatternPicker from "./PatternPicker";
import { DEFAULT_PLACEMENT, loadPatternTile, type PatternPlacement } from "../lib/patterns";
import styles from "./PatternFillDialog.module.scss";

export interface PatternFillResult {
  tile: CanvasImageSource;
  width: number;
  height: number;
  placement: PatternPlacement;
}

export default function PatternFillDialog({
  onFill,
  onClose,
}: {
  onFill: (r: PatternFillResult) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState<string | null>("b-checker");
  const [scale, setScale] = useState(100);
  const [rotate, setRotate] = useState(0);
  const [busy, setBusy] = useState(false);

  /* Escape closes, and it is handled here rather than left to the shell so the
     dialog does not also dismiss whatever is behind it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const fill = async () => {
    if (!id || busy) return;
    setBusy(true);
    const tile = await loadPatternTile(id);
    setBusy(false);
    if (!tile) {
      onClose();
      return;
    }
    const w = "width" in tile ? Number(tile.width) : 1;
    const h = "height" in tile ? Number(tile.height) : 1;
    onFill({
      tile,
      width: w,
      height: h,
      placement: {
        ...DEFAULT_PLACEMENT,
        scale: Math.max(0.05, scale / 100),
        rotate: (rotate * Math.PI) / 180,
      },
    });
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Fill with pattern"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Fill with pattern</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <PatternPicker selectedId={id} onSelect={setId} />

          <label className={styles.row}>
            <span>Scale</span>
            <input
              type="range"
              min={10}
              max={400}
              step={1}
              value={scale}
              aria-label="Pattern scale"
              onChange={(e) => setScale(+e.target.value)}
            />
            <output>{scale}%</output>
          </label>

          <label className={styles.row}>
            <span>Angle</span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={rotate}
              aria-label="Pattern angle"
              onChange={(e) => setRotate(+e.target.value)}
            />
            <output>{rotate}°</output>
          </label>
        </div>

        <footer className={styles.foot}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" data-primary disabled={!id || busy} onClick={() => void fill()}>
            Fill
          </button>
        </footer>
      </div>
    </div>
  );
}
