# Spec 06 — Render Graph & Dirty-Region Compositing

> **Claude Code task.** Retrofit a **node-keyed render cache with explicit dependency versions and dirty-region recompositing** onto Graphiq Studio's existing compositor. This is a *behaviour-preserving refactor*: the composited output must be pixel-identical to today's, only faster and more scalable. This is a complete specification — read it fully, read the real source files in §3, then implement. **This is the highest-risk spec in the pack. Do it AFTER Specs 01 (Masks) and 02 (Adjustment Layers) so the dependency model has real consumers to validate against. It should come BEFORE Spec 07 (Smart Filters) and any future GPU/high-bit-depth backend, which plug into the seam this spec creates.** Keep a debug flag that disables all caching and falls back to a full recomposite, so correctness can be A/B verified at any time.

---

## 1. Project context (Graphiq Studio)

Graphiq Studio is a client-side, browser-based raster photo editor (no server/upload). Stack: **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**. All imaging is hand-written against Canvas 2D / `ImageData`; no image libraries.

A single **`PaintEngine`** (`app/lib/paint.ts`) owns all pixels. Today, `composite(tree)` walks the **entire** layer tree bottom-to-top via `drawNode` and redraws **every** layer on **every** recomposite into the view canvas. Leaves draw their display canvas (`leafDisplay(id)`); groups composite their children into a fresh buffer then draw it with the group's opacity/blend. The paint path is already efficient (scratch/stroke buffers, dirty-bounded history patches), but the **compositor itself caches nothing**: a one-pixel brush dab on a 30-layer document re-draws all 30 layers, and editing one adjustment layer (Spec 02) re-runs its full read-back even when nothing beneath it changed.

This is fine for a handful of layers and is **not** an emergency — but it does not scale to many layers, and as non-destructive features land (adjustment layers, effects, smart filters), each one currently has to invent its own ad-hoc cache. This spec replaces those scattered caches with **one** principled mechanism.

