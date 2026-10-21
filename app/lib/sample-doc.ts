// The sample document (Help ▸ Open sample document, and the tour's last stop):
// "Alpenglow", a mountain lake at sunset.
//
// It is built the way a person would build it in the app, so that taking it
// apart teaches the app: a gradient-fill sky, painted layers for the clouds,
// the sun, two mountain ranges, the lake and the shore; a clipped layer that
// warms the peaks; a reflection with smart filters and a mask; vector birds;
// adjustment layers that grade the whole picture; a vignette that is a fill
// layer with a mask; editable type with layer effects; and four layer comps
// that turn golden hour into blue hour and back.
//
// This module is the RECIPE — the tree, the type, the vectors and the comps —
// and is pure, so its shape is tested in Node. The pixels are painted by
// sample-paint.ts, procedurally (no assets), into the same ids.

import type { LayerNode, LayerLeaf, LayerAdjustment } from "./layers";
import type { LayerComp } from "./comps";
import type { TextRenderSpec } from "./paint";
import type { VectorPath, VectorShape, VectorText } from "./tools";
import { DEFAULT_ADJUST } from "./adjust";

export const SAMPLE_NAME = "Alpenglow (sample)";
export const W = 1500;
export const H = 1000;
/** The waterline: where the mountains stand and the lake begins. */
export const HORIZON = 620;
/** The sun, setting into a saddle of the far range. */
export const SUN = { x: 930, y: 492, r: 40 };

/** Every node of the sample, by role. Ids are handed out by the editor. */
export interface SampleIds {
  title: string;
  titleText: string;
  divider: string;
  subtitle: string;
  vignette: string;
  blueHour: string;
  glow: string;
  contrast: string;
  landscape: string;
  birds: string;
  shore: string;
  sunPath: string;
  reflection: string;
  lake: string;
  alpenglow: string;
  near: string;
  far: string;
  sun: string;
  clouds: string;
  stars: string;
  sky: string;
}

const ROLES: (keyof SampleIds)[] = [
  "title",
  "titleText",
  "divider",
  "subtitle",
  "vignette",
  "blueHour",
  "glow",
  "contrast",
  "landscape",
  "birds",
  "shore",
  "sunPath",
  "reflection",
  "lake",
  "alpenglow",
  "near",
  "far",
  "sun",
  "clouds",
  "stars",
  "sky",
];

export function sampleIds(next: () => string): SampleIds {
  return Object.fromEntries(ROLES.map((r) => [r, next()])) as unknown as SampleIds;
}

/** The layers that carry a raster mask; sample-paint must paint one for each. */
export const MASKED = ["stars", "reflection", "vignette"] as const satisfies readonly (keyof SampleIds)[];

/** Leaves whose pixels are painted (everything that is not type, a fill, a
 *  group or an adjustment); sample-paint must have a painter for each. */
export const PAINTED = [
  "divider",
  "birds",
  "shore",
  "sunPath",
  "reflection",
  "lake",
  "alpenglow",
  "near",
  "far",
  "sun",
  "clouds",
  "stars",
] as const satisfies readonly (keyof SampleIds)[];

// ---- Type --------------------------------------------------------------------

const TITLE_SIZE = 132;

export const TITLE_SPEC: TextRenderSpec = {
  text: "Alpenglow",
  x: W / 2,
  y: 70,
  boxW: null,
  fontFamily: "Georgia",
  fontSize: TITLE_SIZE,
  bold: false,
  italic: true,
  underline: false,
  strike: false,
  align: "center",
  lineHeight: 1.1,
  tracking: 1,
  color: "#fff6eaff",
  antialias: true,
  fill: {
    kind: "gradient",
    gradient: {
      stops: [
        { pos: 0, color: "#fffbf4ff" },
        { pos: 1, color: "#ffcfa3ff" },
      ],
      type: "linear",
      angle: 90,
      scale: 0.5,
      reverse: false,
      smooth: true,
    },
  },
};

