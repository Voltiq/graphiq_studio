"use client";

import { useEffect, useRef, useState } from "react";
import {
  Blend as BlendIcon,
  Check,
  Download,
  Gem,
  Layers2,
  PaintBucket,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  SquareDot,
  Sun,
  SunDim,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import styles from "./LayerStyleDialog.module.scss";
import BlendIfControl from "./BlendIfControl";
import type { BlendIf } from "../lib/blendif";
import { KNOCKOUT_MODES, fillOpacityOf, knockoutOf, type KnockoutMode } from "../lib/knockout";
import {
  DEFAULT_GLOBAL_LIGHT,
  lightFromEffect,
  resolveGlobalLight,
  type GlobalLight,
  type LitKey,
} from "../lib/global-light";
import {
  BUILTIN_STYLES,
  STYLE_EXT,
  STYLE_PRESETS_KEY,
  exportStyles,
  importStyleFiles,
  isBuiltinStyle,
  loadSavedStyles,
  mergeStyles,
  persistSavedStyles,
  styleFromLayer,
  styleToPatch,
  type LayerStylePreset,
} from "../lib/styleio";
import { ColorChip, Segmented, Select, Slider, Toggle } from "./Controls";
import { GradientEditor } from "./GradientControl";
import { parseColor, toHex6 } from "../lib/color";
import { GRADIENT_PRESETS_KEY } from "../lib/gradientio";
import { BLEND_MODES } from "../lib/layers";
import {
  DEFAULT_FX,
  FX_LABELS,
  FX_ORDER,
  renderStyled,
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

/* ------------------------------ Style presets ----------------------------- */

// Thumbnails are rendered by the real effects pipeline rather than drawn as
// little pictures, so what the tile shows is what the layer will get. Rendered
// at 2× and shown at half size: effect sizes are absolute px, and halving them
// keeps a 20px shadow inside a 62px tile without needing per-preset fudging.
const THUMB_W = 62;
const THUMB_H = 46;
const THUMB_SS = 2;

/** The tile's own ground and shape — fixed, not theme-derived, so a style looks
 *  the same in the picker as it will on the canvas regardless of UI theme. */
const THUMB_GROUND = "#6f7580";
const THUMB_SHAPE = "#e7e9ec";

function StyleThumb({ preset, light }: { preset: LayerStylePreset; light: GlobalLight }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const out = ref.current;
    const octx = out?.getContext("2d");
    if (!out || !octx) return;
    const w = THUMB_W * THUMB_SS;
    const h = THUMB_H * THUMB_SS;

    // The layer being styled: a rounded slab, inset so the effects have room to
    // spill. renderStyled returns a buffer the same size as what it is handed,
    // so the padding has to be in the source.
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    const pad = 15 * THUMB_SS;
    sctx.fillStyle = THUMB_SHAPE;
    sctx.beginPath();
    sctx.roundRect(pad, pad * 0.75, w - pad * 2, h - pad * 1.5, 6 * THUMB_SS);
    sctx.fill();

    const fx = resolveGlobalLight(preset.effects ?? {}, light) ?? {};
    const { canvas } = renderStyled(src, fx, "srgb", fillOpacityOf(preset.fillOpacity) / 100);

    octx.clearRect(0, 0, w, h);
    octx.fillStyle = THUMB_GROUND;
    octx.fillRect(0, 0, w, h);
    octx.drawImage(canvas, 0, 0);
  }, [preset, light]);

  return (
    <canvas
      ref={ref}
      className={styles.thumbCanvas}
      width={THUMB_W * THUMB_SS}
      height={THUMB_H * THUMB_SS}
      style={{ width: THUMB_W, height: THUMB_H }}
    />
  );
}

/**
 * The preset library: apply a saved look to this layer, capture the current one,
 * and move styles between machines as `.gstyle` files.
 *
 * Deliberately the same shape as the gradient library — save / import / export
 * in the header, a grid of click-to-apply tiles, a delete affordance on the
 * user's own entries only.
 */
