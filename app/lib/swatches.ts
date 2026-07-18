// Shared, persisted colour swatches — v2 (TODO §13 Swatches v2).
//
// The model is GROUPS of colours ({version:2, groups:[{id,name,colors}]} under
// the same key; a legacy flat string[] migrates into one "My swatches" group).
// The Swatches panel manages groups; every ColorPicker keeps using the flat
// helpers below, which read/write the FIRST group — "your quick swatches".
//
// Import/export: the app's own .gco/.gse are hand-written binary codecs of the
// Adobe ACO / ASE swatch formats (so .aco/.ase files work too — same bytes,
// different extension): big-endian, UTF-16BE names; ASE carries GROUPS and is
// the round-trip format, ACO flattens. Plus JSON (v1 flat / v2 groups), GIMP
// .gpl and loose-#hex text (all tolerant). Palette extraction is a median-cut
// over the composited pixels. All pure — Node-verifiable.

import { parseColor, toHex8 } from "./color";

const KEY = "graphiq:swatches";
const LEGACY_KEY = "aperture:swatches"; // pre-rebrand key, read once as a fallback

export interface SwatchGroup {
  id: string;
  name: string;
  colors: string[];
}

let seq = 0;
export function freshGroupId(): string {
  return `sw-${Date.now().toString(36)}-${(seq += 1)}`;
}

const DEFAULT_NAME = "My swatches";

/* ------------------------------ load / persist ----------------------------- */

function coerceGroups(raw: unknown): SwatchGroup[] | null {
  // Legacy flat list → one default group.
  if (Array.isArray(raw)) {
    const colors = raw.filter((c): c is string => typeof c === "string");
    return [{ id: "default", name: DEFAULT_NAME, colors }];
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { groups?: unknown }).groups)) {
    const out: SwatchGroup[] = [];
    for (const g of (raw as { groups: unknown[] }).groups) {
      if (!g || typeof g !== "object") continue;
      const o = g as Partial<SwatchGroup>;
      if (typeof o.name !== "string" || !Array.isArray(o.colors)) continue;
      out.push({
        id: typeof o.id === "string" ? o.id : freshGroupId(),
        name: o.name,
        colors: o.colors.filter((c): c is string => typeof c === "string"),
      });
    }
    return out;
  }
  return null;
}

function load(): SwatchGroup[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    return coerceGroups(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

type GroupsListener = (groups: SwatchGroup[]) => void;
type FlatListener = (swatches: string[]) => void;
const groupListeners = new Set<GroupsListener>();
const flatListeners = new Set<FlatListener>();
let cache: SwatchGroup[] | null = null;

export function getGroups(): SwatchGroup[] {
  if (!cache) cache = load();
  return cache;
}

export function setGroups(groups: SwatchGroup[]): void {
  cache = groups;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: 2, groups }));
  } catch {
    /* ignore (private mode / quota) */
  }
  groupListeners.forEach((l) => l(groups));
  const flat = groups[0]?.colors ?? [];
  flatListeners.forEach((l) => l(flat));
}

export function subscribeGroups(l: GroupsListener): () => void {
  groupListeners.add(l);
  return () => {
    groupListeners.delete(l);
  };
}

/** Ensure a first (default) group exists before writing into it. */
function withDefault(groups: SwatchGroup[]): SwatchGroup[] {
  return groups.length ? groups : [{ id: "default", name: DEFAULT_NAME, colors: [] }];
}

/* --------------------- Flat compat API (ColorPicker strip) ------------------ */

/** The FIRST group's colours — what every ColorPicker shows. */
export function getSwatches(): string[] {
  return getGroups()[0]?.colors ?? [];
}

export function setSwatches(list: string[]): void {
  const groups = withDefault([...getGroups()]);
  groups[0] = { ...groups[0], colors: list };
  setGroups(groups);
}

/** Subscribe to changes so all open pickers stay in sync. Returns an unsubscribe. */
export function subscribeSwatches(l: FlatListener): () => void {
  flatListeners.add(l);
  return () => {
    flatListeners.delete(l);
  };
}

/** Add a colour to the end of the default group (ignoring exact duplicates). */
export function addSwatch(color: string): void {
  const list = getSwatches();
  const c = color.toLowerCase();
  if (list.some((x) => x.toLowerCase() === c)) return;
  setSwatches([...list, color]);
}

export function removeSwatchAt(index: number): void {
  const list = getSwatches();
  if (index < 0 || index >= list.length) return;
  setSwatches(list.filter((_, i) => i !== index));
}

