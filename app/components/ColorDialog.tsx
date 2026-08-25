"use client";

import { useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { p3Supported } from "../lib/imageio";
import { PROOF_TARGET_LABELS, proofIsIdentity, canvasSpaceOf, type ProofTarget, type WorkingSpace } from "../lib/colorspace";

const PROOF_TARGETS: ProofTarget[] = ["srgb", "display-p3", "adobe-rgb"];

export default function ColorDialog({
  colorSpace,
  onColorSpace,
  proofTarget,
  onProofTarget,
  proofColors,
  gamutWarn,
  onProofColors,
  onGamutWarn,
  onClose,
}: {
  colorSpace: WorkingSpace;
  onColorSpace: (ws: WorkingSpace) => void;
  proofTarget: ProofTarget;
  onProofTarget: (t: ProofTarget) => void;
  proofColors: boolean;
  gamutWarn: boolean;
  onProofColors: (on: boolean) => void;
  onGamutWarn: (on: boolean) => void;
  onClose: () => void;
}) {
  const [supported] = useState(() => p3Supported());

  const opt = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 12px",
    /* No inline font-size: Safari on iOS zooms the page for a field under
       16px, and an inline value outranks the touch floor in globals.scss.
       The stylesheet sizes this now. */
    fontWeight: 550,
    textAlign: "center",
    borderRadius: "var(--r-sm)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "rgba(var(--accent-rgb), 0.12)" : "var(--surface-2)",
    color: active ? "var(--text)" : "var(--text-2)",
  });

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Color management"
        style={{ width: 360 }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className={styles.head}>
          <h2>Color management</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <span className={styles.groupLabel}>Working color space</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={opt(colorSpace === "srgb")} onClick={() => onColorSpace("srgb")}>
              sRGB
            </button>
            <button
              type="button"
              style={{ ...opt(colorSpace === "display-p3"), opacity: supported ? 1 : 0.4 }}
              disabled={!supported}
              onClick={() => onColorSpace("display-p3")}
            >
              Display P3 (wide gamut)
            </button>
            <button
              type="button"
              style={opt(colorSpace === "adobe-rgb")}
              onClick={() => onColorSpace("adobe-rgb")}
            >
              Adobe RGB (1998)
            </button>
          </div>
          {!supported && (
            <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0 }}>
              This browser doesn&apos;t support a Display-P3 canvas.
            </p>
          )}

          <p style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5, margin: 0 }}>
            Display P3 keeps wide-gamut color through editing and export; imported profiled images
            are converted into the working space, and the canvas is color-managed to your display.
            The choice is remembered.
          </p>
          <p style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5, margin: 0 }}>
            <strong style={{ color: "var(--text-2)" }}>Adobe RGB is emulated</strong>: browsers
            can&apos;t display or store an Adobe RGB canvas, so pixels stay in sRGB on screen and
            in exports. Adjustment layers, the Adjustments panel and Curves/Levels run their math
            in Adobe RGB primaries (matrix-converted per pass), matching how those edits behave in
            an Adobe RGB workflow — but colors outside sRGB still clip. Switching to or from it is
            lossless.
          </p>

          <span className={styles.groupLabel}>Soft proofing</span>
          <div style={{ display: "flex", gap: 8 }}>
            {PROOF_TARGETS.map((t) => (
              <button key={t} type="button" style={opt(proofTarget === t)} onClick={() => onProofTarget(t)}>
                {PROOF_TARGET_LABELS[t]}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={opt(proofColors)} onClick={() => onProofColors(!proofColors)}>
              Proof colors (Ctrl+Alt+Y)
            </button>
            <button type="button" style={opt(gamutWarn)} onClick={() => onGamutWarn(!gamutWarn)}>
              Gamut warning (Ctrl+Alt+Shift+Y)
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5, margin: 0 }}>
            Proofing simulates the target space on the view only — exports are untouched. Colors
            outside the target&apos;s gamut clip (Proof colors) or highlight mid-gray (Gamut
            warning).
            {proofIsIdentity(canvasSpaceOf(colorSpace), proofTarget) &&
              " Every color of the current canvas already fits inside this target, so this combination shows no difference — proof a Display P3 document against sRGB or Adobe RGB to see it work."}
          </p>
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
