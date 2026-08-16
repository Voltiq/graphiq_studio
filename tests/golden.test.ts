/**
 * Golden-image tests for the filters, adjustments and tone maps.
 *
 * The unit tests in `filters.test.ts` / `tone.test.ts` assert PROPERTIES — that
 * a mosaic cell is uniform, that a curve does not overshoot. Those catch a
 * filter that is wrong. They do not catch a filter that is merely *different*:
 * a refactor that shifts every pixel by two levels, a changed rounding rule, a
 * kernel that quietly stopped premultiplying in a case no property covers.
 *
 * So each pass is run over fixed fixture images and its output hashed, with the
 * hashes checked in. Any change to the numbers a filter produces then has to be
 * looked at and consciously accepted, instead of arriving unnoticed.
 *
 *   npm test                                    verify
 *   UPDATE_GOLDENS=1 npx vitest run tests/golden.test.ts    re-record
 *
 * The baseline stores per-channel means alongside the hash. A hash alone tells
 * you something moved; the means tell you WHICH WAY, which is the difference
 * between triaging a diff in seconds and re-deriving it by hand.
 *
 * Caveat worth stating plainly: `Math.pow`/`exp`/`sin` are not required to be
 * correctly rounded, so a JS-engine change could in principle shift a byte
 * without any code changing. In practice the 8-bit quantization absorbs
 * last-ULP drift; if a golden ever fails with a max delta of 1 on a handful of
 * pixels and no relevant code changed, that is what happened.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyFilter,
  defaultFilter,
  scaleFilterParams,
  type FilterType,
  type SmartFilter,
} from "@/app/lib/filters";
import {
  DEFAULT_ADJUST,
  FILTER_PRESETS,
  applyAdjustments,
  applyAdjustments16,
  filterToAdjust,
  type Adjustments,
} from "@/app/lib/adjust";
import { applyExtraAdjustment, defaultExtra, type ExtraAdjustment } from "@/app/lib/adjust-extra";
import {
  CURVE_PRESETS,
  applyToneLUTs,
  applyToneLUTs16,
  buildCurvesLUTs,
  buildCurvesLUTs16,
  buildLevelsLUTs,
  buildLevelsLUTs16,
  defaultCurves,
  defaultLevels,
} from "@/app/lib/tone";
import { FIXTURES, fixture } from "./golden/fixtures";

const FIXTURES16 = FIXTURES.map((f) => ({ name: f.name, w: f.width, h: f.height }));

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "golden", "baseline.json");
const UPDATING = !!process.env.UPDATE_GOLDENS;

interface Shot {
  hash: string;
  /** Per-channel means, 2dp — so a failure says which way the pixels moved. */
  mean: [number, number, number, number];
  nonEmpty: number;
}

const fnv = (d: Uint8ClampedArray): string => {
  let a = 0x811c9dc5;
  let b = 0x9dc5811c;
  for (let i = 0; i < d.length; i++) {
    a = Math.imul(a ^ d[i], 0x01000193);
    b = Math.imul(b ^ d[i], 0x01000197);
  }
  return (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
};

const shoot = (d: Uint8ClampedArray): Shot => {
  const sum = [0, 0, 0, 0];
  let nonEmpty = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum[0] += d[i];
    sum[1] += d[i + 1];
    sum[2] += d[i + 2];
    sum[3] += d[i + 3];
    if (d[i + 3] > 0) nonEmpty++;
  }
  const n = d.length / 4;
  return {
    hash: fnv(d),
    mean: sum.map((s) => Math.round((s / n) * 100) / 100) as [number, number, number, number],
    nonEmpty,
  };
};

const recorded: Record<string, Shot> = existsSync(BASELINE)
  ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, Shot>)
  : {};
const produced: Record<string, Shot> = {};

