"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Crosshair,
  Droplets,
  Focus,
  Contrast,
  Eraser,
  Grid3x3,
  Layers,
  Plus,
  Radio,
  ScanLine,
  Snowflake,
  Aperture,
  Boxes,
  Brush as BrushIcon,
  Sparkles,
  SprayCan,
  Sun,
  Zap,
  Trash2,
  Wand2,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import styles from "./LayerStyleDialog.module.scss";
import { ColorChip, Segmented, Select, Slider, Toggle } from "./Controls";
import { BLEND_MODES, type LayerGroup, type LayerLeaf } from "../lib/layers";
import { BLUR_FX_LABELS, type BlurFxKind } from "../lib/tools";
import {
  FILTER_LABELS,
  defaultFilter,
  filterLabel,
  type FilterType,
  type SmartFilter,
} from "../lib/filters";

const FILTER_ICONS: Record<FilterType, LucideIcon> = {
  blur: Droplets,
  sharpen: Focus,
  noise: Sparkles,
  pixelate: Grid3x3,
  distort: Waves,
  stylize: Wand2,
  highpass: ScanLine,
  median: Layers,
  dustscratches: Eraser,
  denoise: SprayCan,
  lens: Aperture,
  dehaze: Sun,
  clarity: Contrast,
  grain: Snowflake,
  oil: BrushIcon,
  halftone: Radio,
  crystallize: Boxes,
  glitch: Zap,
  canvasshadow: Droplets,
};

const TYPE_ORDER: FilterType[] = [
  "blur",
  "sharpen",
  "highpass",
  "denoise",
  "median",
  "dustscratches",
  "lens",
  "dehaze",
  "clarity",
  "grain",
  "oil",
  "halftone",
  "crystallize",
  "glitch",
  "canvasshadow",
  "noise",
  "pixelate",
  "distort",
  "stylize",
];

const FILTER_DESC: Record<FilterType, string> = {
  blur: "Any Blur Gallery blur, applied non-destructively.",
  sharpen: "Unsharp Mask — boosts local contrast along edges.",
  noise: "Adds film-like grain (uniform or gaussian).",
  pixelate: "Mosaic — averages the layer into square cells.",
  distort: "Twirl, pinch/bulge or wave displacement.",
  stylize: "Find Edges, Emboss, Posterize or Threshold.",
  highpass: "Keeps fine detail, flattens everything coarser to grey.",
  median: "Replaces each pixel with its neighbourhood median — kills speckle, keeps edges.",
  dustscratches: "Median, but only where a pixel disagrees with its surroundings.",
  denoise: "Edge-aware luma smoothing plus chroma cleanup for sensor noise.",
  lens: "Vignette, chromatic aberration and barrel/pincushion correction.",
  dehaze: "Cuts atmospheric haze using the dark-channel prior.",
  clarity: "Local contrast — broad shaping plus fine detail.",
  grain: "Film grain with clump size and uneven roughness.",
  oil: "Painterly flattening — modal colour of each neighbourhood.",
  halftone: "Printing screen: dots whose area tracks tone.",
  crystallize: "Voronoi mosaic of flat, irregular cells.",
  glitch: "Torn bands, channel separation and scanlines.",
  canvasshadow: "Bakes a drop shadow into the pixels (clipped to the layer).",
};

const BLUR_KINDS: BlurFxKind[] = [
  "gaussian",
  "box",
  "bokeh",
  "motion",
  "zoom",
  "spin",
  "tiltshift",
  "surface",
  "spread",
];

function blurAmountMeta(kind: BlurFxKind): { label: string; min: number; max: number; unit: string } {
  switch (kind) {
    case "motion":
      return { label: "Length", min: 1, max: 200, unit: "px" };
    case "zoom":
      return { label: "Amount", min: 1, max: 100, unit: "%" };
    case "spin":
      return { label: "Angle", min: 1, max: 180, unit: "°" };
    case "bokeh":
      return { label: "Radius", min: 1, max: 60, unit: "px" };
    case "tiltshift":
      return { label: "Radius", min: 1, max: 100, unit: "px" };
    case "surface":
      return { label: "Radius", min: 1, max: 50, unit: "px" };
    case "spread":
      return { label: "Amount", min: 1, max: 60, unit: "px" };
    default:
      return { label: "Radius", min: 1, max: 200, unit: "px" };
  }
}

