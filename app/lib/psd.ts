// Hand-written PSD interchange (TODO §9) — no dependencies, pure typed-array
// code (Node-testable; the writer's output round-trips through the reader).
//
// READ subset: PSD v1 (not PSB), 8-bit RGB or Grayscale; layers, nested groups
// ('lsct' section dividers), user layer masks, opacity / blend / clipping /
// visibility, unicode names, RAW + RLE (PackBits) channel data. Text and smart
// objects arrive as their rasterized pixels (Photoshop stores those in the
// layer channels). Adjustment/fill layers are skipped with a note. Files
// outside the subset (16/32-bit, CMYK, PSB…) fall back to the flattened
// composite when it's readable — a single-layer import rather than a failure.
//
// WRITE: PSD v1, 8-bit RGB; the full tree (groups as section dividers), layer
// masks, opacity / blend / clipping / hidden flags, pascal + unicode names,
// RLE-compressed channels, a resolution resource carrying the document ppi,
// and the required flattened composite (RGB over white) so every reader —
// including ones that ignore layers — shows the document.

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** RGBA pixels (structurally compatible with ImageData). */
export interface PsdImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface PsdLayer {
  kind: "layer";
  name: string;
  visible: boolean;
  opacity: number; // 0..100
  blend: string; // app blend name
  clipped: boolean;
  /** Doc-anchored RGBA (null = no pixels — e.g. an empty layer). */
  image: PsdImage | null;
  /** Doc-sized grayscale (R=G=B=value, A=255); null = no mask. */
  mask: PsdImage | null;
  maskEnabled: boolean;
}

export interface PsdGroup {
  kind: "group";
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  children: PsdNode[]; // top-first (app order)
  mask: PsdImage | null;
  maskEnabled: boolean;
}

export type PsdNode = PsdLayer | PsdGroup;

export interface PsdDocument {
  width: number;
  height: number;
  dpi: number | null;
  /** Top-first, like the app's layer arrays. */
  nodes: PsdNode[];
  /** Human-readable notes about anything that didn't survive the subset. */
  notes: string[];
}

/** PSD blend key ↔ app blend name. */
const BLEND_FROM_PSD: Record<string, string> = {
  norm: "Normal",
  diss: "Dissolve",
  dark: "Darken",
  "mul ": "Multiply",
  idiv: "Color Burn",
  lbrn: "Linear Burn",
  lite: "Lighten",
  scrn: "Screen",
  "div ": "Color Dodge",
  lddg: "Add",
  over: "Overlay",
  sLit: "Soft Light",
  hLit: "Hard Light",
  diff: "Difference",
  smud: "Exclusion",
  "hue ": "Hue",
  "sat ": "Saturation",
  colr: "Color",
  "lum ": "Luminosity",
};
const BLEND_TO_PSD: Record<string, string> = Object.fromEntries(
  Object.entries(BLEND_FROM_PSD).map(([k, v]) => [v, k]),
);
/** Group "pass-through" reads as Normal (the app's groups composite isolated)
 *  without tripping the unknown-blend note; never written back out. */
const blendFromPsd = (key: string): string | undefined =>
  key === "pass" ? "Normal" : BLEND_FROM_PSD[key];

/** Additional-info keys that mark adjustment / fill layers (no raster). */
const ADJUSTMENT_KEYS = new Set([
  "SoCo", "GdFl", "PtFl", "brit", "levl", "curv", "expA", "vibA",
  "hue ", "hue2", "blnc", "blwh", "phfl", "mixr", "clrL", "nvrt",
  "post", "thrs", "grdm", "selc",
]);

// ---------------------------------------------------------------------------
// PackBits (RLE) — used by both directions, exported for tests
// ---------------------------------------------------------------------------

