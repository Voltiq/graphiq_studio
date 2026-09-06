"use client";

/**
 * The pattern-tile library: built-in tiles, imported ones, and where they live.
 *
 * On the same lines as the gradient and shape libraries — the same shape of API,
 * the same import/export, the same "built-ins plus yours" picker — with one
 * deliberate difference, which is measured rather than preferred.
 *
 * WHY NOT localStorage, WHICH IS WHERE EVERY OTHER PRESET LIVES. Every existing
 * preset in this app is small JSON: a gradient is a handful of stops, a shape is
 * a path string. A pattern tile is an IMAGE, and images are three orders of
 * magnitude bigger. Measured, as data-URL characters — which is what
 * localStorage would actually store:
 *
 *     motif 128×128    11.9 KB PNG      photo 256×256    343 KB
 *     motif 256×256    25.9 KB          photo 512×512   1371 KB
 *
 * A single 512px photographic tile is 26% of the ~5 MB a browser gives an
 * origin, and that budget is shared with swatches, brushes, gradients, actions
 * and export presets. Three tiles would fill it and start throwing on save.
 * IndexedDB has no such ceiling and stores a Blob as bytes, which also avoids
 * base64's +33%.
 *
 * `recents.ts` already does exactly this — a meta store keyed by id, a payload
 * store beside it, thumbnails, and a byte budget with a pure trim — so this
 * follows it rather than inventing a second way to keep blobs.
 *
 * BUILT-INS ARE DRAWN, NOT SHIPPED. The only binaries in this repository are the
 * app icons; `BUILTIN_SHAPES` is path data and the brush textures are generated.
 * So the starter tiles are procedures, which also makes them exactly seamless at
 * any size and costs no storage at all.
 *
 * NAMING: the brush's `TEXTURE_PATTERNS` (brush-tip.ts) are procedural *brush
 * textures* and a different thing entirely. Nothing here is called a texture.
 *
 * The pure half — validation, merging, the byte trim, the built-in definitions —
 * has no DOM in it and is tested in `tests/patterns.test.ts`.
 */

export const PATTERN_DB = "graphiq-patterns";
const DB_VERSION = 1;
const META = "pattern-meta";
const TILE = "pattern-tile";

/** Pattern file extension, matching `.ggrad` / `.gshape`. */
export const PATTERN_EXT = "gpat";

/**
 * The longest edge a stored tile may have.
 *
 * A pattern is something that REPEATS; past a few hundred pixels it is a photo
 * being used as wallpaper, and the cost is carried on every fill. 512 keeps the
 * worst realistic tile inside a megabyte or so of PNG.
 */
export const PATTERN_MAX_EDGE = 512;

/** What the whole library may weigh. Well under any quota, and honest to show. */
export const PATTERN_LIBRARY_BYTES = 32 * 1024 * 1024;

/** Longest edge of the picker's thumbnail. */
export const PATTERN_THUMB_EDGE = 96;

/** What the picker's grid needs, without the pixels. */
export interface PatternMeta {
  id: string;
  name: string;
  /** Tile size in pixels. */
  width: number;
  height: number;
  /** Weight of the stored tile. 0 for built-ins, which store nothing. */
  bytes: number;
  savedAt: number;
}

/** Meta plus the pixels. Only crosses the store boundary on add and on use. */
export interface PatternAsset extends PatternMeta {
  tile: Blob;
}

/**
 * The file-shaped, DOM-free form.
 *
 * NOTE THE ABSENCE OF AN ID. An id can only be minted, never carried in from a
 * file — which closes by construction a hole the shape library has: there,
 * `sanitizeShape` takes the id from the file, so a hand-edited `.gshape` can
 * claim a `b-` prefix and install itself as an undeletable pseudo-built-in.
 */
export interface PatternEntry {
  name: string;
  width: number;
  height: number;
  /** `data:image/png;base64,…` */
  src: string;
}

