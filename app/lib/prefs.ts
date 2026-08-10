// User preferences, persisted to localStorage (separate from per-document state).

import type { CvdType } from "./cvd";
import type { PressureCurve } from "./pointer";

/** Measurement unit for rulers and size readouts. */
export type MeasureUnit = "px" | "in" | "cm";

/** Transparency-checkerboard square size ("none" = a flat backdrop, no squares).
 *  Screen pixels — the pattern lives in screen space, so squares keep their
 *  size at every zoom level. */
export type CheckerSize = "none" | "small" | "medium" | "large";

/** Checkerboard colour scheme; "auto" follows the theme's greys, "custom" uses
 *  the user's two colours. */
export type CheckerColors = "auto" | "light" | "mid" | "dark" | "custom";

export const CHECKER_SIZE_PX: Record<CheckerSize, number> = {
  none: 0,
  small: 8,
  medium: 16, // the historical default (CanvasArea.module.scss .checker)
  large: 24,
};

/** The classic grey pairs (Photoshop's Light/Medium/Dark), [a, b] = [base, square]. */
const CHECKER_PAIRS: Record<Exclude<CheckerColors, "auto" | "custom">, [string, string]> = {
  light: ["#ffffff", "#cccccc"],
  mid: ["#cccccc", "#999999"],
  dark: ["#999999", "#666666"],
};

/** Inline background style for a transparency checker. "auto" resolves to the
 *  theme's `--checker-a/b` vars so it keeps tracking light/dark; unknown values
 *  from an old/hand-edited prefs file fall back to the defaults. Shared by the
 *  document canvas and the Preferences preview so the two can never drift. */
export function checkerCSS(
  size: CheckerSize,
  colors: CheckerColors,
  customA: string,
  customB: string,
): { backgroundColor: string; backgroundImage: string; backgroundSize?: string } {
  const [a, b] =
    colors === "custom"
      ? [customA, customB]
      : (CHECKER_PAIRS[colors as keyof typeof CHECKER_PAIRS] ?? [
          "var(--checker-a)",
          "var(--checker-b)",
        ]);
  const px = CHECKER_SIZE_PX[size] ?? CHECKER_SIZE_PX.medium;
  if (px === 0) return { backgroundColor: a, backgroundImage: "none" };
  return {
    backgroundColor: a,
    backgroundImage: `repeating-conic-gradient(${b} 0% 25%, ${a} 0% 50%)`,
    backgroundSize: `${px}px ${px}px`,
  };
}

/** Where a clipboard paste goes by default. "ask" shows the paste dialog. */
export type PasteDefault = "ask" | "new-layer" | "current-layer" | "new-canvas";

/** What to do when a pasted image is larger than the canvas (and the paste
    destination keeps the current canvas). "ask" shows the size question. */
export type PasteOversize = "ask" | "keep" | "expand";

