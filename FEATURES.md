# Graphiq Studio — Features & Architecture

A browser-based, **fully client-side** raster photo editor with a non-destructive layer stack. There is no server, database, or upload — images never leave the machine; everything is computed in the browser on HTML `<canvas>` elements.

**Stack:** Next.js 16 (App Router) · React 19 (with the React Compiler) · TypeScript (strict) · SCSS modules · `lucide-react` icons. **No image-processing libraries** — every pixel operation (compositing, blending, blurs, filters, tone curves, selections, layer effects, history) is hand-written against the Canvas 2D API and `ImageData`.

**Status:** the destructive editor (19 tools, 19 blend modes, selections, live sessions, colour management) plus the **full non-destructive stack** — layer **masks**, **adjustment layers**, **layer effects**, **Curves & Levels**, **clipping masks**, **smart filters**, and the **render-graph cache**. Project files (`.gproj`, formerly `.aproj` — old files still open) are at **format version 11** (v8 filter masks, v9 document metadata, v10 colour labels, v11 stored paths). See [Part 3 — Known limitations](#part-3--known-limitations--not-yet-implemented) for what's partial or absent.

This document is written so someone **without the code** understands exactly what exists, what works, **how** it works, and what does not.

---

# Part 1 — Feature inventory

## Documents & canvas

- **Multiple documents** open as renamable tabs. Each tab is fully independent: its own layer tree, undo history, selection, view (zoom/pan), working colour space, and metadata.
- **New / Open (.gproj) / Import (image)**; arbitrary canvas sizes.
- **Image Size** (resample — content scales) vs **Canvas Size** (reframe — content stays, the frame grows/shrinks).
- **Rotate 90° CW/CCW**, **Flip Horizontal/Vertical** (whole image).
- **Crop** (interactive box: aspect presets, rule-of-thirds/grid overlay, straighten, shield) and **Trim** (auto-remove uniform border pixels).

## Tools (18, single-key shortcuts)

| Tool | Key | Notes |
|---|---|---|
| Move | `V` | Move layer pixels or a floating selection. |
| Rectangular Marquee | `M` | **Rectangle / ellipse / triangle** region shapes (`Shift+M` cycles); hold `Shift` for a 1:1 square/circle; the triangle's apex follows the drag direction and has an adjustable, live-updating apex position. |
| Lasso | `L` | **Freehand / Polygonal / Magnetic** modes (`Shift+L` cycles). Polygonal: click vertices, rubber-band edge, close on double-click/start-click/Enter, Backspace undoes a point. Magnetic: points snap to a **per-channel edge field** of the composite (catches colour edges a luma map misses; noise-suppressed, per-image normalized) with a **zoom-aware ~28-screen-px reach** and a direction-aware search that prefers the contour being followed (continuity + gradient-orientation coherence) over parallel or crossing edges. |
| Magic Wand | `W` | Contiguous or global colour selection; tolerance, sample-all-layers. |
| Crop | `C` | Aspect presets, grid overlay, straighten, shield. |
| Eyedropper | `I` | Sample colour; configurable sample radius. |
| Brush / Pencil / Eraser | `B` / `N` / `E` | Independent size, hardness, opacity, flow, smoothing. |
| Clone Stamp | `S` | Alt-set source, paint sampled pixels. |
| Spot Heal | `J` | Paint a blob over a blemish; on release it heals in one pass — texture from the best-matching surroundings, tone-matched seamlessly (respects an active selection). |
| Red Eye | `Y` | One click fixes a flash pupil: finds the red blob near the cursor (re-centres on it, adaptive redness thresholds so skin never qualifies), replaces red with min(G,B) — the white catchlight survives — and darkens toward a natural pupil. Size + darken options; respects an active selection; a click that finds nothing changes nothing. |
| Paint Bucket | `G` | Flood fill: tolerance, contiguity, anti-alias, opacity. |
| Gradient | `G` | Linear/radial, draggable re-editable on-canvas control + multi-stop editor; `Esc` keeps the fill and hides the controls. |
| Blur | `R` | Blur brush with an on-canvas brush-ring cursor (coverage-mask model). |
| Dodge / Burn | `O` | Tonal range (shadows/mids/highlights) + exposure. |
| Text | `T` | On-canvas WYSIWYG editor with **rich runs** — select a range and change its font, size, colour, bold/italic/underline/strike independently (a bare caret still styles the whole block); **left/centre/right/justify** paragraph alignment plus tracking + leading controls; rasterises on commit but stays re-editable as a vector (runs included, `.gproj`-persisted, SVG-exported per segment); optional anti-alias. |
| Pen | `P` | Bezier paths (anchors with handles), taper/bend stroke. |
| Shape | `U` | Rectangle / ellipse / triangle / trapezoid, kept as re-editable vectors (fill, stroke, radius, apex/corner geometry). |
| Hand / Zoom | `H` / `Z` | Pan / zoom. |

All Options-Bar settings, the foreground/background colours, and the marquee shape + triangle apex **persist to `localStorage`** and restore on reload.

## Selections

- The selection model is a **list of rectangles** plus an optional rotation **angle + pivot**. Freeform/curved regions (wand, ellipse, triangle, lasso) are rasterised to per-row scanline rects and merged by the engine's **mask-based combine**, which returns clean **pre-traced marching-ant outlines** — so even a 500-rect ellipse animates its ants cheaply (no per-frame O(n³) boundary union).
- **Add (Ctrl) / Subtract (Alt)** while dragging; the existing selection stays visible during the drag and the new region previews separately.
- **Select menu:** All `Ctrl+A`, Deselect `Ctrl+D`, Reselect `Ctrl+Shift+D`, Inverse `Ctrl+Shift+I`, **Feather…** `Shift+F6`, **Grow…** (Feather blurs the selection mask for fills/deletes/moves; Grow expands the region by N px).
- **Free Transform** `Ctrl+Alt+T` and **Transform Selection** `Ctrl+Alt+Shift+T` — scale/rotate either the pixels or just the outline, with corner/edge handles, a rotation ring, and a movable pivot.
- Fill with foreground/background (`Backspace`/`Delete`), Cut/Copy/Paste of selected pixels.
- **Arrow-key nudge:** with a selection tool, arrows move the **outline** by 1 px (`Ctrl` = 10 px); with the Move tool, arrows move the **pixels** (selection content, the whole layer — linked mask included — or a floating paste), and a rapid burst of presses lands as a single undo step.
- **Content-Aware Fill** (`Shift+F5`, Edit menu): fills the selection with content synthesized from its surroundings — overlapping source blocks blended with a seamless tone-matching pass — as one undoable step.

## Layers

- A **tree** of three node kinds: **pixel layers** (`LayerLeaf`), **groups** (`LayerGroup`, nestable folders), and **adjustment layers** (`LayerAdjustment`, pixel-less — see below).
- Per-node **visibility, opacity (0–100), blend mode** (19 modes), an optional **mask**, optional **layer effects**, and a **clipped** flag.
- **New / Duplicate / Delete / Group (`Ctrl+G`) / Ungroup / Merge Down (`Ctrl+E`) / Flatten**. Drag to reorder (can re-parent across groups). Multi-select. Inline rename.
- **Colour labels + filter row:** tag any node with one of **seven colour labels** (right-click menu swatches, applies to the whole selection, shown as a dot on the row, saved in `.gproj` v10) and filter the panel by **name, kind and label** — matches stay bright while their ancestors dim for context, a matching group reveals its contents (even inside collapsed groups), and drag-reorder pauses while a filter is active so hidden hierarchy can't be rearranged blind.
- Group **opacity/blend/mask** apply to the *merged* group result (isolated grouping), exactly like Photoshop.

## The non-destructive stack

These five systems are the heart of the editor. They are all **composite-time**: they change how the layer tree is rendered, never the stored pixels (except an explicit "Apply/bake").

### 1. Layer masks
- Any pixel layer **or group** can carry one **grayscale raster mask** (white = visible, black = hidden, grey = partial). It modulates the layer's alpha at composite time; the layer's own pixels are never altered.
- **Create** reveal-all / hide-all / from-selection; **Delete**; **Apply** (bake into the layer, destructive); **Enable/Disable**; **Link/Unlink**; **Load Mask as Selection**.
- **Active-surface switch:** click a layer's mask thumbnail to make the mask the paint target; click the pixel thumbnail to switch back. **Every paint tool then edits the mask** — brush, pencil, eraser, clone, paint bucket, gradient, **blur and dodge/burn**, plus Backspace-fill and Delete.
- **Linked move:** with the chain (link) toggle on, moving the whole layer moves its mask with it — one undo step restores both.
- Layers panel: mask thumbnail beside the pixel thumbnail, an **active-surface ring**, a chain (link) toggle, Shift-click to disable; Layer menu has the full submenu; the **Channels** panel and the masking interact correctly (mask multiplies the *final* styled result, so a mask also hides a layer's effects).

### 2. Adjustment layers
- A **`LayerAdjustment`** node holds an **`AdjustmentSpec`** and **re-processes the composite of everything below it** within its parent — non-destructively, re-editable forever.
- Types (all routed through the existing `applyAdjustments` math so there is one colour engine): **Brightness/Contrast, Exposure, Vibrance, Color Balance, Black & White, Photo Filter (Warm/Cool)**, the named **filter presets** (Vivid/Noir/Vintage/…), and **Curves / Levels** (below).
- **Extra adjustment kinds** (own pixel math in `adjust-extra.ts`, same node semantics): **Hue/Saturation with per-range targeting** (Master + six feathered hue-wheel ranges — reds/yellows/greens/cyans/blues/magentas — each with hue/saturation/lightness; greys are never range-targeted), **Selective Color** (nine Photoshop-style ranges with relative/absolute CMYK deltas), **Gradient Map** (composite luminance through the shared gradient editor, reversible), **Channel Mixer** (per-output-channel linear mixes + constant, monochrome mode), **Color Lookup** (imports a **3D `.cube` LUT**, applied with trilinear interpolation; the LUT rides inside the `.gproj`), and **Invert / Equalize**. All are strictly per-pixel — so they keep the render graph's region-scoped and tiled recompute — **except Equalize**, whose whole-image histogram the engine detects and always recomputes in full. Parameterized kinds edit in a live dialog (one undo step per gesture, like Curves). Created from **Layer ▸ Adjustment ▸ {type}** or the **Adjustments panel's** button grid below Curves/Levels.
- **LUT export (.cube)**: the current grade exports as a standard 3D LUT (File ▸ Export LUT (.cube)… or the Adjustments panel's "Export as LUT" button) — either the **visible adjustment-layer stack** (bottom→top with opacity + blend modes) or the **panel's current sliders**, sampled through the exact compositor math over a 17³/33³/65³ identity lattice. The dialog reports what can't travel into a LUT (Equalize, masks/clipping, group-nested adjustments, spatial sharpen/noise). Exported LUTs round-trip through the app's own Color Lookup adjustment and work in any .cube-reading software.
- Honours its own **opacity, blend mode, mask, and clip**. Created from **Layer ▸ Adjustment ▸ {type}** or the **Adjustments panel** ("Create Adjustment Layer", "Curves", "Levels"). Editing is **live with no Apply step**; one cheap, params-only undo step per edit gesture.
- The destructive Adjustments-panel path (live preview on a pixel layer + the slider set) still exists; a **"Create adjustment layer"** button converts that preview into a node.

### 3. Layer effects (layer styles)
- Eight non-destructive effects rendered from the layer's **alpha silhouette** at composite time: **Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Stroke, Color Overlay, Gradient Overlay, Bevel & Emboss** — each with its own blend mode + opacity.
- A **Layer Style dialog** (left column = effect checklist, right column = per-effect controls, with a **live document preview**) reusing the app's custom colour picker. **Copy / Paste / Clear Layer Style**; an **fx badge** + footer button + context menu in the Layers panel.
- Shadows/glows use the **shared separable blur** (the same primitive as the Blur Gallery). Effects render in the correct stacking order and compose with masks, adjustments, opacity, blend, and groups.

### 4. Curves & Levels
- **Curves:** a **monotone-cubic** spline (Fritsch–Carlson — guaranteed monotonic, no overshoot) over a live histogram backdrop, per channel (RGB/R/G/B); click to add a node, drag to move, right-click to delete; numeric input/output readout; **presets** (Linear, Increase/Decrease Contrast, Negative, Lighten/Darken Midtones).
- **Levels:** input black/gamma/white + output black/white as **draggable triangles** over a live histogram, per channel, with numeric fields, **Auto** (per-channel contrast stretch), and **black / grey / white eyedroppers** (click the image to set the point or neutralise a colour cast).
- Both compile to **per-channel 256-entry LUTs** (composite⊕channel composed, alpha untouched) applied in one typed-array pass. Available **non-destructively** (as adjustment layers, re-editable via the dialogs) and **destructively** (Image ▸ Adjust ▸ Levels/Curves… → live preview → Apply/Cancel).

### 5. Clipping masks
- Any leaf, group, or adjustment can be **clipped** to the layer directly below it (its *base*): it shows only within the base's silhouette. A **clip group** = a base + the contiguous run of clipped layers above it.
- Members **blend within the group**; the base's opacity/blend/mask then govern the whole group against the layers below. Toggle with **`Ctrl+Alt+G`**, **Alt-click a layer row**, or the context menu. The Layers panel shows clip groups **indented with a ↳ elbow** under an **underlined base name**.

## Adjustments & filters (destructive panel)

- **Adjustments panel** previews live on the active layer (no Apply button — it auto-bakes on session end; Reset discards): **Light** (exposure, contrast, highlights, shadows, whites, blacks) · **Colour** (temperature, tint, vibrance, saturation) · **Detail** (sharpen, clarity, noise).
- **Filter presets** (Original, Vivid, Mono, Noir, Warm, Cool, Vintage, Fade) and **custom presets** that **import/export** to `.gifp`/`.gifpack` files.

## Effects (Blur Gallery)

- **Effects ▸ Blur Gallery…** — a large dialog with an embedded **live-preview canvas**: **Box, Gaussian, Motion, Zoom, Spin, Bokeh**. Zoom/Spin have a **draggable centre point**. Scope = selection (if any) or the whole layer/canvas.

## Colour, file, panels, view, UI

- **Colour:** primary/secondary swatches (remembered), swap & reset, alpha-aware over a checkerboard; a custom **colour picker** + popover used everywhere (options bar, gradient, layer styles); **Compare Colour Profiles** dialog; colour-management dialog.
- **Colour management:** working spaces **sRGB**, **Display P3** (native canvases, browser-managed), and **Adobe RGB (1998) — emulated**: pixels stay on an sRGB canvas (a browser cannot display or export an Adobe RGB canvas), while slider adjustments, adjustment layers and Curves/Levels matrix-convert into Adobe RGB primaries, run their math there, and convert back — matching how those edits behave in an Adobe RGB workflow. Colours outside sRGB still clip at the canvas, and filters/effects/compositing remain in the canvas space; switching to or from the emulated space is lossless. The Color Management dialog states all of this.
- **Soft proofing:** **Proof colors** (`Ctrl+Alt+Y`) simulates how the document will look in a target space (sRGB / Display P3 / Adobe RGB — chosen in Color Management, persisted) on the view only; **Gamut warning** (`Ctrl+Alt+Shift+Y`) marks colours outside the target's gamut in mid-grey. In-gamut pixels display byte-identically; exports are never proofed. Most useful on Display P3 documents proofed against sRGB before an sRGB export.
- **RAW (DNG) development — hand-written decoder:** importing a `.dng` runs a true raw develop, not just the embedded preview: TIFF/IFD parsing, **uncompressed** (16-bit or packed 10/12/14-bit) and **lossless-JPEG (SOF3)** CFA data in strips or tiles, then black/white-level normalization → as-shot white balance → camera→sRGB colour matrix → baseline exposure → sRGB gamma with bilinear demosaic, ActiveArea/DefaultCrop and orientation — all dependency-free, decoded off-thread in a worker. DNGs outside the subset (lossy-JPEG/JXL, float HDR) and other RAW formats (CR2/NEF/ARW…) fall back to the embedded JPEG preview as before.
- **ICC profile import (assign vs convert):** imports sniff embedded ICC profiles from the file bytes (PNG/JPEG/WebP) and show the profile's name; when it differs from the working space, the Import dialog offers **Convert** (colour-managed decode — keeps appearance, the default) or **Assign** (decode without colour management — keeps the raw numbers). Untagged images and same-space profiles skip the question.
- **PSD interchange — hand-written reader + writer:** importing a `.psd` opens it as its own **layered document**: layers (RAW/RLE channel data), **nested groups**, **layer masks** (with disabled flags), opacity, blend modes, **clipping masks**, visibility and unicode names all survive; text and smart objects arrive as their rasterized pixels; adjustment/fill layers are skipped with a note. Files outside the subset (16/32-bit, CMYK, no layer data) import as the flattened composite instead of failing; PSB is rejected with a clear message. **File ▸ Export PSD (layered)…** writes the whole tree back out — groups as section dividers, masks, opacity/blend/clipping/hidden flags, RLE-compressed channels, the document's ppi, and the required flattened composite (over white) so even layer-ignorant readers show it. The writer's output round-trips byte-exactly through the reader (verified: pixels, masks, structure, all 18 blend modes).
- **TIFF import + export — hand-written codec:** importing a `.tif` decodes it in-app (Chrome/Firefox can't decode TIFF at all): both byte orders, strips **and tiles**, **8/16-bit** samples (16-bit shown at 8 for now), grayscale (both polarities), palette, RGB(A) with associated-alpha un-premultiply, **PackBits / LZW / Deflate** compression with the horizontal predictor, orientation and dpi — verified pixel-exact against a real codec's LZW output (GDI+). Files outside the subset (JPEG-in-TIFF, CCITT fax, float, planar) fall back to the browser/preview path. **File ▸ Export TIFF…** writes the flattened composite as 8- or 16-bit RGB(A) with Deflate-compressed strips, straight alpha or white-matted, plus resolution tags — 16-bit is the 8-bit canvas widened (v·257) for 16-bit pipelines, stated in the dialog. **HEIF/HEIC** imports decode where the browser ships the codec (Safari; most others don't) — undecodable files now get a named alert saying exactly that — and the Metadata panel reads **EXIF out of HEIF and AVIF** containers via an ISO-BMFF scan.
- **PDF export — hand-written writer:** **File ▸ Export PDF…** writes a single-page PDF 1.4 from the flattened composite: page sized to the image at a chosen ppi, or to **A4/Letter/Legal/A3/A5** (portrait/landscape) with an mm margin — **fit to margins** or actual-size-at-ppi, centred, with an overflow warning. The image embeds as **JPEG (DCTDecode)** with a quality knob or **lossless (FlateDecode)**; transparency mattes over white; the Info dictionary carries title, author (doc metadata artist or the Preferences attribution default), creator and a timezone-correct creation date (Unicode-safe). Structure Node-verified: xref offsets, stream payloads, escaping.
- **SVG import (vector layers) + SVG export:** importing an `.svg` parses it with the browser's own machinery (a hidden shadow-DOM mount, so transforms/viewBox come from `getScreenCTM` and styles from the full CSS cascade) into a **vector layer** — styled path recipes that rasterize crisply from the source geometry (`vector: path` recipe on the layer, kept in `.gproj`, shown as "Vector layer" in Properties). Covers paths, rects/circles/ellipses/lines/polylines/polygons, groups, transforms, fill rules, stroke caps/joins/dashes and per-paint opacity; files using features beyond that subset (text, gradients/patterns, filters, masks, clip-paths, markers, `<use>`…) import as a faithful **raster** of the browser's own rendering instead — never a degraded "vector". The pixels of a vector import are rendered from the recipe itself, so the recipe and the layer can never disagree. **File ▸ Export SVG (vector layers)…** serializes every visible vector-bearing layer — imported vectors as paths, **shape layers through the exact ring geometry the rasterizer paints**, **text layers through the same line layout** (wrap, alignment, leading, tracking, decoration) — with layer opacity and CSS-mappable blend modes; raster/adjustment layers are skipped and counted in the toast.
- **High-bit adjustment path:** in the emulated Adobe RGB space the whole adjustment pipeline runs at **16 bits/channel** — canvas bytes decode straight to Adobe RGBA16, slider math and 65 536-entry tone/curve LUTs run on 16-bit values, and a single final quantization writes back to the 8-bit canvas (the compositing fallback). Identity edits roundtrip byte-exact — verified numerically. Native sRGB/P3 spaces keep the plain 8-bit path, which already quantizes only once per pass.
- **HDR — merge, tone map, true-HDR export:** **File ▸ Merge to HDR** fuses 2+ bracketed exposures (tripod-aligned, same pixel size) into a **32-bit float radiance map** — EVs auto-read from EXIF (`log2(N²/t) − log2(ISO/100)`) or estimated from brightness, hat-weighted Debevec-style merge that drops clipped channels and recovers highlights from the darkest frame (Node-verified against synthetic brackets to <1% error). A live tone-mapping stage (exposure ±4 ev; **Filmic/Hable**, **extended Reinhard**, or linear) renders the new document, which **keeps the float source in memory**: **Image ▸ HDR tone mapping** re-renders the active layer from float any time (one undo step, no cumulative 8-bit loss), and **File ▸ Export HDR PNG** writes a genuine HDR file — a hand-written **16-bit PNG** encoder (zlib via `CompressionStream`, CRC-verified) tagged **Rec.2100 PQ or HLG via a `cICP` chunk** (BT.2020 primaries, SDR white at 203 nits, PQ peak configurable), whose highlights render beyond SDR white on HDR displays; the dialog reports whether the current display has HDR headroom (`dynamic-range: high`). Honest limits: no auto-alignment, the float map isn't persisted in `.gproj`, and the canvas itself stays SDR.
- **File/export:** Save/Open **`.gproj`**; **Export As** PNG · JPEG · WebP · AVIF (quality + alpha, feature-detected) with a **live exact file-size estimate** (the composite is really encoded, debounced), **export presets** (built-ins + save-your-own, persisted), and a **Batch mode** — multiple format/size targets named by a **filename template** (`{name} {w} {h} {scale} {ext} {n}`, collisions auto-numbered) downloaded as one .zip (hand-written store-method writer); **Export SVG** of vector/text layers; **Export PSD** (layered); **Export LUT** (.cube); **Print** `Ctrl+P`; **Recents** list; EXIF **Metadata** panel.
- **Metadata round-trip:** exports **embed EXIF + XMP** (toggle in Export As, single and batch; the size estimate includes the embedded bytes). A hand-written EXIF/TIFF builder (`metadata-write.ts`, verified against the app's own reader) writes description/author/copyright, camera + capture fields (make/model/lens, DateTimeOriginal, exposure, f-number, ISO, focal lengths), GPS, and the document's **ppi** — into **JPEG** (APP1 Exif + APP1 XMP, JFIF density patched), **PNG** (eXIf + iTXt XMP + pHYs chunks) and **WebP** (VP8X + EXIF/'XMP ' RIFF chunks); AVIF passes through untouched, and any embed failure falls back to the plain encode. The **Metadata panel's Authoring section is editable** (Description / Artist / Copyright, per document, saved in `.gproj` v9), with default attribution from **Preferences ▸ Editing ▸ Attribution** when a document doesn't set its own.
- **Panels (Window menu):** Color · Adjustments · Properties · Layers · Paths · History · Actions · Navigator · Channels · Metadata, in a right dock; Reset Workspace.
- **Paths panel:** committed Pen-tool paths are stored per document — the latest lands as the **Work Path** (Photoshop-style, replaced per commit; Save keeps it as a named path with an SVG thumbnail). Any stored path can become a **selection** (Ctrl adds, Alt subtracts, Ctrl+Alt intersects — the boolean combines, journaled and undoable), be **stroked** (Pen settings + foreground colour, one undoable step) or **filled** onto the active layer, or be **loaded back into the Pen tool** for editing. Paths save in `.gproj` (v11). Boolean combines are rasterized at the selection level — true bezier booleans are out of scope.
- **Actions (macro recorder):** the Actions panel records sequences of **document menu commands** — layer/mask/clip ops, rotates & flips, crop-to-selection, cut/copy/paste, content-aware fill, preset adjustment layers, layer-effect adds, save/print — into named macros, replayed in one click or via an assigned **F-key** (F2–F10; browser keys stay untouched). Recording hooks the single command dispatch point (menus, the `Ctrl+K` palette and keyboard shortcuts all funnel through it) behind an explicit replay-safe allowlist, so a recorded action never stalls on a dialog; playback re-dispatches with a short gap per step. **Paint strokes record too**: while recording, every finished **brush / pencil / eraser** stroke is captured — tool, brush settings snapshot, colour, and the raw pointer path in document space — and replayed through the live stroke engine at the recorded coordinates (identical smoothing/spacing/blending, one undo step), onto the **current** active layer clipped by the **current** selection, same "as if you did it now" semantics as command steps. Stored as user content (`graphiq:actions`, cleared/measured via Preferences ▸ Storage). Honest limits: other tools' gestures (clone/heal, gradients, shapes, text), dialog settings and view changes aren't captured.
- **View:** Zoom In/Out, **Fit** `Ctrl+0`, **100%** `Ctrl+1`, Rulers, **Pixel Grid** `Ctrl+'`, Snap, Navigator overview.
- **Properties panel** (Window ▸ Properties): a contextual editor for the active layer — rename, blend, opacity, clip-to-below, plus quick enable toggles for its masks, layer effects and smart filters, and one-click links into the full Layer Style / Smart Filters / adjustment editors.
- **UI/UX:** Atlassian palette (DESIGN.md / DESIGN.dark.md) styled after the Magiq Studio reference UI: neutral surfaces on an 8px rhythm, SOLID-accent active states (tools, tabs, menu hover), container wells for inputs, white-thumb sliders (every slider's numeric readout is **click-to-type** — click the value to enter an exact number, snapped to the slider's step; covers the options bar, panels, dialogs/popups, the status-bar zoom and the Layers-panel opacity), Atlassian Sans/Mono, sentence-case text; **light / dark / match-system** themes plus **six accent colours** (Preferences → Appearance: theme preview cards, accent swatches, a "Reduce motion" toggle); a **command palette** on `Ctrl+K` (also the top-bar search pill): **fuzzy search** over every tool and executable menu command — subsequence matching with word-start/consecutive ranking, so "exp svg" finds Export SVG — with highlighted match characters, shortcut chips, on/off state for panel toggles, and a persisted **recently-used** list when the query is empty (hand-written matcher in `fuzzy.ts`, Node-verified); an **Interface scale** setting (Preferences ▸ Appearance: Compact 90% / Default / Comfortable 110% / Large 125%, cookie-persisted with no boot flash) that CSS-zooms the bars, panels, menus, dialogs and popups while the canvas view stays 100% — document pixels are never resampled; **Preferences** `Ctrl+,`; non-blocking toasts; inverted tooltips; full menu bar.

---

# Part 2 — Architecture

## Module map (`app/lib`)

| File | Responsibility |
|---|---|
| `paint.ts` | **`PaintEngine`** — all pixels, the compositor, every live session, history, caches. |
| `layers.ts` | Immutable layer **tree** types + pure functions; `clipGroupsOf` resolver; `LayersApi`. |
| `adjust.ts` | The slider `Adjustments` type, `applyAdjustments` (the one colour-math fn), filter presets, `AdjustmentSpec` union. |
| `adjustment-types.ts` | Registry of adjustment-layer types (label + seed params). |
| `tone.ts` | Curves/Levels LUT math (levels formula, monotone-cubic curve, compose, auto-levels, gray-point). |
| `effects.ts` | Layer-effects renderer (`renderStyled`) — all 8 effects from a layer's alpha. |
| `blur.ts` | Shared separable box/Gaussian blur (used by Blur Gallery **and** effects). |
| `gradient.ts` | Multi-stop gradient model + canvas-gradient builder. |
| `color.ts` | Colour parsing + RGBA/HSV/HSL conversions + swatch helpers. |
| `project.ts` | `.gproj` (de)serialisation. |
| `view.ts`, `tools.ts`, `menus.ts`, `metadata.ts`, `imageio.ts`, `filterio.ts`, `pen.ts`, `shapes.ts`, `recents.ts`, `prefs.ts`, `toolPrefs.ts`, `swatches.ts`, `theme.ts` | View math, tool/type defs, menus, EXIF, export/import, filter files, pen/shape geometry, recents, preferences, persistence, theme tokens. |

React talks to the engine through a curated **`EngineHandle`** interface; it never touches pixels directly.

## The paint engine

`PaintEngine` (`paint.ts`) owns one offscreen `<canvas>` per pixel layer (a `Map` keyed by layer id), plus several reusable buffers:

- **`stroke`** — the in-progress brush dab/stroke (kept **sRGB**, see Colour).
- **`scratch`** — live-session previews.
- **mask buffers** — `masks` (grayscale mask per id) and `maskAlpha` (derived alpha cache per id) Maps.
- **adjustment/clip buffers** — a small pool (`adjBufs`) including the offscreen composite **accumulator**.

### Live "session" model
Almost every gesture is a temporary, cancellable session that snapshots the original pixels, shows a live result, and **bakes once on commit** (one history entry). Independent sessions exist for: **paint stroke** (brush/pencil/eraser), **blur brush** and **dodge/burn** (a *coverage-mask* model — original snapshot + a 0–1 coverage buffer re-baked as `mix(orig, effect(orig), coverage×strength)`, so a stroke stays even and successive strokes compound), **clone**, **move/float**, **live shape**, **live gradient**, **live pen path**, **live bucket fill**, **live (destructive) adjustment**, **destructive tone** (Curves/Levels via `previewTone`), and the **Blur Gallery** preview.

The brush **tip is pre-baked once per stroke** (hard tips crisp on the integer grid, soft tips sub-pixel); eraser = `destination-out`.

## The compositor (the core)

`composite(tree)` renders into an **offscreen accumulator** (`willReadFrequently`, so adjustment layers can read it back) and then blits to the on-screen view canvas. `exportComposite(tree)` does the same into a fresh buffer for flatten/export. Both call **`drawStack(ctx, nodes)`**.

```
drawStack(ctx, nodes):
  for unit in clipGroupsOf(nodes)        // bottom → top, clip groups resolved
    if unit has clipped members:  renderClipGroup(ctx, unit.base, unit.members)
    else if base is adjustment:   applyAdjustmentNode(ctx, base)   // reads what's beneath in ctx
    else:                         drawNode(ctx, base)
```

**`drawNode`** draws one ordinary leaf/group:
```
src = styledSource(node)                 // leaf pixels (+ effects) OR group merged buffer (+ group effects)
src = maskedSource(node, src)            // destination-in the node's mask alpha cache (if any)
ctx.draw(src) with opacity + blendOp(blend)
```
- **`styledSource`** → a leaf's display canvas (run through `styledLeaf` if it has effects), or a group's `groupMerged` (children composited via `drawStack` into a fresh buffer + the group's own effects).
- **`leafDisplay(id)`** is the live-preview indirection: normally the layer canvas, but during a live session on that layer it returns the `scratch` buffer with the layer + in-progress edit — so previews composite correctly under blend modes/opacity without touching real pixels.
- **`maskedSource`** multiplies the node's mask in with a single `destination-in` of the cached alpha (no per-pixel JS).

**`applyAdjustmentNode(ctx, node)`** (for an adjustment that is *not* a clip member): reads the accumulator beneath it (`getImageData`), runs `applyAdjustments` (sliders) **or** the cached tone LUTs (Curves/Levels), then writes the result back **modulated by the node's opacity × its own mask** and blended with its blend mode. A neutral spec is a no-op. Group isolation is automatic because a group's children composite into the group's own buffer.

**`renderClipGroup(ctx, base, members)`** (the clip-group assembly):
```
1. render base (masked) into a FRESH buffer cg          // nesting-safe; not pooled
2. clipAlpha = snapshot of cg's alpha (the base silhouette, post-mask)
3. for each visible member (bottom→top):
     adjustment → applyAdjustmentNode(cg, member)        // processes the base-shaped buffer
     else       → draw member (its effects, mask, blend, opacity) onto cg
4. cg ⊗= clipAlpha   (destination-in)                    // clip the whole group to the base
5. draw cg onto ctx with the BASE's opacity + blend mode
```
This single path also subsumes "clipped adjustment layer" (Spec 02's old standalone clip-base logic was deleted).

**Blend modes (19)** map to Canvas 2D `globalCompositeOperation`. A few are pragmatic approximations: **Add→`lighter`**, **Linear Burn→`multiply`**, **Dissolve→`source-over`** (no true dither). Hue/Saturation/Color/Luminosity use the non-separable canvas modes.

## How the non-destructive features are implemented

- **Masks:** the grayscale mask is colour-agnostic (always sRGB, never gamut-converted). On any mask edit the **alpha cache** is re-derived **scoped to the changed rect** (`A = R × maskAlpha/255`, RGB=0). A `surfaces` map records each layer's active paint surface; `surfaceTarget(id)` is the single chokepoint that points the brush/fill/gradient at the layer canvas **or** the mask canvas. A live mask brush previews through `maskDisplay(id)`. History pixel entries carry a `surface: 'layer' | 'mask'` field. Canvas resize/crop/rotate/flip transform masks in lockstep with their layers.
- **Adjustment & tone:** **params live entirely on the tree** — the engine holds no canvas for an adjustment node; it just reads them while compositing. Tone LUTs are cached per node id + spec hash (`toneCache`).
- **Effects:** rendered by the pure `renderStyled(src, fx, space)` (document-sized buffer). The styled buffer is **cached per layer** keyed by `pixelVersion | colourSpace | docEpoch | fxHash` (`effectsCache`) — re-rendered only when the layer's pixels, its effect params, the colour space, or the document geometry change; **bypassed (re-rendered each frame) only while that layer is being painted**.
- **Clipping:** `clipped` is a boolean on every node; membership is **derived each composite** by `clipGroupsOf(children)` (never stored). A clipped node with no valid base below is **inert**.

## History (undo/redo)

A **single linear stack** of `Entry` objects + a position pointer:
- **Pixel entry:** `layerId`, a bounding `rect`, `before`/`after` `ImageData` (only the changed region), and a `surface` (layer vs mask).
- **Structural entry:** a `side` with `undo()`/`redo()` callbacks for tree changes (add/remove/group/merge/crop/resize/paste, mask add/apply, **adjustment param edits, layer-effect edits, clip toggles** — all params-only, no pixel data). Pixel + structural can be combined into one step (e.g. paste, Apply Mask).
- `jumpTo(target)` walks the pointer, reverting/applying entries (pixels via `putImageData`, structure via the `side` callbacks); `undo`/`redo` are ±1; a new edit truncates the redo branch. Live sessions finalise before navigation. A label+index summary drives the History panel.
- Non-destructive edits (sliders, curve points, effect params, clip flags) are **debounced to one undo step per gesture** and carry **no pixel data** — the whole point of non-destructive editing.

## Layering (tree)

`LayerBase` (shared by all kinds): `id, name, visible, opacity, blend`, optional `mask`, optional `effects`, optional `clipped`. `LayerLeaf` adds an optional `vector` (re-editable shape/text); `LayerGroup` adds `expanded` + `children`; `LayerAdjustment` adds `adjustment: AdjustmentSpec`.

All tree edits are **pure functions returning a new tree** (find, update, remove, insert-relative/into-group, wrap-in-group, ungroup, **clone-subtree** with fresh ids + deep-copied effects, replace, remove-many, merge-down, flatten, multi-select helpers, visible-row order, and the `clipGroupsOf` clip resolver). The engine mirrors structural ops (`duplicateLayer`, `rasterize` for merge/flatten — which now bake masks + adjustments + effects + clipping, since it composites through `drawStack`).

## Colour management

- Per-document **working colour space: sRGB or Display-P3** (feature-detected). Layer/scratch/group/accumulator/export buffers are all in that space, so wide-gamut content is preserved end to end.
- The **brush `stroke` buffer stays sRGB** because brush/UI colours are authored as sRGB hex; compositing onto a P3 layer lets the browser convert correctly. Layer-effect colours work the same way (sRGB hex filled onto a P3 buffer).
- `setColorSpace` converts existing layers by drawing them through a new-space canvas; masks are **not** converted (coverage, not colour); effect/tone caches invalidate.

## Performance & caching

- **Per-layer `pixelVersion`** (bumped at every committed pixel write — strokes, fills, gradients, shapes, paths, adjustments, text, load, duplicate, merge, undo/redo) + a document **`docEpoch`** (bumped on resize/crop/transform/colour-space) form the cache keys for effects/tone. Painting on one layer never invalidates another's styled cache.
- **Effects** composite as a single `drawImage` of the cached styled buffer when idle. **Tone** LUTs are built once per spec change and applied as one typed-array pass. **Clip groups** add one buffer + one composite pass per group (the `destination-in` clip is GPU, no per-pixel JS).
- Group and clip-group buffers are **fresh per composite** (nesting-safe) — consistent with the existing group compositing; pooled buffers are used only where re-entrancy can't occur.

## Persistence (`.gproj`, format v8)

- A self-describing JSON: doc name/size, foreground/background, active/selected layers, selection, and the layer tree. **Pixel layers** serialise as PNG data-URLs; **masks** (layer + filter) as grayscale PNG data-URLs + `{enabled, linked}`; **adjustment specs**, **layer effects**, **smart filters**, and **clipped** flags as plain JSON. Adjustment/effect/clip nodes carry **no raster** — they re-render from params on load.
- **Backward-compatible:** older files (any earlier version, missing mask/effects/adjustment/clipped fields) open unchanged with those features simply absent.
- Tool options, colours, marquee shape/apex, view toggles, and theme persist separately in `localStorage`.
- **Units & resolution:** rulers and size readouts in **px / in / cm** (Preferences ▸ Units & rulers); documents carry a **resolution (ppi)** — defaulted from Preferences, set per document in New document, saved in `.gproj` — which drives physical-unit rulers, the status-bar size readout, the Metadata panel's physical size, and **true-size printing**.
- **Transparency grid** (Preferences ▸ Transparency): the checkerboard behind transparent canvas areas is configurable — square size (**None / Small 8 px / Medium 16 px / Large 24 px**; screen-space, so squares keep their size at every zoom) and colours (**theme-following greys** by default, the classic **Light/Medium/Dark** grey pairs, or a **custom two-colour pair** via colour wells) with a live preview in the dialog. "None" shows a flat backdrop instead of squares. The small UI-chrome checkers (colour-picker alpha strip, navigator, dialog thumbnails) deliberately stay theme-based.
- **Files tab (Preferences):** the file-handling settings in one place — the **autosave interval**, **export defaults** (the format Export As opens with, limited to formats the browser can really encode, plus a default quality), the **recent-files length** (4–20; the store trims as new entries are added), and the **shared-gradients library toggle**.
- **Settings reset / portability:** the Preferences footer has **Restore defaults…** (resets every setting — tool options, panel layout, theme/accent, colour management, all Preferences — while keeping saved gradients, swatches, presets, recents and autosave snapshots) plus **Export/Import settings** as a portable `graphiq-settings.json`; imports are validated against a strict key whitelist and apply via reload.
- **Autosave & crash recovery:** **all open documents** snapshot to IndexedDB on a Preferences interval (default every 2 min, only when something changed); a heartbeat flag detects unclean exits and offers **Restore / Discard** on the next start — restoring reopens every tab and re-activates the one that was in focus. The status bar shows the real save state ("Unsaved changes" / "Saved" / "Autosaved HH:MM") along with the true document colour space and a Photoshop-style flattened/all-layers size estimate.
- **Keyboard shortcuts — one registry, remappable:** every tool key and menu shortcut resolves through a single registry (`shortcuts.ts`, defaults derived from the tool/menu definitions), which drives the **actual key dispatch**, the labels in the menus and the `Ctrl+K` palette, and the **Keyboard Shortcuts window** — where any binding can be **remapped**: click the key chip, press the new keys (Backspace unbinds, Esc cancels); conflicts move the key from its current owner with a note, reserved bindings (paste's Ctrl+V) refuse, customized rows are marked with per-row restore and a "Reset all". Remaps persist locally and ride the settings export/import/reset. Fixed canvas gestures (wheel zoom/pan, marquee/lasso cycles, nudges) are listed for reference but not remappable.
- **Help & About:** a **Help window** (Help ▸ Getting started / Documentation) with a 7-step quick-start walkthrough and a **searchable reference** of ten topics — tools, selections, layers & masks, adjustments & colour, filters & effects, text & vector, open/save/export, colour management, view & workspace, storage & privacy — hand-curated in `app/lib/help.ts` (topic nav like Preferences; the search filters entries across every topic). **Help ▸ About** shows the app version (from `package.json`), the format matrix and the local-only privacy promise, and cross-links into the guide and the shortcuts window.
- **Storage panel ("scratch disks"):** Settings ▸ **Scratch disks / storage…** opens Preferences ▸ **Storage** — the honest browser equivalent of scratch-disk management: the origin's **storage estimate** (used vs available with a meter, via `navigator.storage.estimate()`), **persistent-storage** status with a request button (protects autosave/recents from browser eviction), and a per-store breakdown with confirm-guarded clear actions — the **autosave snapshot** (doc count, ~size, timestamp → Delete), the **recent-files list** (count → Clear), and **saved presets & swatches** (gradients, swatches, adjustment looks, export presets → Delete; settings themselves reset via the existing footer button). Settings ▸ **Performance…** deep-links Preferences ▸ Performance the same way (`initialTab`/`onTabChange` on the dialog — plain Preferences… reopens on the last-visited tab). All five former Settings/Help stubs now do something; every entry is reachable from the `Ctrl+K` command search.
- *Saved history is labels + index only* — the live undo stack (in-memory callbacks) is not replayable from a file.

---

# Part 3 — Known limitations / not yet implemented

Honest list of what is **partial, deferred, or absent**:

**Non-destructive stack gaps**
- **Filter-mask move:** the smart-filter mask always tracks its layer through canvas transforms; there is no unlinked per-mask move (the layer mask has one via the link toggle).
- **Curves targeted adjustment** (the optional spec item) is now implemented: the Curves dialog's **Target** toggle lets you click-drag on the image to shape the active channel's curve at the sampled tone — the dialog docks aside, the sampled value is **inverted through the current LUTs** so the point lands at the pre-curve tone, and dragging up/down moves its output. Honest limit: the sample reads the flattened view, so layers/effects *above* a curves adjustment node can skew the recovered tone.
- **Gradient stroke effect:** the engine can render a gradient-filled stroke, but the Layer Style dialog exposes Stroke as **colour-only** (the Gradient *Overlay* has a 2-stop editor).
- **Clip edge case:** a clipped layer sitting directly above a **non-clipped adjustment layer** is treated as **inert** rather than clipping to the pixel base *below* the adjustment (a rare configuration; the spec permitted "inert" as a fallback).
- **Channels-panel mask channel** and an **options-bar "Mask" pill** were deferred (the Layers-panel active-surface ring is the indicator instead).

**Performance (render graph — Spec 06 built)**
- The compositor now runs through a **key-validated per-node render cache**: unchanged subtrees are never recomputed (a cached group/effect/adjustment product is one `drawImage`), opacity/blend/visibility changes reuse the layer's intrinsic render, and adjustment layers only re-run their read-back when something *below* them actually changed. A byte-budgeted LRU bounds memory, live brush strokes bypass the cache, and a dev toggle (`__gqRenderCache.disable()`) A/B-verifies pixel identity against the uncached path.
- The LRU byte budget is configurable in **Preferences ▸ Performance** (64–1024 MB slider) with live statistics — memory used vs budget, cached-product count, and the session hit rate. The same tab caps **undo steps** (10–200; oldest steps drop first — their pixel patches dominate memory) and offers a **background-workers toggle** (off = every heavy path runs its synchronous fallback, a debugging aid).
- **Web Worker offload** covers the three heaviest compute paths: the Blur Gallery (session originals cached in a worker, per-tick param messages, stale replies dropped), the heal brush / content-aware fill (the membrane solve runs off-thread; replies are validated against the document state captured when the job was posted, with a synchronous fallback), and **smart-filter recomputes** (the whole stack renders in a worker with a stale-while-refresh product cache — while a recompute is in flight the compositor draws the previous product, so filter-param drags stay fluid; live painting on a filtered layer and the destructive "Apply (bake)" stay synchronous for exactness).
- **Progressive preview**: on documents over ~2 MP, filter-param drags compute at **half resolution** (spatial params scaled to match, result upscaled) so the preview tracks the slider closely; the moment the params settle, a full-resolution pass refines it in the background. Exports never contain preview-quality pixels — anything but an exact full-quality cache hit re-renders synchronously at full resolution.
- **GPU tone stage (WebGL2)**: Curves/Levels adjustment layers render through a shader LUT pass when available — the accumulator uploads straight to a texture (no `getImageData`), a 256×1 LUT texture maps each channel to its exact 8-bit bucket, and the result comes back by GPU→GPU `drawImage`. Falls back to the always-correct Canvas2D path on missing WebGL2, unsupported wide-gamut plumbing, or context loss; byte-certain exports always use the CPU path; A/B via `__gqGPU` in dev.
- **Region-scoped adjustment recompute**: when only a rect-bounded change happens beneath an adjustment layer (a brush commit, a heal, an undo patch), the adjustment re-reads and re-processes just that rect and reuses the rest of its cached product — adjustments are strictly per-pixel, so the result is byte-identical. Changes with pixel *reach* (layers carrying effects or smart filters, or inside styled groups) automatically fall back to the safe full-document path.
- **Tiled adjustment products (very large documents)**: once a document is big enough that one full-size cached product rivals the whole cache budget (≥ 64 MB — ~4k×4k, so every 8k+ document), adjustment products are cached as a grid of **1024-px tiles** instead of one giant canvas. Eviction frees individual tiles (exactly the overage, LRU-first) instead of dropping a ~268 MB product wholesale; an evicted or dirty tile is recomputed **alone** from the below-accumulator (the math is strictly per-pixel, so a lone tile is byte-identical to the full pass); and rect-bounded commits — brush strokes, heals, undo patches, and **mask paints on the adjustment itself** — re-render only the touched tiles, with none of the old per-commit full-canvas copy + allocation. GPU tone products are never patched with CPU tiles (sub-LSB seams): any staleness there takes the cheap readback-free full GPU pass and re-slices every tile from that single source. The Preferences ▸ Performance stats show resident tiles.
- Remaining ceiling: *effect* and *smart-filter* recomputation still processes at full document size on a miss — their kernels/offsets spread pixels, so region-scoping them needs padded-region math (deliberately not attempted; correctness first). The same reach is why leaf/group/clip-group products stay whole-canvas rather than tiled.

**Engine ceiling (deliberate, "v2-engine" territory)**
- **8-bit storage.** Layer pixels are Canvas 2D `ImageData` (8-bit per channel); the 16-bit path exists only inside the adjustment pipeline (emulated working spaces), the 32-bit float path only in the HDR merge/tone-map/export flow (the float map lives in memory, not in `.gproj`), and the GPU path only for the tone-LUT stage. Full 16/32-bit storage and compositing remain future tracks.

**Smart Filters (Spec 07 built)**
- Every layer/group can carry a non-destructive, re-editable **smart-filter stack** (Effects menu / Layers panel ▸ Smart Filters…): **Blur** (all nine Blur Gallery types, sharing the same kernel), **Sharpen** (Unsharp Mask), **Noise**, **Pixelate** (Mosaic), **Distort** (Twirl/Pinch/Wave), **Stylize** (Find Edges/Emboss/Posterize/Threshold) — each with enable/reorder/remove, per-filter blend mode + opacity, one-step undo per edit, live document preview, cached via the render graph, serialized in `.gproj` (v7+), and bakeable via "Apply". The old placeholder menu items are now wired. Not included: Liquify (still a stub — it's a warp-mesh tool, out of scope).
- **Filter mask**: every stack can carry one grayscale mask that confines ALL its filters — white shows the filtered result, black keeps the original pixels, gray blends (premultiplied, so soft edges don't tint). Managed in the Smart Filters dialog (Add Mask / From Selection / Enable toggle / Paint / Delete) and shown as a dashed flask chip in the Layers panel (click targets it for painting, Shift-click disables/enables). It's a full paint surface: brush, pencil, eraser, fills, gradients, the blur/dodge/burn brushes and selection fills all work on it, with normal undo/redo. It duplicates with the layer, tracks canvas resizes/rotations/crops, is consumed by "Apply (Bake)", and saves as `filterMaskImage` in `.gproj` **v8** (v7 and older files still open).
- The in-app **documentation is curated by hand** (`app/lib/help.ts`): it describes what actually exists, but it is not generated from code — new features need a matching help entry. The planned **interactive onboarding tour + sample document** (TODO §10) remains future work; Help ▸ Getting started is a written walkthrough, not an overlay tour. **Keyboard Shortcuts** stays generated from the tool/menu registries.

**Roadmap status:** all specs **01–07** (Masks, Adjustment Layers, Layer Effects, Curves & Levels, Clipping Masks, Render Graph, Smart Filters) are implemented.

---

# Appendix — keyboard shortcuts

| Action | Shortcut |
|---|---|
| New / Open / Save / Save As | `Ctrl+Alt+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Export As / Print | `Ctrl+Shift+E` / `Ctrl+P` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Cut / Copy / Paste | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` |
| Free Transform / Transform Selection | `Ctrl+Alt+T` / `Ctrl+Alt+Shift+T` |
| Image Size / Canvas Size | `Ctrl+Alt+I` / `Ctrl+Alt+C` |
| Crop / Trim | `Ctrl+Alt+R` / `Ctrl+Alt+M` |
| Select All / Deselect / Reselect / Inverse | `Ctrl+A` / `Ctrl+D` / `Ctrl+Shift+D` / `Ctrl+Shift+I` |
| Feather | `Shift+F6` |
| New Layer / Group / Merge Down | `Ctrl+Shift+N` / `Ctrl+G` / `Ctrl+E` |
| **Clipping Mask (create/release)** | **`Ctrl+Alt+G`** |
| Cycle marquee shape · constrain 1:1 | `Shift+M` · hold `Shift` |
| Fit / 100% / Pixel Grid | `Ctrl+0` / `Ctrl+1` / `Ctrl+'` |
| Preferences | `Ctrl+,` |
| Tools | `V M L W C I B N E S G R O T P U H Z` |

*Snapshot of the current implementation; the [limitations](#part-3--known-limitations--not-yet-implemented) above are the authoritative list of what is partial or absent.*
