"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Expand, Hand, History, RotateCw, Shrink, X, type LucideIcon } from "lucide-react";
import styles from "./BlurGalleryDialog.module.scss";
import { Slider, Toggle } from "./Controls";
import { downloadBlob } from "../lib/project";
import {
  applyBrush,
  createMesh,
  deserializeMesh,
  meshLines,
  renderLiquify,
  resampleMesh,
  serializeMesh,
  type LiquifyMesh,
  type LiquifyTool,
} from "../lib/liquify";

const PW = 560;
const PH = 430;

const TOOLS: { id: LiquifyTool; label: string; icon: LucideIcon; desc: string }[] = [
  { id: "warp", label: "Warp", icon: Hand, desc: "Drag to push pixels along the stroke." },
  { id: "pucker", label: "Pucker", icon: Shrink, desc: "Hold to pull pixels toward the brush centre." },
  { id: "bloat", label: "Bloat", icon: Expand, desc: "Hold to push pixels away from the brush centre." },
  { id: "twirl", label: "Twirl", icon: RotateCw, desc: "Hold to rotate pixels around the brush — Alt reverses." },
  { id: "reconstruct", label: "Reconstruct", icon: History, desc: "Paint over warped areas to restore the original." },
];

/**
 * Liquify — a modal warp-mesh editor for the active layer. The dialog owns the
 * whole session: a displacement mesh (doc-resolution, from lib/liquify) edited
 * by brush gestures on a downscaled live preview; Apply renders the full-res
 * warp once and hands the canvas back for a one-step history entry.
 */
