"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Select, Slider, Toggle } from "./Controls";
import { buildPdf, layoutPage, PAPER_SIZES, type PdfLayoutOptions } from "../lib/pdf";
import { saveExportBlob } from "../lib/share";

/**
 * Export the flattened composite as a single-page PDF (hand-written writer):
 * page sized to the image at a chosen DPI, or to a paper size with margins —
 * fit-to-margins or actual-size-at-DPI, centred. The image embeds as JPEG
 * (small) or lossless deflated RGB; transparency mattes over white.
 */
export default function ExportPdfDialog({
  docName,
  docDpi,
  width,
  height,
  author,
  getComposite,
  onClose,
}: {
  docName: string;
  docDpi: number;
  width: number;
  height: number;
  author: string;
  getComposite: () => HTMLCanvasElement | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"image" | "paper">("image");
  const [dpi, setDpi] = useState(docDpi);
  const [paperId, setPaperId] = useState("a4");
  const [landscape, setLandscape] = useState(false);
  const [marginMm, setMarginMm] = useState(10);
  const [fit, setFit] = useState(true);
  const [comp, setComp] = useState<"jpeg" | "rgb">("jpeg");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);

  const paper = PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0];
  const opts: PdfLayoutOptions = { mode, dpi, paper, landscape, marginMm, fit };
  const layout = layoutPage(width, height, opts);
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const src = getComposite();
      if (!src) return;
      // Matte over white — PDF pages are opaque (and canvas→JPEG mattes black).
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, 0, 0);
      let data: Uint8Array;
      if (comp === "jpeg") {
        const blob = await new Promise<Blob | null>((res) =>
          c.toBlob((b) => res(b), "image/jpeg", quality / 100),
        );
        if (!blob) return;
        data = new Uint8Array(await blob.arrayBuffer());
      } else {
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        data = new Uint8Array(c.width * c.height * 3);
        for (let p = 0, o = 0; p < px.length; p += 4) {
          data[o++] = px[p];
          data[o++] = px[p + 1];
          data[o++] = px[p + 2];
        }
      }
      const pdf = await buildPdf(
        { data, kind: comp, pxW: c.width, pxH: c.height },
        layoutPage(c.width, c.height, opts),
        { title: docName, author: author || undefined },
      );
      const safe = (docName.trim() || "graphiq").replace(/[\\/:*?"<>|]+/g, "-");
      void saveExportBlob(new Blob([pdf], { type: "application/pdf" }), `${safe}.pdf`);
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
        aria-label="Export PDF"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Export PDF</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Page</span>
          <Segmented
            options={[
              { value: "image", text: "Image size", title: "Page exactly fits the image at the chosen resolution" },
              { value: "paper", text: "Paper size", title: "Standard paper with margins" },
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

          <span className={styles.groupLabel}>Image compression</span>
          <Segmented
            options={[
              { value: "jpeg", text: "JPEG", title: "Small file — the image embeds as a JPEG" },
              { value: "rgb", text: "Lossless", title: "Exact pixels, deflate-compressed — larger file" },
            ]}
            value={comp}
            onChange={(v) => setComp(v as "jpeg" | "rgb")}
          />
          {comp === "jpeg" && (
            <Slider label="Quality" min={60} max={100} step={1} value={quality} onChange={setQuality} />
          )}

          <p className={styles.note}>
            Single page, {mm(layout.pageW)}×{mm(layout.pageH)} mm — the flattened composite
            {mode === "paper" ? (fit ? ", scaled to the margin box." : ` at ${dpi} ppi, centred.`) : ` at ${dpi} ppi.`}
            {" "}Transparency mattes over white; title{author ? " and author" : ""} go into the PDF info.
            {layout.overflow ? " ⚠ At this resolution the image overflows the margins — it will clip at the page edge." : ""}
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void doExport()}>
            {busy ? "Encoding…" : "Export .pdf"}
          </button>
        </footer>
      </div>
    </div>
  );
}
