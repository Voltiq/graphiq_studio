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

/** The DEVICE, with nothing said about the screen: a finger, and nothing to
 *  hover. This is the right gate for how big a control has to be, which is a
 *  question about the pointer and not about the layout — a tablet's buttons
 *  need the same 44px a phone's do, while its shell looks nothing like one.
 *
 *  Splitting the two apart is what this tier is: `data-touch` sizes things,
 *  `data-mobile` and `data-tablet` lay them out. Before it, the 44px floor and
 *  the slider padding lived inside the phone's block, so a tablet — entirely
 *  touch-driven — got mouse-sized controls: a sweep at 768×1024 found **23
 *  distinct kinds under 44px**, down to a 15×15 swap arrow. */
export const TOUCH_QUERY = "(pointer: coarse) and (hover: none)";

/** A touch device that is not a phone.
 *
 *  Deliberately the exact complement of `MOBILE_QUERY` within `TOUCH_QUERY`, so
 *  every coarse, hoverless device lands in exactly one of the two and none in
 *  both: the phone query claims anything with a short side, this claims the
 *  rest. There is no upper bound, because there is no width at which a tablet
 *  stops being driven by a finger — a 1366px iPad in landscape still needs
 *  44px buttons, and giving it the mouse shell because it is wide would repeat
 *  the mistake this tier exists to fix.
 *
 *  What it changes, measured at 768×1024 before: a 48px rail and a 320px dock
 *  both in flow left **378px of canvas out of 768**, and an iPad mini fared
 *  worse at **354 of 744**. */
export const TABLET_QUERY =
  "(pointer: coarse) and (hover: none) and (min-width: 601px) and (min-height: 501px)";
