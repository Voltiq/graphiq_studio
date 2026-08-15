/**
 * Knockout and fill opacity — the other half of Photoshop's Blending Options.
 *
 * The two ship together because knockout is invisible without fill opacity. A
 * knockout layer punches its own shape through what is beneath it and then
 * paints itself back over the hole; at fill opacity 100 it covers that hole
 * exactly and nothing appears to happen. Turn the fill down and the hole shows
 * through — which is the entire point, and how you cut type out of a photo.
 *
 *   FILL opacity scales the layer's own PIXELS but not its effects, which is
 *   what separates it from plain opacity: a layer at fill 0 with a drop shadow
 *   keeps the shadow and loses the artwork.
 *
 *   SHALLOW knockout punches down to the bottom of the containing group.
 *   DEEP punches all the way through the document.
 *
 * Pure and dependency-free — Node-testable.
 */

export type KnockoutMode = "none" | "shallow" | "deep";

export const KNOCKOUT_MODES: { id: KnockoutMode; label: string }[] = [
  { id: "none", label: "None" },
  { id: "shallow", label: "Shallow" },
  { id: "deep", label: "Deep" },
];

/** Fill opacity is a percentage; absent means fully opaque. */
export function fillOpacityOf(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

/** True when fill opacity actually changes anything (drives the fast path). */
export function fillOpacityActive(v: number | undefined): boolean {
  return fillOpacityOf(v) < 100;
}

export function knockoutOf(v: KnockoutMode | undefined): KnockoutMode {
  return v === "shallow" || v === "deep" ? v : "none";
}

export function knockoutActive(v: KnockoutMode | undefined): boolean {
  return knockoutOf(v) !== "none";
}

/**
 * How opaque the layer's own pixels are drawn, 0…1.
 *
 * Note this is NOT multiplied by the layer's opacity here: plain opacity is
 * applied when the composited result is drawn, so folding it in twice would
 * square it for any layer that had both.
 */
export function fillAlpha(v: number | undefined): number {
  return fillOpacityOf(v) / 100;
}

/** Accept blending options from a project file, discarding anything malformed. */
export function coerceBlendingOptions(raw: {
  fillOpacity?: unknown;
  knockout?: unknown;
}): { fillOpacity?: number; knockout?: KnockoutMode } {
  const out: { fillOpacity?: number; knockout?: KnockoutMode } = {};
  if (typeof raw.fillOpacity === "number" && Number.isFinite(raw.fillOpacity)) {
    const v = fillOpacityOf(raw.fillOpacity);
    if (v < 100) out.fillOpacity = v; // 100 is the default — do not store it
  }
  const k = knockoutOf(raw.knockout as KnockoutMode | undefined);
  if (k !== "none") out.knockout = k;
  return out;
}