/** The rule under the title: a vector shape, re-editable with the Shape tool. */
export const DIVIDER: VectorShape = {
  type: "shape",
  shape: "rect",
  x: W / 2 - 70,
  y: TITLE_SPEC.y + TITLE_SIZE * 1.1 + 16,
  w: 140,
  h: 3,
  angle: 0,
  fill: "#ffe0c4d9",
  stroke: "",
  strokeWidth: 0,
  radius: 1.5,
};

export const SUBTITLE_SPEC: TextRenderSpec = {
  text: "Poke the layers, try the brushes, break nothing — Ctrl+Z has you.",
  x: W / 2,
  y: DIVIDER.y + 22,
  boxW: null,
  fontFamily: "Arial",
  fontSize: 24,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  align: "center",
  lineHeight: 1.3,
  tracking: 0.5,
  color: "#fff4ebde",
  antialias: true,
};

/** The two text layers, for the loader to rasterise once the document exists. */
export const sampleTexts = (ids: SampleIds): { id: string; spec: TextRenderSpec }[] => [
  { id: ids.titleText, spec: TITLE_SPEC },
  { id: ids.subtitle, spec: SUBTITLE_SPEC },
];

// ---- Birds: a vector path, the kind an imported SVG makes ---------------------

/** A gull, wings up, as one open path: `s` is the half-span. */
const gull = (x: number, y: number, s: number, lift: number) =>
  `M ${x - s} ${y + lift} Q ${x - s * 0.45} ${y - s * 0.62} ${x} ${y} ` +
  `Q ${x + s * 0.5} ${y - s * 0.55} ${x + s} ${y + lift * 0.6}`;

/** Over the sun, against the glow: x, y, half-span, wing lift. */
const FLOCK: [number, number, number, number][] = [
  [1040, 372, 14, 3],
  [1082, 350, 10, -2],
  [1113, 388, 12, 2],
  [1146, 364, 8, 1],
  [1004, 398, 9, -1],
  [1172, 345, 6, 1],
];

export const BIRDS: VectorPath = {
  type: "path",
  paths: FLOCK.map(([x, y, s, lift]) => ({
    d: gull(x, y, s, lift),
    matrix: [1, 0, 0, 1, 0, 0],
    fill: "",
    fillRule: "nonzero",
    stroke: "#1c1531ff",
    strokeWidth: 2.4,
    cap: "round",
    join: "round",
    miter: 4,
    dash: [],
  })),
  bbox: {
    x: Math.min(...FLOCK.map(([x, , s]) => x - s)) - 2,
    y: Math.min(...FLOCK.map(([, y, s]) => y - s)) - 2,
    w: Math.max(...FLOCK.map(([x, , s]) => x + s)) - Math.min(...FLOCK.map(([x, , s]) => x - s)) + 4,
    h: Math.max(...FLOCK.map(([, y, , l]) => y + Math.abs(l))) - Math.min(...FLOCK.map(([, y, s]) => y - s)) + 4,
  },
};

// ---- The tree ----------------------------------------------------------------

const leaf = (id: string, name: string, extra: Partial<LayerLeaf> = {}): LayerLeaf => ({
  id,
  type: "layer",
  name,
  visible: true,
  opacity: 100,
  blend: "Normal",
  ...extra,
});

const adjustment = (
  id: string,
  name: string,
  spec: LayerAdjustment["adjustment"],
  extra: Partial<LayerAdjustment> = {},
): LayerAdjustment => ({
  id,
  type: "adjustment",
  name,
  visible: true,
  opacity: 100,
  blend: "Normal",
  label: "orange",
  adjustment: spec,
  ...extra,
});

const IDENTITY = [
  { x: 0, y: 0 },
  { x: 255, y: 255 },
];

