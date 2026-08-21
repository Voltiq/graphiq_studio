/**
 * The display's unusable edges, for code that positions things by hand.
 *
 * CSS gets at these through the `--safe-t/r/b/l` tokens (globals.scss). Popups
 * cannot: they are placed from an anchor's rect in JS and were all clamped to
 * `window.innerWidth`, which is the whole display INCLUDING whatever the notch
 * and the rounded corners cover. On a phone held in landscape the cutout moves
 * to one side, so a popup pushed against that edge lands underneath it.
 *
 * Read from the tokens rather than calling `env()` again, so there is still one
 * definition of what an inset is — and so a mutation to the tokens shows up
 * here too rather than leaving JS and CSS quietly disagreeing.
 */

export type Insets = { top: number; right: number; bottom: number; left: number };

const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Current insets in CSS px. Zero on a desktop browser, and zero during SSR.
 *
 * Read fresh each time rather than cached: they change when the device rotates,
 * and every caller reads them while opening a popup, which is rare enough that
 * one style read costs nothing.
 */
export function safeInsets(): Insets {
  if (typeof window === "undefined") return NONE;
  const cs = getComputedStyle(document.documentElement);
  const n = (name: string) => {
    // A custom property holding env() computes to the substituted length, so
    // this is a real number — but it is "" if the token is ever removed.
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return { top: n("--safe-t"), right: n("--safe-r"), bottom: n("--safe-b"), left: n("--safe-l") };
}

/**
 * Clamp a popup's LEFT edge so the popup sits inside the safe box, keeping
 * `margin` clear of both edges.
 *
 * `width` is the popup's own width. When the popup is wider than the space
 * available it pins to the left rather than hanging off that side, which is
 * what the hand-rolled versions did when their two bounds crossed.
 */
export function clampX(left: number, width: number, margin = 8): number {
  const { left: safeL, right: safeR } = safeInsets();
  const min = safeL + margin;
  const max = window.innerWidth - safeR - width - margin;
  return Math.min(Math.max(min, left), Math.max(min, max));
}

/**
 * The band of the layout viewport that is actually VISIBLE, in client px —
 * the coordinate space `getBoundingClientRect()` reports in.
 *
 * `window.innerHeight` is the layout viewport, which is not what the user can
 * see the moment anything overlays it: a virtual keyboard takes the bottom
 * third and the page is not told through `innerHeight` at all. `visualViewport`
 * is, and it also covers pinch-zoom, where the visible band is both smaller and
 * offset. Safe-area insets are folded in for the same reason `clampX` does it.
 */
export function visibleBand(): { top: number; bottom: number } {
  if (typeof window === "undefined") return { top: 0, bottom: 0 };
  const vv = window.visualViewport;
  const { top: safeT, bottom: safeB } = safeInsets();
  const offset = vv?.offsetTop ?? 0;
  return {
    top: offset + safeT,
    bottom: offset + (vv?.height ?? window.innerHeight) - safeB,
  };
}

/**
 * Clamp a popup's TOP edge so the popup sits inside the visible band, keeping
 * `margin` clear of both ends. Pins to the top when it cannot fit, which is
 * what the hand-rolled versions did when their bounds crossed.
 */
export function clampY(top: number, height: number, margin = 8): number {
  const band = visibleBand();
  const min = band.top + margin;
  const max = band.bottom - height - margin;
  return Math.min(Math.max(min, top), Math.max(min, max));
}
