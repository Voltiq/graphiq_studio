"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import styles from "./BlurGalleryDialog.module.scss";
import { Slider } from "./Controls";
import { BLUR_FX_LABELS, type BlurFxKind, type BlurFxScope, type BlurFxSettings } from "../lib/tools";

const TYPES: BlurFxKind[] = [
  "gaussian",
  "box",
  "bokeh",
  "motion",
  "zoom",
  "spin",
  "tiltshift",
  "surface",
  "spread",
];
const TYPE_DESC: Record<BlurFxKind, string> = {
  gaussian: "Smooth, natural softening.",
  box: "Uniform square average — fast and flat.",
  motion: "Directional streaks along an angle.",
  zoom: "Radial streaks away from a centre point.",
  spin: "Circular streaks around a centre point.",
  bokeh: "Soft, round lens-like blur.",
  tiltshift: "A sharp focus band fading to blur — the miniature look.",
  surface: "Smooths texture while keeping edges crisp.",
  spread: "Frosted-glass scatter — pixels trade places with neighbours.",
};
const SCOPES: { value: BlurFxScope; label: string }[] = [
  { value: "layer", label: "Active layer" },
  { value: "canvas", label: "Whole canvas" },
];

const PW = 500;
const PH = 380;

/** Primary slider's label + range for each blur kind. */
function amountMeta(kind: BlurFxKind): { label: string; min: number; max: number; unit: string } {
  switch (kind) {
    case "motion":
      return { label: "Length", min: 1, max: 200, unit: "px" };
    case "zoom":
      return { label: "Amount", min: 1, max: 100, unit: "%" };
    case "spin":
      return { label: "Angle", min: 1, max: 180, unit: "°" };
    case "bokeh":
      return { label: "Radius", min: 1, max: 60, unit: "px" };
    case "tiltshift":
      return { label: "Radius", min: 1, max: 100, unit: "px" };
    case "surface":
      return { label: "Radius", min: 1, max: 50, unit: "px" };
    case "spread":
      return { label: "Amount", min: 1, max: 60, unit: "px" };
    default:
      return { label: "Radius", min: 1, max: 200, unit: "px" };
  }
}

/** Kinds whose geometry is set by dragging the preview. */
const dragKind = (k: BlurFxKind) => k === "zoom" || k === "spin" || k === "tiltshift";
const DRAG_HINT: Partial<Record<BlurFxKind, string>> = {
  zoom: "Drag the preview to set the blur centre.",
  spin: "Drag the preview to set the rotation centre.",
  tiltshift: "Drag the preview to move the focus band.",
};

