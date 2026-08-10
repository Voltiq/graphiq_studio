"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import styles from "../RightDock.module.scss";
import { EditableValue } from "../Controls";
import { clamp } from "../../lib/color";
import { clampPan, type NavigatorView } from "../../lib/view";

const STAGE_H = 150;
const MIN_ZOOM = 12;
const MAX_ZOOM = 10000;
/** Click-to-zoom presets (Fit is handled separately). */
const PRESETS = [25, 50, 100, 200, 400];
/** The zoom slider is LOGARITHMIC: a linear 12–10000 range would bunch every
 *  everyday zoom into the first few percent of the track. 0–1000 slider units
 *  map onto log10(zoom), so equal travel = equal ratio. */
const toSlider = (z: number) =>
  Math.round(((Math.log10(clamp(z, MIN_ZOOM, MAX_ZOOM)) - Math.log10(MIN_ZOOM)) /
    (Math.log10(MAX_ZOOM) - Math.log10(MIN_ZOOM))) * 1000);
const fromSlider = (v: number) =>
  Math.round(10 ** (Math.log10(MIN_ZOOM) + (v / 1000) * (Math.log10(MAX_ZOOM) - Math.log10(MIN_ZOOM))));

export default function NavigatorPanel({ view }: { view: NavigatorView }) {
  const { zoom, pan, setPan, vpW, vpH, docW, docH, setZoom, fit } = view;
  const stageRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [stageW, setStageW] = useState(0);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = zoom / 100;

  // Thumbnail size: fit the document aspect ratio inside the stage box.
  const ar = docW / docH;
  let tw = stageW;
  let th = stageW / ar;
  if (th > STAGE_H) {
    th = STAGE_H;
    tw = STAGE_H * ar;
  }

  const ready = vpW > 0 && vpH > 0 && stageW > 0;

  // Visible region as a percentage of the document (= of the thumbnail).
  const left = clamp((-pan.x / scale / docW) * 100, 0, 100);
  const top = clamp((-pan.y / scale / docH) * 100, 0, 100);
  const right = clamp(((-pan.x / scale + vpW / scale) / docW) * 100, 0, 100);
  const bottom = clamp(((-pan.y / scale + vpH / scale) / docH) * 100, 0, 100);

  const panToPoint = (clientX: number, clientY: number) => {
    const el = thumbRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = clamp((clientX - r.left) / r.width, 0, 1);
    const ny = clamp((clientY - r.top) / r.height, 0, 1);
    const dx = nx * docW;
    const dy = ny * docH;
    // Centre the viewport on the clicked document point.
    setPan(clampPan(vpW / 2 - dx * scale, vpH / 2 - dy * scale, scale, docW, docH, vpW, vpH));
  };

  return (
    <div className={styles.navigator}>
      <div className={styles.navStage} ref={stageRef}>
        <div
          className={styles.navThumb}
          ref={thumbRef}
          style={{ width: tw || "100%", height: th || STAGE_H }}
          onPointerDown={(e) => {
            if (!ready) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            panToPoint(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (dragging.current) panToPoint(e.clientX, e.clientY);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
        >
          <div className={styles.navArtwork} />
          {ready && (
            <div
              className={styles.navView}
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${Math.max(0, right - left)}%`,
                height: `${Math.max(0, bottom - top)}%`,
              }}
            />
          )}
        </div>
      </div>
      <div className={styles.navFooter}>
        <button
          type="button"
          className={styles.navStep}
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => setZoom(clamp(Math.round(zoom / 1.25), MIN_ZOOM, MAX_ZOOM))}
        >
          <Minus size={12} />
        </button>
        <input
          className={styles.navSlider}
          type="range"
          min={0}
          max={1000}
          value={toSlider(zoom)}
          onChange={(e) => setZoom(fromSlider(Number(e.target.value)))}
          aria-label="Zoom"
        />
        <button
          type="button"
          className={styles.navStep}
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => setZoom(clamp(Math.round(zoom * 1.25), MIN_ZOOM, MAX_ZOOM))}
        >
          <Plus size={12} />
        </button>
        <EditableValue
          className={styles.navZoom}
          value={Math.round(zoom)}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          display={`${Math.round(zoom)}%`}
          onCommit={(n) => setZoom(clamp(Math.round(n), MIN_ZOOM, MAX_ZOOM))}
          ariaLabel="Zoom percentage"
        />
      </div>
      <div className={styles.navPresets}>
        <button type="button" className={styles.navPreset} onClick={fit} title="Fit on screen">
          Fit
        </button>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={styles.navPreset}
            data-on={Math.round(zoom) === p || undefined}
            onClick={() => setZoom(p)}
            title={`Zoom to ${p}%`}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}
