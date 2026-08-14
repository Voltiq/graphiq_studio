"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./BlurGalleryDialog.module.scss";
import { Slider } from "./Controls";
import { applyRefine, decontaminate, type RefineEdge } from "../lib/refine-edge";

const PW = 560;
const PH = 430;

type Backdrop = "white" | "black" | "overlay";

/**
 * Refine Edge — smooth / feather / contrast / shift-edge with a preview shown
 * against white, black or a rubylith overlay.
 *
 * The three backdrops are not decoration: a soft edge is invisible against a
 * background of its own colour, and the contamination this dialog exists to
 * remove only shows against a contrasting one. Overlay is for judging WHERE the
 * boundary sits; white and black are for judging what the fringe is made of.
 */
export default function RefineEdgeDialog({
  source,
  mask,
  docWidth,
  docHeight,
  initial,
  onApply,
  onClose,
}: {
  /** Flattened document pixels, for the preview. */
  source: HTMLCanvasElement;
  /** The current selection as a hard alpha mask (0/255), doc-sized. */
  mask: HTMLCanvasElement;
  docWidth: number;
  docHeight: number;
  initial: RefineEdge;
  onApply: (r: RefineEdge, decontaminateAmount: number) => void;
  onClose: () => void;
}) {
  const [smooth, setSmooth] = useState(initial.smooth);
  const [feather, setFeather] = useState(initial.feather);
  const [contrast, setContrast] = useState(initial.contrast);
  const [shift, setShift] = useState(initial.shift);
  const [decon, setDecon] = useState(0);
  const [backdrop, setBackdrop] = useState<Backdrop>("overlay");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const layout = useMemo(() => {
    const f = Math.min(PW / docWidth, PH / docHeight);
    const dw = Math.max(1, Math.round(docWidth * f));
    const dh = Math.max(1, Math.round(docHeight * f));
    return { f: dw / docWidth, dw, dh, ox: (PW - dw) / 2, oy: (PH - dh) / 2 };
  }, [docWidth, docHeight]);

  /** Document + mask downscaled to pane size once; the preview refines THIS,
   *  so dragging a slider costs a pane-sized pass rather than a doc-sized one. */
  const small = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = layout.dw;
    c.height = layout.dh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const m = document.createElement("canvas");
    m.width = layout.dw;
    m.height = layout.dh;
    const mctx = m.getContext("2d", { willReadFrequently: true });
    if (!ctx || !mctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, layout.dw, layout.dh);
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(mask, 0, 0, layout.dw, layout.dh);
    return {
      rgba: ctx.getImageData(0, 0, layout.dw, layout.dh),
      alpha: mctx.getImageData(0, 0, layout.dw, layout.dh),
    };
  }, [source, mask, layout.dw, layout.dh]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !small) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(PW * dpr)) {
      cv.width = Math.round(PW * dpr);
      cv.height = Math.round(PH * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PW, PH);

    const w = layout.dw;
    const h = layout.dh;
    const n = w * h;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = small.alpha.data[i * 4 + 3];
    applyRefine(a, w, h, { smooth, feather, contrast, shift });

    const out = new ImageData(w, h);
    const src = small.rgba.data;
    const rgba = Uint8ClampedArray.from(src);
    if (decon > 0) decontaminate(rgba, a, w, h, decon);

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const av = a[i] / 255;
      if (backdrop === "overlay") {
        // Rubylith: the image everywhere, red wash over what is NOT selected.
        const m = 1 - av;
        out.data[o] = rgba[o] * (1 - m) + 255 * m * 0.75 + rgba[o] * m * 0.25;
        out.data[o + 1] = rgba[o + 1] * (1 - m) + rgba[o + 1] * m * 0.25;
        out.data[o + 2] = rgba[o + 2] * (1 - m) + rgba[o + 2] * m * 0.25;
        out.data[o + 3] = 255;
      } else {
        const bg = backdrop === "white" ? 255 : 0;
        out.data[o] = rgba[o] * av + bg * (1 - av);
        out.data[o + 1] = rgba[o + 1] * av + bg * (1 - av);
        out.data[o + 2] = rgba[o + 2] * av + bg * (1 - av);
        out.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d")!.putImageData(out, 0, 0);
    // A checker behind nothing here — the backdrop IS the point of the preview.
    ctx.fillStyle = backdrop === "white" ? "#fff" : backdrop === "black" ? "#000" : "#1b1c1f";
    ctx.fillRect(0, 0, PW, PH);
    ctx.drawImage(tmp, layout.ox, layout.oy);
  }, [small, layout, smooth, feather, contrast, shift, decon, backdrop]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  const apply = useCallback(() => {
    onApply({ smooth, feather, contrast, shift }, decon);
  }, [smooth, feather, contrast, shift, decon, onApply]);
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
        aria-label="Refine edge"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Refine edge</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.preview}>
            <canvas ref={canvasRef} style={{ width: PW, height: PH }} />
          </div>

          <div className={styles.controls}>
            <section className={styles.section}>
              <span className={styles.sectionTitle}>View against</span>
              <div className={styles.typeGrid} style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                {(["white", "black", "overlay"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={styles.typeBtn}
                    data-sel={backdrop === b}
                    onClick={() => setBackdrop(b)}
                  >
                    {b === "white" ? "White" : b === "black" ? "Black" : "Overlay"}
                  </button>
                ))}
              </div>
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Edge</span>
              <Slider label="Smooth" min={0} max={30} unit="px" value={smooth} onChange={setSmooth} />
              <Slider label="Feather" min={0} max={100} unit="px" value={feather} onChange={setFeather} />
              <Slider label="Contrast" min={0} max={100} unit="%" value={contrast} onChange={setContrast} />
              <Slider label="Shift edge" min={-100} max={100} unit="%" value={shift} onChange={setShift} />
              <p className={styles.hint}>
                Smooth rounds off jagged boundaries without softening them; Feather softens; Contrast
                sharpens the transition back up. A large Shift necessarily hardens the edge too — a
                ramp with fixed ends cannot move far without steepening.
              </p>
            </section>

            <section className={styles.section}>
              <span className={styles.sectionTitle}>Output</span>
              <Slider
                label="Decontaminate"
                min={0}
                max={100}
                unit="%"
                value={decon}
                onChange={setDecon}
              />
              <p className={styles.hint}>
                Removes the old background&apos;s colour from the semi-transparent fringe — the halo
                a cut-out keeps from whatever it used to sit on. Applies to the layer&apos;s pixels,
                so it is a destructive edit; the edge settings are not.
              </p>
            </section>
          </div>
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={apply}>
            OK
          </button>
        </footer>
      </div>
    </div>
  );
}
