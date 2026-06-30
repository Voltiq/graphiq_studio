# Spec 05 — Clipping Masks

> **Claude Code task.** Implement clipping masks (clipping groups) in Graphiq Studio: one or more layers clipped to the alpha silhouette of the layer directly beneath them, non-destructively. This is a complete specification. Read it fully, read the real source files named in §3, then implement. **Coordinates with Spec 02:** that spec introduced a `clipped` flag on adjustment layers; this spec **promotes `clipped` to all layer kinds** and implements the full clip-group compositing. If Spec 02 has not landed yet, this spec is fully standalone (clipping pixel layers needs no adjustment system). Do not stop to ask for confirmation on anything already decided here.

---

## 1. Project context (Graphiq Studio)

Graphiq Studio is a client-side, browser-based raster photo editor (no server/upload). Stack: **Next.js 16 (App Router) · React 19 (React Compiler) · TypeScript · SCSS modules · lucide-react**. All imaging is hand-written against Canvas 2D / `ImageData`; no image libraries.

A single **`PaintEngine`** (`app/lib/paint.ts`) owns all pixels; React calls the curated **`EngineHandle`** and never touches pixels. Layers are an **immutable tree** (`app/lib/layers.ts`) edited only by pure functions. The compositor `composite(tree)` / `exportComposite(tree)` walks the tree **bottom-to-top** via `drawNode`: a leaf draws its display canvas with `globalAlpha = opacity/100` and `globalCompositeOperation = blendOp(blend)`; a group composites its children into a fresh buffer first, then draws that buffer with the group's own opacity/blend (isolated grouping). History is a linear pixel+structural stack. Documents are colour-space aware (sRGB / Display-P3).

**Clipping masks are a compositing feature, not a pixel feature.** A clipped layer shows only where the layer beneath it (its *base*) is opaque. Nothing about the clipped layer's pixels changes; the restriction happens at composite time. This is the cheapest of the non-destructive features and is independent of masks (Spec 01) and adjustment layers (Spec 02), though it shares one field with the latter.

## 2. Architecture constraints

- **Non-destructive.** Clipping never alters any layer's pixels. It is a per-layer boolean (`clipped`) interpreted by the compositor.
- **React declarative.** The `clipped` flag lives on the immutable tree, edited only via pure functions. No React component computes clipping.
- **Reuse the compositor; add a clip-group pass.** Do not fork `composite`. Add a clip-group assembly step inside the existing bottom-to-top walk.
- **One field, shared with Spec 02.** Promote `clipped` from `LayerAdjustment` (where Spec 02 put it) to `LayerCommon`, so leaves, groups, and adjustments all support it. If Spec 02 is present, **remove its duplicate `clipped` on `LayerAdjustment`** and let it inherit from `LayerCommon`; route Spec 02's clipped-adjustment behaviour through this spec's clip-group path (see §5.4).
- **No new dependencies.** Canvas 2D + `ImageData` only.

## 3. Existing systems Claude MUST reuse (read first)

- `app/lib/paint.ts` — `composite(tree)` / `exportComposite(tree)` / `drawNode`, the **group-buffer compositing path**, `leafDisplay(id)`, `blendOp(blend)`, buffer-borrowing, the dirty/recomposite mechanism. (If Spec 01 landed: `maskDisplay(id)` and the mask compositing step. If Spec 02 landed: `applyAdjustmentNode`, the running-accumulator compositor, and the clip-base-alpha helper — **this spec generalises that helper**.)
- `app/lib/layers.ts` — `LayerLeaf` / `LayerGroup` / (and `LayerAdjustment` if Spec 02 landed), the common props, and **every** pure function (find, update, remove, insert-relative, insert-into-group, wrap-in-group, ungroup, clone-subtree, replace, merge-down, flatten, visible-row order, multi-select). The clip-group resolver reads sibling order from here.
- The **history module** — structural entries (clip toggles are params-only, no pixels), combined steps, `jumpTo`, summary emission.
- The **`.aproj` (de)serializer** — add the optional `clipped` field per node.
- The **Layers panel**, **Menu bar**, and `EngineHandle`.

## 4. Design goals

