/**
 * Fixture images for the golden tests.
 *
 * Built from integer arithmetic only — no `Math.sin`, `Math.pow` or `Math.sqrt`.
 * Those are not required by ECMAScript to be correctly rounded, so a V8 upgrade
 * could shift a fixture in its last bit and fail every golden at once, for a
 * reason having nothing to do with the code under test. The filters themselves
 * use transcendentals and that risk cannot be removed; there is no reason to
 * take it twice.
 *
 * Three images, each aimed at a different failure mode:
 *   photo  — smooth tonal ramps, fully opaque: adjustments and tone curves.
 *   alpha  — a soft-edged disc on a WHITE transparent surround: anything that
 *            averages neighbours must premultiply, or the surround bleeds in.
 *   edges  — hard checkerboard and a diagonal: spatial kernels (sharpen, find
 *            edges, median, high pass) have something to actually work on.
 */

export interface Fixture {
  name: string;
  width: number;
  height: number;
  make: () => ImageData;
}

const build = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const o = (y * w + x) * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = a;
    }
  }
  return new ImageData(d, w, h, { colorSpace: "srgb" });
};

const W = 64;
const H = 48;

export const FIXTURES: Fixture[] = [
  {
    name: "photo",
    width: W,
    height: H,
    make: () =>
      build(W, H, (x, y) => {
        // A saturated blob over two crossing ramps: highlights and shadows both
        // present, so exposure/contrast/curves have somewhere to clip.
        const dx = x - 20;
        const dy = y - 16;
        if (dx * dx + dy * dy < 100) return [240, 60, 30, 255];
        const dx2 = x - 46;
        const dy2 = y - 32;
        if (dx2 * dx2 + dy2 * dy2 < 64) return [20, 90, 200, 255];
        return [(x * 4) & 255, (y * 5) & 255, (x * y) & 255, 255];
      }),
  },
  {
    name: "alpha",
    width: W,
    height: H,
    make: () =>
      build(W, H, (x, y) => {
        const dx = x - 32;
        const dy = y - 24;
        const d2 = dx * dx + dy * dy;
        // Transparent pixels keep WHITE colour bytes, which is what erased
        // regions really look like — a filter that averages straight RGB pulls
        // that white inward and the fringe goes pale.
        if (d2 > 400) return [255, 255, 255, 0];
        if (d2 > 256) {
          const t = 400 - d2; // 0..144 across the rim
          return [200, 40, 120, Math.round((t * 255) / 144)];
        }
        return [200, 40, 120, 255];
      }),
  },
  {
    name: "edges",
    width: 48,
    height: 48,
    make: () =>
      build(48, 48, (x, y) => {
        if (x === y || x + y === 47) return [255, 220, 0, 255]; // diagonals
        return ((x >> 3) + (y >> 3)) % 2 === 0 ? [16, 16, 16, 255] : [235, 235, 235, 255];
      }),
  },
];

export const fixture = (name: string): ImageData => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture named ${name}`);
  return f.make();
};
