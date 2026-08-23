"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Tooltip.module.scss";
import { uiZoom } from "../lib/ui-scale";
import { clampX, visibleBand } from "../lib/safeArea";

const TIP_ATTR = "data-tip";

interface Anchor {
  text: string;
  cx: number; // trigger centre x
  top: number; // trigger top / bottom (viewport coords)
  bottom: number;
}

/**
 * App-wide styled tooltips. Mounted once.
 *
 * A MutationObserver permanently relocates every `title` attribute to `data-tip`
 * (and mirrors it to `aria-label` for icon-only controls) — so the browser never
 * has a `title` to show its own tooltip, even after React re-adds one on render.
 * Because the hover logic only ever READS `data-tip` (it never mutates attributes
 * mid-hover), there's no race between the native and custom tooltips.
 */
export default function TooltipHost() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; place: "top" | "bottom" } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // Relocate `title` → `data-tip` everywhere, now and as the DOM changes.
  useEffect(() => {
    const sponge = (el: Element) => {
      const t = el.getAttribute("title");
      if (t == null) return;
      el.setAttribute(TIP_ATTR, t);
      el.removeAttribute("title");
      // Keep an accessible name for icon-only controls that relied on `title`.
      if (!el.getAttribute("aria-label") && !(el as HTMLElement).textContent?.trim()) {
        el.setAttribute("aria-label", t);
      }
    };
    const sweep = (root: Element) => {
      if (root.hasAttribute("title")) sponge(root);
      root.querySelectorAll("[title]").forEach(sponge);
    };
    sweep(document.body);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") {
          if (m.target instanceof Element) sponge(m.target);
        } else {
          m.addedNodes.forEach((n) => {
            if (n instanceof Element) sweep(n);
          });
        }
      }
    });
    obs.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });
    return () => obs.disconnect();
  }, []);

  // Hover tracking — reads `data-tip` only, never mutates the DOM.
  useEffect(() => {
    const SHOW_DELAY = 420;
    let el: Element | null = null;
    let timer = 0;

    const clear = () => {
      window.clearTimeout(timer);
      el = null;
      setAnchor(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target as HTMLElement | null;
      const t = target?.closest?.(`[${TIP_ATTR}]`) ?? null;
      if (t === el) return; // still over the same trigger (or its children)
      clear();
      const text = t?.getAttribute(TIP_ATTR);
      if (!t || !text) return;
      el = t;
      timer = window.setTimeout(() => {
        if (!t.isConnected) return;
        const r = t.getBoundingClientRect();
        setAnchor({ text, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
      }, SHOW_DELAY);
    };
    const onOut = (e: PointerEvent) => {
      if (!el) return;
      const rel = e.relatedTarget as Node | null;
      if (rel && el.contains(rel)) return; // moved within the same trigger
      clear();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    window.addEventListener("pointerdown", clear, true); // hide on click
    window.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      window.removeEventListener("pointerdown", clear, true);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  /* Touch: a long press stands in for a hover.
     ------------------------------------------------------------------------
     The hover path above returns immediately for `pointerType === "touch"`,
     which is correct — a finger has no hover to track — but it left every
     icon-only control on a phone with no label at all. The MutationObserver
     mirrors `title` to `aria-label`, so a screen reader is fine; a person
     looking at the screen is not.

     Holding still on a control for half a second shows its tip, and the tap
     that would otherwise follow is SWALLOWED: a deliberate "what is this?"
     gesture should not also press the button it is asking about. That one
     suppressed click is the reason this needs a capture-phase listener rather
     than being purely decorative.

     It stands down for anything that is already a drag: past the slop, or on a
     row the Layers panel has picked up (its own long press lifts at 350ms, and
     a tip appearing over a row in flight would be noise on top of a gesture
     the user is mid-way through). */
  useEffect(() => {
    const HOLD = 500; // long enough not to fire on a tap, short enough to find
    const SLOP = 10; // past this the press is a drag, not a question
    const LINGER = 2600; // a tip with no pointer-out to end it needs an ending
    let timer = 0;
    let hideTimer = 0;
    let start: { x: number; y: number } | null = null;
    let swallowClick = false;

    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      start = null;
    };
    const onDown = (e: PointerEvent) => {
      swallowClick = false;
      if (e.pointerType !== "touch") return;
      const t = (e.target as HTMLElement | null)?.closest?.(`[${TIP_ATTR}]`) ?? null;
      const text = t?.getAttribute(TIP_ATTR);
      if (!t || !text) return;
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => {
        timer = 0;
        if (!t.isConnected) return;
        if (t.closest('[data-dragging="true"]')) return; // a row already in flight
        const r = t.getBoundingClientRect();
        swallowClick = true;
        setAnchor({ text, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => setAnchor(null), LINGER);
      }, HOLD);
    };
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerType !== "touch") return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) stop();
    };
    const onUp = () => stop();
    /* Capture phase, so the control never sees the click the long press ended
       with. Fires once: the flag is cleared on the next press either way. */
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", onClick, true);
    return () => {
      stop();
      window.clearTimeout(hideTimer);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", onClick, true);
    };
  }, []);

  // Drop the measured position the moment the anchor goes away, DURING render:
  // keeping it would flash the next tip at the previous one's coordinates for a
  // frame. The MEASUREMENT below cannot move out of an effect — it reads
  // offsetWidth/offsetHeight, which only mean anything after layout.
  const [seenAnchor, setSeenAnchor] = useState(anchor);
  if (seenAnchor !== anchor) {
    setSeenAnchor(anchor);
    if (!anchor) setPos(null);
  }

  // Position once measured: centre on the trigger, flip above if there's no room
  // below, and clamp within the viewport.
  useEffect(() => {
    if (!anchor) return;
    const el = tipRef.current;
    if (!el) return;
    // The tip is UI-scale-zoomed: offset sizes are local px (×z to compare
    // against viewport coords), and style offsets render ×z (÷z on write).
    const z = uiZoom();
    const tw = el.offsetWidth * z;
    const th = el.offsetHeight * z;
    const gap = 8;
    const margin = 6;
    const band = visibleBand();
    const place: "top" | "bottom" =
      anchor.bottom + gap + th + margin > band.bottom && anchor.top - gap - th - margin > band.top
        ? "top"
        : "bottom";
    const left = clampX(anchor.cx - tw / 2, tw, margin) / z;
    const top = (place === "bottom" ? anchor.bottom + gap : anchor.top - gap - th) / z;
    setPos({ left, top, place });
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className={styles.tip}
      data-place={pos?.place ?? "bottom"}
      style={{
        left: pos?.left ?? anchor.cx,
        top: pos?.top ?? anchor.bottom + 8,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {anchor.text}
    </div>,
    document.body,
  );
}
