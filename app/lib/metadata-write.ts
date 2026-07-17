// Metadata WRITER (TODO §9 "metadata round-trip") — the sibling of metadata.ts.
//
// Builds a little-endian EXIF/TIFF block + an XMP packet from the document's
// metadata and splices them into freshly-encoded exports: JPEG (APP1 segments,
// plus the JFIF density patched to the document's ppi), PNG (eXIf + iTXt +
// pHYs chunks) and WebP (VP8X flags + EXIF/'XMP ' RIFF chunks). AVIF has no
// hand-writable path here (ISO-BMFF box surgery) and passes through untouched.
//
// Dependency-free and DOM-free (Node-testable); metadata.ts's reader is the
// oracle — everything written here must parse back through it. Everything is
// best-effort: any failure returns the ORIGINAL encoded image unchanged, so
// embedding can never break an export.
//
// Character honesty: EXIF ASCII tags are written as UTF-8 bytes (what modern
// tools do in practice); the XMP packet carries the same values as proper
// Unicode XML, so non-ASCII names survive in the channel designed for them.

import { crc32 } from "./zip";

/** What the writer can embed — a plain subset of ImageMetadata (raw numeric
 *  twins, not the display-formatted strings) plus the document's ppi. */
export interface ExportMetadata {
  description?: string;
  artist?: string;
  copyright?: string;
  software?: string;
  make?: string;
  model?: string;
  lensModel?: string;
  dateTakenRaw?: string; // EXIF "YYYY:MM:DD HH:MM:SS"
  exposureTime?: number; // seconds
  fNumberValue?: number;
  iso?: number;
  focalLengthMm?: number;
  focalLength35Mm?: number;
  gps?: { lat: number; lon: number };
  /** Document resolution — written as EXIF X/YResolution, the JFIF density
   *  and PNG pHYs, so exports open at true size elsewhere. */
  dpi?: number;
}

/** Anything beyond software/dpi to say? (drives the dialog's summary/default). */
export function hasExportableMetadata(m: ExportMetadata): boolean {
  return !!(
    m.description ||
    m.artist ||
    m.copyright ||
    m.make ||
    m.model ||
    m.lensModel ||
    m.dateTakenRaw ||
    m.exposureTime ||
    m.fNumberValue ||
    m.iso ||
    m.focalLengthMm ||
    m.focalLength35Mm ||
    m.gps
  );
}

// ---------------------------------------------------------------------------
// EXIF / TIFF builder (little-endian, IFD0 → Exif IFD → GPS IFD)
// ---------------------------------------------------------------------------

interface Entry {
  tag: number;
  type: number; // 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 7 UNDEFINED
  count: number;
  value: Uint8Array; // raw value bytes (unpadded)
}

const enc = new TextEncoder();

const asciiEntry = (tag: number, s: string): Entry => {
  const bytes = enc.encode(s);
  const value = new Uint8Array(bytes.length + 1); // NUL-terminated
  value.set(bytes);
  return { tag, type: 2, count: value.length, value };
};
const shortEntry = (tag: number, v: number): Entry => {
  const value = new Uint8Array(2);
  new DataView(value.buffer).setUint16(0, v & 0xffff, true);
  return { tag, type: 3, count: 1, value };
};
const longEntry = (tag: number, v: number): Entry => {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setUint32(0, v >>> 0, true);
  return { tag, type: 4, count: 1, value };
};
const rationalEntry = (tag: number, pairs: [number, number][]): Entry => {
  const value = new Uint8Array(pairs.length * 8);
  const dv = new DataView(value.buffer);
  pairs.forEach(([n, d], i) => {
    dv.setUint32(i * 8, n >>> 0, true);
    dv.setUint32(i * 8 + 4, d >>> 0, true);
  });
  return { tag, type: 5, count: pairs.length, value };
};
const bytesEntry = (tag: number, type: 1 | 7, bytes: number[]): Entry => ({
  tag,
  type,
  count: bytes.length,
  value: new Uint8Array(bytes),
});

/** Seconds → EXIF rational: 1/250 s stays (1, 250); ≥1 s keeps ms precision. */
const exposureRational = (t: number): [number, number] =>
  t < 1 ? [1, Math.max(1, Math.round(1 / t))] : [Math.round(t * 1000), 1000];

