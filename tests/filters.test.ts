/**
 * filters.ts — the smart-filter stack model and the ImageData passes.
 *
 * Two different kinds of test live here. The stack model (defaults, labels,
 * hashing, preview scaling) is checked exhaustively over every FilterType, so
 * adding a filter without wiring it up fails here rather than in the UI. The
 * pixel passes are checked by construction: build an image whose correct output
 * can be worked out by hand, run the filter, and read the answer back.
 *
 * The most load-bearing of those is the mosaic transparency case. Averaging a
 * cell in STRAIGHT RGB lets transparent pixels vote their black, so a mostly
 * transparent red block turns dark red — the reason the code premultiplies. The
 * test pins the colour to exactly 255, which only the premultiplied average
 * gives.
 */
import { describe, expect, it } from "vitest";
import {
  FILTER_LABELS,
  applyFilter,
  defaultFilter,
  filterLabel,
  filterStackHash,
  hasEnabledFilters,
  premultChannels,
  scaleFilterParams,
  type FilterType,
  type SmartFilter,
} from "@/app/lib/filters";

const TYPES = Object.keys(FILTER_LABELS) as FilterType[];
const CS: PredefinedColorSpace = "srgb";

/** An image built from a per-pixel function. */
function image(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
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
  return new ImageData(d, w, h, { colorSpace: CS });
}
const px = (img: ImageData, x: number, y: number) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const solid = (w: number, h: number, c: [number, number, number, number]) => image(w, h, () => c);

describe("premultChannels", () => {
  it("scales colour by alpha and keeps alpha in bytes", () => {
    const d = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 128]);
    const { R, G, B, A } = premultChannels(d, 2);
    expect(R[0]).toBeCloseTo(200, 5);
    expect(A[0]).toBe(255);
    expect(R[1]).toBeCloseTo(200 * (128 / 255), 5);
    expect(G[1]).toBeCloseTo(100 * (128 / 255), 5);
    expect(B[1]).toBeCloseTo(50 * (128 / 255), 5);
    expect(A[1]).toBe(128);
  });

  it("zeroes the colour of a fully transparent pixel", () => {
    // Otherwise its (arbitrary) RGB bleeds into every blur that touches it.
    const { R, G, B, A } = premultChannels(new Uint8ClampedArray([255, 255, 255, 0]), 1);
    expect([R[0], G[0], B[0], A[0]]).toEqual([0, 0, 0, 0]);
  });
});

describe("the filter stack model", () => {
  it("has a default for every filter type", () => {
    for (const type of TYPES) {
      const f = defaultFilter(type);
      expect(f.type).toBe(type);
      expect(f.enabled).toBe(true);
      expect(f.opacity).toBe(100);
      expect(f.blendMode).toBe("Normal");
      expect(f.params).toBeTruthy();
    }
  });

  it("gives every filter its own id", () => {
    const ids = TYPES.map((t) => defaultFilter(t).id);
    expect(new Set(ids).size).toBe(TYPES.length);
    expect(defaultFilter("blur").id).not.toBe(defaultFilter("blur").id);
  });

  it("has a label for every type, including the per-variant ones", () => {
    for (const type of TYPES) {
      const label = filterLabel(defaultFilter(type));
      expect(label).toBeTruthy();
      expect(label).not.toContain("undefined");
    }
    const blur = defaultFilter("blur") as Extract<SmartFilter, { type: "blur" }>;
    expect(filterLabel({ ...blur, params: { ...blur.params, kind: "tiltshift" } })).toBe("Tilt-Shift Blur");
    expect(filterLabel({ ...blur, params: { ...blur.params, kind: "motion" } })).toBe("Motion Blur");
    const half = defaultFilter("halftone") as Extract<SmartFilter, { type: "halftone" }>;
    expect(filterLabel(half)).toBe("Color Halftone");
    expect(filterLabel({ ...half, params: { ...half.params, mono: true } })).toBe("Halftone");
    const dist = defaultFilter("distort") as Extract<SmartFilter, { type: "distort" }>;
    expect(filterLabel({ ...dist, params: { ...dist.params, mode: "wave" } })).toBe("Wave");
    const sty = defaultFilter("stylize") as Extract<SmartFilter, { type: "stylize" }>;
    expect(filterLabel({ ...sty, params: { ...sty.params, mode: "threshold" } })).toBe("Threshold");
  });

  it("knows when a stack does any work", () => {
    expect(hasEnabledFilters(undefined)).toBe(false);
    expect(hasEnabledFilters([])).toBe(false);
    expect(hasEnabledFilters([{ ...defaultFilter("blur"), enabled: false }])).toBe(false);
    expect(hasEnabledFilters([{ ...defaultFilter("blur"), enabled: false }, defaultFilter("noise")])).toBe(true);
  });

  it("hashes a stack by its contents, so a param change busts the cache", () => {
    const a = defaultFilter("pixelate") as Extract<SmartFilter, { type: "pixelate" }>;
    expect(filterStackHash(undefined)).toBe("");
    expect(filterStackHash([])).toBe("");
    expect(filterStackHash([a])).toBe(filterStackHash([{ ...a }]));
    expect(filterStackHash([a])).not.toBe(filterStackHash([{ ...a, params: { cellSize: 9 } }]));
    expect(filterStackHash([a])).not.toBe(filterStackHash([{ ...a, enabled: false }]));
    expect(filterStackHash([a])).not.toBe(filterStackHash([{ ...a, opacity: 50 }]));
  });

  it("hashes stack ORDER, since filters do not commute", () => {
    const a = defaultFilter("pixelate");
    const b = defaultFilter("noise");
    expect(filterStackHash([a, b])).not.toBe(filterStackHash([b, a]));
  });

  it("memoizes per array identity, which is why the array must be treated as immutable", () => {
    const f = defaultFilter("pixelate") as Extract<SmartFilter, { type: "pixelate" }>;
    const stack = [f];
    const first = filterStackHash(stack);
    stack[0] = { ...f, params: { cellSize: 40 } }; // mutated in place
    expect(filterStackHash(stack)).toBe(first); // stale — by design
    expect(filterStackHash([...stack])).not.toBe(first); // a new array re-reads it
  });
});

