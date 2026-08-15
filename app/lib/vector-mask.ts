/**
 * Vector masks — a pen path used as a layer mask, alongside the raster one.
 *
 * The path is the source of truth, not a raster: it stays re-editable, it is a
 * few hundred bytes in the project file instead of a full-canvas PNG, and it
 * re-rasterises crisply at any document size. The engine caches the rasterised
 * alpha keyed by this module's hash, so moving one anchor re-renders and nothing
 * else does.
 *
 * A layer can carry BOTH masks. They multiply: the raster mask paints softness
 * and detail, the vector mask cuts a clean, resolution-independent edge, and a
 * pixel survives only where both let it through. That is Photoshop's behaviour
 * and it is the reason this is a separate field rather than a mode on the
 * existing mask.
 *
 * Pure and dependency-free — Node-testable.
 */

import type { PenAnchor } from "./tools";

export interface VectorMask {
  anchors: PenAnchor[];
  /** Mask participates in compositing when true. */
  enabled: boolean;
  /** The path HIDES its interior instead of revealing it. */
  inverted: boolean;
  /** px — softens the edge. 0 keeps the path's own anti-aliased edge. */
  feather: number;
}

/** A path needs three anchors to enclose any area at all. */
export const MIN_ANCHORS = 3;

export function defaultVectorMask(anchors: PenAnchor[]): VectorMask {
  return { anchors: anchors.map((a) => ({ ...a })), enabled: true, inverted: false, feather: 0 };
}

/** True when the mask should actually shape the composite. */
export function vectorMaskActive(vm: VectorMask | undefined): vm is VectorMask {
  return !!vm && vm.enabled && vm.anchors.length >= MIN_ANCHORS;
}

/**
 * Cache / render key for a vector mask.
 *
 * Every field that changes the rasterised alpha is included and nothing else —
 * anchor coordinates and handles, inversion and feather. Rounded to a tenth of a
 * pixel so that dragging an anchor produces a genuinely different key rather
 * than a stream of float noise, while still being finer than any visible change.
 */
export function vectorMaskHash(vm: VectorMask): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  let s = `${vm.inverted ? "i" : "n"}:${r(vm.feather)}:`;
  for (const a of vm.anchors) s += `${r(a.x)},${r(a.y)},${r(a.ix)},${r(a.iy)},${r(a.ox)},${r(a.oy)};`;
  return s;
}

/** Move every anchor by (dx, dy) — used when the layer and its mask are linked. */
export function offsetVectorMask(vm: VectorMask, dx: number, dy: number): VectorMask {
  return {
    ...vm,
    anchors: vm.anchors.map((a) => ({
      x: a.x + dx,
      y: a.y + dy,
      ix: a.ix + dx,
      iy: a.iy + dy,
      ox: a.ox + dx,
      oy: a.oy + dy,
    })),
  };
}

/** Accept a vector mask from a project file, discarding anything malformed. */
export function coerceVectorMask(raw: unknown): VectorMask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Partial<VectorMask>;
  if (!Array.isArray(o.anchors)) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const anchors = o.anchors
    .filter((a) => a && typeof a === "object")
    .map((a) => {
      const p = a as Partial<PenAnchor>;
      return { x: num(p.x), y: num(p.y), ix: num(p.ix), iy: num(p.iy), ox: num(p.ox), oy: num(p.oy) };
    });
  if (anchors.length < MIN_ANCHORS) return undefined;
  return {
    anchors,
    enabled: o.enabled !== false,
    inverted: o.inverted === true,
    feather: Math.max(0, num(o.feather)),
  };
}
