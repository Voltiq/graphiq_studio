"use client";

import { useEffect, useState } from "react";
import styles from "./OptionsBar.module.scss";
import {
  cycleModifier,
  getModifiers,
  subscribeModifiers,
  type ModifierName,
  type ModifierState,
} from "../lib/modifiers";

/**
 * Shift / Alt / Ctrl as tappable chips, for a touchscreen that has no keys.
 *
 * One mechanism instead of thirty bespoke gestures: the chip latches the
 * modifier and lib/modifiers injects it into the next gesture, so every
 * behaviour keeps the `e.altKey` test it already had.
 *
 * Three states, because both are genuinely wanted: a tap ARMS it for the next
 * gesture (it clears itself afterwards, like sticky keys), a second tap LOCKS
 * it for a run of gestures, a third turns it off. The state is on the chip, in
 * words, rather than left to be inferred from a highlight.
 */
const LABELS: { name: ModifierName; text: string; hint: string }[] = [
  { name: "shift", text: "Shift", hint: "add to a selection, constrain proportions" },
  { name: "alt", text: "Alt", hint: "subtract from a selection, resize from centre, sample" },
  { name: "ctrl", text: "Ctrl", hint: "add to a selection, snap overrides" },
];

export default function ModifierChips() {
  const [state, setState] = useState<ModifierState>(getModifiers);
  useEffect(() => subscribeModifiers(setState), []);
  return (
    <div className={styles.modifierChips} role="group" aria-label="Keyboard modifiers">
      {LABELS.map(({ name, text, hint }) => {
        const mode = state[name];
        return (
          <button
            key={name}
            type="button"
            className={styles.modifierChip}
            data-mode={mode}
            aria-pressed={mode !== "off"}
            title={`${text} — ${hint}. Tap to arm for the next gesture, again to lock.`}
            onClick={() => cycleModifier(name)}
          >
            {text}
            {mode === "locked" && <span aria-hidden>*</span>}
            <span className={styles.srOnly}>
              {mode === "off" ? "off" : mode === "armed" ? "armed for the next gesture" : "locked on"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
