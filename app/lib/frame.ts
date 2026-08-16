/**
 * Frames — placeholder regions that clip whatever you put in them.
 *
 * Draw a frame, drop an image in, and the image is masked to the frame's shape
 * and fitted to its box; the frame and its contents then move and resize
 * independently, which is the whole point. An empty frame is a visible
 * placeholder rather than nothing, so a layout can be built before the pictures
 * exist.
 *
 * A frame is NOT a new kind of clipping. It is a layer carrying a vector mask in
 * the frame's shape plus this spec, so the existing mask pipeline does the
 * clipping — resolution-independent, already cached by path hash, already saved
 * in the project file. What this module adds is the box, the fit, and the
 * content's own offset and scale inside it.
 *
 * Pure and DOM-free.
 */

import type { PenAnchor } from "./tools";

export type FrameShape = "rect" | "ellipse";
/** How content is sized when it is first placed. */
export type FrameFit = "cover" | "contain" | "fill" | "none";

export const FRAME_FITS: { id: FrameFit; label: string }[] = [
  { id: "cover", label: "Fill frame" },
  { id: "contain", label: "Fit whole image" },
  { id: "fill", label: "Stretch" },
  { id: "none", label: "Actual size" },
];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameSpec extends FrameRect {
  shape: FrameShape;
  fit: FrameFit;
  /** Content nudge inside the frame, in doc px, applied after the fit. */
  offset: { x: number; y: number };
  /** Extra scale on top of the fit. 1 = exactly what the fit chose. */
  scale: number;
}

export function defaultFrame(r: FrameRect, shape: FrameShape = "rect"): FrameSpec {
  return { ...normalizeRect(r), shape, fit: "cover", offset: { x: 0, y: 0 }, scale: 1 };
}

/** A rect dragged up-and-left has negative width; store it the right way round. */
export function normalizeRect(r: FrameRect): FrameRect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/**
 * Where the content should be drawn.
 *
 * `cover` scales until the frame is covered and lets the overflow be clipped;
 * `contain` scales until the whole image fits and leaves gaps; `fill` stretches
 * both axes independently; `none` uses the natural size. The user's own scale
 * and offset apply on top, about the frame's CENTRE — nudging content and then
 * scaling it should not also slide it, which is what scaling about a corner
 * would do.
 */
export function fitContent(
  contentW: number,
  contentH: number,
  frame: FrameSpec,
): FrameRect {
  const fw = frame.w;
  const fh = frame.h;
  // A frame or an image with no area has no sensible placement; returning the
  // frame keeps every caller's arithmetic finite instead of spreading NaN.
  if (!(contentW > 0 && contentH > 0 && fw > 0 && fh > 0)) {
    return { x: frame.x, y: frame.y, w: fw, h: fh };
  }
  const sx = fw / contentW;
  const sy = fh / contentH;
  let w: number;
  let h: number;
  if (frame.fit === "fill") {
    w = fw;
    h = fh;
  } else {
    const k = frame.fit === "cover" ? Math.max(sx, sy) : frame.fit === "contain" ? Math.min(sx, sy) : 1;
    w = contentW * k;
    h = contentH * k;
  }
  const s = Math.max(0.01, frame.scale);
  w *= s;
  h *= s;
  return {
    x: frame.x + (fw - w) / 2 + frame.offset.x,
    y: frame.y + (fh - h) / 2 + frame.offset.y,
    w,
    h,
  };
}

const corner = (x: number, y: number): PenAnchor => ({ x, y, ix: x, iy: y, ox: x, oy: y });

/** Circle-to-bezier constant: handle length that makes four cubics a circle. */
const KAPPA = 0.5522847498307936;

/**
 * The frame's outline as pen anchors, ready to become a vector mask.
 *
 * Returned in the same representation the mask pipeline already consumes, so a
 * frame clips through exactly the code an ordinary vector mask does — no second
 * clipping path to keep in step.
 */
export function framePath(f: FrameSpec): PenAnchor[] {
  const { x, y, w, h } = normalizeRect(f);
  if (f.shape === "ellipse") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return [
      { x: cx, y: cy - ry, ix: cx - kx, iy: cy - ry, ox: cx + kx, oy: cy - ry },
      { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ky, ox: cx + rx, oy: cy + ky },
      { x: cx, y: cy + ry, ix: cx + kx, iy: cy + ry, ox: cx - kx, oy: cy + ry },
      { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ky, ox: cx - rx, oy: cy - ky },
    ];
  }
  return [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)];
}

/** A frame with nothing in it yet — drawn as a placeholder, not as empty space. */
export const isEmptyFrame = (f: FrameSpec | undefined, hasContent: boolean): boolean =>
  !!f && !hasContent;

export function sanitizeFrame(raw: unknown): FrameSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Partial<FrameSpec>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const w = num(o.w, 0);
  const h = num(o.h, 0);
  if (w <= 0 || h <= 0) return undefined; // a frame with no area is not a frame
  const off = (o.offset ?? {}) as { x?: number; y?: number };
  return {
    x: num(o.x, 0),
    y: num(o.y, 0),
    w,
    h,
    shape: o.shape === "ellipse" ? "ellipse" : "rect",
    fit: FRAME_FITS.some((f) => f.id === o.fit) ? (o.fit as FrameFit) : "cover",
    offset: { x: num(off.x, 0), y: num(off.y, 0) },
    scale: Math.max(0.01, Math.min(100, num(o.scale, 1))),
  };
}

/** Move the frame AND its content together (dragging the frame itself). */
export function moveFrame(f: FrameSpec, dx: number, dy: number): FrameSpec {
  return { ...f, x: f.x + dx, y: f.y + dy };
}

/**
 * Resize the frame without moving its content.
 *
 * The offset is measured from the frame's centre, so growing the frame would
 * otherwise drag the content along with the centre. Compensating keeps the
 * picture still while the window over it changes — which is what resizing a
 * frame is for.
 */
export function resizeFrame(f: FrameSpec, r: FrameRect): FrameSpec {
  const n = normalizeRect(r);
  const dcx = n.x + n.w / 2 - (f.x + f.w / 2);
  const dcy = n.y + n.h / 2 - (f.y + f.h / 2);
  return { ...f, ...n, offset: { x: f.offset.x - dcx, y: f.offset.y - dcy } };
}
