"use client";

import { useEffect } from "react";
import { FOCUSABLE_SELECTOR, isTextEntry, nextFocusIndex, preferredInitialFocus } from "../lib/focus";

/**
 * App-wide keyboard behaviour for modal dialogs (TODO §11).
 *
 * The app had focus RINGS everywhere but no focus MANAGEMENT: opening a modal
 * left the keyboard on the page behind it, Tab walked straight out into the
 * editor underneath, and closing one dropped focus on <body> — so a keyboard
 * user who opened Preferences could not get back to the toolbar.
 *
 * This is one observer rather than an edit to each of the ~35 dialogs, because
 * they already share an exact structure: a full-screen `.overlay` backdrop whose
 * child carries `role="dialog"`. That structure IS the modal/non-modal
 * discriminator — the options-bar popovers, the colour popover and the gradient
 * editor also use `role="dialog"` but render straight into <body> with no
 * backdrop, and trapping focus inside a dropdown would strand the rest of the UI.
 * A dialog can still opt out explicitly with `data-focus-trap="off"`.
 *
 * Escape is deliberately left alone: dialogs own it, and several need to finish
 * work (commit a live adjustment, discard a float) on the way out.
 */
const isModalDialog = (el: Element): boolean => {
  if (el.getAttribute("data-focus-trap") === "off") return false;
  const parent = el.parentElement;
  return !!parent && /overlay/i.test(parent.className || "");
};

const openModals = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(isModalDialog);

const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // offsetParent is null inside display:none, so a collapsed section's
    // controls never become invisible stops on the Tab path.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );

export default function DialogFocus() {
  useEffect(() => {
    // The element that had focus before each dialog opened, innermost last, so
    // nested dialogs (a confirm on top of Preferences) unwind in order.
    const openers: { dialog: HTMLElement; opener: HTMLElement | null }[] = [];

    const sync = () => {
      const current = openModals();
      // Newly opened: remember the opener and move focus inside.
      for (const d of current) {
        if (openers.some((o) => o.dialog === d)) continue;
        const opener = document.activeElement as HTMLElement | null;
        openers.push({ dialog: d, opener: opener && opener !== document.body ? opener : null });
        /* `data-touch` is stamped before the first paint (layout.tsx) and kept
           in step by the editor, so it is the shell's own answer to "is this a
           finger?" — and it is right on the very first dialog of a session,
           which a media query read at mount would not be. */
        const touch = document.documentElement.dataset.touch === "true";
        const self = d.contains(document.activeElement) ? document.activeElement : null;
        /* A dialog that focused itself is normally left alone. On touch there
           is one exception, and it is most of them: six dialogs put `autoFocus`
           on their own text input, which never reaches this function at all —
           so suppressing auto-focus here moved 6 dialogs to 4 and no further.
           Taking that focus away is the same decision, applied to the case that
           bypassed it. */
        if (self && !(touch && isTextEntry(self))) continue;
        const list = focusablesIn(d);
        const i = preferredInitialFocus(list, touch);
        if (i >= 0) list[i].focus();
        else if (self) {
          /* Nothing safe to land on: park focus on the dialog rather than leave
             it in the text field, which is what opened the keyboard. */
          (self as HTMLElement).blur();
          if (!d.hasAttribute("tabindex")) d.setAttribute("tabindex", "-1");
          d.focus();
        } else {
          if (!d.hasAttribute("tabindex")) d.setAttribute("tabindex", "-1");
          d.focus();
        }
      }
      // Closed: hand focus back to whatever opened it.
      for (let i = openers.length - 1; i >= 0; i--) {
        const entry = openers[i];
        if (current.includes(entry.dialog)) continue;
        openers.splice(i, 1);
        const active = document.activeElement;
        const stranded = !active || active === document.body || entry.dialog.contains(active);
        if (stranded && entry.opener && document.body.contains(entry.opener)) {
          entry.opener.focus();
        }
      }
    };

    // Trap Tab inside the TOPMOST modal. Only the ends are intercepted — in the
    // middle the browser's own order understands tabindex and shadow content
    // better than a hand-rolled walk does.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const stack = openModals();
      const top = stack[stack.length - 1];
      if (!top) return;
      const list = focusablesIn(top);
      if (!list.length) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      const atEnd = e.shiftKey ? current === 0 : current === list.length - 1;
      if (current !== -1 && !atEnd) return;
      e.preventDefault();
      list[nextFocusIndex(current, list.length, e.shiftKey)]?.focus();
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return null;
}
