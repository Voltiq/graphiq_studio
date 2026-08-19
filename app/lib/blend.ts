/**
 * Blending and compositing in exact arithmetic, for the places that must not
 * depend on a rasteriser.
 *
 * WHY THIS EXISTS. The smart-filter stack blends each filter's result back over
 * the pre-filter pixels with its own mode and opacity. Both the engine and the
 * worker did that by putting the two buffers on canvases and calling `drawImage`
 * with `globalAlpha` — and Chromium's HTMLCanvasElement and OffscreenCanvas do
 * not round that composite the same way. Measured, blending a flat colour over
 * ITSELF at 70% (which must return that colour unchanged):
 *
 *     HTMLCanvasElement    8 of 256 values come back wrong, rounded DOWN
 *     OffscreenCanvas     48 of 256 values come back wrong, rounded UP
 *
 * So the engine and the worker disagreed by 1 — but more importantly *neither
 * was right*: a filter at partial opacity shifted flat colours by a level even
 * where the filter itself changed nothing. Matching the two would only have
 * picked one rasteriser's errors, so the blend is computed here instead, where
 * both paths get the same answer by construction and the answer is correct.
 *
 * WHAT IT COSTS. Not nothing, and not a saving — the round trip this replaces
 * (putImageData → drawImage → getImageData) is a GPU blit, and a per-pixel JS loop
 * does not beat it. Measured back to back on a 4000x3000 document, one blurred
 * filter at 70%: the canvas blend 122 ms, this 186 ms. That is the price of the
 * correctness, and it is paid on the INLINE path only — the settled pass runs in
 * the worker, and a live stroke now blends over its dirty region rather than the
 * whole document. Worth knowing: the first draft of this file cost 367 ms, and
 * almost all of the difference was switching on the op string inside the pixel
 * loop rather than picking the blend function once (see separableFn).
 *
 * WHAT IT IMPLEMENTS. W3C Compositing and Blending Level 1: the blend function
 * B(Cb, Cs) per mode, then simple alpha compositing (source-over) of the blended
 * source over the backdrop. `lighter` is not a blend mode at all — it is the
 * Porter-Duff *plus* operator — and is handled separately.
 *
 * It is keyed on the canvas composite op rather than the blend-mode NAME, so it
 * stays exactly as faithful to `BLEND_MAP` as the canvas path was: modes that map
 * onto an approximation there (Dissolve → source-over, Linear Burn → multiply)
 * keep that approximation here rather than quietly changing.
 */

