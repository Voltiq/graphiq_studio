// Red-eye removal (TODO §2) — pure pixel math, Node-testable.
//
// One click fixes one eye: find the red pupil blob near the click with a
// redness heuristic (how far R exceeds max(G, B)), re-centre on the blob so a
// sloppy click still lands, build a feathered membership mask, then replace
// the red channel with min(G, B) — which neutralizes the flash glow while
// leaving the white catchlight untouched (catchlights aren't red, so their
// mask weight is ~0) — and darken the blob toward a natural pupil.

/** How far red exceeds the other channels (0 when it doesn't). */
const redness = (r: number, g: number, b: number): number => r - Math.max(g, b);

/** Base membership threshold: redness where the mask can start. The working
 *  thresholds ADAPT to the blob's peak redness (see below) so mildly-red skin
 *  around the eye (redness ≈ 40–60) never qualifies next to a real flash
 *  pupil (redness ≈ 100–160). */
const RED_LO = 24;
/** Minimum red level — keeps dark noise from qualifying. */
const RED_MIN = 60;
/** A blob only counts as red-eye when its peak redness clears this — plain
 *  skin peaks around 50–65, flash pupils at 90+. Below it: change nothing. */
const RED_PEAK_MIN = 70;

/**
 * Remove a red pupil near (cx, cy) in RGBA bytes, in place.
 * `radius` is the search radius (doc px); `darken` 0..100 darkens the fixed
 * pupil (0 = only neutralize the red). Returns the changed rect, or null when
 * no red blob was found (then the pixels are untouched).
 */
export function removeRedEyeInPlace(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  darken: number,
): { x: number; y: number; w: number; h: number } | null {
  const R = Math.max(2, radius);
  const x0 = Math.max(0, Math.floor(cx - R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(w - 1, Math.ceil(cx + R));
  const y1 = Math.min(h - 1, Math.ceil(cy + R));
  if (x1 < x0 || y1 < y0) return null;

  // Pass 0: the red centroid + peak redness near the click — the centroid
  // forgives off-centre clicks, the peak calibrates the thresholds.
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let peak = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.hypot(x - cx, y - cy) > R) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0 || d[i] < RED_MIN) continue;
      const rn = redness(d[i], d[i + 1], d[i + 2]);
      if (rn > peak) peak = rn;
      const wgt = Math.max(0, rn - RED_LO);
      if (wgt <= 0) continue;
      sw += wgt;
      sx += x * wgt;
      sy += y * wgt;
    }
  }
  if (sw < RED_LO * 2 || peak < RED_PEAK_MIN) return null; // nothing convincingly red here
  // Adaptive membership window: only pixels near the blob's own redness join.
  const lo = Math.max(RED_LO, peak * 0.45);
  const hi = Math.max(peak * 0.85, lo + 24);
  // Clamp the re-centre so a red background can't drag the fix away.
  let mx = sx / sw;
  let my = sy / sw;
  const shift = Math.hypot(mx - cx, my - cy);
  const maxShift = R * 0.6;
  if (shift > maxShift) {
    mx = cx + ((mx - cx) / shift) * maxShift;
    my = cy + ((my - cy) / shift) * maxShift;
  }

  // Pass 1: feathered membership over the (re-centred) window.
  const bx0 = Math.max(0, Math.floor(mx - R));
  const by0 = Math.max(0, Math.floor(my - R));
  const bx1 = Math.min(w - 1, Math.ceil(mx + R));
  const by1 = Math.min(h - 1, Math.ceil(my + R));
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  const mask = new Float32Array(bw * bh);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const t = Math.hypot(x - mx, y - my) / R;
      if (t > 1) continue;
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0 || d[i] < RED_MIN) continue;
      let m = (redness(d[i], d[i + 1], d[i + 2]) - lo) / (hi - lo);
      if (m <= 0) continue;
      if (m > 1) m = 1;
      // Radial falloff: full inside 65% of the radius, fading to the edge.
      if (t > 0.65) m *= (1 - t) / 0.35;
      mask[(y - by0) * bw + (x - bx0)] = m;
    }
  }

  // No mask blur: the redness ramp + radial falloff already feather the blob
  // edge, and blurring would bleed membership INTO the white catchlight.

  // Pass 2: apply — replace red with min(G, B), darken, lerp by membership.
  const k = 1 - 0.65 * Math.max(0, Math.min(100, darken)) / 100;
  let rx0 = Infinity;
  let ry0 = Infinity;
  let rx1 = -Infinity;
  let ry1 = -Infinity;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const m = mask[y * bw + x];
      if (m < 0.02) continue;
      const i = ((y + by0) * w + (x + bx0)) * 4;
      const g = d[i + 1];
      const b = d[i + 2];
      const gray = Math.min(g, b);
      d[i] = Math.round(d[i] + (gray * k - d[i]) * m);
      d[i + 1] = Math.round(g + (g * k - g) * m);
      d[i + 2] = Math.round(b + (b * k - b) * m);
      rx0 = Math.min(rx0, x + bx0);
      ry0 = Math.min(ry0, y + by0);
      rx1 = Math.max(rx1, x + bx0);
      ry1 = Math.max(ry1, y + by0);
    }
  }
  if (rx1 < rx0) return null;
  return { x: rx0, y: ry0, w: rx1 - rx0 + 1, h: ry1 - ry0 + 1 };
}