> **What this spec is and is not.** It is *not* a from-scratch rewrite, a new threading model, or a GPU port. It does *not* claim to make opacity "instant" as a headline (a single layer's opacity change is already one `drawImage`). Its real wins are: (a) **unchanged subtrees are not recomposited**, so 1000+ layers and stable backgrounds stay cheap; (b) **only the dirty region** repaints; (c) **opacity/blend changes redo only the cheap draw step**, not the layer's intrinsic render; and (d) it establishes **one caching seam** that Specs 02/03/07 and a future renderer reuse instead of each rolling their own.

## 2. Architecture constraints

- **Behaviour-preserving.** Output must equal the current compositor's output for every document. Provide `engine.debug.disableRenderCache` that bypasses everything and full-recomposites; the two paths must be visually identical.
- **Caches are an optimization, never truth.** Dropping any cache at any time must yield correct results by recomputation. No state lives *only* in a cache.
- **Reuse, don't replace, `composite`/`drawNode`.** Wrap the existing per-node rendering in a cache lookup; keep the actual pixel operations identical.
- **Explicit dependencies.** Every node's cached render is keyed by a hash of exactly what it depends on. The one non-obvious dependency: an **adjustment layer (Spec 02) depends on the composite of its lower siblings**, so anything beneath it must invalidate it.
- **Consolidate existing caches.** If Spec 02's per-adjustment output cache and Spec 03's `effectsCache` exist, fold them into this node cache (an adjustment's/effect's product becomes part of that node's cached render). Do not keep three parallel caches.
- **No new dependencies.** Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — `composite(tree)` / `exportComposite(tree)` / `drawNode`, `leafDisplay(id)`, the group-buffer path, `blendOp(blend)`, buffer-borrowing, the **dirty/recomposite mechanism** and the **view-canvas blit** (how the composed result reaches the screen, including pan/zoom). If present: `maskDisplay` (01), `applyAdjustmentNode` + the running-accumulator compositor (02), `effectsCache`/`pixelVersion`/`renderStyled` (03).
- `app/lib/layers.ts` — the node union and the pure functions; in particular which structural ops change child order/membership (insert-relative, remove, wrap-in-group, ungroup, merge-down, flatten, clone-subtree). These are the invalidation triggers.
- Every **engine mutation method** — paint commit, fill/erase, transforms, set-layer-image, adjustment edit, effect edit, opacity/blend/visibility/mask/clip changes, layer add/remove/reorder. Each must, after mutating, **mark the right node(s) dirty** instead of relying on a blanket "recomposite everything."
- The **history module** — `jumpTo` must invalidate the nodes it touches (it mutates pixels/structure under the hood).

## 4. Design goals

1. A **per-node render cache**: each node caches its **intrinsic render** (its own composited pixels, in its parent's coordinate space) plus a **content version** and a **cache key**.
2. **Separation of intrinsic render from composite step.** A leaf's intrinsic render = its pixels ⊗ mask ⊗ effects ⊗ smart-filters (whatever applies). Its **opacity / blend** are applied when the parent draws the cached buffer — so changing opacity/blend invalidates **only the draw step**, not the intrinsic render.
3. **Dependency-versioned invalidation.** A node's cache key includes its own input versions plus the versions of everything it depends on (children for groups; lower-siblings for adjustments). Bumping a version invalidates exactly the affected nodes and their dependents — nothing more.
4. **Dirty-region recompositing.** Mutations accumulate a dirty rect; a recomposite repaints only that rect up the affected parent chain to the view; the view blits only the dirty rect (intersected with the viewport).
5. **Bounded memory** with LRU eviction; caches drop safely under pressure.
6. **One seam for downstream features.** Specs 02/03/07 and any GPU/high-bit backend read/write this cache instead of bespoke ones.

## 5. Detailed implementation plan

### 5.1 Per-node cache + versions

```
renderCache:     Map<layerId, RenderNodeCache>   // intrinsic render per node
contentVersion:  Map<layerId, number>            // bumped when node intrinsic inputs change
```
`RenderNodeCache = { buffer: HTMLCanvasElement; bounds: Rect; key: string }`.

- **Intrinsic inputs** of a node (what its `contentVersion` covers): for a **leaf** — its pixel canvas, its mask pixels (01), its effects params (03), its smart-filter stack (07). For a **group** — the set+order of its children and each child's effective version. For an **adjustment** (02) — its `AdjustmentSpec` params **and** the composite of its lower siblings.
- **NOT** intrinsic (handled at draw time, do not bump `contentVersion`): the node's own `opacity`, `blend`, `visible`, and `clipped` flag, and the node's **position** among siblings. These affect how/whether the cached buffer is *drawn*, not what it contains.

### 5.2 Cache key (what a node depends on)

```
keyOf(node):
  leaf:       hash(pixelVersion(id), maskVersion(id), fxHash(effects), filterStackHash(filters), space)
  group:      hash(childrenSig(node))            // ordered list of child effectiveKey()s
  adjustment: hash(specHash(node.adjustment), belowSig(node), space)
              // belowSig = hash of the effectiveKey()s of all lower siblings in this parent
effectiveKey(node) = hash(keyOf(node), opacity, blend, visible, clipped)  // for parent's childrenSig
```
A cache entry is valid iff its stored `key === keyOf(node)` now. `effectiveKey` (which folds in draw-time props) is what a **parent** hashes into its own `childrenSig`, so a child's opacity change *does* invalidate the **parent group's** composite (correct — the group's merged pixels changed) without invalidating the **child's own** intrinsic render.

### 5.3 Compositor with caching (wrap, don't replace)

```
renderNode(node, scope) -> { buffer, bounds }:        // returns intrinsic render (pre-opacity/blend)
  k = keyOf(node)
  hit = renderCache.get(node.id)
  if hit && hit.key === k && covers(hit.bounds, scope): return hit
  // miss → recompute using the EXISTING drawNode logic, into a borrowed buffer:
  buf = borrow(...)
  switch node.kind:
    leaf:       draw leafDisplay(id) ⊗ mask(01) ; run effects(03)/filters(07) per their specs
    group:      composite(node.children, scope) into buf      // recurses via renderNode per child
    adjustment: assemble lower-sibling composite (from siblings' caches) then applyAdjustmentNode
  store { buffer: buf, bounds, key: k } in renderCache (subject to eviction)
  return it

composite(childList, scope):                          // the running accumulator, now cache-backed
  acc = target
  for unit in clipGroupsOf(childList) bottom→top:      // Spec 05 clip groups, else single nodes
     r = renderNode(unit.base, scope)                  // (clip-group assembly wraps members per Spec 05)
     if !unit.base.visible: continue
     acc.gco = blendOp(base.blend); acc.globalAlpha = base.opacity/100
     acc.draw(r.buffer at r.bounds)
  return acc
```

The **only** behavioural change is the `renderCache` lookup/skip; the pixel ops inside each branch are the current ones. Adjustment "below" assembly reads lower siblings' cached buffers, so an adjustment whose lower siblings are all cache-hits is itself cheap to revalidate (its key's `belowSig` is unchanged ⇒ cache hit).

### 5.4 Dirty-region tracking & invalidation

- `bumpVersion(id, dirtyRect?)`: increments `contentVersion[id]`, drops `renderCache[id]`, unions `dirtyRect` into the pending dirty region, and **propagates**: walk to the parent (its `childrenSig` changed ⇒ drop its cache), and within each ancestor parent, drop the cache of any **adjustment sibling above** the changed node (its `belowSig` changed) — and recurse that adjustment's own dependents. Stop at the root.
- Mutations call `bumpVersion` with the **bounded rect they changed** (reuse the dirty bounds the paint/history code already computes). Structural ops (add/remove/reorder/group/ungroup) bump the parent and pass the affected bounds (union of moved nodes' bounds).
- `recomposite()` now means: recompute caches as needed and **repaint only the pending dirty region** into the view canvas (intersected with the viewport), then clear the pending region. A full repaint (e.g., first paint, zoom/pan exposing new area, colour-space change) sets the dirty region to the whole viewport.

### 5.5 Draw-time-only changes (the cheap path)

Changing a node's **opacity, blend, or visibility**, or its **clip flag** (Spec 05), must **not** bump `contentVersion` and must **not** drop that node's intrinsic cache. It only:
- invalidates the **parent group's** cache (via `effectiveKey` feeding `childrenSig`), and
- marks the node's bounds dirty so the region repaints.
This is where "instant opacity" actually comes from: the layer's (possibly expensive) intrinsic render — effects, filters, mask — is reused untouched; only the composite step re-runs over the dirty region.

### 5.6 Export path

`exportComposite` must produce a **guaranteed-correct full flatten**: run with `scope = whole canvas`, and prefer bypassing region-scoping (compose the entire document). It may reuse caches (they're keyed and valid) but must never emit a partially-composited region. Provide an option to force a clean full recomposite for export to eliminate any cache-coherence doubt in saved output.

## 6. Directory & file changes

```
app/lib/render-graph.ts   (new)   RenderNodeCache types; keyOf/effectiveKey/childrenSig/
                                  belowSig hashing; LRU eviction policy; dirty-region accumulator
app/lib/paint.ts          (edit)  renderNode() wrapper + renderCache/contentVersion maps;
                                  composite() cache-backed; bumpVersion() + propagation;
                                  recomposite() = dirty-region repaint; debug.disableRenderCache;
                                  fold in Spec 02 output cache + Spec 03 effectsCache
app/lib/layers.ts         (read)  structural ops are invalidation triggers (no signature change,
                                  but confirm which ops change order/membership)
app/lib/history.ts        (edit)  jumpTo bumps versions/dirty for the nodes it mutates
app/lib/engine-handle.ts  (edit)  every mutating method routes through bumpVersion with bounds;
                                  expose debug toggle (dev only)
```

No new npm packages. No new UI (this is an engine refactor); optionally a tiny dev-only overlay showing cache hit/miss + dirty rect.

## 7. TypeScript interfaces

```ts
export interface Rect { x: number; y: number; w: number; h: number; }

export interface RenderNodeCache {
  buffer: HTMLCanvasElement;   // intrinsic render (pre-opacity/blend), parent coordinate space
  bounds: Rect;                // region the buffer is valid for
  key: string;                 // keyOf(node) at the time it was rendered
  bytes: number;               // for LRU accounting
  lastUsed: number;            // monotonic tick, for eviction
}

export interface RenderGraph {
  renderCache: Map<string, RenderNodeCache>;
  contentVersion: Map<string, number>;
  dirty: Rect | null;          // pending repaint region (document space)
  budgetBytes: number;         // cap; evict LRU beyond this
}

// hashing (pure)
export function keyOf(node: LayerNode, ctx: KeyContext): string;
export function effectiveKey(node: LayerNode, ctx: KeyContext): string;  // folds opacity/blend/visible/clipped
export function childrenSig(children: LayerNode[], ctx: KeyContext): string;
export function belowSig(siblings: LayerNode[], indexOfNode: number, ctx: KeyContext): string;

// engine
export interface RenderGraphHandle {
  // internal: not React-facing beyond a dev toggle
  bumpVersion(layerId: string, dirty?: Rect): void;
  invalidateAll(): void;                         // colour-space change, resize
  setRenderCacheEnabled(enabled: boolean): void; // debug A/B
}

interface KeyContext {
  pixelVersion(id: string): number;
  maskVersion(id: string): number;
  space: ColorSpace;
}
```

## 8. Class responsibilities

- **`render-graph.ts`** (pure where possible): key/sig hashing, dirty-rect accumulation math, LRU eviction selection. No canvas ops.
- **`PaintEngine`:** owns `renderCache`/`contentVersion`/`dirty`; `renderNode` wrapper around the existing per-kind draw logic; `bumpVersion` + propagation; dirty-region repaint; export full-flatten; eviction execution. Subsumes Spec 02's adjustment output cache and Spec 03's `effectsCache`.
- **Engine mutators / history:** call `bumpVersion(id, bounds)` after every change instead of a blanket recomposite.
- **React:** unchanged (engine refactor); optional dev overlay only.

## 9. Data-flow diagram

```
Mutation (paint commit / opacity / adj edit / reorder / jumpTo)
        │  (knows its bounded changed rect)
        ▼
engine.bumpVersion(id, rect):
   contentVersion[id]++ ; renderCache.delete(id) ; dirty ∪= rect
   propagate ↑: parent cache drop ; adjustment-above cache drop (belowSig changed) ; recurse
        │
        ▼
recomposite():
   for nodes needed to repaint `dirty`:
       renderNode(node): key match? → reuse buffer : recompute via existing drawNode logic, cache it
   composite(root, scope=dirty) → repaint only `dirty` into view canvas (∩ viewport)
   dirty = null
        │
        ▼
   on-screen view canvas (document colour space)

Opacity/blend/visible/clip change (draw-time only):
   do NOT bump contentVersion ; drop PARENT cache (childrenSig via effectiveKey) ; dirty ∪= node.bounds
```

## 10. Rendering pipeline (cache-backed)

```
renderNode(node):                         // intrinsic render, cached
  if cache hit (key & bounds ok): return cached buffer
  else recompute via the SAME ops as today (leaf draw / group composite / adjustment apply),
       store in renderCache (evict LRU if over budget), return

composite(childList, scope):
  acc ← target
  ▼ bottom→top over clip groups (Spec 05) or single nodes
  intrinsic = renderNode(node)            // cache hit ⇒ no re-render
  draw intrinsic with node.opacity + node.blend onto acc   // draw-time props here
  ▲
  result → view canvas (repaint only `scope`) / export buffer (full canvas, clean)
```

Invariant: with `debug.disableRenderCache = true`, `renderNode` always recomputes and `composite` repaints the whole viewport — output must be identical to caching mode.

## 11. State-management rules

- The render graph is **engine** state, fully derived from the tree + pixel buffers; it is reconstructable at any time. The immutable layer tree remains the single source of structural truth.
- Exactly one rule decides intrinsic vs draw-time: **does the change alter the node's own composited pixels?** If yes (pixels/mask/effects/filters/adjustment-params/lower-sibling-content) → bump `contentVersion`. If no (opacity/blend/visible/clipped/position) → drop only the parent's cache + mark dirty.
- Throttle: coalesce multiple `bumpVersion`/dirty unions within one frame into a single `recomposite` on the next animation frame (reuse existing throttling).
- `setColorSpace` and document resize/crop call `invalidateAll()` (every intrinsic render depends on space/geometry) and set dirty = whole viewport.

## 12. History integration

- `jumpTo` mutates pixels/structure; after applying each entry it must `bumpVersion` the affected node(s) with the entry's bounded rect (pixel entries already carry a `rect`; structural entries pass the affected nodes' bounds). Undo/redo then repaint only the changed region.
- No new history entry types — this spec changes *how* recompositing reacts to existing entries, not what is stored.

## 13. Serialization changes (`.aproj`)

- **None.** The render graph is a runtime cache; nothing about it is serialized. `.aproj` is unchanged, and existing files open identically. (If this spec ships in the same release as a version-bumping spec, it adds no fields of its own.)

## 14. Performance requirements

- **Stable-subtree skip:** on a document with 1000 layers where a single layer is edited, only that layer's intrinsic render plus its ancestor groups (and any adjustment above it) recompute; all other nodes are cache hits. Editing must not re-render the other 999.
- **Dirty-region repaint:** a brush dab repaints only the dab's bounded rect to the view, not the whole canvas.
- **Draw-time changes:** opacity/blend/visibility on one layer re-runs only the composite step over that layer's bounds — its intrinsic render (including any effects/filters) is reused.
- **Adjustment revalidation:** editing an adjustment's params recomputes only that adjustment (its lower-sibling composite is a cache hit via `belowSig`); editing a layer *below* an adjustment invalidates that adjustment and everything above it, scoped to the dirty region (this is inherent and acceptable).
- Never allocate per frame; borrow from the pool. Hashing must be cheap (hash small param objects + child key lists, not pixel data).

## 15. Memory requirements

- Each cached node holds one buffer (often layer- or group-sized). Set a **byte budget** (`budgetBytes`, e.g. a sensible fraction of a memory estimate) and **evict LRU** beyond it — prefer evicting off-screen/occluded and least-recently-used nodes; never evict a node currently being composited this frame.
- Eviction must be safe: an evicted node simply recomputes on next access. Validate that worst-case (cache fully evicted) still renders correctly, only slower.
- Free a node's cache on layer deletion, on `invalidateAll`, and under memory pressure. Folding in Spec 02/03 caches means their memory is governed by this one budget.

## 16. Edge cases (handle all)

1. **Cache disabled** (`debug.disableRenderCache`) → full recompute every frame; output identical to enabled. (This is the correctness oracle.)
2. **Reorder** that changes clip groups or adjustment "below" sets → parent cache + affected adjustments drop; recompose correctly.
3. **Group expand/collapse** → UI-only; must **not** invalidate any render cache (collapsed children still composite).
4. **Adjustment with nothing below** (Spec 02 edge) → `belowSig` of empty set is stable; no spurious invalidation.
5. **Nested groups** → invalidation propagates up every ancestor; each group's `childrenSig` recomputed from child `effectiveKey`s.
6. **Hidden layer toggled visible** → draw-time change (parent cache drop + dirty), not an intrinsic re-render of that layer.
7. **Mask/effects/filter edit** (Specs 01/03/07) → bumps the owning leaf's `contentVersion` (intrinsic), scoped to the affected bounds; folds the old per-feature cache into this one.
8. **Colour-space switch / resize / crop / rotate / flip** → `invalidateAll` + full-viewport dirty; caches realloc lazily.
9. **Export while caches are warm** → full clean flatten (whole canvas), never a region-scoped partial.
10. **`jumpTo` across many steps** → invalidate each touched node with its rect; coalesce dirty; one repaint.
11. **Pan/zoom** → no cache invalidation (intrinsic renders are document-space); only the view blit changes; newly exposed area is dirty.
12. **Memory pressure mid-edit** → evict LRU non-active nodes; re-render on demand; never corrupt the in-progress frame.
13. **Hash collision risk** → use a sufficiently wide hash and include all dependency inputs; when in doubt, prefer correctness (treat as miss).

## 17. Acceptance criteria

- [ ] Composited output is pixel-identical to the pre-refactor compositor for every test document, in both cache-enabled and `debug.disableRenderCache` modes.
- [ ] Editing one layer on a 1000-layer document recomputes only that layer + its ancestors (+ any adjustment above it); the rest are cache hits.
- [ ] A brush dab repaints only its bounded region to the view; opacity/blend/visibility changes re-run only the composite step (intrinsic render, including effects/filters, reused).
- [ ] Adjustment-layer (Spec 02) "below" dependency is correctly modelled: editing below an adjustment invalidates it; editing the adjustment alone does not re-render its lower siblings.
- [ ] Spec 02's adjustment output cache and Spec 03's `effectsCache` are folded into this one node cache (no parallel caches remain).
- [ ] Caches respect a byte budget with LRU eviction; a fully-evicted cache still renders correctly (slower). Caches free on delete / colour-space change / resize / memory pressure.
- [ ] `jumpTo` (undo/redo) repaints only changed regions; group expand/collapse and pan/zoom never invalidate intrinsic caches.
- [ ] Export produces a clean full flatten regardless of cache state.
- [ ] `.aproj` and all existing files are unaffected (no serialization change).
- [ ] A dev toggle flips caching on/off at runtime for verification.

## 18. Coding standards

- Match repo conventions (style, naming, SCSS modules, icons).
- TypeScript **strict**; exhaustive `switch` on `LayerNode.kind`; explicit return types; no `any`.
- Keep the cache layer **transparent**: the per-kind pixel ops inside `renderNode` must be the existing `drawNode` ops, refactored in place, not rewritten.
- The dependency-version logic is the subtle part — comment the intrinsic-vs-draw-time rule and the adjustment `belowSig` dependency explicitly.
- Hashing helpers pure and side-effect free; eviction policy isolated and testable.

## 19. Claude must NEVER

- **Never** change the composited result — this is a behaviour-preserving refactor; if output differs from the disabled-cache path, the cache is wrong.
- **Never** store state only in a cache — every cache must be reconstructable; dropping it must never change correctness.
- **Never** bump a node's intrinsic `contentVersion` for an opacity/blend/visibility/clip/position change (those are draw-time; only the parent's cache drops).
- **Never** invalidate the whole graph for a localized edit — propagate precisely (parent chain + adjustments-above only).
- **Never** keep Spec 02/03's separate caches alongside this one — consolidate.
- **Never** emit a region-scoped partial composite on the export path.
- **Never** allocate buffers per frame, and never let the cache grow past its byte budget.
- **Never** add a dependency or use WebGL/WebGPU (this spec *prepares* for a future GPU backend by creating the seam; it does not implement one).

## 20. Begin now

First read `composite`/`drawNode`, `leafDisplay`, the group-buffer path, the dirty/recomposite mechanism, and the view-canvas blit in `app/lib/paint.ts` (plus `maskDisplay`/`applyAdjustmentNode`/`effectsCache` if Specs 01/02/03 landed), the structural ops in `app/lib/layers.ts`, and the history module's `jumpTo`. Then implement in order: (1) `render-graph.ts` — `RenderNodeCache`, `keyOf`/`effectiveKey`/`childrenSig`/`belowSig`, dirty-rect accumulator, LRU policy; (2) `renderNode` wrapper around the existing per-kind ops + `renderCache`/`contentVersion` maps, behind `debug.disableRenderCache`; (3) `composite` made cache-backed with draw-time props applied at draw, intrinsic at render; (4) `bumpVersion` + precise propagation, wired into every engine mutator and `jumpTo` with bounded rects; (5) dirty-region repaint in `recomposite` + clean full-flatten export; (6) fold in Spec 02/03 caches; (7) byte-budget LRU eviction + invalidateAll on space/resize. Verify pixel-identity against the disabled-cache path, build to the §17 checklist, and write the code now.