/** Decimal degrees → EXIF (deg, min, sec×10⁴) rationals, carry-safe. */
function gpsRationals(v: number): [number, number][] {
  const abs = Math.abs(v);
  let d = Math.floor(abs);
  let m = Math.floor((abs - d) * 60);
  let secNum = Math.round(((abs - d) * 60 - m) * 60 * 10000);
  if (secNum >= 600000) {
    secNum -= 600000;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return [
    [d, 1],
    [m, 1],
    [secNum, 10000],
  ];
}

const IFD_TABLE = (n: number) => 2 + n * 12 + 4; // count + entries + next-IFD
const valuesSize = (entries: Entry[]) =>
  entries.reduce((s, e) => s + (e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);

/** Write one IFD (entries ascending by tag, as the spec requires) with its
 *  value area at `valuesOff`. Offsets are TIFF-relative == buffer-relative. */
function writeIfd(u8: Uint8Array, dv: DataView, tableOff: number, valuesOff: number, entries: Entry[]) {
  entries.sort((a, b) => a.tag - b.tag);
  dv.setUint16(tableOff, entries.length, true);
  let vo = valuesOff;
  entries.forEach((e, i) => {
    const o = tableOff + 2 + i * 12;
    dv.setUint16(o, e.tag, true);
    dv.setUint16(o + 2, e.type, true);
    dv.setUint32(o + 4, e.count, true);
    if (e.value.length <= 4) {
      u8.set(e.value, o + 8); // inline, left-justified (rest stays zero)
    } else {
      dv.setUint32(o + 8, vo, true);
      u8.set(e.value, vo);
      vo += e.value.length + (e.value.length & 1); // keep values word-aligned
    }
  });
  dv.setUint32(tableOff + 2 + entries.length * 12, 0, true); // no next IFD
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Now, in EXIF date format. */
export function exifNow(d = new Date()): string {
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Build the complete EXIF payload (a bare little-endian TIFF; metadata.ts
 *  parses it directly, and it slots verbatim into every container below). */
export function buildExifTiff(m: ExportMetadata, now = new Date()): Uint8Array {
  const ifd0: Entry[] = [];
  if (m.description) ifd0.push(asciiEntry(0x010e, m.description));
  if (m.make) ifd0.push(asciiEntry(0x010f, m.make));
  if (m.model) ifd0.push(asciiEntry(0x0110, m.model));
  ifd0.push(shortEntry(0x0112, 1)); // orientation: pixels are always upright here
  if (m.dpi && m.dpi > 0) {
    const dpi = Math.round(m.dpi);
    ifd0.push(rationalEntry(0x011a, [[dpi, 1]])); // XResolution
    ifd0.push(rationalEntry(0x011b, [[dpi, 1]])); // YResolution
    ifd0.push(shortEntry(0x0128, 2)); // ResolutionUnit: inches
  }
  ifd0.push(asciiEntry(0x0131, m.software || "Graphiq Studio"));
  ifd0.push(asciiEntry(0x0132, exifNow(now))); // DateTime (modified)
  if (m.artist) ifd0.push(asciiEntry(0x013b, m.artist));
  if (m.copyright) ifd0.push(asciiEntry(0x8298, m.copyright));

  const exif: Entry[] = [bytesEntry(0x9000, 7, [0x30, 0x32, 0x33, 0x32])]; // ExifVersion "0232"
  if (m.exposureTime && m.exposureTime > 0)
    exif.push(rationalEntry(0x829a, [exposureRational(m.exposureTime)]));
  if (m.fNumberValue && m.fNumberValue > 0)
    exif.push(rationalEntry(0x829d, [[Math.round(m.fNumberValue * 100), 100]]));
  if (m.iso && m.iso > 0) exif.push(shortEntry(0x8827, Math.min(65535, Math.round(m.iso))));
  if (m.dateTakenRaw) exif.push(asciiEntry(0x9003, m.dateTakenRaw));
  if (m.focalLengthMm && m.focalLengthMm > 0)
    exif.push(rationalEntry(0x920a, [[Math.round(m.focalLengthMm * 100), 100]]));
  if (m.focalLength35Mm && m.focalLength35Mm > 0)
    exif.push(shortEntry(0xa405, Math.min(65535, Math.round(m.focalLength35Mm))));
  if (m.lensModel) exif.push(asciiEntry(0xa434, m.lensModel));

  const gps: Entry[] = [];
  if (m.gps) {
    gps.push(bytesEntry(0x0000, 1, [2, 3, 0, 0])); // GPSVersionID
    gps.push(asciiEntry(0x0001, m.gps.lat < 0 ? "S" : "N"));
    gps.push(rationalEntry(0x0002, gpsRationals(m.gps.lat)));
    gps.push(asciiEntry(0x0003, m.gps.lon < 0 ? "W" : "E"));
    gps.push(rationalEntry(0x0004, gpsRationals(m.gps.lon)));
  }

  // IFD0 carries the pointers to the sub-IFDs — placeholder values now, real
  // offsets once the layout is known (adding them first keeps sizes correct).
  const exifPtr = longEntry(0x8769, 0);
  ifd0.push(exifPtr);
  const gpsPtr = m.gps ? longEntry(0x8825, 0) : null;
  if (gpsPtr) ifd0.push(gpsPtr);

  // Layout: header, then each IFD's table immediately followed by its values.
  const ifd0Table = 8;
  const ifd0Values = ifd0Table + IFD_TABLE(ifd0.length);
  const exifTable = ifd0Values + valuesSize(ifd0);
  const exifValues = exifTable + IFD_TABLE(exif.length);
  const gpsTable = exifValues + valuesSize(exif);
  const gpsValues = gpsTable + (gps.length ? IFD_TABLE(gps.length) : 0);
  const total = gpsValues + valuesSize(gps);

  new DataView(exifPtr.value.buffer).setUint32(0, exifTable, true);
  if (gpsPtr) new DataView(gpsPtr.value.buffer).setUint32(0, gpsTable, true);

  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  dv.setUint16(0, 0x4949, false); // "II" little-endian
  dv.setUint16(2, 0x002a, true);
  dv.setUint32(4, ifd0Table, true);
  writeIfd(u8, dv, ifd0Table, ifd0Values, ifd0);
  writeIfd(u8, dv, exifTable, exifValues, exif);
  if (gps.length) writeIfd(u8, dv, gpsTable, gpsValues, gps);
  return u8;
}

// ---------------------------------------------------------------------------
// XMP packet (the Unicode-safe channel for the same descriptive fields)
// ---------------------------------------------------------------------------

const xmlEscape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

/** Minimal, Photoshop-compatible XMP packet. */
export function buildXmp(m: ExportMetadata, now = new Date()): string {
  const alt = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(v)}</rdf:li></rdf:Alt>`;
  const parts: string[] = [
    `<xmp:CreatorTool>${xmlEscape(m.software || "Graphiq Studio")}</xmp:CreatorTool>`,
    `<xmp:ModifyDate>${now.toISOString()}</xmp:ModifyDate>`,
  ];
  if (m.description) parts.push(`<dc:description>${alt(m.description)}</dc:description>`);
  if (m.artist)
    parts.push(`<dc:creator><rdf:Seq><rdf:li>${xmlEscape(m.artist)}</rdf:li></rdf:Seq></dc:creator>`);
  if (m.copyright) parts.push(`<dc:rights>${alt(m.copyright)}</dc:rights>`);
  return (
    // \uFEFF = the BOM the xpacket header carries by spec (kept as an escape —
    // an invisible literal char in source is exactly how files get corrupted).
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
    parts.join("") +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

// ---------------------------------------------------------------------------
// Container splicers
// ---------------------------------------------------------------------------

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** JPEG: insert APP1-EXIF + APP1-XMP after SOI (after JFIF's APP0 when
 *  present, as convention wants) and patch the JFIF density to `dpi`. */
export function embedJpeg(bytes: Uint8Array, exif: Uint8Array, xmp: string, dpi?: number): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  const out = bytes.slice(); // patched copy (JFIF density edit below)
  let insertAt = 2;
  // APP0/JFIF directly after SOI: keep it first, patch its density.
  if (out[2] === 0xff && out[3] === 0xe0) {
    const len = (out[4] << 8) | out[5];
    const isJfif =
      out[6] === 0x4a && out[7] === 0x46 && out[8] === 0x49 && out[9] === 0x46 && out[10] === 0;
    if (isJfif && dpi && dpi > 0 && len >= 14) {
      const d = Math.min(65535, Math.round(dpi));
      out[13] = 1; // units: dots per inch
      out[14] = (d >> 8) & 0xff;
      out[15] = d & 0xff;
      out[16] = (d >> 8) & 0xff;
      out[17] = d & 0xff;
    }
    insertAt = 2 + 2 + len; // SOI + marker bytes + declared segment length
  }
  const app1 = (header: Uint8Array, payload: Uint8Array): Uint8Array => {
    const body = concat([header, payload]);
    if (body.length + 2 > 0xffff) throw new Error("APP1 payload too large");
    const seg = new Uint8Array(4 + body.length);
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg[2] = ((body.length + 2) >> 8) & 0xff;
    seg[3] = (body.length + 2) & 0xff;
    seg.set(body, 4);
    return seg;
  };
  const exifSeg = app1(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), exif); // "Exif\0\0"
  const xmpSeg = app1(enc.encode("http://ns.adobe.com/xap/1.0/\0"), enc.encode(xmp));
  return concat([out.subarray(0, insertAt), exifSeg, xmpSeg, out.subarray(insertAt)]);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0, false);
  return out;
};

/** PNG: insert eXIf + iTXt(XMP) + pHYs right after IHDR. */
export function embedPng(bytes: Uint8Array, exif: Uint8Array, xmp: string, dpi?: number): Uint8Array {
  if (bytes.length < 24 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = dv.getUint32(8, false);
  const insertAt = 8 + 8 + ihdrLen + 4; // sig + IHDR header + data + crc
  // Does a pHYs already exist? (canvas encodes don't add one, but stay safe)
  let hasPhys = false;
  for (let o = insertAt; o + 8 <= bytes.length; ) {
    const len = dv.getUint32(o, false);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (type === "pHYs") hasPhys = true;
    if (type === "IDAT" || type === "IEND") break;
    o += 12 + len;
  }
  const inserts: Uint8Array[] = [pngChunk("eXIf", exif)];
  // iTXt: keyword \0 compressionFlag(0) compressionMethod(0) lang \0 translated \0 text
  const xmpBytes = enc.encode(xmp);
  const keyword = enc.encode("XML:com.adobe.xmp");
  const itxt = new Uint8Array(keyword.length + 5 + xmpBytes.length);
  itxt.set(keyword, 0);
  itxt.set(xmpBytes, keyword.length + 5);
  inserts.push(pngChunk("iTXt", itxt));
  if (dpi && dpi > 0 && !hasPhys) {
    const ppm = Math.round(dpi / 0.0254); // pixels per metre
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    pv.setUint32(0, ppm, false);
    pv.setUint32(4, ppm, false);
    phys[8] = 1; // unit: metre
    inserts.push(pngChunk("pHYs", phys));
  }
  return concat([bytes.subarray(0, insertAt), ...inserts, bytes.subarray(insertAt)]);
}

const fourcc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

const riffChunk = (type: string, data: Uint8Array): Uint8Array => {
  const padded = data.length + (data.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(fourcc(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
};

/** WebP: ensure a VP8X header with the EXIF/XMP flags set, then append EXIF
 *  and 'XMP ' chunks. `w`/`h` are the encoded pixel dimensions (needed when a
 *  simple VP8/VP8L file has no VP8X yet). */
export function embedWebp(bytes: Uint8Array, exif: Uint8Array, xmp: string, w: number, h: number): Uint8Array {
  if (
    bytes.length < 16 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "RIFF" ||
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== "WEBP"
  )
    throw new Error("not a WebP");
  const hasVp8x = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === "VP8X";
  let head: Uint8Array;
  let rest: Uint8Array;
  if (hasVp8x) {
    head = bytes.slice(0, 12 + 8 + 10); // RIFF header + VP8X chunk (10-byte payload)
    head[12 + 8] |= 0x08 | 0x04; // flags: EXIF + XMP
    rest = bytes.subarray(12 + 8 + 10);
  } else {
    if (w < 1 || h < 1 || w > 16384 || h > 16384) throw new Error("bad dimensions");
    const payload = new Uint8Array(10);
    payload[0] = 0x08 | 0x04; // EXIF + XMP present
    const wm = w - 1;
    const hm = h - 1;
    payload[4] = wm & 0xff;
    payload[5] = (wm >> 8) & 0xff;
    payload[6] = (wm >> 16) & 0xff;
    payload[7] = hm & 0xff;
    payload[8] = (hm >> 8) & 0xff;
    payload[9] = (hm >> 16) & 0xff;
    head = concat([bytes.subarray(0, 12), riffChunk("VP8X", payload)]);
    rest = bytes.subarray(12);
  }
  const out = concat([head, rest, riffChunk("EXIF", exif), riffChunk("XMP ", enc.encode(xmp))]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true); // RIFF size
  return out;
}

/** Embed metadata into an encoded export. Returns the original blob for
 *  formats without a writer (AVIF) or on ANY error — never breaks an export.
 *  `pxW`/`pxH` are the encoded pixel dimensions (WebP needs them for VP8X). */
export async function embedMetadata(
  blob: Blob,
  formatId: string,
  m: ExportMetadata,
  pxW: number,
  pxH: number,
): Promise<Blob> {
  try {
    if (formatId !== "jpeg" && formatId !== "png" && formatId !== "webp") return blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const exif = buildExifTiff(m);
    const xmp = buildXmp(m);
    let out: Uint8Array;
    if (formatId === "jpeg") out = embedJpeg(bytes, exif, xmp, m.dpi);
    else if (formatId === "png") out = embedPng(bytes, exif, xmp, m.dpi);
    else out = embedWebp(bytes, exif, xmp, pxW, pxH);
    return new Blob([out as Uint8Array<ArrayBuffer>], { type: blob.type });
  } catch {
    return blob;
  }
}
