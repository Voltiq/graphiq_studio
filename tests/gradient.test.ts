/**
 * gradient.ts — stop sampling and the CanvasGradient builder.
 *
 * `buildCanvasGradient` is usually thought of as untestable outside a browser,
 * but the context is just an injected dependency: hand it a stub that records
 * every `addColorStop`, and the whole shape of the gradient — the midpoint
 * power curve, the reflected mirror, the seam blend that makes an angle
 * gradient wrap smoothly — becomes ordinary arithmetic to check.
 */
import { describe, expect, it } from "vitest";
import { buildCanvasGradient, resolveStops, sampleGradient } from "@/app/lib/gradient";
import type { GradientStop } from "@/app/lib/tools";

/** A CanvasGradient stand-in that just records the stops it is given. */
interface Recorded {
  stops: [number, string][];
}
interface StubCalls {
  linear: number[][];
  radial: number[][];
  conic: number[][];
}

function stubCtx(conic = true) {
  const calls: StubCalls = { linear: [], radial: [], conic: [] };
  const grad = (): Recorded & CanvasGradient => {
    const rec: Recorded = { stops: [] };
    return {
      ...rec,
      addColorStop(offset: number, color: string) {
        rec.stops.push([offset, color]);
      },
    } as unknown as Recorded & CanvasGradient;
  };
  const ctx = {
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      calls.linear.push([x0, y0, x1, y1]);
      return grad();
    },
    createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
      calls.radial.push([x0, y0, r0, x1, y1, r1]);
      return grad();
    },
    ...(conic
      ? {
          createConicGradient(angle: number, x: number, y: number) {
            calls.conic.push([angle, x, y]);
            return grad();
          },
        }
      : {}),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const stopsOf = (g: CanvasGradient) => (g as unknown as Recorded).stops;
const colorAt = (g: CanvasGradient, offset: number) => {
  const hit = stopsOf(g).find(([o]) => Math.abs(o - offset) < 1e-9);
  expect(hit, `no stop recorded at ${offset}`).toBeDefined();
  return hit![1];
};

const BW: GradientStop[] = [
  { color: "#000000ff", pos: 0 },
  { color: "#ffffffff", pos: 1 },
];

describe("sampleGradient", () => {
  it("returns the end colours at and beyond the ends", () => {
    expect(sampleGradient(BW, 0)).toBe("#000000ff");
    expect(sampleGradient(BW, 1)).toBe("#ffffffff");
    expect(sampleGradient(BW, -5)).toBe("#000000ff");
    expect(sampleGradient(BW, 5)).toBe("#ffffffff");
  });

  it("interpolates linearly between two stops", () => {
    expect(sampleGradient(BW, 0.5)).toBe("#808080ff");
    expect(sampleGradient(BW, 0.25)).toBe("#404040ff");
  });

  it("interpolates alpha as well as colour", () => {
    const fade: GradientStop[] = [
      { color: "#ff0000ff", pos: 0 },
      { color: "#ff000000", pos: 1 },
    ];
    expect(sampleGradient(fade, 0)).toBe("#ff0000ff");
    expect(sampleGradient(fade, 1)).toBe("#ff000000");
    expect(sampleGradient(fade, 0.5).slice(0, 7)).toBe("#ff0000");
    expect(sampleGradient(fade, 0.5)).not.toBe(sampleGradient(fade, 0));
  });

  it("honours interior stops and their spacing", () => {
    const three: GradientStop[] = [
      { color: "#000000ff", pos: 0 },
      { color: "#ff0000ff", pos: 0.25 },
      { color: "#ffffffff", pos: 1 },
    ];
    expect(sampleGradient(three, 0.25)).toBe("#ff0000ff");
    // Halfway between the first pair is at u = 0.125, not 0.5.
    expect(sampleGradient(three, 0.125)).toBe("#800000ff");
  });

  it("clamps outside the first and last stop positions", () => {
    const inset: GradientStop[] = [
      { color: "#112233ff", pos: 0.3 },
      { color: "#445566ff", pos: 0.7 },
    ];
    expect(sampleGradient(inset, 0)).toBe("#112233ff");
    expect(sampleGradient(inset, 1)).toBe("#445566ff");
  });

  it("survives coincident stops and an empty list", () => {
    expect(sampleGradient([], 0.5)).toBe("#00000000");
    const hard: GradientStop[] = [
      { color: "#000000ff", pos: 0 },
      { color: "#ff0000ff", pos: 0.5 },
      { color: "#00ff00ff", pos: 0.5 },
      { color: "#ffffffff", pos: 1 },
    ];
    // A zero-width span must not divide by zero — it is a hard colour break.
    expect(sampleGradient(hard, 0.5)).toBe("#ff0000ff");
    expect(sampleGradient(hard, 0.75)).toBe("#80ff80ff");
  });

  it("returns a single stop's colour everywhere", () => {
    const one: GradientStop[] = [{ color: "#abcdefff", pos: 0.5 }];
    for (const u of [0, 0.5, 1]) expect(sampleGradient(one, u)).toBe("#abcdefff");
  });
});