export default function BlurGalleryDialog({
  settings,
  onChange,
  onApply,
  onClose,
  hasSelection,
  preview,
}: {
  settings: BlurFxSettings;
  onChange: (patch: Partial<BlurFxSettings>) => void;
  onApply: () => void;
  onClose: () => void;
  hasSelection: boolean;
  preview: HTMLCanvasElement | null;
}) {
  const meta = amountMeta(settings.kind);
  const draggable = dragKind(settings.kind);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // How the document is letterboxed into the fixed preview pane.
  const layout = () => {
    if (!preview || !preview.width || !preview.height) return null;
    const s = Math.min(PW / preview.width, PH / preview.height);
    const dw = preview.width * s;
    const dh = preview.height * s;
    return { s, dw, dh, ox: (PW - dw) / 2, oy: (PH - dh) / 2 };
  };

  // Drag on the preview to set the zoom/spin/tilt-shift anchor (normalized).
  const setAnchorFromPointer = (e: React.PointerEvent) => {
    const lay = layout();
    const cnv = canvasRef.current;
    if (!lay || !cnv) return;
    const r = cnv.getBoundingClientRect();
    const px = ((e.clientX - r.left) * PW) / r.width;
    const py = ((e.clientY - r.top) * PH) / r.height;
    const nx = Math.max(0, Math.min(1, (px - lay.ox) / lay.dw));
    const ny = Math.max(0, Math.min(1, (py - lay.oy) / lay.dh));
    onChange({ anchor: { x: nx, y: ny } });
  };

  // Escape/Enter close/apply — captured (before the editor's global shortcuts) so
  // they don't also clear the selection etc. while the gallery is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onApply();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onApply]);

  // Draw the previewed composite letterboxed into the pane, plus the geometry
  // guides: a centre reticle for zoom/spin, the focus-band lines for tilt-shift.
  useEffect(() => {
    const cnv = canvasRef.current;
    const ctx = cnv?.getContext("2d");
    if (!cnv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (cnv.width !== Math.round(PW * dpr)) {
      cnv.width = Math.round(PW * dpr);
      cnv.height = Math.round(PH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Checkerboard (transparency).
    const t = 10;
    for (let y = 0; y < PH; y += t) {
      for (let x = 0; x < PW; x += t) {
        ctx.fillStyle = ((x / t + y / t) & 1) === 0 ? "#cfcfcf" : "#a9a9a9";
        ctx.fillRect(x, y, t, t);
      }
    }
    const lay = layout();
    if (preview && lay) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(preview, lay.ox, lay.oy, lay.dw, lay.dh);
    }
    if (!lay) return;
    const mx = lay.ox + settings.anchor.x * lay.dw;
    const my = lay.oy + settings.anchor.y * lay.dh;
    // dark-under-white double stroke, clipped to the artwork
    const dual = (draw: () => void) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      draw();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      draw();
    };

    if (settings.kind === "zoom" || settings.kind === "spin") {
      dual(() => {
        ctx.beginPath();
        ctx.arc(mx, my, 8, 0, Math.PI * 2);
        ctx.moveTo(mx - 12, my);
        ctx.lineTo(mx + 12, my);
        ctx.moveTo(mx, my - 12);
        ctx.lineTo(mx, my + 12);
        ctx.stroke();
      });
    }

    if (settings.kind === "tiltshift" && preview) {
      // Focus-band guides: centre line + band edges (solid) + feather edges
      // (dashed), through the anchor at the configured angle.
      const rad = (settings.angle * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const nx = -dy;
      const ny = dx;
      const base = Math.min(preview.width, preview.height) * lay.s;
      const bandPx = (settings.band / 100) * base * 0.5;
      const featherPx = Math.max(1, (settings.feather / 100) * base * 0.5);
      const L = PW + PH; // long enough to cross the pane at any angle
      const line = (off: number) => {
        const cx = mx + nx * off;
        const cy = my + ny * off;
        ctx.beginPath();
        ctx.moveTo(cx - dx * L, cy - dy * L);
        ctx.lineTo(cx + dx * L, cy + dy * L);
        ctx.stroke();
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(lay.ox, lay.oy, lay.dw, lay.dh);
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
      // centre grab dot
      dual(() => {
        ctx.beginPath();
        ctx.arc(mx, my, 5, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preview,
    settings.kind,
    settings.anchor.x,
    settings.anchor.y,
    settings.angle,
    settings.band,
    settings.feather,
  ]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Blur Gallery"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Blur Gallery</h2>
          <span className={styles.kindChip}>{BLUR_FX_LABELS[settings.kind]}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.preview}>
            {!preview && <span className={styles.loading}>Rendering preview…</span>}
            <canvas
              ref={canvasRef}
              style={{ width: PW, height: PH, cursor: draggable ? "crosshair" : "default" }}
              onPointerDown={
                draggable
                  ? (e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setAnchorFromPointer(e);
                    }
                  : undefined
              }
              onPointerMove={
                draggable
                  ? (e) => {
                      if (e.buttons) setAnchorFromPointer(e);
                    }
                  : undefined
              }
            />
          </div>

          <div className={styles.controls}>
            <section className={styles.section}>
              <span className={styles.sectionTitle}>Blur type</span>
              <div className={styles.typeGrid}>
                {TYPES.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={styles.typeBtn}
                    data-active={settings.kind === k}
                    title={TYPE_DESC[k]}
                    onClick={() =>
                      onChange({
                        kind: k,
                        amount: Math.max(
                          amountMeta(k).min,
                          Math.min(amountMeta(k).max, settings.amount),
                        ),
                      })
                    }
                  >
                    {BLUR_FX_LABELS[k]}
                  </button>
                ))}
              </div>
              <span className={styles.desc}>{TYPE_DESC[settings.kind]}</span>
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Settings</span>
              <Slider
                label={meta.label}
                min={meta.min}
                max={meta.max}
                unit={meta.unit}
                value={settings.amount}
                onChange={(n) => onChange({ amount: n })}
              />
              {(settings.kind === "motion" || settings.kind === "tiltshift") && (
                <Slider
                  label="Angle"
                  min={0}
                  max={360}
                  unit="°"
                  value={settings.angle}
                  onChange={(n) => onChange({ angle: n })}
                />
              )}
              {settings.kind === "tiltshift" && (
                <>
                  <Slider
                    label="Focus size"
                    min={0}
                    max={100}
                    unit="%"
                    value={settings.band}
                    onChange={(n) => onChange({ band: n })}
                  />
                  <Slider
                    label="Feather"
                    min={2}
                    max={100}
                    unit="%"
                    value={settings.feather}
                    onChange={(n) => onChange({ feather: n })}
                  />
                </>
              )}
              {settings.kind === "surface" && (
                <Slider
                  label="Threshold"
                  min={1}
                  max={100}
                  unit="%"
                  value={settings.threshold}
                  onChange={(n) => onChange({ threshold: n })}
                />
              )}
              {draggable && <span className={styles.desc}>{DRAG_HINT[settings.kind]}</span>}
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Apply to</span>
              <div className={styles.segRow}>
                {SCOPES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={styles.segBtn}
                    data-active={settings.scope === s.value}
                    onClick={() => onChange({ scope: s.value })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {hasSelection && (
                <span className={styles.desc}>A selection is active — the blur is limited to it.</span>
              )}
            </section>
          </div>
        </div>

        <footer className={styles.foot}>
          <span className={styles.footNote}>Enter applies · Esc cancels</span>
          <div className={styles.footSpacer} />
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onApply}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
