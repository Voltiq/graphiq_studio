// The sample document's pixels: "Alpenglow", painted procedurally — no image
// assets, the same picture every time (seeded noise), in a few hundred ms.
// The recipe (tree, type, vectors, comps) is sample-doc.ts; this fills its
// painted layers and masks.

import { renderShape } from "./shapes";
import { renderVectorPath } from "./svg";
import { BIRDS, DIVIDER, H, HORIZON, MASKED, PAINTED, SUN, W, type SampleIds } from "./sample-doc";

type Source = { id: string; source: HTMLCanvasElement };

const mk = (w = W, h = H) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d")! };
};

// ---- Noise ------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so the sample is the same picture each time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise, 1-D and 2-D, on a seeded 256-cell lattice; 0..1. */
function lattice(seed: number) {
  const r = rng(seed);
  const v = new Float32Array(256);
  for (let i = 0; i < 256; i++) v[i] = r();
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const s = (t: number) => t * t * (3 - 2 * t);
  const n1 = (x: number) => {
    const i = Math.floor(x);
    const f = s(x - i);
    const a = v[p[i & 255]];
    return a + (v[p[(i + 1) & 255]] - a) * f;
  };
  const n2 = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = s(x - xi);
    const w = s(y - yi);
    const h = (i: number, j: number) => v[p[(p[i & 255] + j) & 255]];
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a + (d - c - (b - a)) * u) * w;
  };
  const fbm1 = (x: number, oct = 4) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      sum += amp * n1(x * f + o * 17.3);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
  const fbm2 = (x: number, y: number, oct = 4) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      sum += amp * n2(x * f + o * 31.7, y * f + o * 11.1);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
  return { n1, n2, fbm1, fbm2 };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as RGB;

// ---- Stars ----------------------------------------------------------------------

function paintStars(): HTMLCanvasElement {
  const { c, ctx } = mk();
  const r = rng(11);
  const tints = ["#ffffff", "#dfe6ff", "#ffeedd"];
  for (let i = 0; i < 420; i++) {
    const x = r() * W;
    const y = Math.pow(r(), 1.7) * H * 0.55;
    const size = 0.45 + Math.pow(r(), 5) * 1.7;
    ctx.globalAlpha = 0.35 + r() * 0.65;
    ctx.fillStyle = tints[i % 3];
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    if (size > 1.6) {
      // The brightest few get a glint.
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 5);
      g.addColorStop(0, "rgba(220,230,255,0.5)");
      g.addColorStop(1, "rgba(220,230,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - size * 5, y - size * 5, size * 10, size * 10);
    }
  }
  ctx.globalAlpha = 1;
  return c;
}

// ---- Clouds: banks of stratus, lit from below by the sun ---------------------------

function paintClouds(): HTMLCanvasElement {
  const q = 4; // painted at a quarter, drawn up smooth: they are soft anyway
  const qw = W / q;
  const qh = H / q;
  const small = mk(qw, qh);
  const img = small.ctx.createImageData(qw, qh);
  const n = lattice(23);
  const dusk = hex("#4e4380");
  const mauve = hex("#8a5f9a");
  const rose = hex("#d8839a");
  const peach = hex("#ffc49a");
  for (let qy = 0; qy < qh; qy++) {
    const y = qy * q;
    const yf = y / H;
    const env = smooth(0.04, 0.15, yf) * (1 - smooth(0.34, 0.5, yf));
    if (env <= 0) continue;
    for (let qx = 0; qx < qw; qx++) {
      const x = qx * q;
      const warp = n.fbm2(x / 520, y / 210, 2) * 0.9;
      const at = (yy: number) => n.fbm2(x / 330 + warp, yy / 64, 5);
      const d = at(y);
      const cover = smooth(0.47, 0.72, d) * env;
      if (cover <= 0.004) continue;
      // An underside is where the cloud thickens upward: lit from below.
      const under = clamp01((at(y - 12) - d) * 7 + 0.45);
      const nearSun = Math.exp(-(((x - SUN.x) / 620) ** 2));
      const warm = clamp01(0.2 + (yf - 0.08) * 1.5) * (0.55 + 0.45 * nearSun);
      const base = mix(dusk, mauve, warm);
      const lit = mix(rose, peach, warm);
      const col = mix(base, lit, under * (0.35 + 0.65 * warm));
      const o = (qy * qw + qx) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = cover * 235;
    }
  }
  small.ctx.putImageData(img, 0, 0);
  const { c, ctx } = mk();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small.c, 0, 0, W, H);
  return c;
}

