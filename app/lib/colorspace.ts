// Working colour spaces beyond what Canvas 2D natively provides.
//
// Browsers can create canvases only in sRGB or Display P3 — those two remain
// the native working spaces (storage, display and export are colour-managed by
// the browser). **Adobe RGB (1998) is an EMULATED working space**: pixels stay
// stored/displayed on an sRGB canvas (a browser can neither display nor export
// an Adobe RGB canvas), and the ADJUSTMENT PIPELINE — slider adjustments and
// Curves/Levels — converts into Adobe RGB primaries with the matrices below,
// runs its math there, and converts back. That reproduces how the same edit
// behaves in an Adobe RGB workflow (per-channel curves, saturation moves and
// white-balance shifts land differently in different primaries), while being
// honest about the limit: colours outside sRGB still clip at the canvas.
//
// Conversion math (D65, no chromatic adaptation needed — both spaces are D65):
//   sRGB bytes → linear (IEC 61966-2-1 piecewise) → XYZ → Adobe linear →
//   Adobe gamma (pure 563/256 ≈ 2.19921875 power) → bytes, and the inverse.
// The combined 3×3 matrices are computed at module load from the published
// primaries-to-XYZ matrices (fewer transcription errors than hand-typing the
// products), and encoding uses exact Math.pow — precision over speed here.

export type WorkingSpace = "srgb" | "display-p3" | "adobe-rgb";

/** The native canvas space that backs a working space. */
export function canvasSpaceOf(ws: WorkingSpace): PredefinedColorSpace {
  return ws === "display-p3" ? "display-p3" : "srgb";
}

export const WORKING_SPACE_LABELS: Record<WorkingSpace, string> = {
  srgb: "sRGB",
  "display-p3": "Display P3",
  "adobe-rgb": "Adobe RGB (1998)",
};

export function isWorkingSpace(v: unknown): v is WorkingSpace {
  return v === "srgb" || v === "display-p3" || v === "adobe-rgb";
}

// ---- Matrices -------------------------------------------------------------

type Mat3 = [number, number, number, number, number, number, number, number, number];

// Linear RGB → XYZ (D65), standard published values.
const SRGB_TO_XYZ: Mat3 = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041,
];
const ADOBE_TO_XYZ: Mat3 = [
  0.5767309, 0.1855540, 0.1881852,
  0.2973769, 0.6273491, 0.0752741,
  0.0270343, 0.0706872, 0.9911085,
];

function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

function mul3(x: Mat3, y: Mat3): Mat3 {
  const o = new Array<number>(9) as unknown as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = x[r * 3] * y[c] + x[r * 3 + 1] * y[3 + c] + x[r * 3 + 2] * y[6 + c];
  return o;
}

const SRGB_LIN_TO_ADOBE_LIN = mul3(invert3(ADOBE_TO_XYZ), SRGB_TO_XYZ);
const ADOBE_LIN_TO_SRGB_LIN = mul3(invert3(SRGB_TO_XYZ), ADOBE_TO_XYZ);

// ---- Transfer functions ----------------------------------------------------

const ADOBE_GAMMA = 563 / 256; // 2.19921875 exactly, per the Adobe RGB spec

// 256-entry decode LUTs (exact: one entry per possible byte).
const SRGB_DECODE = new Float64Array(256);
const ADOBE_DECODE = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_DECODE[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  ADOBE_DECODE[i] = Math.pow(c, ADOBE_GAMMA);
}

