"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Select, Slider, Toggle } from "./Controls";
import { layoutPage, PAPER_SIZES, type PdfLayoutOptions } from "../lib/pdf";

/**
 * Print setup — the half of printing the browser's own dialog cannot do.
 *
 * WHAT IS DELIBERATELY NOT HERE. Destination, copies, duplex, colour-vs-mono
 * and the physical paper tray belong to the printer, and the browser's dialog
 * already owns them properly. Rebuilding those would be duplicating a dialog
 * that appears half a second later anyway.
 *
 * WHAT IS. Everything about how the IMAGE sits on the sheet, which the browser
 * knows nothing about because it cannot see a document resolution: printing at
 * a true size in inches, or fitted to the margins, and what resolution that
 * actually lands at. The browser's "scale" is a percentage of the page; it has
 * no notion of ppi, so "print this 300 ppi photo at its real size" is not
 * something it can express. Plus the soft proof, which cannot survive the trip
 * through the print pipeline unless the pixels are transformed before they go.
 *
 * The geometry is `layoutPage` from lib/pdf — the same model the PDF export
 * uses, rather than a second one that would drift from it. Its rect is in PDF
 * coordinates (origin bottom-left); the caller flips it for CSS.
 */
export default function PrintDialog({
  docDpi,
  width,
  height,
  proofLabel,
  onPrint,
  onClose,
}: {
  docDpi: number;
  width: number;
  height: number;
  /** Name of the configured soft proof, or null when none is set up. */
  proofLabel: string | null;
  onPrint: (opts: PdfLayoutOptions, applyProof: boolean) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"image" | "paper">("paper");
  const [dpi, setDpi] = useState(docDpi);
  const [paperId, setPaperId] = useState("a4");
  const [landscape, setLandscape] = useState(false);
  const [marginMm, setMarginMm] = useState(10);
  const [fit, setFit] = useState(true);
  const [proof, setProof] = useState(false);

  const paper = PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0];
  const opts: PdfLayoutOptions = { mode, dpi, paper, landscape, marginMm, fit };
  const layout = layoutPage(width, height, opts);
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  /* What the print will ACTUALLY resolve at once the image has been placed —
     the number that decides whether it looks sharp, and the one the browser's
     percentage scale can never tell you. */
  const effectivePpi = layout.w > 0 ? Math.round(width / (layout.w / 72)) : dpi;

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Print"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Print</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Page</span>
          <Segmented
            options={[
              { value: "paper", text: "Paper size", title: "Standard paper with margins" },
              { value: "image", text: "Image size", title: "Page exactly fits the image at the chosen resolution" },
            ]}
            value={mode}
            onChange={(v) => setMode(v as "image" | "paper")}
          />
          {mode === "paper" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Select
                  options={PAPER_SIZES.map((p) => p.label)}
                  value={paper.label}
                  onChange={(l) => setPaperId(PAPER_SIZES.find((p) => p.label === l)?.id ?? "a4")}
                />
                <Segmented
                  options={[
                    { value: "p", text: "Portrait" },
                    { value: "l", text: "Landscape" },
                  ]}
                  value={landscape ? "l" : "p"}
                  onChange={(v) => setLandscape(v === "l")}
                />
              </div>
              <Slider label="Margin" min={0} max={30} step={1} value={marginMm} onChange={setMarginMm} unit=" mm" />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Fit image to margins</span>
                <Toggle label="Fit image to margins" checked={fit} onChange={setFit} />
              </div>
            </>
          )}
          {(mode === "image" || !fit) && (
            <Slider label="Resolution" min={72} max={600} step={1} value={dpi} onChange={setDpi} unit=" ppi" />
          )}

          {proofLabel && (
            <>
              <span className={styles.groupLabel}>Colour</span>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Print the {proofLabel} soft proof</span>
                <Toggle label={`Print the ${proofLabel} soft proof`} checked={proof} onChange={setProof} />
              </div>
            </>
          )}

          <p className={styles.note}>
            {mm(layout.pageW)}×{mm(layout.pageH)} mm sheet — the image prints{" "}
            {mm(layout.w)}×{mm(layout.h)} mm at <strong>{effectivePpi} ppi</strong>
            {mode === "paper" ? (fit ? ", scaled to the margin box and centred." : ", centred.") : "."}
            {layout.overflow
              ? " ⚠ At this resolution the image is larger than the margin box — it will clip at the page edge."
              : ""}
            {" "}Your printer, paper tray and copies stay with the browser&apos;s own print dialog, which opens next.
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => onPrint(opts, proof && !!proofLabel)}
          >
            Print…
          </button>
        </footer>
      </div>
    </div>
  );
}
