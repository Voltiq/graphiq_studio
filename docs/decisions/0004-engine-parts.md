# 0004 — The paint engine is a façade over parts that share its document cursor

## Context

`PaintEngine` (`app/lib/paint.ts`) was one class of ~10,900 lines and ~360
members: history, selection, quick mask, the brush pipeline, smart-filter
scheduling and workers, effects, the compositor and its caches, transforms,
the float. Every area reads every other's private fields, so none can be read,
tested or changed alone, and the engine has never had a unit test. TODO 1.6
asks for the areas to come out, one at a time, until the engine is a façade.

Two things make that hard. The engine works on "the document in front"
(`this.doc`, TODO 1.2): `withDocument` swaps it for the length of a call, and every `this.layers` or `this.entries` reads through it — a part that
kept its own pointer would read the wrong document inside such a call. And the
public surface (`EngineHandle`) is called from CanvasArea and Editor by name.

## Decision

- **A part per module, `app/lib/engine/<part>.ts`**, a class that owns its
  area's state (`EngineHistory`: the step and memory caps, non-linear mode,
  what the History panel was last told).
- **One cursor.** `DocCursor` (doc-state.ts) holds the document in front and
  every open one; `DocumentScoped` takes it, and the engine and each part
  extend `DocumentScoped` over the same cursor. A part's code reads
  `this.entries` as before, and `withDocument` in any of them moves all of them.
- **A host, built inside the engine.** What a part needs of the rest of the
  engine is an interface (`HistoryHost`) the engine fills with closures where it
  creates the part, so private members stay private: nothing becomes public
  for a part's sake, and the interface is the honest list of what the area
  depends on.
- **The engine keeps its doors.** Every public method stays on `PaintEngine` as
  a one-line delegation, and the private names other areas call (`emitHistory`,
  `linkEntry`) stay as private doors — no call site changes, inside or out.
- **Bodies move verbatim**, by script: a member is lifted whole with the
  comments above it; the only rewrites are calls that now go through the host.
  Each move is characterized on a fixed start and matched byte for byte, and the
  full e2e suite (pixel identity, the effect goldens) runs before and after.
- **Each part gets unit tests** against a fake host and documents of its own —
  the first the engine has had — and both the part and its wiring are
  mutation-tested.

## Evidence

- History (v3.8.25): each document's undo tree, its caps, structural steps,
  undo, redo and jumps, non-linear history, what the History panel is told, the
  History brush's source, snapshots — 282 lines out of the engine (10,931 →
  10,710 with the doors). Characterized (strokes, undo, a branch kept and
  pruned, snapshots as a source and restored, two documents, a third closed;
  then the step and memory caps) and matched. `tests/engine-history.test.ts`
  (12), `e2e/engine-history.spec.ts`.
- Selection (v3.8.26): coverage and outline, the shape the others clip
  through, the operations, the wand, quick select, the lasso — 987 lines; the
  canvas allocator went to `engine/canvas.ts` with it, so no part imports
  `paint.ts` for a value. The doors are generated from each member's own
  signature. Characterized and matched. `tests/engine-selection.test.ts` (15),
  `e2e/engine-selection.spec.ts`.
- Masks (v3.8.27): layer, filter and quick masks and the saved channels — they
  share one map and one code path, so one part — 313 lines. A part may reach
  another only through its host (the masks ask the engine for the selection's
  mask, which asks the selection part). Characterized and matched.
  `tests/engine-masks.test.ts` (9), `e2e/engine-masks.spec.ts`.
- Stroke (v3.8.28): the brush and eraser pipeline, its tips, the clone stamp —
  617 lines. Engine state a part reads but does not own (the stroke's buffer,
  remade by every resize) is reached through a getter of the same name on the
  part, so the bodies stay verbatim. Characterized (Math.random seeded) and
  matched. `tests/engine-stroke.test.ts` (15), `e2e/engine-stroke.spec.ts`.
- Retouch (v3.8.29): the History brush, blur, dodge and burn, sponge, smudge
  and the mixer — a 1,412-line module. A host member the moved code never
  called was dropped rather than carried: the host lists what the part uses,
  not what the bodies it came from might have. Characterized and matched.
  `tests/engine-retouch.test.ts` (12), `e2e/engine-retouch.spec.ts`.
- Smart filters (v3.8.30): the stack, its product cache and worker, the live
  frames — a 717-line module. Moving a body is not always verbatim: a path
  relative to `import.meta.url` (a worker's) is relative to the module, and
  moved a folder deeper it has to be rewritten. Pixels could not show it — the
  in-line fallback gives the same ones — so the characterization records which
  path produced each step, not only what it produced.
  `tests/engine-smart-filters.test.ts` (14), `e2e/engine-smart-filters.spec.ts`.
- Blur Gallery (v3.8.31): the session, its worker, the preview, Apply and
  Cancel — a 289-line module, its worker's URL rewritten as the filters' was.
  A part with a worker is characterized with the worker's replies counted
  (a wrapper round `Worker` in the page), not only its pixels.
  `tests/engine-blur-gallery.test.ts` (10), `e2e/engine-blur-gallery.spec.ts`.
- Heal (v3.8.32): spot heal, content-aware fill, the heal worker and the bake —
  a 321-line module. A document-scoped part reaches every open document
  through the cursor it shares, so a job begun in one document lands in it
  after another has come to the front (`isOpen`, `this.doc` — unchanged bodies).
  `tests/engine-heal.test.ts` (10), `e2e/engine-heal.spec.ts`.

## Revisit when

- A part's host grows past what it owns: that is two areas pretending to be
  one, and the boundary is in the wrong place.
- The engine moves to a worker: the hosts are the seams that would be
  messages.
