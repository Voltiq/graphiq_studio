/**
 * Lightweight image-metadata reader. Pulls file-level facts plus EXIF (camera,
 * lens, capture date, exposure, GPS, …) out of JPEG/TIFF files with a minimal,
 * dependency-free TIFF/IFD parser. Never throws — returns whatever it can.
 */

export interface ImageMetadata {
  fileName: string;
  fileSize: number; // bytes
  fileType: string; // mime
  lastModified: number; // ms epoch
  // --- EXIF (all optional; present only when found) ---
  make?: string;
  model?: string;
  lensModel?: string;
  dateTaken?: string; // formatted DateTimeOriginal
  exposure?: string; // e.g. "1/250 s"
  fNumber?: string; // e.g. "f/2.8"
  iso?: number;
  focalLength?: string; // e.g. "50 mm"
  focalLength35?: string; // 35mm-equivalent, e.g. "75 mm"
  orientation?: number;
  software?: string;
  artist?: string;
  copyright?: string;
  dpi?: number; // from XResolution when given in inches
  gps?: { lat: number; lon: number };
}

// EXIF field-type → byte size.
const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

// Bounds-checked DataView reads (return 0 past the end instead of throwing).
class Safe {
  constructor(readonly v: DataView) {}
  u8(o: number) {
    return o >= 0 && o < this.v.byteLength ? this.v.getUint8(o) : 0;
  }
  u16(o: number, le: boolean) {
    return o >= 0 && o + 2 <= this.v.byteLength ? this.v.getUint16(o, le) : 0;
  }
  u32(o: number, le: boolean) {
    return o >= 0 && o + 4 <= this.v.byteLength ? this.v.getUint32(o, le) : 0;
  }
}

interface IfdEntry {
  type: number;
  count: number;
  valOff: number; // offset of the 4-byte value/pointer field
}

/** Locate the TIFF header, returning its absolute byte offset (or -1). */
function locateTiff(s: Safe): number {
  const len = s.v.byteLength;
  // Bare TIFF (II*\0 little-endian or MM\0* big-endian).
  const bo = s.u16(0, false);
  if (
    (bo === 0x4949 && s.u16(2, true) === 0x2a) ||
    (bo === 0x4d4d && s.u16(2, false) === 0x2a)
  ) {
    return 0;
  }
  // JPEG: walk the marker segments looking for an "Exif\0\0" APP1.
  if (s.u16(0, false) !== 0xffd8) return -1;
  let off = 2;
  while (off + 4 <= len) {
    if (s.u8(off) !== 0xff) {
      off++; // resync past padding
      continue;
    }
    let marker = s.u8(off + 1);
    while (marker === 0xff && off + 2 < len) {
      off++;
      marker = s.u8(off + 1);
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    if (marker >= 0xd0 && marker <= 0xd7) {
      off += 2; // standalone restart marker
      continue;
    }
    const size = s.u16(off + 2, false);
    if (size < 2) break;
    if (
      marker === 0xe1 &&
      s.u32(off + 4, false) === 0x45786966 && // "Exif"
      s.u16(off + 8, false) === 0x0000
    ) {
      return off + 10; // TIFF data begins right after "Exif\0\0"
    }
    off += 2 + size;
  }
  return -1;
}

/** Read all entries of one IFD into a tag→entry map. */
function readIfd(s: Safe, tiff: number, ifd: number, le: boolean): Map<number, IfdEntry> {
  const map = new Map<number, IfdEntry>();
  const base = tiff + ifd;
  if (base + 2 > s.v.byteLength) return map;
  const n = s.u16(base, le);
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > s.v.byteLength) break;
    map.set(s.u16(e, le), {
      type: s.u16(e + 2, le),
      count: s.u32(e + 4, le),
      valOff: e + 8,
    });
  }
  return map;
}

/** Absolute offset of an entry's data (inline when ≤4 bytes, else a pointer). */
function dataOff(s: Safe, tiff: number, e: IfdEntry, le: boolean): number {
  const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
  return size <= 4 ? e.valOff : tiff + s.u32(e.valOff, le);
}

function readAscii(s: Safe, tiff: number, e: IfdEntry, le: boolean): string {
  const o = dataOff(s, tiff, e, le);
  let str = "";
  for (let i = 0; i < e.count; i++) {
    const c = s.u8(o + i);
    if (c === 0) break;
    str += String.fromCharCode(c);
  }
  return str.trim();
}

function readUint(s: Safe, tiff: number, e: IfdEntry, le: boolean): number {
  const o = dataOff(s, tiff, e, le);
  return e.type === 3 ? s.u16(o, le) : s.u32(o, le);
}

function readRational(s: Safe, tiff: number, e: IfdEntry, le: boolean, i = 0): number {
  const o = dataOff(s, tiff, e, le) + i * 8;
  const num = s.u32(o, le);
  const den = s.u32(o + 4, le);
  return den ? num / den : 0;
}

