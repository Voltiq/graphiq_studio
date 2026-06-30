# Spec 01 — Layer Masks

> **Claude Code task.** Implement non-destructive raster layer masks in Graphiq Studio. This is a complete specification. Read it fully, then read the real source files named in §3 to confirm exact signatures, then implement. Do not stop to ask for confirmation on anything already decided here.

---

## 1. Project context (Graphiq Studio)

Graphiq Studio is a browser-based raster photo editor. Everything runs client-side on HTML `<canvas>` and `ImageData`; there is no server, upload, or database. Stack: **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**. No image-processing libraries — all compositing, filtering, selection and history logic is hand-written against the Canvas 2D API.

The editor is backed by a single **`PaintEngine`** class (`app/lib/paint.ts`). React components never mutate layer pixels directly; they call a curated **`EngineHandle`** interface. Layers form an immutable tree (`app/lib/layers.ts`) manipulated only by pure functions that return new trees. History is a single linear stack of pixel + structural entries. Documents are colour-space aware (sRGB or Display-P3).

**This feature is the foundation of the non-destructive stack.** It adds a grayscale mask channel to any layer/group; subsequent specs (Adjustment Layers, clipping) reuse the machinery built here.

## 2. Architecture constraints

- **React stays declarative.** No React component may read or write mask pixels directly. All mask pixel work goes through new `EngineHandle` methods. React holds only mask *metadata* (enabled/linked) in the layer tree state.
- **Immutable tree.** Mask metadata lives on layer nodes and is edited only via pure functions in `layers.ts`. Never mutate a node in place.
- **One source of imperative truth.** Mask pixels live in the engine, in a `Map` keyed by layer id, exactly mirroring how layer pixels already live in a `Map` keyed by layer id.
- **Session model.** Painting on a mask is a live, cancellable session that snapshots, previews, and bakes on commit producing exactly one history entry — identical in shape to the existing paint-stroke session.
- **Colour-space neutrality.** A mask is a single-channel coverage signal, not colour. It is stored in a plain canvas and is independent of the document's sRGB/P3 working space. Do not run masks through gamut conversion when `setColorSpace` runs.
- **No new dependencies.** Implement with Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read these first)

Before writing code, open and read these to confirm exact names/signatures, then integrate — do **not** reimplement:

- `app/lib/paint.ts` — `PaintEngine`. Find: the per-layer canvas `Map`, `composite(tree)` / `exportComposite(tree)` / `drawNode`, `leafDisplay(id)`, the paint-stroke session methods (begin/move/end), `selectionMask(rects, angle, pivot, feather)`, `clipTo(...)`, the brush tip baking, and the scratch/stroke buffers.
- `app/lib/layers.ts` — the `LayerLeaf` / `LayerGroup` types and the pure functions (find, update/shallow-patch, remove, insert-relative, insert-into-group, wrap-in-group, ungroup, clone-subtree, replace).
- The **history module** — the `Entry` union (pixel entry: `layerId`, `rect`, `before`/`after` `ImageData`; structural entry: `side` with `undo()`/`redo()`), `jumpTo`, `undo`, `redo`, the redo-branch truncation, and the history-summary emission that drives the History panel.
- The **`.aproj` serializer/deserializer** — where layers are written as PNG data-URLs and read back, plus where editor state (selection, colours, sizes, history labels) is (de)serialized.
- The **Layers panel** React component(s) and the `EngineHandle` definition.
- `app/lib/color.ts` — checkerboard background helper (for mask thumbnail rendering).

**You must reuse:** the brush pipeline (for mask painting), `selectionMask` (for "mask from selection" and the load-selection-from-mask op), the structural+pixel history mechanism, the per-id canvas `Map` pattern, and the `.aproj` PNG-data-URL convention.

## 4. Design goals

