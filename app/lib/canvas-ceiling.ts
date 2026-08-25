/**
 * What size of canvas this browser will actually hold — and how to find out
 * without paying for the answer.
 *
 * A 2D canvas has two hard structural limits: a maximum length for either side,
 * and a maximum total area. Past either one the browser does not throw, does not
 * warn, and does not clamp. It reports the size you asked for, hands back a
 * working context, accepts every drawing call, and `getImageData` succeeds —
 * returning zeros. Measured on Chromium 151:
 *
 *     70000×100   c.width = 70000   getContext ok   fillRect ok   pixels: 0
 *
 * That is why a 20 KB image file could open as a document with two canvases,
 * a tab, a name, and not one pixel in it, with an empty console. The user sees
 * an app that ate their photo.
 *
 * THE COST OF ASKING, measured, because it decides the whole design:
 *
 *   - Asking about a size that is TOO BIG costs ~0.3ms and allocates nothing.
 *     The browser rejects the backing store outright, so the probe is free
 *     exactly in the case that matters.
 *   - Asking about a size that FITS costs a real allocation: probing the top of
 *     the range on this machine took 212ms and a transient 1 GB.
 *
 * So the ceiling is established in two different ways, on purpose:
 *
 *   MAX SIDE is probed once, at boot, by binary search with a height of 1. Every
 *   trial is at most 65535×1 — 256 KB — and the whole search took 1.5ms. Cheap,
 *   exact, and on its own it catches the 70000×100 case.
 *
 *   MAX AREA is NOT probed at boot. Finding it requires one successful
 *   allocation the size of the ceiling, which is the single most expensive thing
 *   this file could do, and on a phone it is plausibly the allocation that kills
 *   the tab. Instead the exact size being proposed is tested at the moment it is
 *   proposed — free when it fails, and when it passes it costs no more than the
 *   document was about to cost anyway. What is learned is remembered, so the
 *   same question is never paid for twice.
 *
 * Everything here is injectable so `tests/canvas-ceiling.test.ts` can drive
 * limits no real browser would have.
 */

/** Somewhere a canvas can be made and a pixel checked for survival. */
export interface Probe {
  /** True only if a pixel written at the far corner reads back intact. */
  holds(w: number, h: number): boolean;
}

export type Verdict =
  | "ok"
  | "empty"
  | "too-wide"
  | "too-tall"
  | "too-many-pixels"
  /** Within the known-good side limits, but the area has not been settled. */
  | "unproven";

export interface Ceiling {
  /** Longest side the browser honours. 0 until probed. */
  maxSide: number;
  /** Largest area proven to work, in pixels. */
  provenArea: number;
  /** Smallest area proven NOT to work. `Infinity` until one is found. */
  refusedArea: number;
}

export const UNPROBED: Ceiling = { maxSide: 0, provenArea: 0, refusedArea: Infinity };

/** A fresh ceiling with a known side limit and nothing yet learned about area. */
export function ceilingWithSide(maxSide: number): Ceiling {
  return { maxSide, provenArea: 0, refusedArea: Infinity };
}

/**
 * What we can say about a size WITHOUT touching the browser.
 *
 * `"unproven"` is not a failure — it means the cheap facts do not settle it and
 * something has to actually try. Keeping that separate from `"ok"` is what
 * stops a guess being reported as a guarantee.
 */
export function verdict(w: number, h: number, c: Ceiling): Verdict {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return "empty";
  /* Sides first: they are exact, probed, and free to check. */
  if (c.maxSide > 0 && w > c.maxSide) return "too-wide";
  if (c.maxSide > 0 && h > c.maxSide) return "too-tall";
  const area = w * h;
  if (area >= c.refusedArea) return "too-many-pixels";
  if (area <= c.provenArea) return "ok";
  return "unproven";
}

/**
 * Settle a size, testing it for real only if the cheap facts cannot.
 *
 * Returns a NEW ceiling carrying whatever was learned, so a caller that keeps it
 * never pays for the same question twice. Note which bound moves: proving a size
 * good raises `provenArea` (every smaller area is good too), proving one bad
 * lowers `refusedArea` (every larger area is bad too). Both are monotone, so the
 * knowledge only ever narrows.
 */
export function settle(
  w: number,
  h: number,
  c: Ceiling,
  probe: Probe,
): { ok: boolean; verdict: Verdict; ceiling: Ceiling } {
  const v = verdict(w, h, c);
  if (v !== "unproven") return { ok: v === "ok", verdict: v, ceiling: c };

  const area = w * h;
  const good = probe.holds(w, h);
  if (good) {
    return {
      ok: true,
      verdict: "ok",
      ceiling: { ...c, provenArea: Math.max(c.provenArea, area) },
    };
  }
  return {
    ok: false,
    verdict: "too-many-pixels",
    ceiling: { ...c, refusedArea: Math.min(c.refusedArea, area) },
  };
}

/**
 * Find the longest side the browser honours.
 *
 * Binary search with a height of 1, so the largest allocation any trial can make
 * is `hardCap × 1 × 4` bytes. `hardCap` is a search bound rather than a belief
 * about the answer: it only has to be above whatever the browser allows.
 */