describe("scaleFilterParams", () => {
  it("is a no-op at scale 1, for every type", () => {
    for (const type of TYPES) {
      const f = defaultFilter(type);
      expect(scaleFilterParams(f, 1)).toEqual(f);
    }
  });

  it("shrinks pixel-unit parameters with the preview", () => {
    const sharpen = defaultFilter("sharpen") as Extract<SmartFilter, { type: "sharpen" }>;
    const half = scaleFilterParams(sharpen, 0.5) as typeof sharpen;
    expect(half.params.radius).toBe(sharpen.params.radius * 0.5);
    expect(half.params.amount).toBe(sharpen.params.amount); // a percentage: unscaled
    expect(half.params.threshold).toBe(sharpen.params.threshold); // a value: unscaled

    const pix = defaultFilter("pixelate") as Extract<SmartFilter, { type: "pixelate" }>;
    expect((scaleFilterParams(pix, 0.5) as typeof pix).params.cellSize).toBe(4);
  });

  it("leaves a blur whose amount is not in pixels alone", () => {
    const blur = defaultFilter("blur") as Extract<SmartFilter, { type: "blur" }>;
    const gauss = scaleFilterParams(blur, 0.5) as typeof blur;
    expect(gauss.params.amount).toBe(4); // gaussian: pixels
    for (const kind of ["zoom", "spin"] as const) {
      const f = { ...blur, params: { ...blur.params, kind } };
      // zoom is a percentage and spin is degrees — scaling either would show a
      // different filter in the preview than in the final render.
      expect(scaleFilterParams(f, 0.5)).toEqual(f);
    }
  });

  it("scales only the spatial half of a mixed param set", () => {
    const dist = defaultFilter("distort") as Extract<SmartFilter, { type: "distort" }>;
    expect(scaleFilterParams(dist, 0.5)).toEqual(dist); // twirl: degrees + %
    const wave = { ...dist, params: { ...dist.params, mode: "wave" as const } };
    const scaled = scaleFilterParams(wave, 0.5) as typeof wave;
    expect(scaled.params.amplitude).toBe(5);
    expect(scaled.params.wavelength).toBe(30);
    expect(scaled.params.angle).toBe(wave.params.angle);

    const sty = defaultFilter("stylize") as Extract<SmartFilter, { type: "stylize" }>;
    expect(scaleFilterParams(sty, 0.5)).toEqual(sty); // findEdges has no spatial param
    const emboss = { ...sty, params: { ...sty.params, mode: "emboss" as const, height: 8 } };
    expect((scaleFilterParams(emboss, 0.5) as typeof emboss).params.height).toBe(4);
    expect((scaleFilterParams(emboss, 0.5) as typeof emboss).params.levels).toBe(sty.params.levels);
  });

  it("never scales a radius down to nothing", () => {
    // A radius of 0 is a different filter (or a divide-by-zero), so each case
    // floors it however small the preview gets.
    for (const type of TYPES) {
      const tiny = scaleFilterParams(defaultFilter(type), 0.001);
      const params = tiny.params as unknown as Record<string, unknown>;
      for (const key of ["radius", "size", "cellSize", "wavelength", "blockSize", "height"]) {
        if (typeof params[key] === "number") expect(params[key] as number).toBeGreaterThan(0);
      }
      expect(JSON.stringify(tiny)).not.toContain("null");
    }
  });
});

