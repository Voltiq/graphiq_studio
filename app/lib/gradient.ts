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
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
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
  const k = Math.log(0.5) / Math.log(clamp(midpoint, 0.02, 0.98));
  const N = 64;

  // Angle gradients wrap from the last colour back to the first at the start
  // line, leaving a hard seam. "Smooth" squeezes the band into [eps, 1-eps] and
  // fills the wrap with a blend that meets the same colour on both sides, so the
  // seam becomes continuous instead of a sharp edge.
  if (type === "angle" && smooth) {
    const eps = 0.05;
    const startCol = sampleGradient(sorted, 0);
    const endCol = sampleGradient(sorted, 1);
    const seam = mix(endCol, startCol, 0.5);
    for (let i = 0; i <= N; i++) {
      const v = i / N;
      let color: string;
      if (v <= eps) color = mix(seam, startCol, v / eps);
      else if (v >= 1 - eps) color = mix(endCol, seam, (v - (1 - eps)) / eps);
      else color = sampleGradient(sorted, Math.pow((v - eps) / (1 - 2 * eps), k));
      g.addColorStop(v, color);
    }
    return g;
  }

  for (let i = 0; i <= N; i++) {
    const v = i / N;
    const natural = type === "reflected" ? Math.abs(2 * v - 1) : v;
    g.addColorStop(v, sampleGradient(sorted, Math.pow(natural, k)));
  }
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
