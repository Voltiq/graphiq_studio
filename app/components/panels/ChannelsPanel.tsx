"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import styles from "../RightDock.module.scss";
import type { ChannelHistogram, EngineHandle } from "../../lib/paint";
import type { LayerNode } from "../../lib/layers";

const CANVAS_H = 132;
const CHANNELS = [
  { key: "r", label: "Red", rgb: "248, 113, 113" },
  { key: "g", label: "Green", rgb: "74, 222, 128" },
  { key: "b", label: "Blue", rgb: "96, 165, 250" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/**
 * Live RGB histogram of the composited canvas. Subscribes to the engine's
 * content changes (debounced) and recomputes when the layer tree changes;
 * each channel can be toggled on/off independently.
 */
export default function ChannelsPanel({
  engineRef,
  tree,
}: {
  engineRef: RefObject<EngineHandle | null>;
  tree: LayerNode[];
}) {
  const [hist, setHist] = useState<ChannelHistogram | null>(null);
  const [enabled, setEnabled] = useState<Record<ChannelKey, boolean>>({
    r: true,
    g: true,
    b: true,
  });
  const [width, setWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The recompute reads the latest tree without re-subscribing on every change.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const timerRef = useRef(0);

  const compute = useCallback(() => {
    const eng = engineRef.current;
    if (eng) setHist(eng.histogram(treeRef.current));
  }, [engineRef]);

  // Coalesce bursts of change events (a stroke fires many) into ~8 updates/sec.
  const schedule = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      compute();
    }, 120);
  }, [compute]);

  // Subscribe once the engine handle is installed by CanvasArea (it's set in an
  // effect, so it may not exist on this panel's first mount — retry briefly).
  useEffect(() => {
    let unsub = () => {};
    let retry = 0;
    let cancelled = false;
    const attach = () => {
      if (cancelled) return;
      const eng = engineRef.current;
      if (eng) {
        unsub = eng.subscribe(schedule);
        compute();
      } else {
        retry = window.setTimeout(attach, 120);
      }
    };
    attach();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
      unsub();
    };
  }, [engineRef, schedule, compute]);

  // Recompute on layer add/remove/visibility/opacity/blend changes & doc switch
  // (these change the tree reference but don't fire a pixel-content change).
  useEffect(() => {
    schedule();
  }, [tree, schedule]);

  // Track the available width so the graph fills the panel crisply.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Draw the enabled channels as overlapping area graphs (additive blend so the
  // overlaps read as the classic combined-RGB histogram).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(CANVAS_H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, CANVAS_H);

    // Subtle baseline + quarter gridlines.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = Math.round((i / 4) * width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }

    const active = CHANNELS.filter((c) => enabled[c.key]);
    if (!hist || !active.length) return;

    // Normalize to the tallest bin across ALL channels (not just the visible
    // ones), ignoring the pure black/white extremes so one spike can't flatten
    // the rest — this keeps each channel's height fixed regardless of which
    // channels are toggled on.
    let max = 1;
    for (const c of CHANNELS) {
      const arr = hist[c.key];
      for (let i = 1; i < 255; i++) if (arr[i] > max) max = arr[i];
    }

    ctx.globalCompositeOperation = "lighter";
    for (const c of active) {
      const arr = hist[c.key];
      ctx.beginPath();
      ctx.moveTo(0, CANVAS_H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const y = CANVAS_H - Math.min(1, arr[i] / max) * (CANVAS_H - 2);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, CANVAS_H);
      ctx.closePath();
      ctx.fillStyle = `rgba(${c.rgb}, 0.45)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${c.rgb}, 0.95)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [hist, enabled, width]);

  return (
    <div className={styles.channels}>
      <div className={styles.channelGraph} ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width: "100%", height: CANVAS_H }} />
      </div>
      <div className={styles.channelToggles}>
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={styles.channelToggle}
            data-channel={c.key}
            data-active={enabled[c.key]}
            aria-pressed={enabled[c.key]}
            onClick={() => setEnabled((e) => ({ ...e, [c.key]: !e[c.key] }))}
          >
            <span className={styles.channelDot} />
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
