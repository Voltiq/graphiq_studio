// What a decoder may allocate on a file's say-so (TODO 0.4).
//
// Every format here stores its dimensions in a header, and compression lets a
// few bytes stand for a great many pixels. Measured before this existed: a GIF
// header claiming 65535×65535 decoded into 32 GB in 4.3 s; a 4096×4096 GIF of
// 1×1 frames costs 64 MB per ~15-byte frame (every frame keeps a full-canvas
// copy), so a 15 KB file could ask for 64 GB; a 150-byte TIFF allocated ~2 GB
// before noticing it had no pixel data. In a browser tab any of those is a crash
// that takes every open document with it.
//
// Pure and DOM-free: decoders run in workers and in Node tests.

/** Most pixels one image may have: 16384² — the largest canvas area any
 *  browser allows, so nothing bigger could ever be opened as a document.
 *  Refusing it costs nothing a user could have edited. */
export const MAX_DECODE_PIXELS = 16384 * 16384;

/** Most bytes one decode may produce across ALL its frames or layers. Chosen to
 *  sit above anything the editor can actually work with — a 40-layer 12 MP PSD
 *  decodes to ~1.9 GB, and the editor holds canvases, history and caches on top
 *  — so it refuses bombs, not documents. */
export const MAX_DECODE_BYTES = 2 * 1024 ** 3;

/** May an image of w×h be decoded at `bytesPerPixel`? Rejects non-integer,
 *  non-positive and implausibly large claims before anything is allocated. */
export function fitsDecode(w: number, h: number, bytesPerPixel = 4): boolean {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return false;
  const px = w * h;
  return px <= MAX_DECODE_PIXELS && px * bytesPerPixel <= MAX_DECODE_BYTES;
}

/** A running total for decoders that allocate per frame or per layer. */
export class DecodeBudget {
  private used = 0;
  constructor(private readonly limit = MAX_DECODE_BYTES) {}
  /** Claim `bytes`; false (and nothing claimed) if that would exceed the budget. */
  take(bytes: number): boolean {
    if (!(bytes >= 0) || this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
}
