/**
 * Demosaicing, checked against an image whose answer is already known.
 *
 * This is the rare case with a real ORACLE. Demosaicing reconstructs two of
 * three channels at every photosite, so the way to test it is not to assert
 * particular numbers but to start from a full-colour image, throw away exactly
 * what a Bayer sensor throws away, reconstruct, and measure how much of the
 * original came back. Every claim below is that measurement — including the
 * claim that Malvar-He-Cutler beats bilinear, which is otherwise just an
 * assertion copied out of a paper.
 *
 * THE TEST IMAGE HAD TO BE CORRECTED, and that is worth recording. The first
 * version was built entirely from hard steps between STRONGLY ANTI-CORRELATED
 * colours — red high exactly where green was low. MHC measured worse than
 * bilinear on it, which looked like a bug in the filter and was not: the
 * gradient correction assumes the channels share their detail, and an edge
 * engineered so they share none is the one case where borrowing green's
 * gradient actively misleads. Photographs are not made of those. The image
 * below is what a sensor actually sees — a tinted luminance field with detail
 * at several scales — and the anti-correlated case is kept as a test of its
 * own, stating the cost, because it is a real property of the method rather
 * than something to leave out.
 */
import { describe, expect, it } from "vitest";
import {
  demosaicBilinear,
  demosaicMHC,
  type CFAColor,
  type RGBOut,
} from "../app/lib/demosaic";

const W = 96;
const H = 96;

/**
 * A synthetic image with the statistics of a photograph: one luminance field
 * carrying detail at several scales, tinted per channel. The channels move
 * together, which is what makes a gradient correction worth having.
 */
function makeImage(): Float32Array {
  const img = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let L =
        0.5 +
        0.22 * Math.sin(x * 0.11) * Math.cos(y * 0.09) +
        0.12 * Math.sin((x + y) * 0.42) +
        0.06 * Math.cos(x * 0.9 - y * 0.7);
      // A hard edge, the same one in every channel — a real object boundary.
      if (x > 60 && x < 78 && y > 20 && y < 76) L = 0.86;
      L = Math.max(0.02, Math.min(0.98, L));
      // A colour cast that varies slowly, as a scene's does.
      img[i] = L * (1.04 + 0.1 * Math.sin(y * 0.05));
      img[i + 1] = L;
      img[i + 2] = L * (0.9 + 0.12 * Math.cos(x * 0.04));
    }
  }
  return img;
}

/** RGGB: red on even/even, blue on odd/odd, green on the diagonal. */
const colorAt = (x: number, y: number): CFAColor =>
  y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2;

/** What the sensor actually records: one channel per site. */
function mosaic(img: Float32Array): Float32Array {
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) m[y * W + x] = img[(y * W + x) * 3 + colorAt(x, y)];
  return m;
}

const clampedAt = (m: Float32Array) => (x: number, y: number) => {
  const xx = x < 0 ? 0 : x >= W ? W - 1 : x;
  const yy = y < 0 ? 0 : y >= H ? H - 1 : y;
  return m[yy * W + xx];
};

type Method = (
  at: (x: number, y: number) => number,
  c: typeof colorAt,
  x: number,
  y: number,
  out: RGBOut,
) => void;

/**
 * Mean absolute error over the interior, and the worst single pixel.
 *
 * The outer two rows and columns are excluded: both methods clamp there, so
 * including them would measure the border policy rather than the filter, and
 * would flatter whichever one happens to blur more.
 */
function error(img: Float32Array, m: Float32Array, method: Method) {
  const at = clampedAt(m);
  const out: RGBOut = { r: 0, g: 0, b: 0 };
  let sum = 0;
  let worst = 0;
  let n = 0;
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      method(at, colorAt, x, y, out);
      const i = (y * W + x) * 3;
      const e =
        (Math.abs(out.r - img[i]) +
          Math.abs(out.g - img[i + 1]) +
          Math.abs(out.b - img[i + 2])) /
        3;
      sum += e;
      if (e > worst) worst = e;
      n++;
    }
  }
  return { mean: sum / n, worst };
}

const img = makeImage();
const m = mosaic(img);

describe("the mosaic itself", () => {
  it("keeps exactly one channel per photosite, in RGGB order", () => {
    expect(colorAt(0, 0)).toBe(0);
    expect(colorAt(1, 0)).toBe(1);
    expect(colorAt(0, 1)).toBe(1);
    expect(colorAt(1, 1)).toBe(2);
    expect(m[0]).toBeCloseTo(img[0]);
    expect(m[1]).toBeCloseTo(img[3 + 1]);
  });
});