/** Decode PackBits into dst[dstPos..dstPos+dstLen); returns the new src pos. */
export function packBitsDecode(
  src: Uint8Array,
  srcPos: number,
  dst: Uint8Array,
  dstPos: number,
  dstLen: number,
): number {
  const end = dstPos + dstLen;
  while (dstPos < end && srcPos < src.length) {
    const n = src[srcPos++];
    if (n < 128) {
      // literal run of n+1 bytes
      const count = Math.min(n + 1, end - dstPos);
      dst.set(src.subarray(srcPos, srcPos + count), dstPos);
      srcPos += n + 1;
      dstPos += count;
    } else if (n > 128) {
      // repeat run of 257-n copies
      const count = Math.min(257 - n, end - dstPos);
      const v = src[srcPos++];
      dst.fill(v, dstPos, dstPos + count);
      dstPos += count;
    } // n === 128: no-op
  }
  return srcPos;
}

/** Encode one row with PackBits (repeats ≥3 become runs). */
export function packBitsEncode(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    // Measure the repeat run at i.
    let run = 1;
    while (i + run < n && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3 || (run >= 2 && i + run >= n)) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    // Literal run: until the next ≥3 repeat (or 128 bytes).
    const start = i;
    i += run;
    while (i < n && i - start < 128) {
      let r = 1;
      while (i + r < n && r < 3 && row[i + r] === row[i]) r++;
      if (r >= 3) break;
      i += r;
      if (i - start > 128) {
        i = start + 128;
        break;
      }
    }
    const len = Math.min(i - start, 128);
    out.push(len - 1);
    for (let k = 0; k < len; k++) out.push(row[start + k]);
    i = start + len;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  v: DataView;
  b: Uint8Array;
  pos = 0;
  constructor(buf: ArrayBuffer) {
    this.v = new DataView(buf);
    this.b = new Uint8Array(buf);
  }
  u8() {
    return this.v.getUint8(this.pos++);
  }
  u16() {
    const x = this.v.getUint16(this.pos);
    this.pos += 2;
    return x;
  }
  i16() {
    const x = this.v.getInt16(this.pos);
    this.pos += 2;
    return x;
  }
  u32() {
    const x = this.v.getUint32(this.pos);
    this.pos += 4;
    return x;
  }
  i32() {
    const x = this.v.getInt32(this.pos);
    this.pos += 4;
    return x;
  }
  ascii(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.pos + i]);
    this.pos += n;
    return s;
  }
  /** Pascal string padded to a multiple of `pad`. */
  pascal(pad: number): string {
    const len = this.u8();
    const s = this.ascii(len);
    const total = len + 1;
    const rem = total % pad;
    if (rem) this.pos += pad - rem;
    return s;
  }
  unicode(): string {
    const n = this.u32();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s.replace(/\0+$/, "");
  }
}

interface RawChannel {
  id: number;
  length: number;
}
interface RawRecord {
  rect: { t: number; l: number; b: number; r: number };
  channels: RawChannel[];
  blendKey: string;
  opacity: number;
  clipping: number;
  flags: number;
  name: string;
  uniName: string | null;
  section: number; // lsct type: 0 none, 1/2 folder, 3 hidden divider
  sectionBlend: string | null;
  isAdjustment: boolean;
  mask: { t: number; l: number; b: number; r: number; defaultColor: number; disabled: boolean } | null;
  /** Decoded planes by channel id (8-bit, rect-sized; mask plane under -2). */
  planes: Map<number, Uint8Array>;
  unsupported: boolean; // a needed channel used an unsupported compression
}

/** Decode one channel's image data (positioned at its start) into a plane. */
function readPlane(r: Reader, byteLen: number, w: number, h: number): Uint8Array | null {
  const end = r.pos + byteLen;
  const compression = r.u16();
  const size = w * h;
  const out = new Uint8Array(size);
  if (size === 0) {
    r.pos = end;
    return out;
  }
  if (compression === 0) {
    if (r.pos + size > end + 0) {
      r.pos = end;
      return null;
    }
    out.set(r.b.subarray(r.pos, r.pos + size));
    r.pos = end;
    return out;
  }
  if (compression === 1) {
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(r.u16());
    let dst = 0;
    for (let y = 0; y < h; y++) {
      packBitsDecode(r.b, r.pos, out, dst, w);
      r.pos += counts[y];
      dst += w;
    }
    r.pos = end;
    return out;
  }
  r.pos = end; // ZIP (2/3) or 16-bit payloads — outside the subset
  return null;
}