// ---- The sun -----------------------------------------------------------------------

function paintSun(): HTMLCanvasElement {
  const { c, ctx } = mk();
  const g = ctx.createRadialGradient(SUN.x, SUN.y - 6, 0, SUN.x, SUN.y, SUN.r);
  g.addColorStop(0, "#fffaf0");
  g.addColorStop(0.6, "#ffe6b8");
  g.addColorStop(1, "#ffc27a");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(SUN.x, SUN.y, SUN.r, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

// ---- Mountains ---------------------------------------------------------------------

interface Peak {
  /** Where, as a fraction of the width. */
  at: number;
  /** Height above the waterline, px. */
  h: number;
  /** How steeply it falls away. */
  slope: number;
}

interface Range {
  seed: number;
  peaks: Peak[];
  /** The ridge never drops below this (px above the waterline). */
  floor: number;
  /** Jaggedness of the ridge, px. */
  rough: number;
  top: string;
  base: string;
  /** Faces turned to the sun take this; faces turned away, `shade`. */
  light: string;
  shade: string;
  /** Rock texture, 0..1. */
  texture: number;
  /** Mist where the range meets the water. */
  haze: string;
  hazeAmount: number;
  /** Snow above this height (px above the waterline); absent = none. */
  snowAbove?: number;
  /** A band of forest along the far shore. */
  forest?: string;
}

function paintRange(R: Range): HTMLCanvasElement {
  const n = lattice(R.seed);
  const heights = new Float32Array(W + 8);
  for (let i = 0; i < W + 8; i++) {
    const x = i - 4;
    let h = R.floor + (n.fbm1(x / 160) - 0.5) * 30;
    for (const p of R.peaks) {
      const t = (Math.abs(x - p.at * W) * p.slope) / p.h;
      if (t < 1) h = Math.max(h, p.h * Math.pow(1 - t, 1.25));
    }
    // Rockier toward the summits.
    const k = 0.35 + 0.65 * Math.min(1, h / 300);
    h += ((n.fbm1(x / 70) - 0.5) * R.rough + (n.fbm1(x / 19) - 0.5) * R.rough * 0.45) * k;
    heights[i] = Math.max(4, h);
  }
  const hAt = (x: number) => heights[x + 4];
  let tallest = 0;
  for (let x = 0; x < W; x++) tallest = Math.max(tallest, hAt(x));
  /* The light is read from a SMOOTHED ridge (the fine teeth make noise, not
     faces) and carried down each face along its spurs: a point below the ridge
     takes the light of the ridge point it descends from, which lies back
     toward the summit. So light and shadow run diagonally, like the ribs of a
     real face — read straight down, they fell in vertical bands. */
  const blur = (src: Float32Array, r: number) => {
    const out = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0;
      let k = 0;
      for (let d = -r; d <= r; d++) {
        const i = Math.min(W - 1, Math.max(0, x + d)) + 4;
        s += src[i];
        k++;
      }
      out[x] = s / k;
    }
    return out;
  };
  const fine = blur(heights, 3);
  const broad = blur(heights, 60);
  const facing = new Float32Array(W);
  const downhill = new Float32Array(W);
  const snowDepth = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const a = Math.max(0, x - 3);
    const b = Math.min(W - 1, x + 3);
    const slope = (fine[b] - fine[a]) / (b - a);
    // + a face turned to the sun, − one turned away.
    facing[x] = Math.max(-1, Math.min(1, Math.sign(SUN.x - x) * slope * 1.8));
    // Continuous, through zero at a summit or a valley: a hard ±1 drew a
    // vertical seam straight down from every one.
    const wide = broad[Math.min(W - 1, x + 6)] - broad[Math.max(0, x - 6)];
    downhill[x] = Math.max(-1, Math.min(1, -wide * 0.35));
    snowDepth[x] =
      R.snowAbove !== undefined ? Math.max(0, (hAt(x) - R.snowAbove) * 0.6 + (n.fbm1(x / 13) - 0.5) * 30) : 0;
  }
  const y0 = Math.max(0, Math.floor(HORIZON - tallest) - 1);
  const rows = HORIZON + 2 - y0;
  const { c, ctx } = mk();
  const img = ctx.createImageData(W, rows);
  const top = hex(R.top);
  const base = hex(R.base);
  const light = hex(R.light);
  const shade = hex(R.shade);
  const haze = hex(R.haze);
  const snowLit = hex("#ffe4dc");
  const snowShade = hex("#b9b0da");
  const forest = R.forest ? hex(R.forest) : null;
  for (let x = 0; x < W; x++) {
    const h = hAt(x);
    const ridge = HORIZON - h;
    const treeTop = forest
      ? 8 + 11 * (1 - Math.abs(((x * 0.19 + n.n1(x / 7) * 3) % 1) * 2 - 1)) * (0.55 + 0.45 * n.n1(x / 37))
      : 0;
    for (let y = Math.floor(ridge); y < HORIZON + 2; y++) {
      if (y < y0) continue;
      // The ridge row itself sits a fraction ABOVE the ridge (it is the
      // partly covered pixel), so its depth is clamped: a negative one made
      // Math.pow return NaN, which stores as black — a dark outline along
      // every ridge.
      const depth = Math.max(0, y - ridge);
      const v = clamp01((y - (HORIZON - tallest)) / tallest);
      let col = mix(top, base, v);
      // The ridge point this one descends from.
      // ...and each face leans its own way, so no crest falls plumb.
      const lean = (n.n1(x / 260 + 3) - 0.5) * 1.1;
      const xs = x + (lean - downhill[x] * 0.7) * depth + (n.n2(x / 40, y / 40) - 0.5) * Math.pow(depth, 0.85) * 0.35;
      const src = Math.min(W - 1, Math.max(0, Math.round(xs)));
      const f = facing[src];
      const k = f * Math.exp(-depth / 220) * 0.6;
      col = k > 0 ? mix(col, light, k) : mix(col, shade, -k);
      const t = 1 + (n.fbm2(x / 5, y / 15, 2) - 0.5) * R.texture;
      col = [col[0] * t, col[1] * t, col[2] * t];
      const sd = snowDepth[src];
      if (sd > 0 && depth < sd) {
        // In streaks down the gullies, thinning toward the snow line.
        const streak = smooth(0.32, 0.6, n.n2(xs / 3.5, y / 30));
        const s = smooth(sd, sd * 0.45, depth) * (0.35 + 0.65 * streak) * 0.95;
        col = mix(col, f > 0 ? mix(snowShade, snowLit, f) : snowShade, s);
      }
      col = mix(col, haze, smooth(HORIZON - 90, HORIZON, y) * R.hazeAmount);
      let a = y === Math.floor(ridge) ? 1 - (ridge - Math.floor(ridge)) : 1;
      if (forest && y >= HORIZON - treeTop - 1) {
        const f = clamp01(y - (HORIZON - treeTop));
        col = mix(col, forest, f);
        a = Math.max(a, f);
      }
      const o = ((y - y0) * W + x) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, y0);
  return c;
}

const FAR: Range = {
  seed: 5,
  peaks: [
    { at: 0.05, h: 190, slope: 0.55 },
    { at: 0.18, h: 250, slope: 0.6 },
    { at: 0.33, h: 205, slope: 0.5 },
    { at: 0.47, h: 160, slope: 0.6 },
    { at: 0.74, h: 230, slope: 0.55 },
    { at: 0.88, h: 275, slope: 0.6 },
    { at: 1.0, h: 200, slope: 0.5 },
  ],
  floor: 70,
  rough: 26,
  top: "#7a67a5",
  base: "#a98cb4",
  light: "#d99aa6",
  shade: "#5e548f",
  texture: 0.06,
  haze: "#d7a3a8",
  hazeAmount: 0.55,
};

const NEAR: Range = {
  seed: 9,
  peaks: [
    { at: -0.02, h: 330, slope: 0.75 },
    { at: 0.22, h: 285, slope: 0.7 },
    { at: 0.4, h: 120, slope: 0.5 },
    { at: 0.82, h: 360, slope: 0.9 },
    { at: 1.02, h: 300, slope: 0.8 },
  ],
  floor: 38,
  rough: 44,
  top: "#3f3568",
  base: "#2a2348",
  light: "#9a6a8e",
  shade: "#211b3d",
  texture: 0.16,
  haze: "#6e5a86",
  hazeAmount: 0.4,
  snowAbove: 185,
  forest: "#17122c",
};

/** Warm light for the summits — clipped to the near range in the document. */
function paintAlpenglow(): HTMLCanvasElement {
  const { c, ctx } = mk();
  const g = ctx.createLinearGradient(0, HORIZON - 380, 0, HORIZON - 60);
  g.addColorStop(0, "rgba(255,150,165,0.95)");
  g.addColorStop(0.45, "rgba(255,150,140,0.4)");
  g.addColorStop(1, "rgba(255,150,140,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, HORIZON);
  // Strongest toward the sun.
  ctx.globalCompositeOperation = "destination-in";
  const r = ctx.createRadialGradient(SUN.x, HORIZON - 200, 0, SUN.x, HORIZON - 200, 1100);
  r.addColorStop(0, "rgba(0,0,0,1)");
  r.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
  return c;
}

// ---- The lake ------------------------------------------------------------------------

function paintLake(): HTMLCanvasElement {
  const { c, ctx } = mk();
  const g = ctx.createLinearGradient(0, HORIZON, 0, H);
  g.addColorStop(0, "#e7a17f");
  g.addColorStop(0.08, "#c98a8a");
  g.addColorStop(0.35, "#6c5a8c");
  g.addColorStop(1, "#121735");
  ctx.fillStyle = g;
  ctx.fillRect(0, HORIZON, W, H - HORIZON);
  const r = rng(31);
  // Ripples: broken lines, further apart (and thicker) nearer the viewer.
  for (let k = 0; k < 70; k++) {
    const t = k / 70;
    const y = HORIZON + 3 + Math.pow(t, 1.7) * (H - HORIZON);
    let x = -r() * 200;
    while (x < W) {
      const len = 40 + r() * 380;
      ctx.globalAlpha = 0.04 + r() * 0.09;
      ctx.fillStyle = r() < 0.5 ? "#ffd6be" : "#0c0a20";
      ctx.fillRect(x, y, len, 1 + t * 2.2);
      x += len + 20 + r() * 160;
    }
  }
  ctx.globalAlpha = 1;
  // Where the far shore meets the water, a thin line of light.
  ctx.fillStyle = "rgba(255,210,160,0.3)";
  ctx.fillRect(0, HORIZON, W, 1.5);
  return c;
}

/** The sun's path across the water: a soft column, and the glitter in it.
 *  A layer of its own (Screen), so the blue-hour comp can set the sun. */
function paintSunPath(): HTMLCanvasElement {
  const { c, ctx } = mk();
  ctx.save();
  ctx.translate(SUN.x, HORIZON);
  ctx.scale(1, 3.4);
  const col = ctx.createRadialGradient(0, 0, 0, 0, 0, 150);
  col.addColorStop(0, "rgba(255,214,160,0.5)");
  col.addColorStop(1, "rgba(255,214,160,0)");
  ctx.fillStyle = col;
  ctx.fillRect(-150, 0, 300, 150);
  ctx.restore();
  const r = rng(37);
  const gauss = () => (r() + r() + r() - 1.5) / 1.5;
  ctx.fillStyle = "#ffe3b5";
  for (let i = 0; i < 950; i++) {
    const d = Math.pow(r(), 1.5);
    const y = HORIZON + 2 + d * (H - HORIZON - 2);
    const x = SUN.x + gauss() * (16 + d * 300);
    const len = (3 + d * 46) * (0.5 + r());
    ctx.globalAlpha = Math.pow(1 - d, 0.8) * (0.25 + 0.75 * r()) * 0.85;
    ctx.fillRect(x - len / 2, y, len, 0.8 + d * 2.2);
  }
  ctx.globalAlpha = 1;
  return c;
}

/** The ranges mirrored in the water (rippled by smart filters). The sun is
 *  not: its path is its own layer. */
function paintReflection(far: HTMLCanvasElement, near: HTMLCanvasElement): HTMLCanvasElement {
  const { c, ctx } = mk();
  /* The Wave smart filter moves pixels up and down as well as sideways, so it
     reads a few rows above the waterline. Left transparent, those rows showed
     through as a scalloped edge every wavelength; filled with the first row of
     the reflection, they are only ever sampled — the mask hides them. */
  ctx.save();
  ctx.fillStyle = "#1d1630";
  ctx.fillRect(0, HORIZON - 8, W, 8);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HORIZON, W, H - HORIZON);
  ctx.clip();
  ctx.translate(0, 2 * HORIZON);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.95;
  ctx.drawImage(far, 0, 0);
  ctx.drawImage(near, 0, 0);
  ctx.restore();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(34,22,58,0.32)";
  ctx.fillRect(0, HORIZON, W, H - HORIZON);
  return c;
}

// ---- The shore and its pines -------------------------------------------------------------

/** One pine: tiers of drooping branches up a trunk, with a rim of sunset light
 *  on the side that faces the sun. */
function pine(ctx: CanvasRenderingContext2D, x: number, base: number, h: number, r: () => number) {
  const w = h * (0.26 + r() * 0.08);
  const tiers = 7 + Math.floor(r() * 4);
  const right: [number, number][] = [];
  const left: [number, number][] = [];
  for (let i = 0; i <= tiers; i++) {
    const t = i / tiers;
    const y = base - h * 0.08 - (1 - t) * h * 0.92;
    const hw = (w / 2) * (0.12 + 0.88 * t) * (0.82 + r() * 0.36);
    const droop = h * 0.025 * (0.5 + r());
    right.push([x + hw, y + droop], [x + hw * 0.38, y - h * 0.012]);
    left.push([x - hw * (0.9 + r() * 0.2), y + droop], [x - hw * 0.38, y - h * 0.012]);
  }
  const outline = (dx: number) => {
    ctx.beginPath();
    ctx.moveTo(x + dx, base - h);
    for (const [px, py] of right) ctx.lineTo(px + dx, py);
    ctx.lineTo(x + h * 0.014 + dx, base);
    ctx.lineTo(x - h * 0.014 + dx, base);
    for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i][0] + dx, left[i][1]);
    ctx.closePath();
  };
  ctx.fillStyle = x < SUN.x ? "rgba(255,150,110,0.4)" : "rgba(255,150,110,0.18)";
  outline(x < SUN.x ? 1.6 : -1.6);
  ctx.fill();
  ctx.fillStyle = "#0a0d1f";
  outline(0);
  ctx.fill();
}

