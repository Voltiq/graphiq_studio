"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import styles from "./CanvasArea.module.scss";
import { clamp } from "../lib/color";
import { clampPan, normalizeRect, type Pan, type Rect } from "../lib/view";
import type { MoveMode, SelectResizeMode, ShapeKind, ToolId } from "../lib/tools";
import { renderShape } from "../lib/shapes";
import {
  PaintEngine,
  type BrushSettings,
  type EngineHandle,
  type HistorySummary,
  type PendingPaste,
  type WandSelection,
} from "../lib/paint";
import { collectLeafIds, type LayerNode } from "../lib/layers";
import type { PendingLoad } from "../lib/project";

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
 * screen px and each doc px is `scale` screen px. Labels (document coordinates)
 * sit on major ticks; four minor ticks fall between them.
 */
function rulerTicks(length: number, offset: number, scale: number): RulerTick[] {
  const ticks: RulerTick[] = [];
  if (length <= 0 || scale <= 0) return ticks;
  const step = niceStep(70 / scale); // aim for ~70px between labels
  const minor = step / 5;
  const dStart = -offset / scale;
  const dEnd = (length - offset) / scale;
  const first = Math.floor(dStart / step) * step;
  for (let d = first; d <= dEnd + step; d += step) {
    for (let k = 1; k < 5; k++) {
      const pos = offset + (d + minor * k) * scale;
      if (pos >= 0 && pos <= length) ticks.push({ pos, major: false });
    }
    const pos = offset + d * scale;
    if (pos >= 0 && pos <= length) {
      ticks.push({ pos, label: String(Math.round(d)), major: true });
    }
  }
  return ticks;
}