/* ------------------------------ Import / export ----------------------------- */

/** Serialize a flat list to the portable v1 `.json` palette body. */
export function swatchesToFileJSON(colors: string[]): string {
  return JSON.stringify({ type: "graphiq-swatches", version: 1, colors }, null, 2);
}

/** Serialize the whole group set to the v2 `.json` palette body. */
export function groupsToFileJSON(groups: SwatchGroup[]): string {
  return JSON.stringify(
    {
      type: "graphiq-swatches",
      version: 2,
      groups: groups.map((g) => ({ name: g.name, colors: g.colors })),
    },
    null,
    2,
  );
}

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function normalize(c: string): string | null {
  try {
    return toHex8(parseColor(c));
  } catch {
    return null;
  }
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of list) {
    const k = c.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * Parse colours from an imported TEXT palette. Accepts our JSON (v1 or a bare
 * array), GIMP `.gpl` palettes, and any file with loose `#hex` colours.
 * (v2 group JSON is handled by parseSwatchImport, which callers should prefer.)
 */
export function parseSwatchFile(text: string): string[] {
  const trimmed = text.trim();
  const out: string[] = [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(data)
        ? data
        : Array.isArray((data as { colors?: unknown })?.colors)
          ? (data as { colors: unknown[] }).colors
          : null;
      if (arr) {
        for (const c of arr) {
          const n = typeof c === "string" ? normalize(c) : null;
          if (n) out.push(n);
        }
        return dedupe(out);
      }
    } catch {
      /* not JSON — fall through to text parsing */
    }
  }

  if (/GIMP Palette/i.test(trimmed)) {
    for (const line of trimmed.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) out.push(toHex8({ r: +m[1], g: +m[2], b: +m[3], a: 1 }));
    }
    if (out.length) return dedupe(out);
  }

  for (const h of trimmed.match(HEX_RE) ?? []) {
    const n = normalize(h);
    if (n) out.push(n);
  }
  return dedupe(out);
}

/* ------------------------- .gco (ACO) binary codec -------------------------- */

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  try {
    const c = parseColor(hex);
    return { r: c.r, g: c.g, b: c.b };
  } catch {
    return null;
  }
};

/** Encode as Adobe ACO (v1 + v2 blocks, RGB, names = hex). Groups flatten —
 *  the ACO format has no folders; use .gse to keep them. */
export function encodeACO(groups: SwatchGroup[]): Uint8Array<ArrayBuffer> {
  const entries = groups
    .flatMap((g) => g.colors.map((hex) => ({ hex, rgb: hexToRgb(hex) })))
    .filter((e): e is { hex: string; rgb: { r: number; g: number; b: number } } => e.rgb !== null);
  const colors = entries.map((e) => e.rgb);
  const hexes = entries.map((e) => e.hex);
  // v1: 4 + n*10 bytes; v2 adds per-colour names.
  let size = 4 + colors.length * 10 + 4;
  for (const h of hexes) size += 10 + 4 + (h.length + 1) * 2;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const writeColor = (c: { r: number; g: number; b: number }) => {
    dv.setUint16(o, 0); // colour space 0 = RGB
    dv.setUint16(o + 2, c.r * 257);
    dv.setUint16(o + 4, c.g * 257);
    dv.setUint16(o + 6, c.b * 257);
    dv.setUint16(o + 8, 0);
    o += 10;
  };
  dv.setUint16(o, 1); // version 1
  dv.setUint16(o + 2, colors.length);
  o += 4;
  for (const c of colors) writeColor(c);
  dv.setUint16(o, 2); // version 2 block
  dv.setUint16(o + 2, colors.length);
  o += 4;
  colors.forEach((c, i) => {
    writeColor(c);
    const name = hexes[i].toUpperCase();
    dv.setUint32(o, name.length + 1); // UTF-16 units incl. the terminator
    o += 4;
    for (let k = 0; k < name.length; k++) {
      dv.setUint16(o, name.charCodeAt(k));
      o += 2;
    }
    dv.setUint16(o, 0);
    o += 2;
  });
  return out as Uint8Array<ArrayBuffer>;
}

