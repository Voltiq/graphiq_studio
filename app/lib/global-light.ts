/**
 * Global light — one lighting angle shared by every effect that opts into it.
 *
 * A drop shadow at 120°, an inner shadow at 30° and a bevel lit from 90° is the
 * single most common way a layer style stops looking like an object and starts
 * looking like three unrelated decorations. Photoshop solves it with a
 * document-level light that individual effects follow, and that is what this is:
 * the angle lives on the DOCUMENT, effects carry a flag, and turning the angle
 * anywhere turns it everywhere that opted in.
 *
 * Only three effects have a direction: drop shadow, inner shadow and bevel.
 * Glows radiate and overlays are flat, so they never participate — which is why
 * this substitutes into named fields rather than walking the whole object.
 *
 * The bevel also takes ALTITUDE (how high the light sits). It is part of the
 * global light for the same reason the angle is: a bevel lit from a different
 * elevation than the shadows contradicts them just as visibly.
 *
 * Pure and dependency-free — Node-testable.
 */

import type { LayerEffects } from "./effects";

export interface GlobalLight {
  /** Degrees, matching the per-effect angle convention. */
  angle: number;
  /** Degrees above the surface; only the bevel uses it. */
  altitude: number;
}

export const DEFAULT_GLOBAL_LIGHT: GlobalLight = { angle: 120, altitude: 30 };

/** The effect keys that have a direction and can therefore follow the light. */
export const LIT_KEYS = ["dropShadow", "innerShadow", "bevel"] as const;
export type LitKey = (typeof LIT_KEYS)[number];

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

export function sanitizeGlobalLight(raw: unknown): GlobalLight {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GLOBAL_LIGHT };
  const o = raw as Partial<GlobalLight>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    angle: wrap(num(o.angle, DEFAULT_GLOBAL_LIGHT.angle)),
    altitude: Math.max(0, Math.min(90, num(o.altitude, DEFAULT_GLOBAL_LIGHT.altitude))),
  };
}

/** True when any enabled effect on this layer follows the global light. */
export function usesGlobalLight(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  return !!(
    (fx.dropShadow?.enabled && fx.dropShadow.useGlobalLight) ||
    (fx.innerShadow?.enabled && fx.innerShadow.useGlobalLight) ||
    (fx.bevel?.enabled && fx.bevel.useGlobalLight)
  );
}

/**
 * Substitute the global light into whichever effects opted in.
 *
 * Returns the SAME object when nothing opted in, so the render cache and the
 * effects hash see an unchanged reference on the overwhelmingly common path.
 */
export function resolveGlobalLight(
  fx: LayerEffects | undefined,
  light: GlobalLight,
): LayerEffects | undefined {
  if (!usesGlobalLight(fx)) return fx;
  // Written out per key rather than indexed generically: indexing the union
  // collapses ShadowFX and BevelFX into their intersection, and TypeScript then
  // demands every bevel field on a drop shadow.
  const out: LayerEffects = { ...fx };
  if (out.dropShadow?.enabled && out.dropShadow.useGlobalLight)
    out.dropShadow = { ...out.dropShadow, angle: light.angle };
  if (out.innerShadow?.enabled && out.innerShadow.useGlobalLight)
    out.innerShadow = { ...out.innerShadow, angle: light.angle };
  if (out.bevel?.enabled && out.bevel.useGlobalLight)
    out.bevel = { ...out.bevel, angle: light.angle, altitude: light.altitude };
  return out;
}

/**
 * The new global light after the user drags the angle on an effect that follows
 * it. Dragging one shadow's angle is how you steer the light for the whole
 * document — which is the point, and also why the UI has to say so.
 */
export function lightFromEffect(
  prev: GlobalLight,
  key: LitKey,
  patch: { angle?: number; altitude?: number },
): GlobalLight {
  return sanitizeGlobalLight({
    angle: patch.angle ?? prev.angle,
    // Only the bevel carries an altitude; a shadow's drag must not clear it.
    altitude: key === "bevel" ? (patch.altitude ?? prev.altitude) : prev.altitude,
  });
}

/** Cache-key ingredient: only meaningful when something actually follows it. */
export function globalLightKey(fx: LayerEffects | undefined, light: GlobalLight): string {
  return usesGlobalLight(fx) ? `${Math.round(light.angle)}:${Math.round(light.altitude)}` : "x";
}
