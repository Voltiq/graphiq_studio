import { describe, expect, it } from "vitest";
import {
  classify,
  DESKTOP_BUDGETS,
  deriveBudgets,
  MAX_OVERLAY_DPR,
  overlayDpr,
  type DeviceHints,
} from "../app/lib/budgets";

/**
 * Devices this machine is not. The point of a pure derivation is that a 2 GB
 * Android phone and an iPad can be driven here, where no harness can produce
 * them — an emulated phone reports the HOST's 32 GB and 32 cores, which is
 * exactly why the class leads and the hardware hints only refine.
 */
const hints = (over: Partial<DeviceHints> = {}): DeviceHints => ({
  coarsePointer: false,
  smallScreen: false,
  dpr: 1,
  ...over,
});

const PHONE = hints({ coarsePointer: true, smallScreen: true, dpr: 3 });
const TABLET = hints({ coarsePointer: true, smallScreen: false, dpr: 2 });
const DESKTOP = hints({ dpr: 1, deviceMemory: 32, cores: 32 });

describe("what kind of device this is", () => {
  it("calls a coarse pointer on a small screen a phone", () => {
    expect(classify(PHONE)).toBe("phone");
  });

  it("calls a coarse pointer on a large screen a tablet", () => {
    expect(classify(TABLET)).toBe("tablet");
  });

  /* The signal is the pointer, not the width: a narrow window on a desktop
     still has a desktop's memory and a mouse. */
  it("does not call a narrow desktop window a phone", () => {
    expect(classify(hints({ coarsePointer: false, smallScreen: true }))).toBe("desktop");
  });
});

describe("the budgets each class gets", () => {
  it("leaves the desktop exactly as it was", () => {
    const b = deriveBudgets(DESKTOP);
    expect(b.cacheMB).toBe(DESKTOP_BUDGETS.cacheMB);
    expect(b.historyMB).toBe(DESKTOP_BUDGETS.historyMB);
    expect(b.draftPixels).toBe(DESKTOP_BUDGETS.draftPixels);
  });

  /* The number the item names. */
  it("gives a phone no more than 64 MB of cache", () => {
    expect(deriveBudgets(PHONE).cacheMB).toBeLessThanOrEqual(64);
  });

  it("puts a tablet between the two, not at either end", () => {
    const t = deriveBudgets(TABLET);
    const p = deriveBudgets(PHONE);
    expect(t.cacheMB).toBeGreaterThan(p.cacheMB);
    expect(t.cacheMB).toBeLessThan(DESKTOP_BUDGETS.cacheMB);
  });

  it("shrinks every budget as the device gets smaller", () => {
    const [p, t, d] = [PHONE, TABLET, DESKTOP].map(deriveBudgets);
    for (const k of ["cacheMB", "historyMB", "draftPixels"] as const) {
      expect(p[k]).toBeLessThanOrEqual(t[k]);
      expect(t[k]).toBeLessThanOrEqual(d[k]);
    }
  });
});

describe("what the hardware hints are allowed to do", () => {
  /* The safe direction to be wrong in: a browser that lies about its memory, or
     stays silent, can never talk the app into spending MORE than its class. */
  it("never raises a budget above its class", () => {
    for (const mem of [undefined, 0.25, 1, 2, 4, 8, 32, 1024]) {
      for (const cores of [undefined, 1, 2, 8, 64]) {
        const b = deriveBudgets({ ...PHONE, deviceMemory: mem, cores });
        expect(b.cacheMB).toBeLessThanOrEqual(64);
        expect(b.historyMB).toBeLessThanOrEqual(128);
        expect(b.draftPixels).toBeLessThanOrEqual(250_000);
      }
    }
  });

  it("halves a small-memory device again", () => {
    const plenty = deriveBudgets({ ...PHONE, deviceMemory: 8 });
    const little = deriveBudgets({ ...PHONE, deviceMemory: 2 });
    expect(little.cacheMB).toBeLessThan(plenty.cacheMB);
    expect(little.historyMB).toBeLessThan(plenty.historyMB);
  });

  it("…but never below a floor that would make the cache pointless", () => {
    const b = deriveBudgets({ ...PHONE, deviceMemory: 0.25 });
    expect(b.cacheMB).toBeGreaterThanOrEqual(32);
    expect(b.historyMB).toBeGreaterThanOrEqual(64);
  });

  /* A live filter frame is CPU-bound, so cores shrink it and memory does not. */
  it("lets few cores shrink the filter frame", () => {
    expect(deriveBudgets({ ...DESKTOP, cores: 2 }).draftPixels).toBeLessThan(
      DESKTOP_BUDGETS.draftPixels,
    );
  });

  it("treats an absent deviceMemory as no information, not as zero", () => {
    const unknown = deriveBudgets({ ...PHONE, deviceMemory: undefined });
    const known = deriveBudgets({ ...PHONE, deviceMemory: 8 });
    expect(unknown.cacheMB).toBe(known.cacheMB);
  });

  /* Safari ships no `deviceMemory` at all, so an iPhone arrives with nothing but
     its class — and must still get a phone's budget rather than a desktop's. */
  it("gives an iPhone a phone's budget with no hardware hints at all", () => {
    const iphone = deriveBudgets({ coarsePointer: true, smallScreen: true, dpr: 3 });
    expect(iphone.cacheMB).toBeLessThanOrEqual(64);
    expect(iphone.historyMB).toBeLessThanOrEqual(128);
  });
});

describe("the overlay pixel ratio", () => {
  it("caps at 2, where a 1px dashed line stops improving", () => {
    expect(overlayDpr(3)).toBe(MAX_OVERLAY_DPR);
    expect(overlayDpr(4)).toBe(MAX_OVERLAY_DPR);
  });

  /* A cap, not a constant: never scale a 1× display up. */
  it("leaves a lower ratio alone", () => {
    expect(overlayDpr(1)).toBe(1);
    expect(overlayDpr(1.5)).toBe(1.5);
  });

  it("survives a browser that reports nonsense", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(overlayDpr(bad)).toBe(1);
  });

  /* The saving, stated as the reason it exists: area goes as the square. */
  it("cuts the overlay's area by more than half at dpr 3", () => {
    const before = 3 ** 2;
    const after = overlayDpr(3) ** 2;
    expect(after / before).toBeLessThan(0.5);
  });
});