/** Run one case, compare with (or record) its golden. */
function golden(key: string, produce: () => Uint8ClampedArray) {
  const got = shoot(produce());
  produced[key] = got;
  if (UPDATING) return;
  const want = recorded[key];
  if (!want) {
    throw new Error(
      `no golden recorded for "${key}".\n` +
        `Add it with:  UPDATE_GOLDENS=1 npx vitest run tests/golden.test.ts`,
    );
  }
  if (got.hash !== want.hash) {
    throw new Error(
      `golden mismatch for "${key}"\n` +
        `        was  ${want.hash}  mean rgba ${want.mean.join(", ")}  ink ${want.nonEmpty}\n` +
        `        now  ${got.hash}  mean rgba ${got.mean.join(", ")}  ink ${got.nonEmpty}\n` +
        `If the change is intended:  UPDATE_GOLDENS=1 npx vitest run tests/golden.test.ts`,
    );
  }
}

const CS: PredefinedColorSpace = "srgb";
const IMAGES = ["photo", "alpha", "edges"] as const;
const withParams = <T extends FilterType>(type: T, params: object): SmartFilter =>
  ({ ...defaultFilter(type), params: { ...defaultFilter(type).params, ...params } }) as SmartFilter;

describe("golden — filters", () => {
  const TYPES: FilterType[] = [
    "blur", "sharpen", "noise", "pixelate", "distort", "stylize", "highpass", "median",
    "dustscratches", "denoise", "lens", "dehaze", "clarity", "grain", "oil", "halftone",
    "crystallize", "glitch", "canvasshadow",
  ];

  for (const type of TYPES) {
    for (const img of IMAGES) {
      it(`${type} on ${img}`, () => {
        golden(`filter/${type}/${img}`, () => applyFilter(fixture(img), defaultFilter(type), CS).data);
      });
    }
  }

  // The variants are separate implementations behind one type, so defaults alone
  // would leave most of the distort/stylize/blur code unrecorded.
  const VARIANTS: [string, SmartFilter][] = [
    ...(["gaussian", "motion", "zoom", "spin", "tiltshift", "box"] as const).map(
      (kind) => [`blur-${kind}`, withParams("blur", { kind })] as [string, SmartFilter],
    ),
    ...(["twirl", "pinch", "wave"] as const).map(
      (mode) => [`distort-${mode}`, withParams("distort", { mode })] as [string, SmartFilter],
    ),
    ...(["findEdges", "emboss", "posterize", "threshold"] as const).map(
      (mode) => [`stylize-${mode}`, withParams("stylize", { mode })] as [string, SmartFilter],
    ),
    ["halftone-mono", withParams("halftone", { mono: true })],
    ["noise-uniform", withParams("noise", { distribution: "uniform", monochromatic: false })],
  ];
  for (const [name, f] of VARIANTS) {
    it(name, () => {
      golden(`filter/${name}/edges`, () => applyFilter(fixture("edges"), f, CS).data);
    });
  }

  // The half-resolution preview runs the stack through `scaleFilterParams`, so
  // every spatial filter also has to be right at FRACTIONAL parameters — and
  // only there. Changing mosaic's cell rounding from `round` to `ceil` moved
  // nothing at all while the goldens used defaults, because every default
  // spatial parameter happens to be a whole number. 0.55 is chosen over the
  // literal 0.5 for exactly that reason: it lands the params off the integers.
  const SCALED: FilterType[] = [
    "blur", "sharpen", "pixelate", "highpass", "median", "dustscratches", "denoise",
    "dehaze", "clarity", "grain", "oil", "halftone", "crystallize", "glitch", "canvasshadow",
  ];
  for (const type of SCALED) {
    it(`${type} at preview scale`, () => {
      golden(`filter/${type}/scaled`, () =>
        applyFilter(fixture("edges"), scaleFilterParams(defaultFilter(type), 0.55), CS).data,
      );
    });
  }
  it("distort wave at preview scale", () =>
    golden("filter/distort-wave/scaled", () =>
      applyFilter(fixture("edges"), scaleFilterParams(withParams("distort", { mode: "wave" }), 0.55), CS).data,
    ));
  it("stylize emboss at preview scale", () =>
    golden("filter/stylize-emboss/scaled", () =>
      applyFilter(fixture("edges"), scaleFilterParams(withParams("stylize", { mode: "emboss", height: 5 }), 0.55), CS)
        .data,
    ));
});

