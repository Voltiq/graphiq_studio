// Thumbnails for the Smart Filters "Add" list — one small preview per filter
// type, rendered from the layer's own pixels so the list shows what each filter
// does to YOUR image rather than to a stock swatch.

import { applyFilter, defaultFilter, type FilterType } from "./filters";

/** Edge of the square preview, in device pixels. */
export const THUMB_SIZE = 56;

/**
 * Params are used UNSCALED at thumbnail size, which is a deliberate departure
 * from `scaleFilterParams`.
 *
 * That function exists so the half-resolution *document* preview shows the same
 * filter you will get — a proportionate preview. A picker thumbnail wants the
 * opposite thing: it has to be recognisable in a list row. Scaled
 * proportionately, a 12 px crystallize cell on a 56 px thumbnail of a 1920 px
 * layer becomes a third of a pixel and every entry renders as the same grey
 * square. Unscaled, that cell is a readable ~5 across.
 *
 * So these are ILLUSTRATIONS of each filter's character, not previews of the
 * final result. The document preview behind the dialog is the honest one.
 */
export function thumbSourceRect(
  w: number,
  h: number,
): { sx: number; sy: number; sw: number; sh: number } {
  // Cover: take the largest centred square the layer allows, so every thumbnail
  // has the same aspect and nothing is letterboxed.
  const side = Math.max(1, Math.min(w, h));
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), sw: side, sh: side };
}

/** True when a thumbnail source carries no visible pixels — the caller should
 *  fall back to plain icons rather than render a row of empty squares. */
export function isBlank(src: ImageData): boolean {
  const d = src.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

/**
 * Render one preview per type. Pure apart from the ImageData it is handed, and
 * returns raw ImageData so the caller owns all canvas work.
 *
 * Cost is negligible by construction: the most expensive filter in the set is
 * ~318 ms over 2.07 MP, which at 40×40 is well under a millisecond, so the whole
 * list costs a few ms even with every type enabled.
 */
export function renderFilterThumbs(
  src: ImageData,
  types: readonly FilterType[],
  space: PredefinedColorSpace,
): Map<FilterType, ImageData> {
  const out = new Map<FilterType, ImageData>();
  for (const t of types) {
    try {
      out.set(t, applyFilter(src, defaultFilter(t), space));
    } catch {
      // A broken preview must never take the picker down with it: the row
      // simply falls back to its icon.
    }
  }
  return out;
}
