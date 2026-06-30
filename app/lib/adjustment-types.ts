// Registry of adjustment-layer types offered in the UI. Every type is just a
// bundle of the existing `Adjustments` slider values (and an optional preset
// name), so they all process through `applyAdjustments` — no forked math. Spec
// 04 will add curves/levels by extending `AdjustmentSpec`, not this list.
import { DEFAULT_ADJUST, FILTER_PRESETS, type AdjustmentSpec, type Adjustments } from "./adjust";

export interface AdjustmentType {
  /** Stable id used by the menu action + history label. */
  id: string;
  label: string;
  /** Seed slider values (merged over the neutral default). */
  seed: Partial<Adjustments>;
  /** When set, the node records this preset name (drives the panel's filter chip). */
  preset?: string;
}

/** Editable adjustment-layer types (open the panel with these sliders seeded). */
export const ADJUSTMENT_TYPES: AdjustmentType[] = [
  { id: "brightness-contrast", label: "Brightness / Contrast", seed: {} },
  { id: "exposure", label: "Exposure", seed: {} },
  { id: "vibrance", label: "Vibrance", seed: {} },
  { id: "color-balance", label: "Color Balance", seed: {} },
  { id: "black-white", label: "Black & White", seed: { saturation: -100 } },
  { id: "photo-filter-warm", label: "Photo Filter — Warm", seed: { temperature: 35, vibrance: 12 } },
  { id: "photo-filter-cool", label: "Photo Filter — Cool", seed: { temperature: -32, tint: -8, vibrance: 8 } },
];

/** Build a fresh AdjustmentSpec from a registry type id (falls back to neutral). */
export function specFromType(id: string): AdjustmentSpec {
  const t = ADJUSTMENT_TYPES.find((x) => x.id === id);
  return { type: "sliders", params: { ...DEFAULT_ADJUST, ...(t?.seed ?? {}) } };
}

/** Build a fresh AdjustmentSpec from a named filter preset (Vivid, Noir, …). */
export function specFromPreset(name: string): AdjustmentSpec {
  return { type: "sliders", preset: name, params: { ...DEFAULT_ADJUST, ...(FILTER_PRESETS[name] ?? {}) } };
}

/** A short label for a node's spec (Layers-panel subtitle + history). */
export function specLabel(spec: AdjustmentSpec): string {
  if (spec.type === "levels") return "Levels";
  if (spec.type === "curves") return "Curves";
  if (spec.preset) return spec.preset;
  const p = spec.params;
  // Name it after the dominant non-zero slider group, else "Adjustment".
  if (p.saturation <= -100) return "Black & White";
  if (p.exposure && !p.contrast) return "Exposure";
  if (p.vibrance || p.saturation) return "Vibrance";
  if (p.temperature || p.tint) return "Color Balance";
  if (p.contrast || p.exposure) return "Brightness / Contrast";
  return "Adjustment";
}
