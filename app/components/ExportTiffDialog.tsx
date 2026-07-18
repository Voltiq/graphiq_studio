"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Toggle } from "./Controls";
import { encodeTiff } from "../lib/tiff";
import { downloadBlob } from "../lib/project";

/**
 * Export the flattened composite as a TIFF (little-endian, Deflate-compressed
 * strips, straight alpha). 16-bit widens the 8-bit canvas (v·257) for
 * pipelines that expect 16-bit files — it adds no precision of its own.
 */
export default function ExportTiffDialog({
  docName,
  dpi,
  getComposite,
  onClose,
}: {
  docName: string;
  dpi: number;
  getComposite: () => HTMLCanvasElement | null;
  onClose: () => void;
}) {
  const [bits, setBits] = useState<8 | 16>(8);
  const [alpha, setAlpha] = useState(true);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let c = getComposite();
      if (!c) return;
      if (!alpha) {
        // No alpha channel → matte transparency over white first.
        const m = document.createElement("canvas");
        m.width = c.width;
        m.height = c.height;
        const mc = m.getContext("2d");
        if (!mc) return;
        mc.fillStyle = "#ffffff";
        mc.fillRect(0, 0, m.width, m.height);
        mc.drawImage(c, 0, 0);
        c = m;
      }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      const bytes = await encodeTiff(rgba, c.width, c.height, { bits, dpi, alpha });
      const safe = (docName.trim() || "graphiq").replace(/[\\/:*?"<>|]+/g, "-");
      downloadBlob(new Blob([bytes], { type: "image/tiff" }), `${safe}.tif`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Export TIFF"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") void doExport();
        }}
      >
        <header className={styles.head}>
          <h2>Export TIFF</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Bit depth</span>
          <Segmented
            options={[
              { value: "8", text: "8-bit", title: "8 bits per channel — what the canvas holds" },
              { value: "16", text: "16-bit", title: "16 bits per channel — canvas bytes widened (v·257) for 16-bit pipelines" },
            ]}
            value={String(bits)}
            onChange={(v) => setBits(Number(v) as 8 | 16)}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Transparency (alpha channel)</span>
            <Toggle label="Transparency" checked={alpha} onChange={setAlpha} />
          </div>
          <p className={styles.note}>
            Flattened composite, Deflate-compressed, {dpi} ppi.
            {bits === 16
              ? " 16-bit widens the 8-bit canvas — useful for 16-bit pipelines, but it can't add precision the canvas doesn't have."
              : ""}
            {alpha ? " Alpha is written straight (unassociated)." : " Transparency mattes over white."}
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void doExport()}>
            {busy ? "Encoding…" : "Export .tif"}
          </button>
        </footer>
      </div>
    </div>
  );
}
