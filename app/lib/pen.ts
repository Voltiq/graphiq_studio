import type { PenAnchor, PenSettings } from "./tools";

export interface Pt {
  x: number;
  y: number;
}

interface Sample {
  x: number;
  y: number;
  tx: number; // unit tangent (from point central differences — robust at corners)
  ty: number;
  k: number; // curvature of the bezier segment at this point (0 where straight)
  t: number; // 0..1 along the whole path
}

const STEPS = 24; // samples per cubic segment
const BEND_REF = 110; // curve radius (px) at/under which `bend` reaches full effect
const BEND_SMOOTH = 4; // samples each side to soften curvature steps at anchors

/** The cubic segments of a path (each as its 4 control points). */
function segments(anchors: PenAnchor[], closed: boolean): [PenAnchor, PenAnchor][] {
  const segs: [PenAnchor, PenAnchor][] = [];
  for (let i = 0; i < anchors.length - 1; i++) segs.push([anchors[i], anchors[i + 1]]);
  if (closed && anchors.length > 2) segs.push([anchors[anchors.length - 1], anchors[0]]);
  return segs;
}

/** Trace a path into `ctx` as connected cubic beziers (no fill/stroke). */
export function penPath(ctx: CanvasRenderingContext2D, anchors: PenAnchor[], closed: boolean) {
  if (anchors.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(anchors[0].x, anchors[0].y);
  for (const [a, b] of segments(anchors, closed)) {
    ctx.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
  }
  if (closed) ctx.closePath();
}

/**
 * Sample a path into points carrying a unit tangent, the bezier's own curvature,
 * and a global t. Tangents come from point central differences (well-defined at
 * corners). Curvature is each SEGMENT's intrinsic bend — it is 0 along straight
 * segments and never sees the angle BETWEEN segments, so a sharp corner adds no
 * curvature (the "dots" don't count toward bending); only real curves do.
 */
function samplePath(anchors: PenAnchor[], closed: boolean): Sample[] {
  const segs = segments(anchors, closed);
  const pts: Pt[] = [];
  const ks: number[] = [];
  segs.forEach(([a, b], si) => {
    const last = si === segs.length - 1 && !closed;
    const x0 = a.x, y0 = a.y, x1 = a.ox, y1 = a.oy, x2 = b.ix, y2 = b.iy, x3 = b.x, y3 = b.y;
    const upper = last ? STEPS : STEPS - 1;
    for (let s = 0; s <= upper; s++) {
      const u = s / STEPS;
      const mu = 1 - u;
      pts.push({
        x: mu * mu * mu * x0 + 3 * mu * mu * u * x1 + 3 * mu * u * u * x2 + u * u * u * x3,
        y: mu * mu * mu * y0 + 3 * mu * mu * u * y1 + 3 * mu * u * u * y2 + u * u * u * y3,
      });
      const dx = 3 * mu * mu * (x1 - x0) + 6 * mu * u * (x2 - x1) + 3 * u * u * (x3 - x2);
      const dy = 3 * mu * mu * (y1 - y0) + 6 * mu * u * (y2 - y1) + 3 * u * u * (y3 - y2);
      const ddx = 6 * mu * (x2 - 2 * x1 + x0) + 6 * u * (x3 - 2 * x2 + x1);
      const ddy = 6 * mu * (y2 - 2 * y1 + y0) + 6 * u * (y3 - 2 * y2 + y1);
      const sp = Math.hypot(dx, dy);
      // Guard the degenerate endpoint (zero-length handle) — its curvature is
      // ill-defined; the bezier is straight/cusped there, so treat it as 0.
      ks.push(sp < 1e-3 ? 0 : Math.abs(dx * ddy - dy * ddx) / (sp * sp * sp));
    }
  });
  const n = pts.length;
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1e-6;
    out.push({
      x: pts[i].x,
      y: pts[i].y,
      tx: tx / len,
      ty: ty / len,
      k: ks[i],
      t: n > 1 ? i / (n - 1) : 0.5,
    });
  }
  return out;
}

/** Per-sample bend amount (0..1) from segment curvature, lightly smoothed so the
 *  width transitions are gradual (no steps at curvature changes). */
function bendAmounts(samp: Sample[], closed: boolean): number[] {
  const n = samp.length;
  const raw = samp.map((s) => Math.min(1, s.k * BEND_REF));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let d = -BEND_SMOOTH; d <= BEND_SMOOTH; d++) {
      let k = i + d;
      if (closed) k = ((k % n) + n) % n;
      else if (k < 0 || k >= n) continue;
      sum += raw[k];
      cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

/**
 * Render the variable-width stroke of a pen path. Builds the offset band on both
 * sides of the sampled curve and unions it with round circles at every sample —
 * a single fill, so round caps/joins come for free and a translucent colour never
 * doubles up over overlaps.
 */
export function renderPenStroke(
  ctx: CanvasRenderingContext2D,
  anchors: PenAnchor[],
  closed: boolean,
  o: PenSettings,
  color: string,
) {
  if (anchors.length < 2 || o.width <= 0) return;
  const samp = samplePath(anchors, closed);
  if (samp.length < 2) return;
  // Half-width per sample: base, optional end taper, optional bend-driven widening.
  const bend = o.bend !== 0 ? bendAmounts(samp, closed) : null;
  const half = samp.map((s, i) => {
    let f = 1;
    if (!closed && o.taper > 0) f *= 1 - o.taper + o.taper * Math.sin(Math.PI * s.t);
    if (bend) f *= 1 + o.bend * bend[i];
    return Math.max(0, (o.width * Math.max(0, f)) / 2);
  });
  // Offset points on each side: normal = tangent rotated 90° = (-ty, tx).
  const left = samp.map((s, i) => ({ x: s.x - s.ty * half[i], y: s.y + s.tx * half[i] }));
  const right = samp.map((s, i) => ({ x: s.x + s.ty * half[i], y: s.y - s.tx * half[i] }));

  // Build the stroke as a UNION of per-segment quads plus a circle at every
  // sample (round joins + caps). Every ring is emitted with a consistent
  // orientation so a single nonzero fill never cancels overlaps (which made the
  // old single band vanish where strokes crossed) and leaves no seams.
  const n = samp.length;
  const segCount = closed ? n : n - 1;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    ringInto(ctx, [left[i], right[i], right[j], left[j]]);
  }
  for (let i = 0; i < n; i++) {
    if (half[i] > 0.05) ringInto(ctx, circlePoints(samp[i].x, samp[i].y, half[i]));
  }
  ctx.fill(); // nonzero — all rings share an orientation, so overlaps add (never cancel)
  ctx.restore();
}

/** Signed area (shoelace) — used to normalise ring orientation. */
function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** Add a closed ring, forced to a positive orientation for clean nonzero union. */
function ringInto(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  const ring = signedArea(pts) < 0 ? [...pts].reverse() : pts;
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
  ctx.closePath();
}

/** A circle approximated as a polygon (so its winding can be normalised). */
function circlePoints(cx: number, cy: number, r: number): Pt[] {
  const steps = Math.max(12, Math.min(48, Math.ceil(r * 1.4)));
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}