1. Any leaf, group, or adjustment can be **clipped** to the layer directly beneath it within the same parent. A clipped layer is visible only where the base's composited alpha is non-zero.
2. A **clip group** = a base (a non-clipped layer) plus the contiguous run of `clipped` layers directly above it in the same parent's child list.
3. Clipped members **blend within the group** (their blend modes apply against the base + lower members of the group); the **whole group** then composites against everything below using the **base's** opacity + blend mode + mask.
4. **Re-editable instantly:** Layer ▸ Create/Release Clipping Mask (`Ctrl+Alt+G` toggles), and Alt-click the boundary between two Layers-panel rows toggles the upper layer's clip to the lower. The flag is positional — clip is always "to the layer directly below."
5. Correct interaction with **masks** (Spec 01), **adjustment layers** (Spec 02), **groups**, **opacity/blend**, and **hidden layers**.

## 5. Detailed implementation plan

### 5.1 The `clipped` field

Promote to the shared common properties:

```
LayerCommon { id, name, visible, opacity, blend, mask?, clipped: boolean /* default false */ }
```

`clipped: true` means "clip me to the layer directly below me in my parent's children." It is meaningful only relative to position; moving the layer changes what it clips to. Add pure functions: `setClipped(tree, id, clipped)`, and a resolver `clipGroupsOf(children)` that, given an ordered child list, returns the partition into clip groups: each group is `{ base, members: [...] }` where `base` is a non-clipped node and `members` are the `clipped` nodes immediately above it (in bottom→top order). Nodes with `clipped:true` that have **no valid base below** (e.g., a clipped bottom layer) are treated as **not clipped** (their `clipped` flag is inert; they composite normally) — never let content silently vanish.

### 5.2 Clip-group compositing (the crux)

In the compositor's per-child-list walk (both the document root and inside each group), process **clip groups as units** instead of individual nodes. For each clip group `{ base, members }` encountered bottom→top:

```
renderClipGroup(acc, base, members, scope):
  // 1. Render the base into a borrowed clip-group buffer (its own pixels only — no
  //    base opacity/blend yet; those apply when the whole group draws onto acc).
  cg = borrow buffer (canvas-sized or group-scoped)
  baseSrc = leafDisplay(base.id) (leaf) OR composite(base.children) (group)
  if base.mask?.enabled: baseSrc = baseSrc ⊗ maskDisplay(base.id)   // Spec 01
  cg.draw(baseSrc)

  // 2. Capture the clip silhouette = the base's alpha AFTER its own mask.
  clipAlpha = alphaOf(cg)            // snapshot now, before members grow the alpha

  // 3. Draw each visible member onto cg with its own blend + opacity + mask.
  for m in members (bottom→top), if m.visible:
     if m is adjustment (Spec 02):   applyAdjustmentNode(cg, m, scope)   // affects cg only
     else:
        mSrc = leafDisplay(m.id) (leaf) OR composite(m.children) (group)
        if m.mask?.enabled: mSrc = mSrc ⊗ maskDisplay(m.id)
        cg.gco = blendOp(m.blend); cg.globalAlpha = m.opacity/100
        cg.draw(mSrc)

  // 4. Clip the whole assembled group to the base silhouette.
  cg.gco = 'destination-in'; cg.draw(clipAlpha)

  // 5. Composite the clipped group onto the running accumulator using the BASE's
  //    opacity + blend mode.
  acc.gco = blendOp(base.blend); acc.globalAlpha = base.opacity/100
  acc.draw(cg)
  release cg
```

Notes:
- Members are **consumed** by their clip group and must be **skipped** in the normal node iteration.
- A clip group with **`base.visible === false`** renders nothing at all (hide the base ⇒ hide its clipped members — they have nothing to show on).
- Step 4's `destination-in` against `clipAlpha` is what restricts members to the base's shape, even if a member painted outside it.
- This generalises Spec 02's clip-base-alpha logic: a clipped **adjustment** is just a member processed against `cg` (which is already base-shaped), so it automatically affects only the base+members within the base silhouette. **Delete Spec 02's separate clip-base modulation** and route clipped adjustments through here.

### 5.3 Base and members can be leaves or groups

The base's silhouette is its **rendered alpha** — a leaf's display alpha (after its mask) or a group's merged-buffer alpha. A group can be a clip base (members clip to the merged group shape) and a group can be a clipped member (its merged buffer is drawn as a member). Adjustments can be members (§5.2) but **not bases** (an adjustment has no pixels/alpha of its own; if a `clipped:false` adjustment sits where a base would be, it is not a valid base — skip it as a base and let the next non-adjustment pixel layer below anchor the group, matching Spec 02's "walk down to nearest pixel base").

