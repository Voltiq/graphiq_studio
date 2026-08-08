"use client";

import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented, Slider, Toggle } from "./Controls";
import { GradientEditor } from "./GradientControl";
import ColorPopover from "./ColorPopover";
import { swatchBg } from "../lib/color";
import type { FillSpec, GradientFill } from "../lib/layers";
import type { GradientType } from "../lib/tools";

/** Default gradient for a freshly-switched gradient fill (black → white). */
const DEFAULT_GRADIENT: GradientFill = {
  stops: [
    { color: "#000000ff", pos: 0 },
    { color: "#ffffffff", pos: 1 },
  ],
  type: "linear",
  angle: 90,
  scale: 1,
  reverse: false,
  smooth: false,
};

const GRAD_TYPES: { value: GradientType; text: string; title: string }[] = [
  { value: "linear", text: "Linear", title: "Linear" },
  { value: "radial", text: "Radial", title: "Radial" },
  { value: "angle", text: "Angle", title: "Angle (conic)" },
  { value: "reflected", text: "Reflect", title: "Reflected" },
];

/**
 * Editor for a Fill layer's parametric content. Edits apply live to the node's
 * `fill` spec (`onChange`, an immutable panel patch — the render graph re-renders
 * from the new spec); Solid ↔ Gradient can be switched in place.
 */
export default function FillDialog({
  fill,
  onChange,
  onClose,
}: {
  fill: FillSpec;
  onChange: (fill: FillSpec) => void;
  onClose: () => void;
}) {
  const solidColor = fill.kind === "solid" ? fill.color : "#808080ff";
  const grad = fill.kind === "gradient" ? fill.gradient : DEFAULT_GRADIENT;
  const patchGrad = (p: Partial<GradientFill>) =>
    onChange({ kind: "gradient", gradient: { ...grad, ...p } });

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Fill layer"
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Enter") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Fill Layer</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Segmented
            options={[
              { value: "solid", text: "Solid Color" },
              { value: "gradient", text: "Gradient" },
            ]}
            value={fill.kind}
            onChange={(v) =>
              v === "solid"
                ? onChange({ kind: "solid", color: solidColor })
                : onChange({ kind: "gradient", gradient: grad })
            }
          />
          {fill.kind === "solid" ? (
            <>
              <span className={styles.groupLabel}>Color</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ColorPopover
                  color={solidColor}
                  onChange={(c) => onChange({ kind: "solid", color: c })}
                  style={{
                    ...swatchBg(solidColor),
                    width: 52,
                    height: 32,
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                  }}
                  title="Fill colour"
                  ariaLabel="Fill colour"
                />
                <span className={styles.note} style={{ margin: 0 }}>
                  Fills the whole layer — add a mask to confine it.
                </span>
              </div>
            </>
          ) : (
            <>
              <span className={styles.groupLabel}>Gradient</span>
              <GradientEditor stops={grad.stops} onStops={(stops) => patchGrad({ stops })} />
              <Segmented
                label="Style"
                options={GRAD_TYPES}
                value={grad.type}
                onChange={(v) => patchGrad({ type: v as GradientType })}
              />
              <Slider
                label="Angle"
                min={0}
                max={360}
                unit="°"
                value={grad.angle}
                onChange={(n) => patchGrad({ angle: n })}
              />
              <Slider
                label="Scale"
                min={10}
                max={300}
                unit="%"
                value={Math.round(grad.scale * 100)}
                onChange={(n) => patchGrad({ scale: n / 100 })}
              />
              <div style={{ display: "flex", gap: 18 }}>
                <Toggle label="Reverse" checked={grad.reverse} onChange={(v) => patchGrad({ reverse: v })} />
                {grad.type === "angle" && (
                  <Toggle label="Smooth" checked={grad.smooth} onChange={(v) => patchGrad({ smooth: v })} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