const MIN_ZOOM = 12;
const MAX_ZOOM = 10000;
/** Screen-px width of the invisible rotation ring just outside the selection. */
const RING_OUTER = 44;

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
  tool,
  brush,
  color,
  shape,
  layers,
  activeLayerId,
  ensureLayer,
  selection,
  onSelectionChange,
  onSelectionRects,
  selectionAngle,
  selectionPivot,
  onSelectionAngle,
  onSelectionPivot,
  moveMode,
  resizeMode,
  resizeSmooth,
  wand,
  sampleSize,
  sampleAllLayers,
  onPick,
  pendingPaste,
  onPasteDone,
  pendingLoads,
  onLoadDone,
  colorSpace,
  showRulers,
  showGrid,
  snap,
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
  tool: ToolId;
  brush: BrushSettings;
  color: string;
  /** Shape-tool settings + colours (fill = primary, stroke = secondary). */
  shape: { kind: ShapeKind; strokeWidth: number; radius: number; fill: string; stroke: string };
  layers: LayerNode[];
  activeLayerId: string | null;
  ensureLayer: () => string;
  selection: Rect[];
  onSelectionChange: (rects: Rect[]) => void;
  /** Update the selection rects WITHOUT resetting the rotation transform. */
  onSelectionRects: (rects: Rect[]) => void;
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  onSelectionAngle: (angle: number) => void;
  onSelectionPivot: (pivot: { x: number; y: number } | null) => void;
  moveMode: MoveMode;
  resizeMode: SelectResizeMode;
  resizeSmooth: boolean;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  sampleSize: number;
  sampleAllLayers: boolean;
  onPick: (hex: string) => void;
  pendingPaste: PendingPaste | null;
  onPasteDone: () => void;
  pendingLoads: PendingLoad[];
  onLoadDone: (docId: string) => void;
  colorSpace: PredefinedColorSpace;
  showRulers: boolean;
  showGrid: boolean;
  snap: boolean;
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
  // In-progress freeform lasso path (doc-space points); closed on pointer up.
  const lassoRef = useRef<{ x: number; y: number }[] | null>(null);
  // How the current lasso combines with the existing selection (set at start).
  const lassoModeRef = useRef<SelOp>("new");
  // Hand-tool pan drag: starting pointer position + pan at the start of the drag.
  const handRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  // Shape-tool drag: start point + the current (preview) doc-space box.
  const shapeRef = useRef<{ x: number; y: number } | null>(null);
  const shapeRectRef = useRef<Rect | null>(null);
  const shapeOptsRef = useRef(shape);
  shapeOptsRef.current = shape;
  // The committed-but-still-live shape (re-renderable until deselected). `box`
  // is the same object as its selection rect, so a selection change ends it.
  const liveShapeRef = useRef<{ layerId: string; box: Rect } | null>(null);
  const moveRef = useRef<{
    sx: number;
    sy: number;
    mode: MoveMode;
    float?: boolean;
    baseOff?: { x: number; y: number };
  } | null>(null);
  const moveDeltaRef = useRef({ x: 0, y: 0 });
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
  // Drop any hover cursor when the active tool changes.
  useEffect(() => {
    setHoverCursor(null);
  }, [tool]);
  const antsOffset = useRef(0);
  const antsRaf = useRef(0);

  // Paint engine (created once; constructor is SSR-safe — no DOM access).
  const engineRef = useRef<PaintEngine | null>(null);
  if (!engineRef.current) engineRef.current = new PaintEngine();
  const engine = engineRef.current;

  const layersRef = useRef(layers);
  layersRef.current = layers;
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
    // --- selection marching ants ---
    const m = marqueeRef.current;
    const mv = moveRef.current;
    const rz = resizePreviewRef.current;
    let rects: Rect[];
    if (rz) {
      // Live preview while dragging a resize handle.
      rects = rz;
    } else if (m && m.mode === "new") {
      // While replacing (plain drag), show only the new marquee.
      rects = dragRectRef.current ? [dragRectRef.current] : [];
    } else if (mv) {
      // While moving, offset the selection outline by the drag delta.
      const d = moveDeltaRef.current;
      rects = selectionRef.current.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y }));
    } else if (m && m.mode === "subtract") {
      // Subtracting: the current selection is unchanged here; the drag region is
      // previewed separately in red below.
      rects = selectionRef.current.slice();
    } else {
      rects = selectionRef.current.slice();
      if (dragRectRef.current) rects.push(dragRectRef.current); // additive drag
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
        scx = p.x + pv.x * s;
        scy = p.y + pv.y * s;
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
    } else if (isWand && !rz && (m?.mode === "subtract" || (!m && !dragRectRef.current))) {
      // Static selection, or a subtract drag (the selection itself is unchanged).
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
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Two passes (black, then white offset by half a dash) make the classic ants.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        ctx.lineDashOffset = -antsOffset.current + (pass === 0 ? 0 : 4);
        ctx.beginPath();
        for (const loop of loops) {
          for (let i = 0; i < loop.length; i++) {
            const [sx, sy] = tx(loop[i].x, loop[i].y);
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
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
      renderShape(ctx, o.kind, screenBox, o.fill, o.stroke, o.strokeWidth * s, o.radius * s);
      ctx.restore();
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
      }
    }
  }, []);

  const tickAnts = useCallback(() => {
    antsOffset.current = (antsOffset.current + 0.18) % 8;
    drawAnts();
    if (
      selectionRef.current.length > 0 ||
      dragRectRef.current ||
      lassoRef.current ||
      shapeRef.current ||
      (toolRef.current === "eyedropper" && hoverRef.current)
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
    const live = liveShapeRef.current;
    if (!live) return;
    engine.liveShape(
      live.layerId,
      live.box,
      selAngleRef.current,
      shape.kind,
      shape.fill,
      shape.stroke,
      shape.strokeWidth,
      shape.radius,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.kind, shape.fill, shape.stroke, shape.strokeWidth, shape.radius]);

  // Finalize the live shape when its selection goes away (deselect / reselect).
  useEffect(() => {
    const live = liveShapeRef.current;
    if (live && selection[0] !== live.box) engine.endShape();
  }, [selection, engine]);

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
  zoomRef.current = zoom;
  scaleRef.current = zoom / 100;
  onZoomChangeRef.current = onZoomChange;
  setPanRef.current = setPan;
  onViewportRef.current = onViewport;
  widthRef.current = width;
  heightRef.current = height;

  const prevZoomRef = useRef(zoom);
  const focalRef = useRef<{ ax: number; ay: number } | null>(null);
  const pendingPanRef = useRef<Pan | null>(null);
  const sizeInitRef = useRef(true);

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
      pendingPanRef.current = { x: px, y: py };
      onZoomChangeRef.current(z);
    }
  }, []);

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

  // Fit the document to the viewport once, on mount.
  useLayoutEffect(() => {
    fit();
  }, [fit]);

  // When zoom changes, pivot around the focal point (cursor or viewport centre),
  // or apply an explicit pan queued by fit().
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const newScale = zoom / 100;
    const prevScale = prevZoomRef.current / 100;
    prevZoomRef.current = zoom;

    if (pendingPanRef.current) {
      const p = pendingPanRef.current;
      pendingPanRef.current = null;
      setPanRef.current(clampHere(p.x, p.y, newScale, vp));
      return;
    }
    if (prevScale === newScale) return;

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

  // Re-centre when the canvas is resized (but not on the first mount).
  useEffect(() => {
    if (sizeInitRef.current) {
      sizeInitRef.current = false;
      return;
    }
    const vp = viewportRef.current;
    if (!vp) return;
    const s = zoomRef.current / 100;
    setPanRef.current(clampHere((vp.clientWidth - width * s) / 2, (vp.clientHeight - height * s) / 2, s, vp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // Report the viewport size up, and re-clamp the pan, on resize.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      onViewportRef.current({ w: vp.clientWidth, h: vp.clientHeight });
      setVpSize({ w: vp.clientWidth, h: vp.clientHeight });
      setPanRef.current((p) => clampHere(p.x, p.y, scaleRef.current, vp));
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
    engine.onChange = scheduleComposite;
    engine.onHistory = (s) => onHistoryRef.current(s);
    engine.onAdjustEnd = () => onAdjustEndRef.current();
    engine.onShapeEnd = () => {
      liveShapeRef.current = null;
    };
    paintRef.current = {
      undo: () => engine.undo(),
      redo: () => engine.redo(),
      jumpTo: (i) => engine.jumpTo(i),
      fillSelection: (layerId, rects, col, angle, pivot) =>
        engine.fillSelection(layerId, rects, col, angle, pivot),
      eraseSelection: (layerId, rects, angle, pivot, label) =>
        engine.eraseSelection(layerId, rects, angle, pivot, label),
      copyRegion: (rects, angle, pivot) => engine.copyRegion(rects, angle, pivot),
      isFloating: () => engine.isFloating,
      commitFloat: () => engine.commitFloat(),
      discardFloat: () => engine.discardFloat(),
      duplicateLayer: (s, d) => engine.duplicateLayer(s, d),
      rasterize: (id, nodes, del) => engine.rasterize(id, nodes, del),
      removeLayer: (id) => engine.removeLayer(id),
      getLayerImage: (id) => engine.getLayerImage(id),
      setLayerImage: (id, src) => engine.setLayerImage(id, src),
      exportComposite: (tree) => engine.exportComposite(tree),
      histogram: (tree) => engine.histogram(tree),
      subscribe: (cb) => engine.addChangeListener(cb),
      resizeImage: (w, h, ids, smooth) => engine.resizeImage(w, h, ids, smooth),
      transformImage: (kind, ids) => engine.transformImage(kind, ids),
      applyAdjust: (layerId, adj, sel, angle, pivot) =>
        engine.applyAdjust(layerId, adj, sel, angle, pivot),
      endAdjust: () => engine.endAdjust(),
      revertAdjust: () => engine.revertAdjust(),
      setColorSpace: (cs) => engine.setColorSpace(cs),
      captureLeaves: (ids) => engine.captureLeaves(ids),
      restoreLeaves: (snaps) => engine.restoreLeaves(snaps),
      pushStructural: (label, undo, redo) => engine.pushStructural(label, undo, redo),
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
      await Promise.all(
        entry.images.map(async ({ id, data, source }) => {
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
      );
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

  // Pixel grid: 1px-cell lines over the artwork, drawn in screen space and kept
  // in sync with pan/zoom. Only shown when zoomed in enough to be useful.
  useEffect(() => {
    const ov = gridRef.current;
    const vp = viewportRef.current;
    const ctx = ov?.getContext("2d");
    if (!ov || !vp || !ctx) return;
    if (ov.width !== vp.clientWidth || ov.height !== vp.clientHeight) {
      ov.width = vp.clientWidth;
      ov.height = vp.clientHeight;
    }
    ctx.clearRect(0, 0, ov.width, ov.height);
    const s = zoom / 100;
    if (!showGrid || s < 4) return; // a pixel grid only reads as a grid when zoomed in
    const x0 = Math.max(0, Math.floor(-pan.x / s));
    const x1 = Math.min(width, Math.ceil((ov.width - pan.x) / s));
    const y0 = Math.max(0, Math.floor(-pan.y / s));
    const y1 = Math.min(height, Math.ceil((ov.height - pan.y) / s));
    if (x1 < x0 || y1 < y0) return;
    const top = Math.round(pan.y + y0 * s);
    const bottom = Math.round(pan.y + y1 * s);
    const left = Math.round(pan.x + x0 * s);
    const right = Math.round(pan.x + x1 * s);
    ctx.strokeStyle = "rgba(128,128,128,0.55)";
    ctx.lineWidth = 1;
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
  }, [pan, zoom, vpSize, showGrid, width, height]);

  const toDoc = (e: React.PointerEvent) => {
    const v = viewRef.current!;
    const r = v.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * width) / r.width,
      y: ((e.clientY - r.top) * height) / r.height,
    };
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

  // Start a selection transform (rotate-anchor / resize / rotate-ring) if the
  // press landed on a handle / ring / anchor. Shared by the Marquee and Wand
  // tools so wand selections can be transformed without switching tools.
  const tryStartTransform = (
    e: React.PointerEvent,
    p: { x: number; y: number },
    sc: number,
  ): boolean => {
    if (selection.length < 1) return false;
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
      let content = false;
      if ((tool === "shape" || resizeMode === "content") && activeLayerId) {
        content = engine.beginFloatFromSelection(activeLayerId, selection, selectionAngle, selectionPivot);
      }
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
      let content = false;
      if ((tool === "shape" || resizeMode === "content") && activeLayerId) {
        content = engine.beginFloatFromSelection(activeLayerId, selection, selectionAngle, selectionPivot);
      }
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

  const onCanvasPointerDown = (e: React.PointerEvent) => {
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
    if (tool === "move") {
      const p = toDoc(e);
      if (moveMode === "selection") {
        if (!selection.length) return; // nothing to move
        e.preventDefault();
        viewRef.current?.setPointerCapture(e.pointerId);
        moveRef.current = { sx: p.x, sy: p.y, mode: "selection" };
      } else {
        // Pixels mode: float an active selection (or keep moving the current float),
        // leaving the layer's own content untouched until deselect.
        let floating = engine.isFloating && engine.floatLayerId === activeLayerId;
        if (!floating && activeLayerId && selection.length) {
          floating = engine.beginFloatFromSelection(
            activeLayerId,
            selection,
            selectionAngle,
            selectionPivot,
          );
        }
        if (floating) {
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          moveRef.current = { sx: p.x, sy: p.y, mode: "pixels", float: true, baseOff: engine.getFloatOffset() };
        } else {
          if (!activeLayerId) return; // nothing to move
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          moveRef.current = { sx: p.x, sy: p.y, mode: "pixels" };
          engine.beginMove(activeLayerId, null); // no selection → move the whole layer
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
    if (tool === "select") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      const p = toDoc(e);
      const op = selectOp(e);
      // Plain drag may grab a transform handle; Ctrl-add / Alt-subtract always
      // start a new marquee.
      if (op === "new" && tryStartTransform(e, p, zoom / 100)) return;
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      marqueeRef.current = { x: p.x, y: p.y, mode: op };
      dragRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      ensureAnts();
      return;
    }
    if (tool === "lasso") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      const p = toDoc(e);
      lassoRef.current = [{ x: p.x, y: p.y }];
      lassoModeRef.current = selectOp(e); // Ctrl adds, Alt subtracts, else new
      ensureAnts();
      return;
    }
    if (tool === "shape") {
      if (engine.isFloating) engine.commitFloat();
      const p = toDoc(e);
      // Grab a handle on the just-drawn shape's selection to transform it.
      if (tryStartTransform(e, p, zoom / 100)) return;
      engine.endShape(); // commit any previous live shape before drawing a new one
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      shapeRef.current = { x: p.x, y: p.y };
      shapeRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      ensureAnts();
      return;
    }
    if (tool === "brush" || tool === "pencil" || tool === "eraser") {
      if (engine.isFloating) engine.commitFloat(); // merge before painting on it
      let layerId: string;
      if (tool === "eraser") {
        if (!activeLayerId) return; // nothing to erase
        layerId = activeLayerId;
      } else {
        layerId = ensureLayer(); // brush / pencil auto-creates a layer if none is selected
      }
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      paintingRef.current = true;
      const p = toDoc(e);
      engine.beginStroke(
        layerId,
        brush,
        color,
        p.x,
        p.y,
        tool === "eraser" ? "erase" : "paint",
        selection.length ? selection : null,
        selectionAngle,
        selectionPivot,
        tool === "eraser" ? "Erase" : tool === "pencil" ? "Pencil" : "Brush",
      );
    }
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    // Report the doc-space cursor position to the status bar (null off-canvas).
    const cur = toDoc(e);
    onCursor(
      cur.x >= 0 && cur.y >= 0 && cur.x < width && cur.y < height
        ? { x: Math.floor(cur.x), y: Math.floor(cur.y) }
        : null,
    );

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

    // Hover feedback (Marquee / Wand / Shape): rotate / resize / anchor cursor.
    if (
      (toolRef.current === "select" ||
        toolRef.current === "wand" ||
        toolRef.current === "shape") &&
      !rotateRef.current &&
      !anchorRef.current &&
      !resizeRef.current &&
      !marqueeRef.current
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
      }
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
      // Scale every selection rect proportionally within the new bounding box,
      // rounding to whole pixels (so multi-rect selections snap too).
      const sx = nb.w / o.w;
      const sy = nb.h / o.h;
      resizePreviewRef.current = orig.map((r) => ({
        x: Math.round(nb.x + (r.x - o.x) * sx),
        y: Math.round(nb.y + (r.y - o.y) * sy),
        w: Math.max(1, Math.round(r.w * sx)),
        h: Math.max(1, Math.round(r.h * sy)),
      }));
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
      const dx = Math.round(p.x - moveRef.current.sx);
      const dy = Math.round(p.y - moveRef.current.sy);
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
      if (Math.hypot(p.x - last.x, p.y - last.y) >= minD) pts.push({ x: p.x, y: p.y });
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
      const dr = normalizeRect(m.x, m.y, p.x, p.y, width, height);
      // Snap selections to whole pixels when Snap is on.
      dragRectRef.current = snap
        ? { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.w), h: Math.round(dr.h) }
        : dr;
      return;
    }
    if (!paintingRef.current) return;
    const p = toDoc(e);
    engine.moveStroke(p.x, p.y);
  };
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    if (handRef.current) {
      handRef.current = null;
      setHoverCursor(null);
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
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
      // Float stays floating; a real lift-move bakes here.
      if (!float && mode === "pixels") engine.endMove();
      // Selection follows whatever moved (float, lifted pixels, or selection-only).
      if (selection.length && (d.x !== 0 || d.y !== 0)) {
        onSelectionChange(selection.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y })));
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
        // Draw it as a "live" shape: still editable (colour/stroke/radius) while
        // its selection is up, and resizable / rotatable via the handles.
        engine.liveShape(layerId, box, 0, o.kind, o.fill, o.stroke, o.strokeWidth, o.radius);
        liveShapeRef.current = { layerId, box };
        onSelectionChange([box]); // `box` is the same object → selection identifies the shape
      }
      ensureAnts();
      return;
    }
    if (marqueeRef.current) {
      const mode = marqueeRef.current.mode;
      const rect = dragRectRef.current;
      marqueeRef.current = null;
      dragRectRef.current = null;
      if (rect && rect.w >= 1 && rect.h >= 1) {
        if (mode === "add") onSelectionChange([...selection, rect]);
        else if (mode === "subtract")
          applyCombined(engine.combineSelection(selection, [rect], "subtract"));
        else onSelectionChange([rect]);
      } else if (mode === "new") {
        onSelectionChange([]); // a plain click clears the selection
      }
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (paintingRef.current) {
      engine.endStroke();
      paintingRef.current = false;
    }
    const v = viewRef.current;
    if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
  };

  // Ref-based so the exposed handle stays valid without re-binding.
  const step = (dir: 1 | -1) => {
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
    };
    return () => {
      viewApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  const scale = zoom / 100;

  // Tick marks for the rulers — aligned to the canvas, dynamic on pan/zoom.
  const hTicks = rulerTicks(vpSize.w, pan.x, zoom / 100);
  const vTicks = rulerTicks(vpSize.h, pan.y, zoom / 100);

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
    <section className={styles.canvasArea}>
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
            <div className={styles.rulerH}>
              {hTicks.map((t, i) => (
                <span key={i} className={styles.tick} data-major={t.major} style={{ left: t.pos }}>
                  {t.label !== undefined && t.pos < vpSize.w - 24 && <em>{t.label}</em>}
                </span>
              ))}
            </div>
            <div className={styles.rulerV}>
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
                screen space, so its squares stay the same size on zoom. */}
            <div className={styles.checker} />
            <canvas
              key={colorSpace}
              ref={viewRef}
              className={styles.view}
              width={width}
              height={height}
              style={{
                cursor:
                  hoverCursor ??
                  (tool === "move"
                    ? "move"
                    : tool === "hand"
                      ? "grab"
                      : tool === "zoom"
                        ? "zoom-in"
                        : tool === "eyedropper"
                          ? EYEDROPPER_CURSOR
                          : tool === "brush" ||
                              tool === "pencil" ||
                              tool === "eraser" ||
                              tool === "select" ||
                              tool === "lasso" ||
                              tool === "wand" ||
                              tool === "shape"
                            ? "crosshair"
                            : "default"),
                // Crisp, individually-visible pixels when zoomed in; smooth when zoomed out.
                imageRendering: zoom >= 100 ? "pixelated" : "auto",
              }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onContextMenu={(e) => {
                // Let the zoom tool use right-click for zoom-out (no browser menu).
                if (tool === "zoom") e.preventDefault();
              }}
              onPointerLeave={() => {
                if (handRef.current) return; // keep the grab cursor while panning
                setHoverCursor(null);
                onCursor(null);
                if (!pickingRef.current) {
                  hoverRef.current = null;
                  ensureAnts();
                }
              }}
            />
          </div>
          <canvas ref={gridRef} className={styles.overlay} />
          <canvas ref={overlayRef} className={styles.overlay} />
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