### 5.4 Reconciling with Spec 02 (if present)

- Move `clipped` to `LayerCommon`; remove it from `LayerAdjustment`.
- Replace Spec 02's `applyAdjustmentNode` clip branch (the "multiply modMask by clip-base alpha" path) with membership in a clip group: when the compositor assembles clip groups, a clipped adjustment becomes a member and is applied to `cg`. The visual result is identical for the common case (clipped adjustment directly above a base) and strictly more correct for stacks.
- Spec 02's non-clipped adjustments are unchanged (they still process the running `acc` of their parent's lower siblings).

### 5.5 UI

- **Menu:** Layer ▸ Create Clipping Mask / Release Clipping Mask, toggled by `Ctrl+Alt+G` (label reflects current state of the active layer).
- **Layers panel:** Alt-clicking the boundary between two rows toggles the upper row's `clipped`. Render clipped rows **indented** with a down-right elbow glyph (↳) pointing at the base; render the **base name underlined** (the Photoshop convention) so a clip group reads as a unit. A clipped row whose flag is inert (no valid base) renders normally (not indented).
- **Context menu:** right-click a layer → Create/Release Clipping Mask.

## 6. Directory & file changes

```
app/lib/layers.ts          (edit)  promote `clipped` to LayerCommon (default false);
                                    setClipped(); clipGroupsOf(children) resolver;
                                    ensure clone-subtree/merge/flatten carry `clipped`
app/lib/paint.ts           (edit)  clip-group assembly in the child-list walk
                                    (renderClipGroup); skip consumed members; integrate
                                    with mask (01) + adjustment (02) paths; generalise
                                    clip-base alpha
app/lib/history.ts         (edit)  structural clip-toggle entry (flag flip, no pixels)
app/lib/project.ts         (edit)  serialize/deserialize `clipped`; tolerate absence
   (or wherever .aproj lives)
app/lib/engine-handle.ts   (edit)  expose setClipped / toggleClippingMask
app/components/LayersPanel/(edit)  indent + elbow glyph + underlined base; Alt-click
                                    boundary; context-menu entries
app/components/MenuBar/    (edit)  Layer ▸ Create/Release Clipping Mask + shortcut
```

No new npm packages.

## 7. TypeScript interfaces

```ts
// layers.ts — promoted onto the shared common props (was on LayerAdjustment in Spec 02).
export interface LayerCommon {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;          // 0–100
  blend: BlendMode;
  mask?: MaskMeta;          // Spec 01 (optional)
  clipped: boolean;         // NEW here for leaf/group; promoted for adjustment
}

// Resolver output used by the compositor.
export interface ClipGroup {
  base: LayerNode;          // a non-clipped, pixel-bearing leaf or group
  members: LayerNode[];     // contiguous clipped nodes directly above base (bottom→top)
}
export function clipGroupsOf(children: LayerNode[]): Array<ClipGroup | { base: LayerNode; members: [] }>;
export function setClipped(tree: LayerNode, id: string, clipped: boolean): LayerNode;

// engine-handle.ts
export interface ClippingHandle {
  setClipped(layerId: string, clipped: boolean): void;
  toggleClippingMask(layerId: string): void;   // flips clipped of the active layer
}

// history.ts — cheap structural flag flip (no pixels).
export interface ClipToggleEntry {
  kind: 'structural';
  side: { undo(): void; redo(): void };   // restore previous/next `clipped` on the node
}
```

## 8. Class responsibilities

- **`layers.ts` pure functions:** own the `clipped` field and the `clipGroupsOf` partitioner; carry `clipped` through clone/merge/flatten; never mutate.
- **`PaintEngine`:** assemble and render clip groups inside the existing bottom-to-top walk; borrow/release the clip-group buffer; integrate masks (01) and adjustment members (02); generalise the clip-base alpha. Owns no new persistent state — clipping is recomputed from flags + positions each composite.
- **History module:** structural clip-toggle entries.
- **React panels:** indent/elbow/underline rendering, Alt-click boundary, menu wiring. No compositing.

## 9. Data-flow diagram

