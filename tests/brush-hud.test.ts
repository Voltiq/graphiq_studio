import { describe, expect, it } from "vitest";

import {
  HUD_HARDNESS_SPAN,
  HUD_SIZE_MAX,
  HUD_SIZE_MIN,
  HUD_TOOLS,
  hudAlphaAt,
  hudHardness,
  hudHasHardness,
  hudReadout,
  hudSize,
  hudSupports,
} from "@/app/lib/brush-hud";

describe("which tools take the HUD", () => {
  it("covers every ring-cursor tool", () => {
    for (const t of [
      "brush",
      "pencil",
      "eraser",
      "heal",
      "clone",
      "blur",
      "smudge",
      "mixer",
      "dodge",
      "sponge",
      "history",
      "quickselect",
      "redeye",
    ])
      expect(hudSupports(t)).toBe(true);
  });

  it("leaves tools with no brush alone", () => {
    for (const t of ["move", "marquee", "lasso", "text", "gradient", "crop", "pen", "frame", "zoom"])
      expect(hudSupports(t)).toBe(false);
  });

  it("offers hardness only where there is a soft edge to set", () => {
    expect(hudHasHardness("brush")).toBe(true);
    expect(hudHasHardness("eraser")).toBe(true);
    // Hard by definition — the options bar has no Hardness slider for these.
    expect(hudHasHardness("pencil")).toBe(false);
    expect(hudHasHardness("quickselect")).toBe(false);
    expect(hudHasHardness("redeye")).toBe(false);
  });

  it("cannot claim hardness for a tool it does not drive at all", () => {
    for (const t of Object.keys(HUD_TOOLS)) if (hudHasHardness(t)) expect(hudSupports(t)).toBe(true);
    expect(hudHasHardness("move")).toBe(false);
  });

  it("is not fooled by inherited object properties", () => {
    expect(hudSupports("constructor")).toBe(false);
    expect(hudSupports("toString")).toBe(false);
    expect(hudHasHardness("hasOwnProperty")).toBe(false);
  });
});

describe("horizontal travel → size", () => {
  it("grows to the right and shrinks to the left", () => {
    expect(hudSize(40, 30, 1)).toBe(70);
    expect(hudSize(40, -30, 1)).toBe(10);
  });

  it("does nothing at zero travel, whatever the zoom", () => {
    for (const z of [0.1, 0.5, 1, 4, 32]) expect(hudSize(40, 0, z)).toBe(40);
  });

  /* The point of dividing by the zoom: the same drag must move the ring the
     same distance ON SCREEN at every zoom. A 100 px drag has to add 100 px of
     screen diameter whether that is 100 document px at 100% or 25 at 400%.
     The only slack is the rounding to whole document pixels, which is worth at
     most half a document pixel — half a zoom step on screen. */
  it("moves the ring the same distance on screen at every zoom", () => {
    for (const z of [0.25, 0.5, 1, 2, 4, 8]) {
      const size = hudSize(40, 100, z);
      const screenGrowth = (size - 40) * z;
      expect(Math.abs(screenGrowth - 100)).toBeLessThanOrEqual(z / 2 + 1e-9);
    }
  });

  /* The mistake this rules out: feeding screen px straight in as document px.
     That still passes "grows to the right", but the ring would crawl when
     zoomed in and bolt away when zoomed out. */
  it("does NOT treat screen travel as document travel", () => {
    expect(hudSize(40, 100, 4)).toBe(65);
    expect(hudSize(40, 100, 4)).not.toBe(hudSize(40, 100, 1));
  });

  it("clamps to the same range as the options-bar slider", () => {
    expect(hudSize(400, 5000, 1)).toBe(HUD_SIZE_MAX);
    expect(hudSize(20, -5000, 1)).toBe(HUD_SIZE_MIN);
    expect(hudSize(1, -1, 1)).toBe(HUD_SIZE_MIN);
  });

  it("returns whole pixels — a brush is not 40.7 px wide", () => {
    for (const dx of [1, 3, 7, 13, 99]) expect(Number.isInteger(hudSize(40, dx, 3))).toBe(true);
  });

  it("survives a degenerate scale instead of returning NaN", () => {
    for (const z of [0, -1, NaN, Infinity]) expect(hudSize(40, 30, z)).toBe(70);
    expect(hudSize(NaN, 30, 1)).toBe(31);
    expect(hudSize(40, NaN, 1)).toBe(40);
  });
});

