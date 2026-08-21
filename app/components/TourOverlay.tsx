"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import styles from "./TourOverlay.module.scss";
import { TOUR_STEPS } from "../lib/tour";
import { uiZoom } from "../lib/ui-scale";
import { clampX } from "../lib/safeArea";

/**
 * The interactive onboarding tour: a spotlight over the live chrome (targets
 * found by `data-tour` attributes, re-measured per step and on resize) with a
 * floating card. Centred steps (welcome / finish) have no target. The overlay
 * sits in the zoomed chrome subtree, so all viewport coordinates divide by
 * `uiZoom()` before hitting fixed-position styles — same rule as the popups.
 */
export default function TourOverlay({
  step,
  onStep,
  onClose,
  onOpenSample,
}: {
  step: number;
  onStep: (n: number) => void;
  /** Close the tour (done or skipped — the caller marks it seen either way). */
  onClose: () => void;
  /** Create + open the sample document (offered on the last step). */
  onOpenSample: () => void;
}) {
  const s = TOUR_STEPS[Math.max(0, Math.min(step, TOUR_STEPS.length - 1))];
  const last = step >= TOUR_STEPS.length - 1;
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Measure the target (viewport px) per step + on resize.
  useLayoutEffect(() => {
    const measure = () => {
      if (!s.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector(`[data-tour="${s.target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [s.target]);

  // Keyboard: arrows step, Esc leaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation(); // the tour owns the keyboard while open
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        if (last) onClose();
        else onStep(step + 1);
      } else if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, last, onClose, onStep]);

  const z = uiZoom();
  const pad = 6;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // Spotlight rect in LOCAL px (÷z); centred steps collapse the hole mid-screen.
  const hole = rect
    ? { x: (rect.x - pad) / z, y: (rect.y - pad) / z, w: (rect.w + pad * 2) / z, h: (rect.h + pad * 2) / z }
    : { x: vw / 2 / z, y: vh / 2 / z, w: 0, h: 0 };

  // Card placement: under the target when there's room, above it otherwise,
  // clamped to the viewport; centred steps sit mid-screen.
  const cardW = 340;
  const cardH = 190; // generous estimate — clamping keeps it on screen anyway
  let cx: number;
  let cy: number;
  if (rect) {
    const below = rect.y + rect.h + pad + 12;
    const fitsBelow = below + cardH < vh - 8;
    const yTop = fitsBelow ? below : Math.max(8, rect.y - pad - 12 - cardH);
    cx = clampX(rect.x + rect.w / 2 - cardW / 2, cardW) / z;
    cy = yTop / z;
  } else {
    cx = (vw / 2 - cardW / 2) / z;
    cy = (vh / 2 - cardH / 2) / z;
  }

  return (
    <div className={styles.blanket} role="dialog" aria-modal="true" aria-label="Interactive tour">
      <div
        className={styles.hole}
        style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
      />
      <div className={styles.card} style={{ left: cx, top: cy }}>
        <span className={styles.title}>{s.title}</span>
        <span className={styles.body}>{s.body}</span>
        <div className={styles.foot}>
          <div className={styles.dots} aria-label={`Step ${step + 1} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((t, i) => (
              <span key={t.id} className={styles.dot} data-on={i === step} />
            ))}
          </div>
          {last && (
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                onOpenSample();
                onClose();
              }}
            >
              Open sample
            </button>
          )}
          {step > 0 && !last && (
            <button type="button" className={styles.btn} onClick={() => onStep(step - 1)}>
              Back
            </button>
          )}
          {!last && (
            <button type="button" className={styles.btn} onClick={onClose}>
              Skip
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => (last ? onClose() : onStep(step + 1))}
          >
            {last ? "Done" : step === 0 ? "Take the tour" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
