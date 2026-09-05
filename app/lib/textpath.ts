/**
 * Text on a path — arc-length parameterization, and one placement per glyph.
 *
 * The existing text renderer is RUN-based: it measures a run, gets a width, and
 * paints the whole string at one position with one baseline. That is the right
 * shape for straight text and the wrong one here, because on a curve every
 * character sits somewhere else and points somewhere else. So this module
 * produces a placement PER GLYPH — a point and an angle — and the renderer's job
 * becomes translate, rotate, draw one character.
 *
 * THE PART THAT IS EASY TO GET SUBTLY WRONG, and the reason for the shape below:
 * a glyph must be positioned by its CENTRE, not by its left edge. Advancing to
 * the left edge and rotating there is the obvious implementation and it splays
 * letters outward on tight curves — each glyph pivots about its start, so the
 * further right a pixel is, the further it swings off the curve, and the error
 * grows with the glyph's own width. Placing the centre on the curve and rotating
 * about it halves the worst-case error and, more importantly, makes it symmetric
 * about the stem instead of trailing off one side. `tests/textpath.test.ts`
 * pins that with a glyph on a circle.
 *
 * WHAT "ALONG THE PATH" MEANS NUMERICALLY: a cubic has no closed-form arc
 * length, so the path is flattened to a polyline once and a cumulative length
 * table is built alongside it. Every later question — where is arc length s,
 * which way does the curve point there — is then a binary search and a lerp,
 * which is both exact enough for type and fast enough to run per glyph on every
 * frame of a drag.
 *
 * Pure: no canvas, no DOM. Measurement is injected exactly as `layoutRuns` does
 * it, which is what lets the whole of this file be tested as arithmetic.
 */

import type { PathSeg } from "./svgpath";
import type { MeasureFn } from "./richtext";
import { normalizeRuns, renderedText } from "./richtext";
import type { TextRun, TextRunStyle } from "./tools";

/** A point on the flattened path, with the direction the path points there. */
export interface PathPoint {
  x: number;
  y: number;
  /** Tangent direction in radians, atan2-style (0 = →, +y is down). */
  angle: number;
}

/**
 * A path reduced to a polyline plus the running distance along it.
 *
 * `cum[i]` is the distance from the start to `pts[i]`, so `cum[0]` is 0 and
 * `cum[cum.length - 1]` is `length`. Keeping them parallel rather than storing
 * per-segment lengths is what makes the lookup a binary search.
 */
export interface FlatPath {
  pts: { x: number; y: number }[];
  cum: number[];
  length: number;
}

/**
 * How finely a cubic is diced, in samples per unit of control-polygon length.
 *
 * Uniform subdivision would spend the same effort on a 4px curve and a 4000px
 * one. Scaling by the control polygon — an upper bound on the true arc length —
 * gives roughly even spacing in document pixels, and the clamps keep a
 * degenerate curve from producing either two samples or a hundred thousand.
 */
const SAMPLES_PER_PX = 0.5;
const MIN_CUBIC_SAMPLES = 4;
const MAX_CUBIC_SAMPLES = 240;

function cubicAt(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Flatten path segments to a polyline with a cumulative length table.
 *
 * `Z` closes back to the subpath's start, which matters for text: a closed
 * circle has to be able to carry a word across the seam rather than stopping
 * just short of it.
 *
 * ONLY THE FIRST SUBPATH IS USED. A second `M` starts a new subpath, and text
 * cannot be on two paths at once — running them together would silently teleport
 * a word across the gap between them, which looks like a bug and cannot be
 * distinguished from one. The caller is told by way of `pts` simply ending.
 */
export function flattenPath(segs: PathSeg[]): FlatPath {
  const pts: { x: number; y: number }[] = [];
  let cur: { x: number; y: number } | null = null;
  let sub: { x: number; y: number } | null = null;
  let started = false;

  const push = (p: { x: number; y: number }) => {
    const last = pts[pts.length - 1];
    // Duplicate vertices contribute zero-length spans, which would put a NaN
    // angle in the table the moment a lookup landed on one.
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) pts.push(p);
  };

  for (const s of segs) {
    if (s.c === "M") {
      if (started) break; // a second subpath — see the note above
      started = true;
      cur = { x: s.x, y: s.y };
      sub = cur;
      push(cur);
    } else if (s.c === "L") {
      if (!cur) continue;
      cur = { x: s.x, y: s.y };
      push(cur);
    } else if (s.c === "C") {
      if (!cur) continue;
      const p0 = cur;
      const p1 = { x: s.x1, y: s.y1 };
      const p2 = { x: s.x2, y: s.y2 };
      const p3 = { x: s.x, y: s.y };
      const poly =
        Math.hypot(p1.x - p0.x, p1.y - p0.y) +
        Math.hypot(p2.x - p1.x, p2.y - p1.y) +
        Math.hypot(p3.x - p2.x, p3.y - p2.y);
      const n = Math.max(
        MIN_CUBIC_SAMPLES,
        Math.min(MAX_CUBIC_SAMPLES, Math.ceil(poly * SAMPLES_PER_PX)),
      );
      for (let i = 1; i <= n; i++) push(cubicAt(p0, p1, p2, p3, i / n));
      cur = p3;
    } else if (s.c === "Z") {
      if (sub) {
        push({ x: sub.x, y: sub.y });
        cur = { x: sub.x, y: sub.y };
      }
    }
  }

  const cum: number[] = pts.length ? [0] : [];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, length: cum.length ? cum[cum.length - 1] : 0 };
}

