import type { LucideIcon } from "lucide-react";
import {
  Bandage,
  Eye,
  MousePointer2,
  Move,
  BoxSelect,
  Lasso,
  Wand2,
  Crop,
  Pipette,
  Brush,
  Pencil,
  Eraser,
  Ruler,
  Stamp,
  PaintBucket,
  Blend,
  Droplet,
  Droplets,
  Fingerprint,
  History,
  SunMedium,
  Type,
  PenTool,
  Shapes,
  Hand,
  ZoomIn,
} from "lucide-react";

export type ToolId =
  | "move"
  | "select"
  | "lasso"
  | "wand"
  | "crop"
  | "eyedropper"
  | "measure"
  | "brush"
  | "pencil"
  | "eraser"
  | "history"
  | "clone"
  | "heal"
  | "redeye"
  | "bucket"
  | "gradient"
  | "blur"
  | "smudge"
  | "dodge"
  | "sponge"
  | "text"
  | "pen"
  | "shape"
  | "hand"
  | "zoom";

export interface Tool {
  id: ToolId;
  name: string;
  icon: LucideIcon;
  shortcut: string;
}

/** Tools grouped the way they sit on the rail; each inner array is a cluster. */
export const TOOL_GROUPS: Tool[][] = [
  [
    { id: "move", name: "Move", icon: Move, shortcut: "V" },
    { id: "select", name: "Rectangular marquee", icon: BoxSelect, shortcut: "M" },
    { id: "lasso", name: "Lasso", icon: Lasso, shortcut: "L" },
    { id: "wand", name: "Magic wand", icon: Wand2, shortcut: "W" },
    { id: "crop", name: "Crop", icon: Crop, shortcut: "C" },
    { id: "eyedropper", name: "Eyedropper", icon: Pipette, shortcut: "I" },
    { id: "measure", name: "Measure", icon: Ruler, shortcut: "I" },
  ],
  [
    { id: "brush", name: "Brush", icon: Brush, shortcut: "B" },
    { id: "pencil", name: "Pencil", icon: Pencil, shortcut: "N" },
    { id: "eraser", name: "Eraser", icon: Eraser, shortcut: "E" },
    { id: "history", name: "History brush", icon: History, shortcut: "K" },
    { id: "clone", name: "Clone stamp", icon: Stamp, shortcut: "S" },
    { id: "heal", name: "Spot heal", icon: Bandage, shortcut: "J" },
    { id: "redeye", name: "Red eye", icon: Eye, shortcut: "Y" },
    { id: "bucket", name: "Paint bucket", icon: PaintBucket, shortcut: "G" },
    { id: "gradient", name: "Gradient", icon: Blend, shortcut: "G" },
  ],
  [
    { id: "blur", name: "Blur", icon: Droplet, shortcut: "R" },
    { id: "smudge", name: "Smudge", icon: Fingerprint, shortcut: "F" },
    { id: "dodge", name: "Dodge", icon: SunMedium, shortcut: "O" },
    { id: "sponge", name: "Sponge", icon: Droplets, shortcut: "A" },
  ],
  [
    { id: "text", name: "Text", icon: Type, shortcut: "T" },
    { id: "pen", name: "Pen", icon: PenTool, shortcut: "P" },
    { id: "shape", name: "Shape", icon: Shapes, shortcut: "U" },
  ],
  [
    { id: "hand", name: "Hand", icon: Hand, shortcut: "H" },
    { id: "zoom", name: "Zoom", icon: ZoomIn, shortcut: "Z" },
  ],
];

export const ALL_TOOLS: Tool[] = TOOL_GROUPS.flat();

export const DEFAULT_TOOL: ToolId = "brush";

/** Move tool sub-mode: move the marquee outline only, or the actual pixels. */
export type MoveMode = "pixels" | "selection";

/** Gradient tool: how the colour band is laid out. */
export type GradientType = "linear" | "radial" | "angle" | "reflected";

/** One colour stop of a gradient (pos 0..1 along the band). */
export interface GradientStop {
  color: string;
  pos: number;
}

/** A saved multi-colour gradient. */
export interface GradientPreset {
  id: string;
  name: string;
  stops: GradientStop[];
}

/** Gradient tool settings. `stops: null` means use the primary→secondary colour. */
export interface GradientSettings {
  type: GradientType;
  reverse: boolean;
  /** Angle gradients only: blend across the wrap seam to soften its hard edge. */
  smooth: boolean;
  stops: GradientStop[] | null;
}

