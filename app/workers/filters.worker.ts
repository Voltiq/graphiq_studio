/// <reference lib="webworker" />
// Smart-filter compute worker: runs a node's whole enabled filter stack (the
// same pipeline as the engine's renderFiltered — filters bottom→top, each
// blended back with its own mode/opacity, optionally confined by the filter
// mask) off the UI thread. The engine shows the previous (stale) product for
// the frames a job is in flight, then swaps in the fresh result — so dragging
// a Gaussian-blur slider on a big document no longer blocks compositing.
//
// Protocol (fire-and-forget jobs, one reply each; newest-per-node wins):
//   { id, nodeId, key, w, h, cs, src: ArrayBuffer, fm: ArrayBuffer | null,
//     filters: SmartFilter[] }                        (buffers transferred)
//   → { id, nodeId, key, w, h, data: ArrayBuffer }    (transferred back)

import { blendInto } from "../lib/blend";
import { applyFilter, type SmartFilter } from "../lib/filters";
import { blendOp } from "../lib/layers";

declare const self: DedicatedWorkerGlobalScope;

interface FilterJobMsg {
  id: number;
  nodeId: string;
  key: string;
  w: number;
  h: number;
  cs: PredefinedColorSpace;
  src: ArrayBuffer;
  fm: ArrayBuffer | null;
  filters: SmartFilter[];
}

function makeImage(
  data: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  cs: PredefinedColorSpace,
): ImageData {
  try {
    return new ImageData(data, w, h, { colorSpace: cs });
  } catch {
    return new ImageData(data, w, h);
  }
}

self.onmessage = (e: MessageEvent<FilterJobMsg>) => {
  const m = e.data;
  const { w, h, cs } = m;
  let cur = makeImage(new Uint8ClampedArray(m.src), w, h, cs);
  const base = m.fm ? cur : null; // pristine pixels; never mutated below

  for (const f of m.filters) {
    if (!f.enabled) continue;
    const applied = applyFilter(cur, f, cs);
    const op = blendOp(f.blendMode);
    const alpha = Math.max(0, Math.min(1, f.opacity / 100));
    if (op === "source-over" && alpha >= 1) {
      cur = applied;
      continue;
    }
    // Blend the filtered result back over the pre-filter pixels. This used to go
    // through an OffscreenCanvas at globalAlpha, which is exactly what made the
    // worker's output differ from the engine's by 1: the two canvas kinds round
    // the composite differently, and neither rounds it correctly. See
    // app/lib/blend.ts. `applied` is a fresh buffer, so blending into it is safe
    // (`cur` is not — `base` aliases it).
    blendInto(applied.data, cur.data, applied.data, op, alpha);
    cur = applied;
  }

  // Filter mask: result = orig + (filtered − orig) × mask, premultiplied
  // (identical to the engine's renderFiltered tail).
  if (base && cur !== base && m.fm) {
    const mask = new Uint8ClampedArray(m.fm);
    const a = base.data;
    const b = cur.data;
    for (let i = 0; i < b.length; i += 4) {
      const t = mask[i + 3] / 255;
      if (t >= 1) continue;
      const aa = a[i + 3];
      const ba = b[i + 3];
      const na = aa + (ba - aa) * t;
      const inv = na > 0 ? 1 / na : 0;
      b[i] = (a[i] * aa * (1 - t) + b[i] * ba * t) * inv;
      b[i + 1] = (a[i + 1] * aa * (1 - t) + b[i + 1] * ba * t) * inv;
      b[i + 2] = (a[i + 2] * aa * (1 - t) + b[i + 2] * ba * t) * inv;
      b[i + 3] = na;
    }
  }

  const buf = cur.data.buffer;
  self.postMessage({ id: m.id, nodeId: m.nodeId, key: m.key, w, h, data: buf }, [buf]);
};
