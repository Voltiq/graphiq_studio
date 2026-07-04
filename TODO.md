# Graphiq Studio — Roadmap / TODO

Everything that would take the app from "feature-complete editor" (see [FEATURES.md](FEATURES.md)) to a great, professional-grade photo tool. Grouped by area; roughly ordered **P1 → P3** inside each group (P1 = finish/polish what exists, P2 = expected pro features, P3 = platform leaps).

Legend: `[ ]` open · `[~]` partially exists (noted).

---

## 1. Known gaps & unfinished edges (P1 — finish what's started)

- [x] **Linked-mask move** — done: a whole-layer Move now shifts a linked mask with the pixels, folded into the same one-step undo.
- [x] **Blur / Dodge-Burn on masks** — done: both brushes target the mask when it's the active surface (mask-surface history entries, live alpha rederive).
- [ ] **Smart-filter stack mask** — one grayscale mask confining a layer's whole filter stack. *Assessed 2026-07: this is a mini-spec, not polish — it needs a second mask surface per layer (engine maps, `ActiveSurface` kind, history surface, serializer, panel thumbnail + paint routing). Do it as its own task.*
- [ ] **Per-filter drag-reorder** in the Smart Filters dialog (Up/Down buttons exist; drag would match the Layers panel).
- [ ] **On-canvas anchor drag for smart blurs** (zoom/spin/tilt-shift smart filters use X/Y sliders; the destructive Blur Gallery already has preview-dragging — share it).
- [ ] **Curves targeted adjustment** — click-drag on the image to move the curve point at the sampled tone (the eyedropper pick-mode plumbing from Levels can be reused).
- [ ] **Gradient stroke layer-effect UI** — the engine renders gradient-filled strokes; the Layer Style dialog only exposes solid colour.
- [ ] **Clipping edge case (§16.9)** — a clipped layer directly above a non-clipped adjustment is inert; optionally walk down to the pixel base beneath the adjustment.
- [ ] **Channels panel: mask channel** — show the active layer's mask as a selectable channel; Alt-click mask thumbnail to view the mask on canvas.
- [ ] **Options-bar "editing mask" pill** — a visible mode indicator while the paint target is a mask.
- [ ] **Liquify** — the one remaining Effects stub. A warp-mesh tool (forward warp, pucker, bloat, twirl, reconstruct; brush size/pressure; mesh save/load). Big but self-contained.
- [~] **Settings/Help stubs** — **Keyboard Shortcuts is done** (searchable window generated from the menu/tool registries + curated canvas gestures; opened from Settings and Help). Still stubs: Performance, Scratch Disks, Getting Started, Documentation, About (see §10/§12).

## 2. Tools

**P1**
- [ ] **Polygonal lasso** (click-point lasso; the freehand lasso exists) and **magnetic lasso** (edge-snapping).
- [ ] **Smudge** and **Sponge** (saturate/desaturate) brushes — the coverage-mask session model from Blur/Dodge fits directly.
- [ ] **History brush** — paint from a chosen history state's snapshot.
- [ ] **Red-eye** tool (small, high-value; luminance/redness heuristic in a brush click).
- [ ] **Measure/ruler tool** — distance + angle readout in the status bar; feeds Straighten.
- [ ] **Perspective crop** — crop with a quad, resampling to a rectangle.

**P2**
- [x] **Spot heal brush** — done: paint a blob (`J`), it heals on release (auto source-patch search + diffusion membrane tone-match in `heal.ts`). Follow-ups: a sourced healing-brush variant (Alt-pick source like Clone) and a Patch tool (drag a selection to its source).
- [x] **Content-aware fill** — done: Edit ▸ Content-Aware Fill (`Shift+F5`) synthesizes the selection from feather-blended source blocks + one membrane pass. Follow-up: PatchMatch-style iteration for very large/structured fills.
- [ ] **Quick Selection / Object-ish select** — brush that grows a selection along edges (graph-cut/flood with edge cost; no ML needed for a solid v1).
- [ ] **Mixer brush** (wet paint blending) with brush texture/dual-tip options.
- [ ] **Custom shape tool** — user shape library (SVG path import → shape presets).
- [ ] **Direct-select / path-edit tool** as a first-class tool (pen paths exist; editing after commit is limited).
- [ ] **Frame/placeholder tool** and **Artboards** (multiple canvases per document).

