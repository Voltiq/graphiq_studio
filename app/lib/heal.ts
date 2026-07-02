// Healing / content-aware fill (pure ImageData ops, region space).
//
// The core primitive is Photoshop-style "healing": take TEXTURE from a
// well-matching source patch elsewhere in the image, then seamlessly match the
// destination's TONE by interpolating the boundary difference smoothly across
// the healed region (a diffusion "membrane" — the cheap, visually equivalent
// cousin of Poisson seamless cloning). The spot-heal brush heals one blob with
// a single auto-picked source; content-aware fill synthesizes large selections
// from overlapping feathered blocks (each with its own source) before the same
// membrane pass. Everything runs on a cropped region, never the whole document.

/** A soft coverage mask over a region: 0 = untouched, 255 = fully healed. */
export interface HealJob {
  /** RGBA pixels of the padded work region (will NOT be mutated). */
  src: ImageData;
  /** Coverage (region-sized, w*h), 0–255; >0 means "replace this pixel". */
  coverage: Uint8ClampedArray;
}

/** Collect sample points on the ring just OUTSIDE the hole (coverage 0 next to
 *  coverage >0) — these anchor both the offset search and the membrane. */
function boundaryRing(cov: Uint8ClampedArray, w: number, h: number): number[] {
  const pts: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cov[i] > 0) continue;
      const left = x > 0 && cov[i - 1] > 0;
      const right = x < w - 1 && cov[i + 1] > 0;
      const up = y > 0 && cov[i - w] > 0;
      const down = y < h - 1 && cov[i + w] > 0;
      if (left || right || up || down) pts.push(i);
    }
  }
  return pts;
}

/** Bounds (inclusive) of coverage > 0; null when empty. */
function coverageBounds(cov: Uint8ClampedArray, w: number, h: number) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cov[y * w + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Find the offset (dx,dy) whose source patch best continues the destination:
 * candidates on rings around the hole, scored by SSD over the boundary-ring
 * pixels. A candidate is valid only if every needed source pixel is inside the
 * region and outside the hole.
 */
function findBestOffset(
  data: Uint8ClampedArray,
  cov: Uint8ClampedArray,
  w: number,
  h: number,
  ring: number[],
  holeR: number,
  cx: number,
  cy: number,
): { dx: number; dy: number } | null {
  // Subsample the ring for scoring (cap ~160 anchors).
  const step = Math.max(1, Math.floor(ring.length / 160));
  const anchors: number[] = [];
  for (let i = 0; i < ring.length; i += step) anchors.push(ring[i]);
  let best: { dx: number; dy: number } | null = null;
  let bestScore = Infinity;
  for (const scale of [1.6, 2.2, 3.0]) {
    const r = Math.max(6, holeR * scale);
    const n = 24;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const dx = Math.round(Math.cos(a) * r);
      const dy = Math.round(Math.sin(a) * r);
      // quick centre validity
      const ccx = Math.round(cx + dx);
      const ccy = Math.round(cy + dy);
      if (ccx < 0 || ccy < 0 || ccx >= w || ccy >= h) continue;
      let score = 0;
      let valid = true;
      for (const p of anchors) {
        const px = p % w;
        const py = (p / w) | 0;
        const sx = px + dx;
        const sy = py + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h || cov[sy * w + sx] > 0) {
          valid = false;
          break;
        }
        const o = p * 4;
        const so = (sy * w + sx) * 4;
        const dr = data[o] - data[so];
        const dg = data[o + 1] - data[so + 1];
        const db = data[o + 2] - data[so + 2];
        score += dr * dr + dg * dg + db * db;
        if (score >= bestScore) break; // early out
      }
      if (valid && score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
    if (best && bestScore / anchors.length < 300) break; // good enough, stop widening
  }
  return best;
}

/** Jacobi diffusion of a sparse boundary-difference field across the hole:
 *  boundary pixels are fixed, interior relaxes to the average of neighbours.
 *  Two-level (quarter-res first) so large holes converge fast. */
function membrane(
  fixed: Float32Array[], // per-channel; NaN = free interior, number = fixed
  cov: Uint8ClampedArray,
  w: number,
  h: number,
): Float32Array[] {
  const solve = (init: Float32Array[], sw: number, sh: number, iters: number, inside: (i: number) => boolean) => {
    const cur = init.map((c) => c.slice());
    const nxt = init.map((c) => c.slice());
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = y * sw + x;
          if (!inside(i)) continue;
          const l = x > 0 ? i - 1 : i;
          const r = x < sw - 1 ? i + 1 : i;
          const u = y > 0 ? i - sw : i;
          const d = y < sh - 1 ? i + sw : i;
          for (let c = 0; c < 3; c++) nxt[c][i] = (cur[c][l] + cur[c][r] + cur[c][u] + cur[c][d]) / 4;
        }
      }
      for (let c = 0; c < 3; c++) cur[c].set(nxt[c]);
    }
    return cur;
  };

  // Coarse pass at quarter resolution seeds the fine pass.
  const cw = Math.max(2, w >> 2);
  const ch = Math.max(2, h >> 2);
  const coarse: Float32Array[] = [0, 1, 2].map(() => new Float32Array(cw * ch));
  const coarseIn = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const fi = Math.min(h - 1, y * 4) * w + Math.min(w - 1, x * 4);
      const i = y * cw + x;
      if (Number.isNaN(fixed[0][fi])) coarseIn[i] = 1;
      else for (let c = 0; c < 3; c++) coarse[c][i] = fixed[c][fi];
    }
  }
  const coarseOut = solve(coarse, cw, ch, 120, (i) => coarseIn[i] === 1);

  // Fine: seed interior from the coarse solution, keep boundary fixed.
  const fine: Float32Array[] = [0, 1, 2].map((c) => {
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        f[i] = Number.isNaN(fixed[c][i])
          ? coarseOut[c][Math.min(ch - 1, y >> 2) * cw + Math.min(cw - 1, x >> 2)]
          : fixed[c][i];
      }
    }
    return f;
  });
  return solve(fine, w, h, 24, (i) => Number.isNaN(fixed[0][i]) && cov[i] > 0);
}

