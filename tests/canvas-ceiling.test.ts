import { beforeEach, describe, expect, it } from "vitest";
import {
  ceilingWithSide,
  sentinelPasses,
  checkSize,
  probeMaxSide,
  refusalMessage,
  resetSharedCeiling,
  settle,
  verdict,
  type Ceiling,
  type Probe,
} from "../app/lib/canvas-ceiling";

/**
 * A browser with limits of our choosing, that also counts how often it was
 * asked. The count matters as much as the answers: the whole design rests on
 * never paying for a question twice, and on not asking at all when the cheap
 * facts already settle it.
 */
function fakeProbe(maxSide: number, maxArea: number) {
  const p = {
    calls: [] as [number, number][],
    holds(w: number, h: number) {
      p.calls.push([w, h]);
      return w >= 1 && h >= 1 && w <= maxSide && h <= maxSide && w * h <= maxArea;
    },
  };
  return p as Probe & { calls: [number, number][] };
}

const CHROMIUM = () => fakeProbe(65535, 268435456);

describe("probing the side limit", () => {
  it("finds it exactly", () => {
    expect(probeMaxSide(fakeProbe(65535, 1e12))).toBe(65535);
    expect(probeMaxSide(fakeProbe(4096, 1e12))).toBe(4096);
  });

  /* The point of searching with a height of 1: no trial can be large. */
  it("never asks for anything taller than one pixel", () => {
    const p = fakeProbe(65535, 1e12);
    probeMaxSide(p);
    expect(p.calls.every(([, h]) => h === 1)).toBe(true);
  });

  it("takes a logarithmic number of tries, not a linear one", () => {
    const p = fakeProbe(65535, 1e12);
    probeMaxSide(p);
    expect(p.calls.length).toBeLessThan(40);
  });

  /* A browser that cannot make a 1×1 canvas is not a browser with a limit of
     zero — reporting one would refuse every document forever. */
  it("reports 'unknown' rather than zero when even 1×1 fails", () => {
    expect(probeMaxSide(fakeProbe(0, 0))).toBe(0);
    expect(verdict(100, 100, ceilingWithSide(0))).toBe("unproven");
  });
});

describe("what can be said for free", () => {
  const c = ceilingWithSide(65535);

  it("refuses a side over the limit without touching the browser", () => {
    expect(verdict(70000, 100, c)).toBe("too-wide");
    expect(verdict(100, 70000, c)).toBe("too-tall");
  });

  it("passes the size that is exactly the limit", () => {
    expect(verdict(65535, 1, c)).not.toBe("too-wide");
  });

  it("refuses one pixel over the limit", () => {
    expect(verdict(65536, 1, c)).toBe("too-wide");
  });

  it("will not call a size good on a hunch", () => {
    expect(verdict(4000, 3000, c)).toBe("unproven");
  });

  it("rejects sizes that are not sizes", () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-5, 5],
      [NaN, 10],
      [Infinity, 10],
    ])
      expect(verdict(w, h, c)).toBe("empty");
  });
});