/** A measure/ruler line (two endpoints in document space). */
export interface MeasureLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Derived readout for a measure line: pixel deltas, length, and angle. The
 *  angle is degrees from the +x axis, POSITIVE COUNTER-CLOCKWISE (screen y is
 *  down, so we negate) — matching Photoshop's ruler (drag up-right ⇒ positive).
 *  `straighten` is the deviation from the nearest 90° axis, in (−45, 45], i.e.
 *  the rotation needed to level the line to horizontal/vertical. */
export function measureInfo(m: MeasureLine): {
  dx: number;
  dy: number;
  length: number;
  angle: number;
  straighten: number;
} {
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const length = Math.hypot(dx, dy);
  const angle = -(Math.atan2(dy, dx) * 180) / Math.PI;
  // Fold onto (−45, 45]: how far the line tilts off the nearest axis.
  let dev = ((angle % 90) + 90) % 90; // [0, 90)
  if (dev > 45) dev -= 90; // (−45, 45]
  return { dx, dy, length, angle, straighten: dev };
}

/** Shape tool: the geometry being drawn. */
export type ShapeKind = "rect" | "ellipse" | "tri" | "trapezoid";

/** Shape tool settings (fill = primary colour, stroke = secondary colour). */
export interface ShapeSettings {
  kind: ShapeKind;
  strokeWidth: number;
  radius: number;
}

/** One anchor of a pen path: the point plus its two bezier control handles
 *  (absolute doc coords). A "corner" has its handles sitting on the point. */
export interface PenAnchor {
  x: number;
  y: number;
  ix: number; // incoming handle (controls the curve arriving here)
  iy: number;
  ox: number; // outgoing handle (controls the curve leaving here)
  oy: number;
}

/** Pen tool stroke options (colour = the primary colour). */
export interface PenSettings {
  width: number; // base stroke width, px
  taper: number; // 0..1 — taper an open path's ends toward a point
  bend: number; // -1..1 — how much curvature widens (+) or narrows (−) the stroke
}

/** Crop tool: overlay guide drawn inside the crop box. */
export type CropGrid = "none" | "thirds" | "grid" | "diagonal" | "golden";

/** Crop tool settings (the crop rectangle itself lives in the canvas overlay). */
export interface CropSettings {
  /** Aspect-ratio constraint id; see CROP_RATIOS plus "free" | "original" | "custom". */
  ratio: string;
  /** Custom ratio numerator / denominator (used when ratio === "custom"). */
  customW: number;
  customH: number;
  /** Composition overlay drawn inside the crop box. */
  grid: CropGrid;
  /** Darkness (0–100%) of the shield dimming the area outside the crop box. */
  shield: number;
  /** Straighten / rotate the crop, −45…45°. */
  straighten: number;
  /** Perspective mode: the crop box becomes a free quadrilateral that resamples
   *  to a rectangle on apply (correcting perspective). */
  perspective: boolean;
}

/** The four corners of a perspective-crop quad, in tl, tr, br, bl order (doc space). */
export type CropQuad = [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];

/** Built-in aspect-ratio presets for the crop tool (w : h). */
export const CROP_RATIOS: { id: string; label: string; w: number; h: number }[] = [
  { id: "1:1", label: "1 : 1", w: 1, h: 1 },
  { id: "3:2", label: "3 : 2", w: 3, h: 2 },
  { id: "2:3", label: "2 : 3", w: 2, h: 3 },
  { id: "4:3", label: "4 : 3", w: 4, h: 3 },
  { id: "3:4", label: "3 : 4", w: 3, h: 4 },
  { id: "16:9", label: "16 : 9", w: 16, h: 9 },
  { id: "9:16", label: "9 : 16", w: 9, h: 16 },
  { id: "5:4", label: "5 : 4", w: 5, h: 4 },
  { id: "4:5", label: "4 : 5", w: 4, h: 5 },
  { id: "7:5", label: "7 : 5", w: 7, h: 5 },
];

export const DEFAULT_CROP: CropSettings = {
  ratio: "free",
  customW: 1,
  customH: 1,
  grid: "thirds",
  shield: 65,
  straighten: 0,
  perspective: false,
};

/**
 * Resolve a crop settings object to a numeric aspect ratio (w / h), or null for a
 * free (unconstrained) crop. `original` is the current document's aspect ratio.
 */
export function cropAspect(s: CropSettings, original: number): number | null {
  if (s.ratio === "free") return null;
  if (s.ratio === "original") return original;
  if (s.ratio === "custom") {
    return s.customW > 0 && s.customH > 0 ? s.customW / s.customH : null;
  }
  const p = CROP_RATIOS.find((r) => r.id === s.ratio);
  return p ? p.w / p.h : null;
}

