"use client";

/**
 * Develop a RAW before it becomes a layer.
 *
 * A camera RAW is sensor readings plus the camera's opinion about turning them
 * into a picture. This is where you disagree with the opinion — and the reason
 * it happens HERE rather than with the ordinary Exposure adjustment afterwards
 * is that these two controls act on LINEAR sensor data with headroom still in
 * it. Pulling a blown sky back a stop at this point recovers detail the file
 * really holds; the same slider on the imported 8-bit layer has nothing left to
 * recover, because clipping already happened.
 *
 * THE PREVIEW IS DELIBERATELY SMALL AND DELIBERATELY NOT THE IMPORT. Developing
 * 24 megapixels takes long enough to make a slider useless, so the preview
 * develops at `PREVIEW_EDGE` and the import re-develops at full size once, with
 * the same settings. `developRaw` skips output pixels rather than shrinking the
 * source for exactly this reason: each previewed pixel is demosaiced from its
 * true neighbourhood, so the colour and the exposure shown are the colour and
 * the exposure you get.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { RawDevelopOptions } from "../lib/dng";
import type { RawSession } from "../lib/rawdev";
import styles from "./RawDevelopDialog.module.scss";
import { rangeFill } from "../lib/range-fill";

/** Longest edge of the preview. Small enough to redevelop inside a drag. */
const PREVIEW_EDGE = 900;

/** Exposure range, in stops either side of the camera's own. */
const EV_MIN = -4;
const EV_MAX = 4;

/**
 * Temperature and tint as multipliers, RELATIVE to as-shot.
 *
 * Not kelvin: turning a slider into a colour temperature needs the camera's
 * illuminant calibration, and inventing one would put a number on the screen
 * that means nothing. These are honest relative warm/cool and green/magenta
 * trims, centred on what the camera chose, which is what the numbers say.
 */
const wbFromTrim = (warm: number, tint: number): [number, number, number] => [
  1 + warm,
  1 - tint,
  1 - warm,
];

export interface RawDevelopProps {
  session: RawSession;
  fileName: string;
  onDone: (opts: RawDevelopOptions | null) => void;
}

export default function RawDevelopDialog({ session, fileName, onDone }: RawDevelopProps) {
  const [ev, setEv] = useState(0);
  const [warm, setWarm] = useState(0);
  const [tint, setTint] = useState(0);
  const [busy, setBusy] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /* Develops are serialised: a slider dragged quickly can outrun the worker,
     and without this the last frame drawn is whichever reply happened to
     arrive last rather than the newest settings. */
  const seq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const draw = useCallback(
    async (opts: RawDevelopOptions) => {
      const mine = ++seq.current;
      setBusy(true);
      const img = await session.develop({ ...opts, maxEdge: PREVIEW_EDGE });
      if (!alive.current || mine !== seq.current) return; // superseded
      setBusy(false);
      const c = canvasRef.current;
      if (!c || !img) return;
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")?.putImageData(img, 0, 0);
    },
    [session],
  );

  useEffect(() => {
    const t = setTimeout(
      () => void draw({ exposureEV: ev, wb: wbFromTrim(warm, tint) }),
      /* The first develop runs at once; later ones wait for the drag to settle,
         which is the difference between a slider that tracks and one that
         queues up work it will throw away. */
      seq.current === 0 ? 0 : 120,
    );
    return () => clearTimeout(t);
  }, [draw, ev, warm, tint]);

  const finish = (accept: boolean) =>
    onDone(accept ? { exposureEV: ev, wb: wbFromTrim(warm, tint) } : null);

  const reset = () => {
    setEv(0);
    setWarm(0);
    setTint(0);
  };

  return (
    <div className={styles.overlay}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Develop RAW"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(false);
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(true);
        }}
      >
        <header className={styles.head}>
          <h2>Develop RAW</h2>
          <button
            type="button"
            className={styles.close}
            onClick={() => finish(false)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewWrap} data-busy={busy || undefined}>
            <canvas ref={canvasRef} className={styles.preview} aria-label="Develop preview" />
          </div>

          <p className={styles.meta}>
            {fileName} — {session.width} × {session.height}
            {/* What "as shot" actually was, so the neutral position is not a
                mystery. Two decimals: these are multipliers, not kelvin. */}
            <span className={styles.asShot}>
              as shot {session.asShot.map((n) => n.toFixed(2)).join(" / ")}
            </span>
          </p>

          <label className={styles.row}>
            <span>Exposure</span>
            <input
              type="range"
              min={EV_MIN}
              max={EV_MAX}
              step={0.05}
              value={ev}
              style={rangeFill(ev, EV_MIN, EV_MAX)}
              aria-label="Exposure"
              onChange={(e) => setEv(+e.target.value)}
            />
            <output>
              {ev > 0 ? "+" : ""}
              {ev.toFixed(2)} EV
            </output>
          </label>

          <label className={styles.row}>
            <span>Temperature</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.005}
              value={warm}
              style={rangeFill(warm, -0.5, 0.5)}
              aria-label="Temperature"
              onChange={(e) => setWarm(+e.target.value)}
            />
            <output>{warm === 0 ? "as shot" : `${warm > 0 ? "+" : ""}${(warm * 100).toFixed(0)}`}</output>
          </label>

          <label className={styles.row}>
            <span>Tint</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.005}
              value={tint}
              style={rangeFill(tint, -0.5, 0.5)}
              aria-label="Tint"
              onChange={(e) => setTint(+e.target.value)}
            />
            <output>{tint === 0 ? "as shot" : `${tint > 0 ? "+" : ""}${(tint * 100).toFixed(0)}`}</output>
          </label>
        </div>

        <footer className={styles.foot}>
          <button type="button" onClick={reset} data-reset>
            As shot
          </button>
          <span className={styles.spacer} />
          <button type="button" onClick={() => finish(false)}>
            Cancel
          </button>
          <button type="button" data-primary onClick={() => finish(true)}>
            Import
          </button>
        </footer>
      </div>
    </div>
  );
}
