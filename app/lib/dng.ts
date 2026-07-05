// Hand-written DNG (Digital Negative) decoder — no dependencies.
//
// Scope (the TODO's "DNG subset"): TIFF/IFD structure, CFA or LinearRaw data,
// **uncompressed** (16-bit words or MSB-packed 10/12/14-bit) and **lossless
// JPEG** (ITU-T81 process 14, SOF3 — what the Adobe DNG converter writes)
// in strips or tiles, followed by a develop pass: black/white-level
// normalization → as-shot white balance → camera→sRGB matrix (from
// ColorMatrix2/1, dcraw-style normalization) → baseline exposure → sRGB gamma,
// with bilinear demosaic for CFA mosaics, ActiveArea/DefaultCrop and the
// common orientations. Anything outside the subset (lossy-JPEG/JXL DNGs,
// floating-point HDR data, other RAW containers) returns null and the caller
// falls back to the embedded JPEG preview exactly as before.
//
// Everything is bounds-checked and wrapped — decodeDNG never throws.

export interface RawDecodeResult {
  width: number;
  height: number;
  /** Developed 8-bit RGBA pixels (sRGB). */
  data: Uint8ClampedArray;
}

// ---- TIFF / IFD parsing ------------------------------------------------------

interface Tag {
  type: number;
  count: number;
  /** Raw values (rationals resolved to floats). */
  values: number[];
}

type IFD = Map<number, Tag>;

const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

class Reader {
  readonly dv: DataView;
  readonly le: boolean;
  constructor(dv: DataView, le: boolean) {
    this.dv = dv;
    this.le = le;
  }
  u16(o: number): number {
    return this.dv.getUint16(o, this.le);
  }
  u32(o: number): number {
    return this.dv.getUint32(o, this.le);
  }
  i32(o: number): number {
    return this.dv.getInt32(o, this.le);
  }
}

function readTagValues(r: Reader, type: number, count: number, at: number): number[] {
  const out: number[] = [];
  const n = Math.min(count, 4096); // sanity cap (BlackLevel grids etc. are tiny)
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 1:
      case 2:
      case 7:
        out.push(r.dv.getUint8(at + i));
        break;
      case 6:
        out.push(r.dv.getInt8(at + i));
        break;
      case 3:
        out.push(r.u16(at + i * 2));
        break;
      case 8:
        out.push(r.dv.getInt16(at + i * 2, r.le));
        break;
      case 4:
        out.push(r.u32(at + i * 4));
        break;
      case 9:
        out.push(r.i32(at + i * 4));
        break;
      case 5: {
        const num = r.u32(at + i * 8);
        const den = r.u32(at + i * 8 + 4);
        out.push(den ? num / den : 0);
        break;
      }
      case 10: {
        const num = r.i32(at + i * 8);
        const den = r.i32(at + i * 8 + 4);
        out.push(den ? num / den : 0);
        break;
      }
      case 11:
        out.push(r.dv.getFloat32(at + i * 4, r.le));
        break;
      case 12:
        out.push(r.dv.getFloat64(at + i * 8, r.le));
        break;
      default:
        return out;
    }
  }
  return out;
}

function readIFD(r: Reader, offset: number): { ifd: IFD; next: number } | null {
  if (offset <= 0 || offset + 2 > r.dv.byteLength) return null;
  const count = r.u16(offset);
  if (count > 512) return null;
  const ifd: IFD = new Map();
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > r.dv.byteLength) return null;
    const id = r.u16(e);
    const type = r.u16(e + 2);
    const cnt = r.u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 0) * cnt;
    if (!size) continue;
    const at = size <= 4 ? e + 8 : r.u32(e + 8);
    if (at + size > r.dv.byteLength) continue;
    ifd.set(id, { type, count: cnt, values: readTagValues(r, type, cnt, at) });
  }
  const nextAt = offset + 2 + count * 12;
  const next = nextAt + 4 <= r.dv.byteLength ? r.u32(nextAt) : 0;
  return { ifd, next };
}

const tag = (ifd: IFD, id: number): number[] | null => ifd.get(id)?.values ?? null;
const tag1 = (ifd: IFD, id: number, def = 0): number => ifd.get(id)?.values[0] ?? def;

// ---- Lossless JPEG (SOF3) -----------------------------------------------------

