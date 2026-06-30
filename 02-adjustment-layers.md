# Spec 02 — Non-Destructive Adjustment Layers

> **Claude Code task.** Implement non-destructive adjustment layers in Graphiq Studio: a new layer-tree node kind that modifies the composite of everything below it, with no pixels of its own, re-editable forever, maskable, and clippable. This is a complete specification. Read it fully, read the real source files in §3, then implement. **Prerequisite: Spec 01 (Layer Masks) must be landed** — adjustment layers reuse the mask machinery.

---

## 1. Project context (Graphiq Studio)

Graphiq Studio is a client-side, browser-based raster photo editor (no server/upload). Stack: **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**. All imaging is hand-written against Canvas 2D / `ImageData`; no image libraries.

A single **`PaintEngine`** (`app/lib/paint.ts`) owns all pixels; React calls the curated **`EngineHandle`** and never touches pixels. Layers are an **immutable tree** (`app/lib/layers.ts`) edited only by pure functions. History is a linear pixel+structural stack. Documents are colour-space aware (sRGB / Display-P3).

**Today, adjustments are destructive:** the Adjustments panel previews on the active layer, then **Apply** bakes the result and **Reset** discards. The math already exists and runs on `ImageData` in the working colour space. This spec keeps that, and adds a **non-destructive** path: adjustment *layers* that live in the stack and re-process everything beneath them at composite time. This is the single most important professional feature missing.

## 2. Architecture constraints

- **Reuse the adjustment math verbatim.** There is already a function that applies the full slider set to `ImageData` in a tagged colour space (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, sharpen, clarity, noise) plus the filter presets. Adjustment layers must call **the same function**. Do not fork or reimplement the math.
- **React stays declarative**; adjustment params live in the immutable tree; pixel processing happens only in the engine.
- **Immutable tree, pure functions.** The new node kind is created/edited/removed via pure functions returning new trees.
- **Session reuse.** Editing an adjustment layer's params is live (no Apply) and uses the existing live-adjustment preview path, just bound to a tree node instead of a transient session.
- **Mask reuse (Spec 01).** An adjustment layer carries an optional mask exactly like any other layer; its effect is modulated by the mask.
- **No new dependencies.** Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — `composite(tree)` / `exportComposite(tree)` / `drawNode`, the group-buffer compositing path, `leafDisplay`, the **live-adjustment session** (begin/update/preview/commit), the **adjustment-application function** (the one that takes `ImageData` + params + working space), the per-channel **histogram** op, buffer-borrowing, and the dirty/recomposite mechanism.
- `app/lib/layers.ts` — `LayerLeaf` / `LayerGroup`, the union type, and **every** pure function (find, update, remove, insert-relative, insert-into-group, wrap-in-group, ungroup, clone-subtree, replace, merge-down, flatten, visible-row order, multi-select helpers). All of these must learn the new node kind.
- The **history module** — pixel vs structural `Entry`, combined steps, `jumpTo`, summary emission.
- The **`.aproj` (de)serializer** — node writing/reading; add the new node kind.
- **Spec 01 mask machinery** — `MaskMeta`, engine mask map + alpha cache + `maskDisplay`, mask compositing step. Adjustment layers reuse it directly.
- The **Adjustments panel** React component(s) and the params type for the slider set + presets.
- The **Layers panel** and `EngineHandle`.

## 4. Design goals

1. A new node kind **`LayerAdjustment`** sits in the tree like a leaf (no children, no pixels) but holds an **`AdjustmentSpec`** (which adjustment + its params).
2. It **non-destructively** transforms the composited result of all layers below it, within the same group scope.
3. It honours its own **opacity** (strength) and **blend mode**, an optional **mask** (Spec 01), and an optional **clip** (`clipped`) that restricts its effect to just the layer directly beneath.
4. It is **re-editable forever**: double-click opens the same Adjustments UI bound to that node; changes are live and produce a single, cheap (params-only) history step.
5. The destructive "Apply to active layer" path **remains** for users who want to bake.
6. Adjustment types shipped now: the existing slider groups exposed as adjustment-layer types — **Brightness/Contrast, Exposure, Vibrance, Hue/Saturation, Color Balance (temp/tint), Black & White (mono), Photo Filter (warm/cool), plus the named presets as one-click adjustment layers**. (Curves & Levels arrive in Spec 04 by extending the `AdjustmentSpec` union.)