function srgbEncode(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function adobeEncode(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.pow(c, 1 / ADOBE_GAMMA);
}

// ---- In-place image converters ----------------------------------------------

function convertInPlace(d: Uint8ClampedArray, decode: Float64Array, m: Mat3, encode: (v: number) => number) {
  for (let i = 0; i < d.length; i += 4) {
    const r = decode[d[i]];
    const g = decode[d[i + 1]];
    const b = decode[d[i + 2]];
    // Uint8ClampedArray assignment rounds to nearest — no manual +0.5 (that
    // would double-round and bias every value up half a step).
    d[i] = encode(m[0] * r + m[1] * g + m[2] * b) * 255;
    d[i + 1] = encode(m[3] * r + m[4] * g + m[5] * b) * 255;
    d[i + 2] = encode(m[6] * r + m[7] * g + m[8] * b) * 255;
  }
}

/** Reinterpret sRGB-encoded bytes as Adobe RGB-encoded bytes (same colours,
 *  Adobe primaries + gamma). sRGB ⊂ Adobe RGB, so nothing clips here. */
export function srgbToAdobeInPlace(d: Uint8ClampedArray): void {
  convertInPlace(d, SRGB_DECODE, SRGB_LIN_TO_ADOBE_LIN, adobeEncode);
}

/** Convert Adobe RGB-encoded bytes back to sRGB. Colours the adjustment pushed
 *  outside the sRGB gamut clip to it (the display/storage limit). */
export function adobeToSrgbInPlace(d: Uint8ClampedArray): void {
  convertInPlace(d, ADOBE_DECODE, ADOBE_LIN_TO_SRGB_LIN, srgbEncode);
}

// ---- 16-bit/channel intermediates -------------------------------------------
// The high-bit adjustment path: canvas bytes decode STRAIGHT to Adobe RGBA16
// (no byte-quantized middle step), the math runs at 16 bits, and one final
// quantization writes the sRGB bytes — an identity adjustment roundtrips
// byte-exact, and every real adjustment quantizes once instead of three times.

/** sRGB canvas bytes → Adobe RGB RGBA16 (alpha widened ×257). */
export function srgbBytesToAdobe16(d: Uint8ClampedArray): Uint16Array {
  const m = SRGB_LIN_TO_ADOBE_LIN;
  const out = new Uint16Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = SRGB_DECODE[d[i]];
    const g = SRGB_DECODE[d[i + 1]];
    const b = SRGB_DECODE[d[i + 2]];
    out[i] = adobeEncode(m[0] * r + m[1] * g + m[2] * b) * 65535 + 0.5;
    out[i + 1] = adobeEncode(m[3] * r + m[4] * g + m[5] * b) * 65535 + 0.5;
    out[i + 2] = adobeEncode(m[6] * r + m[7] * g + m[8] * b) * 65535 + 0.5;
    out[i + 3] = d[i + 3] * 257;
  }
  return out;
}

// ---- Soft proofing -----------------------------------------------------------
// Simulate how the document will look in a TARGET space, and/or highlight the
// pixels that fall outside its gamut — on the VIEW only (never the pixels).
// Decode the canvas bytes to linear, convert to the target's primaries, clip
// to [0,1] (that clipping IS the simulation), convert back for display.
// Display P3 shares sRGB's transfer curve, so the byte decode/encode tables
// serve both; only the primaries matrices differ.

export type ProofTarget = "srgb" | "display-p3" | "adobe-rgb";

export const PROOF_TARGET_LABELS: Record<ProofTarget, string> = {
  srgb: "sRGB",
  "display-p3": "Display P3",
  "adobe-rgb": "Adobe RGB (1998)",
};

const P3_TO_XYZ: Mat3 = [
  0.4865709, 0.2656677, 0.1982173,
  0.2289746, 0.6917385, 0.0792869,
  0.0, 0.0451134, 1.0439444,
];

function toXYZ(space: PredefinedColorSpace | ProofTarget): Mat3 {
  return space === "display-p3" ? P3_TO_XYZ : space === "adobe-rgb" ? ADOBE_TO_XYZ : SRGB_TO_XYZ;
}

/** Is every colour of `doc` inside `target`'s gamut (proofing = identity)? */
export function proofIsIdentity(doc: PredefinedColorSpace, target: ProofTarget): boolean {
  if ((doc as string) === (target as string)) return true;
  return doc === "srgb"; // sRGB ⊂ Display P3 and sRGB ⊂ Adobe RGB
}