/** Assemble a record's RGBA image (doc-anchored) from its planes. */
function composeImage(
  rec: RawRecord,
  docW: number,
  docH: number,
  gray: boolean,
): PsdImage | null {
  const { t, l, b, r } = rec.rect;
  const w = r - l;
  const h = b - t;
  if (w <= 0 || h <= 0) return null;
  const R = rec.planes.get(0);
  const G = gray ? R : rec.planes.get(1);
  const B = gray ? R : rec.planes.get(2);
  const A = rec.planes.get(-1);
  if (!R || !G || !B) return null;
  const img = new Uint8ClampedArray(docW * docH * 4); // transparent outside the rect
  for (let y = 0; y < h; y++) {
    const dy = t + y;
    if (dy < 0 || dy >= docH) continue;
    for (let x = 0; x < w; x++) {
      const dx = l + x;
      if (dx < 0 || dx >= docW) continue;
      const s = y * w + x;
      const d = (dy * docW + dx) * 4;
      img[d] = R[s];
      img[d + 1] = G[s];
      img[d + 2] = B[s];
      img[d + 3] = A ? A[s] : 255;
    }
  }
  return { width: docW, height: docH, data: img };
}

/** Doc-sized grayscale mask from the -2 plane + default colour. */
function composeMask(rec: RawRecord, docW: number, docH: number): PsdImage | null {
  const m = rec.mask;
  const plane = rec.planes.get(-2);
  if (!m) return null;
  const img = new Uint8ClampedArray(docW * docH * 4);
  const def = m.defaultColor;
  for (let i = 0; i < img.length; i += 4) {
    img[i] = img[i + 1] = img[i + 2] = def;
    img[i + 3] = 255;
  }
  if (plane) {
    const w = m.r - m.l;
    const h = m.b - m.t;
    for (let y = 0; y < h; y++) {
      const dy = m.t + y;
      if (dy < 0 || dy >= docH) continue;
      for (let x = 0; x < w; x++) {
        const dx = m.l + x;
        if (dx < 0 || dx >= docW) continue;
        const v = plane[y * w + x];
        const d = (dy * docW + dx) * 4;
        img[d] = img[d + 1] = img[d + 2] = v;
      }
    }
  }
  return { width: docW, height: docH, data: img };
}

/** Parse a PSD file. Null = not a readable PSD at all. */
export function parsePSD(buf: ArrayBuffer): PsdDocument | null {
  try {
    return parsePSDUnsafe(buf);
  } catch {
    return null;
  }
}