## 5. Detailed implementation plan

### 5.1 Node kind

Extend the layer union to three kinds:

```
LayerNode = LayerLeaf | LayerGroup | LayerAdjustment
```

`LayerAdjustment` is **leaf-like** (no `children`) but **pixel-less** (engine holds no canvas for it). It shares the common props (id, name, visible, opacity, blend, `mask?`) and adds `adjustment: AdjustmentSpec` and `clipped: boolean`. **Audit every function in `layers.ts`**: anything that branches on "is group?" must treat adjustment as not-a-group; anything that assumes "non-group ⇒ has pixels" must be corrected (adjustment has no pixels). Engine ops that iterate canvases (duplicate, merge-down, flatten, rasterise) must skip allocating/reading a canvas for adjustment nodes and instead handle them per §5.3/§16.

### 5.2 The adjustment-application contract (reuse)

The existing function — call its real name `applyAdjustments(img: ImageData, params: AdjustmentParams, space: ColorSpace): void` (confirm signature in-repo) — is the single processing primitive. An adjustment layer's effect on a region is:

```
out = applyAdjustments(copyOf(belowRegion), spec.params, workingSpace)
```

For preset adjustment layers, store the preset's bundled slider values directly in `params` (a preset is just a params bundle), so the same function applies.

### 5.3 Compositor integration — the crux (`drawNode` / `composite`)

The compositor currently draws bottom-to-top onto a single context (groups composite children into a buffer first). Refactor `composite` to keep the **running result as a target canvas** so an adjustment node can read what is beneath it:

```
composite(node-list, regionScope):
  acc = target canvas (the running composite for this stack/group)
  for node in list bottom→top:
    if node is leaf:        draw as today (incl. its mask)   onto acc
    if node is group:       buf = composite(children); apply group mask; draw buf onto acc
    if node is adjustment AND node.visible:
        applyAdjustmentNode(acc, node, regionScope)
  return acc

applyAdjustmentNode(acc, node, scope):
  region = effectiveRegion(node, scope)         // see Perf §14
  below  = acc.getImageData(region)             // snapshot of everything beneath
  out    = clone(below); applyAdjustments(out, node.adjustment.params, space)
  if node.opacity == 100 AND no mask AND not clipped:
        acc.putImageData(out, region)           // fast path
  else:
        tmp = buffer(region); tmp.putImageData(out)
        modMask = composeModulationMask(node, region)   // opacity × layerMask × clipBaseAlpha
        tmp.gco = 'destination-in'; draw modMask
        acc.gco = blendOp(node.blend); acc.globalAlpha = 1; draw tmp at region
        // For 'normal' blend this equals: acc = below*(1-m) + out*m
```

Where:
- **opacity** → a uniform alpha in `modMask`.
- **layer mask** (Spec 01) → multiplied into `modMask` via the alpha cache.
- **clipped** → multiply `modMask` by the **alpha silhouette of the clip base** (the nearest non-clipped, non-adjustment layer directly below). Build/borrow that alpha once per clip base.

`exportComposite` uses the identical path (full-canvas region) for flatten/export.

> Implementation note: reading back `acc` via `getImageData` is the cost. Keep it correct first, then apply the Perf scoping in §14. Prefer rendering each group's sub-stack into its own offscreen so adjustment readbacks are confined to that group buffer.

### 5.4 Live editing (reuse the live-adjustment session)

