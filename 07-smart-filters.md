# Spec 07 — Smart Filters (Non-Destructive Filter Stack)

> **Claude Code task.** Implement non-destructive, re-editable **smart filters** in Graphiq Studio: a per-layer stack of filters rendered at composite time, re-editable forever. This both wraps the existing **Blur Gallery** non-destructively and is the proper home to finally implement the placeholder menu items — **Sharpen, Distort, Noise, Pixelate, Stylize**. This is a complete specification — read it fully, read the source files in §3, then implement. **Independent of Specs 01/02/05.** It is *much* cleaner on top of Spec 06 (Render Graph) — if 06 has landed, plug filter caching into the node cache; if not, use a local cache exactly like Spec 03's `effectsCache`. Do not stop to ask for confirmation on anything already decided here.

---

## 1. Project context (Graphiq Studio)

Graphiq Studio is a client-side, browser-based raster photo editor (no server/upload). Stack: **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**. All imaging is hand-written against Canvas 2D / `ImageData`; no image libraries.

A single **`PaintEngine`** (`app/lib/paint.ts`) owns all pixels; React calls the curated **`EngineHandle`**. Layers are an immutable tree (`app/lib/layers.ts`). The compositor walks bottom-to-top via `drawNode`; `leafDisplay(id)` returns a layer's display canvas (or a live-session scratch). The **Blur Gallery** already implements **Box, Gaussian, Motion, Zoom, Spin, Bokeh** as live-preview filters over `ImageData`, scoped to the selection or whole layer. The **Adjustments** pipeline runs `applyAdjustments(ImageData, params, space)` destructively (preview → Apply/Reset) via a **live-adjustment session**. The menu lists **Sharpen, Distort, Noise, Pixelate, Stylize, Liquify** as **placeholders that are not yet wired**.

**Smart filters vs adjustment layers (the key distinction).** An adjustment *layer* (Spec 02) modifies the composite of everything **below** it. A smart *filter* modifies **only its own layer's pixels**, before that layer composites. Filters are also frequently **spatial** (blur, distort, pixelate read neighbouring pixels), so they need the layer's own pixel buffer as input — not the composite. That is why this is a distinct feature, and why it is the right wrapper for the existing/placeholder filters.

## 2. Architecture constraints

- **Non-destructive.** A layer's `filters` are data; the engine renders `pixels → filter stack → filtered display` at composite time and **never** mutates the layer's stored pixels. An explicit "Apply / Flatten Filters" may bake on demand.
- **Reuse existing filter code; implement placeholders once.** Blur filter types **delegate to the Blur Gallery routines** (do not re-implement blur). The placeholder filters (Sharpen, Distort, Noise, Pixelate, Stylize) are implemented as pure `ImageData → ImageData` ops in a new `app/lib/filters.ts`. (Liquify is **out of scope** — it is a warp-mesh tool, specced separately.)
- **React declarative.** Filter params live on the immutable tree; all rendering is in the engine/lib.
- **Cache aggressively.** A filtered buffer (a stack of possibly heavy passes) is rendered **once per (pixelVersion, filterStackHash, space)** and cached — never per frame. If Spec 06 exists, this is part of the node's intrinsic render; otherwise a dedicated `filterCache` map.
- **No new dependencies.** Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — `composite`/`drawNode` (**leaf path**, where filtered display is produced), `leafDisplay(id)`, the **Blur Gallery blur routines** (Box/Gaussian/Motion/Zoom/Spin/Bokeh — reuse verbatim), the **live-adjustment session** pattern (begin/update/preview/commit — reuse for live filter editing and destructive Apply), the per-channel **histogram** (for Stylize ▸ Threshold/Posterize previews if useful), buffer-borrowing, the dirty/recomposite mechanism. If present: `maskDisplay` (01), `renderStyled`/`effectsCache` (03), the render-graph node cache (06).
- `app/lib/layers.ts` — `LayerLeaf`/`LayerGroup`/(`LayerAdjustment`), common props, and the pure functions (esp. clone-subtree deep-copy, merge-down, flatten).
- `app/lib/color.ts` — RGBA↔HSV/HSL, hex parsing, clamping helpers (for Noise tint, Stylize ops, gradient where relevant).
- The **history module** — structural entries (filter edits are params-only, no pixels), combined steps for destructive bake.
- The **`.aproj` (de)serializer** — add an optional `filters` array (+ optional filter mask) per layer.
- The existing **Blur Gallery dialog** (UX/quality bar to match) and the **Layers panel**, **Menu bar**, `EngineHandle`.
- If Spec 01 landed: the **mask machinery** (the smart-filter stack gets one optional filter mask, reusing it).