/**
 * The point at arc length `s`, and the direction the path points there.
 *
 * `s` outside the path is CLAMPED rather than wrapped or refused: the caller
 * decides what to do with a glyph that ran off the end (see `layoutTextOnPath`,
 * which drops them), and clamping keeps this function total so a rounding error
 * at the very end cannot produce a null in the middle of a word.
 */
export function pathPointAt(fp: FlatPath, s: number): PathPoint | null {
  const p = positionAt(fp, s);
  if (!p) return null;
  return { x: p.x, y: p.y, angle: tangentAt(fp, s) };
}

/** Position only — the half of the lookup that has no opinion about direction. */
function positionAt(fp: FlatPath, s: number): { x: number; y: number } | null {
  const n = fp.pts.length;
  if (n === 0) return null;
  if (n === 1) return { x: fp.pts[0].x, y: fp.pts[0].y };
  const target = Math.max(0, Math.min(fp.length, s));

  // Binary search for the last vertex at or before `target`.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fp.cum[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.min(lo, n - 2);
  const a = fp.pts[i];
  const b = fp.pts[i + 1];
  const span = fp.cum[i + 1] - fp.cum[i];
  const t = span > 0 ? (target - fp.cum[i]) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * How far either side of a sample the tangent is measured. See below.
 */
const TANGENT_EPS = 1.5;

/**
 * The direction the path points at arc length `s`, by central difference.
 *
 * The obvious implementation is to return the direction of whichever flattening
 * segment `s` landed in. That is the direction of a CHORD, not of the curve, and
 * it steps discontinuously at every vertex — so on a circle the glyphs are each
 * rotated slightly wrong, and the error shows as one end of a glyph sitting
 * further off the curve than the other. MEASURED on a 100px circle with 10px
 * glyphs: at least 0.080px of asymmetry, against a 0.125px bulge that is
 * inherent to laying a straight glyph across a curve at all — so most of the
 * visible error was the tangent, not the geometry. Sampling either side instead
 * holds the asymmetry under 0.02px, at least a factor of four, for two extra
 * table lookups per glyph.
 *
 * Sampling the polyline a little either side and taking the chord between those
 * two points averages the faceting out. At the ends of an open path the samples
 * clamp, which degrades it to the one-sided answer — correct, because there is
 * no curve beyond the end to average with.
 */
function tangentAt(fp: FlatPath, s: number): number {
  if (fp.pts.length < 2) return 0;
  const eps = Math.min(TANGENT_EPS, Math.max(fp.length / 64, 1e-6));
  const a = positionAt(fp, s - eps);
  const b = positionAt(fp, s + eps);
  if (!a || !b) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-12) {
    // Both samples clamped to the same place (a path shorter than one epsilon):
    // fall back to the whole path's direction, which is all there is.
    const p0 = fp.pts[0];
    const p1 = fp.pts[fp.pts.length - 1];
    return Math.atan2(p1.y - p0.y, p1.x - p0.x);
  }
  return Math.atan2(dy, dx);
}

/** One character, placed and turned. */
export interface GlyphPlacement {
  ch: string;
  /** Where the glyph's own origin goes — its left edge on the baseline. */
  x: number;
  y: number;
  /** Rotation about that origin, radians. */
  angle: number;
  style: TextRunStyle;
}

