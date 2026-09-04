import { clamp, parseColor, toHex8 } from "./color";
import type { GradientStop, GradientType } from "./tools";

/** Linearly interpolate two CSS colours, returning an 8-digit hex. */
function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return toHex8({
    r: Math.round(ca.r + (cb.r - ca.r) * t),
    g: Math.round(ca.g + (cb.g - ca.g) * t),
    b: Math.round(ca.b + (cb.b - ca.b) * t),
    a: ca.a + (cb.a - ca.a) * t,
  });
}

/** Colour at parameter `u` (0..1) of a sorted stop list. */
export function sampleGradient(stops: GradientStop[], u: number): string {
  if (!stops.length) return "#00000000";
  u = clamp(u, 0, 1);
  if (u <= stops[0].pos) return stops[0].color;
  const last = stops[stops.length - 1];
  if (u >= last.pos) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (u >= a.pos && u <= b.pos) {
      const span = b.pos - a.pos;
      return span > 0 ? mix(a.color, b.color, (u - a.pos) / span) : a.color;
    }
  }
  return last.color;
}

// Conic gradients aren't in every TS lib version yet.
type ConicCtx = CanvasRenderingContext2D & {
  createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
};

/** One sampled stop of a flattened ramp: `offset` 0..1, `color` an 8-digit hex. */
export interface RampStop {
  offset: number;
  color: string;
}

/** How many samples a ramp is flattened to. Every consumer must use the same
 *  number or two renderings of one gradient stop agreeing. */
export const RAMP_SAMPLES = 64;

/**
 * A gradient flattened to evenly-spaced samples — the ONE definition of what a
 * gradient's colours are.
 *
 * `buildCanvasGradient` has always resampled to 65 stops rather than handing the
 * author's stops to canvas directly, because the midpoint power curve, the
 * reflected fold and the conic seam blend are all things `addColorStop` cannot
 * express. That resampling was inline, which was fine while canvas was the only
 * consumer. It is not: SVG export needs the same ramp, and an SVG that computed
 * its own would be a second implementation free to drift from the pixels it is
 * supposed to match. So the loop lives here and both callers consume it.
 *
 * Pure — no canvas, no DOM — which is also what makes it testable.
 */
export function gradientRamp(
  type: GradientType,
  stops: GradientStop[],
  smooth = false,
  midpoint = 0.5,
  n: number = RAMP_SAMPLES,
): RampStop[] {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  const k = Math.log(0.5) / Math.log(clamp(midpoint, 0.02, 0.98));
  const out: RampStop[] = [];

  // Angle gradients wrap from the last colour back to the first at the start
  // line, leaving a hard seam. "Smooth" squeezes the band into [eps, 1-eps] and
  // fills the wrap with a blend that meets the same colour on both sides, so the
  // seam becomes continuous instead of a sharp edge.
  if (type === "angle" && smooth) {
    const eps = 0.05;
    const startCol = sampleGradient(sorted, 0);
    const endCol = sampleGradient(sorted, 1);
    const seam = mix(endCol, startCol, 0.5);
    for (let i = 0; i <= n; i++) {
      const v = i / n;
      let color: string;
      if (v <= eps) color = mix(seam, startCol, v / eps);
      else if (v >= 1 - eps) color = mix(endCol, seam, (v - (1 - eps)) / eps);
      else color = sampleGradient(sorted, Math.pow((v - eps) / (1 - 2 * eps), k));
      out.push({ offset: v, color });
    }
    return out;
  }

  for (let i = 0; i <= n; i++) {
    const v = i / n;
    // Reflected runs the ramp out from the middle in both directions, so the
    // band is a palindrome over a span twice as wide (see the geometry below).
    const natural = type === "reflected" ? Math.abs(2 * v - 1) : v;
    out.push({ offset: v, color: sampleGradient(sorted, Math.pow(natural, k)) });
  }
  return out;
}

/**
 * Where a gradient sits over a box, in that box's own coordinates.
 *
 * Lifted out of the text renderer so SVG export can place a `<linearGradient>`
 * on exactly the line the raster ramps along. Two implementations of this would
 * be two answers to "where does the colour start", and the whole point of
 * exporting vector text is that it matches the pixels.
 *
 * Pure, and independent of both canvas and SVG.
 */
export function gradientGeometry(
  g: { type: GradientType; angle: number; scale: number },
  b: { x: number; y: number; w: number; h: number },
): { start: { x: number; y: number }; end: { x: number; y: number }; radialish: boolean } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rad = (g.angle * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const scale = g.scale || 1;
  // Linear/reflected: span the bounds ALONG the gradient direction (the box's
  // support function), so scale 1 uses the full colour range whatever the
  // block's aspect — a vertical gradient on a wide, short line still ramps
  // top-to-bottom. Radial/angle keep the corner-reaching diagonal radius.
  const halfLinear = Math.max(1, scale * ((Math.abs(dir.x) * b.w) / 2 + (Math.abs(dir.y) * b.h) / 2));
  const halfRadial = Math.max(1, (scale * Math.hypot(b.w, b.h)) / 2);
  const radialish = g.type === "radial" || g.type === "angle";
  const half = radialish ? halfRadial : halfLinear;
  // Radial/angle grow from the centre; linear/reflected run through it.
  const start = radialish ? { x: cx, y: cy } : { x: cx - dir.x * half, y: cy - dir.y * half };
  return { start, end: { x: cx + dir.x * half, y: cy + dir.y * half }, radialish };
}

/**
 * Build a CanvasGradient for the given type between `start` and `end`. `midpoint`
 * (0..1) biases where the colours' halfway point sits (a power curve), and the
 * stops are sampled densely so it works for any number of colours.
 */
export function buildCanvasGradient(
  ctx: CanvasRenderingContext2D,
  type: GradientType,
  start: { x: number; y: number },
  end: { x: number; y: number },
  midpoint: number,
  stops: GradientStop[],
  smooth = false,
): CanvasGradient {
  let g: CanvasGradient;
  if (type === "radial") {
    const radius = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    g = ctx.createRadialGradient(start.x, start.y, 0, start.x, start.y, radius);
  } else if (type === "angle") {
    const make = (ctx as ConicCtx).createConicGradient;
    const ang = Math.atan2(end.y - start.y, end.x - start.x);
    g = make
      ? make.call(ctx, ang, start.x, start.y)
      : ctx.createLinearGradient(start.x, start.y, end.x, end.y);
  } else if (type === "reflected") {
    // Symmetric about the start: the band runs from the mirror of `end` to `end`.
    g = ctx.createLinearGradient(2 * start.x - end.x, 2 * start.y - end.y, end.x, end.y);
  } else {
    g = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
  }
  /* The ramp itself is `gradientRamp` — shared with SVG export so the two can
     never disagree about a colour. Only the GEOMETRY differs between them. */
  for (const st of gradientRamp(type, stops, smooth, midpoint)) g.addColorStop(st.offset, st.color);
  return g;
}

/** Resolve a gradient's stops, defaulting to primary→secondary, applying reverse. */
export function resolveStops(
  custom: GradientStop[] | null,
  fg: string,
  bg: string,
  reverse: boolean,
): GradientStop[] {
  const base = custom && custom.length >= 2 ? custom : [
    { color: fg, pos: 0 },
    { color: bg, pos: 1 },
  ];
  return reverse ? base.map((s) => ({ color: s.color, pos: 1 - s.pos })) : base;
}