**Tool options (P1 sprinkles)**
- [ ] Brush: **pressure dynamics** (size/opacity/flow from pointer pressure — `PointerEvent.pressure` is already available), scattering, angle/roundness, dual brush, texture; brush preset picker with previews; `[`/`]` size shortcuts + on-canvas HUD (Alt-right-drag size/hardness).
- [ ] Eraser: "erase to history" option.
- [ ] Move: auto-select layer/group toggle, alignment buttons (align/distribute selected layers), transform handles always-on option.
- [ ] Text: full character panel options in the bar (tracking, leading, baseline, all-caps), font search with previews, recent fonts.
- [ ] Gradient: dither option, reverse in options bar (exists in editor), noise gradients.
- [ ] Crop: delete-vs-hide cropped pixels, content-aware fill for straighten gaps.

## 3. Selections & masking

- [ ] **Quick Mask mode** (paint a selection as a red overlay; `Q` toggle).
- [ ] **Save / load selections** (named alpha channels in the Channels panel; serialize in `.aproj`).
- [ ] **Refine edge** dialog — smooth/feather/contrast/shift-edge with preview on white/black/overlay; decontaminate colours.
- [ ] **Border / Smooth / Expand / Contract** under Select ▸ Modify (Grow/Feather exist).
- [ ] **Transform selection by numbers** (x/y/w/h/angle fields in the options bar).
- [ ] **Vector masks** (a path as a mask alongside the raster mask).
- [ ] Feather **preview** (marching ants show the soft edge as a second faint outline).

## 4. Layers

- [ ] **Lock flags** — transparency, pixels, position, all (checkboxes in the panel header like PS).
- [ ] **Colour labels** + **layer search/filter** row (by name/kind/colour) — panel scales badly past ~40 layers without it.
- [ ] **Linked layers** (move/transform together without grouping).
- [ ] **Fill layers**: Solid Colour / Gradient / Pattern as re-editable layer kinds (pairs perfectly with masks + clipping).
- [ ] **More adjustment types**: Hue/Saturation with per-range targeting, Selective Color, Gradient Map, Channel Mixer, Color Lookup (**.cube LUT import**), Invert/Equalize as nodes.
- [ ] **Blend-If sliders** (this-layer/underlying with split handles) and **knockout**.
- [ ] **Global light** for effects (shared angle across shadows/bevels).
- [ ] **Layer style presets** — save/import/export styles (mirror the gradient-preset system; `.astyle` files).
- [ ] **Layer comps** (named visibility/position/style states).
- [ ] **Isolate mode** (temporarily solo selected layers).
- [ ] Merge visible / Stamp visible (Ctrl+Alt+Shift+E).

## 5. Effects & filters

- [ ] **High Pass**, **Median**, **Dust & Scratches**, **Reduce Noise** (edge-preserving already exists as Surface — expose a denoise-tuned variant).
- [ ] **Lens corrections**: vignette (+/-), chromatic-aberration fix, geometric distortion (barrel/pincushion).
- [ ] **Photographic**: Dehaze, Clarity/Texture (local contrast — reuse Unsharp at large radius), Grain with size/roughness.
- [ ] **Stylistic**: Oil Paint, Halftone/Color Halftone, Crystallize (Voronoi mosaic), Glitch/Scanlines, Drop-shadow-on-canvas… as smart-filter types (the Spec 07 dispatch makes each a self-contained pure function).
- [ ] **Filter previews in the picker** (thumbnail per filter type in the Smart Filters "Add" list).
- [ ] **Warp / Perspective warp** transforms (mesh-based; shares math with Liquify).

## 6. Text & vector

- [ ] **Rich text runs** (mixed fonts/sizes/colours inside one block), paragraph alignment/justification, letter/line spacing UI.
- [ ] **OpenType features** (ligatures, alternates) via `FontFace` + `canvas` where supported; variable-font axes sliders.
- [ ] **Text on a path** and **warp text** presets (arc, flag, bulge).
- [ ] **Paths panel** (store/reuse pen paths; path → selection / stroke / fill; boolean combine paths).
- [ ] **SVG import** (as vector shape layers) and **SVG export** of vector/text layers.

## 7. Colour management & depth

- [ ] **ICC profile import** + assign-vs-convert dialogs (currently sRGB/Display-P3 working spaces only).
- [ ] **Soft-proofing** (simulate a target profile + gamut warning overlay).
- [ ] **More working spaces** where Canvas permits (Adobe RGB via manual matrix conversion in the adjustment pipeline; document the browser limits honestly).
- [ ] **16-bit/channel pipeline** (P3): `Float16/Uint16` buffers for the adjustment/filter path with 8-bit compositing fallback — the render-graph seam (Spec 06) is where a high-bit backend plugs in. Tone/curve LUTs generalize to 65k entries.
- [ ] **32-bit float / HDR** (P3): merge-to-HDR, exposure slider, PQ/HLG-aware export on capable displays.

