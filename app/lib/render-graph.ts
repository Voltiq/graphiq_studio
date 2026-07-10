// Spec 06 — render graph support (pure helpers, no canvas ops).
//
// The engine keys every node's cached intrinsic render by a hash of exactly
// what it depends on (see paint.ts renderNode/nodeKey). These helpers provide
// the hashing, the dirty-rect math, and the LRU eviction selection. Caches are
// an optimization, never truth: dropping any entry must only cost time.

import type { Rect } from "./view";

/** One cached intrinsic render (pre-opacity/blend, document space). */
export interface RenderNodeCache {
  c: HTMLCanvasElement;
  /** The node's dependency key when rendered; entry valid iff it still matches. */
  key: string;
  /** Owned bytes (0 when the buffer aliases a layer canvas). */
  bytes: number;
  /** LRU clock value at last use. */
  tick: number;
}

// ---- Tiled products (very large documents) ----------------------------------
// A doc-sized cached product on an 8k document is ~268 MB — bigger than the
// whole default cache budget, so whole-canvas entries can't be kept or evicted
// sensibly. Products whose math is strictly per-pixel (adjustment accumulators)
// are instead stored as a grid of tiles: eviction frees individual tiles, and a
// missing/stale tile is recomputed alone from the below-accumulator.

/** Tile edge in document pixels (4 MB RGBA per full tile). */
export const TILE_SIZE = 1024;
/** Tile products at/above this full-product size — 64 MB is the smallest
 *  budget setting, so anything bigger MUST be evictable in pieces. */
export const TILE_PRODUCT_MIN_BYTES = 64 * 1024 * 1024;
/** Separator for per-tile pseudo-ids fed to selectEvictions. NUL can't collide
 *  with generated node ids (`layer-N` / `adj-N`), and even a crafted project id
 *  containing it only mis-targets an eviction — caches are never truth. */
export const TILE_ID_SEP = String.fromCharCode(0);

export interface TileGrid {
  cols: number;
  rows: number;
}

/** The tile grid for a document, or null when it's small enough that whole-
 *  canvas products stay cheaper (allocation + bookkeeping) than tiling. */
export function tileGrid(w: number, h: number): TileGrid | null {
  if (w < 1 || h < 1 || w * h * 4 < TILE_PRODUCT_MIN_BYTES) return null;
  return { cols: Math.ceil(w / TILE_SIZE), rows: Math.ceil(h / TILE_SIZE) };
}

/** Document-space rect of tile `i` (row-major; edge tiles clamp to the doc). */
export function tileRect(i: number, g: TileGrid, w: number, h: number): Rect {
  const x = (i % g.cols) * TILE_SIZE;
  const y = Math.floor(i / g.cols) * TILE_SIZE;
  return { x, y, w: Math.min(TILE_SIZE, w - x), h: Math.min(TILE_SIZE, h - y) };
}

/** Do two rects share any pixel? */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 64-bit-ish FNV-1a over a string (two 32-bit passes with different seeds).
 *  Inputs are short version/param strings — never pixel data. */
export function fnv(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9dc5811c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000197);
  }
  return (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
}

/** Union two rects (either may be null). */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Clamp a rect to a document, rounded outward to integers; null if empty. */
export function clampRect(r: Rect, docW: number, docH: number): Rect | null {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(docW, Math.ceil(r.x + r.w)) - x;
  const h = Math.min(docH, Math.ceil(r.y + r.h)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * Pick cache entries to evict, least-recently-used first, until `bytes` no
 * longer exceeds `budget`. Entries in `protect` (used by the frame being
 * composited) are never selected — evicting mid-frame could corrupt it.
 * Entries only need bytes+tick, so callers can mix whole products with
 * per-tile pseudo-entries (`<id>${TILE_ID_SEP}<tile index>`).
 */
export function selectEvictions(
  entries: Iterable<[string, { bytes: number; tick: number }]>,
  bytes: number,
  budget: number,
  protect: ReadonlySet<string>,
): string[] {
  if (bytes <= budget) return [];
  const candidates: { id: string; tick: number; bytes: number }[] = [];
  for (const [id, e] of entries) {
    if (e.bytes > 0 && !protect.has(id)) candidates.push({ id, tick: e.tick, bytes: e.bytes });
  }
  candidates.sort((a, b) => a.tick - b.tick);
  const out: string[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (bytes - freed <= budget) break;
    out.push(c.id);
    freed += c.bytes;
  }
  return out;
}