interface Ljpeg {
  precision: number;
  width: number; // samples per line PER COMPONENT
  height: number;
  comps: number;
  /** Scan-order samples: rows of [c0 c1 … cN, c0 c1 …] — for DNG this is the
   *  mosaic row left-to-right (comps × width == mosaic row width). */
  out: Uint16Array;
}

interface Huff {
  // Canonical Huffman decode tables (JPEG spec F.2.2.3 style).
  minCode: Int32Array;
  maxCode: Int32Array;
  valPtr: Int32Array;
  vals: Uint8Array;
}

function buildHuff(bits: Uint8Array, vals: Uint8Array): Huff {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valPtr[l] = k;
    minCode[l] = code;
    code += bits[l - 1];
    k += bits[l - 1];
    maxCode[l] = code - 1;
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, vals };
}

class BitReader {
  private b: Uint8Array;
  private pos: number;
  private acc = 0;
  private n = 0;
  hitMarker = false;
  constructor(b: Uint8Array, pos: number) {
    this.b = b;
    this.pos = pos;
  }
  bit(): number {
    if (this.n === 0) {
      if (this.pos >= this.b.length) {
        this.hitMarker = true;
        return 0;
      }
      let byte = this.b[this.pos++];
      if (byte === 0xff) {
        const next = this.pos < this.b.length ? this.b[this.pos] : 0xd9;
        if (next === 0x00) this.pos++; // stuffed FF
        else {
          this.hitMarker = true; // real marker (EOI/RST) — stop cleanly
          byte = 0;
        }
      }
      this.acc = byte;
      this.n = 8;
    }
    this.n--;
    return (this.acc >> this.n) & 1;
  }
  bits(t: number): number {
    let v = 0;
    for (let i = 0; i < t; i++) v = (v << 1) | this.bit();
    return v;
  }
}

function huffDecode(br: BitReader, h: Huff): number {
  let code = br.bit();
  let l = 1;
  while (code > h.maxCode[l]) {
    if (++l > 16 || br.hitMarker) return 0;
    code = (code << 1) | br.bit();
  }
  return h.vals[h.valPtr[l] + code - h.minCode[l]];
}

/** JPEG "extend": map t low bits to a signed difference. */
function extend(v: number, t: number): number {
  return t === 0 ? 0 : v < 1 << (t - 1) ? v - (1 << t) + 1 : v;
}

/** Decode one lossless-JPEG (SOF3) stream. Returns null on anything outside
 *  the subset (progressive/baseline markers, sampling ≠ 1, restart intervals). */