// "YYYY:MM:DD HH:MM:SS" → a readable, locale-formatted string.
function formatExifDate(raw: string): string | undefined {
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return raw || undefined;
  const [, y, mo, d, h, mi, sec] = m;
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +(sec ?? "0"));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatExposure(t: number): string | undefined {
  if (!t || t <= 0) return undefined;
  return t < 1 ? `1/${Math.round(1 / t)} s` : `${Number(t.toFixed(1))} s`;
}

function gpsCoord(s: Safe, tiff: number, e: IfdEntry | undefined, ref: string, le: boolean) {
  if (!e || e.count < 3) return undefined;
  const deg = readRational(s, tiff, e, le, 0);
  const min = readRational(s, tiff, e, le, 1);
  const sec = readRational(s, tiff, e, le, 2);
  const val = deg + min / 60 + sec / 3600;
  return ref === "S" || ref === "W" ? -val : val;
}

/** Parse the EXIF block (if any) starting at the TIFF header. */
function parseExif(s: Safe, meta: ImageMetadata) {
  const tiff = locateTiff(s);
  if (tiff < 0) return;
  const le = s.u16(tiff, false) === 0x4949;
  const ifd0 = readIfd(s, tiff, s.u32(tiff + 4, le), le);

  const ascii = (m: Map<number, IfdEntry>, tag: number) => {
    const e = m.get(tag);
    const v = e ? readAscii(s, tiff, e, le) : "";
    return v || undefined;
  };

  meta.make = ascii(ifd0, 0x010f);
  meta.model = ascii(ifd0, 0x0110);
  meta.software = ascii(ifd0, 0x0131);
  meta.artist = ascii(ifd0, 0x013b);
  meta.copyright = ascii(ifd0, 0x8298);
  const orient = ifd0.get(0x0112);
  if (orient) meta.orientation = readUint(s, tiff, orient, le);
  // DPI: XResolution, but only meaningful when ResolutionUnit is inches (2).
  const resUnit = ifd0.get(0x0128);
  const xres = ifd0.get(0x011a);
  if (xres && (!resUnit || readUint(s, tiff, resUnit, le) === 2)) {
    const dpi = Math.round(readRational(s, tiff, xres, le));
    if (dpi > 0) meta.dpi = dpi;
  }

  // Exif sub-IFD: the bulk of the shooting data.
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const exif = readIfd(s, tiff, readUint(s, tiff, exifPtr, le), le);
    meta.lensModel = ascii(exif, 0xa434);
    meta.dateTaken =
      formatExifDate(ascii(exif, 0x9003) ?? "") ?? formatExifDate(ascii(exif, 0x9004) ?? "");
    const expo = exif.get(0x829a);
    if (expo) meta.exposure = formatExposure(readRational(s, tiff, expo, le));
    const fnum = exif.get(0x829d);
    if (fnum) {
      const f = readRational(s, tiff, fnum, le);
      if (f > 0) meta.fNumber = `f/${Number(f.toFixed(1))}`;
    }
    const iso = exif.get(0x8827);
    if (iso) {
      const v = readUint(s, tiff, iso, le);
      if (v > 0) meta.iso = v;
    }
    const fl = exif.get(0x920a);
    if (fl) {
      const v = readRational(s, tiff, fl, le);
      if (v > 0) meta.focalLength = `${Math.round(v)} mm`;
    }
    const fl35 = exif.get(0xa405);
    if (fl35) {
      const v = readUint(s, tiff, fl35, le);
      if (v > 0) meta.focalLength35 = `${v} mm`;
    }
  }

  // GPS sub-IFD.
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const gps = readIfd(s, tiff, readUint(s, tiff, gpsPtr, le), le);
    const latRef = ascii(gps, 0x0001) ?? "N";
    const lonRef = ascii(gps, 0x0003) ?? "E";
    const lat = gpsCoord(s, tiff, gps.get(0x0002), latRef, le);
    const lon = gpsCoord(s, tiff, gps.get(0x0004), lonRef, le);
    if (lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0)) {
      meta.gps = { lat, lon };
    }
  }
}

/**
 * Read metadata from an image file. Always resolves with at least the file-level
 * facts; EXIF fields are filled in when present (JPEG/TIFF). Only the first
 * 256 KB are scanned — enough to hold any JPEG's EXIF (APP1 ≤ 64 KB).
 */
export async function extractMetadata(file: File): Promise<ImageMetadata> {
  const meta: ImageMetadata = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    lastModified: file.lastModified,
  };
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    parseExif(new Safe(new DataView(head)), meta);
  } catch {
    /* leave the file-level facts only */
  }
  return meta;
}

/** Human-readable byte size, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${i === 0 ? val : Number(val.toFixed(val < 10 ? 1 : 0))} ${units[i]}`;
}
