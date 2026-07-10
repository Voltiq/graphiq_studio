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
- [x] **Polygonal lasso + magnetic lasso** — done 2026-07: the Lasso tool now has a **Mode** option (Freehand / Polygonal / Magnetic; `Shift+L` cycles, persisted in tool prefs, segmented control in the options bar with distinct icons). **Polygonal** is click-to-drop-vertices with a live rubber-band edge to the cursor and vertex handles (accented start dot); closes on **double-click**, a click back on the start point, or **Enter**; **Backspace** removes the last vertex, **Esc** cancels — and switching tool/mode cancels an open polygon. **Magnetic** builds a capped-resolution **Sobel edge map** of the flattened composite at stroke start and snaps each dragged point to the strongest nearby edge (magnitude-vs-distance score, weak-edge fallback to the raw cursor, continuity clamp against jumps to a different contour). Both reuse the existing `engine.lassoSelect` rasterizer + `combineSelection` (Ctrl-add / Alt-subtract), so add/subtract, marching-ant tracing and the whole selection pipeline work unchanged. Follow-up ideas: adjustable magnetic width/frequency in the options bar, and anchor-point insertion for magnetic (auto-drop periodic anchors).
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

- [x] **ICC profile import + assign-vs-convert** — done 2026-07: a dependency-free ICC reader (`app/lib/icc.ts`) sniffs embedded profiles from the raw file bytes — PNG `iCCP` (zlib via `DecompressionStream`), JPEG `APP2 ICC_PROFILE` (segments re-assembled by sequence), WebP RIFF `ICCP` — and parses the profile's display name from the `desc` (ASCII) or `mluc` (UTF-16BE, v4) tag, classifying it against the working space. When an import carries a profile that ISN'T the working space, the Import dialog shows a **Color profile** section naming it, with the classic choice: **Convert to working space** (recommended — the browser's colour-managed decode, keeps appearance) or **Assign working space** (re-decode with `colorSpaceConversion: "none"` — keeps the raw numbers, ignores the tag). Verified with synthetic PNG/JPEG containers for both tag types. Honest limits noted: AVIF/HEIF/TIFF boxes aren't sniffed (their decodes still colour-manage as before), clipboard pastes stay convert-implicit (the clipboard hands over decoded bitmaps), and the profile bytes are kept on the item for a future export round-trip but not yet re-embedded on export.
- [x] **Soft-proofing** — done 2026-07: **Proof colors** (`Ctrl+Alt+Y`) simulates a target space on the VIEW only, and **Gamut warning** (`Ctrl+Alt+Shift+Y`) paints out-of-gamut pixels Photoshop-style mid-grey; both in the View menu (checkable) and the Color Management dialog, where the target (sRGB / Display P3 / Adobe RGB, persisted) is chosen. The transform (`proofTransformInPlace` in colorspace.ts) decodes the canvas bytes to linear, converts through the target's primaries (P3 matrices added; D65 throughout), flags out-of-gamut against a half-byte-step epsilon, clips in target-linear (that clip IS the simulation) and converts back for display — in-gamut pixels are byte-identical, and identity combinations (sRGB canvas → any larger target) skip entirely, which the dialog explains. Hooked at the engine's view blit, reusing the dirty-rect bound so painting under a proof stays region-priced; exports and `exportComposite` never proof. Verified numerically: P3 grey/muted tones pass through byte-exact, saturated P3 red warns grey, and its simulation clips to (234, 51, 35) — exactly sRGB red in P3 coordinates. Honest limits: targets are the three standard spaces (no arbitrary ICC rendering intents — no CMM), and proofing operates on the CANVAS space (so under the emulated Adobe RGB working space it proofs the sRGB canvas).
- [x] **More working spaces** — done 2026-07: **Adobe RGB (1998) as an emulated working space** (`app/lib/colorspace.ts`), exactly as scoped — manual matrix conversion in the adjustment pipeline, limits documented in the Color Management dialog. Storage/display stay on an sRGB canvas (browsers can't display or export an Adobe RGB canvas); the adjustment pipeline — slider adjustments, adjustment layers, Curves/Levels, including the region-scoped partial path — converts sRGB→Adobe (exact D65 matrices computed at load from the published primaries; Adobe gamma 563/256; per-byte decode LUTs, `Math.pow` encode, single-rounding via `Uint8ClampedArray`), runs the math in Adobe primaries, and converts back. Verified: neutrals and in-gamut colours roundtrip byte-exact, sRGB red → Adobe (219,0,0) matches the published reference; extreme saturated colours quantize ±≤5 per pass (inherent to any 8-bit space conversion — the 16-bit pipeline item is the real fix). Toggling to/from Adobe RGB is lossless (no pixel conversion; only the math redirects; adjustment products recompute via the epoch bump). The GPU tone stage defers to CPU under Adobe RGB (its LUT would apply in canvas-space bytes). Filters/effects/compositing remain in the canvas space — documented. Native spaces still convert pixels through the browser's CMS on switch, unchanged.
- [~] **16-bit/channel pipeline** (P3) — the adjustment path is done 2026-07, exactly as scoped: **Uint16 buffers for the adjustment path with the 8-bit compositing fallback**, and **tone/curve LUTs generalized to 65 536 entries** (`buildLevelsLUTs16`/`buildCurvesLUTs16` sample the SAME continuous evaluators — Fritsch–Carlson curves, closed-form levels — composed continuously, so no intermediate 8-bit rounding; byte v widens as v·257). The seam is the engine's `applyColorMath` dispatcher (all four adjustment sites: destructive sliders/tone sessions, adjustment layers, and the region-scoped partial path): native spaces keep the 8-bit path (a single pass already quantizes once); the **emulated Adobe RGB space runs fully at 16 bits** — canvas bytes decode straight to Adobe RGBA16 (`srgbBytesToAdobe16`), slider math runs in `applyAdjustments16` (kept-in-sync twin incl. the 16-bit noise/sharpen spatial tail) or the 65k LUTs, and ONE final quantization writes sRGB bytes (`adobe16ToSrgbBytes`). **Verified numerically**: the space roundtrip and identity Levels/Curves through the whole 16-bit pipeline are byte-exact over 405k samples (the old byte-intermediate path erred ±5 on saturated colours), and the 65k LUTs agree with the 8-bit tables at every byte position. Remaining (still P3): 16-bit layer STORAGE and compositing (canvas is 8-bit — the true fallback limit), the filter path (spatial kernels), and Float16/HDR sources.
- [ ] **32-bit float / HDR** (P3): merge-to-HDR, exposure slider, PQ/HLG-aware export on capable displays.

## 8. Engine & performance

- [x] **Web Worker offload** — done 2026-07 across all three heavy paths:
  - **Blur Gallery**: dedicated module worker caches the session's originals once, per-tick param messages, sequence/session-guarded replies, sync fallback (`app/workers/blurfx.worker.ts` + `previewBlurFxAsync`).
  - **Heal / content-aware fill** (`app/workers/heal.worker.ts`): the membrane solve runs off-thread; replies are validated against the document state captured at post time (epoch / dimensions / layer existence) before baking + one history entry; a worker error finishes any in-flight jobs synchronously so no released blob is lost.
  - **Smart filters** (`app/workers/filters.worker.ts`): the full stack pipeline (filters bottom→top, per-filter blend/opacity via OffscreenCanvas, filter-mask premultiplied lerp) with a **stale-while-refresh product cache** in the engine (`filteredProduct`) — no async compositor needed: on a key miss with a previous product available, the stale product draws this frame while the worker recomputes; the reply lands in `filteredCache`, clears the render cache (frames in flight cached stale products under fresh keys) and recomposites. Live paint sessions on filtered layers bypass the cache (in-line compute, exactly as before); cold first render and "Apply (bake)" stay synchronous for correctness. Known tradeoffs: worker jobs are posted per drag tick (serial worker queue can lag long drags; newest-per-node reply wins), and the preview trails the slider by ~a tick like the Blur Gallery.
- [~] **WebGL/WebGPU renderer** (P3) — the highest-value stage is done 2026-07: a **WebGL2 tone-LUT renderer** (`app/lib/gpu.ts`) behind the render-graph seam. Curves/Levels adjustment layers now skip BOTH the full-document `getImageData` readback and the JS per-pixel loop: the below-accumulator canvas uploads straight to a texture, a 256×1 NEAREST LUT texture maps each channel exactly (`(v·255+0.5)/256` sampling → exact bucket), and the result returns via GPU→GPU `drawImage`. Correctness rails: sources upload unpremultiplied (getImageData semantics) into a `premultipliedAlpha:false` context; display-p3 documents use `drawingBufferColorSpace`/`unpackColorSpace` where supported and fall back to CPU otherwise; context loss → permanent CPU fallback; tone products are never mixed-source (the region-scoped partial patch defers to the GPU full pass, which is cheap); `exportComposite(clean)` forces the CPU path for byte-certain output; A/B via `window.__gqGPU.enable()/disable()/status()` (dev), mirroring `__gqRenderCache`. **Deliberately NOT GPU** (and why): layer blend modes already run on the GPU through Canvas2D `globalCompositeOperation`; the slider-adjustment math (`applyAdjustments`) is a large hand-written colour pipeline where a GLSL port would risk divergence for modest gain; effects/smart-filters have kernel reach and live in the worker path instead. A full GPU compositor (or WebGPU compute for filters) remains open as the v2-engine step.
- [x] **Dirty-region recompute inside nodes** — done 2026-07 for the case that matters: **region-scoped adjustment read-backs**. Every cached adjustment product now tracks the union rect of committed changes beneath it (`adjMeta`; `pushEntry` passes its patch rect into `bumpPixel`, so brush/heal/fill commits AND undo/redo are rect-bounded). On a key miss where the same immutable tree is live, the adjustment's own key parts are unchanged and every change since caching was rect-bounded, only that rect is re-read, re-processed (same math via `applyAdjustmentRegion` — adjustments are strictly per-pixel, so this is byte-exact) and re-modulated; outside it the old product is reused. Guarded by `changeReaches`: changes on layers with enabled effects/smart filters (or under styled ancestor groups) spread pixels beyond their rect and force the full path — this check also fixed a latent partial-BLIT hazard (undoing a stroke on a shadowed layer could leave a stale shadow on screen outside the patch rect). Not attempted (still full-size on miss): effects and smart-filter recompute regions — both have kernel/offset reach and need padded-region math.
- [x] **Tiled compositing** — done 2026-07 for the case the item names ("so caches/evictions work per-tile"): **adjustment products on very large documents are cached as 1024-px tile grids** (engaged when one full product would reach 64 MB, the smallest budget setting — ≈4k×4k, so every ≥ 8k document; an 8k² product is ~268 MB, larger than the entire default budget). **Per-tile eviction**: the LRU evictor sees each resident tile as its own candidate (`selectEvictions` loosened to `{bytes, tick}` entries; tiles of frame-used products stay protected), so an over-budget cache sheds exactly the overage instead of whole products, and a freed tile is later recomputed **alone** from the below-accumulator. **Per-tile recompute**: the dirty-rect proof (adjMeta) now marks only the tiles under a committed rect stale — replacing the old region path's per-commit full-canvas copy + 268 MB allocation with a few tile-sized ops — and, new with this change, **mask paints on the adjustment itself are region-priced too** (the tiled own-signature excludes the mask version; the mask rect rides the same dirty bookkeeping, sound because modulation is per-pixel). GPU tone products never mix with CPU tiles: any staleness under an active GPU pass reruns the (readback-free) full pass and re-slices all tiles from that single source. Guardrails intact: `exportComposite(clean)` and the `__gqRenderCache` A/B disable bypass tiling wholesale; group-local accumulators stay uncached; resize/crop/space changes clear through a now-centralized cache reset (which also fixed a latent leak — the filter-worker error path cleared the cache without resetting the byte count). Verified: 32 numeric checks on the pure tile math + eviction selection (partition exactness incl. edge tiles, thresholds, tile-vs-product LRU order, pseudo-id round-trip, protection); tsc clean. Deliberately NOT tiled: leaf/group/clip products (effects/smart filters have kernel reach — a tile can't recompute in isolation without padded-region math) and the per-frame compositor itself (Canvas2D draws are already GPU-side; viewport-culled tile compositing is v2-engine territory with exportComposite/histogram implications).
- [x] **Progressive preview** — done 2026-07 for smart-filter drags on large documents (≥ 2 MP): a param drag kicks the worker at **half resolution** — the source downscales on the GPU before the readback (¼ the pixels AND ¼ the `getImageData` cost), spatial filter params scale with it (`scaleFilterParams`: blur px, unsharp radius, mosaic cell, wave amplitude/wavelength, emboss height — %/degree/threshold params untouched) and the reply upscales smoothly to document size. **Settle is timer-free**: it falls out of the composite loop — when a composite hits a preview-quality product whose key still matches (params stopped moving), a full-res refinement job kicks quietly and swaps in. Exports are protected engine-side: `exportComposite` never accepts preview-quality or stale-param products (sync full-res unless the cache is an exact full-quality hit), and the same fix makes the `__gqRenderCache` A/B toggle and clean exports bypass the filtered-product cache entirely. Not extended to the Blur Gallery worker (its session-cached originals would need scaled copies) — its drags are already non-blocking.
- [x] **Cache budget in Preferences** — done 2026-07: Preferences ▸ **Performance** tab with a 64–1024 MB budget slider (`prefs.cacheBudgetMB`, applied via `setRenderCacheBudget`, evicts immediately when shrunk — frame-protected entries excluded) and **live statistics** polled each second while the tab is open: memory used vs budget (with a usage meter), cached-product count, session hit rate (new `cacheHits`/`cacheMisses` counters in `renderNode`), and the debug on/off state.
- [ ] **Autosave / crash recovery** — periodic `.aproj` snapshot to IndexedDB + "restore last session" on boot.
- [ ] Perf HUD (dev): composite ms, cache hit rate, dirty rect overlay.

## 9. File formats & import/export

- [~] **RAW support** (P3) — the hand-written decoder is done 2026-07: a dependency-free **DNG subset decoder** (`app/lib/dng.ts`, ~650 lines) covering the TIFF/IFD structure (both byte orders, SubIFD walking, NewSubfileType-scored raw-IFD selection), **uncompressed** raw (16-bit words and MSB-packed 10/12/14-bit rows) and **lossless JPEG** (ITU-T81 SOF3: canonical Huffman DC tables, all 7 predictors, point transform, FF-stuffing, multi-component scans) in strips or tiles, CFA patterns up to 8×8, LinearRaw, then the develop pass: per-cell BlackLevel/WhiteLevel normalization → **as-shot white balance** (AsShotNeutral, green-normalized) → **camera→sRGB matrix** (ColorMatrix2/1, dcraw-style row normalization + inversion) → BaselineExposure → sRGB gamma, with **bilinear demosaic**, ActiveArea + DefaultCrop, and orientations 3/6/8. Runs in a throwaway worker (`dng.worker.ts`) so a 24 MP decode never blocks the UI; wired into `decodeImageFile` ahead of the browser decode for TIFF-shaped files, with the embedded-JPEG-preview fallback intact for everything outside the subset (lossy-JPEG/JXL DNGs, float HDR, non-DNG RAW containers). **Verified against synthetic DNGs built by the test itself** (a TIFF writer + a lossless-JPEG encoder): the uncompressed and lossless-JPEG paths decode byte-identically, a grey card develops to the exact analytic value, and the tests caught a real SOS-parse bug. Remaining (still P3): an interactive develop dialog (WB/exposure sliders before import), feeding a 16-bit layer (blocked on §7 16-bit storage), Malvar-He-Cutler demosaic, and other RAW containers (CR2/NEF/ARW stay preview-only — or the explicit wasm-libraw decision).
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
- [x] **Properties panel** — done 2026-07 (`panels/PropertiesPanel.tsx`, in the right dock between Adjustments and Layers; Window ▸ Properties toggles it, drag-reorder/collapse persist like every panel — saved panel orders pick the new id up automatically). Fully contextual on the active node: kind badge + inline rename, blend-mode select, opacity slider, and a clip-to-below toggle for every node kind; pixel layers/groups additionally get **Masks** (layer-mask enable + link, filter-mask enable), **Effects** (per-effect enable toggles from the node's style, "Edit layer style…" into the dialog) and **Smart filters** (per-filter enable toggles, "Edit smart filters…"); adjustment layers show their type (registry label / Curves / Levels) with "Edit adjustment…" into their editor. Live-edit semantics match the Layers panel (un-labelled tree patches for slider drags; the toggle paths reuse the existing labelled ops — Enable/Disable Mask, layer-effect toggles, clip). Deep param editing deliberately links into the existing dialogs/panel rather than duplicating their live-session plumbing.
- [ ] **Touch & pen**: pinch zoom / two-finger pan on the canvas (pointer events are in place), pen pressure (see brush dynamics), palm rejection toggle.
- [ ] **UI scale setting** (compact/comfortable) and **localization** scaffolding (strings are currently inline).
- [ ] Colourblind-safe accent option + a **high-contrast** theme variant; full keyboard-navigation audit (focus rings exist — ensure every panel/dialog is traversable).
- [ ] Onboarding: "Getting Started" overlay tour + sample document (wires two Help stubs).

## 12. Settings (Preferences additions)

- [x] **Performance tab** — complete 2026-07: render-cache **budget slider + live stats** (done earlier: 64–1024 MB, usage meter, product count, session hit rate, debug on/off), plus **Undo steps** (10–200, default 60 — `prefs.historyLimit` → engine `setHistoryLimit`, trimming the OLDEST entries after every push and on shrink; pixel patches are the dominant memory holders) and a **Background workers** toggle (`prefs.useWorkers` → engine `setWorkersEnabled` gating the blur/filters/heal `ensure*Worker` fns + `setRawWorkerEnabled` for the DNG decoder — every path already had a synchronous fallback, so off = the debugging-friendly inline mode; in-flight jobs still land).
- [ ] **Cursors tab**: precise vs brush-ring, crosshair-in-brush option, ring colour.
- [x] **Units & rulers** — done 2026-07: Preferences gained a **Units & rulers** tab — measurement unit (**px / in / cm**, `prefs.unit`) + **default resolution** slider (72–600 ppi, `prefs.defaultDpi`). Documents now carry a **`dpi`** (stamped from the preference at creation, editable per-document in the New document dialog's new Resolution field, serialized in `.gproj` as an optional field — old files open at 300). Unit-aware surfaces: **rulers** tick/label in the chosen unit (nice-step spacing computed in unit space, decimals trimmed; pixels keep integer labels), the **status bar** shows physical dimensions with the ppi (`6.40 × 3.60 in @ 300 ppi`), the **Metadata panel** gained a Resolution row with the physical size, and **printing is true-size** (the print CSS sets the image width to `width/ppi` inches, still fitting the page when larger). Deliberately still pixel-based: the Image Size / Canvas Size / New-document size FIELDS (unit-aware size entry is a follow-up).
- [ ] **Transparency grid**: size/colours of the checkerboard.
- [ ] **Guides & grid**: colours, spacing/subdivisions, snap distances.
- [ ] **Files tab**: autosave interval, default export format/quality, recents length, "share saved gradients" (exists) + future shared libraries.
- [x] **Reset all preferences + settings import/export (JSON)** — done 2026-07 (`app/lib/settings.ts` + the Preferences footer). **Restore defaults…** (confirm → clear + reload) resets everything configuration: the Preferences model, tool options, panel order/visibility, view toggles, working colour space, proof target, and the theme/accent cookies — while deliberately KEEPING user content (saved gradients, swatches, adjustment presets, recents, autosave snapshots). **Export settings** downloads `graphiq-settings.json` (`{format:"graphiq-settings", version:1, values, cookies}`, localStorage values stored opaquely); **Import settings…** validates the format and writes ONLY whitelisted keys (a crafted file can't touch user content or foreign keys — verified), then reloads — a reload is the one honest way to apply everything atomically, since consumers read their keys on boot. Absent keys in an import mean "that setting's default" (removed, not skipped), so an export taken on defaults restores defaults.

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
