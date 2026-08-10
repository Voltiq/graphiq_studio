// Animated image import (TODO §9) — turn a GIF / APNG / animated WebP into a
// stack of frames the editor can open as layers.
//
// Two decode paths, chosen per format because the browser's support is uneven:
//
//   GIF  → our own decoder ([gif.ts](./gif.ts)). Browsers animate GIFs
//          internally and will only ever hand back the FIRST frame, so there is
//          no platform route to the rest; the decoder is hand-written and
//          Node-verified against a real GDI+-written file.
//   APNG / animated WebP
//        → WebCodecs `ImageDecoder`, which exposes per-frame decode for every
//          format the browser itself can decode. It is Chromium-only today
//          (Chrome/Edge/Opera); elsewhere we fall back to the single composited
//          frame the browser will give us and SAY SO, rather than silently
//          importing a one-layer "animation".

import { decodeGif, isGif } from "./gif";

export interface AnimFrame {
  bitmap: CanvasImageSource;
  /** Display time in milliseconds. */
  delayMs: number;
}

export interface AnimImage {
  width: number;
  height: number;
  frames: AnimFrame[];
  /** 0 = loop forever. */
  loops: number;
  /** Empty unless something couldn't be honoured (shown as a toast). */
  note: string;
}

/** File extensions that can hold an animation. */
export const ANIMATED_EXT = /\.(gif|png|apng|webp)$/i;

/** Does this file's magic say APNG? A PNG is animated only if it carries an
 *  `acTL` chunk BEFORE the first `IDAT` — a plain PNG must not take this path. */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return false;
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    if (len < 0) return false;
    p += 12 + len;
  }
  return false;
}

/** Does this WebP carry an animation chunk (`ANIM` inside a VP8X container)? */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  const tag = (p: number) =>
    String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return false;
  // VP8X's feature flags byte: bit 1 (0x02) is the animation flag.
  if (tag(12) !== "VP8X") return false;
  return (bytes[20] & 0x02) !== 0;
}

/** True when these bytes hold more than one frame in any supported format. */
export function looksAnimated(bytes: Uint8Array): boolean {
  return isGif(bytes) || isAnimatedPng(bytes) || isAnimatedWebp(bytes);
}

/** Wrap raw RGBA in a canvas the engine can draw. */
function rgbaToCanvas(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  // The decoder allocates plain Uint8ClampedArrays; ImageData wants one backed
  // by a real ArrayBuffer, which a copy guarantees.
  const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

type DecoderCtor = new (init: { data: BufferSource; type: string }) => {
  completed: Promise<void>;
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number; repetitionCount: number } };
  decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
  close: () => void;
};

/** Per-frame decode through WebCodecs, or null where it isn't available. */
async function decodeViaImageDecoder(
  bytes: Uint8Array,
  mime: string,
): Promise<AnimImage | null> {
  const Ctor = (globalThis as { ImageDecoder?: DecoderCtor }).ImageDecoder;
  if (!Ctor) return null;
  let dec: InstanceType<DecoderCtor> | null = null;
  try {
    dec = new Ctor({ data: bytes.slice().buffer, type: mime });
    await dec.tracks.ready;
    await dec.completed; // frameCount is only final once the whole file is in
    const track = dec.tracks.selectedTrack;
    const count = track?.frameCount ?? 1;
    const frames: AnimFrame[] = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      width = image.displayWidth || image.codedWidth;
      height = image.displayHeight || image.codedHeight;
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d")!.drawImage(image, 0, 0);
      // `duration` is microseconds; a still frame reports null.
      frames.push({ bitmap: c, delayMs: Math.max(10, Math.round((image.duration ?? 100000) / 1000)) });
      image.close();
    }
    if (!frames.length) return null;
    return {
      width,
      height,
      frames,
      loops: track?.repetitionCount === Infinity ? 0 : (track?.repetitionCount ?? 0),
      note: "",
    };
  } catch {
    return null;
  } finally {
    try {
      dec?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Decode an animated file into frames, or null when it holds only one.
 *
 * Never throws: a format we can't fully read comes back as a single frame with
 * a `note` explaining what was lost, so the caller can import something useful
 * and tell the user the truth about it.
 */
export async function decodeAnimation(file: File): Promise<AnimImage | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isGif(bytes)) {
    const gif = decodeGif(bytes);
    if (!gif || gif.frames.length < 2) return null; // a still GIF is an ordinary import
    return {
      width: gif.width,
      height: gif.height,
      frames: gif.frames.map((f) => ({
        bitmap: rgbaToCanvas(f.rgba, gif.width, gif.height),
        delayMs: f.delayMs,
      })),
      loops: gif.loops,
      note: "",
    };
  }

  const animatedPng = isAnimatedPng(bytes);
  const animatedWebp = isAnimatedWebp(bytes);
  if (!animatedPng && !animatedWebp) return null;

  const mime = animatedPng ? "image/png" : "image/webp";
  const viaDecoder = await decodeViaImageDecoder(bytes, mime);
  if (viaDecoder && viaDecoder.frames.length >= 2) return viaDecoder;

  // No WebCodecs (or it declined the file): the browser will still give us the
  // composited first frame. Import that, and be explicit that the rest is gone.
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    return {
      width: bitmap.width,
      height: bitmap.height,
      frames: [{ bitmap, delayMs: 100 }],
      loops: 0,
      note: `This browser can't decode ${animatedPng ? "APNG" : "animated WebP"} frame by frame — only the first frame was imported. Chrome and Edge import every frame.`,
    };
  } catch {
    return null;
  }
}

/** Frame label used for the imported layers ("Frame 3 · 80 ms"). */
export const frameLabel = (i: number, delayMs: number): string =>
  `Frame ${i + 1} · ${Math.round(delayMs)} ms`;

/** Parse a delay back out of a frame layer's name (0 when it isn't one). */
export function delayFromLabel(name: string): number {
  const m = /·\s*(\d+)\s*ms\s*$/.exec(name);
  return m ? Number(m[1]) : 0;
}
