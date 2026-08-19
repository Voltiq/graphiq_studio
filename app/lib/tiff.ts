// Baseline TIFF codec — TODO §9 "TIFF import/export (8/16-bit)".
//
// Dependency-free and DOM-free (Node-verifiable). The DECODER covers the
// baseline plus the common extensions real files use: both byte orders,
// strips AND tiles, 8- and 16-bit unsigned samples (16-bit tops out at the
// 8-bit canvas for now — high byte kept), grayscale (both polarities),
// palette, RGB and RGBA (associated alpha un-premultiplied), compressions
// none/PackBits/LZW/Deflate with the horizontal-differencing predictor, and
// orientations 3/6/8. The ENCODER writes little-endian 8- or 16-bit RGB(A)
// with independently Deflate-compressed strips (CompressionStream), straight
// alpha (ExtraSamples=2), resolution and Software tags.
//
// Outside the subset (returns null → import falls back to the browser/preview
// path): JPEG-in-TIFF, CCITT fax, float/signed samples, planar configuration,
// FillOrder 2, bit depths below 8.

/* ----------------------------- shared helpers ------------------------------ */

const T_BYTE = 1;
const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;

interface Entry {
  type: number;
  count: number;
  /** Absolute offset of the value area (inline or pointed-to). */
  at: number;
}

class Reader {
  readonly v: DataView;
  constructor(
    readonly buf: Uint8Array,
    readonly le: boolean,
  ) {
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u16(o: number): number {
    return o >= 0 && o + 2 <= this.buf.length ? this.v.getUint16(o, this.le) : 0;
  }
  u32(o: number): number {
    return o >= 0 && o + 4 <= this.buf.length ? this.v.getUint32(o, this.le) : 0;
  }
}

const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 9: 4, 10: 8 };

