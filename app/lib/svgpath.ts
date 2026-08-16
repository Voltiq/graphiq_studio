/**
 * SVG path data → a small normalized segment list.
 *
 * Everything an SVG `d` string can say is reduced to four absolute commands:
 * move, line, cubic and close. Elliptical arcs become cubics, quadratics become
 * cubics, the shorthand commands (H V S T) are expanded, and relative commands
 * are made absolute. Downstream — rendering, bounds, scaling into a box — then
 * only ever deals with those four, which is what keeps the shape library from
 * needing an SVG engine behind it.
 *
 * Parsing is deliberately lenient. Real-world path data from illustration tools
 * is full of things the grammar does not require anyone to accept: implicit
 * repeats, commas and minus signs used as separators, exponents, and arc flags
 * run together without spaces ("a1 1 0 011 1"). A parser that rejects those
 * would reject most files people actually have. Anything genuinely unparseable
 * is dropped rather than thrown on, so one bad subpath cannot lose a whole
 * import.
 *
 * Pure and DOM-free.
 */

export type PathSeg =
  | { c: "M"; x: number; y: number }
  | { c: "L"; x: number; y: number }
  | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: "Z" };

export interface PathBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NUM_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/**
 * Arc arguments, read in strict groups of seven with the two FLAGS treated as
 * single characters.
 *
 * The flags are the one place SVG's grammar stops being "a list of numbers":
 * they are single digits and every minifier writes them without separators, so
 * "a5 5 0 011 1" means (5,5,0, flag 0, flag 1, 1, 1) and NOT (5,5,0,11,1). A
 * plain number scan reads `011` as eleven, comes up two arguments short, and
 * silently drops the arc — which is most of the curves in a minified file.
 */
function scanArcArgs(body: string): number[] {
  const out: number[] = [];
  let i = 0;
  const skip = () => {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
  };
  while (i < body.length) {
    const group: number[] = [];
    for (let k = 0; k < 7; k++) {
      skip();
      if (i >= body.length) break;
      if (k === 3 || k === 4) {
        if (body[i] !== "0" && body[i] !== "1") break;
        group.push(body[i] === "1" ? 1 : 0);
        i++;
      } else {
        NUM_RE.lastIndex = i;
        const m = NUM_RE.exec(body);
        if (!m || m.index !== i) break;
        group.push(parseFloat(m[0]));
        i = m.index + m[0].length;
      }
    }
    if (group.length < 7) break; // trailing junk — stop rather than guess
    out.push(...group);
  }
  return out;
}

/** Split a `d` string into [command, numbers…] groups. */
function tokenize(d: string): { cmd: string; args: number[] }[] {
  const out: { cmd: string; args: number[] }[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const body = m[2];
    if (m[1] === "A" || m[1] === "a") {
      out.push({ cmd: m[1], args: scanArcArgs(body) });
      continue;
    }
    // Everything else is just a number list; the scan handles "1-2" and "1.5.5"
    // (both legal, both common) coming apart correctly.
    const nums: number[] = [];
    NUM_RE.lastIndex = 0;
    let n: RegExpExecArray | null;
    while ((n = NUM_RE.exec(body))) {
      const v = parseFloat(n[0]);
      if (Number.isFinite(v)) nums.push(v);
    }
    out.push({ cmd: m[1], args: nums });
  }
  return out;
}

/**
 * One elliptical arc → up to four cubic segments.
 *
 * Endpoint parameterisation (what SVG writes) converted to centre
 * parameterisation (what the maths needs), then split so no piece spans more
 * than 90° — beyond that a cubic cannot follow an ellipse closely enough to be
 * invisible, which is the whole reason for the split.
 */
