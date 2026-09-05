/**
 * Text on a path — the arithmetic, with no canvas anywhere near it.
 *
 * `layoutTextOnPath` takes an injected `MeasureFn` for the same reason
 * `layoutRuns` does, so "where does the seventh letter sit and which way does it
 * point" is a question about numbers. The fake measurer below gives every
 * character a width of exactly 10, which makes every expected position
 * something that can be worked out by hand and written down.
 *
 * The geometry is checked against shapes whose answers are known independently:
 * a straight horizontal line, where the tangent is 0 everywhere and the
 * positions are arithmetic; and a circle, where every glyph must be the same
 * distance from the centre and the angle must advance by the arc it covers.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATH_TEXT,
  flattenPath,
  layoutTextOnPath,
  pathPointAt,
  type PathTextOptions,
} from "../app/lib/textpath";
import type { PathSeg } from "../app/lib/svgpath";
import type { MeasureFn } from "../app/lib/richtext";
import type { TextRunStyle } from "../app/lib/tools";

const BASE: TextRunStyle = {
  fontFamily: "Inter",
  fontSize: 10,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: "#000000ff",
  baseline: 0,
  caps: false,
};

/** Every character is 10 wide — so a position is a number you can predict. */
const measure: MeasureFn = () => ({ width: 10, ascent: 8, descent: 2 });

const opts = (over: Partial<PathTextOptions> = {}): PathTextOptions => ({
  ...DEFAULT_PATH_TEXT,
  ...over,
});

const line = (x0: number, y0: number, x1: number, y1: number): PathSeg[] => [
  { c: "M", x: x0, y: y0 },
  { c: "L", x: x1, y: y1 },
];

/** A circle of radius r centred at (0,0), as four cubics. */
const K = 0.5522847498307936;
const circle = (r: number): PathSeg[] => [
  { c: "M", x: r, y: 0 },
  { c: "C", x1: r, y1: r * K, x2: r * K, y2: r, x: 0, y: r },
  { c: "C", x1: -r * K, y1: r, x2: -r, y2: r * K, x: -r, y: 0 },
  { c: "C", x1: -r, y1: -r * K, x2: -r * K, y2: -r, x: 0, y: -r },
  { c: "C", x1: r * K, y1: -r, x2: r, y2: -r * K, x: r, y: 0 },
  { c: "Z" },
];

describe("flattenPath", () => {
  it("keeps a straight line as two points and measures it exactly", () => {
    const fp = flattenPath(line(0, 0, 100, 0));
    expect(fp.pts).toHaveLength(2);
    expect(fp.length).toBeCloseTo(100);
    expect(fp.cum).toEqual([0, 100]);
  });

  it("measures a diagonal by its true length, not its bounding box", () => {
    expect(flattenPath(line(0, 0, 30, 40)).length).toBeCloseTo(50);
  });

  /* NOT "always shorter", which was the first version of this test and was
     wrong: an inscribed polyline is shorter than the curve it samples, but the
     curve here is four CUBICS approximating a circle, and that approximation
     sits very slightly OUTSIDE the true circle (the classic 0.55228 constant
     trades a little bulge for a much better fit). The two errors have opposite
     signs, so the honest claim is a magnitude, not a direction. Half a percent
     of a full circumference is far below a pixel at any size type is set at. */
  it("measures a circle's circumference to within half a percent, either way", () => {
    const fp = flattenPath(circle(100));
    const truth = 2 * Math.PI * 100;
    expect(Math.abs(fp.length - truth)).toBeLessThan(truth * 0.005);
  });

  it("closes a Z back to the subpath start", () => {
    const fp = flattenPath([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 10, y: 0 },
      { c: "L", x: 10, y: 10 },
      { c: "Z" },
    ]);
    expect(fp.length).toBeCloseTo(10 + 10 + Math.hypot(10, 10));
    const last = fp.pts[fp.pts.length - 1];
    expect(last).toEqual({ x: 0, y: 0 });
  });

  /* Text cannot be on two paths at once, and running them together would
     teleport a word across the gap between them. */
  it("uses only the first subpath", () => {
    const fp = flattenPath([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 10, y: 0 },
      { c: "M", x: 500, y: 500 },
      { c: "L", x: 600, y: 500 },
    ]);
    expect(fp.length).toBeCloseTo(10);
  });

  it("drops duplicate vertices, which would otherwise give a NaN tangent", () => {
    const fp = flattenPath([
      { c: "M", x: 0, y: 0 },
      { c: "L", x: 0, y: 0 },
      { c: "L", x: 10, y: 0 },
    ]);
    expect(fp.pts).toHaveLength(2);
    const p = pathPointAt(fp, 5);
    expect(Number.isFinite(p!.angle)).toBe(true);
  });

  it("gives an empty path an empty table rather than throwing", () => {
    const fp = flattenPath([]);
    expect(fp.pts).toEqual([]);
    expect(fp.length).toBe(0);
    expect(pathPointAt(fp, 0)).toBeNull();
  });
});

