/** Client-safe UI-scale constants & helpers (no server-only imports here).
 *
 * The interface scale (TODO §11) zooms the CHROME — top bar, options bar,
 * toolbar, right dock, status bar, dialogs and portalled popups — via CSS
 * `zoom: var(--ui-zoom)` while the canvas viewport (tabs, rulers, stage) stays
 * at 100% so document pixels remain exact (no resampling of the image view).
 *
 * Persisted in a cookie and rendered server-side as `data-uiscale` on <html>
 * (same no-flash pattern as the theme/accent cookies); globals.scss maps the
 * attribute to `--ui-zoom`.
 *
 * Positioning gotcha: `zoom` multiplies an element's own left/top too, so a
 * `position: fixed` popup that is itself zoomed must divide viewport-space
 * coordinates by `uiZoom()` when writing them to styles. Element measurements
 * mix two spaces — getBoundingClientRect() returns VIEWPORT px (zoom already
 * applied) while offsetWidth/offsetHeight return LOCAL px (multiply by
 * `uiZoom()` to compare against client coordinates).
 */

export type UiScale = "compact" | "default" | "comfortable" | "large";

export const UISCALE_COOKIE = "pe-uiscale";
export const DEFAULT_UISCALE: UiScale = "default";

export const UI_SCALES: { id: UiScale; label: string; zoom: number }[] = [
  { id: "compact", label: "Compact", zoom: 0.9 },
  { id: "default", label: "Default", zoom: 1 },
  { id: "comfortable", label: "Comfortable", zoom: 1.1 },
  { id: "large", label: "Large", zoom: 1.25 },
];

export function isUiScale(v: unknown): v is UiScale {
  return typeof v === "string" && UI_SCALES.some((s) => s.id === v);
}

export function zoomOf(scale: UiScale): number {
  return UI_SCALES.find((s) => s.id === scale)?.zoom ?? 1;
}

/** Browsers without standardized CSS zoom ignore the property entirely — the
 *  UI stays at 100% there, so popup math must use 1, not the configured value. */
let zoomSupported: boolean | null = null;
function supportsZoom(): boolean {
  if (zoomSupported === null) {
    zoomSupported =
      typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "2");
  }
  return zoomSupported;
}

/** The zoom factor currently applied to the chrome (1 when SSR, default scale,
 *  or the browser doesn't support CSS zoom). */
export function uiZoom(): number {
  if (typeof document === "undefined" || !supportsZoom()) return 1;
  const attr = document.documentElement.getAttribute("data-uiscale");
  return isUiScale(attr) ? zoomOf(attr) : 1;
}

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Apply a scale live (data attribute → CSS var) and persist it. */
export function applyUiScale(scale: UiScale): void {
  document.documentElement.setAttribute("data-uiscale", scale);
  document.cookie = `${UISCALE_COOKIE}=${scale}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
}

/** The scale currently rendered on <html> (mirrors liveAccent()). */
export function liveUiScale(): UiScale {
  if (typeof document !== "undefined") {
    const s = document.documentElement.getAttribute("data-uiscale");
    if (isUiScale(s)) return s;
  }
  return DEFAULT_UISCALE;
}