1. Any **leaf or group** can carry at most one raster mask. Mask is document-sized grayscale: white = fully visible, black = hidden, gray = partial.
2. Masks are **non-destructive** — they modulate the layer's alpha at composite time; the layer's own pixels are never altered by masking.
3. **Full editing parity with Photoshop masks**: add (reveal-all / hide-all / from-selection), delete, apply (bake), enable/disable, paint with any brush/eraser/gradient/fill, load mask as selection, link/unlink to the layer for moves.
4. **Editing target switch**: clicking a layer's mask thumbnail makes the mask the active paint surface; clicking the pixel thumbnail switches back. All existing paint tools operate on whichever surface is active with zero tool-code changes.
5. Correct interaction with **selections** (painting a mask is clipped by an active selection just like painting pixels) and with **group isolation** (a group mask masks the merged group result).

## 5. Detailed implementation plan

### 5.1 Mask representation (decide once, use everywhere)

Store each mask as an **opaque grayscale RGBA canvas**, document-sized: `R = G = B = value`, `A = 255`. This makes the mask trivially displayable (it *is* a grayscale image) and editable by the existing brush pipeline (which paints RGB).

At composite time the grayscale value must become an **alpha multiplier** on the layer. Maintain a per-layer **mask-as-alpha cache**: a canvas where `A = value`, `RGB = 0`. It is derived from the grayscale mask and **recomputed only when the mask mutates** (on session commit, or on a structural mask op), never per frame.

```
grayscale mask  ──(derive on mutation)──►  mask-as-alpha cache
 R=G=B=v, A=255                              RGB=0, A=v
 (display + edit surface)                    (compositing surface)
```

Derivation pass (runs on mutation only, scoped to the changed rect when known):
`for each px: out.A = in.R; out.R = out.G = out.B = 0`.

### 5.2 Engine additions (`paint.ts`)

- `masks: Map<string, HTMLCanvasElement>` — grayscale mask per layer id (absent ⇒ no mask).
- `maskAlpha: Map<string, HTMLCanvasElement>` — derived alpha cache per layer id.
- `maskSession` state mirroring the paint-stroke session, but its target surface is the active layer's grayscale mask canvas (plus a live scratch for preview).
- An **active surface** flag per the engine's current active layer: `'pixels' | 'mask'`. The brush/eraser/gradient/bucket/clone routines must resolve their draw target through a single helper `activeSurface(layerId)` that returns either the layer canvas or its mask canvas, so **no individual tool changes**.

New/changed methods (final names yours, but match these responsibilities):

- `addMask(layerId, init: 'reveal' | 'hide' | 'selection')` — allocate grayscale mask (white / black / rasterized current selection via `selectionMask`), derive alpha cache. Structural history.
- `removeMask(layerId)` — free mask + alpha cache. Structural history.
- `applyMask(layerId)` — bake: multiply layer alpha by mask alpha into the layer canvas, then remove mask. **Destructive**; one structural+pixel history step.
- `setMaskEnabled(layerId, enabled)` — toggle without deleting (engine keeps the canvas; compositor skips it). Structural history (cheap).
- `loadMaskAsSelection(layerId)` — read mask luminance → feed the selection system as a new selection (reuse the path selections use to ingest a rasterized mask).
- Mask paint session: `beginMaskStroke / moveMaskStroke / endMaskStroke` (or route the existing stroke methods through `activeSurface`). On commit: write a **pixel history entry tagged `surface:'mask'`** (see §12) and **re-derive the alpha cache** for the changed rect.
- `setActiveSurface(layerId, surface)`.

### 5.3 Compositor integration (`drawNode`)

In the **leaf** path of `drawNode`, after obtaining the display source via `leafDisplay(id)`:

```
src = leafDisplay(id)                    // existing: layer canvas, or scratch if live session
if (mask exists AND enabled) {
    tmp = borrow buffer sized to canvas
    tmp.drawImage(src)                   // copy layer/preview
    tmp.gco = 'destination-in'
    tmp.drawImage(maskAlphaCache[id])    // multiply alpha by mask
    src = tmp
}
ctx.globalAlpha = opacity/100
ctx.globalCompositeOperation = blendOp(blend)
ctx.drawImage(src, ...)
```

