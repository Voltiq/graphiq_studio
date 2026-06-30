"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { ColorChip, Segmented, Select, Slider } from "./Controls";
import { parseColor, toHex6 } from "../lib/color";
import { BLEND_MODES } from "../lib/layers";
import {
  DEFAULT_FX,
  FX_LABELS,
  FX_ORDER,
  type FxKey,
  type GlowFX,
  type LayerEffects,
  type ShadowFX,
  type StrokeFX,
  type OverlayColorFX,
  type OverlayGradientFX,
  type BevelFX,
} from "../lib/effects";

const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const rowS: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" };

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  // Reuse the app's custom swatch + colour picker; effect colours stay opaque
  // (the effect's own opacity slider controls strength), so drop any picked alpha.
  return (
    <div style={rowS}>
      <span style={{ fontSize: 12, color: "var(--text-2)" }}>{label}</span>
      <ColorChip color={value} label={label} onChange={(v) => onChange(toHex6(parseColor(v)))} />
    </div>
  );
}

const BlendField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <label style={rowS}>
    <span style={{ fontSize: 12, color: "var(--text-2)" }}>Blend</span>
    <div style={{ width: 150 }}>
      <Select block options={BLEND_MODES} value={value} onChange={onChange} />
    </div>
  </label>
);

export default function LayerStyleDialog({
  effects,
  layerName,
  onChange,
  onToggle,
  onClear,
  onClose,
}: {
  effects: LayerEffects;
  layerName: string;
  onChange: (effects: LayerEffects) => void;
  onToggle: (key: FxKey, enabled: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const fx = effects ?? {};
  const firstOn = FX_ORDER.find((k) => fx[k]?.enabled) ?? "dropShadow";
  const [sel, setSel] = useState<FxKey>(firstOn);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Patch one effect's params (creating it with defaults if absent) — live.
  function set<K extends FxKey>(key: K, patch: Partial<NonNullable<LayerEffects[K]>>) {
    const base = (fx[key] ?? DEFAULT_FX[key]()) as NonNullable<LayerEffects[K]>;
    onChange({ ...fx, [key]: { ...base, ...patch } });
  }

  const renderControls = () => {
    switch (sel) {
      case "dropShadow":
      case "innerShadow": {
        const s = (fx[sel] ?? DEFAULT_FX[sel]()) as ShadowFX;
        return (
          <div style={col}>
            <BlendField value={s.blendMode} onChange={(v) => set(sel, { blendMode: v })} />
            <ColorField label="Color" value={s.color} onChange={(v) => set(sel, { color: v })} />
            <Slider label="Opacity" min={0} max={100} unit="%" value={s.opacity} onChange={(v) => set(sel, { opacity: v })} />
            <Slider label="Angle" min={0} max={360} unit="°" value={s.angle} onChange={(v) => set(sel, { angle: v })} />
            <Slider label="Distance" min={0} max={250} unit="px" value={s.distance} onChange={(v) => set(sel, { distance: v })} />
            <Slider label="Spread" min={0} max={100} unit="%" value={s.spread} onChange={(v) => set(sel, { spread: v })} />
            <Slider label="Size" min={0} max={250} unit="px" value={s.size} onChange={(v) => set(sel, { size: v })} />
          </div>
        );
      }
      case "outerGlow":
      case "innerGlow": {
        const g = (fx[sel] ?? DEFAULT_FX[sel]()) as GlowFX;
        return (
          <div style={col}>
            <BlendField value={g.blendMode} onChange={(v) => set(sel, { blendMode: v })} />
            <ColorField label="Color" value={g.color} onChange={(v) => set(sel, { color: v })} />
            <Slider label="Opacity" min={0} max={100} unit="%" value={g.opacity} onChange={(v) => set(sel, { opacity: v })} />
            <Slider label="Spread" min={0} max={100} unit="%" value={g.spread} onChange={(v) => set(sel, { spread: v })} />
            <Slider label="Size" min={0} max={250} unit="px" value={g.size} onChange={(v) => set(sel, { size: v })} />
            {sel === "innerGlow" && (
              <Segmented
                label="Source"
                value={g.source ?? "edge"}
                onChange={(v) => set("innerGlow", { source: v as "edge" | "center" })}
                options={[
                  { value: "edge", text: "Edge" },
                  { value: "center", text: "Center" },
                ]}
              />
            )}
          </div>
        );
      }
      case "stroke": {
        const st = (fx.stroke ?? DEFAULT_FX.stroke()) as StrokeFX;
        return (
          <div style={col}>
            <BlendField value={st.blendMode} onChange={(v) => set("stroke", { blendMode: v })} />
            <Slider label="Size" min={1} max={100} unit="px" value={st.size} onChange={(v) => set("stroke", { size: v })} />
            <Segmented
              label="Position"
              value={st.position}
              onChange={(v) => set("stroke", { position: v as StrokeFX["position"] })}
              options={[
                { value: "outside", text: "Outside" },
                { value: "center", text: "Center" },
                { value: "inside", text: "Inside" },
              ]}
            />
            <ColorField label="Color" value={st.color ?? "#ffffff"} onChange={(v) => set("stroke", { fillType: "color", color: v })} />
            <Slider label="Opacity" min={0} max={100} unit="%" value={st.opacity} onChange={(v) => set("stroke", { opacity: v })} />
          </div>
        );
      }
      case "colorOverlay": {
        const o = (fx.colorOverlay ?? DEFAULT_FX.colorOverlay()) as OverlayColorFX;
        return (
          <div style={col}>
            <BlendField value={o.blendMode} onChange={(v) => set("colorOverlay", { blendMode: v })} />
            <ColorField label="Color" value={o.color} onChange={(v) => set("colorOverlay", { color: v })} />
            <Slider label="Opacity" min={0} max={100} unit="%" value={o.opacity} onChange={(v) => set("colorOverlay", { opacity: v })} />
          </div>
        );
      }
      case "gradientOverlay": {
        const o = (fx.gradientOverlay ?? DEFAULT_FX.gradientOverlay()) as OverlayGradientFX;
        const stops = o.gradient;
        const setStop = (i: number, color: string) => {
          const g = stops.map((s, k) => (k === i ? { ...s, color } : s));
          set("gradientOverlay", { gradient: g });
        };
        return (
          <div style={col}>
            <BlendField value={o.blendMode} onChange={(v) => set("gradientOverlay", { blendMode: v })} />
            <ColorField label="Start" value={stops[0]?.color ?? "#000000"} onChange={(v) => setStop(0, v)} />
            <ColorField label="End" value={stops[stops.length - 1]?.color ?? "#ffffff"} onChange={(v) => setStop(stops.length - 1, v)} />
            <Segmented
              label="Style"
              value={o.style}
              onChange={(v) => set("gradientOverlay", { style: v as "linear" | "radial" })}
              options={[
                { value: "linear", text: "Linear" },
                { value: "radial", text: "Radial" },
              ]}
            />
            <Slider label="Angle" min={0} max={360} unit="°" value={o.angle} onChange={(v) => set("gradientOverlay", { angle: v })} />
            <Slider label="Scale" min={10} max={300} unit="%" value={o.scale} onChange={(v) => set("gradientOverlay", { scale: v })} />
            <Slider label="Opacity" min={0} max={100} unit="%" value={o.opacity} onChange={(v) => set("gradientOverlay", { opacity: v })} />
          </div>
        );
      }
      case "bevel": {
        const b = (fx.bevel ?? DEFAULT_FX.bevel()) as BevelFX;
        return (
          <div style={col}>
            <Slider label="Depth" min={0} max={300} unit="%" value={b.depth} onChange={(v) => set("bevel", { depth: v })} />
            <Slider label="Size" min={0} max={100} unit="px" value={b.size} onChange={(v) => set("bevel", { size: v })} />
            <Slider label="Soften" min={0} max={40} unit="px" value={b.soften} onChange={(v) => set("bevel", { soften: v })} />
            <Slider label="Angle" min={0} max={360} unit="°" value={b.angle} onChange={(v) => set("bevel", { angle: v })} />
            <Slider label="Altitude" min={0} max={90} unit="°" value={b.altitude} onChange={(v) => set("bevel", { altitude: v })} />
            <ColorField label="Highlight" value={b.highlightColor} onChange={(v) => set("bevel", { highlightColor: v })} />
            <Slider label="Highlight Opacity" min={0} max={100} unit="%" value={b.highlightOpacity} onChange={(v) => set("bevel", { highlightOpacity: v })} />
            <ColorField label="Shadow" value={b.shadowColor} onChange={(v) => set("bevel", { shadowColor: v })} />
            <Slider label="Shadow Opacity" min={0} max={100} unit="%" value={b.shadowOpacity} onChange={(v) => set("bevel", { shadowOpacity: v })} />
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Layer style"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 560 }}
      >
        <header className={styles.head}>
          <h2>Layer Style — {layerName}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", gap: 14 }}>
          <div style={{ width: 190, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span className={styles.groupLabel}>Effects</span>
            {FX_ORDER.map((k) => {
              const on = !!fx[k]?.enabled;
              return (
                <div
                  key={k}
                  className={styles.row}
                  data-active={sel === k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 8px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: sel === k ? "var(--surface-hover)" : "transparent",
                  }}
                  onClick={() => setSel(k)}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onToggle(k, e.target.checked)}
                  />
                  <span style={{ fontSize: 12.5, color: on ? "var(--text)" : "var(--text-3)" }}>{FX_LABELS[k]}</span>
                </div>
              );
            })}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <span className={styles.groupLabel}>{FX_LABELS[sel]}</span>
            <div style={{ marginTop: 8 }}>{renderControls()}</div>
          </div>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClear}>
            Clear All
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