const shadow = (opacity: number, size: number, distance: number) => ({
  enabled: true,
  blendMode: "Multiply",
  opacity,
  color: "#1a0f2e",
  angle: 90,
  distance,
  spread: 0,
  size,
  useGlobalLight: false,
});

/**
 * The layer tree, top to bottom.
 *
 * The adjustment layers sit at the TOP LEVEL, above the Landscape group, and
 * that is not a matter of tidiness: an adjustment re-processes what is below
 * it within its own parent, and a group here composites its children first
 * (there is no pass-through), so an adjustment inside a "Grade" group would
 * grade nothing. `textBounds` measures the type, for the re-edit hit test.
 */
export function sampleTree(
  ids: SampleIds,
  textBounds: (spec: TextRenderSpec) => { x: number; y: number; w: number; h: number },
): LayerNode[] {
  const text = (spec: TextRenderSpec): VectorText => ({ type: "text", ...spec, bbox: textBounds(spec) });
  const reveal = { enabled: true, linked: true };
  return [
    {
      id: ids.title,
      type: "group",
      name: "Title",
      visible: true,
      opacity: 100,
      blend: "Normal",
      label: "purple",
      expanded: true,
      children: [
        leaf(ids.titleText, "Alpenglow", {
          vector: text(TITLE_SPEC),
          effects: {
            dropShadow: shadow(55, 22, 5),
            outerGlow: {
              enabled: true,
              blendMode: "Screen",
              opacity: 30,
              color: "#ffb38a",
              spread: 0,
              size: 30,
            },
          },
        }),
        leaf(ids.divider, "Rule", { vector: DIVIDER }),
        leaf(ids.subtitle, "Poke the layers…", {
          vector: text(SUBTITLE_SPEC),
          effects: { dropShadow: shadow(50, 8, 2) },
        }),
      ],
    },
    leaf(ids.vignette, "Vignette", {
      fill: { kind: "solid", color: "#24122f" },
      blend: "Multiply",
      opacity: 70,
      label: "orange",
      mask: reveal,
    }),
    adjustment(
      ids.blueHour,
      "Blue hour",
      {
        type: "sliders",
        params: {
          ...DEFAULT_ADJUST,
          exposure: -30,
          contrast: 10,
          highlights: -25,
          temperature: -55,
          tint: 10,
          vibrance: 12,
          saturation: -12,
        },
      },
      { visible: false },
    ),
    adjustment(
      ids.glow,
      "Golden glow",
      {
        type: "gradientmap",
        stops: [
          { pos: 0, color: "#1c1238" },
          { pos: 0.5, color: "#c4607a" },
          { pos: 1, color: "#ffe0a8" },
        ],
        reverse: false,
      },
      { blend: "Soft Light", opacity: 50 },
    ),
    adjustment(ids.contrast, "Evening contrast", {
      type: "curves",
      channels: {
        rgb: [
          { x: 0, y: 0 },
          { x: 62, y: 50 },
          { x: 190, y: 204 },
          { x: 255, y: 255 },
        ],
        r: IDENTITY,
        g: IDENTITY,
        b: IDENTITY,
      },
    }),
    {
      id: ids.landscape,
      type: "group",
      name: "Landscape",
      visible: true,
      opacity: 100,
      blend: "Normal",
      label: "green",
      expanded: true,
      children: [
        leaf(ids.birds, "Birds", { vector: BIRDS }),
        leaf(ids.shore, "Shore & pines"),
        leaf(ids.sunPath, "Sun on the water", { blend: "Screen" }),
        leaf(ids.reflection, "Reflection", {
          opacity: 80,
          mask: reveal,
          // Smart filters: the ripple and the streak are not in the pixels.
          // Hide either in the Layers panel and the water goes still.
          filters: [
            {
              id: "sample-wave",
              enabled: true,
              blendMode: "Normal",
              opacity: 100,
              type: "distort",
              params: {
                mode: "wave",
                angle: 0,
                radius: 60,
                amount: 0,
                amplitude: 2.5,
                wavelength: 11,
                edge: "clamp",
              },
            },
            {
              id: "sample-streak",
              enabled: true,
              blendMode: "Normal",
              opacity: 100,
              type: "blur",
              params: {
                kind: "motion",
                amount: 14,
                angle: 90,
                anchor: { x: 0.5, y: 0.5 },
                band: 20,
                feather: 30,
                threshold: 40,
              },
            },
          ],
        }),
        leaf(ids.lake, "Lake"),
        // Clipped to the range below it: the warm light lands on the
        // mountains and nowhere else.
        leaf(ids.alpenglow, "Alpenglow light", { blend: "Screen", opacity: 60, clipped: true }),
        leaf(ids.near, "Mountains, near"),
        leaf(ids.far, "Mountains, far"),
        leaf(ids.sun, "Sun", {
          effects: {
            outerGlow: {
              enabled: true,
              blendMode: "Screen",
              opacity: 75,
              color: "#ffb070",
              spread: 0,
              size: 120,
            },
          },
        }),
        leaf(ids.clouds, "Clouds", { opacity: 92 }),
        leaf(ids.stars, "Stars", { blend: "Screen", visible: false, mask: reveal }),
        leaf(ids.sky, "Sky", {
          label: "blue",
          fill: {
            kind: "gradient",
            gradient: {
              // A vertical span exactly the canvas's height: stop positions
              // are heights (0 = top, 0.62 = the horizon).
              type: "linear",
              angle: 90,
              scale: H / Math.hypot(W, H),
              reverse: false,
              smooth: true,
              stops: [
                { pos: 0, color: "#0e1838" },
                { pos: 0.2, color: "#1f2f63" },
                { pos: 0.37, color: "#4a4589" },
                { pos: 0.49, color: "#9c5a8e" },
                { pos: 0.56, color: "#e2806f" },
                { pos: 0.6, color: "#ffb27c" },
                { pos: HORIZON / H, color: "#ffcb94" },
                { pos: 1, color: "#f0b48e" },
              ],
            },
          },
        }),
      ],
    },
  ];
}

