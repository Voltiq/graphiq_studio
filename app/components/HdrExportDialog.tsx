"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Slider } from "./Controls";
import { encodeHdrPng, hasHdrDisplay, type HdrImage, type HdrTransfer } from "../lib/hdr";
import { downloadBlob } from "../lib/project";

/**
 * Export the document's float radiance source as a TRUE HDR PNG: 16-bit RGB
 * tagged Rec.2100 (cICP chunk) with a PQ or HLG transfer — HDR-capable
 * browsers and viewers render its highlights beyond SDR white.
 */
export default function HdrExportDialog({
  hdr,
  docName,
  onClose,
}: {
  hdr: HdrImage;
  docName: string;
  onClose: () => void;
}) {
  const [transfer, setTransfer] = useState<HdrTransfer>("pq");
  const [peak, setPeak] = useState(1000);
  const [exposure, setExposure] = useState(0);
  const [busy, setBusy] = useState(false);
  const hdrScreen = hasHdrDisplay();

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await encodeHdrPng(hdr, { transfer, peak, exposure, sdrWhite: 203 });
      const safe = (docName.trim() || "graphiq").replace(/[\\/:*?"<>|]+/g, "-");
      downloadBlob(blob, `${safe}-hdr.png`);
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
        aria-label="Export HDR PNG"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") void doExport();
        }}
      >
        <header className={styles.head}>
          <h2>Export HDR PNG</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Transfer</span>
          <Segmented
            options={[
              { value: "pq", text: "PQ", title: "SMPTE ST 2084 — absolute nits, the common HDR-photo choice" },
              { value: "hlg", text: "HLG", title: "Hybrid Log-Gamma — display-relative, broadcast-style" },
            ]}
            value={transfer}
            onChange={(v) => setTransfer(v as HdrTransfer)}
          />
          {transfer === "pq" && (
            <Slider label="Peak luminance" min={400} max={4000} step={100} value={peak} onChange={setPeak} unit=" nits" />
          )}
          <Slider label="Exposure" min={-2} max={2} step={0.1} bipolar value={exposure} onChange={setExposure} unit=" ev" />
          <p className={styles.note}>
            Writes a 16-bit Rec.2100 PNG (cICP-tagged) from the document&apos;s float
            radiance — SDR white sits at 203 nits{transfer === "pq" ? `, highlights clip at ${peak} nits` : ""}.
            {hdrScreen
              ? " This display reports HDR headroom, so the exported file's highlights will actually glow here."
              : " This display looks SDR — the file still carries HDR and will shine on HDR screens."}
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void doExport()}>
            {busy ? "Encoding…" : "Export PNG"}
          </button>
        </footer>
      </div>
    </div>
  );
}
