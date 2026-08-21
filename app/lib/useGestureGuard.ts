"use client";

import { useEffect } from "react";

/**
 * Stops the BROWSER's gestures from fighting the editor's own.
 *
 * `touch-action: pan-x pan-y` on the body already denies the page a pinch in
 * every engine that honours it. This is the second line, for the one that
 * historically did not: iOS Safari ignores `user-scalable=no` outright, and on
 * older versions the only thing that reliably cancels a page pinch is
 * preventing its proprietary `gesture*` events. They do not exist in Chromium,
 * which is why this is belt-and-braces rather than the primary mechanism.
 *
 * The canvas is excluded deliberately: it runs its own pinch-to-zoom, and its
 * `touch-action: none` already tells the browser to keep out.
 */
export function useGestureGuard(): void {
  useEffect(() => {
    const overCanvas = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('[data-tour="canvas"]');

    const onGesture = (e: Event) => {
      if (!overCanvas(e.target)) e.preventDefault();
    };
    /* Two fingers anywhere but the canvas is a page pinch, never a scroll —
       a one-finger drag is left alone so panels still scroll normally. */
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1 && !overCanvas(e.target)) e.preventDefault();
    };

    const gestures = ["gesturestart", "gesturechange", "gestureend"];
    for (const name of gestures) document.addEventListener(name, onGesture, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      for (const name of gestures) document.removeEventListener(name, onGesture);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);
}