// ---- Layer comps -----------------------------------------------------------------

/** Which nodes each comp shows that the picture as it opens does not, and
 *  the other way round. Everything else keeps its opening visibility. */
const COMPS: { name: string; comment: string; show?: (keyof SampleIds)[]; hide?: (keyof SampleIds)[] }[] = [
  { name: "Golden hour", comment: "The picture as it opens." },
  {
    name: "Blue hour",
    comment: "After sunset: the sun gone, the stars out, the grade cooled.",
    show: ["stars", "blueHour"],
    hide: ["sun", "sunPath", "glow", "alpenglow"],
  },
  {
    name: "Before grading",
    comment: "The landscape as painted, with every adjustment layer off.",
    hide: ["contrast", "glow", "blueHour", "vignette"],
  },
  { name: "Photo only", comment: "Without the title.", hide: ["title"] },
];

/** Every node's id and its opening visibility, depth first. */
function visibilities(tree: LayerNode[], out = new Map<string, boolean>()): Map<string, boolean> {
  for (const n of tree) {
    out.set(n.id, n.visible);
    if (n.type === "group") visibilities(n.children, out);
  }
  return out;
}

/** The four comps, each recording the visibility of EVERY node — so applying
 *  one puts the whole document in that state, whatever was toggled before. */
export function sampleComps(ids: SampleIds, tree: LayerNode[]): LayerComp[] {
  const base = visibilities(tree);
  return COMPS.map((c, i) => {
    const states: LayerComp["states"] = {};
    for (const [id, visible] of base) states[id] = { visible };
    for (const r of c.show ?? []) states[ids[r]] = { visible: true };
    for (const r of c.hide ?? []) states[ids[r]] = { visible: false };
    return { id: `sample-comp-${i + 1}`, name: c.name, comment: c.comment, capture: ["visibility"], states };
  });
}