- **Create:** Layer ▸ New Adjustment Layer ▸ {type}, or the Adjustments-panel "+" / a Layers-panel adjustment button. Insert a `LayerAdjustment` above the active layer (into the same parent group), with a mask **from the current selection if one exists** (reveal-all otherwise). Open the editor immediately.
- **Edit:** double-click the adjustment node (or select it → the Adjustments panel binds to it). The panel shows that node's sliders. Dragging a slider updates `node.adjustment.params` and recomposites live. There is **no Apply** — it is always live. Closing/clicking away commits a single history step capturing the param delta.
- **Adjustments panel modes (define explicitly):**
  - If the **active node is an adjustment layer** → panel is in **edit mode**, bound to the node, no Apply/Reset (changes persist live; a "Delete adjustment" affordance exists).
  - If the **active node is a pixel layer** → panel behaves as today: live preview on that layer + **Apply** (destructive bake) / **Reset**, **plus** a new **"Create adjustment layer"** button that converts the current preview into an adjustment layer above it instead of baking.

## 6. Directory & file changes

```
app/lib/layers.ts        (edit)  add LayerAdjustment + union; update EVERY pure fn to
                                 handle the kind; AdjustmentSpec type; clipped flag
app/lib/paint.ts         (edit)  composite refactor (running-acc), applyAdjustmentNode,
                                 composeModulationMask, clip-base alpha; reuse
                                 applyAdjustments + maskDisplay; engine create/edit/remove
                                 adjustment-node ops
app/lib/adjustments.ts   (edit?) if the params type / applyAdjustments lives here, export
   (or wherever it lives)        the params type and ensure presets map to params bundles
app/lib/history.ts       (edit)  structural param-edit entry (old/new AdjustmentSpec)
app/lib/project.ts       (edit)  serialize/deserialize adjustment nodes; version bump
app/lib/engine-handle.ts (edit)  expose adjustment-node methods
app/components/AdjustmentsPanel/(edit)  edit-mode vs apply-mode; "Create adjustment layer"
app/components/LayersPanel/     (edit)  render adjustment rows (icon, name, mask, clip
                                 indicator, double-click to edit, clip toggle)
app/components/MenuBar/         (edit)  Layer ▸ New Adjustment Layer ▸ {types}
app/lib/adjustment-types.ts     (new)  registry: id → {label, icon, defaultParams, editor}
```

No new npm packages.

## 7. TypeScript interfaces

```ts
// The existing slider/preset params (confirm the real shape in-repo and import it).
export interface AdjustmentParams {
  exposure: number; contrast: number; highlights: number; shadows: number;
  whites: number; blacks: number;
  temperature: number; tint: number; vibrance: number; saturation: number;
  sharpen: number; clarity: number; noise: number;
}

// Discriminated union so Spec 04 can add 'curves' | 'levels' later.
export type AdjustmentSpec =
  | { type: 'sliders'; preset?: string; params: AdjustmentParams }
  | { type: 'hueSaturation'; hue: number; saturation: number; lightness: number; colorize?: boolean }
  | { type: 'blackWhite'; mix: { r: number; g: number; b: number; c: number; m: number; y: number }; tint?: string }
  | { type: 'photoFilter'; color: string; density: number; preserveLuminosity: boolean }
  | { type: 'colorBalance'; shadows: [number,number,number]; mids: [number,number,number]; highlights: [number,number,number] };
  // Spec 04 extends with: | { type:'curves'; ... } | { type:'levels'; ... }

export interface LayerAdjustment extends LayerCommon {  // LayerCommon from Spec 01
  kind: 'adjustment';
  adjustment: AdjustmentSpec;
  clipped: boolean;            // restrict effect to the layer directly below
  // no children, no pixels
}

export type LayerNode = LayerLeaf | LayerGroup | LayerAdjustment;

// engine-handle.ts
export interface AdjustmentLayerHandle {
  addAdjustmentLayer(spec: AdjustmentSpec, opts?: { fromSelection?: boolean }): string; // returns new id
  updateAdjustmentSpec(layerId: string, spec: AdjustmentSpec): void;     // live
  setAdjustmentClipped(layerId: string, clipped: boolean): void;
  // delete/duplicate/reorder reuse existing layer ops
}

// history.ts — cheap param edit (no pixels)
export interface AdjustmentParamEntry {
  kind: 'structural';
  side: { undo(): void; redo(): void }; // restores previous/next AdjustmentSpec on the node
}
```

