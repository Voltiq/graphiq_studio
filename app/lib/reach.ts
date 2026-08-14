// Pixel REACH of smart filters and layer effects (TODO §8 P0) — pure math.
//
// A change to a rect R only stays a change to R if nothing downstream spreads
// pixels. Effects and filters do, which is why the engine currently gives up and
// recomputes the whole document on any pixel change beneath them. This works out
// HOW FAR each one spreads, so a change can instead be re-rendered over R grown
// by that distance and the rest of the cached product reused.
//
// Two properties matter, and conflating them is the trap:
//
//   REACH — how many pixels away an input pixel can influence the output. Bounded
//     and finite ⇒ a padded region is enough.
//   POSITION DEPENDENCE — whether the output at a pixel depends on that pixel's
//     ABSOLUTE coordinates. A twirl rotates about the image centre; a mosaic's
//     cell grid is anchored to the origin; noise is seeded per pixel index.
//     Running any of those over a cropped region gives a DIFFERENT answer no
//     matter how much padding you add, because the crop moves the origin.
//
// So a filter is region-safe only when it is position-INDEPENDENT *and* has a
// bounded reach. Anything else must fall back to the full pass — the whole point
// is that a region-scoped result is byte-identical to the full one.

import type { SmartFilter } from "./filters";
import type { LayerEffects } from "./effects";

/** Reach in px, or `null` meaning "cannot be region-scoped" (unbounded or
 *  position-dependent). */
export type Reach = number | null;

/** Combine two reaches: null (unsafe) wins, otherwise they add — a stack applies
 *  its filters in sequence, so each one spreads what the previous already
 *  spread. */
export const addReach = (a: Reach, b: Reach): Reach => (a === null || b === null ? null : a + b);

/** Grow a reach by a safety margin and round up to whole pixels. */
const px = (v: number): number => Math.max(0, Math.ceil(v));

/**
 * How far one smart filter spreads a pixel.
 *
 * The blur kinds split on position dependence rather than on cost:
 *   box / gaussian / bokeh / surface / spread — isotropic, reach = the radius.
 *   motion — directional, but bounded by the same radius in the worst case.
 *   zoom / spin — sample along a ray from the ANCHOR, so a pixel's displacement
 *     grows with its distance from that anchor and depends on where it is.
 *   tiltshift — the in-focus band is defined in absolute document coordinates.
 */
export function filterReach(f: SmartFilter): Reach {
  if (!f.enabled) return 0;
  switch (f.type) {
    case "blur": {
      const p = f.params;
      switch (p.kind) {
        case "zoom":
        case "spin":
        case "tiltshift":
          return null; // position-dependent (anchor / band in absolute coords)
        default:
          return px(p.amount);
      }
    }
    case "sharpen":
      // Unsharp mask = blur of `radius` subtracted from the original.
      return px(f.params.radius);
    case "noise":
      // Per-pixel RNG seeded from the pixel index — a crop reseeds it.
      return null;
    case "pixelate":
      // The cell grid is anchored to the image origin, so an unaligned crop
      // shifts every cell. (Snapping the region to the grid would make this
      // safe with reach = cellSize; not worth it until pixelate is hot.)
      return null;
    case "distort":
      // twirl/pinch are centred on the image; wave's phase comes from absolute
      // coordinates. All three read the pixel's position.
      return null;
    case "stylize": {
      const p = f.params;
      switch (p.mode) {
        case "posterize":
        case "threshold":
          return 0; // strictly per-pixel
        case "findEdges":
          return 1; // 3×3 kernel
        case "emboss":
          return px(Math.abs(p.height)) + 1; // offset sample + its 3×3 kernel
      }
      return null;
    }
    case "highpass":
      // src − gaussian(src): the blur is what reaches.
      return px(f.params.radius);
    case "median":
    case "dustscratches":
      // A (2r+1)² window, so a changed pixel can alter the median r away.
      // Both are position-INDEPENDENT: the window is relative to the pixel and
      // the edge rule is clamping, exactly like a blur.
      return px(f.params.radius);
    case "dehaze":
      // The patch min and the transmission blur are both local and bounded —
      // but the ATMOSPHERIC LIGHT is estimated from the haziest 0.1% of the
      // WHOLE image. A region would compute a different constant and recover
      // different colours, so this is unsafe for a reason that has nothing to do
      // with reach: a global statistic, not a kernel.
      return null;
    case "clarity":
      // Unsharp at two radii; the clarity radius is the larger of the two.
      return px(f.params.radius);
    case "grain":
      // The noise lattice is anchored to the image ORIGIN and seeded from
      // lattice coordinates, so an unaligned region reseeds every clump — the
      // same trap as mosaic's cell grid.
      return null;
    case "lens":
      // Distortion, chromatic aberration AND vignette are all functions of the
      // distance from the image CENTRE, so every pixel's result depends on where
      // it is — the same trap as twirl/pinch. No amount of padding makes a
      // cropped region agree with the full pass.
      return null;
    case "denoise":
      // Bilateral disc of `radius` on luma, plus a chroma blur of up to
      // radius·2 (colour amount 100%). Take the larger — under-estimating reach
      // is a correctness bug, over-estimating only costs efficiency.
      return px(f.params.radius * 2);
  }
  return null; // unknown/future type: refuse to region-scope it
}

