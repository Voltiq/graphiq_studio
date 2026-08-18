import type { ShapeKind } from "./tools";
import { fitPathToBox, parsePath, pathToD } from "./svgpath";
import type { Rect } from "./view";

/** A 2D context that may have the (newer) roundRect method. */
type ShapeCtx = CanvasRenderingContext2D & {
  roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
};

/** Add a (possibly rounded) rectangle as a sub-path (no beginPath). */
function rectSubpath(ctx: ShapeCtx, x: number, y: number, w: number, h: number, r: number) {
  if (r > 0 && typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * Trace a shape's path into `ctx` within the box (x, y, w, h) — which should
 * already be inset by half the stroke width so the stroke stays inside it.
 * Shared by the live preview (CanvasArea) and the rasterizer (PaintEngine) so
 * the drawn shape matches the preview exactly.
 */
/**
 * A custom shape's path, fitted into the box.
 *
 * Returns null rather than an empty path when there is nothing to draw, so the
 * caller can skip painting entirely instead of filling a degenerate region.
 */
export function customPath(d: string | undefined, box: Rect): Path2D | null {
  if (!d) return null;
  const segs = fitPathToBox(parsePath(d), box);
  if (!segs.length) return null;
  return new Path2D(pathToD(segs));
}

export function shapePath(
  ctx: ShapeCtx,
  kind: ShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  customD?: string,
) {
  ctx.beginPath();
  if (kind === "custom") {
    // Traced segment by segment rather than via Path2D: this variant exists so
    // callers can keep adding to the same context path (hit-testing, clipping),
    // and a Path2D cannot be merged into one.
    if (customD) {
      for (const sg of fitPathToBox(parsePath(customD), { x, y, w, h })) {
        if (sg.c === "M") ctx.moveTo(sg.x, sg.y);
        else if (sg.c === "L") ctx.lineTo(sg.x, sg.y);
        else if (sg.c === "C") ctx.bezierCurveTo(sg.x1, sg.y1, sg.x2, sg.y2, sg.x, sg.y);
        else ctx.closePath();
      }
    }
    return;
  }
  if (kind === "ellipse") {
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
  } else if (kind === "tri") {
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  } else {
    rectSubpath(ctx, x, y, w, h, Math.max(0, Math.min(radius, w / 2, h / 2)));
  }
}

interface Pt {
  x: number;
  y: number;
}

/** Trapezoid top-edge insets, as fractions (0..0.5) of the box width per side. */
export interface TrapInsets {
  l: number;
  r: number;
}

/** Star geometry: how many points, how deep the waist, and its rotation. */
export interface StarGeom {
  /** Number of points (spikes). */
  points: number;
  /** Inner radius as a fraction (0..1) of the outer. 1 = a regular polygon. */
  inner: number;
  /** Rotation in degrees, clockwise; 0 puts a point straight up. */
  angle: number;
}

export const STAR_MIN_POINTS = 3;
export const STAR_MAX_POINTS = 24;
export const STAR_DEFAULT: StarGeom = { points: 5, inner: 0.382, angle: 0 };

/** Extra, node-adjustable geometry for shapes that have it. */
export interface ShapeGeom {
  /** Star: point count, waist and rotation. */
  star?: StarGeom;
  /** Custom shapes: the preset's path, normalized to the unit square.
   *  Carried here rather than looked up by id so the geometry travels WITH the
   *  layer — a document keeps its shape after the preset is renamed or deleted,
   *  and the rasterizer never has to reach into a library. */
  customD?: string;
  /** Trapezoid: top-edge insets per side. */
  trap?: TrapInsets;
  /** Triangle: apex horizontal position, as a fraction (0..1) of the box width. */
  apex?: number;
}

/** The three corners of the triangle in `box` (apex on the top edge at `apex`).
 *  Exported for the SVG exporter, which mirrors renderShape's exact geometry. */
export function triPoints(box: Rect, apex = 0.5): Pt[] {
  return [
    { x: box.x + Math.max(0, Math.min(1, apex)) * box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
}

/** The four corners of a trapezoid in `box`: full-width bottom, inset top. */
export function trapPoints(box: Rect, trap: TrapInsets): Pt[] {
  const l = Math.max(0, Math.min(0.5, trap.l));
  const r = Math.max(0, Math.min(0.5, trap.r));
  return [
    { x: box.x + l * box.w, y: box.y }, // top-left
    { x: box.x + box.w - r * box.w, y: box.y }, // top-right
    { x: box.x + box.w, y: box.y + box.h }, // bottom-right
    { x: box.x, y: box.y + box.h }, // bottom-left
  ];
}

/** Clamp a star's parameters into the range the UI and renderer both assume. */
export function sanitizeStar(s?: Partial<StarGeom> | null): StarGeom {
  const n = Math.round(Number(s?.points));
  const inner = Number(s?.inner);
  const angle = Number(s?.angle);
  return {
    points: Number.isFinite(n) ? Math.max(STAR_MIN_POINTS, Math.min(STAR_MAX_POINTS, n)) : STAR_DEFAULT.points,
    // Never 0: a zero waist collapses every spike to the centre, which is not a
    // shape so much as a set of lines.
    inner: Number.isFinite(inner) ? Math.max(0.05, Math.min(1, inner)) : STAR_DEFAULT.inner,
    // Rotation WRAPS rather than clamping — it is a direction, not a limit.
    angle: Number.isFinite(angle) ? ((((angle + 180) % 360) + 360) % 360) - 180 : 0,
  };
}

/**
 * The 2·n vertices of a star inscribed in `box`, alternating outer and inner,
 * starting at the outer point at the top (before rotation).
 *
 * Inscribed in the box's ELLIPSE, not its circle: a wide box gives a wide star,
 * the same way the triangle and trapezoid fill whatever box they are given
 * rather than staying regular inside it.
 */
export function starPoints(box: Rect, star: StarGeom): Pt[] {
  const { points, inner, angle } = sanitizeStar(star);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2;
  const ry = box.h / 2;
  const start = -Math.PI / 2 + (angle * Math.PI) / 180; // 0° = a point straight up
  const step = Math.PI / points; // alternating vertices are half a point apart
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const t = start + i * step;
    const r = i % 2 === 0 ? 1 : inner;
    out.push({ x: cx + rx * r * Math.cos(t), y: cy + ry * r * Math.sin(t) });
  }
  return out;
}

/**
 * The waist ratio at which a star's spike edges run straight through — the
 * classic "proper" star (a pentagram at 5 points, r/R = 0.382).
 *
 * Only defined once there are enough points for the geometry to close: below 5
 * the value leaves (0,1) — at 3 points it is exactly −1 — so the caller gets
 * null and simply has one fewer snap target rather than a nonsense one.
 *
 * That is left to the RANGE check rather than an `n < 5` guard in front of it.
 * The guard was written first and turned out to be unreachable — every n it
 * rejected, the range check rejected too — so it went, on the same principle as
 * any other branch that cannot be made to fail. The n = 2, 3 and 4 cases are
 * pinned by tests, which now exercise the check that actually does the work.
 */
export function starCollinearInner(points: number): number | null {
  const n = Math.round(points);
  if (!Number.isFinite(n)) return null; // Math.round(NaN) is NaN; stop here
  const v = Math.cos((2 * Math.PI) / n) / Math.cos(Math.PI / n);
  return v > 0.02 && v < 0.999 ? v : null;
}

/** Inradius of a polygon (max inward offset before it collapses). */
export function polyInradius(pts: Pt[]): number {
  let area2 = 0;
  let peri = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
    peri += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return peri > 0 ? Math.abs(area2) / peri : 0; // = 2·area / perimeter
}

/** Offset a (convex) polygon inward by `d`, moving each vertex along its
    bisector. Returns null if `d` collapses it. */
export function insetPoly(pts: Pt[], d: number): Pt[] | null {
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    let u1x = pts[(i - 1 + n) % n].x - p1.x;
    let u1y = pts[(i - 1 + n) % n].y - p1.y;
    let u2x = pts[(i + 1) % n].x - p1.x;
    let u2y = pts[(i + 1) % n].y - p1.y;
    const l1 = Math.hypot(u1x, u1y);
    const l2 = Math.hypot(u2x, u2y);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    u1x /= l1;
    u1y /= l1;
    u2x /= l2;
    u2y /= l2;
    let bx = u1x + u2x;
    let by = u1y + u2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) return null;
    bx /= bl;
    by /= bl;
    const sinHalf = Math.sqrt(Math.max(1e-6, (1 - (u1x * u2x + u1y * u2y)) / 2));
    const t = d / sinHalf; // distance along the bisector for a perpendicular inset of d
    out.push({ x: p1.x + bx * t, y: p1.y + by * t });
  }
  return out;
}

/** Add a rounded-corner polygon as a sub-path (radius rounds each vertex). */
function roundedPolyInto(ctx: ShapeCtx, pts: Pt[], radius: number) {
  const n = pts.length;
  if (radius <= 0.01) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    return;
  }
  // Start mid-edge so the first/last arcs join cleanly.
  ctx.moveTo((pts[n - 1].x + pts[0].x) / 2, (pts[n - 1].y + pts[0].y) / 2);
  for (let i = 0; i < n; i++) {
    const c = pts[i];
    const next = pts[(i + 1) % n];
    ctx.arcTo(c.x, c.y, next.x, next.y, radius);
  }
  ctx.closePath();
}

