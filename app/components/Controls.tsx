"use client";

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import styles from "./Controls.module.scss";
import ColorPopover from "./ColorPopover";
import { parseColor, swatchBg, toHex6 } from "../lib/color";

export { Select } from "./Select";

/* --------------------------------------------------------------------------
   Small presentational form controls reused across the options bar & panels.
   They keep their own local state so the UI feels alive without wiring up
   any real editing logic yet.
   -------------------------------------------------------------------------- */

/**
 * A numeric readout that turns into a text input when clicked, so any value can
 * be typed exactly. Snaps the typed value to [min, max] on the step grid (same
 * granularity as the slider it accompanies). `display` overrides the shown text
 * (e.g. a "+" prefix, or a "%"/"px" suffix); `className` carries the caller's
 * text styling so it looks identical to the static readout it replaces.
 */
export function EditableValue({
  value,
  min,
  max,
  step = 1,
  unit = "",
  display,
  onCommit,
  className = "",
  title = "Click to type a value",
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  display?: string;
  onCommit: (n: number) => void;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const begin = () => {
    setDraft(String(value));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    let n = parseFloat(draft);
    if (Number.isNaN(n)) return; // invalid → keep the current value
    n = Math.max(min, Math.min(max, n));
    // Snap to the slider's step grid (relative to min) so typed and dragged
    // values share the same granularity; trim float dust from the multiply.
    if (step > 0) n = Number((min + Math.round((n - min) / step) * step).toFixed(6));
    onCommit(n);
  };

  if (editing) {
    return (
      <input
        className={`${styles.valueInput} ${className}`}
        autoFocus
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          // Keep the keys local: don't trip tool shortcuts or dialog Escape.
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setEditing(false);
        }}
        aria-label={ariaLabel ?? "Value"}
      />
    );
  }
  return (
    <span
      className={`${styles.valueClickable} ${className}`}
      role="button"
      tabIndex={0}
      title={title}
      onClick={begin}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          begin();
        }
      }}
    >
      {display ?? `${value}${unit}`}
    </span>
  );
}

export function Slider({
  label,
  min = 0,
  max = 100,
  step = 1,
  defaultValue,
  unit = "",
  compact = false,
  inline = false,
  bipolar = false,
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
  inline?: boolean;
  bipolar?: boolean;
  value?: number;
  onChange?: (n: number) => void;
}) {
  const [internal, setInternal] = useState(defaultValue ?? value ?? min);
  const v = value !== undefined ? value : internal;
  const pct = ((v - min) / (max - min)) * 100;
  // Bipolar tracks fill outward from the centre (50%) toward the value.
  const lo = bipolar ? Math.min(50, pct) : 0;
  const hi = bipolar ? Math.max(50, pct) : pct;
  const set = (n: number) => {
    if (value === undefined) setInternal(n);
    onChange?.(n);
  };
  return (
    <div
      className={`${styles.slider} ${compact ? styles.compact : ""} ${
        inline ? styles.inline : ""
      } ${bipolar ? styles.bipolar : ""}`}
    >
      <div className={styles.sliderHead}>
        <span className={styles.label}>{label}</span>
        <EditableValue
          className={styles.value}
          value={v}
          min={min}
          max={max}
          step={step}
          unit={unit}
          display={`${bipolar && v > 0 ? "+" : ""}${v}${unit}`}
          onCommit={set}
          ariaLabel={`${label} value`}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => set(Number(e.target.value))}
        style={
          {
            "--pct": `${pct}%`,
            "--lo": `${lo}%`,
            "--hi": `${hi}%`,
          } as React.CSSProperties
        }
        aria-label={label}
      />
    </div>
  );
}

export function NumberField({
  label,
  defaultValue = "",
  value,
  onChange,
  unit = "",
  width = 64,
  min,
  max,
}: {
  label?: string;
  defaultValue?: string | number;
  /** Controlled numeric value; when set, edits commit through onChange. */
  value?: number;
  onChange?: (n: number) => void;
  unit?: string;
  width?: number;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(String(value ?? defaultValue));
  const [editing, setEditing] = useState(false);
  // Reflect external changes while the user isn't actively typing. Adjusted
  // DURING render rather than in an effect: an effect would paint the stale
  // number for a frame before correcting it.
  const [seenValue, setSeenValue] = useState(value);
  if (!editing && seenValue !== value) {
    setSeenValue(value);
    if (value !== undefined) setDraft(String(value));
  }

  const commit = () => {
    setEditing(false);
    if (!onChange) return;
    let n = parseFloat(draft);
    if (Number.isNaN(n)) {
      if (value !== undefined) setDraft(String(value));
      return;
    }
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    n = Math.round(n);
    onChange(n);
    setDraft(String(n));
  };

  return (
    <label className={styles.numField}>
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.numBox} style={{ width }}>
        <input
          /* A number, so ask for the number pad. Without it this input has no
             `type` and no `inputMode`, so a phone offers QWERTY for a field
             that only ever takes digits — New guide's position and every
             NumberField in the options bar. `decimal` rather than `numeric`
             because these take fractions, and it is what the sibling
             click-to-type value input already asks for.

             `data-numeric` says so out loud. The `numBox` wrapper cannot: New
             document puts its NAME field in one for the layout, so a check that
             read the wrapper called a text field numeric and asked why it
             offered QWERTY — which it should. */
          inputMode="decimal"
          data-numeric
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape" && value !== undefined) {
              setDraft(String(value));
              e.currentTarget.blur();
            }
          }}
        />
        {unit && <span className={styles.unit}>{unit}</span>}
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
