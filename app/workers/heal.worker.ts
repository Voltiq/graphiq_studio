/// <reference lib="webworker" />
// Spot-heal / content-aware-fill compute worker: runs the pure healRegion
// kernel (best-offset texture synthesis + two-level membrane solve) off the
// UI thread, so releasing a big heal blob never freezes the canvas.
//
// Protocol (fire-and-forget jobs, one reply each):
//   { id, w, h, src: ArrayBuffer, coverage: ArrayBuffer }   (buffers transferred)
//   → { id, data: ArrayBuffer }                             (transferred back)
//
// The main thread validates each reply against the document state it captured
// when the job was posted (epoch / dimensions / layer existence) and falls
// back to computing synchronously if the worker can't be created.

import { healRegion } from "../lib/heal";

declare const self: DedicatedWorkerGlobalScope;

interface HealJobMsg {
  id: number;
  w: number;
  h: number;
  src: ArrayBuffer;
  coverage: ArrayBuffer;
}

self.onmessage = (e: MessageEvent<HealJobMsg>) => {
  const m = e.data;
  const src = new ImageData(new Uint8ClampedArray(m.src), m.w, m.h);
  const healed = healRegion({ src, coverage: new Uint8ClampedArray(m.coverage) });
  const buf = healed.data.buffer;
  self.postMessage({ id: m.id, data: buf }, [buf]);
};
