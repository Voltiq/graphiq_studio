"use client";

import { useEffect, useState } from "react";
import { MOBILE_QUERY, TABLET_QUERY } from "./breakpoint";

/** Reactive `window.matchMedia` — re-renders when the query starts/stops
 *  matching. SSR-safe: returns `false` until mounted (desktop-first, so the
 *  server render and first client paint agree). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Re-exported so existing imports keep working; defined in ./breakpoint,
 *  which the root layout also reads. See the note there. */
export { MOBILE_QUERY, TABLET_QUERY, TOUCH_QUERY } from "./breakpoint";

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);

/** A touch device that is not a phone. Mutually exclusive with `useIsMobile`. */
export const useIsTablet = () => useMediaQuery(TABLET_QUERY);