describe.each([
  ["bilinear", demosaicBilinear as Method],
  ["Malvar-He-Cutler", demosaicMHC as Method],
])("%s", (_name, method) => {
  const at = clampedAt(m);
  const out: RGBOut = { r: 0, g: 0, b: 0 };

  /* The one thing neither may ever get wrong: the channel the sensor actually
     measured must come back untouched. Interpolating over a measurement would
     be discarding data that was really there. */
  it("returns the measured channel exactly at every site", () => {
    for (let y = 3; y < H - 3; y += 7) {
      for (let x = 3; x < W - 3; x += 5) {
        method(at, colorAt, x, y, out);
        const c = colorAt(x, y);
        const got = c === 0 ? out.r : c === 1 ? out.g : out.b;
        expect(got).toBeCloseTo(img[(y * W + x) * 3 + c], 10);
      }
    }
  });

  it("reconstructs a flat colour exactly", () => {
    const flat = new Float32Array(W * H).fill(0.42);
    const fat = clampedAt(flat);
    method(fat, colorAt, 10, 10, out);
    expect(out.r).toBeCloseTo(0.42, 6);
    expect(out.g).toBeCloseTo(0.42, 6);
    expect(out.b).toBeCloseTo(0.42, 6);
  });

  /* A grey ramp is the sharpest test of the interpolation itself: every channel
     is equal, so the cross-channel correction contributes nothing and any error
     is the filter's own. Both methods are exact on one. */
  it("reproduces a linear grey ramp exactly", () => {
    const ramp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ramp[y * W + x] = x / W;
    const rat = clampedAt(ramp);
    for (let x = 4; x < W - 4; x += 3) {
      method(rat, colorAt, x, 20, out);
      for (const v of [out.r, out.g, out.b]) expect(v).toBeCloseTo(x / W, 6);
    }
  });

  it("produces finite numbers everywhere, including the clamped border", () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [W - 1, H - 1], [W - 2, H - 2]]) {
      method(at, colorAt, x, y, out);
      expect(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b)).toBe(true);
    }
  });
});

describe("Malvar-He-Cutler against bilinear", () => {
  const bil = error(img, m, demosaicBilinear as Method);
  const mhc = error(img, m, demosaicMHC as Method);

  /* Measured at 1.74x less mean absolute error over the frame. The threshold
     is set well inside that so a small regression is caught but ordinary
     re-tuning of the test image is not. */
  it("reconstructs the image with materially less error", () => {
    expect(mhc.mean).toBeLessThan(bil.mean * 0.75);
  });

  it("…and cuts the worst single-pixel error too, not just the average", () => {
    expect(mhc.worst).toBeLessThan(bil.worst);
  });

  /* A filter can win on the mean by blurring everything slightly, so the gain
     has to be located, not just totalled. MEASURED, and not where the first
     version of this test looked: it compared a region around a hard step and
     expected the biggest win there, and got 1.13 against 1.74 for the frame as
     a whole. A hard step is not where MHC earns its keep — a step is a low
     frequency, and both filters handle it. The gradient correction pays off
     against detail near the SAMPLING LIMIT, where bilinear's same-colour
     averaging aliases and green's denser sampling is the only thing that still
     resolves it. So the comparison is fine detail against a smooth ramp. */
  it("wins by more on detail near the sampling limit than on a smooth ramp", () => {
    const S = 64;
    const build = (detail: boolean) => {
      const im = new Float32Array(S * S * 3);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 3;
          const L = detail
            ? 0.5 + 0.35 * Math.cos(x * 1.15) * Math.cos(y * 1.05)
            : 0.15 + (0.7 * x) / S;
          im[i] = L * 1.05;
          im[i + 1] = L;
          im[i + 2] = L * 0.92;
        }
      return im;
    };
    const gain = (im: Float32Array) => {
      const mo = new Float32Array(S * S);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) mo[y * S + x] = im[(y * S + x) * 3 + colorAt(x, y)];
      const at = (x: number, y: number) =>
        mo[(y < 0 ? 0 : y >= S ? S - 1 : y) * S + (x < 0 ? 0 : x >= S ? S - 1 : x)];
      const out: RGBOut = { r: 0, g: 0, b: 0 };
      const meanOf = (method: Method) => {
        let sum = 0;
        let n = 0;
        for (let y = 3; y < S - 3; y++)
          for (let x = 3; x < S - 3; x++) {
            method(at, colorAt, x, y, out);
            const i = (y * S + x) * 3;
            sum +=
              (Math.abs(out.r - im[i]) +
                Math.abs(out.g - im[i + 1]) +
                Math.abs(out.b - im[i + 2])) /
              3;
            n++;
          }
        return sum / n || 1e-12;
      };
      return meanOf(demosaicBilinear as Method) / meanOf(demosaicMHC as Method);
    };
    expect(gain(build(true))).toBeGreaterThan(gain(build(false)));
  });

  /* THE HONEST LIMIT. Where the channels are anti-correlated — red high exactly
     where green is low, which happens at a saturated colour boundary and almost
     nowhere else — borrowing green's gradient is the wrong thing to do and MHC
     is measurably worse than bilinear. Recorded as a test rather than omitted,
     so the trade-off is a known quantity instead of a surprise. */
  it("is worse on a strongly anti-correlated edge, which is inherent to the method", () => {
    const S = 48;
    const anti = new Float32Array(S * S * 3);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 3;
        const on = x >= S / 2;
        anti[i] = on ? 0.1 : 0.9;
        anti[i + 1] = on ? 0.8 : 0.2;
        anti[i + 2] = on ? 0.6 : 0.15;
      }
    const mo = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) mo[y * S + x] = anti[(y * S + x) * 3 + colorAt(x, y)];
    const at = (x: number, y: number) =>
      mo[(y < 0 ? 0 : y >= S ? S - 1 : y) * S + (x < 0 ? 0 : x >= S ? S - 1 : x)];
    const out: RGBOut = { r: 0, g: 0, b: 0 };
    const meanOf = (method: Method) => {
      let sum = 0;
      let n = 0;
      for (let y = 3; y < S - 3; y++)
        for (let x = 3; x < S - 3; x++) {
          method(at, colorAt, x, y, out);
          const i = (y * S + x) * 3;
          sum +=
            (Math.abs(out.r - anti[i]) +
              Math.abs(out.g - anti[i + 1]) +
              Math.abs(out.b - anti[i + 2])) /
            3;
          n++;
        }
      return sum / n;
    };
    const b = meanOf(demosaicBilinear as Method);
    const h = meanOf(demosaicMHC as Method);
    expect(h).toBeGreaterThan(b); // measured at roughly 1.7x worse
    expect(h).toBeLessThan(b * 3); // …but bounded, not unstable
  });
});

