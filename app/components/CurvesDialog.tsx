"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair, Minus, RotateCcw, X } from "lucide-react";
import styles from "./CurvesDialog.module.scss";
import { Select } from "./Controls";
import type { ChannelHistogram } from "../lib/paint";
import {
  CURVE_PRESETS,
  IDENTITY_CURVE,
  curveSampler,
  type ChannelKey,
  type CurvePoint,
  type ToneAdjustment,
} from "../lib/tone";

type CurvesSpec = Extract<ToneAdjustment, { type: "curves" }>;

const PAD = 12;
const CHANNELS: { key: ChannelKey; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "r", label: "Red" },
  { key: "g", label: "Green" },
  { key: "b", label: "Blue" },
];
// Channel curve colours (canvas needs concrete values; RGB uses the theme ink,
// read from the computed style at draw time).
const LINE: Record<Exclude<ChannelKey, "rgb">, string> = { r: "#f87171", g: "#4ade80", b: "#60a5fa" };
const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const isIdentity = (pts: CurvePoint[]) =>
  pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 255 && pts[1].y === 255;

/** Name of the preset the points exactly match, else "Custom". */
function matchPreset(pts: CurvePoint[]): string {
  for (const [name, preset] of Object.entries(CURVE_PRESETS)) {
    if (
      preset.length === pts.length &&
      preset.every((p, i) => p.x === pts[i].x && p.y === pts[i].y)
    )
      return name;
  }
  return "Custom";
}