describe("golden — adjustments", () => {
  const adjusted = (a: Adjustments, img = "photo") => applyAdjustments(fixture(img), a, CS).data;

  for (const name of Object.keys(FILTER_PRESETS)) {
    it(`preset ${name}`, () => golden(`adjust/preset/${name}`, () => adjusted(filterToAdjust(name))));
  }

  // One slider at a time, at both ends: a preset moves several at once, so a
  // regression in any single one hides inside the others.
  for (const key of Object.keys(DEFAULT_ADJUST) as (keyof Adjustments)[]) {
    for (const v of [-100, 100]) {
      it(`${key} ${v}`, () =>
        golden(`adjust/${key}/${v}`, () => adjusted({ ...DEFAULT_ADJUST, [key]: v })));
    }
  }

  it("every slider at once, over transparency", () =>
    golden("adjust/all/alpha", () =>
      adjusted(
        Object.fromEntries(Object.keys(DEFAULT_ADJUST).map((k) => [k, 40])) as unknown as Adjustments,
        "alpha",
      ),
    ));
});

describe("golden — adjustments, 16-bit path", () => {
  // `applyAdjustments16` is a SECOND copy of the slider maths, used by the
  // emulated working spaces. Nothing above touches it: a mutation to the
  // exposure formula in that function changed no golden at all until these
  // existed, which is exactly the sort of hole a golden suite is meant to close.
  const to16 = (name: string) => {
    const src = fixture(name).data;
    const d = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) d[i] = src[i] * 257; // 0->0, 255->65535
    return d;
  };
  /** Narrow back to bytes so the shot format matches the 8-bit entries. */
  const narrow = (d: Uint16Array) => {
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i] / 257;
    return out;
  };
  const run16 = (a: Adjustments, name = "photo") => {
    const d = to16(name);
    const f = FIXTURES16.find((x) => x.name === name)!;
    applyAdjustments16(d, f.w, f.h, a);
    return narrow(d);
  };

  for (const name of Object.keys(FILTER_PRESETS)) {
    it(`preset ${name} (16-bit)`, () =>
      golden(`adjust16/preset/${name}`, () => run16(filterToAdjust(name))));
  }
  for (const key of Object.keys(DEFAULT_ADJUST) as (keyof Adjustments)[]) {
    it(`${key} 100 (16-bit)`, () =>
      golden(`adjust16/${key}/100`, () => run16({ ...DEFAULT_ADJUST, [key]: 100 })));
  }
  it("every slider at once, over transparency (16-bit)", () =>
    golden("adjust16/all/alpha", () =>
      run16(
        Object.fromEntries(Object.keys(DEFAULT_ADJUST).map((k) => [k, 40])) as unknown as Adjustments,
        "alpha",
      ),
    ));
});

describe("golden — extra adjustments", () => {
  // Deliberately non-neutral: `defaultExtra` is the identity for most of these,
  // and an identity pass would record the fixture back rather than the code.
  const SPECS: [string, ExtraAdjustment][] = [
    ["invert", { type: "invert" }],
    ["equalize", { type: "equalize" }],
    [
      "huesat",
      {
        type: "huesat",
        ranges: Array.from({ length: 7 }, (_, i) => ({ hue: i * 13 - 40, sat: 25, light: -10 })),
      },
    ],
    ["gradientmap", { type: "gradientmap", reverse: false, stops: [
      { color: "#101060ff", pos: 0 },
      { color: "#e08020ff", pos: 0.5 },
      { color: "#ffffffff", pos: 1 },
    ] }],
    ["chanmix", { type: "chanmix", mono: false, r: { r: 20, g: 60, b: 20, k: 5 }, g: { r: 0, g: 80, b: 20, k: 0 }, b: { r: 30, g: 0, b: 70, k: -5 } }],
    ["chanmix-mono", { type: "chanmix", mono: true, r: { r: 40, g: 40, b: 20, k: 0 }, g: { r: 0, g: 100, b: 0, k: 0 }, b: { r: 0, g: 0, b: 100, k: 0 } }],
    ["selective", { ...(defaultExtra("selective") as Extract<ExtraAdjustment, { type: "selective" }>), relative: false }],
  ];
  for (const [name, spec] of SPECS) {
    for (const img of ["photo", "alpha"] as const) {
      it(`${name} on ${img}`, () =>
        golden(`extra/${name}/${img}`, () => applyExtraAdjustment(fixture(img), spec).data));
    }
  }
});

