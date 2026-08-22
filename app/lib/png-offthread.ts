"use client";

import type { PngResponse } from "../workers/png.worker";

/**
 * Encode a canvas to a PNG data URL without blocking the caller.
 *
 * Same output as `canvas.toDataURL("image/png")` — byte for byte, since it is
 * the same encoder — but the work happens in a worker. Used by autosave, which
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

export async function encodePngOffThread(canvas: HTMLCanvasElement): Promise<string> {
  const w = ensureWorker();
  if (!w || typeof createImageBitmap !== "function") return canvas.toDataURL("image/png");
  try {
    /* Transferable, and free to make: the pixels leave without a copy on this
       thread. */
    const bitmap = await createImageBitmap(canvas);
    const id = nextId++;
    const reply = await new Promise<PngResponse>((resolve) => {
      pending.set(id, resolve);
      w.postMessage({ id, bitmap, width: canvas.width, height: canvas.height }, [bitmap]);
    });
    if ("url" in reply) return reply.url;
    return canvas.toDataURL("image/png");
  } catch {
    return canvas.toDataURL("image/png");
  }
}
