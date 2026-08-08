"use client";

import { useEffect, useState } from "react";
import { BoxSelect, Check, CircleDashed, MousePointer2, Ruler } from "lucide-react";
import styles from "./StatusBar.module.scss";
import { EditableValue } from "./Controls";
import { WORKING_SPACE_LABELS, type WorkingSpace } from "../lib/colorspace";
import type { MeasureUnit } from "../lib/prefs";
import { getTool, measureInfo, type MeasureLine, type ToolId } from "../lib/tools";
import { parseColor, swatchBg, toHex6 } from "../lib/color";
import type { Rect } from "../lib/view";

/** Photoshop-style document sizes: flattened / all layers, from real dims. */
/** Pixels → the display unit, trimmed to 2 decimals. */
function fmtUnit(px: number, unit: MeasureUnit, dpi: number): string {
  const v = unit === "in" ? px / dpi : (px / dpi) * 2.54;
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

type CursorPt = { x: number; y: number } | null;

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
    x0: Math.round(x0),
    y0: Math.round(y0),
    x1: Math.round(x1),
    y1: Math.round(y1),
    w: Math.round(x1 - x0),
    h: Math.round(y1 - y0),
    count,
  };
}

export default function StatusBar({
  tool,
  zoom,
  onZoomChange,
  foreground,
  width,
  height,
  colorSpace,
  unit = "px",
  dpi = 300,
  layerCount,
  saveState,
  selection,
  measure = null,
  subscribeCursor,
}: {
  tool: ToolId;
  zoom: number;
  onZoomChange: (z: number) => void;
  foreground: string;
  width: number;
  height: number;
  colorSpace: WorkingSpace;
  unit?: MeasureUnit;
  dpi?: number;
  layerCount: number;
  saveState: { label: string; ok: boolean };
  selection: Rect[];
  measure?: MeasureLine | null;
  subscribeCursor: (fn: (p: CursorPt) => void) => () => void;
}) {
  const meta = getTool(tool);
  const [cursor, setCursor] = useState<CursorPt>(null);

  // Subscribe to cursor updates; bail out when the integer position is unchanged
  // so the status bar only re-renders when there's something new to show.
  useEffect(
    () =>
      subscribeCursor((p) =>
        setCursor((prev) => {
          if (p === null) return prev === null ? prev : null;
          if (prev && prev.x === p.x && prev.y === p.y) return prev;
          return p;
        }),
      ),
    [subscribeCursor],
  );

  const sel = selection.length ? selectionInfo(selection) : null;

  return (
    <footer className={styles.statusbar} data-tour="status">
      <div className={styles.left}>
        <span className={styles.swatchPip} style={swatchBg(foreground)} />
        <span className={styles.mono}>{toHex6(parseColor(foreground)).toUpperCase()}</span>
        <span className={styles.muted}>{Math.round(parseColor(foreground).a * 100)}%</span>
        <span className={styles.sep}>|</span>
        <span>
          {unit === "px"
            ? `${width} × ${height} px`
            : `${fmtUnit(width, unit, dpi)} × ${fmtUnit(height, unit, dpi)} ${unit} @ ${dpi} ppi`}
        </span>
        <span className={styles.sep}>|</span>
        <span>{WORKING_SPACE_LABELS[colorSpace]} / 8-bit</span>
      </div>

      <div className={styles.center}>
        <MousePointer2 size={12} />
        <span className={styles.mono}>X {cursor ? cursor.x : "—"}</span>
        <span className={styles.mono}>Y {cursor ? cursor.y : "—"}</span>
        <span className={styles.sep}>|</span>
        {tool === "measure" && measure ? (
          (() => {
            const m = measureInfo(measure);
            const len =
              unit === "px"
                ? `${Math.round(m.length)} px`
                : `${fmtUnit(m.length, unit, dpi)} ${unit}`;
            return (
              <span className={styles.selInfo}>
                <Ruler size={12} />
                <span className={styles.mono}>L {len}</span>
                <span className={styles.mono}>A {m.angle.toFixed(1)}°</span>
                <span className={styles.muted}>
                  dX {Math.round(m.dx)} · dY {Math.round(m.dy)}
                </span>
              </span>
            );
          })()
        ) : sel ? (
          <span className={styles.selInfo}>
            <BoxSelect size={12} />
            <span className={styles.mono}>
              {sel.w} × {sel.h}
            </span>
            <span className={styles.muted}>{sel.count.toLocaleString()} px</span>
            <span className={styles.muted}>
              ({sel.x0}, {sel.y0}) → ({sel.x1}, {sel.y1})
            </span>
          </span>
        ) : (
          <span className={styles.hint}>{meta.name}: drag on the canvas to apply.</span>
        )}
      </div>

      <div className={styles.right}>
        <span className={saveState.ok ? styles.saved : styles.muted} title="Save state (autosave in Preferences)">
          {saveState.ok ? <Check size={12} /> : <CircleDashed size={11} />} {saveState.label}
        </span>
        <span className={styles.sep}>|</span>
        <span
          className={styles.muted}
          title="Document size: flattened / all layers (uncompressed, in memory)"
        >
          Doc {fmtBytes(width * height * 4)} / {fmtBytes(Math.max(1, layerCount) * width * height * 4)}
        </span>
        <span className={styles.sep}>|</span>
        <div className={styles.zoom}>
          <input
            type="range"
            min={12}
            max={10000}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            aria-label="Zoom"
          />
          <EditableValue
            className={styles.mono}
            value={zoom}
            min={12}
            max={10000}
            display={`${zoom}%`}
            onCommit={onZoomChange}
            ariaLabel="Zoom percentage"
          />
        </div>
      </div>
    </footer>
  );
}
