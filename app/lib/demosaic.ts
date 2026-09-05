/**
 * Bayer demosaicing — bilinear, and Malvar-He-Cutler.
 *
 * A camera sensor measures ONE colour per photosite behind a colour filter
 * array; the other two have to be reconstructed from the neighbours. Bilinear
 * does that by averaging the nearest same-colour sites, which is correct on flat
 * areas and wrong exactly where a photograph is interesting: at an edge, the
 * green plane is sampled twice as densely as red and blue, so red and blue lag
 * behind green across the edge and the result is the coloured fringing —
 * "zippering" — along every high-contrast boundary.
 *
 * MALVAR-HE-CUTLER (ICASSP 2004, "High-quality linear interpolation for
 * demosaicing of Bayer-patterned color images") fixes that without leaving the
 * world of linear filters: it interpolates a missing colour from its own
 * neighbours AND adds a correction term taken from the gradient of the channel
 * that IS sampled at that site. Green is sampled everywhere on the diagonal, so
 * it carries the luminance detail, and the correction transfers that detail into
 * red and blue instead of letting them blur independently.
 *
 * WHY PER PIXEL AND NOT PER PLANE. The obvious shape is "take the mosaic,
 * return three full planes", and it is the wrong one here: a 24-megapixel RAW
 * would need 288 MB of Float32 for the output alone, on a device that has just
 * spent its budget decoding the file. The decoder consumes one pixel at a time
 * inside its develop loop, so these functions do too. Each is one convolution
 * with no dependency on any other output pixel, which is a property of MHC, not
 * a compromise: nothing here needs a first pass over green.
 *
 * Pure — no canvas, no DOM, no allocation per call — so `tests/demosaic.test.ts`
 * can check it against a known image by mosaicing one and measuring what comes
 * back.
 */

/** Which filter sits over a photosite: 0 = red, 1 = green, 2 = blue. */
export type CFAColor = 0 | 1 | 2;

/** Reads the mosaic. `x`/`y` may be out of bounds and are clamped by the caller. */
export type MosaicAt = (x: number, y: number) => number;
/** The filter colour at a photosite. */
export type ColorAt = (x: number, y: number) => CFAColor;

/** RGB written in place, so a per-pixel loop allocates nothing. */
export interface RGBOut {
  r: number;
  g: number;
  b: number;
}

/**
 * Bilinear: average the nearest same-colour neighbours.
 *
 * Kept alongside MHC rather than deleted — it is what the decoder shipped with,
 * and `tests/demosaic.test.ts` measures the new one AGAINST it. A quality claim
 * with nothing to compare to is not a measurement.
 */
export function demosaicBilinear(
  at: MosaicAt,
  colorAt: ColorAt,
  x: number,
  y: number,
  out: RGBOut,
): void {
  const c = colorAt(x, y);
  const v = at(x, y);
  const hAvg = (at(x - 1, y) + at(x + 1, y)) / 2;
  const vAvg = (at(x, y - 1) + at(x, y + 1)) / 2;
  const xAvg = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
  const plusAvg = (hAvg + vAvg) / 2;
  if (c === 1) {
    // Green site: the row's other colour decides which way red lies.
    const rowHasR = colorAt(x - 1, y) === 0 || colorAt(x + 1, y) === 0;
    out.g = v;
    out.r = rowHasR ? hAvg : vAvg;
    out.b = rowHasR ? vAvg : hAvg;
  } else if (c === 0) {
    out.r = v;
    out.g = plusAvg;
    out.b = xAvg;
  } else {
    out.b = v;
    out.g = plusAvg;
    out.r = xAvg;
  }
}

/*
 * The four Malvar-He-Cutler kernels, all over a 5×5 window and all summing to 8.
 *
 * Written out as named sums rather than as arrays looped over, because the
 * kernels are sparse — between 9 and 13 non-zero taps out of 25 — and a
 * general 5×5 convolution would do 25 multiplies per channel per pixel to reach
 * the same answer. On a 24-megapixel file that difference is the whole cost.
 */

/**
 * One demosaiced pixel, gradient-corrected.
 *
 * Reads a 5×5 neighbourhood. `at` is expected to clamp at the edges, which
 * makes the outermost two rows and columns slightly less accurate than the
 * interior — the correction term there is taken from a mirrored neighbour
 * rather than a real one. That is the standard treatment and the alternative,
 * falling back to bilinear at the border, would put a visible seam two pixels
 * in from every edge.
 */
export function demosaicMHC(
  at: MosaicAt,
  colorAt: ColorAt,
  x: number,
  y: number,
  out: RGBOut,
): void {
  const c = colorAt(x, y);
  const v = at(x, y);

  // The taps every kernel draws on, named by their offset.
  const n1 = at(x, y - 1);
  const s1 = at(x, y + 1);
  const w1 = at(x - 1, y);
  const e1 = at(x + 1, y);
  const n2 = at(x, y - 2);
  const s2 = at(x, y + 2);
  const w2 = at(x - 2, y);
  const e2 = at(x + 2, y);
  const nw = at(x - 1, y - 1);
  const ne = at(x + 1, y - 1);
  const sw = at(x - 1, y + 1);
  const se = at(x + 1, y + 1);

  const plus = n1 + s1 + w1 + e1; // the four nearest
  const cross = nw + ne + sw + se; // the four diagonal
  const far = n2 + s2 + w2 + e2; // the four at distance 2

  if (c === 1) {
    // ---- green site: green is measured; red and blue are interpolated -------
    out.g = v;
    /* Which axis red lies along depends on the row. The two kernels are
       transposes of each other, so one expression serves both with the roles of
       the horizontal and vertical taps swapped. */
    const rowHasR = colorAt(x - 1, y) === 0 || colorAt(x + 1, y) === 0;
    const along = rowHasR ? w1 + e1 : n1 + s1; // the axis the colour sits on
    const across = rowHasR ? n1 + s1 : w1 + e1;
    const farAlong = rowHasR ? w2 + e2 : n2 + s2;
    const farAcross = rowHasR ? n2 + s2 : w2 + e2;
    // R at G: 5·centre + 4·(along) − 1·(across) − 1·(far along) + ½·(far across) − cross
    /* `along` is ALWAYS red's axis — horizontal when the row carries red,
       vertical when it carries blue — so the outputs are not swapped again
       here. Doing both was this function's one bug: it left red and blue
       exchanged on exactly half the green sites, which a literal convolution
       of the published kernels caught at 256 of 1024 pixels. */
    out.r = (5 * v + 4 * along - cross - farAlong + 0.5 * farAcross) / 8;
    out.b = (5 * v + 4 * across - cross - farAcross + 0.5 * farAlong) / 8;
  } else {
    // ---- red or blue site: that colour is measured, green and the other are not
    // G at R/B: 4·centre + 2·plus − far, all over 8.
    out.g = (4 * v + 2 * plus - far) / 8;
    // The opposite colour sits on the diagonal:
    // 6·centre + 2·cross − 1.5·far, over 8.
    const opposite = (6 * v + 2 * cross - 1.5 * far) / 8;
    if (c === 0) {
      out.r = v;
      out.b = opposite;
    } else {
      out.b = v;
      out.r = opposite;
    }
  }
}
