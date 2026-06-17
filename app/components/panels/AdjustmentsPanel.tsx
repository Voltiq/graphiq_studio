"use client";

import { Slider } from "../Controls";
import styles from "../RightDock.module.scss";

const FILTERS = ["Original", "Vivid", "Mono", "Noir", "Warm", "Cool", "Vintage", "Fade"];

export default function AdjustmentsPanel() {
  return (
    <div className={styles.adjustments}>
      <div className={styles.filterStrip}>
        {FILTERS.map((f, i) => (
          <button key={f} type="button" className={styles.filterChip} data-active={i === 0}>
            <span className={styles.filterThumb} data-filter={f.toLowerCase()} />
            <span>{f}</span>
          </button>
        ))}
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Light</span>
        <Slider label="Exposure" min={-100} max={100} defaultValue={0} />
        <Slider label="Contrast" min={-100} max={100} defaultValue={12} />
        <Slider label="Highlights" min={-100} max={100} defaultValue={-8} />
        <Slider label="Shadows" min={-100} max={100} defaultValue={15} />
        <Slider label="Whites" min={-100} max={100} defaultValue={0} />
        <Slider label="Blacks" min={-100} max={100} defaultValue={-5} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Color</span>
        <Slider label="Temperature" min={-100} max={100} defaultValue={6} />
        <Slider label="Tint" min={-100} max={100} defaultValue={0} />
        <Slider label="Vibrance" min={-100} max={100} defaultValue={20} />
        <Slider label="Saturation" min={-100} max={100} defaultValue={0} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Detail</span>
        <Slider label="Sharpen" defaultValue={25} />
        <Slider label="Clarity" min={-100} max={100} defaultValue={10} />
        <Slider label="Noise Reduction" defaultValue={0} />
      </div>
    </div>
  );
}