export default function CurvesDialog({
  spec,
  histogram,
  onChange,
  onDone,
  onCancel,
  targeting,
  onToggleTarget,
  onChannel,
  doneLabel,
  cancelLabel,
}: {
  spec: CurvesSpec;
  histogram: ChannelHistogram | null;
  onChange: (spec: CurvesSpec) => void;
  onDone: () => void;
  onCancel: () => void;
  /** Targeted adjustment armed: drags on the image drive the active channel. */
  targeting: boolean;
  onToggleTarget: () => void;
  /** Reports channel-tab switches (the targeted adjustment edits this channel). */
  onChannel: (ch: ChannelKey) => void;
  doneLabel: string;
  cancelLabel: string;
}) {
  const [ch, setCh] = useState<ChannelKey>("rgb");
  const [selRaw, setSel] = useState(0); // selected node index
  const [hover, setHover] = useState(-1);
  const [dragAxis, setDragAxis] = useState<"x" | "y" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number | null>(null);
  const dragAxisRef = useRef<"x" | "y" | null>(null);

  const points = spec.channels[ch];
  const sel = Math.min(selRaw, points.length - 1);
  const setChannel = (next: CurvePoint[]) =>
    onChange({ ...spec, channels: { ...spec.channels, [ch]: next } });
  const setPoints = (next: CurvePoint[]) => setChannel([...next].sort((a, b) => a.x - b.x));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Esc steps out of targeting first; a second Esc closes the dialog.
        if (targeting) onToggleTarget();
        else onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, targeting, onToggleTarget]);

  // ---- draw the graph (theme-aware: ink colours come from the live tokens) ----
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const size = cv.clientWidth || 360;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const root = getComputedStyle(document.documentElement);
    const ink = root.getPropertyValue("--text").trim() || "#f2f0ec";
    const voidBg = root.getPropertyValue("--canvas-void").trim() || "#121110";
    const accent = root.getPropertyValue("--accent").trim() || "#1868db";
    const line = ch === "rgb" ? ink : LINE[ch];
    const inner = size - PAD * 2;
    const gx = (x: number) => PAD + (x / 255) * inner;
    const gy = (y: number) => PAD + (1 - y / 255) * inner;

    // histogram backdrop (selected channel, or the average for RGB)
    if (histogram) {
      const h =
        ch === "rgb"
          ? histogram.r.map((_, i) => (histogram.r[i] + histogram.g[i] + histogram.b[i]) / 3)
          : histogram[ch];
      let max = 1;
      for (let i = 1; i < 255; i++) if (h[i] > max) max = h[i];
      ctx.fillStyle = "rgba(150,146,139,0.35)"; // neutral — reads on both themes
      for (let i = 0; i < 256; i++) {
        const bh = Math.min(1, h[i] / max) * inner;
        ctx.fillRect(gx(i), PAD + inner - bh, inner / 256 + 0.6, bh);
      }
    }

    // grid (quarters) + the linear baseline
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.08;
    for (let i = 1; i < 4; i++) {
      const p = PAD + (i / 4) * inner;
      ctx.beginPath();
      ctx.moveTo(p, PAD);
      ctx.lineTo(p, PAD + inner);
      ctx.moveTo(PAD, p);
      ctx.lineTo(PAD + inner, p);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.16;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(gx(0), gy(0));
    ctx.lineTo(gx(255), gy(255));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // the curve — plotted from the continuous spline (unrounded), one sample
    // per pixel, so the line is genuinely smooth (the applied LUT is this same
    // curve quantized to 256 integer steps)
    const f = curveSampler(points);
    const steps = Math.max(256, Math.ceil(inner));
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const px = PAD + (i / steps) * inner;
      const py = gy(f((i / steps) * 255));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // nodes: hollow → hover (larger) → selected (filled + accent halo)
    points.forEach((p, i) => {
      const x = gx(p.x);
      const y = gy(p.y);
      if (i === sel) {
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(x, y, i === sel ? 4.5 : i === hover ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === sel ? line : voidBg;
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }, [points, ch, sel, hover, histogram]);

  const toGraph = (e: React.PointerEvent) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const inner = r.width - PAD * 2;
    const x = ((e.clientX - r.left - PAD) / inner) * 255;
    const y = (1 - (e.clientY - r.top - PAD) / inner) * 255;
    return { x: clampN(x, 0, 255), y: clampN(y, 0, 255) };
  };
  const nodeAt = (gxv: number, gyv: number) => {
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(points[i].x - gxv) < 9 && Math.abs(points[i].y - gyv) < 14) return i;
    }
    return -1;
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    canvasRef.current?.focus();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const g = toGraph(e);
    const hit = nodeAt(g.x, g.y);
    if (e.button === 2) {
      // right-click deletes a non-endpoint node
      if (hit > 0 && hit < points.length - 1) {
        setPoints(points.filter((_, i) => i !== hit));
        setSel(0);
      }
      return;
    }
    if (hit >= 0) {
      dragRef.current = hit;
      setSel(hit);
      return;
    }
    // add a node at the clicked position
    const next = [...points, { x: Math.round(g.x), y: Math.round(g.y) }].sort((a, b) => a.x - b.x);
    const idx = next.findIndex((p) => p.x === Math.round(g.x) && p.y === Math.round(g.y));
    setChannel(next);
    setSel(idx);
    dragRef.current = idx;
  };
  const onMove = (e: React.PointerEvent) => {
    const i = dragRef.current;
    if (i == null) {
      const g = toGraph(e);
      setHover(nodeAt(g.x, g.y));
      return;
    }
    const g = toGraph(e);
    const isEnd = i === 0 || i === points.length - 1;
    const next = points.map((p, k) => {
      if (k !== i) return p;
      // endpoints stay on their vertical edge; interior nodes move freely but stay
      // strictly between their neighbours' x (keeps the curve a function).
      const x = isEnd ? p.x : Math.max(points[i - 1].x + 1, Math.min(points[i + 1].x - 1, Math.round(g.x)));
      return { x, y: Math.round(g.y) };
    });
    setChannel(next);
  };
  const onUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const node = points[sel];
  const isEndSel = sel === 0 || sel === points.length - 1;
  const setNodeField = (field: "x" | "y", v: number) => {
    const next = points.map((p, k) => {
      if (k !== sel) return p;
      if (field === "x") {
        if (isEndSel) return p;
        return { ...p, x: Math.max(points[sel - 1].x + 1, Math.min(points[sel + 1].x - 1, Math.round(v))) };
      }
      return { ...p, y: clampN(Math.round(v), 0, 255) };
    });
    setChannel(next);
  };
  const removeSel = () => {
    if (isEndSel) return;
    setPoints(points.filter((_, i) => i !== sel));
    setSel(0);
  };

  // Nudge the selected point with the arrow keys (Shift = ×10).
  const onGraphKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setNodeField("x", node.x + (e.key === "ArrowRight" ? step : -step));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setNodeField("y", node.y + (e.key === "ArrowUp" ? step : -step));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSel();
    }
  };

  // Axis-bar dragging: move the selected point along one axis only.
  const axisMove = (axis: "x" | "y") => (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (axis === "x") setNodeField("x", clampN((e.clientX - r.left) / r.width, 0, 1) * 255);
    else setNodeField("y", (1 - clampN((e.clientY - r.top) / r.height, 0, 1)) * 255);
  };
  const axisProps = (axis: "x" | "y") => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragAxisRef.current = axis;
      setDragAxis(axis);
      axisMove(axis)(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragAxisRef.current === axis) axisMove(axis)(e);
    },
    onPointerUp: () => {
      dragAxisRef.current = null;
      setDragAxis(null);
    },
    onPointerCancel: () => {
      dragAxisRef.current = null;
      setDragAxis(null);
    },
  });

  const svgFill = ch === "rgb" ? "var(--text)" : LINE[ch];
  const presetValue = matchPreset(points);

  return (
    <div
      className={styles.overlay}
      data-targeting={targeting}
      // While targeting, the blanket stops intercepting the canvas (clicks fall
      // through everywhere except the dialog itself, which re-enables events).
      style={targeting ? { pointerEvents: "none", background: "transparent", backdropFilter: "none" } : undefined}
      onMouseDown={targeting ? undefined : onCancel}
    >
      <div
        className={styles.dialog}
        data-targeting={targeting}
        role="dialog"
        aria-modal={!targeting}
        aria-label="Curves"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT") onDone();
        }}
      >
        <header className={styles.head}>
          <h2>Curves</h2>
          <button type="button" className={styles.close} onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {/* Channel chips + Reset + Preset */}
          <div className={styles.toolbar}>
            <div className={styles.chips} role="tablist" aria-label="Channel">
              {CHANNELS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={styles.chip}
                  data-channel={c.key}
                  data-active={ch === c.key}
                  role="tab"
                  aria-selected={ch === c.key}
                  onClick={() => {
                    setCh(c.key);
                    setSel(0);
                    setHover(-1);
                    onChannel(c.key);
                  }}
                >
                  <span className={styles.chipDot} />
                  {c.label}
                  {!isIdentity(spec.channels[c.key]) && <span className={styles.chipMark} />}
                </button>
              ))}
            </div>
            <div className={styles.spacer} />
            <button
              type="button"
              className={styles.ghostBtn}
              data-active={targeting}
              onClick={onToggleTarget}
              title={
                targeting
                  ? "Targeted adjustment is on — drag on the image to shape the curve (Esc exits)"
                  : "Targeted adjustment: click-drag on the image to move the curve at that tone"
              }
            >
              <Crosshair size={12} /> Target
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => {
                setChannel(IDENTITY_CURVE.map((p) => ({ ...p })));
                setSel(0);
              }}
              title={`Reset the ${CHANNELS.find((c) => c.key === ch)!.label} channel to linear`}
            >
              <RotateCcw size={12} /> Reset
            </button>
          </div>
          {targeting && (
            <p className={styles.targetHint}>
              Drag up or down on the image to brighten or darken the{" "}
              {CHANNELS.find((c) => c.key === ch)!.label} curve at that tone — Esc to finish.
            </p>
          )}

          {/* Preset — full-width row so the dropdown never clips */}
          <div className={styles.presetRow}>
            <span className={styles.presetLabel}>Preset</span>
            <div className={styles.presetSelect}>
              <Select
                block
                options={Object.keys(CURVE_PRESETS)}
                value={presetValue}
                onChange={(name) => {
                  const preset = CURVE_PRESETS[name];
                  if (preset) {
                    setChannel(preset.map((p) => ({ ...p })));
                    setSel(0);
                  }
                }}
              />
            </div>
          </div>

          {/* Graph flanked by the black→white axis bars */}
          <div className={styles.graphGrid}>
            <div className={styles.axisY} {...axisProps("y")} title="Drag to set the point's output">
              <span
                className={styles.axisHandleY}
                data-drag={dragAxis === "y"}
                style={{ top: `${(1 - node.y / 255) * 100}%` }}
              >
                <svg width="13" height="14" viewBox="0 0 13 14" aria-hidden>
                  <path d="M6.5 1 L12 7.6 V11.4 Q12 13 10.4 13 H2.6 Q1 13 1 11.4 V7.6 Z" fill={svgFill} />
                </svg>
              </span>
            </div>
            <div className={styles.graphWrap}>
              <canvas
                ref={canvasRef}
                className={styles.graph}
                data-hover={hover >= 0}
                tabIndex={0}
                aria-label="Tone curve — click to add a point, drag to move, arrows to nudge"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={() => setHover(-1)}
                onKeyDown={onGraphKey}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
            <div className={styles.axisX} {...axisProps("x")} title="Drag to set the point's input">
              <span
                className={styles.axisHandleX}
                data-drag={dragAxis === "x"}
                style={{ left: `${(node.x / 255) * 100}%` }}
              >
                <svg width="13" height="14" viewBox="0 0 13 14" aria-hidden>
                  <path d="M6.5 1 L12 7.6 V11.4 Q12 13 10.4 13 H2.6 Q1 13 1 11.4 V7.6 Z" fill={svgFill} />
                </svg>
              </span>
            </div>
          </div>

          {/* Selected point */}
          <div className={styles.pointRow}>
            <span className={styles.pointBadge}>
              Point {sel + 1} / {points.length}
            </span>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Input</span>
              <input
                type="number"
                className={styles.fieldInput}
                min={0}
                max={255}
                value={node?.x ?? 0}
                disabled={isEndSel}
                title={isEndSel ? "Endpoint inputs are fixed" : undefined}
                onChange={(e) => setNodeField("x", Number(e.target.value))}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Output</span>
              <input
                type="number"
                className={styles.fieldInput}
                min={0}
                max={255}
                value={node?.y ?? 0}
                onChange={(e) => setNodeField("y", Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              className={styles.removeBtn}
              disabled={isEndSel}
              onClick={removeSel}
              title={isEndSel ? "Endpoints can't be removed" : "Remove the selected point"}
            >
              <Minus size={12} /> Remove
            </button>
          </div>

          <p className={styles.hint}>
            Click the curve to add a point · drag to move · arrows nudge (Shift = ×10) ·
            right-click or ⌫ removes.
          </p>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onDone}>
            {doneLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