/** Blur tool (a focus brush that softens pixels as you paint). */
export interface BlurSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
  /** How strongly each stroke mixes in the blur, 0–100%. */
  strength: number;
  /** Blur kernel radius (how soft the softening is), px. */
  radius: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Sample the active layer only, or the merged composite of all layers. */
  sampleAll: boolean;
}

export const DEFAULT_BLUR: BlurSettings = {
  size: 40,
  hardness: 50,
  strength: 50,
  radius: 8,
  smoothing: 20,
  spacing: 15,
  sampleAll: false,
};

/** Smudge tool: drags colour along the stroke like a finger through wet paint.
 *  Unlike Blur/Dodge/Sponge (which recompute from the original by a coverage
 *  mask) this is a stateful smear — a "carried" colour that the stroke pushes
 *  forward — so the engine paints it incrementally in place. */
export interface SmudgeSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
  /** How far the colour is carried (higher = longer smear), 0–100%. */
  strength: number;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
  /** Pick up colour from the merged composite of all layers (paints the active). */
  sampleAll: boolean;
  /** Start the smear with the foreground colour instead of the pixels beneath. */
  fingerPaint: boolean;
}

export const DEFAULT_SMUDGE: SmudgeSettings = {
  size: 40,
  hardness: 50,
  strength: 50,
  spacing: 12,
  smoothing: 20,
  sampleAll: false,
  fingerPaint: false,
};

/** Text tool: paragraph alignment. */
export type TextAlign = "left" | "center" | "right" | "justify";

/** Character-level style one rich-text run carries (block-level properties —
 *  align, leading, tracking — stay on the text block itself). */
export interface TextRunStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Fill colour, #rrggbbaa. */
  color: string;
}

/** One run of a rich text block: `len` characters (of the block's flat text,
 *  newlines included) sharing one style. Runs cover the text exactly. */
export interface TextRun extends TextRunStyle {
  len: number;
}

/** Text tool settings (a styled live editor that rasterizes onto a layer). */
/** OpenType feature toggles (block-level). An absent field means the font's
 *  own default, so an empty/absent object renders byte-identically to before
 *  the feature existed. `liga`/`calt` are ON by default in browsers — setting
 *  them false emits the "off" tags; every other flag opts IN when true. */
export interface TextOpenType {
  /** Standard + contextual ligatures (fi, ffl, …). False turns them OFF. */
  liga?: boolean;
  /** Discretionary ligatures (decorative — ct, st, …). */
  dlig?: boolean;
  /** Contextual alternates. False turns them OFF. */
  calt?: boolean;
  /** Small caps. */
  smcp?: boolean;
  /** Oldstyle (text) figures. */
  onum?: boolean;
  /** Tabular (fixed-width) figures. */
  tnum?: boolean;
  /** Diagonal fractions (1/2 → ½-style). */
  frac?: boolean;
  /** Slashed zero. */
  zero?: boolean;
  /** Stylistic alternates. */
  salt?: boolean;
  /** Stylistic set 1. */
  ss01?: boolean;
}

/** Variable-font axes (block-level; no effect on static fonts).
 *  `wght` 100–900 overrides the bold toggle; `wdth` is a percent that maps to
 *  the nearest CSS font-stretch keyword (canvas accepts only the keywords). */
export interface TextAxes {
  wght?: number;
  wdth?: number;
}

export interface TextSettings {
  fontFamily: string;
  /** Font size, px. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  align: TextAlign;
  /** Line height as a multiple of the font size (leading). */
  lineHeight: number;
  /** Letter spacing (tracking), px. */
  tracking: number;
  /** Fill colour, #rrggbbaa. */
  color: string;
  /** Smooth (anti-aliased) edges when rasterized; off gives hard 1-bit edges. */
  antialias: boolean;
  /** OpenType features (absent = font defaults). */
  features?: TextOpenType;
  /** Variable-font axes (absent = weight from `bold`, normal width). */
  axes?: TextAxes;
}

/** Font choices offered in the text options bar (web-safe families, plus a
 *  few Windows-shipped OpenType/variable fonts so features and axes have
 *  something real to bite on — elsewhere they fall back gracefully). */
export const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Garamond",
  "Courier New",
  "Impact",
  "Comic Sans MS",
  "Calibri",
  "Bahnschrift",
  "Segoe UI Variable",
];