function ljpegDecode(b: Uint8Array): Ljpeg | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  const tables: (Huff | null)[] = [null, null, null, null];
  let precision = 0;
  let width = 0;
  let height = 0;
  let comps = 0;
  let compTable: number[] = [];
  let predictor = 1;
  let pt = 0;
  let scanAt = -1;

  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xd8) {
      o += 2;
      continue;
    }
    const len = (b[o + 2] << 8) | b[o + 3];
    const seg = o + 4;
    if (marker === 0xc4) {
      // DHT — possibly several tables in one segment.
      let p = seg;
      while (p < o + 2 + len) {
        const tc = b[p] >> 4;
        const th = b[p] & 15;
        const bits = b.subarray(p + 1, p + 17);
        let total = 0;
        for (let i = 0; i < 16; i++) total += bits[i];
        const vals = b.subarray(p + 17, p + 17 + total);
        if (tc === 0 && th < 4) tables[th] = buildHuff(bits, vals);
        p += 17 + total;
      }
    } else if (marker === 0xc3) {
      // SOF3 — lossless, Huffman.
      precision = b[seg];
      height = (b[seg + 1] << 8) | b[seg + 2];
      width = (b[seg + 3] << 8) | b[seg + 4];
      comps = b[seg + 5];
      if (precision < 2 || precision > 16 || !width || !height || comps < 1 || comps > 4) return null;
      for (let c = 0; c < comps; c++) {
        const hv = b[seg + 6 + c * 3 + 1];
        if (hv !== 0x11) return null; // sampling must be 1×1 in the DNG subset
      }
    } else if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) && marker !== 0xc3) {
      return null; // some other SOF — not lossless
    } else if (marker === 0xdd) {
      const ri = (b[seg] << 8) | b[seg + 1];
      if (ri !== 0) return null; // restart intervals: outside the subset
    } else if (marker === 0xda) {
      const ns = b[seg];
      if (ns !== comps) return null;
      compTable = [];
      for (let c = 0; c < ns; c++) compTable.push(b[seg + 2 + c * 2] >> 4);
      // SOS tail: Ss (= predictor selector for lossless), Se, Ah/Al (Al = Pt).
      predictor = b[seg + 1 + ns * 2];
      pt = b[seg + 3 + ns * 2] & 15;
      if (predictor < 1 || predictor > 7) return null;
      scanAt = o + 2 + len;
      break;
    }
    o += 2 + len;
  }
  if (scanAt < 0 || !width || !height) return null;

  const br = new BitReader(b, scanAt);
  const out = new Uint16Array(width * height * comps);
  // One current + one previous row per component.
  const cur: Int32Array[] = [];
  const prev: Int32Array[] = [];
  for (let c = 0; c < comps; c++) {
    cur.push(new Int32Array(width));
    prev.push(new Int32Array(width));
  }
  const defPred = 1 << (precision - pt - 1);
  const maxVal = 0xffff;

  for (let y = 0; y < height; y++) {
    for (let c = 0; c < comps; c++) {
      const t = prev[c];
      prev[c] = cur[c];
      cur[c] = t;
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < comps; c++) {
        const h = tables[compTable[c]];
        if (!h) return null;
        const t = huffDecode(br, h);
        const diff = t === 0 ? 0 : t === 16 ? 32768 : extend(br.bits(t), t);
        let pred: number;
        if (y === 0 && x === 0) pred = defPred;
        else if (y === 0) pred = cur[c][x - 1];
        else if (x === 0) pred = prev[c][x];
        else {
          const a = cur[c][x - 1];
          const bb = prev[c][x];
          const cc = prev[c][x - 1];
          switch (predictor) {
            case 1:
              pred = a;
              break;
            case 2:
              pred = bb;
              break;
            case 3:
              pred = cc;
              break;
            case 4:
              pred = a + bb - cc;
              break;
            case 5:
              pred = a + ((bb - cc) >> 1);
              break;
            case 6:
              pred = bb + ((a - cc) >> 1);
              break;
            default:
              pred = (a + bb) >> 1;
          }
        }
        const val = (pred + diff) & maxVal;
        cur[c][x] = val;
        out[(y * width + x) * comps + c] = (val << pt) & maxVal;
        if (br.hitMarker && !(y === height - 1 && x === width - 1 && c === comps - 1)) {
          // Ran off the stream before the last sample — corrupt.
          if (y * width + x < (height * width) / 2) return null;
        }
      }
    }
  }
  return { precision, width, height, comps, out };
}

// ---- Raw sample assembly (strips / tiles, packed / 16-bit / ljpeg) ------------

/** MSB-first unpack of `count` samples of `bps` bits (rows handled by caller). */
function unpackBits(src: Uint8Array, bps: number, count: number, out: Uint16Array, outAt: number): void {
  let acc = 0;
  let n = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    while (n < bps) {
      acc = (acc << 8) | (p < src.length ? src[p++] : 0);
      n += 8;
    }
    n -= bps;
    out[outAt + i] = (acc >> n) & ((1 << bps) - 1);
  }
}

interface RawGrid {
  w: number;
  h: number;
  bps: number;
  spp: number;
  /** Interleaved samples, row-major, spp per pixel. */
  data: Uint16Array;
}

