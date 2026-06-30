# Spec 03 — Layer Effects / Layer Styles (FX)

> **Claude Code task.** Implement non-destructive, re-editable layer effects (layer styles) in Graphiq Studio: Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Stroke, Color Overlay, Gradient Overlay, and Bevel & Emboss. Rendered at composite time from the layer's alpha silhouette; never bakes into pixels. This is a complete specification — read it, read the source files in §3, then implement. **Independent of Specs 01/02**; can be built in parallel (touches `layers.ts`, the compositor's leaf path, and the `.aproj` serializer).

---

## 1. Project context (Graphiq Studio)

Client-side browser raster editor; no server/upload. **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**; all imaging hand-written on Canvas 2D / `ImageData`. A single **`PaintEngine`** (`app/lib/paint.ts`) owns pixels; React uses a curated **`EngineHandle`**. Layers are an immutable tree (`app/lib/layers.ts`, pure functions). Linear pixel+structural history. Colour-space aware (sRGB / Display-P3).

The **Blur Gallery** already implements Box, Gaussian, Motion, Zoom, Spin, and Bokeh blurs on `ImageData`. Layer effects reuse a separable Gaussian/box blur primitive for shadows and glows. This feature delivers the visually dramatic, expected-in-every-pro-editor "fx" stack, fully non-destructive.

## 2. Architecture constraints

- **Non-destructive.** Effects are data on the layer, rendered around/under/over the layer's pixels at composite time. They never modify the layer's own pixels. (A separate explicit "Rasterise Layer Style" may bake, but the default is live.)
- **React declarative**; effect params live in the immutable tree; all rendering is in the engine.
- **Derive from alpha.** Shadows, glows, and strokes are computed from the layer's **alpha silhouette**, so they work for any layer content, including text and shapes.
- **Reuse the existing blur.** Do not write a new Gaussian if a usable separable blur already exists in the Blur Gallery code — extract/share it.
- **Cache aggressively.** A styled layer buffer is expensive (multiple blurs + composites). Cache it per layer, keyed by `(pixelVersion, fxParamsHash)`, and only re-render on layer-pixel change or FX edit.
- **No new dependencies.** Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — `composite` / `exportComposite` / `drawNode` (**leaf path** is where FX render), `leafDisplay`, the group-buffer path, `blendOp(blend)`, buffer-borrowing, the dirty/recomposite mechanism, and the **Blur Gallery blur routines** (find the separable Gaussian/box implementation to reuse).
- `app/lib/layers.ts` — `LayerLeaf` / `LayerGroup` / (and `LayerAdjustment` if Spec 02 landed); the common props; the pure functions (esp. clone-subtree, update, merge-down, flatten).
- `app/lib/color.ts` — hex/rgba parsing, gradient/checkerboard helpers (gradient overlay + thumbnails). Reuse the gradient model the **Gradient tool** already uses (multi-stop) so the Gradient Overlay editor matches.
- The **history module** — structural entries (FX edits are params-only, no pixels).
- The **`.aproj` (de)serializer** — add an optional `effects` object per layer.
- The **Layers panel**, **Menu bar**, and `EngineHandle`.
- The existing **Gradient tool**'s gradient/stop types and the **Blur Gallery** dialog patterns (for the Layer Style dialog UX/quality bar).

## 4. Design goals

1. Each leaf (and group) may carry a `LayerEffects` object holding any subset of: **Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Stroke, Color Overlay, Gradient Overlay, Bevel & Emboss**. (Satin optional/stretch.)
2. Effects render in **document space** at composite time, extend beyond the layer's bounds where appropriate (shadows/glows), and respect each effect's own blend mode + opacity.
3. **Re-editable forever** via a Layer Style dialog with a live preview; effects can be toggled individually, copied/pasted between layers, and cleared.
4. **Correct stacking order** matching Photoshop (see §10).
5. **Group support**: effects on a group apply to the merged group result (isolated), consistent with existing group compositing.

