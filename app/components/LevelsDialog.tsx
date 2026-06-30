"use client";

import { useEffect, useRef, useState } from "react";
import { Pipette, Wand2, X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { Select } from "./Controls";
import type { ChannelHistogram } from "../lib/paint";
import type { ChannelKey, ChannelParams, ToneAdjustment } from "../lib/tone";

type LevelsSpec = Extract<ToneAdjustment, { type: "levels" }>;
export type EyedropKind = "black" | "gray" | "white";

const W = 300;
const HIST_H = 110;
const CHANNELS: { key: ChannelKey; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "r", label: "Red" },
  { key: "g", label: "Green" },
  { key: "b", label: "Blue" },
];
const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// gamma ↔ normalized midtone position (0.5 = γ1; left raises γ/lightens).
const gammaToT = (g: number) => clampN(0.5 - Math.log(g) / Math.log(9.99) / 2, 0, 1);
const tToGamma = (t: number) => clampN(Math.pow(9.99, (0.5 - t) * 2), 0.1, 9.99);

export default function LevelsDialog({
  spec,
  histogram,
  onChange,
  onDone,
  onCancel,
  onAuto,
  onEyedrop,
  doneLabel,
  cancelLabel,
  picking = false,
}: {
  spec: LevelsSpec;
  histogram: ChannelHistogram | null;
  onChange: (spec: LevelsSpec) => void;
  onDone: () => void;
  onCancel: () => void;
  onAuto: () => void;
  onEyedrop: (kind: EyedropKind) => void;
  doneLabel: string;
  cancelLabel: string;
  /** While sampling an eyedropper point, let clicks pass through to the canvas. */
  picking?: boolean;
}) {
  const [ch, setCh] = useState<ChannelKey>("rgb");
  const histRef = useRef<HTMLCanvasElement>(null);
  const inTrackRef = useRef<HTMLDivElement>(null);
  const outTrackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"black" | "gamma" | "white" | "oBlack" | "oWhite" | null>(null);

  const p = spec.channels[ch];
  const setP = (patch: Partial<ChannelParams>) => {
    const next = { ...p, ...patch };
    // keep inWhite > inBlack (min gap 1)
    if (next.inWhite <= next.inBlack) {
      if (patch.inBlack !== undefined) next.inBlack = next.inWhite - 1;
      else next.inWhite = next.inBlack + 1;
    }
    onChange({ ...spec, channels: { ...spec.channels, [ch]: next } });
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

  // histogram backdrop
  useEffect(() => {
    const cv = histRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = HIST_H * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, HIST_H);
    if (!histogram) return;
    const h = ch === "rgb" ? histogram.r.map((_, i) => (histogram.r[i] + histogram.g[i] + histogram.b[i]) / 3) : histogram[ch];
    let max = 1;
    for (let i = 1; i < 255; i++) if (h[i] > max) max = h[i];
    ctx.fillStyle = ch === "r" ? "rgba(248,113,113,0.7)" : ch === "g" ? "rgba(74,222,128,0.7)" : ch === "b" ? "rgba(96,165,250,0.7)" : "rgba(220,220,220,0.6)";
    for (let i = 0; i < 256; i++) {
      const bh = Math.min(1, h[i] / max) * (HIST_H - 2);
      ctx.fillRect((i / 256) * W, HIST_H - bh, W / 256 + 0.6, bh);
    }
  }, [histogram, ch]);

  const fracFromEvent = (e: React.PointerEvent, ref: React.RefObject<HTMLDivElement | null>) => {
    const r = ref.current!.getBoundingClientRect();
    return clampN((e.clientX - r.left) / r.width, 0, 1);
  };
  const onInDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const f = fracFromEvent(e, inTrackRef);
    const v = f * 255;
    // nearest of black / gamma / white
    const gammaPos = p.inBlack + gammaToT(p.gamma) * (p.inWhite - p.inBlack);
    const d = { black: Math.abs(v - p.inBlack), gamma: Math.abs(v - gammaPos), white: Math.abs(v - p.inWhite) };
    dragRef.current = d.black <= d.gamma && d.black <= d.white ? "black" : d.white <= d.gamma ? "white" : "gamma";
    onInMove(e);
  };
  const onInMove = (e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current === "oBlack" || dragRef.current === "oWhite") return;
    const v = fracFromEvent(e, inTrackRef) * 255;
    if (dragRef.current === "black") setP({ inBlack: clampN(Math.round(v), 0, p.inWhite - 1) });
    else if (dragRef.current === "white") setP({ inWhite: clampN(Math.round(v), p.inBlack + 1, 255) });
    else {
      const t = clampN((v - p.inBlack) / Math.max(1, p.inWhite - p.inBlack), 0, 1);
      setP({ gamma: tToGamma(t) });
    }
  };
  const onOutDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const v = fracFromEvent(e, outTrackRef) * 255;
    dragRef.current = Math.abs(v - p.outBlack) <= Math.abs(v - p.outWhite) ? "oBlack" : "oWhite";
    onOutMove(e);
  };
  const onOutMove = (e: React.PointerEvent) => {
    if (dragRef.current !== "oBlack" && dragRef.current !== "oWhite") return;
    const v = clampN(Math.round(fracFromEvent(e, outTrackRef) * 255), 0, 255);
    setP(dragRef.current === "oBlack" ? { outBlack: v } : { outWhite: v });
  };
  const onUp = () => (dragRef.current = null);

  const gammaPct = ((p.inBlack + gammaToT(p.gamma) * (p.inWhite - p.inBlack)) / 255) * 100;

  const numField = (label: string, value: number, set: (v: number) => void, step = 1, min = 0, max = 255) => (
    <label style={{ fontSize: 11, color: "var(--text-2)", display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => set(Number(e.target.value))} style={inputStyle} />
    </label>
  );

  return (
    <div className={styles.overlay} onMouseDown={onCancel} style={picking ? { pointerEvents: "none" } : undefined}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Levels" onMouseDown={(e) => e.stopPropagation()} style={{ width: 360 }}>
        <header className={styles.head}>
          <h2>Levels</h2>
          <button type="button" className={styles.close} onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>Channel</span>
            <div style={{ width: 110 }}>
              <Select block options={CHANNELS.map((c) => c.label)} value={CHANNELS.find((c) => c.key === ch)!.label} onChange={(l) => setCh(CHANNELS.find((c) => c.label === l)!.key)} />
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" className={styles.btn} onClick={onAuto} title="Auto contrast (per channel)">
              <Wand2 size={13} /> Auto
            </button>
          </div>

          <div style={{ width: W, margin: "0 auto" }}>
            <canvas ref={histRef} style={{ width: W, height: HIST_H, display: "block", borderBottom: "1px solid var(--border)", background: "var(--surface-3)" }} />
            {/* input track */}
            <div
              ref={inTrackRef}
              onPointerDown={onInDown}
              onPointerMove={onInMove}
              onPointerUp={onUp}
              style={{ position: "relative", height: 16, marginTop: 2, background: "linear-gradient(90deg,#000,#fff)", borderRadius: 2, touchAction: "none", cursor: "ew-resize" }}
            >
              <Tri leftPct={(p.inBlack / 255) * 100} color="#000" />
              <Tri leftPct={gammaPct} color="#888" />
              <Tri leftPct={(p.inWhite / 255) * 100} color="#fff" />
            </div>
            {/* output track */}
            <div
              ref={outTrackRef}
              onPointerDown={onOutDown}
              onPointerMove={onOutMove}
              onPointerUp={onUp}
              style={{ position: "relative", height: 16, marginTop: 10, background: "linear-gradient(90deg,#000,#fff)", borderRadius: 2, touchAction: "none", cursor: "ew-resize" }}
            >
              <Tri leftPct={(p.outBlack / 255) * 100} color="#000" />
              <Tri leftPct={(p.outWhite / 255) * 100} color="#fff" />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
            {numField("In Black", p.inBlack, (v) => setP({ inBlack: clampN(Math.round(v), 0, p.inWhite - 1) }))}
            {numField("Gamma", Number(p.gamma.toFixed(2)), (v) => setP({ gamma: clampN(v, 0.1, 9.99) }), 0.01, 0.1, 9.99)}
            {numField("In White", p.inWhite, (v) => setP({ inWhite: clampN(Math.round(v), p.inBlack + 1, 255) }))}
            {numField("Out Black", p.outBlack, (v) => setP({ outBlack: clampN(Math.round(v), 0, 255) }))}
            {numField("Out White", p.outWhite, (v) => setP({ outWhite: clampN(Math.round(v), 0, 255) }))}
          </div>

          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 12 }}>
            <span style={{ fontSize: 11, color: "var(--text-3)", alignSelf: "center" }}>Set point in image:</span>
            <button type="button" className={styles.btn} title="Black point" onClick={() => onEyedrop("black")}>
              <Pipette size={13} style={{ color: "#000", filter: "drop-shadow(0 0 1px #fff)" }} /> Black
            </button>
            <button type="button" className={styles.btn} title="Gray point (neutralize)" onClick={() => onEyedrop("gray")}>
              <Pipette size={13} style={{ color: "#888" }} /> Gray
            </button>
            <button type="button" className={styles.btn} title="White point" onClick={() => onEyedrop("white")}>
              <Pipette size={13} style={{ color: "#fff" }} /> White
            </button>
          </div>
        </div>
        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onDone}>{doneLabel}</button>
        </footer>
      </div>
    </div>
  );
}

/** A small triangle marker positioned along a track. */
function Tri({ leftPct, color }: { leftPct: number; color: string }) {
  return (
    <span
      style={{
        position: "absolute",
        top: 1,
        left: `${leftPct}%`,
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "5px solid transparent",
        borderRight: "5px solid transparent",
        borderTop: `8px solid ${color}`,
        filter: "drop-shadow(0 0 1px rgba(0,0,0,0.6))",
        pointerEvents: "none",
      }}
    />
  );
}

const inputStyle: React.CSSProperties = {
  width: 50,
  padding: "3px 4px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--surface-3)",
  color: "var(--text)",
  fontSize: 11,
  textAlign: "center",
};
