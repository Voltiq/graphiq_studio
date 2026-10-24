# 0003 — The commands' operations are functions of one render of the editor

## Context

The commands (TODO 1.1) say WHICH operation each menu item, shortcut and
action step performs, and when it applies; the operations themselves
(`CommandOps`, ~70) were still Editor functions, ~1,000 lines, together with
the helpers they and the rest of Editor share — the undoable layer change
(`commitLayerChange`), the selection journal, the layer selection
(`selNow`, `setDocSel`). The stores of 1.5 (0002) are the seam they can move
through. TODO 1.10.

## Decision

- **A family per module, `app/commands/<family>.ts`**, exporting one function
  (`layerOps(ctx)`, `maskOps(ctx)`, …) that returns the family's operations and
  the helpers it owns, under the names Editor already called them. Editor
  destructures the result, so none of its call sites — the menus' table, the
  Layers panel's API, the dialogs' callbacks — changes.
- **Called on every render, closing over that render.** Editor is not compiled
  by the React Compiler (it writes refs during render, so the compiler leaves
  it alone) and re-creates every function each render; the operations did the
  same as closures. A family function called during render with a context
  built from that render's values (`active`, the refs, the stores, `showToast`)
  keeps exactly those semantics — the render's `active` stays the render's,
  a ref is still read when the operation runs. A context of getters onto the
  stores' latest would have changed what an operation sees inside a handler
  that set state earlier in the same tick.
- **Bodies move verbatim.** The context's fields carry the names the bodies
  already use (`paintRef`, `activeIdRef`, `showToast`), and the move is a
  script that lifts the exact text out of Editor — no logic retyped.
- **Hooks stay in Editor.** A ref a family needs (`layerSeqRef`, the
  selection journal's pending gesture) is made in Editor and passed in; a
  `useMemo` or `useEffect` beside the operations stays where it is.
- **A family takes another's helpers through its context**, not by importing
  its state: masks get `selNow` and `setDocSel` from the layer family's result.

## Evidence

- Layers (v3.8.10): New, Duplicate, Delete, Group, Ungroup, Merge (and Merge
  Down), Merge Visible, Stamp Visible, Flatten, and the helpers the rest of
  Editor uses (`commitLayerChange`, `setDocSel`, `selNow`, `single`,
  `targetIds`, `nextLeafId`) — 259 lines out of Editor. Characterized on the
  sample (every command, single and multi-selected, undone and redone, and the
  edge cases on an empty document) and matched byte for byte.
  `tests/layer-ops.test.ts` — the first unit tests these operations have had —
  and `e2e/layer-ops.spec.ts`.
- Masks (v3.8.11): layer, filter and vector masks — 259 lines; takes the
  layer family's `selNow` and `setDocSel` through its context. Characterized
  on the sample (every mask operation, the Layers panel's chips, a filter mask
  through its dialog) and matched. `tests/mask-ops.test.ts`,
  `e2e/mask-ops.spec.ts`.
- Selection (v3.8.12): the selection, its journal and the Select menu — 269
  lines. The journal's three refs and the number box's `useMemo` stay in
  Editor around the call, in their old order. Characterized (tool gestures,
  every Select command, its dialogs, transform by numbers, Refine Edge) and
  matched. `tests/selection-ops.test.ts`, `e2e/selection-ops.spec.ts`.
- Adjustments (v3.8.13): adjustment layers, their live edits, clipping,
  Curves and Levels, the extra kinds — 169 lines. The call sits after the
  last hook it is handed (the .cube picker's refs); the .cube handler stays,
  for Editor's `stripExt`. Characterized and matched.
  `tests/adjustment-ops.test.ts`, `e2e/adjustment-ops.spec.ts`.
- Effects (v3.8.14): layer styles — 102 lines; `selectLayer`, declared later
  in Editor, passed as a call. Characterized and matched.
  `tests/effect-ops.test.ts`, `e2e/effect-ops.spec.ts`.
- Smart filters (v3.8.15): the stack's edits, a filter from the menu, the bake
  — 97 lines. Characterized (waiting for the off-thread render to settle) and
  matched. `tests/filter-ops.test.ts`, `e2e/filter-ops.spec.ts`.
- Fills and frames (v3.8.16): 136 lines; takes two other families' helpers
  (`commitAdjustEdit`, `stylePatchStructural`), so it is called after both.
  Characterized and matched. `tests/fill-ops.test.ts`, `e2e/fill-ops.spec.ts`.
- Image (v3.8.17): rotate, flip, Crop, Trim, Free Transform, Content-Aware
  Fill — 202 lines. Characterized and matched. `tests/image-ops.test.ts`,
  `e2e/image-ops.spec.ts`.
- Clipboard (v3.8.18): copy, cut, paste, the float, undo and redo — 228 lines,
  18 context fields (the clipboard's refs, the sequence counters, the paste
  dialog's state). The native paste listener, an effect with no deps, still
  holds the first render's `placePaste`: the same closure it held before.
  Characterized and matched. `tests/clipboard-ops.test.ts`,
  `e2e/clipboard-ops.spec.ts`.
- Export (v3.8.19): the dialog, single and batch, PSD, SVG, frames — 256
  lines. Characterized by each download's content (a zip by its entries, the
  clock held still for the metadata) and matched. `tests/export-ops.test.ts`,
  `e2e/export-ops.spec.ts`.
- Documents (v3.8.20): New, Close, Rename, the sample — 73 lines; called after
  autosave's cache, which it closes documents out of. Characterized and
  matched. `tests/document-ops.test.ts`, `e2e/document-ops.spec.ts`.
- Projects (v3.8.21): serialize, Save, Save As, Open, load, restore — 375
  lines, 28 context fields. The autosave hooks that call the serializer keep
  their dependency lists (a disable note each: the function is new each
  render, as before). Characterized and matched. `tests/project-ops.test.ts`,
  `e2e/project-ops.spec.ts`.
- Sessions (v3.8.22): the Blur Gallery, Liquify, Warp — 154 lines.
  Characterized and matched. `tests/session-ops.test.ts`,
  `e2e/session-ops.spec.ts`.
- View and text (v3.8.23): Quick Mask, Isolate, the guides' commit, type on a
  path — 169 lines, two modules. Characterized and matched.
  `tests/view-ops.test.ts`, `tests/text-ops.test.ts`, `e2e/view-ops.spec.ts`.
- Workspace (v3.8.24): the table's own bodies — dialogs and the tour, zoom,
  the view flags, compare, proof, gamut, the HUD, the panels. It returns a
  `Pick` of `CommandOps`, so the entries keep their table types. Characterized
  and matched. `tests/workspace-ops.test.ts`, `e2e/workspace-ops.spec.ts`.
- Outcome (TODO 1.10 done, v3.8.24): Editor 8,198 → 5,724 lines; sixteen
  modules; `commandOps` names what they return.

## Revisit when

- Editor becomes compiled (its render-time ref writes go): the family calls
  would then be memoized on the context, which is still correct but worth
  checking against the characterizations.
- A family's operations are wanted outside Editor (a worker, a headless
  script): the context is the interface they would be called through.