const SEPARABLE = new Set<string>([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);
const NON_SEPARABLE = new Set<string>(["hue", "saturation", "color", "luminosity"]);

/** Is `op` one this module evaluates exactly? (Everything BLEND_MAP produces is.) */
export const canBlendExactly = (op: string): boolean =>
  op === "source-over" || op === "lighter" || SEPARABLE.has(op) || NON_SEPARABLE.has(op);

// ---- separable blend functions, all on 0..1 -------------------------------

const screen = (b: number, s: number) => b + s - b * s;
const hardLight = (b: number, s: number) => (s <= 0.5 ? b * (2 * s) : screen(b, 2 * s - 1));

// ---- non-separable blend functions (operate on the whole triple) ----------

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Pull a triple back into gamut by scaling it about its own luminosity, which
 *  is what keeps the hue and saturation the blend just produced. */
function clipColor(c: [number, number, number]): [number, number, number] {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) {
    const d = l - n;
    if (d !== 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / d;
  }
  if (x > 1) {
    const d = x - l;
    if (d !== 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / d;
  }
  return c;
}

function setLum(c: [number, number, number], l: number): [number, number, number] {
  const d = l - lum(c[0], c[1], c[2]);
  c[0] += d;
  c[1] += d;
  c[2] += d;
  return clipColor(c);
}

const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);

/** Stretch the triple to a given saturation, keeping the mid channel's position
 *  between the min and the max (the spec's min/mid/max procedure). */
function setSat(c: [number, number, number], s: number): [number, number, number] {
  // Index of the smallest, middle and largest components.
  let mn = 0;
  let mx = 0;
  for (let i = 1; i < 3; i++) {
    if (c[i] < c[mn]) mn = i;
    if (c[i] > c[mx]) mx = i;
  }
  if (mn === mx) {
    // All three equal (or a degenerate ordering): no spread to scale.
    c[0] = c[1] = c[2] = 0;
    return c;
  }
  const md = 3 - mn - mx;
  if (c[mx] > c[mn]) {
    c[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    c[mx] = s;
  } else {
    c[md] = 0;
    c[mx] = 0;
  }
  c[mn] = 0;
  return c;
}

/** Scratch for the non-separable result. Module-level and reused: these modes
 *  run per pixel, and a fresh triple per pixel is millions of allocations on a
 *  document-sized buffer. Never reentered — blendInto is synchronous. */
const NS: [number, number, number] = [0, 0, 0];

function nonSeparableInto(
  op: string,
  br: number,
  bg: number,
  bb: number,
  sr: number,
  sg: number,
  sb: number,
): void {
  switch (op) {
    case "hue":
      NS[0] = sr;
      NS[1] = sg;
      NS[2] = sb;
      setLum(setSat(NS, sat(br, bg, bb)), lum(br, bg, bb));
      return;
    case "saturation":
      NS[0] = br;
      NS[1] = bg;
      NS[2] = bb;
      setLum(setSat(NS, sat(sr, sg, sb)), lum(br, bg, bb));
      return;
    case "color":
      NS[0] = sr;
      NS[1] = sg;
      NS[2] = sb;
      setLum(NS, lum(br, bg, bb));
      return;
    case "luminosity":
      NS[0] = br;
      NS[1] = bg;
      NS[2] = bb;
      setLum(NS, lum(sr, sg, sb));
      return;
    default:
      NS[0] = sr;
      NS[1] = sg;
      NS[2] = sb;
  }
}

/** The separable blend functions, as closures picked ONCE per call rather than
 *  by switching on a string inside the pixel loop — 12 MP is 36 million channel
 *  evaluations, and a string switch at each of them costs more than the
 *  arithmetic it selects. */
function separableFn(op: string): (b: number, s: number) => number {
  switch (op) {
    case "multiply":
      return (b, s) => b * s;
    case "screen":
      return screen;
    case "overlay":
      return (b, s) => hardLight(s, b); // overlay is hard-light with the operands swapped
    case "darken":
      return (b, s) => (b < s ? b : s);
    case "lighten":
      return (b, s) => (b > s ? b : s);
    case "color-dodge":
      // The order of these guards is the spec's, and it matters: a backdrop of 0
      // stays 0 even where the source is 1.
      return (b, s) => (b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s)));
    case "color-burn":
      return (b, s) => (b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
    case "hard-light":
      return hardLight;
    case "soft-light":
      return (b, s) => {
        if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
        const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
        return b + (2 * s - 1) * (d - b);
      };
    case "difference":
      return (b, s) => Math.abs(b - s);
    case "exclusion":
      return (b, s) => b + s - 2 * b * s;
    default:
      return (_b, s) => s;
  }
}

/**
 * Composite `top` over `base` with `op` at `alpha`, writing 8-bit RGBA into `out`.
 *
 * `out` MAY alias `top` (the filter stack passes the freshly-allocated
 * `applyFilter` result as both), but must never alias `base` — every output pixel
 * is written after its own inputs are read, so an alias with `base` would feed
 * later reads with already-blended values. All three buffers are the same length.
 *
 * Colours are unpremultiplied 8-bit, exactly as `ImageData` carries them; the
 * arithmetic runs in doubles and rounds once, at the end.
 *
 * Split into a loop per category rather than one loop with branches: the three
 * kinds share almost no work, and source-over — far and away the common case —
 * needs no blend function at all.
 */
export function blendInto(
  out: Uint8ClampedArray,
  base: Uint8ClampedArray,
  top: Uint8ClampedArray,
  op: string,
  alpha: number,
): void {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const n = out.length;

  if (op === "lighter") {
    // Porter-Duff PLUS, which is what canvas calls "lighter": add the
    // premultiplied colours and clamp the alpha.
    for (let i = 0; i < n; i += 4) {
      const as = (top[i + 3] / 255) * a;
      const ab = base[i + 3] / 255;
      const ao = as + ab < 1 ? as + ab : 1;
      if (ao <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }
      const inv = 255 / ao;
      out[i] = Math.round(((top[i] / 255) * as + (base[i] / 255) * ab) * inv);
      out[i + 1] = Math.round(((top[i + 1] / 255) * as + (base[i + 1] / 255) * ab) * inv);
      out[i + 2] = Math.round(((top[i + 2] / 255) * as + (base[i + 2] / 255) * ab) * inv);
      out[i + 3] = Math.round(ao * 255);
    }
    return;
  }

  if (!SEPARABLE.has(op) && !NON_SEPARABLE.has(op)) {
    // source-over (and anything unrecognised, which `blendOp` also resolves to
    // source-over). No blend function: the source composites over the backdrop
    // directly, so this stays a handful of multiplies per channel.
    for (let i = 0; i < n; i += 4) {
      const sa = top[i + 3];
      const as = (sa / 255) * a;
      if (as === 0) {
        out[i] = base[i];
        out[i + 1] = base[i + 1];
        out[i + 2] = base[i + 2];
        out[i + 3] = base[i + 3];
        continue;
      }
      const ba = base[i + 3];
      if (as === 1 || ba === 0) {
        // Fully covering, or nothing underneath: the source survives as-is.
        out[i] = top[i];
        out[i + 1] = top[i + 1];
        out[i + 2] = top[i + 2];
        out[i + 3] = as === 1 ? 255 : Math.round(as * 255);
        continue;
      }
      const ab = ba / 255;
      const k = ab * (1 - as);
      const ao = as + k;
      const inv = 1 / ao;
      out[i] = Math.round((top[i] * as + base[i] * k) * inv);
      out[i + 1] = Math.round((top[i + 1] * as + base[i + 1] * k) * inv);
      out[i + 2] = Math.round((top[i + 2] * as + base[i + 2] * k) * inv);
      out[i + 3] = Math.round(ao * 255);
    }
    return;
  }

  const fn = SEPARABLE.has(op) ? separableFn(op) : null;
  for (let i = 0; i < n; i += 4) {
    const as = (top[i + 3] / 255) * a;
    const ab = base[i + 3] / 255;
    if (as === 0) {
      // Nothing to add: the backdrop survives untouched. (Also the only branch
      // that can run for a fully transparent source, where Cs is meaningless.)
      out[i] = base[i];
      out[i + 1] = base[i + 1];
      out[i + 2] = base[i + 2];
      out[i + 3] = base[i + 3];
      continue;
    }
    const sr = top[i] / 255;
    const sg = top[i + 1] / 255;
    const sb = top[i + 2] / 255;
    const br = base[i] / 255;
    const bg = base[i + 1] / 255;
    const bb = base[i + 2] / 255;

    // The blended source: where the backdrop is transparent the blend function
    // has nothing to read, so the source shows through unblended — that is what
    // the (1 − ab) term does.
    let cr: number;
    let cg: number;
    let cb2: number;
    if (fn) {
      cr = (1 - ab) * sr + ab * fn(br, sr);
      cg = (1 - ab) * sg + ab * fn(bg, sg);
      cb2 = (1 - ab) * sb + ab * fn(bb, sb);
    } else {
      nonSeparableInto(op, br, bg, bb, sr, sg, sb);
      cr = (1 - ab) * sr + ab * NS[0];
      cg = (1 - ab) * sg + ab * NS[1];
      cb2 = (1 - ab) * sb + ab * NS[2];
    }

    // Simple alpha compositing of the blended source over the backdrop.
    const k = ab * (1 - as);
    const ao = as + k;
    const inv = ao > 0 ? 255 / ao : 0;
    out[i] = Math.round((cr * as + br * k) * inv);
    out[i + 1] = Math.round((cg * as + bg * k) * inv);
    out[i + 2] = Math.round((cb2 * as + bb * k) * inv);
    out[i + 3] = Math.round(ao * 255);
  }
}
