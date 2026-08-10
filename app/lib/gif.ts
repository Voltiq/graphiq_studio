// GIF87a/89a decoder (TODO §9 Animated) — dependency-free and DOM-free, so it
// is Node-verifiable like the PSD/TIFF/PDF codecs.
//
// Browsers will only ever hand you a GIF's FIRST frame (`createImageBitmap`
// and <img> both animate internally and expose nothing), so importing an
// animation as a layer stack means decoding it ourselves. GIF is a good target
// for that: it is fully specified, and the whole job is an LZW decompressor
// plus the frame-composition rules (a frame is a sub-rectangle patched onto the
// previous canvas, with a disposal method saying what to do afterwards).
//
// Output is straight RGBA for every frame, already composed to full canvas
// size — which is what a layer stack needs.

export interface GifFrame {
  /** Full-canvas RGBA, already composed over the preceding frames. */
  rgba: Uint8ClampedArray;
  /** Display time in milliseconds (GIF stores hundredths of a second). */
  delayMs: number;
  /** The sub-rectangle this frame actually redrew, before composition. */
  rect: { x: number; y: number; w: number; h: number };
  /** Disposal method from the Graphic Control Extension (0–3). */
  disposal: number;
}

export interface GifImage {
  width: number;
  height: number;
  frames: GifFrame[];
  /** Netscape loop count: 0 = forever, absent ⇒ 1 pass. */
  loops: number;
}

/** Cheap sniff — the 6-byte signature, before anything is parsed. */
export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 && // 8
    (bytes[4] === 0x37 || bytes[4] === 0x39) && // 7 | 9
    bytes[5] === 0x61 // a
  );
}

/**
 * GIF LZW: variable-width codes, a dictionary that grows from the clear code
 * up to 4095, and a reset whenever the CLEAR code appears. Codes are packed
 * LSB-first across byte boundaries.
 *
 * The dictionary is held as flat parallel arrays (prefix/suffix/length) rather
 * than as arrays-of-arrays: an entry is emitted by walking its prefix chain
 * backwards into a scratch buffer, which keeps the whole decode allocation-free
 * per code and is what makes a big GIF decode quickly.
 */
export function lzwDecode(
  data: Uint8Array,
  minCodeSize: number,
  pixelCount: number,
): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const scratch = new Uint8Array(4096);

  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  let outPos = 0;

  while (outPos < pixelCount) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return out; // truncated stream — keep what we got
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    // A code at or past `next` is the KwKwK case: it can only mean "the
    // previous entry plus that entry's own first byte", because the encoder
    // emitted it in the same step that defined it.
    const deferred = code >= next;
    if (deferred && prev < 0) break; // malformed: deferred code before any literal
    const entry = deferred ? prev : code;

    // Walk the chain backwards into scratch, then emit it forwards.
    let n = 0;
    let c = entry;
    while (c >= 0 && n < 4096) {
      scratch[n++] = suffix[c];
      c = prefix[c];
    }
    const firstByte = scratch[n - 1];
    for (let i = n - 1; i >= 0 && outPos < pixelCount; i--) out[outPos++] = scratch[i];
    if (deferred && outPos < pixelCount) out[outPos++] = firstByte;

    // The new dictionary entry is always "previous entry + this one's first
    // byte"; there is none for the first code after a CLEAR.
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

/** GIF's interlaced row order: 8k, 8k+4, 4k+2, 2k+1. */
export function deinterlaceRows(height: number): number[] {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 8) rows.push(y);
  for (let y = 4; y < height; y += 8) rows.push(y);
  for (let y = 2; y < height; y += 4) rows.push(y);
  for (let y = 1; y < height; y += 2) rows.push(y);
  return rows;
}

/** Read a GIF sub-block chain (length-prefixed runs, terminated by a 0 byte). */
function readBlocks(b: Uint8Array, p: number): { data: Uint8Array; next: number } {
  let total = 0;
  let q = p;
  while (q < b.length && b[q] !== 0) {
    total += b[q];
    q += b[q] + 1;
  }
  const data = new Uint8Array(total);
  let w = 0;
  q = p;
  while (q < b.length && b[q] !== 0) {
    const n = b[q];
    data.set(b.subarray(q + 1, q + 1 + n), w);
    w += n;
    q += n + 1;
  }
  return { data, next: q + 1 };
}

/**
 * Decode every frame of a GIF, composed to full canvas size.
 *
 * Returns null when the bytes aren't a GIF at all; a truncated or partly
 * corrupt file yields whatever frames were readable, which is friendlier than
 * refusing the import outright.
 */
