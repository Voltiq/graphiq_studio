"use client";

/**
 * Changing the LOOK — theme, accent, contrast, colour vision — in one piece.
 *
 * Every one of these is a swap of tokens on <html>, and every surface that
 * reads them repaints. But the surfaces do not all repaint at the same SPEED:
 * the page background eased over 300ms, buttons and chips over 120ms, fields
 * over 220ms, and everything without a transition of its own switched at once
 * — so a theme change rolled across the interface in a ragged wave, the
 * slowest pieces trailing the rest by a third of a second.
 *
 * So for the swap, every element's own transitions stand down
 * (`html[data-look-switching]`, globals.scss) and the whole interface changes
 * in the same frame; and where the browser can (View Transitions), the old
 * look cross-fades into the new one as a single picture rather than snapping.
 * With Reduce motion on, it simply snaps — all of it, together.
 */

const ATTR = "data-look-switching";

function motionOff(): boolean {
  return (
    document.documentElement.dataset.motion === "off" ||
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/** Let transitions back in once the new look has been painted with them off. */
function release(root: HTMLElement) {
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute(ATTR)));
}

type ViewTransitionDoc = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/** Apply `update` (which changes attributes on <html>) as one swap of the look. */
export function switchLook(update: () => void): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(ATTR, "");
  const doc = document as ViewTransitionDoc;
  if (!motionOff() && typeof doc.startViewTransition === "function") {
    try {
      const t = doc.startViewTransition(update);
      t.finished.finally(() => release(root));
      return;
    } catch {
      // fall through: apply it directly
    }
  }
  update();
  release(root);
}

/** Set an attribute on <html> as a look swap — but quietly the first time,
 *  when there is no previous look to swap from (a page load is not a switch). */
export function setLookAttribute(name: string, value: string): void {
  const root = document.documentElement;
  const prev = root.getAttribute(name);
  if (prev === value) return;
  if (prev === null) root.setAttribute(name, value);
  else switchLook(() => root.setAttribute(name, value));
}

/**
 * The OS switching between light and dark while the theme follows it: the
 * media query flips the tokens with no script involved, so the swap cannot be
 * cross-faded — but it can at least land in one frame. The change event comes
 * before the browser restyles for it, so standing transitions down here is in
 * time. Returns the unsubscribe.
 */
export function watchSystemLook(): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const root = document.documentElement;
    root.setAttribute(ATTR, "");
    release(root);
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
