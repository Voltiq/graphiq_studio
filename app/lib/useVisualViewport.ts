"use client";

import { useEffect } from "react";

/**
 * Publishes the visual viewport to CSS, once, for overlays to subtract.
 *
 * `--kb-inset` is how much of the layout viewport is hidden BELOW the visible
 * area: a virtual keyboard, or a browser toolbar drawn over the page. CSS has
 * no way to ask — `dvh` tracks the toolbar but knows nothing about a keyboard,
 * which is precisely the case where a dialog's buttons end up unreachable — so
 * it has to come from `visualViewport`, which is what this reads.
 *
 * `--vv-h` is the visible height itself, for anything that wants to size to it
 * directly rather than subtract.
 *
 * Both are set on the root element so any overlay can use them without
 * plumbing, and both default to a sane value in globals.scss so a component
 * rendered before this mounts (or during SSR) still lays out correctly.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      const height = vv?.height ?? window.innerHeight;
      const offset = vv?.offsetTop ?? 0;
      /* Only what is hidden at the FOOT. Pinch-zoom also hides a strip at the
         top, but that is what `offsetTop` describes and overlays anchor to the
         top already. Clamped at zero: the visual viewport can report slightly
         larger than the layout one mid-gesture. */
      const hidden = Math.max(0, Math.round(window.innerHeight - height - offset));
      root.style.setProperty("--kb-inset", `${hidden}px`);
      root.style.setProperty("--vv-h", `${Math.round(height)}px`);
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--kb-inset");
      root.style.removeProperty("--vv-h");
    };
  }, []);
}
