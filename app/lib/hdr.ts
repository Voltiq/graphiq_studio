// 32-bit float / HDR core — TODO §7.
//
// A hand-written, dependency-free HDR pipeline over Float32 radiance maps:
//   • mergeToHdr: Debevec-style exposure fusion of bracketed SDR frames
//     (hat-weighted, EV-scaled linear averages) into a relative-linear
//     Float32Array where 1.0 = SDR white of the reference (median-EV) frame.
//   • tonemap: float → display bytes with an exposure control and three
//     operators (linear clip / extended Reinhard on luminance / Hable filmic).
//   • encodeHdrPng: a TRUE HDR export — a hand-written 16-bit PNG encoder
//     (zlib via CompressionStream) tagged with a `cICP` chunk as Rec.2100
//     PQ or HLG, which HDR-capable browsers/displays render beyond SDR white.
//
// Everything here is pure math on typed arrays (Node-verifiable); the dialogs
// own file decode and canvas I/O. The float map lives on the document IN
// MEMORY only — .gproj does not persist it (documented honest limit).

import { crc32 } from "./zip";
import type { ImageMetadata } from "./metadata";

/** Relative scene-linear radiance, 3 floats (RGB) per pixel; 1.0 = SDR white. */
export interface HdrImage {
  w: number;
  h: number;
  data: Float32Array;
}

export type TonemapMethod = "linear" | "reinhard" | "filmic";
export type HdrTransfer = "pq" | "hlg";

export interface TonemapOptions {
  /** Exposure in stops (multiplies radiance by 2^exposure). */
  exposure: number;
  method: TonemapMethod;
  /** Luminance that maps to white (reinhard/filmic headroom). */
  white?: number;
}

/* ------------------------------- sRGB transfer ----------------------------- */

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function srgbByteToLinear(b: number): number {
  return SRGB_LIN[b & 255];
}