For the **group** path: after compositing children into the group buffer, apply the group's mask (if any) to that buffer the same way **before** drawing it with the group's opacity/blend. This yields isolated group masking (mask applies to merged result), consistent with existing group opacity/blend behaviour.

If a leaf has a **live mask session** in progress, `leafDisplay` is unaffected (pixels unchanged) but the compositor must use the **in-progress mask** (live scratch) for the `destination-in` step so the mask brush previews live. Add a `maskDisplay(id)` indirection mirroring `leafDisplay`: returns the committed alpha cache, or a freshly-derived alpha from the live mask scratch during a session.

### 5.4 React / UI

- **Layers panel:** render a mask thumbnail beside each layer's pixel thumbnail when a mask exists. A thin highlight ring indicates the **active surface**. Clicking either thumbnail calls `setActiveSurface`. Shift-click the mask thumbnail toggles enabled (disabled = red "X" overlay). A small chain icon between the two thumbnails toggles **linked**.
- **Add-mask affordance:** a button in the Layers panel footer plus **Layer ▸ Layer Mask ▸ {Reveal All, Hide All, From Selection, Delete, Apply, Disable/Enable}**.
- **Options bar / status:** when the active surface is a mask, surface the fact subtly (e.g., a "Mask" pill) so the user knows paint will land on the mask.
- **Channels panel:** when a layer with a mask is active, list the mask as a selectable grayscale channel; selecting it is equivalent to `setActiveSurface(..., 'mask')`. (Reuse the existing Channels rendering; do not build a parallel widget.)

## 6. Directory & file changes

```
app/lib/paint.ts            (edit)  masks Map, maskAlpha cache, mask session,
                                    activeSurface()/maskDisplay(), drawNode mask step,
                                    addMask/removeMask/applyMask/setMaskEnabled/
                                    loadMaskAsSelection
app/lib/layers.ts           (edit)  MaskMeta type + add/update/remove-mask pure fns;
                                    clone-subtree carries mask meta + signals engine
                                    to copy mask canvases
app/lib/history.ts          (edit)  pixel Entry gains `surface: 'layer' | 'mask'`
                                    (default 'layer'); jumpTo writes to correct surface
                                    and re-derives alpha cache on mask patches
app/lib/project.ts          (edit)  serialize/deserialize mask PNG + MaskMeta;
   (or wherever .aproj lives)       format version bump; tolerate absent masks
app/lib/engine-handle.ts    (edit)  expose the new mask methods on EngineHandle
   (or wherever the interface lives)
app/components/LayersPanel/ (edit)  mask thumbnail, active-surface ring, link/enable
app/components/ChannelsPanel/(edit) list active layer mask as a channel
app/components/MenuBar/     (edit)  Layer ▸ Layer Mask submenu + shortcuts
app/lib/mask.ts             (new, optional) pure helpers: deriveAlphaFromGray(),
                                    luminanceToMask(), thumbnail compositing
```

No new npm packages.

## 7. TypeScript interfaces

```ts
// layers.ts — metadata only; pixels live in the engine.
export interface MaskMeta {
  /** Mask participates in compositing when true; false = temporarily disabled. */
  enabled: boolean;
  /** When true, Move transforms layer + mask together; when false, only the
   *  active surface moves. */
  linked: boolean;
}

// Extend the common properties shared by LayerLeaf and LayerGroup:
export interface LayerCommon {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;            // 0–100
  blend: BlendMode;
  mask?: MaskMeta;            // NEW — absent ⇒ no mask
}

export type ActiveSurface = 'pixels' | 'mask';

// engine-handle.ts — methods React calls.
export interface MaskHandle {
  addMask(layerId: string, init: 'reveal' | 'hide' | 'selection'): void;
  removeMask(layerId: string): void;
  applyMask(layerId: string): void;          // destructive bake
  setMaskEnabled(layerId: string, enabled: boolean): void;
  setMaskLinked(layerId: string, linked: boolean): void;
  loadMaskAsSelection(layerId: string): void;
  setActiveSurface(layerId: string, surface: ActiveSurface): void;
  getActiveSurface(layerId: string): ActiveSurface;
}

// history.ts — pixel entry gains a surface discriminator.
export interface PixelEntry {
  kind: 'pixel';
  layerId: string;
  surface: 'layer' | 'mask';   // NEW — default 'layer' for back-compat
  rect: Rect;
  before: ImageData;
  after: ImageData;
}
```