/**
 * Render a shape (fill + stroke) into `box`. Rectangle and triangle corner radii
 * are measured at the OUTER (stroke) edge — radius 0 gives perfectly sharp
 * corners — by drawing the stroke as the ring between the outer outline and an
 * inset interior. The ellipse keeps a uniform centre-line stroke.
 */
export function renderShape(
  ctx: ShapeCtx,
  kind: ShapeKind,
  box: Rect,
  fill: string,
  stroke: string,
  strokeWidth: number,
  radius: number,
  geom?: ShapeGeom,
) {
  const sw = Math.max(0, strokeWidth);

  if (kind === "custom") {
    const path = customPath(geom?.customD, box);
    if (!path) return;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill(path, "evenodd");
    }
    if (sw > 0 && stroke) {
      // An INSIDE stroke, matching the other shapes. The ring construction they
      // use only works for rectangles and convex polygons; for an arbitrary
      // path the equivalent is to clip to it and stroke at double width, so the
      // outer half falls outside the clip and is discarded.
      ctx.save();
      ctx.clip(path, "evenodd");
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw * 2;
      ctx.lineJoin = "round";
      ctx.stroke(path);
      ctx.restore();
    }
    return;
  }

  if (kind === "rect") {
    const r = Math.max(0, Math.min(radius, Math.min(box.w, box.h) / 2));
    const hasStroke = sw > 0 && !!stroke;
    if (hasStroke) {
      const iw = Math.max(0, box.w - 2 * sw);
      const ih = Math.max(0, box.h - 2 * sw);
      const ir = Math.max(0, r - sw);
      // Stroke = the ring between the outer box and the inset interior.
      ctx.beginPath();
      rectSubpath(ctx, box.x, box.y, box.w, box.h, r);
      if (iw > 0 && ih > 0) rectSubpath(ctx, box.x + sw, box.y + sw, iw, ih, ir);
      ctx.fillStyle = stroke;
      ctx.fill("evenodd");
      if (fill && iw > 0 && ih > 0) {
        ctx.beginPath();
        rectSubpath(ctx, box.x + sw, box.y + sw, iw, ih, ir);
        ctx.fillStyle = fill;
        ctx.fill();
      }
    } else if (fill) {
      ctx.beginPath();
      rectSubpath(ctx, box.x, box.y, box.w, box.h, r);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    return;
  }

  if (kind === "star") {
    const pts = starPoints(box, sanitizeStar(geom?.star));
    // Radius is bounded by the SHORTEST edge, not by polyInradius: that measure
    // is 2·area/perimeter, which for a spiky star is far larger than any corner
    // can actually take, and over-rounding turns the spikes into blobs.
    let shortest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      shortest = Math.min(shortest, Math.hypot(b.x - a.x, b.y - a.y));
    }
    const r = Math.max(0, Math.min(radius, shortest / 2));
    ctx.beginPath();
    roundedPolyInto(ctx, pts, r);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (sw > 0 && stroke) {
      // An INSIDE stroke via clip + double width, exactly as the custom-shape
      // branch does. The inset-ring construction the triangle and trapezoid use
      // is only valid for CONVEX polygons — a star's inner vertices are reflex,
      // and offsetting them along their bisectors turns the waist inside out.
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw * 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (kind === "tri" || kind === "trapezoid") {
    const outer =
      kind === "tri"
        ? triPoints(box, geom?.apex)
        : trapPoints(box, geom?.trap ?? { l: 0.25, r: 0.25 });
    const r = Math.max(0, Math.min(radius, polyInradius(outer)));
    const hasStroke = sw > 0 && !!stroke;
    const inner = hasStroke && sw < polyInradius(outer) ? insetPoly(outer, sw) : null;
    if (inner) {
      const ir = Math.max(0, Math.min(r - sw, polyInradius(inner)));
      // Stroke = the ring between the outer triangle and the inset interior.
      ctx.beginPath();
      roundedPolyInto(ctx, outer, r);
      roundedPolyInto(ctx, inner, ir);
      ctx.fillStyle = stroke;
      ctx.fill("evenodd");
      if (fill) {
        ctx.beginPath();
        roundedPolyInto(ctx, inner, ir);
        ctx.fillStyle = fill;
        ctx.fill();
      }
    } else {
      // No stroke (or it's thicker than the triangle): one solid fill.
      ctx.beginPath();
      roundedPolyInto(ctx, outer, r);
      ctx.fillStyle = hasStroke ? stroke : fill;
      ctx.fill();
    }
    return;
  }

  // Ellipse: stroke centred on a path inset by half the stroke (no corners).
  const inset = sw / 2;
  const x = box.x + inset;
  const y = box.y + inset;
  const w = Math.max(0, box.w - sw);
  const h = Math.max(0, box.h - sw);
  shapePath(ctx, "ellipse", x, y, w, h, radius);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (sw > 0 && stroke) {
    ctx.lineWidth = sw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}