function arcToCubics(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  angleDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): PathSeg[] {
  if (x0 === x && y0 === y) return [];
  // A zero radius means "draw a straight line" per the spec, not "no segment".
  if (!rx || !ry) return [{ c: "L", x, y }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (angleDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  // Radii too small to span the chord are scaled up, again per the spec.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dTheta = ang(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= Math.PI * 2;
  else if (sweep && dTheta < 0) dTheta += Math.PI * 2;

  const pieces = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const step = dTheta / pieces;
  // Control-point distance for a cubic approximating a circular arc of `step`.
  const k = (4 / 3) * Math.tan(step / 4);
  const out: PathSeg[] = [];
  let t = theta1;
  let px = x0;
  let py = y0;
  for (let i = 0; i < pieces; i++) {
    const t2 = t + step;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const cosT2 = Math.cos(t2);
    const sinT2 = Math.sin(t2);
    // Derivatives of the ellipse at t and t2, rotated into place.
    const d1x = -rx * sinT * cosP - ry * cosT * sinP;
    const d1y = -rx * sinT * sinP + ry * cosT * cosP;
    const e2x = cx + rx * cosT2 * cosP - ry * sinT2 * sinP;
    const e2y = cy + rx * cosT2 * sinP + ry * sinT2 * cosP;
    const d2x = -rx * sinT2 * cosP - ry * cosT2 * sinP;
    const d2y = -rx * sinT2 * sinP + ry * cosT2 * cosP;
    out.push({
      c: "C",
      x1: px + k * d1x,
      y1: py + k * d1y,
      x2: e2x - k * d2x,
      y2: e2y - k * d2y,
      x: i === pieces - 1 ? x : e2x,
      y: i === pieces - 1 ? y : e2y,
    });
    px = e2x;
    py = e2y;
    t = t2;
  }
  return out;
}

/** Parse SVG path data into absolute M/L/C/Z segments. */
export function parsePath(d: string): PathSeg[] {
  if (typeof d !== "string" || !d.trim()) return [];
  const out: PathSeg[] = [];
  let cx = 0; // current point
  let cy = 0;
  let sx = 0; // start of the current subpath (where Z returns to)
  let sy = 0;
  // Last cubic/quadratic control point, for the S and T shorthands.
  let lastC: { x: number; y: number } | null = null;
  let lastQ: { x: number; y: number } | null = null;

  for (const { cmd, args } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase() && cmd !== "Z" && cmd !== "z";
    const up = cmd.toUpperCase();
    // Arc flags are single digits and may be written without separators, so the
    // number scan can glue them to the following coordinate. Handled by reading
    // arcs in strict groups of 7 below.
    const step =
      up === "M" || up === "L" || up === "T" ? 2 : up === "H" || up === "V" ? 1 : up === "C" ? 6 : up === "S" || up === "Q" ? 4 : up === "A" ? 7 : 0;

    if (up === "Z") {
      out.push({ c: "Z" });
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      continue;
    }
    if (step === 0 || args.length < step) continue; // unparseable — drop it

    for (let i = 0; i + step <= args.length; i += step) {
      const a = args.slice(i, i + step);
      if (up === "M") {
        const nx = rel ? cx + a[0] : a[0];
        const ny = rel ? cy + a[1] : a[1];
        // Extra coordinate pairs after an M are implicit lineto, per the spec.
        if (i === 0) {
          out.push({ c: "M", x: nx, y: ny });
          sx = nx;
          sy = ny;
        } else out.push({ c: "L", x: nx, y: ny });
        cx = nx;
        cy = ny;
        lastC = lastQ = null;
      } else if (up === "L") {
        cx = rel ? cx + a[0] : a[0];
        cy = rel ? cy + a[1] : a[1];
        out.push({ c: "L", x: cx, y: cy });
        lastC = lastQ = null;
      } else if (up === "H") {
        cx = rel ? cx + a[0] : a[0];
        out.push({ c: "L", x: cx, y: cy });
        lastC = lastQ = null;
      } else if (up === "V") {
        cy = rel ? cy + a[0] : a[0];
        out.push({ c: "L", x: cx, y: cy });
        lastC = lastQ = null;
      } else if (up === "C") {
        const x1 = rel ? cx + a[0] : a[0];
        const y1 = rel ? cy + a[1] : a[1];
        const x2 = rel ? cx + a[2] : a[2];
        const y2 = rel ? cy + a[3] : a[3];
        cx = rel ? cx + a[4] : a[4];
        cy = rel ? cy + a[5] : a[5];
        out.push({ c: "C", x1, y1, x2, y2, x: cx, y: cy });
        lastC = { x: x2, y: y2 };
        lastQ = null;
      } else if (up === "S") {
        // Reflect the previous cubic's second control point through the current
        // point; with no previous cubic the reflection is the point itself.
        const x1 = lastC ? 2 * cx - lastC.x : cx;
        const y1 = lastC ? 2 * cy - lastC.y : cy;
        const x2 = rel ? cx + a[0] : a[0];
        const y2 = rel ? cy + a[1] : a[1];
        cx = rel ? cx + a[2] : a[2];
        cy = rel ? cy + a[3] : a[3];
        out.push({ c: "C", x1, y1, x2, y2, x: cx, y: cy });
        lastC = { x: x2, y: y2 };
        lastQ = null;
      } else if (up === "Q" || up === "T") {
        let qx: number;
        let qy: number;
        if (up === "Q") {
          qx = rel ? cx + a[0] : a[0];
          qy = rel ? cy + a[1] : a[1];
        } else {
          qx = lastQ ? 2 * cx - lastQ.x : cx;
          qy = lastQ ? 2 * cy - lastQ.y : cy;
        }
        const ex = up === "Q" ? (rel ? cx + a[2] : a[2]) : rel ? cx + a[0] : a[0];
        const ey = up === "Q" ? (rel ? cy + a[3] : a[3]) : rel ? cy + a[1] : a[1];
        // Quadratic → cubic: control points sit two-thirds of the way out.
        out.push({
          c: "C",
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: ex + (2 / 3) * (qx - ex),
          y2: ey + (2 / 3) * (qy - ey),
          x: ex,
          y: ey,
        });
        cx = ex;
        cy = ey;
        lastQ = { x: qx, y: qy };
        lastC = null;
      } else if (up === "A") {
        const ex = rel ? cx + a[5] : a[5];
        const ey = rel ? cy + a[6] : a[6];
        out.push(...arcToCubics(cx, cy, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, ex, ey));
        cx = ex;
        cy = ey;
        lastC = lastQ = null;
      }
    }
  }
  // A path that never started with a move is not usable geometry.
  return out.some((s) => s.c === "M") ? out : [];
}

/** Tight bounds. Cubic extremes are solved, not sampled — a curve that bulges
 *  past its endpoints would otherwise be clipped when scaled into a box. */
export function pathBounds(segs: PathSeg[]): PathBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  // Extremes of one cubic coordinate: the roots of its derivative in [0,1].
  const axis = (p0: number, p1: number, p2: number, p3: number, put: (v: number) => void) => {
    put(p3);
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = -p0 + p1;
    const at = (t: number) => {
      if (t <= 0 || t >= 1) return;
      const mt = 1 - t;
      put(mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3);
    };
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) at(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        at((-b + s) / (2 * a));
        at((-b - s) / (2 * a));
      }
    }
  };
  let cx = 0;
  let cy = 0;
  for (const s of segs) {
    if (s.c === "Z") continue;
    if (s.c === "C") {
      // Each axis is solved on its own — an x extreme says nothing about y, so
      // pairing them up would invent points the curve never passes through.
      // Feeding a known-inside coordinate alongside keeps `add` honest.
      add(cx, cy);
      axis(cx, s.x1, s.x2, s.x, (v) => add(v, cy));
      axis(cy, s.y1, s.y2, s.y, (v) => add(cx, v));
      add(s.x, s.y);
      cx = s.x;
      cy = s.y;
    } else {
      add(s.x, s.y);
      cx = s.x;
      cy = s.y;
    }
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Affine-map every coordinate. */
export function mapPath(segs: PathSeg[], fx: (x: number) => number, fy: (y: number) => number): PathSeg[] {
  return segs.map((s) =>
    s.c === "Z"
      ? s
      : s.c === "C"
        ? { c: "C", x1: fx(s.x1), y1: fy(s.y1), x2: fx(s.x2), y2: fy(s.y2), x: fx(s.x), y: fy(s.y) }
        : { c: s.c, x: fx(s.x), y: fy(s.y) },
  );
}

/**
 * Fit a path into the unit square, PRESERVING ASPECT and centring it.
 *
 * Stretching each axis independently is the obvious alternative and it is
 * wrong: every stored shape would come out as a square, and a heart or an arrow
 * would only look right when drawn in a square box.
 */
export function normalizePath(segs: PathSeg[]): PathSeg[] {
  const b = pathBounds(segs);
  if (b.w <= 0 && b.h <= 0) return segs;
  const s = 1 / Math.max(b.w, b.h);
  const ox = (1 - b.w * s) / 2;
  const oy = (1 - b.h * s) / 2;
  return mapPath(segs, (x) => (x - b.x) * s + ox, (y) => (y - b.y) * s + oy);
}

/** Back to a `d` string (for storage and for Path2D). */
export function pathToD(segs: PathSeg[], precision = 4): string {
  const n = (v: number) => {
    const r = Number(v.toFixed(precision));
    return String(Number.isFinite(r) ? r : 0);
  };
  return segs
    .map((s) =>
      s.c === "Z"
        ? "Z"
        : s.c === "C"
          ? `C${n(s.x1)} ${n(s.y1)} ${n(s.x2)} ${n(s.y2)} ${n(s.x)} ${n(s.y)}`
          : `${s.c}${n(s.x)} ${n(s.y)}`,
    )
    .join("");
}

/** Place a unit-square path inside a box, preserving its aspect. */
export function fitPathToBox(segs: PathSeg[], box: PathBox): PathSeg[] {
  const k = Math.min(box.w, box.h);
  const ox = box.x + (box.w - k) / 2;
  const oy = box.y + (box.h - k) / 2;
  return mapPath(segs, (x) => ox + x * k, (y) => oy + y * k);
}
