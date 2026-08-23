"use client";

import { useEffect, useMemo } from "react";
import { Camera, FileImage, RotateCcw, Square } from "lucide-react";
import styles from "./StartCard.module.scss";
import type { RecentImage } from "../lib/recents";

/** Object URLs for the stored thumbnails, revoked when the card goes away.
 *  Without the cleanup every reopen of the card leaks one blob URL per row —
 *  small, but the card is the first thing a phone renders and it renders often. */
function useThumbUrls(recents: RecentImage[]): string[] {
  /* Derived, not stored: making the URLs in an effect meant a first paint with
     no thumbnails and a second render to fill them in. */
  const urls = useMemo(() => recents.map((r) => URL.createObjectURL(r.thumb)), [recents]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

/**
 * The phone's launch state.
 *
 * The app opens on a blank 1920×1080 artboard, which is the right answer for a
 * desktop — you came to make something — and the wrong one for a phone, where
 * the picture you want to edit is already on the device. The card is the first
 * thing a fresh phone sees, and it costs nothing to dismiss.
 *
 * The two pickers are separate inputs rather than one with a toggle, because
 * `capture` is what makes the OS open the camera rather than the photo library,
 * and it is an attribute, not a runtime choice. Both accept `image/*` so the
 * picker filters to pictures instead of showing every file on the device.
 *
 * Rendered ONLY over an untouched document: see `Editor`. It is a start state,
 * not a modal, and it must never appear over work.
 */
export default function StartCard({
  onOpen,
  onCapture,
  onContinue,
  continueLabel,
  recents = [],
  onOpenRecent,
  onDismiss,
}: {
  /** The photo-library picker fired. */
  onOpen: () => void;
  /** The camera picker fired. */
  onCapture: () => void;
  /** Restore the last session's autosave; absent when there is nothing to restore. */
  onContinue?: () => void;
  continueLabel?: string;
  /** Pictures opened before, newest first. */
  recents?: RecentImage[];
  onOpenRecent?: (entry: RecentImage) => void;
  onDismiss: () => void;
}) {
  const thumbs = useThumbUrls(recents);
  return (
    <div className={styles.wrap} data-startcard role="region" aria-label="Start">
      <div className={styles.card}>
        <h2 className={styles.title}>Start with a photo</h2>
        <p className={styles.sub}>Or begin from a blank canvas.</p>

        <button type="button" className={styles.primary} onClick={onOpen} data-start="open">
          <FileImage size={18} />
          Open photo
        </button>
        <button type="button" className={styles.action} onClick={onCapture} data-start="camera">
          <Camera size={18} />
          Take photo
        </button>
        {recents.length > 0 && onOpenRecent && (
          <div className={styles.recents} data-recents>
            <span className={styles.groupLabel}>Recent</span>
            {recents.map((r, i) => (
              <button
                type="button"
                key={r.id}
                className={styles.recent}
                data-recent={r.name}
                onClick={() => onOpenRecent(r)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.thumb} src={thumbs[i]} alt="" data-recent-thumb width={40} height={40} />
                <span className={styles.stack}>
                  <span className={styles.recentName}>{r.name}</span>
                  <span className={styles.meta}>
                    {r.width} × {r.height}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {onContinue && (
          <button type="button" className={styles.action} onClick={onContinue} data-start="continue">
            <RotateCcw size={18} />
            <span className={styles.stack}>
              Continue where you left off
              {continueLabel && <span className={styles.meta}>{continueLabel}</span>}
            </span>
          </button>
        )}
        <button type="button" className={styles.quiet} onClick={onDismiss} data-start="blank">
          <Square size={16} />
          Start with a blank canvas
        </button>
      </div>
    </div>
  );
}
