"use client";

/**
 * Shift / Alt / Ctrl for a touchscreen.
 *
 * Roughly thirty canvas behaviours are gated on a held modifier — add and
 * subtract a selection, constrain proportions, resize from centre, the brush
 * HUD, clone-source setting, sample-merged — across 83 call sites. A finger has
 * no modifier keys, so all of them were simply unreachable.
 *
 * Thirty bespoke gestures would be thirty things to learn and thirty places to
 * get wrong. Instead the modifier is LATCHED here and injected into the event
 * before anything reads it, so every one of those sites keeps its existing
 * `e.altKey` test and none of them has to know a finger was involved.
 *
 * WHY THIS WORKS, and it was measured before it was built: React copies the
 * properties it exposes off the native event when it builds its synthetic one,
 * so a capture-phase listener on `window` — which runs before React's root
 * listener — can redefine them and React hands the new values on. Verified end
 * to end through a real behaviour: with `altKey` injected, the Zoom tool zoomed
 * OUT (67% -> 50%) instead of in.
 *
 * The flags are one-shot by default: armed, used by the next gesture, then
 * cleared, the way sticky keys work. Tapping an armed chip again LOCKS it until
 * it is tapped off, for the cases where a whole series of gestures wants it.
 */

export type ModifierName = "shift" | "alt" | "ctrl";
export type ModifierState = Record<ModifierName, "off" | "armed" | "locked">;

const OFF: ModifierState = { shift: "off", alt: "off", ctrl: "off" };

let state: ModifierState = { ...OFF };
const listeners = new Set<(s: ModifierState) => void>();

const emit = () => {
  for (const fn of listeners) fn(state);
};

export function getModifiers(): ModifierState {
  return state;
}

export function subscribeModifiers(fn: (s: ModifierState) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** off -> armed -> locked -> off, which is the whole interaction. */
export function cycleModifier(name: ModifierName): void {
  const next = state[name] === "off" ? "armed" : state[name] === "armed" ? "locked" : "off";
  state = { ...state, [name]: next };
  emit();
}

export function clearArmedModifiers(): void {
  if (!(["shift", "alt", "ctrl"] as const).some((k) => state[k] === "armed")) return;
  state = {
    shift: state.shift === "locked" ? "locked" : "off",
    alt: state.alt === "locked" ? "locked" : "off",
    ctrl: state.ctrl === "locked" ? "locked" : "off",
  };
  emit();
}

/** Events whose modifier flags a canvas behaviour might read. */
const TYPES = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "wheel",
] as const;

/**
 * The surfaces a latched modifier applies to: the canvas, and the panels.
 *
 * Both are the user's DOCUMENT — the canvas holds the pixels and the panels
 * hold its structure, and each has behaviours that only a held key could reach:
 * Alt-click a Layers row to clip it to the one below, Shift-click a mask to
 * disable it, Ctrl-click a channel to add it to the selection.
 *
 * The app's own chrome is deliberately NOT in this list. A latched Alt has no
 * business changing what a menu, a dialog or the bottom bar does, and quietly
 * rewriting every event in the document would be a trap set for whoever debugs
 * the next odd click.
 */
const SURFACES = '[data-tour="canvas"], [data-tour="dock"], [aria-label="Left dock"]';

/**
 * Start injecting latched modifiers. Returns a function that stops it.
 *
 * Capture phase on `window`, so it runs before React's listener and before any
 * handler the app registers itself.
 */
export function installModifierInjection(): () => void {
  const inject = (e: Event) => {
    if (state.shift === "off" && state.alt === "off" && state.ctrl === "off") return;
    const target = e.target;
    if (!(target instanceof Element) || !target.closest(SURFACES)) return;
    const set = (prop: string, on: boolean) => {
      if (!on) return;
      try {
        Object.defineProperty(e, prop, { value: true, configurable: true });
      } catch {
        /* a browser that will not let the flag be redefined: the gesture simply
           behaves as it did before, which is no worse than not having latched */
      }
    };
    set("shiftKey", state.shift !== "off");
    set("altKey", state.alt !== "off");
    set("ctrlKey", state.ctrl !== "off");
  };
  /* One-shot, but only a gesture on one of those SURFACES spends it. Tapping the chip is itself a
     pointer gesture: spending on any pointerup meant the chip's own release
     cleared the flag it had just set, and the second tap appeared to do nothing
     — arming again rather than locking. "Armed for the next gesture" always
     meant the next gesture on the canvas. */
  let onCanvas = false;
  const noteStart = (e: Event) => {
    onCanvas = e.target instanceof Element && !!e.target.closest(SURFACES);
  };
  const spend = () => {
    const was = onCanvas;
    onCanvas = false;
    if (!was) return;
    /* Deferred by a turn, because `click` is dispatched AFTER `pointerup` — and
       the panel behaviours are onClick handlers, not onPointerDown ones. Spent
       synchronously here, a tap on a Layers row saw `pointerdown alt=true,
       mousedown alt=true, click alt=FALSE`, so nothing clipped: the canvas
       worked and the panels did not, for a reason that was invisible from
       either end. */
    setTimeout(clearArmedModifiers, 0);
  };
  for (const type of TYPES) window.addEventListener(type, inject, true);
  window.addEventListener("pointerdown", noteStart, true);
  window.addEventListener("pointerup", spend, false);
  window.addEventListener("pointercancel", spend, false);
  return () => {
    for (const type of TYPES) window.removeEventListener(type, inject, true);
    window.removeEventListener("pointerdown", noteStart, true);
    window.removeEventListener("pointerup", spend, false);
    window.removeEventListener("pointercancel", spend, false);
  };
}
