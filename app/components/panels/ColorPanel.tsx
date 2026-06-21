"use client";

import { ArrowLeftRight } from "lucide-react";
import styles from "../RightDock.module.scss";
import ColorPicker from "../ColorPicker";
import { swatchBg } from "../../lib/color";

export default function ColorPanel({
  foreground,
  background,
  onForeground,
  onBackground,
  active,
  onActive,
}: {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  /** Which swatch is active — this is the colour tools paint with. */
  active: "primary" | "secondary";
  onActive: (slot: "primary" | "secondary") => void;
}) {
  const color = active === "primary" ? foreground : background;
  const setColor = active === "primary" ? onForeground : onBackground;

  return (
    <div className={styles.colorPanel}>
      <div className={styles.targets}>
        <div className={styles.segment}>
          <button
            type="button"
            className={styles.target}
            data-active={active === "primary"}
            onClick={() => onActive("primary")}
          >
            <span className={styles.targetSwatch} style={swatchBg(foreground)} />
            <span className={styles.targetLabel}>Primary</span>
          </button>
          <button
            type="button"
            className={styles.target}
            data-active={active === "secondary"}
            onClick={() => onActive("secondary")}
          >
            <span className={styles.targetSwatch} style={swatchBg(background)} />
            <span className={styles.targetLabel}>Secondary</span>
          </button>
        </div>
        <button
          type="button"
          className={styles.swap}
          title="Swap primary & secondary"
          aria-label="Swap primary and secondary colors"
          onClick={() => {
            const f = foreground;
            onForeground(background);
            onBackground(f);
          }}
        >
          <ArrowLeftRight size={14} />
        </button>
      </div>

      {/* Key on the active target so switching Primary↔Secondary re-initialises
          the picker from that swatch (immune to stale internal edit state). */}
      <ColorPicker key={active} value={color} onChange={setColor} />
    </div>
  );
}