export interface Preferences {
  /** Default destination for pasted clipboard images. */
  defaultPaste: PasteDefault;
  /** Default canvas-size behaviour for oversized pastes. */
  pasteOversize: PasteOversize;
  /** Snap the gradient midpoint to the centre when it's dragged close. */
  gradientSnap: boolean;
  /** Layer styles share the Gradient tool's saved/imported gradient presets. */
  sharedGradients: boolean;
  /** Max history rows shown before the History panel becomes scrollable. */
  maxHistory: number;
  /** New document: show the size dialog (false â create with the defaults). */
  newDocAsk: boolean;
  /** New-document default canvas size (px). */
  newDocWidth: number;
  newDocHeight: number;
  /** Autosave interval in minutes (0 = off). Snapshots go to IndexedDB and are
   *  offered for restore after an unclean exit. */
  autosaveMinutes: number;
  /** Render-cache LRU budget in MB (Preferences ▸ Performance). */
  cacheBudgetMB: number;
  /** Ruler / size-readout unit (physical units use the document's PPI). */
  unit: MeasureUnit;
  /** Default resolution (pixels per inch) stamped on new documents; used for
   *  physical-unit rulers/readouts and true-size printing. */
  defaultDpi: number;
  /** Max undoable steps kept in memory (older steps drop off the far end). */
  historyLimit: number;
  /** Run heavy compute (Blur Gallery, smart filters, heal, RAW decode) in
   *  background workers. Off = synchronous fallbacks (debugging aid). */
  useWorkers: boolean;
  /** Minimize non-essential animations and panel transitions
   *  (Preferences ▸ Appearance; applied as data-motion="off" on <html>). */
  reduceMotion: boolean;
  /** Transparency grid: checkerboard square size behind the document. */
  checkerSize: CheckerSize;
  /** Transparency grid: colour scheme ("custom" uses checkerA/checkerB). */
  checkerColors: CheckerColors;
  /** Custom checkerboard pair — base colour (a) and square colour (b). */
  checkerA: string;
  checkerB: string;
  /** Default attribution embedded in exported images (EXIF Artist / dc:creator)
   *  when the document doesn't set its own in the Metadata panel. "" = none. */
  authorName: string;
  /** Default copyright notice (EXIF Copyright / dc:rights) — same fallback rule. */
  copyrightNotice: string;
  /** Export As opens with this format preselected (falls back to PNG when the
   *  browser can't encode it). */
  defaultExportFormatId: string;
  /** Export As opens with this quality (lossy formats), 1–100. */
  defaultExportQuality: number;
  /** How many projects File ▸ Open recent remembers (older entries drop as new
   *  ones are added). */
  recentsLimit: number;
  /** Document grid (View ▸ Document grid): gridline spacing in document px. */
  gridSpacing: number;
  /** Fainter subdivision lines between gridlines (1 = none). */
  gridSubdivisions: number;
  /** Document-grid line colour (subdivisions draw the same hue, fainter). */
  gridColor: string;
  /** Pixel-grid line colour (the 1px cells shown at high zoom). */
  pixelGridColor: string;
  /** Snap pull distance in screen px (shape-node symmetry snaps, guides…). */
  snapDistance: number;
  /** Paint-tool cursor: the size ring (with hardness preview) or a precise
   *  crosshair only. */
  paintCursor: "ring" | "precise";
  /** Draw the small centre crosshair inside the brush ring. */
  brushCrosshair: boolean;
  /** Brush ring / crosshair colour (the dark under-stroke stays for contrast). */
  ringColor: string;
  /** Honour stylus pressure in the paint tools (a mouse is never affected). */
  penPressure: boolean;
  /** How hard you have to press for full size/flow. */
  pressureCurve: PressureCurve;
  /** Ignore touch for tool input once a stylus has been used on this canvas —
   *  two-finger pan/zoom keeps working, so a resting hand is simply ignored. */
  palmRejection: boolean;
  /** Colour-vision deficiency to accommodate: retunes the semantic triad
   *  (danger / success / warning) to one that stays separable. */
  colorVision: CvdType;
  /** Firm up borders, text ramps and the focus ring within the current theme. */
  highContrast: boolean;
  /** Non-linear history: a new edit after undoing keeps the states it replaces
   *  as a branch instead of discarding them (Photoshop's History Options). */
  nonLinearHistory: boolean;
}

export const DEFAULT_PREFS: Preferences = {
  defaultPaste: "ask",
  pasteOversize: "ask",
  gradientSnap: true,
  sharedGradients: true,
  maxHistory: 25,
  newDocAsk: true,
  newDocWidth: 1920,
  newDocHeight: 1080,
  autosaveMinutes: 2,
  cacheBudgetMB: 256,
  unit: "px",
  defaultDpi: 300,
  historyLimit: 60,
  useWorkers: true,
  reduceMotion: false,
  checkerSize: "medium",
  checkerColors: "auto",
  checkerA: "#ffffff",
  checkerB: "#cccccc",
  authorName: "",
  copyrightNotice: "",
  defaultExportFormatId: "png",
  defaultExportQuality: 92,
  recentsLimit: 8,
  gridSpacing: 64,
  gridSubdivisions: 4,
  gridColor: "#4688ec",
  pixelGridColor: "#808080", // reproduces the historical rgba(128,128,128,…) lines
  snapDistance: 6, // reproduces the historical SNAP_PX
  paintCursor: "ring",
  brushCrosshair: true,
  ringColor: "#ffffff", // reproduces the historical white strokes
  penPressure: true,
  pressureCurve: "linear",
  palmRejection: true,
  colorVision: "none",
  highContrast: false,
  nonLinearHistory: false,
};

const KEY = "graphiq:preferences";
const LEGACY_KEY = "aperture:preferences"; // pre-rebrand key, read once as a fallback

export function loadPrefs(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
