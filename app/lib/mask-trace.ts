// Turning a boolean selection mask into geometry: the rectangle decomposition
// the engine stores, and the boundary segments the marching ants draw.
//
// Both used to walk every cell of the region's bounding box — the boundary trace
// twice over, once for horizontal edges and once for vertical. That is ~2 M cell
// tests per pass on a full-screen wand click, and it is the wrong shape of work:
// a flood selection is mostly SOLID, so almost every row is identical to the one
// above it and contributes no horizontal edge at all.
//
// So everything here is built on RUNS — the maximal spans of set cells in a row.
// A solid 1920x1080 region is 1080 rows of one run each, and the boundary falls
// out of comparing consecutive run lists rather than consecutive pixel rows. The
// cost becomes O(number of runs) instead of O(area), which is the same answer for
// a ragged mask and dramatically less for a smooth one.

// PRECONDITION, relied on throughout: `b` CONTAINS every set cell of the
// region being described — cells outside it are treated as empty, so the
// boundary always closes. Every caller satisfies this: the wand passes the
// min/max of its flood, and combineSelection passes the union of its inputs`
// bounds. Handing in a box that clips through set cells would trace an open
// boundary, which the marching ants cannot draw.
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The maximal runs of set cells in row `y`, clipped to `[x0, x1)`.
 *
 * Written into `out` as flat [start, end) pairs and the pair count returned, so
 * a caller can scan a whole mask without allocating a list per row. `out` must
 * hold at least `x1 - x0 + 1` pairs — the worst case is every other cell set.
 */
export function rowRuns(
  mask: Uint8Array,
  w: number,
  y: number,
  x0: number,
  x1: number,
  out: Int32Array,
): number {
  let n = 0;
  const row = y * w;
  let x = x0;
  while (x < x1) {
    if (!mask[row + x]) {
      x++;
      continue;
    }
    const start = x;
    while (x < x1 && mask[row + x]) x++;
    out[n * 2] = start;
    out[n * 2 + 1] = x;
    n++;
  }
  return n;
}

/**
 * Decompose a boolean mask into non-overlapping rectangles covering exactly the
 * set cells: per-row runs, greedily extended downward while the run directly
 * below is identical (which collapses a solid region to a handful of rects).
 */
export function maskToRects(mask: Uint8Array, w: number, b: Bounds): Rect[] {
  const rects: Rect[] = [];
  const span = b.x1 - b.x0;
  if (span <= 0 || b.y1 <= b.y0) return rects;
  const cap = (span >> 1) + 2;
  let prev = new Int32Array(cap * 2);
  let cur = new Int32Array(cap * 2);
  // The open rect for each run of the previous row, index-aligned with `prev`.
  let prevOpen: Rect[] = [];
  let prevN = 0;

  for (let y = b.y0; y < b.y1; y++) {
    const n = rowRuns(mask, w, y, b.x0, b.x1, cur);
    const open: Rect[] = new Array(n);
    // Both run lists are sorted and disjoint, so one merge walk pairs identical
    // runs; anything unpaired on the previous row is a rect that ends here.
    let i = 0;
    let j = 0;
    while (i < prevN && j < n) {
      const pa = prev[i * 2];
      const pb = prev[i * 2 + 1];
      const ca = cur[j * 2];
      const cb = cur[j * 2 + 1];
      if (pa === ca && pb === cb) {
        prevOpen[i].h++;
        open[j] = prevOpen[i];
        i++;
        j++;
      } else if (pa < ca || (pa === ca && pb < cb)) {
        rects.push(prevOpen[i]);
        i++;
      } else {
        open[j] = { x: ca, y, w: cb - ca, h: 1 };
        j++;
      }
    }
    for (; i < prevN; i++) rects.push(prevOpen[i]);
    for (; j < n; j++) open[j] = { x: cur[j * 2], y, w: cur[j * 2 + 1] - cur[j * 2], h: 1 };

    const t = prev;
    prev = cur;
    cur = t;
    prevOpen = open;
    prevN = n;
  }
  for (let i = 0; i < prevN; i++) rects.push(prevOpen[i]);
  return rects;
}