## 8. Engine & performance

- [~] **Web Worker offload** — **done for the Blur Gallery** (the heaviest interactive path): a dedicated module worker caches the session's originals once, per-tick param messages, sequence/session-guarded replies, sync fallback (`app/workers/blurfx.worker.ts` + `previewBlurFxAsync`). Remaining: smart-filter recompute inside `renderNode` (needs an async compositor step — pairs with the dirty-region item below) and one-shot ops (heal/content-aware fill).
- [ ] **WebGL/WebGPU renderer** (P3) behind the render-graph seam: blend modes, effects and LUTs as shaders; Canvas2D stays as the always-correct fallback (A/B via `__gqRenderCache`-style toggle).
- [ ] **Dirty-region recompute inside nodes** (Spec 06 deliberately stopped at full-node recompute; region-scoped adjustment read-backs are the next win).
- [ ] **Tiled compositing** for very large documents (≥ 8k) so caches/evictions work per-tile.
- [ ] **Progressive preview** — half-resolution first pass for heavy filter drags, full-res on settle.
- [ ] **Cache budget in Preferences** (the 256 MB LRU budget is hard-coded; expose under Settings ▸ Performance with live stats from `renderCacheStats`).
- [ ] **Autosave / crash recovery** — periodic `.aproj` snapshot to IndexedDB + "restore last session" on boot.
- [ ] Perf HUD (dev): composite ms, cache hit rate, dirty rect overlay.

## 9. File formats & import/export

- [ ] **RAW support** (P3) — true RAW needs a decoder: either a hand-written **DNG (uncompressed/lossless-JPEG) subset** to stay dependency-free, or an explicit decision to vendor a wasm decoder (libraw). Then: demosaic, WB/exposure "develop" step feeding a 16-bit layer.
- [ ] **PSD**: import subset (layers, groups, masks, opacity/blend, text as raster) and flattened+layers export — the single biggest interchange ask.
- [ ] **TIFF** import/export (8/16-bit), **HEIF** import where the browser decodes it.
- [ ] **PDF export** (flattened, with DPI/paper size) and multi-page print dialog upgrades (margins, scale, profile).
- [ ] **Animated**: GIF/APNG/WebP import as layer stacks; timeline-less "export frames" first.
- [ ] **Metadata round-trip** — preserve/edit EXIF/XMP on export (currently read-only panel); copyright/author fields in Preferences.
- [ ] **Export presets** + **batch export** (multiple sizes/formats at once, filename templates) + estimated file size preview in Export As.

## 10. History

- [ ] **Snapshots** (pin a state; source for the History brush).
- [ ] **Non-linear option** (keep redo branch on new edits, PS-style toggle).
- [ ] **Undo limit setting** backed by a byte budget (large pixel patches accounted).
- [ ] Persist minimal history across reload (last N structural labels already saved in `.aproj`; consider replayable param-only steps).

## 11. UI / UX

