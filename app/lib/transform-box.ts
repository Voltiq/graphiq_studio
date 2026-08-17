// Transform-box geometry: the maths behind dragging a resize handle.
//
// Used by the marquee/wand transform AND by the Move tool's always-on transform
// handles, which are the same session driven from a different box — so the rules
// below are written once and pinned in Node rather than living inside a pointer
// handler where only a browser can reach them.

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which sides of the box the dragged handle moves. A corner sets two. */
export interface BoxEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export interface ResizeBoxOptions {
  /** Shift: keep the original aspect ratio. */
  constrain?: boolean;
  /** Alt: grow/shrink about the box's centre instead of the opposite edge. */
  fromCentre?: boolean;
  /** Clamp the result into 0..clamp.w / 0..clamp.h (skipped for a rotated box,
   *  whose frame is not the canvas's). */
  clamp?: { w: number; h: number } | null;
  /** Snap the edges to whole pixels (what the committed result does anyway, so
   *  the live preview matches the outcome). */
  round?: boolean;
}

const MIN_SIDE = 1;

/**
 * Move the dragged edges of `o` to the pointer at (px, py).
 *
 * The pointer is expected in the box's OWN frame — for a rotated box the caller
 * un-rotates it first, so everything here is axis-aligned.
 */
export function resizeBox(
  o: BoxRect,
  edges: BoxEdges,
  px: number,
  py: number,
  opts: ResizeBoxOptions = {},
): BoxRect {
  const { constrain = false, fromCentre = false, clamp = null, round = false } = opts;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;

  let x0 = o.x;
  let y0 = o.y;
  let x1 = o.x + o.w;
  let y1 = o.y + o.h;

  // Free drag first: the grabbed edges follow the pointer, the others stay put.
  // Each axis is kept non-degenerate against its own opposite edge.
  if (edges.left) x0 = Math.min(px, x1 - MIN_SIDE);
  if (edges.right) x1 = Math.max(px, x0 + MIN_SIDE);
  if (edges.top) y0 = Math.min(py, y1 - MIN_SIDE);
  if (edges.bottom) y1 = Math.max(py, y0 + MIN_SIDE);

  // Alt: the box grows both ways at once, so the centre stays where it was. The
  // dragged edge still tracks the pointer exactly — it is the opposite edge that
  // moves to match, which is why this is applied to the half-extent.
  if (fromCentre) {
    if (edges.left || edges.right) {
      const half = Math.max(MIN_SIDE / 2, edges.left ? cx - x0 : x1 - cx);
      x0 = cx - half;
      x1 = cx + half;
    }
    if (edges.top || edges.bottom) {
      const half = Math.max(MIN_SIDE / 2, edges.top ? cy - y0 : y1 - cy);
      y0 = cy - half;
      y1 = cy + half;
    }
  }

  // Shift: hold the original aspect. On a corner the axis that has been dragged
  // FURTHER (in proportion to the original side) wins, so the box follows
  // whichever way the pointer is really going; on an edge handle the free axis
  // is derived from the dragged one, which is what makes a side handle scale a
  // layer uniformly instead of stretching it.
  if (constrain && o.w > 0 && o.h > 0) {
    const aspect = o.w / o.h;
    const horiz = !!(edges.left || edges.right);
    const vert = !!(edges.top || edges.bottom);
    let nw = x1 - x0;
    let nh = y1 - y0;
    if (horiz && vert) {
      if (nw / o.w >= nh / o.h) nh = nw / aspect;
      else nw = nh * aspect;
    } else if (horiz) {
      nh = nw / aspect;
    } else if (vert) {
      nw = nh * aspect;
    } else {
      return { ...o };
    }
    nw = Math.max(MIN_SIDE, nw);
    nh = Math.max(MIN_SIDE, nh);
    // Re-anchor: about the centre with Alt, otherwise about the corner or edge
    // that was NOT dragged. An un-dragged axis stays centred on itself, which is
    // what keeps an edge-handle drag from sliding the box sideways.
    if (fromCentre) {
      x0 = cx - nw / 2;
      x1 = cx + nw / 2;
      y0 = cy - nh / 2;
      y1 = cy + nh / 2;
    } else {
      if (edges.left) x0 = x1 - nw;
      else if (edges.right) x1 = x0 + nw;
      else {
        const mid = (x0 + x1) / 2;
        x0 = mid - nw / 2;
        x1 = mid + nw / 2;
      }
      if (edges.top) y0 = y1 - nh;
      else if (edges.bottom) y1 = y0 + nh;
      else {
        const mid = (y0 + y1) / 2;
        y0 = mid - nh / 2;
        y1 = mid + nh / 2;
      }
    }
  }

  // Clamping runs LAST and only without a constraint: pushing an edge back
  // inside the canvas changes one side's length, which would silently break the
  // aspect the user asked for. Photoshop lets a constrained transform run off
  // the canvas for the same reason.
  if (clamp && !constrain) {
    x0 = Math.max(0, Math.min(clamp.w, x0));
    x1 = Math.max(0, Math.min(clamp.w, x1));
    y0 = Math.max(0, Math.min(clamp.h, y0));
    y1 = Math.max(0, Math.min(clamp.h, y1));
  }

  if (round) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
  }

  return { x: x0, y: y0, w: Math.max(MIN_SIDE, x1 - x0), h: Math.max(MIN_SIDE, y1 - y0) };
}

/** Reach of the Move box's rotate zone, in SCREEN px out from a corner. */
export const MOVE_ROTATE_REACH = 22;

/**
 * Is (px, py) in the Move box's rotate zone — just outside one of its corners?
 *
 * The marquee's rotate zone is a 44 px band around the WHOLE outline, which is
 * right there because nothing else is competing for those pixels. On the Move
 * tool it would be a trap: the band lies over the neighbouring artwork, so
 * clicking a layer beside the active one would spin that one instead of
 * selecting this one. Corners only, and half the reach.
 */
export function inRotateZone(
  box: BoxRect,
  px: number,
  py: number,
  reach: number = MOVE_ROTATE_REACH,
): boolean {
  const inside =
    px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
  if (inside) return false;
  for (const [cx, cy] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ]) {
    if (Math.hypot(px - cx, py - cy) <= reach) return true;
  }
  return false;
}

/** Why a layer cannot show transform handles — or null when it can. */
export type TransformBlock = "no-layer" | "locked" | "empty" | null;

/**
 * Should the Move tool draw transform handles?
 *
 * The rule is deliberately the same one that decides whether a MOVE is allowed,
 * plus "there is something to put a box around": a handle you cannot drag is a
 * worse affordance than no handle at all.
 */
export function transformBlock(
  activeLayerId: string | null,
  moveBlocked: boolean,
  bounds: BoxRect | null,
): TransformBlock {
  if (!activeLayerId) return "no-layer";
  if (moveBlocked) return "locked";
  if (!bounds || bounds.w < 1 || bounds.h < 1) return "empty";
  return null;
}
