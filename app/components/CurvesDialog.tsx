"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { Select } from "./Controls";
import type { ChannelHistogram } from "../lib/paint";
import {
  CURVE_PRESETS,
  curveLUT,
  type ChannelKey,
  type CurvePoint,
  type ToneAdjustment,
} from "../lib/tone";

type CurvesSpec = Extract<ToneAdjustment, { type: "curves" }>;

const G = 256; // logical graph units
const SIZE = 280; // px (the square graph)
const PAD = 10;
const CHANNELS: { key: ChannelKey; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "r", label: "Red" },
  { key: "g", label: "Green" },
  { key: "b", label: "Blue" },
];
const LINE: Record<ChannelKey, string> = { rgb: "#e6e6e6", r: "#f87171", g: "#4ade80", b: "#60a5fa" };

export default function CurvesDialog({
  spec,
  histogram,
  onChange,
  onDone,
  onCancel,
  doneLabel,
  cancelLabel,
}: {
  spec: CurvesSpec;
  histogram: ChannelHistogram | null;
  onChange: (spec: CurvesSpec) => void;
  onDone: () => void;
  onCancel: () => void;
  doneLabel: string;
  cancelLabel: string;
}) {
  const [ch, setCh] = useState<ChannelKey>("rgb");
  const [sel, setSel] = useState(0); // selected node index
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number | null>(null);

  const points = spec.channels[ch];
  const setPoints = (next: CurvePoint[]) => {
    const sorted = [...next].sort((a, b) => a.x - b.x);
    onChange({ ...spec, channels: { ...spec.channels, [ch]: sorted } });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // ---- draw the graph ----
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const inner = SIZE - PAD * 2;
    const gx = (x: number) => PAD + (x / 255) * inner;
    const gy = (y: number) => PAD + (1 - y / 255) * inner;

    // histogram backdrop (selected channel, or luma-ish average for RGB)
    if (histogram) {
      const h = ch === "rgb" ? histogram.r.map((_, i) => (histogram.r[i] + histogram.g[i] + histogram.b[i]) / 3) : histogram[ch];
      let max = 1;
      for (let i = 1; i < 255; i++) if (h[i] > max) max = h[i];
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      for (let i = 0; i < 256; i++) {
        const bh = Math.min(1, h[i] / max) * inner;
        ctx.fillRect(gx(i), PAD + inner - bh, inner / 256 + 0.6, bh);
      }
    }
    // grid (quarters) + baseline
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = PAD + (i / 4) * inner;
      ctx.beginPath();
      ctx.moveTo(p, PAD);
      ctx.lineTo(p, PAD + inner);
      ctx.moveTo(PAD, p);
      ctx.lineTo(PAD + inner, p);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(gx(0), gy(0));
    ctx.lineTo(gx(255), gy(255));
    ctx.stroke();

    // the curve (sample the LUT we actually apply)
    const lut = curveLUT(points);
    ctx.strokeStyle = LINE[ch];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const px = gx(x);
      const py = gy(lut[x]);
      if (x === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // nodes
    points.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(gx(p.x), gy(p.y), i === sel ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === sel ? LINE[ch] : "var(--surface-2)";
      ctx.fill();
      ctx.strokeStyle = LINE[ch];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }, [points, ch, sel, histogram]);

  const toGraph = (e: React.PointerEvent) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const inner = SIZE - PAD * 2;
    const x = ((e.clientX - r.left - PAD) / inner) * 255;
    const y = (1 - (e.clientY - r.top - PAD) / inner) * 255;
    return { x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(255, y)) };
  };
  const nodeAt = (gxv: number, gyv: number) => {
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(points[i].x - gxv) < 9 && Math.abs(points[i].y - gyv) < 14) return i;
    }
    return -1;
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
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
    onChange({ ...spec, channels: { ...spec.channels, [ch]: next } });
    setSel(idx);
    dragRef.current = idx;
  };
  const onMove = (e: React.PointerEvent) => {
    const i = dragRef.current;
    if (i == null) return;
    const g = toGraph(e);
    const isEnd = i === 0 || i === points.length - 1;
    const next = points.map((p, k) => {
      if (k !== i) return p;
      // endpoints stay on their vertical edge; interior nodes move freely but stay
      // strictly between their neighbours' x (keeps the curve a function).
      const x = isEnd ? p.x : Math.max(points[i - 1].x + 1, Math.min(points[i + 1].x - 1, Math.round(g.x)));
      return { x, y: Math.round(g.y) };
    });
    onChange({ ...spec, channels: { ...spec.channels, [ch]: next } });
  };
  const onUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const node = points[sel];
  const setNodeField = (field: "x" | "y", v: number) => {
    const isEnd = sel === 0 || sel === points.length - 1;
    const next = points.map((p, k) => {
      if (k !== sel) return p;
      if (field === "x") {
        if (isEnd) return p;
        return { ...p, x: Math.max(points[sel - 1].x + 1, Math.min(points[sel + 1].x - 1, Math.round(v))) };
      }
      return { ...p, y: Math.max(0, Math.min(255, Math.round(v))) };
    });
    onChange({ ...spec, channels: { ...spec.channels, [ch]: next } });
  };

  return (
    <div className={styles.overlay} onMouseDown={onCancel}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Curves" onMouseDown={(e) => e.stopPropagation()} style={{ width: 360 }}>
        <header className={styles.head}>
          <h2>Curves</h2>
          <button type="button" className={styles.close} onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Channel</span>
            <div style={{ width: 110 }}>
              <Select block options={CHANNELS.map((c) => c.label)} value={CHANNELS.find((c) => c.key === ch)!.label} onChange={(l) => { setCh(CHANNELS.find((c) => c.label === l)!.key); setSel(0); }} />
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ width: 130 }}>
              <Select
                block
                options={["Preset…", ...Object.keys(CURVE_PRESETS)]}
                value="Preset…"
                onChange={(name) => {
                  const preset = CURVE_PRESETS[name];
                  if (preset) {
                    onChange({ ...spec, channels: { ...spec.channels, [ch]: preset.map((p) => ({ ...p })) } });
                    setSel(0);
                  }
                }}
              />
            </div>
          </div>
          <canvas
            ref={canvasRef}
            style={{ width: SIZE, height: SIZE, display: "block", margin: "0 auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface-3)", touchAction: "none", cursor: "crosshair" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", marginTop: 10 }}>
            <label style={{ fontSize: 12, color: "var(--text-2)", display: "flex", gap: 6, alignItems: "center" }}>
              Input
              <input type="number" min={0} max={255} value={node?.x ?? 0} onChange={(e) => setNodeField("x", Number(e.target.value))} style={inputStyle} />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-2)", display: "flex", gap: 6, alignItems: "center" }}>
              Output
              <input type="number" min={0} max={255} value={node?.y ?? 0} onChange={(e) => setNodeField("y", Number(e.target.value))} style={inputStyle} />
            </label>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-3)", textAlign: "center", marginTop: 6 }}>
            Click to add a point · drag to move · right-click a point to delete.
          </p>
        </div>
        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onDone}>{doneLabel}</button>
        </footer>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: 56,
  padding: "3px 6px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--surface-3)",
  color: "var(--text)",
  fontSize: 12,
};
