"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import styles from "./LayerStyleDialog.module.scss";
import { Select } from "./Controls";
import {
  BLEND_IF_CHANNELS,
  DEFAULT_BLEND_IF,
  FULL_RANGE,
  normalizeRange,
  type BlendIf,
  type BlendIfChannel,
  type BlendIfRange,
} from "../lib/blendif";

type End = "black" | "white";
/** Which half of a handle is being dragged (0 = left, 1 = right). */
type Half = 0 | 1;

/**
 * One Blend-If track: a tonal gradient with a black handle at the left and a
 * white handle at the right, each drawn as two halves.
 *
 * Dragging a handle moves BOTH halves (a hard cut); **Alt-drag moves one half**,
 * splitting it into a ramp — which is Photoshop's interaction, and the only way
 * to get a soft edge instead of a jagged one.
 */
function Track({
  label,
  range,
  onChange,
}: {
  label: string;
  range: BlendIfRange;
  onChange: (r: BlendIfRange) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const r = normalizeRange(range);

  const valueAt = (clientX: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const b = rail.getBoundingClientRect();
    if (b.width <= 0) return 0;
    return Math.max(0, Math.min(255, Math.round(((clientX - b.left) / b.width) * 255)));
  };

  const startDrag = (end: End, half: Half) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const split = e.altKey;
    const move = (ev: PointerEvent) => {
      const v = valueAt(ev.clientX);
      const cur = normalizeRange(range);
      const pair: [number, number] = [...cur[end]] as [number, number];
      if (split) pair[half] = v;
      else {
        // Move the pair as one, keeping whatever gap it already had.
        const width = pair[1] - pair[0];
        pair[0] = half === 0 ? v : v - width;
        pair[1] = pair[0] + width;
      }
      onChange(normalizeRange({ ...cur, [end]: pair }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (v: number) => `${(v / 255) * 100}%`;
  const handle = (end: End, half: Half) => (
    <span
      key={`${end}${half}`}
      className={styles.biHandle}
      data-end={end}
      data-half={half}
      style={{ left: pct(r[end][half]) }}
      onPointerDown={startDrag(end, half)}
      role="slider"
      tabIndex={0}
      aria-label={`${label} ${end} ${half === 0 ? "start" : "end"}`}
      aria-valuemin={0}
      aria-valuemax={255}
      aria-valuenow={r[end][half]}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 1;
        const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        if (!d) return;
        e.preventDefault();
        const cur = normalizeRange(range);
        const pair: [number, number] = [...cur[end]] as [number, number];
        // Alt makes the arrows split too, matching the drag.
        if (e.altKey) pair[half] += d;
        else {
          pair[0] += d;
          pair[1] += d;
        }
        onChange(normalizeRange({ ...cur, [end]: pair }));
      }}
    />
  );

  return (
    <div className={styles.biTrack}>
      <div className={styles.biLabelRow}>
        <span>{label}</span>
        <span className={styles.biValues}>
          {r.black[0] === r.black[1] ? r.black[0] : `${r.black[0]}/${r.black[1]}`}
          {" – "}
          {r.white[0] === r.white[1] ? r.white[1] : `${r.white[0]}/${r.white[1]}`}
        </span>
      </div>
      <div className={styles.biRail} ref={railRef}>
        {/* The band that survives, drawn under the handles. */}
        <span
          className={styles.biKeep}
          style={{ left: pct(r.black[0]), right: `${100 - (r.white[1] / 255) * 100}%` }}
        />
        {handle("black", 0)}
        {handle("black", 1)}
        {handle("white", 0)}
        {handle("white", 1)}
      </div>
    </div>
  );
}

/**
 * Blend If (Photoshop's Blending Options): hide a layer's pixels by their own
 * tonal range, and/or by the tones already beneath it. The classic use is
 * dropping a dark sky out of a shot without touching a mask.
 */
export default function BlendIfControl({
  value,
  onChange,
}: {
  value?: BlendIf;
  onChange: (b: BlendIf | undefined) => void;
}) {
  const v = value ?? DEFAULT_BLEND_IF;
  const isDefault =
    v.this.black[0] === 0 &&
    v.this.black[1] === 0 &&
    v.this.white[0] === 255 &&
    v.this.white[1] === 255 &&
    v.under.black[0] === 0 &&
    v.under.black[1] === 0 &&
    v.under.white[0] === 255 &&
    v.under.white[1] === 255;

  return (
    <div className={styles.biWrap}>
      <div className={styles.biHead}>
        <Select
          label="Blend If"
          options={BLEND_IF_CHANNELS.map((c) => c.label)}
          value={BLEND_IF_CHANNELS.find((c) => c.id === v.channel)?.label ?? "Gray"}
          onChange={(l) =>
            onChange({
              ...v,
              channel:
                (BLEND_IF_CHANNELS.find((c) => c.label === l)?.id as BlendIfChannel) ?? "gray",
            })
          }
          width={110}
        />
        <button
          type="button"
          className={styles.biReset}
          disabled={isDefault}
          onClick={() => onChange(undefined)}
        >
          Reset
        </button>
      </div>
      <Track label="This layer" range={v.this} onChange={(t) => onChange({ ...v, this: t })} />
      <Track
        label="Underlying layer"
        range={v.under}
        onChange={(u) => onChange({ ...v, under: u })}
      />
      <p className={styles.biHint}>
        Drag a handle to cut, <strong>Alt-drag</strong> to split it into a soft ramp. Underlying
        tests what is already composited below this layer.
      </p>
    </div>
  );
}

export { FULL_RANGE };
