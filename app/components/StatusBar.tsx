"use client";

import { useEffect, useState } from "react";
import { BoxSelect, Check, MousePointer2, Wifi } from "lucide-react";
import styles from "./StatusBar.module.scss";
import { getTool, type ToolId } from "../lib/tools";
import { parseColor, swatchBg, toHex6 } from "../lib/color";
import type { Rect } from "../lib/view";

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
  selection,
  subscribeCursor,
}: {
  tool: ToolId;
  zoom: number;
  onZoomChange: (z: number) => void;
  foreground: string;
  width: number;
  height: number;
  selection: Rect[];
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
    <footer className={styles.statusbar}>
      <div className={styles.left}>
        <span className={styles.swatchPip} style={swatchBg(foreground)} />
        <span className={styles.mono}>{toHex6(parseColor(foreground)).toUpperCase()}</span>
        <span className={styles.muted}>{Math.round(parseColor(foreground).a * 100)}%</span>
        <span className={styles.sep}>|</span>
        <span>
          {width} × {height} px
        </span>
        <span className={styles.sep}>|</span>
        <span>RGB / 8-bit</span>
        <span className={styles.sep}>|</span>
        <span className={styles.muted}>240 DPI</span>
      </div>

      <div className={styles.center}>
        <MousePointer2 size={12} />
        <span className={styles.mono}>X {cursor ? cursor.x : "—"}</span>
        <span className={styles.mono}>Y {cursor ? cursor.y : "—"}</span>
        <span className={styles.sep}>|</span>
        {sel ? (
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
        <span className={styles.saved}>
          <Check size={12} /> Saved
        </span>
        <span className={styles.sep}>|</span>
        <span className={styles.muted}>Doc 8.2M / 24.6M</span>
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
          <span className={styles.mono}>{zoom}%</span>
        </div>
        <span className={styles.sep}>|</span>
        <Wifi size={13} className={styles.muted} />
      </div>
    </footer>
  );
}