- [ ] **Command palette** (`Ctrl+K` when not in Preferences… pick another binding): fuzzy-search every menu action/tool/panel — cheap to build over `menus.ts` actions.
- [ ] **Keyboard Shortcuts window** (wire the Settings stub): searchable cheat-sheet generated from one shortcut registry; later, **remappable** bindings persisted to prefs. (A single source of truth for shortcuts would also de-duplicate `menus.ts` labels + the keydown handler.)
- [ ] **Dockable/collapsible panel system v2** — drag panels between docks, tabbed panel groups, floating panels, saved **workspaces** (Reset Workspace exists).
- [ ] **Guides**: draggable from rulers, snap-to-guides, lock guides, smart guides (align hints between layers while moving).
- [ ] **Before/after compare** (split view or hold-\\ to peek at the pre-adjustment composite — the render graph can serve both cheaply).
- [ ] **Navigator**: zoom slider + click-to-zoom presets; **bird's-eye** (hold `H` + drag like PS).
- [ ] **Info panel** (live cursor readout: RGBA/HSB under pointer, selection W×H, doc coords).
- [ ] **Properties panel** (contextual: shows active layer's opacity/blend/fx/filters/adjustment controls without opening dialogs).
- [ ] **Touch & pen**: pinch zoom / two-finger pan on the canvas (pointer events are in place), pen pressure (see brush dynamics), palm rejection toggle.
- [ ] **UI scale setting** (compact/comfortable) and **localization** scaffolding (strings are currently inline).
- [ ] Colourblind-safe accent option + a **high-contrast** theme variant; full keyboard-navigation audit (focus rings exist — ensure every panel/dialog is traversable).
- [ ] Onboarding: "Getting Started" overlay tour + sample document (wires two Help stubs).

## 12. Settings (Preferences additions)

- [ ] **Performance tab**: render-cache budget + stats, undo limit, worker toggle.
- [ ] **Cursors tab**: precise vs brush-ring, crosshair-in-brush option, ring colour.
- [ ] **Units & rulers**: px/in/cm, default DPI for new docs and print.
- [ ] **Transparency grid**: size/colours of the checkerboard.
- [ ] **Guides & grid**: colours, spacing/subdivisions, snap distances.
- [ ] **Files tab**: autosave interval, default export format/quality, recents length, "share saved gradients" (exists) + future shared libraries.
- [ ] **Reset all preferences** + settings import/export (JSON).

## 13. Panels (new)

- [ ] **Info** (see §11), **Properties** (see §11), **Paths** (see §6).
- [ ] **Swatches v2**: groups/folders, import/export `.aco`/`.ase`/plain JSON, document palette extraction ("colours from image").
- [ ] **Brushes panel** (preset management with previews, import ABR-subset?).
- [ ] **Actions panel** (see §14).
- [ ] **Histogram panel upgrades**: luminosity mode, clipping warnings, per-selection histogram.

## 14. Automation

- [ ] **Actions / macro recorder** — record menu ops + tool params (most ops already flow through `handleMenuAction` and typed engine calls; a command-log layer makes this feasible), play back, assign F-keys.
- [ ] **Batch processing** — run an action/export preset over dropped files.
- [ ] **Scripting hook** (dev): expose a safe subset of `EngineHandle`/layer ops on `window` for power users; document it.

## 15. Quality & infrastructure

- [ ] **Unit tests for the pure libs** (`tone.ts`, `filters.ts`, `gradient.ts`, `render-graph.ts`, `layers.ts` tree ops, `view.ts` invertRects) — they're dependency-free and crying out for Vitest.
- [ ] **Pixel-identity harness**: automated A/B of cache-on vs `disableRenderCache` composites over fixture documents (the Spec 06 oracle, CI-ified).
- [ ] **Golden-image tests** for filters/effects (hash composite outputs of fixture docs).
- [ ] **Perf benchmarks** (composite time vs layer count; filter throughput) tracked over time.
- [ ] **E2E smoke** (Playwright): boot, paint, undo, save/open, export.
- [ ] Error boundary + user-facing crash report dialog with "save recovery copy".

---

### Suggested next three (highest value ÷ effort)

Round 1 — all done 2026-07: ~~§1 polish sweep~~ · ~~healing brush + content-aware fill~~ · ~~worker offload (Blur Gallery)~~.

1. ~~**Autosave & crash recovery**~~ — done 2026-07: IndexedDB snapshots on a Preferences interval (default 2 min, only when history moved), a `pagehide` heartbeat that detects unclean exits, a Restore/Discard prompt on boot after a crash, and a real save-state indicator in the status bar. Follow-up idea: multi-document snapshots (currently the active document).
2. ~~**Smart-filter stack mask**~~ (§1) — done 2026-07: one grayscale filter mask per layer/group confining the whole stack (white = filtered, black = original, premultiplied blend between). Lives in the engine's existing mask maps under `fm:<id>`, so painting (brush/pencil/eraser/fill/gradient/blur/dodge), history's mask surface, undo/redo and restore all reuse the layer-mask machinery. Managed from the Smart Filters dialog (Add / From Selection / Enable / Paint / Delete) + a dashed flask chip in the Layers panel (click = paint target, Shift-click = enable/disable). Serialized as `filterMaskImage` in `.gproj` v8 (older files open unchanged); duplicated, transformed (resize/rotate/flip/crop) and consumed by "Apply (Bake)" correctly. Not included: unlinked filter-mask move (it always tracks the layer).
3. **Layer lock flags + panel search/filter** (§4) — transparency/pixels/position/all locks enforced in the engine's paint guards, plus a filter row (name/kind) in the Layers panel; the everyday-ergonomics gap that shows up on any document past ~40 layers. (Close runner-up if you'd rather have something flashier: the **command palette**, §11 — cheap to build over `menus.ts`.)
