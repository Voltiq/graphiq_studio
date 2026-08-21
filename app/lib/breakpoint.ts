/**
 * The mobile breakpoint, in a module of its own.
 *
 * Deliberately NOT in useMediaQuery.ts, which is `"use client"`: a server
 * component importing from a client module gets client REFERENCES back rather
 * than values, so the root layout could not read the string to inline it into
 * the pre-hydration script. Both the hook and the layout import it from here,
 * which keeps one definition rather than a copy that drifts.
 */

/** The single mobile breakpoint. Kept as a constant so the JS hook and any CSS
 *  that mirrors it stay in step; on mobile the layout is driven entirely by the
 *  `html[data-mobile]` attribute this powers, not a CSS `@media` block, so this
 *  one query is the sole source of truth.
 *
 *  WIDTH ALONE CANNOT DECIDE THIS, which `(max-width: 767px)` demonstrated in
 *  three directions at once: a phone in landscape is 844px wide and got the
 *  desktop shell on a 390px-tall screen; an iPad mini in portrait is 744px wide
 *  and got the phone shell; and a desktop window dragged narrow got touch-sized
 *  controls with a mouse attached.
 *
 *  So the question is asked in two parts. `(pointer: coarse) and (hover: none)`
 *  is the device — a finger, with nothing to hover — which alone settles the
 *  narrow desktop window. Then EITHER dimension being small settles the rest:
 *  600px of width separates every phone in portrait (the widest are ~430) from
 *  every tablet (the smallest, an iPad mini, is 744), and 500px of height
 *  catches those same phones turned sideways without catching a tablet in
 *  landscape (an iPad mini is 744px tall that way).
 *
 *  A malformed query is not an error — `matchMedia` parses it to `not all` and
 *  quietly never matches — so the rail asserts the parsed text, not just the
 *  result. */
export const MOBILE_QUERY =
  "(pointer: coarse) and (hover: none) and ((max-width: 600px) or (max-height: 500px))";
