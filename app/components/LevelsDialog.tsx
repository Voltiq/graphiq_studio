"use client";

import { useEffect, useRef, useState } from "react";
import { Pipette, RotateCcw, Wand2, X } from "lucide-react";
import styles from "./LevelsDialog.module.scss";
import type { ChannelHistogram } from "../lib/paint";
import { IDENTITY_LEVELS, type ChannelKey, type ChannelParams, type ToneAdjustment } from "../lib/tone";

type LevelsSpec = Extract<ToneAdjustment, { type: "levels" }>;
export type EyedropKind = "black" | "gray" | "white";

const HIST_H = 112;
const CHANNELS: { key: ChannelKey; label: string }[] = [
  { key: "rgb", label: "RGB" },
  { key: "r", label: "Red" },
  { key: "g", label: "Green" },
  { key: "b", label: "Blue" },
];
const PICKS: { kind: EyedropKind; label: string; dot: string }[] = [
  { kind: "black", label: "Black point", dot: "#000000" },
  { kind: "gray", label: "Grey point", dot: "#808080" },
  { kind: "white", label: "White point", dot: "#ffffff" },
];
const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// gamma ↔ normalized midtone position (0.5 = γ1; left raises γ/lightens).
const gammaToT = (g: number) => clampN(0.5 - Math.log(g) / Math.log(9.99) / 2, 0, 1);
const tToGamma = (t: number) => clampN(Math.pow(9.99, (0.5 - t) * 2), 0.1, 9.99);

const isIdentity = (p: ChannelParams) =>
  p.inBlack === IDENTITY_LEVELS.inBlack &&
  p.gamma === IDENTITY_LEVELS.gamma &&
  p.inWhite === IDENTITY_LEVELS.inWhite &&
  p.outBlack === IDENTITY_LEVELS.outBlack &&
  p.outWhite === IDENTITY_LEVELS.outWhite;

type DragKind = "black" | "gamma" | "white" | "oBlack" | "oWhite";