describe("resolveStops", () => {
  it("falls back to primary → secondary", () => {
    expect(resolveStops(null, "#ff0000", "#0000ff", false)).toEqual([
      { color: "#ff0000", pos: 0 },
      { color: "#0000ff", pos: 1 },
    ]);
  });

  it("ignores a custom list too short to be a gradient", () => {
    const one: GradientStop[] = [{ color: "#123456", pos: 0 }];
    expect(resolveStops(one, "#ff0000", "#0000ff", false)[0].color).toBe("#ff0000");
  });

  it("mirrors positions when reversed", () => {
    const custom: GradientStop[] = [
      { color: "#aaaaaa", pos: 0 },
      { color: "#bbbbbb", pos: 0.25 },
      { color: "#cccccc", pos: 1 },
    ];
    expect(resolveStops(custom, "#000", "#fff", true)).toEqual([
      { color: "#aaaaaa", pos: 1 },
      { color: "#bbbbbb", pos: 0.75 },
      { color: "#cccccc", pos: 0 },
    ]);
  });

  it("does not mutate the caller's stops", () => {
    const custom: GradientStop[] = [
      { color: "#aaaaaa", pos: 0 },
      { color: "#cccccc", pos: 1 },
    ];
    resolveStops(custom, "#000", "#fff", true);
    expect(custom[0].pos).toBe(0);
  });
});