```
Toggle clip (menu / Ctrl+Alt+G / Alt-click boundary)
        │
        ▼
EngineHandle.toggleClippingMask(id) ──► layers.ts setClipped (pure) ──► new tree
        │                                          │
        │                                  History ← ClipToggleEntry { clipped old→new }
        │                                          │  request recomposite
        ▼                                          ▼
composite(children):
   groups = clipGroupsOf(children)
   for {base, members} in groups bottom→top:
       cg = base (⊗ baseMask)         ; clipAlpha = alpha(cg)
       for m in members: draw m (blend+opacity+mask) onto cg   // adj members → applyAdjustmentNode(cg)
       cg ⊗= clipAlpha (destination-in)
       draw cg onto acc with base.opacity + base.blend (⊗ baseMask already in cg)
        │
        ▼
   on-screen view canvas (document colour space)
```

## 10. Rendering pipeline (where clipping slots in)

```
composite(childList):
  acc ← blank target (or parent group buffer)
  for unit in clipGroupsOf(childList) bottom→top:
     if unit has members:  renderClipGroup(acc, unit.base, unit.members)   // §5.2
     else:                 drawNode(unit.base) onto acc                     // unchanged path
  return acc
exportComposite: identical; clip groups clip to base alpha; result clipped to canvas on flatten.
```

A clip group costs **one borrowed buffer**, composited once. No per-pixel JS loop is added — `destination-in` does the silhouette clip on the GPU.

## 11. State-management rules

- `clipped` is tree state, edited via pure functions. Clip-group membership is **derived** from flags + sibling order at composite time; never stored.
- Reordering layers (existing insert/remove ops) silently re-forms clip groups — the compositor reflects the new relationships next recomposite. No special reordering code beyond reading positions.
- Wrapping clipped layers into a group, or ungrouping: clip relationships are per-parent; after the structural op, re-resolve from the new parent's child order. A clipped layer that becomes the bottom child of a new group becomes inert (no base below) until reordered — acceptable and matches the "no base ⇒ inert" rule.
- `setColorSpace`, resize, crop: clipping carries no pixels; nothing to convert. (If Spec 06 caching is present, clip-group buffers are cache-managed there.)

## 12. History integration

- **Clip toggle** (and the Alt-click boundary toggle) → **structural** `ClipToggleEntry` flipping `clipped` (no pixels — free, like all non-destructive edits).
- **Create/Release Clipping Mask** on a multi-selection → one combined structural step toggling all affected nodes.
- Reorders that change clip relationships are the **existing** reorder structural entries; no new history needed (the flag travels with the node).
- Emit summaries ("Create Clipping Mask", "Release Clipping Mask").

## 13. Serialization changes (`.aproj`)

