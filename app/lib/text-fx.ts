/**
 * Type effects — the text-first face of the existing layer-effects engine.
 *
 * Nothing here re-implements shadow, glow or stroke maths: `effects.ts` already
 * renders all four from a layer's alpha at composite time, non-destructively,
 * and re-runs whenever the type re-renders. This module is the small amount of
 * policy that makes them reachable from the Text tool: which four are offered,
 * what a sensible starting value looks like for TYPE specifically, and the
 * one-click presets.
 *
 * Type wants different defaults from artwork. The layer-style defaults are tuned
 * for large shapes — a 10 px shadow at 8 px distance is a fine drop shadow under
 * a photo and a smeared mess under 24 px text — so the seeds here are tighter
 * and scale with the font size.
 *
 * Pure and dependency-free — Node-testable.
 */

import type { LayerEffects, ShadowFX, GlowFX, StrokeFX } from "./effects";

/** The four effects the Text tool surfaces, in the order the popover lists them. */
export type TextFxKey = "dropShadow" | "outerGlow" | "innerGlow" | "stroke";

export const TEXT_FX_KEYS: { id: TextFxKey; label: string }[] = [
  { id: "dropShadow", label: "Drop Shadow" },
  { id: "outerGlow", label: "Outer Glow" },
  { id: "innerGlow", label: "Inner Glow" },
  { id: "stroke", label: "Stroke" },
];

/** Round to a whole pixel, never below 1 — every seed below is a size in px. */
const px = (v: number) => Math.max(1, Math.round(v));

/**
 * A starting value for one effect at a given font size.
 *
 * Sizes are fractions of the type size rather than constants, so the same seed
 * reads correctly on 12 px captions and 200 px titles. The reference is a 24 px
 * face: at that size these come out at roughly the values the layer-style
 * defaults use, and they scale from there.
 */
export function seedTextFx(key: TextFxKey, fontSize: number, color: string): NonNullable<LayerEffects[TextFxKey]> {
  const s = Math.max(4, fontSize);
  switch (key) {
    case "dropShadow":
      return {
        enabled: true,
        blendMode: "Multiply",
        opacity: 60,
        color: "#000000",
        angle: 120,
        distance: px(s * 0.12),
        spread: 0,
        size: px(s * 0.16),
      } satisfies ShadowFX;
    case "outerGlow":
      return {
        enabled: true,
        blendMode: "Screen",
        opacity: 75,
        color: "#7dd3fc",
        spread: 0,
        size: px(s * 0.25),
      } satisfies GlowFX;
    case "innerGlow":
      return {
        enabled: true,
        blendMode: "Screen",
        opacity: 60,
        color: "#fff3b0",
        spread: 0,
        size: px(s * 0.12),
        source: "edge",
      } satisfies GlowFX;
    case "stroke":
      return {
        enabled: true,
        blendMode: "Normal",
        opacity: 100,
        // Outside, so the stroke never eats into the glyph shapes — an inside
        // stroke on text of any weight closes up counters and thins the face.
        position: "outside",
        size: px(s * 0.06),
        fillType: "color",
        color: contrastingInk(color),
      } satisfies StrokeFX;
  }
}

/** Black on light type, white on dark — so a seeded stroke is always visible. */
export function contrastingInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})/i.exec((hex || "").trim());
  if (!m) return "#000000";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : "#ffffff";
}

export type TextFxPreset = "soft" | "neon" | "outlined";

export const TEXT_FX_PRESETS: { id: TextFxPreset; label: string }[] = [
  { id: "soft", label: "Soft shadow" },
  { id: "neon", label: "Neon glow" },
  { id: "outlined", label: "Outlined" },
];

/**
 * Apply a preset. Presets REPLACE the type effects rather than merging: a
 * one-click look that quietly inherited the previous look's stroke would not be
 * the look. Any effect the Text tool does not surface (bevel, overlays) is left
 * untouched, because the user can only have set those from the full Layer Style
 * dialog and silently discarding them would be destructive.
 */
export function applyTextFxPreset(
  preset: TextFxPreset,
  prev: LayerEffects | undefined,
  fontSize: number,
  color: string,
): LayerEffects {
  const keep: LayerEffects = { ...prev };
  for (const k of TEXT_FX_KEYS) delete keep[k.id];
  const s = Math.max(4, fontSize);
  switch (preset) {
    case "soft":
      return { ...keep, dropShadow: { ...(seedTextFx("dropShadow", s, color) as ShadowFX), opacity: 45 } };
    case "neon":
      return {
        ...keep,
        outerGlow: {
          ...(seedTextFx("outerGlow", s, color) as GlowFX),
          size: px(s * 0.45),
          opacity: 90,
          color: "#38bdf8",
        },
        innerGlow: { ...(seedTextFx("innerGlow", s, color) as GlowFX), color: "#e0f2fe", opacity: 70 },
      };
    case "outlined":
      return {
        ...keep,
        stroke: { ...(seedTextFx("stroke", s, color) as StrokeFX), size: px(s * 0.09) },
      };
  }
}

/** How many of the four type effects are currently on (drives the FX badge). */
export function textFxCount(fx: LayerEffects | undefined): number {
  if (!fx) return 0;
  let n = 0;
  for (const k of TEXT_FX_KEYS) if (fx[k.id]?.enabled) n++;
  return n;
}