export function linearToSrgbByte(f: number): number {
  const v = f <= 0 ? 0 : f >= 1 ? 1 : f;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/* ------------------------------ EV estimation ------------------------------ */

/** EV100 from EXIF (log2(N²/t) − log2(ISO/100)); null when the capture fields
 *  are missing. Only RELATIVE EVs matter to the merge, so a bracket from one
 *  camera works even if the absolute calibration is off. */
export function evFromMetadata(m: ImageMetadata | null | undefined): number | null {
  if (!m || !m.exposureTime || !m.fNumberValue) return null;
  if (m.exposureTime <= 0 || m.fNumberValue <= 0) return null;
  const iso = m.iso && m.iso > 0 ? m.iso : 100;
  return Math.log2((m.fNumberValue * m.fNumberValue) / m.exposureTime) - Math.log2(iso / 100);
}

/** EVs for a bracket: EXIF when EVERY frame has one (centred on their median),
 *  else brightness rank — brightest frame gets the lowest EV, spaced 2 stops.
 *  `lumas` are the frames' mean lumas (any consistent scale). */
export function suggestEvs(metaEvs: (number | null)[], lumas: number[]): number[] {
  const n = metaEvs.length;
  if (n > 0 && metaEvs.every((e) => e !== null)) {
    const evs = metaEvs as number[];
    const mid = median(evs);
    return evs.map((e) => round2(e - mid));
  }
  // Rank by brightness: brightest = most light captured = lowest EV.
  const order = lumas.map((l, i) => ({ l, i })).sort((a, b) => b.l - a.l);
  const evs = new Array<number>(n).fill(0);
  const mid = (n - 1) / 2;
  order.forEach((o, rank) => {
    evs[o.i] = round2((rank - mid) * 2);
  });
  return evs;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Mean luma (0..255) of an RGBA buffer — the brightness-rank input. */
export function meanLuma(rgba: Uint8ClampedArray): number {
  let sum = 0;
  const n = rgba.length >> 2;
  for (let i = 0; i < rgba.length; i += 4) {
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
  }
  return n ? sum / n : 0;
}

/* -------------------------------- Merge ------------------------------------ */

export interface HdrSourceFrame {
  rgba: Uint8ClampedArray;
  /** EV of this frame (relative scale is fine). */
  ev: number;
}

/**
 * Merge bracketed frames into a radiance map. Per pixel, each frame's linear
 * value is scaled by 2^(ev − evRef) (higher EV = less light captured = its
 * pixels represent MORE scene radiance per level) and averaged under a hat
 * weight on the frame's luma — mid-tones count most; frames with any clipped
 * channel (≥254) are excluded at that pixel because their colour is wrong.
 * Fallback when every frame is unusable: the darkest (highest-EV) frame for
 * blown pixels, the brightest for crushed ones.
 */
export function mergeToHdr(frames: HdrSourceFrame[], w: number, h: number): HdrImage {
  const n = frames.length;
  const evRef = median(frames.map((f) => f.ev));
  const scale = frames.map((f) => Math.pow(2, f.ev - evRef));
  // Highest EV = least exposed = clips last; lowest EV = sees shadows best.
  let darkest = 0;
  let brightest = 0;
  for (let i = 1; i < n; i++) {
    if (frames[i].ev > frames[darkest].ev) darkest = i;
    if (frames[i].ev < frames[brightest].ev) brightest = i;
  }
  const out = new Float32Array(w * h * 3);
  const px = w * h;
  for (let p = 0; p < px; p++) {
    const o4 = p * 4;
    const o3 = p * 3;
    let sw = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let allHigh = true;
    for (let i = 0; i < n; i++) {
      const d = frames[i].rgba;
      const rb = d[o4];
      const gb = d[o4 + 1];
      const bb = d[o4 + 2];
      const maxc = rb > gb ? (rb > bb ? rb : bb) : gb > bb ? gb : bb;
      if (maxc < 254) allHigh = false;
      else continue; // clipped high — colour untrustworthy here
      const luma = (0.2126 * rb + 0.7152 * gb + 0.0722 * bb) / 255;
      // Hat weight with a small floor so a sole usable frame still lands.
      const wgt = Math.max(0.02, 1 - Math.abs(2 * luma - 1));
      const s = scale[i];
      sw += wgt;
      r += wgt * SRGB_LIN[rb] * s;
      g += wgt * SRGB_LIN[gb] * s;
      b += wgt * SRGB_LIN[bb] * s;
    }
    if (sw > 1e-9) {
      out[o3] = r / sw;
      out[o3 + 1] = g / sw;
      out[o3 + 2] = b / sw;
    } else {
      // Every frame excluded: blown → trust the darkest frame, else brightest.
      const i = allHigh ? darkest : brightest;
      const d = frames[i].rgba;
      const s = scale[i];
      out[o3] = SRGB_LIN[d[o4]] * s;
      out[o3 + 1] = SRGB_LIN[d[o4 + 1]] * s;
      out[o3 + 2] = SRGB_LIN[d[o4 + 2]] * s;
    }
  }
  return { w, h, data: out };
}

/** Block-average downscale for cheap live previews. */
export function downscaleHdr(hdr: HdrImage, maxW: number): HdrImage {
  if (hdr.w <= maxW) return hdr;
  const k = Math.ceil(hdr.w / maxW);
  const w = Math.floor(hdr.w / k);
  const h = Math.max(1, Math.floor(hdr.h / k));
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++) {
        const row = (y * k + dy) * hdr.w;
        for (let dx = 0; dx < k; dx++) {
          const o = (row + x * k + dx) * 3;
          r += hdr.data[o];
          g += hdr.data[o + 1];
          b += hdr.data[o + 2];
        }
      }
      const o = (y * w + x) * 3;
      const inv = 1 / (k * k);
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  return { w, h, data: out };
}

/* ------------------------------- Tone mapping ------------------------------ */

// Hable/Uncharted 2 filmic curve.
const hable = (x: number): number => {
  const A = 0.15;
  const B = 0.5;
  const C = 0.1;
  const D = 0.2;
  const E = 0.02;
  const F = 0.3;
  return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
};

/** Tone-map a radiance map to opaque sRGB RGBA bytes. */
export function tonemap(hdr: HdrImage, opts: TonemapOptions): Uint8ClampedArray<ArrayBuffer> {
  const { data } = hdr;
  const m = Math.pow(2, opts.exposure);
  const out = new Uint8ClampedArray(hdr.w * hdr.h * 4);
  const method = opts.method;
  const W = opts.white && opts.white > 1 ? opts.white : method === "filmic" ? 11.2 : 8;
  const invHW = method === "filmic" ? 1 / hable(W) : 0;
  const invW2 = 1 / (W * W);
  for (let p = 0, o3 = 0, o4 = 0; o3 < data.length; p++, o3 += 3, o4 += 4) {
    let r = data[o3] * m;
    let g = data[o3 + 1] * m;
    let b = data[o3 + 2] * m;
    if (method === "reinhard") {
      // Extended Reinhard on luminance — preserves colour ratios.
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (y > 0) {
        const s = ((y * (1 + y * invW2)) / (1 + y)) / y;
        r *= s;
        g *= s;
        b *= s;
      }
    } else if (method === "filmic") {
      r = hable(2 * r) * invHW;
      g = hable(2 * g) * invHW;
      b = hable(2 * b) * invHW;
    }
    out[o4] = linearToSrgbByte(r);
    out[o4 + 1] = linearToSrgbByte(g);
    out[o4 + 2] = linearToSrgbByte(b);
    out[o4 + 3] = 255;
  }
  return out;
}

/* --------------------------- Rec.2100 signal path -------------------------- */

// BT.709 → BT.2020 linear primaries (BT.2087 matrix, rows sum to 1).
export function bt709To2020(r: number, g: number, b: number): [number, number, number] {
  return [
    0.6274 * r + 0.3293 * g + 0.0433 * b,
    0.0691 * r + 0.9195 * g + 0.0114 * b,
    0.0164 * r + 0.088 * g + 0.8956 * b,
  ];
}

/** SMPTE ST 2084 (PQ) inverse EOTF: Y = nits/10000 → signal 0..1.
 *  True black returns exactly 0 (the raw curve leaves ~7e-7 at Y=0). */
export function pqEncode(y: number): number {
  if (y <= 0) return 0;
  const Y = y >= 1 ? 1 : y;
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const ym = Math.pow(Y, m1);
  return Math.pow((c1 + c2 * ym) / (1 + c3 * ym), m2);
}

/** ARIB STD-B67 (HLG) OETF: scene-linear E 0..1 → signal 0..1. */
export function hlgEncode(e: number): number {
  const E = e <= 0 ? 0 : e >= 1 ? 1 : e;
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  return E <= 1 / 12 ? Math.sqrt(3 * E) : a * Math.log(12 * E - b) + c;
}

/* --------------------------- 16-bit PNG (cICP) export ---------------------- */

export interface HdrExportOptions {
  transfer: HdrTransfer;
  /** Nits assigned to radiance 1.0 (SDR/graphics white; Rec.2408 says 203). */
  sdrWhite?: number;
  /** PQ peak clamp in nits (HLG is display-relative; it always fills 0..1). */
  peak?: number;
  /** Extra exposure in stops applied before encoding. */
  exposure?: number;
}

const te = new TextEncoder();

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = te.encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  const body = new Uint8Array(4 + data.length);
  body.set(t, 0);
  body.set(data, 4);
  dv.setUint32(8 + data.length, crc32(body) >>> 0);
  return out;
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  // CompressionStream("deflate") emits the zlib format PNG's IDAT requires.
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode the radiance map as a 16-bit/channel RGB PNG tagged Rec.2100 via a
 * `cICP` chunk (primaries BT.2020=9, transfer PQ=16 / HLG=18, matrix RGB=0,
 * full range). HDR-capable browsers render these brighter than SDR white on
 * HDR displays; SDR viewers tone-map (or, worst case, show flat colours) —
 * the pixels and tags are valid PNG either way.
 */
export async function encodeHdrPng(hdr: HdrImage, opts: HdrExportOptions): Promise<Blob> {
  const { w, h, data } = hdr;
  const sdrWhite = opts.sdrWhite && opts.sdrWhite > 0 ? opts.sdrWhite : 203;
  const peak = opts.peak && opts.peak > sdrWhite ? opts.peak : 1000;
  const m = Math.pow(2, opts.exposure ?? 0);
  const pq = opts.transfer === "pq";

  // Raw scanlines: filter byte 0 + big-endian u16 RGB per pixel.
  const stride = 1 + w * 6;
  const raw = new Uint8Array(stride * h);
  const encode = (lin: number): number => {
    const l = lin < 0 ? 0 : lin;
    const v = pq
      ? pqEncode(Math.min(l * sdrWhite, peak) / 10000)
      : hlgEncode(Math.min((l * sdrWhite) / 1000, 1));
    return Math.round(v * 65535);
  };
  for (let y = 0; y < h; y++) {
    let o = y * stride + 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = data[i] * m;
      const g = data[i + 1] * m;
      const b = data[i + 2] * m;
      const ur = encode(0.6274 * r + 0.3293 * g + 0.0433 * b);
      const ug = encode(0.0691 * r + 0.9195 * g + 0.0114 * b);
      const ub = encode(0.0164 * r + 0.088 * g + 0.8956 * b);
      raw[o++] = ur >> 8;
      raw[o++] = ur & 255;
      raw[o++] = ug >> 8;
      raw[o++] = ug & 255;
      raw[o++] = ub >> 8;
      raw[o++] = ub & 255;
    }
  }

  const ihdr = new Uint8Array(13);
  {
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr[8] = 16; // bit depth
    ihdr[9] = 2; // colour type: truecolour RGB
  }
  const cicp = new Uint8Array([9, pq ? 16 : 18, 0, 1]);
  const idat = await zlibDeflate(raw);

  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("cICP", cicp),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "image/png" });
}

/** Is the current display capable of showing HDR headroom? (Client-only.) */
export function hasHdrDisplay(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(dynamic-range: high)").matches;
}