function StylePresets({
  current,
  light,
  onApply,
}: {
  current: LayerStylePreset;
  light: GlobalLight;
  onApply: (p: LayerStylePreset) => void;
}) {
  // Read straight into state rather than in an effect: the dialog is mounted by
  // a click, never server-rendered, so there is no first paint to mismatch.
  const [saved, setSaved] = useState<LayerStylePreset[]>(loadSavedStyles);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const persist = (list: LayerStylePreset[]) => {
    setSaved(list);
    persistSavedStyles(STYLE_PRESETS_KEY, list);
  };

  const startSave = () => {
    setNameDraft(`Style ${saved.length + 1}`);
    setNaming(true);
  };
  const confirmSave = () => {
    const name = nameDraft.trim();
    if (!name) return;
    persist([...saved, { ...current, id: styleFromLayer(name, current).id, name }]);
    setNaming(false);
  };

  const doImport = async () => {
    const imported = await importStyleFiles();
    if (imported.length) persist(mergeStyles(saved, imported));
  };
  const doExport = () => {
    if (saved.length) void exportStyles(saved);
  };

  const hasStyle = Object.entries(current.effects).some(
    ([k, v]) => k !== "scale" && (v as { enabled?: boolean })?.enabled,
  );

  return (
    <>
      <div className={styles.paneHead}>
        <span className={styles.paneTitle}>Styles</span>
        <div className={styles.paneActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={startSave}
            disabled={!hasStyle}
            title={hasStyle ? "Save this layer's style as a preset" : "This layer has no effects to save"}
            aria-label="Save current style"
          >
            <Save size={13} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={doImport}
            title={`Import styles (.${STYLE_EXT})`}
            aria-label="Import styles"
          >
            <Upload size={13} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={!saved.length}
            onClick={doExport}
            title={saved.length ? `Export saved styles (.${STYLE_EXT})` : "No saved styles to export"}
            aria-label="Export styles"
          >
            <Download size={13} />
          </button>
        </div>
      </div>
      <p className={styles.paneDesc}>
        A preset carries every effect plus fill opacity, knockout and Blend If — clicking one
        replaces this layer&apos;s whole style.
      </p>

      <div className={styles.paneBody}>
        {naming && (
          <div className={styles.nameRow}>
            <StyleThumb preset={current} light={light} />
            <input
              className={styles.nameInput}
              autoFocus
              value={nameDraft}
              placeholder="Style name"
              // Escape here cancels naming rather than closing the dialog; the
              // dialog's window-level handler defers to this flag.
              data-esc-local="1"
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
                else if (e.key === "Escape") setNaming(false);
              }}
            />
            <button
              type="button"
              className={styles.iconBtn}
              onClick={confirmSave}
              disabled={!nameDraft.trim()}
              aria-label="Confirm save"
            >
              <Check size={14} />
            </button>
            <button type="button" className={styles.iconBtn} onClick={() => setNaming(false)} aria-label="Cancel save">
              <X size={14} />
            </button>
          </div>
        )}

        <div className={styles.styleGrid}>
          {[...BUILTIN_STYLES, ...saved].map((p) => (
            <div key={p.id} className={styles.styleCell}>
              <button
                type="button"
                className={styles.styleTile}
                onClick={() => onApply(p)}
                title={`Apply ${p.name}`}
                aria-label={`Apply ${p.name}`}
              >
                <StyleThumb preset={p} light={light} />
              </button>
              <span className={styles.styleName} title={p.name}>
                {p.name}
              </span>
              {!isBuiltinStyle(p.id) && (
                <span
                  className={styles.styleDel}
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete ${p.name}`}
                  onClick={() => persist(saved.filter((x) => x.id !== p.id))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") persist(saved.filter((x) => x.id !== p.id));
                  }}
                >
                  <X size={9} />
                </span>
              )}
            </div>
          ))}
          <button
            type="button"
            className={styles.addStyle}
            onClick={startSave}
            disabled={!hasStyle}
            title="Save this layer's style as a preset"
            aria-label="Save current style as preset"
          >
            <Plus size={16} />
          </button>
        </div>
        <p className={styles.hint}>
          Saved styles live in this browser. Export them to a .{STYLE_EXT} file to keep them or share
          them; importing adds to the library rather than replacing it.
        </p>
      </div>
    </>
  );
}

export default function LayerStyleDialog({
  effects,
  layerName,
  blendIf,
  onBlendIf,
  fillOpacity,
  knockout,
  globalLight,
  onGlobalLight,
  onBlending,
  gradientStorageKey = GRADIENT_PRESETS_KEY,
  onApplyPreset,
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
  /** Document-level lighting angle; effects can follow it instead of their own. */
  globalLight?: GlobalLight;
  onGlobalLight?: (l: GlobalLight) => void;
  onBlending?: (patch: { fillOpacity?: number; knockout?: KnockoutMode }) => void;
  /** Preset bucket for the gradient overlay's editor (shared with the
      Gradient tool unless the "share saved gradients" preference is off). */
  gradientStorageKey?: string;
  /** Apply a whole saved style (effects + blending) as ONE history step. */
  onApplyPreset?: (p: LayerStylePreset) => void;
  onChange: (effects: LayerEffects) => void;
  onToggle: (key: FxKey, enabled: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const fx = effects ?? {};
  const firstOn = FX_ORDER.find((k) => fx[k]?.enabled) ?? "dropShadow";
  const [sel, setSel] = useState<FxKey>(firstOn);
  // The preset library is a pane rather than a strip: it needs the room, and it
  // is a whole-layer operation, so it does not belong beside one effect's knobs.
  const [showStyles, setShowStyles] = useState(false);
  const selOn = !!fx[sel]?.enabled;
  const onCount = FX_ORDER.filter((k) => fx[k]?.enabled).length;
  const light = globalLight ?? DEFAULT_GLOBAL_LIGHT;

  /**
   * Applying a preset REPLACES the style — effects and blending together, so the
   * layer ends up looking like the tile that was clicked with nothing of the
   * previous style surviving underneath.
   *
   * The parent does it in one go when it can. The fallback path exists for hosts
   * that only wire `onChange`, but it is genuinely worse: `onBlending` and
   * `onBlendIf` are live doc patches rather than history steps, so an undo would
   * take the effects back and leave the blending behind.
   */
  const applyPreset = (p: LayerStylePreset) => {
    if (onApplyPreset) {
      onApplyPreset(p);
      return;
    }
    const patch = styleToPatch(p);
    onChange(patch.effects);
    onBlending?.({ fillOpacity: fillOpacityOf(patch.fillOpacity), knockout: knockoutOf(patch.knockout) });
    onBlendIf?.(patch.blendIf);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A field that handles its own Escape (the style-name input) gets it
        // first — this listener is on WINDOW in capture phase, so it would
        // otherwise close the whole dialog before the field ever saw the key,
        // and stopPropagation down in the field cannot prevent that.
        if ((e.target as HTMLElement | null)?.dataset?.escLocal === "1") return;
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
                <Slider
                  label="Angle"
                  min={0}
                  max={360}
                  unit="°"
                  value={s.useGlobalLight && globalLight ? globalLight.angle : s.angle}
                  onChange={(v) =>
                    // Following the light means the slider steers the DOCUMENT,
                    // not this one effect — that is the whole point of it.
                    s.useGlobalLight && onGlobalLight && globalLight
                      ? onGlobalLight(lightFromEffect(globalLight, sel as LitKey, { angle: v }))
                      : set(sel, { angle: v })
                  }
                />
                <Slider label="Distance" min={0} max={250} unit="px" value={s.distance} onChange={(v) => set(sel, { distance: v })} />
                <Slider label="Spread" min={0} max={100} unit="%" value={s.spread} onChange={(v) => set(sel, { spread: v })} />
                <Slider label="Size" min={0} max={250} unit="px" value={s.size} onChange={(v) => set(sel, { size: v })} />
              </Grid>
              {onGlobalLight && (
                <Toggle
                  label="Use global light"
                  checked={!!s.useGlobalLight}
                  onChange={(v) => set(sel, { useGlobalLight: v })}
                />
              )}
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
                <Slider
                  label="Angle"
                  min={0}
                  max={360}
                  unit="°"
                  value={b.useGlobalLight && globalLight ? globalLight.angle : b.angle}
                  onChange={(v) =>
                    b.useGlobalLight && onGlobalLight && globalLight
                      ? onGlobalLight(lightFromEffect(globalLight, "bevel", { angle: v }))
                      : set("bevel", { angle: v })
                  }
                />
                <Slider
                  label="Altitude"
                  min={0}
                  max={90}
                  unit="°"
                  value={b.useGlobalLight && globalLight ? globalLight.altitude : b.altitude}
                  onChange={(v) =>
                    b.useGlobalLight && onGlobalLight && globalLight
                      ? onGlobalLight(lightFromEffect(globalLight, "bevel", { altitude: v }))
                      : set("bevel", { altitude: v })
                  }
                />
              </Grid>
              {onGlobalLight && (
                <Toggle
                  label="Use global light"
                  checked={!!b.useGlobalLight}
                  onChange={(v) => set("bevel", { useGlobalLight: v })}
                />
              )}
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
            <div
              className={`${styles.fxRow} ${styles.stylesRow}`}
              data-sel={showStyles}
              data-on={true}
              role="option"
              aria-selected={showStyles}
              tabIndex={0}
              onClick={() => setShowStyles(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setShowStyles(true);
                }
              }}
            >
              <Sparkles size={14} className={styles.fxIcon} />
              <span className={styles.fxName}>Styles</span>
            </div>

            <span className={styles.listLabel}>Effects</span>
            {FX_ORDER.map((k) => {
              const on = !!fx[k]?.enabled;
              const Icon = FX_ICONS[k];
              return (
                <div
                  key={k}
                  className={styles.fxRow}
                  data-sel={!showStyles && sel === k}
                  data-on={on}
                  role="option"
                  aria-selected={!showStyles && sel === k}
                  tabIndex={0}
                  onClick={() => {
                    setSel(k);
                    setShowStyles(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSel(k);
                      setShowStyles(false);
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
            {showStyles ? (
              <StylePresets
                current={{ id: "current", name: layerName, effects: fx, fillOpacity, knockout, blendIf }}
                light={light}
                onApply={applyPreset}
              />
            ) : (
              <>
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
              </>
            )}
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
