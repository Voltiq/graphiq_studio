// Embedded ICC profile detection — dependency-free.
//
// Browsers already COLOUR-MANAGE tagged images on decode (the "convert to
// working space" behaviour, `colorSpaceConversion: "default"`). What they
// don't expose is the profile itself. This module reads the raw file bytes to
// find an embedded profile, extracts its display name from the 'desc'/'mluc'
// tag, and guesses which standard space it is — enough for the import dialog
// to offer the classic ASSIGN vs CONVERT choice ("assign" = re-decode with
// `colorSpaceConversion: "none"`, keeping the numbers and ignoring the tag).
//
// Containers handled: PNG (iCCP chunk, zlib-deflated), JPEG (APP2
// "ICC_PROFILE" segments, re-assembled by sequence number), WebP (RIFF ICCP
// chunk). Other formats (AVIF/HEIF boxes, TIFF/RAW) report no profile — the
// browser still converts them on decode as before.

export interface ICCInfo {
  /** Human-readable profile name from the 'desc' or 'mluc' tag (null if unreadable). */
  description: string | null;
  /** Which standard space the profile appears to be (by name heuristics). */
  looksLike: "srgb" | "display-p3" | "adobe-rgb" | "other";
  /** Raw profile bytes (kept for future use, e.g. export round-trip). */
  profile: Uint8Array;
}

const td = new TextDecoder();
const ascii = (b: Uint8Array, s: number, e: number) => td.decode(b.subarray(s, e));
const u32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

// ---- Container extraction ---------------------------------------------------

async function inflate(zlibBytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // "deflate" in the Compression Streams spec = the zlib format (RFC 1950),
    // which is exactly what PNG iCCP stores.
    const src = zlibBytes.slice(); // detached copy backed by a plain ArrayBuffer
    const stream = new Blob([src.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function fromPNG(b: Uint8Array): Promise<Uint8Array | null> {
  let o = 8; // past the signature
  while (o + 8 <= b.length) {
    const len = u32(b, o) >>> 0;
    const type = ascii(b, o + 4, o + 8);
    if (type === "iCCP") {
      const data = b.subarray(o + 8, o + 8 + len);
      const nul = data.indexOf(0);
      if (nul < 0 || data[nul + 1] !== 0) return null; // compression method must be 0 (deflate)
      return inflate(data.subarray(nul + 2));
    }
    if (type === "IDAT" || type === "IEND") return null; // profile chunks precede image data
    o += 12 + len; // len + type + data + crc
  }
  return null;
}

function fromJPEG(b: Uint8Array): Uint8Array | null {
  const parts: { seq: number; data: Uint8Array }[] = [];
  let o = 2; // past SOI
  while (o + 4 <= b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      o += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan — no more headers
    const size = (b[o + 2] << 8) | b[o + 3];
    if (marker === 0xe2 && size > 16 && ascii(b, o + 4, o + 15) === "ICC_PROFILE") {
      const seq = b[o + 16]; // 1-based chunk index (byte 17 is the chunk count)
      parts.push({ seq, data: b.subarray(o + 18, o + 2 + size) });
    }
    o += 2 + size;
  }
  if (!parts.length) return null;
  parts.sort((x, y) => x.seq - y.seq);
  const total = parts.reduce((s, p) => s + p.data.length, 0);
  const out = new Uint8Array(total);
  let w = 0;
  for (const p of parts) {
    out.set(p.data, w);
    w += p.data.length;
  }
  return out;
}

function fromWebP(b: Uint8Array): Uint8Array | null {
  // RIFF chunks: fourcc + little-endian size + data (padded to even).
  let o = 12; // "RIFF" size "WEBP"
  while (o + 8 <= b.length) {
    const four = ascii(b, o, o + 4);
    const size = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);
    if (four === "ICCP") return b.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size & 1);
  }
  return null;
}

// ---- Profile parsing ---------------------------------------------------------

/** The profile's display name: 'desc' (textDescriptionType, ASCII) or 'mluc'
 *  (multiLocalizedUnicodeType, UTF-16BE — v4 profiles). */
function readDescription(p: Uint8Array): string | null {
  if (p.length < 132) return null;
  const tagCount = u32(p, 128) >>> 0;
  if (tagCount > 1024) return null; // corrupt
  for (let t = 0; t < tagCount; t++) {
    const e = 132 + t * 12;
    if (e + 12 > p.length) return null;
    if (ascii(p, e, e + 4) !== "desc") continue;
    const off = u32(p, e + 4) >>> 0;
    const size = u32(p, e + 8) >>> 0;
    if (off + size > p.length || off + 12 > p.length) return null;
    const type = ascii(p, off, off + 4);
    if (type === "desc") {
      const count = u32(p, off + 8) >>> 0; // includes the trailing NUL
      if (count < 1 || off + 12 + count > p.length) return null;
      return ascii(p, off + 12, off + 12 + count - 1).replace(/\0+$/, "") || null;
    }
    if (type === "mluc") {
      const records = u32(p, off + 8) >>> 0;
      const recSize = u32(p, off + 12) >>> 0;
      if (!records || recSize < 12) return null;
      // Prefer an English record; fall back to the first.
      let rec = off + 16;
      for (let r = 0; r < records; r++) {
        const at = off + 16 + r * recSize;
        if (ascii(p, at, at + 2) === "en") {
          rec = at;
          break;
        }
      }
      const len = u32(p, rec + 4) >>> 0;
      const strOff = u32(p, rec + 8) >>> 0;
      if (off + strOff + len > p.length) return null;
      let s = "";
      for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode((p[off + strOff + i] << 8) | p[off + strOff + i + 1]);
      return s.replace(/\0+$/, "") || null;
    }
    return null;
  }
  return null;
}

function classify(desc: string | null): ICCInfo["looksLike"] {
  const d = (desc ?? "").toLowerCase();
  if (d.includes("srgb")) return "srgb";
  if (d.includes("display p3") || d.includes("display-p3") || /\bp3\b/.test(d)) return "display-p3";
  if (d.includes("adobe rgb")) return "adobe-rgb";
  return "other";
}

/** Find + parse an embedded ICC profile in an image file (null when absent or
 *  the container isn't one we sniff). Never throws. */
export async function extractICCProfile(file: File): Promise<ICCInfo | null> {
  try {
    const b = new Uint8Array(await file.arrayBuffer());
    let profile: Uint8Array | null = null;
    if (b.length > 16 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      profile = await fromPNG(b);
    } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      profile = fromJPEG(b);
    } else if (b.length > 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
      profile = fromWebP(b);
    }
    if (!profile || profile.length < 132) return null;
    const description = readDescription(profile);
    return { description, looksLike: classify(description), profile };
  } catch {
    return null;
  }
}
