"use client";

import { Check, MousePointer2, Wifi } from "lucide-react";
import styles from "./StatusBar.module.scss";
import { getTool, type ToolId } from "../lib/tools";
import { parseColor, swatchBg, toHex6 } from "../lib/color";

export default function StatusBar({
  tool,
  zoom,
  onZoomChange,
  foreground,
  width,
  height,
}: {
  tool: ToolId;
  zoom: number;
  onZoomChange: (z: number) => void;
  foreground: string;
  width: number;
  height: number;
}) {
  const meta = getTool(tool);

  return (
    <footer className={styles.statusbar}>
      <div className={styles.left}>
        <span className={styles.swatchPip} style={swatchBg(foreground)} />
        <span className={styles.mono}>{toHex6(parseColor(foreground))}</span>
        <span className={styles.muted}>{Math.round(parseColor(foreground).a * 100)}%</span>
        <span className={styles.sep} />
        <span>
          {width} × {height} px
        </span>
        <span className={styles.sep} />
        <span>RGB / 8-bit</span>
        <span className={styles.sep} />
        <span className={styles.muted}>240 DPI</span>
      </div>

      <div className={styles.center}>
        <MousePointer2 size={12} />
        <span className={styles.mono}>X 842</span>
        <span className={styles.mono}>Y 519</span>
        <span className={styles.sep} />
        <span className={styles.hint}>
          {meta.name}: drag on the canvas to apply.
        </span>
      </div>

      <div className={styles.right}>
        <span className={styles.saved}>
          <Check size={12} /> Saved
        </span>
        <span className={styles.sep} />
        <span className={styles.muted}>Doc 8.2M / 24.6M</span>
        <span className={styles.sep} />
        <div className={styles.zoom}>
          <input
            type="range"
            min={12}
            max={3200}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            aria-label="Zoom"
          />
          <span className={styles.mono}>{zoom}%</span>
        </div>
        <span className={styles.sep} />
        <Wifi size={13} className={styles.muted} />
      </div>
    </footer>
  );
}
