// The options bar's state: every tool's settings (TODO 1.5, the `toolOptions`
// slice) and the two colours (the `colors` slice). Both are restored from the
// last session and saved back as they change — one bundle, `ToolPrefs`.

import type { FrameFit } from "../lib/frame";
import { DEFAULT_MIXER, sanitizeMixer, type MixerSettings } from "../lib/mixer";
import type { BrushSettings } from "../lib/paint";
import type { ToolPrefs, BucketSettings, WandSettings } from "../lib/toolPrefs";
import {
  DEFAULT_BLUR,
  DEFAULT_CLONE,
  DEFAULT_CROP,
  DEFAULT_DODGE,
  DEFAULT_HEAL,
  DEFAULT_QUICKSELECT,
  DEFAULT_REDEYE,
  DEFAULT_SMUDGE,
  DEFAULT_SPONGE,
  DEFAULT_TEXT,
  type BlurSettings,
  type CloneSettings,
  type CropSettings,
  type DodgeSettings,
  type GradientSettings,
  type HealSettings,
  type LassoMode,
  type MarqueeShape,
  type MoveMode,
  type PenSettings,
  type QuickSelectSettings,
  type RedEyeSettings,
  type SelectResizeMode,
  type ShapeSettings,
  type SmudgeSettings,
  type SpongeSettings,
  type TextSettings,
} from "../lib/tools";
import { createStore, type Store } from "./store";

export interface Colors {
  /** Primary and secondary, #rrggbbaa. */
  foreground: string;
  background: string;
  /** Which of the two the paint tools and the Eyedropper use. */
  activeSlot: "primary" | "secondary";
}

export interface ToolOptions {
  brush: BrushSettings;
  eraser: BrushSettings;
  pencil: BrushSettings;
  wand: WandSettings;
  bucket: BucketSettings;
  shape: ShapeSettings;
  gradient: GradientSettings;
  pen: PenSettings;
  blur: BlurSettings;
  quickSelect: QuickSelectSettings;
  smudge: SmudgeSettings;
  mixer: MixerSettings;
  /** The Frame tool's next frame. Not saved. */
  frameShape: "rect" | "ellipse";
  /** Fit for NEW frames. An existing frame carries its own in its spec, and the
   *  options bar edits that one when a frame layer is selected. Not saved. */
  frameFit: FrameFit;
  sponge: SpongeSettings;
  historyBrush: BrushSettings;
  heal: HealSettings;
  redEye: RedEyeSettings;
  clone: CloneSettings;
  dodge: DodgeSettings;
  text: TextSettings;
  crop: CropSettings;
  moveMode: MoveMode;
  autoSelect: boolean;
  autoSelectScope: "layer" | "group";
  showTransform: boolean;
  alignToCanvas: boolean;
  resizeMode: SelectResizeMode;
  resizeSmooth: boolean;
  marqueeShape: MarqueeShape;
  lassoMode: LassoMode;
  triangleApex: number;
  /** The Eyedropper's sample size and scope, as their menus label them. */
  sampleSize: string;
  sampleScope: string;
}

export const DEFAULT_COLORS: Colors = { foreground: "#6366f1ff", background: "#ffffffff", activeSlot: "primary" };

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  brush: { size: 24, hardness: 80, opacity: 100, flow: 100, blend: "Normal", smoothing: 20 },
  eraser: { size: 30, hardness: 90, opacity: 100, flow: 100, blend: "Normal", smoothing: 10 },
  // Pencil: a hard-edged, pixel-perfect tool — always full hardness, no smoothing.
  pencil: { size: 4, hardness: 100, opacity: 100, flow: 100, blend: "Normal", smoothing: 0 },
  wand: { tolerance: 32, contiguous: true, sampleAll: false },
  bucket: { tolerance: 32, opacity: 100, contiguous: true, antialias: false },
  shape: { kind: "rect", strokeWidth: 2, radius: 12 },
  gradient: { type: "linear", reverse: false, smooth: false, stops: null },
  pen: { width: 8, taper: 0, bend: 0 },
  blur: DEFAULT_BLUR,
  quickSelect: DEFAULT_QUICKSELECT,
  smudge: DEFAULT_SMUDGE,
  mixer: DEFAULT_MIXER,
  frameShape: "rect",
  frameFit: "cover",
  sponge: DEFAULT_SPONGE,
  historyBrush: { size: 24, hardness: 80, opacity: 100, flow: 100, blend: "Normal", smoothing: 20 },
  heal: DEFAULT_HEAL,
  redEye: DEFAULT_REDEYE,
  clone: DEFAULT_CLONE,
  dodge: DEFAULT_DODGE,
  text: DEFAULT_TEXT,
  crop: DEFAULT_CROP,
  moveMode: "pixels",
  autoSelect: true,
  autoSelectScope: "layer",
  showTransform: false,
  alignToCanvas: false,
  resizeMode: "bounds",
  resizeSmooth: true,
  marqueeShape: "rect",
  lassoMode: "free",
  triangleApex: 0.5,
  sampleSize: "Point sample",
  sampleScope: "All layers",
};