describe("pathPointAt", () => {
  const fp = flattenPath(line(0, 0, 100, 0));

  it("interpolates along a straight span", () => {
    expect(pathPointAt(fp, 25)).toMatchObject({ x: 25, y: 0, angle: 0 });
  });

  it("clamps rather than returning null outside the path", () => {
    expect(pathPointAt(fp, -50)!.x).toBeCloseTo(0);
    expect(pathPointAt(fp, 1000)!.x).toBeCloseTo(100);
  });

  it("reports the direction the path points, not the direction to the origin", () => {
    const down = flattenPath(line(0, 0, 0, 100));
    expect(pathPointAt(down, 50)!.angle).toBeCloseTo(Math.PI / 2);
  });

  it("stays on the circle it was built from", () => {
    const c = flattenPath(circle(100));
    for (let i = 0; i <= 8; i++) {
      const p = pathPointAt(c, (c.length * i) / 8)!;
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 0);
    }
  });
});

describe("layoutTextOnPath", () => {
  const straight = flattenPath(line(0, 0, 1000, 0));

  it("places each glyph one advance after the last", () => {
    const { glyphs } = layoutTextOnPath("abc", undefined, BASE, straight, opts(), measure);
    expect(glyphs.map((g) => g.ch)).toEqual(["a", "b", "c"]);
    expect(glyphs.map((g) => Math.round(g.x))).toEqual([0, 10, 20]);
    expect(glyphs.every((g) => g.angle === 0)).toBe(true);
  });

  it("adds tracking between glyphs but not before the first", () => {
    const { glyphs } = layoutTextOnPath(
      "abc", undefined, BASE, straight, opts({ tracking: 5 }), measure,
    );
    expect(glyphs.map((g) => Math.round(g.x))).toEqual([0, 15, 30]);
  });

  it("starts where it is told to", () => {
    const { glyphs } = layoutTextOnPath(
      "ab", undefined, BASE, straight, opts({ startOffset: 100 }), measure,
    );
    expect(Math.round(glyphs[0].x)).toBe(100);
  });

  it("centres the whole string on the path", () => {
    const { glyphs, advance } = layoutTextOnPath(
      "abcd", undefined, BASE, straight, opts({ align: "center" }), measure,
    );
    expect(advance).toBeCloseTo(40);
    expect(Math.round(glyphs[0].x)).toBe(Math.round(1000 / 2 - 40 / 2));
  });

  it("ends the string at the path's end", () => {
    const { glyphs } = layoutTextOnPath(
      "abcd", undefined, BASE, straight, opts({ align: "end" }), measure,
    );
    const last = glyphs[glyphs.length - 1];
    expect(Math.round(last.x + 10)).toBe(1000);
  });

  /* Piling the overflow onto the final vertex reads as corruption; dropping it
     and saying how much reads as "the path is too short". */
  it("drops glyphs that run off the end and reports how many", () => {
    const short = flattenPath(line(0, 0, 25, 0));
    const { glyphs, dropped } = layoutTextOnPath(
      "abcdef", undefined, BASE, short, opts(), measure,
    );
    expect(glyphs.length + dropped).toBe(6);
    expect(dropped).toBeGreaterThan(0);
    expect(glyphs.every((g) => g.x <= 25)).toBe(true);
  });

  it("has no line breaks to honour, so a newline is not a glyph", () => {
    const { glyphs } = layoutTextOnPath("a\nb", undefined, BASE, straight, opts(), measure);
    expect(glyphs.map((g) => g.ch)).toEqual(["a", "b"]);
    expect(Math.round(glyphs[1].x)).toBe(10);
  });

  it("lifts the text off the path by the offset, along the normal", () => {
    const { glyphs } = layoutTextOnPath(
      "a", undefined, BASE, straight, opts({ offset: 7 }), measure,
    );
    // On a left-to-right path the normal points up, and y grows downward.
    expect(glyphs[0].y).toBeCloseTo(-7);
  });

  it("renders all-caps as the glyph it measured, not the stored character", () => {
    const { glyphs } = layoutTextOnPath(
      "ab", undefined, { ...BASE, caps: true }, straight, opts(), measure,
    );
    expect(glyphs.map((g) => g.ch)).toEqual(["A", "B"]);
  });

  it("carries each run's own style onto its glyphs", () => {
    const runs = [
      { ...BASE, len: 1 },
      { ...BASE, bold: true, len: 1 },
    ];
    const { glyphs } = layoutTextOnPath("ab", runs, BASE, straight, opts(), measure);
    expect(glyphs[0].style.bold).toBe(false);
    expect(glyphs[1].style.bold).toBe(true);
  });

  // ================================================= the curve itself ========
  describe("on a circle", () => {
    const c = flattenPath(circle(100));

    it("keeps every glyph's centre on the curve", () => {
      const { glyphs } = layoutTextOnPath("abcdefgh", undefined, BASE, c, opts(), measure);
      expect(glyphs).toHaveLength(8);
      for (const g of glyphs) {
        // Step forward half an advance to recover the centre that was placed.
        const cxp = g.x + (Math.cos(g.angle) * 10) / 2;
        const cyp = g.y + (Math.sin(g.angle) * 10) / 2;
        expect(Math.hypot(cxp, cyp)).toBeCloseTo(100, 0);
      }
    });

    /* THE REASON THE CENTRE IS WHAT SITS ON THE CURVE, stated as the number it
       buys. A glyph is a straight chord laid across a curve, so its ends are
       always OUTSIDE the radius of the point it was placed at — that is chord
       geometry, not an error, and the first version of this test asserted the
       opposite. What placement chooses is how that bulge is DISTRIBUTED:

         centred    ends at hypot(100, 5)  = 100.125  — 0.125 out, both ends
         left edge  far end at hypot(100, 10) = 100.499 — 0.499 out, one end

       Four times the deviation, all of it on one side, which is what makes
       left-edge placement splay letters outward on tight curves. */
    it("spreads a glyph's bulge evenly, a quarter of what left-edge placement costs", () => {
      const { glyphs } = layoutTextOnPath("abcd", undefined, BASE, c, opts(), measure);
      const centred = Math.hypot(100, 5) - 100;
      const leftEdge = Math.hypot(100, 10) - 100;
      for (const g of glyphs) {
        const startR = Math.hypot(g.x, g.y);
        const endR = Math.hypot(g.x + Math.cos(g.angle) * 10, g.y + Math.sin(g.angle) * 10);
        /* Symmetric to within the flattening error, not to machine precision.
           The bound is what the central-difference tangent holds to; with the
           raw chord direction of whichever flattening segment the sample landed
           in, this same loop broke a 0.05 bound. So the tangent change is worth
           at least a factor of four here, on a 0.125px bulge that is inherent
           to laying a straight glyph across a curve at all. */
        expect(Math.abs(startR - endR)).toBeLessThan(0.02);
        for (const R of [startR, endR]) {
          expect(R).toBeGreaterThan(100 - 0.05);
          expect(R - 100).toBeLessThan(centred + 0.05);
          expect(R - 100).toBeLessThan(leftEdge / 3);
        }
      }
    });

    it("turns each glyph by the arc it covers", () => {
      const { glyphs } = layoutTextOnPath("abcdefgh", undefined, BASE, c, opts(), measure);
      const step = 10 / 100; // arc length over radius = radians
      for (let i = 1; i < glyphs.length; i++) {
        let d = glyphs[i].angle - glyphs[i - 1].angle;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        expect(d).toBeCloseTo(step, 1);
      }
    });

  });

  /* Checked on a STRAIGHT line, where every number is exact. The first version
     compared glyph 0 of a flipped run against glyph 0 of an unflipped one on a
     circle — two different places on the path, so their tangents differ by the
     arc between them as well as by the flip, and the difference is not π. */
  it("turns every glyph over when flipped, and keeps them in text order", () => {
    const { glyphs } = layoutTextOnPath(
      "abcd", undefined, BASE, straight, opts({ flip: true }), measure,
    );
    expect(glyphs.map((g) => g.ch)).toEqual(["a", "b", "c", "d"]);
    for (const g of glyphs) expect(Math.abs(g.angle)).toBeCloseTo(Math.PI, 6);
    // Upside down, the string runs back along the path: 'a' ends up furthest on.
    expect(glyphs[0].x).toBeGreaterThan(glyphs[3].x);
  });

  it("gives an empty string and a degenerate path nothing to draw", () => {
    expect(layoutTextOnPath("", undefined, BASE, straight, opts(), measure).glyphs).toEqual([]);
    const dot = flattenPath([{ c: "M", x: 5, y: 5 }]);
    expect(layoutTextOnPath("ab", undefined, BASE, dot, opts(), measure).glyphs).toEqual([]);
  });
});
