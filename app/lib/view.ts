import { clamp } from "./color";

export interface Pan {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Build a doc-space rectangle from two points, clamped to the document. */
export function normalizeRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  docW: number,
  docH: number,
): Rect {
  const x0 = clamp(Math.min(ax, bx), 0, docW);
  const y0 = clamp(Math.min(ay, by), 0, docH);
  const x1 = clamp(Math.max(ax, bx), 0, docW);
  const y1 = clamp(Math.max(ay, by), 0, docH);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Everything the Navigator needs to mirror & drive the canvas view. */
export interface NavigatorView {
  zoom: number;
  pan: Pan;
  setPan: (p: Pan) => void;
  /** Viewport (visible canvas area) size in px. */
  vpW: number;
  vpH: number;
  /** Document size in px. */
  docW: number;
  docH: number;
}

/** Keep at least this many px of the canvas reachable so it can't get lost. */
export const KEEP = 80;

/**
 * Clamp the pan so part of the canvas always stays inside the viewport.
 * `pan` is the on-screen position of the canvas's top-left corner.
 */
export function clampPan(
  x: number,
  y: number,
  scale: number,
  docW: number,
  docH: number,
  vpW: number,
  vpH: number,
  keep = KEEP,
): Pan {
  const sw = docW * scale;
  const sh = docH * scale;
  const keepX = Math.min(keep, sw);
  const keepY = Math.min(keep, sh);
  return {
    x: clamp(x, keepX - sw, vpW - keepX),
    y: clamp(y, keepY - sh, vpH - keepY),
  };
}