/** Whose settings a tool's brush is: the pencil and the eraser keep their own,
 *  every other brush tool shares the brush's. */
export const brushOf = (tool: string): "brush" | "pencil" | "eraser" =>
  tool === "eraser" ? "eraser" : tool === "pencil" ? "pencil" : "brush";

/** The colour the paint tools use and the Eyedropper sets: the active slot's. */
export const slotColor = (slot: Colors["activeSlot"]): "foreground" | "background" =>
  slot === "primary" ? "foreground" : "background";

export const createColors = (): Store<Colors> => createStore({ ...DEFAULT_COLORS });
export const createToolOptions = (): Store<ToolOptions> => createStore({ ...DEFAULT_TOOL_OPTIONS });

/** What is saved: everything but the slot and the Frame tool's two — in the
 *  order it has always been written in. */
function prefsOf(c: Colors, t: ToolOptions): ToolPrefs {
  return {
    foreground: c.foreground,
    background: c.background,
    brush: t.brush,
    eraser: t.eraser,
    pencil: t.pencil,
    wand: t.wand,
    quickSelect: t.quickSelect,
    bucket: t.bucket,
    shape: t.shape,
    gradient: t.gradient,
    pen: t.pen,
    blur: t.blur,
    smudge: t.smudge,
    mixer: t.mixer,
    sponge: t.sponge,
    historyBrush: t.historyBrush,
    heal: t.heal,
    redEye: t.redEye,
    clone: t.clone,
    dodge: t.dodge,
    text: t.text,
    crop: t.crop,
    moveMode: t.moveMode,
    autoSelect: t.autoSelect,
    autoSelectScope: t.autoSelectScope,
    showTransform: t.showTransform,
    alignToCanvas: t.alignToCanvas,
    resizeMode: t.resizeMode,
    resizeSmooth: t.resizeSmooth,
    marqueeShape: t.marqueeShape,
    lassoMode: t.lassoMode,
    triangleApex: t.triangleApex,
    sampleSize: t.sampleSize,
    sampleScope: t.sampleScope,
  };
}

/** Bring back a saved session's options — merged over the defaults, field by
 *  field, so a bundle from an older version (or a partial one) still loads. */
export function restoreToolOptions(colors: Store<Colors>, tools: Store<ToolOptions>, p: Partial<ToolPrefs>): void {
  if (p.foreground) colors.set({ foreground: p.foreground });
  if (p.background) colors.set({ background: p.background });
  const t = tools.get();
  const merged: Partial<ToolOptions> = {};
  for (const k of [
    "brush",
    "eraser",
    "pencil",
    "wand",
    "bucket",
    "shape",
    "gradient",
    "pen",
    "blur",
    "quickSelect",
    "smudge",
    "sponge",
    "historyBrush",
    "heal",
    "redEye",
    "clone",
    "dodge",
    "text",
    "crop",
  ] as const) {
    if (p[k]) (merged as Record<string, unknown>)[k] = { ...t[k], ...p[k] };
  }
  if (p.mixer) merged.mixer = sanitizeMixer({ ...t.mixer, ...p.mixer });
  if (p.moveMode) merged.moveMode = p.moveMode;
  if (typeof p.autoSelect === "boolean") merged.autoSelect = p.autoSelect;
  if (p.autoSelectScope) merged.autoSelectScope = p.autoSelectScope;
  if (typeof p.showTransform === "boolean") merged.showTransform = p.showTransform;
  if (typeof p.alignToCanvas === "boolean") merged.alignToCanvas = p.alignToCanvas;
  if (p.resizeMode) merged.resizeMode = p.resizeMode;
  if (typeof p.resizeSmooth === "boolean") merged.resizeSmooth = p.resizeSmooth;
  if (p.marqueeShape) merged.marqueeShape = p.marqueeShape;
  if (p.lassoMode) merged.lassoMode = p.lassoMode;
  if (typeof p.triangleApex === "number") merged.triangleApex = p.triangleApex;
  if (p.sampleSize) merged.sampleSize = p.sampleSize;
  if (p.sampleScope) merged.sampleScope = p.sampleScope;
  tools.set(merged);
}

/** Save the options a quarter-second after they last changed. Returns the
 *  way to stop (a pending save is dropped). */
export function persistToolOptions(
  colors: Store<Colors>,
  tools: Store<ToolOptions>,
  save: (p: ToolPrefs) => void,
): () => void {
  let last = prefsOf(colors.get(), tools.get());
  let timer = 0;
  const changed = () => {
    const now = prefsOf(colors.get(), tools.get());
    const moved = (Object.keys(now) as (keyof ToolPrefs)[]).some((k) => !Object.is(now[k], last[k]));
    last = now;
    if (!moved) return; // the Frame tool's own two, or the slot: not saved
    window.clearTimeout(timer);
    timer = window.setTimeout(() => save(prefsOf(colors.get(), tools.get())), 250);
  };
  const offColors = colors.subscribe(changed);
  const offTools = tools.subscribe(changed);
  return () => {
    offColors();
    offTools();
    window.clearTimeout(timer);
  };
}