export default function LiquifyDialog({
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
  const [tool, setTool] = useState<LiquifyTool>("warp");
  const [size, setSize] = useState(160);
  const [pressure, setPressure] = useState(60);
  const [showMesh, setShowMesh] = useState(false);
  const [meshErr, setMeshErr] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const meshRef = useRef<LiquifyMesh>(null!);
  if (!meshRef.current) meshRef.current = createMesh(docWidth, docHeight);

  // Letterbox the document into the fixed pane (same layout as the Blur Gallery).
  const layout = useMemo(() => {
    const f = Math.min(PW / docWidth, PH / docHeight);
    const dw = Math.max(1, Math.round(docWidth * f));
    const dh = Math.max(1, Math.round(docHeight * f));
    return { f: dw / docWidth, dw, dh, ox: (PW - dw) / 2, oy: (PH - dh) / 2 };
  }, [docWidth, docHeight]);

  // Downscaled source for the interactive preview + a reusable warped buffer.
  const preview = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = layout.dw;
    c.height = layout.dh;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, layout.dw, layout.dh);
    return { src: ctx.getImageData(0, 0, layout.dw, layout.dh), warped: c };
  }, [source, layout]);

  // Live-session refs (imperative canvas loop; React state only for the UI).
  const cursorRef = useRef<{ x: number; y: number } | null>(null); // pane px
  const strokeRef = useRef<{ lastDoc: { x: number; y: number } } | null>(null);
  const altRef = useRef(false);
  const pressureMulRef = useRef(1);
  const tickTimerRef = useRef(0);
  const rafRef = useRef(0);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const strengthRef = useRef(pressure);
  strengthRef.current = pressure;
  const showMeshRef = useRef(showMesh);
  showMeshRef.current = showMesh;

  const draw = () => {
    const cnv = canvasRef.current;
    const ctx = cnv?.getContext("2d");
    if (!cnv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (cnv.width !== Math.round(PW * dpr)) {
      cnv.width = Math.round(PW * dpr);
      cnv.height = Math.round(PH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Checkerboard (transparency), matching the Blur Gallery pane.
    const t = 10;
    for (let y = 0; y < PH; y += t) {
      for (let x = 0; x < PW; x += t) {
        ctx.fillStyle = ((x / t + y / t) & 1) === 0 ? "#cfcfcf" : "#a9a9a9";
        ctx.fillRect(x, y, t, t);
      }
    }
    const { f, dw, dh, ox, oy } = layout;
    // Warped preview: backward-warp the downscaled source through the doc mesh.
    const out = renderLiquify(preview.src, meshRef.current, f);
    preview.warped.getContext("2d")!.putImageData(new ImageData(out.data, dw, dh), 0, 0);
    ctx.drawImage(preview.warped, ox, oy);

    const dual = (width: number, alpha: number, drawPath: () => void) => {
      ctx.lineWidth = width + 1.5;
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.6})`;
      drawPath();
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      drawPath();
    };

    if (showMeshRef.current) {
      // Grid step so overlay lines land every ~26 pane px regardless of size.
      const mesh = meshRef.current;
      const step = Math.max(1, Math.round(26 / (mesh.spacing * f)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, dw, dh);
      ctx.clip();
      ctx.beginPath();
      for (const line of meshLines(mesh, step)) {
        for (let i = 0; i < line.length; i++) {
          const sx = ox + line[i].x * f;
          const sy = oy + line[i].y * f;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
      }
      // Dark-under-light double stroke so the grid reads on any content.
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke();
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.stroke();
      ctx.restore();
    }

    // Brush ring at the cursor (pane px; radius follows the doc-space size).
    const cur = cursorRef.current;
    if (cur) {
      const r = Math.max(2, ((sizeRef.current / 2) * f));
      dual(1.25, 0.95, () => {
        ctx.beginPath();
        ctx.arc(cur.x, cur.y, r, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  };
  const requestDraw = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  };

  // First paint + repaint when the overlay-affecting UI changes.
  useEffect(() => {
    requestDraw();
    return () => {
      // Reset the handle too, or requestDraw() forever thinks a frame is
      // pending after StrictMode's dev mount→cleanup→mount cycle.
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, size, showMesh, preview]);

  const toDoc = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) * PW) / r.width;
    const py = ((e.clientY - r.top) * PH) / r.height;
    return { pane: { x: px, y: py }, doc: { x: (px - layout.ox) / layout.f, y: (py - layout.oy) / layout.f } };
  };

  /** One brush tick of the held tools at the current cursor (doc space). */
  const tick = () => {
    const cur = cursorRef.current;
    if (!cur) return;
    const doc = { x: (cur.x - layout.ox) / layout.f, y: (cur.y - layout.oy) / layout.f };
    const s = (strengthRef.current / 100) * pressureMulRef.current;
    applyBrush(meshRef.current, toolRef.current, doc.x, doc.y, sizeRef.current / 2, s, undefined, altRef.current ? -1 : 1);
    setMeshErr(null);
    requestDraw();
  };

  const stopTicks = () => {
    window.clearInterval(tickTimerRef.current);
    tickTimerRef.current = 0;
  };
  useEffect(() => stopTicks, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = toDoc(e);
    cursorRef.current = p.pane;
    altRef.current = e.altKey;
    pressureMulRef.current = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 1;
    strokeRef.current = { lastDoc: p.doc };
    if (toolRef.current !== "warp") {
      tick(); // click applies once; holding keeps building
      stopTicks();
      tickTimerRef.current = window.setInterval(tick, 40);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toDoc(e);
    cursorRef.current = p.pane;
    altRef.current = e.altKey;
    if (e.pointerType === "pen" && e.pressure > 0) pressureMulRef.current = e.pressure;
    const stroke = strokeRef.current;
    if (stroke && toolRef.current === "warp") {
      const delta = { x: p.doc.x - stroke.lastDoc.x, y: p.doc.y - stroke.lastDoc.y };
      if (delta.x || delta.y) {
        applyBrush(
          meshRef.current,
          "warp",
          p.doc.x,
          p.doc.y,
          sizeRef.current / 2,
          (strengthRef.current / 100) * pressureMulRef.current,
          delta,
        );
        stroke.lastDoc = p.doc;
        setMeshErr(null);
      }
    }
    requestDraw();
  };
  const endStroke = (e: React.PointerEvent) => {
    strokeRef.current = null;
    stopTicks();
    const c = canvasRef.current;
    if (c && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
  };

  const resetMesh = () => {
    meshRef.current = createMesh(docWidth, docHeight);
    setMeshErr(null);
    requestDraw();
  };

  const saveMesh = () => {
    downloadBlob(
      new Blob([serializeMesh(meshRef.current)], { type: "application/json" }),
      `${layerName.replace(/[^\w.-]+/g, "_") || "layer"}-liquify.gmesh`,
    );
  };
  const loadMesh = async (file: File) => {
    try {
      const mesh = deserializeMesh(await file.text());
      meshRef.current = resampleMesh(mesh, docWidth, docHeight);
      setMeshErr(null);
      requestDraw();
    } catch (err) {
      setMeshErr((err as Error).message);
    }
  };

  const apply = () => {
    const sctx = source.getContext("2d")!;
    const src = sctx.getImageData(0, 0, docWidth, docHeight);
    const out = renderLiquify(src, meshRef.current, 1);
    const c = document.createElement("canvas");
    c.width = docWidth;
    c.height = docHeight;
    c.getContext("2d")!.putImageData(new ImageData(out.data, docWidth, docHeight), 0, 0);
    onApply(c);
  };

  // Esc cancels / Enter applies — captured before the editor's global shortcuts.
  const applyRef = useRef(apply);
  applyRef.current = apply;
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

  const activeTool = TOOLS.find((t) => t.id === tool)!;

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Liquify"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Liquify</h2>
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
              style={{ width: PW, height: PH, cursor: "crosshair", touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={() => {
                cursorRef.current = null;
                requestDraw();
              }}
            />
          </div>

          <div className={styles.controls}>
            <section className={styles.section}>
              <span className={styles.sectionTitle}>Tool</span>
              <div className={styles.typeGrid} style={{ gridTemplateColumns: "1fr 1fr" }}>
                {TOOLS.map((t) => {
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={styles.typeBtn}
                      data-active={tool === t.id}
                      title={t.desc}
                      onClick={() => setTool(t.id)}
                    >
                      <Icon size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <span className={styles.desc}>{activeTool.desc}</span>
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Brush</span>
              <Slider label="Size" min={10} max={600} unit="px" value={size} onChange={setSize} />
              <Slider label="Pressure" min={1} max={100} unit="%" value={pressure} onChange={setPressure} />
              <span className={styles.desc}>Pen pressure scales the strength when available.</span>
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Mesh</span>
              <Toggle label="Show mesh" checked={showMesh} onChange={setShowMesh} />
              <div className={styles.segRow}>
                <button type="button" className={styles.segBtn} onClick={saveMesh}>
                  Save mesh…
                </button>
                <button type="button" className={styles.segBtn} onClick={() => fileRef.current?.click()}>
                  Load mesh…
                </button>
                <button type="button" className={styles.segBtn} onClick={resetMesh}>
                  Reset
                </button>
              </div>
              {meshErr && (
                <span className={styles.desc} style={{ color: "var(--danger)" }}>
                  {meshErr}
                </span>
              )}
              <span className={styles.desc}>
                A saved mesh re-applies this warp to any image (scaled to fit).
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".gmesh,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) loadMesh(f);
                }}
              />
            </section>
          </div>
        </div>

        <footer className={styles.foot}>
          <span className={styles.footNote}>Enter applies · Esc cancels</span>
          <div className={styles.footSpacer} />
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={apply}
            title="Bake the warp into the layer (one undo step)"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
