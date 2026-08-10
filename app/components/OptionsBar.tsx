"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Hexagon,
  Ligature,
  Lasso as LassoIcon,
  Magnet,
  Palette,
  PenLine,
  Waves,
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  ArrowLeftRight,
  Bold,
  Check,
  Circle,
  FlaskConical,
  Italic,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Ruler,
  Square,
  Strikethrough,
  Triangle,
  Underline,
  X,
} from "lucide-react";
import styles from "./OptionsBar.module.scss";
import {
  CROP_RATIOS,
  FONT_FAMILIES,
  getTool,
  measureInfo,
  SAMPLE_SCOPE_OPTIONS,
  SAMPLE_SIZE_OPTIONS,
  type BlurSettings,
  type HealSettings,
  type RedEyeSettings,
  type CloneSettings,
  type CropSettings,
  type DodgeMode,
  type DodgeRange,
  type DodgeSettings,
  type SmudgeSettings,
  type SpongeMode,
  type SpongeSettings,
  type TextAlign,
  type TextSettings,
  type GradientSettings,
  type GradientType,
  type LassoMode,
  type MarqueeShape,
  type MeasureLine,
  type MoveMode,
  type QuickSelectSettings,
  type PenSettings,
  type SelectResizeMode,
  type ShapeKind,
  type ShapeSettings,
  type ToolId,
} from "../lib/tools";
import type { Rect } from "../lib/view";
import type { ActiveSurface } from "../lib/layers";
import type { TextAxes, TextGradient, TextOpenType } from "../lib/tools";
import { WARP_STYLES, warpActive, type TextWarp, type TextWarpStyle } from "../lib/textwarp";
import {
  BUILTIN_BRUSHES,
  getBrushPresets,
  subscribeBrushPresets,
  type BrushPreset,
} from "../lib/brushes";
import {
  OPENTYPE_FLAGS,
  effectiveWeight,
  featureOn,
  fontFeatureCSS,
  stretchKeyword,
} from "../lib/richtext";
import GradientControl, { GradientEditor } from "./GradientControl";
import { brushDynamics, type BrushSettings } from "../lib/paint";
import {
  ColorChip,
  Divider,
  NumberField,
  Segmented,
  Select,
  Slider as BaseSlider,
  Toggle,
} from "./Controls";

/** In the options bar every slider is the compact inline (label-beside) variant. */
function Slider(props: React.ComponentProps<typeof BaseSlider>) {
  return <BaseSlider inline {...props} />;
}

/** The nine width stops the canvas font shorthand can express (keywords). */
const WIDTH_STOPS = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];
const widthLabel = (pct: number) => (pct === 100 ? "Normal (100%)" : `${pct}%`);

/**
 * OpenType popover (TODO §6): block-level feature toggles (ligatures,
 * alternates, caps, figures) plus variable-font Weight/Width axes. Features
 * apply where the font supports them; the axes need a variable font.
 */