describe("applyFilter", () => {
  it("returns a same-sized, independent buffer for every filter type", () => {
    const src = image(16, 16, (x, y) => [x * 16, y * 16, 128, x < 8 ? 255 : 90]);
    const before = [...src.data];
    for (const type of TYPES) {
      const out = applyFilter(src, defaultFilter(type), CS);
      expect(out.width, type).toBe(16);
      expect(out.height, type).toBe(16);
      expect(out.data.length, type).toBe(16 * 16 * 4);
      expect(out.data, type).not.toBe(src.data);
      expect([...src.data], `${type} mutated its input`).toEqual(before);
      // Nothing may come back as NaN — a Uint8ClampedArray would silently store 0.
      expect([...out.data].every((v) => Number.isFinite(v)), type).toBe(true);
    }
  });

  describe("mosaic", () => {
    const mosaicOf = (src: ImageData, cellSize: number) =>
      applyFilter(src, { ...defaultFilter("pixelate"), type: "pixelate", params: { cellSize } }, CS);

    it("flattens each cell to one colour", () => {
      const src = image(4, 4, (x, y) => [x * 60, y * 60, 0, 255]);
      const out = mosaicOf(src, 2);
      for (const [ox, oy] of [
        [0, 0],
        [2, 0],
        [0, 2],
        [2, 2],
      ]) {
        const first = px(out, ox, oy);
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          expect(px(out, ox + dx, oy + dy)).toEqual(first);
        }
      }
    });

    it("uses the cell's average", () => {
      const src = image(2, 2, (x) => [x === 0 ? 0 : 100, 0, 0, 255]);
      expect(px(mosaicOf(src, 2), 0, 0)[0]).toBe(50);
    });

    it("does not let transparent pixels vote on the colour", () => {
      // One opaque red pixel in a 2×2 cell with three transparent WHITE ones.
      // Erased pixels keep their colour bytes in practice, so this is the real
      // shape of the problem: averaging straight RGB would return white, while
      // the premultiplied average keeps the red and only averages the alpha.
      const src = image(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [255, 255, 255, 0]));
      const [r, g, b, a] = px(mosaicOf(src, 2), 1, 1);
      expect(r).toBe(255);
      expect(g).toBe(0);
      expect(b).toBe(0);
      expect(a).toBe(64); // 255/4, rounded
    });

    it("clamps a cell bigger than the image instead of reading past it", () => {
      const src = image(3, 3, () => [10, 20, 30, 255]);
      const out = mosaicOf(src, 512);
      expect(px(out, 2, 2)).toEqual([10, 20, 30, 255]);
    });
  });

  describe("stylize", () => {
    const stylizeOf = (src: ImageData, params: Partial<Extract<SmartFilter, { type: "stylize" }>["params"]>) => {
      const base = defaultFilter("stylize") as Extract<SmartFilter, { type: "stylize" }>;
      return applyFilter(src, { ...base, params: { ...base.params, ...params } }, CS);
    };

    it("posterizes to exactly the requested number of levels", () => {
      const ramp = image(256, 1, (x) => [x, x, x, 255]);
      for (const levels of [2, 4, 8]) {
        const out = stylizeOf(ramp, { mode: "posterize", levels });
        const seen = new Set<number>();
        for (let x = 0; x < 256; x++) seen.add(px(out, x, 0)[0]);
        expect(seen.size).toBe(levels);
        expect(Math.min(...seen)).toBe(0);
        expect(Math.max(...seen)).toBe(255);
      }
    });

    it("thresholds on luminance, not on the raw channels", () => {
      // Pure green (luma 150) is above a 128 threshold; pure blue (luma 29) is
      // not — a per-channel threshold would get both wrong.
      const src = image(3, 1, (x) =>
        x === 0 ? [255, 0, 0, 255] : x === 1 ? [0, 255, 0, 255] : [0, 0, 255, 200],
      );
      const out = stylizeOf(src, { mode: "threshold", level: 128 });
      expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]); // red luma 76
      expect(px(out, 1, 0)).toEqual([255, 255, 255, 255]); // green luma 150
      expect(px(out, 2, 0)).toEqual([0, 0, 0, 200]); // blue luma 29, alpha kept
    });

    it("finds no edges in a flat image", () => {
      // Every Sobel response is zero, and the result is inverted, so flat white.
      const out = stylizeOf(solid(8, 8, [70, 70, 70, 255]), { mode: "findEdges" });
      for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
    });

    it("darkens exactly where an edge is", () => {
      const src = image(8, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
      const out = stylizeOf(src, { mode: "findEdges" });
      expect(px(out, 3, 4)[0]).toBeLessThan(128); // on the edge
      expect(px(out, 0, 4)[0]).toBe(255); // far from it
      expect(px(out, 7, 4)[0]).toBe(255);
    });

    it("embosses to mid-grey where nothing changes", () => {
      const out = stylizeOf(solid(8, 8, [200, 30, 60, 255]), { mode: "emboss" });
      expect(px(out, 4, 4)).toEqual([128, 128, 128, 255]);
    });
  });

  describe("noise", () => {
    const noiseOf = (src: ImageData, params: Partial<Extract<SmartFilter, { type: "noise" }>["params"]>) => {
      const base = defaultFilter("noise") as Extract<SmartFilter, { type: "noise" }>;
      return applyFilter(src, { ...base, params: { ...base.params, ...params } }, CS);
    };
    const flat = () => solid(16, 16, [128, 128, 128, 255]);

    it("is reproducible for a given seed", () => {
      // Filters re-run on every composite; noise that re-rolled would shimmer.
      expect([...noiseOf(flat(), { seed: 7 }).data]).toEqual([...noiseOf(flat(), { seed: 7 }).data]);
    });

    it("changes with the seed", () => {
      expect([...noiseOf(flat(), { seed: 7 }).data]).not.toEqual([...noiseOf(flat(), { seed: 8 }).data]);
    });

    it("leaves fully transparent pixels alone", () => {
      const src = image(8, 8, (x) => (x < 4 ? [128, 128, 128, 255] : [128, 128, 128, 0]));
      const out = noiseOf(src, { amount: 100 });
      for (let y = 0; y < 8; y++) {
        for (let x = 4; x < 8; x++) expect(px(out, x, y)).toEqual([128, 128, 128, 0]);
      }
      // ...and really did disturb the opaque half, so the check above means something.
      let moved = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) if (px(out, x, y)[0] !== 128) moved++;
      expect(moved).toBeGreaterThan(16);
    });

    it("moves all three channels together when monochromatic", () => {
      const out = noiseOf(flat(), { amount: 60, monochromatic: true });
      for (let i = 0; i < out.data.length; i += 4) {
        expect(out.data[i]).toBe(out.data[i + 1]);
        expect(out.data[i + 1]).toBe(out.data[i + 2]);
      }
      const colour = noiseOf(flat(), { amount: 60, monochromatic: false });
      let split = 0;
      for (let i = 0; i < colour.data.length; i += 4) if (colour.data[i] !== colour.data[i + 1]) split++;
      expect(split).toBeGreaterThan(0);
    });

    it("does nothing at zero amount", () => {
      expect([...noiseOf(flat(), { amount: 0 }).data]).toEqual([...flat().data]);
    });
  });

  describe("blur", () => {
    const blurOf = (src: ImageData, amount: number) => {
      const base = defaultFilter("blur") as Extract<SmartFilter, { type: "blur" }>;
      return applyFilter(src, { ...base, params: { ...base.params, kind: "gaussian", amount } }, CS);
    };

    it("leaves a uniform image uniform", () => {
      // Edge handling that reads past the border shows up here as darkened or
      // lightened corners.
      const out = blurOf(solid(24, 24, [90, 140, 200, 255]), 6);
      for (const [x, y] of [
        [0, 0],
        [23, 0],
        [0, 23],
        [23, 23],
        [12, 12],
      ]) {
        expect(px(out, x, y)[0]).toBeGreaterThanOrEqual(88);
        expect(px(out, x, y)[0]).toBeLessThanOrEqual(92);
        expect(px(out, x, y)[3]).toBe(255);
      }
    });

    it("spreads a bright spot into its neighbours", () => {
      const src = image(21, 21, (x, y) => (x === 10 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
      const out = blurOf(src, 4);
      expect(px(out, 10, 10)[0]).toBeLessThan(255);
      expect(px(out, 12, 10)[0]).toBeGreaterThan(0);
      // ...and it falls off with distance rather than smearing flat.
      expect(px(out, 11, 10)[0]).toBeGreaterThanOrEqual(px(out, 14, 10)[0]);
    });

    it("does not drag colour out of transparent regions", () => {
      // A red square on empty space. The interesting pixel is one on the soft
      // edge, where the transparent surround has a say: its alpha must fall,
      // but its colour must stay red. Blurring straight (non-premultiplied) RGB
      // instead averages in the surround's black and leaves a dark fringe.
      const src = image(24, 24, (x, y) =>
        x >= 4 && x < 20 && y >= 4 && y < 20 ? [255, 0, 0, 255] : [0, 0, 0, 0],
      );
      const out = blurOf(src, 3);
      expect(px(out, 12, 12)).toEqual([255, 0, 0, 255]); // deep inside: untouched

      const [r, g, b, a] = px(out, 4, 12); // on the edge
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(255);
      expect(r).toBeGreaterThan(240);
      expect(g).toBeLessThan(12);
      expect(b).toBeLessThan(12);
    });
  });
});