## 8. Class responsibilities

- **`PaintEngine`**: the running-accumulator compositor; `applyAdjustmentNode` (snapshot below → `applyAdjustments` → modulate by opacity/mask/clip → write back); clip-base alpha derivation; live recompositing on param edits. It calls the existing `applyAdjustments` — it does **not** contain new colour math.
- **`layers.ts` pure functions**: introduce and correctly handle `LayerAdjustment` across the whole API surface; produce new trees only.
- **History module**: store/restore `AdjustmentSpec` deltas (structural, no pixels); structural add/remove for the node.
- **Adjustments panel (React)**: bind to a node in edit-mode; dispatch `updateAdjustmentSpec`; offer create/convert/delete. No pixel logic.
- **Layers panel (React)**: render adjustment rows with the correct icon, clip indicator (down-arrow), mask thumbnail (Spec 01), double-click-to-edit.

## 9. Data-flow diagram

```
Create adjustment layer
   selection? → mask-from-selection (Spec 01)
        │
        ▼
layers.ts insert-relative (above active, same group)  ──► new tree (React state)
        │                                                      │
        │                                              engine: register node id
        ▼                                                      ▼
Adjustments panel binds to node ──update params──► EngineHandle.updateAdjustmentSpec
        │                                                      │
        │                                            engine: patch node spec (via pure fn)
        │                                                      │  request recomposite
        ▼                                                      ▼
composite(tree): at adjustment node →
   below = acc.getImageData(region)
   out   = applyAdjustments(clone(below), params, space)   // REUSED math
   acc   = modulate(below, out, opacity × mask × clipBase)
        │
        ▼  on commit (blur/click-away)
History ← AdjustmentParamEntry{ old→new spec }   (no pixels)
```

## 10. Rendering pipeline

```
composite(stack):
  acc ← blank target (or parent group buffer)
  ▼ bottom→top
  leaf        → draw (with its mask) onto acc
  group       → acc ← acc ∘ composite(children)        (group mask applied to buffer)
  adjustment  → snapshot acc(region) → applyAdjustments → write back
                modulated by opacity × layerMask × (clipped ? clipBaseAlpha : 1)
  ▲
  result → view canvas (working colour space) / export buffer (flatten)
```

Order matters: an adjustment only sees what is **below** it in its parent's child order. Stacked adjustments compose top-of-stack last (each sees the cumulative result beneath).

## 11. State-management rules

- Adjustment **params** are tree state (immutable, pure-function edits). The engine holds **no canvas** for adjustment nodes — only references their specs while compositing.
- Live edits flow React → `EngineHandle.updateAdjustmentSpec` → pure tree patch → recomposite. The panel must **debounce/throttle** slider drags to one recomposite per animation frame (reuse the existing live-adjustment throttling).
- A single committed history step per **edit gesture** (e.g., one slider drag from mousedown to mouseup = one step), not per intermediate value.
- Deleting/reordering an adjustment node uses the existing layer remove/insert ops; the compositor reflects the new position immediately.
- `setColorSpace`: adjustment nodes need no pixel conversion; only ensure `applyAdjustments` continues to receive the **new** working space tag.

## 12. History integration

