"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import styles from "../RightDock.module.scss";
import type { ChannelHistogram, EngineHandle } from "../../lib/paint";
import { findNode, type LayerNode, type LayersApi } from "../../lib/layers";
import { opFromModifiers, type ChannelSelectOp, type SavedChannel } from "../../lib/channels";
import type { Rect } from "../../lib/view";

const CANVAS_H = 132;
const CHANNELS = [
  { key: "r", label: "Red", rgb: "248, 113, 113" },
  { key: "g", label: "Green", rgb: "74, 222, 128" },
  { key: "b", label: "Blue", rgb: "96, 165, 250" },
  { key: "l", label: "Lum", rgb: "226, 232, 240" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/** Clipped-pixel share above which the warning lights up. */
const CLIP_WARN = 0.005;

/**
 * Live RGB histogram of the composited canvas. Subscribes to the engine's
 * content changes (debounced) and recomputes when the layer tree changes;
 * each channel can be toggled on/off independently. When the active layer
 * carries a mask, it appears as a fourth (grayscale) channel: its tonal curve
 * can be toggled like R/G/B, and the eye shows the mask ON THE CANVAS
 * (same view mode as Alt-clicking the mask chip in the Layers panel).
 */
export default function ChannelsPanel({
  engineRef,
  tree,
  api,
  selection,
  selectionAngle,
  selectionPivot,
  channels,
}: {
  engineRef: RefObject<EngineHandle | null>;
  tree: LayerNode[];
  api: LayersApi;
  /** Active selection — when present the histogram scopes to it. */
  selection: Rect[];
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  /** Saved selections (alpha channels) + the operations on them. */
  channels: {
    list: SavedChannel[];
    previewOf: (id: string) => string | null;
    onSave: () => void;
    onLoad: (id: string, op: ChannelSelectOp) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
  };
}) {
  const [renaming, setRenaming] = useState<string | null>(null);

  // Thumbnails are re-encoded PNGs, and this panel re-renders on every selection
  // change — so generating them inline would re-encode every channel on every
  // frame of a marquee drag. A channel's raster only changes when one is saved
  // or deleted, so keying the cache on the id list is enough (a rename doesn't
  // touch pixels).
  const channelIds = channels.list.map((c) => c.id).join("|");
  const previews = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const id of channelIds ? channelIds.split("|") : []) m.set(id, channels.previewOf(id));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelIds]);
  const [hist, setHist] = useState<ChannelHistogram | null>(null);
  const [maskHist, setMaskHist] = useState<Uint32Array | null>(null);
  const [enabled, setEnabled] = useState<Record<ChannelKey, boolean>>({
    r: true,
    g: true,
    b: true,
    l: false,
  });
  const [maskOn, setMaskOn] = useState(true);
  const [width, setWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const activeNode = api.activeLayerId ? findNode(tree, api.activeLayerId) : null;
  const maskLayerId = activeNode?.mask ? activeNode.id : null;

  // The recompute reads the latest tree without re-subscribing on every change.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const maskIdRef = useRef(maskLayerId);
  maskIdRef.current = maskLayerId;
  const selRef = useRef({ selection, selectionAngle, selectionPivot });
  selRef.current = { selection, selectionAngle, selectionPivot };
  const timerRef = useRef(0);

  const compute = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const s = selRef.current;
    setHist(
      eng.histogram(
        treeRef.current,
        s.selection.length ? s.selection : null,
        s.selectionAngle,
        s.selectionPivot,
      ),
    );
    setMaskHist(maskIdRef.current ? eng.maskHistogram(maskIdRef.current) : null);
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
  // (these change the tree reference but don't fire a pixel-content change),
  // when the mask channel's target changes, and when the selection moves.
  useEffect(() => {
    schedule();
  }, [tree, maskLayerId, selection, selectionAngle, selectionPivot, schedule]);

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

    // Mask channel first (source-over, beneath the additive RGB curves), with
    // its own normalization — a mostly-white mask would otherwise flatline.
    if (maskHist && maskOn) {
      let mmax = 1;
      for (let i = 1; i < 255; i++) if (maskHist[i] > mmax) mmax = maskHist[i];
      ctx.beginPath();
      ctx.moveTo(0, CANVAS_H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const y = CANVAS_H - Math.min(1, maskHist[i] / mmax) * (CANVAS_H - 2);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, CANVAS_H);
      ctx.closePath();
      ctx.fillStyle = "rgba(203, 210, 220, 0.28)";
      ctx.fill();
      ctx.strokeStyle = "rgba(203, 210, 220, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (!hist) return;

    // Normalize to the tallest bin across ALL channels (not just the visible
    // ones), ignoring the pure black/white extremes so one spike can't flatten
    // the rest — this keeps each channel's height fixed regardless of which
    // channels are toggled on.
    let max = 1;
    for (const c of CHANNELS) {
      const arr = hist[c.key];
      for (let i = 1; i < 255; i++) if (arr[i] > max) max = arr[i];
    }

    const curve = (arr: number[] | Uint32Array, rgb: string, fillA: number) => {
      ctx.beginPath();
      ctx.moveTo(0, CANVAS_H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const y = CANVAS_H - Math.min(1, arr[i] / max) * (CANVAS_H - 2);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, CANVAS_H);
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb}, ${fillA})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // Luminosity draws source-over BENEATH the additive RGB curves — adding
    // white into the mix would blow the overlaps out.
    if (enabled.l) curve(hist.l, "226, 232, 240", 0.3);
    const activeRgb = CHANNELS.filter((c) => c.key !== "l" && enabled[c.key]);
    ctx.globalCompositeOperation = "lighter";
    for (const c of activeRgb) curve(hist[c.key], c.rgb, 0.45);
    ctx.globalCompositeOperation = "source-over";
  }, [hist, maskHist, maskOn, enabled, width]);

  // Clipping shares: worst clipped fraction at bin 0 / bin 255 across the
  // enabled channels (luminosity when nothing is on). Every channel counts the
  // same opaque-pixel population, so one total serves them all.
  let clip: { lo: number; hi: number } | null = null;
  if (hist) {
    const arrs = CHANNELS.filter((c) => enabled[c.key]).map((c) => hist[c.key]);
    const use = arrs.length ? arrs : [hist.l];
    let total = 0;
    for (const v of hist.l) total += v;
    if (total > 0) {
      clip = {
        lo: Math.max(...use.map((a) => a[0])) / total,
        hi: Math.max(...use.map((a) => a[255])) / total,
      };
    }
  }
  const pct = (v: number) => (v >= 0.1 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`);
  const selActive = selection.length > 0;

  return (
    <div className={styles.channels}>
      <div className={styles.channelGraph} ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width: "100%", height: CANVAS_H }} />
        {selActive && (
          <span className={styles.channelSelBadge} title="Histogram of the selected pixels only">
            Selection
          </span>
        )}
      </div>
      {clip && (
        <div className={styles.channelClipRow}>
          <span
            data-warn={clip.lo > CLIP_WARN || undefined}
            title="Share of pixels clipped to pure black (over the enabled channels)"
          >
            ◢ shadows {pct(clip.lo)}
          </span>
          <span
            data-warn={clip.hi > CLIP_WARN || undefined}
            title="Share of pixels clipped to pure white (over the enabled channels)"
          >
            highlights {pct(clip.hi)} ◣
          </span>
        </div>
      )}
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
      {maskLayerId && (
        <div className={styles.channelMaskRow}>
          <button
            type="button"
            className={styles.channelToggle}
            data-channel="m"
            data-active={maskOn}
            aria-pressed={maskOn}
            title={`${activeNode?.name ?? "Layer"}'s mask — toggle its tonal curve`}
            onClick={() => setMaskOn((v) => !v)}
          >
            <span className={styles.channelDot} />
            Mask
          </button>
          <button
            type="button"
            className={styles.channelView}
            data-active={api.maskViewId === maskLayerId}
            title={
              api.maskViewId === maskLayerId
                ? "Stop viewing the mask on the canvas"
                : "View the mask on the canvas (Alt-clicking its chip in Layers works too)"
            }
            aria-label="View mask on canvas"
            aria-pressed={api.maskViewId === maskLayerId}
            onClick={() => api.toggleMaskView(maskLayerId)}
          >
            {api.maskViewId === maskLayerId ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      )}

      {/* Saved selections (alpha channels). Modifier semantics match the Paths
          panel exactly — the two do the same job to the same selection. */}
      <div className={styles.savedHead}>
        <span className={styles.savedLabel}>Saved selections</span>
        <button
          type="button"
          className={styles.savedAdd}
          title="Save the current selection as a channel"
          aria-label="Save selection as channel"
          disabled={!selActive}
          onClick={() => channels.onSave()}
        >
          <Plus size={13} />
        </button>
      </div>
      {channels.list.length === 0 ? (
        <p className={styles.savedEmpty}>
          {selActive
            ? "Save the current selection to reuse it later."
            : "Make a selection, then save it here to reuse later."}
        </p>
      ) : (
        <ul className={styles.savedList}>
          {channels.list.map((c) => (
            <li key={c.id} className={styles.savedRow}>
              <button
                type="button"
                className={styles.savedLoad}
                title="Click to select · Ctrl add · Alt subtract · Ctrl+Alt intersect"
                onClick={(e) => channels.onLoad(c.id, opFromModifiers(e))}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.savedThumb}
                  src={previews.get(c.id) ?? undefined}
                  alt=""
                  draggable={false}
                />
                {renaming === c.id ? (
                  <input
                    className={styles.savedName}
                    defaultValue={c.name}
                    autoFocus
                    aria-label="Channel name"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      channels.onRename(c.id, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      // Keep Enter/Escape inside the field — the canvas treats
                      // both as document-level commands.
                      e.stopPropagation();
                      if (e.key === "Enter") e.currentTarget.blur();
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className={styles.savedName} onDoubleClick={() => setRenaming(c.id)}>
                    {c.name}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={styles.savedDelete}
                title={`Delete “${c.name}”`}
                aria-label={`Delete ${c.name}`}
                onClick={() => channels.onDelete(c.id)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
