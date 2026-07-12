"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import logo from "../icon.png";
import pkg from "../../package.json";

/** Help ▸ About: what this is, the version, and the local-only promise. */
export default function AboutDialog({
  onOpenGuide,
  onOpenShortcuts,
  onClose,
}: {
  onOpenGuide: () => void;
  onOpenShortcuts: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        style={{ width: 460 }}
        role="dialog"
        aria-modal="true"
        aria-label="About Graphiq Studio"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>About Graphiq Studio</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.aboutBrand}>
            <span className={styles.aboutLogo}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo.src} alt="" />
            </span>
            <span className={styles.aboutName}>
              <strong>
                Graphiq <em>Studio</em>
              </strong>
              <span className={styles.aboutVersion}>Version {pkg.version}</span>
            </span>
          </div>

          <p className={styles.aboutBlurb}>
            A layered photo editor that runs entirely in your browser. The imaging engine —
            compositing, brushes, selections, adjustments, filters — is hand-written on the
            Canvas&nbsp;2D API, with no image-processing libraries and no server: your pictures
            never leave this device.
          </p>

          <div className={styles.statsCard}>
            <div className={styles.statRow}>
              <span>Projects</span>
              <strong>.gproj — layers, masks, adjustments, styles, filters</strong>
            </div>
            <div className={styles.statRow}>
              <span>Opens</span>
              <strong>PNG · JPEG · WebP · AVIF · SVG · PSD · DNG/RAW</strong>
            </div>
            <div className={styles.statRow}>
              <span>Exports</span>
              <strong>PNG · JPEG · WebP · AVIF · PSD · SVG · .cube</strong>
            </div>
            <div className={styles.statRow}>
              <span>Color</span>
              <strong>sRGB · Display P3 · Adobe RGB (emulated)</strong>
            </div>
            <div className={styles.statRow}>
              <span>Privacy</span>
              <strong>100% local — no uploads, no account</strong>
            </div>
          </div>
        </div>

        <footer className={styles.foot} style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              onClose();
              onOpenGuide();
            }}
          >
            Getting started
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              onClose();
              onOpenShortcuts();
            }}
          >
            Keyboard shortcuts
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
