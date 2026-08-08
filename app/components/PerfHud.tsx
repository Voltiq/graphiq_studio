"use client";

import { useEffect, useState } from "react";
import styles from "./PerfHud.module.scss";
import type { PerfStats } from "../lib/paint";

/** Dev performance HUD: composite timing, recomposite rate, render-cache hit
 *  rate/occupancy, and the last frame's blit region. Polls the engine a few
 *  times a second (cheap; kept off the render path so it doesn't skew the ms). */
export default function PerfHud({ stats }: { stats: () => PerfStats | null }) {
  const [s, setS] = useState<PerfStats | null>(() => stats());
  useEffect(() => {
    const id = window.setInterval(() => setS(stats()), 120);
    return () => window.clearInterval(id);
  }, [stats]);
  if (!s) return null;

  // Composite cost is colour-ramped: a 60 fps budget is ~16 ms/frame.
  const costClass = s.lastMs < 4 ? styles.good : s.lastMs < 16 ? styles.warn : styles.bad;
  const memPct = s.budget > 0 ? Math.min(100, (s.bytes / s.budget) * 100) : 0;
  const mb = (b: number) => (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0);
  const dirtyClass = s.full ? styles.bad : styles.good;
  const dirtyLabel = s.full
    ? "full frame"
    : s.dirty
      ? `${Math.round(s.dirty.w)}×${Math.round(s.dirty.h)}`
      : "—";

  return (
    <div className={styles.hud} aria-hidden>
      <div className={styles.title}>
        <span
          className={styles.dot}
          style={{ background: s.enabled ? "#4ade80" : "#f87171" }}
          title={s.enabled ? "Render cache ON" : "Render cache OFF"}
        />
        PERF{!s.enabled && " · cache off"}
      </div>

      <div className={styles.row}>
        <span className={styles.label}>composite</span>
        <span>
          <span className={`${styles.big} ${costClass}`}>{s.lastMs.toFixed(1)}</span>
          <span className={styles.sub}> ms</span>
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.sub}>avg {s.avgMs.toFixed(1)} · max {s.maxMs.toFixed(1)}</span>
        <span className={styles.sub}>{s.rate}/s</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>cache hit</span>
        <span className={styles.value}>{Math.round(s.hitRate * 100)}%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.sub}>
          {s.hits}/{s.hits + s.misses}
        </span>
        <span className={styles.sub}>
          {s.entries} prod{s.tiles ? ` · ${s.tiles} tiles` : ""}
        </span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>memory</span>
        <span className={styles.value}>
          {mb(s.bytes)} / {mb(s.budget)} MB
        </span>
      </div>
      <div className={styles.bar}>
        <div className={styles.barFill} style={{ width: `${memPct}%` }} />
      </div>

      <div className={styles.row} style={{ marginTop: 5 }}>
        <span className={styles.label}>dirty</span>
        <span className={styles.value}>
          <span className={styles.swatch} style={{ background: s.full ? "#f87171" : "#4ade80" }} />
          <span className={dirtyClass}>{dirtyLabel}</span>
        </span>
      </div>
    </div>
  );
}