describe("settling a size", () => {
  let c: Ceiling;
  beforeEach(() => {
    c = ceilingWithSide(65535);
  });

  it("does not ask the browser when the sides already decide it", () => {
    const p = CHROMIUM();
    const r = settle(70000, 100, c, p);
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("too-wide");
    expect(p.calls).toEqual([]);
  });

  it("asks once for a size it cannot settle, and remembers a pass", () => {
    const p = CHROMIUM();
    const first = settle(4000, 3000, c, p);
    expect(first.ok).toBe(true);
    expect(p.calls).toHaveLength(1);
    /* Same size again, and anything smaller, is now free. */
    expect(settle(4000, 3000, first.ceiling, p).ok).toBe(true);
    expect(settle(1000, 1000, first.ceiling, p).ok).toBe(true);
    expect(p.calls).toHaveLength(1);
  });

  it("…and remembers a failure just as hard", () => {
    const p = CHROMIUM();
    const first = settle(16384, 16385, c, p);
    expect(first.ok).toBe(false);
    expect(first.verdict).toBe("too-many-pixels");
    expect(p.calls).toHaveLength(1);
    /* Anything at least that big is refused for free from here on. */
    expect(settle(16384, 16385, first.ceiling, p).ok).toBe(false);
    expect(settle(20000, 20000, first.ceiling, p).ok).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  /* Knowledge only narrows: a proven-good area never shrinks and a proven-bad
     area never grows, whatever order the questions arrive in. */
  it("keeps its bounds monotone whatever the order", () => {
    const p = CHROMIUM();
    let cc = c;
    for (const [w, h] of [
      [1000, 1000],
      [20000, 20000],
      [4000, 3000],
      [30000, 30000],
      [100, 100],
    ] as [number, number][]) {
      const before = cc;
      cc = settle(w, h, cc, p).ceiling;
      expect(cc.provenArea).toBeGreaterThanOrEqual(before.provenArea);
      expect(cc.refusedArea).toBeLessThanOrEqual(before.refusedArea);
    }
    expect(cc.provenArea).toBeLessThan(cc.refusedArea);
  });

  it("agrees with the browser it is standing in front of", () => {
    const p = fakeProbe(65535, 268435456);
    let cc = ceilingWithSide(probeMaxSide(p));
    for (const [w, h, want] of [
      [16384, 16384, true],
      [16385, 16384, false],
      [65535, 1, true],
      [65536, 1, false],
      [8192, 8192, true],
    ] as [number, number, boolean][]) {
      const r = settle(w, h, cc, p);
      cc = r.ceiling;
      expect([w, h, r.ok]).toEqual([w, h, want]);
    }
  });
});

describe("what the user is told", () => {
  const c = ceilingWithSide(65535);

  it("names the size and the limit, not just 'too big'", () => {
    const m = refusalMessage(70000, 100, "too-wide", c);
    expect(m).toContain("70,000 × 100");
    expect(m).toContain("65,535");
    expect(m).toContain("blank");
  });

  it("names the pixel count when it is the area that failed", () => {
    const m = refusalMessage(20000, 20000, "too-many-pixels", c);
    expect(m).toContain("400,000,000");
  });

  it("says nothing when there is nothing wrong", () => {
    expect(refusalMessage(100, 100, "ok", c)).toBe("");
  });

  it("can speak about something other than an image", () => {
    expect(refusalMessage(70000, 1, "too-wide", c, "document")).toContain("document");
  });
});

describe("the shared ceiling", () => {
  beforeEach(resetSharedCeiling);

  it("probes once and then answers from memory", () => {
    const p = CHROMIUM();
    checkSize(4000, 3000, { probe: p });
    const afterFirst = p.calls.length;
    checkSize(4000, 3000, { probe: p });
    checkSize(70000, 100, { probe: p });
    expect(p.calls.length).toBe(afterFirst);
  });

  it("refuses with a message a person can act on", () => {
    const r = checkSize(70000, 100, { probe: CHROMIUM() });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("65,535");
  });

  it("passes an ordinary photo without complaint", () => {
    const r = checkSize(4000, 3000, { probe: CHROMIUM() });
    expect(r.ok).toBe(true);
    expect(r.message).toBe("");
  });
});

/**
 * A context that really stores what is written to it, so the sentinel can be
 * driven without a browser. `dead` is the failure this exists for: every read
 * comes back transparent black however much is drawn — which is exactly what a
 * canvas whose backing store was never allocated does.
 */
function fakeCtx({ dead = false, throwOnRead = false } = {}) {
  const store = new Map<string, Uint8ClampedArray>();
  const key = (x: number, y: number) => `${x},${y}`;
  let fill = "#000000";
  const ctx = {
    saved: 0,
    restored: 0,
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: string) {
      fill = v;
    },
    globalCompositeOperation: "source-over",
    save() {
      ctx.saved++;
    },
    restore() {
      ctx.restored++;
    },
    fillRect(x: number, y: number) {
      store.set(key(x, y), new Uint8ClampedArray([255, 0, 0, 255]));
    },
    getImageData(x: number, y: number) {
      if (throwOnRead) throw new Error("out of memory");
      const px = dead ? new Uint8ClampedArray([0, 0, 0, 0]) : (store.get(key(x, y)) ?? new Uint8ClampedArray(4));
      return { data: px } as ImageData;
    },
    putImageData(img: ImageData, x: number, y: number) {
      store.set(key(x, y), img.data as Uint8ClampedArray);
    },
    peek: (x: number, y: number) => store.get(key(x, y)),
  };
  return ctx as unknown as CanvasRenderingContext2D & typeof ctx;
}

describe("the allocation sentinel", () => {
  it("passes on a canvas that really holds pixels", () => {
    expect(sentinelPasses(fakeCtx(), 100, 100)).toBe(true);
  });

  /* The whole point: a dead canvas is indistinguishable from an empty one by
     reading alone, so the sentinel writes first. */
  it("fails on a canvas that reads back transparent whatever is drawn", () => {
    expect(sentinelPasses(fakeCtx({ dead: true }), 100, 100)).toBe(false);
  });

  it("treats a throw as a failure rather than letting it escape", () => {
    expect(() => sentinelPasses(fakeCtx({ throwOnRead: true }), 100, 100)).not.toThrow();
    expect(sentinelPasses(fakeCtx({ throwOnRead: true }), 100, 100)).toBe(false);
  });

  it("puts back whatever pixel it borrowed", () => {
    const g = fakeCtx();
    const artwork = new Uint8ClampedArray([9, 8, 7, 255]);
    g.putImageData({ data: artwork } as ImageData, 99, 99);
    expect(sentinelPasses(g, 100, 100)).toBe(true);
    expect(Array.from(g.peek(99, 99) ?? [])).toEqual([9, 8, 7, 255]);
  });

  /* A browser that CLAMPS an over-large canvas rather than failing reports the
     clamped size, and a read past the end comes back as zeros rather than
     throwing — so the far corner catches a buffer that came back smaller than
     asked for, where the origin would happily pass. */
  it("checks the far corner, which is the pixel a short buffer would not have", () => {
    const g = fakeCtx();
    sentinelPasses(g, 640, 480);
    expect(g.peek(639, 479)).toBeDefined();
    expect(g.peek(0, 0)).toBeUndefined();
  });

  /* `copy` so the probe is not fooled by a canvas that ignores blending, and
     save/restore so the caller's state survives. */
  it("leaves the context state as it found it", () => {
    const g = fakeCtx();
    sentinelPasses(g, 10, 10);
    expect(g.saved).toBe(1);
    expect(g.restored).toBe(1);
  });
});
