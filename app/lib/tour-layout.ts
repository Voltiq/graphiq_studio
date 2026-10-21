// Where the tour's card goes, and whether a stop's chrome is there to point at.
// Pure geometry in viewport px, so it is tested without a browser; TourOverlay
// measures the page and feeds it in.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which side of its target the card sits on. `inset` is INSIDE a target too big
 * to stand beside (the canvas fills most of the window); `center` is a stop
 * with no target at all.
 */
export type Side = "below" | "above" | "right" | "left" | "inset" | "center";

export interface Placement {
  x: number;
  y: number;
  side: Side;
  /** Where the caret meets the card's edge, in px along that edge (from its
   *  left for below/above, from its top for right/left) — pointing at the
   *  target's centre. Null when there is no caret to draw. */
  arrow: number | null;
}

/** The spotlight's margin round its target. */
export const PAD = 6;
/** ...and how far inside the view it is kept, so its ring is never cut off. */
const EDGE = 2;
/** The card stands this far from the target it points at (room for the caret). */
export const GAP = 16;
/** ...and at least this far inside the visible area. */
export const MARGIN = 12;
/** The caret stays this far from the card's corners. */
const ARROW_INSET = 22;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), Math.max(lo, hi));

/** The share of `r` inside `view`, 0–1 (0 for an empty box). */
export function visibleFraction(r: Box, view: Box): number {
  const area = r.w * r.h;
  if (area <= 0) return 0;
  const w = Math.min(r.x + r.w, view.x + view.w) - Math.max(r.x, view.x);
  const h = Math.min(r.y + r.h, view.y + view.h) - Math.max(r.y, view.y);
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

/**
 * Is a stop's chrome on screen enough to be shown? At least half of it inside
 * the view, and big enough to see. A closed drawer (parked off the side), a
 * hidden panel (0×0) and a sheet below the fold all fail — and the tour skips
 * the stop rather than spotlight an empty rectangle.
 */
export function isShown(r: Box | null, view: Box): boolean {
  return !!r && r.w >= 8 && r.h >= 8 && visibleFraction(r, view) >= 0.5;
}

/**
 * The spotlight round a target: PAD clear of it, but kept EDGE inside the
 * view — so a bar that runs to the edge of the screen (the phone's header) is
 * ringed all the way round rather than underlined, the rest of its ring off
 * the screen. `r` is the corner radius it takes, the target's own plus PAD.
 */
export function spotlight(t: Box, radius: number, view: Box): Box & { r: number } {
  const x0 = Math.max(t.x - PAD, view.x + EDGE);
  const y0 = Math.max(t.y - PAD, view.y + EDGE);
  const x1 = Math.min(t.x + t.w + PAD, view.x + view.w - EDGE);
  const y1 = Math.min(t.y + t.h + PAD, view.y + view.h - EDGE);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), r: radius + PAD };
}

/**
 * The order to try the sides of a target in. A wide target (a bar across the
 * top) is best read with the card under or over it; a tall one (a rail down
 * the side) with the card beside it; anything squarer tries under first.
 */
export function sidesFor(t: Box): Side[] {
  if (t.w >= t.h * 2) return ["below", "above", "right", "left"];
  if (t.h >= t.w * 2) return ["right", "left", "below", "above"];
  return ["below", "above", "right", "left"];
}

/** The room beside the target on one side, along the axis the card stacks on. */
function room(t: Box, view: Box, side: Side): number {
  switch (side) {
    case "below":
      return view.y + view.h - (t.y + t.h);
    case "above":
      return t.y - view.y;
    case "right":
      return view.x + view.w - (t.x + t.w);
    case "left":
      return t.x - view.x;
    default:
      return 0;
  }
}

/** Card placed on one side of `t`, centred on it across, kept inside the view. */
function beside(t: Box, card: { w: number; h: number }, view: Box, side: Side): Placement {
  const loX = view.x + MARGIN;
  const hiX = view.x + view.w - MARGIN - card.w;
  const loY = view.y + MARGIN;
  const hiY = view.y + view.h - MARGIN - card.h;
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  if (side === "below" || side === "above") {
    const x = clamp(cx - card.w / 2, loX, hiX);
    const y = clamp(side === "below" ? t.y + t.h + GAP : t.y - GAP - card.h, loY, hiY);
    return { x, y, side, arrow: clamp(cx - x, ARROW_INSET, card.w - ARROW_INSET) };
  }
  const x = clamp(side === "right" ? t.x + t.w + GAP : t.x - GAP - card.w, loX, hiX);
  const y = clamp(cy - card.h / 2, loY, hiY);
  return { x, y, side, arrow: clamp(cy - y, ARROW_INSET, card.h - ARROW_INSET) };
}

/**
 * Where the card goes.
 *
 * No target: the middle of the view. Otherwise the first side (in the order
 * `sidesFor` gives) with room for the whole card; a target too big for any
 * side to have room has the card set inside it, in its lower right corner —
 * clear of the middle, where the picture is. A small target with no side that
 * fits (a phone on its side) takes the roomier of below and above and lets the
 * card overlap it rather than leave the screen; it loses its caret, which would
 * point from inside the target at itself.
 */
export function placeCard(target: Box | null, card: { w: number; h: number }, view: Box): Placement {
  if (!target) {
    return {
      x: view.x + Math.max(MARGIN, (view.w - card.w) / 2),
      y: view.y + Math.max(MARGIN, (view.h - card.h) / 2),
      side: "center",
      arrow: null,
    };
  }
  for (const side of sidesFor(target)) {
    const vertical = side === "below" || side === "above";
    const fitsAlong = vertical ? card.w <= view.w - 2 * MARGIN : card.h <= view.h - 2 * MARGIN;
    const across = vertical ? card.h : card.w;
    if (fitsAlong && room(target, view, side) >= across + GAP + MARGIN) return beside(target, card, view, side);
  }
  if (visibleFraction(target, view) * target.w * target.h >= view.w * view.h * 0.25) {
    // The lower right corner of the part of the target that is on screen.
    const inset = MARGIN + 8;
    const right = Math.min(target.x + target.w, view.x + view.w);
    const bottom = Math.min(target.y + target.h, view.y + view.h);
    return {
      x: clamp(right - inset - card.w, view.x + MARGIN, view.x + view.w - MARGIN - card.w),
      y: clamp(bottom - inset - card.h, view.y + MARGIN, view.y + view.h - MARGIN - card.h),
      side: "inset",
      arrow: null,
    };
  }
  const side = room(target, view, "below") >= room(target, view, "above") ? "below" : "above";
  const p = beside(target, card, view, side);
  const overlaps = p.y < target.y + target.h && p.y + card.h > target.y;
  return overlaps ? { ...p, arrow: null } : p;
}
