"use client";

import type { PngResponse } from "../workers/png.worker";

/**
 * Encode a canvas to a PNG Blob without blocking the caller.
 *
 * The same encoder the canvas would have used, running in a worker; the result
 * comes back as a Blob, so the base64 a data URL would need is never built. Used by autosave, which
 * runs while the page is being hidden and must not freeze it; the crash path
 * and the file export still encode synchronously, because they cannot await.
 *
 * Falls back to `toDataURL` wherever the pieces are missing (no worker, no
 * OffscreenCanvas, no `createImageBitmap`) so the caller always gets a URL —
 * a slow snapshot is worth far more than no snapshot.
 */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: PngResponse) => void>();

/** Lazily started, and left running: autosave uses it every couple of minutes. */
function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  try {
    worker = new Worker(new URL("../workers/png.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<PngResponse>) => {
      const done = pending.get(e.data.id);
      pending.delete(e.data.id);
      done?.(e.data);
    };
    worker.onerror = () => {
      // Fail the whole batch rather than leave callers hanging; each falls back.
      for (const [, done] of pending) done({ id: -1, error: "worker failed" });
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** The fallback when there is no worker: `toBlob` still encodes on this thread
 *  (measured at 409 ms blocked for one 12-megapixel layer, worse than
 *  toDataURL), but a slow snapshot is worth far more than no snapshot. */
function encodeHere(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export async function encodePngOffThread(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const w = ensureWorker();
  if (!w || typeof createImageBitmap !== "function") return encodeHere(canvas);
  try {
    /* Transferable, and free to make: the pixels leave without a copy on this
       thread. */
    const bitmap = await createImageBitmap(canvas);
    const id = nextId++;
    const reply = await new Promise<PngResponse>((resolve) => {
      pending.set(id, resolve);
      w.postMessage({ id, bitmap, width: canvas.width, height: canvas.height }, [bitmap]);
    });
    if ("blob" in reply) return reply.blob;
    return encodeHere(canvas);
  } catch {
    return encodeHere(canvas);
  }
}