/**
 * Smart Filters — the per-layer non-destructive filter stack manager: an
 * ordered list (top of the list renders last), per-filter enable/reorder/
 * delete, per-type parameter editors with live document preview, per-filter
 * blend + opacity, Clear All and destructive Apply (bake).
 */
export default function SmartFilterDialog({
  node,
  onLive,
  onCommit,
  onApplyAll,
  onAddFilterMask,
  onRemoveFilterMask,
  onToggleFilterMask,
  onPaintFilterMask,
  anchorArmId,
  onToggleAnchorArm,
  hasSelection = false,
  onClose,
}: {
  node: LayerLeaf | LayerGroup;
  /** Param-drag updates (debounced into one history step by the editor). */
  onLive: (filters: SmartFilter[]) => void;
  /** Discrete structural change (add/toggle/reorder/remove/clear). */
  onCommit: (filters: SmartFilter[] | undefined, label: string) => void;
  /** Bake the stack into the layer's pixels (leaf layers only). */
  onApplyAll: () => void;
  /** Filter mask — one grayscale raster confining the whole stack. */
  onAddFilterMask: (init: "reveal" | "selection") => void;
  onRemoveFilterMask: () => void;
  onToggleFilterMask: (enabled: boolean) => void;
  /** Target the mask as the paint surface (closes the dialog to paint). */
  onPaintFilterMask: () => void;
  /** Anchor targeting: id of the radial-blur filter placed by dragging the
   *  canvas (null = off). While armed the dialog docks and the blanket lets
   *  clicks through to the canvas — same treatment as the Curves Target mode. */
  anchorArmId: string | null;
  onToggleAnchorArm: (id: string | null) => void;
  hasSelection?: boolean;
  onClose: () => void;
}) {
  const filters = node.filters ?? [];
  const [selId, setSelId] = useState<string | null>(filters.length ? filters[filters.length - 1].id : null);
  const sel = filters.find((f) => f.id === selId) ?? (filters.length ? filters[filters.length - 1] : null);

  // Anchor targeting is armed for the SELECTED filter only; picking another row
  // (or the armed filter vanishing) disarms so the blanket never blocks a still-
  // armed canvas mode.
  const arming = !!sel && anchorArmId === sel.id;
  useEffect(() => {
    if (anchorArmId && sel?.id !== anchorArmId) onToggleAnchorArm(null);
  }, [anchorArmId, sel?.id, onToggleAnchorArm]);

  // Drag-reorder: the order previews in LOCAL state while dragging and commits
  // as ONE "Reorder Smart Filters" step on drop (the Up/Down buttons remain).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragList, setDragList] = useState<SmartFilter[] | null>(null);
  const shown = dragList ?? filters;
  const finishDrag = () => {
    if (dragList && dragList.some((f, i) => f.id !== filters[i]?.id)) {
      onCommit(dragList, "Reorder Smart Filters");
    }
    setDragId(null);
    setDragList(null);
  };
  const dragOverRow = (targetId: string, before: boolean) => {
    setDragList((ls) => {
      const cur = ls ?? filters;
      const from = cur.findIndex((x) => x.id === dragId);
      const to = cur.findIndex((x) => x.id === targetId);
      if (from < 0 || to < 0) return ls;
      // The list DISPLAYS reversed (top = end of array), so "above the target"
      // in display space means AFTER it in the array.
      let insert = before ? to + 1 : to;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      if (from < insert) insert--;
      next.splice(insert, 0, moved);
      return next.every((x, i) => x.id === cur[i].id) ? ls : next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Esc steps out of anchor targeting first; a second Esc closes.
        if (anchorArmId) onToggleAnchorArm(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, anchorArmId, onToggleAnchorArm]);

  const patchSel = (patch: Partial<SmartFilter["params"]>) => {
    if (!sel) return;
    onLive(
      filters.map((f) =>
        f.id === sel.id ? ({ ...f, params: { ...f.params, ...patch } } as SmartFilter) : f,
      ),
    );
  };
  const patchSelBase = (patch: Partial<Pick<SmartFilter, "blendMode" | "opacity">>, live: boolean) => {
    if (!sel) return;
    const next = filters.map((f) => (f.id === sel.id ? ({ ...f, ...patch } as SmartFilter) : f));
    if (live) onLive(next);
    else onCommit(next, "Edit Smart Filter");
  };
  const addFilter = (type: FilterType) => {
    const f = defaultFilter(type);
    onCommit([...filters, f], `Add ${filterLabel(f)}`);
    setSelId(f.id);
  };
  const toggle = (f: SmartFilter, enabled: boolean) =>
    onCommit(
      filters.map((x) => (x.id === f.id ? { ...x, enabled } : x)),
      enabled ? "Enable Smart Filter" : "Disable Smart Filter",
    );
  const removeSel = () => {
    if (!sel) return;
    const next = filters.filter((f) => f.id !== sel.id);
    onCommit(next.length ? next : undefined, `Remove ${filterLabel(sel)}`);
    setSelId(next.length ? next[next.length - 1].id : null);
  };
  /** dir +1 = toward the top of the stack (renders later). */
  const moveSel = (dir: 1 | -1) => {
    if (!sel) return;
    const i = filters.findIndex((f) => f.id === sel.id);
    const j = i + dir;
    if (j < 0 || j >= filters.length) return;
    const next = [...filters];
    [next[i], next[j]] = [next[j], next[i]];
    onCommit(next, "Reorder Smart Filters");
  };

  const onCount = filters.filter((f) => f.enabled).length;
  const selIdx = sel ? filters.findIndex((f) => f.id === sel.id) : -1;

  const renderParams = () => {
    if (!sel) return <p className={styles.paneDesc}>Add a filter from the list on the left.</p>;
    switch (sel.type) {
      case "blur": {
        const p = sel.params;
        const meta = blurAmountMeta(p.kind);
        const radial = p.kind === "zoom" || p.kind === "spin" || p.kind === "tiltshift";
        return (
          <>
            <div className={styles.group}>
              <span className={styles.groupTitle}>Blur</span>
              <div className={styles.grid2}>
                <div className={styles.stackField}>
                  <span className={styles.stackLabel}>Type</span>
                  <Select
                    block
                    options={BLUR_KINDS.map((k) => BLUR_FX_LABELS[k])}
                    value={BLUR_FX_LABELS[p.kind]}
                    onChange={(l) => {
                      const kind = BLUR_KINDS.find((k) => BLUR_FX_LABELS[k] === l)!;
                      const m = blurAmountMeta(kind);
                      patchSel({ kind, amount: Math.max(m.min, Math.min(m.max, p.amount)) });
                    }}
                  />
                </div>
                <Slider label={meta.label} min={meta.min} max={meta.max} unit={meta.unit} value={p.amount} onChange={(v) => patchSel({ amount: v })} />
                {(p.kind === "motion" || p.kind === "tiltshift") && (
                  <Slider label="Angle" min={0} max={360} unit="°" value={p.angle} onChange={(v) => patchSel({ angle: v })} />
                )}
                {p.kind === "surface" && (
                  <Slider label="Threshold" min={1} max={100} unit="%" value={p.threshold} onChange={(v) => patchSel({ threshold: v })} />
                )}
                {p.kind === "tiltshift" && (
                  <>
                    <Slider label="Focus size" min={0} max={100} unit="%" value={p.band} onChange={(v) => patchSel({ band: v })} />
                    <Slider label="Feather" min={2} max={100} unit="%" value={p.feather} onChange={(v) => patchSel({ feather: v })} />
                  </>
                )}
              </div>
            </div>
            {radial && (
              <div className={styles.group}>
                <span className={styles.groupTitle}>
                  Centre
                  <button
                    type="button"
                    className={styles.resetBtn}
                    data-active={arming}
                    onClick={() => onToggleAnchorArm(arming ? null : sel.id)}
                    title={
                      arming
                        ? "On-canvas placement is on — drag on the image (Esc exits)"
                        : "Place it by dragging on the image itself"
                    }
                  >
                    <Crosshair size={11} /> Set on canvas
                  </button>
                </span>
                <div className={styles.grid2}>
                  <Slider label="X" min={0} max={100} unit="%" value={Math.round(p.anchor.x * 100)} onChange={(v) => patchSel({ anchor: { x: v / 100, y: p.anchor.y } })} />
                  <Slider label="Y" min={0} max={100} unit="%" value={Math.round(p.anchor.y * 100)} onChange={(v) => patchSel({ anchor: { x: p.anchor.x, y: v / 100 } })} />
                </div>
                {arming && (
                  <p className={styles.targetHint}>
                    Drag on the image to place the{" "}
                    {p.kind === "tiltshift" ? "focus band" : p.kind === "spin" ? "rotation centre" : "blur centre"}
                    {" "}— Esc to finish.
                  </p>
                )}
              </div>
            )}
          </>
        );
      }
      case "sharpen": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Unsharp Mask</span>
            <div className={styles.grid2}>
              <Slider label="Amount" min={1} max={500} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
              <Slider label="Radius" min={1} max={100} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
              <Slider label="Threshold" min={0} max={255} unit="" value={p.threshold} onChange={(v) => patchSel({ threshold: v })} />
            </div>
          </div>
        );
      }
      case "noise": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Add Noise</span>
            <div className={styles.grid2}>
              <Slider label="Amount" min={1} max={100} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
              <Slider label="Seed" min={1} max={100} unit="" value={p.seed} onChange={(v) => patchSel({ seed: v })} />
            </div>
            <Segmented
              label="Distribution"
              value={p.distribution}
              onChange={(v) => patchSel({ distribution: v as "gaussian" | "uniform" })}
              options={[
                { value: "gaussian", text: "Gaussian" },
                { value: "uniform", text: "Uniform" },
              ]}
            />
            <div className={styles.fieldRow}>
              <span className={styles.fieldLabel}>Monochromatic</span>
              <Toggle label="" checked={p.monochromatic} onChange={(v) => patchSel({ monochromatic: v })} />
            </div>
          </div>
        );
      }
      case "pixelate": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Mosaic</span>
            <Slider label="Cell size" min={2} max={200} unit="px" value={p.cellSize} onChange={(v) => patchSel({ cellSize: v })} />
          </div>
        );
      }
      case "distort": {
        const p = sel.params;
        return (
          <>
            <div className={styles.group}>
              <span className={styles.groupTitle}>Distort</span>
              <Segmented
                label="Mode"
                value={p.mode}
                onChange={(v) => patchSel({ mode: v as "twirl" | "pinch" | "wave" })}
                options={[
                  { value: "twirl", text: "Twirl" },
                  { value: "pinch", text: "Pinch" },
                  { value: "wave", text: "Wave" },
                ]}
              />
              <div className={styles.grid2}>
                {p.mode === "twirl" && (
                  <>
                    <Slider label="Angle" min={-360} max={360} unit="°" value={p.angle} onChange={(v) => patchSel({ angle: v })} />
                    <Slider label="Radius" min={5} max={100} unit="%" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
                  </>
                )}
                {p.mode === "pinch" && (
                  <>
                    <Slider label="Amount" min={-100} max={100} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
                    <Slider label="Radius" min={5} max={100} unit="%" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
                  </>
                )}
                {p.mode === "wave" && (
                  <>
                    <Slider label="Amplitude" min={1} max={100} unit="px" value={p.amplitude} onChange={(v) => patchSel({ amplitude: v })} />
                    <Slider label="Wavelength" min={4} max={300} unit="px" value={p.wavelength} onChange={(v) => patchSel({ wavelength: v })} />
                  </>
                )}
              </div>
              {p.mode === "wave" && (
                <Segmented
                  label="Edges"
                  value={p.edge}
                  onChange={(v) => patchSel({ edge: v as "clamp" | "wrap" })}
                  options={[
                    { value: "clamp", text: "Clamp" },
                    { value: "wrap", text: "Wrap" },
                  ]}
                />
              )}
            </div>
          </>
        );
      }
      case "highpass": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>High Pass</span>
            <div className={styles.grid2}>
              <Slider label="Radius" min={1} max={250} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
            </div>
            <span className={styles.hint}>
              Detail finer than the radius survives; everything else becomes mid-grey. Blend with
              Overlay or Soft Light above to sharpen.
            </span>
          </div>
        );
      }
      case "median": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Median</span>
            <div className={styles.grid2}>
              <Slider label="Radius" min={1} max={16} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
            </div>
          </div>
        );
      }
      case "dustscratches": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Dust &amp; Scratches</span>
            <div className={styles.grid2}>
              <Slider label="Radius" min={1} max={16} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
              <Slider label="Threshold" min={0} max={255} unit="" value={p.threshold} onChange={(v) => patchSel({ threshold: v })} />
            </div>
            <span className={styles.hint}>
              Higher thresholds touch fewer pixels. At 0 this is a plain Median.
            </span>
          </div>
        );
      }
      case "denoise": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Reduce Noise</span>
            <div className={styles.grid2}>
              <Slider label="Strength" min={0} max={100} unit="%" value={p.strength} onChange={(v) => patchSel({ strength: v })} />
              <Slider label="Radius" min={1} max={24} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
              <Slider label="Color noise" min={0} max={100} unit="%" value={p.color} onChange={(v) => patchSel({ color: v })} />
            </div>
            <span className={styles.hint}>
              Strength sets how different a neighbour may be and still be averaged in — edges stay
              crisp because they exceed it.
            </span>
          </div>
        );
      }
      case "oil": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Oil Paint</span>
            <div className={styles.grid2}>
              <Slider label="Brush size" min={1} max={16} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
              <Slider label="Levels" min={2} max={64} unit="" value={p.levels} onChange={(v) => patchSel({ levels: v })} />
            </div>
            <span className={styles.hint}>
              Fewer levels give broader, flatter strokes. Cost grows with brush size.
            </span>
          </div>
        );
      }
      case "halftone": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Halftone</span>
            <Segmented
              label="Screen"
              value={p.mono ? "mono" : "color"}
              onChange={(v) => patchSel({ mono: v === "mono" })}
              options={[
                { value: "color", text: "Colour (CMY)" },
                { value: "mono", text: "Black" },
              ]}
            />
            <div className={styles.grid2}>
              <Slider label="Dot pitch" min={2} max={64} unit="px" value={p.size} onChange={(v) => patchSel({ size: v })} />
              <Slider label="Angle" min={0} max={90} unit="°" value={p.angle} onChange={(v) => patchSel({ angle: v })} />
            </div>
            <span className={styles.hint}>
              Colour mode screens cyan, magenta and yellow 30° apart, which is what keeps the three
              from beating into moiré.
            </span>
          </div>
        );
      }
      case "crystallize": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Crystallize</span>
            <div className={styles.grid2}>
              <Slider label="Cell size" min={2} max={200} unit="px" value={p.size} onChange={(v) => patchSel({ size: v })} />
            </div>
            <span className={styles.hint}>
              Irregular Voronoi cells, each filled with its own average colour — unlike Pixelate,
              which uses a square grid.
            </span>
          </div>
        );
      }
      case "glitch": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Glitch</span>
            <div className={styles.grid2}>
              <Slider label="Displacement" min={0} max={100} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
              <Slider label="Band height" min={1} max={128} unit="px" value={p.blockSize} onChange={(v) => patchSel({ blockSize: v })} />
              <Slider label="Channel shift" min={-32} max={32} unit="px" value={p.rgbShift} onChange={(v) => patchSel({ rgbShift: v })} />
              <Slider label="Scanlines" min={0} max={100} unit="%" value={p.scanlines} onChange={(v) => patchSel({ scanlines: v })} />
              <Slider label="Seed" min={1} max={999} unit="" value={p.seed} onChange={(v) => patchSel({ seed: v })} />
            </div>
          </div>
        );
      }
      case "canvasshadow": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Drop Shadow (baked)</span>
            <div className={styles.grid2}>
              <Slider label="Distance" min={0} max={200} unit="px" value={p.distance} onChange={(v) => patchSel({ distance: v })} />
              <Slider label="Angle" min={0} max={360} unit="°" value={p.angle} onChange={(v) => patchSel({ angle: v })} />
              <Slider label="Size" min={0} max={200} unit="px" value={p.size} onChange={(v) => patchSel({ size: v })} />
              <Slider label="Opacity" min={0} max={100} unit="%" value={p.opacity} onChange={(v) => patchSel({ opacity: v })} />
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Color</span>
              <ColorChip color={p.color} onChange={(c) => patchSel({ color: c })} label="Shadow color" />
            </div>
            <span className={styles.hint}>
              For most work use Layer Style ▸ Drop Shadow instead — it stays live and can spill
              outside the layer. This one bakes into the pixels so later filters in the stack see
              it, and is therefore clipped at the layer bounds.
            </span>
          </div>
        );
      }
      case "dehaze": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Dehaze</span>
            <div className={styles.grid2}>
              <Slider label="Amount" min={0} max={100} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
              <Slider label="Radius" min={1} max={64} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
            </div>
            <span className={styles.hint}>
              Radius is the patch the haze estimate is measured over — larger is smoother but
              blunter around fine detail. Strong settings can halo along a hard skyline.
            </span>
          </div>
        );
      }
      case "clarity": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Clarity &amp; Texture</span>
            <div className={styles.grid2}>
              <Slider label="Clarity" min={-100} max={100} unit="" value={p.clarity} onChange={(v) => patchSel({ clarity: v })} />
              <Slider label="Texture" min={-100} max={100} unit="" value={p.texture} onChange={(v) => patchSel({ texture: v })} />
              <Slider label="Radius" min={5} max={200} unit="px" value={p.radius} onChange={(v) => patchSel({ radius: v })} />
            </div>
            <span className={styles.hint}>
              Clarity shapes broad contrast and is weighted to the midtones so skies keep their
              gradient; Texture works at a fraction of the radius for fine detail. Negative values
              soften.
            </span>
          </div>
        );
      }
      case "grain": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Grain</span>
            <div className={styles.grid2}>
              <Slider label="Amount" min={0} max={100} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
              <Slider label="Size" min={1} max={32} unit="px" value={p.size} onChange={(v) => patchSel({ size: v })} />
              <Slider label="Roughness" min={0} max={100} unit="%" value={p.roughness} onChange={(v) => patchSel({ roughness: v })} />
              <Slider label="Seed" min={1} max={999} unit="" value={p.seed} onChange={(v) => patchSel({ seed: v })} />
            </div>
            <span className={styles.hint}>
              Grain lands on the midtones and fades out of deep shadow and blown highlight, the way
              film does. Roughness makes its strength vary across the frame.
            </span>
          </div>
        );
      }
      case "lens": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Lens Corrections</span>
            <div className={styles.grid2}>
              <Slider label="Distortion" min={-100} max={100} unit="" value={p.distortion} onChange={(v) => patchSel({ distortion: v })} />
              <Slider label="Red / cyan" min={-100} max={100} unit="" value={p.redCyan} onChange={(v) => patchSel({ redCyan: v })} />
              <Slider label="Blue / yellow" min={-100} max={100} unit="" value={p.blueYellow} onChange={(v) => patchSel({ blueYellow: v })} />
              <Slider label="Vignette" min={-100} max={100} unit="" value={p.vignette} onChange={(v) => patchSel({ vignette: v })} />
              <Slider label="Midpoint" min={0} max={100} unit="%" value={p.midpoint} onChange={(v) => patchSel({ midpoint: v })} />
            </div>
            <span className={styles.hint}>
              Positive Distortion removes barrel (corners pull in), negative removes pincushion. The
              fringe sliders scale red and blue against green. Vignette darkens below 0 and lightens
              above; Midpoint sets how far out it starts.
            </span>
          </div>
        );
      }
      case "stylize": {
        const p = sel.params;
        return (
          <div className={styles.group}>
            <span className={styles.groupTitle}>Stylize</span>
            <Segmented
              label="Mode"
              value={p.mode}
              onChange={(v) => patchSel({ mode: v as "findEdges" | "emboss" | "posterize" | "threshold" })}
              options={[
                { value: "findEdges", text: "Edges" },
                { value: "emboss", text: "Emboss" },
                { value: "posterize", text: "Posterize" },
                { value: "threshold", text: "Threshold" },
              ]}
            />
            <div className={styles.grid2}>
              {p.mode === "emboss" && (
                <>
                  <Slider label="Angle" min={0} max={360} unit="°" value={p.angle} onChange={(v) => patchSel({ angle: v })} />
                  <Slider label="Height" min={1} max={10} unit="px" value={p.height} onChange={(v) => patchSel({ height: v })} />
                  <Slider label="Amount" min={10} max={500} unit="%" value={p.amount} onChange={(v) => patchSel({ amount: v })} />
                </>
              )}
              {p.mode === "posterize" && (
                <Slider label="Levels" min={2} max={32} unit="" value={p.levels} onChange={(v) => patchSel({ levels: v })} />
              )}
              {p.mode === "threshold" && (
                <Slider label="Level" min={0} max={255} unit="" value={p.level} onChange={(v) => patchSel({ level: v })} />
              )}
            </div>
          </div>
        );
      }
    }
  };

  return (
    <div
      className={styles.overlay}
      data-targeting={arming}
      // While targeting, the blanket stops intercepting the canvas (clicks fall
      // through everywhere except the dialog itself, which re-enables events).
      style={arming ? { pointerEvents: "none", background: "transparent", backdropFilter: "none" } : undefined}
      onMouseDown={arming ? undefined : onClose}
    >
      <div
        className={styles.dialog}
        data-targeting={arming}
        role="dialog"
        aria-modal={!arming}
        aria-label="Smart filters"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Smart filters</h2>
          <span className={styles.nameChip} title={node.name}>
            {node.name}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.layout}>
          <div className={styles.list} role="listbox" aria-label="Smart filters">
            <span className={styles.listLabel}>Stack (top renders last — drag to reorder)</span>
            {[...shown].reverse().map((f) => {
              const Icon = FILTER_ICONS[f.type];
              return (
                <div
                  key={f.id}
                  className={styles.fxRow}
                  data-sel={sel?.id === f.id}
                  data-on={f.enabled}
                  data-dragging={dragId === f.id || undefined}
                  role="option"
                  aria-selected={sel?.id === f.id}
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    setDragId(f.id);
                    setSelId(f.id);
                    e.dataTransfer.setData("text/plain", f.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === f.id) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    dragOverRow(f.id, e.clientY - r.top < r.height / 2);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    finishDrag();
                  }}
                  onDragEnd={(e) => {
                    // Esc / drop outside cancels: discard the preview order.
                    if (e.dataTransfer.dropEffect === "none") {
                      setDragId(null);
                      setDragList(null);
                    } else finishDrag();
                  }}
                  onClick={() => setSelId(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelId(f.id);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={styles.fxCheck}
                    data-on={f.enabled}
                    aria-label={`${filterLabel(f)} ${f.enabled ? "on" : "off"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(f, !f.enabled);
                    }}
                  >
                    {f.enabled && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
                        <path d="M1.5 5.5 4 8l4.5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                  <Icon size={14} className={styles.fxIcon} />
                  <span className={styles.fxName}>{filterLabel(f)}</span>
                </div>
              );
            })}
            {!filters.length && <span className={styles.listLabel}>No filters yet</span>}
            <span className={styles.listLabel} style={{ marginTop: 8 }}>
              Add filter
            </span>
            {TYPE_ORDER.map((t) => {
              const Icon = FILTER_ICONS[t];
              return (
                <button key={t} type="button" className={styles.fxRow} onClick={() => addFilter(t)} title={FILTER_DESC[t]}>
                  <Plus size={12} className={styles.fxIcon} />
                  <Icon size={14} className={styles.fxIcon} />
                  <span className={styles.fxName}>{FILTER_LABELS[t]}</span>
                </button>
              );
            })}
          </div>

          <div className={styles.pane}>
            <div className={styles.paneHead}>
              <span className={styles.paneTitle}>{sel ? filterLabel(sel) : "Smart Filters"}</span>
              {sel && (
                <div className={styles.paneActions}>
                  <button
                    type="button"
                    className={styles.resetBtn}
                    disabled={selIdx >= filters.length - 1}
                    onClick={() => moveSel(1)}
                    title="Move up the stack (renders later)"
                  >
                    <ArrowUp size={11} /> Up
                  </button>
                  <button
                    type="button"
                    className={styles.resetBtn}
                    disabled={selIdx <= 0}
                    onClick={() => moveSel(-1)}
                    title="Move down the stack (renders earlier)"
                  >
                    <ArrowDown size={11} /> Down
                  </button>
                  <button type="button" className={styles.resetBtn} onClick={removeSel} title="Remove this filter">
                    <Trash2 size={11} /> Remove
                  </button>
                </div>
              )}
            </div>
            <p className={styles.paneDesc}>
              {sel ? FILTER_DESC[sel.type] : "Non-destructive filters, rendered on this layer's own pixels."}
            </p>
            <div className={styles.paneBody}>
              {renderParams()}
              {sel && (
                <div className={styles.group}>
                  <span className={styles.groupTitle}>Blending</span>
                  <div className={styles.grid2}>
                    <div className={styles.stackField}>
                      <span className={styles.stackLabel}>Blend</span>
                      <Select block options={BLEND_MODES} value={sel.blendMode} onChange={(v) => patchSelBase({ blendMode: v }, false)} />
                    </div>
                    <Slider label="Opacity" min={0} max={100} unit="%" value={sel.opacity} onChange={(v) => patchSelBase({ opacity: v }, true)} />
                  </div>
                </div>
              )}
              <div className={styles.group}>
                <span className={styles.groupTitle}>Filter Mask</span>
                {node.filterMask ? (
                  <>
                    <p className={styles.paneDesc}>
                      One grayscale mask confines the whole stack — white shows the filtered result,
                      black keeps the original pixels. Paint it with any brush.
                    </p>
                    <div className={styles.paneActions}>
                      <Toggle
                        label="Enabled"
                        checked={node.filterMask.enabled}
                        onChange={(on) => onToggleFilterMask(on)}
                      />
                      <button
                        type="button"
                        className={styles.resetBtn}
                        onClick={onPaintFilterMask}
                        title="Make the filter mask the paint target and close this dialog"
                      >
                        <Brush size={11} /> Paint
                      </button>
                      <button
                        type="button"
                        className={styles.resetBtn}
                        onClick={onRemoveFilterMask}
                        title="Delete the filter mask (the stack applies everywhere again)"
                      >
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className={styles.paneDesc}>
                      Confine these filters to part of the layer with a paintable grayscale mask.
                    </p>
                    <div className={styles.paneActions}>
                      <button
                        type="button"
                        className={styles.resetBtn}
                        disabled={!filters.length}
                        onClick={() => onAddFilterMask("reveal")}
                        title={filters.length ? "Add a reveal-all filter mask" : "Add a smart filter first"}
                      >
                        <Plus size={11} /> Add Mask
                      </button>
                      <button
                        type="button"
                        className={styles.resetBtn}
                        disabled={!filters.length || !hasSelection}
                        onClick={() => onAddFilterMask("selection")}
                        title={hasSelection ? "Mask from the current selection" : "Make a selection first"}
                      >
                        <Plus size={11} /> From Selection
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <footer className={styles.foot}>
          <span className={styles.countNote}>
            {onCount === 0 ? "No filters on" : `${onCount} of ${filters.length} filters on`}
          </span>
          <div className={styles.footSpacer} />
          <button
            type="button"
            className={`${styles.btn} ${styles.clearBtn}`}
            disabled={!filters.length}
            onClick={() => {
              onCommit(undefined, "Clear Smart Filters");
              setSelId(null);
            }}
          >
            Clear all
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={node.type !== "layer" || !filters.length}
            title={node.type !== "layer" ? "Only pixel layers can bake filters" : "Bake the stack into the layer's pixels"}
            onClick={onApplyAll}
          >
            Apply (bake)
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
