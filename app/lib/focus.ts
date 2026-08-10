// Keyboard navigation (TODO §11) — the focus rules every modal dialog shares.
//
// The app had focus RINGS everywhere but no focus MANAGEMENT: opening a dialog
// left the keyboard back on the page behind it, Tab walked straight out of the
// dialog into the editor underneath, and closing one dropped focus on <body>.
// This module is the shared answer; `useDialogFocus` applies it.
//
// The selector and the wrap arithmetic are pure so they can be Node-verified;
// only the hook touches the DOM.

/** Everything that can take keyboard focus, in DOM order. Disabled controls,
 *  `tabindex="-1"` and hidden inputs are excluded — they are skipped by the
 *  browser too, so a trap that counted them would jump over gaps. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Where Tab should land, given the currently focused index. Returns an index
 * into the focusable list, wrapping at both ends — that wrap IS the trap.
 *
 * `current` of -1 means focus is outside the container (the browser moved it
 * somewhere we don't own): Tab enters at the top, Shift+Tab at the bottom.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  const next = backwards ? current - 1 : current + 1;
  return (next + count) % count;
}

/** Should this element take focus when its dialog opens? Text inputs are the
 *  natural landing spot (you can type straight away); otherwise the first
 *  control. A destructive button is never auto-focused — Enter would fire it. */
export function preferredInitialFocus<T extends { tagName: string; type?: string; dataset?: Record<string, string | undefined> }>(
  items: T[],
): number {
  if (!items.length) return -1;
  const isText = (el: T) =>
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      !["checkbox", "radio", "range", "color", "file", "button", "submit"].includes(
        (el.type || "text").toLowerCase(),
      ));
  const text = items.findIndex(isText);
  if (text >= 0) return text;
  const safe = items.findIndex((el) => el.dataset?.destructive === undefined);
  return safe >= 0 ? safe : 0;
}