## 8. Class responsibilities

- **`PaintEngine`** owns: mask canvases, alpha caches, the mask paint session, surface resolution, mask↔selection conversion, mask compositing in `drawNode`, and re-deriving the alpha cache after any mask mutation. It is the *only* place mask pixels are touched.
- **`layers.ts` pure functions** own: attaching/detaching/patching `MaskMeta` on the immutable tree, and ensuring clone-subtree reports old→new ids so the engine can copy mask canvases alongside layer canvases.
- **History module** owns: applying/reverting mask pixel patches to the correct surface and triggering alpha-cache re-derive on those patches.
- **React panels** own: presentation and dispatch only — thumbnails, the active-surface ring, menu wiring. No pixel logic.

## 9. Data-flow diagram

```
User paints on active mask
        │
        ▼
Tool handler ── begin/move/endStroke ──►  PaintEngine
                                            │  activeSurface(id) -> mask canvas
                                            │  live preview via maskDisplay(id)
        ┌───────────────────────────────────┘
        ▼ (commit)
PaintEngine: write mask scratch → grayscale mask
            derive alpha cache (changed rect)
            push PixelEntry{ surface:'mask' }  ──►  History
            request recomposite
        │
        ▼
composite(tree) → drawNode(leaf):
   leafDisplay(id) × maskDisplay(id) (destination-in) → blended draw
        │
        ▼
   on-screen view canvas (document colour space)
```

Adding a mask from a selection:
```
selection rects/angle/pivot ──► selectionMask(...) ──► grayscale mask canvas
                                                    └► derive alpha cache ──► composite
```

## 10. Rendering pipeline (where masks slot in)

```
composite(tree):
  for node in tree bottom→top:
    if leaf:
        src = leafDisplay(id)
        if mask?.enabled: src = src ⊗ maskDisplay(id)   // destination-in alpha mult
        draw src with opacity + blendOp
    if group:
        buf = composite(children) into group-sized buffer
        if mask?.enabled: buf = buf ⊗ maskDisplay(id)
        draw buf with group opacity + blendOp
exportComposite(tree): identical, but masks clipped to canvas bounds on flatten.
```

The mask step is a single extra `destination-in drawImage` against a cached alpha buffer — O(canvas) per masked layer, only when the layer redraws.

## 11. State-management rules

- Mask **metadata** (`enabled`, `linked`) is React/tree state, edited via pure functions; mask **pixels** are engine state. Never store mask pixels in React.
- The **active surface** is engine state keyed to the active layer. React reads it via `getActiveSurface` to render the ring; it is set via `setActiveSurface`. Switching the active layer resets the surface to `'pixels'` for the newly active layer unless that layer's surface was previously set this session (keep a small per-layer map; default `'pixels'`).
- A tree update that removes a layer must trigger engine cleanup of its mask + alpha cache (mirror existing layer-canvas cleanup).
- `setColorSpace` must **not** convert mask canvases (they are colour-agnostic). Re-derive alpha caches only if their dimensions change due to canvas resize.

## 12. History integration

