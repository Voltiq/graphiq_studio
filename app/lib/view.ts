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

/**
 * Invert a set of (axis-aligned) selection rectangles within the canvas: returns
 * the rectangles covering everything NOT in the original selection. Built by
 * slicing the canvas along every rect edge into a grid, keeping the cells that
 * fall outside the selection, then merging them horizontally per row band.
 */
export function invertRects(rects: Rect[], docW: number, docH: number): Rect[] {
  const clamped = rects
    .map((r) => ({
      x0: clamp(Math.min(r.x, r.x + r.w), 0, docW),
      y0: clamp(Math.min(r.y, r.y + r.h), 0, docH),
      x1: clamp(Math.max(r.x, r.x + r.w), 0, docW),
      y1: clamp(Math.max(r.y, r.y + r.h), 0, docH),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);

  const xs = [...new Set([0, docW, ...clamped.flatMap((r) => [r.x0, r.x1])])].sort((a, b) => a - b);
  const ys = [...new Set([0, docH, ...clamped.flatMap((r) => [r.y0, r.y1])])].sort((a, b) => a - b);

  const out: Rect[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const cy = (ys[j] + ys[j + 1]) / 2;
    let runStart: number | null = null;
    for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const inside = clamped.some((r) => cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1);
      if (!inside && runStart === null) runStart = xs[i];
      else if (inside && runStart !== null) {
        out.push({ x: runStart, y: ys[j], w: xs[i] - runStart, h: ys[j + 1] - ys[j] });
        runStart = null;
      }
    }
    if (runStart !== null) {
      out.push({ x: runStart, y: ys[j], w: xs[xs.length - 1] - runStart, h: ys[j + 1] - ys[j] });
    }
  }
  return out;
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
  /** Set the zoom level (%) — the canvas pivots around the viewport centre. */
  setZoom: (z: number) => void;
  /** Fit the whole document in the viewport. */
  fit: () => void;
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