## 4. Design goals

1. Each leaf (and group) may carry an ordered **`SmartFilter[]`** stack. Each filter has a `type`, `params`, `enabled`, a **blend mode + opacity** (how the filtered result blends back over the pre-filter pixels), and the **stack as a whole** has one optional **filter mask** (reuse Spec 01) confining all filters.
2. Filters render **on the layer's own pixels**, in stack order, at composite time, producing the layer's **filtered display**; the layer then composites (with its opacity/blend/mask/effects) using that filtered display.
3. **Re-editable forever:** each filter re-opens its dialog bound to stored params; filters can be toggled, reordered (drag), and deleted; the whole stack can be cleared or applied (baked).
4. **Filter inventory shipped now:**
   - **Blur** (Box, Gaussian, Motion, Zoom, Spin, Bokeh) — wrap the Blur Gallery routines as smart-filter types.
   - **Sharpen** — Unsharp Mask (amount / radius / threshold); reuse the separable blur for the radius pass.
   - **Noise** — Add Noise (amount, Gaussian/Uniform, monochromatic).
   - **Pixelate** — Mosaic (cell size). (Crystallize optional/stretch.)
   - **Distort** — a pragmatic subset: Twirl, Pinch/Bulge, Wave/Ripple (displacement maps).
   - **Stylize** — Find Edges, Emboss, Posterize (levels), Threshold (level). (Posterize/Threshold are per-pixel; Find Edges/Emboss use the gradient.)
5. Correct interaction with **layer effects** (Spec 03 — effects sit **above** smart filters), **masks** (Spec 01), **adjustment layers** (Spec 02 — they see the filtered+styled result as "below"), and **groups**.

## 5. Detailed implementation plan

### 5.1 New module `app/lib/filters.ts`

Pure filter implementations, each `(src: ImageData, params, space: ColorSpace) => ImageData` (or in-place on a clone). **Blur types delegate** to the Blur Gallery routines (import/share them; do not duplicate). New implementations:

- **Unsharp Mask** `(amount, radius, threshold)`: `blurred = separableGaussian(src, radius)`; `mask = src − blurred`; where `|mask| > threshold`, `out = src + amount·mask`; clamp. Reuse the existing separable blur for `blurred`.
- **Add Noise** `(amount, distribution: 'gaussian'|'uniform', monochromatic)`: per pixel add noise; if monochromatic, same delta to R/G/B; else per-channel; clamp. Deterministic optional seed for reproducibility.
- **Mosaic** `(cellSize)`: average each `cell×cell` block, write the average back to the block. Single pass over blocks.
- **Distort** (one `type` with sub-modes): displacement maps computing a source coordinate per output pixel, bilinear-sampled, edge mode clamp/wrap:
  - *Twirl* `(angle, radius)` — rotate sample coords by an angle that falls off with distance from centre.
  - *Pinch/Bulge* `(amount)` — radial scale of sample distance.
  - *Wave/Ripple* `(amplitude, wavelength, type)` — sinusoidal offset.
- **Stylize**:
  - *Find Edges* — gradient magnitude (Sobel) → inverted intensity.
  - *Emboss* `(angle, height, amount)` — directional gradient mapped to gray + bias.
  - *Posterize* `(levels)` — quantize each channel to `levels` steps (per-channel LUT).
  - *Threshold* `(level)` — luminance threshold to black/white.

Each filter operates on the **working-space** `ImageData`; colour-touching ops (noise tint, stylize) use `color.ts`; spatial ops are colour-agnostic.

### 5.2 Filter-stack rendering