/** A level-track pointer handle (SVG: point up, rounded base). */
function Handle({ pct, fill, dragging, label }: { pct: number; fill: string; dragging: boolean; label: string }) {
  return (
    <span
      className={styles.handle}
      data-drag={dragging}
      style={{ left: `${pct}%` }}
      role="img"
      aria-label={label}
    >
      <svg width="13" height="14" viewBox="0 0 13 14" aria-hidden>
        <path d="M6.5 1 L12 7.6 V11.4 Q12 13 10.4 13 H2.6 Q1 13 1 11.4 V7.6 Z" fill={fill} />
      </svg>
    </span>
  );
}

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
  const [drag, setDrag] = useState<DragKind | null>(null);
  const [pickKind, setPickKind] = useState<EyedropKind | null>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const inTrackRef = useRef<HTMLDivElement>(null);
  const outTrackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragKind | null>(null);

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
  const resetChannel = () =>
    onChange({ ...spec, channels: { ...spec.channels, [ch]: { ...IDENTITY_LEVELS } } });

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

  // The sampled-point highlight only lasts while the canvas is in pick mode.
  // Cleared DURING render rather than in an effect, so the highlight cannot
  // survive a frame past the mode ending.
  const [seenPicking, setSeenPicking] = useState(picking);
  if (seenPicking !== picking) {
    setSeenPicking(picking);
    if (!picking) setPickKind(null);
  }

  // Histogram backdrop: channel distribution + the clipped ranges (outside the
  // black/white input points) veiled, with accent markers on the boundaries.
  useEffect(() => {
    const cv = histRef.current;
    if (!cv) return;
    const cssW = cv.clientWidth || 384;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = HIST_H * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, HIST_H);
    if (!histogram) return;
    const h =
      ch === "rgb"
        ? histogram.r.map((_, i) => (histogram.r[i] + histogram.g[i] + histogram.b[i]) / 3)
        : histogram[ch];
    let max = 1;
    for (let i = 1; i < 255; i++) if (h[i] > max) max = h[i];
    ctx.fillStyle =
      ch === "r"
        ? "rgba(248,113,113,0.72)"
        : ch === "g"
          ? "rgba(74,222,128,0.72)"
          : ch === "b"
            ? "rgba(96,165,250,0.72)"
            : "rgba(150,146,139,0.8)"; // neutral — reads on the dark and light void
    for (let i = 0; i < 256; i++) {
      const bh = Math.min(1, h[i] / max) * (HIST_H - 4);
      ctx.fillRect((i / 256) * cssW, HIST_H - bh, cssW / 256 + 0.6, bh);
    }
    // Clipped ranges + boundary markers (tied to the black/white handles).
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1868db";
    const bx = (p.inBlack / 255) * cssW;
    const wx = (p.inWhite / 255) * cssW;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    if (p.inBlack > 0) ctx.fillRect(0, 0, bx, HIST_H);
    if (p.inWhite < 255) ctx.fillRect(wx, 0, cssW - wx, HIST_H);
    ctx.fillStyle = accent;
    if (p.inBlack > 0) ctx.fillRect(bx - 0.5, 0, 1, HIST_H);
    if (p.inWhite < 255) ctx.fillRect(wx - 0.5, 0, 1, HIST_H);
  }, [histogram, ch, p.inBlack, p.inWhite]);

  const fracFromEvent = (e: React.PointerEvent, ref: React.RefObject<HTMLDivElement | null>) => {
    const r = ref.current!.getBoundingClientRect();
    return clampN((e.clientX - r.left) / r.width, 0, 1);
  };
  const startDrag = (kind: DragKind) => {
    dragRef.current = kind;
    setDrag(kind);
  };
  const onInDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const f = fracFromEvent(e, inTrackRef);
    const v = f * 255;
    // nearest of black / gamma / white
    const gammaPos = p.inBlack + gammaToT(p.gamma) * (p.inWhite - p.inBlack);
    const d = { black: Math.abs(v - p.inBlack), gamma: Math.abs(v - gammaPos), white: Math.abs(v - p.inWhite) };
    startDrag(d.black <= d.gamma && d.black <= d.white ? "black" : d.white <= d.gamma ? "white" : "gamma");
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
    startDrag(Math.abs(v - p.outBlack) <= Math.abs(v - p.outWhite) ? "oBlack" : "oWhite");
    onOutMove(e);
  };
  const onOutMove = (e: React.PointerEvent) => {
    if (dragRef.current !== "oBlack" && dragRef.current !== "oWhite") return;
    const v = clampN(Math.round(fracFromEvent(e, outTrackRef) * 255), 0, 255);
    setP(dragRef.current === "oBlack" ? { outBlack: v } : { outWhite: v });
  };
  const onUp = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const gammaPct = ((p.inBlack + gammaToT(p.gamma) * (p.inWhite - p.inBlack)) / 255) * 100;

  const field = (
    label: string,
    value: number,
    set: (v: number) => void,
    step = 1,
    min = 0,
    max = 255,
  ) => (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        type="number"
        className={styles.fieldInput}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );

  return (
    <div
      className={styles.overlay}
      onMouseDown={onCancel}
      style={picking ? { pointerEvents: "none", background: "transparent", backdropFilter: "none" } : undefined}
    >
      <div
        className={styles.dialog}
        data-picking={picking}
        role="dialog"
        aria-modal="true"
        aria-label="Levels"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "INPUT") onDone();
        }}
      >
        <header className={styles.head}>
          <h2>Levels</h2>
          <button type="button" className={styles.close} onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {/* Channel chips + Auto / Reset */}
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
                  onClick={() => setCh(c.key)}
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
              onClick={resetChannel}
              title={`Reset the ${CHANNELS.find((c) => c.key === ch)!.label} channel`}
            >
              <RotateCcw size={12} /> Reset
            </button>
            <button type="button" className={styles.ghostBtn} onClick={onAuto} title="Auto contrast (per channel)">
              <Wand2 size={12} /> Auto
            </button>
          </div>

          {/* Input levels */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Input levels</span>
            <div className={styles.histWrap}>
              <canvas ref={histRef} height={HIST_H} className={styles.hist} style={{ height: HIST_H }} />
            </div>
            <div
              ref={inTrackRef}
              className={styles.trackWrap}
              onPointerDown={onInDown}
              onPointerMove={onInMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <div className={styles.bar}>
                {p.inBlack > 0 && <span className={styles.clip} style={{ left: 0, width: `${(p.inBlack / 255) * 100}%` }} />}
                {p.inWhite < 255 && (
                  <span className={styles.clip} style={{ right: 0, width: `${((255 - p.inWhite) / 255) * 100}%` }} />
                )}
              </div>
              <div className={styles.handles}>
                <Handle pct={(p.inBlack / 255) * 100} fill="#000000" dragging={drag === "black"} label="Input black point" />
                <Handle pct={gammaPct} fill="#8a8a8a" dragging={drag === "gamma"} label="Midtones (gamma)" />
                <Handle pct={(p.inWhite / 255) * 100} fill="#ffffff" dragging={drag === "white"} label="Input white point" />
              </div>
            </div>
            <div className={styles.fields}>
              {field("Black", p.inBlack, (v) => setP({ inBlack: clampN(Math.round(v), 0, p.inWhite - 1) }))}
              {field("Gamma", Number(p.gamma.toFixed(2)), (v) => setP({ gamma: clampN(v, 0.1, 9.99) }), 0.01, 0.1, 9.99)}
              {field("White", p.inWhite, (v) => setP({ inWhite: clampN(Math.round(v), p.inBlack + 1, 255) }))}
            </div>
          </div>

          {/* Output levels */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Output levels</span>
            <div
              ref={outTrackRef}
              className={styles.trackWrap}
              onPointerDown={onOutDown}
              onPointerMove={onOutMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <div className={styles.bar} />
              <div className={styles.handles}>
                <Handle pct={(p.outBlack / 255) * 100} fill="#000000" dragging={drag === "oBlack"} label="Output black" />
                <Handle pct={(p.outWhite / 255) * 100} fill="#ffffff" dragging={drag === "oWhite"} label="Output white" />
              </div>
            </div>
            <div className={styles.fields}>
              {field("Black", p.outBlack, (v) => setP({ outBlack: clampN(Math.round(v), 0, 255) }))}
              {field("White", p.outWhite, (v) => setP({ outWhite: clampN(Math.round(v), 0, 255) }))}
            </div>
          </div>

          {/* Eyedroppers */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Sample from image</span>
            <div className={styles.pickRow}>
              {PICKS.map((pk) => (
                <button
                  key={pk.kind}
                  type="button"
                  className={styles.pickChip}
                  data-active={picking && pickKind === pk.kind}
                  title={
                    pk.kind === "gray"
                      ? "Click a colour that should be neutral grey"
                      : `Click the image to set the ${pk.label.toLowerCase()}`
                  }
                  onClick={() => {
                    setPickKind(pk.kind);
                    onEyedrop(pk.kind);
                  }}
                >
                  <span className={styles.pickDot} style={{ background: pk.dot }} />
                  {pk.label}
                  <Pipette size={12} style={{ color: "var(--text-3)" }} />
                </button>
              ))}
            </div>
            {picking && pickKind && (
              <span className={styles.pickHint}>
                Click the image to sample the {PICKS.find((x) => x.kind === pickKind)!.label.toLowerCase()}…
              </span>
            )}
          </div>
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
