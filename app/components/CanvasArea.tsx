"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeftRight, Maximize2, Minus, Plus, X } from "lucide-react";
import styles from "./CanvasArea.module.scss";
import type { WorkingSpace } from "../lib/colorspace";
import { checkerCSS, type CheckerColors, type CheckerSize, type MeasureUnit } from "../lib/prefs";
import { buildEdgeField, snapPoint, type EdgeField } from "../lib/magnetic";
import type { StrokeStep } from "../lib/actions";
import { baseRunStyle, effectiveWeight, fontFeatureCSS, stretchKeyword } from "../lib/richtext";
import {
  applyPatchToSelection,
  seedTextEditor,
  serializeTextEditor,
  type TextStylePatch,
} from "../lib/richtext-dom";
import type { LassoMode } from "../lib/tools";
import { clamp, parseColor, toHex8 } from "../lib/color";
import { selectionChannelKey } from "../lib/channels";
import {
  canvasTargets,
  clampGuide,
  dedupeTargets,
  guideTargets,
  hitGuide,
  layerTargets,
  shouldDiscard,
  snapMove,
  snapAxis,
  snapPointTo,
  type Guide,
  type GuideAxis,
  type SnapHit,
  type SnapTarget,
} from "../lib/guides";
import {
  effectivePressure,
  newPalmState,
  palmDown,
  palmUp,
  rejectsPointer,
  type PressureCurve,
} from "../lib/pointer";
import {
  bypassAdjustments,
  compareClip,
  dividerPos,
  splitFromPointer,
  type CompareAxis,
} from "../lib/compare";
import { clampPan, normalizeRect, type Pan, type Rect } from "../lib/view";
import type {
  BlurSettings,
  CloneSettings,
  CropGrid,
  CropQuad,
  DodgeSettings,
  SmudgeSettings,
  SpongeSettings,
  HealSettings,
  RedEyeSettings,
  MarqueeShape,
  MeasureLine,
  QuickSelectSettings,
  TextSettings,
  GradientStop,
  GradientType,
  MoveMode,
  PenAnchor,
  PenSettings,
  SelectResizeMode,
  ShapeKind,
  TextRun,
  ToolId,
  VectorData,
  VectorShape,
  VectorText,
} from "../lib/tools";
import { measureInfo } from "../lib/tools";
import { warpActive } from "../lib/textwarp";
import { renderShape, type ShapeGeom, type TrapInsets } from "../lib/shapes";
import { resolveStops } from "../lib/gradient";
import {
  PaintEngine,
  type BrushSettings,
  type EngineHandle,
  type HistorySummary,
  type PendingPaste,
  type WandSelection,
} from "../lib/paint";
import {
  collectLeafIds,
  containsId,
  findNode,
  isFillLayer,
  isPixelsLocked,
  isPositionLocked,
  linkedLeafIds,
  type LayerNode,
} from "../lib/layers";
import type { MixerSettings } from "../lib/mixer";
import { builtinShapes, loadSavedShapes } from "../lib/shape-library";
import {
  anchorsInRect,
  deleteAnchors,
  dragHandle,
  hitTest,
  insertAnchor,
  moveAnchors,
  toggleSmooth,
} from "../lib/path-edit";
import type { PendingLoad } from "../lib/project";
import { effectiveSoftness } from "../lib/refine-edge";
import PerfHud from "./PerfHud";

const ZOOM_STEPS = [
  12, 25, 33, 50, 67, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200,
  4800, 6400, 10000,
];

interface DocTab {
  id: string;
  name: string;
}

/** View commands exposed to the menu (zoom/fit live in the canvas stage). */
export interface ViewApi {
  zoomIn: () => void;
  zoomOut: () => void;
  zoom100: () => void;
  fit: () => void;
  /** Apply a character-style patch to the text editor's SELECTION (true when
   *  consumed — the caller then leaves the block's base style alone). */
  applyTextStyle: (patch: TextStylePatch) => boolean;
  /** Load a stored path into the Pen tool as the live editing path (Paths
   *  panel ▸ Edit). The caller switches the tool to "pen". */
  /** Load a path for editing. `sourceId` (a stored path) makes the commit write
   *  BACK to that path instead of producing a new Work Path. */
  loadPenPath: (anchors: PenAnchor[], closed: boolean, sourceId?: string) => void;
}

interface RulerTick {
  pos: number; // screen px from the ruler's start
  label?: string; // document coordinate (major ticks only)
  major: boolean;
}

/** Smallest "nice" number (1/2/5 × 10ⁿ) ≥ raw, for ruler tick spacing. */
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * Ticks for a ruler `length` px long, where document coord 0 sits at `offset`
 * screen px and each doc px is `scale` screen px. Labels sit on major ticks
 * (four minors between) and are expressed in the measurement unit —
 * `pxPerUnit` = 1 for pixels, the document PPI for inches, PPI/2.54 for cm.
 */
function rulerTicks(length: number, offset: number, scale: number, pxPerUnit = 1): RulerTick[] {
  const ticks: RulerTick[] = [];
  if (length <= 0 || scale <= 0 || pxPerUnit <= 0) return ticks;
  const unitScale = scale * pxPerUnit; // screen px per UNIT
  const step = niceStep(70 / unitScale); // aim for ~70px between labels (unit space)
  const minor = step / 5;
  const uStart = -offset / unitScale;
  const uEnd = (length - offset) / unitScale;
  const first = Math.floor(uStart / step) * step;
  const fmt = (u: number) =>
    pxPerUnit === 1
      ? String(Math.round(u))
      : (Math.abs(u) < 1e-9 ? 0 : u).toFixed(2).replace(/\.?0+$/, "");
  for (let u = first; u <= uEnd + step; u += step) {
    for (let k = 1; k < 5; k++) {
      const pos = offset + (u + minor * k) * unitScale;
      if (pos >= 0 && pos <= length) ticks.push({ pos, major: false });
    }
    const pos = offset + u * unitScale;
    if (pos >= 0 && pos <= length) {
      ticks.push({ pos, label: fmt(u), major: true });
    }
  }
  return ticks;
}

const MIN_ZOOM = 12;
const MAX_ZOOM = 10000;
/** Screen-px width of the invisible rotation ring just outside the selection. */
const RING_OUTER = 44;

/** Quick Mask overlay tint — Photoshop's rubylith, 50% red over masked areas.
 *  The alpha is baked into the colour because the overlay is punched out with a
 *  destination-out pass, which scales whatever opacity is already there. */
const QUICK_MASK_COLOR = "rgba(255,0,0,0.5)";