```
renderFiltered(srcPixels, filters, filterMaskAlpha?, space):
  if no enabled filters: return srcPixels (no copy needed for the no-op case)
  buf = clone(srcPixels)
  for f in filters (bottom→top), if f.enabled:
      out  = applyFilter(buf, f.type, f.params, space)      // filters.ts / Blur Gallery
      buf  = blendBack(buf, out, f.blendMode, f.opacity)     // per-filter blend over pre-filter
  if filterMaskAlpha: buf = mix(srcPixels, buf, filterMaskAlpha)   // stack mask (Spec 01)
  return buf
```

`blendBack` composites `out` over `buf` with the filter's blend mode + opacity (most filters use Normal @ 100, but exposing blend/opacity per filter is cheap and Photoshop-accurate). The **stack mask** confines the *entire* stack's effect (mix filtered vs original by mask alpha), matching Photoshop's single smart-filter mask.

### 5.3 Compositor integration (produce "filtered display")

Introduce `filteredDisplay(id)` mirroring `leafDisplay(id)`:

```
filteredDisplay(id):
  src = leafDisplay(id)                         // raw pixels or live-session scratch
  if (layer.filters has any enabled):
      return filterCache.get(id) ?? renderFiltered(src, layer.filters, maskFor(stack), space)
  return src
```

Then the **leaf path** uses `filteredDisplay(id)` everywhere it currently uses `leafDisplay(id)` for *display* purposes:
- **Layer effects (Spec 03)** derive their silhouette/fill from `filteredDisplay(id)` — so effects sit **above** filters (Photoshop order: Smart Filters render below Layer Effects). If Spec 03 is present, change its `renderStyled` input from `leafDisplay` to `filteredDisplay`.
- The layer's **mask (01)**, **opacity/blend**, and **clip (05)** apply to the filtered (then styled) result, unchanged.

Order within a single layer: **raw pixels → smart filters → (filtered display) → layer effects → mask → opacity/blend → composite.**

### 5.4 Caching & invalidation

- Without Spec 06: `filterCache: Map<layerId, { canvas, key }>`, `key = hash(pixelVersion(id), filterStackHash(filters), filterMaskVersion(id), space)`. Invalidate when the layer's pixels change, the filter stack changes, the filter mask changes, the document resizes, or the colour space changes.
- With Spec 06: **do not** add a parallel cache — fold the filtered render into the node's intrinsic render (the leaf's `contentVersion` already covers its filter stack per Spec 06 §5.1). `filteredDisplay` becomes part of `renderNode`'s leaf branch.
- Re-render lazily on next composite; never re-render mid-frame more than once. Heavy filters (large-radius Gaussian, Bokeh) may exceed one frame — show the existing busy affordance, keep the UI responsive.

### 5.5 Editing model (reuse the live-adjustment session)

