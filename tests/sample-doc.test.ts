import { describe, expect, it } from "vitest";
import {
  BIRDS,
  DIVIDER,
  H,
  HORIZON,
  MASKED,
  PAINTED,
  SUBTITLE_SPEC,
  SUN,
  TITLE_SPEC,
  W,
  sampleComps,
  sampleIds,
  sampleTexts,
  sampleTree,
  type SampleIds,
} from "../app/lib/sample-doc";
import type { LayerNode } from "../app/lib/layers";
import { FONT_FAMILIES } from "../app/lib/tools";

/**
 * The sample document's RECIPE — the tree, the type, the vectors, the comps.
 * Its pixels are painted in a browser (sample-paint.ts) and checked there
 * (e2e/sample.spec.ts); what is pinned here is that the recipe hangs together:
 * every node has a painter or needs none, the grading reaches the picture, the
 * clip lands on the mountains, and each comp is a real, different state.
 */

let seq = 0;
const ids = sampleIds(() => `n${(seq += 1)}`);
const BOX = { x: 1, y: 2, w: 3, h: 4 };
const tree = sampleTree(ids, () => BOX);

const walk = (nodes: LayerNode[]): LayerNode[] =>
  nodes.flatMap((n) => [n, ...(n.type === "group" ? walk(n.children) : [])]);
const all = walk(tree);
const byId = new Map(all.map((n) => [n.id, n]));
const node = (role: keyof SampleIds) => byId.get(ids[role])!;
const roleOf = new Map(Object.entries(ids).map(([role, id]) => [id, role]));

describe("the tree", () => {
  it("holds every role exactly once, and nothing else", () => {
    const seen = all.map((n) => n.id);
    expect(seen.length).toBe(new Set(seen).size);
    expect(new Set(seen)).toEqual(new Set(Object.values(ids)));
  });

  /* An adjustment re-processes what is below it within its OWN parent, and a
     group composites its children first (there is no pass-through). An
     adjustment tucked into a "Grade" group would grade nothing at all. */
  it("keeps every adjustment at the top level, above the picture it grades", () => {
    const adjustments = all.filter((n) => n.type === "adjustment");
    expect(adjustments.length).toBeGreaterThanOrEqual(3);
    expect(adjustments.every((a) => tree.includes(a))).toBe(true);
    const landscape = tree.findIndex((n) => n.id === ids.landscape);
    expect(adjustments.every((a) => tree.indexOf(a) < landscape)).toBe(true);
  });

  /* A clipping mask clips to the layer DIRECTLY below it in the same parent. */
  it("clips the alpenglow to the near range, and to nothing else", () => {
    const landscape = node("landscape");
    if (landscape.type !== "group") throw new Error("Landscape is a group");
    const kids = landscape.children.map((n) => n.id);
    expect(node("alpenglow").clipped).toBe(true);
    expect(kids.indexOf(ids.near)).toBe(kids.indexOf(ids.alpenglow) + 1);
    expect(all.filter((n) => n.clipped).map((n) => n.id)).toEqual([ids.alpenglow]);
  });

  it("has a painter for every layer with pixels, and paints nothing else", () => {
    const pixelLeaves = all
      .filter((n) => n.type === "layer" && !n.fill && n.vector?.type !== "text")
      .map((n) => roleOf.get(n.id));
    expect(new Set(pixelLeaves)).toEqual(new Set(PAINTED));
  });

  it("has a mask painted for every masked layer, and only those", () => {
    expect(new Set(all.filter((n) => n.mask).map((n) => roleOf.get(n.id)))).toEqual(new Set(MASKED));
  });

  it("hides what only the blue hour shows", () => {
    expect(node("stars").visible).toBe(false);
    expect(node("blueHour").visible).toBe(false);
    expect(all.filter((n) => !n.visible).length).toBe(2);
  });

  /* What the sample is FOR: every kind of thing the app does to a layer. */
  it("shows off every kind of layer and what can be done to one", () => {
    const leaves = all.filter((n) => n.type === "layer");
    expect(all.some((n) => n.type === "group")).toBe(true);
    expect(new Set(all.filter((n) => n.type === "adjustment").map((n) => n.type === "adjustment" && n.adjustment.type)))
      .toEqual(new Set(["sliders", "gradientmap", "curves"]));
    expect(leaves.some((n) => n.fill?.kind === "gradient")).toBe(true);
    expect(leaves.some((n) => n.fill?.kind === "solid")).toBe(true);
    const vectors = new Set(leaves.flatMap((n) => (n.vector ? [n.vector.type] : [])));
    expect(vectors).toEqual(new Set(["text", "shape", "path"]));
    expect(leaves.some((n) => n.filters?.length)).toBe(true);
    expect(leaves.some((n) => n.effects?.dropShadow && n.effects.outerGlow)).toBe(true);
    expect(new Set(all.map((n) => n.blend)).size).toBeGreaterThanOrEqual(4);
    expect(all.some((n) => n.opacity < 100)).toBe(true);
    expect(new Set(all.flatMap((n) => (n.label ? [n.label] : []))).size).toBeGreaterThanOrEqual(3);
  });

  it("ripples the reflection with smart filters, not in its pixels", () => {
    const f = node("reflection").filters ?? [];
    expect(f.map((x) => x.type)).toEqual(["distort", "blur"]);
    expect(f.every((x) => x.enabled)).toBe(true);
  });
});