function assembleRaw(r: Reader, ifd: IFD, buf: Uint8Array): RawGrid | null {
  const w = tag1(ifd, 256);
  const h = tag1(ifd, 257);
  const bps = tag1(ifd, 258, 16);
  const spp = tag1(ifd, 277, 1);
  const compression = tag1(ifd, 259, 1);
  if (!w || !h || w * h > 120_000_000 || bps < 8 || bps > 16 || spp < 1 || spp > 3) return null;
  const data = new Uint16Array(w * h * spp);

  const tileW = tag1(ifd, 322);
  const tileH = tag1(ifd, 323);
  const tiled = tileW > 0 && tileH > 0;
  const offsets = tag(ifd, tiled ? 324 : 273);
  const counts = tag(ifd, tiled ? 325 : 279);
  if (!offsets || !counts || offsets.length !== counts.length) return null;

  const writeRect = (
    samples: Uint16Array,
    rw: number, // source row width in SAMPLES
    x0: number,
    y0: number,
    rectW: number,
    rectH: number,
  ) => {
    for (let y = 0; y < rectH; y++) {
      const dy = y0 + y;
      if (dy >= h) break;
      const copyW = Math.min(rectW, w - x0) * spp;
      const srcRow = y * rw;
      const dstRow = (dy * w + x0) * spp;
      for (let i = 0; i < copyW; i++) data[dstRow + i] = samples[srcRow + i];
    }
  };

  const rowsPerStrip = tag1(ifd, 278, h);
  for (let s = 0; s < offsets.length; s++) {
    const off = offsets[s];
    const cnt = counts[s];
    if (off + cnt > buf.length) return null;
    const bytes = buf.subarray(off, off + cnt);
    const rectW = tiled ? tileW : w;
    const rectH = tiled ? tileH : Math.min(rowsPerStrip, h - s * rowsPerStrip);
    const x0 = tiled ? (s % Math.ceil(w / tileW)) * tileW : 0;
    const y0 = tiled ? Math.floor(s / Math.ceil(w / tileW)) * tileH : s * rowsPerStrip;

    if (compression === 1) {
      const samples = new Uint16Array(rectW * rectH * spp);
      if (bps === 16) {
        const rowBytes = rectW * spp * 2;
        for (let y = 0; y < rectH; y++)
          for (let x = 0; x < rectW * spp; x++) {
            const at = y * rowBytes + x * 2;
            if (at + 1 >= bytes.length) break;
            samples[y * rectW * spp + x] = r.le
              ? bytes[at] | (bytes[at + 1] << 8)
              : (bytes[at] << 8) | bytes[at + 1];
          }
      } else if (bps === 8) {
        for (let i = 0; i < samples.length && i < bytes.length; i++) samples[i] = bytes[i];
      } else {
        // Packed 10/12/14-bit, MSB first, rows byte-aligned.
        const rowBytes = Math.ceil((rectW * spp * bps) / 8);
        for (let y = 0; y < rectH; y++)
          unpackBits(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), bps, rectW * spp, samples, y * rectW * spp);
      }
      writeRect(samples, rectW * spp, x0, y0, rectW, rectH);
    } else if (compression === 7) {
      const lj = ljpegDecode(bytes);
      if (!lj) return null;
      // DNG maps the decoded scan onto the mosaic row-major: comps × width
      // must equal the tile's sample width.
      if (lj.width * lj.comps !== rectW * spp || lj.height !== rectH) {
        // Some writers split a tile row across two ljpeg rows (2× height,
        // half width) — accept when total sample count matches.
        if (lj.width * lj.comps * lj.height !== rectW * spp * rectH) return null;
      }
      writeRect(lj.out, rectW * spp, x0, y0, rectW, rectH);
    } else {
      return null; // lossy JPEG / JXL / deflate DNGs — outside the subset
    }
  }
  return { w, h, bps, spp, data };
}

// ---- Develop -------------------------------------------------------------------

type Mat3 = number[];

function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !isFinite(det)) return null;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

const SRGB_TO_XYZ_D65: Mat3 = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041,
];

/** dcraw-style camera→linear-sRGB matrix from a DNG ColorMatrix (XYZ→camera):
 *  camRGB = CM · (sRGB→XYZ); normalize its rows so camera white stays white;
 *  invert. Returns null → identity (keeps the image usable regardless). */
function camToSrgb(colorMatrix: number[] | null): Mat3 | null {
  if (!colorMatrix || colorMatrix.length < 9) return null;
  const cm = colorMatrix.slice(0, 9);
  const camRgb: Mat3 = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) camRgb[r * 3 + c] += cm[r * 3 + k] * SRGB_TO_XYZ_D65[k * 3 + c];
  for (let r = 0; r < 3; r++) {
    const sum = camRgb[r * 3] + camRgb[r * 3 + 1] + camRgb[r * 3 + 2];
    if (!sum || !isFinite(sum)) return null;
    for (let c = 0; c < 3; c++) camRgb[r * 3 + c] /= sum;
  }
  return invert3(camRgb);
}