/** How a tile sits under a fill. Shared, so both blocked follow-ons can reuse it. */
export interface PatternPlacement {
  /** 1 = the tile's own pixels. */
  scale: number;
  /** Radians. */
  rotate: number;
  /** Origin offset, as a fraction of the scaled tile. */
  offsetX: number;
  offsetY: number;
}

export const DEFAULT_PLACEMENT: PatternPlacement = {
  scale: 1,
  rotate: 0,
  offsetX: 0,
  offsetY: 0,
};

// ---------------------------------------------------------------- pure ------

const BUILTIN_PREFIX = "b-";

export const isBuiltinPattern = (id: string): boolean => id.startsWith(BUILTIN_PREFIX);

/**
 * A new id: the time, plus enough randomness that two in the same millisecond
 * differ.
 *
 * NOT sortable, and the first version of this said it was. Base36 of a
 * timestamp changes LENGTH as the clock rolls over a power of 36, and strings
 * of different lengths do not compare by value — `(2e6).toString(36)` sorts
 * BEFORE `(1e6).toString(36)`. Nothing depends on it: `listPatterns` sorts on
 * `savedAt`, which is a number.
 */
export function freshPatternId(now: number, rand: number): string {
  const t = Math.max(0, Math.floor(now)).toString(36);
  const r = Math.floor(Math.abs(rand) * 0xffff)
    .toString(36)
    .padStart(4, "0");
  return `pat-${t}-${r}`;
}

/** "brick_wall.png" → "brick wall". A file name is a bad label as it stands. */
export function patternNameFromFile(file: string): string {
  return (
    file
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .slice(0, 60) || "Pattern"
  );
}

/** Validate one entry from a file. Null = not a pattern, or not a usable one. */
export function sanitizePattern(raw: unknown): PatternEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : null;
  const width = typeof o.width === "number" ? Math.round(o.width) : 0;
  const height = typeof o.height === "number" ? Math.round(o.height) : 0;
  const src = typeof o.src === "string" ? o.src : "";
  if (!name) return null;
  if (width < 1 || height < 1) return null;
  if (width > PATTERN_MAX_EDGE || height > PATTERN_MAX_EDGE) return null;
  /* Only a data URL, and only an image one. A file that could name an http:
     source would turn importing a pattern into a network request the user did
     not make, and a `javascript:` one would be worse than that. */
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) return null;
  return { name, width, height, src };
}

/** Read a `.gpat` file. Tolerates a bare array or a wrapped object. */
export function parsePatternFile(text: string): PatternEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { patterns?: unknown })?.patterns)
      ? (data as { patterns: unknown[] }).patterns
      : [];
  return list.map(sanitizePattern).filter((p): p is PatternEntry => p !== null);
}

export function serializePatterns(list: PatternEntry[]): string {
  return JSON.stringify({ kind: "graphiq-patterns", version: 1, patterns: list }, null, 2);
}

/**
 * Imported entries that are not already there, renamed so nothing is shadowed.
 *
 * Names collide constantly — everybody's file is called "pattern" — and silently
 * replacing one someone made is the worst of the options.
 */
export function mergePatterns(
  existing: { name: string }[],
  imported: PatternEntry[],
): PatternEntry[] {
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  const out: PatternEntry[] = [];
  for (const p of imported) {
    let name = p.name;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = `${p.name} ${n++}`;
    taken.add(name.toLowerCase());
    out.push({ ...p, name });
  }
  return out;
}

/**
 * The entries that survive the byte budget: newest first, oldest evicted.
 *
 * `keepId` is never evicted — it is the one just added, and adding a tile that
 * immediately deletes itself would be a confusing way to hit a limit.
 * Built-ins weigh nothing and are never counted.
 */
export function trimPatterns(
  metas: PatternMeta[],
  maxBytes: number = PATTERN_LIBRARY_BYTES,
  keepId?: string,
): PatternMeta[] {
  const sorted = [...metas].sort((a, b) => b.savedAt - a.savedAt);
  const out: PatternMeta[] = [];
  let used = 0;
  for (const m of sorted) {
    const size = isBuiltinPattern(m.id) ? 0 : m.bytes;
    if (m.id === keepId || used + size <= maxBytes) {
      out.push(m);
      used += size;
    }
  }
  return out;
}