/** Decode an ACO buffer (v1 or v2; RGB entries; others skipped). Null = not ACO. */
export function decodeACO(buf: Uint8Array): string[] | null {
  if (buf.length < 4) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  let colors: string[] = [];
  while (o + 4 <= buf.length) {
    const version = dv.getUint16(o);
    const count = dv.getUint16(o + 2);
    if (version !== 1 && version !== 2) return colors.length ? colors : null;
    o += 4;
    const block: string[] = [];
    for (let i = 0; i < count; i++) {
      if (o + 10 > buf.length) return null;
      const space = dv.getUint16(o);
      const w = dv.getUint16(o + 2);
      const x = dv.getUint16(o + 4);
      const y = dv.getUint16(o + 6);
      o += 10;
      if (space === 0) block.push(toHex8({ r: w >> 8, g: x >> 8, b: y >> 8, a: 1 }));
      if (version === 2) {
        if (o + 4 > buf.length) return null;
        const len = dv.getUint32(o);
        o += 4 + len * 2; // skip the UTF-16 name (incl. terminator)
        if (o > buf.length) return null;
      }
    }
    // Prefer the v2 block when both exist (same colours, but be tolerant).
    if (block.length) colors = block;
  }
  return colors.length ? dedupe(colors) : null;
}

/* ------------------------- .gse (ASE) binary codec -------------------------- */

/** Encode as Adobe ASE — groups become real ASE folders (names = hex). */
export function encodeASE(groups: SwatchGroup[]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const utf16 = (s: string): Uint8Array => {
    const b = new Uint8Array((s.length + 1) * 2 + 2);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, s.length + 1);
    for (let i = 0; i < s.length; i++) dv.setUint16(2 + i * 2, s.charCodeAt(i));
    return b; // trailing null already zero
  };
  const block = (type: number, payload: Uint8Array): Uint8Array => {
    const b = new Uint8Array(6 + payload.length);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, type);
    dv.setUint32(2, payload.length);
    b.set(payload, 6);
    return b;
  };
  let blockCount = 0;
  for (const g of groups) {
    chunks.push(block(0xc001, utf16(g.name)));
    blockCount++;
    for (const hex of g.colors) {
      const c = hexToRgb(hex);
      if (!c) continue;
      const name = utf16(hex.toUpperCase());
      const payload = new Uint8Array(name.length + 4 + 12 + 2);
      const dv = new DataView(payload.buffer);
      payload.set(name, 0);
      let o = name.length;
      payload.set([0x52, 0x47, 0x42, 0x20], o); // "RGB "
      o += 4;
      dv.setFloat32(o, c.r / 255);
      dv.setFloat32(o + 4, c.g / 255);
      dv.setFloat32(o + 8, c.b / 255);
      o += 12;
      dv.setUint16(o, 2); // colour type: normal
      chunks.push(block(0x0001, payload));
      blockCount++;
    }
    chunks.push(block(0xc002, new Uint8Array(0)));
    blockCount++;
  }
  const total = 12 + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x41, 0x53, 0x45, 0x46], 0); // "ASEF"
  dv.setUint32(4, 0x00010000); // version 1.0
  dv.setUint32(8, blockCount);
  let o = 12;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out as Uint8Array<ArrayBuffer>;
}

