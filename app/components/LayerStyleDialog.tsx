"use client";

import { useEffect, useState } from "react";
import {
  Blend as BlendIcon,
  Gem,
  Layers2,
  PaintBucket,
  RotateCcw,
  Square,
  SquareDot,
  Sun,
  SunDim,
  X,
  type LucideIcon,
} from "lucide-react";
import styles from "./LayerStyleDialog.module.scss";
import BlendIfControl from "./BlendIfControl";
import type { BlendIf } from "../lib/blendif";
import { KNOCKOUT_MODES, fillOpacityOf, knockoutOf, type KnockoutMode } from "../lib/knockout";
import { ColorChip, Segmented, Select, Slider, Toggle } from "./Controls";
import { GradientEditor } from "./GradientControl";
import { parseColor, toHex6 } from "../lib/color";
import { GRADIENT_PRESETS_KEY } from "../lib/gradientio";
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

const FX_ICONS: Record<FxKey, LucideIcon> = {
  dropShadow: Layers2,
  innerShadow: SquareDot,
  outerGlow: Sun,
  innerGlow: SunDim,
  stroke: Square,
  colorOverlay: PaintBucket,
  gradientOverlay: BlendIcon,
  bevel: Gem,
};

const FX_DESC: Record<FxKey, string> = {
  dropShadow: "A soft shadow cast behind the layer.",
  innerShadow: "A shadow inside the edges, for a recessed look.",
  outerGlow: "Light radiating outward from the edges.",
  innerGlow: "Light along the inside of the edges.",
  stroke: "An outline traced around the layer's silhouette.",
  colorOverlay: "Fills the layer's pixels with a solid colour.",
  gradientOverlay: "Fills the layer's pixels with a gradient.",
  bevel: "Chiselled highlight-and-shadow relief from the edges.",
};

/* ----------------------------- Field helpers ------------------------------ */

