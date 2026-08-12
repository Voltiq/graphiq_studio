/* Pins app/lib/blur.ts to the semantics of the original column-at-a-time
 * implementation, which is embedded below as the reference.
 *
 *   npx tsx tools/verify-blur-identity.ts        (tsx is dev tooling, not a dependency)
 *
 * WHY THIS EXISTS. The vertical pass now blurs 16 columns at a time so each
 * cache line is fully used. That is only a legitimate optimisation if it is
 * BIT-identical, not merely close: blur output feeds shadows, glows and the Blur
 * Gallery, and `exportComposite` must not disagree with what is on screen. The
 * rewrite preserves identity because each column keeps its own running sum, in
 * the original order — but "preserves identity because I reasoned so" is exactly
 * what this file exists to replace.
 *
 * It already earned its keep: the first version of the blocked pass kept the
 * running sums in a Float32Array, which rounds at every step, where the original
 * accumulates in a plain `let` (a float64 double) and rounds only on store. The
 * output drifted in the low bits on every single shape. Nothing about the result
 * LOOKED wrong; only byte comparison caught it.
 *
 * Re-run after any change to blur.ts.
 */
import { gaussianChannel, boxBlurPass } from "../app/lib/blur";

// ---- reference: the original implementation, verbatim -----------------------
const clampi = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function refPass(ch: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
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
function refGaussian(ch: Float32Array, w: number, h: number, radius: number) {
  if (radius < 0.5) return;
  const br = Math.max(1, Math.round(radius / 2));
  for (let p = 0; p < 3; p++) {
    refPass(ch, w, h, br, true);
    refPass(ch, w, h, br, false);
  }
}

// ---- harness ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? " — " + extra : ""}`);
};
const fill = (n: number, seed: number) => {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = (s >>> 8) / 65536;
  }
  return a;
};
/** Byte comparison, not epsilon: the point is bit-identity. */
const byteDiff = (a: Float32Array, b: Float32Array) => {
  const A = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const B = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let d = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) d++;
  return d;
};

// Shapes chosen to hit the block edges: widths that are and are not multiples of
// 16, widths narrower than one block, single rows and columns, and radii larger
// than the dimension being blurred.
const shapes: Array<[number, number, number]> = [
  [64, 48, 3], [64, 48, 25], [65, 48, 5], [63, 49, 7], [16, 16, 2], [17, 16, 2],
  [15, 9, 4], [7, 5, 1], [1, 40, 3], [40, 1, 3], [33, 17, 40], [128, 96, 1],
  [257, 129, 11], [1920, 64, 12], [64, 1080, 12], [1920, 1080, 25],
];

for (const [w, h, r] of shapes) {
  const base = fill(w * h, w * 7919 + h * 104729 + r);
  const a = Float32Array.from(base);
  const b = Float32Array.from(base);
  refGaussian(a, w, h, r);
  gaussianChannel(b, w, h, r);
  const d = byteDiff(a, b);
  check(`gaussianChannel ${w}x${h} r=${r}`, d === 0, d ? `${d} bytes differ` : "bit-identical");
}
for (const [w, h, r] of shapes) {
  const base = fill(w * h, w + h + r);
  const a = Float32Array.from(base);
  const b = Float32Array.from(base);
  refPass(a, w, h, r, false);
  boxBlurPass(b, w, h, r, false);
  check(`vertical pass ${w}x${h} r=${r}`, byteDiff(a, b) === 0);
}

// The shared scratch buffers must not carry state between differently-shaped
// calls — the failure mode buffer reuse introduces.
{
  const big = fill(200 * 100, 1);
  const small = fill(40 * 30, 2);
  const b1 = Float32Array.from(big);
  gaussianChannel(b1, 200, 100, 9);
  const s1 = Float32Array.from(small);
  gaussianChannel(s1, 40, 30, 4);
  const b2 = Float32Array.from(big);
  gaussianChannel(b2, 200, 100, 9); // same call again, but after a smaller one
  const s2 = Float32Array.from(small);
  gaussianChannel(s2, 40, 30, 4);
  const ref = Float32Array.from(big);
  refGaussian(ref, 200, 100, 9);
  check("scratch reuse: large call after a smaller one", byteDiff(b2, ref) === 0);
  check("scratch reuse: repeated small call is stable", byteDiff(s1, s2) === 0);
}

// Not vacuous: identity between two no-ops would also be "identical".
{
  const w = 128;
  const h = 96;
  const base = fill(w * h, 42);
  const b = Float32Array.from(base);
  gaussianChannel(b, w, h, 8);
  const d = byteDiff(base, b);
  check("blur actually changes the data", d > 0, `${d} bytes differ from the input`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
