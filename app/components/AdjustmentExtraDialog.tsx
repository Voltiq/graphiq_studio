"use client";

import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Slider, Toggle } from "./Controls";
import { GradientEditor } from "./GradientControl";
import {
  EXTRA_LABELS,
  HUESAT_RANGE_NAMES,
  SELECTIVE_RANGES,
  type ChannelMixerAdjustment,
  type ChannelMixerChannel,
  type ExtraAdjustment,
  type GradientMapAdjustment,
  type HueSatAdjustment,
  type SelectiveColorAdjustment,
  type SelectiveRangeName,
} from "../lib/adjust-extra";
import { useState } from "react";

/**
 * Editor for the parameterized "extra" adjustment layers: Hue/Saturation
 * (per-range targeting), Selective Color, Channel Mixer and Gradient Map.
 * Edits apply live to the node's spec (`onChange` — the Editor debounces one
 * undoable step per gesture, same as Curves/Levels); Done just closes.
 * Invert / Equalize / Color Lookup carry no editable params and never open it.
 */
export default function AdjustmentExtraDialog({
  spec,
  onChange,
  onClose,
}: {
  spec: ExtraAdjustment;
  onChange: (spec: ExtraAdjustment) => void;
  onClose: () => void;
}) {
  const [hueRange, setHueRange] = useState(0);
  const [selRange, setSelRange] = useState<SelectiveRangeName>("reds");
  const [mixChannel, setMixChannel] = useState<"r" | "g" | "b">("r");

  const body = () => {
    if (spec.type === "huesat") {
      const s = spec as HueSatAdjustment;
      const cur = s.ranges[hueRange] ?? { hue: 0, sat: 0, light: 0 };
      const patch = (p: Partial<typeof cur>) =>
        onChange({
          ...s,
          ranges: s.ranges.map((r, i) => (i === hueRange ? { ...r, ...p } : r)),
        });
      return (
        <>
          <span className={styles.groupLabel}>Range</span>
          <Segmented
            options={HUESAT_RANGE_NAMES.map((name, i) => ({
              value: String(i),
              text: i === 0 ? "Master" : name[0],
              title: name,
            }))}
            value={String(hueRange)}
            onChange={(v) => setHueRange(Number(v))}
          />
          <p className={styles.note}>
            {HUESAT_RANGE_NAMES[hueRange]}
            {hueRange > 0 ? " — feathered hue-wheel range; greys are never targeted." : " — applies to every pixel."}
          </p>
          <Slider label="Hue" min={-180} max={180} bipolar value={cur.hue} onChange={(n) => patch({ hue: n })} />
          <Slider label="Saturation" min={-100} max={100} bipolar value={cur.sat} onChange={(n) => patch({ sat: n })} />
          <Slider label="Lightness" min={-100} max={100} bipolar value={cur.light} onChange={(n) => patch({ light: n })} />
        </>
      );
    }
    if (spec.type === "selective") {
      const s = spec as SelectiveColorAdjustment;
      const cur = s.ranges[selRange] ?? { c: 0, m: 0, y: 0, k: 0 };
      const patch = (p: Partial<typeof cur>) =>
        onChange({ ...s, ranges: { ...s.ranges, [selRange]: { ...cur, ...p } } });
      return (
        <>
          <span className={styles.groupLabel}>Colors</span>
          <Segmented
            options={SELECTIVE_RANGES.map((name) => ({
              value: name,
              text: name === "blacks" ? "K" : name[0].toUpperCase(),
              title: name[0].toUpperCase() + name.slice(1),
            }))}
            value={selRange}
            onChange={(v) => setSelRange(v as SelectiveRangeName)}
          />
          <p className={styles.note}>{selRange[0].toUpperCase() + selRange.slice(1)}</p>
          <Slider label="Cyan" min={-100} max={100} bipolar value={cur.c} onChange={(n) => patch({ c: n })} />
          <Slider label="Magenta" min={-100} max={100} bipolar value={cur.m} onChange={(n) => patch({ m: n })} />
          <Slider label="Yellow" min={-100} max={100} bipolar value={cur.y} onChange={(n) => patch({ y: n })} />
          <Slider label="Black" min={-100} max={100} bipolar value={cur.k} onChange={(n) => patch({ k: n })} />
          <Segmented
            label="Method"
            options={[
              { value: "relative", text: "Relative", title: "Proportional to the current amount" },
              { value: "absolute", text: "Absolute", title: "Fixed amounts" },
            ]}
            value={s.relative ? "relative" : "absolute"}
            onChange={(v) => onChange({ ...s, relative: v === "relative" })}
          />
        </>
      );
    }
    if (spec.type === "chanmix") {
      const s = spec as ChannelMixerAdjustment;
      const cur: ChannelMixerChannel = s.mono ? s.r : s[mixChannel];
      const patch = (p: Partial<ChannelMixerChannel>) =>
        onChange(
          s.mono
            ? { ...s, r: { ...s.r, ...p } }
            : { ...s, [mixChannel]: { ...cur, ...p } },
        );
      return (
        <>
          <Toggle
            label="Monochrome (one mix drives all channels)"
            checked={s.mono}
            onChange={(v) => onChange({ ...s, mono: v })}
          />
          {!s.mono && (
            <>
              <span className={styles.groupLabel}>Output channel</span>
              <Segmented
                options={[
                  { value: "r", text: "Red" },
                  { value: "g", text: "Green" },
                  { value: "b", text: "Blue" },
                ]}
                value={mixChannel}
                onChange={(v) => setMixChannel(v as "r" | "g" | "b")}
              />
            </>
          )}
          <Slider label="Red" min={-200} max={200} bipolar unit="%" value={cur.r} onChange={(n) => patch({ r: n })} />
          <Slider label="Green" min={-200} max={200} bipolar unit="%" value={cur.g} onChange={(n) => patch({ g: n })} />
          <Slider label="Blue" min={-200} max={200} bipolar unit="%" value={cur.b} onChange={(n) => patch({ b: n })} />
          <Slider label="Constant" min={-100} max={100} bipolar unit="%" value={cur.k} onChange={(n) => patch({ k: n })} />
        </>
      );
    }
    // Gradient map.
    const s = spec as GradientMapAdjustment;
    return (
      <>
        <span className={styles.groupLabel}>Gradient</span>
        <GradientEditor stops={s.stops} onStops={(stops) => onChange({ ...s, stops })} />
        <Toggle label="Reverse" checked={s.reverse} onChange={(v) => onChange({ ...s, reverse: v })} />
        <p className={styles.note}>Composite luminance maps through the gradient (dark → left).</p>
      </>
    );
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={EXTRA_LABELS[spec.type]}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Enter") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>{EXTRA_LABELS[spec.type]}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {body()}
        </div>
        <footer className={styles.foot}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
