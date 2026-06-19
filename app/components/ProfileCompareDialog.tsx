"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";

const PROFILES: { value: PredefinedColorSpace; label: string }[] = [
  { value: "srgb", label: "sRGB" },
  { value: "display-p3", label: "Display P3" },
];

function Pane({
  composite,
  profile,
  onProfile,
}: {
  composite: HTMLCanvasElement | null;
  profile: PredefinedColorSpace;
  onProfile: (p: PredefinedColorSpace) => void;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <select
        value={profile}
        onChange={(e) => onProfile(e.target.value as PredefinedColorSpace)}
        aria-label="Profile"
        style={{
          height: 30,
          padding: "0 8px",
          fontSize: 12.5,
          fontWeight: 550,
          color: "var(--text)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          outline: "none",
        }}
      >
        {PROFILES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <canvas
        key={profile}
        width={252}
        height={190}
        className={styles.preview}
        style={{ width: "100%", height: 190 }}
        ref={(el) => {
          const ctx = el?.getContext("2d", { colorSpace: profile });
          if (!el || !ctx) return;
          ctx.clearRect(0, 0, el.width, el.height);
          if (!composite) return;
          const s = Math.min(el.width / composite.width, el.height / composite.height, 1);
          const w = composite.width * s;
          const h = composite.height * s;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(composite, (el.width - w) / 2, (el.height - h) / 2, w, h);
        }}
      />
    </div>
  );
}

export default function ProfileCompareDialog({
  composite,
  onClose,
}: {
  composite: HTMLCanvasElement | null;
  onClose: () => void;
}) {
  const [left, setLeft] = useState<PredefinedColorSpace>("srgb");
  const [right, setRight] = useState<PredefinedColorSpace>("display-p3");

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Compare color profiles"
        style={{ width: 580, maxWidth: "calc(100vw - 32px)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className={styles.head}>
          <h2>Compare Color Profiles</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div style={{ display: "flex", gap: 12 }}>
            <Pane composite={composite} profile={left} onProfile={setLeft} />
            <Pane composite={composite} profile={right} onProfile={setRight} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
              {composite ? `${composite.width} × ${composite.height} px` : "Empty canvas"}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
              Soft proof — your image through each profile
            </span>
          </div>
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