export const DEFAULT_TEXT: TextSettings = {
  fontFamily: "Arial",
  fontSize: 48,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  align: "left",
  lineHeight: 1.2,
  tracking: 0,
  // Seeded from the primary colour when a text edit begins (see CanvasArea).
  color: "#6366f1ff",
  antialias: true,
};

/**
 * Vector source kept on a layer so a rasterized shape/text can be re-selected and
 * edited again. The layer's pixels are the rasterized result; this is the recipe.
 */
export interface VectorText {
  type: "text";
  text: string;
  x: number;
  y: number;
  boxW: number | null;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  align: TextAlign;
  lineHeight: number;
  tracking: number;
  color: string;
  antialias: boolean;
  /** Rich runs (mixed fonts/sizes/colours). Absent = uniform block using the
   *  fields above; when present, runs cover `text` exactly and the flat
   *  fontFamily/size/bold/… fields are the base (caret) style. */
  runs?: TextRun[];
  /** OpenType features / variable axes (block-level; absent = defaults). */
  features?: TextOpenType;
  axes?: TextAxes;
  /** Rasterized bounds (doc px), for hit-testing the re-edit double-click. */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface VectorShape {
  type: "shape";
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation (radians) about the box centre. */
  angle: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
  /** Trapezoid side insets (fraction of width), if shape === "trapezoid". */
  trap?: { l: number; r: number };
  /** Triangle apex position (fraction of width), if shape === "tri". */
  apex?: number;
}

/** One styled subpath of an imported vector graphic (SVG). Coordinates live in
 *  the source element's own user space; `matrix` maps them into document space
 *  (import placement folds into e/f), so re-rasterizing at any scale stays
 *  crisp. `d` is SVG path syntax — `Path2D` parses it natively. */
export interface VectorPathElement {
  d: string;
  /** Element → document affine transform [a, b, c, d, e, f]. */
  matrix: [number, number, number, number, number, number];
  /** Fill colour (#rrggbbaa), "" = none. */
  fill: string;
  fillRule: "nonzero" | "evenodd";
  /** Stroke colour (#rrggbbaa), "" = none. Width/dash are in element units. */
  stroke: string;
  strokeWidth: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miter: number;
  dash: number[];
}

/** An imported vector graphic (e.g. an SVG): styled subpaths painted in order
 *  (first = bottom). Like the other recipes, the layer's pixels are the
 *  rasterized result and this is the re-renderable source. */
export interface VectorPath {
  type: "path";
  paths: VectorPathElement[];
  /** Rasterized bounds (doc px), for hit-testing / info. */
  bbox: { x: number; y: number; w: number; h: number };
}

export type VectorData = VectorText | VectorShape | VectorPath;

/** Clone Stamp tool (Alt-click sets the source, then paint copies sampled pixels). */
export interface CloneSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
  /** Overall stroke opacity, 0–100%. */
  opacity: number;
  /** Per-dab paint build-up, 0–100%. */
  flow: number;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
  /** Keep the source↔destination offset across separate strokes (vs. re-anchor). */
  aligned: boolean;
  /** Sample the active layer only, or the merged composite of all layers. */
  sampleAll: boolean;
}

export const DEFAULT_CLONE: CloneSettings = {
  size: 60,
  hardness: 70,
  opacity: 100,
  flow: 100,
  spacing: 10,
  smoothing: 15,
  aligned: true,
  sampleAll: false,
};

/** Dodge/Burn tool: lighten (dodge) or darken (burn). */
export type DodgeMode = "dodge" | "burn";
/** Which tonal range the dodge/burn most affects. */
export type DodgeRange = "shadows" | "midtones" | "highlights";

/** Dodge/Burn tool settings (a tonal brush that lightens or darkens as you paint). */
export interface DodgeSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
  /** Strength of each pass, 0–100%. */
  exposure: number;
  /** Lighten (dodge) or darken (burn). */
  mode: DodgeMode;
  /** Tonal range the effect concentrates on. */
  range: DodgeRange;
  /** Protect tones: preserve hue/saturation and limit clipping. */
  protect: boolean;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
}

/** Spot-heal brush settings. Paint a blob over a blemish; it heals on release
 *  (texture from the best-matching surroundings, tone-matched seamlessly). */
export interface HealSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
}

export const DEFAULT_HEAL: HealSettings = {
  size: 40,
  hardness: 65,
};

/** Red-eye tool settings. One click neutralizes + darkens the red pupil blob
 *  it finds near the cursor. */
export interface RedEyeSettings {
  /** Search diameter, px (roughly the pupil size). */
  size: number;
  /** How dark the fixed pupil goes, 0–100 (0 = only remove the red). */
  darken: number;
}

