/**
 * How much memory and how many pixels this device should be asked for.
 *
 * Four numbers were tuned on a desktop and shipped everywhere: a 256 MB render
 * cache, a 512 MB history, a 0.5 MP live-filter frame, and an overlay drawn at
 * whatever `devicePixelRatio` the screen reports — which on a phone at dpr 3 is
 * NINE times the CSS area for one canvas.
 *
 * WHY NOT `deviceMemory` ALONE, which is what the obvious reading asks for:
 *
 *   1. It does not exist on the device that needs this most. `navigator.
 *      deviceMemory` is a Chromium-only API — Safari has never shipped it — so
 *      on an iPhone it is `undefined`, and a budget derived from it alone would
 *      leave iOS on the desktop numbers.
 *   2. It reports the HOST, not the emulated device. Measured: an emulated phone
 *      profile at 390×844, dpr 3, coarse pointer, reports `deviceMemory: 32` and
 *      `hardwareConcurrency: 32` — this machine's. A budget that consulted only
 *      those would be desktop-sized on every phone the harness can produce, and
 *      therefore untestable, which for an item about a harness that can fail is
 *      the whole ballgame.
 *
 * So the DEVICE CLASS leads — a coarse pointer on a small screen is a phone, and
 * that is both true in the world and reproducible in a harness — and the
 * hardware hints REFINE it where a browser actually supplies them. A 3 GB
 * Android phone and a 12 GB one are both phones; only one of them should be
 * offered 64 MB of cache.
 *
 * Pure, so `tests/budgets.test.ts` can drive devices that do not exist here.
 */

export type DeviceClass = "phone" | "tablet" | "desktop";

export interface DeviceHints {
  /** GB of RAM, quantised by the browser. Chromium only; `undefined` elsewhere. */
  deviceMemory?: number;
  /** Logical cores. Widely available, but see the caveat above about emulation. */
  cores?: number;
  /** A finger, not a mouse. */
  coarsePointer: boolean;
  /** The phone breakpoint — the same question `data-mobile` answers. */
  smallScreen: boolean;
  /** Physical pixels per CSS pixel. */
  dpr: number;
}

export interface Budgets {
  /** LRU render-cache ceiling, in MB. */
  cacheMB: number;
  /** Undo-history ceiling, in MB. */
  historyMB: number;
  /** Pixels in one live filter frame. */
  draftPixels: number;
  /** What the screen-space overlays render at. */
  overlayDpr: number;
}

/** The desktop numbers, unchanged — every other class is a reduction of these. */
export const DESKTOP_BUDGETS: Budgets = {
  cacheMB: 256,
  historyMB: 512,
  draftPixels: 500_000,
  overlayDpr: 1,
};

/**
 * A coarse pointer is the signal, not the width alone: a small window on a
 * desktop is still a desktop, with a desktop's memory and a mouse.
 */
export function classify(h: Pick<DeviceHints, "coarsePointer" | "smallScreen">): DeviceClass {
  if (!h.coarsePointer) return "desktop";
  return h.smallScreen ? "phone" : "tablet";
}

const BY_CLASS: Record<DeviceClass, Omit<Budgets, "overlayDpr">> = {
  /* A phone tab is allowed a few hundred MB in total, and an open 12 MP photo
     already holds ~92 MB of that. 64 + 128 leaves room to actually edit. */
  phone: { cacheMB: 64, historyMB: 128, draftPixels: 250_000 },
  /* A tablet has more of everything and a screen worth filling, but it is still
     a mobile memory budget and still a finger. */
  tablet: { cacheMB: 128, historyMB: 256, draftPixels: 350_000 },
  desktop: {
    cacheMB: DESKTOP_BUDGETS.cacheMB,
    historyMB: DESKTOP_BUDGETS.historyMB,
    draftPixels: DESKTOP_BUDGETS.draftPixels,
  },
};

/**
 * The overlays draw in screen space, so their cost is the viewport times dpr
 * squared: at dpr 3 a 390×844 viewport is 2.96 MP of overlay for 0.33 MP of
 * screen. Two is where the returns stop — the ants are a 1px dashed line and
 * the grid a 1px rule, and neither reads differently at 3× — so it is the cap.
 *
 * A cap, not a constant: a dpr-1 display must not be scaled UP to 2.
 */
export const MAX_OVERLAY_DPR = 2;

export function overlayDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, MAX_OVERLAY_DPR);
}

/**
 * What this device should be asked for.
 *
 * The class sets the shape; the hardware hints only ever make it SMALLER. A
 * browser that lies about its memory, or does not say, can never talk this into
 * spending more than its class allows — which is the safe direction to be wrong
 * in, and the direction an unknown device should default to.
 */
export function deriveBudgets(h: DeviceHints): Budgets {
  const cls = classify(h);
  const base = BY_CLASS[cls];
  let { cacheMB, historyMB, draftPixels } = base;

  /* Chromium quantises `deviceMemory` to 0.25/0.5/1/2/4/8 and caps it at 8, so
     the interesting comparison is "4 or less", not a ratio. A 2 GB Android
     phone and a 2 GB Chromebook both want half of what their class assumes. */
  if (typeof h.deviceMemory === "number" && h.deviceMemory > 0 && h.deviceMemory <= 4) {
    const share = h.deviceMemory <= 2 ? 0.25 : 0.5;
    cacheMB = Math.max(32, Math.round(cacheMB * share));
    historyMB = Math.max(64, Math.round(historyMB * share));
  }

  /* A live filter frame is CPU-bound — the comment on the original constant
     puts a gaussian at roughly 100 MP/s — so cores, not memory, is what should
     shrink it. */
  if (typeof h.cores === "number" && h.cores > 0 && h.cores <= 4) {
    draftPixels = Math.min(draftPixels, 250_000);
  }

  return { cacheMB, historyMB, draftPixels, overlayDpr: overlayDpr(h.dpr) };
}

/** Read the hints this browser will admit to. Safe to call anywhere. */
export function readDeviceHints(): DeviceHints {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    /* Server render: nothing to measure, and the desktop shape is the one that
       must not change. */
    return { coarsePointer: false, smallScreen: false, dpr: 1 };
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mq = (q: string) => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  return {
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
    coarsePointer: mq("(pointer: coarse) and (hover: none)"),
    /* The same bounds as MOBILE_QUERY in lib/breakpoint — stated here rather
       than imported so a budget never depends on a layout module. */
    smallScreen: mq("(max-width: 600px), (max-height: 500px)"),
    dpr: window.devicePixelRatio || 1,
  };
}

/** This device's budgets, worked out once. */
let cached: Budgets | null = null;

export function budgets(): Budgets {
  if (!cached) cached = deriveBudgets(readDeviceHints());
  return cached;
}

/** Tests only. */
export function resetBudgets(): void {
  cached = null;
}
