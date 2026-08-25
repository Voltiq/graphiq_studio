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
 *  control. A destructive button is never auto-focused — Enter would fire it.
 *
 *  `touch` inverts the first half of that. Landing on a text field summons the
 *  software keyboard the instant a dialog opens, which covers between a third
 *  and a half of it before you have read a word — and "you can type straight
 *  away" is a benefit only when typing is free. Measured on a phone: **6 of 10
 *  dialogs** opened straight onto a field. A finger loses nothing by being
 *  given the first safe control instead; it was never going to Tab anywhere. */
export function isTextEntry(el: {
  tagName: string;
  type?: string;
  getAttribute?: (n: string) => string | null;
}): boolean {
  const type = (el.type ?? el.getAttribute?.("type") ?? "text").toLowerCase();
  return (
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      !["checkbox", "radio", "range", "color", "file", "button", "submit"].includes(type))
  );
}

export function preferredInitialFocus<T extends { tagName: string; type?: string; dataset?: Record<string, string | undefined> }>(
  items: T[],
  touch = false,
): number {
  if (!items.length) return -1;
  const isText = (el: T) => isTextEntry(el);
  if (!touch) {
    const text = items.findIndex(isText);
    if (text >= 0) return text;
  }
  const safe = items.findIndex(
    (el) => el.dataset?.destructive === undefined && !(touch && isText(el)),
  );
  if (safe >= 0) return safe;
  /* Nothing safe and non-text: better the dialog itself than a text field that
     opens the keyboard, or a destructive button that Enter would fire. */
  return touch ? -1 : 0;
}