/** The throwing parser — parsePSD's guts, exported for tests/diagnostics. */
export function parsePSDUnsafe(buf: ArrayBuffer): PsdDocument | null {
  const r = new Reader(buf);
  if (buf.byteLength < 26 + 4 * 4) return null;
  if (r.ascii(4) !== "8BPS") return null;
  const version = r.u16();
  r.pos += 6;
  const notes: string[] = [];
  if (version !== 1) return null; // PSB (v2) is outside the subset
  r.u16(); // channel count (composite)
  const docH = r.u32();
  const docW = r.u32();
  const depth = r.u16();
  const mode = r.u16(); // 1 gray, 3 RGB
  if (docW < 1 || docH < 1 || docW > 30000 || docH > 30000) return null;
  const gray = mode === 1;
  const supportedMode = (mode === 3 || mode === 1) && depth === 8;

  // Colour mode data. (NOTE: never `r.pos += r.u32()` — the compound
  // assignment reads the OLD pos before u32() advances it, clobbering the
  // read's own 4-byte step.)
  const cmLen = r.u32();
  r.pos += cmLen;

  // Image resources → resolution (0x03ED).
  let dpi: number | null = null;
  const resLen = r.u32();
  const resEnd = r.pos + resLen;
  while (r.pos < resEnd - 4) {
    if (r.ascii(4) !== "8BIM") break;
    const id = r.u16();
    r.pascal(2);
    const len = r.u32();
    const next = r.pos + len + (len % 2);
    if (id === 0x03ed && len >= 4) dpi = Math.round(r.u32() / 0x10000);
    r.pos = next;
  }
  r.pos = resEnd;

  if (!supportedMode) {
    notes.push(
      `${depth}-bit / mode ${mode} files are outside the layer subset — imported flattened.`,
    );
    return compositeFallback(r, buf, docW, docH, mode, depth, dpi, notes);
  }

  // Layer & mask information.
  const lmiLen = r.u32();
  const lmiEnd = r.pos + lmiLen;
  let records: RawRecord[] = [];
  if (lmiLen >= 6) {
    const layerInfoLen = r.u32();
    const layerInfoEnd = r.pos + layerInfoLen;
    if (layerInfoLen >= 2) {
      const rawCount = r.i16();
      const count = Math.abs(rawCount);
      for (let i = 0; i < count; i++) records.push(readRecord(r));
      // Channel image data follows, in record order.
      for (const rec of records) {
        for (const ch of rec.channels) {
          const isMask = ch.id === -2;
          const rw = isMask && rec.mask ? rec.mask.r - rec.mask.l : rec.rect.r - rec.rect.l;
          const rh = isMask && rec.mask ? rec.mask.b - rec.mask.t : rec.rect.b - rec.rect.t;
          const plane = readPlane(r, ch.length, Math.max(0, rw), Math.max(0, rh));
          if (plane) rec.planes.set(ch.id, plane);
          else if (ch.id >= -1) rec.unsupported = true;
        }
      }
    }
    r.pos = layerInfoEnd;
  }
  r.pos = lmiEnd;

  if (!records.length) {
    notes.push("No layer data — imported the flattened composite.");
    return compositeFallback(r, buf, docW, docH, mode, depth, dpi, notes);
  }

  // Build the tree (records are bottom→top; app arrays are top-first).
  let sawText = false;
  let skippedAdjustments = 0;
  let unknownBlend = false;
  const rootChildren: PsdNode[] = [];
  const stack: PsdNode[][] = [rootChildren];
  const pendingGroups: PsdNode[][] = [];
  for (const rec of records) {
    let blend = blendFromPsd(rec.blendKey);
    if (!blend) {
      unknownBlend = true;
      blend = "Normal";
    }
    const common = {
      name: rec.uniName ?? rec.name ?? "Layer",
      visible: (rec.flags & 2) === 0,
      opacity: Math.round((rec.opacity / 255) * 100),
      blend,
    };
    if (rec.section === 3) {
      // Hidden divider = the BOTTOM of a group; children follow.
      const children: PsdNode[] = [];
      pendingGroups.push(children);
      stack.push(children);
      continue;
    }
    if (rec.section === 1 || rec.section === 2) {
      // Folder record = the TOP of the group; carries its props.
      stack.pop();
      const children = pendingGroups.pop() ?? [];
      children.reverse(); // bottom→top collected → top-first
      const g: PsdGroup = {
        kind: "group",
        ...common,
        blend: rec.sectionBlend ?? common.blend,
        children,
        mask: composeMask(rec, docW, docH),
        maskEnabled: !rec.mask?.disabled,
      };
      stack[stack.length - 1].push(g);
      continue;
    }
    if (rec.isAdjustment) {
      skippedAdjustments++;
      continue;
    }
    if (rec.unsupported) {
      notes.push(`"${common.name}": channel data outside the subset — layer imported empty.`);
    }
    const node: PsdLayer = {
      kind: "layer",
      ...common,
      clipped: rec.clipping === 1,
      image: rec.unsupported ? null : composeImage(rec, docW, docH, gray),
      mask: composeMask(rec, docW, docH),
      maskEnabled: !rec.mask?.disabled,
    };
    if (rec.hasText) sawText = true;
    stack[stack.length - 1].push(node);
  }
  rootChildren.reverse();
  if (sawText) notes.push("Text layers imported as raster pixels (not editable text).");
  if (skippedAdjustments)
    notes.push(`${skippedAdjustments} adjustment/fill layer${skippedAdjustments === 1 ? "" : "s"} skipped.`);
  if (unknownBlend) notes.push("Some blend modes had no equivalent and became Normal.");
  return { width: docW, height: docH, dpi, nodes: rootChildren, notes };
}