- **Add / remove / apply / enable-toggle / link-toggle** mask → **structural** entries with `undo()`/`redo()` that allocate/free/restore the mask canvas + alpha cache and the `MaskMeta`. `applyMask` is structural (mask removed, layer restored) **plus** a pixel patch of the changed layer region — combine into one step (the engine already supports combined pixel+structural steps, e.g. paste).
- **Mask painting** → **pixel** entry with `surface:'mask'`, storing only the changed bounding rect's `before`/`after` `ImageData` of the **grayscale mask** (not the whole mask). `jumpTo` must `putImageData` to the mask canvas (not the layer) when `surface==='mask'`, then **re-derive the alpha cache** for that rect.
- Finalise any open mask session before any history navigation (same rule as paint sessions). Emit the same history-summary so the History panel lists e.g. "Add Layer Mask", "Mask Brush", "Apply Layer Mask".

## 13. Serialization changes (`.aproj`)

- Bump format `version` (see roadmap rule).
- For each layer that has a mask, write:
  - `mask`: `{ enabled, linked }`
  - `maskImage`: PNG **grayscale** data-URL of the mask canvas (reuse the exact data-URL convention used for layer pixels).
- Loader: if `mask`/`maskImage` present, allocate the mask canvas from the PNG and derive the alpha cache; if absent, the layer simply has no mask. Older files (no version / no mask fields) must open unchanged.
- `exportComposite` for raster export already flattens with masks applied (compositor handles it) — no export-format changes needed.

## 14. Performance requirements

- Mask **alpha-cache derivation** must be **scoped to the changed rect** during painting (never re-derive the full document on every dab). Full-document derive only on add-from-selection / load / apply.
- Compositing overhead for a masked layer is one extra `drawImage` against the cached alpha buffer; it must add **no per-pixel JS loop** to the composite path (the alpha multiply is GPU/`destination-in`, not an `ImageData` loop).
- Painting a mask must sustain the **same brush frame-rate as painting pixels** on a 4000×3000 document (target ≥ 60fps for typical brush sizes; never worse than the existing pixel-paint path).
- Borrow/reuse a shared temp buffer for the per-leaf masked composite; do not allocate a canvas per frame.

## 15. Memory requirements

- One grayscale mask canvas **and** one alpha-cache canvas per masked layer = 2 × (W×H×4) bytes. For a 4000×3000 doc that is ~96 MB per masked layer across both buffers — acceptable but not free.
- The alpha cache may be stored as a **single-channel** representation if you prefer (an `OffscreenCanvas`/`ImageData` of alpha only) to halve footprint; if so, document the trade-off. Default acceptable approach: full RGBA canvases for both.
- History mask patches store only the changed rect, never the whole mask (reuse the existing bounded-patch rule).
- Free both canvases immediately on `removeMask` and on layer deletion.

## 16. Edge cases (handle all)

1. **Add mask when one exists** → no-op (or replace only via explicit delete first); never stack two masks.
2. **Paint on mask with active selection** → mask paint is clipped by the selection mask exactly as pixel paint is.
3. **Mask on a group** → masks the merged group buffer (not each child).
4. **Disabled mask** → excluded from compositing but preserved through save/load and undo/redo.
5. **Linked move** → Move tool translates both layer and mask; **unlinked** → moves only the active surface. Moving the mask must move it as document-space pixels (offset within its canvas), and update the alpha cache.
6. **Apply mask on a layer whose mask is disabled** → applying a disabled mask should be blocked or apply at full reveal? Define: **applying a disabled mask is not allowed** (toast: "Enable the mask before applying").
7. **Duplicate / merge-down / rasterise / flatten** a masked layer → masks must be honoured: merge-down composites with masks applied; duplicate copies the mask canvas (clone-subtree → engine copies mask + cache); flatten bakes masks. Rasterising a vector layer that has a mask keeps the mask.
8. **Canvas resize / crop / rotate / flip / image-size** → mask canvases must be transformed identically to layer canvases (extend the existing per-layer transform loops to also transform masks, then re-derive caches).
9. **Load mask as selection on an all-black mask** → yields an empty selection (handle gracefully, no NaN).
10. **Switch active surface to mask, then delete the mask** → reset active surface to `'pixels'`.
11. **Gradient / Paint Bucket / Clone on a mask** → must work (they paint through `activeSurface`); gradients on a mask produce smooth reveals.
12. **P3 document** → mask unaffected by colour space; a `#808080` brush on the mask yields ~50% coverage regardless of working space.