- **Add / remove / duplicate / reorder** adjustment node → **structural** entries (reuse existing layer structural ops; for add, capture node + position).
- **Param edit** (including clip toggle, opacity, blend, type-specific values) → **structural** `AdjustmentParamEntry` whose `undo()/redo()` swap the node's `AdjustmentSpec` (and opacity/blend/clip) back/forward. **No pixel patch** — these are free, which is the whole point of non-destructive.
- **"Apply to pixels"** (destructive, on a real pixel layer) keeps the existing pixel-entry behaviour.
- Mask edits on an adjustment layer → Spec 01's `surface:'mask'` pixel entries.
- Finalise any open live-adjustment session before history navigation; emit summaries ("New Curves Layer", "Edit Vibrance Layer", "Adjustment Opacity").

## 13. Serialization changes (`.aproj`)

- Bump `version`.
- Serialize `LayerAdjustment` nodes with: `kind:'adjustment'`, common props, `adjustment` (the full `AdjustmentSpec`), `clipped`, and (via Spec 01) `mask`/`maskImage` if present. **No pixel image** for the node itself.
- Loader: reconstruct adjustment nodes; tolerate unknown future `AdjustmentSpec.type` by skipping the node's effect but preserving its data (forward-compat) — or, simpler, require known types and ignore unknown ones with a toast. **Older files (no adjustment nodes) must open unchanged.**
- Ensure the loader places adjustment nodes at the correct tree position and rebuilds masks.

## 14. Performance requirements

- The expensive op is `getImageData` readback + an `applyAdjustments` pass per adjustment node per composite. Mitigations, in priority order:
  1. **Region scoping** — never process the whole canvas when the dirty region is smaller. During interactive editing, scope to the **visible viewport ∩ dirty rect ∩ (selection or mask bounds)**. `effectiveRegion(node, scope)` computes this.
  2. **Sub-stack offscreen per group** — render a group's children into its own buffer so adjustment readbacks touch only that buffer, not the whole document.
  3. **Output cache per adjustment node** — cache the node's produced region keyed by `(specHash, belowContentVersion, region)`; reuse when nothing beneath changed. Invalidate when any layer below mutates, when the spec changes, or on resize.
- Target: editing an adjustment layer's slider on a 4000×3000 document at fit-zoom updates at **≥ 30fps** with viewport scoping; a single-layer doc with three stacked adjustments stays interactive.
- Reuse buffer-borrowing; never allocate canvases per frame. LUT-style adjustments (Spec 04) should precompute a LUT once per spec change and apply via a single typed-array pass.

## 15. Memory requirements

- Adjustment nodes themselves are tiny (params only). The cost is **temporary** readback/processing buffers and any per-node output cache.
- Cap the output cache: store at most the **viewport-sized** region per adjustment node, not full-document, during interaction. Drop caches on document close and on memory pressure (reuse existing buffer lifecycle).
- Masks on adjustment layers cost the same as Spec 01 masks (grayscale + alpha cache). Free on node deletion.

## 16. Edge cases (handle all)

1. **Adjustment at the very bottom of the stack** with nothing below → no-op (empty region); must not crash.
2. **Stacked adjustments** → each sees the cumulative result beneath; order respected; toggling visibility of a lower one updates all above.
3. **Adjustment inside a group** → affects only siblings below it **within that group** (group isolation). It must not reach pixels outside the group.
4. **Clipped adjustment** → affects only the clip base directly below; if the base is itself clipped/an adjustment, walk down to the nearest valid pixel base; if none, the clip has no effect.
5. **Opacity / blend on the adjustment** → opacity scales effect strength; blend mode blends the adjusted result over the original beneath (e.g., a Curves layer in "Luminosity" affects only luminance).
6. **Mask on the adjustment** → effect confined to mask-white areas; partial in gray.
7. **Merge-down with an adjustment** → merging an adjustment layer onto the pixel layer below **bakes** the adjustment into those pixels (composite base through the adjustment, write to a new leaf). Merging a pixel layer up into an adjustment is not meaningful → block or bake.
8. **Flatten** → bakes all adjustments into the single output leaf (export path already does this).
9. **Duplicate** an adjustment node → deep-copies its spec + mask; new id.
10. **Rasterise** an adjustment layer → produce a pixel layer equal to its visible contribution? Photoshop disallows rasterising an empty adjustment; instead define **"Rasterise = merge its effect into the layers below as a baked result is not standard"** — simplest correct behaviour: rasterising an adjustment layer is **not offered**; offer **Merge Down** instead. Document this.
11. **Canvas resize/crop/rotate/flip/image-size** → adjustment nodes carry no pixels, but their **masks** must transform with the canvas (Spec 01 loops). Output caches invalidate.
12. **Unknown preset / NaN param** → clamp params to valid ranges before processing; never feed NaN to `applyAdjustments`.
13. **P3 document** → `applyAdjustments` receives the P3 tag; results stay in gamut end-to-end.