- Add `clipped: boolean` to every serialized node (or omit when false and default to false on load — pick one and be consistent). Bump `version` (or rely on Spec 02's bump if shipped together).
- Loader: read `clipped`; absent ⇒ false. **Older files (no `clipped`) open unchanged**, all layers un-clipped.
- Export/flatten already composites through `exportComposite`, which now honours clip groups — no export-format change.

## 14. Performance requirements

- A clip group adds one borrowed buffer and one extra composite pass over the group's region — **O(region) per clip group**, no per-pixel JS. Borrow/reuse buffers; never allocate per frame.
- Toggling `clipped` is a flag flip + one recomposite; it must be instant on a 4000×3000 document.
- Deeply nested or many small clip groups must not allocate one full-canvas buffer each — size the clip-group buffer to the group's bounds where practical, or reuse a single canvas-sized scratch sequentially.
- If Spec 06 (render graph) is present, a clip group's assembled buffer is a cacheable sub-result keyed on the versions of its base + members.

## 15. Memory requirements

- Clipping introduces **no persistent buffers** — only a transient clip-group scratch reused from the buffer pool during compositing. The `clipped` flag is one boolean per node.
- Free the clip-group scratch back to the pool after each group; never leak per composite.

## 16. Edge cases (handle all)

1. **Clipped bottom layer** (no base below) → flag inert; layer composites normally; not indented in the panel.
2. **Base hidden** (`visible:false`) → entire clip group renders nothing (members have no base to show on).
3. **Member hidden** → that member is skipped; the rest of the group renders.
4. **Base has a mask** (Spec 01) → clip silhouette = base display ⊗ base mask alpha (members clip to the masked shape, and a base mask also hides its clipped members).
5. **Member has a mask** → the member's mask multiplies the member within the group before the group is clipped to the base.
6. **Clipped adjustment member** (Spec 02) → processes the clip-group buffer (already base-shaped); its opacity/mask further modulate it; replaces Spec 02's standalone clip-base path.
7. **Group as base** → members clip to the merged group alpha. **Group as member** → its merged buffer is drawn as a member.
8. **Run of several clipped members** → all clip to the same single base directly below the run; members blend in order within the group.
9. **Adjustment sitting where a base would be** (a non-clipped adjustment with clipped layers above it) → an adjustment is not a valid base (no alpha); the clipped layers above clip to the nearest pixel-bearing base below the adjustment (walk down), or are inert if none.
10. **Reorder** that moves a base out from under its members → members re-resolve to their new base (or go inert); compositor reflects immediately.
11. **Merge-down / flatten** within or across a clip group → bake with clipping applied: merging a clipped member into its base writes the clipped contribution into the base pixels; flatten composites the whole clipped result. Duplicate copies `clipped`.
12. **Opacity/blend** → member opacity/blend act inside the group; base opacity/blend act on the whole group against layers below (verify a clipped Multiply member multiplies only within the base shape, and a base at 50% fades the entire clip group).
13. **P3 document** → unaffected; clipping is alpha-only.

## 17. Acceptance criteria

- [ ] Any leaf, group, or adjustment can be clipped/released via the menu (`Ctrl+Alt+G`), Alt-click on the row boundary, and the context menu.
- [ ] A clipped layer shows only within the base's masked alpha silhouette; members blend within the group; the base's opacity/blend/mask govern the whole group against layers below.
- [ ] Runs of multiple clipped members, group bases, group members, and clipped adjustment members (Spec 02) all composite correctly.
- [ ] Hidden base hides the group; hidden member is skipped; clipped bottom layer is inert (composites normally).
- [ ] Clip toggles are single, cheap, undoable structural steps with no pixel data; reorders re-form clip groups correctly.
- [ ] `.aproj` round-trips `clipped`; older files open unchanged; export/flatten bakes clipping correctly.
- [ ] Toggling clip on a 4000×3000 document is instant; no per-frame buffer allocation; no per-pixel JS in the clip step.
- [ ] If Spec 02 is present, its standalone clip-base modulation is removed and clipped adjustments route through the clip-group path with identical or improved results.
- [ ] Layers panel shows clip groups as indented members under an underlined base.

## 18. Coding standards

- Match repo conventions exactly (style, naming, SCSS modules, lucide-react icons).
- TypeScript **strict**; exhaustive `switch` on `LayerNode.kind`; explicit return types on the resolver and engine methods.
- Pure functions return new trees; the compositor recomputes clip groups each composite (no cached membership in the tree).
- Reuse `leafDisplay`, `maskDisplay` (01), `applyAdjustmentNode` (02), `blendOp`, and buffer-borrowing — never duplicate.
- Keep `renderClipGroup` small and readable; isolate clip-group assembly from the normal `drawNode` path.

## 19. Claude must NEVER

- **Never** alter any layer's pixels to implement clipping — it is composite-time only.
- **Never** let a clipped member draw outside the base silhouette (the `destination-in` clip is mandatory).
- **Never** keep two copies of `clipped` (promote it to `LayerCommon`; remove Spec 02's duplicate).
- **Never** leave clipped content with no base silently invisible — make the flag inert instead.
- **Never** mutate the tree in place; toggle `clipped` via `layers.ts` pure functions.
- **Never** allocate a full-canvas buffer per clip group without reusing the pool.
- **Never** add a dependency or use WebGL/WebGPU.
- **Never** break loading of existing `.aproj` files or the Spec 02 adjustment path.

## 20. Begin now

First read `composite`/`drawNode` and the group-buffer path in `app/lib/paint.ts` (and `maskDisplay`/`applyAdjustmentNode` if Specs 01/02 landed), the `layers.ts` pure functions + union, the history module, and the `.aproj` serializer. Then implement in order: (1) promote `clipped` to `LayerCommon` + `setClipped` + `clipGroupsOf` resolver (and remove Spec 02's duplicate field); (2) `renderClipGroup` + clip-group assembly in the child-list walk, consuming members and integrating mask/adjustment paths; (3) generalise/replace Spec 02's clip-base modulation; (4) `EngineHandle` toggle + structural clip-toggle history; (5) `.aproj` serialization + version bump; (6) Layers-panel indent/elbow/underline + Alt-click boundary + menu/context entries. Build to the §17 checklist and write the code now.