const proofMatrixCache = new Map<string, { fwd: Mat3; back: Mat3 }>();
function proofMatrices(doc: PredefinedColorSpace, target: ProofTarget) {
  const key = doc + ">" + target;
  let m = proofMatrixCache.get(key);
  if (!m) {
    m = { fwd: mul3(invert3(toXYZ(target)), toXYZ(doc)), back: mul3(invert3(toXYZ(doc)), toXYZ(target)) };
    proofMatrixCache.set(key, m);
  }
  return m;
}

const OOG_EPS = 1 / 512; // half a byte step past the gamut boundary
const WARN = [128, 128, 128]; // Photoshop-style mid-grey gamut warning

/** Proof `d` (canvas bytes in `doc` space) against `target` in place:
 *  `simulate` clips colours to the target gamut (the soft proof);
 *  `warn` paints out-of-gamut pixels mid-grey. Alpha untouched. */
export function proofTransformInPlace(
  d: Uint8ClampedArray,
  doc: PredefinedColorSpace,
  target: ProofTarget,
  simulate: boolean,
  warn: boolean,
): void {
  if (proofIsIdentity(doc, target) || (!simulate && !warn)) return;
  const { fwd, back } = proofMatrices(doc, target);
  for (let i = 0; i < d.length; i += 4) {
    const r = SRGB_DECODE[d[i]]; // sRGB curve serves sRGB AND Display P3 docs
    const g = SRGB_DECODE[d[i + 1]];
    const b = SRGB_DECODE[d[i + 2]];
    let tr = fwd[0] * r + fwd[1] * g + fwd[2] * b;
    let tg = fwd[3] * r + fwd[4] * g + fwd[5] * b;
    let tb = fwd[6] * r + fwd[7] * g + fwd[8] * b;
    const oog =
      tr < -OOG_EPS || tr > 1 + OOG_EPS ||
      tg < -OOG_EPS || tg > 1 + OOG_EPS ||
      tb < -OOG_EPS || tb > 1 + OOG_EPS;
    if (warn && oog) {
      d[i] = WARN[0];
      d[i + 1] = WARN[1];
      d[i + 2] = WARN[2];
      continue;
    }
    if (!simulate || !oog) continue; // in-gamut pixels display identically
    // Clip in the target's linear space, then bring back for display. (The
    // target's transfer curve cancels out — clipping happens on linear.)
    tr = tr < 0 ? 0 : tr > 1 ? 1 : tr;
    tg = tg < 0 ? 0 : tg > 1 ? 1 : tg;
    tb = tb < 0 ? 0 : tb > 1 ? 1 : tb;
    d[i] = srgbEncode(back[0] * tr + back[1] * tg + back[2] * tb) * 255;
    d[i + 1] = srgbEncode(back[3] * tr + back[4] * tg + back[5] * tb) * 255;
    d[i + 2] = srgbEncode(back[6] * tr + back[7] * tg + back[8] * tb) * 255;
  }
}

// Lazy 65k Adobe-decode table (one pow per entry, built on first use).
let ADOBE_DECODE16: Float32Array | null = null;

/** Adobe RGB RGBA16 → sRGB canvas bytes (single final quantization; colours
 *  outside the sRGB gamut clip). */
export function adobe16ToSrgbBytes(s16: Uint16Array, out: Uint8ClampedArray): void {
  if (!ADOBE_DECODE16) {
    ADOBE_DECODE16 = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) ADOBE_DECODE16[i] = Math.pow(i / 65535, ADOBE_GAMMA);
  }
  const lut = ADOBE_DECODE16;
  const m = ADOBE_LIN_TO_SRGB_LIN;
  for (let i = 0; i < s16.length; i += 4) {
    const r = lut[s16[i]];
    const g = lut[s16[i + 1]];
    const b = lut[s16[i + 2]];
    // Uint8ClampedArray rounds + clamps on assignment.
    out[i] = srgbEncode(m[0] * r + m[1] * g + m[2] * b) * 255;
    out[i + 1] = srgbEncode(m[3] * r + m[4] * g + m[5] * b) * 255;
    out[i + 2] = srgbEncode(m[6] * r + m[7] * g + m[8] * b) * 255;
    out[i + 3] = s16[i + 3] / 257;
  }
}