/** Decode an ASE buffer into groups (ungrouped colours land in "Imported"). */
export function decodeASE(buf: Uint8Array): SwatchGroup[] | null {
  if (buf.length < 12) return null;
  if (buf[0] !== 0x41 || buf[1] !== 0x53 || buf[2] !== 0x45 || buf[3] !== 0x46) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const groups: SwatchGroup[] = [];
  let current: SwatchGroup | null = null;
  let loose: string[] = [];
  let o = 12;
  while (o + 6 <= buf.length) {
    const type = dv.getUint16(o);
    const len = dv.getUint32(o + 2);
    const at = o + 6;
    o = at + len;
    if (o > buf.length + 4) break; // tolerate a slightly short final block
    if (type === 0xc001) {
      const nameLen = dv.getUint16(at);
      let name = "";
      for (let i = 0; i < nameLen - 1; i++) name += String.fromCharCode(dv.getUint16(at + 2 + i * 2));
      current = { id: freshGroupId(), name: name || "Group", colors: [] };
      groups.push(current);
    } else if (type === 0xc002) {
      current = null;
    } else if (type === 0x0001) {
      const nameLen = dv.getUint16(at);
      let p = at + 2 + nameLen * 2;
      if (p + 4 > buf.length) continue;
      const space = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      p += 4;
      let hex: string | null = null;
      if (space === "RGB " && p + 12 <= buf.length) {
        const r = Math.round(dv.getFloat32(p) * 255);
        const g = Math.round(dv.getFloat32(p + 4) * 255);
        const b = Math.round(dv.getFloat32(p + 8) * 255);
        hex = toHex8({ r: clamp255(r), g: clamp255(g), b: clamp255(b), a: 1 });
      } else if (space === "Gray" && p + 4 <= buf.length) {
        const v = clamp255(Math.round(dv.getFloat32(p) * 255));
        hex = toHex8({ r: v, g: v, b: v, a: 1 });
      }
      if (hex) (current ? current.colors : loose).push(hex);
    }
  }
  if (loose.length) groups.push({ id: freshGroupId(), name: "Imported", colors: dedupe(loose) });
  for (const g of groups) g.colors = dedupe(g.colors);
  const any = groups.some((g) => g.colors.length);
  return any ? groups.filter((g) => g.colors.length) : null;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/* ------------------------------ Unified import ------------------------------ */

/**
 * Parse ANY supported palette file into groups: binary ASE/.gse (keeps
 * folders), binary ACO/.gco, our JSON v2 (groups) / v1 / bare arrays, GIMP
 * .gpl, or loose #hex text. Empty array = nothing usable.
 */
export function parseSwatchImport(buffer: ArrayBuffer, fallbackName = "Imported"): SwatchGroup[] {
  const bytes = new Uint8Array(buffer);
  const ase = decodeASE(bytes);
  if (ase) return ase;
  const aco = decodeACO(bytes);
  if (aco?.length) return [{ id: freshGroupId(), name: fallbackName, colors: aco }];
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return [];
  }
  // JSON v2 with groups?
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = coerceGroups(JSON.parse(trimmed));
      if (parsed?.some((g) => g.colors.length)) {
        return parsed
          .map((g) => ({ ...g, id: freshGroupId(), colors: dedupe(g.colors.map(normalize).filter((c): c is string => !!c)) }))
          .filter((g) => g.colors.length);
      }
    } catch {
      /* fall through */
    }
  }
  const flat = parseSwatchFile(text);
  return flat.length ? [{ id: freshGroupId(), name: fallbackName, colors: flat }] : [];
}

/* --------------------------- Palette extraction ----------------------------- */

/**
 * Median-cut palette extraction over RGBA bytes (callers downsample first).
 * Transparent pixels (a < 128) are ignored; boxes split on their widest
 * channel at the median; each box averages to one colour.
 */
export function extractPalette(rgba: Uint8ClampedArray | Uint8Array, count = 8): string[] {
  const px: number[] = []; // packed 0xRRGGBB of opaque pixels
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    px.push((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  if (!px.length) return [];
  let boxes: number[][] = [px];
  while (boxes.length < count) {
    // Split the box scoring highest on range × population (pure widest-range
    // selection degenerates when several boxes tie at full range — big mixed
    // boxes must win so minority colours separate before the budget runs out).
    let bi = -1;
    let bc = 0;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        const sh = 16 - ch * 8;
        let mn = 255;
        let mx = 0;
        for (const p of boxes[i]) {
          const v = (p >> sh) & 255;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const score = (mx - mn) * boxes[i].length;
        if (score > best) {
          best = score;
          bi = i;
          bc = ch;
        }
      }
    }
    if (bi < 0 || best === 0) break; // nothing left to split
    const sh = 16 - bc * 8;
    const box = boxes[bi].slice().sort((a, b) => ((a >> sh) & 255) - ((b >> sh) & 255));
    // Split at the VALUE boundary nearest the median — splitting at the raw
    // median index lands inside tie runs when few distinct colours dominate,
    // wasting the whole budget halving identical pixels.
    const v = (i: number) => (box[i] >> sh) & 255;
    const mid0 = box.length >> 1;
    let lo = mid0;
    while (lo > 0 && v(lo) === v(lo - 1)) lo--;
    let hi = mid0;
    while (hi < box.length && v(hi) === v(hi - 1)) hi++;
    let mid = mid0 - lo <= hi - mid0 ? lo : hi;
    if (mid <= 0) mid = hi;
    if (mid >= box.length) mid = lo;
    if (mid <= 0 || mid >= box.length) break; // single value — range said otherwise, bail safely
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    boxes = boxes.filter((b) => b.length);
  }
  const out: string[] = [];
  for (const box of boxes) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of box) {
      r += (p >> 16) & 255;
      g += (p >> 8) & 255;
      b += p & 255;
    }
    const n = box.length;
    out.push(toHex8({ r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: 1 }));
  }
  return dedupe(out);
}