// readRecord needs to report text presence; extend the interface via a field.
interface RawRecord {
  hasText?: boolean;
}

function readRecord(r: Reader): RawRecord {
  const t = r.i32();
  const l = r.i32();
  const b = r.i32();
  const rr = r.i32();
  const chCount = r.u16();
  const channels: RawChannel[] = [];
  for (let i = 0; i < chCount; i++) channels.push({ id: r.i16(), length: r.u32() });
  r.ascii(4); // '8BIM'
  const blendKey = r.ascii(4);
  const opacity = r.u8();
  const clipping = r.u8();
  const flags = r.u8();
  r.u8(); // filler
  const extraLen = r.u32();
  const extraEnd = r.pos + extraLen;

  // Layer mask / adjustment data.
  let mask: RawRecord["mask"] = null;
  const maskLen = r.u32();
  if (maskLen >= 20) {
    const maskEnd = r.pos + maskLen;
    const mt = r.i32();
    const ml = r.i32();
    const mb = r.i32();
    const mr = r.i32();
    const def = r.u8();
    const mflags = r.u8();
    mask = { t: mt, l: ml, b: mb, r: mr, defaultColor: def, disabled: (mflags & 2) !== 0 };
    r.pos = maskEnd;
  } else {
    r.pos += maskLen;
  }
  // Blending ranges (same compound-assignment trap as the colour-mode skip).
  const brLen = r.u32();
  r.pos += brLen;
  // Pascal name (padded to 4 within the record).
  const name = r.pascal(4);

  // Additional info blocks.
  let uniName: string | null = null;
  let section = 0;
  let sectionBlend: string | null = null;
  let isAdjustment = false;
  let hasText = false;
  while (r.pos < extraEnd - 8) {
    const sig = r.ascii(4);
    if (sig !== "8BIM" && sig !== "8B64") break;
    const key = r.ascii(4);
    const len = r.u32();
    const next = r.pos + len + (len % 2);
    if (key === "luni") uniName = r.unicode();
    else if (key === "lsct") {
      section = r.u32();
      if (len >= 12) {
        r.ascii(4);
        sectionBlend = blendFromPsd(r.ascii(4)) ?? null;
      }
    } else if (key === "TySh" || key === "tySh") hasText = true;
    else if (ADJUSTMENT_KEYS.has(key)) isAdjustment = true;
    r.pos = next;
  }
  r.pos = extraEnd;
  return {
    rect: { t, l, b, r: rr },
    channels,
    blendKey,
    opacity,
    clipping,
    flags,
    name,
    uniName,
    section,
    sectionBlend,
    isAdjustment,
    hasText,
    mask,
    planes: new Map(),
    unsupported: false,
  };
}

