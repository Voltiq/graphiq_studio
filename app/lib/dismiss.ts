"use client";

/**
 * The stack of things a "back" should close before it leaves the app.
 *
 * On a phone the back gesture is how you dismiss anything, and there was
 * nothing to consume it: back left the editor outright, taking the document
 * with it. The layers that should absorb it — the tool and panel drawers, the
 * menu sheet — each own their own open state in their own component, so this is
 * a registry rather than a lifted flag: a component says "while I am open, here
 * is how to close me", and the back guard closes the most recent one first.
 *
 * LIFO because that is what "back" means: the thing opened last is the thing in
 * front of you. Modal dialogs deliberately do NOT register — they sit above
 * everything and own Escape themselves (see DialogFocus), so the guard tries
 * them first and by their own route.
 */

let nextId = 1;
const stack: { id: number; close: () => void }[] = [];

/** Register a way to close this layer; call the returned function when it shuts. */
export function registerDismissible(close: () => void): () => void {
  const id = nextId++;
  stack.push({ id, close });
  return () => {
    const i = stack.findIndex((e) => e.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Close the most recently opened layer. False when there was nothing to close. */
export function dismissTop(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}

/** Whether anything is registered — for callers that need to look before leaping. */
export function hasDismissible(): boolean {
  return stack.length > 0;
}
