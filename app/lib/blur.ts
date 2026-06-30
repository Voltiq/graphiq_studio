// Shared separable box / Gaussian blur on a single float channel. Used by the
// Blur Gallery (paint.ts) and by Layer Effects (effects.ts) so shadows/glows do
// not reimplement a slower blur.

export const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** One separable box-blur pass (radius r) over `ch` (w×h), horizontal or vertical.
 *  Edge samples clamp. O(w·h) regardless of radius (running sum). */
export function boxBlurPass(ch: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  if (r < 1) return;
  const norm = 1 / (2 * r + 1);
  if (horizontal) {
    const tmp = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += ch[row + clampi(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[x] = sum * norm;
        sum += ch[row + clampi(x + r + 1, 0, w - 1)] - ch[row + clampi(x - r, 0, w - 1)];
      }
      ch.set(tmp, row);
    }
  } else {
    const tmp = new Float32Array(h);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += ch[clampi(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        tmp[y] = sum * norm;
        sum += ch[clampi(y + r + 1, 0, h - 1) * w + x] - ch[clampi(y - r, 0, h - 1) * w + x];
      }
      for (let y = 0; y < h; y++) ch[y * w + x] = tmp[y];
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
