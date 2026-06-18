"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { ColorChip, Slider, Toggle } from "./Controls";
import { availableFormats, type ExportFormat, type ExportOptions } from "../lib/imageio";

export default function ExportDialog({
  composite,
  defaultName,
  onExport,
  onClose,
}: {
  composite: HTMLCanvasElement;
  defaultName: string;
  onExport: (opts: ExportOptions, filename: string) => void;
  onClose: () => void;
}) {
  const [formats] = useState(() => availableFormats());
  const [format, setFormat] = useState<ExportFormat>(formats[0]);
  const [quality, setQuality] = useState(92);
  const [transparent, setTransparent] = useState(true);
  const [matte, setMatte] = useState("#ffffffff");
  const [scalePct, setScalePct] = useState(100);
  const [name, setName] = useState(defaultName);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const effTransparent = transparent && format.alpha;
  const outW = Math.max(1, Math.round(composite.width * (scalePct / 100)));
  const outH = Math.max(1, Math.round(composite.height * (scalePct / 100)));

  // Draw a checker-backed preview of the composite.
  useEffect(() => {
    const c = previewRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const scale = Math.min(c.width / composite.width, c.height / composite.height, 1);
    const w = composite.width * scale;
    const h = composite.height * scale;
    ctx.clearRect(0, 0, c.width, c.height);
    const x = (c.width - w) / 2;
    const y = (c.height - h) / 2;
    if (!effTransparent) {
      ctx.fillStyle = matte;
      ctx.fillRect(x, y, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(composite, x, y, w, h);
  }, [composite, effTransparent, matte]);

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
        aria-label="Export image"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") onExport(opts(), name);
        }}
      >
        <header className={styles.head}>
          <h2>Export As</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewRow}>
            <canvas ref={previewRef} width={132} height={96} className={styles.preview} />
            <div className={styles.meta}>
              <div className={styles.dim}>
                {outW} × {outH} px
              </div>
              <div className={styles.sub}>{format.label} · 8-bit / channel</div>
            </div>
          </div>

          <span className={styles.groupLabel}>Format</span>
          <select
            style={{ ...field, padding: "0 8px" }}
            value={format.id}
            onChange={(e) => setFormat(formats.find((f) => f.id === e.target.value) ?? formats[0])}
            aria-label="Format"
          >
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} (.{f.ext})
              </option>
            ))}
          </select>

          {format.lossy && (
            <Slider label="Quality" unit="%" value={quality} onChange={setQuality} />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
            {format.alpha && (
              <Toggle label="Transparent" checked={transparent} onChange={setTransparent} />
            )}
            {!effTransparent && <ColorChip color={matte} onChange={setMatte} label="Background" />}
          </div>

          <span className={styles.groupLabel}>Scale</span>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            <input
              type="number"
              min={1}
              max={1000}
              value={scalePct}
              onChange={(e) => setScalePct(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))}
              style={{ ...field, width: 90 }}
              aria-label="Scale percent"
            />
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>%</span>
          </div>

          <span className={styles.groupLabel}>File name</span>
          <input
            style={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-label="File name"
          />
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => onExport(opts(), name)}
          >
            Export
          </button>
        </footer>
      </div>
    </div>
  );

  function opts(): ExportOptions {
    return {
      format,
      quality: quality / 100,
      scale: scalePct / 100,
      transparent,
      matte,
    };
  }
}
