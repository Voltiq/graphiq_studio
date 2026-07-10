"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import prefStyles from "./PreferencesDialog.module.scss";
import { Segmented } from "./Controls";
import { isDefaultAdjust, type Adjustments } from "../lib/adjust";
import type { LayerNode } from "../lib/layers";
import {
  LUT_SIZES,
  captureLut,
  collectLayerLutOps,
  cubeText,
  sliderLutOps,
  type LutCollectResult,
} from "../lib/lut-export";
import { downloadBlob } from "../lib/project";

/**
 * Export the document's colour adjustments as a 3D .cube LUT: either the
 * visible adjustment-layer stack or the Adjustments panel's current sliders,
 * sampled through the exact compositor math over an identity lattice. The
 * result re-imports via Layer ▸ Adjustment: color lookup — and anywhere else
 * .cube files work (video editors, other photo tools).
 */
export default function ExportLutDialog({
  layers,
  panelAdjust,
  docName,
  onClose,
}: {
  layers: LayerNode[];
  panelAdjust: Adjustments;
  docName: string;
  onClose: () => void;
}) {
  const layerResult = useMemo(() => collectLayerLutOps(layers), [layers]);
  const slidersDirty = !isDefaultAdjust(panelAdjust);
  const [source, setSource] = useState<"layers" | "sliders">(
    layerResult.ops.length || !slidersDirty ? "layers" : "sliders",
  );
  const [size, setSize] = useState<number>(33);
  const [title, setTitle] = useState(`${docName || "Graphiq"} look`);

  const result: LutCollectResult =
    source === "layers"
      ? layerResult
      : slidersDirty
        ? sliderLutOps(panelAdjust)
        : { ops: [], notes: ["The panel sliders are all neutral — nothing to capture."] };

  const canExport = result.ops.length > 0;

  const doExport = () => {
    if (!canExport) return;
    const table = captureLut(result.ops, size);
    const text = cubeText(table, size, title);
    const safe = (title.trim() || "graphiq-look").replace(/[\\/:*?"<>|]+/g, "-");
    downloadBlob(new Blob([text], { type: "text/plain" }), `${safe}.cube`);
    onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Export LUT"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && canExport) doExport();
        }}
      >
        <header className={styles.head}>
          <h2>Export LUT (.cube)</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Capture</span>
          <div className={styles.options}>
            <button
              type="button"
              className={styles.option}
              data-active={source === "layers"}
              onClick={() => setSource("layers")}
            >
              <span className={styles.radio} />
              <span className={styles.optText}>
                <strong>Adjustment layers</strong>
                <em>
                  {layerResult.ops.length
                    ? `The ${layerResult.ops.length} visible adjustment layer${layerResult.ops.length === 1 ? "" : "s"}, bottom to top, with opacity and blend`
                    : "No capturable adjustment layers in this document"}
                </em>
              </span>
            </button>
            <button
              type="button"
              className={styles.option}
              data-active={source === "sliders"}
              onClick={() => setSource("sliders")}
            >
              <span className={styles.radio} />
              <span className={styles.optText}>
                <strong>Adjustments panel sliders</strong>
                <em>
                  {slidersDirty
                    ? "The panel's current (unapplied) slider values"
                    : "The panel sliders are currently neutral"}
                </em>
              </span>
            </button>
          </div>

          <span className={styles.groupLabel}>Grid size</span>
          <Segmented
            options={LUT_SIZES.map((n) => ({
              value: String(n),
              text: `${n}³`,
              title: `${n}×${n}×${n} lattice (${n * n * n} rows)`,
            }))}
            value={String(size)}
            onChange={(v) => setSize(Number(v))}
          />
          <p className={styles.note}>
            33³ suits most looks; 65³ captures steep curves more precisely (larger file).
          </p>

          <span className={styles.groupLabel}>Title</span>
          <div className={prefStyles.searchBox}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="LUT title"
              aria-label="LUT title"
            />
          </div>

          {result.notes.length > 0 && (
            <>
              <span className={styles.groupLabel}>Notes</span>
              {result.notes.map((n, i) => (
                <p key={i} className={styles.note}>
                  {n}
                </p>
              ))}
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
            disabled={!canExport}
            onClick={doExport}
          >
            Export .cube
          </button>
        </footer>
      </div>
    </div>
  );
}