/** Copy texture from `off`, then add the membrane-interpolated boundary
 *  difference — writes healed pixels (soft-mixed by coverage) into `out`. */
function healWithOffset(
  out: Uint8ClampedArray,
  data: Uint8ClampedArray,
  cov: Uint8ClampedArray,
  w: number,
  h: number,
  ring: number[],
  off: { dx: number; dy: number },
) {
  const clampI = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  // Fixed boundary values: destination − source (per channel); interior free.
  const fixed: Float32Array[] = [0, 1, 2].map(() => {
    const f = new Float32Array(w * h);
    f.fill(NaN);
    return f;
  });
  for (const p of ring) {
    const px = p % w;
    const py = (p / w) | 0;
    const so = (clampI(py + off.dy, h - 1) * w + clampI(px + off.dx, w - 1)) * 4;
    const o = p * 4;
    fixed[0][p] = data[o] - data[so];
    fixed[1][p] = data[o + 1] - data[so + 1];
    fixed[2][p] = data[o + 2] - data[so + 2];
  }
  const corr = membrane(fixed, cov, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = cov[i] / 255;
      if (m <= 0) continue;
      const so = (clampI(y + off.dy, h - 1) * w + clampI(x + off.dx, w - 1)) * 4;
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const healed = data[so + c] + corr[c][i];
        out[o + c] = out[o + c] + (Math.max(0, Math.min(255, healed)) - out[o + c]) * m;
      }
      // Alpha: take the source's coverage so healing over transparency works.
      out[o + 3] = out[o + 3] + (data[so + 3] - out[o + 3]) * m;
    }
  }
}

/**
 * Heal a region: auto-pick the best source offset for the whole blob (spot
 * heal), or — when the blob is large — synthesize it from overlapping blocks,
 * each with its own source, before the shared membrane tone-match.
 * Returns a NEW ImageData for the region (same size as `src`).
 */