function readIFD(r: Reader, off: number): { entries: Map<number, Entry>; next: number } | null {
  const n = r.u16(off);
  if (!n || off + 2 + n * 12 + 4 > r.buf.length) return null;
  const entries = new Map<number, Entry>();
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const count = r.u32(e + 4);
    const size = (TYPE_BYTES[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : r.u32(e + 8);
    entries.set(tag, { type, count, at });
  }
  return { entries, next: r.u32(off + 2 + n * 12) };
}

/** Read an entry as a number array (SHORT/LONG/BYTE; RATIONAL → num/den). */
function nums(r: Reader, e: Entry | undefined, max = 1 << 20): number[] {
  if (!e) return [];
  const out: number[] = [];
  const n = Math.min(e.count, max);
  for (let i = 0; i < n; i++) {
    if (e.type === T_SHORT) out.push(r.u16(e.at + i * 2));
    else if (e.type === T_LONG) out.push(r.u32(e.at + i * 4));
    else if (e.type === T_BYTE || e.type === 6 || e.type === 7) out.push(r.buf[e.at + i] ?? 0);
    else if (e.type === T_RATIONAL) {
      const den = r.u32(e.at + i * 8 + 4);
      out.push(den ? r.u32(e.at + i * 8) / den : 0);
    } else out.push(0);
  }
  return out;
}

const num = (r: Reader, e: Entry | undefined, dflt: number): number => {
  const a = nums(r, e, 1);
  return a.length ? a[0] : dflt;
};

/* ------------------------------ decompressors ------------------------------ */

/** Apple PackBits (compression 32773). */
export function unpackBits(src: Uint8Array, dstLen: number): Uint8Array {
  const out = new Uint8Array(dstLen);
  let si = 0;
  let di = 0;
  while (si < src.length && di < dstLen) {
    const n = (src[si++] << 24) >> 24; // signed
    if (n >= 0) {
      for (let i = 0; i <= n && si < src.length && di < dstLen; i++) out[di++] = src[si++];
    } else if (n !== -128) {
      const b = src[si++];
      for (let i = 0; i < 1 - n && di < dstLen; i++) out[di++] = b;
    }
  }
  return out;
}

/** TIFF LZW (compression 5): MSB-first codes, Clear=256, EOI=257, early change. */
export function unlzw(src: Uint8Array, dstLen: number): Uint8Array | null {
  const out = new Uint8Array(dstLen);
  let di = 0;
  // String table as (prefix code, appended byte); 0..255 literals.
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  let tableLen = 258;
  let width = 9;
  let bitBuf = 0;
  let bitCnt = 0;
  let si = 0;
  let prev = -1;
  const stack = new Uint8Array(4096);

  const firstByte = (code: number): number => {
    while (code >= 258) code = prefix[code];
    return code;
  };
  const emit = (code: number): boolean => {
    let sp = 0;
    let c = code;
    while (c >= 258) {
      if (sp >= stack.length || prefix[c] < 0) return false;
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    stack[sp++] = c;
    while (sp > 0 && di < dstLen) out[di++] = stack[--sp];
    return true;
  };

  for (;;) {
    while (bitCnt < width) {
      if (si >= src.length) return di === dstLen ? out : di > 0 ? out : null;
      bitBuf = (bitBuf << 8) | src[si++];
      bitCnt += 8;
    }
    const code = (bitBuf >> (bitCnt - width)) & ((1 << width) - 1);
    bitCnt -= width;
    if (code === 256) {
      tableLen = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (code === 257) return out;
    if (prev < 0) {
      if (code > 255) return null;
      out[di++] = code;
      prev = code;
    } else {
      if (code < tableLen) {
        if (!emit(code)) return null;
        if (tableLen < 4096) {
          prefix[tableLen] = prev;
          suffix[tableLen] = firstByte(code);
          tableLen++;
        }
      } else if (code === tableLen && tableLen < 4096) {
        // KwK case: string = prev's string + first byte of prev's string.
        prefix[tableLen] = prev;
        suffix[tableLen] = firstByte(prev);
        tableLen++;
        if (!emit(code)) return null;
      } else return null;
      prev = code;
    }
    // Early change: TIFF bumps the width one code before the table fills.
    if (tableLen >= (1 << width) - 1 && width < 12) width++;
    if (di >= dstLen) return out;
  }
}

async function inflate(src: Uint8Array, dstLen: number): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([src as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    if (raw.length === dstLen) return raw;
    if (raw.length > dstLen) return raw.subarray(0, dstLen);
    const out = new Uint8Array(dstLen);
    out.set(raw);
    return out;
  } catch {
    return null;
  }
}

/* --------------------------------- decode ---------------------------------- */

export interface TiffDecodeResult {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Source bit depth (16-bit data is delivered on the 8-bit canvas, high byte). */
  bits: 8 | 16;
  dpi?: number;
  /** Total IFDs in the file — only the first full-resolution one is decoded. */
  pages: number;
}

/** Decode a baseline(-ish) TIFF. Null = not a TIFF or outside the subset. */
export async function decodeTiff(buffer: ArrayBuffer): Promise<TiffDecodeResult | null> {
  const buf = new Uint8Array(buffer);
  if (buf.length < 12) return null;
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  const be = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!le && !be) return null;
  const r = new Reader(buf, le);
  if (r.u16(2) !== 42) return null;

  // Walk the IFD chain; decode the first full-resolution image.
  let off = r.u32(4);
  let chosen: Map<number, Entry> | null = null;
  let pages = 0;
  const seen = new Set<number>();
  while (off && !seen.has(off) && pages < 64) {
    seen.add(off);
    const ifd = readIFD(r, off);
    if (!ifd) break;
    pages++;
    const sub = num(r, ifd.entries.get(254), 0);
    if (!chosen && (sub & 1) === 0 && ifd.entries.has(256)) chosen = ifd.entries;
    off = ifd.next;
  }
  if (!chosen) return null;
  const e = chosen;

  const width = num(r, e.get(256), 0);
  const height = num(r, e.get(257), 0);
  if (!width || !height || width * height > 268435456) return null;
  const bitsArr = nums(r, e.get(258), 8);
  const bits = bitsArr.length ? bitsArr[0] : 1;
  const spp = num(r, e.get(277), 1);
  const photometric = num(r, e.get(262), 1);
  const compression = num(r, e.get(259), 1);
  const predictor = num(r, e.get(317), 1);
  const planar = num(r, e.get(284), 1);
  const fillOrder = num(r, e.get(266), 1);
  const sampleFormat = nums(r, e.get(339));
  const extra = nums(r, e.get(338));
  const orientation = num(r, e.get(274), 1);

  if ((bits !== 8 && bits !== 16) || bitsArr.some((b) => b !== bits)) return null;
  if (spp < 1 || spp > 4 || planar !== 1 || fillOrder !== 1) return null;
  if (sampleFormat.some((f) => f !== 1)) return null; // unsigned only
  if (photometric > 3) return null;
  if (photometric === 3 && (spp !== 1 || bits !== 8 || !e.has(320))) return null;
  if (![1, 5, 8, 32773, 32946].includes(compression)) return null;

  const bytesPer = bits >> 3;
  const rowBytes = width * spp * bytesPer;
  const samples = new Uint8Array(rowBytes * height);

  // Undo LZW/Deflate horizontal differencing in place (per row, per channel).
  const undiff = (row: Uint8Array, w: number) => {
    if (predictor !== 2) return;
    if (bits === 8) {
      for (let x = spp; x < w * spp; x++) row[x] = (row[x] + row[x - spp]) & 255;
    } else {
      // 16-bit predictor works on the sample values in FILE byte order.
      const hi = le ? 1 : 0;
      const lo = le ? 0 : 1;
      for (let x = spp; x < w * spp; x++) {
        const o = x * 2;
        const p = (x - spp) * 2;
        const v =
          (((row[o + hi] << 8) | row[o + lo]) + ((row[p + hi] << 8) | row[p + lo])) & 0xffff;
        row[o + hi] = v >> 8;
        row[o + lo] = v & 255;
      }
    }
  };

  const decompress = async (raw: Uint8Array, outLen: number): Promise<Uint8Array | null> => {
    if (compression === 1) return raw.length >= outLen ? raw.subarray(0, outLen) : null;
    if (compression === 32773) return unpackBits(raw, outLen);
    if (compression === 5) return unlzw(raw, outLen);
    return inflate(raw, outLen);
  };

  if (e.has(322)) {
    // Tiled layout.
    const tw = num(r, e.get(322), 0);
    const th = num(r, e.get(323), 0);
    const offs = nums(r, e.get(324), 1 << 16);
    const counts = nums(r, e.get(325), 1 << 16);
    if (!tw || !th || !offs.length || offs.length !== counts.length) return null;
    const across = Math.ceil(width / tw);
    const down = Math.ceil(height / th);
    if (offs.length < across * down) return null;
    const tileRow = tw * spp * bytesPer;
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const i = ty * across + tx;
        const data = await decompress(buf.subarray(offs[i], offs[i] + counts[i]), tileRow * th);
        if (!data) return null;
        const copyW = Math.min(tw, width - tx * tw) * spp * bytesPer;
        const copyH = Math.min(th, height - ty * th);
        for (let y = 0; y < copyH; y++) {
          const row = data.subarray(y * tileRow, y * tileRow + tileRow);
          undiff(row, tw);
          samples.set(
            row.subarray(0, copyW),
            (ty * th + y) * rowBytes + tx * tw * spp * bytesPer,
          );
        }
      }
    }
  } else {
    // Stripped layout.
    const offs = nums(r, e.get(273), 1 << 20);
    const counts = nums(r, e.get(279), 1 << 20);
    const rps = num(r, e.get(278), height) || height;
    if (!offs.length) return null;
    for (let s = 0; s < offs.length; s++) {
      const y0 = s * rps;
      if (y0 >= height) break;
      const rows = Math.min(rps, height - y0);
      const cnt = counts[s] ?? buf.length - offs[s];
      const data = await decompress(buf.subarray(offs[s], offs[s] + cnt), rows * rowBytes);
      if (!data) return null;
      for (let y = 0; y < rows; y++) {
        const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
        undiff(row, width);
        samples.set(row, (y0 + y) * rowBytes);
      }
    }
  }

  // Palette lookup table (u16 → 8-bit).
  let pal: Uint8Array | null = null;
  if (photometric === 3) {
    const map = nums(r, e.get(320), 3 << bits);
    const n = 1 << bits;
    if (map.length < 3 * n) return null;
    pal = new Uint8Array(3 * n);
    for (let i = 0; i < 3 * n; i++) pal[i] = map[i] >> 8;
  }

  // Expand samples → RGBA bytes (16-bit keeps the high byte for the 8-bit canvas).
  const rgba = new Uint8ClampedArray(width * height * 4);
  const alphaIdx = spp === 2 || spp === 4 ? spp - 1 : -1;
  const associated = alphaIdx >= 0 && (extra[0] ?? (spp === 4 && photometric === 2 ? 2 : 0)) === 1;
  const val =
    bits === 8
      ? (o: number) => samples[o]
      : le
        ? (o: number) => samples[o * 2 + 1]
        : (o: number) => samples[o * 2];
  for (let p = 0; p < width * height; p++) {
    const s = p * spp;
    const d = p * 4;
    let rr: number;
    let gg: number;
    let bb: number;
    if (photometric === 2) {
      rr = val(s);
      gg = val(s + 1);
      bb = val(s + 2);
    } else if (pal) {
      const idx = val(s);
      rr = pal[idx];
      gg = pal[(1 << bits) + idx];
      bb = pal[(2 << bits) + idx];
    } else {
      const g = photometric === 0 ? 255 - val(s) : val(s);
      rr = g;
      gg = g;
      bb = g;
    }
    const a = alphaIdx >= 0 ? val(s + alphaIdx) : 255;
    if (associated && a > 0 && a < 255) {
      // Associated (premultiplied) alpha → straight for the canvas.
      rr = Math.min(255, Math.round((rr * 255) / a));
      gg = Math.min(255, Math.round((gg * 255) / a));
      bb = Math.min(255, Math.round((bb * 255) / a));
    } else if (associated && a === 0) {
      rr = gg = bb = 0;
    }
    rgba[d] = rr;
    rgba[d + 1] = gg;
    rgba[d + 2] = bb;
    rgba[d + 3] = a;
  }

  // Resolution → dpi.
  let dpi: number | undefined;
  const xres = num(r, e.get(282), 0);
  if (xres > 0) {
    const unit = num(r, e.get(296), 2);
    if (unit === 2) dpi = Math.round(xres);
    else if (unit === 3) dpi = Math.round(xres * 2.54);
  }

  const oriented = applyOrientation(rgba, width, height, orientation);
  return {
    width: oriented.w,
    height: oriented.h,
    rgba: oriented.rgba,
    bits: bits as 8 | 16,
    dpi,
    pages,
  };
}

