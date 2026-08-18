import { describe, expect, it } from "vitest";

import {
  STAR_DEFAULT,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
  sanitizeStar,
  starCollinearInner,
  starPoints,
  type StarGeom,
} from "@/app/lib/shapes";

const BOX = { x: 100, y: 50, w: 200, h: 200 }; // square, centre (200, 150)
const CX = 200;
const CY = 150;
const star = (over: Partial<StarGeom> = {}): StarGeom => sanitizeStar({ ...STAR_DEFAULT, ...over });

const radiusOf = (p: { x: number; y: number }) => Math.hypot(p.x - CX, p.y - CY);
/** Angle from the centre, degrees, 0 = straight up, clockwise positive. */
const angleOf = (p: { x: number; y: number }) =>
  (((Math.atan2(p.y - CY, p.x - CX) * 180) / Math.PI + 90) % 360 + 360) % 360;

describe("the vertex ring", () => {
  it("emits two vertices per point", () => {
    for (const n of [3, 5, 8, 24]) expect(starPoints(BOX, star({ points: n })).length).toBe(n * 2);
  });

  it("alternates outer and inner radii", () => {
    const pts = starPoints(BOX, star({ points: 6, inner: 0.4 }));
    for (let i = 0; i < pts.length; i++) {
      expect(radiusOf(pts[i])).toBeCloseTo(i % 2 === 0 ? 100 : 40, 6);
    }
  });

  it("puts a point straight up at rotation 0 — which is what a star looks like", () => {
    const pts = starPoints(BOX, star({ points: 5, angle: 0 }));
    expect(pts[0].x).toBeCloseTo(CX, 6);
    expect(pts[0].y).toBeCloseTo(BOX.y, 6); // touches the top edge
  });

  it("spaces the points evenly round the circle", () => {
    const pts = starPoints(BOX, star({ points: 5 }));
    const outer = pts.filter((_, i) => i % 2 === 0).map(angleOf);
    for (let i = 0; i < outer.length; i++) expect(outer[i]).toBeCloseTo(i * 72, 4);
  });

  it("sits each inner vertex exactly halfway between its neighbours", () => {
    const pts = starPoints(BOX, star({ points: 7 }));
    for (let i = 1; i < pts.length; i += 2) {
      const a = angleOf(pts[i - 1]);
      const b = angleOf(pts[i]);
      const gap = ((b - a) % 360 + 360) % 360;
      expect(gap).toBeCloseTo(360 / 7 / 2, 4);
    }
  });

  it("fills the box it is given rather than staying regular inside it", () => {
    // A wide box must give a wide star — the same rule the triangle and
    // trapezoid follow. A circular star in a wide box would be the bug.
    const wide = { x: 0, y: 0, w: 400, h: 100 };
    const pts = starPoints(wide, star({ points: 4, angle: 0 }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(400, 4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 4);
  });

  it("stays inside its box at every rotation and point count", () => {
    for (const n of [3, 5, 6, 11, 24])
      for (const angle of [-180, -90, -37, 0, 23, 90, 179]) {
        for (const p of starPoints(BOX, star({ points: n, angle }))) {
          expect(p.x).toBeGreaterThanOrEqual(BOX.x - 1e-6);
          expect(p.x).toBeLessThanOrEqual(BOX.x + BOX.w + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(BOX.y - 1e-6);
          expect(p.y).toBeLessThanOrEqual(BOX.y + BOX.h + 1e-6);
        }
      }
  });

  it("rotates by exactly the angle asked for", () => {
    const a = starPoints(BOX, star({ points: 5, angle: 0 }))[0];
    const b = starPoints(BOX, star({ points: 5, angle: 30 }))[0];
    expect(angleOf(a)).toBeCloseTo(0, 4);
    expect(angleOf(b)).toBeCloseTo(30, 4);
  });

  it("is a regular polygon at inner = 1 — every vertex on the same circle", () => {
    const pts = starPoints(BOX, star({ points: 6, inner: 1 }));
    for (const p of pts) expect(radiusOf(p)).toBeCloseTo(100, 6);
  });

  it("is centred on the box, wherever the box is", () => {
    for (const b of [BOX, { x: -500, y: 900, w: 40, h: 80 }]) {
      const pts = starPoints(b, star({ points: 5 }));
      const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      expect(mx).toBeCloseTo(b.x + b.w / 2, 4);
      expect(my).toBeCloseTo(b.y + b.h / 2, 4);
    }
  });
});

describe("the collinear (proper-star) waist", () => {
  it("is the golden pentagram at five points", () => {
    expect(starCollinearInner(5)).toBeCloseTo(0.381966, 5);
  });

  it("is undefined below five points, where the geometry cannot close", () => {
    // At three points the formula gives −1; a snap target outside (0,1) is not
    // a tidier star, it is a broken one.
    expect(starCollinearInner(3)).toBeNull();
    expect(starCollinearInner(4)).toBeNull();
    expect(starCollinearInner(2)).toBeNull();
  });

  it("is a usable ratio for every point count that has one", () => {
    for (let n = 5; n <= STAR_MAX_POINTS; n++) {
      const v = starCollinearInner(n);
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThan(0);
      expect(v!).toBeLessThan(1);
    }
  });

  it("approaches a full polygon as the points multiply", () => {
    // More points → shallower spikes → the proper star tends toward the circle.
    expect(starCollinearInner(24)!).toBeGreaterThan(starCollinearInner(6)!);
    expect(starCollinearInner(24)!).toBeGreaterThan(0.9);
  });

  it("really does put the spike edges in a straight line", () => {
    // The point of the ratio: at a pentagram's inner vertex, the two edges
    // meeting there are collinear with the opposite spike's edges. Checked as
    // three consecutive vertices being colinear.
    const pts = starPoints(BOX, star({ points: 5, inner: starCollinearInner(5)!, angle: 0 }));
    const cross = (o: number) => {
      const a = pts[o % 10];
      const b = pts[(o + 1) % 10];
      const c = pts[(o + 2) % 10];
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    };
    // Vertices 0,1,2 are outer-inner-outer and are NOT collinear...
    expect(Math.abs(cross(0))).toBeGreaterThan(100);
    // ...but the edge through an inner vertex continues into the next spike:
    // vertex 1 lies on the line from vertex 0 to vertex 4 (two spikes along).
    const a = pts[0];
    const b = pts[4];
    const m = pts[1];
    const area = Math.abs((b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x));
    expect(area / Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(0.01); // ~0 px off the line
  });
});

describe("sanitizing", () => {
  it("fills in a missing star with the default", () => {
    expect(sanitizeStar(undefined)).toEqual(STAR_DEFAULT);
    expect(sanitizeStar(null)).toEqual(STAR_DEFAULT);
  });

  it("clamps the point count to a drawable range", () => {
    expect(sanitizeStar({ points: 0 }).points).toBe(STAR_MIN_POINTS);
    expect(sanitizeStar({ points: 999 }).points).toBe(STAR_MAX_POINTS);
    expect(sanitizeStar({ points: 5.6 }).points).toBe(6);
  });

  it("never lets the waist reach zero — that is lines, not a shape", () => {
    expect(sanitizeStar({ inner: 0 }).inner).toBe(0.05);
    expect(sanitizeStar({ inner: -3 }).inner).toBe(0.05);
    expect(sanitizeStar({ inner: 5 }).inner).toBe(1);
  });

  it("WRAPS the rotation rather than clamping it — it is a direction", () => {
    expect(sanitizeStar({ angle: 190 }).angle).toBe(-170);
    expect(sanitizeStar({ angle: -190 }).angle).toBe(170);
    expect(sanitizeStar({ angle: 720 }).angle).toBe(0);
  });

  it("survives nonsense instead of producing NaN vertices", () => {
    const s = sanitizeStar({ points: NaN, inner: NaN, angle: NaN });
    expect(s).toEqual({ ...STAR_DEFAULT, angle: 0 });
    for (const p of starPoints(BOX, sanitizeStar("nonsense" as never))) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is applied by starPoints itself, so a raw value can never escape", () => {
    const pts = starPoints(BOX, { points: 999, inner: 50, angle: 1e6 } as StarGeom);
    expect(pts.length).toBe(STAR_MAX_POINTS * 2);
    for (const p of pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