function srgbEncode(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Decode + develop a DNG. Null = not a DNG / outside the supported subset. */
export function decodeDNG(buffer: ArrayBuffer): RawDecodeResult | null {
  try {
    return decodeDNGInner(buffer);
  } catch {
    return null;
  }
}

function decodeDNGInner(buffer: ArrayBuffer): RawDecodeResult | null {
  const dv = new DataView(buffer);
  if (dv.byteLength < 16) return null;
  const b0 = dv.getUint16(0, false);
  const le = b0 === 0x4949; // "II"
  if (!le && b0 !== 0x4d4d) return null;
  const r = new Reader(dv, le);
  if (r.u16(2) !== 42) return null;
  const buf = new Uint8Array(buffer);

  // Walk IFD0 + chain + SubIFDs; require DNGVersion; pick the raw IFD.
  const first = readIFD(r, r.u32(4));
  if (!first) return null;
  if (!first.ifd.has(50706)) return null; // DNGVersion — plain TIFFs aren't ours
  const orientation = tag1(first.ifd, 274, 1);

  const candidates: IFD[] = [];
  const visit = (res: { ifd: IFD; next: number } | null, depth: number) => {
    if (!res || depth > 8) return;
    candidates.push(res.ifd);
    const subs = tag(res.ifd, 330);
    if (subs) for (const off of subs) visit(readIFD(r, off), depth + 1);
    if (res.next) visit(readIFD(r, res.next), depth + 1);
  };
  visit(first, 0);

  let raw: IFD | null = null;
  let best = -1;
  for (const ifd of candidates) {
    const photometric = tag1(ifd, 262);
    if (photometric !== 32803 && photometric !== 34892) continue; // CFA / LinearRaw
    const area = tag1(ifd, 256) * tag1(ifd, 257);
    const main = tag1(ifd, 254, 0) === 0 ? 2 : 1; // NewSubfileType 0 = main image
    const score = area * main;
    if (score > best) {
      best = score;
      raw = ifd;
    }
  }
  if (!raw) return null;

  const grid = assembleRaw(r, raw, buf);
  if (!grid) return null;
  const { w, h, spp } = grid;
  const isCFA = tag1(raw, 262) === 32803 && spp === 1;

  // CFA pattern (defaults to RGGB when absent).
  let patW = 2;
  let patH = 2;
  let pattern = [0, 1, 1, 2];
  if (isCFA) {
    const dim = tag(raw, 33421);
    const pat = tag(raw, 33422);
    if (dim && dim.length >= 2 && pat && pat.length >= dim[0] * dim[1]) {
      patH = dim[0];
      patW = dim[1];
      pattern = pat.slice(0, patW * patH);
      if (pattern.some((v) => v > 2)) return null; // non-RGB CFA (e.g. X-Trans w/ emissive) unsupported
      if (patW > 8 || patH > 8) return null;
    }
  }

  // Black / white levels (BlackLevel may repeat over a small grid).
  const white = tag1(raw, 50717, (1 << grid.bps) - 1);
  const blackVals = tag(raw, 50714) ?? [0];
  const blackDim = tag(raw, 50713) ?? [1, 1];
  const bRows = Math.max(1, blackDim[0] | 0);
  const bCols = Math.max(1, blackDim[1] | 0);
  const blackAt = (x: number, y: number, s: number) =>
    blackVals[((y % bRows) * bCols + (x % bCols)) * (spp > 1 ? spp : 1) + (spp > 1 ? s : 0)] ??
    blackVals[0] ??
    0;

  // As-shot white balance (camera-space neutral) + colour matrix + exposure.
  const neutral = tag(raw, 50728) ?? tag(first.ifd, 50728);
  const gain = [1, 1, 1];
  if (neutral && neutral.length >= 3) {
    for (let c = 0; c < 3; c++) gain[c] = neutral[c] > 1e-6 ? 1 / neutral[c] : 1;
    // Normalize so green gain is 1 (keeps exposure stable).
    const gN = gain[1] || 1;
    for (let c = 0; c < 3; c++) gain[c] /= gN;
  }
  const matrix =
    camToSrgb(tag(raw, 50722) ?? tag(first.ifd, 50722) ?? tag(raw, 50721) ?? tag(first.ifd, 50721)) ??
    [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const exposure = Math.pow(2, tag1(raw, 50730, tag1(first.ifd, 50730, 0)));

  // Active area + default crop (both in raw coordinates).
  let ax0 = 0;
  let ay0 = 0;
  let ax1 = w;
  let ay1 = h;
  const active = tag(raw, 50829);
  if (active && active.length >= 4) {
    ay0 = Math.max(0, active[0] | 0);
    ax0 = Math.max(0, active[1] | 0);
    ay1 = Math.min(h, active[2] | 0);
    ax1 = Math.min(w, active[3] | 0);
  }
  const cropO = tag(raw, 50719);
  const cropS = tag(raw, 50720);
  let cx0 = ax0;
  let cy0 = ay0;
  let cx1 = ax1;
  let cy1 = ay1;
  if (cropO && cropS && cropS.length >= 2) {
    cx0 = ax0 + Math.round(cropO[0] ?? 0);
    cy0 = ay0 + Math.round(cropO[1] ?? 0);
    cx1 = Math.min(ax1, cx0 + Math.round(cropS[0]));
    cy1 = Math.min(ay1, cy0 + Math.round(cropS[1]));
  }
  const outW = Math.max(1, cx1 - cx0);
  const outH = Math.max(1, cy1 - cy0);

  // Normalize (black/white + WB folded per site) into a float plane (CFA) or
  // triplets (LinearRaw).
  const cfaColor = (x: number, y: number) => pattern[(y % patH) * patW + (x % patW)];
  const norm = new Float32Array(w * h * (isCFA ? 1 : 3));
  const rangeInv = (blk: number) => 1 / Math.max(1, white - blk);
  if (isCFA) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const blk = blackAt(x, y, 0);
        let v = (grid.data[i] - blk) * rangeInv(blk);
        v = v < 0 ? 0 : v;
        norm[i] = v * gain[cfaColor(x, y)];
      }
  } else {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let s = 0; s < 3; s++) {
          const i = (y * w + x) * 3 + s;
          const blk = blackAt(x, y, s);
          let v = (grid.data[spp === 3 ? i : y * w + x] - blk) * rangeInv(blk);
          v = v < 0 ? 0 : v;
          norm[i] = v * gain[s];
        }
  }

  // Demosaic (bilinear) + matrix + exposure + gamma → 8-bit RGBA, cropped.
  const rot = orientation === 3 ? 2 : orientation === 6 ? 1 : orientation === 8 ? 3 : 0;
  const finalW = rot % 2 ? outH : outW;
  const finalH = rot % 2 ? outW : outH;
  const out = new Uint8ClampedArray(finalW * finalH * 4);

  const at = (x: number, y: number) => {
    const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return norm[yy * w + xx];
  };

  for (let oy = 0; oy < outH; oy++) {
    const y = cy0 + oy;
    for (let ox = 0; ox < outW; ox++) {
      const x = cx0 + ox;
      let cr: number;
      let cg: number;
      let cb: number;
      if (!isCFA) {
        const i = (y * w + x) * 3;
        cr = norm[i];
        cg = norm[i + 1];
        cb = norm[i + 2];
      } else {
        const c = cfaColor(x, y);
        const v = at(x, y);
        // Bilinear neighbours per Bayer geometry.
        const hAvg = (at(x - 1, y) + at(x + 1, y)) / 2;
        const vAvg = (at(x, y - 1) + at(x, y + 1)) / 2;
        const xAvg = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
        const plusAvg = (hAvg + vAvg) / 2;
        if (c === 1) {
          // Green site: neighbours along row/col alternate between R and B
          // depending on the row's pattern.
          const rowHasR = cfaColor(x - 1, y) === 0 || cfaColor(x + 1, y) === 0;
          cg = v;
          if (rowHasR) {
            cr = hAvg;
            cb = vAvg;
          } else {
            cr = vAvg;
            cb = hAvg;
          }
        } else if (c === 0) {
          cr = v;
          cg = plusAvg;
          cb = xAvg;
        } else {
          cb = v;
          cg = plusAvg;
          cr = xAvg;
        }
      }
      let R = (matrix[0] * cr + matrix[1] * cg + matrix[2] * cb) * exposure;
      let G = (matrix[3] * cr + matrix[4] * cg + matrix[5] * cb) * exposure;
      let B = (matrix[6] * cr + matrix[7] * cg + matrix[8] * cb) * exposure;
      R = srgbEncode(R);
      G = srgbEncode(G);
      B = srgbEncode(B);
      // Orientation mapping into the output.
      let dx: number;
      let dy: number;
      if (rot === 0) {
        dx = ox;
        dy = oy;
      } else if (rot === 1) {
        dx = finalW - 1 - oy;
        dy = ox;
      } else if (rot === 2) {
        dx = finalW - 1 - ox;
        dy = finalH - 1 - oy;
      } else {
        dx = oy;
        dy = finalH - 1 - ox;
      }
      const di = (dy * finalW + dx) * 4;
      out[di] = R * 255;
      out[di + 1] = G * 255;
      out[di + 2] = B * 255;
      out[di + 3] = 255;
    }
  }
  return { width: finalW, height: finalH, data: out };
}