function OpenTypeControl({ text, onText }: TextProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const nonDefault =
    !!fontFeatureCSS(text.features) ||
    text.axes?.wght !== undefined ||
    stretchKeyword(text.axes?.wdth) !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 328)),
        top: r.bottom + 6,
      });
    }
    setOpen((o) => !o);
  };

  const setFeature = (key: keyof TextOpenType, v: boolean) => {
    const next: TextOpenType = { ...text.features, [key]: v };
    // Entries back at their default drop out, so "all defaults" is absent —
    // and legacy blocks stay byte-stable.
    for (const { key: k } of OPENTYPE_FLAGS) {
      if (next[k] !== undefined && next[k] === featureOn(undefined, k)) delete next[k];
    }
    onText({ features: Object.keys(next).length ? next : undefined });
  };
  const setAxes = (patch: Partial<TextAxes>) => {
    const next: TextAxes = { ...text.axes, ...patch };
    if (next.wght === undefined) delete next.wght;
    if (next.wdth === undefined || next.wdth === 100) delete next.wdth;
    onText({ axes: Object.keys(next).length ? next : undefined });
  };

  const curWidth = WIDTH_STOPS.reduce((best, s) =>
    Math.abs(s - (text.axes?.wdth ?? 100)) < Math.abs(best - (text.axes?.wdth ?? 100)) ? s : best,
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.iconBtn}
        data-active={nonDefault || open}
        title="OpenType features & variable axes"
        onClick={toggleOpen}
      >
        <Ligature size={15} />
      </button>
      {open &&
        createPortal(
          <>
            <div className={styles.otBackdrop} onMouseDown={() => setOpen(false)} />
            <div className={styles.otPopover} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="OpenType features">
            <span className={styles.otTitle}>OpenType features</span>
            <div className={styles.otGrid}>
              {OPENTYPE_FLAGS.map(({ key, label }) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={featureOn(text.features, key)}
                  onChange={(v) => setFeature(key, v)}
                />
              ))}
            </div>
            <span className={styles.otTitle}>Variable axes</span>
            <div className={styles.otAxisRow}>
              <BaseSlider
                inline
                label="Weight"
                min={100}
                max={900}
                step={25}
                value={effectiveWeight(text.bold, text.axes)}
                onChange={(n) => setAxes({ wght: n })}
              />
              {text.axes?.wght !== undefined && (
                <button
                  type="button"
                  className={styles.otReset}
                  title="Back to the Bold toggle"
                  onClick={() => setAxes({ wght: undefined })}
                >
                  <RotateCcw size={11} />
                </button>
              )}
            </div>
            <div className={styles.otAxisRow}>
              <Select
                label="Width"
                options={WIDTH_STOPS.map(widthLabel)}
                value={widthLabel(curWidth)}
                onChange={(l) => setAxes({ wdth: WIDTH_STOPS.find((s) => widthLabel(s) === l) ?? 100 })}
                width={150}
              />
            </div>
            <span className={styles.otHint}>
              Fonts decide which features exist; Weight and Width need a variable font (try
              Bahnschrift or Segoe UI Variable).
            </span>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

const DEFAULT_WARP: TextWarp = { style: "arc", bend: 40, distH: 0, distV: 0 };

/** Warp-text popover: a style dropdown + bend / horizontal / vertical sliders.
 *  Deforms the whole text block (arc, bulge, flag, …); baked on commit. */
function WarpControl({ text, onText }: TextProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const active = warpActive(text.warp);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 6 });
    }
    setOpen((o) => !o);
  };

  const warp: TextWarp = text.warp ?? { style: "none", bend: 0, distH: 0, distV: 0 };
  const setWarp = (patch: Partial<TextWarp>) => {
    const next = { ...warp, ...patch };
    onText({ warp: next.style === "none" ? undefined : next });
  };
  const setStyle = (style: TextWarpStyle) => {
    if (style === "none") return onText({ warp: undefined });
    // Picking a style from flat seeds a sensible default bend so it's visible.
    onText({ warp: warp.style === "none" ? { ...DEFAULT_WARP, style } : { ...warp, style } });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.iconBtn}
        data-active={active || open}
        title="Warp text (arc, bulge, flag, …)"
        onClick={toggleOpen}
      >
        <Waves size={15} />
      </button>
      {open &&
        createPortal(
          <>
            <div className={styles.otBackdrop} onMouseDown={() => setOpen(false)} />
            <div className={styles.otPopover} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Warp text">
              <span className={styles.otTitle}>Warp text</span>
              <div className={styles.otAxisRow}>
                <Select
                  label="Style"
                  options={WARP_STYLES.map((s) => s.label)}
                  value={WARP_STYLES.find((s) => s.id === warp.style)?.label ?? "None"}
                  onChange={(l) => setStyle(WARP_STYLES.find((s) => s.label === l)?.id ?? "none")}
                  width={150}
                />
              </div>
              <BaseSlider inline label="Bend" min={-100} max={100} bipolar value={warp.bend} onChange={(n) => setWarp({ bend: n })} />
              <BaseSlider inline label="Horizontal" min={-100} max={100} bipolar value={warp.distH} onChange={(n) => setWarp({ distH: n })} />
              <BaseSlider inline label="Vertical" min={-100} max={100} bipolar value={warp.distV} onChange={(n) => setWarp({ distV: n })} />
              <span className={styles.otHint}>Deforms the whole block; bakes when you commit the text (Enter / click away).</span>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/**
 * Pen-pressure popover for the paint tools: which brush properties a stylus
 * drives, and how weak the lightest touch gets.
 *
 * Opacity is deliberately absent. In this engine opacity is the ceiling applied
 * when the whole stroke buffer is composited, so it cannot vary within a stroke
 * — per-dab paint IS `flow`, which is what pressure drives instead.
 */
function PressureControl({
  brush,
  onBrush,
  showFlow,
}: {
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  showFlow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const dyn = brushDynamics(brush);
  const active = showFlow ? dyn.size || dyn.flow : dyn.size;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 6 });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.iconBtn}
        data-active={active || open}
        title="Pen pressure (size / flow)"
        aria-label="Pen pressure"
        onClick={toggleOpen}
      >
        <PenLine size={15} />
      </button>
      {open &&
        createPortal(
          <>
            <div className={styles.otBackdrop} onMouseDown={() => setOpen(false)} />
            <div
              className={styles.otPopover}
              style={{ left: pos.left, top: pos.top }}
              role="dialog"
              aria-label="Pen pressure"
            >
              <span className={styles.otTitle}>Pen pressure</span>
              <div style={{ display: "flex", gap: 18, padding: "2px 0 4px" }}>
                <Toggle
                  label="Size"
                  checked={dyn.size}
                  onChange={(v) => onBrush({ ...brush, pressureSize: v })}
                />
                {showFlow && (
                  <Toggle
                    label="Flow"
                    checked={dyn.flow}
                    onChange={(v) => onBrush({ ...brush, pressureFlow: v })}
                  />
                )}
              </div>
              <BaseSlider
                inline
                label="Minimum"
                unit="%"
                min={0}
                max={100}
                value={dyn.min}
                onChange={(n) => onBrush({ ...brush, pressureMin: n })}
              />
              <span className={styles.otHint}>
                What the lightest touch still puts down. A mouse always paints at full strength;
                the response curve and palm rejection live in Preferences ▸ Touch &amp; pen.
              </span>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/** Options-bar brush-preset picker: the shipped + saved presets from the
 *  Brushes panel. Applying one loads its whole settings bundle; the label falls
 *  back to "Custom" once the live settings no longer match any preset. */
function BrushPresetSelect({
  brush,
  onBrush,
}: {
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
}) {
  // Shared store, so presets saved in the Brushes panel appear here at once.
  const [user, setUser] = useState<BrushPreset[]>(() => getBrushPresets());
  useEffect(() => subscribeBrushPresets(setUser), []);
  const all = [...BUILTIN_BRUSHES, ...user];
  const same = (a: BrushSettings, b: BrushSettings) =>
    a.size === b.size &&
    a.hardness === b.hardness &&
    a.opacity === b.opacity &&
    a.flow === b.flow &&
    a.smoothing === b.smoothing &&
    a.blend === b.blend;
  const match = all.find((p) => same(p.settings, brush));
  const CUSTOM = "Custom";
  // Duplicate names would collapse in the Select — de-duplicate for display.
  const seen = new Set<string>();
  const labels: string[] = [];
  const byLabel = new Map<string, BrushPreset>();
  for (const p of all) {
    let l = p.name;
    let i = 2;
    while (seen.has(l)) l = `${p.name} (${i++})`;
    seen.add(l);
    labels.push(l);
    byLabel.set(l, p);
  }
  const current = match ? labels[all.indexOf(match)] : CUSTOM;
  return (
    <Select
      label="Preset"
      width={140}
      options={match ? labels : [CUSTOM, ...labels]}
      value={current}
      onChange={(l) => {
        const p = byLabel.get(l);
        if (p) onBrush({ ...p.settings });
      }}
    />
  );
}

const GRAD_FILL_TYPES: { value: GradientType; text: string; title: string }[] = [
  { value: "linear", text: "Linear", title: "Linear" },
  { value: "radial", text: "Radial", title: "Radial" },
  { value: "angle", text: "Angle", title: "Angle (conic)" },
  { value: "reflected", text: "Reflect", title: "Reflected" },
];

/** Text fill popover: Solid (the colour swatch) vs a Gradient painted through
 *  the glyphs. Gradient geometry is relative to the text's own bounds. */
function TextFillControl({ text, onText }: TextProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const grad = text.fill?.gradient;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggleOpen = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 330)), top: r.bottom + 6 });
    }
    setOpen((o) => !o);
  };

  // A fresh gradient starts from the current text colour → transparent-ish white,
  // so switching to Gradient is immediately visible without further tweaking.
  const seed = (): TextGradient => ({
    stops: [
      { color: text.color, pos: 0 },
      { color: "#ffffffff", pos: 1 },
    ],
    type: "linear",
    angle: 90,
    scale: 1,
    reverse: false,
    smooth: false,
  });
  const patch = (p: Partial<TextGradient>) =>
    onText({ fill: { kind: "gradient", gradient: { ...(grad ?? seed()), ...p } } });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.iconBtn}
        data-active={!!grad || open}
        title="Text fill (solid colour or gradient)"
        onClick={toggleOpen}
      >
        <Palette size={15} />
      </button>
      {open &&
        createPortal(
          <>
            <div className={styles.otBackdrop} onMouseDown={() => setOpen(false)} />
            <div className={styles.otPopover} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Text fill">
              <span className={styles.otTitle}>Text fill</span>
              <Segmented
                options={[
                  { value: "solid", text: "Solid" },
                  { value: "gradient", text: "Gradient" },
                ]}
                value={grad ? "gradient" : "solid"}
                onChange={(v) =>
                  v === "solid" ? onText({ fill: undefined }) : onText({ fill: { kind: "gradient", gradient: seed() } })
                }
              />
              {grad ? (
                <>
                  <GradientEditor stops={grad.stops} onStops={(stops) => patch({ stops })} />
                  <Segmented
                    label="Style"
                    options={GRAD_FILL_TYPES}
                    value={grad.type}
                    onChange={(v) => patch({ type: v as GradientType })}
                  />
                  <BaseSlider inline label="Angle" min={0} max={360} unit="°" value={grad.angle} onChange={(n) => patch({ angle: n })} />
                  <BaseSlider
                    inline
                    label="Scale"
                    min={10}
                    max={300}
                    unit="%"
                    value={Math.round(grad.scale * 100)}
                    onChange={(n) => patch({ scale: n / 100 })}
                  />
                  <div style={{ display: "flex", gap: 18 }}>
                    <Toggle label="Reverse" checked={grad.reverse} onChange={(v) => patch({ reverse: v })} />
                    {grad.type === "angle" && (
                      <Toggle label="Smooth" checked={grad.smooth} onChange={(v) => patch({ smooth: v })} />
                    )}
                  </div>
                  <span className={styles.otHint}>
                    Painted through the glyphs, spanning the text&apos;s own bounds; bakes when you commit
                    the text (Enter / click away).
                  </span>
                </>
              ) : (
                <span className={styles.otHint}>
                  Solid uses the colour swatch in the options bar. Switch to Gradient to fill the type
                  with a colour band.
                </span>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

interface ShapeProps {
  shape: ShapeSettings;
  onShape: (patch: Partial<ShapeSettings>) => void;
  fill: string;
  onFill: (c: string) => void;
  stroke: string;
  onStroke: (c: string) => void;
}

interface BlurProps {
  blur: BlurSettings;
  onBlur: (patch: Partial<BlurSettings>) => void;
}

interface SmudgeProps {
  smudge: SmudgeSettings;
  onSmudge: (patch: Partial<SmudgeSettings>) => void;
}

interface SpongeProps {
  sponge: SpongeSettings;
  onSponge: (patch: Partial<SpongeSettings>) => void;
}

interface HistoryBrushProps {
  historyBrush: BrushSettings;
  onHistoryBrush: (b: BrushSettings) => void;
}

interface HealProps {
  heal: HealSettings;
  onHeal: (patch: Partial<HealSettings>) => void;
}

interface RedEyeProps {
  redEye: RedEyeSettings;
  onRedEye: (patch: Partial<RedEyeSettings>) => void;
}

interface CloneProps {
  clone: CloneSettings;
  onClone: (patch: Partial<CloneSettings>) => void;
}

interface TextProps {
  text: TextSettings;
  onText: (patch: Partial<TextSettings>) => void;
}

interface DodgeProps {
  dodge: DodgeSettings;
  onDodge: (patch: Partial<DodgeSettings>) => void;
}

interface CropProps {
  crop: CropSettings;
  onCrop: (patch: Partial<CropSettings>) => void;
  cropBox: Rect | null;
  onCropBox: (b: Rect | null) => void;
  onCropApply: () => void;
  onCropReset: () => void;
  docWidth: number;
  docHeight: number;
}

export default function OptionsBar({
  tool,
  paintSurface,
  onExitMaskEdit,
  foreground,
  onForeground,
  brush,
  onBrush,
  moveMode,
  onMoveMode,
  resizeMode,
  onResizeMode,
  resizeSmooth,
  onResizeSmooth,
  marqueeShape,
  onMarqueeShape,
  lassoMode,
  onLassoMode,
  triangleApex,
  onTriangleApex,
  wand,
  onWand,
  quickSelect,
  onQuickSelect,
  bucket,
  onBucket,
  gradient,
  onGradient,
  pen,
  onPen,
  eyedropper,
  onEyedropper,
  shape,
  onShape,
  blur,
  onBlur,
  smudge,
  onSmudge,
  sponge,
  onSponge,
  historyBrush,
  onHistoryBrush,
  heal,
  onHeal,
  redEye,
  onRedEye,
  clone,
  onClone,
  text,
  onText,
  dodge,
  onDodge,
  crop,
  onCrop,
  cropBox,
  onCropBox,
  onCropApply,
  onCropReset,
  docWidth,
  docHeight,
  fill,
  onFill,
  stroke,
  onStroke,
  measure,
  onMeasureClear,
  onStraighten,
}: {
  tool: ToolId;
  paintSurface: ActiveSurface;
  onExitMaskEdit: () => void;
  foreground: string;
  onForeground: (c: string) => void;
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  moveMode: MoveMode;
  onMoveMode: (m: MoveMode) => void;
  resizeMode: SelectResizeMode;
  onResizeMode: (m: SelectResizeMode) => void;
  resizeSmooth: boolean;
  onResizeSmooth: (v: boolean) => void;
  marqueeShape: MarqueeShape;
  lassoMode: LassoMode;
  onLassoMode: (m: LassoMode) => void;
  onMarqueeShape: (s: MarqueeShape) => void;
  triangleApex: number;
  onTriangleApex: (v: number) => void;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  onWand: (patch: Partial<{ tolerance: number; contiguous: boolean; sampleAll: boolean }>) => void;
  quickSelect: QuickSelectSettings;
  onQuickSelect: (patch: Partial<QuickSelectSettings>) => void;
  bucket: { tolerance: number; opacity: number; contiguous: boolean; antialias: boolean };
  onBucket: (patch: Partial<{ tolerance: number; opacity: number; contiguous: boolean; antialias: boolean }>) => void;
  gradient: GradientSettings;
  onGradient: (patch: Partial<GradientSettings>) => void;
  pen: PenSettings;
  onPen: (patch: Partial<PenSettings>) => void;
  eyedropper: { size: string; scope: string };
  onEyedropper: (patch: { size?: string; scope?: string }) => void;
  measure: MeasureLine | null;
  onMeasureClear: () => void;
  onStraighten: () => void;
} & ShapeProps &
  BlurProps &
  SmudgeProps &
  SpongeProps &
  HistoryBrushProps &
  HealProps &
  RedEyeProps &
  CloneProps &
  TextProps &
  DodgeProps &
  CropProps) {
  const meta = getTool(tool);
  const Icon = meta.icon;

  return (
    <div className={styles.optionsbar} data-tour="options">
      <div className={styles.toolBadge}>
        <Icon size={16} strokeWidth={2} />
        <span>{meta.name}</span>
      </div>
      {paintSurface !== "pixels" && (
        <button
          type="button"
          className={styles.maskPill}
          title={
            paintSurface === "filterMask"
              ? "Paint tools and fills target the filter mask, not the layer pixels — click to edit pixels"
              : "Paint tools and fills target the layer mask, not the layer pixels — click to edit pixels"
          }
          onClick={onExitMaskEdit}
        >
          {paintSurface === "filterMask" ? (
            <FlaskConical size={12} />
          ) : (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
            </svg>
          )}
          <span>{paintSurface === "filterMask" ? "Editing filter mask" : "Editing mask"}</span>
          <X size={11} strokeWidth={2.5} className={styles.maskPillX} />
        </button>
      )}
      <Divider />
      <div className={styles.controls}>
        {renderOptions(
          tool,
          foreground,
          onForeground,
          brush,
          onBrush,
          moveMode,
          onMoveMode,
          resizeMode,
          onResizeMode,
          resizeSmooth,
          onResizeSmooth,
          marqueeShape,
          onMarqueeShape,
          lassoMode,
          onLassoMode,
          triangleApex,
          onTriangleApex,
          wand,
          onWand,
          quickSelect,
          onQuickSelect,
          bucket,
          onBucket,
          gradient,
          onGradient,
          pen,
          onPen,
          eyedropper,
          onEyedropper,
          { shape, onShape, fill, onFill, stroke, onStroke },
          { crop, onCrop, cropBox, onCropBox, onCropApply, onCropReset, docWidth, docHeight },
          { blur, onBlur },
          { smudge, onSmudge },
          { sponge, onSponge },
          { historyBrush, onHistoryBrush },
          { heal, onHeal },
          { redEye, onRedEye },
          { clone, onClone },
          { text, onText },
          { dodge, onDodge },
          measure,
          onMeasureClear,
          onStraighten,
        )}
      </div>
    </div>
  );
}

function renderOptions(
  tool: ToolId,
  foreground: string,
  onForeground: (c: string) => void,
  brush: BrushSettings,
  onBrush: (b: BrushSettings) => void,
  moveMode: MoveMode,
  onMoveMode: (m: MoveMode) => void,
  resizeMode: SelectResizeMode,
  onResizeMode: (m: SelectResizeMode) => void,
  resizeSmooth: boolean,
  onResizeSmooth: (v: boolean) => void,
  marqueeShape: MarqueeShape,
  onMarqueeShape: (s: MarqueeShape) => void,
  lassoMode: LassoMode,
  onLassoMode: (m: LassoMode) => void,
  triangleApex: number,
  onTriangleApex: (v: number) => void,
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean },
  onWand: (patch: Partial<{ tolerance: number; contiguous: boolean; sampleAll: boolean }>) => void,
  quickSelect: QuickSelectSettings,
  onQuickSelect: (patch: Partial<QuickSelectSettings>) => void,
  bucket: { tolerance: number; opacity: number; contiguous: boolean; antialias: boolean },
  onBucket: (patch: Partial<{ tolerance: number; opacity: number; contiguous: boolean; antialias: boolean }>) => void,
  gradient: GradientSettings,
  onGradient: (patch: Partial<GradientSettings>) => void,
  pen: PenSettings,
  onPen: (patch: Partial<PenSettings>) => void,
  eyedropper: { size: string; scope: string },
  onEyedropper: (patch: { size?: string; scope?: string }) => void,
  shapeProps: ShapeProps,
  cropProps: CropProps,
  blurProps: BlurProps,
  smudgeProps: SmudgeProps,
  spongeProps: SpongeProps,
  historyBrushProps: HistoryBrushProps,
  healProps: HealProps,
  redEyeProps: RedEyeProps,
  cloneProps: CloneProps,
  textProps: TextProps,
  dodgeProps: DodgeProps,
  measure: MeasureLine | null,
  onMeasureClear: () => void,
  onStraighten: () => void,
) {
  const set = (patch: Partial<BrushSettings>) => onBrush({ ...brush, ...patch });
  switch (tool) {
    case "pencil":
      // Pencil: hard-edged & pixel-perfect, so no hardness / flow / smoothing.
      return (
        <>
          <Slider label="Size" min={1} max={500} unit="px" value={brush.size} onChange={(n) => set({ size: n })} />
          <Slider label="Opacity" unit="%" value={brush.opacity} onChange={(n) => set({ opacity: n })} />
          {/* Pencil has no flow — only the tip width can follow the pen. */}
          <PressureControl brush={brush} onBrush={onBrush} showFlow={false} />
          <Divider />
          <Select
            label="Blend"
            options={["Normal", "Multiply", "Screen", "Overlay", "Soft Light", "Color"]}
            width={120}
            value={brush.blend}
            onChange={(s) => set({ blend: s })}
          />
          <Divider />
          <ColorChip color={foreground} onChange={onForeground} label="Pencil color" />
        </>
      );

    case "brush":
    case "eraser":
      return (
        <>
          <BrushPresetSelect brush={brush} onBrush={onBrush} />
          <Divider />
          <Slider label="Size" min={1} max={500} unit="px" value={brush.size} onChange={(n) => set({ size: n })} />
          <Slider label="Hardness" unit="%" value={brush.hardness} onChange={(n) => set({ hardness: n })} />
          <Slider label="Opacity" unit="%" value={brush.opacity} onChange={(n) => set({ opacity: n })} />
          <Slider label="Flow" unit="%" value={brush.flow} onChange={(n) => set({ flow: n })} />
          <PressureControl brush={brush} onBrush={onBrush} showFlow />
          {tool !== "eraser" && (
            <>
              <Divider />
              <Select
                label="Blend"
                options={["Normal", "Multiply", "Screen", "Overlay", "Soft Light", "Color"]}
                width={120}
                value={brush.blend}
                onChange={(s) => set({ blend: s })}
              />
            </>
          )}
          <Divider />
          <Slider
            label="Smoothing"
            unit="%"
            compact
            value={brush.smoothing}
            onChange={(n) => set({ smoothing: n })}
          />
          {tool !== "eraser" && (
            <>
              <Divider />
              <ColorChip color={foreground} onChange={onForeground} label="Brush color" />
            </>
          )}
        </>
      );

    case "history": {
      const { historyBrush, onHistoryBrush } = historyBrushProps;
      const hset = (patch: Partial<BrushSettings>) => onHistoryBrush({ ...historyBrush, ...patch });
      return (
        <>
          <Slider label="Size" min={1} max={500} unit="px" value={historyBrush.size} onChange={(n) => hset({ size: n })} />
          <Slider label="Hardness" unit="%" value={historyBrush.hardness} onChange={(n) => hset({ hardness: n })} />
          <Slider label="Opacity" unit="%" value={historyBrush.opacity} onChange={(n) => hset({ opacity: n })} />
          <Slider label="Flow" unit="%" value={historyBrush.flow} onChange={(n) => hset({ flow: n })} />
          <Divider />
          <Slider
            label="Smoothing"
            unit="%"
            compact
            value={historyBrush.smoothing}
            onChange={(n) => hset({ smoothing: n })}
          />
          <Divider />
          <span className={styles.muted}>Paints from the history source — set it in the History panel.</span>
        </>
      );
    }

    case "text": {
      const { text, onText } = textProps;
      return (
        <>
          <Select
            label="Font"
            options={FONT_FAMILIES}
            value={text.fontFamily}
            onChange={(f) => onText({ fontFamily: f })}
            width={150}
          />
          <NumberField
            label="Size"
            value={text.fontSize}
            min={1}
            max={2000}
            onChange={(n) => onText({ fontSize: n })}
            unit="px"
            width={64}
          />
          <Divider />
          <div className={styles.fmtGroup}>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.bold}
              title="Bold (Ctrl+B)"
              onClick={() => onText({ bold: !text.bold })}
            >
              <Bold size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.italic}
              title="Italic (Ctrl+I)"
              onClick={() => onText({ italic: !text.italic })}
            >
              <Italic size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.underline}
              title="Underline (Ctrl+U)"
              onClick={() => onText({ underline: !text.underline })}
            >
              <Underline size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.strike}
              title="Strikethrough"
              onClick={() => onText({ strike: !text.strike })}
            >
              <Strikethrough size={14} />
            </button>
          </div>
          <Segmented
            value={text.align}
            onChange={(v) => onText({ align: v as TextAlign })}
            options={[
              { value: "left", icon: <AlignLeft size={14} />, title: "Align left" },
              { value: "center", icon: <AlignCenter size={14} />, title: "Align center" },
              { value: "right", icon: <AlignRight size={14} />, title: "Align right" },
              { value: "justify", icon: <AlignJustify size={14} />, title: "Justify" },
            ]}
          />
          <Divider />
          <NumberField
            label="Tracking"
            value={text.tracking}
            min={-200}
            max={800}
            onChange={(n) => onText({ tracking: n })}
            width={58}
          />
          <Slider
            label="Leading"
            min={50}
            max={300}
            unit="%"
            value={Math.round(text.lineHeight * 100)}
            onChange={(n) => onText({ lineHeight: n / 100 })}
          />
          <Divider />
          <ColorChip color={text.color} onChange={(c) => onText({ color: c })} label="Text color" />
          <Toggle
            label="Anti-alias"
            checked={text.antialias}
            onChange={(v) => onText({ antialias: v })}
          />
          <Divider />
          <OpenTypeControl text={text} onText={onText} />
          <TextFillControl text={text} onText={onText} />
          <WarpControl text={text} onText={onText} />
        </>
      );
    }

    case "shape": {
      const { shape, onShape, fill, onFill, stroke, onStroke } = shapeProps;
      return (
        <>
          <Segmented
            value={shape.kind}
            onChange={(v) => onShape({ kind: v as ShapeKind })}
            options={[
              { value: "rect", icon: <Square size={14} />, title: "Rectangle" },
              { value: "ellipse", icon: <Circle size={14} />, title: "Ellipse" },
              { value: "tri", icon: <Triangle size={14} />, title: "Triangle" },
              {
                value: "trapezoid",
                icon: (
                  <svg
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                  >
                    <path d="M7 6h10l4 12H3z" />
                  </svg>
                ),
                title: "Trapezoid",
              },
            ]}
          />
          <Divider />
          <ColorChip color={fill} onChange={onFill} label="Fill" />
          <ColorChip color={stroke} onChange={onStroke} label="Stroke" />
          <Slider
            label="Stroke W"
            min={0}
            max={60}
            unit="px"
            compact
            value={shape.strokeWidth}
            onChange={(n) => onShape({ strokeWidth: n })}
          />
          {shape.kind !== "ellipse" && (
            <>
              <Divider />
              <Slider
                label="Radius"
                min={0}
                max={200}
                unit="px"
                compact
                value={shape.radius}
                onChange={(n) => onShape({ radius: n })}
              />
            </>
          )}
        </>
      );
    }

    case "crop": {
      const { crop, onCrop, cropBox, onCropBox, onCropApply, onCropReset, docWidth, docHeight } =
        cropProps;
      const box = cropBox ?? { x: 0, y: 0, w: docWidth, h: docHeight };

      const RATIO_OPTS = [
        { id: "free", label: "Free" },
        { id: "original", label: "Original" },
        ...CROP_RATIOS.map((r) => ({ id: r.id, label: r.label })),
        { id: "custom", label: "Custom" },
      ];
      const curRatioLabel = RATIO_OPTS.find((r) => r.id === crop.ratio)?.label ?? "Free";

      const aspectOf = (id: string): number | null => {
        if (id === "free") return null;
        if (id === "original") return docHeight ? docWidth / docHeight : null;
        if (id === "custom")
          return crop.customW > 0 && crop.customH > 0 ? crop.customW / crop.customH : null;
        const p = CROP_RATIOS.find((r) => r.id === id);
        return p ? p.w / p.h : null;
      };
      const aspect = aspectOf(crop.ratio);

      // Reshape a box to a given aspect ratio, keeping its centre and fitting the
      // canvas; used when a ratio is picked or the orientation is swapped.
      const reshape = (b: Rect, a: number): Rect => {
        let w = b.w;
        let h = b.h;
        if (w / h > a) w = h * a;
        else h = w / a;
        if (w > docWidth) {
          w = docWidth;
          h = w / a;
        }
        if (h > docHeight) {
          h = docHeight;
          w = h * a;
        }
        w = Math.round(w);
        h = Math.round(h);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const x = Math.max(0, Math.min(docWidth - w, Math.round(cx - w / 2)));
        const y = Math.max(0, Math.min(docHeight - h, Math.round(cy - h / 2)));
        return { x, y, w, h };
      };

      const pickRatio = (label: string) => {
        const id = RATIO_OPTS.find((r) => r.label === label)?.id ?? "free";
        onCrop({ ratio: id });
        const a = aspectOf(id);
        if (cropBox && a) onCropBox(reshape(cropBox, a));
      };

      // Resize the box from a W/H field, holding the locked ratio (if any) and the
      // box's top-left corner, clamped to the canvas.
      const setW = (w: number) => {
        if (!cropBox) return;
        let nw = Math.max(1, Math.min(docWidth - cropBox.x, w));
        let nh = aspect ? Math.round(nw / aspect) : cropBox.h;
        if (cropBox.y + nh > docHeight) {
          nh = docHeight - cropBox.y;
          if (aspect) nw = Math.round(nh * aspect);
        }
        onCropBox({ ...cropBox, w: nw, h: nh });
      };
      const setH = (h: number) => {
        if (!cropBox) return;
        let nh = Math.max(1, Math.min(docHeight - cropBox.y, h));
        let nw = aspect ? Math.round(nh * aspect) : cropBox.w;
        if (cropBox.x + nw > docWidth) {
          nw = docWidth - cropBox.x;
          if (aspect) nh = Math.round(nw / aspect);
        }
        onCropBox({ ...cropBox, w: nw, h: nh });
      };
      const setX = (x: number) => {
        if (!cropBox) return;
        onCropBox({ ...cropBox, x: Math.max(0, Math.min(docWidth - cropBox.w, x)) });
      };
      const setY = (y: number) => {
        if (!cropBox) return;
        onCropBox({ ...cropBox, y: Math.max(0, Math.min(docHeight - cropBox.h, y)) });
      };

      const swapOrientation = () => {
        if (crop.ratio === "custom") {
          onCrop({ customW: crop.customH, customH: crop.customW });
        } else if (crop.ratio !== "free" && crop.ratio !== "original") {
          const p = CROP_RATIOS.find((r) => r.id === crop.ratio);
          if (p) {
            const inv = CROP_RATIOS.find((r) => r.w === p.h && r.h === p.w);
            if (inv) onCrop({ ratio: inv.id });
            else onCrop({ ratio: "custom", customW: p.h, customH: p.w });
          }
        }
        if (cropBox) {
          const cx = cropBox.x + cropBox.w / 2;
          const cy = cropBox.y + cropBox.h / 2;
          const w = Math.min(cropBox.h, docWidth);
          const h = Math.min(cropBox.w, docHeight);
          const x = Math.max(0, Math.min(docWidth - w, Math.round(cx - w / 2)));
          const y = Math.max(0, Math.min(docHeight - h, Math.round(cy - h / 2)));
          onCropBox({ x, y, w, h });
        }
      };

      const GRID_OPTS = [
        { id: "thirds", label: "Rule of Thirds" },
        { id: "grid", label: "Grid" },
        { id: "diagonal", label: "Diagonal" },
        { id: "golden", label: "Golden ratio" },
        { id: "none", label: "None" },
      ];
      const curGridLabel = GRID_OPTS.find((g) => g.id === crop.grid)?.label ?? "Rule of Thirds";

      return (
        <>
          <Toggle
            label="Perspective"
            checked={crop.perspective}
            onChange={(v) => onCrop({ perspective: v })}
          />
          <Divider />
          {crop.perspective ? (
            <span className={styles.muted}>
              Drag the corners over a skewed subject — Apply resamples it to a rectangle.
            </span>
          ) : (
            <>
              <Select
                label="Ratio"
                options={RATIO_OPTS.map((r) => r.label)}
                value={curRatioLabel}
                onChange={pickRatio}
                width={140}
              />
              {crop.ratio === "custom" && (
                <>
                  <NumberField
                    value={crop.customW}
                    min={1}
                    max={9999}
                    onChange={(n) => {
                      onCrop({ customW: n });
                      if (cropBox) onCropBox(reshape(cropBox, n / Math.max(1, crop.customH)));
                    }}
                    width={52}
                  />
                  <span className={styles.muted}>:</span>
                  <NumberField
                    value={crop.customH}
                    min={1}
                    max={9999}
                    onChange={(n) => {
                      onCrop({ customH: n });
                      if (cropBox) onCropBox(reshape(cropBox, Math.max(1, crop.customW) / n));
                    }}
                    width={52}
                  />
                </>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                title="Swap orientation"
                onClick={swapOrientation}
              >
                <ArrowLeftRight size={15} />
              </button>
              <Divider />
              <NumberField label="W" value={Math.round(box.w)} min={1} onChange={setW} unit="px" width={74} />
              <NumberField label="H" value={Math.round(box.h)} min={1} onChange={setH} unit="px" width={74} />
              <NumberField label="X" value={Math.round(box.x)} min={0} onChange={setX} unit="px" width={70} />
              <NumberField label="Y" value={Math.round(box.y)} min={0} onChange={setY} unit="px" width={70} />
              <Divider />
              <Slider
                label="Straighten"
                min={-45}
                max={45}
                value={crop.straighten}
                onChange={(n) => onCrop({ straighten: n })}
                unit="°"
              />
            </>
          )}
          <Select
            label="Overlay"
            options={GRID_OPTS.map((g) => g.label)}
            value={curGridLabel}
            onChange={(l) => onCrop({ grid: (GRID_OPTS.find((g) => g.label === l)?.id ?? "thirds") as CropSettings["grid"] })}
            width={150}
          />
          <Slider
            label="Shield"
            min={0}
            max={90}
            value={crop.shield}
            onChange={(n) => onCrop({ shield: n })}
            unit="%"
          />
          <Divider />
          <button type="button" className={styles.preset} onClick={onCropReset}>
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            type="button"
            className={`${styles.preset} ${styles.apply}`}
            onClick={onCropApply}
            title="Apply crop (Enter)"
          >
            <Check size={14} />
            Apply
          </button>
        </>
      );
    }

    case "select":
    case "lasso":
    case "wand":
      return (
        <>
          {tool === "lasso" && (
            <>
              <Segmented
                label="Mode"
                value={lassoMode}
                onChange={(v) => onLassoMode(v as LassoMode)}
                options={[
                  { value: "free", icon: <LassoIcon size={14} />, title: "Freehand lasso (drag)" },
                  { value: "poly", icon: <Hexagon size={14} />, title: "Polygonal lasso — click points; Enter/double-click closes" },
                  { value: "magnetic", icon: <Magnet size={14} />, title: "Magnetic lasso — drag along an edge, points snap to it" },
                ]}
              />
              <Divider />
            </>
          )}
          {tool === "select" && (
            <>
              <Segmented
                label="Shape"
                value={marqueeShape}
                onChange={(v) => onMarqueeShape(v as MarqueeShape)}
                options={[
                  { value: "rect", icon: <Square size={14} />, title: "Rectangular marquee" },
                  { value: "ellipse", icon: <Circle size={14} />, title: "Elliptical marquee" },
                  { value: "triangle", icon: <Triangle size={14} />, title: "Triangular marquee" },
                ]}
              />
              {marqueeShape === "triangle" && (
                <Slider
                  label="Apex"
                  min={0}
                  max={100}
                  unit="%"
                  value={Math.round(triangleApex * 100)}
                  onChange={(v) => onTriangleApex(v / 100)}
                />
              )}
              <Divider />
            </>
          )}
          <Segmented
            options={[
              { value: "new", text: "New" },
              { value: "add", icon: <Plus size={13} />, title: "Add to selection" },
              { value: "sub", icon: <Minus size={13} />, title: "Subtract" },
            ]}
          />
          {(tool === "select" || tool === "wand") && (
            <>
              <Divider />
              <Segmented
                label="Resize"
                value={resizeMode}
                onChange={(v) => onResizeMode(v as SelectResizeMode)}
                options={[
                  {
                    value: "bounds",
                    icon: <Square size={14} />,
                    text: "Bounds",
                    title: "Resize the selection outline only",
                  },
                  {
                    value: "content",
                    icon: <ImageIcon size={14} />,
                    text: "Content",
                    title: "Scale the pixels inside the selection too",
                  },
                ]}
              />
              {resizeMode === "content" && (
                <Toggle
                  label="Smooth"
                  checked={resizeSmooth}
                  onChange={onResizeSmooth}
                />
              )}
            </>
          )}
          {tool === "wand" ? (
            <>
              <Divider />
              <Slider
                label="Tolerance"
                min={0}
                max={255}
                value={wand.tolerance}
                onChange={(n) => onWand({ tolerance: n })}
              />
              <Toggle
                label="Contiguous"
                checked={wand.contiguous}
                onChange={(v) => onWand({ contiguous: v })}
              />
              <Toggle
                label="Sample all layers"
                checked={wand.sampleAll}
                onChange={(v) => onWand({ sampleAll: v })}
              />
            </>
          ) : (
            <>
              <Divider />
              <Slider label="Feather" min={0} max={250} defaultValue={0} unit="px" />
              <Toggle label="Anti-alias" defaultChecked />
            </>
          )}
        </>
      );

    case "gradient":
      return (
        <>
          <Segmented
            value={gradient.type}
            onChange={(v) => onGradient({ type: v as GradientType })}
            options={[
              { value: "linear", text: "Linear" },
              { value: "radial", text: "Radial" },
              { value: "angle", text: "Angle" },
              { value: "reflected", text: "Reflected" },
            ]}
          />
          <Divider />
          <GradientControl
            gradient={gradient}
            onGradient={onGradient}
            fg={shapeProps.fill}
            bg={shapeProps.stroke}
          />
          <Divider />
          <Toggle
            label="Reverse"
            checked={gradient.reverse}
            onChange={(v) => onGradient({ reverse: v })}
          />
          {gradient.type === "angle" && (
            <Toggle
              label="Smooth"
              checked={gradient.smooth}
              onChange={(v) => onGradient({ smooth: v })}
            />
          )}
        </>
      );

    case "pen":
      return (
        <>
          <ColorChip color={foreground} onChange={onForeground} label="Stroke" />
          <Divider />
          <Slider
            label="Width"
            min={1}
            max={200}
            unit="px"
            compact
            value={pen.width}
            onChange={(n) => onPen({ width: n })}
          />
          <Slider
            label="Taper"
            min={0}
            max={100}
            unit="%"
            compact
            value={Math.round(pen.taper * 100)}
            onChange={(n) => onPen({ taper: n / 100 })}
          />
          <Slider
            label="Bend"
            min={-100}
            max={100}
            unit="%"
            compact
            value={Math.round(pen.bend * 100)}
            onChange={(n) => onPen({ bend: n / 100 })}
          />
          <Divider />
          <span className={styles.penHint}>
            Click to add points, drag to curve. Click the first point or press Enter to finish.
          </span>
        </>
      );

    case "bucket":
      return (
        <>
          <ColorChip color={foreground} onChange={onForeground} label="Fill color" />
          <Divider />
          <Slider
            label="Tolerance"
            min={0}
            max={255}
            value={bucket.tolerance}
            onChange={(n) => onBucket({ tolerance: n })}
          />
          <Slider
            label="Opacity"
            unit="%"
            value={bucket.opacity}
            onChange={(n) => onBucket({ opacity: n })}
          />
          <Toggle
            label="Contiguous"
            checked={bucket.contiguous}
            onChange={(v) => onBucket({ contiguous: v })}
          />
          <Toggle
            label="Anti-alias"
            checked={bucket.antialias}
            onChange={(v) => onBucket({ antialias: v })}
          />
        </>
      );

    case "clone":
    case "clone": {
      const { clone, onClone } = cloneProps;
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={clone.size}
            onChange={(n) => onClone({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={clone.hardness}
            onChange={(n) => onClone({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Opacity"
            unit="%"
            value={clone.opacity}
            onChange={(n) => onClone({ opacity: n })}
          />
          <Slider
            label="Flow"
            unit="%"
            value={clone.flow}
            onChange={(n) => onClone({ flow: n })}
          />
          <Divider />
          <Select
            label="Sample"
            options={["Current layer", "All layers"]}
            value={clone.sampleAll ? "All layers" : "Current layer"}
            onChange={(l) => onClone({ sampleAll: l === "All layers" })}
            width={140}
          />
          <Toggle
            label="Aligned"
            checked={clone.aligned}
            onChange={(v) => onClone({ aligned: v })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={clone.spacing}
            onChange={(n) => onClone({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={clone.smoothing}
            onChange={(n) => onClone({ smoothing: n })}
          />
        </>
      );
    }

    case "heal": {
      const { heal, onHeal } = healProps;
      return (
        <>
          <Slider
            label="Size"
            min={4}
            max={300}
            unit="px"
            value={heal.size}
            onChange={(n) => onHeal({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={heal.hardness}
            onChange={(n) => onHeal({ hardness: n })}
          />
          <Divider />
          <span className={styles.muted}>Paint over a blemish — it heals when you release.</span>
        </>
      );
    }

    case "redeye": {
      const { redEye, onRedEye } = redEyeProps;
      return (
        <>
          <Slider
            label="Size"
            min={6}
            max={200}
            unit="px"
            value={redEye.size}
            onChange={(n) => onRedEye({ size: n })}
          />
          <Slider
            label="Darken"
            unit="%"
            value={redEye.darken}
            onChange={(n) => onRedEye({ darken: n })}
          />
          <Divider />
          <span className={styles.muted}>Click a red pupil — the ring should cover the eye.</span>
        </>
      );
    }

    case "blur": {
      const { blur, onBlur } = blurProps;
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={blur.size}
            onChange={(n) => onBlur({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={blur.hardness}
            onChange={(n) => onBlur({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Strength"
            unit="%"
            value={blur.strength}
            onChange={(n) => onBlur({ strength: n })}
          />
          <Slider
            label="Radius"
            min={1}
            max={100}
            unit="px"
            value={blur.radius}
            onChange={(n) => onBlur({ radius: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={blur.spacing}
            onChange={(n) => onBlur({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={blur.smoothing}
            onChange={(n) => onBlur({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Sample all layers"
            checked={blur.sampleAll}
            onChange={(v) => onBlur({ sampleAll: v })}
          />
        </>
      );
    }

    case "smudge": {
      const { smudge, onSmudge } = smudgeProps;
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={smudge.size}
            onChange={(n) => onSmudge({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={smudge.hardness}
            onChange={(n) => onSmudge({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Strength"
            unit="%"
            value={smudge.strength}
            onChange={(n) => onSmudge({ strength: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={smudge.spacing}
            onChange={(n) => onSmudge({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={smudge.smoothing}
            onChange={(n) => onSmudge({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Sample all layers"
            checked={smudge.sampleAll}
            onChange={(v) => onSmudge({ sampleAll: v })}
          />
          <Toggle
            label="Finger painting"
            checked={smudge.fingerPaint}
            onChange={(v) => onSmudge({ fingerPaint: v })}
          />
        </>
      );
    }

    case "dodge": {
      const { dodge, onDodge } = dodgeProps;
      const RANGE_OPTS = [
        { id: "shadows", label: "Shadows" },
        { id: "midtones", label: "Midtones" },
        { id: "highlights", label: "Highlights" },
      ];
      const rangeLabel = RANGE_OPTS.find((r) => r.id === dodge.range)?.label ?? "Midtones";
      return (
        <>
          <Segmented
            label="Mode"
            value={dodge.mode}
            onChange={(v) => onDodge({ mode: v as DodgeMode })}
            options={[
              { value: "dodge", text: "Dodge" },
              { value: "burn", text: "Burn" },
            ]}
          />
          <Select
            label="Range"
            options={RANGE_OPTS.map((r) => r.label)}
            value={rangeLabel}
            onChange={(l) =>
              onDodge({ range: (RANGE_OPTS.find((r) => r.label === l)?.id ?? "midtones") as DodgeRange })
            }
            width={120}
          />
          <Slider
            label="Exposure"
            unit="%"
            value={dodge.exposure}
            onChange={(n) => onDodge({ exposure: n })}
          />
          <Divider />
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={dodge.size}
            onChange={(n) => onDodge({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={dodge.hardness}
            onChange={(n) => onDodge({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={dodge.spacing}
            onChange={(n) => onDodge({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={dodge.smoothing}
            onChange={(n) => onDodge({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Protect tones"
            checked={dodge.protect}
            onChange={(v) => onDodge({ protect: v })}
          />
        </>
      );
    }

    case "sponge": {
      const { sponge, onSponge } = spongeProps;
      return (
        <>
          <Segmented
            label="Mode"
            value={sponge.mode}
            onChange={(v) => onSponge({ mode: v as SpongeMode })}
            options={[
              { value: "saturate", text: "Saturate" },
              { value: "desaturate", text: "Desaturate" },
            ]}
          />
          <Slider
            label="Flow"
            unit="%"
            value={sponge.flow}
            onChange={(n) => onSponge({ flow: n })}
          />
          <Divider />
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={sponge.size}
            onChange={(n) => onSponge({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={sponge.hardness}
            onChange={(n) => onSponge({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={sponge.spacing}
            onChange={(n) => onSponge({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={sponge.smoothing}
            onChange={(n) => onSponge({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Vibrance"
            checked={sponge.vibrance}
            onChange={(v) => onSponge({ vibrance: v })}
          />
        </>
      );
    }

    case "zoom":
      return (
        <>
          <Segmented
            defaultValue="in"
            options={[
              { value: "in", icon: <Plus size={13} />, title: "Zoom in" },
              { value: "out", icon: <Minus size={13} />, title: "Zoom out" },
            ]}
          />
          <Divider />
          {["25%", "50%", "100%", "200%", "Fit"].map((z) => (
            <button key={z} type="button" className={styles.preset}>
              {z}
            </button>
          ))}
        </>
      );

    case "eyedropper":
      return (
        <>
          <Select
            label="Sample size"
            options={SAMPLE_SIZE_OPTIONS}
            width={150}
            value={eyedropper.size}
            onChange={(v) => onEyedropper({ size: v })}
          />
          <Divider />
          <Select
            label="Sample"
            options={SAMPLE_SCOPE_OPTIONS}
            width={130}
            value={eyedropper.scope}
            onChange={(v) => onEyedropper({ scope: v })}
          />
        </>
      );

    case "measure": {
      const info = measure ? measureInfo(measure) : null;
      return info ? (
        <>
          <div className={styles.measureReadout}>
            <span>A</span>
            <b>{info.angle.toFixed(1)}°</b>
            <span>L</span>
            <b>{Math.round(info.length)} px</b>
            <span>W</span>
            <b>{Math.round(info.dx)}</b>
            <span>H</span>
            <b>{Math.round(info.dy)}</b>
          </div>
          <Divider />
          <button
            type="button"
            className={styles.preset}
            onClick={onStraighten}
            title="Rotate the image so the measured line is level (opens the Crop tool)"
          >
            <Ruler size={14} /> Straighten
          </button>
          <button
            type="button"
            className={styles.preset}
            onClick={onMeasureClear}
            title="Clear the measurement"
          >
            <X size={14} /> Clear
          </button>
        </>
      ) : (
        <span className={styles.muted}>Drag a line on the canvas to measure distance &amp; angle.</span>
      );
    }

    case "quickselect":
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            value={quickSelect.size}
            onChange={(n) => onQuickSelect({ size: n })}
            unit="px"
          />
          <Divider />
          <Slider
            label="Tolerance"
            min={1}
            max={100}
            value={quickSelect.tolerance}
            onChange={(n) => onQuickSelect({ tolerance: n })}
          />
          <Divider />
          <Toggle
            label="Sample all layers"
            checked={quickSelect.sampleAll}
            onChange={(v) => onQuickSelect({ sampleAll: v })}
          />
          <Divider />
          <span className={styles.muted}>
            Brush over a region — it grows to the edges. Alt-drag to subtract.
          </span>
        </>
      );

    case "move":
      return (
        <>
          <Segmented
            label="Move"
            value={moveMode}
            onChange={(v) => onMoveMode(v as MoveMode)}
            options={[
              { value: "pixels", icon: <ImageIcon size={14} />, text: "Pixels", title: "Move pixels" },
              {
                value: "selection",
                icon: <MousePointer2 size={14} />,
                text: "Selection",
                title: "Move selection outline only",
              },
            ]}
          />
          <Divider />
          <Toggle label="Auto-select" defaultChecked />
          <Select label="Scope" options={["Layer", "Group"]} width={100} />
          <Toggle label="Show transform controls" defaultChecked />
          <Toggle label="Snap" defaultChecked />
          <Divider />
          <span className={styles.muted}>Align</span>
          <Segmented
            options={[
              { value: "l", icon: <AlignLeft size={14} />, title: "Align left edges" },
              {
                value: "hc",
                icon: <AlignHorizontalJustifyCenter size={14} />,
                title: "Align horizontal centers",
              },
              { value: "r", icon: <AlignRight size={14} />, title: "Align right edges" },
              { value: "t", icon: <AlignCenter size={14} />, title: "Align top edges" },
              {
                value: "vc",
                icon: <AlignVerticalJustifyCenter size={14} />,
                title: "Align vertical centers",
              },
            ]}
          />
        </>
      );

    default:
      return (
        <>
          <span className={styles.muted}>
            Select a tool to see its options here.
          </span>
          <button type="button" className={styles.preset}>
            <RotateCcw size={13} /> Reset
          </button>
        </>
      );
  }
}