export function decodeGif(bytes: Uint8Array): GifImage | null {
  if (!isGif(bytes)) return null;
  const b = bytes;
  const u16 = (p: number) => b[p] | (b[p + 1] << 8);

  const width = u16(6);
  const height = u16(8);
  if (width <= 0 || height <= 0) return null;
  const flags = b[10];
  const globalTableSize = flags & 0x80 ? 2 << (flags & 7) : 0;
  const bgIndex = b[11];
  let p = 13;

  const readTable = (start: number, count: number): Uint8Array => {
    const t = new Uint8Array(count * 3);
    t.set(b.subarray(start, start + count * 3));
    return t;
  };
  const globalTable = globalTableSize ? readTable(p, globalTableSize) : null;
  p += globalTableSize * 3;

  const frames: GifFrame[] = [];
  let loops = 1;
  // Graphic Control Extension state — applies to the NEXT image descriptor.
  let delayMs = 0;
  let transparentIndex = -1;
  let disposal = 0;

  // The running canvas frames compose onto, plus the copy needed by disposal
  // method 3 ("restore to previous").
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previous: Uint8ClampedArray | null = null;
  void bgIndex; // background colour is display-time styling, not pixel data

  while (p < b.length) {
    const marker = b[p];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      // Extension block.
      const label = b[p + 1];
      if (label === 0xf9) {
        // Graphic Control Extension: 4 bytes of payload.
        const size = b[p + 2];
        const packed = b[p + 3];
        disposal = (packed >> 2) & 7;
        transparentIndex = packed & 1 ? b[p + 6] : -1;
        delayMs = u16(p + 4) * 10;
        p = p + 3 + size + 1; // payload + terminator
      } else if (label === 0xff) {
        // Application Extension: 0x21 0xFF <size> <app id> then sub-blocks.
        const { data, next } = readBlocks(b, p + 3 + b[p + 2]);
        // Netscape 2.0 loop count lives in the first sub-block: 01 LL LL.
        if (data.length >= 3 && data[0] === 1) loops = data[1] | (data[2] << 8);
        p = next;
      } else {
        p = readBlocks(b, p + 2).next;
      }
      continue;
    }
    if (marker !== 0x2c) {
      p++; // unknown byte — resync rather than abandon the file
      continue;
    }

    // Image Descriptor.
    const fx = u16(p + 1);
    const fy = u16(p + 3);
    const fw = u16(p + 5);
    const fh = u16(p + 7);
    const fflags = b[p + 9];
    p += 10;
    const localSize = fflags & 0x80 ? 2 << (fflags & 7) : 0;
    const table = localSize ? readTable(p, localSize) : globalTable;
    p += localSize * 3;
    const interlaced = !!(fflags & 0x40);

    const minCodeSize = b[p++];
    const { data, next } = readBlocks(b, p);
    p = next;
    if (!table || fw <= 0 || fh <= 0) continue;

    const indices = lzwDecode(data, minCodeSize, fw * fh);

    // Disposal 3 wants the canvas as it was BEFORE this frame drew.
    if (disposal === 3) previous = canvas.slice();

    const rows = interlaced ? deinterlaceRows(fh) : null;
    for (let row = 0; row < fh; row++) {
      // Interlaced rows arrive in 8/8/4/2 passes: decoded row `row` belongs at
      // destination row rows[row].
      const dstY = (rows ? rows[row] : row) + fy;
      if (dstY < 0 || dstY >= height) continue;
      for (let col = 0; col < fw; col++) {
        const dstX = col + fx;
        if (dstX < 0 || dstX >= width) continue;
        const idx = indices[row * fw + col];
        if (idx === transparentIndex) continue; // transparent: leave what's beneath
        const t = idx * 3;
        const o = (dstY * width + dstX) * 4;
        canvas[o] = table[t];
        canvas[o + 1] = table[t + 1];
        canvas[o + 2] = table[t + 2];
        canvas[o + 3] = 255;
      }
    }

    frames.push({
      rgba: canvas.slice(),
      delayMs: delayMs > 0 ? delayMs : 100, // 0 means "as fast as possible"; 100ms is the de-facto floor
      rect: { x: fx, y: fy, w: fw, h: fh },
      disposal,
    });

    // Apply the disposal for the NEXT frame.
    if (disposal === 2) {
      // Restore to background = clear this frame's rectangle to transparent.
      for (let row = 0; row < fh; row++) {
        const dstY = row + fy;
        if (dstY < 0 || dstY >= height) continue;
        for (let col = 0; col < fw; col++) {
          const dstX = col + fx;
          if (dstX < 0 || dstX >= width) continue;
          canvas.fill(0, (dstY * width + dstX) * 4, (dstY * width + dstX) * 4 + 4);
        }
      }
    } else if (disposal === 3 && previous) {
      canvas.set(previous);
    }
    // Reset the per-frame extension state.
    delayMs = 0;
    transparentIndex = -1;
    disposal = 0;
  }

  return frames.length ? { width, height, frames, loops } : null;
}