- **Adding a filter:** the existing filter menus (Effects ▸ Blur Gallery…, and the now-implemented Sharpen/Distort/Noise/Pixelate/Stylize entries) open the filter's dialog. On confirm, **add a `SmartFilter` to the active layer's stack** (non-destructive) by default. Provide a secondary **"Apply destructively"** action for users who want the old bake-into-pixels behaviour.
- **Editing a filter:** double-click the filter in the Layers-panel sub-list (or select it) → its dialog re-opens bound to stored params; edits are live (reuse the live-adjustment session's preview throttling) and commit one params-only history step.
- **The destructive path remains:** "Apply destructively" runs the filter through the existing session and bakes (one pixel history entry) — identical to wiring a placeholder filter the simple way. This is also the acceptable **first ship** for the placeholder filters if you want them usable before the full stack UI exists.

### 5.6 UI

- **Layers panel:** a filter badge on filtered layers and an expandable **sub-list of filters** (like Spec 03's effects), each with an eye toggle, double-click to edit, **drag to reorder**, right-click to delete. Show the **filter-mask thumbnail** (Spec 01) for the stack if present. Right-click the layer → Clear Smart Filters / Apply (Flatten) Smart Filters.
- **Filter dialogs:** reuse the Blur Gallery dialog for blur types; build matching dialogs (same quality bar) for Sharpen/Noise/Pixelate/Distort/Stylize, each with a live preview.
- **Menu:** wire the placeholder entries (Sharpen, Distort, Noise, Pixelate, Stylize) to open their dialogs and add smart filters; keep Blur Gallery working and route it through the same add-as-smart-filter path.

## 6. Directory & file changes

```
app/lib/filters.ts          (new)   pure filter ops: unsharpMask, addNoise, mosaic,
                                     distort (twirl/pinch/wave), stylize (findEdges/emboss/
                                     posterize/threshold); blur types delegate to Blur Gallery;
                                     applyFilter dispatch + filterStackHash
app/lib/paint.ts            (edit)  filteredDisplay(id) + filterCache (or fold into Spec 06
                                     node cache); leaf path uses filteredDisplay; effects (03)
                                     input switched to filteredDisplay; reuse Blur Gallery +
                                     separable blur + live-adjustment session
app/lib/layers.ts           (edit)  filters?: SmartFilter[] + filterMask meta on common props;
                                     clone-subtree deep-copies; add/remove/reorder/toggle helpers
app/lib/history.ts          (edit)  structural filter-edit entry (old/new stack); combined
                                     pixel+structural for destructive Apply
app/lib/project.ts          (edit)  serialize/deserialize filters (+ filter mask via Spec 01);
                                     version bump
app/lib/engine-handle.ts    (edit)  add/update/remove/reorder/toggle/clear/applyFilters
app/components/(filter dialogs) (new/edit)  Sharpen/Noise/Pixelate/Distort/Stylize dialogs;
                                     Blur Gallery routed to add-as-smart-filter
app/components/LayersPanel/ (edit)  filter badge, filter sub-list + eye/drag/delete, mask thumb,
                                     context menu (Clear / Apply Smart Filters)
app/components/MenuBar/     (edit)  wire placeholder filter entries; Filter/Effects submenu
```

No new npm packages.

## 7. TypeScript interfaces

```ts
export type FilterType =
  | 'blurBox' | 'blurGaussian' | 'blurMotion' | 'blurZoom' | 'blurSpin' | 'blurBokeh'  // Blur Gallery
  | 'sharpenUnsharp'
  | 'noiseAdd'
  | 'pixelateMosaic'
  | 'distort'
  | 'stylize';

// Per-type params (confirm Blur Gallery's real param shapes in-repo and reuse them).
export interface UnsharpParams   { amount: number; radius: number; threshold: number; }
export interface NoiseParams     { amount: number; distribution: 'gaussian' | 'uniform'; monochromatic: boolean; seed?: number; }
export interface MosaicParams    { cellSize: number; }
export interface DistortParams   { mode: 'twirl' | 'pinch' | 'wave'; // discriminated by mode
                                   angle?: number; radius?: number; amount?: number;
                                   amplitude?: number; wavelength?: number; edge?: 'clamp' | 'wrap'; }
export interface StylizeParams   { mode: 'findEdges' | 'emboss' | 'posterize' | 'threshold';
                                   angle?: number; height?: number; amount?: number;
                                   levels?: number; level?: number; }
// Blur params reuse the Blur Gallery's existing param interfaces.

export interface SmartFilter {
  id: string;
  type: FilterType;
  params: unknown;            // one of the *Params above / Blur Gallery params, per `type`
  enabled: boolean;
  blendMode: BlendMode;       // how this filter's result blends over the pre-filter pixels
  opacity: number;            // 0–100
}

// Added to LayerCommon (shared by leaf/group/adjustment):
//   filters?: SmartFilter[];          // ordered bottom→top
//   filterMask?: MaskMeta;            // single mask confining the whole stack (Spec 01)

export interface SmartFilterHandle {
  addSmartFilter(layerId: string, type: FilterType, params: unknown): string; // returns filter id
  updateSmartFilter(layerId: string, filterId: string, params: unknown): void; // live
  toggleSmartFilter(layerId: string, filterId: string, enabled: boolean): void;
  reorderSmartFilters(layerId: string, fromIndex: number, toIndex: number): void;
  removeSmartFilter(layerId: string, filterId: string): void;
  clearSmartFilters(layerId: string): void;
  applySmartFilters(layerId: string): void;   // bake the whole stack into pixels (destructive)
}

// filters.ts
export function applyFilter(src: ImageData, type: FilterType, params: unknown, space: ColorSpace): ImageData;
export function filterStackHash(filters: SmartFilter[]): string;
```

## 8. Class responsibilities

- **`filters.ts`** (pure): each filter op + the dispatch + stack hashing; blur types delegate to Blur Gallery. No tree/React/history knowledge.
- **`PaintEngine`:** `filteredDisplay` + filter cache (or fold into Spec 06); produce the filtered display in the leaf path; feed it to effects (03), mask, opacity/blend; reuse Blur Gallery, separable blur, and the live-adjustment session; invalidate on pixel/stack/mask/space/size changes.
- **`layers.ts`:** store `filters`/`filterMask` on nodes; clone-subtree deep-copies; stack edit helpers.
- **History module:** structural filter-edit entries (params only); combined pixel+structural for destructive Apply.
- **React (filter dialogs, LayersPanel):** editing UI, live dispatch, badges/sub-list/reorder. No filter math.

## 9. Data-flow diagram

```
Open filter dialog (menu) → confirm / edit
        │
        ▼
EngineHandle.addSmartFilter / updateSmartFilter ──► layers.ts (pure) ──► new tree
        │                                                   │
        │                                  engine: invalidate filterCache[id] (or bump node version, Spec 06)
        │                                                   │  request recomposite
        ▼                                                   ▼
composite → drawNode(leaf):
   filtered = filterCache[id] ?? renderFiltered(leafDisplay(id), filters, filterMask, space)  // filters.ts
   styled   = effects? renderStyled(filtered, fx, space) : filtered      // effects ABOVE filters (Spec 03)
   styled ⊗ maskDisplay(id) → draw with layer opacity+blend (+clip, Spec 05)
        │
        ▼ on commit (close/click-away)
History ← filter-edit entry { old→new stack }   (no pixels)
```

## 10. Rendering pipeline (within one layer)

```
raw pixels (leafDisplay)
   │  renderFiltered: stack of applyFilter passes (blur → Blur Gallery; others → filters.ts),
   │  each blended back (blend+opacity), whole stack confined by filterMask (Spec 01)
   ▼
filtered display  ── cached by (pixelVersion, filterStackHash, filterMaskVersion, space)
   │  layer effects (Spec 03) derive from filtered display   (effects sit ABOVE filters)
   ▼
styled display
   │  layer mask (Spec 01) ⊗   then layer opacity + blend   then clip (Spec 05)
   ▼
composite onto running accumulator
```

## 11. State-management rules

- Filter params/stack are tree state (immutable, pure-function edits). The filtered buffer is engine-cached (or part of Spec 06's node cache), never tree state.
- Live edits: React → `updateSmartFilter` → pure update → cache invalidate → recomposite, throttled to one render per animation frame during slider drags (reuse the live-adjustment throttle).
- One committed history step per edit gesture; reordering/toggling/deleting a filter is one structural step each.
- `setColorSpace`: filtered buffers depend on space → invalidate; spatial filters are colour-agnostic, colour-touching ones reprocess in the new space (mirror how adjustments handle the space tag).
- Reordering filters changes `filterStackHash` → re-render.

## 12. History integration

- **Add / update / toggle / reorder / clear** filters → **structural** entries with `undo()/redo()` swapping the node's `filters` (and `filterMask` meta) — params only, no pixels.
- **Filter-mask painting** (Spec 01) → `surface:'mask'`-style pixel entries on the filter mask (reuse Spec 01's surface mechanism, extended to the filter-mask surface).
- **Apply (Flatten) Smart Filters** (destructive bake) → structural (stack removed) + pixel entry (new baked pixels) = one combined step.
- Finalise any open live-filter session before history navigation; emit summaries ("Add Gaussian Blur", "Edit Smart Filter", "Flatten Smart Filters").

## 13. Serialization changes (`.aproj`)

- Bump `version`.
- Serialize each node's `filters` array verbatim (plain JSON: `type`, `params`, `enabled`, `blendMode`, `opacity`, `id`) and, if present, the **filter mask** (`filterMask` meta + a grayscale PNG, via Spec 01's convention). **No filtered raster is stored** — re-render from layer pixels on load.
- Loader: attach `filters`/`filterMask` if present; absent ⇒ none. **Older files open unchanged.** Validate/clamp out-of-range params; ignore unknown future `FilterType`s gracefully (skip that filter, keep the rest).

## 14. Performance requirements

- The filtered buffer renders **once per (pixel change | stack change | mask change | space change)** and is cached — never per frame. Compositing a filtered layer is then a single draw of the cached buffer (then effects/mask/opacity).
- Reuse the **Blur Gallery** routines and the **separable blur** (for Unsharp's radius); do not implement naive blurs. Cap radii/cell sizes/displacement magnitudes to sane maxima.
- Spatial filters scope to the **layer bounds** (and, during interactive editing, ideally the dirty region / selection); per-pixel filters (Posterize/Threshold/Noise) are a single typed-array pass.
- Editing filter sliders on a 4000×3000 layer stays responsive (≥ 30fps for light filters; heavy passes may take longer — show the busy affordance, keep the UI alive).
- Borrow temp buffers inside `renderFiltered`; release on return; no per-frame allocation.

## 15. Memory requirements

- One cached filtered buffer per filtered layer (layer-sized). The filter mask costs like a Spec 01 mask. Free on layer deletion, on Clear Smart Filters, and under memory pressure (or via Spec 06's eviction budget if present).
- `renderFiltered` uses a few transient scratch buffers (e.g., Unsharp's blurred copy, Distort's source sample) — reuse a small pool, do not leak.
- Filter data itself is tiny JSON.

## 16. Edge cases (handle all)

1. **Empty / all-disabled stack** → `filteredDisplay` returns raw pixels with no copy; zero overhead.
2. **Disabled single filter** → skipped in the stack; the rest render.
3. **Spatial filter at layer edges** (blur/distort) → respect the chosen edge mode (clamp/wrap); never read out of bounds.
4. **Filter that would enlarge content** → keep all filters **within the layer's pixel bounds** (filtered display is layer-sized; unlike Spec 03 effects, smart filters do not expand bounds). Distort wraps/clamps at the edge.
5. **Reorder filters** → different result (e.g., Noise-then-Blur ≠ Blur-then-Noise); re-render; both valid.
6. **Filter mask** (Spec 01) → confines the whole stack: mask-black areas show original pixels, mask-white show filtered, gray blends.
7. **Filters + effects (Spec 03)** → effects derive from the **filtered** display (effects above filters); confirm and implement this order.
8. **Filters + adjustment layer above (Spec 02)** → the adjustment sees the filtered+styled result as part of "below"; just works through the compositor.
9. **Filters + clipping (Spec 05)** → a filtered layer can be a clip base or member; its filtered display is what gets clipped/blended.
10. **Group with filters** → render the merged group buffer, then run the filter stack on it (group filters operate on the merged result), consistent with group isolation.
11. **Duplicate / merge-down / flatten** → duplicate deep-copies the stack + filter mask; merge-down/flatten **bake** filters (render the filtered display into the merged pixels); rasterise keeps the stack unless Apply Smart Filters is chosen.
12. **Canvas resize / crop / rotate / flip / image-size** → no stored filtered raster to transform, but **invalidate caches** so they re-render at the new geometry; filter params in px stay constant.
13. **Extreme / NaN params** (radius 0, cell 0, amount huge) → clamp; a 0-strength filter is a valid no-op.
14. **P3 document** → filters operate on working-space `ImageData`; colour-touching ops respect the space (mirror adjustments); blur/distort are colour-agnostic.

## 17. Acceptance criteria

- [ ] A layer can carry an ordered smart-filter stack; filters render on the layer's own pixels at composite time and never mutate stored pixels.
- [ ] Blur types reuse the Blur Gallery routines; Sharpen (Unsharp), Noise, Pixelate (Mosaic), Distort (Twirl/Pinch/Wave), and Stylize (Find Edges/Emboss/Posterize/Threshold) are implemented and selectable — the placeholder menu items now work.
- [ ] Each filter is re-editable via its dialog with a live preview; filters toggle, **reorder by drag**, and delete; the stack clears and bakes ("Apply Smart Filters").
- [ ] A single stack-wide **filter mask** (Spec 01) confines the whole stack; per-filter blend mode + opacity are honoured.
- [ ] Order within a layer is correct: pixels → filters → effects (Spec 03, above filters) → mask → opacity/blend → clip (Spec 05) → composite.
- [ ] Filtered buffers are cached and re-render only on pixel/stack/mask/space change (or via Spec 06's node cache); compositing a filtered layer is one draw of the cached buffer.
- [ ] Filter edits are single, undoable, params-only history steps; destructive Apply is one combined pixel+structural step.
- [ ] `.aproj` round-trips `filters` (+ filter mask, no filtered raster); older files open; merge-down/flatten bakes filters.
- [ ] Editing on a 4000×3000 layer stays responsive; heavy filters show the busy affordance; no per-frame re-render; no unbounded buffers.
- [ ] The reused Blur Gallery / separable blur (not new naive blurs) power the blur and Unsharp passes.

## 18. Coding standards

- Match repo conventions (style, naming, SCSS modules, icons, dialog patterns à la Blur Gallery).
- TypeScript **strict**; exhaustive `switch` on `FilterType` and on the per-filter `mode` discriminants; explicit return types. Narrow `params: unknown` through the `type`/`mode` discriminant before use.
- `filters.ts` is pure and side-effect-free; the engine handles caching/invalidation; React handles UI/dispatch only.
- Reuse the Blur Gallery routines, the separable blur, `color.ts`, the live-adjustment session, and buffer-borrowing — never duplicate.
- Tight typed-array inner loops; no per-pixel allocations; bilinear sampling for distort kept branch-light.

## 19. Claude must NEVER

- **Never** modify the layer's stored pixels to apply filters (non-destructive; only explicit Apply bakes).
- **Never** re-render the filtered buffer per frame — cache and invalidate precisely (or use Spec 06's node cache).
- **Never** re-implement a blur that the Blur Gallery already provides — delegate to it (and reuse its separable blur for Unsharp).
- **Never** expand a layer's bounds via a filter — filtered display is layer-sized; handle edges with clamp/wrap.
- **Never** mutate the tree in place; edit `filters` via `layers.ts` pure functions.
- **Never** store filtered rasters in `.aproj` — store params and re-render on load.
- **Never** add a dependency or use WebGL/WebGPU.
- **Never** break loading of existing `.aproj` files or the existing destructive filter/Apply behaviour.

## 20. Begin now

First read the Blur Gallery blur routines and `composite`/`drawNode`/`leafDisplay` in `app/lib/paint.ts`, the live-adjustment session, `app/lib/color.ts`, `app/lib/layers.ts`, the history module, and the `.aproj` serializer (plus `renderStyled`/`effectsCache` if Spec 03 landed, and the render-graph node cache if Spec 06 landed). Then implement in order: (1) `filters.ts` — `applyFilter` dispatch, Unsharp/Noise/Mosaic/Distort/Stylize ops (blur types delegate to Blur Gallery), `filterStackHash`; (2) `SmartFilter[]` + `filterMask` on `LayerCommon` + clone/edit helpers in `layers.ts`; (3) `filteredDisplay(id)` + filter cache (or fold into Spec 06), leaf path switched to filtered display, effects (03) input switched to filtered display; (4) `EngineHandle` add/update/toggle/reorder/remove/clear/apply; (5) filter dialogs (reuse Blur Gallery; build matching Sharpen/Noise/Pixelate/Distort/Stylize) + wire the placeholder menu entries; (6) Layers-panel filter badge/sub-list/reorder/mask/context menu; (7) filter history entries + destructive Apply; (8) `.aproj` serialization + version bump; (9) merge-down/flatten bake. Build to the §17 checklist and write the code now.
