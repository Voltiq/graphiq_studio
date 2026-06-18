"use client";

import { Slider } from "../Controls";
import styles from "../RightDock.module.scss";
import { FILTERS, isDefaultAdjust, type Adjustments } from "../../lib/adjust";

export default function AdjustmentsPanel({
  adjust,
  onChange,
  filter,
  onFilter,
  onApply,
  onReset,
  active,
}: {
  adjust: Adjustments;
  onChange: (patch: Partial<Adjustments>) => void;
  filter: string;
  onFilter: (name: string) => void;
  onApply: () => void;
  onReset: () => void;
  active: boolean;
}) {
  const dirty = !isDefaultAdjust(adjust);

  const btn = (primary: boolean): React.CSSProperties => ({
    flex: 1,
    height: 30,
    fontSize: 12.5,
    fontWeight: 550,
    borderRadius: "var(--r-sm)",
    color: primary ? "var(--accent-contrast)" : "var(--text)",
    background: primary ? "var(--accent)" : "var(--surface-3)",
    border: primary ? "1px solid transparent" : "1px solid var(--border)",
    opacity: 1,
    cursor: "pointer",
  });

  return (
    <div className={styles.adjustments}>
      <div className={styles.filterStrip}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={styles.filterChip}
            data-active={filter === f}
            onClick={() => onFilter(f)}
          >
            <span className={styles.filterThumb} data-filter={f.toLowerCase()} />
            <span>{f}</span>
          </button>
        ))}
      </div>

      {!active && (
        <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0" }}>
          Select a pixel layer to adjust.
        </p>
      )}

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Light</span>
        <Slider label="Exposure" min={-100} max={100} value={adjust.exposure} onChange={(v) => onChange({ exposure: v })} />
        <Slider label="Contrast" min={-100} max={100} value={adjust.contrast} onChange={(v) => onChange({ contrast: v })} />
        <Slider label="Highlights" min={-100} max={100} value={adjust.highlights} onChange={(v) => onChange({ highlights: v })} />
        <Slider label="Shadows" min={-100} max={100} value={adjust.shadows} onChange={(v) => onChange({ shadows: v })} />
        <Slider label="Whites" min={-100} max={100} value={adjust.whites} onChange={(v) => onChange({ whites: v })} />
        <Slider label="Blacks" min={-100} max={100} value={adjust.blacks} onChange={(v) => onChange({ blacks: v })} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Color</span>
        <Slider label="Temperature" min={-100} max={100} value={adjust.temperature} onChange={(v) => onChange({ temperature: v })} />
        <Slider label="Tint" min={-100} max={100} value={adjust.tint} onChange={(v) => onChange({ tint: v })} />
        <Slider label="Vibrance" min={-100} max={100} value={adjust.vibrance} onChange={(v) => onChange({ vibrance: v })} />
        <Slider label="Saturation" min={-100} max={100} value={adjust.saturation} onChange={(v) => onChange({ saturation: v })} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Detail</span>
        <Slider label="Sharpen" min={0} max={100} value={adjust.sharpen} onChange={(v) => onChange({ sharpen: v })} />
        <Slider label="Clarity" min={-100} max={100} value={adjust.clarity} onChange={(v) => onChange({ clarity: v })} />
        <Slider label="Noise Reduction" min={0} max={100} value={adjust.noise} onChange={(v) => onChange({ noise: v })} />
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        <button type="button" style={btn(false)} disabled={!dirty} onClick={onReset}>
          Reset
        </button>
        <button type="button" style={btn(true)} disabled={!dirty || !active} onClick={onApply}>
          Apply
        </button>
      </div>
    </div>
  );
}