## 17. Acceptance criteria

- [ ] A `LayerAdjustment` node can be created (from the menu and the panel), appears in the Layers panel with the right icon, and re-edits live on double-click with no Apply step.
- [ ] Its effect modifies the composite of all layers beneath it within its group, correctly modulated by opacity, blend mode, mask (Spec 01), and clip.
- [ ] Stacked and grouped adjustments compose in the correct order; group isolation holds.
- [ ] The destructive Adjustments-panel path (Apply/Reset on a pixel layer) still works, and a "Create adjustment layer" button converts a preview into a node.
- [ ] Param edits are single, cheap, undoable history steps with no pixel data; structural add/remove/duplicate/reorder undo correctly.
- [ ] All `layers.ts` pure functions handle the new kind without assuming pixels exist; duplicate/merge-down/flatten behave per §16.
- [ ] `.aproj` round-trips adjustment nodes (spec + clip + mask); older files still open; export bakes adjustments correctly.
- [ ] Interactive slider editing on a 4000×3000 document stays ≥ 30fps with viewport scoping; no per-frame canvas allocation.
- [ ] `applyAdjustments` (existing math) is the only adjustment processing function used — no duplicated math.

## 18. Coding standards

- Match repo conventions exactly (style, naming, SCSS modules, icons).
- TypeScript **strict**; exhaustive `switch` on `AdjustmentSpec.type` and on `LayerNode.kind` (with a `never` default to force future cases).
- Pure functions return new trees; engine methods snapshot-for-history → mutate → recomposite.
- Reuse `applyAdjustments`, `maskDisplay`, histogram, buffer-borrow, throttling — never duplicate.
- Keep the compositor refactor minimal and readable; isolate the readback/modulate logic in `applyAdjustmentNode`.

## 19. Claude must NEVER

- **Never** reimplement or fork the adjustment colour math — call the existing `applyAdjustments`.
- **Never** give an adjustment node its own pixel canvas or store its output as the source of truth (it is recomputed from below).
- **Never** mutate the tree in place; use `layers.ts` pure functions, and update **all** of them for the new kind.
- **Never** let an adjustment reach outside its parent group (respect isolation).
- **Never** process the full canvas when a smaller region suffices during interaction.
- **Never** record pixel data for a param edit — those steps are params-only.
- **Never** add a dependency or use WebGL/WebGPU.
- **Never** break loading of existing `.aproj` files or the existing destructive Apply path.

## 20. Begin now

First read `app/lib/paint.ts` (compositor + `applyAdjustments` + live-adjustment session), `app/lib/layers.ts` (all pure functions + union), the history module, the `.aproj` serializer, and the Spec 01 mask code. Then implement in order: (1) `LayerAdjustment` + `AdjustmentSpec` + update every `layers.ts` function; (2) compositor running-accumulator refactor; (3) `applyAdjustmentNode` with opacity/mask/clip modulation + clip-base alpha; (4) engine add/update/remove + `EngineHandle`; (5) Adjustments-panel edit-mode + create/convert; (6) Layers-panel rows + clip toggle + menu; (7) param history entries; (8) `.aproj` serialization + version bump; (9) merge-down/flatten/duplicate behaviour; (10) Perf scoping + caches. Build to the §17 checklist and write the code now.
