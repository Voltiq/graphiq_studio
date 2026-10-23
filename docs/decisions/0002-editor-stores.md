# 0002 — Editor state lives in stores the components subscribe to

## Context

`Editor` held 138 `useState`s and passed 134 props to `CanvasArea`, 96 to
`OptionsBar` and 69 to `RightDock`. Every setting the options bar shows was
Editor state, threaded down as a value and a setter to each component that
read it — the shape of interface the bucket-colour regression came from (a
re-run that read the live foreground through one of those props). TODO 1.5.
Re-renders cost no measurable time (D.2): this is about the interface, not
speed.

## Decision

- **A store per slice, not a library.** `app/state/store.ts` is a value, a set
  of listeners and a merge; `useStore(store, select)` subscribes a component.
  A `set` notifies only when a field changed by `Object.is`, as `useState`
  decides. `setter(key)` is a
  field's setter shaped like `useState`'s — a value or an updater, the same
  function every time — so code that called `setBrush(...)` is unchanged.
- **One set per Editor, through context** (`app/state/editor.ts`): created with
  the Editor, provided round it. Nothing is module-global, so a second Editor or
  a test gets state of its own.
- **A slice owns its restore and its save** (`app/state/toolOptions.ts`): the
  defaults, the merge of a saved session over them, and the debounced save —
  the same bundle, key order and timing as before.
- **Components read what they show.** The options bar, the canvas, the rail,
  the dock and the status bar subscribe to the tools' options and the colours;
  Editor subscribes, field by field, only to what it acts on itself. What only
  Editor knows (a frame's fit, the text editor's live selection, the crop box)
  stays a prop.
- **A store change renders like a state change.** `useStore` re-renders
  through a `useReducer` dispatch, not `useSyncExternalStore`: that hook
  renders a store change synchronously, while a `useState` update made after an
  `await` waits for a later pass, so state split between the two would commit
  in two steps (a document's tab before its queued pixels). A dispatch takes
  the priority of whatever caused it and lands in the same commit. Tearing, the
  other hook's reason, needs concurrent rendering, which the app does not use.
- **`useStore` is not compiled** (`"use no memo"`): the React Compiler is on,
  and it memoized the read of the store during render on a stable store and
  selector — a component re-rendered with the value it had first.
- **Selectors pick, they do not build.** A selector returning a new object
  would never equal the last snapshot; derived values (the paint colour, the
  gradient's colours) are computed in the component from what it picked.

## Evidence

- Slice 1 (v3.8.4 — tools' options and colours): `OptionsBar` 96 → 31 props,
  `CanvasArea` 134 → 95, `RightDock` 69 → 61, `Toolbar` and `StatusBar` read
  their colours themselves. A characterization (every tool's options bar from
  defaults and from saved prefs, prefs saved after edits, pixels and history
  from edited tools, the dock's colour and brush panels, a tablet's status bar)
  matched byte for byte against v3.8.3. `tests/state.test.ts` and
  `e2e/tool-options.spec.ts`; mutation-tested (see TODO 1.5).
- Slice 2 (v3.8.5 — the View menu's toggles and the panels):
  `app/state/view.ts`; `CanvasArea` → 88 props, `OptionsBar` → 29. Its own
  characterization (menus' checks, attributes, the dock, storage, the overlay,
  across fifteen toggles and a reload) matched byte for byte;
  `e2e/view-flags.spec.ts`.
- Slice 3 (v3.8.6 — the dialogs): `app/state/dialogs.ts`, a field per dialog,
  not the single `openDialog` slot TODO 1.5 sketched — no shortcut waits for an
  open dialog, so one can open over another today, and one slot would close the
  first. The commands' open table moved with it. Editor 95 → 68 `useState`s.
  Characterized (every command's dialog, stacking) and matched byte for byte;
  `e2e/dialog-state.spec.ts`.
- Slice 4 (v3.8.7 — the documents, the load queue, a pending paste, the
  history): `app/state/documents.ts`, one store because they change together.
  The switch from `useSyncExternalStore` came with it; all four
  characterizations (the documents' own: make, open, switch, save, re-open,
  close, restore) matched byte for byte under it. `CanvasArea` → 81 props;
  Editor → 63 `useState`s. `e2e/documents-state.spec.ts`.

## Revisit when

- A slice needs derived state shared by several readers: add a memoized
  selector then, not a new store.
- The command operations (`CommandOps`, 1.1) move out of Editor: they read and
  write through these stores, which is the seam 1.1 left for this item.
- Anything adopts concurrent rendering (a transition, Suspense for data):
  `useStore` would then have to go back to `useSyncExternalStore`, and the
  states that change together into one store first.