describe("buildCanvasGradient", () => {
  const start = { x: 10, y: 20 };
  const end = { x: 110, y: 20 };

  it("emits a dense, ordered stop list", () => {
    const { ctx } = stubCtx();
    const g = buildCanvasGradient(ctx, "linear", start, end, 0.5, BW);
    const stops = stopsOf(g);
    expect(stops).toHaveLength(65);
    expect(stops[0][0]).toBe(0);
    expect(stops[64][0]).toBe(1);
    for (let i = 1; i < stops.length; i++) expect(stops[i][0]).toBeGreaterThan(stops[i - 1][0]);
  });

  it("runs a linear gradient between the two points", () => {
    const { ctx, calls } = stubCtx();
    buildCanvasGradient(ctx, "linear", start, end, 0.5, BW);
    expect(calls.linear).toEqual([[10, 20, 110, 20]]);
  });

  it("puts the midpoint's halfway colour where the midpoint says", () => {
    // midpoint 0.25 ⇒ k = log(.5)/log(.25) = 0.5, so v=0.25 maps to u=0.5.
    const { ctx } = stubCtx();
    const g = buildCanvasGradient(ctx, "linear", start, end, 0.25, BW);
    expect(colorAt(g, 0.25)).toBe(sampleGradient(BW, 0.5));
    // ...and a neutral midpoint leaves the ramp alone.
    const { ctx: c2 } = stubCtx();
    const plain = buildCanvasGradient(c2, "linear", start, end, 0.5, BW);
    expect(colorAt(plain, 0.25)).toBe(sampleGradient(BW, 0.25));
    expect(colorAt(plain, 0.25)).not.toBe(colorAt(g, 0.25));
  });

  it("clamps an extreme midpoint instead of dividing by zero", () => {
    for (const mid of [0, 1, -3, 17]) {
      const { ctx } = stubCtx();
      const g = buildCanvasGradient(ctx, "linear", start, end, mid, BW);
      expect(stopsOf(g).every(([, c]) => /^#[0-9a-f]{8}$/.test(c))).toBe(true);
    }
  });

  it("makes a radial gradient reach the drag's end point", () => {
    const { ctx, calls } = stubCtx();
    buildCanvasGradient(ctx, "radial", { x: 0, y: 0 }, { x: 30, y: 40 }, 0.5, BW);
    expect(calls.radial).toEqual([[0, 0, 0, 0, 0, 50]]); // hypot(30,40)
  });

  it("gives a radial gradient a usable radius even for a zero-length drag", () => {
    const { ctx, calls } = stubCtx();
    buildCanvasGradient(ctx, "radial", start, start, 0.5, BW);
    expect(calls.radial[0][5]).toBeGreaterThanOrEqual(1);
  });

  it("mirrors a reflected gradient about the start point", () => {
    const { ctx, calls } = stubCtx();
    const g = buildCanvasGradient(ctx, "reflected", start, end, 0.5, BW);
    // The band is laid out from the mirror of `end` through `start` to `end`.
    expect(calls.linear).toEqual([[-90, 20, 110, 20]]);
    // ...and the colours are symmetric about the centre, with the first stop
    // colour in the middle.
    expect(colorAt(g, 0.5)).toBe(sampleGradient(BW, 0));
    for (let i = 0; i <= 32; i++) {
      expect(colorAt(g, i / 64)).toBe(colorAt(g, 1 - i / 64));
    }
  });

  it("uses a conic gradient for the angle type, at the drag's angle", () => {
    const { ctx, calls } = stubCtx(true);
    buildCanvasGradient(ctx, "angle", { x: 5, y: 5 }, { x: 5, y: 15 }, 0.5, BW);
    expect(calls.conic).toEqual([[Math.PI / 2, 5, 5]]);
    expect(calls.linear).toHaveLength(0);
  });

  it("falls back to linear where conic gradients are unsupported", () => {
    const { ctx, calls } = stubCtx(false);
    const g = buildCanvasGradient(ctx, "angle", start, end, 0.5, BW);
    expect(calls.linear).toEqual([[10, 20, 110, 20]]);
    expect(stopsOf(g)).toHaveLength(65);
  });

  it("closes the seam when an angle gradient is smoothed", () => {
    const { ctx } = stubCtx();
    const hard = buildCanvasGradient(ctx, "angle", start, end, 0.5, BW, false);
    // Unsmoothed, the wrap is a hard edge: black meets white at the start line.
    expect(colorAt(hard, 0)).not.toBe(colorAt(hard, 1));

    const { ctx: c2 } = stubCtx();
    const soft = buildCanvasGradient(c2, "angle", start, end, 0.5, BW, true);
    // Smoothed, both ends land on the same blend, so there is no edge at all.
    expect(colorAt(soft, 0)).toBe(colorAt(soft, 1));
    expect(colorAt(soft, 0)).toBe("#808080ff"); // halfway between the two ends
    // The full ramp still happens in between, just squeezed clear of the seam.
    expect(colorAt(soft, 0.5)).toBe(sampleGradient(BW, 0.5));
  });

  it("smoothing only applies to angle gradients", () => {
    const { ctx } = stubCtx();
    const linear = buildCanvasGradient(ctx, "linear", start, end, 0.5, BW, true);
    expect(colorAt(linear, 0)).toBe("#000000ff");
    expect(colorAt(linear, 1)).toBe("#ffffffff");
  });

  it("sorts the caller's stops rather than trusting their order", () => {
    const unsorted: GradientStop[] = [
      { color: "#ffffffff", pos: 1 },
      { color: "#000000ff", pos: 0 },
    ];
    const { ctx } = stubCtx();
    const g = buildCanvasGradient(ctx, "linear", start, end, 0.5, unsorted);
    expect(colorAt(g, 0)).toBe("#000000ff");
    expect(colorAt(g, 1)).toBe("#ffffffff");
    expect(unsorted[0].pos).toBe(1); // and does not reorder the caller's array
  });
});
