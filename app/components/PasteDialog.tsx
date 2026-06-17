"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";

export type PasteDest = "new-layer" | "current-layer" | "new-canvas";

const DESTS: { value: PasteDest; title: string; desc: string }[] = [
  { value: "new-layer", title: "New layer", desc: "Add a new layer with the pasted image" },
  { value: "current-layer", title: "Current layer", desc: "Draw onto the selected layer" },
  { value: "new-canvas", title: "New canvas", desc: "Open the image as its own document" },
];

export default function PasteDialog({
  width,
  height,
  docWidth,
  docHeight,
  source,
  onApply,
  onClose,
}: {
  width: number;
  height: number;
  docWidth: number;
  docHeight: number;
  source: CanvasImageSource;
  onApply: (opts: { dest: PasteDest; expand: boolean }) => void;
  onClose: () => void;
}) {
  const [dest, setDest] = useState<PasteDest>("current-layer");
  const [expand, setExpand] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = previewRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const scale = Math.min(c.width / width, c.height / height, 1);
    const w = width * scale;
    const h = height * scale;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }, [source, width, height]);

  // Keep / Expand only make sense when the image is bigger than the canvas.
  const biggerThanCanvas = width > docWidth || height > docHeight;
  const showCanvasSize = dest !== "new-canvas" && biggerThanCanvas;

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Paste image"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") onApply({ dest, expand });
        }}
      >
        <header className={styles.head}>
          <h2>Paste image</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewRow}>
            <canvas ref={previewRef} width={132} height={96} className={styles.preview} />
            <div className={styles.meta}>
              <div className={styles.dim}>
                {width} × {height} px
              </div>
              <div className={styles.sub}>Clipboard image</div>
            </div>
          </div>

          <span className={styles.groupLabel}>Paste into</span>
          <div className={styles.options}>
            {DESTS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={styles.option}
                data-active={dest === o.value}
                onClick={() => setDest(o.value)}
              >
                <span className={styles.radio} />
                <span className={styles.optText}>
                  <strong>{o.title}</strong>
                  <em>{o.desc}</em>
                </span>
              </button>
            ))}
          </div>

          {showCanvasSize && (
            <>
              <span className={styles.groupLabel}>Canvas size</span>
              <div className={styles.options}>
                <button
                  type="button"
                  className={styles.option}
                  data-active={!expand}
                  onClick={() => setExpand(false)}
                >
                  <span className={styles.radio} />
                  <span className={styles.optText}>
                    <strong>Keep canvas size</strong>
                    <em>Anything outside the canvas is cropped</em>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.option}
                  data-active={expand}
                  onClick={() => setExpand(true)}
                >
                  <span className={styles.radio} />
                  <span className={styles.optText}>
                    <strong>Expand to fit image</strong>
                    <em>Grow the canvas to hold the whole image</em>
                  </span>
                </button>
              </div>
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
            onClick={() => onApply({ dest, expand })}
          >
            Paste
          </button>
        </footer>
      </div>
    </div>
  );
}
