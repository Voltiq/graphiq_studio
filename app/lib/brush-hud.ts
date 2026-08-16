// The on-canvas brush HUD: Alt + right-drag anywhere on the canvas sets the
// active brush's SIZE (horizontal travel) and HARDNESS (vertical travel), with
// a live preview of the tip under the pointer. It is the same numbers the
// options-bar sliders hold — this is a second way to reach them, not a second
// set of settings — so nothing here touches the document or the history.
//
// Everything below is pure arithmetic so the mapping can be pinned in Node;
// the drawing and the pointer plumbing live in CanvasArea.

/** Every ring-cursor tool, and whether it has a hardness to drive.
 *
 *  Quick Select and Red Eye stamp a plain disc — their ring is drawn at
 *  hardness 100 because there is no soft edge to show. The Pencil is hard by
 *  definition (its options bar has no Hardness slider either), so offering the
 *  vertical axis there would write a number nothing reads. */
export const HUD_TOOLS: Readonly<Record<string, boolean>> = {
  brush: true,
  eraser: true,
  pencil: false,
  heal: true,
  clone: true,
  blur: true,
  smudge: true,
  mixer: true,
  dodge: true,
  sponge: true,
  history: true,
  quickselect: false,
  redeye: false,
};

/** Does this tool take the HUD at all? */
export function hudSupports(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(HUD_TOOLS, tool);
}

/** Does the HUD's vertical axis do anything for this tool? */
export function hudHasHardness(tool: string): boolean {
  return HUD_TOOLS[tool] === true;
}

/** Diameter range, matching the options-bar Size sliders. */
export const HUD_SIZE_MIN = 1;
export const HUD_SIZE_MAX = 500;
/** Vertical travel, in screen px, for a full 0 → 100 hardness sweep. */
export const HUD_HARDNESS_SPAN = 200;
/** Opacity of the preview disc at full coverage. The disc's alpha is the tip's
 *  coverage times exactly this — one constant, nothing composited underneath —
 *  so the preview stays a faithful reading of the tip rather than a picture of
 *  one. */
export const HUD_VEIL = 0.62;

/** Horizontal travel → diameter.
 *
 *  The drag is divided by the zoom, which means one screen pixel of travel is
 *  one screen pixel of ring DIAMETER at every zoom level: the ring grows
 *  exactly under the pointer whether you are at 25% or 800%. Feeding screen px
 *  straight into a document measurement instead would make the ring crawl when
 *  zoomed in and bolt away when zoomed out — the same gesture doing visibly
 *  different things depending on the view. */
export function hudSize(startSize: number, dxScreen: number, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const dx = Number.isFinite(dxScreen) ? dxScreen : 0;
  const base = Number.isFinite(startSize) ? startSize : HUD_SIZE_MIN;
  return Math.max(HUD_SIZE_MIN, Math.min(HUD_SIZE_MAX, Math.round(base + dx / s)));
}

/** Vertical travel → hardness. Up is harder, so the gesture runs the same way
 *  as the value: further up the screen = further up the scale. Screen px are
 *  NOT divided by the zoom here — hardness is a percentage, not a length, so
 *  there is nothing on screen for it to stay in step with. */
export function hudHardness(startHardness: number, dyScreen: number): number {
  const dy = Number.isFinite(dyScreen) ? dyScreen : 0;
  const base = Number.isFinite(startHardness) ? startHardness : 100;
  return Math.max(0, Math.min(100, Math.round(base - (dy / HUD_HARDNESS_SPAN) * 100)));
}

/** Tip coverage at `t` (0 = centre, 1 = rim) for a given hardness.
 *
 *  This is the profile `PaintEngine.buildSoftTip` bakes — a solid core out to
 *  `hardness/100` of the radius, then a linear ramp to nothing at the rim — so
 *  the HUD's preview disc is the tip you are about to paint with rather than a
 *  decorative gradient that merely looks soft. At hardness 100 the engine
 *  switches to its aliased hard tip, which is a flat disc with no ramp at all. */
export function hudAlphaAt(t: number, hardness: number): number {
  if (!Number.isFinite(t) || t < 0) return 1;
  if (t >= 1) return 0;
  const h = Math.max(0, Math.min(100, Number.isFinite(hardness) ? hardness : 100));
  // Hardness 100 needs no special case: the core reaches the rim, so the two
  // lines below already give the flat disc the engine's hard tip paints. (Note
  // the deliberate difference from buildSoftTip, which caps its core at 0.999
  // of the radius — it only ever sees hardness < 100, because at 100 the engine
  // has already switched to the aliased hard tip.)
  const inner = h / 100;
  if (t <= inner) return 1;
  return 1 - (t - inner) / (1 - inner);
}

/** The HUD's one line of text. `hardness` is null for the tools that have none. */
export function hudReadout(size: number, hardness: number | null): string {
  const px = `${Math.round(size)} px`;
  return hardness === null ? `Size ${px}` : `Size ${px} · Hardness ${Math.round(hardness)}%`;
}
