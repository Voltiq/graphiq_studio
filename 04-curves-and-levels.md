# Spec 04 — Curves & Levels

> **Claude Code task.** Implement Curves and Levels — the two precision per-channel tone tools every professional editor has — in Graphiq Studio, with rich editing UIs over a live histogram. Both reduce to per-channel 256-entry LUTs applied in one fast pass. This is a complete specification — read it, read the source files in §3, then implement. **Prerequisite for the non-destructive form: Spec 02 (Adjustment Layers)** — Curves/Levels extend the `AdjustmentSpec` union. If Spec 02 is not yet landed, ship the **destructive-only** form first (§4 fallback) and wire the non-destructive form when 02 exists.

---

## 1. Project context (Graphiq Studio)

Client-side browser raster editor; no server/upload. **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**; hand-written Canvas 2D / `ImageData` imaging. A single **`PaintEngine`** (`app/lib/paint.ts`) owns pixels; React calls a curated **`EngineHandle`**. Immutable layer tree (`app/lib/layers.ts`). Linear pixel+structural history. Colour-space aware (sRGB / Display-P3).

The editor already has a **Channels** panel and a **per-channel histogram** engine op, plus a destructive Adjustments pipeline that runs on `ImageData` in the working space. Curves and Levels reuse the histogram for their backdrop and the adjustment-application path for processing. Spec 02 added non-destructive **adjustment layers** with an `AdjustmentSpec` discriminated union; this spec adds `'curves'` and `'levels'` to it.

## 2. Architecture constraints

- **LUT-based processing.** Both tools compile to **per-channel 256-entry uint8 lookup tables**; application is a single typed-array pass over `ImageData`. No per-pixel spline evaluation at apply time.
- **Reuse the histogram.** The editor already computes per-channel histograms; the Curves/Levels editors render that data as a backdrop — do not recompute histograms with new code if the op exists.
- **Reuse the adjustment-layer system (Spec 02).** Curves/Levels are new `AdjustmentSpec.type`s, processed through the same `applyAdjustmentNode`/`applyAdjustments` dispatch. As destructive adjustments they go through the existing live-adjustment session + Apply.
- **React declarative**; curve/level params live in the tree (as part of `AdjustmentSpec`); LUT building + pixel processing happen in lib/engine.
- **No new dependencies.** Canvas 2D + `ImageData` only; spline/LUT math hand-written.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — the **histogram** op (per-channel), the **live-adjustment session** (begin/update/preview/commit) for the destructive path, and (if Spec 02 landed) `applyAdjustmentNode` + the `AdjustmentSpec` dispatch, plus `applyAdjustments`.
- `app/lib/layers.ts` — the `AdjustmentSpec` union (extend it) and `LayerAdjustment` (Spec 02).
- `app/components/ChannelsPanel/` — channel selection model (composite RGB + R/G/B); reuse it to drive the editor's active channel and to render the histogram backdrop.
- The **Adjustments panel** + its session wiring (for destructive Curves/Levels and the "Create adjustment layer" path from Spec 02).
- The **history module** and the **`.aproj` serializer** (Spec 02 already serializes adjustment specs — just include the new fields).
- `app/lib/color.ts` if luminance/clamping helpers exist.

## 4. Design goals

- **Levels:** per-channel **input black / gamma (midtone) / input white**, **output black / output white**, a live histogram backdrop, **Auto** (per-channel contrast stretch), and **black/gray/white eyedroppers** that set points by sampling the image. Channels: composite RGB + individual R/G/B.
- **Curves:** per-channel **monotonic spline** through draggable control points over the histogram; add/remove/drag points; numeric input/output readout for the selected point; presets (Linear, Increase/Decrease Contrast, Negative); optional **targeted on-canvas adjustment** (click-drag on the image moves the curve point at the sampled tone).
- Both available **destructively** (Adjustments-style: live preview + Apply) **and non-destructively** (as adjustment layers from Spec 02). Destructive-only is the acceptable first ship if Spec 02 is absent.