describe("golden — tone", () => {
  for (const name of Object.keys(CURVE_PRESETS)) {
    it(`curve ${name}`, () =>
      golden(`tone/curve/${name}`, () => {
        const spec = defaultCurves();
        spec.channels.rgb = CURVE_PRESETS[name].map((p) => ({ ...p }));
        return applyToneLUTs(fixture("photo"), buildCurvesLUTs(spec)).data;
      }));
  }

  const splitLevels = () => {
    const spec = defaultLevels();
    spec.channels.rgb = { inBlack: 20, gamma: 1.3, inWhite: 230, outBlack: 0, outWhite: 255 };
    spec.channels.r = { inBlack: 0, gamma: 0.8, inWhite: 255, outBlack: 10, outWhite: 250 };
    spec.channels.b = { inBlack: 15, gamma: 1, inWhite: 240, outBlack: 0, outWhite: 255 };
    return spec;
  };

  it("levels, per channel", () =>
    golden("tone/levels/split", () =>
      applyToneLUTs(fixture("photo"), buildLevelsLUTs(splitLevels())).data,
    ));

  // Same two specs down the 65k-entry tables, for the same reason the 16-bit
  // adjustment path is covered: it is a second implementation, not a wrapper.
  const tone16 = (luts: ReturnType<typeof buildLevelsLUTs16>) => {
    const src = fixture("photo").data;
    const d = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) d[i] = src[i] * 257;
    applyToneLUTs16(d, luts);
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i] / 257;
    return out;
  };
  it("levels, per channel (16-bit)", () =>
    golden("tone16/levels/split", () => tone16(buildLevelsLUTs16(splitLevels()))));
  it("curve Increase Contrast (16-bit)", () =>
    golden("tone16/curve/contrast", () => {
      const spec = defaultCurves();
      spec.channels.rgb = CURVE_PRESETS["Increase Contrast"].map((p) => ({ ...p }));
      spec.channels.g = CURVE_PRESETS["Lighten Midtones"].map((p) => ({ ...p }));
      return tone16(buildCurvesLUTs16(spec));
    }));
});

describe("golden — the baseline itself", () => {
  it("has no stale entries", () => {
    // A golden left behind for a case that no longer runs is dead weight that
    // looks like coverage.
    const stale = Object.keys(recorded).filter((k) => !(k in produced));
    expect(stale, `stale goldens (re-record to prune): ${stale.join(", ")}`).toEqual([]);
  });
});

afterAll(() => {
  if (!UPDATING) return;
  mkdirSync(dirname(BASELINE), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(produced).sort().map((k) => [k, produced[k]]));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + "\n");
  const added = Object.keys(sorted).filter((k) => !(k in recorded));
  const changed = Object.keys(sorted).filter((k) => k in recorded && recorded[k].hash !== sorted[k].hash);
  const removed = Object.keys(recorded).filter((k) => !(k in sorted));
  console.log(
    `\ngoldens written: ${Object.keys(sorted).length} entries` +
      `  (+${added.length} new, ~${changed.length} changed, -${removed.length} pruned)`,
  );
  if (changed.length) console.log("  changed: " + changed.join(", "));
});
