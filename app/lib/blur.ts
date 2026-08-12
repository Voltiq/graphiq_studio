// Shared separable box / Gaussian blur on a single float channel. Used by the
// Blur Gallery (paint.ts) and by Layer Effects (effects.ts) so shadows/glows do
// not reimplement a slower blur.

export const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Scratch reused across calls. Blur is synchronous and never re-entrant within a
// thread, and each thread (main, filter worker) gets its own module instance, so
// a module-level buffer is safe and saves an allocation per pass.
let rowBuf: Float32Array = new Float32Array(0);
let sumBuf: Float64Array = new Float64Array(0);
const rowScratch = (n: number) => {
  if (rowBuf.length < n) rowBuf = new Float32Array(n);
  return rowBuf;
};
/** The running sums must be float64. The row pass keeps its sum in a plain
 *  `let`, i.e. a JS double, and rounds to f32 only when storing into `tmp`;
 *  accumulating in an f32 array instead would round at every step and drift in
 *  the low bits — caught by the identity test, which is why it is worth saying. */
const sumScratch = (n: number) => {
  if (sumBuf.length < n) sumBuf = new Float64Array(n);
  return sumBuf;
};

/** Columns blurred together in the vertical pass. 16 floats = one 64-byte cache
 *  line, so a row fetched for one column serves all 16. */
const COLS = 16;

/** One separable box-blur pass (radius r) over `ch` (w×h), horizontal or vertical.
 *  Edge samples clamp. O(w·h) regardless of radius (running sum). */
export function boxBlurPass(ch: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  if (r < 1) return;
  const norm = 1 / (2 * r + 1);
  if (horizontal) {
    const tmp = rowScratch(w);
    const view = tmp.subarray(0, w); // hoisted: one view, not one per row
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += ch[row + clampi(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[x] = sum * norm;
        sum += ch[row + clampi(x + r + 1, 0, w - 1)] - ch[row + clampi(x - r, 0, w - 1)];
      }
      ch.set(view, row);
    }
  } else {
    // Same running sum as the row pass, but over COLS columns at once. Walking
    // one column at a time strides by `w`, so every access is a fresh cache line
    // of which 1 value in 16 is used — that alone made this pass ~3.4× the cost
    // of the row pass at 4000×3000. Each column keeps its own sequential sum in
    // the original order, so the result is bit-identical to the column-at-a-time
    // version (verified byte-for-byte in test-blur.ts).
    const tmp = rowScratch(h * COLS);
    const sums = sumScratch(COLS);
    for (let x0 = 0; x0 < w; x0 += COLS) {
      const bw = Math.min(COLS, w - x0);
      sums.fill(0, 0, bw);
      for (let k = -r; k <= r; k++) {
        const row = clampi(k, 0, h - 1) * w + x0;
        for (let i = 0; i < bw; i++) sums[i] += ch[row + i];
      }
      for (let y = 0; y < h; y++) {
        const add = clampi(y + r + 1, 0, h - 1) * w + x0;
        const sub = clampi(y - r, 0, h - 1) * w + x0;
        const to = y * bw;
        for (let i = 0; i < bw; i++) {
          tmp[to + i] = sums[i] * norm;
          sums[i] += ch[add + i] - ch[sub + i];
        }
      }
      for (let y = 0; y < h; y++) {
        const from = y * bw;
        const row = y * w + x0;
        for (let i = 0; i < bw; i++) ch[row + i] = tmp[from + i];
      }
    }
  }
}

/** Approximate a Gaussian blur of `radius` on a float channel with 3 box passes
 *  (separable, in place). 3 boxes ≈ a Gaussian by the central-limit theorem. */
export function gaussianChannel(ch: Float32Array, w: number, h: number, radius: number) {
  if (radius < 0.5) return;
  const br = Math.max(1, Math.round(radius / 2));
  for (let p = 0; p < 3; p++) {
    boxBlurPass(ch, w, h, br, true);
    boxBlurPass(ch, w, h, br, false);
  }
}