/** Rotate (x,y) about (cx,cy) by `a` radians. */
function rotatePt(x: number, y: number, cx: number, cy: number, a: number): [number, number] {
  if (!a) return [x, y];
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/**
 * A custom "rotate" cursor: a 270° arc with one arrowhead, white-filled with a
 * 1px black outline. The whole glyph is rotated by `deg` (about its centre =
 * the hotspot) so the arrow can be aimed toward the selection. The base arrow
 * points +x (right); `deg` is quantised to limit cursor churn while hovering.
 */
function rotateCursorFor(deg: number): string {
  const r = Math.round(deg / 6) * 6;
  const arc = "M12 5 A7 7 0 1 0 19 12"; // 270° arc about (12,12), gap top-right
  const head = "M16.5 5 L12 2.5 L12 7.5 Z"; // arrowhead at the top end, pointing right
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<g transform="rotate(${r} 12 12)">` +
    // black outline underneath (1px wider on each side than the white core)
    `<path d="${arc}" fill="none" stroke="black" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="${head}" fill="black" stroke="black" stroke-width="2" stroke-linejoin="round"/>` +
    // white core on top
    `<path d="${arc}" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="${head}" fill="white"/>` +
    `</g>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, auto`;
}

/** Cursor oriented so its arrow points from a doc-space point toward the pivot. */
function rotateCursorToward(
  px: number,
  py: number,
  pivot: { x: number; y: number },
): string {
  return rotateCursorFor((Math.atan2(pivot.y - py, pivot.x - px) * 180) / Math.PI);
}

/** Pick the directional resize cursor for a handle, accounting for rotation. */
function resizeCursor(edges: HandleEdges, angle: number): string {
  const dx = (edges.right ? 1 : 0) - (edges.left ? 1 : 0);
  const dy = (edges.bottom ? 1 : 0) - (edges.top ? 1 : 0);
  if (!dx && !dy) return "move";
  let deg = ((Math.atan2(dy, dx) + angle) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180; // fold to [0,180): resize cursors are symmetric
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nwse-resize";
  if (deg < 112.5) return "ns-resize";
  return "nesw-resize";
}

type SelZone =
  | { kind: "anchor" }
  | { kind: "resize"; edges: HandleEdges }
  | { kind: "ring" }
  | { kind: "none" };

/** A full selection snapshot for undoable transforms (incl. wand ants cache). */
type SelState = {
  rects: Rect[];
  angle: number;
  pivot: { x: number; y: number } | null;
  segs: Seg[] | null;
};

/** Classify where a doc-space point falls relative to the (possibly rotated)
 *  selection: its anchor, a resize handle, the rotation ring, or nothing. */
function selectZone(
  px: number,
  py: number,
  selection: Rect[],
  angle: number,
  pivot: { x: number; y: number },
  sc: number,
  allowResize = true,
): SelZone {
  if (Math.abs(px - pivot.x) <= 9 / sc && Math.abs(py - pivot.y) <= 9 / sc) return { kind: "anchor" };
  const [lx, ly] = rotatePt(px, py, pivot.x, pivot.y, -angle);
  const bbox = bboxOf(selection);
  if (allowResize) {
    const edges = hitHandle(bbox, lx, ly, 10 / sc);
    if (edges) return { kind: "resize", edges };
  }
  const m = RING_OUTER / sc;
  const inBox = lx >= bbox.x && lx <= bbox.x + bbox.w && ly >= bbox.y && ly <= bbox.y + bbox.h;
  const inRing =
    !inBox &&
    lx >= bbox.x - m &&
    lx <= bbox.x + bbox.w + m &&
    ly >= bbox.y - m &&
    ly <= bbox.y + bbox.h + m;
  return inRing ? { kind: "ring" } : { kind: "none" };
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Outer-boundary segments (doc space) of a set of rectangles. Edges interior to
 * the union cancel out, so overlapping rectangles render as one combined outline.
 */
function unionSegments(rects: Rect[]): Seg[] {
  const xsSet = new Set<number>();
  const ysSet = new Set<number>();
  for (const r of rects) {
    xsSet.add(r.x);
    xsSet.add(r.x + r.w);
    ysSet.add(r.y);
    ysSet.add(r.y + r.h);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  if (nx < 2 || ny < 2) return [];
  const covered = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return rects.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
  };
  const segs: Seg[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx - 1; i++)
      if (covered(i, j - 1) !== covered(i, j))
        segs.push({ x1: xs[i], y1: ys[j], x2: xs[i + 1], y2: ys[j] });
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny - 1; j++)
      if (covered(i - 1, j) !== covered(i, j))
        segs.push({ x1: xs[i], y1: ys[j], x2: xs[i], y2: ys[j + 1] });
  return segs;
}

interface Pt {
  x: number;
  y: number;
}

/** Selection combine mode chosen by modifier keys: new / Ctrl-add / Alt-subtract. */
type SelOp = "new" | "add" | "subtract";

/**
 * Order boundary segments into connected polyline loops so the marching ants can
 * be stroked as continuous paths. The dash then flows around each loop (each edge
 * marching in its own connecting direction, e.g. clockwise) instead of every
 * horizontal edge going right and every vertical edge going down. Segments share
 * exact endpoints, so a simple walk of the endpoint graph recovers the loops.
 */
function tracePerimeter(segs: Seg[]): Pt[][] {
  const key = (x: number, y: number) => `${x},${y}`;
  const adj = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const a = adj.get(k);
    if (a) a.push(i);
    else adj.set(k, [i]);
  };
  for (let i = 0; i < segs.length; i++) {
    add(key(segs[i].x1, segs[i].y1), i);
    add(key(segs[i].x2, segs[i].y2), i);
  }
  const used = new Array<boolean>(segs.length).fill(false);
  const nextFrom = (px: number, py: number): number => {
    const list = adj.get(key(px, py));
    if (list) for (const i of list) if (!used[i]) return i;
    return -1;
  };
  const loops: Pt[][] = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const s = segs[start];
    const pts: Pt[] = [
      { x: s.x1, y: s.y1 },
      { x: s.x2, y: s.y2 },
    ];
    // Grow the chain forward from the tail, then backward from the head.
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const end = dir === 0 ? pts[pts.length - 1] : pts[0];
        const i = nextFrom(end.x, end.y);
        if (i < 0) break;
        used[i] = true;
        const e = segs[i];
        const far = e.x1 === end.x && e.y1 === end.y ? { x: e.x2, y: e.y2 } : { x: e.x1, y: e.y1 };
        if (dir === 0) pts.push(far);
        else pts.unshift(far);
      }
    }
    loops.push(pts);
  }
  return loops;
}

/** Decompose a marquee region into per-row scanline rects (ellipse / triangle),
 *  or a single rect. Fed to the engine's mask-based combine for a clean selection.
 *  `pointDown` flips the triangle's apex to the bottom (when dragged downward);
 *  `apex` is the apex's horizontal position as a fraction of width (0.5 = centred). */
function marqueeSelRects(b: Rect, shape: MarqueeShape, pointDown = false, apex = 0.5): Rect[] {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const w = Math.round(b.w);
  const h = Math.round(b.h);
  if (w < 1 || h < 1) return [];
  if (shape === "rect") return [{ x, y, w, h }];
  const out: Rect[] = [];
  if (shape === "ellipse") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    for (let i = 0; i < h; i++) {
      const dy = (y + i + 0.5 - cy) / ry;
      if (Math.abs(dy) >= 1) continue;
      const dx = rx * Math.sqrt(1 - dy * dy);
      const left = Math.round(cx - dx);
      const right = Math.round(cx + dx);
      if (right > left) out.push({ x: left, y: y + i, w: right - left, h: 1 });
    }
  } else {
    // Triangle: apex on the top edge at `apex` (or the bottom edge, when pointDown),
    // base across the opposite edge. Each row's span interpolates the two slanted
    // edges from the apex toward the base, so the apex offset slants the triangle.
    const ax = x + apex * w;
    for (let i = 0; i < h; i++) {
      const t = pointDown ? (h - i) / h : (i + 1) / h;
      const left = Math.round(ax + (x - ax) * t);
      const right = Math.round(ax + (x + w - ax) * t);
      if (right > left) out.push({ x: left, y: y + i, w: right - left, h: 1 });
    }
  }
  return out;
}

interface HandleEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** The 8 resize handles of a rectangle (corners + edge midpoints), in doc space. */
function rectHandles(r: Rect): { edges: HandleEdges; x: number; y: number }[] {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  return [
    { edges: { left: true, top: true }, x: x0, y: y0 },
    { edges: { top: true }, x: mx, y: y0 },
    { edges: { right: true, top: true }, x: x1, y: y0 },
    { edges: { right: true }, x: x1, y: my },
    { edges: { right: true, bottom: true }, x: x1, y: y1 },
    { edges: { bottom: true }, x: mx, y: y1 },
    { edges: { left: true, bottom: true }, x: x0, y: y1 },
    { edges: { left: true }, x: x0, y: my },
  ];
}

/** Which handle (if any) a doc-space point is over, within `hit` doc units. */
function hitHandle(r: Rect, px: number, py: number, hit: number): HandleEdges | null {
  for (const h of rectHandles(r)) {
    if (Math.abs(px - h.x) <= hit && Math.abs(py - h.y) <= hit) return h.edges;
  }
  return null;
}

/** Bounding box enclosing a set of rectangles. */
function bboxOf(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Custom eyedropper cursor: the dropper's tip points down-left toward the sample
// point, with the body offset up-right and a gap so the sampled pixel stays
// visible (uncovered). The hotspot sits in that gap, on the sampled pixel.
const EYEDROPPER_PATHS =
  '<path d="m2 22 1-1h3l9-9"/>' +
  '<path d="M3 21v-3l9-9"/>' +
  '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>';
const EYEDROPPER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<g transform="translate(7,3)" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  `<g stroke="#000" stroke-opacity="0.5" stroke-width="3.4">${EYEDROPPER_PATHS}</g>` +
  `<g stroke="#fff" stroke-width="1.6">${EYEDROPPER_PATHS}</g>` +
  "</g></svg>";
// Hotspot (4, 30): down-left of the drawn tip (~9, 25), so the tip aims at it.
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(EYEDROPPER_SVG)}") 4 30, crosshair`;

/** Strip a text vector down to a render spec (used to restore it on re-edit cancel). */
function textSpecOf(v: VectorText) {
  return {
    text: v.text,
    x: v.x,
    y: v.y,
    boxW: v.boxW,
    fontFamily: v.fontFamily,
    fontSize: v.fontSize,
    bold: v.bold,
    italic: v.italic,
    underline: v.underline,
    strike: v.strike,
    align: v.align,
    lineHeight: v.lineHeight,
    tracking: v.tracking,
    baseline: v.baseline,
    caps: v.caps,
    color: v.color,
    antialias: v.antialias,
    runs: v.runs,
    features: v.features,
    axes: v.axes,
    warp: v.warp,
    fill: v.fill,
  };
}

/** The style half of a render spec, taken from the live text options (the
 *  geometry + content half is supplied per call). Mirrors Editor.buildTextSpec
 *  so the live preview rasters exactly what a commit will bake. */
function textSpecBase(t: TextSettings) {
  return {
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    bold: t.bold,
    italic: t.italic,
    underline: t.underline,
    strike: t.strike,
    align: t.align,
    lineHeight: t.lineHeight,
    tracking: t.tracking,
    baseline: t.baseline,
    caps: t.caps,
    color: t.color,
    antialias: t.antialias,
    features: t.features,
    axes: t.axes,
    warp: t.warp,
    fill: t.fill,
  };
}

// Blue node colour for shapes' draggable geometry handles (trapezoid sides,
// triangle apex) — distinct from the white resize handles. Plus the default
// symmetric trapezoid top-edge insets.
/* Shape/pen node handles follow the UI accent (`--accent`). Reading a computed
   style is not free, so the value is cached per theme. */
let shapeNodeCache = { key: "", color: "#1868db" };
function shapeNodeColor(): string {
  const el = document.documentElement;
  const key = el.getAttribute("data-theme") ?? "";
  if (key !== shapeNodeCache.key) {
    const v = getComputedStyle(el).getPropertyValue("--accent").trim();
    shapeNodeCache = { key, color: v || "#1868db" };
  }
  return shapeNodeCache.color;
}
const TRAP_DEFAULT: TrapInsets = { l: 0.25, r: 0.25 };

/** A fresh pen anchor as a "corner" (both bezier handles sit on the point). */
function makeAnchor(x: number, y: number): PenAnchor {
  return { x, y, ix: x, iy: y, ox: x, oy: y };
}

// Minimum on-screen length a pen handle is drawn at, so handles stay visible /
// grabbable on every anchor at any zoom (even when retracted onto the point).
const PEN_HANDLE_MIN_PX = 24;

/** Does an anchor have an outgoing / incoming segment (so its handle matters)? */
function penHasOut(i: number, n: number, closed: boolean) {
  return closed || i < n - 1;
}
function penHasIn(i: number, n: number, closed: boolean) {
  return closed || i > 0;
}

/**
 * The doc-space DISPLAY position of an anchor handle: its real control point when
 * pulled out far enough, otherwise a stub of length PEN_HANDLE_MIN_PX (screen) in
 * the handle's direction — or, if retracted, along the local path tangent. `s` is
 * the zoom scale. Used for both drawing and hit-testing so they always agree.
 */
function penHandlePos(
  anchors: PenAnchor[],
  i: number,
  closed: boolean,
  isOut: boolean,
  s: number,
): { x: number; y: number } {
  const a = anchors[i];
  let dx = (isOut ? a.ox : a.ix) - a.x;
  let dy = (isOut ? a.oy : a.iy) - a.y;
  let len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    dx /= len;
    dy /= len;
  } else {
    // Retracted → point along the local tangent (toward the next/prev anchor).
    const n = anchors.length;
    const prev = i > 0 ? anchors[i - 1] : closed ? anchors[n - 1] : null;
    const next = i < n - 1 ? anchors[i + 1] : closed ? anchors[0] : null;
    let tx = 1;
    let ty = 0;
    if (prev && next) {
      tx = next.x - prev.x;
      ty = next.y - prev.y;
    } else if (next) {
      tx = next.x - a.x;
      ty = next.y - a.y;
    } else if (prev) {
      tx = a.x - prev.x;
      ty = a.y - prev.y;
    }
    const tl = Math.hypot(tx, ty) || 1;
    dx = (isOut ? tx : -tx) / tl;
    dy = (isOut ? ty : -ty) / tl;
    len = 0;
  }
  const docLen = Math.max(len, PEN_HANDLE_MIN_PX / Math.max(s, 1e-6));
  return { x: a.x + dx * docLen, y: a.y + dy * docLen };
}

export default function CanvasArea({
  docs,
  activeId,
  onSelectDoc,
  onCloseDoc,
  onNewDoc,
  onRenameDoc,
  zoom,
  onZoomChange,
  width,
  height,
  pan,
  setPan,
  onViewport,
  mobile = false,
  tool,
  brush,
  color,
  foreground,
  background,
  bucket,
  gradient,
  pen,
  shape,
  blur,
  smudge,
  mixer,
  sponge,
  historyBrush,
  heal,
  redEye,
  clone,
  dodge,
  autoSelect,
  autoSelectScope,
  onPickLayer,
  text,
  onText,
  onPlaceText,
  onUpdateText,
  cropBox,
  onCropBox,
  cropQuad,
  onCropQuad,
  cropGrid,
  cropShield,
  cropStraighten,
  cropAspect,
  onCropApply,
  layers,
  activeLayerId,
  ensureLayer,
  onLockedAction,
  perfHud,
  onPerfHud,
  measure,
  onMeasure,
  selection,
  onSelectionChange,
  onSelectionRects,
  selectionAngle,
  selectionPivot,
  selectionFeather,
  onSelectionAngle,
  onSelectionPivot,
  moveMode,
  resizeMode,
  resizeSmooth,
  marqueeShape,
  triangleApex,
  wand,
  quickSelect,
  onQuickSelect,
  sampleSize,
  sampleAllLayers,
  onPick,
  tonePick,
  onTonePick,
  curveTarget,
  onCurveTargetStart,
  onCurveTargetDrag,
  onCurveTargetEnd,
  filterAnchor,
  onFilterAnchorDrag,
  onPenPathCommit,
  onPathEdited,
  onFrameDrawn,
  frameShape,
  recordStrokes,
  onStrokeRecord,
  pendingPaste,
  onPasteDone,
  pendingLoads,
  onLoadDone,
  colorSpace,
  showRulers,
  unit = "px",
  docDpi = 300,
  checkerSize = "medium",
  checkerColors = "auto",
  checkerA = "#ffffff",
  checkerB = "#cccccc",
  lassoMode = "free",
  showGrid,
  snap,
  docGrid,
  pixelGridColor,
  snapDistance,
  guides,
  showGuides,
  lockGuides,
  smartGuides,
  onGuidesCommit,
  onRevealGuides,
  penPressure,
  pressureCurve,
  palmRejection,
  compareSplit,
  compareAxis,
  onCompareSplit,
  cursorPrefs,
  viewApiRef,
  paintRef,
  onHistory,
  onAdjustEnd,
  onCursor,
}: {
  docs: DocTab[];
  activeId: string;
  onSelectDoc: (id: string) => void;
  onCloseDoc: (id: string) => void;
  onNewDoc: () => void;
  onRenameDoc: (id: string, name: string) => void;
  zoom: number;
  onZoomChange: (z: number) => void;
  width: number;
  height: number;
  pan: Pan;
  setPan: (p: Pan | ((prev: Pan) => Pan)) => void;
  onViewport: (size: { w: number; h: number }) => void;
  /** Mobile shell: while an untouched view is still auto-fit, re-fit on viewport
   *  resize (the desktop→mobile reflow widens the canvas after the first fit). */
  mobile?: boolean;
  tool: ToolId;
  brush: BrushSettings;
  color: string;
  /** Primary / secondary colours — left-button paints with `foreground`, right with `background`. */
  foreground: string;
  background: string;
  /** Paint-bucket settings (fill colour comes from `color`). */
  bucket: { tolerance: number; opacity: number; contiguous: boolean; antialias: boolean };
  /** Gradient settings + the colours used when no custom stops are set. */
  gradient: {
    type: GradientType;
    reverse: boolean;
    smooth: boolean;
    snap: boolean;
    stops: GradientStop[] | null;
    fg: string;
    bg: string;
  };
  /** Pen tool stroke options (stroke colour = the active `color`). */
  pen: PenSettings;
  /** Shape-tool settings + colours (fill = primary, stroke = secondary). */
  shape: {
    kind: ShapeKind;
    strokeWidth: number;
    radius: number;
    fill: string;
    stroke: string;
    /** Custom shapes: which library preset to draw. */
    customId?: string;
  };
  /** Blur (focus) brush settings. */
  blur: BlurSettings;
  /** Smudge brush settings. */
  smudge: SmudgeSettings;
  mixer: MixerSettings;
  /** Sponge (saturate/desaturate) brush settings. */
  sponge: SpongeSettings;
  /** History brush settings (brush controls; paints from the source state). */
  historyBrush: BrushSettings;
  heal: HealSettings;
  /** Red-eye tool settings (search size + darken amount). */
  redEye: RedEyeSettings;
  /** Clone-stamp brush settings. */
  clone: CloneSettings;
  /** Dodge/Burn brush settings. */
  dodge: DodgeSettings;
  /** Move tool: clicking the canvas picks the layer under the pointer. */
  autoSelect: boolean;
  /** Auto-select target: the layer itself, or the group it lives in. */
  autoSelectScope: "layer" | "group";
  /** Make `id` the active layer (auto-select's pick). */
  onPickLayer: (id: string) => void;
  /** Text tool settings (styling for the live editor + rasterization). */
  text: TextSettings;
  /** Patch the text settings (used by the in-editor Ctrl+B/I/U shortcuts). */
  onText: (patch: Partial<TextSettings>) => void;
  /** Commit a finished text block: creates a layer and rasterizes it (Editor). */
  onPlaceText: (p: { x: number; y: number; boxW: number | null; value: string; runs?: TextRun[] }) => void;
  /** Commit a re-edit of an existing text (vector) layer, in place (Editor). */
  onUpdateText: (
    layerId: string,
    p: { x: number; y: number; boxW: number | null; value: string; runs?: TextRun[] },
  ) => void;
  /** Crop tool: the pending crop rectangle (doc coords), null when not cropping. */
  cropBox: Rect | null;
  onCropBox: (b: Rect | null) => void;
  /** Perspective-crop quad (tl,tr,br,bl) — non-null only in Perspective mode. */
  cropQuad: CropQuad | null;
  onCropQuad: (q: CropQuad | null) => void;
  cropGrid: CropGrid;
  /** Dimming (0–90%) of the area outside the crop box. */
  cropShield: number;
  /** Straighten / rotate angle of the crop, −45…45°. */
  cropStraighten: number;
  /** Locked aspect ratio (w/h) while resizing, or null for a free crop. */
  cropAspect: number | null;
  /** Commit the pending crop (double-click inside the box). */
  onCropApply: () => void;
  layers: LayerNode[];
  activeLayerId: string | null;
  ensureLayer: () => string;
  /** A locked (or parametric fill) layer blocked an edit — editor shows a toast. */
  onLockedAction?: (kind: "pixels" | "position" | "fill") => void;
  /** Dev Perf HUD visible (composite ms / cache hit rate / dirty-rect overlay). */
  perfHud?: boolean;
  /** Toggle the Perf HUD (wired to the window.__gqPerf console API). */
  onPerfHud?: (on: boolean) => void;
  /** The current measure/ruler line (null = none), shown while the tool is active. */
  measure: MeasureLine | null;
  /** Update the measure line (live during a drag; null clears it). */
  onMeasure: (line: MeasureLine | null) => void;
  selection: Rect[];
  onSelectionChange: (rects: Rect[]) => void;
  /** Update the selection rects WITHOUT resetting the rotation transform. */
  onSelectionRects: (rects: Rect[]) => void;
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  /** Feather radius (px) applied to selection fills / erases / lifts. */
  selectionFeather: number;
  onSelectionAngle: (angle: number) => void;
  onSelectionPivot: (pivot: { x: number; y: number } | null) => void;
  moveMode: MoveMode;
  resizeMode: SelectResizeMode;
  resizeSmooth: boolean;
  /** Rectangular-marquee region shape (rectangle / ellipse / triangle). */
  marqueeShape: MarqueeShape;
  /** Triangle-marquee apex position as a fraction of width (0.5 = isosceles). */
  triangleApex: number;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  quickSelect: QuickSelectSettings;
  onQuickSelect: (patch: Partial<QuickSelectSettings>) => void;
  sampleSize: number;
  sampleAllLayers: boolean;
  onPick: (hex: string) => void;
  /** While a Levels eyedropper is armed, the next canvas click samples a colour. */
  tonePick: boolean;
  onTonePick: (rgb: { r: number; g: number; b: number }) => void;
  /** Curves targeted adjustment armed: click-drag on the image drives the curve. */
  curveTarget: boolean;
  onCurveTargetStart: (rgb: { r: number; g: number; b: number }) => void;
  onCurveTargetDrag: (dy: number) => void;
  onCurveTargetEnd: () => void;
  /** Smart-blur anchor targeting armed (non-null): dragging the image places the
   *  zoom/spin centre or tilt-shift focus band; the guide draws on the overlay. */
  filterAnchor: {
    kind: "zoom" | "spin" | "tiltshift";
    anchor: { x: number; y: number };
    angle: number;
    band: number;
    feather: number;
  } | null;
  /** Reports the dragged anchor in doc-normalized coords (0–1, clamped). */
  onFilterAnchorDrag: (nx: number, ny: number) => void;
  /** A pen path was committed (baked) — the Paths panel stores it as Work Path. */
  onPenPathCommit: (anchors: PenAnchor[], closed: boolean) => void;
  /** Direct Selection committing an edit of an existing stored path. */
  onPathEdited?: (id: string, anchors: PenAnchor[], closed: boolean) => void;
  /** The Frame tool finished dragging out a new frame. */
  onFrameDrawn?: (rect: { x: number; y: number; w: number; h: number }, shape: "rect" | "ellipse") => void;
  /** Which shape the Frame tool draws. */
  frameShape: "rect" | "ellipse";
  /** Actions recorder: capture brush/pencil/eraser strokes while armed. */
  recordStrokes: boolean;
  onStrokeRecord: (stroke: StrokeStep) => void;
  pendingPaste: PendingPaste | null;
  onPasteDone: () => void;
  pendingLoads: PendingLoad[];
  onLoadDone: (docId: string) => void;
  colorSpace: WorkingSpace;
  showRulers: boolean;
  unit?: MeasureUnit;
  docDpi?: number;
  /** Transparency grid (Preferences ▸ Transparency): square size + colours. */
  checkerSize?: CheckerSize;
  checkerColors?: CheckerColors;
  checkerA?: string;
  checkerB?: string;
  lassoMode?: LassoMode;
  showGrid: boolean;
  snap: boolean;
  /** Document grid overlay (View ▸ Document grid) — null = hidden. */
  docGrid: { spacing: number; subdivisions: number; color: string } | null;
  /** Pixel-grid line colour (Preferences ▸ Guides & grid). */
  pixelGridColor: string;
  /** Snap pull distance in screen px (shape-node symmetry snaps, guide snapping). */
  snapDistance: number;
  /** This document's ruler guides (View ▸ Show guides). */
  guides: Guide[];
  /** Hidden guides are inert: not drawn, not grabbable, and they pull on nothing. */
  showGuides: boolean;
  /** Locked guides still draw and still snap — they just can't be dragged. */
  lockGuides: boolean;
  /** Smart guides: align hints against other layers while moving. */
  smartGuides: boolean;
  /** Commit a guide edit as one undoable step (label shows in the History panel). */
  onGuidesCommit: (label: string, next: Guide[]) => void;
  /** Turn View ▸ Show guides on (dragging one off a ruler implies wanting it). */
  onRevealGuides: () => void;
  /** Honour stylus pressure (Preferences ▸ Touch & pen). */
  penPressure: boolean;
  /** How hard you must press for full size/flow. */
  pressureCurve: PressureCurve;
  /** Ignore touch for TOOL input once a stylus has been used (gestures still work). */
  palmRejection: boolean;
  /** Before/after split: divider position 0-100, or null when compare is off. */
  compareSplit: number | null;
  compareAxis: CompareAxis;
  onCompareSplit: (pct: number) => void;
  /** Paint-cursor prefs (Preferences ▸ Cursors): ring vs precise, centre
   *  crosshair, ring colour. */
  cursorPrefs: { mode: "ring" | "precise"; crosshair: boolean; ringColor: string };
  viewApiRef: RefObject<ViewApi | null>;
  paintRef: RefObject<EngineHandle | null>;
  onHistory: (s: HistorySummary) => void;
  /** Called when a live adjustment session ends (so the panel resets its sliders). */
  onAdjustEnd: () => void;
  /** Reports the doc-space cursor position (null when off the canvas). */
  onCursor: (p: { x: number; y: number } | null) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  // Before/after compare: a doc-sized canvas holding the PRE-ADJUSTMENT
  // composite, stacked exactly on the artwork and revealed by clip-path — so it
  // scales with zoom for free and costs nothing while compare is off.
  const compareRef = useRef<HTMLCanvasElement>(null);
  const [comparePeek, setComparePeek] = useState(false);
  const compareDragRef = useRef(false);
  const paintingRef = useRef(false);
  // Marquee selection drag state + marching-ants animation.
  const panR = useRef(pan);
  panR.current = pan;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Magic-wand ants cache: the boundary segments traced for a wand selection,
  // keyed by the exact rects array that was set (so drawAnts skips the slow
  // unionSegments for arbitrary-shaped, many-rect selections).
  const wandSegsRef = useRef<{ key: Rect[]; segs: Seg[] } | null>(null);
  // The seed of the last wand click (+ the selection it was added to, if Ctrl-
  // added), so the selection can re-compute live when the options change.
  const wandSeedRef = useRef<{
    x: number;
    y: number;
    layerId: string | null;
    base: Rect[];
    mode: SelOp;
  } | null>(null);
  // Throttle live re-computes so they can't monopolise the main thread while
  // the slider is being dragged (leading + trailing edge).
  const wandThrottleRef = useRef({ last: 0, timer: 0 });
  const wandOptsRef = useRef(wand);
  wandOptsRef.current = wand;
  const dragRectRef = useRef<Rect | null>(null);
  const marqueeRef = useRef<{ x: number; y: number; mode: SelOp } | null>(null);
  // In-progress freeform/magnetic lasso path (doc-space points); closed on
  // pointer up. The polygonal variant collects CLICKED vertices in polyRef
  // instead (open until explicitly closed).
  const lassoRef = useRef<{ x: number; y: number }[] | null>(null);
  // How the current lasso combines with the existing selection (set at start).
  const lassoModeRef = useRef<SelOp>("new");
  const lassoVariantRef = useRef<LassoMode>("free");
  lassoVariantRef.current = lassoMode;
  // Polygonal lasso: committed vertices + the rubber-band cursor position.
  const polyRef = useRef<{ pts: { x: number; y: number }[]; op: SelOp } | null>(null);
  const polyHoverRef = useRef<{ x: number; y: number } | null>(null);
  // Magnetic lasso: per-channel-Sobel edge field of the composite, built at
  // stroke start (downscaled to a cap so big documents stay fast). The
  // detection + snap logic is the pure lib magnetic.ts (Node-verified) —
  // this component only handles readback, scaling and per-stroke state.
  const edgeMapRef = useRef<{ field: EdgeField; sx: number; sy: number } | null>(null);
  // Per-stroke snap context: the last SNAPPED point (field px + gradient
  // direction) for continuity/coherence, and the last RAW cursor for the
  // travel direction. Reset at stroke start.
  const magneticPrevRef = useRef<{ x: number; y: number; theta: number } | null>(null);
  const magneticRawRef = useRef<{ x: number; y: number } | null>(null);

  /** Build the edge field from the flattened composite (capped resolution). */
  const buildEdgeMap = () => {
    const comp = engine.exportComposite(layersRef.current);
    const cap = 1400;
    const scale = Math.min(1, cap / Math.max(comp.width, comp.height, 1));
    const w = Math.max(4, Math.round(comp.width * scale));
    const h = Math.max(4, Math.round(comp.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(comp, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    edgeMapRef.current = { field: buildEdgeField(d, w, h), sx: w / comp.width, sy: h / comp.height };
    magneticPrevRef.current = null;
    magneticRawRef.current = null;
  };

  // Snap reach is SCREEN-space (like a cursor affordance): ~28 screen px of
  // pull regardless of zoom, so a subject outlined at fit-to-screen zoom snaps
  // from just as far as one at 100%. Clamped in doc px so extreme zooms stay sane.
  const MAGNETIC_SCREEN_RADIUS = 28;

  /** Snap a doc-space point to the best nearby edge (magnetic lasso). The pure
   *  search (anisotropic band + continuity + orientation coherence) lives in
   *  magnetic.ts; here: coordinate scaling, the zoom-aware radius, and the
   *  per-stroke direction/previous-point context. */
  const snapToEdge = (pt: { x: number; y: number }) => {
    const m = edgeMapRef.current;
    if (!m) return pt;
    const fx = pt.x * m.sx;
    const fy = pt.y * m.sy;
    const docR = Math.max(10, Math.min(96, MAGNETIC_SCREEN_RADIUS / Math.max(0.05, scaleRef.current)));
    const r = Math.max(4, Math.min(72, Math.round(docR * m.sx)));
    const raw = magneticRawRef.current;
    const dirX = raw ? fx - raw.x * m.sx : undefined;
    const dirY = raw ? fy - raw.y * m.sy : undefined;
    const stepFree = raw ? Math.max(3, Math.hypot((pt.x - raw.x) * m.sx, (pt.y - raw.y) * m.sy)) : 8;
    const s = snapPoint(m.field, fx, fy, {
      r,
      dirX,
      dirY,
      prev: magneticPrevRef.current,
      stepFree,
    });
    magneticRawRef.current = { x: pt.x, y: pt.y };
    if (s.snapped) magneticPrevRef.current = { x: s.x, y: s.y, theta: s.theta };
    return { x: s.x / m.sx, y: s.y / m.sy };
  };

  /** Close + commit the polygonal lasso (Enter / double-click / click-on-start). */
  const commitPolyLasso = () => {
    const poly = polyRef.current;
    polyRef.current = null;
    polyHoverRef.current = null;
    if (!poly) return;
    const region = poly.pts.length >= 3 ? engine.lassoSelect(poly.pts) : null;
    if (region && region.rects.length) {
      if (poly.op === "new") {
        wandSegsRef.current = { key: region.rects, segs: region.segments };
        onSelectionChange(region.rects);
      } else {
        applyCombined(engine.combineSelection(selectionRef.current, region.rects, poly.op));
      }
    }
    ensureAnts();
  };
  // Hand-tool pan drag: starting pointer position + pan at the start of the drag.
  const handRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  // Bird's-eye (hold H + drag, like Photoshop): while H is physically down, a
  // canvas drag zooms out to fit, shows the viewport rectangle under the
  // pointer, and on release returns to the previous zoom centred there.
  const hKeyRef = useRef(false);
  const birdRef = useRef<{ prevZoom: number; x: number; y: number } | null>(null);

  // ---- Touch & pen ----------------------------------------------------------
  // Pressure and palm rejection read their settings from a ref, because the only
  // callers are pointer handlers that must see the CURRENT prefs without being
  // rebuilt (and, for palm state, without a re-render per contact).
  const pointerPrefsRef = useRef({
    pressure: penPressure,
    curve: pressureCurve,
    palm: palmRejection,
  });
  pointerPrefsRef.current = { pressure: penPressure, curve: pressureCurve, palm: palmRejection };
  const palmRef = useRef(newPalmState());
  /** Curved 0–1 pressure for an event — always 1 for a mouse (which reports a
   *  constant 0.5 while held) and for pens that don't measure. */
  const pressureOf = (e: { pointerType: string; pressure: number }): number =>
    effectivePressure(e.pointerType, e.pressure, {
      enabled: pointerPrefsRef.current.pressure,
      curve: pointerPrefsRef.current.curve,
    });
  /** True when this pen contact is the stylus's ERASER end (barrel bit 5). */
  const isEraserTip = (e: { pointerType: string; buttons: number }): boolean =>
    e.pointerType === "pen" && (e.buttons & 32) !== 0;

  // ---- Guides ---------------------------------------------------------------
  // The committed guides live in Editor state; `guidesRef` is the LIVE list the
  // overlay draws, which during a drag is the committed list with one entry
  // rewritten. Keeping the drag out of React means a guide follows the pointer
  // at screen rate without re-rendering the whole editor on every pointermove.
  const guidesRef = useRef<Guide[]>(guides);
  const guideOptsRef = useRef({ show: showGuides, lock: lockGuides, smart: smartGuides });
  guideOptsRef.current = { show: showGuides, lock: lockGuides, smart: smartGuides };
  // Live guide drag: which entry (index into the committed list, or -1 for a
  // brand-new one dragged off a ruler), its axis, the list it started from, and
  // whether the pointer has wandered far enough off-canvas to mean "delete".
  const guideDragRef = useRef<{
    index: number;
    axis: GuideAxis;
    base: Guide[];
    discard: boolean;
    isNew: boolean;
  } | null>(null);
  // Smart-guide / snap hint lines to draw for the current drag (doc space).
  const snapHintsRef = useRef<{ v: SnapHit[]; h: SnapHit[] }>({ v: [], h: [] });
  // Snap context captured at the start of a Move drag: the box being moved and
  // the candidate lines it can land on (guides + canvas + other layers).
  const moveSnapRef = useRef<{ box: Rect; v: SnapTarget[]; h: SnapTarget[] } | null>(null);
  // Same, for drags that move a single point rather than a box (marquee corner).
  const rectSnapRef = useRef<{ v: SnapTarget[]; h: SnapTarget[] } | null>(null);
  // Redraw the grid/guides overlay outside React (assigned by its useCallback).
  const drawGuidesRef = useRef<() => void>(() => {});
  // Keep the live list in step with committed edits (undo, tab switch, dialog)
  // unless a drag currently owns it.
  if (!guideDragRef.current) guidesRef.current = guides;
  // Multi-touch pinch: all active touch/pen pointers (id → client x/y), the live
  // pinch gesture, and a flag that makes the tool handlers stand down for the
  // rest of a gesture (so the finger that started a stroke can't also draw).
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    docMx: number; // doc point under the gesture's starting midpoint
    docMy: number;
  } | null>(null);
  const gestureSuppressRef = useRef(false);
  // Shape-tool drag: start point + the current (preview) doc-space box.
  const shapeRef = useRef<{ x: number; y: number } | null>(null);
  const shapeRectRef = useRef<Rect | null>(null);
  const shapeOptsRef = useRef(shape);
  shapeOptsRef.current = shape;
  // The committed-but-still-live shape (re-renderable until deselected). `box`
  // is the same object as its selection rect, so a selection change ends it.
  const liveShapeRef = useRef<{ layerId: string; box: Rect } | null>(null);
  // Adjustable shape nodes: trapezoid top-edge insets (fractions of width) and the
  // triangle apex x-position (fraction 0..1). `nodeDragRef` is the node being
  // dragged; `nodeSnapRef` is true while snapped to centre (draws guide lines).
  const trapRef = useRef<TrapInsets>({ ...TRAP_DEFAULT });
  const triApexRef = useRef(0.5);
  const nodeDragRef = useRef<"l" | "r" | "apex" | null>(null);
  const nodeSnapRef = useRef(false);
  // Paint-bucket drag: the seed point + the previewed fill region (committed on
  // release). The preview follows the cursor; recomputes are throttled.
  const bucketSeedRef = useRef<{
    x: number;
    y: number;
    shift: boolean;
    layerId: string | null;
    slot: "primary" | "secondary"; // chosen at press: left = primary, right = secondary
  } | null>(null);
  // Committed-but-still-editable bucket fill: re-runs the flood + fill from the
  // same seed when the options change, until the next action. `raf` coalesces.
  const liveBucketRef = useRef<{
    seedX: number;
    seedY: number;
    sampleLayerId: string | null;
    fillLayerId: string;
    slot: "primary" | "secondary";
    shift: boolean;
  } | null>(null);
  const liveBucketRaf = useRef(0);
  const bucketRef = useRef<{ rects: Rect[]; color: string } | null>(null);
  const bucketThrottle = useRef({ last: 0, timer: 0 });
  const bucketOptsRef = useRef(bucket);
  bucketOptsRef.current = bucket;
  const colorRef = useRef(color);
  colorRef.current = color;
  const fgRef = useRef(foreground);
  fgRef.current = foreground;
  const bgRef = useRef(background);
  bgRef.current = background;
  // Live gradient: its endpoints + midpoint + the selection it was clipped to,
  // re-renderable until committed. `drag` is the handle currently being dragged.
  const gradientRef = useRef<{
    layerId: string;
    start: { x: number; y: number };
    end: { x: number; y: number };
    mid: number;
    sel: Rect[];
    selAngle: number;
    selPivot: { x: number; y: number } | null;
  } | null>(null);
  const gradDragRef = useRef<"start" | "end" | "mid" | null>(null);
  const gradOptsRef = useRef(gradient);
  gradOptsRef.current = gradient;
  // Live pen path: the editable anchors + which handle is being dragged. Stays
  // editable (re-stroked) until committed (Enter / double-click / tool switch).
  const penPathRef = useRef<{ anchors: PenAnchor[]; closed: boolean; layerId: string } | null>(null);
  const penDragRef = useRef<{ kind: "new" | "anchor" | "in" | "out"; index: number } | null>(null);
  // ---- Direct Selection -----------------------------------------------------
  // Shares `penPathRef` as its working path, so the skeleton/handle overlay and
  // the live engine render are the ones the Pen already has. What it adds is a
  // SELECTION of anchors, a marquee, and the structural edits (insert, delete,
  // corner⇄smooth) the pen has no verb for.
  /** Frame tool: the rubber band while dragging out a new frame, and which
   *  shape the next one takes (the options bar drives it). */
  const frameDragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const frameShapeRef = useRef<"rect" | "ellipse">(frameShape);
  frameShapeRef.current = frameShape;
  /** Stored path being edited; a commit writes back to it. */
  const dsSourceRef = useRef<string | null>(null);
  const dsSelRef = useRef<Set<number>>(new Set());
  const dsDragRef = useRef<{ kind: "anchors" | "in" | "out"; index: number; px: number; py: number } | null>(null);
  const dsMarqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const penGrabRef = useRef<{ px: number; py: number; anchor: PenAnchor } | null>(null);
  const penOptsRef = useRef(pen);
  penOptsRef.current = pen;
  // Brush / pencil / eraser: latest settings (the prop is already the active
  // tool's) + hover point — the same overlay brush-ring cursor as blur/dodge,
  // so it scales with zoom and shows the hardness falloff.
  const paintBrushRef = useRef(brush);
  paintBrushRef.current = brush;
  const paintHoverRef = useRef<{ x: number; y: number } | null>(null);
  // Cursor prefs (ring vs precise, crosshair, colour) for the deps-[] overlay draw.
  const cursorPrefsRef = useRef(cursorPrefs);
  cursorPrefsRef.current = cursorPrefs;
  // Blur (focus) brush: latest settings + the hover point for the brush-ring
  // cursor that's drawn on the overlay (so it scales with zoom + shows hardness).
  const blurRef = useRef(blur);
  blurRef.current = blur;
  const blurHoverRef = useRef<{ x: number; y: number } | null>(null);
  // Quick-selection brush: latest settings + hover ring + in-stroke state.
  const quickSelectRef = useRef(quickSelect);
  quickSelectRef.current = quickSelect;
  const onQuickSelectRef = useRef(onQuickSelect);
  onQuickSelectRef.current = onQuickSelect;
  const quickSelectHoverRef = useRef<{ x: number; y: number } | null>(null);
  const qsDraggingRef = useRef(false);
  const qsLastRef = useRef<{ x: number; y: number } | null>(null);
  // Smudge brush: latest settings + hover ring + active flag (colour-drag stroke).
  const smudgeRef = useRef(smudge);
  smudgeRef.current = smudge;
  const mixerRef = useRef(mixer);
  mixerRef.current = mixer;
  const smudgeHoverRef = useRef<{ x: number; y: number } | null>(null);
  const smudgingRef = useRef(false);
  // History brush: latest settings + hover ring + active flag (coverage-lerp
  // stroke — its own begin/move/end, like blur/dodge).
  const historyBrushRef = useRef(historyBrush);
  historyBrushRef.current = historyBrush;
  const historyHoverRef = useRef<{ x: number; y: number } | null>(null);
  const historyingRef = useRef(false);
  // Spot-heal brush: settings + hover ring + the blob's stroke points (doc
  // space). The blob is shown as a veil while painting and heals on release.
  const healRef = useRef(heal);
  healRef.current = heal;
  const healHoverRef = useRef<{ x: number; y: number } | null>(null);
  const healPtsRef = useRef<{ x: number; y: number }[] | null>(null);
  // Red-eye tool: latest settings + hover point (ring cursor on the overlay).
  const redEyeRef = useRef(redEye);
  redEyeRef.current = redEye;
  const redEyeHoverRef = useRef<{ x: number; y: number } | null>(null);
  // Dodge/Burn brush: latest settings + hover point (brush-ring cursor on overlay).
  const dodgeRef = useRef(dodge);
  dodgeRef.current = dodge;
  const dodgeHoverRef = useRef<{ x: number; y: number } | null>(null);
  const dodgingRef = useRef(false);
  // Sponge brush: latest settings + hover point + active flag.
  const spongeRef = useRef(sponge);
  spongeRef.current = sponge;
  const spongeHoverRef = useRef<{ x: number; y: number } | null>(null);
  const spongingRef = useRef(false);
  // Clone stamp: latest settings, the sampled source point (Alt-click), the live
  // source→dest offset, the hover point for the brush ring, and the Alt-held state
  // (which swaps the ring for a "set source" reticle).
  const cloneRef = useRef(clone);
  cloneRef.current = clone;
  const cloneHoverRef = useRef<{ x: number; y: number } | null>(null);
  const cloneSrcRef = useRef<{ x: number; y: number } | null>(null);
  const cloneOffRef = useRef<{ x: number; y: number } | null>(null);
  const cloneAltRef = useRef(false);
  // Text tool: the active edit session (a styled overlay <textarea>), plus the
  // press point / drag rect used to start point- vs. paragraph-text on release.
  const [textSession, setTextSession] = useState<{
    x: number;
    y: number;
    boxW: number | null;
    value: string;
    /** Rich runs to seed the editor with (the DOM is the truth afterwards). */
    runs?: TextRun[];
    /** Bumped per session open — triggers the one-time editor seeding. */
    seed: number;
    /** When set, this is a re-edit of an existing vector layer (not a new one). */
    editId?: string;
    /** The layer's original vector, to restore on cancel. */
    orig?: VectorText;
  } | null>(null);
  const textSessionRef = useRef(textSession);
  textSessionRef.current = textSession;
  const textRef = useRef(text);
  textRef.current = text;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onPlaceTextRef = useRef(onPlaceText);
  onPlaceTextRef.current = onPlaceText;
  const onUpdateTextRef = useRef(onUpdateText);
  onUpdateTextRef.current = onUpdateText;
  const layersHitRef = useRef(layers);
  layersHitRef.current = layers;
  const textEditRef = useRef<HTMLDivElement>(null);
  const textDownRef = useRef<{ x: number; y: number } | null>(null);
  const textDragRef = useRef<Rect | null>(null);
  // Live warp/gradient preview: the contentEditable can only show flat text, so
  // while either is active we raster the real thing onto an overlay canvas and
  // hide the editor's own glyphs (its caret + selection stay visible).
  const textPreviewRef = useRef<HTMLCanvasElement>(null);
  const livePreviewOn = warpActive(text.warp) || !!text.fill;
  const showTextPreview = !!textSession && livePreviewOn;
  // Rasterize the current text block (if it has content) and end the session.
  // A re-edit (editId set) updates that layer in place; otherwise a new layer.
  // The editor DOM is the truth for content + runs (mixed styles).
  const commitText = useCallback(() => {
    const s = textSessionRef.current;
    if (!s) return;
    const el = textEditRef.current;
    const parsed = el
      ? serializeTextEditor(el, baseRunStyle(textRef.current))
      : { text: s.value, runs: undefined };
    const geom = { x: s.x, y: s.y, boxW: s.boxW, value: parsed.text, runs: parsed.runs };
    if (s.editId) {
      if (parsed.text.trim()) onUpdateTextRef.current(s.editId, geom);
      else if (s.orig) engine.renderText(s.editId, textSpecOf(s.orig)); // empty → keep original
    } else if (parsed.text.trim()) {
      onPlaceTextRef.current(geom);
    }
    setTextSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Cancel a text edit: discard a new one, or restore the original for a re-edit.
  const cancelText = useCallback(() => {
    const s = textSessionRef.current;
    if (s?.editId && s.orig) engine.renderText(s.editId, textSpecOf(s.orig));
    setTextSession(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // How far a vector layer's PIXELS have drifted from where its recipe would
  // draw them — i.e. the Move tool shifted the layer without touching the
  // recipe. Measured by rendering the recipe and comparing its content origin
  // to the layer's actual content origin, so it is exact (both come from the
  // same renderer) and reads 0 for text that has never moved.
  const textPixelOffset = (id: string, v: VectorText): { dx: number; dy: number } => {
    const live = engine.layerContentBounds(id);
    if (!live) return { dx: 0, dy: 0 };
    const ref = engine.canvasContentBounds(engine.textPreview(textSpecOf(v)));
    if (!ref) return { dx: 0, dy: 0 };
    return { dx: Math.round(live.x - ref.x), dy: Math.round(live.y - ref.y) };
  };
  /** `v` shifted by however far its pixels were moved (see textPixelOffset). */
  const textVectorAtPixels = (id: string, v: VectorText): VectorText => {
    const { dx, dy } = textPixelOffset(id, v);
    if (!dx && !dy) return v;
    return {
      ...v,
      x: v.x + dx,
      y: v.y + dy,
      bbox: { ...v.bbox, x: v.bbox.x + dx, y: v.bbox.y + dy },
    };
  };
  // Open an existing text vector layer for editing: load its style, hide its
  // rasterized pixels (the live textarea stands in), and seat the editor on it.
  const openTextReedit = (id: string, vRaw: VectorText) => {
    // Re-seat the recipe on the pixels' CURRENT position first, so a text layer
    // that was moved with the Move tool edits (and commits) where it now sits
    // instead of snapping back to where it was first typed.
    const v = textVectorAtPixels(id, vRaw);
    onTextRef.current({
      fontFamily: v.fontFamily,
      fontSize: v.fontSize,
      bold: v.bold,
      italic: v.italic,
      underline: v.underline,
      strike: v.strike,
      align: v.align,
      lineHeight: v.lineHeight,
      tracking: v.tracking,
      baseline: v.baseline ?? 0,
      caps: !!v.caps,
      color: v.color,
      features: v.features,
      axes: v.axes,
      warp: v.warp,
      fill: v.fill,
      // Seed the FX popover from the layer that is actually being edited, so it
      // shows what is applied rather than whatever the tool was last set to —
      // including effects added from the full Layer Style dialog.
      fx: findNode(layersRef.current, id)?.effects,
    });
    engine.clearLayerPixels(id);
    setTextSession({
      x: v.x,
      y: v.y,
      boxW: v.boxW,
      value: v.text,
      runs: v.runs,
      seed: Date.now(),
      editId: id,
      orig: v,
    });
  };
  /**
   * Topmost visible pixel layer whose OWN pixels are opaque at `pt` — the Move
   * tool's auto-select target.
   *
   * Walked back-to-front because `drawStack` composites a sibling list
   * bottom→top, so the last entry is the one on top. Alpha is read from the
   * layer rather than the composite: a layer showing through a hole in the one
   * above it is still the thing you clicked on.
   */
  const pickLayerAt = (pt: { x: number; y: number }): string | null => {
    const walk = (nodes: LayerNode[]): string | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n.visible) continue;
        if (n.type === "group") {
          const hit = walk(n.children);
          if (hit) return hit;
        } else if (n.type === "layer" && engine.layerAlphaAt(n.id, pt.x, pt.y) > 8) {
          return n.id;
        }
      }
      return null;
    };
    const hit = walk(layersRef.current);
    if (!hit || autoSelectScope !== "group") return hit;
    // Group scope selects the OUTERMOST group holding the hit layer, so moving
    // grabs the whole assembly rather than one piece of it.
    return layersRef.current.find((n) => n.type === "group" && containsId(n, hit))?.id ?? hit;
  };

  // Topmost visible vector layer of `type` whose bounds contain `pt` (or null).
  const vectorLayerAt = (
    pt: { x: number; y: number },
    type: "text" | "shape",
  ): { id: string; vector: VectorData } | null => {
    const pad = 4 / (zoomRef.current / 100);
    const hit = (v: VectorData, id: string): boolean => {
      if (v.type === "text" || v.type === "path") {
        // Axis-aligned bounds (imported vectors bake rotation into their paths).
        // For TEXT, prefer the layer's live pixel bounds: the Move tool shifts
        // pixels without rewriting the recipe, and hit-testing the stale recipe
        // box would both miss the text where it now is and re-open it where it
        // used to be (which then commits it back there).
        let b = v.bbox;
        if (v.type === "text") {
          const live = engine.layerContentBounds(id);
          if (live) b = live;
        }
        return pt.x >= b.x - pad && pt.x <= b.x + b.w + pad && pt.y >= b.y - pad && pt.y <= b.y + b.h + pad;
      }
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      const cos = Math.cos(-v.angle);
      const sin = Math.sin(-v.angle);
      const dx = pt.x - cx;
      const dy = pt.y - cy;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      return Math.abs(lx) <= v.w / 2 + pad && Math.abs(ly) <= v.h / 2 + pad;
    };
    const search = (nodes: LayerNode[]): { id: string; vector: VectorData } | null => {
      for (const n of nodes) {
        if (n.type === "group") {
          if (!n.visible) continue;
          const r = search(n.children);
          if (r) return r;
        } else if (n.type === "layer" && n.visible && n.vector && n.vector.type === type && hit(n.vector, n.id)) {
          return { id: n.id, vector: n.vector };
        }
      }
      return null;
    };
    return search(layersHitRef.current);
  };
  // Crop tool: latest box + settings reachable from the ants loop and handlers.
  const cropBoxRef = useRef(cropBox);
  cropBoxRef.current = cropBox;
  const onCropBoxRef = useRef(onCropBox);
  onCropBoxRef.current = onCropBox;
  const cropQuadRef = useRef(cropQuad);
  cropQuadRef.current = cropQuad;
  const onCropQuadRef = useRef(onCropQuad);
  onCropQuadRef.current = onCropQuad;
  // Which perspective-quad corner (0=tl..3=bl) is being dragged, or null.
  const perspDragRef = useRef<number | null>(null);
  const cropGridRef = useRef(cropGrid);
  cropGridRef.current = cropGrid;
  const cropShieldRef = useRef(cropShield);
  cropShieldRef.current = cropShield;
  const cropStraightenRef = useRef(cropStraighten);
  cropStraightenRef.current = cropStraighten;
  const cropAspectRef = useRef(cropAspect);
  cropAspectRef.current = cropAspect;
  const onCropApplyRef = useRef(onCropApply);
  onCropApplyRef.current = onCropApply;
  // In-progress crop drag: which handle ("move" | corners nw/ne/se/sw | edges
  // n/e/s/w | "new" rubber-band), the pointer-down doc point, and the box then.
  const cropDragRef = useRef<{
    handle: string;
    px: number;
    py: number;
    box: Rect;
  } | null>(null);
  // True while a blur-brush stroke is in progress (distinct from paint strokes).
  const blurringRef = useRef(false);
  const moveRef = useRef<{
    sx: number;
    sy: number;
    mode: MoveMode;
    float?: boolean;
    baseOff?: { x: number; y: number };
  } | null>(null);
  const moveDeltaRef = useRef({ x: 0, y: 0 });
  /** True while an arrow-key pixel nudge is in flight — the selection outline
   *  then follows moveDeltaRef live, exactly like a pointer move-drag. */
  const nudgeActiveRef = useRef(false);
  const resizeRef = useRef<{
    rects: Rect[];
    bbox: Rect;
    edges: HandleEdges;
    content: boolean;
    angle: number;
    pivot: { x: number; y: number };
    before: SelState;
  } | null>(null);
  const resizePreviewRef = useRef<Rect[] | null>(null);
  // Rotate drag (grab the ring): pivot (doc), pointer's start angle, the angle at
  // grab, the bounding box, and whether it rotates pixels (content) or just the
  // outline (bounds). `rotatePreviewRef` is the live angle (null = not rotating).
  const rotateRef = useRef<{
    cx: number;
    cy: number;
    start: number;
    base: number;
    bbox: Rect;
    content: boolean;
    before: SelState;
  } | null>(null);
  const rotatePreviewRef = useRef<number | null>(null);
  // Dragging the rotation anchor (pivot) around.
  const anchorRef = useRef(false);
  // Latest selection transform, reachable from the ants rAF loop / handlers.
  const selAngleRef = useRef(selectionAngle);
  selAngleRef.current = selectionAngle;
  const selPivotRef = useRef(selectionPivot);
  selPivotRef.current = selectionPivot;
  // Cursor override driven by hovering the selection (resize / rotate / anchor).
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  // Curves targeted-adjustment drag: the pointer's clientY at drag start.
  const curveDragYRef = useRef<number | null>(null);
  // Actions recorder: the in-progress stroke being captured (null = not armed).
  const strokeRecRef = useRef<StrokeStep | null>(null);
  // Viewport pixel size, tracked so the rulers can lay out their ticks.
  const [vpSize, setVpSize] = useState({ w: 0, h: 0 });
  const pickingRef = useRef(false);
  const toolRef = useRef(tool);
  const sampleSizeRef = useRef(sampleSize);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  // Inline tab rename (click the already-active tab to edit its name).
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  toolRef.current = tool;
  sampleSizeRef.current = sampleSize;
  const marqueeShapeRef = useRef(marqueeShape);
  marqueeShapeRef.current = marqueeShape;
  const marqueeApexRef = useRef(triangleApex);
  marqueeApexRef.current = triangleApex;
  // drawAnts is a useCallback keyed on [engine] and reads every prop through a
  // ref for exactly this reason — reading `selectionFeather` directly captured
  // its first-render value and the preview never appeared.
  const selectionFeatherRef = useRef(selectionFeather);
  selectionFeatherRef.current = selectionFeather;
  /** Ants-only preview of an in-flight Apex reshape (null = nothing pending).
   *  Non-null means the drawn outline is ahead of the committed selection. */
  const apexPreviewRef = useRef<Rect[] | null>(null);
  // Smart-blur anchor targeting: guide params for the overlay + live-drag flag.
  const filterAnchorRef = useRef(filterAnchor);
  filterAnchorRef.current = filterAnchor;
  const filterAnchorDragRef = useRef(false);
  // A just-committed triangle marquee, kept so the Apex slider can re-shape it while
  // it's still the active selection. `key` is the selection it produced; once the
  // selection changes by any other means the identity no longer matches and we drop it.
  const liveTriangleRef = useRef<{
    box: Rect;
    pointDown: boolean;
    base: Rect[];
    mode: SelOp;
    key: Rect[];
  } | null>(null);
  // Drop any hover cursor when the active tool changes.
  useEffect(() => {
    setHoverCursor(null);
  }, [tool]);
  // The clone source is in document coordinates, so forget it when the active
  // document changes (a stale source would sample the wrong image / location).
  useEffect(() => {
    cloneSrcRef.current = null;
    cloneOffRef.current = null;
  }, [activeId]);
  // Commit a pending text edit when leaving the Text tool.
  useEffect(() => {
    if (tool !== "text") commitText();
  }, [tool, commitText]);
  // Drop a pending text edit when the document changes (coords belong to it).
  useEffect(() => {
    setTextSession(null);
  }, [activeId]);
  // Seed + focus the overlay editor whenever a new text session opens: build
  // its DOM once from {text, runs} (uncontrolled afterwards — the browser owns
  // caret, selection and typing), then put the caret at the end.
  useEffect(() => {
    if (!textSession) return;
    const el = textEditRef.current;
    if (!el) return;
    seedTextEditor(el, textSession.value, textSession.runs, baseRunStyle(textRef.current));
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false); // caret at the end
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // Only re-seed when a session begins, never on keystrokes / style changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textSession?.seed]);
  // Auto-grow the overlay editor: point text shrink-wraps to its content; a
  // paragraph box keeps its width and grows in height as lines wrap.
  useEffect(() => {
    const el = textEditRef.current;
    if (!el || !textSession) return;
    if (textSession.boxW == null) {
      el.style.width = "1px";
      el.style.width = `${el.scrollWidth + 2}px`;
    } else {
      el.style.width = `${textSession.boxW}px`;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [textSession, text.fontFamily, text.fontSize, text.lineHeight, text.tracking, text.bold, text.italic]);
  // Live warp / gradient preview: re-raster the block through the real text
  // pipeline and blit it onto the overlay canvas. Reads content + runs straight
  // from the editor DOM (the same source commitText uses), so what's previewed
  // is exactly what will bake. Runs on every keystroke and style change.
  useEffect(() => {
    const cv = textPreviewRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const s = textSessionRef.current;
    if (!showTextPreview || !s) return;
    const el = textEditRef.current;
    const parsed = el
      ? serializeTextEditor(el, baseRunStyle(textRef.current))
      : { text: s.value, runs: undefined as TextRun[] | undefined };
    if (!parsed.text) return;
    const raster = engine.textPreview({
      ...textSpecBase(textRef.current),
      text: parsed.text,
      x: s.x,
      y: s.y,
      boxW: s.boxW,
      runs: parsed.runs,
    });
    ctx.drawImage(raster, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPreview, textSession, text, width, height]);
  const antsOffset = useRef(0);
  /** Scratch for the feather-preview outlines: carving them out needs a
   *  destination-out, which must not touch the shared overlay. */
  const featherLayerRef = useRef<HTMLCanvasElement | null>(null);
  const antsRaf = useRef(0);

  // Paint engine (created once; constructor is SSR-safe — no DOM access).
  const engineRef = useRef<PaintEngine | null>(null);
  if (!engineRef.current) engineRef.current = new PaintEngine();
  const engine = engineRef.current;

  // Dev-only console hooks: __gqRenderCache A/B (Spec 06 — disable() must be
  // pixel-identical, just slower) and __gqGPU A/B (WebGL2 tone-LUT stage vs
  // the always-correct Canvas2D path).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      __gqRenderCache?: object;
      __gqGPU?: object;
      __gqPerf?: object;
    };
    w.__gqRenderCache = {
      enable: () => engine.setRenderCacheEnabled(true),
      disable: () => engine.setRenderCacheEnabled(false),
      stats: () => engine.renderCacheStats(),
    };
    w.__gqGPU = {
      enable: () => engine.setGpuEnabled(true),
      disable: () => engine.setGpuEnabled(false),
      status: () => engine.gpuStatus(),
    };
    w.__gqPerf = {
      show: () => onPerfHudRef.current?.(true),
      hide: () => onPerfHudRef.current?.(false),
      toggle: () => onPerfHudRef.current?.(!perfHudRef.current),
      stats: () => engine.perfStats(),
    };
    return () => {
      delete w.__gqRenderCache;
      delete w.__gqGPU;
      delete w.__gqPerf;
    };
  }, [engine]);

  const layersRef = useRef(layers);
  layersRef.current = layers;
  const onLockedActionRef = useRef(onLockedAction);
  onLockedActionRef.current = onLockedAction;
  const perfHudRef = useRef(perfHud);
  perfHudRef.current = perfHud;
  const onPerfHudRef = useRef(onPerfHud);
  onPerfHudRef.current = onPerfHud;
  const perfStatsCb = useCallback(() => engine.perfStats(), [engine]);
  // Measure/ruler line: the committed line comes from the editor as a prop (drawn
  // on the overlay); which endpoint is being dragged lives here.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const measureDragRef = useRef<"start" | "end" | null>(null);
  // Latest ensureAnts (defined later) — lets the composite scheduler restart the
  // overlay loop for the Perf HUD dirty flash without a forward reference.
  const ensureAntsRef = useRef<() => void>(() => {});
  // Guard an edit against a layer's locks: returns true (and fires the toast)
  // when `id` is locked against `kind` ("pixels" for paint/fill, "position" for
  // move/transform). The engine also reverts pixel edits as a backstop, but
  // bailing here avoids the flash and gives the user an explanation.
  const lockBlocks = (id: string | null, kind: "pixels" | "position"): boolean => {
    if (!id) return false;
    const node = findNode(layersRef.current, id);
    if (!node) return false;
    const blocked = kind === "pixels" ? isPixelsLocked(node) : isPositionLocked(node);
    if (blocked) onLockedActionRef.current?.(kind);
    return blocked;
  };
  // Paint tools: block when the target layer's pixels aren't editable — a fill
  // layer is parametric (no pixels), or its pixels are locked — but never when
  // the active surface is a mask (masks are separate rasters, always paintable).
  const paintBlocked = (id: string | null): boolean => {
    // Quick Mask paints a document-level raster, so no layer lock applies — a
    // locked or parametric layer can still have a selection painted over it.
    if (engine.quickMaskActive()) return false;
    if (!id || engine.getActiveSurface(id) !== "pixels") return false;
    if (isFillLayer(findNode(layersRef.current, id))) {
      onLockedActionRef.current?.("fill");
      return true;
    }
    return lockBlocks(id, "pixels");
  };
  // Move tools: block a fill layer (nothing to move — it fills the canvas) or a
  // position-locked layer.
  const moveBlocked = (id: string | null): boolean => {
    if (!id) return false;
    if (isFillLayer(findNode(layersRef.current, id))) {
      onLockedActionRef.current?.("fill");
      return true;
    }
    return lockBlocks(id, "position");
  };
  // Linked layers that should ride along a whole-layer move of `primaryId`: the
  // other leaf pixel layers sharing its link key, minus any that are position-
  // locked or parametric fills (which don't move). Each carries its mask-link flag.
  const linkedMoveExtras = (primaryId: string): { id: string; maskLinked: boolean }[] => {
    const out: { id: string; maskLinked: boolean }[] = [];
    for (const id of linkedLeafIds(layersRef.current, primaryId)) {
      if (id === primaryId) continue;
      const node = findNode(layersRef.current, id);
      if (!node || node.type !== "layer" || isPositionLocked(node) || isFillLayer(node)) continue;
      out.push({ id, maskLinked: !!node.mask && node.mask.linked !== false });
    }
    return out;
  };
  const onHistoryRef = useRef(onHistory);
  onHistoryRef.current = onHistory;
  const onAdjustEndRef = useRef(onAdjustEnd);
  onAdjustEndRef.current = onAdjustEnd;

  const rafRef = useRef(0);
  const scheduleComposite = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      engine.composite(layersRef.current);
      if (perfHudRef.current) ensureAntsRef.current(); // flash the new dirty region
    });
  }, [engine]);

  // Marching ants: draw the selection (and any in-progress marquee) in screen
  // space so the dashes stay a constant size regardless of zoom.
  const drawAnts = useCallback(() => {
    const ov = overlayRef.current;
    const vp = viewportRef.current;
    const ctx = ov?.getContext("2d");
    if (!ov || !vp || !ctx) return;
    // Render at the device pixel ratio so thin strokes / the anchor stay crisp.
    const dpr = window.devicePixelRatio || 1;
    const cw = vp.clientWidth;
    const ch = vp.clientHeight;
    if (ov.width !== Math.round(cw * dpr) || ov.height !== Math.round(ch * dpr)) {
      ov.width = Math.round(cw * dpr);
      ov.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px, backed by device px
    ctx.clearRect(0, 0, cw, ch);
    const s = zoomRef.current / 100;
    const p = panR.current;

    // --- Quick Mask: shade everything the mask does NOT select in red ---------
    // Drawn FIRST, on the just-cleared overlay, because the punch-out below is a
    // destination-out — anything already painted inside the document rect would
    // be eaten by it. Everything else in this function then draws on top.
    //
    // Screen space, not document space: filling a document-sized scratch canvas
    // every frame would cost 24M pixels on a 6000×4000 image, while this is one
    // fill and one scaled blit bounded by the viewport, whatever the zoom.
    const qmCoverage = engine.quickMaskCoverage();
    if (qmCoverage) {
      const dw = widthRef.current * s;
      const dh = heightRef.current * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, dw, dh);
      ctx.clip();
      // Red at the overlay opacity everywhere, then remove it in proportion to
      // coverage: destination-out leaves dst.a × (1 − src.a), so a fully selected
      // pixel ends fully clear and a half-covered one keeps half the shade —
      // which is what makes a soft brush read as a feathered selection.
      ctx.fillStyle = QUICK_MASK_COLOR;
      ctx.fillRect(p.x, p.y, dw, dh);
      ctx.globalCompositeOperation = "destination-out";
      ctx.imageSmoothingEnabled = s < 1; // match the document blit: crisp when zoomed in
      ctx.drawImage(qmCoverage, p.x, p.y, dw, dh);
      ctx.restore();
    }

    // --- Perf HUD dirty-region flash (dev): outline what the last composite
    // re-blitted — green = a cheap region blit, red = a full-document recompute
    // — fading out over ~500ms so repeated edits pulse the touched area. ---
    if (perfHudRef.current) {
      const st = engine.perfStats();
      const age = performance.now() - st.dirtyAt;
      if (age < 500 && st.dirtyAt > 0) {
        const a = 1 - age / 500;
        const r = st.dirty ?? { x: 0, y: 0, w: widthRef.current, h: heightRef.current };
        const x = p.x + r.x * s;
        const y = p.y + r.y * s;
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = st.full ? `rgba(248,113,113,${0.9 * a})` : `rgba(74,222,128,${0.9 * a})`;
        ctx.fillStyle = st.full ? `rgba(248,113,113,${0.1 * a})` : `rgba(74,222,128,${0.1 * a})`;
        ctx.fillRect(x, y, r.w * s, r.h * s);
        ctx.strokeRect(x, y, r.w * s, r.h * s);
        ctx.restore();
      }
    }

    // --- bird's-eye: the region the release will zoom back into ---
    const bird = birdRef.current;
    if (bird) {
      const vp = viewportRef.current;
      if (vp) {
        const r = vp.getBoundingClientRect();
        // The remembered zoom shows this many doc px; draw that at today's scale.
        const prevScale = bird.prevZoom / 100;
        const bw = (vp.clientWidth / prevScale) * s;
        const bh = (vp.clientHeight / prevScale) * s;
        const bx = bird.x - r.left;
        const by = bird.y - r.top;
        ctx.save();
        ctx.fillStyle = "rgba(8,10,14,0.35)";
        ctx.fillRect(0, 0, cw, ch);
        ctx.clearRect(bx - bw / 2, by - bh / 2, bw, bh);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.strokeRect(bx - bw / 2, by - bh / 2, bw, bh);
        ctx.restore();
      }
    }

    // --- crop overlay (its own complete UI: shield + box/quad + grid + handles) ---
    const cb = cropBoxRef.current;
    const pq = cropQuadRef.current; // non-null ⇒ perspective mode (free quad)
    if (toolRef.current === "crop" && (cb || pq)) {
      let tl: [number, number];
      let tr: [number, number];
      let br: [number, number];
      let bl: [number, number];
      if (pq) {
        const sc = (pt: { x: number; y: number }): [number, number] => [p.x + pt.x * s, p.y + pt.y * s];
        tl = sc(pq[0]);
        tr = sc(pq[1]);
        br = sc(pq[2]);
        bl = sc(pq[3]);
      } else {
        const box = cb!;
        const ang = (cropStraightenRef.current * Math.PI) / 180;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const scx = p.x + cx * s;
        const scy = p.y + cy * s;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        // A box corner offset (doc px from centre) → rotated screen point.
        const corner = (dx: number, dy: number): [number, number] => [
          scx + (dx * cos - dy * sin) * s,
          scy + (dx * sin + dy * cos) * s,
        ];
        const hw = box.w / 2;
        const hh = box.h / 2;
        tl = corner(-hw, -hh);
        tr = corner(hw, -hh);
        br = corner(hw, hh);
        bl = corner(-hw, hh);
      }
      const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      const poly = (pts: [number, number][]) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      // Shield: dim everything, then punch out the crop rectangle.
      const shield = cropShieldRef.current / 100;
      if (shield > 0) {
        ctx.save();
        ctx.fillStyle = `rgba(8,10,14,${shield})`;
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalCompositeOperation = "destination-out";
        poly([tl, tr, br, bl]);
        ctx.fill();
        ctx.restore();
      }

      // Composition guide lines inside the box.
      const grid = cropGridRef.current;
      if (grid !== "none") {
        ctx.save();
        poly([tl, tr, br, bl]);
        ctx.clip();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        const vline = (f: number) => {
          const a = lerp(tl, tr, f);
          const b = lerp(bl, br, f);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        };
        const hline = (g: number) => {
          const a = lerp(tl, bl, g);
          const b = lerp(tr, br, g);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        };
        if (grid === "thirds") {
          [1 / 3, 2 / 3].forEach(vline);
          [1 / 3, 2 / 3].forEach(hline);
        } else if (grid === "grid") {
          [0.25, 0.5, 0.75].forEach(vline);
          [0.25, 0.5, 0.75].forEach(hline);
        } else if (grid === "golden") {
          [0.382, 0.618].forEach(vline);
          [0.382, 0.618].forEach(hline);
        } else if (grid === "diagonal") {
          ctx.beginPath();
          ctx.moveTo(tl[0], tl[1]);
          ctx.lineTo(br[0], br[1]);
          ctx.moveTo(tr[0], tr[1]);
          ctx.lineTo(bl[0], bl[1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Box outline.
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      poly([tl, tr, br, bl]);
      ctx.stroke();

      // Handles: 4 corners always; edge midpoints only for a rectangular box
      // (a free quad has no meaningful edge-midpoint drag).
      ctx.lineWidth = 1;
      const drawHandle = (hx: number, hy: number, big: boolean) => {
        const r = big ? 4.5 : 3.5;
        ctx.fillStyle = "rgba(255,255,255,0.98)";
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.beginPath();
        ctx.rect(hx - r, hy - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
      };
      [tl, tr, br, bl].forEach(([hx, hy]) => drawHandle(hx, hy, true));
      if (!pq) {
        [lerp(tl, tr, 0.5), lerp(tr, br, 0.5), lerp(br, bl, 0.5), lerp(bl, tl, 0.5)].forEach(
          ([hx, hy]) => drawHandle(hx, hy, false),
        );
      }

      // Size readout: for perspective, the estimated output rectangle.
      const label = pq
        ? (() => {
            const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
              Math.hypot(a.x - b.x, a.y - b.y);
            const ow = Math.round((d(pq[0], pq[1]) + d(pq[3], pq[2])) / 2);
            const oh = Math.round((d(pq[0], pq[3]) + d(pq[1], pq[2])) / 2);
            return `${ow} × ${oh}  ⟂`;
          })()
        : `${Math.round(cb!.w)} × ${Math.round(cb!.h)}${
            cropStraightenRef.current ? `   ${cropStraightenRef.current}°` : ""
          }`;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(label).width;
      const lx = Math.min(tl[0], tr[0], br[0], bl[0]);
      const ly = Math.min(tl[1], tr[1], br[1], bl[1]) - 22;
      ctx.fillStyle = "rgba(8,10,14,0.8)";
      ctx.beginPath();
      ctx.rect(lx, ly, tw + 12, 17);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 6, ly + 9);
      ctx.restore();
      return; // crop owns the overlay; skip the selection marching ants
    }

    // --- selection marching ants ---
    const m = marqueeRef.current;
    const mv = moveRef.current || nudgeActiveRef.current;
    const rz = resizePreviewRef.current;
    let rects: Rect[];
    if (apexPreviewRef.current) {
      // Live preview while the Apex slider is moving — drawn straight from the
      // ref so an in-flight reshape never touches React (see the apex effect).
      rects = apexPreviewRef.current;
    } else if (rz) {
      // Live preview while dragging a resize handle.
      rects = rz;
    } else if (m && m.mode === "new") {
      // While replacing (plain drag), show only the new marquee. Ellipse/triangle
      // marquees are previewed as a smooth outline below instead of a rect.
      rects =
        dragRectRef.current && marqueeShapeRef.current === "rect" ? [dragRectRef.current] : [];
    } else if (mv) {
      // While moving, offset the selection outline by the drag delta.
      const d = moveDeltaRef.current;
      rects = selectionRef.current.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y }));
    } else if (m && m.mode === "subtract") {
      // Subtracting: the current selection is unchanged here; the drag region is
      // previewed separately in red below.
      rects = selectionRef.current.slice();
    } else {
      // Adding (or static): the existing selection is unchanged and drawn from its
      // cached outline; the new region is previewed separately below so a large
      // (many-rect) selection — e.g. an ellipse/triangle — never vanishes mid-drag.
      rects = selectionRef.current.slice();
    }
    // Selection rotation (persisted, or live while dragging the ring): spin the
    // outline + handles about the pivot (anchor), in screen space.
    const ang = rotatePreviewRef.current ?? selAngleRef.current;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    let scx = 0;
    let scy = 0;
    if (rects.length) {
      // While resizing, rotate about the locked grab pivot so the preview lines
      // up with the committed result; otherwise use the selection's pivot/centre.
      const pv = resizeRef.current ? resizeRef.current.pivot : selPivotRef.current;
      if (pv) {
        // While moving, the pivot travels with the content so a rotated selection
        // translates as a whole instead of swinging about a fixed point (which
        // would make the outline drift away from the moved pixels).
        const md = mv ? moveDeltaRef.current : { x: 0, y: 0 };
        scx = p.x + (pv.x + md.x) * s;
        scy = p.y + (pv.y + md.y) * s;
      } else {
        const bb = bboxOf(rects);
        scx = p.x + (bb.x + bb.w / 2) * s;
        scy = p.y + (bb.y + bb.h / 2) * s;
      }
    }
    const rot = (x: number, y: number): [number, number] =>
      ang === 0
        ? [x, y]
        : [scx + (x - scx) * cosA - (y - scy) * sinA, scy + (x - scx) * sinA + (y - scy) * cosA];

    // For a magic-wand selection use the pre-traced boundary segments (cheap),
    // transformed for move/resize; unionSegments is O(rects³) — too slow here.
    const cache = wandSegsRef.current;
    const isWand = !!cache && cache.key === selectionRef.current;
    let segs: Seg[];
    if (isWand && rz && resizeRef.current) {
      // Resizing: scale the cached boundary from the grab bbox to the preview.
      const o = resizeRef.current.bbox;
      const nb = bboxOf(rz);
      const fx = o.w ? nb.w / o.w : 1;
      const fy = o.h ? nb.h / o.h : 1;
      segs = cache!.segs.map((g) => ({
        x1: nb.x + (g.x1 - o.x) * fx,
        y1: nb.y + (g.y1 - o.y) * fy,
        x2: nb.x + (g.x2 - o.x) * fx,
        y2: nb.y + (g.y2 - o.y) * fy,
      }));
    } else if (isWand && mv) {
      const d = moveDeltaRef.current;
      segs = cache!.segs.map((g) => ({ x1: g.x1 + d.x, y1: g.y1 + d.y, x2: g.x2 + d.x, y2: g.y2 + d.y }));
    } else if (isWand && !rz && m?.mode !== "new") {
      // Static selection, or an add / subtract drag — the existing selection is
      // unchanged, so reuse its cached outline (the new region is previewed below).
      segs = cache!.segs;
    } else {
      // unionSegments is O(rects³); never run it on a wand-sized rect set without
      // a cache match (e.g. a transient frame during undo/redo) — it would freeze.
      segs = rects.length && rects.length <= 80 ? unionSegments(rects) : [];
    }
    if (segs.length) {
      // Stitch the segments into connected loops and stroke each as one polyline,
      // so the dash runs continuously around the perimeter — every edge marches in
      // its own direction (circulating the loop), and corners flow into each other.
      const loops = tracePerimeter(segs);
      const tx = (x: number, y: number): [number, number] =>
        ang === 0
          ? [Math.round(p.x + x * s) + 0.5, Math.round(p.y + y * s) + 0.5]
          : rot(p.x + x * s, p.y + y * s);
      const antPath = (c: CanvasRenderingContext2D) => {
        c.beginPath();
        for (const loop of loops) {
          for (let i = 0; i < loop.length; i++) {
            const [sx, sy] = tx(loop[i].x, loop[i].y);
            if (i === 0) c.moveTo(sx, sy);
            else c.lineTo(sx, sy);
          }
        }
      };

      // --- feather preview: two faint outlines at the edges of the soft band --
      // The ants mark the 50% line, which tells you nothing about how far a
      // feathered selection actually reaches. These show the extent.
      //
      // The offsets come from STROKE GEOMETRY rather than from offsetting the
      // polygon: stroking the ant path at 2·softness and then carving the middle
      // out with destination-out leaves exactly the inner and outer bounds, with
      // the rasteriser doing the offset-curve work (including the corners). It
      // needs its own canvas because that carve would otherwise eat whatever
      // else is already on the overlay — the Quick Mask wash, for one.
      const soft = effectiveSoftness({
        ...engine.getRefineEdge(),
        feather: selectionFeatherRef.current,
      });
      const bandPx = soft * 2 * s;
      if (bandPx >= 3) {
        let fc = featherLayerRef.current;
        if (!fc) fc = featherLayerRef.current = document.createElement("canvas");
        if (fc.width !== ov.width || fc.height !== ov.height) {
          fc.width = ov.width;
          fc.height = ov.height;
        }
        const fx2 = fc.getContext("2d");
        if (fx2) {
          fx2.setTransform(dpr, 0, 0, dpr, 0, 0);
          fx2.clearRect(0, 0, cw, ch);
          fx2.strokeStyle = "#fff";
          fx2.lineJoin = "round";
          fx2.lineWidth = bandPx;
          antPath(fx2);
          fx2.stroke();
          fx2.globalCompositeOperation = "destination-out";
          fx2.lineWidth = Math.max(0.5, bandPx - 1.5);
          antPath(fx2);
          fx2.stroke();
          fx2.globalCompositeOperation = "source-over";
          ctx.save();
          ctx.globalAlpha = 0.42;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(fc, 0, 0);
          ctx.restore();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      }

      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Two passes (black, then white offset by half a dash) make the classic ants.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        antPath(ctx);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- marquee region in progress: a dashed outline of the new region, drawn
    //     separately from the existing ants. Ellipse/triangle marquees always use
    //     this (any mode); an additive rectangle uses it too (a "new" rectangle is
    //     drawn through the ants above; a subtracted one shows in red below). ---
    const mShape = marqueeShapeRef.current;
    const mdr = dragRectRef.current;
    if (m && (mShape !== "rect" || m.mode === "add") && mdr && mdr.w >= 1 && mdr.h >= 1) {
      const sx = (x: number) => p.x + x * s;
      const sy = (y: number) => p.y + y * s;
      // Apex points toward the drag direction: down when the anchor (initial click)
      // sits at the top of the box (i.e. dragged downward), up otherwise.
      const triDown = m.y <= mdr.y + mdr.h / 2;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        ctx.beginPath();
        if (mShape === "ellipse") {
          ctx.ellipse(
            sx(mdr.x + mdr.w / 2),
            sy(mdr.y + mdr.h / 2),
            (mdr.w / 2) * s,
            (mdr.h / 2) * s,
            0,
            0,
            Math.PI * 2,
          );
        } else if (mShape === "triangle") {
          const apexX = sx(mdr.x + marqueeApexRef.current * mdr.w);
          if (triDown) {
            ctx.moveTo(sx(mdr.x), sy(mdr.y)); // top-left
            ctx.lineTo(sx(mdr.x + mdr.w), sy(mdr.y)); // top-right
            ctx.lineTo(apexX, sy(mdr.y + mdr.h)); // bottom apex
          } else {
            ctx.moveTo(apexX, sy(mdr.y)); // top apex
            ctx.lineTo(sx(mdr.x + mdr.w), sy(mdr.y + mdr.h)); // bottom-right
            ctx.lineTo(sx(mdr.x), sy(mdr.y + mdr.h)); // bottom-left
          }
          ctx.closePath();
        } else {
          ctx.rect(sx(mdr.x), sy(mdr.y), mdr.w * s, mdr.h * s); // additive rectangle
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- lasso in progress: the freeform path, auto-closed start↔end ---
    // (a subtracting lasso is drawn in red by the subtract-preview block below)
    const lasso = lassoRef.current;
    if (lasso && lasso.length && lassoModeRef.current !== "subtract") {
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        ctx.beginPath();
        ctx.moveTo(p.x + lasso[0].x * s, p.y + lasso[0].y * s);
        for (let i = 1; i < lasso.length; i++) ctx.lineTo(p.x + lasso[i].x * s, p.y + lasso[i].y * s);
        ctx.closePath(); // straight shortest-distance edge back to the start
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- polygonal lasso in progress: committed edges + rubber-band to cursor,
    //     with a vertex handle on each point. Subtract ops draw red. ---
    const poly = polyRef.current;
    if (poly && poly.pts.length) {
      const sub = poly.op === "subtract";
      const hover = polyHoverRef.current;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(p.x + poly.pts[0].x * s, p.y + poly.pts[0].y * s);
        for (let i = 1; i < poly.pts.length; i++) {
          ctx.lineTo(p.x + poly.pts[i].x * s, p.y + poly.pts[i].y * s);
        }
        if (hover) ctx.lineTo(p.x + hover.x * s, p.y + hover.y * s); // rubber band
      };
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : sub ? "#ff3b3b" : "#fff";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        path();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Vertex handles — filled dots, larger + accented on the start point.
      for (let i = 0; i < poly.pts.length; i++) {
        const vx = p.x + poly.pts[i].x * s;
        const vy = p.y + poly.pts[i].y * s;
        const r = i === 0 ? 4 : 3;
        ctx.beginPath();
        ctx.arc(vx, vy, r, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#fff" : "rgba(255,255,255,0.9)";
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
    }

    // --- subtract preview (Alt): the region being removed, in red. A faint red
    //     fill marks the part that overlaps the current selection (what's cut),
    //     and a red marching-ants outline traces the whole dragged region. ---
    const subRect = m && m.mode === "subtract" ? dragRectRef.current : null;
    const subLasso = lasso && lasso.length && lassoModeRef.current === "subtract" ? lasso : null;
    if (subRect || subLasso) {
      const traceRegion = () => {
        if (subRect) {
          ctx.rect(p.x + subRect.x * s, p.y + subRect.y * s, subRect.w * s, subRect.h * s);
        } else if (subLasso) {
          ctx.moveTo(p.x + subLasso[0].x * s, p.y + subLasso[0].y * s);
          for (let i = 1; i < subLasso.length; i++) {
            ctx.lineTo(p.x + subLasso[i].x * s, p.y + subLasso[i].y * s);
          }
          ctx.closePath();
        }
      };
      // Red fill of the overlap with the current selection = exactly what's cut.
      const sel = selectionRef.current;
      if (sel.length) {
        ctx.save();
        ctx.beginPath();
        for (const r of sel) ctx.rect(p.x + r.x * s, p.y + r.y * s, r.w * s, r.h * s);
        ctx.clip();
        ctx.beginPath();
        traceRegion();
        ctx.fillStyle = "rgba(255, 64, 64, 0.22)";
        ctx.fill();
        ctx.restore();
      }
      // Red marching-ants outline of the whole region being dragged.
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(255, 255, 255, 0.9)" : "#ff3b3b";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        ctx.beginPath();
        traceRegion();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- shape tool: live preview of the shape being drawn (filled + stroked) ---
    const shapeBox = shapeRef.current ? shapeRectRef.current : null;
    if (shapeBox && (shapeBox.w > 0 || shapeBox.h > 0)) {
      const o = shapeOptsRef.current;
      const screenBox = {
        x: p.x + shapeBox.x * s,
        y: p.y + shapeBox.y * s,
        w: shapeBox.w * s,
        h: shapeBox.h * s,
      };
      ctx.save();
      renderShape(
        ctx,
        o.kind,
        screenBox,
        o.fill,
        o.stroke,
        o.strokeWidth * s,
        o.radius * s,
        shapeGeom(o.kind),
      );
      ctx.restore();
    }

    // --- paint-bucket: preview of the area that will be filled (follows cursor) ---
    const bk = bucketRef.current;
    if (bk && bk.rects.length) {
      // Clip to the whole region and fill once. Filling each rect separately
      // anti-aliases both sides of every shared edge, which shows as faint seam
      // lines through a semi-transparent fill.
      ctx.save();
      ctx.beginPath();
      for (const r of bk.rects) ctx.rect(p.x + r.x * s, p.y + r.y * s, r.w * s, r.h * s);
      ctx.clip();
      ctx.fillStyle = bk.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }

    // --- live bucket fill: a solid border on the clicked (seed) pixel ---
    const lb = liveBucketRef.current;
    if (lb) {
      // The pixel itself, but never smaller than ~7px so it stays visible.
      const size = Math.max(s, 7);
      const cx = p.x + (lb.seedX + 0.5) * s;
      const cy = p.y + (lb.seedY + 0.5) * s;
      const x = Math.round(cx - size / 2) + 0.5;
      const y = Math.round(cy - size / 2) + 0.5;
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeRect(x, y, size, size);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(x, y, size, size);
    }

    // --- gradient: the line, endpoint handles + the draggable midpoint tick ---
    const grad = gradientRef.current;
    if (grad) {
      const ax = p.x + grad.start.x * s;
      const ay = p.y + grad.start.y * s;
      const bx = p.x + grad.end.x * s;
      const by = p.y + grad.end.y * s;
      const mx = ax + (bx - ax) * grad.mid;
      const my = ay + (by - ay) * grad.mid;
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      // Connecting line (dark underlay + white).
      for (const [w, col] of [
        [3, "rgba(0,0,0,0.5)"],
        [1, "#fff"],
      ] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      // Endpoint dots.
      const dot = (x: number, y: number) => {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
      };
      dot(ax, ay);
      dot(bx, by);
      // Perpendicular unit for the ticks.
      const a = Math.atan2(by - ay, bx - ax) + Math.PI / 2;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const tick = (cx: number, cy: number, len: number, dw: number, lw: number) => {
        for (const [w, col] of [
          [dw, "rgba(0,0,0,0.5)"],
          [lw, "#fff"],
        ] as const) {
          ctx.lineWidth = w;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(cx - ux * len, cy - uy * len);
          ctx.lineTo(cx + ux * len, cy + uy * len);
          ctx.stroke();
        }
      };
      // Fixed marker at the geometric centre (50%) — a small reference tick.
      tick(ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, 4, 2.5, 1);
      // Draggable midpoint tick (where the colours' halfway point sits).
      tick(mx, my, 7, 4, 2);
      ctx.lineCap = "butt";
    }

    // --- measure/ruler: the line + endpoint dots + a compact angle/length label ---
    const meas = measureRef.current;
    if (toolRef.current === "measure" && meas) {
      const ax = p.x + meas.x1 * s;
      const ay = p.y + meas.y1 * s;
      const bx = p.x + meas.x2 * s;
      const by = p.y + meas.y2 * s;
      ctx.setLineDash([]);
      ctx.lineCap = "round";
      for (const [w, col] of [
        [3, "rgba(0,0,0,0.55)"],
        [1, "#ffd24a"],
      ] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      const dot = (x: number, y: number) => {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffd24a";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
      };
      dot(ax, ay);
      dot(bx, by);
      ctx.lineCap = "butt";
      // Floating label near the far endpoint: angle + pixel length.
      const info = measureInfo(meas);
      if (info.length > 0.5) {
        const label = `${info.angle.toFixed(1)}° · ${Math.round(info.length)} px`;
        ctx.font = "11px var(--font-mono, monospace)";
        const tw = ctx.measureText(label).width;
        const lx = bx + 10;
        const ly = by - 10;
        ctx.fillStyle = "rgba(12,14,20,0.82)";
        ctx.fillRect(lx - 4, ly - 11, tw + 8, 16);
        ctx.fillStyle = "#ffe9a6";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx, ly - 2);
      }
    }

    // --- frames: chrome on the SELECTED frame layer ---
    // Only the selected one. Testing every frame for emptiness would mean
    // scanning its pixels on every overlay frame, and showing chrome on all of
    // them at once would bury the artwork under boxes.
    {
      const sel = activeLayerId ? findNode(layersRef.current, activeLayerId) : null;
      const fr = sel && sel.type === "layer" ? sel.frame : undefined;
      if (fr) {
        const rx = p.x + fr.x * s;
        const ry = p.y + fr.y * s;
        const rw = fr.w * s;
        const rh = fr.h * s;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        if (fr.shape === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = shapeNodeColor();
          ctx.stroke();
        } else {
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.strokeStyle = shapeNodeColor();
          ctx.strokeRect(rx, ry, rw, rh);
        }
        // The placeholder cross — how a frame says "something goes here".
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + rw, ry + rh);
        ctx.moveTo(rx + rw, ry);
        ctx.lineTo(rx, ry + rh);
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- frame tool: the rubber band while dragging one out ---
    const fd = frameDragRef.current;
    if (fd) {
      const rx = p.x + Math.min(fd.x0, fd.x1) * s;
      const ry = p.y + Math.min(fd.y0, fd.y1) * s;
      const rw = Math.abs(fd.x1 - fd.x0) * s;
      const rh = Math.abs(fd.y1 - fd.y0) * s;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = shapeNodeColor();
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    // --- direct selection: the anchor marquee ---
    const dsm = dsMarqueeRef.current;
    if (dsm) {
      const rx = p.x + Math.min(dsm.x0, dsm.x1) * s;
      const ry = p.y + Math.min(dsm.y0, dsm.y1) * s;
      const rw = Math.abs(dsm.x1 - dsm.x0) * s;
      const rh = Math.abs(dsm.y1 - dsm.y0) * s;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineDashOffset = 4;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.lineDashOffset = 0;
      ctx.setLineDash([]);
    }

    // --- pen: the editable path skeleton + anchor / handle nodes ---
    const path = penPathRef.current;
    if (path && path.anchors.length) {
      const sx = (x: number) => p.x + x * s;
      const sy = (y: number) => p.y + y * s;
      const a = path.anchors;
      ctx.setLineDash([]);
      // Skeleton: the bezier path through the anchors (dark underlay + white).
      if (a.length >= 2) {
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(sx(a[0].x), sy(a[0].y));
          for (let i = 1; i < a.length; i++) {
            ctx.bezierCurveTo(sx(a[i - 1].ox), sy(a[i - 1].oy), sx(a[i].ix), sy(a[i].iy), sx(a[i].x), sy(a[i].y));
          }
          if (path.closed) {
            const f = a[0];
            const l = a[a.length - 1];
            ctx.bezierCurveTo(sx(l.ox), sy(l.oy), sx(f.ix), sy(f.iy), sx(f.x), sy(f.y));
          }
        };
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        trace();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = shapeNodeColor();
        trace();
        ctx.stroke();
      }
      // Bend handles: shown on EVERY anchor at all times — at the control point
      // when pulled out, otherwise as a fixed-length stub along the path tangent —
      // with a dark underlay + bright line + a dot, so they stay visible and
      // grabbable on any background and at any zoom level.
      for (let i = 0; i < a.length; i++) {
        const an = a[i];
        for (const isOut of [false, true]) {
          if (isOut ? !penHasOut(i, a.length, path.closed) : !penHasIn(i, a.length, path.closed)) {
            continue;
          }
          const h = penHandlePos(a, i, path.closed, isOut, s);
          const ax = sx(an.x);
          const ay = sy(an.y);
          const bx = sx(h.x);
          const by = sy(h.y);
          for (const [w, col] of [
            [3, "rgba(0,0,0,0.45)"],
            [1, "rgba(255,255,255,0.95)"],
          ] as const) {
            ctx.lineWidth = w;
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(bx, by, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.stroke();
        }
      }
      // Anchor circles: white with a blue outline matching the path skeleton; the
      // first one is larger to show where clicking closes the path. Under Direct
      // Selection the SELECTED points are filled instead of hollow, which is the
      // only way to tell what a drag is about to move.
      a.forEach((an, i) => {
        const r = i === 0 && !path.closed && a.length >= 2 ? 6 : 5;
        const picked = toolRef.current === "directselect" && dsSelRef.current.has(i);
        ctx.beginPath();
        ctx.arc(sx(an.x), sy(an.y), r, 0, Math.PI * 2);
        ctx.fillStyle = picked ? shapeNodeColor() : "#fff";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = shapeNodeColor();
        ctx.stroke();
      });
    }

    // --- eyedropper: solid outline around the pixels being sampled ---
    const hov = hoverRef.current;
    if (toolRef.current === "eyedropper" && hov) {
      const size = Math.max(1, sampleSizeRef.current);
      const half = Math.floor(size / 2);
      const x = Math.round(p.x + (Math.floor(hov.x) - half) * s) + 0.5;
      const y = Math.round(p.y + (Math.floor(hov.y) - half) * s) + 0.5;
      const w = Math.max(1, Math.round(size * s));
      const h = Math.max(1, Math.round(size * s));
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(x, y, w, h);
    }

    // --- resize handles + rotation anchor (Marquee + Wand tools) ---
    if (
      toolRef.current === "select" ||
      toolRef.current === "wand" ||
      toolRef.current === "shape"
    ) {
      const handleRects =
        rz ?? (selectionRef.current.length >= 1 && !m && !mv ? selectionRef.current : null);
      if (handleRects && handleRects.length) {
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        const bb = bboxOf(handleRects);
        const dot = (hx: number, hy: number, r: number) => {
          ctx.beginPath();
          ctx.arc(Math.round(hx), Math.round(hy), r, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.stroke();
        };
        // Resize handles, rotated to follow the (possibly diagonal) box. Wand
        // selections resize too (the cached boundary segments scale with them).
        for (const h of rectHandles(bb)) {
          const [hx, hy] = rot(p.x + h.x * s, p.y + h.y * s);
          dot(hx, hy, 4);
        }
        // Rotation anchor (the pivot): a crisp crosshair + a white centre dot
        // with a thin black outline. Half-pixel centre keeps 1px lines sharp.
        const acx = Math.round(scx) + 0.5;
        const acy = Math.round(scy) + 0.5;
        ctx.lineCap = "round";
        for (const [w, col] of [
          [3, "rgba(255,255,255,0.95)"],
          [1, "#000"],
        ] as const) {
          ctx.lineWidth = w;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(acx - 9, acy);
          ctx.lineTo(acx + 9, acy);
          ctx.moveTo(acx, acy - 9);
          ctx.lineTo(acx, acy + 9);
          ctx.stroke();
        }
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.arc(acx, acy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#000";
        ctx.stroke();

        // Shape nodes on the top edge — the trapezoid's two side nodes or the
        // triangle's apex — plus the centre/symmetry guide lines (vertical in the
        // shape's own frame) shown while snapped.
        const liveN = liveShapeRef.current;
        const nodeKind = shapeOptsRef.current.kind;
        if (toolRef.current === "shape" && liveN && (nodeKind === "trapezoid" || nodeKind === "tri")) {
          const nb = liveN.box;
          const nodeXs =
            nodeKind === "trapezoid"
              ? [nb.x + trapRef.current.l * nb.w, nb.x + nb.w - trapRef.current.r * nb.w]
              : [nb.x + triApexRef.current * nb.w];
          // Guide lines while snapped: trapezoid → the two node verticals; triangle
          // → the centre vertical it snapped to.
          if (nodeSnapRef.current) {
            const ext = 14 / s; // extend a touch past the box, in doc units
            const guideXs = nodeKind === "trapezoid" ? nodeXs : [nb.x + nb.w / 2];
            for (const gx of guideXs) {
              const [x1, y1] = rot(p.x + gx * s, p.y + (nb.y - ext) * s);
              const [x2, y2] = rot(p.x + gx * s, p.y + (nb.y + nb.h + ext) * s);
              for (const [w, col] of [
                [3, "rgba(0,0,0,0.35)"],
                [1, shapeNodeColor()],
              ] as const) {
                ctx.lineWidth = w;
                ctx.strokeStyle = col;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
              }
            }
          }
          for (const gx of nodeXs) {
            const [hx, hy] = rot(p.x + gx * s, p.y + nb.y * s);
            ctx.beginPath();
            ctx.arc(Math.round(hx), Math.round(hy), 5, 0, Math.PI * 2);
            ctx.fillStyle = shapeNodeColor();
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#fff";
            ctx.stroke();
          }
        }
      }
    }

    // --- brush-ring cursors (paint/heal/blur/dodge/clone) ---------------------
    // Drawn on the overlay so they scale with zoom and show the hardness falloff;
    // the OS cursor is hidden for these tools (see the view canvas style). The
    // light strokes take Preferences ▸ Cursors' ring colour; a dark under-stroke
    // keeps them readable on light pixels either way.
    const cp = cursorPrefsRef.current;
    const cm = /^#?([0-9a-f]{6})/i.exec(cp.ringColor);
    const cn = cm ? parseInt(cm[1], 16) : 0xffffff;
    const lite = (a: number) => `rgba(${(cn >> 16) & 255},${(cn >> 8) & 255},${cn & 255},${a})`;
    const drawCross = (cxp: number, cyp: number, len: number) => {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        ctx.moveTo(cxp - len, cyp);
        ctx.lineTo(cxp + len, cyp);
        ctx.moveTo(cxp, cyp - len);
        ctx.lineTo(cxp, cyp + len);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = lite(0.92);
      }
    };
    // A brush ring at full diameter + a dashed inner ring at the hardness radius.
    const drawRing = (hx: number, hy: number, r: number, hardness: number) => {
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.stroke();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = lite(0.95);
      ctx.stroke();
      const inner = r * (hardness / 100);
      if (hardness < 100 && inner < r - 1.5 && inner > 0.5) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(hx, hy, inner, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = lite(0.8);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    // The per-tool cursor: precise crosshair, or the ring (+ optional centre).
    const drawBrushCursor = (hx: number, hy: number, r: number, hardness: number) => {
      if (cp.mode === "precise") {
        drawCross(hx, hy, 7);
        return;
      }
      drawRing(hx, hy, r, hardness);
      if (cp.crosshair) drawCross(hx, hy, 4);
    };

    // While smart-blur anchor targeting is armed the pointer belongs to it —
    // no tool hover rings (the crosshair cursor + anchor guide are the UI).
    const anchorArmed = !!filterAnchorRef.current;

    if (
      !anchorArmed &&
      (toolRef.current === "brush" || toolRef.current === "pencil" || toolRef.current === "eraser") &&
      paintHoverRef.current
    ) {
      const b = paintBrushRef.current;
      const hx = p.x + paintHoverRef.current.x * s;
      const hy = p.y + paintHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (b.size / 2) * s), b.hardness);
    }

    if (!anchorArmed && toolRef.current === "heal") {
      // The painted blob: a translucent veil so you see what will be healed.
      const pts = healPtsRef.current;
      const hr = Math.max(1, (healRef.current.size / 2) * s);
      if (pts && pts.length) {
        ctx.save();
        ctx.beginPath();
        for (const q of pts) {
          ctx.moveTo(p.x + q.x * s + hr, p.y + q.y * s);
          ctx.arc(p.x + q.x * s, p.y + q.y * s, hr, 0, Math.PI * 2);
        }
        ctx.fillStyle = "rgba(0,0,0,0.32)";
        ctx.fill();
        ctx.restore();
      }
      if (healHoverRef.current) {
        const hx = p.x + healHoverRef.current.x * s;
        const hy = p.y + healHoverRef.current.y * s;
        drawBrushCursor(hx, hy, hr, healRef.current.hardness);
      }
    }

    if (!anchorArmed && toolRef.current === "redeye" && redEyeHoverRef.current) {
      const hx = p.x + redEyeHoverRef.current.x * s;
      const hy = p.y + redEyeHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (redEyeRef.current.size / 2) * s), 100);
    }

    if (!anchorArmed && toolRef.current === "blur" && blurHoverRef.current) {
      const b = blurRef.current;
      const hx = p.x + blurHoverRef.current.x * s;
      const hy = p.y + blurHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (b.size / 2) * s), b.hardness);
    }

    if (!anchorArmed && toolRef.current === "quickselect" && quickSelectHoverRef.current) {
      const q = quickSelectRef.current;
      const hx = p.x + quickSelectHoverRef.current.x * s;
      const hy = p.y + quickSelectHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (q.size / 2) * s), 100);
    }

    if (!anchorArmed && toolRef.current === "history" && historyHoverRef.current) {
      const hb = historyBrushRef.current;
      const hx = p.x + historyHoverRef.current.x * s;
      const hy = p.y + historyHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (hb.size / 2) * s), hb.hardness);
    }

    if (
      !anchorArmed &&
      (toolRef.current === "smudge" || toolRef.current === "mixer") &&
      smudgeHoverRef.current
    ) {
      const sm = toolRef.current === "mixer" ? mixerRef.current : smudgeRef.current;
      const hx = p.x + smudgeHoverRef.current.x * s;
      const hy = p.y + smudgeHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (sm.size / 2) * s), sm.hardness);
    }

    if (!anchorArmed && toolRef.current === "dodge" && dodgeHoverRef.current) {
      const d = dodgeRef.current;
      const hx = p.x + dodgeHoverRef.current.x * s;
      const hy = p.y + dodgeHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (d.size / 2) * s), d.hardness);
    }

    if (!anchorArmed && toolRef.current === "sponge" && spongeHoverRef.current) {
      const sp = spongeRef.current;
      const hx = p.x + spongeHoverRef.current.x * s;
      const hy = p.y + spongeHoverRef.current.y * s;
      drawBrushCursor(hx, hy, Math.max(1, (sp.size / 2) * s), sp.hardness);
    }

    if (!anchorArmed && toolRef.current === "clone" && cloneHoverRef.current) {
      const c = cloneRef.current;
      const hov = cloneHoverRef.current;
      const hx = p.x + hov.x * s;
      const hy = p.y + hov.y * s;
      const r = Math.max(1, (c.size / 2) * s);
      // Where the clone is (or would be) sampling from.
      const off = cloneOffRef.current;
      let srcPt: { x: number; y: number } | null = null;
      if (paintingRef.current && off) srcPt = { x: hov.x + off.x, y: hov.y + off.y };
      else if (cloneSrcRef.current)
        srcPt = c.aligned && off ? { x: hov.x + off.x, y: hov.y + off.y } : cloneSrcRef.current;

      if (srcPt) {
        const sx = p.x + srcPt.x * s;
        const sy = p.y + srcPt.y * s;
        // Faint connector from source to the brush while actively cloning.
        if (paintingRef.current && off) {
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = lite(0.45);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Source marker: a small ringed cross-hair.
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = lite(0.95);
        ctx.stroke();
        drawCross(sx, sy, 5);
      }

      // Alt held → "set source" reticle; otherwise the normal brush ring.
      if (cloneAltRef.current) {
        ctx.beginPath();
        ctx.arc(hx, hy, 9, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = lite(0.95);
        ctx.stroke();
        drawCross(hx, hy, 7);
      } else {
        drawBrushCursor(hx, hy, r, c.hardness);
      }
    }

    // --- text paragraph-box rubber-band (while dragging to define a box) ------
    const tdr = textDragRef.current;
    if (toolRef.current === "text" && tdr) {
      const rx = p.x + tdr.x * s;
      const ry = p.y + tdr.y * s;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeRect(rx + 0.5, ry + 0.5, tdr.w * s, tdr.h * s);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeRect(rx + 0.5, ry + 0.5, tdr.w * s, tdr.h * s);
      ctx.setLineDash([]);
    }

    // --- smart-blur anchor targeting: the same guides the Blur Gallery draws on
    //     its preview, here over the live document — a centre reticle for zoom/
    //     spin, the focus-band lines for tilt-shift (band math mirrors filters.ts:
    //     offsets are % of min(doc W, doc H) / 2, drawn at the current zoom). ---
    const fa = filterAnchorRef.current;
    if (fa) {
      const dw = widthRef.current;
      const dh = heightRef.current;
      const ax = p.x + fa.anchor.x * dw * s;
      const ay = p.y + fa.anchor.y * dh * s;
      const dual = (draw: () => void) => {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        draw();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        draw();
      };
      if (fa.kind === "zoom" || fa.kind === "spin") {
        dual(() => {
          ctx.beginPath();
          ctx.arc(ax, ay, 8, 0, Math.PI * 2);
          ctx.moveTo(ax - 12, ay);
          ctx.lineTo(ax + 12, ay);
          ctx.moveTo(ax, ay - 12);
          ctx.lineTo(ax, ay + 12);
          ctx.stroke();
        });
      } else {
        const rad = (fa.angle * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const nx = -dy;
        const ny = dx;
        const base = Math.min(dw, dh) * s;
        const bandPx = (fa.band / 100) * base * 0.5;
        const featherPx = Math.max(1, (fa.feather / 100) * base * 0.5);
        const L = cw + ch; // long enough to cross the viewport at any angle
        const line = (off: number) => {
          const lx = ax + nx * off;
          const ly = ay + ny * off;
          ctx.beginPath();
          ctx.moveTo(lx - dx * L, ly - dy * L);
          ctx.lineTo(lx + dx * L, ly + dy * L);
          ctx.stroke();
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x, p.y, dw * s, dh * s); // clip the lines to the artwork
        ctx.clip();
        dual(() => line(0));
        dual(() => {
          line(bandPx);
          line(-bandPx);
        });
        ctx.setLineDash([5, 5]);
        dual(() => {
          line(bandPx + featherPx);
          line(-bandPx - featherPx);
        });
        ctx.setLineDash([]);
        ctx.restore();
        dual(() => {
          ctx.beginPath();
          ctx.arc(ax, ay, 5, 0, Math.PI * 2);
          ctx.stroke();
        });
      }
    }
  }, []);

  const tickAnts = useCallback(() => {
    antsOffset.current = (antsOffset.current + 0.18) % 8;
    drawAnts();
    if (
      // The quick mask lives on the overlay canvas, which this loop owns and
      // clears when it stops — so the loop has to run for as long as the mode is
      // on, or the red would vanish the moment nothing else needed a frame.
      engine.quickMaskActive() ||
      selectionRef.current.length > 0 ||
      dragRectRef.current ||
      lassoRef.current ||
      polyRef.current ||
      shapeRef.current ||
      bucketRef.current ||
      liveBucketRef.current ||
      gradientRef.current ||
      penPathRef.current ||
      dsMarqueeRef.current ||
      (toolRef.current === "crop" && cropBoxRef.current) ||
      ((toolRef.current === "brush" || toolRef.current === "pencil" || toolRef.current === "eraser") &&
        paintHoverRef.current) ||
      (toolRef.current === "heal" && (healHoverRef.current || healPtsRef.current)) ||
      (toolRef.current === "redeye" && redEyeHoverRef.current) ||
      (toolRef.current === "blur" && blurHoverRef.current) ||
      (toolRef.current === "quickselect" && quickSelectHoverRef.current) ||
      (toolRef.current === "history" && historyHoverRef.current) ||
      ((toolRef.current === "smudge" || toolRef.current === "mixer") && smudgeHoverRef.current) ||
      (toolRef.current === "dodge" && dodgeHoverRef.current) ||
      (toolRef.current === "sponge" && spongeHoverRef.current) ||
      (toolRef.current === "clone" && cloneHoverRef.current) ||
      (toolRef.current === "text" && textDragRef.current) ||
      (toolRef.current === "eyedropper" && hoverRef.current) ||
      (toolRef.current === "measure" && measureRef.current) ||
      birdRef.current ||
      filterAnchorRef.current ||
      // Keep the loop alive while a dirty-region flash is still fading.
      (perfHudRef.current && performance.now() - engine.perfStats().dirtyAt < 520)
    ) {
      antsRaf.current = requestAnimationFrame(tickAnts);
    } else {
      antsRaf.current = 0;
      const ctx = overlayRef.current?.getContext("2d");
      if (ctx && overlayRef.current) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    }
  }, [drawAnts]);

  const ensureAnts = useCallback(() => {
    if (!antsRaf.current) antsRaf.current = requestAnimationFrame(tickAnts);
  }, [tickAnts]);
  ensureAntsRef.current = ensureAnts;

  // Start the overlay loop when the Perf HUD turns on so any recent dirty region
  // flashes right away (and it stops itself once the flash fades).
  useEffect(() => {
    if (perfHud) ensureAnts();
  }, [perfHud, ensureAnts]);

  // Repaint the hover cursor immediately when its prefs change (otherwise the
  // new ring style waits for the next pointer move).
  useEffect(() => {
    ensureAnts();
  }, [cursorPrefs, ensureAnts]);

  // Keep the overlay loop alive while a crop box is present so it stays drawn and
  // reflects live edits (drag, W/H fields, ratio, straighten).
  useEffect(() => {
    if (tool === "crop" && cropBox) ensureAnts();
  }, [tool, cropBox, cropGrid, cropShield, cropStraighten, cropAspect, ensureAnts]);

  // Same for the smart-blur anchor guide: start the loop when armed, repaint when
  // the dialog's sliders move the geometry (the loop's else-branch clears it off).
  useEffect(() => {
    if (filterAnchor) ensureAnts();
  }, [filterAnchor, ensureAnts]);

  // ---- Undoable selection transforms (resize / rotate) ----
  // Snapshot the live selection (rects + rotation + wand ants cache) and restore
  // it; `selSide` wraps a before/after pair as a history side so the transform
  // rides on the engine's undo stack (alone for Bounds, on the pixel entry for
  // Content). Restoring also re-seats the wand cache so the ants stay cheap.
  const snapshotSel = (): SelState => ({
    rects: selectionRef.current,
    angle: selAngleRef.current,
    pivot: selPivotRef.current,
    segs: wandSegsRef.current?.key === selectionRef.current ? wandSegsRef.current.segs : null,
  });
  const applySel = (st: SelState) => {
    wandSegsRef.current = st.segs ? { key: st.rects, segs: st.segs } : null;
    wandSeedRef.current = null;
    onSelectionRects(st.rects);
    onSelectionAngle(st.angle);
    onSelectionPivot(st.pivot);
    ensureAnts();
  };
  const selSide = (before: SelState, after: SelState) => ({
    undo: () => applySel(before),
    redo: () => applySel(after),
  });

  // Re-shape a just-created triangle marquee live as the Apex slider moves — but
  // only while it is still the active selection (any other change drops tracking).
  //
  // PREVIEW IN A REF, COMMIT ONCE. Each rebuild is a full-document mask combine
  // plus a boundary retrace; committing it to React additionally re-renders
  // every panel subscribed to the selection, measured at ~100 dock DOM mutations
  // per tick (2002 over one 20-step sweep). So a moving slider only ever draws
  // from `apexPreviewRef` — the marching ants read it directly — and the real
  // selection is committed once the slider has been still for a moment.
  //
  // rAF-coalesced on top, which matters for real bursty input (a high-rate mouse
  // can deliver several ticks per frame) even though a scripted drag arrives at
  // about one per frame and sees no benefit from it.
  const apexRafRef = useRef(0);
  const apexCommitRef = useRef(0);
  useEffect(() => {
    if (!liveTriangleRef.current) return;
    const commit = () => {
      const lt = liveTriangleRef.current;
      const preview = apexPreviewRef.current;
      apexPreviewRef.current = null;
      if (!lt || !preview) return;
      // The commit is deferred, so the user can deselect (or select something
      // else) inside the settle window — without this, that pending commit would
      // resurrect the selection they just dismissed. While a preview is pending
      // the committed selection is still the tracked one, so it must match.
      if (selectionRef.current !== lt.key) {
        liveTriangleRef.current = null;
        ensureAnts(); // repaint without the abandoned preview
        return;
      }
      const result = engine.combineSelection(
        lt.base,
        marqueeSelRects(lt.box, "triangle", lt.pointDown, marqueeApexRef.current),
        lt.mode === "subtract" ? "subtract" : "add",
      );
      applyCombined(result);
      liveTriangleRef.current = result && result.rects.length ? { ...lt, key: result.rects } : null;
      ensureAnts();
    };
    if (!apexRafRef.current) {
      apexRafRef.current = requestAnimationFrame(() => {
        apexRafRef.current = 0;
        const lt = liveTriangleRef.current;
        if (!lt) return;
        // The tracked selection must still be the live one; anything else means
        // the user changed the selection elsewhere and this must stop.
        if (!apexPreviewRef.current && selectionRef.current !== lt.key) {
          liveTriangleRef.current = null;
          return;
        }
        // Read the LATEST apex at frame time, not the value this effect closed
        // over — coalescing is only correct if the frame uses the newest input.
        const sel = marqueeSelRects(lt.box, "triangle", lt.pointDown, marqueeApexRef.current);
        const result = engine.combineSelection(lt.base, sel, lt.mode === "subtract" ? "subtract" : "add");
        apexPreviewRef.current = result?.rects.length ? result.rects : [];
        ensureAnts();
      });
    }
    // Settle: once the slider stops, commit the real selection exactly once.
    window.clearTimeout(apexCommitRef.current);
    apexCommitRef.current = window.setTimeout(commit, 140);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triangleApex]);

  // Drop queued apex work on unmount so it can't run against a dead engine.
  useEffect(
    () => () => {
      if (apexRafRef.current) cancelAnimationFrame(apexRafRef.current);
      window.clearTimeout(apexCommitRef.current);
    },
    [],
  );

  useEffect(() => {
    if (selection.length) {
      // Multi-rect selections set from outside the canvas (e.g. Select › Inverse)
      // arrive without a traced outline. Pre-trace their boundary once and cache
      // it (keyed by the rects array) so the ants render via the cheap cached
      // path instead of the per-frame unionSegments call, which is rect-capped.
      if (selection.length > 1 && wandSegsRef.current?.key !== selection) {
        wandSegsRef.current = { key: selection, segs: unionSegments(selection) };
      }
      ensureAnts();
    } else {
      // Selection cleared (e.g. Esc): wipe the leftover outline from the overlay.
      const ov = overlayRef.current;
      const ctx = ov?.getContext("2d");
      if (ov && ctx) ctx.clearRect(0, 0, ov.width, ov.height);
    }
    return () => {
      if (antsRaf.current) {
        cancelAnimationFrame(antsRaf.current);
        antsRaf.current = 0;
      }
    };
  }, [selection, ensureAnts]);

  // Re-render the live shape whenever its settings change (colour / stroke /
  // radius / kind) — it stays editable while its selection is up.
  useEffect(() => {
    reRenderLiveShape();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.kind, shape.fill, shape.stroke, shape.strokeWidth, shape.radius]);

  // Finalize the live shape when its selection goes away (deselect / reselect).
  useEffect(() => {
    const live = liveShapeRef.current;
    if (live && selection[0] !== live.box) engine.endShape();
  }, [selection, engine]);

  // Re-render the live gradient when its settings change (type / reverse / stops
  // / colours), so it stays editable while its handles are up. Coalesced to one
  // render per frame so dragging the colour picker (many ticks/s) stays smooth.
  useEffect(() => {
    if (!gradientRef.current) return;
    const id = requestAnimationFrame(renderGradient);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradient.type, gradient.reverse, gradient.smooth, gradient.stops, gradient.fg, gradient.bg]);

  // Commit the live gradient when leaving the gradient tool.
  useEffect(() => {
    if (tool !== "gradient") engine.endGradient();
  }, [tool, engine]);

  // Re-stroke the live pen path when its options change (width / taper / bend) or
  // the stroke colour changes, so the preview stays current while it's editable.
  useEffect(() => {
    if (penPathRef.current) renderPenLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pen.width, pen.taper, pen.bend, color]);

  // Commit the live pen path when leaving BOTH tools that edit it.
  useEffect(() => {
    if (tool !== "pen" && tool !== "directselect" && penPathRef.current) finishPenPath();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, engine]);

  // Re-run the live bucket fill when its options (tolerance / opacity /
  // contiguous) or the fill colours change — coalesced to one run per frame.
  useEffect(() => {
    if (liveBucketRef.current) scheduleLiveBucket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket.tolerance, bucket.opacity, bucket.contiguous, bucket.antialias, foreground, background]);

  // Commit the live bucket fill when leaving the bucket tool.
  useEffect(() => {
    if (tool !== "bucket" && liveBucketRef.current) finishLiveBucket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, engine]);

  // Esc deselects the just-filled pixel — keeping the fill, dropping the marker.
  useEffect(() => {
    if (tool !== "bucket") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && liveBucketRef.current) {
        e.preventDefault();
        finishLiveBucket();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, engine]);

  // Esc commits the drawn gradient — the gradient stays, its control handles vanish.
  useEffect(() => {
    if (tool !== "gradient") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gradientRef.current) {
        e.preventDefault();
        engine.endGradient();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, engine]);

  // Finish (commit) the pen path with Enter / Escape while the pen tool is active.
  useEffect(() => {
    if (tool !== "pen" && tool !== "directselect") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === "Escape") && penPathRef.current) {
        e.preventDefault();
        finishPenPath();
        return;
      }
      // Direct Selection: remove the selected points. Guarded on the tool so a
      // Delete elsewhere still means "clear the selection".
      if (
        tool === "directselect" &&
        (e.key === "Delete" || e.key === "Backspace") &&
        penPathRef.current &&
        dsSelRef.current.size
      ) {
        e.preventDefault();
        const path = penPathRef.current;
        path.anchors = deleteAnchors(path.anchors, dsSelRef.current);
        dsSelRef.current = new Set();
        renderPenLive();
        ensureAnts();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, engine]);

  // Polygonal lasso keys: Enter closes, Escape cancels, Backspace undoes a
  // vertex. Cancels the in-progress polygon when the tool/variant changes.
  useEffect(() => {
    const cancelPoly = () => {
      if (polyRef.current) {
        polyRef.current = null;
        polyHoverRef.current = null;
        ensureAnts();
      }
    };
    if (tool !== "lasso" || lassoMode !== "poly") {
      cancelPoly();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (!polyRef.current) return;
      if (e.key === "Enter") {
        e.preventDefault();
        commitPolyLasso();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPoly();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const poly = polyRef.current;
        poly.pts.pop();
        if (poly.pts.length === 0) cancelPoly();
        else ensureAnts();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelPoly();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, lassoMode, engine]);

  // Live-update a magic-wand selection when its options change (e.g. dragging
  // the Tolerance slider) — re-run the wand from the same seed, reusing the
  // cached source pixels. THROTTLED (leading + trailing) so the heavy recompute
  // can't saturate the main thread and stall the slider; the trailing run keeps
  // the final value correct. Only runs while the selection IS the live wand.
  useEffect(() => {
    if (!wandSeedRef.current) return;
    if (!wandSegsRef.current || wandSegsRef.current.key !== selectionRef.current) return;
    const run = () => {
      const seed = wandSeedRef.current;
      const cache = wandSegsRef.current;
      if (!seed || !cache || cache.key !== selectionRef.current) return;
      const o = wandOptsRef.current;
      if (!o.sampleAll && !seed.layerId) return;
      const raw = engine.magicWand(
        seed.layerId ?? "",
        seed.x,
        seed.y,
        { tolerance: o.tolerance, contiguous: o.contiguous, sampleAll: o.sampleAll },
        true, // reuse cached source pixels
        seed.mode === "add" && seed.base.length ? seed.base : null, // keep the added-to selection
      );
      if (seed.mode === "subtract") {
        if (raw) {
          applyCombined(engine.combineSelection(seed.base, raw.rects, "subtract"));
          ensureAnts();
        }
      } else if (raw && raw.rects.length) {
        wandSegsRef.current = { key: raw.rects, segs: raw.segments };
        onSelectionChange(raw.rects);
        ensureAnts();
      }
    };
    const WAND_THROTTLE = 60; // ms between live recomputes
    const tr = wandThrottleRef.current;
    const now = performance.now();
    const wait = WAND_THROTTLE - (now - tr.last);
    clearTimeout(tr.timer);
    if (wait <= 0) {
      tr.last = now;
      run();
    } else {
      tr.timer = window.setTimeout(() => {
        wandThrottleRef.current.last = performance.now();
        run();
      }, wait);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wand.tolerance, wand.contiguous, wand.sampleAll]);

  // Cancel a pending trailing recompute on unmount.
  useEffect(() => () => clearTimeout(wandThrottleRef.current.timer), []);

  // Drop the eyedropper outline when switching to another tool.
  useEffect(() => {
    if (tool !== "eyedropper") {
      hoverRef.current = null;
      ensureAnts();
    }
  }, [tool, ensureAnts]);
  // Keep the latest values reachable from one-time listeners / stable callbacks.
  const zoomRef = useRef(zoom);
  const scaleRef = useRef(zoom / 100);
  const onZoomChangeRef = useRef(onZoomChange);
  const setPanRef = useRef(setPan);
  const onViewportRef = useRef(onViewport);
  const widthRef = useRef(width);
  const heightRef = useRef(height);
  const mobileRef = useRef(mobile);
  zoomRef.current = zoom;
  scaleRef.current = zoom / 100;
  onZoomChangeRef.current = onZoomChange;
  setPanRef.current = setPan;
  onViewportRef.current = onViewport;
  widthRef.current = width;
  heightRef.current = height;
  mobileRef.current = mobile;
  // True once the user has zoomed/panned/drawn — a still-false ("pristine") view
  // re-fits on viewport resize so the mobile-shell reflow (which widens the
  // canvas after the initial fit) leaves the document centred.
  const viewTouchedRef = useRef(false);

  const prevZoomRef = useRef(zoom);
  const focalRef = useRef<{ ax: number; ay: number } | null>(null);
  /** A pan queued for a specific target zoom (fit / view restore). Tagging it
   *  with the zoom stops the zoom effect's mount run from consuming it early
   *  at the not-yet-updated scale — which left the canvas off-centre on load. */
  const pendingPanRef = useRef<{ pan: Pan; zoom: number } | null>(null);
  const sizeInitRef = useRef(true);
  const panRef = useRef(pan);
  panRef.current = pan;

  const clampHere = (x: number, y: number, scale: number, vp: HTMLElement) =>
    clampPan(x, y, scale, widthRef.current, heightRef.current, vp.clientWidth, vp.clientHeight);

  /** Zoom the whole document to fit the viewport and centre it. */
  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const w = widthRef.current;
    const h = heightRef.current;
    const raw = Math.min(vp.clientWidth / w, vp.clientHeight / h) * 100 * 0.96;
    const z = clamp(Math.max(1, Math.floor(raw)), MIN_ZOOM, MAX_ZOOM);
    const s = z / 100;
    const px = (vp.clientWidth - w * s) / 2;
    const py = (vp.clientHeight - h * s) / 2;
    if (z === zoomRef.current) {
      setPanRef.current(clampPan(px, py, s, w, h, vp.clientWidth, vp.clientHeight));
    } else {
      pendingPanRef.current = { pan: { x: px, y: py }, zoom: z };
      onZoomChangeRef.current(z);
    }
  }, []);

  // Track whether the H key is physically held — the bird's-eye modifier. (H
  // also selects the Hand tool via the shortcut registry; that is the same
  // double duty Photoshop gives it.) Cleared on blur so a lost keyup can't
  // leave the modifier stuck on.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") hKeyRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") hKeyRef.current = false;
    };
    const clear = () => {
      hKeyRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  /** Enter bird's-eye: remember the zoom, then fit the whole document so the
   *  drag can aim anywhere in it. */
  const beginBirdsEye = (clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return false;
    const w = widthRef.current;
    const h = heightRef.current;
    const raw = Math.min(vp.clientWidth / w, vp.clientHeight / h) * 100 * 0.96;
    const z = clamp(Math.max(1, Math.floor(raw)), MIN_ZOOM, MAX_ZOOM);
    birdRef.current = { prevZoom: zoomRef.current, x: clientX, y: clientY };
    const s = z / 100;
    const px = (vp.clientWidth - w * s) / 2;
    const py = (vp.clientHeight - h * s) / 2;
    if (z === zoomRef.current) {
      setPanRef.current(clampPan(px, py, s, w, h, vp.clientWidth, vp.clientHeight));
    } else {
      pendingPanRef.current = { pan: { x: px, y: py }, zoom: z };
      onZoomChangeRef.current(z);
    }
    ensureAntsRef.current();
    return true;
  };

  /** Leave bird's-eye: go back to the remembered zoom, centred on the document
   *  point the pointer is over. */
  const endBirdsEye = () => {
    const bird = birdRef.current;
    const vp = viewportRef.current;
    birdRef.current = null;
    if (!bird || !vp) return;
    const r = vp.getBoundingClientRect();
    const cur = zoomRef.current / 100;
    const p = panR.current;
    // Document point under the pointer at the CURRENT (fitted) view.
    const docX = (bird.x - r.left - p.x) / cur;
    const docY = (bird.y - r.top - p.y) / cur;
    const next = clamp(Math.round(bird.prevZoom), MIN_ZOOM, MAX_ZOOM);
    const ns = next / 100;
    const px = vp.clientWidth / 2 - docX * ns;
    const py = vp.clientHeight / 2 - docY * ns;
    if (next === zoomRef.current) {
      setPanRef.current(clampHere(px, py, ns, vp));
    } else {
      pendingPanRef.current = { pan: { x: px, y: py }, zoom: next };
      onZoomChangeRef.current(next);
    }
    ensureAntsRef.current();
  };

  // Native, non-passive wheel handling so preventDefault() works.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl / pinch → zoom, pivoting around the cursor.
        const cur = zoomRef.current;
        const next = clamp(Math.round(cur * Math.pow(1.0015, -e.deltaY)), MIN_ZOOM, MAX_ZOOM);
        if (next === cur) return;
        const r = vp.getBoundingClientRect();
        focalRef.current = { ax: e.clientX - r.left, ay: e.clientY - r.top };
        onZoomChangeRef.current(next);
      } else if (e.shiftKey) {
        // Shift → pan horizontally.
        const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        setPanRef.current((p) => clampHere(p.x - d, p.y, scaleRef.current, vp));
      } else {
        // Plain wheel → pan vertically.
        setPanRef.current((p) => clampHere(p.x, p.y - e.deltaY, scaleRef.current, vp));
      }
    };

    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-document view: each tab keeps its own zoom/pan. The outgoing doc's
  // view is saved on switch; the incoming doc's is restored — and a document
  // that has never been active (including the first one, on mount) defaults to
  // the Fit-on-Screen view, so it always starts correctly centred.
  const viewMemRef = useRef(new Map<string, { zoom: number; pan: Pan }>());
  const prevDocRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const prev = prevDocRef.current;
    if (prev === activeId) return;
    prevDocRef.current = activeId;
    if (prev !== null) {
      viewMemRef.current.set(prev, { zoom: zoomRef.current, pan: panRef.current });
      // Drop views of closed documents.
      const alive = new Set(docs.map((d) => d.id));
      for (const id of [...viewMemRef.current.keys()]) if (!alive.has(id)) viewMemRef.current.delete(id);
    }
    const mem = prev === null ? undefined : viewMemRef.current.get(activeId);
    if (!mem) {
      fit();
      return;
    }
    const vp = viewportRef.current;
    if (!vp) return;
    if (mem.zoom === zoomRef.current) {
      setPanRef.current(clampHere(mem.pan.x, mem.pan.y, mem.zoom / 100, vp));
    } else {
      pendingPanRef.current = { pan: mem.pan, zoom: mem.zoom }; // applied by the zoom effect below
      onZoomChangeRef.current(mem.zoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, fit]);

  // When zoom changes, pivot around the focal point (cursor or viewport centre),
  // or apply an explicit pan queued by fit().
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const newScale = zoom / 100;
    const prevScale = prevZoomRef.current / 100;
    prevZoomRef.current = zoom;

    if (pendingPanRef.current?.zoom === zoom) {
      const p = pendingPanRef.current;
      pendingPanRef.current = null;
      setPanRef.current(clampHere(p.pan.x, p.pan.y, newScale, vp));
      return;
    }
    if (prevScale === newScale) return;
    pendingPanRef.current = null; // a different zoom arrived first — the queued pan is obsolete

    const f = focalRef.current;
    focalRef.current = null;
    const ax = f ? f.ax : vp.clientWidth / 2;
    const ay = f ? f.ay : vp.clientHeight / 2;
    setPanRef.current((prev) => {
      const docX = (ax - prev.x) / prevScale;
      const docY = (ay - prev.y) / prevScale;
      return clampHere(ax - docX * newScale, ay - docY * newScale, newScale, vp);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Re-centre when the canvas is resized (Image/Canvas Size, crop, rotate) —
  // but not on the first mount, and not when the size change comes from
  // switching documents: the per-document view effect above owns the view then.
  const sizeDocRef = useRef(activeId);
  useEffect(() => {
    const switched = sizeDocRef.current !== activeId;
    sizeDocRef.current = activeId;
    if (sizeInitRef.current) {
      sizeInitRef.current = false;
      return;
    }
    if (switched) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const s = zoomRef.current / 100;
    setPanRef.current(clampHere((vp.clientWidth - width * s) / 2, (vp.clientHeight - height * s) / 2, s, vp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, activeId]);

  // Report the viewport size up, and re-clamp the pan, on resize.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      onViewportRef.current({ w: vp.clientWidth, h: vp.clientHeight });
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
      // On mobile the first fit() runs against the transient desktop-flow width
      // (toolbar + dock still in flow); once the mobile CSS lifts them out and
      // the canvas widens, re-fit a still-untouched view so it lands centred.
      // A touched view (or desktop) just clamps the existing pan, as before.
      if (mobileRef.current && !viewTouchedRef.current) fit();
      else setPanRef.current((p) => clampHere(p.x, p.y, scaleRef.current, vp));
    });
    ro.observe(vp);
    setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire the paint engine to the view canvas. Re-runs when the working colour
  // space changes (the view canvas is remounted via its key so its 2D context
  // is recreated in the new space).
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    engine.setColorSpace(colorSpace); // sets the space + converts existing layers
    engine.setView(v); // recreates vctx in the working space
    engine.setDoc(widthRef.current, heightRef.current, collectLeafIds(layersRef.current));
    engine.setMaskView(null); // mask view never survives a doc (re)activation
    engine.onChange = scheduleComposite;
    engine.onHistory = (s) => onHistoryRef.current(s);
    engine.onAdjustEnd = () => onAdjustEndRef.current();
    engine.onShapeEnd = () => {
      liveShapeRef.current = null;
    };
    engine.onGradientEnd = () => {
      gradientRef.current = null;
      gradDragRef.current = null;
      ensureAnts();
    };
    engine.onPathEnd = () => {
      penPathRef.current = null;
      penDragRef.current = null;
      penGrabRef.current = null;
      ensureAnts();
    };
    engine.onFillEnd = () => {
      liveBucketRef.current = null;
      ensureAnts();
    };
    paintRef.current = {
      undo: () => engine.undo(),
      redo: () => engine.redo(),
      jumpTo: (i) => engine.jumpTo(i),
      setHistorySourceIndex: (i) => engine.setHistorySourceIndex(i),
      sampleColor: (x, y, size, allLayers, layerId) => engine.sampleColor(x, y, size, allLayers, layerId),
      createSnapshot: (label, ids) => engine.createSnapshot(label, ids),
      restoreSnapshot: (id) => engine.restoreSnapshot(id),
      deleteSnapshot: (id) => engine.deleteSnapshot(id),
      setHistorySourceSnapshot: (id) => engine.setHistorySourceSnapshot(id),
      fillSelection: (layerId, rects, col, angle, pivot, feather) =>
        engine.fillSelection(layerId, rects, col, angle, pivot, feather),
      eraseSelection: (layerId, rects, angle, pivot, label, feather) =>
        engine.eraseSelection(layerId, rects, angle, pivot, label, feather),
      copyRegion: (rects, angle, pivot) => engine.copyRegion(rects, angle, pivot),
      lassoSelect: (points) => engine.lassoSelect(points),
      combineSelection: (base, region, mode) => engine.combineSelection(base, region, mode),
      strokePath: (layerId, anchors, closed, settings, color) => {
        engine.livePath(layerId, anchors, closed, settings, color);
        engine.endPath(); // bakes + journals the tight "Path" entry
      },
      playStroke: (layerId, toolKind, settings, color, points, sel, angle, pivot) => {
        if (!points.length) return;
        engine.beginStroke(
          layerId,
          settings,
          color,
          points[0].x,
          points[0].y,
          toolKind === "eraser" ? "erase" : "paint",
          sel,
          angle,
          pivot,
          toolKind === "eraser" ? "Erase" : toolKind === "pencil" ? "Pencil" : "Brush",
        );
        for (let i = 1; i < points.length; i++) engine.moveStroke(points[i].x, points[i].y);
        engine.endStroke();
      },
      isFloating: () => engine.isFloating,
      commitFloat: () => engine.commitFloat(),
      discardFloat: () => engine.discardFloat(),
      duplicateLayer: (s, d) => engine.duplicateLayer(s, d),
      rasterize: (id, nodes, del) => engine.rasterize(id, nodes, del),
      removeLayer: (id) => engine.removeLayer(id),
      getLayerImage: (id) => engine.getLayerImage(id),
      getLayerCanvas: (id) => engine.getLayerCanvas(id),
      setLayerImage: (id, src, x, y) => engine.setLayerImage(id, src, x, y),
      applyLayerImage: (id, src, label) => engine.applyLayerImage(id, src, label),
      getMaskImage: (id) => engine.getMaskImage(id),
      setMaskImage: (id, src) => engine.setMaskImage(id, src),
      exportComposite: (tree) => engine.exportComposite(tree),
      histogram: (tree, sel, selAngle, selPivot) => engine.histogram(tree, sel, selAngle, selPivot),
      maskHistogram: (id, surface) => engine.maskHistogram(id, surface),
      setMaskView: (id, surface) => engine.setMaskView(id, surface),
      subscribe: (cb) => engine.addChangeListener(cb),
      resizeImage: (w, h, ids, smooth) => engine.resizeImage(w, h, ids, smooth),
      transformImage: (kind, ids) => engine.transformImage(kind, ids),
      clearLayerPixels: (id) => engine.clearLayerPixels(id),
      syncLayerLocks: (list) => engine.syncLayerLocks(list),
      isPixelsLocked: (id) => engine.isPixelsLocked(id),
      renderText: (id, spec) => engine.renderText(id, spec),
      textBounds: (spec) => engine.textBounds(spec),
      rasterizeShape: (id, box, angle, kind, fill, stroke, sw, radius, geom) =>
        engine.rasterizeShape(id, box, angle, kind, fill, stroke, sw, radius, geom),
      beginBlurFx: (ids, sel, selAngle, selPivot) =>
        engine.beginBlurFx(ids, sel, selAngle, selPivot),
      previewBlurFx: (kind, amount, angle, anchorX, anchorY, extra) =>
        engine.previewBlurFx(kind, amount, angle, anchorX, anchorY, extra),
      previewBlurFxAsync: (kind, amount, angle, anchorX, anchorY, extra) =>
        engine.previewBlurFxAsync(kind, amount, angle, anchorX, anchorY, extra),
      commitBlurFx: (label) => engine.commitBlurFx(label),
      cancelBlurFx: () => engine.cancelBlurFx(),
      beginBlur: (layerId, blur, x, y, clip, clipAngle, clipPivot) =>
        engine.beginBlur(layerId, blur, x, y, clip, clipAngle, clipPivot),
      moveBlur: (x, y) => engine.moveBlur(x, y),
      endBlur: () => engine.endBlur(),
      beginSmudge: (layerId, opts, x, y, finger, clip, clipAngle, clipPivot) =>
        engine.beginSmudge(layerId, opts, x, y, finger, clip, clipAngle, clipPivot),
      beginMixer: (layerId, opts, x, y, fg, clip, clipAngle, clipPivot) =>
        engine.beginMixer(layerId, opts, x, y, fg, clip, clipAngle, clipPivot),
      cleanMixer: () => engine.cleanMixer(),
      moveSmudge: (x, y) => engine.moveSmudge(x, y),
      endSmudge: () => engine.endSmudge(),
      beginSponge: (layerId, opts, x, y, clip, clipAngle, clipPivot) =>
        engine.beginSponge(layerId, opts, x, y, clip, clipAngle, clipPivot),
      moveSponge: (x, y) => engine.moveSponge(x, y),
      endSponge: () => engine.endSponge(),
      cropSnapshot: (ids) => engine.cropSnapshot(ids),
      applyCrop: (rect, ids, angle, fillGaps) => engine.applyCrop(rect, ids, angle, fillGaps),
      applyPerspectiveCrop: (quad, outW, outH, ids) =>
        engine.applyPerspectiveCrop(quad, outW, outH, ids),
      cropRestore: (snap) => engine.cropRestore(snap),
      applyAdjust: (layerId, adj, sel, angle, pivot) =>
        engine.applyAdjust(layerId, adj, sel, angle, pivot),
      previewTone: (layerId, spec, sel, angle, pivot) =>
        engine.previewTone(layerId, spec, sel, angle, pivot),
      endAdjust: () => engine.endAdjust(),
      revertAdjust: () => engine.revertAdjust(),
      modifySelection: (rects, angle, pivot, op, px) => engine.modifySelection(rects, angle, pivot, op, px),
      setGlobalLight: (l) => engine.setGlobalLight(l),
      getGlobalLight: () => engine.getGlobalLight(),
      setRefineEdge: (r) => engine.setRefineEdge(r),
      getRefineEdge: () => engine.getRefineEdge(),
      setColorSpace: (cs) => engine.setColorSpace(cs),
      setProofing: (simulate, warn, target) => engine.setProofing(simulate, warn, target),
      captureLeaves: (ids) => engine.captureLeaves(ids),
      restoreLeaves: (snaps) => engine.restoreLeaves(snaps),
      pushStructural: (label, undo, redo) => engine.pushStructural(label, undo, redo),
      hasMask: (id) => engine.hasMask(id),
      allocMask: (id, init, rects, angle, pivot) => engine.allocMask(id, init, rects, angle, pivot),
      freeMask: (id) => engine.freeMask(id),
      captureMask: (id) => engine.captureMask(id),
      restoreMask: (id, img) => engine.restoreMask(id, img),
      applyMaskToLayer: (id) => engine.applyMaskToLayer(id),
      offsetMask: (id, dx, dy) => engine.offsetMask(id, dx, dy),
      maskSelectionRects: (id) => engine.maskSelectionRects(id),
      maskPreviewURL: (id, maxW) => engine.maskPreviewURL(id, maxW),
      layerContentBounds: (id) => engine.layerContentBounds(id),
      offsetLayerPixels: (id, dx, dy, alsoMask) => engine.offsetLayerPixels(id, dx, dy, alsoMask),
      quickMaskActive: () => engine.quickMaskActive(),
      // Both entry points restart the overlay loop: it is what paints the red,
      // and it parks itself whenever nothing on screen needs animating.
      enterQuickMask: (key, rects, angle, pivot) => {
        engine.enterQuickMask(key, rects, angle, pivot);
        ensureAntsRef.current?.();
      },
      setQuickMask: (key) => {
        engine.setQuickMask(key);
        ensureAntsRef.current?.();
      },
      quickMaskRects: () => engine.quickMaskRects(),
      setActiveSurface: (id, surface) => engine.setActiveSurface(id, surface),
      getActiveSurface: (id) => engine.getActiveSurface(id),
      applySmartFilters: (layerId, filters, side, useFilterMask) =>
        engine.applySmartFilters(layerId, filters, side, useFilterMask),
      contentAwareFill: (layerId, sel, selAngle, selPivot) =>
        engine.contentAwareFill(layerId, sel, selAngle, selPivot),
      redEye: (layerId, x, y, size, darken, sel, selAngle, selPivot) =>
        engine.redEye(layerId, x, y, size, darken, sel, selAngle, selPivot),
      resizeCanvasAnchored: (w, h, dx, dy, ids) => engine.resizeCanvasAnchored(w, h, dx, dy, ids),
      setRenderCacheEnabled: (on) => engine.setRenderCacheEnabled(on),
      renderCacheStats: () => engine.renderCacheStats(),
      setRenderCacheBudget: (mb) => engine.setRenderCacheBudget(mb),
      setHistoryLimit: (n) => engine.setHistoryLimit(n),
      setHistoryBudgetMB: (mb) => engine.setHistoryBudgetMB(mb),
      setNonLinearHistory: (on) => engine.setNonLinearHistory(on),
      setWorkersEnabled: (on) => engine.setWorkersEnabled(on),
    };
    engine.syncHistory();
    scheduleComposite();
    return () => {
      paintRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorSpace]);

  // Resize the engine buffers when the document size changes; recomposite.
  useEffect(() => {
    engine.setDoc(width, height, collectLeafIds(layers));
    scheduleComposite();
  }, [width, height, layers, engine, scheduleComposite]);

  // Apply a queued paste once its target document is active and sized.
  useEffect(() => {
    if (!pendingPaste || pendingPaste.docId !== activeId) return;
    engine.setDoc(width, height, collectLeafIds(layers));
    if (pendingPaste.float) {
      engine.beginFloat(
        pendingPaste.layerId,
        pendingPaste.source,
        pendingPaste.x,
        pendingPaste.y,
        pendingPaste.side,
      );
    } else {
      engine.drawImageToLayer(
        pendingPaste.layerId,
        pendingPaste.source,
        pendingPaste.x,
        pendingPaste.y,
        pendingPaste.side,
      );
    }
    onPasteDone();
  }, [pendingPaste, activeId, width, height, layers, engine, onPasteDone]);

  // Draw queued layer pixels (loaded project / imported images) into the active
  // doc once it's sized. Entries for other docs wait until they're activated.
  useEffect(() => {
    const entry = pendingLoads.find((p) => p.docId === activeId);
    if (!entry) return;
    engine.setDoc(width, height, collectLeafIds(layers));
    let cancelled = false;
    (async () => {
      await Promise.all([
        ...entry.images.map(async ({ id, data, source }) => {
          if (source) {
            if (!cancelled) engine.setLayerImage(id, source);
            return;
          }
          if (!data) return;
          const img = new Image();
          img.src = data;
          try {
            await img.decode();
          } catch {
            return;
          }
          if (!cancelled) engine.setLayerImage(id, img);
        }),
        ...(entry.masks ?? []).map(async ({ id, data, source }) => {
          if (source) {
            if (!cancelled) engine.setMaskImage(id, source);
            return;
          }
          if (!data) return;
          const img = new Image();
          img.src = data;
          try {
            await img.decode();
          } catch {
            return;
          }
          if (!cancelled) engine.setMaskImage(id, img);
        }),
        // Saved selections: the same grayscale restore, but the file stores a
        // CHANNEL id and the engine keys them per document.
        ...(entry.channels ?? []).map(async ({ id, data, source }) => {
          const key = selectionChannelKey(entry.docId, id);
          if (source) {
            if (!cancelled) engine.setMaskImage(key, source);
            return;
          }
          if (!data) return;
          const img = new Image();
          img.src = data;
          try {
            await img.decode();
          } catch {
            return;
          }
          if (!cancelled) engine.setMaskImage(key, img);
        }),
      ]);
      if (!cancelled) {
        onLoadDone(entry.docId);
        scheduleComposite();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingLoads, activeId, width, height, layers, engine, onLoadDone, scheduleComposite]);

  // Recomposite when layer metadata / active document changes.
  useEffect(() => {
    scheduleComposite();
  }, [layers, activeLayerId, scheduleComposite]);

  // Grid + guide overlay, drawn in screen space and kept in sync with pan/zoom:
  // the DOCUMENT grid (configurable spacing/subdivisions/colour, any zoom)
  // beneath the PIXEL grid (1px cells, only readable when zoomed right in),
  // with the guides and any live snap hints on top.
  //
  // This is a callback rather than a bare effect body because guide drags and
  // snap hints have to repaint it directly, at pointer rate, without a React
  // render in the loop (pan/zoom come from refs for exactly that reason).
  const drawGuidesOverlay = useCallback(() => {
    const ov = gridRef.current;
    const vp = viewportRef.current;
    const ctx = ov?.getContext("2d");
    if (!ov || !vp || !ctx) return;
    if (ov.width !== vp.clientWidth || ov.height !== vp.clientHeight) {
      ov.width = vp.clientWidth;
      ov.height = vp.clientHeight;
    }
    ctx.clearRect(0, 0, ov.width, ov.height);
    const pan = panR.current;
    const zoom = zoomRef.current;
    const s = zoom / 100;
    const x0 = Math.max(0, Math.floor(-pan.x / s));
    const x1 = Math.min(width, Math.ceil((ov.width - pan.x) / s));
    const y0 = Math.max(0, Math.floor(-pan.y / s));
    const y1 = Math.min(height, Math.ceil((ov.height - pan.y) / s));
    if (x1 < x0 || y1 < y0) return;
    const top = Math.round(pan.y + y0 * s);
    const bottom = Math.round(pan.y + y1 * s);
    const left = Math.round(pan.x + x0 * s);
    const right = Math.round(pan.x + x1 * s);
    const hexRgb = (hex: string): string => {
      const m = /^#?([0-9a-f]{6})/i.exec(hex);
      const n = m ? parseInt(m[1], 16) : 0x808080;
      return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    };
    ctx.lineWidth = 1;

    if (docGrid && docGrid.spacing >= 1) {
      const rgb = hexRgb(docGrid.color);
      // Lines vanish when denser than ~4 screen px — a solid wash helps nobody.
      const lines = (step: number, alpha: number) => {
        if (step * s < 4) return;
        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
        ctx.beginPath();
        for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
          const sx = Math.round(pan.x + gx * s) + 0.5;
          ctx.moveTo(sx, top);
          ctx.lineTo(sx, bottom);
        }
        for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
          const sy = Math.round(pan.y + gy * s) + 0.5;
          ctx.moveTo(left, sy);
          ctx.lineTo(right, sy);
        }
        ctx.stroke();
      };
      const sub = Math.max(1, Math.round(docGrid.subdivisions));
      if (sub > 1) lines(docGrid.spacing / sub, 0.22);
      lines(docGrid.spacing, 0.55);
    }

    if (showGrid && s >= 4) {
      // Pixel grid only reads as a grid when zoomed in.
      ctx.strokeStyle = `rgba(${hexRgb(pixelGridColor)}, 0.55)`;
      ctx.beginPath();
      for (let dx = x0; dx <= x1; dx++) {
        const sx = Math.round(pan.x + dx * s) + 0.5;
        ctx.moveTo(sx, top);
        ctx.lineTo(sx, bottom);
      }
      for (let dy = y0; dy <= y1; dy++) {
        const sy = Math.round(pan.y + dy * s) + 0.5;
        ctx.moveTo(left, sy);
        ctx.lineTo(right, sy);
      }
      ctx.stroke();
    }

    // ---- Guides, on top of both grids --------------------------------------
    // Cyan across the full canvas; the one being dragged goes dashed, and a
    // guide dragged far enough off the canvas turns red to say "let go and it's
    // gone" before you commit to it.
    const drag = guideDragRef.current;
    if (guideOptsRef.current.show) {
      const gLeft = Math.round(pan.x);
      const gRight = Math.round(pan.x + width * s);
      const gTop = Math.round(pan.y);
      const gBottom = Math.round(pan.y + height * s);
      guidesRef.current.forEach((g, i) => {
        const dragging = !!drag && drag.index === i;
        ctx.strokeStyle = dragging && drag!.discard ? "#ff5a5a" : "rgba(0, 170, 255, 0.95)";
        ctx.lineWidth = 1;
        ctx.setLineDash(dragging ? [4, 3] : []);
        ctx.beginPath();
        if (g.axis === "v") {
          const sx = Math.round(pan.x + g.pos * s) + 0.5;
          ctx.moveTo(sx, gTop);
          ctx.lineTo(sx, gBottom);
        } else {
          const sy = Math.round(pan.y + g.pos * s) + 0.5;
          ctx.moveTo(gLeft, sy);
          ctx.lineTo(gRight, sy);
        }
        ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    // ---- Snap hints ---------------------------------------------------------
    // Magenta, Photoshop-style: a line where the snap landed. Canvas/guide hits
    // run the full length; a layer hit is bracketed to the two boxes involved
    // (its span, widened to include the moving edge) so it reads as "these two
    // things line up" rather than as another guide.
    const hints = snapHintsRef.current;
    if (hints.v.length || hints.h.length) {
      ctx.strokeStyle = "#ff3ea5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const hit of hints.v) {
        const sx = Math.round(pan.x + hit.pos * s) + 0.5;
        const a = hit.span ? Math.round(pan.y + hit.span[0] * s) : Math.round(pan.y);
        const b = hit.span ? Math.round(pan.y + hit.span[1] * s) : Math.round(pan.y + height * s);
        ctx.moveTo(sx, a);
        ctx.lineTo(sx, b);
      }
      for (const hit of hints.h) {
        const sy = Math.round(pan.y + hit.pos * s) + 0.5;
        const a = hit.span ? Math.round(pan.x + hit.span[0] * s) : Math.round(pan.x);
        const b = hit.span ? Math.round(pan.x + hit.span[1] * s) : Math.round(pan.x + width * s);
        ctx.moveTo(a, sy);
        ctx.lineTo(b, sy);
      }
      ctx.stroke();
    }
  }, [showGrid, docGrid, pixelGridColor, width, height]);
  drawGuidesRef.current = drawGuidesOverlay;

  // ---- Before/after compare -------------------------------------------------
  // Render the pre-adjustment composite into the stacked canvas whenever the
  // comparison is showing and the document changes. `exportComposite` renders
  // an arbitrary tree through the SAME render graph and its caches, so the
  // before image costs about one extra composite, not a second pipeline.
  const compareOn = compareSplit !== null || comparePeek;
  useEffect(() => {
    const cv = compareRef.current;
    if (!compareOn || !cv) return;
    const before = engine.exportComposite(bypassAdjustments(layers));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(before, 0, 0);
  }, [compareOn, layers, width, height, engine, activeId]);

  // Hold the peek key to see the "before" across the whole canvas. Tracked on
  // window with a blur reset, like the bird's-eye modifier — a lost keyup must
  // not leave the canvas stuck showing the wrong image.
  useEffect(() => {
    const isPeekKey = (e: KeyboardEvent) => e.key === "\\" && !e.ctrlKey && !e.metaKey && !e.altKey;
    const typing = () => {
      const t = document.activeElement as HTMLElement | null;
      return (
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          !!t.closest?.('[role="dialog"]'))
      );
    };
    const down = (e: KeyboardEvent) => {
      if (!isPeekKey(e) || e.repeat || typing()) return;
      e.preventDefault();
      setComparePeek(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "\\") setComparePeek(false);
    };
    const blur = () => setComparePeek(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /** Drag the split divider. Window listeners so the pointer can leave the thin
   *  line without the drag stopping. */
  const startCompareDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    compareDragRef.current = true;
    const move = (ev: PointerEvent) => {
      const v = viewRef.current;
      if (!v) return;
      onCompareSplitRef.current(splitFromPointer(ev.clientX, ev.clientY, compareAxisRef.current, v.getBoundingClientRect()));
    };
    const up = () => {
      compareDragRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onCompareSplitRef = useRef(onCompareSplit);
  onCompareSplitRef.current = onCompareSplit;
  const compareAxisRef = useRef(compareAxis);
  compareAxisRef.current = compareAxis;

  // Repaint whenever anything the overlay reads from React changes. Pan/zoom are
  // read through refs inside the draw, so they must be listed here to trigger it.
  useEffect(() => {
    drawGuidesOverlay();
  }, [pan, zoom, vpSize, guides, showGuides, lockGuides, drawGuidesOverlay]);

  // ---- Guide interaction ----------------------------------------------------
  /** Grab radius for a guide, in screen px (guides are 1px — 5 is comfortable). */
  const GUIDE_GRAB_PX = 5;
  /** How far off the canvas a guide must go before dropping it deletes it. */
  const GUIDE_DISCARD_PX = 26;

  const onGuidesCommitRef = useRef(onGuidesCommit);
  onGuidesCommitRef.current = onGuidesCommit;
  const guideCtxRef = useRef({ width, height, snapDistance, snapOn: snap });
  guideCtxRef.current = { width, height, snapDistance, snapOn: snap };

  /** Client px → document coordinates (works anywhere, incl. over the rulers). */
  const clientToDoc = (cx: number, cy: number) => {
    const v = viewRef.current;
    if (!v) return { x: 0, y: 0 };
    const r = v.getBoundingClientRect();
    return { x: ((cx - r.left) * width) / r.width, y: ((cy - r.top) * height) / r.height };
  };

  /** Content bounds of every visible pixel layer except `exceptIds` (doc space).
   *  Smart guides align against what you can actually see, so hidden layers and
   *  the layers travelling with the drag are excluded. */
  const otherLayerBoxes = (exceptIds: Set<string>): Rect[] => {
    const out: Rect[] = [];
    const walk = (nodes: LayerNode[], visible: boolean) => {
      for (const n of nodes) {
        const vis = visible && n.visible;
        if (n.type === "group") walk(n.children, vis);
        else if (n.type === "layer" && vis && !exceptIds.has(n.id)) {
          const b = engine.layerContentBounds(n.id);
          if (b && b.w > 0 && b.h > 0) out.push(b);
        }
      }
    };
    walk(layers, true);
    return out;
  };

  /** Snap candidates for a drag: guides (when shown) + the document's own edges
   *  and centre, plus other layers' edges when smart guides are on. */
  const buildSnapTargets = (exceptIds: Set<string>) => {
    const o = guideOptsRef.current;
    const v: SnapTarget[] = [...canvasTargets(width)];
    const h: SnapTarget[] = [...canvasTargets(height)];
    if (o.show) {
      v.push(...guideTargets(guidesRef.current, "v"));
      h.push(...guideTargets(guidesRef.current, "h"));
    }
    if (o.smart) {
      const boxes = otherLayerBoxes(exceptIds);
      v.push(...layerTargets(boxes, "v"));
      h.push(...layerTargets(boxes, "h"));
    }
    return { v: dedupeTargets(v), h: dedupeTargets(h) };
  };

  /** Snap pull distance converted from screen px to document px. */
  const snapTolDoc = () => guideCtxRef.current.snapDistance / (zoomRef.current / 100);

  /** Index of the guide under a client point, or -1 (hidden/locked ⇒ none). */
  const guideAtClient = (cx: number, cy: number): number => {
    const o = guideOptsRef.current;
    if (!o.show || o.lock) return -1;
    const p = clientToDoc(cx, cy);
    return hitGuide(guidesRef.current, p.x, p.y, GUIDE_GRAB_PX / (zoomRef.current / 100));
  };

  /**
   * Start dragging a guide. `index` is its slot in the committed list, or -1 to
   * pull a brand-new one off a ruler. The drag runs on WINDOW listeners rather
   * than pointer capture because it legitimately crosses element boundaries —
   * out of the ruler onto the canvas, and back onto the ruler to delete.
   */
  const startGuideDrag = (index: number, axis: GuideAxis, cx: number, cy: number) => {
    if (guideOptsRef.current.lock) return;
    const base = guidesRef.current;
    const { width: dw, height: dh } = guideCtxRef.current;
    const size = axis === "v" ? dw : dh;
    const p = clientToDoc(cx, cy);
    const pos = clampGuide(axis === "v" ? p.x : p.y, size);
    const list = index >= 0 ? base.slice() : [...base, { axis, pos }];
    const idx = index >= 0 ? index : list.length - 1;
    list[idx] = { axis, pos };
    guidesRef.current = list;
    guideDragRef.current = { index: idx, axis, base, discard: false, isNew: index < 0 };
    drawGuidesRef.current();

    const move = (ev: PointerEvent) => {
      const d = guideDragRef.current;
      if (!d) return;
      const ctx = guideCtxRef.current;
      const sizeNow = d.axis === "v" ? ctx.width : ctx.height;
      const q = clientToDoc(ev.clientX, ev.clientY);
      let raw = d.axis === "v" ? q.x : q.y;
      // Ctrl suspends snapping mid-drag (Photoshop's escape hatch) — otherwise a
      // guide lands on the document edges/centre and on visible layer edges.
      if (ctx.snapOn && !ev.ctrlKey) {
        const t = buildSnapTargets(new Set<string>());
        const self = guidesRef.current[d.index].pos;
        const axisTargets = (d.axis === "v" ? t.v : t.h).filter(
          // A guide must not snap to ITSELF via the guide candidates.
          (c) => !(c.kind === "guide" && Math.abs(c.pos - self) < 1e-6),
        );
        const r = snapAxis([raw], axisTargets, snapTolDoc());
        if (r) {
          raw += r.delta;
          snapHintsRef.current = d.axis === "v" ? { v: r.hits, h: [] } : { v: [], h: r.hits };
        } else {
          snapHintsRef.current = { v: [], h: [] };
        }
      }
      const next = guidesRef.current.slice();
      next[d.index] = { axis: d.axis, pos: clampGuide(raw, sizeNow) };
      guidesRef.current = next;
      d.discard = shouldDiscard(raw, sizeNow, GUIDE_DISCARD_PX / (zoomRef.current / 100));
      drawGuidesRef.current();
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      const d = guideDragRef.current;
      guideDragRef.current = null;
      snapHintsRef.current = { v: [], h: [] };
      if (!d) return;
      if (!commit) {
        guidesRef.current = d.base;
        drawGuidesRef.current();
        return;
      }
      const next = d.discard
        ? guidesRef.current.filter((_, i) => i !== d.index)
        : guidesRef.current;
      guidesRef.current = next;
      drawGuidesRef.current();
      // A brand-new guide dragged straight back onto the ruler leaves the list
      // untouched, and commitGuides drops no-ops — so no phantom history step.
      const label = d.isNew ? "New Guide" : d.discard ? "Delete Guide" : "Move Guide";
      onGuidesCommitRef.current(label, next);
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  };

  /**
   * Capture what a Move drag can snap to, once, at the moment it starts: the box
   * being moved and the candidate lines. Doing it per-frame would re-measure
   * every layer's content bounds 60× a second — and worse, the moving layer's
   * own bounds would change under it mid-drag.
   */
  const beginMoveSnap = () => {
    moveSnapRef.current = null;
    snapHintsRef.current = { v: [], h: [] };
    if (!guideCtxRef.current.snapOn) return;
    const m = moveRef.current;
    if (!m) return;
    const except = new Set<string>();
    let box: Rect | null = null;
    if (m.mode === "selection") {
      box = selectionRef.current.length ? bboxOf(selectionRef.current) : null;
    } else if (m.float) {
      // Floating pixels: the lifted selection, offset to where the float sits now.
      const off = m.baseOff ?? { x: 0, y: 0 };
      if (selectionRef.current.length) {
        const b = bboxOf(selectionRef.current);
        box = { x: b.x + off.x, y: b.y + off.y, w: b.w, h: b.h };
      }
      if (activeLayerId) except.add(activeLayerId);
    } else if (activeLayerId) {
      box = engine.layerContentBounds(activeLayerId);
      except.add(activeLayerId);
      for (const x of linkedMoveExtras(activeLayerId)) except.add(x.id);
    }
    // An empty layer has no bounds and nothing meaningful to align — skip.
    if (!box || box.w <= 0 || box.h <= 0) return;
    const t = buildSnapTargets(except);
    moveSnapRef.current = { box, v: t.v, h: t.h };
  };

  /** Apply guide/smart snapping to a Move delta, recording the hint lines.
   *  Ctrl suspends it mid-drag without having to toggle View ▸ Snap. */
  const applyMoveSnap = (dx: number, dy: number, suspend: boolean): { dx: number; dy: number } => {
    const ms = moveSnapRef.current;
    if (!ms || suspend) {
      if (snapHintsRef.current.v.length || snapHintsRef.current.h.length) {
        snapHintsRef.current = { v: [], h: [] };
        drawGuidesRef.current();
      }
      return { dx, dy };
    }
    const r = snapMove(ms.box, dx, dy, ms.v, ms.h, snapTolDoc());
    // Widen each layer hint's span to reach the moving box, so the line visibly
    // connects the two things it claims are aligned.
    const moved: Rect = { x: ms.box.x + r.dx, y: ms.box.y + r.dy, w: ms.box.w, h: ms.box.h };
    const stretch = (hits: SnapHit[], lo: number, hi: number): SnapHit[] =>
      hits.map((s) =>
        s.span ? { ...s, span: [Math.min(s.span[0], lo), Math.max(s.span[1], hi)] } : s,
      );
    const next = {
      v: stretch(r.hitsV, moved.y, moved.y + moved.h),
      h: stretch(r.hitsH, moved.x, moved.x + moved.w),
    };
    // Repaint while hints are showing (their spans grow as the box travels) and
    // once more on the frame they disappear.
    const had = snapHintsRef.current.v.length || snapHintsRef.current.h.length;
    snapHintsRef.current = next;
    if (had || next.v.length || next.h.length) drawGuidesRef.current();
    return { dx: r.dx, dy: r.dy };
  };

  /** Start a point-drag snap session (marquee corner): capture the candidates
   *  once, and snap the anchor point itself. Returns the snapped anchor. */
  const beginRectSnap = (x: number, y: number, suspend: boolean): { x: number; y: number } => {
    rectSnapRef.current = null;
    snapHintsRef.current = { v: [], h: [] };
    if (!guideCtxRef.current.snapOn) return { x, y };
    const t = buildSnapTargets(new Set<string>());
    rectSnapRef.current = t;
    if (suspend) return { x, y };
    const r = snapPointTo(x, y, t.v, t.h, snapTolDoc());
    return { x: r.x, y: r.y };
  };

  /** Snap a dragged point against the session's candidates + show the hints. */
  const applyRectSnap = (x: number, y: number, suspend: boolean): { x: number; y: number } => {
    const t = rectSnapRef.current;
    if (!t || suspend) {
      if (snapHintsRef.current.v.length || snapHintsRef.current.h.length) {
        snapHintsRef.current = { v: [], h: [] };
        drawGuidesRef.current();
      }
      return { x, y };
    }
    const r = snapPointTo(x, y, t.v, t.h, snapTolDoc());
    const had = snapHintsRef.current.v.length || snapHintsRef.current.h.length;
    snapHintsRef.current = { v: r.hitsV, h: r.hitsH };
    if (had || r.hitsV.length || r.hitsH.length) drawGuidesRef.current();
    return { x: r.x, y: r.y };
  };

  /** Clear any snap hints left over from a finished drag. */
  const endMoveSnap = () => {
    rectSnapRef.current = null;
    moveSnapRef.current = null;
    if (snapHintsRef.current.v.length || snapHintsRef.current.h.length) {
      snapHintsRef.current = { v: [], h: [] };
      drawGuidesRef.current();
    }
  };

  /** Ruler press → drag out a guide. Alt swaps the orientation, as in Photoshop
   *  (drag from the top ruler with Alt held to place a vertical guide). */
  const onRulerPointerDown = (from: GuideAxis) => (e: React.PointerEvent) => {
    if (e.button !== 0 || guideOptsRef.current.lock) return;
    e.preventDefault();
    const axis: GuideAxis = e.altKey ? (from === "v" ? "h" : "v") : from;
    // Pulling a guide off the ruler means you want to see it.
    if (!guideOptsRef.current.show) onRevealGuides();
    startGuideDrag(-1, axis, e.clientX, e.clientY);
  };

  const toDoc = (e: React.PointerEvent) => {
    const v = viewRef.current!;
    const r = v.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * width) / r.width,
      y: ((e.clientY - r.top) * height) / r.height,
    };
  };
  /** Anchor targeting: report the pointer as a doc-normalized (clamped) anchor. */
  const reportFilterAnchor = (e: React.PointerEvent) => {
    const p = toDoc(e);
    onFilterAnchorDrag(
      Math.max(0, Math.min(1, p.x / width)),
      Math.max(0, Math.min(1, p.y / height)),
    );
  };
  const pick = (e: React.PointerEvent) => {
    const p = toDoc(e);
    hoverRef.current = { x: p.x, y: p.y };
    const hex = engine.sampleColor(
      Math.floor(p.x),
      Math.floor(p.y),
      sampleSize,
      sampleAllLayers,
      activeLayerId,
    );
    if (hex) onPick(hex);
  };

  // ---- Crop tool geometry --------------------------------------------------
  // Classify a doc-space point against the current (possibly straightened) crop
  // box: a corner (nw/ne/se/sw), an edge (n/e/s/w), "move" (inside), or "outside".
  const cropHandleAt = (pt: { x: number; y: number }): string | null => {
    const cb = cropBoxRef.current;
    if (!cb) return null;
    const a = (-cropStraightenRef.current * Math.PI) / 180;
    const cx = cb.x + cb.w / 2;
    const cy = cb.y + cb.h / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const lx = dx * cos - dy * sin; // into the box's leveled frame
    const ly = dx * sin + dy * cos;
    const hw = cb.w / 2;
    const hh = cb.h / 2;
    const tol = 9 / (zoomRef.current / 100); // handle grab radius in doc px
    if (lx < -hw - tol || lx > hw + tol || ly < -hh - tol || ly > hh + tol) return "outside";
    const nL = Math.abs(lx + hw) <= tol;
    const nR = Math.abs(lx - hw) <= tol;
    const nT = Math.abs(ly + hh) <= tol;
    const nB = Math.abs(ly - hh) <= tol;
    if (nT && nL) return "nw";
    if (nT && nR) return "ne";
    if (nB && nL) return "sw";
    if (nB && nR) return "se";
    if (nT) return "n";
    if (nB) return "s";
    if (nL) return "w";
    if (nR) return "e";
    return "move";
  };

  const CROP_CURSOR: Record<string, string> = {
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    move: "move",
    outside: "crosshair",
  };

  // Resolve a crop drag (move / resize a handle / rubber-band a new box) to the
  // next box, honouring the locked aspect ratio and clamping to the canvas when
  // the crop isn't straightened.
  const computeCropDrag = (
    drag: { handle: string; px: number; py: number; box: Rect },
    pt: { x: number; y: number },
  ): Rect => {
    const aspect = cropAspectRef.current;
    const ang = cropStraightenRef.current;
    const rad = (ang * Math.PI) / 180;
    const clampToCanvas = ang === 0;
    const minSize = 8;
    const round = (r: Rect): Rect => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.max(1, Math.round(r.w)),
      h: Math.max(1, Math.round(r.h)),
    });

    if (drag.handle === "move") {
      let nx = drag.box.x + (pt.x - drag.px);
      let ny = drag.box.y + (pt.y - drag.py);
      if (clampToCanvas) {
        nx = Math.max(0, Math.min(width - drag.box.w, nx));
        ny = Math.max(0, Math.min(height - drag.box.h, ny));
      }
      return round({ ...drag.box, x: nx, y: ny });
    }

    if (drag.handle === "new") {
      let x = Math.min(drag.px, pt.x);
      let y = Math.min(drag.py, pt.y);
      let w = Math.abs(pt.x - drag.px);
      let h = Math.abs(pt.y - drag.py);
      if (aspect) {
        if (w / Math.max(1, h) > aspect) w = h * aspect;
        else h = w / aspect;
        x = pt.x < drag.px ? drag.px - w : drag.px;
        y = pt.y < drag.py ? drag.py - h : drag.py;
      }
      if (clampToCanvas) {
        x = Math.max(0, Math.min(width - 1, x));
        y = Math.max(0, Math.min(height - 1, y));
        w = Math.min(w, width - x);
        h = Math.min(h, height - y);
      }
      return round({ x, y, w: Math.max(minSize, w), h: Math.max(minSize, h) });
    }

    // Edge / corner resize, computed in the box's leveled frame.
    const b = drag.box;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const toLocal = (q: { x: number; y: number }) => {
      const ddx = q.x - cx;
      const ddy = q.y - cy;
      return { x: ddx * cos + ddy * sin, y: -ddx * sin + ddy * cos };
    };
    const toDocPt = (l: { x: number; y: number }) => ({
      x: cx + l.x * cos - l.y * sin,
      y: cy + l.x * sin + l.y * cos,
    });
    const PL = toLocal(pt);
    let left = -b.w / 2;
    let right = b.w / 2;
    let top = -b.h / 2;
    let bottom = b.h / 2;
    const mL = drag.handle.includes("w");
    const mR = drag.handle.includes("e");
    const mT = drag.handle.includes("n");
    const mB = drag.handle.includes("s");
    if (mL) left = Math.min(PL.x, right - minSize);
    if (mR) right = Math.max(PL.x, left + minSize);
    if (mT) top = Math.min(PL.y, bottom - minSize);
    if (mB) bottom = Math.max(PL.y, top + minSize);

    if (aspect) {
      const corner = (mL || mR) && (mT || mB);
      let w = right - left;
      let h = bottom - top;
      if (corner) {
        h = w / aspect;
        if (mT) top = bottom - h;
        else bottom = top + h;
      } else if (mL || mR) {
        h = w / aspect;
        const midY = (top + bottom) / 2;
        top = midY - h / 2;
        bottom = midY + h / 2;
      } else {
        w = h * aspect;
        const midX = (left + right) / 2;
        left = midX - w / 2;
        right = midX + w / 2;
      }
    }

    const w = right - left;
    const h = bottom - top;
    const center = toDocPt({ x: (left + right) / 2, y: (top + bottom) / 2 });
    let nx = center.x - w / 2;
    let ny = center.y - h / 2;
    if (clampToCanvas) {
      nx = Math.max(0, Math.min(width - w, nx));
      ny = Math.max(0, Math.min(height - h, ny));
    }
    return round({ x: nx, y: ny, w, h });
  };

  // Start a selection transform (rotate-anchor / resize / rotate-ring) if the
  // press landed on a handle / ring / anchor. Shared by the Marquee and Wand
  // tools so wand selections can be transformed without switching tools.
  const tryStartTransform = (
    e: React.PointerEvent,
    p: { x: number; y: number },
    sc: number,
  ): boolean => {
    if (selection.length < 1) return false;
    // Lift the selected pixels into a float for a content transform — unless the
    // layer's position is locked, in which case only the marquee reshapes.
    const liftContent = (): boolean => {
      if (!((tool === "shape" || resizeMode === "content") && activeLayerId)) return false;
      if (moveBlocked(activeLayerId)) return false; // position-locked or fill layer
      return engine.beginFloatFromSelection(
        activeLayerId,
        selection,
        selectionAngle,
        selectionPivot,
        selectionFeather,
      );
    };
    const bbox = bboxOf(selection);
    const pivot = selectionPivot ?? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
    const zone = selectZone(p.x, p.y, selection, selectionAngle, pivot, sc);
    if (zone.kind === "anchor") {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      anchorRef.current = true;
      setHoverCursor("grabbing");
      ensureAnts();
      return true;
    }
    if (zone.kind === "resize") {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const content = liftContent();
      resizeRef.current = {
        rects: selection,
        bbox,
        edges: zone.edges,
        content,
        angle: selectionAngle,
        pivot,
        before: snapshotSel(),
      };
      // Lock a rotated selection's pivot so it can't drift to the new centre.
      if (selectionAngle !== 0 && !selectionPivot) onSelectionPivot(pivot);
      resizePreviewRef.current = selection;
      ensureAnts();
      return true;
    }
    if (zone.kind === "ring") {
      const content = liftContent();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      rotateRef.current = {
        cx: pivot.x,
        cy: pivot.y,
        start: Math.atan2(p.y - pivot.y, p.x - pivot.x),
        base: selectionAngle,
        bbox,
        content,
        before: snapshotSel(),
      };
      rotatePreviewRef.current = selectionAngle;
      setHoverCursor(rotateCursorToward(p.x, p.y, pivot));
      ensureAnts();
      return true;
    }
    return false;
  };

  // Modifier → selection combine mode: Ctrl/Cmd adds, Alt subtracts, else new.
  const selectOp = (e: React.PointerEvent): SelOp =>
    e.ctrlKey || e.metaKey ? "add" : e.altKey ? "subtract" : "new";

  // Apply a combined selection result (caches its ants; clears when empty).
  const applyCombined = (result: WandSelection | null) => {
    if (!result) return;
    if (result.rects.length) {
      wandSegsRef.current = { key: result.rects, segs: result.segments };
      onSelectionChange(result.rects);
    } else {
      wandSegsRef.current = null;
      onSelectionChange([]); // subtracted everything → deselect
    }
  };

  // Zoom tool: step in (dir 1) / out (dir -1), pivoting on the clicked point.
  // ---- Two-finger pinch (touch/pen): zoom + pan the canvas together ---------
  // Gated to ≥2 non-mouse pointers, so mouse drawing on desktop is untouched.
  const beginPinch = () => {
    const vp = viewportRef.current;
    const pts = [...pointersRef.current.values()];
    if (!vp || pts.length < 2) return;
    // A second finger overrides whatever the first one started — discard any
    // live paint stroke (no commit) and drop the other tools' in-progress state
    // so no stray marquee/shape/gradient gets committed on lift.
    if (paintingRef.current) {
      engine.cancelStroke();
      paintingRef.current = false;
    }
    handRef.current = null;
    marqueeRef.current = null;
    dragRectRef.current = null;
    lassoRef.current = null;
    shapeRef.current = null;
    shapeRectRef.current = null;
    gradientRef.current = null;
    gestureSuppressRef.current = true;
    scheduleComposite();
    ensureAnts();

    const [p1, p2] = pts;
    const r = vp.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2 - r.left;
    const midY = (p1.y + p2.y) / 2 - r.top;
    const s0 = zoomRef.current / 100;
    pinchRef.current = {
      startDist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
      startZoom: zoomRef.current,
      docMx: (midX - panR.current.x) / s0,
      docMy: (midY - panR.current.y) / s0,
    };
    // Capture both pointers on the viewport so their moves keep reporting even
    // if a finger strays off the (possibly tiny, at fit-view) artwork.
    for (const id of pointersRef.current.keys()) {
      try {
        viewportRef.current?.setPointerCapture(id);
      } catch {
        /* a pointer already released — ignore */
      }
    }
  };

  // Viewport-level (capture-phase) gesture tracking. Capture runs BEFORE the
  // canvas tool handlers, and the viewport wraps both the artwork and the
  // padding around it — so a second finger anywhere in the canvas area starts a
  // pinch and pre-empts the tool, wherever the fingers land.
  const gestureDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    viewTouchedRef.current = true; // any canvas touch ends the auto-fit-on-resize
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2 && !pinchRef.current) beginPinch();
  };
  const gestureMove = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || !pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchRef.current) updatePinch();
  };
  const gestureUp = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || !pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.delete(e.pointerId);
    const vp = viewportRef.current;
    if (vp && vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    // Clear the tool-suppress flag only AFTER this event's tool handlers have
    // run (they check it and bail), so the aborted stroke never commits.
    if (pointersRef.current.size === 0 && gestureSuppressRef.current) {
      queueMicrotask(() => {
        if (pointersRef.current.size === 0) gestureSuppressRef.current = false;
      });
    }
  };

  const updatePinch = () => {
    const pin = pinchRef.current;
    const vp = viewportRef.current;
    const pts = [...pointersRef.current.values()];
    if (!pin || !vp || pts.length < 2) return;
    const [p1, p2] = pts;
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const nextZoom = clamp(Math.round(pin.startZoom * (dist / pin.startDist)), MIN_ZOOM, MAX_ZOOM);
    const s1 = nextZoom / 100;
    const r = vp.getBoundingClientRect();
    // Keep the doc point that was under the starting midpoint under the CURRENT
    // midpoint — moving both fingers pans, spreading them zooms about that point.
    const m1x = (p1.x + p2.x) / 2 - r.left;
    const m1y = (p1.y + p2.y) / 2 - r.top;
    const panX = m1x - pin.docMx * s1;
    const panY = m1y - pin.docMy * s1;
    const clamped = clampHere(panX, panY, s1, vp);
    if (nextZoom !== zoomRef.current) {
      // Route the pan through the zoom effect's queue so it isn't overwritten
      // by the focal-point recentre.
      pendingPanRef.current = { pan: clamped, zoom: nextZoom };
      onZoomChangeRef.current(nextZoom);
    } else {
      setPanRef.current(clamped);
    }
  };

  const zoomToPoint = (dir: 1 | -1, clientX: number, clientY: number) => {
    const z = zoomRef.current;
    const opts = ZOOM_STEPS.filter((v) => (dir === 1 ? v > z : v < z));
    if (!opts.length) return;
    const vp = viewportRef.current;
    if (vp) {
      const r = vp.getBoundingClientRect();
      focalRef.current = { ax: clientX - r.left, ay: clientY - r.top };
    }
    onZoomChangeRef.current(dir === 1 ? opts[0] : opts[opts.length - 1]);
  };

  // Recompute the paint-bucket preview region from the current seed (reads refs
  // so it stays correct when called from the throttle timer). `reuse` reuses the
  // cached layer pixels (true after the first compute of a drag).
  const recomputeBucket = (reuse: boolean) => {
    const seed = bucketSeedRef.current;
    if (!seed) return;
    const o = bucketOptsRef.current;
    const region = engine.magicWand(
      seed.layerId ?? "",
      seed.x,
      seed.y,
      { tolerance: o.tolerance, contiguous: !seed.shift && o.contiguous, sampleAll: false },
      reuse,
      null,
    );
    // No source (empty / no layer) → the whole canvas is the fill region.
    const rects = region?.rects ?? [{ x: 0, y: 0, w: widthRef.current, h: heightRef.current }];
    const c = parseColor(seed.slot === "secondary" ? bgRef.current : fgRef.current);
    bucketRef.current = {
      rects,
      color: toHex8({ r: c.r, g: c.g, b: c.b, a: c.a * (o.opacity / 100) }),
    };
    ensureAnts();
  };

  // Re-run the live (committed-but-editable) bucket fill from its seed with the
  // current options — the magic-wand reuses the cached ORIGINAL pixels, so the
  // region is right even though the layer already shows the fill.
  const renderLiveBucket = () => {
    const lb = liveBucketRef.current;
    if (!lb) return;
    const o = bucketOptsRef.current;
    const region = engine.magicWand(
      lb.sampleLayerId ?? "",
      lb.seedX,
      lb.seedY,
      { tolerance: o.tolerance, contiguous: !lb.shift && o.contiguous, sampleAll: false },
      true, // reuse the cached original source
      null,
    );
    const rects = region?.rects ?? [{ x: 0, y: 0, w: widthRef.current, h: heightRef.current }];
    const c = parseColor(lb.slot === "secondary" ? bgRef.current : fgRef.current);
    engine.liveFill(
      lb.fillLayerId,
      rects,
      toHex8({ r: c.r, g: c.g, b: c.b, a: c.a * (o.opacity / 100) }),
      o.antialias,
    );
  };

  const scheduleLiveBucket = () => {
    if (liveBucketRaf.current) return;
    liveBucketRaf.current = requestAnimationFrame(() => {
      liveBucketRaf.current = 0;
      renderLiveBucket();
    });
  };

  // Commit (bake) the live bucket fill and drop the editing marker.
  const finishLiveBucket = () => {
    if (liveBucketRaf.current) {
      cancelAnimationFrame(liveBucketRaf.current);
      liveBucketRaf.current = 0;
    }
    engine.endFill();
    liveBucketRef.current = null;
    ensureAnts();
  };

  // The node-adjustable geometry for the current shape kind (trapezoid insets /
  // triangle apex), or undefined for kinds without nodes.
  const shapeGeom = (kind: ShapeKind): ShapeGeom | undefined => {
    if (kind === "trapezoid") return { trap: trapRef.current };
    if (kind === "tri") return { apex: triApexRef.current };
    if (kind === "custom") {
      // Resolve the preset to its PATH here, so everything downstream — the
      // preview, the rasterizer, the saved vector recipe — carries the geometry
      // rather than an id that could later point at a deleted preset.
      const id = shapeOptsRef.current.customId;
      const all = [...builtinShapes(), ...loadSavedShapes()];
      const p = all.find((x) => x.id === id) ?? all[0];
      return p ? { customD: p.d } : undefined;
    }
    return undefined;
  };

  // Re-render the live shape from its box + current settings (+ node geometry).
  const reRenderLiveShape = () => {
    const live = liveShapeRef.current;
    if (!live) return;
    const o = shapeOptsRef.current;
    engine.liveShape(
      live.layerId,
      live.box,
      selAngleRef.current,
      o.kind,
      o.fill,
      o.stroke,
      o.strokeWidth,
      o.radius,
      shapeGeom(o.kind),
    );
  };

  // Which shape node (if any) a doc-space point is over: the trapezoid's two side
  // nodes or the triangle's apex. Works in the shape's local (un-rotated) frame.
  const shapeNodeAt = (pt: { x: number; y: number }): "l" | "r" | "apex" | null => {
    const live = liveShapeRef.current;
    if (!live) return null;
    const kind = shapeOptsRef.current.kind;
    if (kind !== "trapezoid" && kind !== "tri") return null;
    const box = live.box;
    const ang = selAngleRef.current;
    const piv = selPivotRef.current ?? { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    let lx = pt.x;
    let ly = pt.y;
    if (ang) {
      const c = Math.cos(-ang);
      const sn = Math.sin(-ang);
      lx = piv.x + (pt.x - piv.x) * c - (pt.y - piv.y) * sn;
      ly = piv.y + (pt.x - piv.x) * sn + (pt.y - piv.y) * c;
    }
    const hit = 9 / (zoomRef.current / 100);
    if (kind === "tri") {
      return Math.hypot(lx - (box.x + triApexRef.current * box.w), ly - box.y) <= hit
        ? "apex"
        : null;
    }
    const t = trapRef.current;
    if (Math.hypot(lx - (box.x + t.l * box.w), ly - box.y) <= hit) return "l";
    if (Math.hypot(lx - (box.x + box.w - t.r * box.w), ly - box.y) <= hit) return "r";
    return null;
  };

  // Re-stroke the live pen path from its anchors + current options.
  const renderPenLive = () => {
    const path = penPathRef.current;
    if (!path || path.anchors.length < 2) return;
    engine.livePath(path.layerId, path.anchors, path.closed, penOptsRef.current, colorRef.current);
  };

  // Commit (bake) the live pen path and drop the editing state. Also clears a
  // single-anchor path, which never started an engine session to commit.
  const finishPenPath = () => {
    // Hand the committed geometry up BEFORE clearing. An edit of a STORED path
    // goes back to that path; anything else becomes the Work Path.
    const p = penPathRef.current;
    if (p && p.anchors.length >= 2) {
      if (dsSourceRef.current) onPathEdited?.(dsSourceRef.current, p.anchors, p.closed);
      else onPenPathCommit(p.anchors, p.closed);
    }
    dsSourceRef.current = null;
    dsSelRef.current = new Set();
    dsDragRef.current = null;
    dsMarqueeRef.current = null;
    engine.endPath();
    penPathRef.current = null;
    penDragRef.current = null;
    penGrabRef.current = null;
    ensureAnts();
  };

  // Hit-test the active path's anchors / handles (handles take priority).
  const penHitAt = (p: { x: number; y: number }): { kind: "anchor" | "in" | "out"; index: number } | null => {
    const path = penPathRef.current;
    if (!path) return null;
    const s = zoomRef.current / 100;
    const r = 8 / s;
    const near = (ax: number, ay: number) => Math.hypot(p.x - ax, p.y - ay) <= r;
    const a = path.anchors;
    const n = a.length;
    // Handles take priority; they're hit at their displayed (stub) positions so
    // even retracted handles can be grabbed.
    for (let i = 0; i < n; i++) {
      if (penHasOut(i, n, path.closed)) {
        const out = penHandlePos(a, i, path.closed, true, s);
        if (near(out.x, out.y)) return { kind: "out", index: i };
      }
      if (penHasIn(i, n, path.closed)) {
        const inn = penHandlePos(a, i, path.closed, false, s);
        if (near(inn.x, inn.y)) return { kind: "in", index: i };
      }
    }
    for (let i = 0; i < n; i++) if (near(a[i].x, a[i].y)) return { kind: "anchor", index: i };
    return null;
  };

  // Re-render the live gradient from its current geometry + settings.
  const renderGradient = () => {
    const g = gradientRef.current;
    if (!g) return;
    const o = gradOptsRef.current;
    engine.liveGradient(
      g.layerId,
      o.type,
      g.start,
      g.end,
      g.mid,
      resolveStops(o.stops, o.fg, o.bg, o.reverse),
      g.sel.length ? g.sel : null,
      g.selAngle,
      g.selPivot,
      o.smooth,
    );
  };

  // Which gradient handle (if any) a doc-space point is over.
  const gradientHandleAt = (p: { x: number; y: number }): "start" | "end" | "mid" | null => {
    const g = gradientRef.current;
    if (!g) return null;
    const hit = 10 / (zoomRef.current / 100); // ~10 screen px in doc units
    const mid = {
      x: g.start.x + (g.end.x - g.start.x) * g.mid,
      y: g.start.y + (g.end.y - g.start.y) * g.mid,
    };
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y) <= hit;
    if (near(p, g.end)) return "end";
    if (near(p, g.start)) return "start";
    if (near(p, mid)) return "mid";
    return null;
  };

  // Which measure-line endpoint (if any) a doc-space point is over.
  const measureHandleAt = (p: { x: number; y: number }): "start" | "end" | null => {
    const m = measureRef.current;
    if (!m) return null;
    const hit = 10 / (zoomRef.current / 100);
    if (Math.hypot(p.x - m.x2, p.y - m.y2) <= hit) return "end";
    if (Math.hypot(p.x - m.x1, p.y - m.y1) <= hit) return "start";
    return null;
  };

  // ---- Arrow-key nudge -------------------------------------------------------
  // Arrows move the selection OUTLINE (selection tools) or the selected pixels /
  // whole layer / float (Move tool) by 1px — 10px with Ctrl. Pixel nudges keep
  // one engine move-session open across rapid presses and commit 350ms after the
  // last one, so holding a key is smooth and a burst lands as ONE undo step.
  const activeLayerIdRef = useRef(activeLayerId);
  activeLayerIdRef.current = activeLayerId;
  const moveModeRef = useRef(moveMode);
  moveModeRef.current = moveMode;
  const selHandlersRef = useRef({ onSelectionChange, onSelectionRects, onSelectionPivot });
  selHandlersRef.current = { onSelectionChange, onSelectionRects, onSelectionPivot };
  const nudgeRef = useRef<{
    active: boolean;
    float: boolean;
    baseOff: { x: number; y: number } | null;
    dx: number;
    dy: number;
    timer: number;
  }>({ active: false, float: false, baseOff: null, dx: 0, dy: 0, timer: 0 });

  const commitNudge = useCallback(() => {
    const n = nudgeRef.current;
    if (!n.active) return;
    window.clearTimeout(n.timer);
    const d = { x: n.dx, y: n.dy };
    const wasFloat = n.float;
    nudgeRef.current = { active: false, float: false, baseOff: null, dx: 0, dy: 0, timer: 0 };
    nudgeActiveRef.current = false;
    moveDeltaRef.current = { x: 0, y: 0 }; // the real selection shift takes over below
    if (!wasFloat) engine.endMove(); // bake + one history entry (a float commits later)
    // The outline follows the moved pixels, exactly like a pointer move-drag.
    const sel = selectionRef.current;
    if (sel.length && (d.x !== 0 || d.y !== 0)) {
      const moved = sel.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y }));
      const h = selHandlersRef.current;
      if (selAngleRef.current !== 0) {
        h.onSelectionRects(moved);
        const piv = selPivotRef.current;
        if (piv) h.onSelectionPivot({ x: piv.x + d.x, y: piv.y + d.y });
      } else {
        h.onSelectionChange(moved);
      }
    }
  }, [engine]);

  // Finalize a pending pixel nudge when the tool changes.
  useEffect(() => {
    commitNudge();
  }, [tool, commitNudge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown")
        return;
      if (e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable ||
          t.closest?.('[role="dialog"]'))
      )
        return; // typing / dialog-local arrow handling wins
      const curTool = toolRef.current;
      const sel = selectionRef.current;
      const selTool = curTool === "select" || curTool === "lasso" || curTool === "wand";
      // The Move tool honours its own "Move: pixels / selection" option — with
      // "selection" the arrows move the outline only, exactly like dragging.
      const outlineOnly = selTool || (curTool === "move" && moveModeRef.current === "selection");
      if (!(curTool === "move" || (selTool && sel.length))) return;
      if (outlineOnly && !sel.length) return; // no outline to nudge
      e.preventDefault();
      const step = e.ctrlKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;

      if (outlineOnly) {
        // Selection tools / Move-in-selection-mode nudge the OUTLINE only.
        const moved = sel.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
        const h = selHandlersRef.current;
        if (selAngleRef.current !== 0) {
          h.onSelectionRects(moved);
          const piv = selPivotRef.current;
          if (piv) h.onSelectionPivot({ x: piv.x + dx, y: piv.y + dy });
        } else {
          h.onSelectionChange(moved);
        }
        return;
      }

      // Move tool → nudge pixels (the float, selection content, or whole layer).
      const n = nudgeRef.current;
      const layerId = activeLayerIdRef.current;
      if (!n.active) {
        if (engine.isFloating && engine.floatLayerId === layerId) {
          n.float = true;
          n.baseOff = engine.getFloatOffset();
        } else {
          if (!layerId) return;
          if (moveBlocked(layerId)) return; // position-locked or fill layer
          const node = findNode(layersRef.current, layerId);
          if (!node || node.type !== "layer") return; // pixel leaves only
          n.float = false;
          n.baseOff = null;
          engine.beginMove(
            layerId,
            sel.length ? sel : null,
            !!node.mask && node.mask.linked !== false && !sel.length,
            sel.length ? [] : linkedMoveExtras(layerId), // linked layers ride whole-layer moves
          );
        }
        n.active = true;
        n.dx = 0;
        n.dy = 0;
        nudgeActiveRef.current = true;
      }
      n.dx += dx;
      n.dy += dy;
      if (n.float && n.baseOff) engine.setFloatOffset(n.baseOff.x + n.dx, n.baseOff.y + n.dy);
      else engine.moveTo(n.dx, n.dy);
      // The ants outline follows the moving pixels live (same as a drag).
      moveDeltaRef.current = { x: n.dx, y: n.dy };
      ensureAnts();
      window.clearTimeout(n.timer);
      n.timer = window.setTimeout(commitNudge, 350);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, commitNudge]);

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // A pinch (tracked on the viewport, capture-phase) owns the gesture — the
    // tool stands down for touch while one is active or being wound down.
    if (e.pointerType !== "mouse" && (pinchRef.current || gestureSuppressRef.current)) return;
    // Palm rejection: once a stylus has been used here, touch stops driving the
    // TOOLS. It still reaches the capture-phase gesture handler above, so a hand
    // resting on the glass is ignored while two-finger pan/zoom keeps working.
    palmRef.current = palmDown(palmRef.current, e.pointerType);
    if (rejectsPointer(palmRef.current, e.pointerType, pointerPrefsRef.current.palm)) return;
    commitNudge(); // a pointer gesture finalizes any pending arrow-key nudge
    // Bird's-eye takes precedence over every tool while H is held.
    if (hKeyRef.current && !birdRef.current) {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      if (beginBirdsEye(e.clientX, e.clientY)) return;
    }
    // Grabbing a guide pre-empts the Move tool — a guide sitting over a layer
    // has to win, or it could never be picked up again once artwork is under it.
    if (tool === "move" && e.button === 0) {
      const gi = guideAtClient(e.clientX, e.clientY);
      if (gi >= 0) {
        e.preventDefault();
        startGuideDrag(gi, guidesRef.current[gi].axis, e.clientX, e.clientY);
        return;
      }
    }
    // Levels eyedropper: sample the composite under the cursor, then hand back the
    // RGB (the active tool's normal action is suppressed for this one click).
    if (tonePick) {
      e.preventDefault();
      const p = toDoc(e);
      const hex = engine.sampleColor(Math.floor(p.x), Math.floor(p.y), 1, true, activeLayerId);
      if (hex) {
        const c = parseColor(hex);
        onTonePick({ r: c.r, g: c.g, b: c.b });
      }
      return;
    }
    // Curves targeted adjustment: sample the tone under the cursor, then a
    // vertical drag moves the curve point at that tone (Editor does the math).
    if (curveTarget) {
      e.preventDefault();
      const p = toDoc(e);
      const hex = engine.sampleColor(Math.floor(p.x), Math.floor(p.y), 1, true, activeLayerId);
      if (hex) {
        const c = parseColor(hex);
        viewRef.current?.setPointerCapture(e.pointerId);
        curveDragYRef.current = e.clientY;
        onCurveTargetStart({ r: c.r, g: c.g, b: c.b });
      }
      return;
    }
    // Smart-blur anchor targeting: click-drag anywhere on the image to place the
    // zoom/spin centre or the tilt-shift focus band (Editor patches the filter).
    // Non-left buttons fall through so middle-drag panning etc. keep working.
    if (filterAnchor && e.button === 0) {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      filterAnchorDragRef.current = true;
      reportFilterAnchor(e);
      return;
    }
    if (tool === "zoom") {
      // Left click zooms in, right click (or Alt) zooms out — toward the cursor.
      e.preventDefault();
      zoomToPoint(e.button === 2 || e.altKey ? -1 : 1, e.clientX, e.clientY);
      return;
    }
    if (tool === "hand") {
      // Drag to pan the canvas around the viewport.
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      handRef.current = { sx: e.clientX, sy: e.clientY, px: panR.current.x, py: panR.current.y };
      setHoverCursor("grabbing");
      return;
    }
    if (tool === "eyedropper") {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      pickingRef.current = true;
      pick(e);
      ensureAnts();
      return;
    }
    if (tool === "crop") {
      const pq = cropQuadRef.current;
      if (pq) {
        // Perspective mode: grab the nearest corner; double-click commits.
        e.preventDefault();
        const p = toDoc(e);
        if (e.detail >= 2) {
          onCropApplyRef.current();
          return;
        }
        const hit = 12 / (zoomRef.current / 100);
        let idx = -1;
        let best = hit;
        for (let i = 0; i < 4; i++) {
          const d = Math.hypot(p.x - pq[i].x, p.y - pq[i].y);
          if (d <= best) {
            best = d;
            idx = i;
          }
        }
        if (idx >= 0) {
          viewRef.current?.setPointerCapture(e.pointerId);
          perspDragRef.current = idx;
          ensureAnts();
        }
        return;
      }
      if (!cropBoxRef.current) return;
      e.preventDefault();
      const p = toDoc(e);
      const handle = cropHandleAt(p);
      // Double-click inside the box commits the crop.
      if (e.detail >= 2 && handle === "move") {
        onCropApplyRef.current();
        return;
      }
      viewRef.current?.setPointerCapture(e.pointerId);
      cropDragRef.current = {
        handle: handle === "outside" || handle === null ? "new" : handle,
        px: p.x,
        py: p.y,
        box: { ...cropBoxRef.current },
      };
      ensureAnts();
      return;
    }
    if (tool === "move") {
      const p = toDoc(e);
      // Auto-select: clicking a pixel picks the layer that owns it, so you can
      // grab things on the canvas instead of hunting the Layers panel. Only
      // without a selection — with a marquee up, a click starts moving THAT,
      // and re-targeting the layer under the cursor would be a trap.
      // `moveId` shadows the active layer for this gesture so an auto-selected
      // pick takes effect immediately — the prop won't have updated yet, and
      // waiting a render would drag the OLD layer on the very click that picked
      // the new one.
      let moveId = activeLayerId;
      if (autoSelect && moveMode === "pixels" && !selection.length) {
        const hit = pickLayerAt(p);
        if (hit && hit !== activeLayerId) {
          onPickLayer(hit);
          moveId = hit;
        }
      }
      if (moveMode === "selection") {
        if (!selection.length) return; // nothing to move
        e.preventDefault();
        viewRef.current?.setPointerCapture(e.pointerId);
        moveRef.current = { sx: p.x, sy: p.y, mode: "selection" };
        beginMoveSnap();
      } else {
        // Pixels mode: float an active selection (or keep moving the current float),
        // leaving the layer's own content untouched until deselect.
        if (moveBlocked(moveId)) return; // position-locked or fill layer
        let floating = engine.isFloating && engine.floatLayerId === moveId;
        if (!floating && moveId && selection.length) {
          floating = engine.beginFloatFromSelection(
            moveId,
            selection,
            selectionAngle,
            selectionPivot,
            selectionFeather,
          );
        }
        if (floating) {
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          moveRef.current = { sx: p.x, sy: p.y, mode: "pixels", float: true, baseOff: engine.getFloatOffset() };
          beginMoveSnap();
        } else {
          if (!moveId) return; // nothing to move
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          moveRef.current = { sx: p.x, sy: p.y, mode: "pixels" };
          // Snap candidates MUST be captured before beginMove: a whole-layer move
          // lifts the pixels onto a float and clears the layer's own canvas, so
          // measuring its content bounds afterwards finds an empty layer (and the
          // same goes for any linked layers riding along).
          beginMoveSnap();
          // No selection → move the whole layer; a linked mask travels with it,
          // and any linked layers ride along by the same delta.
          const moveNode = findNode(layers, moveId);
          engine.beginMove(
            moveId,
            null,
            !!moveNode?.mask && moveNode.mask.linked !== false,
            linkedMoveExtras(moveId),
          );
        }
      }
      moveDeltaRef.current = { x: 0, y: 0 };
      ensureAnts();
      return;
    }
    if (tool === "wand") {
      if (engine.isFloating) engine.commitFloat();
      const p = toDoc(e);
      const op = selectOp(e);
      // With no modifier, a grab on a handle/ring/anchor transforms the existing
      // selection; Ctrl-add / Alt-subtract always start a fresh wand region.
      if (op === "new" && tryStartTransform(e, p, zoom / 100)) return;
      if (!wand.sampleAll && !activeLayerId) return; // need a layer to sample
      e.preventDefault();
      // Ctrl/Cmd adds (union); Alt subtracts; plain click replaces.
      const base = op !== "new" && selection.length ? selection : [];
      wandSeedRef.current = { x: p.x, y: p.y, layerId: activeLayerId, base, mode: op };
      const raw = engine.magicWand(
        activeLayerId ?? "",
        p.x,
        p.y,
        { tolerance: wand.tolerance, contiguous: wand.contiguous, sampleAll: wand.sampleAll },
        false,
        op === "add" && base.length ? base : null, // union folded in for add
      );
      if (op === "subtract") {
        if (raw) applyCombined(engine.combineSelection(base, raw.rects, "subtract"));
      } else if (raw && raw.rects.length) {
        wandSegsRef.current = { key: raw.rects, segs: raw.segments };
        onSelectionChange(raw.rects);
      }
      ensureAnts();
      return;
    }
    if (tool === "quickselect") {
      if (!quickSelect.sampleAll && !activeLayerId) return; // need a layer to sample
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      const subtract = e.altKey; // Alt = subtract; a plain brush grows the selection
      engine.beginQuickSelect(
        activeLayerId ?? "",
        { tolerance: quickSelect.tolerance, sampleAll: quickSelect.sampleAll },
        selection.length ? selection : null,
        subtract,
      );
      qsDraggingRef.current = true;
      qsLastRef.current = { x: p.x, y: p.y };
      quickSelectHoverRef.current = { x: p.x, y: p.y };
      const r = engine.quickSelectDab(p.x, p.y, quickSelect.size / 2);
      if (r) applyCombined(r);
      else onSelectionChange([]);
      ensureAnts();
      return;
    }
    if (tool === "select") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      const p = toDoc(e);
      const op = selectOp(e);
      // Plain drag may grab a transform handle; Ctrl-add / Alt-subtract and a
      // Shift (1:1-constrained) drag always start a fresh marquee.
      if (op === "new" && !e.shiftKey && tryStartTransform(e, p, zoom / 100)) return;
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      // Snap the anchor corner too — a marquee that snaps only on release would
      // start half a pixel off the guide it was clearly aimed at.
      const a = beginRectSnap(p.x, p.y, e.ctrlKey || e.metaKey);
      marqueeRef.current = { x: a.x, y: a.y, mode: op };
      dragRectRef.current = { x: a.x, y: a.y, w: 0, h: 0 };
      ensureAnts();
      return;
    }
    if (tool === "lasso") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      e.preventDefault();
      const p = toDoc(e);
      const variant = lassoVariantRef.current;
      if (variant === "poly") {
        // Click-point polygon: each click drops a vertex. Double-click, or a
        // click back on the start point, closes it. No pointer capture — the
        // cursor roams freely between clicks (rubber band tracks it on move).
        const poly = polyRef.current;
        const scale = zoomRef.current / 100;
        if (poly) {
          const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
            Math.hypot(a.x - b.x, a.y - b.y) * scale <= 8;
          if (e.detail >= 2 || (poly.pts.length >= 3 && near(p, poly.pts[0]))) {
            commitPolyLasso();
            return;
          }
          poly.pts.push({ x: p.x, y: p.y });
        } else {
          polyRef.current = { pts: [{ x: p.x, y: p.y }], op: selectOp(e) };
        }
        polyHoverRef.current = { x: p.x, y: p.y };
        ensureAnts();
        return;
      }
      // Freehand or magnetic: drag a path. Magnetic snaps points to edges, so
      // build the composite's edge map once at stroke start.
      viewRef.current?.setPointerCapture(e.pointerId);
      if (variant === "magnetic") buildEdgeMap();
      const start = variant === "magnetic" ? snapToEdge(p) : p;
      lassoRef.current = [start];
      lassoModeRef.current = selectOp(e); // Ctrl adds, Alt subtracts, else new
      ensureAnts();
      return;
    }
    if (tool === "shape") {
      if (engine.isFloating) engine.commitFloat();
      const p = toDoc(e);
      // Grab a shape node (trapezoid side / triangle apex) to reshape it live.
      const node = shapeNodeAt(p);
      if (node) {
        e.preventDefault();
        viewRef.current?.setPointerCapture(e.pointerId);
        nodeDragRef.current = node;
        setHoverCursor("grabbing");
        return;
      }
      // Grab a handle on the just-drawn shape's selection to transform it.
      if (tryStartTransform(e, p, zoom / 100)) return;
      engine.endShape(); // commit any previous live shape before drawing a new one
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      trapRef.current = { ...TRAP_DEFAULT }; // a fresh trapezoid starts symmetric
      triApexRef.current = 0.5; // a fresh triangle starts centred
      shapeRef.current = { x: p.x, y: p.y };
      shapeRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      ensureAnts();
      return;
    }
    if (tool === "measure") {
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      const hit = measureHandleAt(p);
      if (hit && measureRef.current) {
        measureDragRef.current = hit; // grab an existing endpoint to adjust
      } else {
        onMeasureRef.current({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }); // start fresh
        measureDragRef.current = "end";
      }
      ensureAnts();
      return;
    }
    if (tool === "bucket") {
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      finishLiveBucket(); // bake any previous editable fill before a new one
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      // Hold to preview the flood-fill region (Shift = all matching areas, even
      // disconnected ones); it follows the cursor and only fills on release.
      // Left button fills with the primary colour, right button with the secondary.
      bucketSeedRef.current = {
        x: p.x,
        y: p.y,
        shift: e.shiftKey,
        layerId: activeLayerId,
        slot: e.button === 2 ? "secondary" : "primary",
      };
      bucketThrottle.current.last = performance.now();
      recomputeBucket(false); // load source fresh
      return;
    }
    if (tool === "gradient") {
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      // Grab a handle of the current gradient to adjust it, otherwise draw a new one.
      const hit = gradientHandleAt(p);
      if (hit) {
        gradDragRef.current = hit;
        return;
      }
      engine.endGradient(); // commit the previous gradient
      gradientRef.current = {
        layerId: ensureLayer(),
        start: p,
        end: p,
        mid: 0.5,
        sel: selection.slice(),
        selAngle: selectionAngle,
        selPivot: selectionPivot,
      };
      gradDragRef.current = "end";
      renderGradient();
      ensureAnts();
      return;
    }
    if (tool === "frame") {
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      frameDragRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      ensureAnts();
      return;
    }
    if (tool === "directselect") {
      const path = penPathRef.current;
      if (!path) return; // nothing loaded — pick a path in the Paths panel
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      const tol = 8 / (zoomRef.current / 100);
      const hit = hitTest(path.anchors, path.closed, p, tol, dsSelRef.current);
      const sel = dsSelRef.current;

      if (hit?.kind === "anchor") {
        if (e.altKey) {
          // Alt on a point flips it between corner and smooth — the one edit
          // that changes the CURVE rather than moving something.
          path.anchors = toggleSmooth(path.anchors, path.closed, hit.index);
          sel.clear();
          sel.add(hit.index);
        } else if (e.shiftKey) {
          if (sel.has(hit.index)) sel.delete(hit.index);
          else sel.add(hit.index);
        } else if (!sel.has(hit.index)) {
          sel.clear();
          sel.add(hit.index);
        }
        dsDragRef.current = { kind: "anchors", index: hit.index, px: p.x, py: p.y };
      } else if (hit?.kind === "in" || hit?.kind === "out") {
        dsDragRef.current = { kind: hit.kind, index: hit.index, px: p.x, py: p.y };
      } else if (hit?.kind === "segment") {
        if (e.altKey) {
          // Alt on a segment inserts a point there, without moving the curve.
          path.anchors = insertAnchor(path.anchors, path.closed, hit.index, hit.t);
          sel.clear();
          sel.add(hit.index + 1);
        } else {
          // Clicking the path itself selects the whole thing, as in Illustrator.
          sel.clear();
          for (let i = 0; i < path.anchors.length; i++) sel.add(i);
        }
      } else {
        if (!e.shiftKey) sel.clear();
        dsMarqueeRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      renderPenLive();
      ensureAnts();
      return;
    }
    if (tool === "pen") {
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      const path = penPathRef.current;
      if (path) {
        const hit = penHitAt(p);
        if (hit) {
          // Clicking the first anchor closes the path; otherwise grab to edit.
          if (hit.kind === "anchor" && hit.index === 0 && !path.closed && path.anchors.length >= 2) {
            path.closed = true;
            renderPenLive();
            ensureAnts();
            return;
          }
          penDragRef.current = hit;
          penGrabRef.current = { px: p.x, py: p.y, anchor: { ...path.anchors[hit.index] } };
          return;
        }
        if (path.closed) {
          engine.endPath(); // a closed path is complete → start a fresh one
        } else {
          // Extend the path with a new anchor (corner; drag to give it handles).
          path.anchors.push(makeAnchor(p.x, p.y));
          penDragRef.current = { kind: "new", index: path.anchors.length - 1 };
          renderPenLive();
          ensureAnts();
          return;
        }
      }
      // Start a new path at the first anchor.
      penPathRef.current = {
        anchors: [makeAnchor(p.x, p.y)],
        closed: false,
        layerId: ensureLayer(),
      };
      penDragRef.current = { kind: "new", index: 0 };
      ensureAnts();
      return;
    }
    if (tool === "brush" || tool === "pencil" || tool === "eraser") {
      if (engine.isFloating) engine.commitFloat(); // merge before painting on it
      // Flip-to-erase: a stylus turned over reports its eraser end, and erases
      // for the length of that stroke without changing the selected tool.
      const erasing = tool === "eraser" || (isEraserTip(e) && !!activeLayerId);
      let layerId: string;
      if (activeLayerId && (engine.quickMaskActive() || engine.getActiveSurface(activeLayerId) !== "pixels")) {
        // Painting a mask — the active layer's (or group's) layer/filter mask, or
        // the document's quick mask. Target the layer directly so brush/pencil
        // don't auto-create a new layer via ensureLayer.
        layerId = activeLayerId;
      } else if (erasing) {
        if (!activeLayerId) return; // nothing to erase
        layerId = activeLayerId;
      } else {
        layerId = ensureLayer(); // brush / pencil auto-creates a layer if none is selected
      }
      if (paintBlocked(layerId)) return; // pixels-locked layer
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      paintHoverRef.current = { x: p.x, y: p.y }; // ring tracks the stroke

      // Erase to History: the eraser paints back from the history source instead
      // of erasing to transparency. It IS the history-brush stroke, run with the
      // eraser's own size/hardness/opacity/flow — so it goes through that
      // session (which the move/up handlers already drive off historyingRef).
      //
      // Two deliberate limits. It applies only on LAYER PIXELS: the history
      // source is a reconstruction of this layer's pixels at an earlier state,
      // and a layer/filter/quick mask has no such past to erase back to — on a
      // mask the eraser stays an eraser. And it's read from the ERASER's
      // settings only, so a flipped stylus (which erases with the brush's
      // settings) keeps erasing to transparency rather than silently
      // resurrecting pixels.
      const onPixels = !engine.quickMaskActive() && engine.getActiveSurface(layerId) === "pixels";
      if (tool === "eraser" && brush.eraseToHistory && onPixels) {
        historyingRef.current = true;
        engine.beginHistory(
          layerId,
          brush,
          p.x,
          p.y,
          selection.length ? selection : null,
          selectionAngle,
          selectionPivot,
          "Erase to History",
        );
        return;
      }

      paintingRef.current = true;
      // Left button paints with the primary colour, right button with the secondary.
      const paintCol = e.button === 2 ? background : foreground;
      engine.beginStroke(
        layerId,
        brush,
        paintCol,
        p.x,
        p.y,
        erasing ? "erase" : "paint",
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
        erasing ? "Erase" : tool === "pencil" ? "Pencil" : "Brush",
        pressureOf(e),
      );
      // Actions recorder: snapshot the stroke's settings + gather its raw path.
      strokeRecRef.current = recordStrokes
        ? { tool, brush: { ...brush }, color: paintCol, points: [{ x: p.x, y: p.y }] }
        : null;
    }
    if (tool === "heal") {
      if (!activeLayerId) return; // nothing to heal on an empty doc
      const healNode = findNode(layers, activeLayerId);
      if (!healNode || healNode.type !== "layer") return; // pixel leaves only
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      healPtsRef.current = [{ x: p.x, y: p.y }];
      healHoverRef.current = { x: p.x, y: p.y };
      ensureAnts();
      return;
    }
    if (tool === "redeye") {
      if (!activeLayerId) return;
      const node = findNode(layers, activeLayerId);
      if (!node || node.type !== "layer") return; // pixel leaves only
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      const p = toDoc(e);
      engine.redEye(
        activeLayerId,
        p.x,
        p.y,
        redEyeRef.current.size,
        redEyeRef.current.darken,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
      return;
    }
    if (tool === "blur") {
      if (!activeLayerId) return; // nothing to soften on an empty doc
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      blurringRef.current = true;
      const p = toDoc(e);
      blurHoverRef.current = { x: p.x, y: p.y };
      engine.beginBlur(
        activeLayerId,
        blur,
        p.x,
        p.y,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "smudge") {
      if (!activeLayerId) return; // nothing to smudge on an empty doc
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      smudgingRef.current = true;
      const p = toDoc(e);
      smudgeHoverRef.current = { x: p.x, y: p.y };
      // Finger painting seeds the smear with the foreground colour.
      const fc = smudge.fingerPaint ? parseColor(fgRef.current) : null;
      engine.beginSmudge(
        activeLayerId,
        smudge,
        p.x,
        p.y,
        fc ? { r: fc.r, g: fc.g, b: fc.b, a: Math.round(fc.a * 255) } : null,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "mixer") {
      if (!activeLayerId) return; // nothing to paint on in an empty doc
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      smudgingRef.current = true; // the mixer IS a smudge session with a reservoir
      const p = toDoc(e);
      smudgeHoverRef.current = { x: p.x, y: p.y };
      const fc = parseColor(fgRef.current);
      engine.beginMixer(
        activeLayerId,
        mixer,
        p.x,
        p.y,
        { r: fc.r, g: fc.g, b: fc.b, a: Math.round(fc.a * 255) },
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "dodge") {
      if (!activeLayerId) return; // nothing to dodge/burn on an empty doc
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      dodgingRef.current = true;
      const p = toDoc(e);
      dodgeHoverRef.current = { x: p.x, y: p.y };
      engine.beginDodge(
        activeLayerId,
        dodge,
        p.x,
        p.y,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "sponge") {
      if (!activeLayerId) return; // nothing to sponge on an empty doc
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      spongingRef.current = true;
      const p = toDoc(e);
      spongeHoverRef.current = { x: p.x, y: p.y };
      engine.beginSponge(
        activeLayerId,
        sponge,
        p.x,
        p.y,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "history") {
      if (!activeLayerId) return; // needs a layer with history to paint from
      if (paintBlocked(activeLayerId)) return; // pixels-locked layer
      if (engine.isFloating) engine.commitFloat();
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      historyingRef.current = true;
      const p = toDoc(e);
      historyHoverRef.current = { x: p.x, y: p.y };
      engine.beginHistory(
        activeLayerId,
        historyBrush,
        p.x,
        p.y,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "clone") {
      const p = toDoc(e);
      cloneHoverRef.current = { x: p.x, y: p.y };
      // Alt / Option click sets the clone source (re-anchoring the offset).
      if (e.altKey) {
        e.preventDefault();
        cloneSrcRef.current = { x: p.x, y: p.y };
        cloneOffRef.current = null;
        cloneAltRef.current = true;
        ensureAnts();
        return;
      }
      if (!cloneSrcRef.current) return; // no source defined yet → nothing to paint
      if (engine.isFloating) engine.commitFloat();
      const layerId = ensureLayer();
      if (paintBlocked(layerId)) return; // pixels-locked layer
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      paintingRef.current = true;
      // Aligned keeps the previous offset; otherwise (or on the first stroke after
      // sampling) re-anchor so the stroke starts sampling from the source point.
      let off = cloneOffRef.current;
      if (!clone.aligned || !off) {
        off = { x: cloneSrcRef.current.x - p.x, y: cloneSrcRef.current.y - p.y };
        cloneOffRef.current = off;
      }
      const cloneBrush: BrushSettings = {
        size: clone.size,
        hardness: clone.hardness,
        opacity: clone.opacity,
        flow: clone.flow,
        blend: "Normal",
        smoothing: clone.smoothing,
      };
      engine.beginClone(
        layerId,
        cloneBrush,
        p.x,
        p.y,
        off,
        clone.sampleAll,
        clone.spacing,
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
      );
    }
    if (tool === "text") {
      e.preventDefault();
      // Clicking the canvas (outside the editor) commits any text being edited.
      if (textSessionRef.current) commitText();
      const p = toDoc(e);
      // Click on an existing text layer → re-edit it as a vector.
      const hit = vectorLayerAt(p, "text");
      if (hit && hit.vector.type === "text") {
        openTextReedit(hit.id, hit.vector);
        return;
      }
      // Otherwise arm a press → click = point text, drag = paragraph box on release.
      textDownRef.current = { x: p.x, y: p.y };
      textDragRef.current = null;
      viewRef.current?.setPointerCapture(e.pointerId);
    }
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    // While a pinch owns the gesture, tools ignore touch moves.
    if (e.pointerType !== "mouse" && (pinchRef.current || gestureSuppressRef.current)) return;
    // Report the doc-space cursor position to the status bar (null off-canvas).
    const cur = toDoc(e);
    onCursor(
      cur.x >= 0 && cur.y >= 0 && cur.x < width && cur.y < height
        ? { x: Math.floor(cur.x), y: Math.floor(cur.y) }
        : null,
    );

    if (birdRef.current) {
      birdRef.current = { ...birdRef.current, x: e.clientX, y: e.clientY };
      ensureAnts();
      return;
    }

    if (curveDragYRef.current !== null) {
      onCurveTargetDrag(e.clientY - curveDragYRef.current);
      return;
    }

    if (filterAnchorDragRef.current) {
      reportFilterAnchor(e);
      return;
    }

    if (handRef.current) {
      // Pan: offset the canvas by the drag delta from the press point.
      const h = handRef.current;
      const vp = viewportRef.current;
      if (vp) {
        setPanRef.current(
          clampHere(h.px + (e.clientX - h.sx), h.py + (e.clientY - h.sy), scaleRef.current, vp),
        );
      }
      return;
    }

    // Brush / pencil / eraser: track the pointer for the brush-ring cursor.
    if (toolRef.current === "brush" || toolRef.current === "pencil" || toolRef.current === "eraser") {
      paintHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // History brush: same brush-ring tracking (painting rides the shared path).
    if (toolRef.current === "history") {
      historyHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Red-eye: ring cursor tracking.
    if (toolRef.current === "redeye") {
      redEyeHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Spot heal: ring cursor + grow the blob while the pointer is down.
    if (toolRef.current === "heal") {
      healHoverRef.current = { x: cur.x, y: cur.y };
      const pts = healPtsRef.current;
      if (pts) {
        const last = pts[pts.length - 1];
        if (Math.hypot(cur.x - last.x, cur.y - last.y) >= Math.max(2, healRef.current.size / 6)) {
          pts.push({ x: cur.x, y: cur.y });
        }
      }
      ensureAnts();
    }
    // Blur: track the pointer so the brush-ring cursor follows it (drawn on the overlay).
    if (toolRef.current === "blur") {
      blurHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Quick-select: same brush-ring tracking.
    if (toolRef.current === "quickselect") {
      quickSelectHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Smudge / mixer: same brush-ring tracking (one shared session).
    if (toolRef.current === "smudge" || toolRef.current === "mixer") {
      smudgeHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Dodge/Burn: same brush-ring tracking.
    if (toolRef.current === "dodge") {
      dodgeHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Sponge: same brush-ring tracking.
    if (toolRef.current === "sponge") {
      spongeHoverRef.current = { x: cur.x, y: cur.y };
      ensureAnts();
    }
    // Clone: track the pointer + Alt state for the brush ring / source marker.
    if (toolRef.current === "clone") {
      cloneHoverRef.current = { x: cur.x, y: cur.y };
      cloneAltRef.current = e.altKey;
      ensureAnts();
    }
    // Text: drag from the press point rubber-bands a paragraph box (preview).
    if (textDownRef.current) {
      const start = textDownRef.current;
      textDragRef.current = normalizeRect(start.x, start.y, cur.x, cur.y, width, height);
      ensureAnts();
      return;
    }

    // Crop: drag a handle / move / rubber-band, else show the right hover cursor.
    if (toolRef.current === "crop") {
      // Perspective mode: drag a quad corner (clamped to the canvas).
      const pq = cropQuadRef.current;
      if (pq) {
        if (perspDragRef.current !== null) {
          const idx = perspDragRef.current;
          const nx = Math.max(0, Math.min(widthRef.current, cur.x));
          const ny = Math.max(0, Math.min(heightRef.current, cur.y));
          const next = pq.map((c, i) => (i === idx ? { x: nx, y: ny } : c)) as CropQuad;
          onCropQuadRef.current(next);
          ensureAnts();
        } else {
          const hit = 12 / (zoomRef.current / 100);
          const onCorner = pq.some((c) => Math.hypot(cur.x - c.x, cur.y - c.y) <= hit);
          const next = onCorner ? "grab" : "crosshair";
          setHoverCursor((c) => (c === next ? c : next));
        }
        return;
      }
      if (cropDragRef.current) {
        onCropBoxRef.current(computeCropDrag(cropDragRef.current, cur));
        ensureAnts();
        return;
      }
      if (cropBoxRef.current) {
        const h = cropHandleAt(cur) ?? "outside";
        const next = CROP_CURSOR[h] ?? "crosshair";
        setHoverCursor((c) => (c === next ? c : next));
      }
      return;
    }

    // Hover feedback (Marquee / Wand / Shape): rotate / resize / anchor cursor.
    if (
      (toolRef.current === "select" ||
        toolRef.current === "wand" ||
        toolRef.current === "shape") &&
      !rotateRef.current &&
      !anchorRef.current &&
      !resizeRef.current &&
      !marqueeRef.current &&
      !nodeDragRef.current
    ) {
      const sel = selectionRef.current;
      let next: string | null = null;
      if (sel.length) {
        const p = toDoc(e);
        const bb = bboxOf(sel);
        const pivot = selPivotRef.current ?? { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
        const zone = selectZone(p.x, p.y, sel, selAngleRef.current, pivot, zoom / 100);
        if (zone.kind === "anchor") next = "grab";
        else if (zone.kind === "resize") next = resizeCursor(zone.edges, selAngleRef.current);
        else if (zone.kind === "ring") next = rotateCursorToward(p.x, p.y, pivot);
        // Shape nodes sit on the top edge and take priority over resize.
        if (toolRef.current === "shape" && shapeNodeAt(p)) next = "grab";
      }
      setHoverCursor((c) => (c === next ? c : next));
    }
    // Hover feedback (Move): a resize cursor over a guide the pointer can grab,
    // so guides are discoverable without a click. Suppressed while a real move
    // is under way (the move cursor must not flicker as it crosses a guide).
    if (toolRef.current === "move" && !moveRef.current && !guideDragRef.current) {
      const gi = guideAtClient(e.clientX, e.clientY);
      const next = gi >= 0 ? (guidesRef.current[gi].axis === "v" ? "col-resize" : "row-resize") : null;
      setHoverCursor((c) => (c === next ? c : next));
    }
    // Hover feedback (Gradient): grab over a handle / midpoint, grabbing while dragging.
    if (toolRef.current === "gradient") {
      const next = gradDragRef.current ? "grabbing" : gradientHandleAt(toDoc(e)) ? "grab" : null;
      setHoverCursor((c) => (c === next ? c : next));
    }
    if (toolRef.current === "measure") {
      const next = measureDragRef.current ? "grabbing" : measureHandleAt(toDoc(e)) ? "grab" : "crosshair";
      setHoverCursor((c) => (c === next ? c : next));
    }
    if (anchorRef.current) {
      const p = toDoc(e);
      onSelectionPivot({ x: Math.round(p.x), y: Math.round(p.y) });
      ensureAnts();
      return;
    }
    if (rotateRef.current) {
      const p = toDoc(e);
      const r = rotateRef.current;
      let a = r.base + (Math.atan2(p.y - r.cy, p.x - r.cx) - r.start);
      // Shift snaps the absolute angle to 15° steps.
      if (e.shiftKey) {
        const step = Math.PI / 12;
        a = Math.round(a / step) * step;
      }
      rotatePreviewRef.current = a; // outline angle (absolute) for the marching ants
      // The lifted float already sits at the base-rotated position, so spin it by
      // the angle delta only — about the same pivot.
      if (r.content) engine.setFloatRotation(a - r.base, { x: r.cx, y: r.cy });
      // Keep the cursor arrow aimed at the selection as the pointer orbits.
      const cur = rotateCursorToward(p.x, p.y, { x: r.cx, y: r.cy });
      setHoverCursor((c) => (c === cur ? c : cur));
      ensureAnts();
      return;
    }
    if (resizeRef.current) {
      const p = toDoc(e);
      const { rects: orig, bbox: o, edges, angle, pivot } = resizeRef.current;
      // For a rotated selection, work in its own (un-rotated) frame so the
      // dragged edge tracks the cursor and the opposite edge stays put.
      const [cxp, cyp] = angle ? rotatePt(p.x, p.y, pivot.x, pivot.y, -angle) : [p.x, p.y];
      // Move the dragged edges of the bounding box; keep it non-degenerate
      // (no flipping) and, when upright, clamped to the canvas.
      let x0 = o.x;
      let y0 = o.y;
      let x1 = o.x + o.w;
      let y1 = o.y + o.h;
      if (edges.left) x0 = Math.min(cxp, x1 - 1);
      if (edges.right) x1 = Math.max(cxp, x0 + 1);
      if (edges.top) y0 = Math.min(cyp, y1 - 1);
      if (edges.bottom) y1 = Math.max(cyp, y0 + 1);
      if (!angle) {
        x0 = clamp(x0, 0, width);
        x1 = clamp(x1, 0, width);
        y0 = clamp(y0, 0, height);
        y1 = clamp(y1, 0, height);
      }
      // Snap the box to whole pixels live, so the outline (and the scaled pixels)
      // land on the grid during the drag — matching the result on release.
      x0 = Math.round(x0);
      y0 = Math.round(y0);
      x1 = Math.round(x1);
      y1 = Math.round(y1);
      const nb = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      // Scale every selection rect proportionally within the new bounding box.
      // Round each rect by its EDGES (not origin + size): an irregular lasso/wand
      // selection is made of many vertically-stacked scanline rects, and rounding
      // y and h independently would leave 1px gaps between them — those gaps later
      // show up as horizontal lines when the mask is used to lift/clip content.
      // Edge rounding keeps contiguous rects sharing an edge (no gaps).
      const sx = nb.w / o.w;
      const sy = nb.h / o.h;
      resizePreviewRef.current = orig.map((r) => {
        const nx0 = Math.round(nb.x + (r.x - o.x) * sx);
        const ny0 = Math.round(nb.y + (r.y - o.y) * sy);
        const nx1 = Math.round(nb.x + (r.x + r.w - o.x) * sx);
        const ny1 = Math.round(nb.y + (r.y + r.h - o.y) * sy);
        return { x: nx0, y: ny0, w: Math.max(1, nx1 - nx0), h: Math.max(1, ny1 - ny0) };
      });
      // In content mode, scale the lifted pixels to match the new bounds. For a
      // rotated selection the scale is applied in its own (un-rotated) frame.
      if (resizeRef.current.content) {
        if (angle) engine.setFloatFrameScale(o, nb, angle, pivot, resizeSmooth);
        else engine.setFloatDst(nb, resizeSmooth);
      }
      return;
    }
    if (tool === "eyedropper") {
      if (pickingRef.current) {
        pick(e);
      } else {
        const p = toDoc(e);
        hoverRef.current = { x: p.x, y: p.y };
      }
      ensureAnts();
      return;
    }
    if (moveRef.current) {
      const p = toDoc(e);
      // Snap the raw delta (guides, canvas edges/centre, other layers) before it
      // is rounded, so the box lands exactly on the line rather than a px off.
      const s = applyMoveSnap(
        p.x - moveRef.current.sx,
        p.y - moveRef.current.sy,
        e.ctrlKey || e.metaKey,
      );
      const dx = Math.round(s.dx);
      const dy = Math.round(s.dy);
      moveDeltaRef.current = { x: dx, y: dy };
      if (moveRef.current.float) {
        const b = moveRef.current.baseOff!;
        engine.setFloatOffset(b.x + dx, b.y + dy);
      } else if (moveRef.current.mode === "pixels") {
        engine.moveTo(dx, dy);
      }
      return;
    }
    if (lassoRef.current) {
      const p = toDoc(e);
      const pts = lassoRef.current;
      const last = pts[pts.length - 1];
      // Add a point only after moving ~2 screen px, to keep the path light.
      const minD = 2 / (zoomRef.current / 100);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= minD) {
        // Magnetic: pin each new point to the strongest nearby edge.
        pts.push(lassoVariantRef.current === "magnetic" ? snapToEdge(p) : { x: p.x, y: p.y });
      }
      ensureAnts();
      return;
    }
    // Polygonal lasso in progress: track the cursor for the rubber-band edge.
    if (polyRef.current) {
      polyHoverRef.current = toDoc(e);
      ensureAnts();
      return;
    }
    if (bucketSeedRef.current) {
      const p = toDoc(e);
      bucketSeedRef.current = { ...bucketSeedRef.current, x: p.x, y: p.y, shift: e.shiftKey };
      // Throttle the flood recompute so big fills don't stall the drag.
      const t = bucketThrottle.current;
      const now = performance.now();
      clearTimeout(t.timer);
      if (now - t.last >= 40) {
        t.last = now;
        recomputeBucket(true);
      } else {
        t.timer = window.setTimeout(() => {
          bucketThrottle.current.last = performance.now();
          recomputeBucket(true);
        }, 40 - (now - t.last));
      }
      return;
    }
    if (gradDragRef.current && gradientRef.current) {
      const p = toDoc(e);
      const g = gradientRef.current;
      if (gradDragRef.current === "end") g.end = { x: p.x, y: p.y };
      else if (gradDragRef.current === "start") g.start = { x: p.x, y: p.y };
      else {
        // Project the cursor onto the line to pick the midpoint position.
        const dx = g.end.x - g.start.x;
        const dy = g.end.y - g.start.y;
        const len2 = dx * dx + dy * dy;
        let t = clamp(len2 > 0 ? ((p.x - g.start.x) * dx + (p.y - g.start.y) * dy) / len2 : 0.5, 0.05, 0.95);
        // Snap to the centre when close (unless disabled in Preferences).
        if (gradOptsRef.current.snap && Math.abs(t - 0.5) < 0.04) t = 0.5;
        g.mid = t;
      }
      renderGradient();
      ensureAnts();
      return;
    }
    if (measureDragRef.current && measureRef.current) {
      const p = toDoc(e);
      const m = measureRef.current;
      let nx = p.x;
      let ny = p.y;
      // Shift constrains the line to 45° increments from the anchored endpoint.
      if (e.shiftKey) {
        const ax = measureDragRef.current === "end" ? m.x1 : m.x2;
        const ay = measureDragRef.current === "end" ? m.y1 : m.y2;
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(p.y - ay, p.x - ax) / step) * step;
        const len = Math.hypot(p.x - ax, p.y - ay);
        nx = ax + Math.cos(ang) * len;
        ny = ay + Math.sin(ang) * len;
      }
      onMeasureRef.current(
        measureDragRef.current === "end"
          ? { ...m, x2: nx, y2: ny }
          : { ...m, x1: nx, y1: ny },
      );
      ensureAnts();
      return;
    }
    if (frameDragRef.current) {
      const p = toDoc(e);
      frameDragRef.current.x1 = p.x;
      frameDragRef.current.y1 = p.y;
      ensureAnts();
      return;
    }
    if (dsMarqueeRef.current) {
      const p = toDoc(e);
      dsMarqueeRef.current.x1 = p.x;
      dsMarqueeRef.current.y1 = p.y;
      ensureAnts();
      return;
    }
    if (dsDragRef.current && penPathRef.current) {
      const p = toDoc(e);
      const d = dsDragRef.current;
      const path = penPathRef.current;
      if (d.kind === "anchors") {
        path.anchors = moveAnchors(path.anchors, dsSelRef.current, p.x - d.px, p.y - d.py);
      } else {
        path.anchors = dragHandle(path.anchors, d.index, d.kind, p, e.altKey);
      }
      d.px = p.x;
      d.py = p.y;
      renderPenLive();
      ensureAnts();
      return;
    }
    if (penDragRef.current && penPathRef.current) {
      const p = toDoc(e);
      const d = penDragRef.current;
      const a = penPathRef.current.anchors[d.index];
      // By default the opposite handle mirrors for a smooth anchor; holding Shift
      // breaks the symmetry so only the dragged handle moves (an independent corner).
      const mirror = !e.shiftKey;
      if (d.kind === "new" || d.kind === "out") {
        a.ox = p.x;
        a.oy = p.y;
        if (mirror) {
          a.ix = 2 * a.x - p.x;
          a.iy = 2 * a.y - p.y;
        }
      } else if (d.kind === "in") {
        a.ix = p.x;
        a.iy = p.y;
        if (mirror) {
          a.ox = 2 * a.x - p.x;
          a.oy = 2 * a.y - p.y;
        }
      } else {
        // Move the whole anchor (point + both handles) by the drag delta.
        const g = penGrabRef.current;
        if (g) {
          const dx = p.x - g.px;
          const dy = p.y - g.py;
          a.x = g.anchor.x + dx;
          a.y = g.anchor.y + dy;
          a.ix = g.anchor.ix + dx;
          a.iy = g.anchor.iy + dy;
          a.ox = g.anchor.ox + dx;
          a.oy = g.anchor.oy + dy;
        }
      }
      renderPenLive();
      ensureAnts();
      return;
    }
    if (nodeDragRef.current) {
      const live = liveShapeRef.current;
      if (!live) {
        nodeDragRef.current = null;
        return;
      }
      const box = live.box;
      const p = toDoc(e);
      const ang = selAngleRef.current;
      const piv = selPivotRef.current ?? { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      // Work in the shape's local (un-rotated) frame; only the x-position matters.
      let lx = p.x;
      if (ang) {
        const c = Math.cos(-ang);
        const sn = Math.sin(-ang);
        lx = piv.x + (p.x - piv.x) * c - (p.y - piv.y) * sn;
      }
      const sc = zoomRef.current / 100;
      const SNAP_PX = snapDistance; // Preferences ▸ Guides & grid

      let snapped = false;
      if (nodeDragRef.current === "apex") {
        // Triangle apex: slide along the top edge, snapping to centre (isosceles).
        let a = clamp((lx - box.x) / box.w, 0, 1);
        if (Math.abs(a - 0.5) * box.w * sc < SNAP_PX) {
          a = 0.5;
          snapped = true;
        }
        triApexRef.current = a;
      } else {
        const t = { ...trapRef.current };
        if (nodeDragRef.current === "l") {
          let l = clamp((lx - box.x) / box.w, 0, 0.5);
          if (Math.abs(l - t.r) * box.w * sc < SNAP_PX) {
            l = t.r; // snap to symmetry
            snapped = true;
          }
          t.l = l;
        } else {
          let r = clamp((box.x + box.w - lx) / box.w, 0, 0.5);
          if (Math.abs(r - t.l) * box.w * sc < SNAP_PX) {
            r = t.l;
            snapped = true;
          }
          t.r = r;
        }
        trapRef.current = t;
      }
      nodeSnapRef.current = snapped;
      reRenderLiveShape();
      ensureAnts();
      return;
    }
    if (shapeRef.current) {
      const start = shapeRef.current;
      const p = toDoc(e);
      let ex = p.x;
      let ey = p.y;
      if (e.shiftKey) {
        // Constrain to 1:1 (square / circle / equilateral), keeping drag direction.
        const sz = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
        ex = start.x + (p.x < start.x ? -sz : sz);
        ey = start.y + (p.y < start.y ? -sz : sz);
      }
      shapeRectRef.current = normalizeRect(start.x, start.y, ex, ey, width, height);
      ensureAnts();
      return;
    }
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      const p = toDoc(e);
      let px = p.x;
      let py = p.y;
      if (e.shiftKey) {
        // Shift constrains to a 1:1 box (square / circle / symmetric triangle).
        const sx = Math.sign(px - m.x) || 1;
        const sy = Math.sign(py - m.y) || 1;
        let side = Math.max(Math.abs(px - m.x), Math.abs(py - m.y));
        // Keep the square inside the canvas so the edge can't clamp it out of square.
        side = Math.min(
          side,
          Math.max(0, sx > 0 ? width - m.x : m.x),
          Math.max(0, sy > 0 ? height - m.y : m.y),
        );
        px = m.x + sx * side;
        py = m.y + sy * side;
      }
      // The free corner snaps to guides / canvas / layer edges (Shift's 1:1
      // constraint wins — a snapped square would stop being square).
      if (!e.shiftKey) {
        const s = applyRectSnap(px, py, e.ctrlKey || e.metaKey);
        px = s.x;
        py = s.y;
      }
      const dr = normalizeRect(m.x, m.y, px, py, width, height);
      // Snap selections to whole pixels when Snap is on.
      dragRectRef.current = snap
        ? { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.w), h: Math.round(dr.h) }
        : dr;
      return;
    }
    if (qsDraggingRef.current) {
      const p = toDoc(e);
      quickSelectHoverRef.current = { x: p.x, y: p.y };
      const last = qsLastRef.current;
      const step = Math.max(2, quickSelectRef.current.size * 0.25);
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= step) {
        qsLastRef.current = { x: p.x, y: p.y };
        const r = engine.quickSelectDab(p.x, p.y, quickSelectRef.current.size / 2);
        if (r) applyCombined(r);
        else onSelectionChange([]);
      }
      ensureAnts();
      return;
    }
    if (blurringRef.current) {
      const p = toDoc(e);
      engine.moveBlur(p.x, p.y);
      return;
    }
    if (smudgingRef.current) {
      const p = toDoc(e);
      engine.moveSmudge(p.x, p.y);
      return;
    }
    if (historyingRef.current) {
      const p = toDoc(e);
      engine.moveHistory(p.x, p.y);
      return;
    }
    if (dodgingRef.current) {
      const p = toDoc(e);
      engine.moveDodge(p.x, p.y);
      return;
    }
    if (spongingRef.current) {
      const p = toDoc(e);
      engine.moveSponge(p.x, p.y);
      return;
    }
    if (!paintingRef.current) return;
    const p = toDoc(e);
    // A pen samples far faster than the browser fires move events; replaying the
    // coalesced samples keeps a fast stroke smooth AND gives each dab its own
    // pressure instead of one reading per animation frame.
    const native = e.nativeEvent;
    const samples =
      e.pointerType !== "mouse" && typeof native.getCoalescedEvents === "function"
        ? native.getCoalescedEvents()
        : [];
    if (samples.length > 1) {
      for (const s of samples) {
        const q = clientToDoc(s.clientX, s.clientY);
        engine.moveStroke(q.x, q.y, pressureOf(s));
        recordStrokePoint(q);
      }
      return;
    }
    engine.moveStroke(p.x, p.y, pressureOf(e));
    recordStrokePoint(p);
  };

  /** Actions recorder: thin the stroke path to ≥0.75 doc px between points. */
  const recordStrokePoint = (p: { x: number; y: number }) => {
    const rec = strokeRecRef.current;
    if (!rec) return;
    const last = rec.points[rec.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.75) rec.points.push({ x: p.x, y: p.y });
  };
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    const wasRejected = rejectsPointer(palmRef.current, e.pointerType, pointerPrefsRef.current.palm);
    palmRef.current = palmUp(palmRef.current, e.pointerType);
    if (wasRejected) return; // this contact never started anything
    // The aborted tool must not commit on lift while a gesture is winding down.
    if (e.pointerType !== "mouse" && (pinchRef.current || gestureSuppressRef.current)) return;
    if (birdRef.current) {
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      endBirdsEye();
      return;
    }
    if (curveDragYRef.current !== null) {
      curveDragYRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      onCurveTargetEnd();
      return;
    }
    if (filterAnchorDragRef.current) {
      filterAnchorDragRef.current = false;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (handRef.current) {
      handRef.current = null;
      setHoverCursor(null);
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (perspDragRef.current !== null) {
      perspDragRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      ensureAnts();
      return;
    }
    if (cropDragRef.current) {
      cropDragRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      ensureAnts();
      return;
    }
    if (textDownRef.current) {
      const start = textDownRef.current;
      const drag = textDragRef.current;
      textDownRef.current = null;
      textDragRef.current = null;
      const pt = toDoc(e);
      // A real drag → paragraph box; a click → point text (auto-width).
      const session =
        drag && Math.abs(pt.x - start.x) > 6 && Math.abs(pt.y - start.y) > 6
          ? { x: drag.x, y: drag.y, boxW: Math.max(24, drag.w), value: "", seed: Date.now() }
          : { x: start.x, y: start.y, boxW: null, value: "", seed: Date.now() };
      // New text defaults to the primary colour.
      onText({ color: foreground });
      setTextSession(session);
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      ensureAnts();
      return;
    }
    if (anchorRef.current) {
      anchorRef.current = false;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (rotateRef.current) {
      const r = rotateRef.current;
      const a = rotatePreviewRef.current ?? r.base;
      const before = r.before;
      rotateRef.current = null;
      rotatePreviewRef.current = null;
      wandSeedRef.current = null; // rotating finalises a wand selection
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      if (!r.content) {
        if (a === before.angle) return; // grabbed but didn't rotate
        // Bounds mode: persist the outline rotation; pixels untouched.
        const after: SelState = { rects: before.rects, angle: a, pivot: before.pivot, segs: before.segs };
        onSelectionAngle(a);
        engine.pushStructural("Rotate", () => applySel(before), () => applySel(after));
        return;
      }
      if (a === before.angle) {
        engine.discardFloat(); // no rotation → put the lifted pixels back
        return;
      }
      // Keep the selection rotated to match the baked content; the pixel "Rotate"
      // entry carries the selection restore so one undo reverts both.
      const after: SelState = {
        rects: before.rects,
        angle: a,
        pivot: { x: r.cx, y: r.cy },
        segs: before.segs,
      };
      engine.commitFloat(selSide(before, after)); // bake the rotated pixels
      onSelectionPivot({ x: r.cx, y: r.cy });
      onSelectionAngle(a);
      return;
    }
    if (resizeRef.current) {
      const { content, bbox: o, angle, before } = resizeRef.current;
      const wandCache = wandSegsRef.current;
      const wasWand = !!wandCache && wandCache.key === selectionRef.current;
      const preview = resizePreviewRef.current;
      resizeRef.current = null;
      resizePreviewRef.current = null;
      // Snap to whole pixels and drop any rects that collapsed away.
      const committed = preview
        ? preview
            .map((r) => ({
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.w),
              h: Math.round(r.h),
            }))
            .filter((r) => r.w >= 1 && r.h >= 1)
        : [];
      const nb = committed.length ? bboxOf(committed) : null;
      const changed = !!nb && (nb.x !== o.x || nb.y !== o.y || nb.w !== o.w || nb.h !== o.h);
      // For a wand selection, scale its cached boundary segments to match the
      // committed rects so the ants stay cheap (no unionSegments on many rects).
      const recacheWand = (rects: Rect[]) => {
        // A transformed wand selection is no longer "live" — stop tolerance from
        // re-selecting the original region.
        wandSeedRef.current = null;
        if (!wasWand || !nb) return;
        const fx = o.w ? nb.w / o.w : 1;
        const fy = o.h ? nb.h / o.h : 1;
        wandSegsRef.current = {
          key: rects,
          segs: wandCache!.segs.map((g) => ({
            x1: nb.x + (g.x1 - o.x) * fx,
            y1: nb.y + (g.y1 - o.y) * fy,
            x2: nb.x + (g.x2 - o.x) * fx,
            y2: nb.y + (g.y2 - o.y) * fy,
          })),
        };
      };
      const mkAfter = (rects: Rect[]): SelState => ({
        rects,
        angle,
        pivot: selPivotRef.current,
        segs: wasWand ? wandSegsRef.current?.segs ?? null : null,
      });
      if (content) {
        // Bake the scaled pixels (or restore them untouched if nothing changed).
        if (changed) {
          recacheWand(committed);
          const after = mkAfter(committed);
          // The pixel "Scale" entry carries the selection restore (one undo).
          engine.commitFloat(selSide(before, after));
          if (angle) onSelectionRects(committed);
          else onSelectionChange(committed);
        } else {
          engine.discardFloat();
        }
      } else if (committed.length && changed) {
        recacheWand(committed);
        const after = mkAfter(committed);
        // Bounds mode: no pixels — push the outline change as its own undo step.
        if (angle) onSelectionRects(committed);
        else onSelectionChange(committed);
        engine.pushStructural("Resize", () => applySel(before), () => applySel(after));
      }
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (pickingRef.current) {
      pickingRef.current = false;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (moveRef.current) {
      const mode = moveRef.current.mode;
      const float = moveRef.current.float;
      const d = moveDeltaRef.current;
      moveRef.current = null;
      endMoveSnap();
      // Float stays floating; a real lift-move bakes here.
      if (!float && mode === "pixels") engine.endMove();
      // Selection follows whatever moved (float, lifted pixels, or selection-only).
      if (selection.length && (d.x !== 0 || d.y !== 0)) {
        const moved = selection.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y }));
        if (selAngleRef.current !== 0) {
          // Keep the rotation and shift the pivot with the rects, so a rotated
          // selection's outline stays locked to its (rotated) pixels. Resetting
          // the angle here would leave an axis-aligned mask over rotated content,
          // which later clips it into scanlines.
          onSelectionRects(moved);
          const piv = selPivotRef.current;
          if (piv) onSelectionPivot({ x: piv.x + d.x, y: piv.y + d.y });
        } else {
          onSelectionChange(moved);
        }
      }
      moveDeltaRef.current = { x: 0, y: 0 };
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (lassoRef.current) {
      const pts = lassoRef.current;
      const mode = lassoModeRef.current;
      lassoRef.current = null;
      edgeMapRef.current = null; // free the magnetic edge field
      magneticPrevRef.current = null;
      magneticRawRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      // Close the polygon (straight start↔end edge) and rasterize it to a region,
      // then combine with the current selection (Ctrl-add / Alt-subtract).
      const region = pts.length >= 3 ? engine.lassoSelect(pts) : null;
      if (region && region.rects.length) {
        if (mode === "new") {
          wandSegsRef.current = { key: region.rects, segs: region.segments };
          onSelectionChange(region.rects);
        } else {
          applyCombined(engine.combineSelection(selection, region.rects, mode));
        }
      } else if (mode === "new") {
        onSelectionChange([]); // a click / empty lasso clears (plain only)
      }
      ensureAnts();
      return;
    }
    if (bucketSeedRef.current) {
      clearTimeout(bucketThrottle.current.timer);
      // Recompute precisely from the release point, then start an editable fill.
      const p = toDoc(e);
      const seed = { ...bucketSeedRef.current, x: p.x, y: p.y, shift: e.shiftKey };
      bucketSeedRef.current = seed;
      recomputeBucket(true);
      const hasRegion = !!bucketRef.current?.rects.length;
      bucketSeedRef.current = null;
      bucketRef.current = null; // the fill goes onto the layer now (no overlay preview)
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      if (hasRegion) {
        // Keep the fill live: re-runs from this seed when the options change,
        // until the next action. The seed pixel is marked on the overlay.
        liveBucketRef.current = {
          seedX: Math.floor(p.x),
          seedY: Math.floor(p.y),
          sampleLayerId: seed.layerId,
          fillLayerId: seed.layerId ?? ensureLayer(),
          slot: seed.slot,
          shift: seed.shift,
        };
        renderLiveBucket();
      }
      ensureAnts();
      return;
    }
    if (measureDragRef.current) {
      measureDragRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      // A bare click (no drag) clears the measurement rather than leaving a dot.
      const m = measureRef.current;
      if (m && Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 1) onMeasureRef.current(null);
      setHoverCursor(measureHandleAt(toDoc(e)) ? "grab" : null);
      ensureAnts();
      return;
    }
    if (gradDragRef.current) {
      // Stop dragging the handle; the gradient stays live (handles remain) until
      // you switch tools, start a new one, or make another edit.
      gradDragRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      // Pointer is still over the handle it just released → show "grab", not "grabbing".
      setHoverCursor(gradientHandleAt(toDoc(e)) ? "grab" : null);
      ensureAnts();
      return;
    }
    if (frameDragRef.current) {
      const f = frameDragRef.current;
      frameDragRef.current = null;
      const w = Math.abs(f.x1 - f.x0);
      const h = Math.abs(f.y1 - f.y0);
      // A click rather than a drag is not a frame; ignoring it beats creating a
      // one-pixel placeholder nobody can see or grab.
      if (w >= 4 && h >= 4) {
        onFrameDrawn?.(
          { x: Math.min(f.x0, f.x1), y: Math.min(f.y0, f.y1), w, h },
          frameShapeRef.current,
        );
      }
      ensureAnts();
    }
    if (dsMarqueeRef.current) {
      const m = dsMarqueeRef.current;
      const path = penPathRef.current;
      if (path) {
        for (const i of anchorsInRect(path.anchors, {
          x: m.x0,
          y: m.y0,
          w: m.x1 - m.x0,
          h: m.y1 - m.y0,
        }))
          dsSelRef.current.add(i);
      }
      dsMarqueeRef.current = null;
      ensureAnts();
    }
    if (dsDragRef.current) {
      dsDragRef.current = null;
      renderPenLive();
      ensureAnts();
    }
    if (penDragRef.current) {
      // Finish this anchor/handle drag; the path stays live until committed.
      penDragRef.current = null;
      penGrabRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      ensureAnts();
      return;
    }
    if (nodeDragRef.current) {
      nodeDragRef.current = null;
      nodeSnapRef.current = false; // guides only show during the snapped drag
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      setHoverCursor(shapeNodeAt(toDoc(e)) ? "grab" : null);
      ensureAnts();
      return;
    }
    if (shapeRef.current) {
      const rect = shapeRectRef.current;
      shapeRef.current = null;
      shapeRectRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      if (rect && rect.w >= 1 && rect.h >= 1) {
        const o = shapeOptsRef.current;
        const box: Rect = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.w),
          h: Math.round(rect.h),
        };
        const layerId = ensureLayer();
        // Draw it as a "live" shape: still editable (colour/stroke/radius, and the
        // trapezoid's side nodes) while its selection is up, and resizable /
        // rotatable via the handles.
        engine.liveShape(
          layerId,
          box,
          0,
          o.kind,
          o.fill,
          o.stroke,
          o.strokeWidth,
          o.radius,
          shapeGeom(o.kind),
        );
        liveShapeRef.current = { layerId, box };
        onSelectionChange([box]); // `box` is the same object → selection identifies the shape
      }
      ensureAnts();
      return;
    }
    if (marqueeRef.current) {
      const anchor = marqueeRef.current;
      const mode = anchor.mode;
      const rect = dragRectRef.current;
      marqueeRef.current = null;
      dragRectRef.current = null;
      endMoveSnap();
      liveTriangleRef.current = null; // a new marquee op supersedes any live triangle
      if (rect && rect.w >= 1 && rect.h >= 1) {
        if (mode === "new" && marqueeShape === "rect") {
          onSelectionChange([rect]); // plain replace — a single rect needs no tracing
        } else {
          // Rasterize the region (rect / ellipse / triangle) and mask-combine so the
          // engine hands back a clean, pre-traced selection. Routing add/subtract
          // through here — rather than [...selection, rect] — keeps it fast even when
          // the existing selection is a many-rect ellipse/triangle: a plain concat
          // would make the next repaint run an O(n³) unionSegments over the union.
          // A triangle dragged downward (anchor at the top) points its apex down.
          const pointDown = anchor.y <= rect.y + rect.h / 2;
          const sel = marqueeSelRects(rect, marqueeShape, pointDown, triangleApex);
          const base = mode === "new" ? [] : selection;
          const result = engine.combineSelection(base, sel, mode === "subtract" ? "subtract" : "add");
          applyCombined(result);
          // Remember a freshly-made triangle so the Apex slider can re-shape it.
          if (marqueeShape === "triangle" && result && result.rects.length) {
            liveTriangleRef.current = { box: rect, pointDown, base, mode, key: result.rects };
          }
        }
      } else if (mode === "new") {
        onSelectionChange([]); // a plain click clears the selection
      }
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (healPtsRef.current) {
      // Release heals the whole blob in one pass (one history entry).
      const pts = healPtsRef.current;
      healPtsRef.current = null;
      if (activeLayerId && pts.length) {
        engine.healSpots(
          activeLayerId,
          pts,
          healRef.current.size,
          healRef.current.hardness,
          selection.length ? selection : null,
          selAngleRef.current,
          selPivotRef.current,
        );
      }
      ensureAnts();
    }
    if (qsDraggingRef.current) {
      engine.endQuickSelect();
      qsDraggingRef.current = false;
      qsLastRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      ensureAnts();
    }
    if (blurringRef.current) {
      engine.endBlur();
      blurringRef.current = false;
    }
    if (smudgingRef.current) {
      engine.endSmudge();
      smudgingRef.current = false;
    }
    if (historyingRef.current) {
      engine.endHistory();
      historyingRef.current = false;
    }
    if (dodgingRef.current) {
      engine.endDodge();
      dodgingRef.current = false;
    }
    if (spongingRef.current) {
      engine.endSponge();
      spongingRef.current = false;
    }
    if (paintingRef.current) {
      engine.endStroke();
      paintingRef.current = false;
      if (strokeRecRef.current) {
        onStrokeRecord(strokeRecRef.current);
        strokeRecRef.current = null;
      }
    }
    const v = viewRef.current;
    if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
  };

  // Ref-based so the exposed handle stays valid without re-binding.
  const step = (dir: 1 | -1) => {
    viewTouchedRef.current = true; // an explicit zoom ends the auto-fit-on-resize
    const z = zoomRef.current;
    const next = ZOOM_STEPS.filter((s) => (dir === 1 ? s > z : s < z));
    if (next.length) onZoomChangeRef.current(dir === 1 ? next[0] : next[next.length - 1]);
  };

  // Expose zoom/fit commands to the View menu.
  useEffect(() => {
    viewApiRef.current = {
      zoomIn: () => step(1),
      zoomOut: () => step(-1),
      zoom100: () => onZoomChangeRef.current(100),
      fit,
      applyTextStyle: (patch) => {
        const el = textEditRef.current;
        if (!el || !textSessionRef.current) return false;
        return applyPatchToSelection(el, patch);
      },
      loadPenPath: (anchors, closed, sourceId) => {
        dsSourceRef.current = sourceId ?? null;
        dsSelRef.current = new Set();
        if (anchors.length < 2) return;
        finishPenPath(); // commit any path already in progress first
        penPathRef.current = {
          anchors: anchors.map((a) => ({ ...a })),
          closed,
          layerId: ensureLayer(),
        };
        renderPenLive();
        ensureAnts();
      },
    };
    return () => {
      viewApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  const scale = zoom / 100;

  // Tick marks for the rulers — aligned to the canvas, dynamic on pan/zoom.
  const pxPerUnit = unit === "in" ? docDpi : unit === "cm" ? docDpi / 2.54 : 1;
  const hTicks = rulerTicks(vpSize.w, pan.x, zoom / 100, pxPerUnit);
  const vTicks = rulerTicks(vpSize.h, pan.y, zoom / 100, pxPerUnit);

  // Accept the in-progress rename (Enter / blur), or drop it (Escape sets the flag).
  const commitTabRename = () => {
    if (editingTabId == null) return;
    if (!cancelRenameRef.current) {
      const name = tabDraft.trim();
      if (name) onRenameDoc(editingTabId, name);
    }
    cancelRenameRef.current = false;
    setEditingTabId(null);
  };

  return (
    <section className={styles.canvasArea} data-tour="canvas">
      <div className={styles.tabs}>
        {docs.map((d) =>
          editingTabId === d.id ? (
            <div key={d.id} className={styles.tab} data-active={true}>
              <span className={styles.tabDot} />
              <input
                ref={renameInputRef}
                className={styles.tabRename}
                value={tabDraft}
                autoFocus
                aria-label={`Rename ${d.name}`}
                onChange={(e) => setTabDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    renameInputRef.current?.blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRenameRef.current = true;
                    renameInputRef.current?.blur();
                  }
                }}
                onBlur={commitTabRename}
              />
            </div>
          ) : (
            <button
              key={d.id}
              type="button"
              className={styles.tab}
              data-active={d.id === activeId}
              onClick={() => {
                // Clicking the already-active tab starts an inline rename;
                // clicking another tab just switches to it.
                if (d.id === activeId) {
                  setTabDraft(d.name);
                  setEditingTabId(d.id);
                } else {
                  onSelectDoc(d.id);
                }
              }}
            >
              <span className={styles.tabDot} />
              <span className={styles.tabName}>{d.name}</span>
              {docs.length > 1 && (
                <span
                  className={styles.tabClose}
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseDoc(d.id);
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          ),
        )}
        <button
          type="button"
          className={styles.tabNew}
          onClick={onNewDoc}
          title="New canvas (Ctrl+N)"
          aria-label="New canvas"
        >
          <Plus size={14} />
        </button>
        <span className={styles.tabSpacer} />
      </div>

      <div className={styles.stageWrap} data-rulers={showRulers}>
        {showRulers && (
          <>
            <div className={styles.rulerCorner} />
            {/* Press-and-drag anywhere on a ruler to pull out a guide (Alt swaps
                the orientation). Locked guides make the rulers inert. */}
            <div
              className={styles.rulerH}
              data-guides={!lockGuides || undefined}
              onPointerDown={onRulerPointerDown("h")}
              title={lockGuides ? "Guides are locked (View ▸ Lock guides)" : "Drag down for a guide"}
            >
              {hTicks.map((t, i) => (
                <span key={i} className={styles.tick} data-major={t.major} style={{ left: t.pos }}>
                  {t.label !== undefined && t.pos < vpSize.w - 24 && <em>{t.label}</em>}
                </span>
              ))}
            </div>
            <div
              className={styles.rulerV}
              data-guides={!lockGuides || undefined}
              onPointerDown={onRulerPointerDown("v")}
              title={lockGuides ? "Guides are locked (View ▸ Lock guides)" : "Drag right for a guide"}
            >
              {vTicks.map((t, i) => (
                <span key={i} className={styles.tick} data-major={t.major} style={{ top: t.pos }}>
                  {t.label !== undefined && t.pos < vpSize.h - 24 && <em>{t.label}</em>}
                </span>
              ))}
            </div>
          </>
        )}

        <div
          className={styles.viewport}
          ref={viewportRef}
          style={tool === "hand" ? { cursor: hoverCursor ?? "grab" } : undefined}
          // Capture-phase multi-touch: a two-finger pinch anywhere in the canvas
          // area zooms/pans, pre-empting the tool (see gestureDown/Move/Up).
          onPointerDownCapture={gestureDown}
          onPointerMoveCapture={gestureMove}
          onPointerUpCapture={gestureUp}
          onPointerCancelCapture={gestureUp}
          onPointerDown={(e) => {
            // Hand tool: also start a pan when the press lands in the padding
            // around the canvas (target is the viewport itself, not the artwork
            // or an overlay). Capture on the artwork canvas so the existing
            // move/up handlers drive the pan.
            if (tool !== "hand" || e.target !== e.currentTarget) return;
            e.preventDefault();
            viewRef.current?.setPointerCapture(e.pointerId);
            handRef.current = { sx: e.clientX, sy: e.clientY, px: panR.current.x, py: panR.current.y };
            setHoverCursor("grabbing");
          }}
        >
          <div
            className={styles.canvasShadow}
            style={{
              width: width * scale,
              height: height * scale,
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
            }}
          >
            {/* Transparency checker behind the artwork. The pattern lives in
                screen space, so its squares stay the same size on zoom; size +
                colours come from Preferences ▸ Transparency (checkerCSS). */}
            <div
              className={styles.checker}
              style={checkerCSS(checkerSize, checkerColors, checkerA, checkerB)}
            />
            <canvas
              key={colorSpace}
              ref={viewRef}
              className={styles.view}
              width={width}
              height={height}
              style={{
                cursor:
                  curveTarget || filterAnchor
                    ? "crosshair"
                    : hoverCursor ??
                  (tool === "move"
                    ? "move"
                    : tool === "hand"
                      ? "grab"
                      : tool === "zoom"
                        ? "zoom-in"
                        : tool === "blur" ||
                            tool === "smudge" ||
                            tool === "mixer" ||
                            tool === "history" ||
                            tool === "clone" ||
                            tool === "dodge" ||
                            tool === "sponge" ||
                            tool === "heal" ||
                            tool === "redeye" ||
                            tool === "quickselect" ||
                            tool === "brush" ||
                            tool === "pencil" ||
                            tool === "eraser"
                          ? "none" // brush ring is drawn on the overlay instead
                          : tool === "text"
                            ? "text"
                            : tool === "eyedropper"
                            ? EYEDROPPER_CURSOR
                            : tool === "select" ||
                                tool === "lasso" ||
                                tool === "wand" ||
                                tool === "shape" ||
                                tool === "bucket" ||
                                tool === "gradient" ||
                                tool === "pen" ||
                                tool === "crop"
                              ? "crosshair"
                              : "default"),
                // Crisp, individually-visible pixels when zoomed in; smooth when zoomed out.
                imageRendering: zoom >= 100 ? "pixelated" : "auto",
              }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onDoubleClick={() => {
                // Double-click finishes (commits) the live pen path.
                if (tool === "pen" && penPathRef.current) finishPenPath();
              }}
              onContextMenu={(e) => {
                // Suppress the browser menu where right-click is a tool action:
                // zoom-out, and right-button painting / filling (secondary colour).
                if (
                  tool === "zoom" ||
                  tool === "brush" ||
                  tool === "pencil" ||
                  tool === "eraser" ||
                  tool === "bucket"
                ) {
                  e.preventDefault();
                }
              }}
              onPointerLeave={() => {
                if (handRef.current) return; // keep the grab cursor while panning
                setHoverCursor(null);
                onCursor(null);
                // Hide the brush-ring cursors when the pointer leaves the
                // canvas (unless mid-stroke, so the ring stays while dragging out).
                // An Erase-to-History stroke is a HISTORY session drawn with the
                // eraser's ring, so it has to count as mid-stroke here too.
                if (!paintingRef.current && !historyingRef.current) {
                  paintHoverRef.current = null;
                  ensureAnts();
                }
                if (!blurringRef.current) {
                  blurHoverRef.current = null;
                  ensureAnts();
                }
                if (!qsDraggingRef.current) {
                  quickSelectHoverRef.current = null;
                  ensureAnts();
                }
                if (!smudgingRef.current) {
                  smudgeHoverRef.current = null;
                  ensureAnts();
                }
                if (!historyingRef.current) {
                  historyHoverRef.current = null;
                  ensureAnts();
                }
                if (!healPtsRef.current) {
                  healHoverRef.current = null;
                  ensureAnts();
                }
                if (!dodgingRef.current) {
                  dodgeHoverRef.current = null;
                  ensureAnts();
                }
                if (!spongingRef.current) {
                  spongeHoverRef.current = null;
                  ensureAnts();
                }
                if (!paintingRef.current) {
                  cloneHoverRef.current = null;
                  ensureAnts();
                }
                if (!pickingRef.current) {
                  hoverRef.current = null;
                  ensureAnts();
                }
              }}
            />
            {/* Live warp/gradient text preview — doc-sized, stacked exactly on
                the artwork (same box), click-through so the editor keeps focus. */}
            <canvas
              ref={textPreviewRef}
              className={styles.textPreview}
              width={width}
              height={height}
              style={{
                display: showTextPreview ? "block" : "none",
                imageRendering: zoom >= 100 ? "pixelated" : "auto",
              }}
            />
            {/* Before/after: the pre-adjustment composite, clipped to the split
                (or fully revealed while the peek key is held). */}
            {compareOn && (
              <canvas
                ref={compareRef}
                className={styles.comparePane}
                width={width}
                height={height}
                style={{
                  clipPath: compareClip(compareSplit ?? 100, compareAxis, comparePeek),
                  imageRendering: zoom >= 100 ? "pixelated" : "auto",
                }}
              />
            )}
          </div>
          <canvas ref={gridRef} className={styles.overlay} />
          <canvas ref={overlayRef} className={styles.overlay} />
          {/* Split divider + side tags, in VIEWPORT space so the line stays a
              constant 2px however far the canvas is zoomed. */}
          {compareSplit !== null && !comparePeek && (() => {
            const v = viewRef.current;
            const vp = viewportRef.current;
            if (!v || !vp) return null;
            const b = v.getBoundingClientRect();
            const host = vp.getBoundingClientRect();
            const box = { left: b.left - host.left, top: b.top - host.top, width: b.width, height: b.height };
            const at = dividerPos(compareSplit, compareAxis, box);
            const vertical = compareAxis === "vertical";
            return (
              <>
                <div
                  className={styles.compareDivider}
                  data-axis={compareAxis}
                  style={vertical ? { left: at } : { top: at }}
                  onPointerDown={startCompareDrag}
                  role="separator"
                  aria-label="Before/after divider"
                  aria-orientation={vertical ? "vertical" : "horizontal"}
                >
                  <span className={styles.compareGrip}>
                    <ArrowLeftRight size={14} />
                  </span>
                </div>
                <span
                  className={styles.compareTag}
                  style={vertical ? { left: box.left + 8, top: box.top + 8 } : { left: box.left + 8, top: box.top + 8 }}
                >
                  Before
                </span>
                <span
                  className={styles.compareTag}
                  style={
                    vertical
                      ? { left: box.left + box.width - 8, top: box.top + 8, transform: "translateX(-100%)" }
                      : { left: box.left + 8, top: box.top + box.height - 8, transform: "translateY(-100%)" }
                  }
                >
                  After
                </span>
              </>
            );
          })()}
          {perfHud && <PerfHud stats={perfStatsCb} />}
          {textSession && (
            <div
              ref={textEditRef}
              className={`${styles.textInput}${showTextPreview ? ` ${styles.textInputGhost}` : ""}`}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              onPointerDown={(e) => e.stopPropagation()}
              onInput={() => {
                const el = textEditRef.current;
                setTextSession((sx) => (sx && el ? { ...sx, value: el.innerText } : sx));
              }}
              onPaste={(e) => {
                // Plain text only — foreign HTML must never enter the runs.
                e.preventDefault();
                const t = e.clipboardData.getData("text/plain");
                if (t) document.execCommand("insertText", false, t);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelText(); // discard a new edit, or restore the original re-edit
                } else if (
                  e.code === "NumpadEnter" ||
                  ((e.ctrlKey || e.metaKey) && e.key === "Enter")
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  commitText();
                } else if (e.key === "Enter") {
                  // Uniform newlines: <br> only, never nested <div> blocks.
                  e.preventDefault();
                  e.stopPropagation();
                  document.execCommand("insertLineBreak");
                } else if (
                  (e.ctrlKey || e.metaKey) &&
                  !e.altKey &&
                  "biu".includes(e.key.toLowerCase())
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  const k = e.key.toLowerCase();
                  const el = textEditRef.current;
                  const patch: TextStylePatch =
                    k === "b" ? { bold: true } : k === "i" ? { italic: true } : { underline: true };
                  // A selection styles that range; a bare caret toggles the block.
                  if (!(el && applyPatchToSelection(el, patch))) {
                    const t = textRef.current;
                    if (k === "b") onTextRef.current({ bold: !t.bold });
                    else if (k === "i") onTextRef.current({ italic: !t.italic });
                    else onTextRef.current({ underline: !t.underline });
                  }
                } else if (
                  (e.ctrlKey || e.metaKey) &&
                  e.shiftKey &&
                  "lcrj".includes(e.key.toLowerCase())
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  const k = e.key.toLowerCase();
                  onTextRef.current({
                    align: k === "l" ? "left" : k === "c" ? "center" : k === "r" ? "right" : "justify",
                  });
                } else if (
                  (e.ctrlKey || e.metaKey) &&
                  e.shiftKey &&
                  (e.key === ">" || e.key === "<" || e.key === "." || e.key === ",")
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  const inc = e.key === ">" || e.key === ".";
                  const t = textRef.current;
                  onTextRef.current({ fontSize: Math.max(1, Math.min(2000, t.fontSize + (inc ? 2 : -2))) });
                }
              }}
              style={{
                left: pan.x + textSession.x * scale,
                // A BASE baseline shift moves every glyph equally, which for the
                // editor box is just a translation — folded into its placement
                // so the DOM text sits where the raster will. Per-RUN shifts ride
                // vertical-align on their own spans (see richtext-dom).
                top: pan.y + (textSession.y - (text.baseline ?? 0)) * scale,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                fontFamily: text.fontFamily,
                fontSize: text.fontSize,
                fontWeight: effectiveWeight(text.bold, text.axes),
                fontStyle: text.italic ? "italic" : "normal",
                // Same quantized keyword the raster uses (canvas accepts only
                // stretch keywords), so the editor never lies about the width.
                fontStretch: stretchKeyword(text.axes?.wdth) ?? undefined,
                fontFeatureSettings: fontFeatureCSS(text.features) ?? undefined,
                lineHeight: String(text.lineHeight),
                letterSpacing: `${text.tracking}px`,
                // All-caps is a display transform here exactly as it is in the
                // raster: the DOM still holds the typed characters, so turning
                // it off gives the original text back rather than a shouted copy.
                textTransform: text.caps ? "uppercase" : undefined,
                color: text.color,
                // Ghosted (warp/gradient preview showing): the glyphs go
                // transparent so the raster isn't doubled, but the caret must
                // stay visible to keep typing usable.
                caretColor: showTextPreview ? text.color : undefined,
                textAlign: text.align,
                // Decorations live on runs (spans), never on the base — CSS
                // text-decoration paints through children and can't be undone.
                whiteSpace: textSession.boxW != null ? "pre-wrap" : "pre",
                overflowWrap: textSession.boxW != null ? "break-word" : "normal",
              }}
            />
          )}
        </div>

        <div className={styles.zoomBar}>
          <button type="button" onClick={() => step(-1)} aria-label="Zoom out">
            <Minus size={14} />
          </button>
          <span className={styles.zoomValue}>{zoom}%</span>
          <button type="button" onClick={() => step(1)} aria-label="Zoom in">
            <Plus size={14} />
          </button>
          <span className={styles.zoomSep} />
          <button type="button" onClick={fit} aria-label="Fit on screen" title="Fit on screen">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
    </section>
  );
}
