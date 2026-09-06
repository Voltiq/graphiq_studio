"use client";

/**
 * The RAW develop session, and the registry that lets a dialog own one.
 *
 * A camera RAW is not a picture yet: it is sensor readings plus the camera's
 * opinion about how to turn them into one. `decodeDNG` has always taken that
 * opinion — as-shot white balance, the file's baseline exposure — and produced
 * a picture. This module is what lets someone disagree BEFORE the pixels land
 * on a layer, which is the point of a develop dialog: exposure and white
 * balance done on linear sensor data are a different and better thing than the
 * same sliders applied to an 8-bit sRGB layer afterwards.
 *
 * WHY A REGISTRY. `decodeImageFile` lives in a lib and is called from three
 * places, one of them a drag-and-drop handler; it cannot import a React dialog
 * without dragging the whole component tree into every context that decodes an
 * image, including the worker. So the editor registers "here is how to ask the
 * user", exactly as `crash.ts` registers "here is how to collect the open
 * documents", and anything with no dialog registered — a test, a headless
 * render, the worker itself — develops with the camera's own settings and
 * behaves precisely as it did before. The fallback is the old behaviour, not an
 * error.
 */

import type { RawDevelopOptions } from "./dng";

/** What the dialog is handed, and what it drives while it is open. */
export interface RawSession {
  /** Final pixel size after crop and rotation. */
  width: number;
  height: number;
  /** The camera's own white balance, for showing what "as shot" means. */
  asShot: [number, number, number];
  /** Develop at the given settings. `maxEdge` keeps a preview cheap. */
  develop(opts: RawDevelopOptions): Promise<ImageData | null>;
  /** Release the worker. Safe to call twice. */
  close(): void;
}

/**
 * Ask the user how to develop a RAW.
 *
 * Resolves with the options to use, or null to take the camera's own. Throwing
 * or rejecting is treated as null — a dialog that breaks must not cost someone
 * their import.
 */
export type RawDeveloper = (
  session: RawSession,
  name: string,
) => Promise<RawDevelopOptions | null>;

let developer: RawDeveloper | null = null;

/** Register the dialog. Returns the un-register, for an effect cleanup. */
export function registerRawDeveloper(fn: RawDeveloper): () => void {
  developer = fn;
  return () => {
    if (developer === fn) developer = null;
  };
}

/** Is anyone able to ask? `imageio` uses this to skip the whole dance. */
export const hasRawDeveloper = (): boolean => developer !== null;

/**
 * Open a worker-backed session over a RAW buffer.
 *
 * Null when the file is not a DNG or is outside the decoder's subset, which is
 * the caller's cue to fall back to the embedded JPEG preview as before.
 */
export async function openRawSession(buffer: ArrayBuffer): Promise<RawSession | null> {
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("../workers/dng.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }

  let seq = 0;
  const pending = new Map<number, (v: unknown) => void>();
  worker.onmessage = (e: MessageEvent<{ id: number }>) => {
    const done = pending.get(e.data.id);
    if (done) {
      pending.delete(e.data.id);
      done(e.data);
    }
  };
  /* A worker that dies takes every outstanding request with it, or the dialog
     waits forever on a promise nobody will settle. */
  worker.onerror = () => {
    for (const [, done] of pending) done({ ok: false });
    pending.clear();
  };

  const send = <T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve as (v: unknown) => void);
      worker.postMessage({ ...msg, id }, transfer);
    });

  /* The buffer is COPIED into the worker rather than transferred. Transferring
     detaches it, and the caller still needs it: if the dialog is cancelled, or
     the file turns out not to be a supported DNG, the import falls back to
     decoding the same bytes the ordinary way. A structured clone of 40 MB is
     cheaper than losing the fallback. */
  const opened = await send<{
    ok: boolean;
    width?: number;
    height?: number;
    asShot?: [number, number, number];
  }>({ kind: "open", buf: buffer });

  if (!opened.ok || !opened.width || !opened.height) {
    worker.terminate();
    return null;
  }

  let closed = false;
  return {
    width: opened.width,
    height: opened.height,
    asShot: opened.asShot ?? [1, 1, 1],
    async develop(opts) {
      if (closed) return null;
      const r = await send<{
        ok: boolean;
        width?: number;
        height?: number;
        data?: ArrayBuffer;
      }>({ kind: "develop", opts });
      if (!r.ok || !r.data || !r.width || !r.height) return null;
      const px = new Uint8ClampedArray(r.data);
      try {
        return new ImageData(px, r.width, r.height, { colorSpace: "srgb" });
      } catch {
        return new ImageData(px, r.width, r.height);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [, done] of pending) done({ ok: false });
      pending.clear();
      worker.terminate();
    },
  };
}

/**
 * What happened when a RAW was offered to the dialog.
 *
 * Three outcomes, not two, and the difference matters: "nobody asked" has to
 * decode the file as it always did, while "the user cancelled" has to abandon
 * the import entirely. Collapsing them would mean Cancel silently imported the
 * photo with the camera's settings — the one thing a Cancel button must not do.
 */
export type RawDialogOutcome =
  | { handled: false }
  | { handled: true; cancelled: true }
  | { handled: true; cancelled: false; image: ImageData };

/** Run a RAW through the dialog if one is registered. */
export async function developWithDialog(
  buffer: ArrayBuffer,
  name = "",
): Promise<RawDialogOutcome> {
  if (!developer) return { handled: false };
  const session = await openRawSession(buffer);
  if (!session) return { handled: false };
  try {
    const opts = await developer(session, name);
    if (!opts) return { handled: true, cancelled: true };
    const image = await session.develop({ ...opts, maxEdge: undefined });
    return image
      ? { handled: true, cancelled: false, image }
      : { handled: false }; // develop failed — let the ordinary path try
  } catch {
    return { handled: false };
  } finally {
    session.close();
  }
}
