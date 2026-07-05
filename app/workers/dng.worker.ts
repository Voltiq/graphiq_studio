/// <reference lib="webworker" />
// RAW (DNG) decode worker: the whole parse → lossless-JPEG → demosaic →
// develop pipeline is pure math, so it runs off-thread — a 24 MP raw takes
// on the order of a second, which would otherwise freeze the UI.
//
// One job per message: { buf } (transferred) → { ok, width, height, data }
// (pixels transferred back). The caller spawns a worker per decode and
// terminates it after the reply — decodes are rare and stateless.

import { decodeDNG } from "../lib/dng";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<{ buf: ArrayBuffer }>) => {
  const res = decodeDNG(e.data.buf);
  if (!res) {
    self.postMessage({ ok: false });
    return;
  }
  self.postMessage(
    { ok: true, width: res.width, height: res.height, data: res.data.buffer },
    [res.data.buffer],
  );
};
