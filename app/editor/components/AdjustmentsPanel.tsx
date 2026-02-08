"use client";

import { useEditor } from "../state";
import styles from "./editor.module.scss";

type AdjustmentKey =
  | "exposure"
  | "brightness"
  | "contrast"
  | "saturation"
  | "temperature"
  | "tint"
  | "highlights"
  | "shadows";

const controls: Array<{
  key: AdjustmentKey;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "exposure", label: "Exposure", min: -1, max: 1, step: 0.01 },
  { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01 },
  { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01 },
  { key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01 },
  { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01 },
  { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
  { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.01 },
  { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01 },
];

const neutralPayload: Record<AdjustmentKey, number> = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
};

const AdjustmentsPanel = () => {
  const { state, dispatch } = useEditor();

  const updateAdjustment = (key: AdjustmentKey, value: number) => {
    dispatch({ type: "APPLY_ADJUSTMENT", payload: { [key]: value } });
  };

  const resetAdjustments = () => {
    dispatch({ type: "APPLY_ADJUSTMENT", payload: neutralPayload });
  };

  return (
    <section className={styles.panel}>
      <header>
        <div>
          <h2>Color Management</h2>
          <p>Precise tonal control</p>
        </div>
        <button onClick={resetAdjustments}>Reset</button>
      </header>
      <div className={styles.sliderStack}>
        {controls.map((control) => (
          <label key={control.key} className={styles.sliderRow}>
            <div>
              <span>{control.label}</span>
              <span>{state.adjustments[control.key].toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={state.adjustments[control.key]}
              onChange={(event) =>
                updateAdjustment(control.key, Number(event.target.value))
              }
            />
          </label>
        ))}
      </div>
    </section>
  );
};

export default AdjustmentsPanel;
