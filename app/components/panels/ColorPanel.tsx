"use client";

import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import styles from "../RightDock.module.scss";
import ColorPicker from "../ColorPicker";
import { swatchBg } from "../../lib/color";

export default function ColorPanel({
  foreground,
  background,
  onForeground,
  onBackground,
}: {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
}) {
  const [active, setActive] = useState<"fg" | "bg">("fg");
  const color = active === "fg" ? foreground : background;
  const setColor = active === "fg" ? onForeground : onBackground;

  return (
    <div className={styles.colorPanel}>
      <div className={styles.targets}>
        <button
          type="button"
          className={styles.target}
          data-active={active === "fg"}
          onClick={() => setActive("fg")}
        >
          <span className={styles.targetSwatch} style={swatchBg(foreground)} />
          <span className={styles.targetLabel}>Primary</span>
        </button>
        <button
          type="button"
          className={styles.target}
          data-active={active === "bg"}
          onClick={() => setActive("bg")}
        >
          <span className={styles.targetSwatch} style={swatchBg(background)} />
          <span className={styles.targetLabel}>Secondary</span>
        </button>
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

      <ColorPicker value={color} onChange={setColor} />
    </div>
  );
}