export interface PathTextOptions {
  /** Distance along the path where the text begins, doc px. */
  startOffset: number;
  /** start = at the offset, center/end = measured back from the middle / end. */
  align: "start" | "center" | "end";
  /** Extra space between characters, doc px (the block's tracking). */
  tracking: number;
  /** Lift off the path, doc px — positive raises, matching baseline shift. */
  offset: number;
  /** Put the text on the other side, reading the other way. */
  flip: boolean;
}

/** A path plus how the text sits on it — what a text layer stores. */
export interface PathTextSpec extends PathTextOptions {
  /** The path in DOCUMENT coordinates, as SVG path data. Stored resolved rather
   *  than as a reference to a path layer: text that reflowed because an
   *  unrelated layer was edited, or vanished because one was deleted, would be
   *  worse than text that keeps the shape it was attached to. */
  d: string;
}

export const DEFAULT_PATH_TEXT: PathTextOptions = {
  startOffset: 0,
  align: "start",
  tracking: 0,
  offset: 0,
  flip: false,
};

/**
 * Lay one styled string out along a path, one placement per character.
 *
 * Characters that would run past the end of the path are DROPPED rather than
 * piled up at the last point. Photoshop hides the overflow and shows a marker;
 * silently stacking glyphs on the final vertex is the one behaviour that reads
 * as corruption rather than as "the path is too short", so the count of what
 * was dropped is returned for a caller that wants to say so.
 */
export function layoutTextOnPath(
  text: string,
  runs: TextRun[] | undefined,
  base: TextRunStyle,
  path: FlatPath,
  opts: PathTextOptions,
  measure: MeasureFn,
): { glyphs: GlyphPlacement[]; dropped: number; advance: number } {
  if (!text || path.pts.length < 2) return { glyphs: [], dropped: 0, advance: 0 };
  const norm = normalizeRuns(text, runs, base);

  // Expand the runs into one style per character, so a glyph never has to ask
  // which run it came from twice.
  const styles: TextRunStyle[] = [];
  for (const r of norm) for (let i = 0; i < r.len; i++) styles.push(r);

  /* Newlines have no meaning on a path — there is no next line to move to — so
     they are treated as ordinary breaks in the text and skipped. Keeping them
     as zero-width glyphs would leave the tracking between the words either
     side doubled. */
  const chars: { ch: string; style: TextRunStyle }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") continue;
    const st = styles[i] ?? base;
    // All-caps is a render-time transform, so the glyph measured and the glyph
    // drawn have to be the same one — take it here, once.
    chars.push({ ch: renderedText(text[i], st), style: st });
  }

  const widths = chars.map((c) => measure(c.ch, c.style).width);
  const total =
    widths.reduce((n, w) => n + w, 0) + Math.max(0, chars.length - 1) * opts.tracking;

  let s =
    opts.align === "center"
      ? path.length / 2 - total / 2 + opts.startOffset
      : opts.align === "end"
        ? path.length - total + opts.startOffset
        : opts.startOffset;

  const glyphs: GlyphPlacement[] = [];
  let dropped = 0;
  const order = opts.flip ? [...chars].reverse() : chars;
  const w = opts.flip ? [...widths].reverse() : widths;

  for (let i = 0; i < order.length; i++) {
    const cw = w[i];
    const mid = s + cw / 2;
    const p = pathPointAt(path, mid);
    if (!p || mid < 0 || mid > path.length) {
      dropped++;
      s += cw + opts.tracking;
      continue;
    }
    /* THE CENTRE IS WHAT SITS ON THE CURVE — see the note at the top. The
       renderer draws at the glyph's own origin, so step back half a width
       ALONG the (rotated) baseline to get there. */
    const ang = opts.flip ? p.angle + Math.PI : p.angle;
    const nx = Math.sin(ang); // the normal, for lifting the text off the path
    const ny = -Math.cos(ang);
    const off = opts.offset;
    glyphs.push({
      ch: order[i].ch,
      x: p.x - (Math.cos(ang) * cw) / 2 + nx * off,
      y: p.y - (Math.sin(ang) * cw) / 2 + ny * off,
      angle: ang,
      style: order[i].style,
    });
    s += cw + opts.tracking;
  }
  if (opts.flip) glyphs.reverse();
  return { glyphs, dropped, advance: total };
}
