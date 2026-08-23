"use client";

import { useEffect, useRef } from "react";

/** The three heights the panels sheet snaps to, smallest first. */
export const DETENTS = ["peek", "half", "full"] as const;
export type Detent = (typeof DETENTS)[number];

/** What each detent is worth, as a fraction of the viewport height. `full` is
 *  resolved against the space between the bars rather than the whole screen. */
const FRACTION: Record<Detent, number> = { peek: 0.25, half: 0.5, full: 1 };

/**
 * The grab handle at the top of the panels sheet.
 *
 * Two ways to move between detents, because they fail differently. A DRAG is
 * the gesture people try, and it wants to follow the finger and then snap to
 * whichever detent it ended nearest. A TAP is the one that always works — no
 * slop, no direction, nothing to learn — and it steps to the next height,
 * wrapping round at the top.
 *
 * The drag writes its height straight onto the root element rather than
 * through React state: it fires on every pointermove, and a re-render of the
 * whole editor per frame is the difference between following the finger and
 * lagging behind it. State is set once, on release, when the detent is known.
 */
export default function SheetHandle({
  detent,
  onDetent,
}: {
  detent: Detent;
  onDetent: (d: Detent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);

  /* The pixel height of each detent, right now. Measured rather than assumed:
     `full` depends on --chrome-top and --chrome-bottom, and those move with the
     safe-area insets when a phone is rotated. */
  const heights = (): Record<Detent, number> => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:var(--chrome-top);bottom:var(--chrome-bottom);left:0;width:1px;visibility:hidden";
    document.body.appendChild(probe);
    const band = probe.getBoundingClientRect().height;
    probe.remove();
    const vh = window.innerHeight;
    return {
      peek: Math.min(band, vh * FRACTION.peek),
      half: Math.min(band, vh * FRACTION.half),
      full: band,
    };
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;

    const onDown = (e: PointerEvent) => {
      const sheet = el.closest("aside");
      if (!sheet) return;
      el.setPointerCapture(e.pointerId);
      drag.current = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false };
      root.setAttribute("data-sheet-drag", "");
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dy = d.y - e.clientY; // up is taller
      if (Math.abs(dy) > 4) d.moved = true;
      const h = heights();
      const next = Math.max(60, Math.min(h.full, d.h + dy));
      root.style.setProperty("--sheet-h", `${Math.round(next)}px`);
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      root.removeAttribute("data-sheet-drag");
      root.style.removeProperty("--sheet-h");
      const h = heights();
      if (!d.moved) {
        // A tap: step to the next height, wrapping round at the top.
        onDetent(DETENTS[(DETENTS.indexOf(detent) + 1) % DETENTS.length]);
        return;
      }
      const ended = Math.max(60, Math.min(h.full, d.h + (d.y - e.clientY)));
      let best: Detent = DETENTS[0];
      for (const k of DETENTS) if (Math.abs(h[k] - ended) < Math.abs(h[best] - ended)) best = k;
      onDetent(best);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      root.removeAttribute("data-sheet-drag");
      root.style.removeProperty("--sheet-h");
    };
  }, [detent, onDetent]);

  return (
    <div
      ref={ref}
      className="gq-m-sheet-handle"
      data-sheet-handle
      data-detent={detent}
      role="slider"
      tabIndex={0}
      aria-label="Panel height"
      aria-valuetext={detent}
      aria-valuenow={DETENTS.indexOf(detent)}
      aria-valuemin={0}
      aria-valuemax={DETENTS.length - 1}
      onKeyDown={(e) => {
        const i = DETENTS.indexOf(detent);
        if (e.key === "ArrowUp" && i < DETENTS.length - 1) onDetent(DETENTS[i + 1]);
        else if (e.key === "ArrowDown" && i > 0) onDetent(DETENTS[i - 1]);
        else return;
        e.preventDefault();
      }}
    />
  );
}