/** Label-above colour swatch — matches the Slider's stacked anatomy in grids. */
function ColorStack({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  // Effect colours stay opaque (the effect's own opacity slider is the strength).
  return (
    <div className={styles.stackField}>
      <span className={styles.stackLabel}>{label}</span>
      <ColorChip color={value} label={label} onChange={(v) => onChange(toHex6(parseColor(v)))} />
    </div>
  );
}

/** Label-above blend-mode dropdown. */
function BlendStack({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className={styles.stackField}>
      <span className={styles.stackLabel}>Blend</span>
      <Select block options={BLEND_MODES} value={value} onChange={onChange} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <span className={styles.groupTitle}>{title}</span>
      {children}
    </div>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => <div className={styles.grid2}>{children}</div>;

export default function LayerStyleDialog({
  effects,
  layerName,
  blendIf,
  onBlendIf,
  fillOpacity,
  knockout,
  onBlending,
  gradientStorageKey = GRADIENT_PRESETS_KEY,
  onChange,
  onToggle,
  onClear,
  onClose,
}: {
  effects: LayerEffects;
  layerName: string;
  /** The layer's Blend If, and how to change it (omit to hide the section). */
  blendIf?: BlendIf;
  onBlendIf?: (b: BlendIf | undefined) => void;
  /** Blending Options ▸ fill opacity + knockout (layer-level, like Blend If). */
  fillOpacity?: number;
  knockout?: KnockoutMode;
  onBlending?: (patch: { fillOpacity?: number; knockout?: KnockoutMode }) => void;
  /** Preset bucket for the gradient overlay's editor (shared with the
      Gradient tool unless the "share saved gradients" preference is off). */
  gradientStorageKey?: string;
  onChange: (effects: LayerEffects) => void;
  onToggle: (key: FxKey, enabled: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const fx = effects ?? {};
  const firstOn = FX_ORDER.find((k) => fx[k]?.enabled) ?? "dropShadow";
  const [sel, setSel] = useState<FxKey>(firstOn);
  const selOn = !!fx[sel]?.enabled;
  const onCount = FX_ORDER.filter((k) => fx[k]?.enabled).length;

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
  // Editing a disabled effect enables it, so a drag always shows something.
  function set<K extends FxKey>(key: K, patch: Partial<NonNullable<LayerEffects[K]>>) {
    const base = (fx[key] ?? DEFAULT_FX[key]()) as NonNullable<LayerEffects[K]>;
    onChange({ ...fx, [key]: { ...base, ...patch, enabled: true } });
  }

  // Reset the selected effect's parameters to defaults (keeping its on/off state).
  const resetSel = () => {
    const def = DEFAULT_FX[sel]();
    onChange({ ...fx, [sel]: { ...def, enabled: selOn } });
  };

  const renderControls = () => {
    switch (sel) {
      case "dropShadow":
      case "innerShadow": {
        const s = (fx[sel] ?? DEFAULT_FX[sel]()) as ShadowFX;
        return (
          <>
            <Group title="Appearance">
              <Grid>
                <BlendStack value={s.blendMode} onChange={(v) => set(sel, { blendMode: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={s.opacity} onChange={(v) => set(sel, { opacity: v })} />
                <ColorStack label="Colour" value={s.color} onChange={(v) => set(sel, { color: v })} />
              </Grid>
            </Group>
            <Group title="Geometry">
              <Grid>
                <Slider label="Angle" min={0} max={360} unit="°" value={s.angle} onChange={(v) => set(sel, { angle: v })} />
                <Slider label="Distance" min={0} max={250} unit="px" value={s.distance} onChange={(v) => set(sel, { distance: v })} />
                <Slider label="Spread" min={0} max={100} unit="%" value={s.spread} onChange={(v) => set(sel, { spread: v })} />
                <Slider label="Size" min={0} max={250} unit="px" value={s.size} onChange={(v) => set(sel, { size: v })} />
              </Grid>
            </Group>
          </>
        );
      }
      case "outerGlow":
      case "innerGlow": {
        const g = (fx[sel] ?? DEFAULT_FX[sel]()) as GlowFX;
        return (
          <>
            <Group title="Appearance">
              <Grid>
                <BlendStack value={g.blendMode} onChange={(v) => set(sel, { blendMode: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={g.opacity} onChange={(v) => set(sel, { opacity: v })} />
                <ColorStack label="Colour" value={g.color} onChange={(v) => set(sel, { color: v })} />
              </Grid>
            </Group>
            <Group title="Shape">
              <Grid>
                <Slider label="Spread" min={0} max={100} unit="%" value={g.spread} onChange={(v) => set(sel, { spread: v })} />
                <Slider label="Size" min={0} max={250} unit="px" value={g.size} onChange={(v) => set(sel, { size: v })} />
              </Grid>
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
            </Group>
          </>
        );
      }
      case "stroke": {
        const st = (fx.stroke ?? DEFAULT_FX.stroke()) as StrokeFX;
        const strokeFill = st.fillType === "gradient" ? "gradient" : "color";
        const strokeStops =
          st.gradient && st.gradient.length
            ? st.gradient
            : [
                { color: st.color ?? "#ffffffff", pos: 0 },
                { color: "#000000ff", pos: 1 },
              ];
        return (
          <>
            <Group title="Appearance">
              <Grid>
                <BlendStack value={st.blendMode} onChange={(v) => set("stroke", { blendMode: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={st.opacity} onChange={(v) => set("stroke", { opacity: v })} />
              </Grid>
              <Segmented
                label="Fill"
                value={strokeFill}
                onChange={(v) => {
                  if (v === "gradient") {
                    // Seed with the current colour so the switch never blanks.
                    set("stroke", { fillType: "gradient", gradient: strokeStops, angle: st.angle ?? 90 });
                  } else {
                    set("stroke", { fillType: "color", color: st.color ?? "#ffffff" });
                  }
                }}
                options={[
                  { value: "color", text: "Colour" },
                  { value: "gradient", text: "Gradient" },
                ]}
              />
              {strokeFill === "color" ? (
                <Grid>
                  <ColorStack label="Colour" value={st.color ?? "#ffffff"} onChange={(v) => set("stroke", { fillType: "color", color: v })} />
                </Grid>
              ) : (
                <>
                  <GradientEditor
                    stops={strokeStops}
                    onStops={(g) => set("stroke", { fillType: "gradient", gradient: g })}
                    storageKey={gradientStorageKey}
                  />
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Reverse</span>
                    <Toggle label="" checked={!!st.reverse} onChange={(v) => set("stroke", { reverse: v })} />
                  </div>
                  <Grid>
                    <Slider label="Angle" min={0} max={360} unit="°" value={st.angle ?? 90} onChange={(v) => set("stroke", { angle: v })} />
                  </Grid>
                </>
              )}
            </Group>
            <Group title="Geometry">
              <Grid>
                <Slider label="Size" min={1} max={100} unit="px" value={st.size} onChange={(v) => set("stroke", { size: v })} />
              </Grid>
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
            </Group>
          </>
        );
      }
      case "colorOverlay": {
        const o = (fx.colorOverlay ?? DEFAULT_FX.colorOverlay()) as OverlayColorFX;
        return (
          <Group title="Appearance">
            <Grid>
              <BlendStack value={o.blendMode} onChange={(v) => set("colorOverlay", { blendMode: v })} />
              <Slider label="Opacity" min={0} max={100} unit="%" value={o.opacity} onChange={(v) => set("colorOverlay", { opacity: v })} />
              <ColorStack label="Colour" value={o.color} onChange={(v) => set("colorOverlay", { color: v })} />
            </Grid>
          </Group>
        );
      }
      case "gradientOverlay": {
        const o = (fx.gradientOverlay ?? DEFAULT_FX.gradientOverlay()) as OverlayGradientFX;
        return (
          <>
            <Group title="Appearance">
              <Grid>
                <BlendStack value={o.blendMode} onChange={(v) => set("gradientOverlay", { blendMode: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={o.opacity} onChange={(v) => set("gradientOverlay", { opacity: v })} />
              </Grid>
            </Group>
            <Group title="Gradient">
              {/* The Gradient tool's full editor: draggable multi-stops, presets,
                  save / import / export — same preset library as the tool. */}
              <GradientEditor
                stops={o.gradient}
                onStops={(g) => set("gradientOverlay", { gradient: g })}
                storageKey={gradientStorageKey}
              />
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Reverse</span>
                <Toggle label="" checked={!!o.reverse} onChange={(v) => set("gradientOverlay", { reverse: v })} />
              </div>
            </Group>
            <Group title="Geometry">
              <Segmented
                label="Style"
                value={o.style ?? "linear"}
                onChange={(v) => set("gradientOverlay", { style: v as OverlayGradientFX["style"] })}
                options={[
                  { value: "linear", text: "Linear" },
                  { value: "radial", text: "Radial" },
                  { value: "angle", text: "Angle" },
                  { value: "reflected", text: "Reflected" },
                ]}
              />
              {o.style === "angle" && (
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>Smooth seam</span>
                  <Toggle label="" checked={o.smooth ?? true} onChange={(v) => set("gradientOverlay", { smooth: v })} />
                </div>
              )}
              <Grid>
                <Slider label="Angle" min={0} max={360} unit="°" value={o.angle} onChange={(v) => set("gradientOverlay", { angle: v })} />
                <Slider label="Scale" min={10} max={300} unit="%" value={o.scale} onChange={(v) => set("gradientOverlay", { scale: v })} />
              </Grid>
            </Group>
          </>
        );
      }
      case "bevel": {
        const b = (fx.bevel ?? DEFAULT_FX.bevel()) as BevelFX;
        return (
          <>
            <Group title="Structure">
              <Grid>
                <Slider label="Depth" min={0} max={300} unit="%" value={b.depth} onChange={(v) => set("bevel", { depth: v })} />
                <Slider label="Size" min={0} max={100} unit="px" value={b.size} onChange={(v) => set("bevel", { size: v })} />
                <Slider label="Soften" min={0} max={40} unit="px" value={b.soften} onChange={(v) => set("bevel", { soften: v })} />
              </Grid>
            </Group>
            <Group title="Light">
              <Grid>
                <Slider label="Angle" min={0} max={360} unit="°" value={b.angle} onChange={(v) => set("bevel", { angle: v })} />
                <Slider label="Altitude" min={0} max={90} unit="°" value={b.altitude} onChange={(v) => set("bevel", { altitude: v })} />
              </Grid>
            </Group>
            <Group title="Highlight">
              <Grid>
                <ColorStack label="Colour" value={b.highlightColor} onChange={(v) => set("bevel", { highlightColor: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={b.highlightOpacity} onChange={(v) => set("bevel", { highlightOpacity: v })} />
              </Grid>
            </Group>
            <Group title="Shadow">
              <Grid>
                <ColorStack label="Colour" value={b.shadowColor} onChange={(v) => set("bevel", { shadowColor: v })} />
                <Slider label="Opacity" min={0} max={100} unit="%" value={b.shadowOpacity} onChange={(v) => set("bevel", { shadowOpacity: v })} />
              </Grid>
            </Group>
          </>
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
      >
        <header className={styles.head}>
          <h2>Layer style</h2>
          <span className={styles.nameChip} title={layerName}>
            {layerName}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.layout}>
          <div className={styles.list} role="listbox" aria-label="Effects">
            <span className={styles.listLabel}>Effects</span>
            {FX_ORDER.map((k) => {
              const on = !!fx[k]?.enabled;
              const Icon = FX_ICONS[k];
              return (
                <div
                  key={k}
                  className={styles.fxRow}
                  data-sel={sel === k}
                  data-on={on}
                  role="option"
                  aria-selected={sel === k}
                  tabIndex={0}
                  onClick={() => setSel(k)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSel(k);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={styles.fxCheck}
                    data-on={on}
                    aria-label={`${FX_LABELS[k]} ${on ? "on" : "off"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(k, !on);
                    }}
                  >
                    {on && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
                        <path d="M1.5 5.5 4 8l4.5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                  <Icon size={14} className={styles.fxIcon} />
                  <span className={styles.fxName}>{FX_LABELS[k]}</span>
                </div>
              );
            })}
          </div>

          <div className={styles.pane}>
            <div className={styles.paneHead}>
              <span className={styles.paneTitle}>{FX_LABELS[sel]}</span>
              <div className={styles.paneActions}>
                <button type="button" className={styles.resetBtn} onClick={resetSel}>
                  <RotateCcw size={11} /> Reset
                </button>
                <button
                  type="button"
                  className={styles.switch}
                  data-on={selOn}
                  role="switch"
                  aria-checked={selOn}
                  aria-label={`${FX_LABELS[sel]} enabled`}
                  onClick={() => onToggle(sel, !selOn)}
                />
              </div>
            </div>
            <p className={styles.paneDesc}>{FX_DESC[sel]}</p>
            <div className={styles.paneBody}>
              {renderControls()}
              {/* Blending Options ▸ Blend If — a property of the LAYER, not of
                  any one effect, so it sits below the selected effect's
                  controls rather than inside them. */}
              {onBlending && (
                <div className={styles.group}>
                  <span className={styles.groupTitle}>Blending Options</span>
                  <Slider
                    label="Fill opacity"
                    min={0}
                    max={100}
                    unit="%"
                    value={fillOpacityOf(fillOpacity)}
                    onChange={(v) => onBlending({ fillOpacity: v })}
                  />
                  <Segmented
                    label="Knockout"
                    value={knockoutOf(knockout)}
                    onChange={(v) => onBlending({ knockout: v as KnockoutMode })}
                    options={KNOCKOUT_MODES.map((k) => ({ value: k.id, text: k.label }))}
                  />
                  <p className={styles.hint}>
                    Fill opacity fades the layer&apos;s own pixels but leaves its effects at full
                    strength. Knockout punches the layer&apos;s shape through what is beneath it —
                    Shallow stops at the bottom of its group, Deep goes through the whole document.
                    You only see the hole once Fill opacity drops below 100.
                  </p>
                </div>
              )}
              {onBlendIf && <BlendIfControl value={blendIf} onChange={onBlendIf} />}
            </div>
          </div>
        </div>

        <footer className={styles.foot}>
          <span className={styles.countNote}>
            {onCount === 0 ? "No effects on" : `${onCount} of ${FX_ORDER.length} effects on`}
          </span>
          <div className={styles.footSpacer} />
          <button type="button" className={`${styles.btn} ${styles.clearBtn}`} onClick={onClear}>
            Clear all
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