function paintShore(): HTMLCanvasElement {
  const { c, ctx } = mk();
  const n = lattice(41);
  const r = rng(41);
  const leftEnd = W * 0.5;
  const left = (x: number) =>
    H - (58 + 200 * Math.pow(Math.max(0, 1 - x / leftEnd), 1.3)) + (n.fbm1(x / 60) - 0.5) * 16;
  const spitStart = W * 0.83;
  const right = (x: number) =>
    H - (36 + 118 * Math.pow(Math.max(0, (x - spitStart) / (W - spitStart)), 0.75)) + (n.fbm1(x / 50 + 9) - 0.5) * 12;
  const land = (from: number, to: number, y: (x: number) => number) => {
    ctx.beginPath();
    ctx.moveTo(from, H);
    for (let x = from; x <= to; x += 4) ctx.lineTo(x, y(x));
    ctx.lineTo(to, H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, H - 260, 0, H);
    g.addColorStop(0, "#141a33");
    g.addColorStop(1, "#05070f");
    ctx.fillStyle = g;
    ctx.fill();
    // The lip of the bank catches the last light.
    ctx.beginPath();
    for (let x = from; x <= to; x += 4) ctx.lineTo(x, y(x));
    ctx.strokeStyle = "rgba(255,160,120,0.28)";
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  land(0, leftEnd + 40, left);
  land(spitStart - 20, W, right);
  // Rocks at the water's edge.
  for (let i = 0; i < 9; i++) {
    const x = leftEnd - 30 - r() * 220;
    const y = left(x) + 4 + r() * 10;
    const rw = 10 + r() * 22;
    ctx.fillStyle = "#0b0f22";
    ctx.beginPath();
    ctx.ellipse(x, y, rw, rw * 0.45, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "rgba(255,170,130,0.22)";
    ctx.fillRect(x - rw * 0.6, y - rw * 0.42, rw * 1.1, 1.4);
  }
  // Pines: the taller ones furthest left, painted back to front.
  const trees: { x: number; base: number; h: number }[] = [];
  for (let i = 0; i < 34; i++) {
    const x = Math.pow(r(), 1.25) * leftEnd * 0.96;
    const h = 40 + (120 + r() * 250) * Math.pow(1 - x / (leftEnd * 1.15), 0.6);
    trees.push({ x, base: left(x) + 8 + r() * 10, h });
  }
  for (let i = 0; i < 9; i++) {
    const x = spitStart + 30 + r() * (W - spitStart - 20);
    trees.push({ x, base: right(x) + 6 + r() * 6, h: 60 + r() * 120 });
  }
  trees.sort((a, b) => a.base - b.base);
  for (const t of trees) pine(ctx, t.x, t.base, t.h, r);
  return c;
}

// ---- Masks ------------------------------------------------------------------------------

const gray = (draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement => {
  const { c, ctx } = mk();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  draw(ctx);
  return c;
};

const MASKS: Record<(typeof MASKED)[number], () => HTMLCanvasElement> = {
  // Stars fade out toward the glow at the horizon.
  stars: () =>
    gray((ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.52);
      g.addColorStop(0, "#fff");
      g.addColorStop(1, "#000");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }),
  // The reflection fades with distance from the far shore.
  reflection: () =>
    gray((ctx) => {
      const g = ctx.createLinearGradient(0, HORIZON, 0, H);
      g.addColorStop(0, "#fff");
      g.addColorStop(0.5, "#5a5a5a");
      g.addColorStop(1, "#000");
      ctx.fillStyle = g;
      ctx.fillRect(0, HORIZON, W, H - HORIZON);
    }),
  // The vignette shows at the corners only.
  vignette: () =>
    gray((ctx) => {
      const g = ctx.createRadialGradient(W / 2, H * 0.47, W * 0.3, W / 2, H * 0.47, W * 0.78);
      g.addColorStop(0, "#000");
      g.addColorStop(1, "#fff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }),
};

/** Paint every painted layer and mask of the sample. */
export function paintSample(ids: SampleIds): { images: Source[]; masks: Source[] } {
  // Painted once and used twice: the reflection mirrors them.
  const far = paintRange(FAR);
  const near = paintRange(NEAR);
  const painters: Record<(typeof PAINTED)[number], () => HTMLCanvasElement> = {
    divider: () => {
      const { c, ctx } = mk();
      renderShape(ctx, "rect", DIVIDER, DIVIDER.fill, DIVIDER.stroke, DIVIDER.strokeWidth, DIVIDER.radius);
      return c;
    },
    birds: () => renderVectorPath(BIRDS, W, H),
    shore: paintShore,
    sunPath: paintSunPath,
    reflection: () => paintReflection(far, near),
    lake: paintLake,
    alpenglow: paintAlpenglow,
    near: () => near,
    far: () => far,
    sun: paintSun,
    clouds: paintClouds,
    stars: paintStars,
  };
  return {
    images: PAINTED.map((role) => ({ id: ids[role], source: painters[role]() })),
    masks: MASKED.map((role) => ({ id: ids[role], source: MASKS[role]() })),
  };
}
