/// <reference lib="webworker" />
// Blur Gallery compute worker: runs the pure computeBlurFx kernel off the UI
// thread so slider drags stay responsive on large documents.
//
// Protocol (one dedicated worker, sessions keyed by a counter):
//   { type: "init", session, cs, mask, layers: [{ id, w, h, data }] }
//       — the session's ORIGINAL pixels, sent once (buffers transferred).
//   { type: "render", session, seq, kind, amount, angle, ax, ay, extra }
//       — recompute every cached layer from its original; replies
//         { session, seq, results: [{ id, w, h, data }] } (transferred).
//   { type: "end", session } — free the session's buffers.
//
// The main thread drops replies whose session/seq are stale, so rapid drags
// only ever apply the newest result.

import { computeBlurFx } from "../lib/filters";

declare const self: DedicatedWorkerGlobalScope;

interface InitMsg {
  type: "init";
  session: number;
  cs: PredefinedColorSpace;
  mask: ArrayBuffer | null;
  layers: { id: string; w: number; h: number; data: ArrayBuffer }[];
}
interface RenderMsg {
  type: "render";
  session: number;
  seq: number;
  kind: string;
  amount: number;
  angle: number;
  ax: number;
  ay: number;
  extra: { band: number; feather: number; threshold: number };
}
interface EndMsg {
  type: "end";
  session: number;
}
type Msg = InitMsg | RenderMsg | EndMsg;

let session = -1;
let cs: PredefinedColorSpace = "srgb";
let mask: Uint8ClampedArray | null = null;
let layers: { id: string; img: ImageData }[] = [];

/** ImageData with a colour-space tag where supported (falls back untagged). */
function makeImage(data: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): ImageData {
  try {
    return new ImageData(data, w, h, { colorSpace: cs });
  } catch {
    return new ImageData(data, w, h);
  }
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === "init") {
    session = m.session;
    cs = m.cs;
    mask = m.mask ? new Uint8ClampedArray(m.mask) : null;
    layers = m.layers.map((l) => ({
      id: l.id,
      img: makeImage(new Uint8ClampedArray(l.data), l.w, l.h),
    }));
    return;
  }
  if (m.type === "end") {
    if (m.session === session) {
      layers = [];
      mask = null;
    }
    return;
  }
  // render
  if (m.session !== session) return; // stale session — session data already replaced
  const results: { id: string; w: number; h: number; data: ArrayBuffer }[] = [];
  const transfers: ArrayBuffer[] = [];
  for (const l of layers) {
    const cx = m.ax * l.img.width;
    const cy = m.ay * l.img.height;
    const out = computeBlurFx(l.img, m.kind, m.amount, m.angle, mask, cx, cy, cs, m.extra);
    results.push({ id: l.id, w: out.width, h: out.height, data: out.data.buffer });
    transfers.push(out.data.buffer);
  }
  self.postMessage({ session: m.session, seq: m.seq, results }, transfers);
};