// ------------------------------------------------------------ built-ins -----

/** A built-in is a name and a way to draw one tile of it. */
export interface BuiltinPattern {
  id: string;
  name: string;
  size: number;
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
}

/*
 * Drawn rather than shipped, and drawn so they TILE: every stroke that leaves
 * one edge is repeated arriving at the opposite one. A pattern whose seam shows
 * is not a pattern.
 */
export const BUILTIN_PATTERNS: BuiltinPattern[] = [
  {
    id: "b-checker",
    name: "Checker",
    size: 32,
    draw: (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      c.fillStyle = "#c8ccd4";
      c.fillRect(0, 0, s / 2, s / 2);
      c.fillRect(s / 2, s / 2, s / 2, s / 2);
    },
  },
  {
    id: "b-grid",
    name: "Grid",
    size: 32,
    draw: (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      c.strokeStyle = "#aeb4c0";
      c.lineWidth = 1;
      // Half-pixel offsets keep a 1px line on the pixel grid rather than astride it.
      c.beginPath();
      c.moveTo(0.5, 0);
      c.lineTo(0.5, s);
      c.moveTo(0, 0.5);
      c.lineTo(s, 0.5);
      c.stroke();
    },
  },
  {
    id: "b-dots",
    name: "Dots",
    size: 24,
    draw: (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      c.fillStyle = "#8b93a3";
      /* Drawn at all four corners as well as the centre, so the dot that is cut
         by an edge is completed by the neighbouring tile. */
      for (const [x, y] of [
        [0, 0],
        [s, 0],
        [0, s],
        [s, s],
        [s / 2, s / 2],
      ]) {
        c.beginPath();
        c.arc(x, y, s / 8, 0, Math.PI * 2);
        c.fill();
      }
    },
  },
  {
    id: "b-diagonal",
    name: "Diagonal lines",
    size: 24,
    draw: (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      c.strokeStyle = "#9aa2b1";
      c.lineWidth = 3;
      /* Three passes offset by a tile, so the stripe leaving the bottom-left
         arrives again at the top-right and the diagonal runs unbroken. */
      c.beginPath();
      for (const d of [-s, 0, s]) {
        c.moveTo(d, s);
        c.lineTo(d + s, 0);
      }
      c.stroke();
    },
  },
  {
    id: "b-crosshatch",
    name: "Crosshatch",
    size: 24,
    draw: (c, s) => {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, s, s);
      c.strokeStyle = "#9aa2b1";
      c.lineWidth = 2;
      c.beginPath();
      for (const d of [-s, 0, s]) {
        c.moveTo(d, s);
        c.lineTo(d + s, 0);
        c.moveTo(d, 0);
        c.lineTo(d + s, s);
      }
      c.stroke();
    },
  },
];

export const builtinPatternMetas = (): PatternMeta[] =>
  BUILTIN_PATTERNS.map((b) => ({
    id: b.id,
    name: b.name,
    width: b.size,
    height: b.size,
    bytes: 0,
    savedAt: 0,
  }));

