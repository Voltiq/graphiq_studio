"use client";

import { useEffect, useState } from "react";

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

/** The single mobile breakpoint. Kept as a constant so the JS hook and any CSS
 *  that mirrors it stay in step; on mobile the layout is driven entirely by the
 *  `html[data-mobile]` attribute this powers, not a CSS `@media` block, so this
 *  one query is the sole source of truth. */
export const MOBILE_QUERY = "(max-width: 767px)";

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
