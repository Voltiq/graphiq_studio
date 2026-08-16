/**
 * Node has no `ImageData`, and filters.ts returns one from every pass, so the
 * tests need a stand-in.
 *
 * It is written to match the real constructor rather than to be convenient: it
 * WRAPS the array it is handed instead of copying it (so a test that asserts a
 * filter returned a fresh buffer is really asserting that, not being fooled by
 * the shim), it validates the length exactly as the spec does, and it keeps
 * `colorSpace`. A lenient shim here would let broken code pass in Node and fail
 * in the browser, which is the one thing a stand-in must not do.
 */
class NodeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: PredefinedColorSpace;

  constructor(
    a: Uint8ClampedArray | number,
    b: number,
    c?: number | ImageDataSettings,
    d?: ImageDataSettings,
  ) {
    if (typeof a === "number") {
      // new ImageData(width, height, settings?)
      const w = Math.trunc(a);
      const h = Math.trunc(b);
      if (w <= 0 || h <= 0) throw new RangeError("ImageData: dimensions must be positive");
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
      this.colorSpace = (c as ImageDataSettings | undefined)?.colorSpace ?? "srgb";
      return;
    }
    // new ImageData(data, width, height?, settings?)
    const w = Math.trunc(b);
    if (a.length % 4 !== 0) throw new RangeError("ImageData: data length must be a multiple of 4");
    if (w <= 0) throw new RangeError("ImageData: width must be positive");
    const h = typeof c === "number" ? Math.trunc(c) : a.length / 4 / w;
    if (!Number.isInteger(h) || h <= 0 || a.length !== w * h * 4) {
      throw new RangeError(`ImageData: data length ${a.length} does not match ${w}x${h}`);
    }
    this.data = a;
    this.width = w;
    this.height = h;
    this.colorSpace = (typeof c === "number" ? d : c)?.colorSpace ?? "srgb";
  }
}

const g = globalThis as unknown as { ImageData?: typeof ImageData };
g.ImageData ??= NodeImageData as unknown as typeof ImageData;
