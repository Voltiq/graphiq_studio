/// <reference lib="webworker" />
// RAW (DNG) decode worker: the whole parse → lossless-JPEG → demosaic →
// develop pipeline is pure math, so it runs off-thread — a 24 MP raw takes
// on the order of a second, which would otherwise freeze the UI.
//
// TWO PROTOCOLS, because there are two callers with different needs.
//
//   decode   one shot: { kind: "decode", buf, opts } → pixels. What an import
//            with no dialog does, and what this worker did before.
//
//   open/develop   the develop dialog: "open" parses once and KEEPS the parsed
//            image here, then each "develop" re-runs only the cheap half and
//            sends back a small preview. The parsed plane is 96 MB on a 24 MP
//            file; keeping it in the worker means it never crosses the boundary
//            at all, and the main thread never blocks on a slider.
//
// The caller spawns a worker per import and terminates it when done.

import { developRaw, parseRawDNG, type RawDevelopOptions, type RawImage } from "../lib/dng";

declare const self: DedicatedWorkerGlobalScope;

type Req =
  | { id: number; kind: "decode"; buf: ArrayBuffer; opts?: RawDevelopOptions }
  | { id: number; kind: "open"; buf: ArrayBuffer }
  | { id: number; kind: "develop"; opts?: RawDevelopOptions };

/** The image "open" parsed, held for the develops that follow. */
let held: RawImage | null = null;

const fail = (id: number) => self.postMessage({ id, ok: false });

const sendPixels = (
  id: number,
  res: { width: number; height: number; data: Uint8ClampedArray } | null,
  extra: Record<string, unknown> = {},
) => {
  if (!res) return fail(id);
  self.postMessage({ id, ok: true, width: res.width, height: res.height, data: res.data.buffer, ...extra }, [
    res.data.buffer,
  ]);
};

self.onmessage = (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.kind === "decode") {
      const img = parseRawDNG(m.buf);
      sendPixels(m.id, img ? developRaw(img, m.opts) : null);
      return;
    }
    if (m.kind === "open") {
      held = parseRawDNG(m.buf);
      if (!held) return fail(m.id);
      /* The reply carries what the dialog needs to lay itself out before any
         develop has run: the final size, and the camera's own white balance so
         "as shot" can be shown as the neutral position. */
      self.postMessage({
        id: m.id,
        ok: true,
        width: held.rot % 2 ? held.cropH : held.cropW,
        height: held.rot % 2 ? held.cropW : held.cropH,
        asShot: held.asShot,
      });
      return;
    }
    if (m.kind === "develop") {
      if (!held) return fail(m.id);
      sendPixels(m.id, developRaw(held, m.opts));
      return;
    }
  } catch {
    fail((m as { id: number }).id);
  }
};