describe("the type", () => {
  it("rasterises from the very recipe the layer keeps, so a re-edit redraws the same", () => {
    for (const { id, spec } of sampleTexts(ids)) {
      const n = byId.get(id)!;
      expect(n.type === "layer" && n.vector?.type).toBe("text");
      if (n.type !== "layer" || n.vector?.type !== "text") continue;
      const { type, bbox, ...recipe } = n.vector;
      expect(type).toBe("text");
      expect(recipe).toEqual(spec);
      // The measured bounds are what the re-edit hit test uses.
      expect(bbox).toEqual(BOX);
    }
  });

  it("uses fonts the Text tool offers", () => {
    expect(FONT_FAMILIES).toContain(TITLE_SPEC.fontFamily);
    expect(FONT_FAMILIES).toContain(SUBTITLE_SPEC.fontFamily);
  });

  it("stacks title, rule and subtitle top to bottom without touching", () => {
    expect(TITLE_SPEC.y + TITLE_SPEC.fontSize * TITLE_SPEC.lineHeight).toBeLessThan(DIVIDER.y);
    expect(DIVIDER.y + DIVIDER.h).toBeLessThan(SUBTITLE_SPEC.y);
    expect(DIVIDER.x + DIVIDER.w / 2).toBe(W / 2);
  });
});

describe("the picture", () => {
  /* The fill's span is scale × the canvas diagonal, centred: for its stop
     positions to BE heights, the span must be exactly the canvas height. */
  it("lays the sky's gradient out by height, with a stop on the horizon", () => {
    const sky = node("sky");
    if (sky.type !== "layer" || sky.fill?.kind !== "gradient") throw new Error("Sky is a gradient fill");
    const g = sky.fill.gradient;
    expect(g.angle).toBe(90);
    expect(g.scale * Math.hypot(W, H)).toBeCloseTo(H, 6);
    const pos = g.stops.map((s) => s.pos);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(pos).toContain(HORIZON / H);
  });

  it("sets the sun above the waterline, inside the canvas", () => {
    expect(SUN.y + SUN.r).toBeLessThan(HORIZON);
    expect(SUN.x - SUN.r).toBeGreaterThan(0);
    expect(SUN.x + SUN.r).toBeLessThan(W);
  });

  it("keeps the birds' recorded bounds round every bird", () => {
    const b = BIRDS.bbox;
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(0);
    expect(b.x + b.w).toBeLessThan(W);
    for (const p of BIRDS.paths) {
      const nums = p.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(b.x);
        expect(nums[i]).toBeLessThanOrEqual(b.x + b.w);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(b.y);
        expect(nums[i + 1]).toBeLessThanOrEqual(b.y + b.h);
      }
    }
  });
});

describe("the layer comps", () => {
  const comps = sampleComps(ids, tree);
  const visible = (name: string, role: keyof SampleIds) =>
    comps.find((c) => c.name === name)!.states[ids[role]].visible;

  it("record the visibility of every node, so each one sets the whole picture", () => {
    expect(comps.map((c) => c.name)).toEqual(["Golden hour", "Blue hour", "Before grading", "Photo only"]);
    for (const c of comps) {
      expect(c.capture).toEqual(["visibility"]);
      expect(new Set(Object.keys(c.states))).toEqual(new Set(Object.values(ids)));
    }
  });

  it("open on golden hour: the first comp is the picture as it opens", () => {
    for (const n of all) expect(comps[0].states[n.id].visible, n.name).toBe(n.visible);
  });

  it("turn golden hour into blue hour", () => {
    expect(["stars", "blueHour"].map((r) => visible("Blue hour", r as keyof SampleIds))).toEqual([true, true]);
    expect(["sun", "sunPath", "glow", "alpenglow"].map((r) => visible("Blue hour", r as keyof SampleIds))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("take every adjustment off for Before grading", () => {
    const graders = all.filter((n) => n.type === "adjustment" || n.id === ids.vignette);
    for (const n of graders) expect(visible("Before grading", roleOf.get(n.id) as keyof SampleIds), n.name).toBe(false);
  });

  it("are four different states", () => {
    const keys = comps.map((c) => JSON.stringify(c.states));
    expect(new Set(keys).size).toBe(4);
  });
});
