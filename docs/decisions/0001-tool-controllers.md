# 0001 — Tool controllers: a gesture belongs to the controller that began it

## Context

CanvasArea's three pointer handlers held every tool as a branch: `tool === "…"`
69 times across ~2,200 lines, with each tool's gesture state in CanvasArea refs
read from five places (down, move, up, the overlay, pointer-leave). TODO 1.4
moves each tool family into `app/tools/`, one family at a time, behaviour-neutral.

## Decision

- **A controller per tool family** (`app/tools/types.ts`): `down`, `hover`,
  `move`, `up`, `cancel`, `leave`, `drawOverlay`, `wantsOverlay`, `busy`. It owns its
  gesture's state. Tools sharing a session share a controller (Smudge and the
  Mixer brush).
- **CanvasArea keeps arbitration and dispatch.** Pinch, palm rejection, the
  brush HUD, bird's-eye, a dialog's eyedropper and pan mode decide who owns the
  pointer; what is left goes to the selected tool's controller. A click tool
  that answers before pan mode says so (`overPan`, the Zoom tool).
- **A gesture goes to the controller that began it**, not the tool selected
  now (`gestureRef`). This is what the old ref-per-session code did implicitly:
  a stroke whose tool is switched by a shortcut half way ends as that tool's
  one stroke. Hover, the overlay and the cursor follow the selected tool.
- **The host is rebuilt every render** and passed to every call, never kept by
  a controller, so every value it reads is the current one. The overlay loop
  (a `useCallback` with no deps) reads the latest host through a ref.
- **A pinch cancels the gesture in flight** through the controller that owns
  it (`cancel`): the picture back as it was, nothing recorded. CanvasArea's
  `abortActiveGesture` needs no list of tools for this.
- **One canvas, one set of controllers** (`createToolControllers()`), so two
  canvases can never share a stroke.

## Evidence

- Slice 1 (v3.8.1): Zoom, Blur, Smudge, Mixer brush, Dodge, Sponge, Spot heal,
  Red eye. A fixed gesture per tool over the (deterministic) sample document —
  composite hash, history, ring while hovering, mid-stroke and after leaving,
  and a stroke switched mid-way — recorded before the move and after it:
  identical, twice over, on all nine.
- `tests/tools.test.ts` (22 checks, fake engine) and
  `e2e/tool-controllers.spec.ts` (11 tests on real pixels). Mutation-tested
  31 ways (21 controller mutants, 10 dispatch mutants), all caught; two only
  after a test was added (red eye and heal confined to the selection; a brush
  stopping at the selection's edge).
- CanvasArea: −269 lines in slice 1.

## Revisit when

- A tool needs two pointers of its own (the dispatch assumes one gesture).
- The remaining families move: the brush/eraser/history brush (they share the
  history session), clone, eyedropper (samplers, loupe), selection tools (where
  the selection's React side becomes a handle — 1.3's leftover), move/transform,
  crop, shapes, pen and text.
