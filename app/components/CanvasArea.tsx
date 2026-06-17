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
  type LayerMeta,
  type PendingPaste,
} from "../lib/paint";

const ZOOM_STEPS = [
  12, 25, 33, 50, 67, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200,
];

interface DocTab {
  id: string;
  name: string;
}

const MIN_ZOOM = 12;
const MAX_ZOOM = 3200;

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
  moveMode,
  resizeMode,
  resizeSmooth,
  sampleSize,
  sampleAllLayers,
  onPick,
  pendingPaste,
  onPasteDone,
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
  layers: LayerMeta[];
  activeLayerId: string | null;
  ensureLayer: () => string;
  selection: Rect[];
  onSelectionChange: (rects: Rect[]) => void;
  moveMode: MoveMode;
  resizeMode: SelectResizeMode;
  resizeSmooth: boolean;
  sampleSize: number;
  sampleAllLayers: boolean;
  onPick: (hex: string) => void;
  pendingPaste: PendingPaste | null;
  onPasteDone: () => void;
  paintRef: RefObject<EngineHandle | null>;
  onHistory: (s: HistorySummary) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const paintingRef = useRef(false);
  // Marquee selection drag state + marching-ants animation.
  const panR = useRef(pan);
  panR.current = pan;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
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
  } | null>(null);
  const resizePreviewRef = useRef<Rect[] | null>(null);
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
    if (ov.width !== vp.clientWidth || ov.height !== vp.clientHeight) {
      ov.width = vp.clientWidth;
      ov.height = vp.clientHeight;
    }
    ctx.clearRect(0, 0, ov.width, ov.height);
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
    const segs = rects.length ? unionSegments(rects) : [];
    if (segs.length) {
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Two passes (black + white, offset by half the dash) make the classic ants.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.75)" : "#fff";
        const phase = pass === 0 ? 0 : 4;
        for (const seg of segs) {
          const sx1 = Math.round(p.x + seg.x1 * s) + 0.5;
          const sy1 = Math.round(p.y + seg.y1 * s) + 0.5;
          const sx2 = Math.round(p.x + seg.x2 * s) + 0.5;
          const sy2 = Math.round(p.y + seg.y2 * s) + 0.5;
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

    // --- resize handles on the bounding box of the marquee selection ---
    if (toolRef.current === "select") {
      const handleRects =
        rz ?? (selectionRef.current.length >= 1 && !m && !mv ? selectionRef.current : null);
      if (handleRects && handleRects.length) {
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        for (const h of rectHandles(bboxOf(handleRects))) {
          const hx = Math.round(p.x + h.x * s);
          const hy = Math.round(p.y + h.y * s);
          ctx.beginPath();
          ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.stroke();
        }
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
      setPanRef.current((p) => clampHere(p.x, p.y, scaleRef.current, vp));
    });
    ro.observe(vp);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire the paint engine to the view canvas (once).
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    engine.setView(v);
    engine.setDoc(widthRef.current, heightRef.current, layersRef.current.map((l) => l.id));
    engine.onChange = scheduleComposite;
    engine.onHistory = (s) => onHistoryRef.current(s);
    paintRef.current = {
      undo: () => engine.undo(),
      redo: () => engine.redo(),
      jumpTo: (i) => engine.jumpTo(i),
      fillSelection: (layerId, rects, col) => engine.fillSelection(layerId, rects, col),
      eraseSelection: (layerId, rects) => engine.eraseSelection(layerId, rects),
      copyRegion: (rects) => engine.copyRegion(rects),
      isFloating: () => engine.isFloating,
      commitFloat: () => engine.commitFloat(),
      discardFloat: () => engine.discardFloat(),
    };
    engine.syncHistory();
    scheduleComposite();
    return () => {
      paintRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize the engine buffers when the document size changes; recomposite.
  useEffect(() => {
    engine.setDoc(width, height, layers.map((l) => l.id));
    scheduleComposite();
  }, [width, height, layers, engine, scheduleComposite]);

  // Apply a queued paste once its target document is active and sized.
  useEffect(() => {
    if (!pendingPaste || pendingPaste.docId !== activeId) return;
    engine.setDoc(width, height, layers.map((l) => l.id));
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

  // Recomposite when layer metadata / active document changes.
  useEffect(() => {
    scheduleComposite();
  }, [layers, activeLayerId, scheduleComposite]);

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
          floating = engine.beginFloatFromSelection(activeLayerId, selection);
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
    if (tool === "select") {
      if (engine.isFloating) engine.commitFloat(); // merge before reselecting
      const p = toDoc(e);
      // Grab a resize handle (on the selection's bounding box) if pressed.
      if (selection.length >= 1) {
        const bbox = bboxOf(selection);
        const edges = hitHandle(bbox, p.x, p.y, 10 / (zoom / 100));
        if (edges) {
          e.preventDefault();
          viewRef.current?.setPointerCapture(e.pointerId);
          // In "content" mode, lift the selected pixels into a scalable float.
          let content = false;
          if (resizeMode === "content" && activeLayerId) {
            content = engine.beginFloatFromSelection(activeLayerId, selection);
          }
          resizeRef.current = { rects: selection, bbox, edges, content };
          resizePreviewRef.current = selection;
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
      );
    }
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      const p = toDoc(e);
      const { rects: orig, bbox: o, edges } = resizeRef.current;
      // Move the dragged edges of the bounding box; keep it non-degenerate
      // (no flipping) and clamped to the canvas.
      let x0 = o.x;
      let y0 = o.y;
      let x1 = o.x + o.w;
      let y1 = o.y + o.h;
      if (edges.left) x0 = Math.min(p.x, x1 - 1);
      if (edges.right) x1 = Math.max(p.x, x0 + 1);
      if (edges.top) y0 = Math.min(p.y, y1 - 1);
      if (edges.bottom) y1 = Math.max(p.y, y0 + 1);
      x0 = clamp(x0, 0, width);
      x1 = clamp(x1, 0, width);
      y0 = clamp(y0, 0, height);
      y1 = clamp(y1, 0, height);
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
      // In content mode, scale the lifted pixels to match the new bounds.
      if (resizeRef.current.content) engine.setFloatDst(nb, resizeSmooth);
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
      dragRectRef.current = normalizeRect(m.x, m.y, p.x, p.y, width, height);
      return;
    }
    if (!paintingRef.current) return;
    const p = toDoc(e);
    engine.moveStroke(p.x, p.y);
  };
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      const { content, bbox: o } = resizeRef.current;
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
          onSelectionChange(committed);
        } else {
          engine.discardFloat();
        }
      } else if (committed.length) {
        onSelectionChange(committed);
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

  const step = (dir: 1 | -1) => {
    const next = ZOOM_STEPS.filter((z) => (dir === 1 ? z > zoom : z < zoom));
    if (next.length) onZoomChange(dir === 1 ? next[0] : next[next.length - 1]);
  };

  const scale = zoom / 100;

  // Tick marks for the rulers.
  const hTicks = Array.from({ length: 40 }, (_, i) => i);
  const vTicks = Array.from({ length: 28 }, (_, i) => i);

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

      <div className={styles.stageWrap}>
        <div className={styles.rulerCorner} />
        <div className={styles.rulerH}>
          {hTicks.map((i) => (
            <span key={i} className={styles.tick} data-major={i % 5 === 0}>
              {i % 5 === 0 && <em>{i * 100}</em>}
            </span>
          ))}
        </div>
        <div className={styles.rulerV}>
          {vTicks.map((i) => (
            <span key={i} className={styles.tick} data-major={i % 5 === 0}>
              {i % 5 === 0 && <em>{i * 100}</em>}
            </span>
          ))}
        </div>

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
              ref={viewRef}
              className={styles.view}
              width={width}
              height={height}
              style={{
                cursor:
                  tool === "move"
                    ? "move"
                    : tool === "brush" ||
                        tool === "eraser" ||
                        tool === "select" ||
                        tool === "eyedropper"
                      ? "crosshair"
                      : "default",
                // Crisp, individually-visible pixels when zoomed in; smooth when zoomed out.
                imageRendering: zoom >= 100 ? "pixelated" : "auto",
              }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onPointerLeave={() => {
                if (!pickingRef.current) {
                  hoverRef.current = null;
                  ensureAnts();
                }
              }}
            />
          </div>
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
