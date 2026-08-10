// Colour-vision accessibility (TODO §11) — simulation of colour-vision
// deficiencies, plus the colour-difference and contrast metrics used to DECIDE
// which accents are safe rather than guessing at them.
//
// Everything here is pure and DOM-free (Node-verifiable). No colour library:
// the dichromat simulation is the Viénot–Brettel–Mollon (1999) projection —
// linearize sRGB, convert to LMS with the Hunt–Pointer–Estévez matrix, collapse
// the missing cone onto the plane the remaining two span, convert back. It is
// the same method browsers and the classic `color-blindness` tools use, and it
// is a handful of matrix multiplies, which is exactly this project's style.

export type CvdType = "none" | "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";

export const CVD_TYPES: { id: CvdType; label: string; hint: string }[] = [
  { id: "none", label: "Off", hint: "Standard colours" },
  { id: "protanopia", label: "Protanopia", hint: "Red-blind — reds darken toward yellow" },
  { id: "deuteranopia", label: "Deuteranopia", hint: "Green-blind — the most common type" },
  { id: "tritanopia", label: "Tritanopia", hint: "Blue-blind — blues shift toward teal" },
  { id: "achromatopsia", label: "Monochromacy", hint: "No colour at all" },
];

export const isCvdType = (v: unknown): v is CvdType =>
  typeof v === "string" && CVD_TYPES.some((t) => t.id === v);

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/* ------------------------------- conversions ------------------------------ */

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** "#rrggbb" (or "#rgb", with or without the hash) → 0–255 channels. */
export function hexToRgb(hex: string): RGB {
  const s = hex.trim().replace(/^#/, "");
  const full =
    s.length === 3
      ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
      : s.length >= 6
        ? s.slice(0, 6)
        : "000000";
  const n = parseInt(full, 16);
  return Number.isNaN(n)
    ? { r: 0, g: 0, b: 0 }
    : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(clamp255(v)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB 0–255 → linear-light 0–1. */
const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
/** Linear-light 0–1 → sRGB 0–255. */
const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return clamp255(c * 255);
};

/* ------------------------------- simulation ------------------------------- */

// Hunt–Pointer–Estévez (D65-normalized), the matrix Viénot et al. use.
const RGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
];
const LMS_TO_RGB = [
  [0.080944448, -0.13050440, 0.11672106],
  [-0.010248534, 0.054019327, -0.11361471],
  [-0.00036529694, -0.0041216147, 0.69351141],
];

/** Collapse one cone class onto the plane spanned by the surviving two. */
const DICHROMAT: Record<string, number[][]> = {
  // L is missing: reconstruct it from M and S.
  protanopia: [
    [0, 2.02344, -2.52581],
    [0, 1, 0],
    [0, 0, 1],
  ],
  // M is missing.
  deuteranopia: [
    [1, 0, 0],
    [0.494207, 0, 1.24827],
    [0, 0, 1],
  ],
  // S is missing.
  tritanopia: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.395913, 0.801109, 0],
  ],
};

const mul3 = (m: number[][], v: number[]): number[] => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

/**
 * How a colour appears to someone with the given deficiency. `none` is the
 * identity; `achromatopsia` is the luminance of the colour (rod vision only).
 *
 * Note this is a *dichromat* model — the complete absence of one cone class.
 * Anomalous trichromacy (the far commoner, milder form) sits between this and
 * normal vision, so anything that survives this simulation is comfortably safe
 * for the milder cases too.
 */
export function simulateRgb(rgb: RGB, type: CvdType): RGB {
  if (type === "none") return { ...rgb };
  const lin = [toLinear(rgb.r), toLinear(rgb.g), toLinear(rgb.b)];
  if (type === "achromatopsia") {
    const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    const g = toSrgb(y);
    return { r: g, g, b: g };
  }
  const lms = mul3(RGB_TO_LMS, lin);
  const sim = mul3(DICHROMAT[type], lms);
  const back = mul3(LMS_TO_RGB, sim);
  return { r: toSrgb(back[0]), g: toSrgb(back[1]), b: toSrgb(back[2]) };
}

/** Same, on hex strings (what the UI actually holds). */
export const simulateHex = (hex: string, type: CvdType): string =>
  rgbToHex(simulateRgb(hexToRgb(hex), type));

/* -------------------------- difference & contrast -------------------------- */

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(rgb: RGB): number {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 2.x contrast ratio — 1 (identical) … 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear sRGB → CIE XYZ (D65). */
function rgbToXyz(rgb: RGB): [number, number, number] {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

/** CIE L*a*b* (D65 white point). */
export function rgbToLab(rgb: RGB): [number, number, number] {
  const [x, y, z] = rgbToXyz(rgb);
  const wx = 0.95047;
  const wy = 1;
  const wz = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / wx);
  const fy = f(y / wy);
  const fz = f(z / wz);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. ~2.3 is the "just noticeable" threshold. */
export function deltaE(a: string, b: string): number {
  const la = rgbToLab(hexToRgb(a));
  const lb = rgbToLab(hexToRgb(b));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** Colour difference AS SEEN with the given deficiency. */
export const deltaEUnder = (a: string, b: string, type: CvdType): number =>
  deltaE(simulateHex(a, type), simulateHex(b, type));

/* ------------------------------ accent safety ------------------------------ */

/** Below this ΔE two UI colours read as "the same colour" at a glance. */
export const SAFE_DELTA_E = 22;

export interface SafetyReport {
  /** The smallest separation found against any reference colour. */
  minDeltaE: number;
  /** Which reference it collides with (empty when safe). */
  clashesWith: string[];
  safe: boolean;
}

/**
 * Is this accent still distinguishable from the app's semantic colours once the
 * deficiency is applied? The accent marks selection and active state, while
 * danger/success/warning carry meaning — an accent that collapses onto "danger"
 * under deuteranopia makes a selected item look like an error.
 */
export function accentSafety(
  accent: string,
  references: { name: string; hex: string }[],
  type: CvdType,
): SafetyReport {
  let min = Infinity;
  const clashes: string[] = [];
  for (const ref of references) {
    const d = deltaEUnder(accent, ref.hex, type);
    if (d < min) min = d;
    if (d < SAFE_DELTA_E) clashes.push(ref.name);
  }
  return {
    minDeltaE: references.length ? min : Infinity,
    clashesWith: clashes,
    safe: clashes.length === 0,
  };
}
