# 0001 — Tool controllers: a gesture belongs to the controller that began it

## Context

CanvasArea's three pointer handlers held every tool as a branch: `tool === "…"`
69 times across ~2,200 lines, with each tool's gesture state in CanvasArea refs
read from five places (down, move, up, the overlay, pointer-leave). TODO 1.4
moved each tool family into `app/tools/`, one family at a time, behaviour-neutral.

## Decision

- **A controller per tool family** (`app/tools/types.ts`): `down`, `hover`,
  `move`, `up`, `drop`, `cancel`, `leave`, `deselect`, `keyDown`, `doubleClick`,
  `switchDoc`, `drawCursor`, `drawOverlay`, `wantsOverlay`, `readout`, `busy`,
  plus what it tells the canvas (`cursor`, `rightButton`, `overPan`,
  `grabsGuides`, `showsLayerTransform`, `transformsSelection`). It owns its
  gesture's state. Tools sharing a session share a controller (Smudge and the
  Mixer brush; the Brush, Pencil and Eraser) or its state (a brush and a clone
  stroke are one engine stroke; the Pen and Direct selection edit one path).
- **CanvasArea keeps arbitration, dispatch and its services.** Pinch, palm
  rejection, the brush HUD, bird's-eye, a dialog's eyedropper and pan mode
  decide who owns the pointer; what is left goes to the selected tool's
  controller. A click tool that answers before pan mode says so (`overPan`, the
  Zoom tool); a tool that lets a guide over the canvas take the press first
  says so too (`grabsGuides`, Move). What several tools share stays CanvasArea's
  and is lent through the host: the selection and its transform box, snapping,
  the loupe, the text editor, the live path, the live shape, the crop's box.
- **A gesture goes to the controller that began it**, not the tool selected
  now (`gestureRef`). This is what the old ref-per-session code did for most
  sessions: a stroke whose tool is switched by a shortcut half way ends as that
  tool's one stroke. Hover, the overlay and the cursor follow the selected tool.
- **Two dispatch points in a move, as the old blocks had.** What the old code
  did for the SELECTED tool (a ring following the pointer, the Eyedropper's
  sample, the crop's drag, a hover cursor) is the controller's `hover`, called
  first and able to take the move (`true`); what it did for a SESSION is the
  gesture's `move`, called last. A grab that only carries a marker (the clone
  source) ends on the lift before arbitration looks at it (`drop`), as it did.
- **The overlay keeps its order.** A controller draws its cursor (`drawCursor`,
  the selected tool's, at the rings' place) and what it shows on the canvas
  (`drawOverlay`) in a named layer of the overlay's fixed order (`layer`:
  crop, selection, shape, fill, gradient, measure, frame, path, sample,
  transform, text) — for whatever tool is selected, told whether its own is.
  The crop's drawing can be the whole overlay (it returns `true`).
- **State the rest of CanvasArea reads stays where it was read.** Where the
  selection's outline, the Info readout or the keyboard read a tool's gesture
  (the marquee's rect, the Move delta, the polygon, the pen's drags, a shape
  node), the controller owns a `{ current }` box and CanvasArea aliases it.
- **The host is rebuilt every render** and passed to every call, never kept by
  a controller, so every value it reads is the current one. A timer or a frame
  that fires later asks for `h.latest()`. The overlay loop (a `useCallback`
  with no deps) reads the latest host through a ref.
- **A pinch cancels what every controller has in flight** (`cancel`): the
  picture back as it was, nothing recorded, and no gesture outlives it. Until
  v3.8.3 a session the old abort never ended (a measure or crop drag, a bucket
  or text press, an Eyedropper sample, a quick-select stroke) kept the
  pointer; each now cancels too, put back as it was before the press.
- **A double-click is the canvas's `dblclick`** (`doubleClick(e, h)`), after
  its two presses: Chromium reports `detail: 0` on `pointerdown`, so counting
  clicks there never saw one (the crop's apply and the polygon's close were
  dead until v3.8.3).
- **One canvas, one set of controllers** (`createToolControllers()`), so two
  canvases can never share a stroke.

## Evidence

- Slice 1 (v3.8.1): Zoom, Blur, Smudge, Mixer brush, Dodge, Sponge, Spot heal,
  Red eye. A fixed gesture per tool, recorded before and after: identical.
- Slices 2–6 (v3.8.2): the paint brushes and clone; the Eyedropper, Measure,
  bucket, gradient, Frame and Text; the selection tools; Move and Crop; shapes,
  the Pen and Direct selection; then the cursor table. A 35-case
  characterization over the sample document (composite, history, options bar,
  docs, layers, overlay ink, a selection made visible by filling it) was
  recorded before slice 2 and matched byte for byte after every slice. One
  case (crop) once differed under the full parallel load: its harness clicked
  Apply within milliseconds of the drag's last box update; with a settle it
  matches every time, and 3.8.1 behaves the same.
- Tests: `tests/tools*.test.ts` (194 cases on a shared fake-host bench) and
  `e2e/tool-controllers.spec.ts` (50 tests on real pixels). The controllers
  mutated 291 ways in slices 2–6 (31 in slice 1), all caught once tests were
  added for each first sweep's survivors; CanvasArea's wiring 84 ways — the
  survivors are equivalent (an outline cache the selection effect re-traces
  anyway) or wiring no e2e test can reach (guides grabbed by Move, a position
  lock, linked layers, the crop's straighten; and a live shape's nodes, until
  v3.8.3 made the drawn shape live — see TODO 1.4).
- CanvasArea: 8,970 → 6,138 lines; the three pointer handlers hold no tool
  branches (`tool === "hand" || panMode` is the pan, CanvasArea's own).

## Revisit when

- A tool needs two pointers of its own (the dispatch assumes one gesture).
- The selection's React side becomes a handle (1.3's leftover): every tool
  now reaches the selection through `h.selection`, so that is one seam.
- The keyboard: the polygon's and the path's keys, and the option-change
  effects (the bucket's refill, the gradient's redraw, the wand's re-run), are
  still effects in CanvasArea calling the controllers.