## 5. Detailed implementation plan

### 5.1 New module `app/lib/effects.ts`

A pure rendering module: given a **source** (the layer's display canvas / its alpha), the **`LayerEffects`** params, the working **colour space**, and a **bounds** rect, produce a **styled buffer** (canvas) plus its offset, representing the layer with all enabled effects composited in the correct order. The compositor draws this styled buffer instead of the raw layer when effects exist.

Core building blocks (all from the layer's alpha `A`):
- `silhouette(src) → alphaCanvas` — the layer's coverage as an opaque/colored shape.
- `offsetBlurTint(alpha, dx, dy, blurRadius, color, opacity)` — drop/inner shadow & glows. Uses the reused separable blur.
- `dilate(alpha, r)` / `erode(alpha, r)` — morphology for **Stroke** (outside = dilate−original, inside = original−erode, center = blend). Implement via distance-thresholded blur **or** a small max/min filter; pick the approach that reuses the blur primitive where possible.
- `fillThroughAlpha(color|gradient, alpha)` — Color/Gradient Overlay (draw fill, then `destination-in` the alpha).
- `bevel(alpha, params)` — compute a height field from blurred alpha, derive light/shadow from the gradient of that field along the light angle; composite highlight (screen) and shadow (multiply) clipped to the shape. Keep it pragmatic (emboss-from-blurred-alpha), not a full normal-map renderer.

### 5.2 Effect order (render into the styled buffer)

```
[ below the layer ]
  1. Drop Shadow      (offset+blur+tint of alpha, drawn behind, knockout under layer)
  2. Outer Glow       (blur+tint of alpha, behind, outside the shape)
[ the layer fill ]
  3. Layer pixels (src), then overlays clipped to alpha:
       Color Overlay  → Gradient Overlay   (each blendMode+opacity, destination-in alpha)
[ inside the layer ]
  4. Inner Shadow     (inverse: fill bounds, hole via alpha, blur, clip to alpha)
  5. Inner Glow       (edge or center source, blur, clip to alpha)
  6. Satin            (optional)
  7. Bevel & Emboss   (highlight screen + shadow multiply, clipped to alpha)
[ edge ]
  8. Stroke           (outside/inside/center; color or gradient)
```

Each enabled effect honours its own `blendMode` + `opacity`. "Knockout under layer" for Drop Shadow / Outer Glow = after drawing the effect behind, `destination-out` the layer alpha so the effect does not show through opaque layer pixels (respect the "Layer Knocks Out Drop Shadow" default = on).

### 5.3 Bounds

Compute styled-buffer bounds = layer alpha bounds **expanded** by the max outward extent across enabled effects (drop-shadow distance + size, glow size, outside-stroke width, bevel size). Clamp to a sane maximum (e.g., document bounds + a margin) to avoid enormous buffers. The styled buffer has an offset; the compositor draws it at `bounds.x/y`.

### 5.4 Compositor integration (`drawNode` leaf path)

```
leaf path:
  src = leafDisplay(id)                 // existing
  if (layer.effects has any enabled) {
      styled = effectsCache.get(id) ?? renderStyled(src, layer.effects, space)
      drawTarget = styled.canvas; offset = styled.offset
  } else {
      drawTarget = src; offset = (0,0)
      // still apply mask (Spec 01) here as today
  }
  if (mask?.enabled) drawTarget = drawTarget ⊗ maskDisplay(id)   // mask multiplies final
  ctx.globalAlpha = opacity/100
  ctx.gco = blendOp(blend)
  ctx.drawImage(drawTarget, offset.x, offset.y)
```

Notes:
- Effects render **before** the layer's own opacity/blend/mask are applied — i.e., the styled buffer is the "fill + fx", then the whole thing gets the layer's opacity/blend/mask. This matches Photoshop's default (effects are inside the layer's opacity). (Advanced "Fill Opacity vs Opacity" distinction is a stretch goal; default both equal for now.)
- **Group effects**: in the group path, render the merged group buffer, then run it through `renderStyled` using that buffer's alpha, then draw with group opacity/blend/mask.

### 5.5 Caching & invalidation

- `effectsCache: Map<layerId, { canvas, offset, key }>` in the engine. `key = hash(pixelVersion(layerId), fxParamsHash(layer.effects), space)`.
- Invalidate (drop the entry) when: the layer's pixels change (any paint/transform/structural op that touches that canvas bumps a per-layer `pixelVersion`), the layer's `effects` change, the document resizes, or the colour space changes.
- Re-render lazily on next composite. **Never** re-render the styled buffer mid-frame more than once.

### 5.6 UI — Layer Style dialog

- Open via **Layer ▸ Layer Style ▸ {effect}…**, an **"fx" button** in the Layers panel footer, or double-clicking a layer's empty area. Match the Blur Gallery dialog's quality bar.
- Left column: list of effect types with checkboxes (enable/disable) and selection. Right column: controls for the selected effect (color/gradient picker reusing the Gradient tool's editor, sliders for size/distance/spread/opacity/angle, blend-mode select, stroke position select). A **live preview** updates the document as values change.
- **Global**: "Scale Effects" multiplier; per-effect blend mode + opacity.
- **Layers panel**: show an "fx" badge on styled layers and an expandable sub-list of applied effects, each with its own eye toggle; right-click → Copy Layer Style / Paste Layer Style / Clear Layer Style.

## 6. Directory & file changes

```
app/lib/effects.ts        (new)   renderStyled(), per-effect renderers, morphology,
                                  bounds expansion, fxParamsHash
app/lib/paint.ts          (edit)  effectsCache + pixelVersion bumping; drawNode leaf
                                  + group integration; reuse blur primitive
app/lib/layers.ts         (edit)  effects?: LayerEffects on common props; clone-subtree
                                  deep-copies effects; copy/paste-style helpers
app/lib/history.ts        (edit)  structural FX-edit entry (old/new LayerEffects)
app/lib/project.ts        (edit)  serialize/deserialize effects; version bump
app/lib/engine-handle.ts  (edit)  expose setLayerEffects / copy / paste / clear
app/components/LayerStyleDialog/(new)  the dialog (effect list + controls + preview)
app/components/LayersPanel/     (edit)  fx badge, effect sub-list + eye toggles, context menu
app/components/MenuBar/         (edit)  Layer ▸ Layer Style submenu
```

No new npm packages.

## 7. TypeScript interfaces

```ts
export type FxBlend = BlendMode;            // reuse existing 19 modes
export type StrokePosition = 'outside' | 'inside' | 'center';

export interface ShadowFX {                 // drop & inner share shape
  enabled: boolean; blendMode: FxBlend; opacity: number;   // 0–100
  color: string;                            // hex
  angle: number;                            // degrees (global-light aware)
  distance: number; spread: number; size: number;          // px / %
  useGlobalLight?: boolean;
}
export interface GlowFX {                    // outer & inner share shape
  enabled: boolean; blendMode: FxBlend; opacity: number;
  color: string;                            // (gradient optional/stretch)
  spread: number; size: number; noise?: number;
  source?: 'edge' | 'center';               // inner glow only
}
export interface StrokeFX {
  enabled: boolean; blendMode: FxBlend; opacity: number;
  size: number; position: StrokePosition;
  fillType: 'color' | 'gradient';
  color?: string; gradient?: GradientStops;  // reuse Gradient tool's stop model
}
export interface OverlayColorFX { enabled: boolean; blendMode: FxBlend; opacity: number; color: string; }
export interface OverlayGradientFX {
  enabled: boolean; blendMode: FxBlend; opacity: number;
  gradient: GradientStops; angle: number; scale: number;
  style: 'linear' | 'radial'; reverse?: boolean;
}
export interface BevelFX {
  enabled: boolean; style: 'innerBevel' | 'outerBevel' | 'emboss' | 'pillowEmboss';
  depth: number; size: number; soften: number; angle: number; altitude: number;
  highlightMode: FxBlend; highlightColor: string; highlightOpacity: number;
  shadowMode: FxBlend; shadowColor: string; shadowOpacity: number;
}

export interface LayerEffects {
  scale?: number;                 // global effect scale (%), default 100
  dropShadow?: ShadowFX;
  innerShadow?: ShadowFX;
  outerGlow?: GlowFX;
  innerGlow?: GlowFX;
  stroke?: StrokeFX;
  colorOverlay?: OverlayColorFX;
  gradientOverlay?: OverlayGradientFX;
  bevel?: BevelFX;
}

// Added to LayerCommon (shared by leaf/group/adjustment):
//   effects?: LayerEffects;

export interface LayerEffectsHandle {
  setLayerEffects(layerId: string, effects: LayerEffects): void;  // live
  toggleEffect(layerId: string, key: keyof LayerEffects, enabled: boolean): void;
  copyLayerStyle(layerId: string): void;
  pasteLayerStyle(layerId: string): void;
  clearLayerStyle(layerId: string): void;
  rasterizeLayerStyle(layerId: string): void;   // optional bake
}

// effects.ts main entry:
export interface StyledResult { canvas: HTMLCanvasElement; offset: { x: number; y: number }; }
export function renderStyled(
  src: HTMLCanvasElement, fx: LayerEffects, space: ColorSpace
): StyledResult;
```

## 8. Class responsibilities

- **`effects.ts`** (pure): all effect rendering from alpha; bounds math; parameter hashing. No tree/React/history knowledge.
- **`PaintEngine`**: owns `effectsCache` + `pixelVersion`; calls `renderStyled` and draws the styled buffer in `drawNode`; invalidates cache on pixel/param/space/size changes; reuses the blur primitive.
- **`layers.ts`**: stores `effects` on nodes; clone-subtree deep-copies; copy/paste-style helpers.
- **History**: structural FX-edit entries (params only).
- **React (LayerStyleDialog, LayersPanel)**: editing UI, live dispatch, fx badges, context menu. No rendering math.

## 9. Data-flow diagram

```
Open Layer Style dialog → edit values
        │
        ▼
EngineHandle.setLayerEffects(id, fx)  ──► layers.ts update (pure) ──► new tree
        │                                          │
        │                                  engine: invalidate effectsCache[id]
        │                                          │  request recomposite
        ▼                                          ▼
composite → drawNode(leaf):
   styled = effectsCache[id] ?? renderStyled(leafDisplay(id), fx, space)  // effects.ts
   styled ⊗ maskDisplay(id) → draw with layer opacity+blend
        │
        ▼ on commit (close/click-away)
History ← FX-edit entry { old→new LayerEffects }   (no pixels)
```

## 10. Rendering pipeline (styled buffer)

```
renderStyled(src, fx, space):
  alpha = silhouette(src)
  buf = new canvas(boundsExpandedBy(maxOutwardExtent(fx)))
  // behind
  if dropShadow.enabled:  draw offsetBlurTint(alpha, ...) ; knockout under layer alpha
  if outerGlow.enabled:   draw blurTint(alpha, outside)  ; knockout under layer alpha
  // fill
  draw src
  if colorOverlay.enabled:    draw fillThroughAlpha(color, alpha)    (blend+opacity)
  if gradientOverlay.enabled: draw fillThroughAlpha(gradient, alpha) (blend+opacity)
  // inside (all clipped to alpha)
  if innerShadow.enabled: draw innerOffsetBlur(alpha, ...)  destination-in alpha
  if innerGlow.enabled:   draw innerBlur(alpha, source)     destination-in alpha
  if bevel.enabled:       draw highlight(screen)+shadow(multiply) from blurred-alpha gradient
  // edge
  if stroke.enabled:      draw stroke(alpha, size, position, color|gradient)
  return { canvas: buf, offset: bounds.topLeft }
```

Composite then draws `buf` at `offset`, then layer opacity/blend/mask apply to the whole styled result.

## 11. State-management rules

- Effect params are tree state (immutable, pure-function edits). The styled buffer is engine-cached, never tree state.
- Live edits: React → `setLayerEffects` → pure update → cache invalidate → recomposite, throttled to one render per animation frame during slider drags.
- One committed history step per edit gesture (a slider drag = one step).
- **Global light**: if any effect uses `useGlobalLight`, store a single document-level global-light angle and have those effects read it; changing global light invalidates all dependent caches.
- `setColorSpace`: effect colours are authored as hex (sRGB); render them so the browser converts onto P3 correctly (mirror how the brush stroke buffer stays sRGB then composites onto P3). Invalidate caches on space change.

## 12. History integration

- **Edit / toggle / paste / clear** effects → **structural** entries with `undo()/redo()` swapping the node's `LayerEffects` (params only, no pixels).
- **Rasterise Layer Style** (optional bake) → structural (replace styled layer with a baked pixel layer) + a pixel entry of the new pixels = one combined step.
- Emit summaries ("Add Drop Shadow", "Edit Layer Style", "Clear Layer Style").

## 13. Serialization changes (`.aproj`)

- Bump `version`.
- Serialize each node's `effects` object verbatim (it is plain JSON: colours as hex, gradients as the existing stop model, numbers). **No raster needed** — effects re-render from the layer pixels on load.
- Loader: attach `effects` if present; absent ⇒ no effects. Older files open unchanged. Validate/clamp out-of-range numbers on load.

## 14. Performance requirements

- The styled buffer is rendered **once per (pixel change | param change)** and cached — never per frame. Compositing a styled layer is a single `drawImage` of the cached buffer (+ mask multiply).
- Reuse the existing **separable blur** for shadows/glows; do not implement an O(n·r) naive box blur if a faster one exists. Cap blur radii to sane maxima.
- Editing effect sliders on a 4000×3000 text/shape layer updates at **≥ 30fps** (the styled buffer for a single layer re-renders within ~1 frame for typical sizes; large blurs may take longer — show the existing busy affordance if needed, but keep the UI responsive).
- Bound the styled buffer size (document + margin); never allocate unbounded canvases for huge shadow distances.
- Borrow temp buffers inside `renderStyled`; release on return.

## 15. Memory requirements

- One cached styled buffer per styled layer, sized to the expanded bounds (often larger than the layer). Free it when the layer is deleted, when effects are cleared, or under memory pressure.
- `renderStyled` uses several scratch buffers transiently; reuse a small pool, do not leak.
- Effects data itself is tiny JSON.

## 16. Edge cases (handle all)

1. **Fully transparent layer** → no silhouette; effects render nothing (no crash, empty styled buffer).
2. **Effects extending past canvas edges** → visible in the document (drawn at negative offsets), **clipped to canvas on export/flatten**.
3. **Layer at canvas border** → shadow/glow clipped by bounds clamp but still correct within the document.
4. **Stroke larger than the shape** (inside stroke on a thin shape) → erode to empty gracefully; outside stroke just grows.
5. **Gradient Overlay / Gradient Stroke** → reuse the Gradient tool's multi-stop model and rendering; angle/scale/reverse honoured.
6. **Group effects** → applied to the merged group buffer; nested groups each style their own merged result.
7. **Effects + mask (Spec 01)** → mask multiplies the **final** styled result (so a mask also hides the shadow). Confirm this is the intended order and implement it.
8. **Effects + adjustment layers (Spec 02)** → an adjustment above a styled layer sees the styled result as part of "below"; ordering just works through the compositor.
9. **Duplicate / merge-down / flatten / rasterise-layer** → duplicate deep-copies effects; merge-down/flatten **bake** effects into the merged pixels (composite the styled buffer into the result); rasterise-layer (pixels) keeps effects unless "Rasterise Layer Style" is chosen.
10. **Canvas resize/crop/rotate/flip/image-size** → no stored effect raster to transform, but **invalidate caches** so they re-render at the new geometry; effect distances are in px and stay constant unless "Scale Effects" is changed.
11. **Global light change** → all effects using it re-render.
12. **Extreme params (size 0, opacity 0, NaN)** → clamp; size/opacity 0 = effect invisible but valid.
13. **P3 document** → effect colours convert correctly (hex authored sRGB → composited onto P3).

## 17. Acceptance criteria

- [ ] All eight effects render correctly from the layer's alpha, in the §10 order, each with its own blend mode + opacity.
- [ ] Effects are fully re-editable via the Layer Style dialog with a live preview; individual effects toggle on/off; Copy/Paste/Clear Layer Style work.
- [ ] Shadows/glows extend beyond layer bounds in the document and clip correctly on export.
- [ ] Styled buffers are cached and only re-render on pixel/param/space/global-light change — compositing a styled layer is one `drawImage`.
- [ ] Effects compose correctly with layer opacity, all 19 blend modes, masks (Spec 01 if present), adjustment layers (Spec 02 if present), and groups.
- [ ] FX edits are single, undoable, params-only history steps; structural toggles/paste/clear undo correctly.
- [ ] `.aproj` round-trips `effects` (no raster); older files open; export/flatten bakes effects.
- [ ] Editing on a 4000×3000 layer stays responsive (≥ 30fps for typical sizes); no unbounded buffers; no per-frame re-render.
- [ ] The reused blur primitive (not a new naive blur) powers shadows/glows.

## 18. Coding standards

- Match repo conventions (style, naming, SCSS modules, icons, dialog patterns à la Blur Gallery).
- TypeScript **strict**; exhaustive switches over effect kinds; explicit return types.
- `effects.ts` is pure and side-effect-free; engine handles caching/invalidations; React handles UI/dispatch only.
- Reuse the Gradient tool's gradient model, `color.ts` parsing, the Blur Gallery blur, and buffer-borrowing — never duplicate.
- Tight inner loops for morphology; typed arrays; no per-pixel allocations.

## 19. Claude must NEVER

- **Never** modify the layer's own pixels to apply effects (effects are non-destructive; only explicit rasterise bakes).
- **Never** re-render the styled buffer per frame — cache and invalidate precisely.
- **Never** mutate the tree in place; edit `effects` via `layers.ts` pure functions.
- **Never** implement a fresh slow blur if the Blur Gallery already provides a separable one — reuse it.
- **Never** allocate unbounded canvases for large shadow distances — clamp bounds.
- **Never** store effect rasters in `.aproj` — store params and re-render on load.
- **Never** add a dependency or use WebGL/WebGPU.
- **Never** break loading of existing `.aproj` files.

## 20. Begin now

First read the Blur Gallery blur implementation and `composite`/`drawNode` in `app/lib/paint.ts`, the Gradient tool's stop model, `app/lib/color.ts`, `app/lib/layers.ts`, the history module, and the `.aproj` serializer. Then implement in order: (1) `LayerEffects` types + `effects` on `LayerCommon` + clone/copy/paste helpers in `layers.ts`; (2) `effects.ts` with `silhouette`, the reused blur, `offsetBlurTint`, morphology, overlays, bevel, bounds, `renderStyled`; (3) engine `effectsCache` + `pixelVersion` + `drawNode` leaf/group integration; (4) `EngineHandle` methods; (5) Layer Style dialog + live preview; (6) Layers-panel fx badge/sub-list/context menu + menu; (7) FX history entries; (8) `.aproj` serialization + version bump; (9) merge-down/flatten bake. Build to the §17 checklist and write the code now.
