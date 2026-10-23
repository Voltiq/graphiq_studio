// A small external store for the editor's state (TODO 1.5). A component reads
// the part it needs through `useStore`, which subscribes it to that part alone,
// instead of taking it as a prop that Editor threads down to it.

import { useLayoutEffect, useReducer, useRef } from "react";

/** A new value, or a function of the old one — what `useState`'s setter takes. */
export type Update<V> = V | ((prev: V) => V);

export interface Store<S extends object> {
  /** The state now: the same object until something in it changes. */
  get(): S;
  /** Merge a patch, or what a function of the state returns. Listeners are
   *  told only when a field changed (by `Object.is`, as `useState` decides). */
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(listener: () => void): () => void;
  /** One field's setter, shaped like `useState`'s: a value or an updater. The
   *  same function every time it is asked for, as a `useState` setter is. */
  setter<K extends keyof S>(key: K): (next: Update<S[K]>) => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  const setters = new Map<keyof S, (next: never) => void>();
  const store: Store<S> = {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      const changed = (Object.keys(p) as (keyof S)[]).some((k) => !Object.is(p[k], state[k]));
      if (!changed) return;
      state = { ...state, ...p };
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setter<K extends keyof S>(key: K) {
      let fn = setters.get(key) as ((next: Update<S[K]>) => void) | undefined;
      if (!fn) {
        fn = (next: Update<S[K]>) =>
          store.set(
            (s) =>
              ({
                [key]: typeof next === "function" ? (next as (prev: S[K]) => S[K])(s[key]) : next,
              }) as unknown as Partial<S>,
          );
        setters.set(key, fn);
      }
      return fn;
    },
  };
  return store;
}

/** Subscribe to what `select` picks out of the store. It must pick, not build:
 *  a new object every call would never be equal to the last one.
 *
 *  NOT `useSyncExternalStore`, deliberately. That hook renders a store change
 *  synchronously, whatever caused it, while a `useState` update made after an
 *  `await` or in a timer waits for a later pass — so a document opened from a
 *  file would commit in two steps: the store's half (the new tab) first, the
 *  state's half (its pixels, queued to load) after, with effects running on
 *  the half-made one in between. A re-render dispatched like any state update
 *  takes the priority of whatever caused it, and lands in the same commit as
 *  the state set beside it — exactly as when all of it was `useState`. Tearing,
 *  the reason the other hook exists, needs concurrent rendering, which this app
 *  does not use (no transitions, no Suspense).
 *
 *  Kept out of the React Compiler ("use no memo"): it reads the store during
 *  render, which the compiler cannot see change — compiled, `select(store.get())`
 *  was memoized on a stable store and selector, and a component re-rendered
 *  with the value it had first. */
export function useStore<S extends object, V>(store: Store<S>, select: (s: S) => V): V {
  "use no memo";
  const value = select(store.get());
  // What this render showed, and the selector that picked it: the listener
  // compares against it. Brought up to date as each render commits.
  const shown = useRef({ value, select });
  useLayoutEffect(() => {
    shown.current = { value, select };
  });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const check = () => {
      const { value: was, select: pick } = shown.current;
      if (!Object.is(pick(store.get()), was)) rerender();
    };
    check(); // a change between the render and this subscription
    return store.subscribe(check);
  }, [store]);
  return value;
}