/** Draw one built-in tile. Null for an id that is not one. */
export function drawBuiltinTile(id: string): HTMLCanvasElement | null {
  const b = BUILTIN_PATTERNS.find((p) => p.id === id);
  if (!b || typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = b.size;
  c.height = b.size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  b.draw(ctx, b.size);
  return c;
}

// --------------------------------------------------------- the store --------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PATTERN_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(TILE)) db.createObjectStore(TILE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every saved pattern's meta, newest first. Built-ins are not in here. */
export async function listPatterns(): Promise<PatternMeta[]> {
  try {
    const db = await openDB();
    return await new Promise<PatternMeta[]>((resolve) => {
      const tx = db.transaction(META, "readonly");
      const req = tx.objectStore(META).getAll();
      req.onsuccess = () => {
        const list = (req.result as PatternMeta[]) ?? [];
        resolve(list.sort((a, b) => b.savedAt - a.savedAt));
      };
      req.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

export async function readPatternTile(id: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(TILE, "readonly");
      const req = tx.objectStore(TILE).get(id);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

/** Store a tile. Returns its meta, or null if the store refused it. */
export async function addPattern(meta: PatternMeta, tile: Blob): Promise<PatternMeta | null> {
  try {
    const db = await openDB();
    const ok = await new Promise<boolean>((resolve) => {
      const tx = db.transaction([META, TILE], "readwrite");
      tx.objectStore(META).put(meta);
      tx.objectStore(TILE).put(tile, meta.id);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      /* A quota error lands here rather than throwing at the caller — the
         picker says the library is full instead of the import vanishing. */
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    });
    if (!ok) return null;
    // Evict oldest beyond the budget, never the one just added.
    const keep = new Set(trimPatterns(await listPatterns(), PATTERN_LIBRARY_BYTES, meta.id).map((m) => m.id));
    for (const m of await listPatterns()) if (!keep.has(m.id)) await deletePattern(m.id);
    return meta;
  } catch {
    return null;
  }
}

export async function deletePattern(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([META, TILE], "readwrite");
      tx.objectStore(META).delete(id);
      tx.objectStore(TILE).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    /* nothing to delete, or storage is unavailable — both are "it is gone" */
  }
}

export async function clearPatterns(): Promise<void> {
  for (const m of await listPatterns()) await deletePattern(m.id);
}

/** Count and weight, for the Storage tab. */
export async function patternStoreInfo(): Promise<{ count: number; bytes: number }> {
  const list = await listPatterns();
  return { count: list.length, bytes: list.reduce((n, m) => n + m.bytes, 0) };
}

// --------------------------------------------------- loading and importing --

/** A pattern's pixels, ready to hand to `createPattern`. Null if it is gone. */
export async function loadPatternTile(id: string): Promise<CanvasImageSource | null> {
  if (isBuiltinPattern(id)) return drawBuiltinTile(id);
  const blob = await readPatternTile(id);
  if (!blob) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Take an image file into the library.
 *
 * Anything over `PATTERN_MAX_EDGE` is scaled DOWN rather than refused: someone
 * dragging a photo in wants a pattern made of it, and "too big" is a worse
 * answer than a tile of the size a tile should be. Re-encoded as PNG so the
 * stored bytes are predictable whatever came in.
 */
export async function importPatternFile(
  file: File,
  now: number,
  rand: number,
): Promise<PatternMeta | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, PATTERN_MAX_EDGE / Math.max(bmp.width, bmp.height, 1));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), "image/png"));
    if (!blob) return null;
    return await addPattern(
      {
        id: freshPatternId(now, rand),
        name: patternNameFromFile(file.name),
        width: w,
        height: h,
        bytes: blob.size,
        savedAt: now,
      },
      blob,
    );
  } catch {
    return null;
  }
}

/** One stored pattern as a file-shaped entry, for export. */
export async function patternToEntry(m: PatternMeta): Promise<PatternEntry | null> {
  const blob = await readPatternTile(m.id);
  if (!blob) return null;
  const src = await new Promise<string>((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ""));
    fr.onerror = () => res("");
    fr.readAsDataURL(blob);
  });
  return sanitizePattern({ name: m.name, width: m.width, height: m.height, src });
}

/** Store an entry that came from a file. */
export async function entryToPattern(
  e: PatternEntry,
  now: number,
  rand: number,
): Promise<PatternMeta | null> {
  try {
    const res = await fetch(e.src);
    const blob = await res.blob();
    return await addPattern(
      {
        id: freshPatternId(now, rand),
        name: e.name,
        width: e.width,
        height: e.height,
        bytes: blob.size,
        savedAt: now,
      },
      blob,
    );
  } catch {
    return null;
  }
}