## 17. Acceptance criteria

- [ ] Any leaf or group can gain a mask via reveal-all, hide-all, or from-selection; deletes; applies; enable/disable; link/unlink.
- [ ] Clicking the mask thumbnail makes the mask the paint target; **all 18 tools** that paint (brush, pencil, eraser, gradient, bucket, clone, blur, dodge/burn where sensible) operate on the mask **without per-tool changes**.
- [ ] Mask painting previews live and bakes to exactly one undoable history step labelled appropriately.
- [ ] Masked compositing is correct under opacity, all 19 blend modes, group isolation, and selections.
- [ ] Undo/redo restores mask pixels and metadata; jumping in the History panel works across mask steps.
- [ ] Save → reload an `.aproj` restores masks (pixels + enabled + linked) bit-for-bit; older mask-less `.aproj` files still open.
- [ ] Canvas resize/crop/rotate/flip/image-size transform masks identically to layers.
- [ ] Raster export (PNG/JPEG/WebP/AVIF) reflects masks (hidden regions transparent/over background as appropriate).
- [ ] No regression to pixel-paint frame-rate on a 4000×3000 document.
- [ ] `setColorSpace` leaves masks visually identical.

## 18. Coding standards

- Match the existing repo style exactly (formatting, naming, file layout, SCSS-module conventions, lucide-react icon usage).
- TypeScript **strict**: no `any`, no non-null `!` to dodge real null cases, explicit return types on engine methods and pure functions.
- Pure functions in `layers.ts` return new trees; never mutate inputs.
- Engine methods that mutate must (a) snapshot for history, (b) update the alpha cache, (c) request a recomposite via the existing mechanism — in that order.
- Reuse existing helpers (`selectionMask`, brush baking, buffer-borrowing, checkerboard) — do not duplicate them.
- Keep hot loops (alpha derive) tight: single pass over the scoped rect's `ImageData`, typed-array access, no per-pixel allocations.
- Comment only non-obvious invariants (e.g., why the alpha cache exists, why masks skip colour conversion).

## 19. Claude must NEVER

- **Never** let any React component read or write mask pixels — only metadata via pure functions and pixel ops via `EngineHandle`.
- **Never** mutate a layer node in place; always go through `layers.ts` pure functions.
- **Never** alter a layer's own pixels when masking (masking is non-destructive; only `applyMask` is destructive and it is explicit).
- **Never** re-derive the full-document alpha cache on every brush dab — scope to the changed rect.
- **Never** run masks through colour-space gamut conversion.
- **Never** store the whole mask in a history entry — store only the changed bounded rect.
- **Never** add an npm dependency or use WebGL/WebGPU; Canvas 2D + `ImageData` only.
- **Never** introduce a second mask on a layer or a separate parallel state store for masks.
- **Never** break loading of existing `.aproj` files.

## 20. Begin now

Start by reading `app/lib/paint.ts`, `app/lib/layers.ts`, the history module, and the `.aproj` serializer to confirm exact signatures and the buffer-borrow/cleanup patterns. Then implement in this order: (1) `MaskMeta` + pure tree functions; (2) engine mask map, alpha cache, derive helper; (3) compositor mask step + `maskDisplay`; (4) mask paint session routed through `activeSurface` + history `surface` field; (5) structural mask ops (add/remove/apply/enable/link/load-as-selection); (6) transform-loop coverage (resize/crop/rotate/flip); (7) `.aproj` serialization + version bump; (8) Layers/Channels/Menu UI. Implement everything in this spec, keep diffs aligned to §17, and write the code now.