/** Read the flattened composite (Image Data section) as one layer. */
function compositeFallback(
  r: Reader,
  buf: ArrayBuffer,
  w: number,
  h: number,
  mode: number,
  depth: number,
  dpi: number | null,
  notes: string[],
): PsdDocument | null {
  if (depth !== 8 || (mode !== 3 && mode !== 1)) return null; // can't rescue
  // Skip the layer & mask info section if the caller hasn't already.
  // (Callers position us right AFTER image resources or after LMI; detect by
  // trying to read the section length sanely.)
  if (r.pos + 4 > buf.byteLength) return null;
  // Peek: if the next u32 could be an LMI length that fits, skip it.
  const maybeLen = r.v.getUint32(r.pos);
  if (r.pos + 4 + maybeLen + 2 <= buf.byteLength) {
    // Heuristic: an LMI section is followed by the u16 compression of the
    // image data; accept the skip when that compression looks valid (0..3).
    const comp = r.v.getUint16(r.pos + 4 + maybeLen);
    if (comp <= 3) r.pos += 4 + maybeLen;
  }
  if (r.pos + 2 > buf.byteLength) return null;
  const compression = r.u16();
  const size = w * h;
  const chans = mode === 1 ? 1 : 3;
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < chans; c++) {
      if (r.pos + size > buf.byteLength) return null;
      planes.push(r.b.subarray(r.pos, r.pos + size) as Uint8Array);
      r.pos += size;
    }
  } else if (compression === 1) {
    const counts: number[] = [];
    for (let i = 0; i < chans * h; i++) counts.push(r.u16());
    for (let c = 0; c < chans; c++) {
      const plane = new Uint8Array(size);
      for (let y = 0; y < h; y++) {
        packBitsDecode(r.b, r.pos, plane, y * w, w);
        r.pos += counts[c * h + y];
      }
      planes.push(plane);
    }
  } else {
    return null;
  }
  const img = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    img[i * 4] = planes[0][i];
    img[i * 4 + 1] = planes[chans === 1 ? 0 : 1][i];
    img[i * 4 + 2] = planes[chans === 1 ? 0 : 2][i];
    img[i * 4 + 3] = 255;
  }
  return {
    width: w,
    height: h,
    dpi,
    nodes: [
      {
        kind: "layer",
        name: "Background",
        visible: true,
        opacity: 100,
        blend: "Normal",
        clipped: false,
        image: { width: w, height: h, data: img },
        mask: null,
        maskEnabled: true,
      },
    ],
    notes,
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface PsdOutLayer {
  kind: "layer";
  name: string;
  visible: boolean;
  opacity: number; // 0..100
  blend: string;
  clipped: boolean;
  image: PsdImage | null; // doc-sized RGBA
  mask: PsdImage | null; // doc-sized grayscale
  maskEnabled: boolean;
}
export interface PsdOutGroup {
  kind: "group";
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  children: PsdOutNode[]; // top-first
  mask: PsdImage | null;
  maskEnabled: boolean;
}
export type PsdOutNode = PsdOutLayer | PsdOutGroup;

class Writer {
  chunks: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }
  scalar(bytes: number, write: (v: DataView) => void) {
    const a = new Uint8Array(bytes);
    write(new DataView(a.buffer));
    this.push(a);
  }
  u8(v: number) {
    this.scalar(1, (d) => d.setUint8(0, v));
  }
  u16(v: number) {
    this.scalar(2, (d) => d.setUint16(0, v));
  }
  u32(v: number) {
    this.scalar(4, (d) => d.setUint32(0, v));
  }
  i32(v: number) {
    this.scalar(4, (d) => d.setInt32(0, v));
  }
  ascii(s: string) {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    this.push(a);
  }
  /** Pascal string padded to a multiple of `pad`. */
  pascal(s: string, pad: number) {
    const trimmed = s.slice(0, 31);
    this.u8(trimmed.length);
    this.ascii(trimmed);
    const total = trimmed.length + 1;
    const rem = total % pad;
    if (rem) this.push(new Uint8Array(pad - rem));
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

/** Extract one channel plane from doc-sized RGBA (offset 0=R,1=G,2=B,3=A). */
function planeOf(img: PsdImage, offset: number): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = img.data[i * 4 + offset];
  return out;
}

/** RLE-compress a plane: per-row byte counts table + packed rows. */
function rleChannel(plane: Uint8Array, w: number, h: number): { counts: Uint8Array; data: Uint8Array } {
  const counts = new Uint8Array(h * 2);
  const cv = new DataView(counts.buffer);
  const rows: Uint8Array[] = [];
  let total = 0;
  for (let y = 0; y < h; y++) {
    const packed = packBitsEncode(plane.subarray(y * w, (y + 1) * w));
    rows.push(packed);
    cv.setUint16(y * 2, packed.length);
    total += packed.length;
  }
  const data = new Uint8Array(total);
  let p = 0;
  for (const row of rows) {
    data.set(row, p);
    p += row.length;
  }
  return { counts, data };
}

/** One layer record + its channel image data. */
function writeRecord(
  rec: Writer,
  chan: Writer,
  docW: number,
  docH: number,
  opts: {
    name: string;
    visible: boolean;
    opacity: number;
    blend: string;
    clipping: boolean;
    section: number; // 0 layer, 1 folder, 3 divider
    image: PsdImage | null;
    mask: PsdImage | null;
    maskEnabled: boolean;
  },
) {
  const hasPixels = !!opts.image;
  const w = hasPixels ? docW : 0;
  const h = hasPixels ? docH : 0;
  rec.i32(0);
  rec.i32(0);
  rec.i32(h);
  rec.i32(w);
  // Channels: RGBA (+ mask), each payload = compression u16 + RLE table + rows.
  // An empty rect ⇒ just the 2-byte compression marker.
  const payloads: { id: number; bytes: Uint8Array }[] = [];
  const channelPayload = (plane: Uint8Array, pw: number, ph: number): Uint8Array => {
    const { counts, data } = rleChannel(plane, pw, ph);
    const out = new Uint8Array(2 + counts.length + data.length);
    new DataView(out.buffer).setUint16(0, 1); // RLE
    out.set(counts, 2);
    out.set(data, 2 + counts.length);
    return out;
  };
  for (const id of [0, 1, 2, -1]) {
    payloads.push({
      id,
      bytes: hasPixels
        ? channelPayload(planeOf(opts.image!, id === -1 ? 3 : id), w, h)
        : new Uint8Array(2), // compression 0, no data
    });
  }
  if (opts.mask) payloads.push({ id: -2, bytes: channelPayload(planeOf(opts.mask, 0), docW, docH) });
  rec.u16(payloads.length);
  for (const c of payloads) {
    rec.scalar(2, (d) => d.setInt16(0, c.id));
    rec.u32(c.bytes.length);
  }
  rec.ascii("8BIM");
  rec.ascii(BLEND_TO_PSD[opts.blend] ?? "norm");
  rec.u8(Math.round((Math.max(0, Math.min(100, opts.opacity)) / 100) * 255));
  rec.u8(opts.clipping ? 1 : 0);
  rec.u8(opts.visible ? 0 : 2);
  rec.u8(0);

  // Extra data: mask block, blending ranges (empty), pascal name, additional info.
  const extra = new Writer();
  if (opts.mask) {
    extra.u32(20);
    extra.i32(0);
    extra.i32(0);
    extra.i32(docH);
    extra.i32(docW);
    extra.u8(255);
    extra.u8(opts.maskEnabled ? 0 : 2);
    extra.u16(0);
  } else {
    extra.u32(0);
  }
  extra.u32(0); // blending ranges
  extra.pascal(opts.name, 4);
  // 'luni' unicode name (data padded to a multiple of 2 — always even here).
  const uni = new Writer();
  uni.u32(opts.name.length);
  for (let i = 0; i < opts.name.length; i++) uni.u16(opts.name.charCodeAt(i));
  const uniBytes = uni.bytes();
  extra.ascii("8BIM");
  extra.ascii("luni");
  extra.u32(uniBytes.length);
  extra.push(uniBytes);
  if (opts.section) {
    extra.ascii("8BIM");
    extra.ascii("lsct");
    extra.u32(12);
    extra.u32(opts.section);
    extra.ascii("8BIM");
    extra.ascii(BLEND_TO_PSD[opts.blend] ?? "norm");
  }
  const extraBytes = extra.bytes();
  rec.u32(extraBytes.length);
  rec.push(extraBytes);

  // Channel image data (same order as the id list above).
  for (const c of payloads) chan.push(c.bytes);
}

/**
 * Build a PSD file: the tree (top-first, as the app stores it), plus the
 * flattened composite for the Image Data section (matted over white — every
 * PSD reader shows it, layered or not).
 */
export function buildPSD(
  docW: number,
  docH: number,
  dpi: number,
  nodes: PsdOutNode[],
  composite: PsdImage,
): ArrayBuffer {
  const rec = new Writer();
  const chan = new Writer();
  let count = 0;

  // Records are bottom→top: walk the top-first tree in reverse. A group is
  // [hidden divider] … children … [folder record].
  const emit = (list: PsdOutNode[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (n.kind === "group") {
        writeRecord(rec, chan, docW, docH, {
          name: "</Layer group>",
          visible: true,
          opacity: 100,
          blend: "Normal",
          clipping: false,
          section: 3,
          image: null,
          mask: null,
          maskEnabled: true,
        });
        count++;
        emit(n.children);
        writeRecord(rec, chan, docW, docH, {
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
          clipping: false,
          section: 1,
          image: null,
          mask: n.mask,
          maskEnabled: n.maskEnabled,
        });
        count++;
      } else {
        writeRecord(rec, chan, docW, docH, {
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
          clipping: n.clipped,
          section: 0,
          image: n.image,
          mask: n.mask,
          maskEnabled: n.maskEnabled,
        });
        count++;
      }
    }
  };
  emit(nodes);

  const out = new Writer();
  out.ascii("8BPS");
  out.u16(1);
  out.push(new Uint8Array(6));
  out.u16(3); // composite channels (RGB)
  out.u32(docH);
  out.u32(docW);
  out.u16(8); // depth
  out.u16(3); // RGB
  out.u32(0); // colour mode data

  // Image resources: resolution (0x03ED).
  const res = new Writer();
  res.ascii("8BIM");
  res.u16(0x03ed);
  res.u16(0); // empty pascal name (even)
  res.u32(16);
  res.u32(Math.round(dpi * 0x10000));
  res.u16(1); // ppi
  res.u16(1); // inches
  res.u32(Math.round(dpi * 0x10000));
  res.u16(1);
  res.u16(1);
  const resBytes = res.bytes();
  out.u32(resBytes.length);
  out.push(resBytes);

  // Layer & mask info.
  const recBytes = rec.bytes();
  const chanBytes = chan.bytes();
  let layerInfoLen = 2 + recBytes.length + chanBytes.length;
  const layerInfoPad = layerInfoLen % 2;
  layerInfoLen += layerInfoPad;
  out.u32(4 + layerInfoLen + 4); // section = layer info + empty global mask
  out.u32(layerInfoLen);
  out.scalar(2, (d) => d.setInt16(0, count));
  out.push(recBytes);
  out.push(chanBytes);
  if (layerInfoPad) out.push(new Uint8Array(1));
  out.u32(0); // global layer mask info (empty)

  // Flattened composite (RGB over white), RLE, planar.
  out.u16(1);
  const n = docW * docH;
  const planes: Uint8Array[] = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) {
    const a = composite.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++)
      planes[c][i] = Math.round(composite.data[i * 4 + c] * a + 255 * (1 - a));
  }
  const rles = planes.map((p) => rleChannel(p, docW, docH));
  for (const rle of rles) out.push(rle.counts);
  for (const rle of rles) out.push(rle.data);

  const bytes = out.bytes();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