function applyOrientation(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  o: number,
): { rgba: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
  if (o !== 3 && o !== 6 && o !== 8) return { rgba, w, h };
  const swap = o !== 3;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8ClampedArray(rgba.length);
  const s32 = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
  const d32 = new Uint32Array(out.buffer, 0, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      if (o === 3) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else if (o === 6) {
        dx = h - 1 - y;
        dy = x;
      } else {
        dx = y;
        dy = w - 1 - x;
      }
      d32[dy * W + dx] = s32[y * w + x];
    }
  }
  return { rgba: out, w: W, h: H };
}

/* --------------------------------- encode ---------------------------------- */

export interface TiffEncodeOptions {
  bits: 8 | 16;
  dpi?: number;
  /** Write an alpha channel (straight, ExtraSamples=2). */
  alpha?: boolean;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode RGBA bytes as a little-endian, Deflate-compressed 8/16-bit TIFF. */
export async function encodeTiff(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: TiffEncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const spp = opts.alpha ? 4 : 3;
  const bytesPer = opts.bits >> 3;
  const rowBytes = width * spp * bytesPer;

  // Build raw sample rows (16-bit widens v → v·257, little-endian).
  const raw = new Uint8Array(rowBytes * height);
  let o = 0;
  for (let p = 0; p < width * height; p++) {
    const s = p * 4;
    for (let c = 0; c < spp; c++) {
      const v = rgba[s + c];
      if (opts.bits === 8) raw[o++] = v;
      else {
        raw[o++] = v; // v·257 = (v<<8)|v — low byte first (II)
        raw[o++] = v;
      }
    }
  }

  // Strips of ~1 MB uncompressed, each an independent zlib stream.
  const rps = Math.max(1, Math.min(height, Math.floor((1 << 20) / Math.max(1, rowBytes)) || 1));
  const strips: Uint8Array[] = [];
  for (let y = 0; y < height; y += rps) {
    const rows = Math.min(rps, height - y);
    strips.push(await deflateRaw(raw.subarray(y * rowBytes, (y + rows) * rowBytes)));
  }

  const software = "Graphiq Studio";
  const dpi = opts.dpi && opts.dpi > 0 ? Math.round(opts.dpi) : 300;

  // Tag layout (ascending), then external value areas, then strip data.
  interface Tag {
    tag: number;
    type: number;
    count: number;
    /** Inline value (strip offsets are patched once positions are known). */
    value: number;
    ext?: Uint8Array; // external payload
  }
  const shorts = (vals: number[]): Uint8Array => {
    const b = new Uint8Array(vals.length * 2);
    const dv = new DataView(b.buffer);
    vals.forEach((v, i) => dv.setUint16(i * 2, v, true));
    return b;
  };
  const longs = (vals: number[]): Uint8Array => {
    const b = new Uint8Array(vals.length * 4);
    const dv = new DataView(b.buffer);
    vals.forEach((v, i) => dv.setUint32(i * 4, v, true));
    return b;
  };
  const rational = (v: number): Uint8Array => longs([v, 1]);

  const stripByteCounts = strips.map((s) => s.length);
  const stripOffsets = new Array<number>(strips.length).fill(0); // patched later

  const tags: Tag[] = [
    { tag: 256, type: T_LONG, count: 1, value: width },
    { tag: 257, type: T_LONG, count: 1, value: height },
    { tag: 258, type: T_SHORT, count: spp, value: 0, ext: shorts(new Array(spp).fill(opts.bits)) },
    { tag: 259, type: T_SHORT, count: 1, value: 8 }, // Deflate
    { tag: 262, type: T_SHORT, count: 1, value: 2 }, // RGB
    { tag: 273, type: T_LONG, count: strips.length, value: 0, ext: longs(stripOffsets) },
    { tag: 277, type: T_SHORT, count: 1, value: spp },
    { tag: 278, type: T_LONG, count: 1, value: rps },
    { tag: 279, type: T_LONG, count: strips.length, value: 0, ext: longs(stripByteCounts) },
    { tag: 282, type: T_RATIONAL, count: 1, value: 0, ext: rational(dpi) },
    { tag: 283, type: T_RATIONAL, count: 1, value: 0, ext: rational(dpi) },
    { tag: 284, type: T_SHORT, count: 1, value: 1 },
    { tag: 296, type: T_SHORT, count: 1, value: 2 },
    { tag: 305, type: 2, count: software.length + 1, value: 0, ext: new TextEncoder().encode(software + "\0") },
    ...(opts.alpha ? [{ tag: 338, type: T_SHORT, count: 1, value: 2 } as Tag] : []),
    { tag: 339, type: T_SHORT, count: spp, value: 0, ext: shorts(new Array(spp).fill(1)) },
  ];
  // Inline any external payload that fits in the 4 value bytes.
  for (const t of tags) {
    if (t.ext && t.ext.length <= 4) {
      const dv = new DataView(new ArrayBuffer(4));
      t.ext.forEach((b, i) => dv.setUint8(i, b));
      t.value = dv.getUint32(0, true);
      t.ext = undefined;
    }
  }

  const ifdAt = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let extAt = ifdAt + ifdSize;
  const extOffsets = new Map<Tag, number>();
  for (const t of tags) {
    if (t.ext) {
      if (extAt & 1) extAt++; // word-align value areas
      extOffsets.set(t, extAt);
      extAt += t.ext.length;
    }
  }
  let dataAt = extAt + (extAt & 1);
  const stripStart: number[] = [];
  for (const s of strips) {
    stripStart.push(dataAt);
    dataAt += s.length;
  }
  // Patch the strip-offset array now that positions are known.
  const soTag = tags.find((t) => t.tag === 273)!;
  if (soTag.ext) soTag.ext = longs(stripStart);
  else soTag.value = stripStart[0];

  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, tags.length, true);
  tags.forEach((t, i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, t.tag, true);
    dv.setUint16(e + 2, t.type, true);
    dv.setUint32(e + 4, t.count, true);
    if (t.ext) dv.setUint32(e + 8, extOffsets.get(t)!, true);
    else dv.setUint32(e + 8, t.value as number, true);
  });
  dv.setUint32(ifdAt + 2 + tags.length * 12, 0, true); // no next IFD
  for (const t of tags) if (t.ext) out.set(t.ext, extOffsets.get(t)!);
  strips.forEach((s, i) => out.set(s, stripStart[i]));
  return out as Uint8Array<ArrayBuffer>;
}