export function healRegion(job: HealJob): ImageData {
  const { src, coverage: cov } = job;
  const w = src.width;
  const h = src.height;
  const out = new Uint8ClampedArray(src.data);
  const b = coverageBounds(cov, w, h);
  if (!b) return new ImageData(out, w, h, { colorSpace: src.colorSpace });
  const ring = boundaryRing(cov, w, h);
  if (!ring.length) return new ImageData(out, w, h, { colorSpace: src.colorSpace });
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const holeR = Math.max(bw, bh) / 2;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;

  if (Math.max(bw, bh) <= 120) {
    // Single-source spot heal.
    const off = findBestOffset(src.data, cov, w, h, ring, holeR, cx, cy);
    if (off) healWithOffset(out, src.data, cov, w, h, ring, off);
    return new ImageData(out, w, h, { colorSpace: src.colorSpace });
  }

  // Large region (content-aware fill): per-block sources, feather-blended into
  // a synthesized texture, then ONE membrane pass against the real boundary.
  const B = 64; // block size
  const S = 40; // stride (overlap = B - S)
  const synth = new Float32Array(w * h * 3);
  const wsum = new Float32Array(w * h);
  for (let by = b.y0 - S; by <= b.y1; by += S) {
    for (let bx = b.x0 - S; bx <= b.x1; bx += S) {
      // Does this block touch the hole?
      let touches = false;
      for (let y = Math.max(0, by); y < Math.min(h, by + B) && !touches; y += 4) {
        for (let x = Math.max(0, bx); x < Math.min(w, bx + B); x += 4) {
          if (cov[y * w + x] > 0) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) continue;
      const bcx = bx + B / 2;
      const bcy = by + B / 2;
      const off = findBestOffset(src.data, cov, w, h, ring, Math.max(holeR * 0.6, B), bcx, bcy) ?? {
        dx: Math.round(cx - bcx) * 2,
        dy: Math.round(cy - bcy) * 2,
      };
      for (let y = Math.max(0, by); y < Math.min(h, by + B); y++) {
        for (let x = Math.max(0, bx); x < Math.min(w, bx + B); x++) {
          const i = y * w + x;
          if (cov[i] <= 0) continue;
          const sx = Math.min(w - 1, Math.max(0, x + off.dx));
          const sy = Math.min(h - 1, Math.max(0, y + off.dy));
          const so = (sy * w + sx) * 4;
          // Feather: raised-cosine weight toward the block centre.
          const fx = 1 - Math.abs((x - bcx) / (B / 2));
          const fy = 1 - Math.abs((y - bcy) / (B / 2));
          const wgt = Math.max(0.001, fx * fy);
          synth[i * 3] += src.data[so] * wgt;
          synth[i * 3 + 1] += src.data[so + 1] * wgt;
          synth[i * 3 + 2] += src.data[so + 2] * wgt;
          wsum[i] += wgt;
        }
      }
    }
  }
  // Membrane against the real destination boundary: fixed = dst − synth ring.
  // Synth has no values ON the ring (cov=0 there) — anchor with diff vs a
  // nearest-synth approximation: use diff = dst − dst = 0 fallback when the
  // ring pixel has no synthesized neighbour (keeps it stable).
  const fixed: Float32Array[] = [0, 1, 2].map(() => {
    const f = new Float32Array(w * h);
    f.fill(NaN);
    return f;
  });
  for (const p of ring) {
    const px = p % w;
    const py = (p / w) | 0;
    // nearest covered neighbour's synth value
    let ni = -1;
    for (const [ox, oy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const q = (py + oy) * w + (px + ox);
      if (px + ox >= 0 && px + ox < w && py + oy >= 0 && py + oy < h && cov[q] > 0 && wsum[q] > 0) {
        ni = q;
        break;
      }
    }
    const o = p * 4;
    for (let c = 0; c < 3; c++) {
      fixed[c][p] = ni >= 0 ? src.data[o + c] - synth[ni * 3 + c] / wsum[ni] : 0;
    }
  }
  const corr = membrane(fixed, cov, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = cov[i] / 255;
      if (m <= 0 || wsum[i] <= 0) continue;
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const v = synth[i * 3 + c] / wsum[i] + corr[c][i];
        out[o + c] = out[o + c] + (Math.max(0, Math.min(255, v)) - out[o + c]) * m;
      }
      out[o + 3] = out[o + 3] + (255 - out[o + 3]) * m;
    }
  }
  return new ImageData(out, w, h, { colorSpace: src.colorSpace });
}

/** Suggested padding around a blob's bounds so the source search has room. */
export function healPadding(holeW: number, holeH: number): number {
  return Math.ceil(Math.max(48, Math.max(holeW, holeH) * 1.8));
}
