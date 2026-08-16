/**
 * samplers.ts — the Info panel's pinned readout points.
 *
 * Two properties get most of the attention here, because both are the sort that
 * look fine until a user notices: the operations return the SAME array when
 * they change nothing (these results go into React state and into undo, so a
 * fresh array for a no-op click costs a re-render and a history entry), and a
 * sampler that would land off the canvas is dropped rather than clamped — a
 * clamped one sits on the edge pretending to be the measurement you left there.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SAMPLERS,
  addSampler,
  clampToDoc,
  moveSampler,
  offsetSamplers,
  removeSampler,
  samplerAt,
  samplerLabel,
  sanitizeSamplers,
  type ColorSampler,
} from "@/app/lib/samplers";

const W = 100;
const H = 80;
const at = (x: number, y: number, id = `s${x}-${y}`): ColorSampler => ({ id, x, y });

describe("adding", () => {
  it("puts a sampler on the clicked pixel", () => {
    const out = addSampler([], 12, 34, W, H, "a");
    expect(out).toEqual([{ id: "a", x: 12, y: 34 }]);
  });

  it("rounds to the pixel grid", () => {
    expect(addSampler([], 12.6, 34.2, W, H, "a")[0]).toMatchObject({ x: 13, y: 34 });
  });

  it("pulls a click outside the canvas to the nearest real pixel", () => {
    // The click was still a request to sample something.
    expect(addSampler([], -5, 999, W, H, "a")[0]).toMatchObject({ x: 0, y: H - 1 });
  });

  it("refuses a second sampler on the same pixel, without churning the array", () => {
    const one = addSampler([], 10, 10, W, H, "a");
    expect(addSampler(one, 10, 10, W, H, "b")).toBe(one);
  });

  it("stops at the cap, and says so by returning the same array", () => {
    let list: ColorSampler[] = [];
    for (let i = 0; i < MAX_SAMPLERS; i++) list = addSampler(list, i, i, W, H, `s${i}`);
    expect(list).toHaveLength(MAX_SAMPLERS);
    expect(addSampler(list, 50, 50, W, H, "extra")).toBe(list);
  });

  it("mints distinct ids when none is given", () => {
    const a = addSampler([], 1, 1, W, H);
    const b = addSampler(a, 2, 2, W, H);
    expect(b[0].id).not.toBe(b[1].id);
  });
});

describe("hit testing", () => {
  const list = [at(10, 10, "a"), at(40, 40, "b")];

  it("finds a sampler within the tolerance", () => {
    expect(samplerAt(list, 12, 11, 4)?.id).toBe("a");
    expect(samplerAt(list, 12, 11, 1)).toBeNull();
  });

  it("measures distance radially, not per axis", () => {
    // (3,3) is 4.24 away — outside a 4 px radius, though within 4 on each axis.
    expect(samplerAt(list, 13, 13, 4)).toBeNull();
    expect(samplerAt(list, 13, 13, 4.3)?.id).toBe("a");
  });

  it("picks the nearest when two overlap", () => {
    const stacked = [at(20, 20, "old"), at(22, 20, "new")];
    expect(samplerAt(stacked, 21.6, 20, 5)?.id).toBe("new");
  });

  it("prefers the newest on an exact tie, since that is the one just placed", () => {
    const stacked = [at(20, 20, "old"), at(24, 20, "new")];
    expect(samplerAt(stacked, 22, 20, 5)?.id).toBe("new");
  });

  it("returns null for an empty list", () => {
    expect(samplerAt([], 5, 5, 10)).toBeNull();
  });
});

describe("removing and moving", () => {
  const list = [at(10, 10, "a"), at(40, 40, "b")];

  it("removes by id", () => {
    expect(removeSampler(list, "a").map((s) => s.id)).toEqual(["b"]);
  });

  it("leaves the array alone when the id is not there", () => {
    expect(removeSampler(list, "nope")).toBe(list);
  });

  it("moves one and keeps it on the canvas", () => {
    expect(moveSampler(list, "a", 500, 500, W, H).find((s) => s.id === "a")).toMatchObject({
      x: W - 1,
      y: H - 1,
    });
  });

  it("does not churn when the move lands on the same pixel", () => {
    expect(moveSampler(list, "a", 10.2, 9.8, W, H)).toBe(list);
    expect(moveSampler(list, "ghost", 5, 5, W, H)).toBe(list);
  });
});

describe("sanitizing what a project file holds", () => {
  it("keeps well-formed points", () => {
    const out = sanitizeSamplers([{ id: "a", x: 5, y: 6 }], W, H);
    expect(out).toEqual([{ id: "a", x: 5, y: 6 }]);
  });

  it("drops points that fall outside the canvas, rather than clamping them", () => {
    // The document may have been cropped since; a clamped sampler would sit on
    // the edge pretending to be the measurement the user left behind.
    const out = sanitizeSamplers([{ x: 5, y: 6 }, { x: 500, y: 6 }, { x: 5, y: -1 }], W, H);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ x: 5, y: 6 });
  });

  it("survives junk", () => {
    expect(sanitizeSamplers(null, W, H)).toEqual([]);
    expect(sanitizeSamplers("nope", W, H)).toEqual([]);
    expect(sanitizeSamplers([null, 7, {}, { x: "a", y: 2 }, { x: NaN, y: 2 }], W, H)).toEqual([]);
  });

  it("gives an id to a point that lost one", () => {
    expect(sanitizeSamplers([{ x: 1, y: 2 }], W, H)[0].id).toBeTruthy();
  });

  it("de-duplicates and honours the cap", () => {
    expect(sanitizeSamplers([{ x: 3, y: 3 }, { x: 3, y: 3 }], W, H)).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 1 }));
    expect(sanitizeSamplers(many, W, H)).toHaveLength(MAX_SAMPLERS);
  });
});

describe("surviving a canvas resize", () => {
  const list = [at(10, 10, "a"), at(40, 40, "b")];

  it("shifts by the crop offset", () => {
    expect(offsetSamplers(list, -5, -5, W, H)).toEqual([
      { id: "a", x: 5, y: 5 },
      { id: "b", x: 35, y: 35 },
    ]);
  });

  it("drops what the new canvas no longer contains", () => {
    const out = offsetSamplers(list, -20, 0, W, H);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });

  it("is a no-op for a zero offset, array identity included", () => {
    expect(offsetSamplers(list, 0, 0, W, H)).toBe(list);
    expect(offsetSamplers([], 10, 10, W, H)).toEqual([]);
  });
});

describe("labels", () => {
  it("numbers from one, the way the canvas badge reads", () => {
    expect(samplerLabel(0)).toBe("#1");
    expect(samplerLabel(9)).toBe("#10");
  });
});

describe("clampToDoc", () => {
  it("handles a degenerate document without going negative", () => {
    expect(clampToDoc(5, 5, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
