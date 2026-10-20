"use client";

import type { ReactNode } from "react";
import { ArrowLeftRight } from "lucide-react";
import styles from "../RightDock.module.scss";
import ColorPicker, { SwatchLibrary } from "../ColorPicker";
import { parseColor, swatchBg, toHex8 } from "../../lib/color";

export type ColorView = "picker" | "swatches";

/**
 * The Color panel, as the design draws it: the picker, or the swatch library,
 * chosen by the Picker / Swatches control in the panel's header.
 *
 * Which colour is being edited — primary or secondary — is the pair of chips
 * at the start of the value row, the way every paint program draws it: the
 * one you are editing in front, the other peeking out behind it (click it to
 * edit that one instead), and a swap between them.
 */
export default function ColorPanel({
  foreground,
  background,
  onForeground,
  onBackground,
  active,
  onActive,
  view = "picker",
  viewSwitch,
}: {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  /** Which swatch is active — this is the colour tools paint with. */
  active: "primary" | "secondary";
  onActive: (slot: "primary" | "secondary") => void;
  view?: ColorView;
  /** On a touchscreen: the Picker / Swatches control, at the top of the panel. */
  viewSwitch?: ReactNode;
}) {
  const color = active === "primary" ? foreground : background;
  const setColor = active === "primary" ? onForeground : onBackground;
  const other = active === "primary" ? background : foreground;
  const otherSlot = active === "primary" ? "secondary" : "primary";
  const name = (slot: "primary" | "secondary") => (slot === "primary" ? "Primary" : "Secondary");

  const swap = () => {
    const f = foreground;
    onForeground(background);
    onBackground(f);
  };

  const pair = (
    <div className={styles.slotPair} role="group" aria-label="Primary and secondary colours">
      <button
        type="button"
        className={styles.slotBack}
        data-slot={otherSlot}
        style={swatchBg(other)}
        title={`${name(otherSlot)} colour — click to edit it`}
        aria-label={`Edit the ${otherSlot} colour`}
        onClick={() => onActive(otherSlot)}
      />
      <span
        className={styles.slotFront}
        data-slot={active}
        style={swatchBg(color)}
        title={`${name(active)} colour — the one you are editing`}
        role="img"
        aria-label={`${name(active)} colour, being edited`}
      />
      <button
        type="button"
        className={styles.slotSwap}
        title="Swap primary & secondary"
        aria-label="Swap primary and secondary colors"
        onClick={swap}
      >
        <ArrowLeftRight size={10} />
      </button>
    </div>
  );

  return (
    <div className={styles.colorPanel} data-view={view}>
      {viewSwitch}
      {/* Key on the active target so switching Primary↔Secondary re-initialises
          the picker from that swatch (immune to stale internal edit state). */}
      {view === "picker" ? (
        <ColorPicker key={active} value={color} onChange={setColor} lead={pair} swatches="row" />
      ) : (
        <>
          <div className={styles.swatchCurrent}>
            {pair}
            <span className={styles.swatchCurrentText}>
              <span className={styles.swatchCurrentName}>{name(active)}</span>
              <span className={styles.swatchCurrentHex}>{toHex8(parseColor(color)).slice(0, 7).toUpperCase()}</span>
            </span>
          </div>
          <SwatchLibrary value={toHex8(parseColor(color))} onChange={setColor} />
        </>
      )}
    </div>
  );
}