/** Reach of a whole stack (in order). `null` if any member is unsafe. */
export function stackReach(filters: SmartFilter[] | undefined): Reach {
  if (!filters?.length) return 0;
  let total: Reach = 0;
  for (const f of filters) total = addReach(total, filterReach(f));
  return total;
}

/**
 * How far a layer effect spreads the silhouette.
 *
 * Effects render FROM the layer's alpha, so a pixel change moves a shadow or a
 * glow: the reach is the blur size plus however far the effect is offset. A
 * drop shadow at distance d and angle θ lands at most d away in any direction,
 * so d is used without resolving the angle — cheaper and never under-estimates.
 */
export function effectsReach(fx: LayerEffects | undefined): Reach {
  if (!fx) return 0;
  let max = 0;
  const bump = (v: number) => {
    if (v > max) max = v;
  };
  const on = (e: { enabled: boolean } | undefined): boolean => !!e?.enabled;

  // Shadows travel `distance` and blur by `size`; the angle is not resolved
  // because a rect grown uniformly already contains every direction, and
  // over-estimating reach only costs efficiency while under-estimating is a
  // correctness bug (a seam at the edge of the re-rendered region).
  if (on(fx.dropShadow)) bump(fx.dropShadow!.distance + fx.dropShadow!.size);
  if (on(fx.outerGlow)) bump(fx.outerGlow!.size);
  if (on(fx.stroke)) bump(fx.stroke!.size);
  if (on(fx.bevel)) bump(fx.bevel!.size + fx.bevel!.soften);
  // Inner shadow / inner glow are clipped to the silhouette, so they cannot
  // paint OUTSIDE it — but a pixel change still alters the silhouette they are
  // derived from that far in, so the region must cover them too.
  if (on(fx.innerShadow)) bump(fx.innerShadow!.distance + fx.innerShadow!.size);
  if (on(fx.innerGlow)) bump(fx.innerGlow!.size);
  // colorOverlay / gradientOverlay are per-pixel within the silhouette: no reach.

  // `scale` (%) resizes every effect's spatial params at render time, so the
  // reach scales with it.
  const s = typeof fx.scale === "number" && fx.scale > 0 ? fx.scale / 100 : 1;
  return px(max * s);
}

/**
 * Can this effect stack be rendered over a PADDED SUB-RECT and blitted back?
 *
 * This is a different question from `effectsReach`, and conflating them is the
 * same trap `filterReach` documents for filters. Reach answers "how far does a
 * changed pixel spread?", which is enough to pad the DIRTY RECT — the blit — and
 * every effect has a finite answer there. Rendering a sub-rect additionally
 * requires that each effect compute the same value for a pixel whether it is
 * handed the whole canvas or a window onto it.
 *
 * Most effects pass: shadows, glows, bevel and a colour stroke are all derived
 * from nearby alpha by blur/offset/threshold, so a padded window reproduces them
 * exactly. Two do NOT, because they take their geometry from the canvas they are
 * given — `cx = w/2`, `half = max(w,h)/2` — so handing them a sub-canvas silently
 * moves and rescales the gradient:
 *   - gradient overlay
 *   - stroke with a gradient fill (both the centred and the legacy
 *     top-left→bottom-right geometry depend on the canvas size)
 *
 * Returns true when the stack must take the full-canvas path. Effects that are
 * disabled cannot disqualify anything.
 */
export function effectsPositionDependent(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  if (fx.gradientOverlay?.enabled) return true;
  if (fx.stroke?.enabled && fx.stroke.fillType === "gradient") return true;
  return false;
}

/** Total reach of a node's filters AND effects (filters run first, then fx). */
export function nodeReach(
  filters: SmartFilter[] | undefined,
  fx: LayerEffects | undefined,
): Reach {
  return addReach(stackReach(filters), effectsReach(fx));
}

/** Grow a rect by `r` px and clamp it to the document. */
export function padRect(
  rect: { x: number; y: number; w: number; h: number },
  r: number,
  docW: number,
  docH: number,
): { x: number; y: number; w: number; h: number } {
  const x0 = Math.max(0, Math.floor(rect.x - r));
  const y0 = Math.max(0, Math.floor(rect.y - r));
  const x1 = Math.min(docW, Math.ceil(rect.x + rect.w + r));
  const y1 = Math.min(docH, Math.ceil(rect.y + rect.h + r));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Is a padded region worth it, or does it already cover most of the document?
 *  Below this share, region work wins; above it the bookkeeping costs more than
 *  the full pass it replaces. */
export const REGION_WORTH_IT = 0.6;

export function regionWorthIt(
  rect: { w: number; h: number },
  docW: number,
  docH: number,
): boolean {
  const doc = docW * docH;
  return doc > 0 && (rect.w * rect.h) / doc <= REGION_WORTH_IT;
}