/**
 * Trace the mask's boundary into merged collinear segments on the pixel grid.
 *
 * Horizontal edges on grid line `y` are exactly the symmetric difference of row
 * `y-1`'s runs and row `y`'s runs — an interval XOR over two sorted lists, so a
 * row identical to the one above costs one comparison per run and emits nothing.
 * Vertical edges are the run ENDPOINTS, kept open across rows so a straight side
 * merges into a single segment instead of one per row.
 */
export function maskToSegments(mask: Uint8Array, w: number, h: number, b: Bounds): Seg[] {
  const segs: Seg[] = [];
  const span = b.x1 - b.x0;
  if (span <= 0 || b.y1 <= b.y0) return segs;
  const cap = (span >> 1) + 2;
  let prev = new Int32Array(cap * 2);
  let cur = new Int32Array(cap * 2);
  let prevN = 0;
  // Vertical-edge merge state: the previous row's edge columns and the row each
  // one opened on.
  const prevEdges = new Int32Array(cap * 2);
  let prevEdgeN = 0;
  let prevStart = new Int32Array(cap * 2);
  let curStart = new Int32Array(cap * 2);

  /** Horizontal edges on grid line `y`: the interval XOR of two run lists. */
  const xorRow = (
    a: Int32Array,
    an: number,
    c: Int32Array,
    cn: number,
    y: number,
  ) => {
    let i = 0;
    let j = 0;
    let run = -1; // start of an open horizontal edge, or -1
    // Walk both lists as a sequence of boundary events, tracking which side is
    // inside; an edge exists exactly where the two disagree.
    let x = Math.min(an ? a[0] : Infinity, cn ? c[0] : Infinity);
    let inA = false;
    let inC = false;
    while (i < an || j < cn) {
      // Advance the flags to position x.
      if (i < an && a[i * 2] === x) inA = true;
      if (i < an && a[i * 2 + 1] === x) {
        inA = false;
        i++;
        continue;
      }
      if (j < cn && c[j * 2] === x) inC = true;
      if (j < cn && c[j * 2 + 1] === x) {
        inC = false;
        j++;
        continue;
      }
      const edge = inA !== inC;
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) {
        segs.push({ x1: run, y1: y, x2: x, y2: y });
        run = -1;
      }
      // Next event: the nearest unconsumed endpoint on either side.
      let nx = Infinity;
      if (i < an) nx = Math.min(nx, a[i * 2] > x ? a[i * 2] : a[i * 2 + 1]);
      if (j < cn) nx = Math.min(nx, c[j * 2] > x ? c[j * 2] : c[j * 2 + 1]);
      if (!Number.isFinite(nx)) break;
      x = nx;
    }
    if (run >= 0) segs.push({ x1: run, y1: y, x2: x, y2: y });
  };

  for (let y = b.y0; y <= b.y1; y++) {
    const n = y < b.y1 ? rowRuns(mask, w, y, b.x0, b.x1, cur) : 0;
    xorRow(prev, prevN, cur, n, y);

    // Vertical edges. A row's run array IS its sorted list of edge columns:
    // runs are disjoint and ordered, and two runs that touched would have
    // merged, so the flat [start, end) pairs are strictly increasing. Merging
    // that list against the previous row's keeps a straight side as ONE segment
    // and costs O(runs), not O(width).
    const curEdgeN = n * 2;
    let i = 0;
    let j = 0;
    while (i < prevEdgeN || j < curEdgeN) {
      const pv = i < prevEdgeN ? prevEdges[i] : Infinity;
      const cv = j < curEdgeN ? cur[j] : Infinity;
      if (pv === cv) {
        curStart[j] = prevStart[i]; // still open — carry its start row down
        i++;
        j++;
      } else if (pv < cv) {
        segs.push({ x1: pv, y1: prevStart[i], x2: pv, y2: y }); // closed here
        i++;
      } else {
        curStart[j] = y; // opens here
        j++;
      }
    }
    for (let k = 0; k < curEdgeN; k++) prevEdges[k] = cur[k];
    prevEdgeN = curEdgeN;
    const ts = prevStart;
    prevStart = curStart;
    curStart = ts;

    const t = prev;
    prev = cur;
    cur = t;
    prevN = n;
  }
  // The final grid line (y = b.y1) has no runs, so every open column closed
  // there — nothing can still be open.
  void h;
  return segs;
}