## 5. Detailed implementation plan

### 5.1 LUT compilation

`app/lib/tone.ts` (new), pure:

- `levelsLUT(ch: ChannelParams): Uint8ClampedArray /*256*/` —
  `t = clamp((v - inBlack) / (inWhite - inBlack), 0, 1); t = pow(t, 1/gamma); out = outBlack + t*(outWhite - outBlack)`. Precompute 256 entries.
- `curveLUT(points: CurvePoint[]): Uint8ClampedArray /*256*/` — fit a **monotone cubic** (Fritsch–Carlson) through sorted points, sample at x=0..255, clamp to [0,255]. Guarantee monotonic, no overshoot. Endpoints default (0,0)/(255,255) but are user-movable.
- Compose **composite (RGB) LUT with per-channel LUTs**: `final_channel = perChannelLUT[ compositeLUT[v] ]` (composite applied first, then channel), matching Photoshop's behaviour. Build one effective 256-LUT per R/G/B at compile time so apply is a single indexing pass.

Apply (in the engine's adjustment path):
```
for i in data: data[i]   = lutR[data[i]]
               data[i+1] = lutG[data[i+1]]
               data[i+2] = lutB[data[i+2]]   // alpha untouched
```

Working space: operate on the working-space `ImageData` values (8-bit). Note: LUTs are 8-bit; this matches the canvas bit depth. Document the limitation (no >8-bit precision) in a code comment.

### 5.2 Integration as `AdjustmentSpec` (non-destructive, Spec 02)

Extend the union:
```
| { type: 'levels'; channels: { rgb: ChannelParams; r: ChannelParams; g: ChannelParams; b: ChannelParams } }
| { type: 'curves'; channels: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] } }
```
In `applyAdjustmentNode` (or the `applyAdjustments` dispatch), add cases that **build the LUTs once per spec change** (cache the compiled LUTs on the node/spec hash) and apply them. This slots into Spec 02's compositor path with zero new compositor logic — it is just another adjustment that processes the "below" region.

### 5.3 Destructive path (works without Spec 02)

Wire Curves and Levels into the **existing live-adjustment session**: the editor previews on the active layer via the session's preview buffer (recompute LUT on each edit, apply to the previewed `ImageData`), then **Apply** bakes (one pixel history entry) / **Reset** discards — identical to how the slider adjustments already work.

### 5.4 UIs

**Curves editor** (`app/components/CurvesDialog/`):
- A square graph (canvas or SVG) with the selected channel's **histogram** as a faint backdrop, a diagonal baseline, and a grid (quarters). Draggable nodes; click empty curve to add a node; drag a node off-graph (or right-click) to delete; endpoints constrained to their edges but movable along them.
- Channel selector (RGB/R/G/B) reusing the Channels model. Input/Output numeric fields for the selected node. Preset dropdown. Optional **targeted adjustment** toggle: when on, click-dragging on the **document** samples the tone under the cursor and moves the corresponding curve node up/down.
- Live preview through the session (destructive) or `updateAdjustmentSpec` (non-destructive node).

**Levels editor** (`app/components/LevelsDialog/`):
- Histogram backdrop with **three input triangles** (black/gamma/white) beneath it and **two output triangles** on a lower bar; numeric fields for all five; channel selector; **Auto**; three **eyedropper** buttons (set black/gray/white point by sampling the image — gray sets neutral by adjusting per-channel to equalize the sampled pixel).
- Same live-preview wiring.

Both: reuse the Adjustments panel's Apply/Reset affordances in destructive mode, or the Spec 02 node-edit (no Apply) in non-destructive mode.

## 6. Directory & file changes

```
app/lib/tone.ts            (new)   levelsLUT, curveLUT (monotone cubic), LUT compose,
                                   auto-levels, eyedropper point solving
app/lib/layers.ts          (edit)  extend AdjustmentSpec union with 'levels' | 'curves'
app/lib/paint.ts           (edit)  apply cases for levels/curves (build+cache LUTs;
                                   single typed-array pass); reuse histogram + session
app/components/CurvesDialog/(new)  curve graph editor (histogram backdrop, nodes, presets)
app/components/LevelsDialog/(new)  levels editor (triangles, fields, auto, eyedroppers)
app/components/AdjustmentsPanel/(edit)  expose Curves/Levels (destructive + create-as-layer)
app/components/MenuBar/     (edit)  Image ▸ Adjustments ▸ Curves / Levels; and (Spec 02)
                                   Layer ▸ New Adjustment Layer ▸ Curves / Levels
app/lib/project.ts         (edit)  serialize new AdjustmentSpec variants (Spec 02 path)
```

No new npm packages.

## 7. TypeScript interfaces

```ts
export interface ChannelParams {            // Levels, per channel
  inBlack: number;   // 0–255
  gamma: number;     // ~0.1–9.99, midtone; 1 = linear
  inWhite: number;   // 0–255  (inWhite > inBlack enforced)
  outBlack: number;  // 0–255
  outWhite: number;  // 0–255
}

export interface CurvePoint { x: number; y: number; }  // 0–255 each, x sorted ascending

// AdjustmentSpec additions (Spec 02 union):
export type ToneAdjustment =
  | { type: 'levels'; channels: { rgb: ChannelParams; r: ChannelParams; g: ChannelParams; b: ChannelParams } }
  | { type: 'curves'; channels: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] } };

export type ChannelKey = 'rgb' | 'r' | 'g' | 'b';

// tone.ts
export function levelsLUT(p: ChannelParams): Uint8ClampedArray;     // length 256
export function curveLUT(points: CurvePoint[]): Uint8ClampedArray;  // length 256, monotonic
export function composeLUT(composite: Uint8ClampedArray, channel: Uint8ClampedArray): Uint8ClampedArray;
export function autoLevels(histogram: HistogramData, clipPct: number): { r: ChannelParams; g: ChannelParams; b: ChannelParams };
export function solveGrayPoint(sample: RGB): { r: ChannelParams; g: ChannelParams; b: ChannelParams };

// Compiled, cached per spec:
export interface ToneLUTs { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray; }
export function buildLevelsLUTs(spec: Extract<ToneAdjustment,{type:'levels'}>): ToneLUTs;
export function buildCurvesLUTs(spec: Extract<ToneAdjustment,{type:'curves'}>): ToneLUTs;
```

## 8. Class responsibilities

- **`tone.ts`** (pure): LUT compilation (levels formula, monotone cubic spline), composite⊕channel composition, auto-levels, eyedropper point solving. No tree/engine/React knowledge.
- **`PaintEngine`**: in the adjustment apply path, build+cache `ToneLUTs` per spec hash and apply via one typed-array pass; reuse the histogram op and live-adjustment session.
- **React (CurvesDialog/LevelsDialog)**: editing UI over the histogram; emit spec updates; targeted on-canvas adjustment; presets/auto/eyedroppers. No LUT/pixel math beyond reading the produced preview.

## 9. Data-flow diagram

```
Open Curves/Levels (destructive)            Open as adjustment layer (Spec 02)
        │                                            │
   live-adjustment session                  LayerAdjustment{ type:'curves'|'levels' }
        │                                            │
 edit nodes/triangles ─► spec               edit ─► EngineHandle.updateAdjustmentSpec
        │                                            │
 tone.ts buildLUTs(spec) (cached)           tone.ts buildLUTs(spec) (cached)
        │                                            │
 apply LUTs to preview ImageData            applyAdjustmentNode: snapshot below →
        │                                    apply LUTs → modulate by opacity/mask/clip
        ▼                                            ▼
   Apply → pixel history entry              param edit → structural history (no pixels)
```

Histogram backdrop:
```
ChannelsPanel/active layer ──► histogram op ──► editor draws faint bars behind the graph
```

## 10. Rendering pipeline (apply)

```
buildLUTs(spec):
  for ch in {rgb,r,g,b}: lut[ch] = (levels? levelsLUT : curveLUT)(spec.channels[ch])
  effectiveR = composeLUT(lut.rgb, lut.r); effectiveG = composeLUT(lut.rgb, lut.g); effectiveB = composeLUT(lut.rgb, lut.b)
  return { r: effectiveR, g: effectiveG, b: effectiveB }   // cache by specHash

apply(img, luts):
  d = img.data
  for i in 0..d.length step 4:
    d[i]=luts.r[d[i]]; d[i+1]=luts.g[d[i+1]]; d[i+2]=luts.b[d[i+2]]   // alpha untouched
```

Single linear pass; no branching in the loop; LUTs precompiled.

## 11. State-management rules

- Curve points / level params live in the `AdjustmentSpec` (tree state for nodes; session state for destructive preview). The **compiled LUTs are derived/cached**, never stored in the tree.
- Cache LUTs keyed by spec hash; rebuild only when the spec changes (a drag updates the spec → one rebuild per frame, throttled).
- Curve points kept **sorted by x**; enforce on every edit; clamp all values to [0,255]; gamma clamped to a safe positive range; enforce `inWhite > inBlack` (min gap of 1).
- Destructive preview: one LUT rebuild + preview apply per edit gesture frame; **Apply** commits one history step; **Reset** discards.
- `setColorSpace`: LUTs operate on whatever 8-bit values the working-space `ImageData` carries; no special handling beyond reprocessing.

## 12. History integration

- **Destructive Apply** → one **pixel** entry (changed region only), exactly like the existing slider adjustments.
- **Non-destructive (Spec 02)** → param edits are **structural** `AdjustmentParamEntry` steps swapping the `AdjustmentSpec` (points/params), no pixel data; add/remove of the Curves/Levels adjustment node is structural.
- Emit summaries ("Curves", "Levels", "Edit Curves Layer").

## 13. Serialization changes (`.aproj`)

- Non-destructive: the new `AdjustmentSpec` variants serialize as plain JSON inside the adjustment node (Spec 02 already serializes specs) — include `channels` (curve points / level params). Bump `version` if not already bumped by Spec 02 in the same release.
- Destructive results are just pixels — already serialized as layer PNGs.
- Loader: validate/sort curve points, clamp params; tolerate absence (older files). Unknown future tone fields ignored gracefully.

## 14. Performance requirements

- Apply is **O(pixels)** with a precompiled LUT — a single typed-array pass, no per-pixel spline math. Target: full-canvas apply on 4000×3000 well under one frame for the loop (LUT build is 256 ops).
- LUT rebuild on edit happens **once per spec change**, throttled to one per animation frame during drags.
- Non-destructive editing inherits Spec 02's region scoping (process only viewport ∩ dirty ∩ mask/selection during interaction).
- Curve graph + histogram rendering must not re-layout per mousemove beyond redrawing the small graph canvas.

## 15. Memory requirements

- Three 256-byte LUTs per active spec (negligible). Cache at most a handful (current editor + visible adjustment nodes); drop on close.
- Curve points / level params are tiny JSON. No large buffers introduced by this feature beyond the standard preview buffer reused from the session.

## 16. Edge cases (handle all)

1. **Two curve points at the same x** → reject the second / nudge x by 1; never produce a non-function curve.
2. **Single point or all points collinear** → valid; LUT is the implied line.
3. **Endpoints moved inward along their edges** (e.g., black endpoint dragged up the left edge) → clips/raises shadows correctly.
4. **`inBlack == inWhite`** (Levels) → enforce a minimum gap of 1 to avoid divide-by-zero; clamp.
5. **Extreme gamma** → clamp to safe range; never NaN/Inf in the LUT.
6. **Output range inverted** (`outBlack > outWhite`) → allow (produces a per-channel negative); LUT handles it.
7. **Per-channel curve on R/G/B + composite curve** → compose composite-then-channel; verify against a known mapping.
8. **Auto-levels on a flat image** (histogram single spike) → no-op / safe; do not blow up contrast to NaN.
9. **Gray eyedropper on a saturated pixel** → solve per-channel to neutralize that sample; clamp results; warn if degenerate.
10. **Targeted on-canvas adjustment** when the sampled tone is at an endpoint → move the nearest node, do not create overlapping nodes.
11. **Selection / mask active** (non-destructive via Spec 02) → effect confined to it; (destructive) → preview/apply respects the active selection like other adjustments.
12. **P3 document** → process the working-space values; results stay in gamut.
13. **Alpha** → never modify the alpha channel in the LUT pass.

## 17. Acceptance criteria

- [ ] Curves: draggable monotone-cubic curve over a live histogram, per-channel (RGB/R/G/B), add/remove/drag points, numeric input/output, presets, optional targeted on-canvas adjustment; produces a correct 256-LUT.
- [ ] Levels: input black/gamma/white + output black/white triangles and fields over a live histogram, per-channel, Auto, and black/gray/white eyedroppers; produces a correct 256-LUT.
- [ ] Both apply via a single precompiled-LUT typed-array pass; composite⊕channel composition matches expected behaviour; alpha untouched.
- [ ] Destructive path: live preview through the existing session + Apply/Reset, one pixel history step on Apply. (Ships without Spec 02.)
- [ ] Non-destructive path (with Spec 02): Curves/Levels as adjustment layers, re-editable live, params-only history, serialized in `.aproj`, modulated by opacity/blend/mask/clip.
- [ ] Histogram backdrop reuses the existing histogram op; channel selection reuses the Channels model.
- [ ] Full-canvas apply on 4000×3000 is well within one frame; LUT rebuild throttled to one per frame during drags.
- [ ] All §16 edge cases handled without NaN/Inf/crashes; older `.aproj` files still open.

## 18. Coding standards

- Match repo conventions (style, naming, SCSS modules, icons, dialog patterns).
- TypeScript **strict**; explicit return types; exhaustive switches over `ChannelKey` and the tone `type`.
- `tone.ts` is pure; engine builds/caches/applies LUTs; React handles UI/dispatch.
- Reuse the histogram op, Channels model, live-adjustment session, and (Spec 02) `applyAdjustmentNode` — never duplicate.
- LUT loops branch-free and typed-array based; monotone-cubic implemented carefully (Fritsch–Carlson) with comments citing the method.

## 19. Claude must NEVER

- **Never** evaluate splines per pixel at apply time — always go through a precompiled 256-LUT.
- **Never** modify the alpha channel during tone application.
- **Never** recompute histograms with new code if the existing op is available.
- **Never** produce a non-monotonic or non-function curve (enforce sorted x, dedupe, clamp).
- **Never** divide by zero (`inWhite==inBlack`) or emit NaN/Inf into a LUT.
- **Never** mutate the tree in place; edit specs via `layers.ts` pure functions (non-destructive path).
- **Never** add a dependency or use WebGL/WebGPU.
- **Never** break loading of existing `.aproj` files or the existing Adjustments Apply path.

## 20. Begin now

First read the histogram op and live-adjustment session in `app/lib/paint.ts`, the Channels panel model, and (if present) Spec 02's `AdjustmentSpec` union + `applyAdjustmentNode`. Then implement in order: (1) `tone.ts` — `levelsLUT`, monotone-cubic `curveLUT`, `composeLUT`, `autoLevels`, `solveGrayPoint`, `buildLevelsLUTs`/`buildCurvesLUTs`; (2) destructive wiring through the live-adjustment session + Apply (ship this first); (3) `LevelsDialog` and `CurvesDialog` over the histogram backdrop with the Channels model; (4) if Spec 02 exists, extend the `AdjustmentSpec` union + add apply cases in `applyAdjustmentNode` with per-spec LUT caching + `.aproj` serialization + menu entries for adjustment-layer Curves/Levels. Build to the §17 checklist and write the code now.