/**
 * The optimised form IS the published filter.
 *
 * `demosaicMHC` adds up named taps rather than convolving a 5×5 array, because
 * the kernels are sparse and a general convolution would do 25 multiplies per
 * channel to reach the same number. That is an optimisation, and this is the
 * check that it is ONLY an optimisation: the four kernels from the paper are
 * written out literally here and convolved the slow way over random data, and
 * the two must agree exactly at every interior pixel.
 *
 * It earned its place immediately. The first `demosaicMHC` defined its taps
 * relative to "the axis the interpolated colour lies along" and THEN swapped red
 * and blue again on the output — a double swap that left the two exchanged on
 * exactly half the green sites. Every structural test above still passed; this
 * one failed at 256 of 1024 pixels and named them.
 */
describe("equivalence with the published kernels", () => {
  const K_G = [
    [0, 0, -1, 0, 0],
    [0, 0, 2, 0, 0],
    [-1, 2, 4, 2, -1],
    [0, 0, 2, 0, 0],
    [0, 0, -1, 0, 0],
  ];
  const K_RB = [
    [0, 0, -1.5, 0, 0],
    [0, 2, 0, 2, 0],
    [-1.5, 0, 6, 0, -1.5],
    [0, 2, 0, 2, 0],
    [0, 0, -1.5, 0, 0],
  ];
  /** The colour lies HORIZONTALLY from the green site; K_V is its transpose. */
  const K_H = [
    [0, 0, 0.5, 0, 0],
    [0, -1, 0, -1, 0],
    [-1, 4, 5, 4, -1],
    [0, -1, 0, -1, 0],
    [0, 0, 0.5, 0, 0],
  ];
  const K_V = K_H[0].map((_, c) => K_H.map((row) => row[c]));

  it("every kernel sums to 8, so none of them shifts a flat colour", () => {
    for (const K of [K_G, K_RB, K_H, K_V])
      expect(K.flat().reduce((a, b) => a + b, 0)).toBeCloseTo(8, 10);
  });

  it("agrees with a literal 5×5 convolution at every interior pixel", () => {
    const S = 40;
    const rand = new Float32Array(S * S);
    let seed = 12345;
    for (let i = 0; i < rand.length; i++)
      rand[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const at = (x: number, y: number) =>
      rand[(y < 0 ? 0 : y >= S ? S - 1 : y) * S + (x < 0 ? 0 : x >= S ? S - 1 : x)];
    const conv = (K: number[][], x: number, y: number) => {
      let s = 0;
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) s += K[j + 2][i + 2] * at(x + i, y + j);
      return s / 8;
    };
    const out: RGBOut = { r: 0, g: 0, b: 0 };
    const bad: string[] = [];
    for (let y = 4; y < S - 4; y++) {
      for (let x = 4; x < S - 4; x++) {
        demosaicMHC(at, colorAt, x, y, out);
        const c = colorAt(x, y);
        let R: number;
        let G: number;
        let B: number;
        if (c === 1) {
          const rowHasR = colorAt(x - 1, y) === 0;
          G = at(x, y);
          R = conv(rowHasR ? K_H : K_V, x, y);
          B = conv(rowHasR ? K_V : K_H, x, y);
        } else if (c === 0) {
          R = at(x, y);
          G = conv(K_G, x, y);
          B = conv(K_RB, x, y);
        } else {
          B = at(x, y);
          G = conv(K_G, x, y);
          R = conv(K_RB, x, y);
        }
        if (
          Math.abs(out.r - R) > 1e-9 ||
          Math.abs(out.g - G) > 1e-9 ||
          Math.abs(out.b - B) > 1e-9
        )
          bad.push(`(${x},${y}) colour ${c}`);
      }
    }
    expect(bad.slice(0, 5).join(", ") || "none").toBe("none");
  });
});