describe("vertical travel → hardness", () => {
  it("hardens upward and softens downward", () => {
    expect(hudHardness(50, -HUD_HARDNESS_SPAN / 2)).toBe(100);
    expect(hudHardness(50, HUD_HARDNESS_SPAN / 2)).toBe(0);
  });

  it("takes a full span to sweep the whole range", () => {
    expect(hudHardness(0, -HUD_HARDNESS_SPAN)).toBe(100);
    expect(hudHardness(100, HUD_HARDNESS_SPAN)).toBe(0);
    expect(hudHardness(50, -HUD_HARDNESS_SPAN / 4)).toBe(75);
  });

  it("does NOT scale with zoom — a percentage has no length to keep step with", () => {
    // Same gesture, and the only argument that could carry zoom is not there.
    expect(hudHardness(50, -50)).toBe(75);
    expect(hudHardness.length).toBe(2);
  });

  it("clamps to 0–100", () => {
    expect(hudHardness(50, -9999)).toBe(100);
    expect(hudHardness(50, 9999)).toBe(0);
  });

  it("survives non-finite input", () => {
    expect(hudHardness(50, NaN)).toBe(50);
    expect(hudHardness(NaN, 0)).toBe(100);
  });
});

describe("the preview profile", () => {
  it("is solid at the centre and empty at the rim", () => {
    for (const h of [0, 25, 50, 75, 100]) {
      expect(hudAlphaAt(0, h)).toBe(1);
      expect(hudAlphaAt(1, h)).toBe(0);
      expect(hudAlphaAt(1.5, h)).toBe(0);
    }
  });

  it("keeps a solid core out to the hardness radius, then ramps", () => {
    // Hardness 40 → solid to 0.4 r, then a straight line to nothing at the rim.
    expect(hudAlphaAt(0.2, 40)).toBe(1);
    expect(hudAlphaAt(0.4, 40)).toBe(1);
    expect(hudAlphaAt(0.7, 40)).toBeCloseTo(0.5, 6);
    expect(hudAlphaAt(0.9, 40)).toBeCloseTo(1 / 6, 6);
  });

  it("ramps LINEARLY — the midpoint of the falloff band is exactly half", () => {
    for (const h of [0, 20, 50, 80]) {
      const inner = h / 100;
      const mid = inner + (1 - inner) / 2;
      expect(hudAlphaAt(mid, h)).toBeCloseTo(0.5, 6);
      const quarter = inner + (1 - inner) / 4;
      expect(hudAlphaAt(quarter, h)).toBeCloseTo(0.75, 6);
    }
  });

  it("is a flat disc at hardness 100 — which is the tip the engine switches to", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 0.99]) expect(hudAlphaAt(t, 100)).toBe(1);
    expect(hudAlphaAt(1, 100)).toBe(0);
    // Right up to the rim. buildSoftTip caps its core at 0.999 of the radius,
    // which would leave a hairline ramp here — but the engine never runs that
    // path at hardness 100, it stamps the aliased hard tip instead. Sampling
    // only as far as 0.99 would not tell the two apart.
    expect(hudAlphaAt(0.9995, 100)).toBe(1);
    expect(hudAlphaAt(0.99999, 100)).toBe(1);
  });

  it("is a pure cone at hardness 0 — no core at all", () => {
    expect(hudAlphaAt(0.25, 0)).toBeCloseTo(0.75, 6);
    expect(hudAlphaAt(0.5, 0)).toBeCloseTo(0.5, 6);
    expect(hudAlphaAt(0.75, 0)).toBeCloseTo(0.25, 6);
  });

  it("never increases with distance, at any hardness", () => {
    for (const h of [0, 10, 33, 50, 67, 90, 99, 100]) {
      let prev = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const a = hudAlphaAt(t, h);
        expect(a).toBeLessThanOrEqual(prev + 1e-9);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        prev = a;
      }
    }
  });

  it("gets harder as hardness rises — at a fixed radius, coverage only grows", () => {
    for (const t of [0.3, 0.5, 0.7, 0.9]) {
      let prev = -Infinity;
      for (const h of [0, 20, 40, 60, 80, 100]) {
        const a = hudAlphaAt(t, h);
        expect(a).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = a;
      }
    }
  });

  it("clamps a nonsense hardness rather than inverting the profile", () => {
    expect(hudAlphaAt(0.5, -50)).toBeCloseTo(hudAlphaAt(0.5, 0), 6);
    expect(hudAlphaAt(0.5, 900)).toBe(1);
    expect(hudAlphaAt(0.5, NaN)).toBe(1);
  });
});

describe("the readout", () => {
  it("names both numbers when there are two", () => {
    expect(hudReadout(48, 65)).toBe("Size 48 px · Hardness 65%");
  });

  it("drops hardness entirely for the tools that have none", () => {
    expect(hudReadout(48, null)).toBe("Size 48 px");
    expect(hudReadout(48, null)).not.toMatch(/hardness/i);
  });

  it("shows whole numbers", () => {
    expect(hudReadout(48.6, 64.4)).toBe("Size 49 px · Hardness 64%");
  });

  it("still reads correctly at the ends of the range", () => {
    expect(hudReadout(HUD_SIZE_MIN, 0)).toBe("Size 1 px · Hardness 0%");
    expect(hudReadout(HUD_SIZE_MAX, 100)).toBe("Size 500 px · Hardness 100%");
  });
});
