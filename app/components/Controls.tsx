"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import styles from "./Controls.module.scss";
import ColorPopover from "./ColorPopover";
import { parseColor, swatchBg, toHex6 } from "../lib/color";

/* --------------------------------------------------------------------------
   Small presentational form controls reused across the options bar & panels.
   They keep their own local state so the UI feels alive without wiring up
   any real editing logic yet.
   -------------------------------------------------------------------------- */

export function Slider({
  label,
  min = 0,
  max = 100,
  step = 1,
  defaultValue,
  unit = "",
  compact = false,
  value,
  onChange,
}: {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  unit?: string;
  compact?: boolean;
  value?: number;
  onChange?: (n: number) => void;
}) {
  const [internal, setInternal] = useState(defaultValue ?? value ?? min);
  const v = value !== undefined ? value : internal;
  const pct = ((v - min) / (max - min)) * 100;
  const set = (n: number) => {
    if (value === undefined) setInternal(n);
    onChange?.(n);
  };
  return (
    <div className={`${styles.slider} ${compact ? styles.compact : ""}`}>
      <div className={styles.sliderHead}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>
          {v}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => set(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        aria-label={label}
      />
    </div>
  );
}

export function NumberField({
  label,
  defaultValue,
  unit = "",
  width = 64,
}: {
  label?: string;
  defaultValue: string | number;
  unit?: string;
  width?: number;
}) {
  const [value, setValue] = useState(String(defaultValue));
  return (
    <label className={styles.numField}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.numBox} style={{ width }}>
        <input value={value} onChange={(e) => setValue(e.target.value)} />
        {unit && <span className={styles.unit}>{unit}</span>}
      </span>
    </label>
  );
}

export function Select({
  label,
  options,
  defaultValue,
  width,
  value,
  onChange,
}: {
  label?: string;
  options: string[];
  defaultValue?: string;
  width?: number;
  value?: string;
  onChange?: (s: string) => void;
}) {
  const [internal, setInternal] = useState(defaultValue ?? options[0]);
  const v = value !== undefined ? value : internal;
  const id = useId();
  const set = (s: string) => {
    if (value === undefined) setInternal(s);
    onChange?.(s);
  };
  return (
    <label className={styles.select} htmlFor={id}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.selectBox} style={width ? { width } : undefined}>
        <select id={id} value={v} onChange={(e) => set(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <ChevronDown size={13} />
      </span>
    </label>
  );
}

export function Segmented({
  label,
  options,
  defaultValue,
  value,
  onChange,
}: {
  label?: string;
  options: { value: string; icon?: ReactNode; text?: string; title?: string }[];
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
}) {
  const [internal, setInternal] = useState(defaultValue ?? options[0].value);
  const v = value !== undefined ? value : internal;
  const set = (next: string) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };
  return (
    <div className={styles.segmentedWrap}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.segmented} role="group">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.title}
            data-active={v === o.value}
            onClick={() => set(o.value)}
          >
            {o.icon}
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({
  label,
  defaultChecked = false,
  checked,
  onChange,
}: {
  label: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const [internal, setInternal] = useState(defaultChecked);
  const controlled = checked !== undefined;
  const on = controlled ? checked : internal;
  return (
    <button
      type="button"
      className={styles.toggle}
      role="switch"
      aria-checked={on}
      onClick={() => {
        if (!controlled) setInternal((v) => !v);
        onChange?.(!on);
      }}
    >
      <span className={styles.toggleBox} data-on={on}>
        {on && <Check size={11} strokeWidth={3} />}
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}

export function ColorChip({
  color,
  onChange,
  label,
}: {
  color: string;
  onChange?: (c: string) => void;
  label?: string;
}) {
  // Controlled when an onChange is supplied; otherwise keep its own colour.
  const [internal, setInternal] = useState(color);
  const value = onChange ? color : internal;
  const handle = onChange ?? setInternal;
  return (
    <ColorPopover
      color={value}
      onChange={handle}
      className={styles.colorChip}
      title={label}
      ariaLabel={label ?? "Color"}
    >
      <span className={styles.colorDot} style={swatchBg(value)} />
      <span className={styles.colorHex}>{toHex6(parseColor(value))}</span>
    </ColorPopover>
  );
}

export const Divider = () => <span className={styles.divider} aria-hidden />;