export function probeMaxSide(probe: Probe, hardCap = 1 << 17): number {
  /* If even one pixel fails there is nothing to search — treat it as unknown
     rather than reporting a limit of zero, which would refuse everything. */
  if (!probe.holds(1, 1)) return 0;
  let lo = 1;
  let hi = hardCap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (probe.holds(mid, 1)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * What to tell the user. Names the size they asked for and the limit they hit,
 * because "too big" on its own gives them nothing to act on.
 */
export function refusalMessage(w: number, h: number, v: Verdict, c: Ceiling, what = "image"): string {
  const size = `${fmt(w)} × ${fmt(h)}`;
  switch (v) {
    case "empty":
      return `That ${what} has no size to open — ${size}.`;
    case "too-wide":
    case "too-tall":
      return (
        `This ${what} is ${size}, and this browser cannot hold a canvas longer than ` +
        `${fmt(c.maxSide)} pixels on a side. Opening it would give you a blank document, ` +
        `so Graphiq has not opened it.`
      );
    case "too-many-pixels":
      /* Deliberately NOT "this browser cannot". A failed allocation of a size
         within the probed side limits is ambiguous: it may be the browser's cap
         on one canvas, or the device being short of memory this minute. The
         first is permanent, the second clears when a few tabs close — and
         telling someone their browser is incapable when they simply need to
         close a document sends them away for good. The side-limit message above
         can be definite because that limit IS decided without allocating. */
      return (
        `There is not enough room for ${what === "image" ? "an image" : `a ${what}`} this ` +
        `size right now — ${size} is ${fmt(w * h)} pixels. That can be this browser's limit ` +
        `for a single image, or your device being short of memory; closing other documents ` +
        `or tabs may help. Graphiq has not opened it, because it would come out blank.`
      );
    default:
      return "";
  }
}

/**
 * Does this context's backing store actually hold a pixel?
 *
 * The ONLY way to tell. A canvas that was never allocated reads as transparent
 * black — and so does a canvas that was allocated and is simply empty, which is
 * every new canvas. So the test has to WRITE first: put a pixel at the far
 * corner, read it back, and undo it. A read-only check cannot distinguish "this
 * failed" from "this is blank", and blank is the normal case.
 *
 * The far corner rather than the origin: a browser that CLAMPS an over-large
 * canvas reports the clamped size and serves reads past the end as zeros rather
 * than throwing, so the last pixel is the one a short buffer would not have.
 *
 * Restores the pixel it borrowed, so it is safe on a canvas that already holds
 * artwork — though at allocation time, which is where this is used, there is
 * nothing there to disturb.
 */
export function sentinelPasses(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  try {
    const x = w - 1;
    const y = h - 1;
    const before = g.getImageData(x, y, 1, 1);
    g.save();
    /* NOT `globalCompositeOperation = "copy"`, which was the first thing tried
       here: `copy` replaces the WHOLE canvas with the drawn shape, clearing
       every pixel outside it. On a canvas holding artwork that is a one-line
       eraser. An opaque fill over source-over is already unambiguous. */
    g.fillStyle = "#ff0000";
    g.fillRect(x, y, 1, 1);
    const d = g.getImageData(x, y, 1, 1).data;
    g.putImageData(before, x, y);
    g.restore();
    return d[0] === 255 && d[3] === 255;
  } catch {
    /* A throw is a failure like any other. */
    return false;
  }
}

/** The real thing: a canvas, a pixel at the far corner, and a read-back. */
export const browserProbe: Probe = {
  holds(w: number, h: number): boolean {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return false;
    let c: HTMLCanvasElement | null = null;
    try {
      c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      /* Some browsers clamp instead of failing silently; either way, a size that
         did not stick is a size we did not get. */
      if (c.width !== w || c.height !== h) return false;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return false;
      return sentinelPasses(g, w, h);
    } catch {
      /* A throw is a refusal like any other — some engines do throw on
         `getImageData` for an over-large canvas. */
      return false;
    } finally {
      /* Hand the backing store back immediately. This runs on the way out of a
         successful probe too, where it is releasing the whole allocation. */
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    }
  },
};

/* ---------------------------------------------------------------- singleton */

let shared: Ceiling | null = null;

/** The app's ceiling, probed once. Cheap: sides only. */
export function sharedCeiling(probe: Probe = browserProbe): Ceiling {
  if (!shared) shared = ceilingWithSide(probeMaxSide(probe));
  return shared;
}

/** Settle a size against the shared ceiling, remembering what it learns. */
export function checkSize(
  w: number,
  h: number,
  opts: { what?: string; probe?: Probe } = {},
): { ok: boolean; verdict: Verdict; message: string } {
  const probe = opts.probe ?? browserProbe;
  const r = settle(w, h, sharedCeiling(probe), probe);
  shared = r.ceiling;
  return {
    ok: r.ok,
    verdict: r.verdict,
    message: r.ok ? "" : refusalMessage(w, h, r.verdict, r.ceiling, opts.what),
  };
}

/** Tests only: forget everything probed so far. */
export function resetSharedCeiling(): void {
  shared = null;
}
