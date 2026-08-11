// Tool options (every options-bar slider / toggle / select), persisted to
// localStorage so they survive a reload. Stored as one bundle under a single key.
import type { BrushSettings } from "./paint";
import type {
  BlurSettings,
  CloneSettings,
  CropSettings,
  DodgeSettings,
  GradientSettings,
  HealSettings,
  LassoMode,
  MarqueeShape,
  MoveMode,
  PenSettings,
  QuickSelectSettings,
  RedEyeSettings,
  SelectResizeMode,
  ShapeSettings,
  SmudgeSettings,
  SpongeSettings,
  TextSettings,
} from "./tools";

export interface WandSettings {
  tolerance: number;
  contiguous: boolean;
  sampleAll: boolean;
}

export interface BucketSettings {
  tolerance: number;
  opacity: number;
  contiguous: boolean;
  antialias: boolean;
}

/** Everything the options bar lets the user tweak, per tool. */
export interface ToolPrefs {
  /** Primary (foreground) and secondary (background) colours, #rrggbbaa. */
  foreground: string;
  background: string;
  brush: BrushSettings;
  eraser: BrushSettings;
  pencil: BrushSettings;
  wand: WandSettings;
  quickSelect: QuickSelectSettings;
  bucket: BucketSettings;
  shape: ShapeSettings;
  gradient: GradientSettings;
  pen: PenSettings;
  blur: BlurSettings;
  smudge: SmudgeSettings;
  sponge: SpongeSettings;
  /** History brush (reuses the brush settings shape). */
  historyBrush: BrushSettings;
  heal: HealSettings;
  redEye: RedEyeSettings;
  clone: CloneSettings;
  dodge: DodgeSettings;
  text: TextSettings;
  crop: CropSettings;
  moveMode: MoveMode;
  /** Move tool: pick the layer under the pointer on click, and at what scope. */
  autoSelect: boolean;
  autoSelectScope: "layer" | "group";
  /** Align against the canvas/selection rather than the layers' own union. */
  alignToCanvas: boolean;
  resizeMode: SelectResizeMode;
  resizeSmooth: boolean;
  marqueeShape: MarqueeShape;
  lassoMode: LassoMode;
  triangleApex: number;
  sampleSize: string;
  sampleScope: string;
}

const KEY = "graphiq:tool-settings";

/** Read the saved tool options (a partial — only what was stored). */
export function loadToolPrefs(): Partial<ToolPrefs> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<ToolPrefs>) : {};
  } catch {
    return {};
  }
}

export function saveToolPrefs(prefs: ToolPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore (private mode / quota) */
  }
}
