"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./BlurGalleryDialog.module.scss";
import { Slider, Toggle } from "./Controls";
import { meshLines, renderLiquify, type LiquifyImage } from "../lib/liquify";
import {
  WARP_PRESETS,
  cornersOf,
  warpMesh,
  warpSpecActive,
  type WarpKind,
  type WarpSpec,
} from "../lib/warp";
import type { Pt } from "../lib/homography";

const PW = 560;
const PH = 430;
/** Corner hit radius in preview px. */
const GRAB = 14;

/**
 * Warp & Perspective Warp — mesh transforms for a pixel layer.
 *
 * The preview renders at pane resolution rather than document resolution:
 * `renderLiquify` takes a doc→source scale precisely so a mesh built in document
 * space can drive a downscaled preview, which keeps dragging a corner
 * interactive on a 12 MP layer. Apply re-renders once at full resolution.
 */
export default function WarpDialog({
  layerName,
  source,
  docWidth,
  docHeight,
  onApply,
  onClose,
}: {
  layerName: string;
  /** Full-res copy of the layer raster (doc-sized). */
  source: HTMLCanvasElement;
  docWidth: number;
  docHeight: number;
  onApply: (result: HTMLCanvasElement) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<WarpKind>("preset");
  const [style, setStyle] = useState(WARP_PRESETS[0].id);
  const [bend, setBend] = useState(30);
  const [distH, setDistH] = useState(0);
  const [distV, setDistV] = useState(0);
  const [corners, setCorners] = useState<Pt[]>(() => cornersOf(docWidth, docHeight));
  const [showMesh, setShowMesh] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<number>(-1);

  // Letterbox the document into the fixed pane (same layout as Liquify).
  const layout = useMemo(() => {
    const f = Math.min(PW / docWidth, PH / docHeight);
    const dw = Math.max(1, Math.round(docWidth * f));
    const dh = Math.max(1, Math.round(docHeight * f));
    return { f: dw / docWidth, dw, dh, ox: (PW - dw) / 2, oy: (PH - dh) / 2 };
  }, [docWidth, docHeight]);

  /** The layer downscaled to pane size, read once — the preview resamples from
   *  this rather than from the full-resolution layer on every frame. */
  const preview = useMemo<LiquifyImage | null>(() => {
    const c = document.createElement("canvas");
    c.width = layout.dw;
    c.height = layout.dh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, layout.dw, layout.dh);
    const d = ctx.getImageData(0, 0, layout.dw, layout.dh);
    return { width: d.width, height: d.height, data: d.data as Uint8ClampedArray<ArrayBuffer> };
  }, [source, layout.dw, layout.dh]);

  const spec: WarpSpec = useMemo(
    () => ({ kind, style, bend, distH, distV, corners }),
    [kind, style, bend, distH, distV, corners],
  );

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !preview) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(PW * dpr) || cv.height !== Math.round(PH * dpr)) {
      cv.width = Math.round(PW * dpr);
      cv.height = Math.round(PH * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PW, PH);

    const mesh = warpMesh(spec, docWidth, docHeight);
    const out = renderLiquify(preview, mesh, layout.f);
    const tmp = document.createElement("canvas");
    tmp.width = out.width;
    tmp.height = out.height;
    tmp.getContext("2d")!.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    ctx.drawImage(tmp, layout.ox, layout.oy);

    const toPane = (p: Pt) => ({ x: layout.ox + p.x * layout.f, y: layout.oy + p.y * layout.f });
    if (showMesh) {
      ctx.strokeStyle = "rgba(80,160,255,0.55)";
      ctx.lineWidth = 1;
      for (const line of meshLines(mesh, 4)) {
        ctx.beginPath();
        line.forEach((p, i) => {
          const q = toPane(p);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        ctx.stroke();
      }
    }
    if (kind === "perspective") {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      corners.forEach((p, i) => {
        const q = toPane(p);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.stroke();
      for (const p of corners) {
        const q = toPane(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "#2b7fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }, [spec, preview, layout, showMesh, kind, corners, docWidth, docHeight]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  const paneToDoc = (e: React.PointerEvent) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: (e.clientX - r.left - layout.ox) / layout.f,
      y: (e.clientY - r.top - layout.oy) / layout.f,
    };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (kind !== "perspective") return;
    const p = paneToDoc(e);
    let best = -1;
    let bestD = GRAB / layout.f;
    corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return;
    dragRef.current = best;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current < 0) return;
    const p = paneToDoc(e);
    setCorners((prev) => prev.map((c, i) => (i === dragRef.current ? p : c)));
  };
  const endDrag = () => {
    dragRef.current = -1;
  };

  const apply = useCallback(() => {
    if (!warpSpecActive(spec, docWidth, docHeight)) {
      onClose();
      return;
    }
    const sctx = source.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    const full = sctx.getImageData(0, 0, docWidth, docHeight);
    const out = renderLiquify(
      { width: full.width, height: full.height, data: full.data as Uint8ClampedArray<ArrayBuffer> },
      warpMesh(spec, docWidth, docHeight),
      1,
    );
    const c = document.createElement("canvas");
    c.width = docWidth;
    c.height = docHeight;
    c.getContext("2d")!.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    onApply(c);
  }, [spec, source, docWidth, docHeight, onApply, onClose]);

  // Esc closes, Enter applies — captured, matching Liquify.
  // Kept in a ref so the key handler is bound once; written in an effect, since
  // mutating a ref during render is a React rule violation (and lint catches it).
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        applyRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Warp"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Warp</h2>
          <span className={styles.kindChip} title={layerName}>
            {layerName}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.preview}>
            <canvas
              ref={canvasRef}
              style={{
                width: PW,
                height: PH,
                cursor: kind === "perspective" ? "crosshair" : "default",
                touchAction: "none",
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          </div>

          <div className={styles.controls}>
            <section className={styles.section}>
              <span className={styles.sectionTitle}>Mode</span>
              <div className={styles.typeGrid} style={{ gridTemplateColumns: "1fr 1fr" }}>
                <button
                  type="button"
                  className={styles.typeBtn}
                  data-sel={kind === "preset"}
                  onClick={() => setKind("preset")}
                >
                  Warp
                </button>
                <button
                  type="button"
                  className={styles.typeBtn}
                  data-sel={kind === "perspective"}
                  onClick={() => setKind("perspective")}
                >
                  Perspective
                </button>
              </div>
            </section>

            {kind === "preset" ? (
              <>
                <section className={styles.section}>
                  <span className={styles.sectionTitle}>Style</span>
                  <div className={styles.typeGrid} style={{ gridTemplateColumns: "1fr 1fr" }}>
                    {WARP_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={styles.typeBtn}
                        data-sel={style === p.id}
                        onClick={() => setStyle(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.sectionTitle}>Shape</span>
                  <Slider label="Bend" min={-100} max={100} unit="" value={bend} onChange={setBend} />
                  <Slider label="Horizontal" min={-100} max={100} unit="" value={distH} onChange={setDistH} />
                  <Slider label="Vertical" min={-100} max={100} unit="" value={distV} onChange={setDistV} />
                </section>
              </>
            ) : (
              <section className={styles.section}>
                <span className={styles.sectionTitle}>Corners</span>
                <p className={styles.hint}>
                  Drag the four handles on the preview. The layer is re-projected so the original
                  corners land where you put them.
                </p>
                <button
                  type="button"
                  className={styles.typeBtn}
                  onClick={() => setCorners(cornersOf(docWidth, docHeight))}
                >
                  Reset corners
                </button>
              </section>
            )}

            <section className={styles.section}>
              <Toggle label="Show mesh" checked={showMesh} onChange={setShowMesh} />
              <p className={styles.hint}>
                The warp is fitted inside the layer, so nothing is pushed off the edge — a strong
                bend shrinks the content slightly rather than clipping it.
              </p>
            </section>
          </div>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={apply}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