export const DEFAULT_REDEYE: RedEyeSettings = {
  size: 30,
  darken: 50,
};

export const DEFAULT_DODGE: DodgeSettings = {
  size: 60,
  hardness: 50,
  exposure: 50,
  mode: "dodge",
  range: "midtones",
  protect: true,
  spacing: 12,
  smoothing: 15,
};

/** Sponge tool: saturate or desaturate as you paint. Same coverage-mask session
 *  model as Dodge/Burn (recompute from the original by coverage × flow), so a
 *  stroke stays even and successive strokes compound. */
export type SpongeMode = "saturate" | "desaturate";

export interface SpongeSettings {
  /** Brush diameter, px. */
  size: number;
  /** Brush edge softness, 0–100. */
  hardness: number;
  /** Strength of each pass, 0–100%. */
  flow: number;
  /** Add or remove saturation. */
  mode: SpongeMode;
  /** Protect already-saturated colours from clipping (minimises banding). */
  vibrance: boolean;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
}

export const DEFAULT_SPONGE: SpongeSettings = {
  size: 60,
  hardness: 50,
  flow: 50,
  mode: "saturate",
  vibrance: true,
  spacing: 12,
  smoothing: 15,
};

/** Blur Gallery (Effects ▸ Blur Gallery): the available blur algorithms. */
export type BlurFxKind =
  | "box"
  | "gaussian"
  | "motion"
  | "zoom"
  | "spin"
  | "bokeh"
  | "tiltshift"
  | "surface"
  | "spread";

/** Where a blur effect is applied. */
export type BlurFxScope = "layer" | "canvas";

export interface BlurFxSettings {
  kind: BlurFxKind;
  /** Primary strength — radius (px) for box/gaussian/bokeh/tilt-shift/surface/
   *  spread, length for motion, strength (%) for zoom, angle (°) for spin. */
  amount: number;
  /** Direction in degrees (motion blur + the tilt-shift focus line). */
  angle: number;
  /** Centre point for zoom / spin / tilt-shift, normalized 0–1 of the document. */
  anchor: { x: number; y: number };
  /** Tilt-shift: sharp focus band half-size, % of the shorter document side. */
  band: number;
  /** Tilt-shift: sharp→blurred transition size, % of the shorter document side. */
  feather: number;
  /** Surface: edge threshold (%) — how different a neighbour may be and still blend. */
  threshold: number;
  /** "layer" = active layer only; "canvas" = every layer (the whole document). */
  scope: BlurFxScope;
}

export const BLUR_FX_LABELS: Record<BlurFxKind, string> = {
  box: "Box",
  gaussian: "Gaussian",
  motion: "Motion",
  zoom: "Zoom",
  spin: "Spin",
  bokeh: "Bokeh",
  tiltshift: "Tilt-Shift",
  surface: "Surface",
  spread: "Spread",
};

export const DEFAULT_BLUR_FX: BlurFxSettings = {
  kind: "gaussian",
  amount: 12,
  angle: 0,
  anchor: { x: 0.5, y: 0.5 },
  band: 20,
  feather: 30,
  threshold: 40,
  scope: "layer",
};

/** Rectangular-marquee tool shape: a rectangle, ellipse, or triangle region. */
/** Lasso variants: freehand drag, click-point polygon, edge-snapping drag. */
export type LassoMode = "free" | "poly" | "magnetic";

export type MarqueeShape = "rect" | "ellipse" | "triangle";

/** Marquee resize sub-mode: resize the outline only, or scale the pixels inside. */
export type SelectResizeMode = "bounds" | "content";

/** Eyedropper sampling options. */
export const SAMPLE_SIZE_OPTIONS = [
  "Point sample",
  "3×3 average",
  "5×5 average",
  "11×11 average",
];
export const SAMPLE_SIZE_PX: Record<string, number> = {
  "Point sample": 1,
  "3×3 average": 3,
  "5×5 average": 5,
  "11×11 average": 11,
};
export const SAMPLE_SCOPE_OPTIONS = ["All layers", "Current layer"];

// (TOOL_BY_KEY was retired 2026-07 — tool keys now dispatch through the
// shortcut registry in shortcuts.ts, which preserves its first-match-wins
// rule for duplicate letters and adds user remapping.)

export const getTool = (id: ToolId): Tool =>
  ALL_TOOLS.find((t) => t.id === id) ?? ALL_TOOLS[0];

/** Pointer cursor preview used in the options bar headline. */
export { MousePointer2 };
