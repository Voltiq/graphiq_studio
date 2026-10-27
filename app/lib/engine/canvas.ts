// The canvas allocator the engine and its parts share (TODO 1.6): every buffer
// is made here, and the big ones are checked for the silent failure below.

import { sentinelPasses } from "../canvas-ceiling";

/**
 * Running out of canvas memory is not an error anywhere. WebKit hands back a
 * canvas that draws, composites and reads — as transparent black, for ever. The
 * user does not see "your device ran out of room"; they see the photo they just
 * opened turn into nothing, which reads as this app having destroyed it.
 *
 * So every allocation big enough to be the one that fails is checked with a
 * sentinel: a pixel written and read back at the far corner. That cannot be
 * skipped or made read-only — an empty canvas and a dead canvas read identically
 * (see `sentinelPasses`).
 *
 * WHY THERE IS A THRESHOLD, measured rather than assumed. The sentinel costs
 * 0.7–0.8ms whatever the canvas size: it is a GPU→CPU readback stall, not work
 * proportional to pixels. And a census of a real session — boot, a 4000×3000
 * document, a brush stroke — found 27 allocations, of which 20 were under a
 * quarter of a megapixel and 4 were over four. Checking everything would spend
 * most of its time on canvases that could never be the one to exhaust memory;
 * checking only the large ones costs about 3ms per document and covers every
 * allocation that could produce a blank photograph.
 *
 * The accepted limit, stated plainly: a failure below the threshold goes
 * undetected. A device that cannot allocate 4 MB has already lost the tab.
 */
const SENTINEL_MIN_PIXELS = 1_048_576;

type CanvasFailure = { w: number; h: number };
let onCanvasFailure: ((f: CanvasFailure) => void) | null = null;

/**
 * Where to report an allocation that came back dead.
 *
 * Module-level rather than a constructor argument because `makeCanvas` is a free
 * function used by the engine, its workers' helpers and the paths that build
 * scratch buffers — there is no single instance to hang it off.
 */
export function setCanvasFailureHandler(fn: ((f: CanvasFailure) => void) | null): void {
  onCanvasFailure = fn;
}

/** Reported once. Fifty dead buffers are one event, not fifty. */
let reportedFailure = false;

/** Tests only. */
export function resetCanvasFailureReport(): void {
  reportedFailure = false;
}

/** True if the canvas is real. Reports the first failure it sees. */
export function checkAllocation(
  ctx: CanvasRenderingContext2D | null,
  w: number,
  h: number,
): boolean {
  if (!ctx) return false;
  if (w * h < SENTINEL_MIN_PIXELS) return true;
  if (sentinelPasses(ctx, w, h)) return true;
  if (!reportedFailure) {
    reportedFailure = true;
    onCanvasFailure?.({ w, h });
  }
  return false;
}

export const makeCanvas = (
  w: number,
  h: number,
  readFreq = false,
  colorSpace: PredefinedColorSpace = "srgb",
) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: readFreq, colorSpace })!;
  checkAllocation(ctx, w, h);
  return { c, ctx };
};
