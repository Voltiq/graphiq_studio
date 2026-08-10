"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "../RightDock.module.scss";
import { parseColor, rgbToHsv, swatchBg, toHex6 } from "../../lib/color";
import type { MeasureUnit } from "../../lib/prefs";
import type { EngineHandle } from "../../lib/paint";
import type { Rect } from "../../lib/view";

type CursorPt = { x: number; y: number } | null;

/** Pixels → the display unit, trimmed (mirrors the status bar's formatter). */
function fmtUnit(px: number, unit: MeasureUnit, dpi: number): string {
  if (unit === "px") return String(Math.round(px));
  const v = unit === "in" ? px / dpi : (px / dpi) * 2.54;
  return v.toFixed(2).replace(/\.?0+$/, "");
}

/** Axis-aligned bounds + selected-pixel count for a set of selection rects. */
function selectionInfo(rects: Rect[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let count = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
    count += Math.round(r.w) * Math.round(r.h);
  }
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(x1 - x0),
    h: Math.round(y1 - y0),
    count,
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{children}</span>
    </div>
  );
}

/**
 * Info panel (TODO §11): a live readout of what's under the pointer — the
 * composited colour as RGBA / HSB / hex with a swatch, the document coordinates
 * in the current unit — plus the active selection's origin, size and pixel
 * count, and the document's own size.
 *
 * The colour is sampled from the engine's COMPOSITE (what you actually see) and
 * only while the pointer is over the canvas; readings are throttled to one per
 * animation frame so a fast drag can't spam `getImageData`.
 */
export default function InfoPanel({
  subscribeCursor,
  engineRef,
  selection,
  width,
  height,
  unit = "px",
  dpi = 300,
}: {
  subscribeCursor: (fn: (p: CursorPt) => void) => () => void;
  engineRef: RefObject<EngineHandle | null>;
  selection: Rect[];
  width: number;
  height: number;
  unit?: MeasureUnit;
  dpi?: number;
}) {
  const [cursor, setCursor] = useState<CursorPt>(null);
  const [hex, setHex] = useState<string | null>(null);
  // Sampling is rAF-throttled: a pointer move fires far more often than the
  // panel can usefully repaint, and each sample is a getImageData.
  const pendingRef = useRef<CursorPt>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const flush = () => {
      rafRef.current = 0;
      const p = pendingRef.current;
      setCursor(p);
      setHex(p ? (engineRef.current?.sampleColor(p.x, p.y, 1, true, null) ?? null) : null);
    };
    const unsub = subscribeCursor((p) => {
      pendingRef.current = p;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [subscribeCursor, engineRef]);

  const rgba = hex ? parseColor(hex) : null;
  const hsv = rgba ? rgbToHsv(rgba.r, rgba.g, rgba.b) : null;
  const sel = selection.length ? selectionInfo(selection) : null;
  const u = unit === "px" ? "px" : unit;
  const dash = "—";

  return (
    <div className={styles.info}>
      <Row label="X">
        <span className={styles.mono}>{cursor ? fmtUnit(cursor.x, unit, dpi) : dash}</span>
      </Row>
      <Row label="Y">
        <span className={styles.mono}>{cursor ? fmtUnit(cursor.y, unit, dpi) : dash}</span>
      </Row>

      <div className={styles.infoSep} />

      <Row label="Color">
        {rgba ? (
          <span className={styles.infoColor}>
            <span className={styles.infoSwatch} style={swatchBg(hex!)} />
            <span className={styles.mono}>{toHex6(rgba).toUpperCase()}</span>
          </span>
        ) : (
          <span className={styles.mono}>{dash}</span>
        )}
      </Row>
      <Row label="RGB">
        <span className={styles.mono}>
          {rgba ? `${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)}` : dash}
        </span>
      </Row>
      <Row label="Alpha">
        <span className={styles.mono}>{rgba ? `${Math.round(rgba.a * 100)}%` : dash}</span>
      </Row>
      <Row label="HSB">
        <span className={styles.mono}>
          {/* rgbToHsv already returns s/v as 0–100 — do NOT scale again. */}
          {hsv ? `${Math.round(hsv.h)}°, ${Math.round(hsv.s)}%, ${Math.round(hsv.v)}%` : dash}
        </span>
      </Row>

      <div className={styles.infoSep} />

      <Row label="Selection">
        <span className={styles.mono}>
          {sel ? `${fmtUnit(sel.w, unit, dpi)} × ${fmtUnit(sel.h, unit, dpi)} ${u}` : dash}
        </span>
      </Row>
      {sel && (
        <>
          <Row label="Origin">
            <span className={styles.mono}>
              {fmtUnit(sel.x, unit, dpi)}, {fmtUnit(sel.y, unit, dpi)}
            </span>
          </Row>
          <Row label="Pixels">
            <span className={styles.mono}>{sel.count.toLocaleString()}</span>
          </Row>
        </>
      )}
      <Row label="Document">
        <span className={styles.mono}>
          {fmtUnit(width, unit, dpi)} × {fmtUnit(height, unit, dpi)} {u}
        </span>
      </Row>
      {!cursor && (
        <span className={styles.infoHint}>Move the pointer over the canvas to sample.</span>
      )}
    </div>
  );
}
