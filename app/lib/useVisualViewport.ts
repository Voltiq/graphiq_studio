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
      keepFocusVisible(hidden);
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    /* A field can be focused while the keyboard is already up — moving between
       two inputs never resizes the viewport, so nothing above would fire. */
    const onFocus = () => {
      const height = vv?.height ?? window.innerHeight;
      const offset = vv?.offsetTop ?? 0;
      keepFocusVisible(Math.max(0, Math.round(window.innerHeight - height - offset)));
    };
    document.addEventListener("focusin", onFocus);
    /* Dev-only handle, in the same family as `__gqFits` and `__gqPanelRenders`.
       A harness cannot summon a real keyboard: the browser shrinks the VISUAL
       viewport, and nothing Playwright can drive does that. Writing
       `--kb-inset` by hand simulates the CSS half but fires no event, so the
       scrolling never runs. This lets the rail ask for the behaviour directly
       and measure what it does to a real dialog with a real scroller; that the
       listeners are wired at all is checked separately, by dispatching a
       `visualViewport` resize and watching the token recompute. */
    const dbg = window as unknown as { __gqKeepFocusVisible?: (hidden: number) => void };
    if (process.env.NODE_ENV !== "production") dbg.__gqKeepFocusVisible = keepFocusVisible;
    return () => {
      delete dbg.__gqKeepFocusVisible;
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", onFocus);
      root.style.removeProperty("--kb-inset");
      root.style.removeProperty("--vv-h");
    };
  }, []);
}

/** The nearest ancestor that can actually scroll vertically. */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

const FIELD = "input, textarea, select, [contenteditable='true']";

/**
 * Scroll whatever has focus back above the keyboard.
 *
 * A dialog's own sizing keeps the BOX above the keyboard; it says nothing about
 * where in that box the focused field sits. Measured at 390×844 with a 300px
 * keyboard, focusing Export's last field left it **185px below the keyboard
 * line** — typing into something you cannot see.
 *
 * Deliberately not `scrollIntoView`, which measures against the LAYOUT viewport
 * and so believes a field behind the keyboard is already visible. The delta is
 * computed against the visible area and applied to the nearest real scroller —
 * which, since dialogs became a column flex with a scrolling middle, is the
 * dialog body.
 *
 * Moves by the minimum needed and never scrolls a field that is already
 * visible, so it cannot fight the user's own scrolling.
 */
function keepFocusVisible(hidden: number): void {
  if (hidden <= 0) return;
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || !el.matches?.(FIELD)) return;
  const visibleBottom = window.innerHeight - hidden;
  const r = el.getBoundingClientRect();
  const MARGIN = 12;
  const delta = Math.round(r.bottom + MARGIN - visibleBottom);
  if (delta <= 0) return;
  const scroller = scrollableAncestor(el);
  if (scroller) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
}
