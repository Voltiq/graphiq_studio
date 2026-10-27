import { vi } from "vitest";
import type { Layer } from "../app/lib/doc-state";

/**
 * A canvas whose pixels are an array, for the engine parts' unit tests (TODO
 * 1.6): enough of a 2D context for what they do — fill, clear, read, put,
 * create image data, and draw one canvas onto another over or into it (with
 * the context's alpha) — and a log of every draw with the context's state at
 * that moment, for what a test checks by how it was drawn rather than by value.
 */

/** `#rgb` or `#rrggbb` as [r, g, b]. */
const rgb = (s: string) =>
  [1, 3, 5].map((i) => parseInt(s.length === 4 ? s[(i + 1) / 2].repeat(2) : s.slice(i, i + 2), 16));

/** One draw, and the context's state when it was made. */
export interface Draw {
  op: string;
  src: FakeCanvas | unknown;
  args: number[];
  alpha: number;
  composite: string;
  smoothing: boolean;
}

export class FakeCanvas {
  width = 0;
  height = 0;
  px = new Uint8ClampedArray(0);
  /** Every drawImage, with the state it was made in. */
  draws: Draw[] = [];
  /** Every other call, by name. */
  calls: unknown[][] = [];
  private ctx: Record<string, unknown> | null = null;
  getContext() {
    if (!this.ctx) {
      this.px = new Uint8ClampedArray(this.width * this.height * 4);
      this.ctx = contextOf(this);
    }
    return this.ctx;
  }
  toDataURL() {
    return `data:fake,${this.width}x${this.height}`;
  }
  /** Pixel (x, y) as [r, g, b, a]. */
  at(x: number, y: number) {
    return [...this.px.subarray((y * this.width + x) * 4, (y * this.width + x) * 4 + 4)];
  }
}

function contextOf(c: FakeCanvas): Record<string, unknown> {
  const stack: Record<string, unknown>[] = [];
  const ctx: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    save() {
      stack.push({
        globalAlpha: ctx.globalAlpha,
        globalCompositeOperation: ctx.globalCompositeOperation,
        fillStyle: ctx.fillStyle,
        imageSmoothingEnabled: ctx.imageSmoothingEnabled,
      });
      c.calls.push(["save"]);
    },
    restore() {
      Object.assign(ctx, stack.pop());
      c.calls.push(["restore"]);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const [r, g, b] = rgb(ctx.fillStyle as string);
      for (let yy = y; yy < Math.min(c.height, y + h); yy++)
        for (let xx = x; xx < Math.min(c.width, x + w); xx++) c.px.set([r, g, b, 255], (yy * c.width + xx) * 4);
    },
    clearRect(x: number, y: number, w: number, h: number) {
      c.calls.push(["clearRect", x, y, w, h]);
      for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++)
        c.px.fill(0, (yy * c.width + Math.max(0, x)) * 4, (yy * c.width + Math.min(c.width, x + w)) * 4);
    },
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    /** Recorded, its stops with it; nothing painted. */
    createRadialGradient(...args: number[]) {
      const g = { stops: [] as [number, string][], addColorStop: (o: number, s: string) => g.stops.push([o, s]) };
      c.calls.push(["createRadialGradient", ...args, g]);
      return g;
    },
    getImageData(x: number, y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++)
        data.set(c.px.subarray(((y + yy) * c.width + x) * 4, ((y + yy) * c.width + x + w) * 4), yy * w * 4);
      return { data, width: w, height: h };
    },
    putImageData(
      img: { data: Uint8ClampedArray; width: number; height: number },
      x: number,
      y: number,
      ...dirty: number[]
    ) {
      // With a dirty rect, only that part of the image is put down.
      const [sx, sy, sw, sh] = dirty.length === 4 ? dirty : [0, 0, img.width, img.height];
      for (let yy = sy; yy < sy + sh; yy++)
        for (let xx = sx; xx < sx + sw; xx++) {
          const tx = x + xx;
          const ty = y + yy;
          if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
          const from = (yy * img.width + xx) * 4;
          c.px.set(img.data.subarray(from, from + 4), (ty * c.width + tx) * 4);
        }
    },
    drawImage(src: FakeCanvas, ...args: number[]) {
      c.draws.push({
        op: "drawImage",
        src,
        args,
        alpha: ctx.globalAlpha as number,
        composite: ctx.globalCompositeOperation as string,
        smoothing: ctx.imageSmoothingEnabled as boolean,
      });
      // Pixels for an unscaled draw at a whole position, in the modes masks use.
      if (args.length !== 2 || !(src instanceof FakeCanvas)) return;
      const [x, y] = args.map(Math.round);
      src.getContext();
      const ga = ctx.globalAlpha as number;
      for (let yy = 0; yy < src.height; yy++)
        for (let xx = 0; xx < src.width; xx++) {
          if (y + yy < 0 || x + xx < 0 || y + yy >= c.height || x + xx >= c.width) continue;
          const s = (yy * src.width + xx) * 4;
          const d = ((y + yy) * c.width + x + xx) * 4;
          const sa = src.px[s + 3] * ga;
          const op = ctx.globalCompositeOperation;
          if (op === "destination-in") c.px[d + 3] = (c.px[d + 3] * sa) / 255;
          else if (op === "copy") c.px.set(src.px.subarray(s, s + 4), d);
          else if (op !== "source-over") continue; // recorded only
          else if (sa >= 255) c.px.set(src.px.subarray(s, s + 4), d);
          else if (sa > 0) {
            for (let k = 0; k < 3; k++) c.px[d + k] = (src.px[s + k] * sa + c.px[d + k] * (255 - sa)) / 255;
            c.px[d + 3] = sa + (c.px[d + 3] * (255 - sa)) / 255;
          }
        }
    },
  };
  // Anything else a part calls (paths, transforms) is recorded by name.
  return new Proxy(ctx, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => c.calls.push([k, ...a]);
    },
  });
}

/** A `w × h` raster, as the engine keeps one. */
export const canvas = (w: number, h: number): Layer => {
  const c = new FakeCanvas();
  c.width = w;
  c.height = h;
  return { c: c as unknown as HTMLCanvasElement, ctx: c.getContext() as unknown as CanvasRenderingContext2D };
};

/** The fake behind a raster or a canvas. */
export const fc = (l: Layer | HTMLCanvasElement | null | undefined) => ((l as Layer)?.c ?? l) as unknown as FakeCanvas;

/** `new ImageData(w, h)` or `new ImageData(data, w, h)`, as Node has none. */
export class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? a.length / 4 / b;
    }
  }
}

/** `document.createElement("canvas")` makes fakes, for code that makes its own (makeCanvas). */
export const installFakeCanvas = () => {
  vi.stubGlobal("document", { createElement: () => new FakeCanvas() });
  vi.stubGlobal("ImageData", FakeImageData);
};
