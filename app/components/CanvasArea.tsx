"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import styles from "./CanvasArea.module.scss";
import { clamp } from "../lib/color";
import { clampPan, normalizeRect, type Pan, type Rect } from "../lib/view";
import type { MoveMode, SelectResizeMode, ToolId } from "../lib/tools";
import {
  PaintEngine,
  type BrushSettings,
  type EngineHandle,
  type HistorySummary,
  type PendingPaste,
} from "../lib/paint";
import { collectLeafIds, type LayerNode } from "../lib/layers";
import type { PendingLoad } from "../lib/project";

const ZOOM_STEPS = [
  12, 25, 33, 50, 67, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200,
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
const MAX_ZOOM = 3200;
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
  // The seed of the last wand click, so the selection can re-compute live when
  // the tolerance (or contiguous / sample-all) options change.
  const wandSeedRef = useRef<{ x: number; y: number; layerId: string | null } | null>(null);
  const wandRafRef = useRef(0); // coalesces rapid live re-computes to one per frame
  const wandOptsRef = useRef(wand);
  wandOptsRef.current = wand;
  const dragRectRef = useRef<Rect | null>(null);
  const marqueeRef = useRef<{ x: number; y: number; additive: boolean } | null>(null);
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
    } else if (m && !m.additive) {
      // While replacing (non-additive drag), show only the new marquee.
      rects = dragRectRef.current ? [dragRectRef.current] : [];
    } else if (mv) {
      // While moving, offset the selection outline by the drag delta.
      const d = moveDeltaRef.current;
      rects = selectionRef.current.map((r) => ({ ...r, x: r.x + d.x, y: r.y + d.y }));
    } else {
      rects = selectionRef.current.slice();
      if (dragRectRef.current) rects.push(dragRectRef.current);
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
    // offsetting them while moving; unionSegments is O(rects³) — too slow here.
    const cache = wandSegsRef.current;
    const wandCached = !!cache && cache.key === selectionRef.current && !rz && !m;
    let segs: Seg[];
    if (wandCached && mv) {
      const d = moveDeltaRef.current;
      segs = cache!.segs.map((g) => ({ x1: g.x1 + d.x, y1: g.y1 + d.y, x2: g.x2 + d.x, y2: g.y2 + d.y }));
    } else if (wandCached && !dragRectRef.current) {
      segs = cache!.segs;
    } else {
      segs = rects.length ? unionSegments(rects) : [];
    }
    if (segs.length) {
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Two passes (black + white, offset by half the dash) make the classic ants.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        const phase = pass === 0 ? 0 : 4;
        for (const seg of segs) {
          let sx1: number;
          let sy1: number;
          let sx2: number;
          let sy2: number;
          if (ang === 0) {
            sx1 = Math.round(p.x + seg.x1 * s) + 0.5;
            sy1 = Math.round(p.y + seg.y1 * s) + 0.5;
            sx2 = Math.round(p.x + seg.x2 * s) + 0.5;
            sy2 = Math.round(p.y + seg.y2 * s) + 0.5;
          } else {
            [sx1, sy1] = rot(p.x + seg.x1 * s, p.y + seg.y1 * s);
            [sx2, sy2] = rot(p.x + seg.x2 * s, p.y + seg.y2 * s);
          }
          // Anchor the dash to absolute screen position so segments meeting at a
          // corner stay in phase (one continuous outline, no doubled dashes).
          const anchor = sy1 === sy2 ? sx1 : sy1;
          ctx.lineDashOffset = anchor - antsOffset.current + phase;
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
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

    // --- resize handles + rotation anchor ---
    if (toolRef.current === "select") {
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
        // Resize handles, rotated to follow the (possibly diagonal) box — hidden
        // for wand selections (scaling their many rects isn't supported).
        const wandSel = wandSegsRef.current?.key === selectionRef.current;
        if (!wandSel) {
          for (const h of rectHandles(bb)) {
            const [hx, hy] = rot(p.x + h.x * s, p.y + h.y * s);
            dot(hx, hy, 4);
          }
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
    antsOffset.current = (antsOffset.current + 0.25) % 8;
    drawAnts();
    if (
      selectionRef.current.length > 0 ||
      dragRectRef.current ||
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

  useEffect(() => {
    if (selection.length) {
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

  // Live-update a magic-wand selection when its options change (e.g. dragging
  // the Tolerance slider) — re-run the wand from the same seed. Coalesced to one
  // recompute per frame (rapid slider events collapse), reuses the cached source
  // pixels, and only runs while the current selection IS the live wand result.
  useEffect(() => {
    if (!wandSeedRef.current) return;
    if (!wandSegsRef.current || wandSegsRef.current.key !== selectionRef.current) return;
    if (wandRafRef.current) return; // a recompute is already scheduled for this frame
    wandRafRef.current = requestAnimationFrame(() => {
      wandRafRef.current = 0;
      const seed = wandSeedRef.current;
      const cache = wandSegsRef.current;
      if (!seed || !cache || cache.key !== selectionRef.current) return;
      const o = wandOptsRef.current;
      if (!o.sampleAll && !seed.layerId) return;
      const result = engine.magicWand(
        seed.layerId ?? "",
        seed.x,
        seed.y,
        { tolerance: o.tolerance, contiguous: o.contiguous, sampleAll: o.sampleAll },
        true, // reuse cached source pixels
      );
      if (result && result.rects.length) {
        wandSegsRef.current = { key: result.rects, segs: result.segments };
        onSelectionChange(result.rects);
        ensureAnts();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wand.tolerance, wand.contiguous, wand.sampleAll]);

  // Cancel any pending wand recompute on unmount only (a per-change cleanup
  // would cancel the coalesced frame before it runs).
  useEffect(() => () => cancelAnimationFrame(wandRafRef.current), []);

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
    paintRef.current = {
      undo: () => engine.undo(),
      redo: () => engine.redo(),
      jumpTo: (i) => engine.jumpTo(i),
      fillSelection: (layerId, rects, col, angle, pivot) =>
        engine.fillSelection(layerId, rects, col, angle, pivot),
      eraseSelection: (layerId, rects, angle, pivot) =>
        engine.eraseSelection(layerId, rects, angle, pivot),
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
      resizeImage: (w, h, ids, smooth) => engine.resizeImage(w, h, ids, smooth),
      applyAdjust: (layerId, adj, sel, angle, pivot) =>
        engine.applyAdjust(layerId, adj, sel, angle, pivot),
      commitAdjust: (layerId, adj, sel, angle, pivot) =>
        engine.commitAdjust(layerId, adj, sel, angle, pivot),
      cancelAdjust: () => engine.cancelAdjust(),
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

  const onCanvasPointerDown = (e: React.PointerEvent) => {
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
      if (!wand.sampleAll && !activeLayerId) return; // need a layer to sample
      e.preventDefault();
      const p = toDoc(e);
      wandSeedRef.current = { x: p.x, y: p.y, layerId: activeLayerId };
      const result = engine.magicWand(activeLayerId ?? "", p.x, p.y, {
        tolerance: wand.tolerance,
        contiguous: wand.contiguous,
        sampleAll: wand.sampleAll,
      });
      if (result && result.rects.length) {
        wandSegsRef.current = { key: result.rects, segs: result.segments };
        onSelectionChange(result.rects);
      }
      ensureAnts();
      return;
    }
    if (tool === "select") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      const p = toDoc(e);
      const sc = zoom / 100;
      if (selection.length >= 1) {
        const bbox = bboxOf(selection);
        const pivot = selectionPivot ?? { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
        const wandSel = wandSegsRef.current?.key === selectionRef.current;
        const zone = selectZone(p.x, p.y, selection, selectionAngle, pivot, sc, !wandSel);
        // 1) Grab the rotation anchor (the pivot) to move it.
        if (zone.kind === "anchor") {
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          anchorRef.current = true;
          setHoverCursor("grabbing");
          ensureAnts();
          return;
        }
        // 2) Resize handle — works on rotated selections (cursor → local frame).
        if (zone.kind === "resize") {
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          // "content" mode scales the lifted pixels (works on rotated selections
          // too — the scale is applied in the selection's own frame).
          let content = false;
          if (resizeMode === "content" && activeLayerId) {
            content = engine.beginFloatFromSelection(
              activeLayerId,
              selection,
              selectionAngle,
              selectionPivot,
            );
          }
          resizeRef.current = {
            rects: selection,
            bbox,
            edges: zone.edges,
            content,
            angle: selectionAngle,
            pivot,
          };
          // Lock a rotated selection's pivot so it can't drift to the new centre.
          if (selectionAngle !== 0 && !selectionPivot) onSelectionPivot(pivot);
          resizePreviewRef.current = selection;
          ensureAnts();
          return;
        }
        // 3) Rotation ring — a band just outside the box.
        if (zone.kind === "ring") {
          // Content mode rotates the pixels — lift the (possibly already-rotated)
          // selection region so it works even after a Bounds rotation.
          let content = false;
          if (resizeMode === "content" && activeLayerId) {
            content = engine.beginFloatFromSelection(
              activeLayerId,
              selection,
              selectionAngle,
              selectionPivot,
            );
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
          };
          rotatePreviewRef.current = selectionAngle;
          setHoverCursor(rotateCursorToward(p.x, p.y, pivot));
          ensureAnts();
          return;
        }
      }
      e.preventDefault();
      viewRef.current?.setPointerCapture(e.pointerId);
      marqueeRef.current = { x: p.x, y: p.y, additive: e.ctrlKey || e.metaKey };
      dragRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      ensureAnts();
      return;
    }
    if (tool === "brush" || tool === "eraser") {
      if (engine.isFloating) engine.commitFloat(); // merge before painting on it
      let layerId: string;
      if (tool === "eraser") {
        if (!activeLayerId) return; // nothing to erase
        layerId = activeLayerId;
      } else {
        layerId = ensureLayer(); // brush auto-creates a layer if none is selected
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
      );
    }
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    // Hover feedback for the select tool: rotate / resize / anchor cursor.
    if (
      toolRef.current === "select" &&
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
        const wandSel = wandSegsRef.current?.key === sel;
        const zone = selectZone(p.x, p.y, sel, selAngleRef.current, pivot, zoom / 100, !wandSel);
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
      const delta = Math.atan2(p.y - r.cy, p.x - r.cx) - r.start;
      const a = r.base + delta;
      rotatePreviewRef.current = a; // outline angle (absolute) for the marching ants
      // The lifted float already sits at the base-rotated position, so spin it by
      // the drag delta only — about the same pivot.
      if (r.content) engine.setFloatRotation(delta, { x: r.cx, y: r.cy });
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
      const nb = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      // Scale every selection rect proportionally within the new bounding box.
      const sx = nb.w / o.w;
      const sy = nb.h / o.h;
      resizePreviewRef.current = orig.map((r) => ({
        x: nb.x + (r.x - o.x) * sx,
        y: nb.y + (r.y - o.y) * sy,
        w: r.w * sx,
        h: r.h * sy,
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
    if (anchorRef.current) {
      anchorRef.current = false;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      return;
    }
    if (rotateRef.current) {
      const r = rotateRef.current;
      const a = rotatePreviewRef.current ?? r.base;
      rotateRef.current = null;
      rotatePreviewRef.current = null;
      const v = viewRef.current;
      if (v && v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
      if (!r.content) {
        // Bounds mode: persist the outline rotation; pixels untouched.
        onSelectionAngle(a);
        return;
      }
      engine.commitFloat(); // bake the rotated pixels
      // Keep the selection rotated to match the baked content: the rects are
      // unchanged, so persisting the pivot + total angle leaves the marquee
      // exactly bounding the rotated pixels (same as the Bounds-mode outcome).
      onSelectionPivot({ x: r.cx, y: r.cy });
      onSelectionAngle(a);
      return;
    }
    if (resizeRef.current) {
      const { content, bbox: o, angle } = resizeRef.current;
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
      if (content) {
        // Bake the scaled pixels (or restore them untouched if nothing changed).
        if (changed) {
          engine.commitFloat();
          // Keep the rotation when the selection was rotated.
          if (angle) onSelectionRects(committed);
          else onSelectionChange(committed);
        } else {
          engine.discardFloat();
        }
      } else if (committed.length) {
        // Keep the rotation when resizing a rotated selection; a new (upright)
        // marquee otherwise resets it.
        if (angle) onSelectionRects(committed);
        else onSelectionChange(committed);
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
    if (marqueeRef.current) {
      const additive = marqueeRef.current.additive;
      const rect = dragRectRef.current;
      marqueeRef.current = null;
      dragRectRef.current = null;
      if (rect && rect.w >= 1 && rect.h >= 1) {
        onSelectionChange(additive ? [...selection, rect] : [rect]);
      } else if (!additive) {
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

        <div className={styles.viewport} ref={viewportRef}>
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
                    : tool === "brush" ||
                        tool === "eraser" ||
                        tool === "select" ||
                        tool === "wand" ||
                        tool === "eyedropper"
                      ? "crosshair"
                      : "default"),
                // Crisp, individually-visible pixels when zoomed in; smooth when zoomed out.
                imageRendering: zoom >= 100 ? "pixelated" : "auto",
              }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onPointerLeave={() => {
                setHoverCursor(null);
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
