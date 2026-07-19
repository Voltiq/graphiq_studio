# Graphiq Studio

**A full-featured photo editor that runs entirely in your browser — no account, no upload, no server. Your images never leave your computer.**

Graphiq Studio is a from-scratch raster image editor with a non‑destructive layer stack, built on Next.js and React. Every pixel operation — compositing, blend modes, blurs, filters, tone curves, selections, layer effects, even the file encoders — is hand‑written against the HTML `<canvas>` API. There are **no image‑processing libraries** under the hood, and nothing is ever sent over the network: open the page, edit your photos, and everything happens locally.

If you've used Photoshop, you'll feel at home — layers, masks, adjustment layers, clipping masks, smart filters, curves, and blend modes all work the way you'd expect.

---

## Table of contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [A tour of the features](#a-tour-of-the-features)
  - [Documents & canvas](#documents--canvas)
  - [Tools](#tools)
  - [Selections](#selections)
  - [Layers](#layers)
  - [Non‑destructive editing](#non-destructive-editing)
  - [Adjustments & filters](#adjustments--filters)
  - [Colour management & depth](#colour-management--depth)
  - [Importing & exporting](#importing--exporting)
  - [Automation](#automation)
  - [Panels & workspace](#panels--workspace)
  - [Preferences](#preferences)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Your files & your privacy](#your-files--your-privacy)
- [Scripting (power users)](#scripting-power-users)
- [Tech stack & architecture](#tech-stack--architecture)
- [Project scripts](#project-scripts)
- [Browser support](#browser-support)

---

## Highlights

- 🔒 **100% local & private.** No server, no database, no uploads. Images are processed in your browser and never transmitted anywhere.
- 🧱 **Non‑destructive by design.** Layers, layer masks, adjustment layers, clipping masks, layer effects, and smart filters — edit anything, forever, without baking pixels.
- 🖌️ **A deep toolbox** — brush/pencil/eraser, clone stamp, spot heal, red‑eye, magnetic lasso, pen paths, editable text and shapes, gradient, dodge/burn, and blur.
- 🎚️ **Real adjustments.** Curves and Levels (per channel, with a live histogram), Hue/Saturation, Selective Color, Channel Mixer, Gradient Map, Color Lookup (`.cube` LUTs), and more.
- 🗂️ **A native project format** (`.gproj`) that round‑trips your entire document — layers, masks, adjustments, effects, text, paths and history labels.
- 📤 **Export anywhere.** PNG, JPEG, WebP, AVIF, TIFF, PDF, PSD (layered), SVG (vector layers), 3D LUT `.cube`, and true‑HDR PNG — with EXIF/XMP metadata, presets, and batch export.
- ⚙️ **Automation.** Record actions (menu commands *and* brush strokes), assign them to F‑keys, and run them across many files in one batch.
- ✍️ **Hand‑written imaging.** No third‑party image libraries — the blend modes, blurs, demosaic (RAW), TIFF/PDF/PSD encoders and everything else are original code.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org/) 18+ and npm. A modern browser (Chrome, Edge, Firefox, or Safari).

```bash
# 1. Install dependencies
npm install

# 2. Start the development server
npm run dev
```

Then open **[http://localhost:3000](http://localhost:3000)** in your browser.

On first launch you'll be greeted by a short **interactive tour** of the workspace, and you can open a **sample document** (Help ▸ Open sample document) to experiment on real layers straight away. To edit your own photo, drag an image file onto the canvas or use **File ▸ Import**.

For a production build:

```bash
npm run build
npm start
```

---

## A tour of the features

### Documents & canvas

- Open multiple images as **renamable tabs** — each keeps its own layers, undo history, selection, zoom/pan and colour space.
- **New**, **Open** a `.gproj` project, or **Import** an image.
- **Image Size** (resample — the picture scales) vs **Canvas Size** (reframe — the picture stays put while the frame changes).
- **Rotate** 90° either way, **Flip** horizontal/vertical, **Crop** (with aspect presets, a rule‑of‑thirds overlay, straighten and shield), and **Trim** away a uniform border.
- Zoom with `Ctrl`+scroll, pan by holding **Space** and dragging, **Fit** with `Ctrl+0`, jump to **100%** with `Ctrl+1`.

### Tools

Every tool has a single‑key shortcut and its own settings in the options bar (click any numeric readout to type an exact value):

| Tool | Key | What it does |
|---|---|---|
| **Move** | `V` | Move a layer's pixels or a floating selection. |
| **Marquee** | `M` | Rectangle / ellipse / triangle selections (`Shift+M` cycles; hold `Shift` for 1:1). |
| **Lasso** | `L` | Freehand, polygonal, or **magnetic** (snaps to edges from a distance). |
| **Magic Wand** | `W` | Select by colour — contiguous or global, with tolerance. |
| **Crop** | `C` | Aspect presets, grid overlay, straighten, shield. |
| **Eyedropper** | `I` | Sample a colour (configurable sample radius). |
| **Brush / Pencil / Eraser** | `B` / `N` / `E` | Size, hardness, opacity, flow, smoothing and blend mode. |
| **Clone Stamp** | `S` | Alt‑click to set a source, then paint sampled pixels. |
| **Spot Heal** | `J` | Paint over a blemish; it heals seamlessly on release. |
| **Red Eye** | `Y` | One click removes flash red‑eye while keeping the catchlight. |
| **Paint Bucket** | `G` | Flood fill with tolerance, contiguity and anti‑alias. |
| **Gradient** | `G` | Linear/radial/angle/reflected, with a draggable on‑canvas control and multi‑stop editor. |
| **Blur** | `R` | A blur brush with a live on‑canvas ring cursor. |
| **Dodge / Burn** | `O` | Lighten/darken by tonal range and exposure. |
| **Text** | `T` | WYSIWYG editing with rich runs (per‑character font, size, colour, bold/italic), paragraph alignment, tracking and leading — stays re‑editable. |
| **Pen** | `P` | Bézier paths with handles; stroke or fill them. |
| **Shape** | `U` | Rectangle / ellipse / triangle / trapezoid, kept as editable vectors. |
| **Hand / Zoom** | `H` / `Z` | Pan / zoom. |

Your tool settings and foreground/background colours are remembered between sessions.

### Selections

- **Add** to a selection with `Ctrl`, **subtract** with `Alt` while you drag.
- Select **All** (`Ctrl+A`), **Deselect** (`Ctrl+D`), **Reselect** (`Ctrl+Shift+D`), **Inverse** (`Ctrl+Shift+I`), plus **Feather** and **Grow**.
- **Free Transform** (`Ctrl+Alt+T`) scales/rotates the pixels; **Transform Selection** does the same to just the outline — both with handles, a rotation ring and a movable pivot.
- **Content‑Aware Fill** (`Shift+F5`) fills a selection with texture synthesised from its surroundings.
- Nudge a selection (or, with the Move tool, the pixels) with the arrow keys — a rapid burst collapses into one undo step.

### Layers

- A **tree** of pixel layers, nestable **groups**, and pixel‑less **adjustment layers**.
- **19 blend modes**, per‑layer opacity, visibility, drag‑to‑reorder (including re‑parenting into groups), multi‑select, and inline rename.
- **Colour labels** (seven colours) and a **search/filter** row to find layers by name, kind or label.
- New / Duplicate / Delete / **Group** (`Ctrl+G`) / Ungroup / **Merge Down** (`Ctrl+E`) / Flatten.

### Non‑destructive editing

This is the heart of Graphiq Studio — nothing here bakes into pixels until you ask it to.

- **Layer masks** — paint black to hide, white to reveal, grey for partial. Every paint tool works on a mask, and you can Alt‑click a mask thumbnail to view it on the canvas. Filter masks confine a smart‑filter stack.
- **Adjustment layers** — Curves, Levels, Hue/Saturation, Gradient Map and more re‑process everything beneath them and stay editable forever.
- **Clipping masks** (`Ctrl+Alt+G`) — clip a layer to the shape of the one below (it even reaches through adjustment layers, Photoshop‑style).
- **Layer effects** — Drop Shadow, Inner Shadow, Outer/Inner Glow, **Stroke** (solid or a full gradient), Colour Overlay, Gradient Overlay, and Bevel & Emboss, all rendered live from the layer's silhouette.
- **Smart filters** — a per‑layer, re‑editable stack of Blur, Sharpen, Noise, Pixelate, Distort and Stylize, with per‑filter blend/opacity and drag‑to‑reorder.

### Adjustments & filters

- **Curves** — a monotone‑cubic spline over a live histogram, per channel, with presets.
- **Levels** — draggable black/gamma/white sliders, Auto, and black/grey/white eyedroppers.
- **More kinds** — Hue/Saturation (with per‑range targeting), Selective Color, Gradient Map, Channel Mixer, Color Lookup (imports a 3D `.cube` LUT), Invert and Equalize.
- **Adjustments panel** for quick, live Light/Colour/Detail tweaks, plus built‑in and savable filter presets.
- **Export your grade as a `.cube` LUT** to reuse in other software.

### Colour management & depth

- Working spaces: **sRGB**, **Display P3** (on supporting browsers), and an emulated **Adobe RGB (1998)**.
- **Soft proofing** (`Ctrl+Alt+Y`) and **gamut warning** (`Ctrl+Alt+Shift+Y`).
- **ICC profiles** on import — convert or assign.
- A **16‑bit/channel** path for adjustments, and a **32‑bit float HDR** pipeline (Merge to HDR → tone map → export true HDR PNG in PQ or HLG).

### Importing & exporting

**Import:** PNG · JPEG · WebP · AVIF · GIF · BMP · **TIFF** (hand‑written decoder) · **HEIF/HEIC** (where the browser supports it) · **SVG** (as editable vector layers) · **PSD** (layered) · **RAW/DNG** (true develop — demosaic, white balance, camera matrix).

**Export:**

| Format | Notes |
|---|---|
| PNG / JPEG / WebP / AVIF | With quality, scale, transparency/matte, and a **live file‑size estimate** that actually encodes. |
| **TIFF** | 8‑ or 16‑bit, Deflate‑compressed. |
| **PDF** | Single page, image‑size or paper size (A4/Letter/…) with margins. |
| **PSD** | Layered — groups, masks, blend modes and clipping survive. |
| **SVG** | Vector/text layers exported as real vectors. |
| **`.cube` LUT** | Your colour grade as a 3D lookup table. |
| **HDR PNG** | True Rec.2100 (PQ/HLG) 16‑bit. |

- **EXIF + XMP metadata** is embedded on export (editable in the Metadata panel; default attribution in Preferences).
- **Export presets** and a **batch export** that zips several sizes/formats at once with filename templates.

### Automation

- **Actions** — record a sequence of menu commands *and* brush/pencil/eraser strokes into a named macro, replay it in one click or with an assigned F‑key (F2–F10).
- **Batch processing** (File ▸ Batch process) — run a saved action and/or an export preset over many dropped files; results download as one zip.

### Panels & workspace

- Panels: Color · Swatches · Adjustments · Properties · Layers · Paths · History · Actions · Navigator · Channels · Metadata.
- Arrange them across **two docks**, **float** any panel over the canvas, and save named **workspaces** (Window ▸ Workspaces).
- A **command palette** (`Ctrl+K`) fuzzy‑searches every tool and menu command.
- **Channels panel** with R/G/B + luminosity histograms, clipping warnings, and per‑selection histograms.
- **Swatches** with colour groups, palette extraction from an image, and import/export of `.gse`/`.gco`/`.gpl`/JSON.

### Preferences

Themes (light/dark/system) and six accent colours, an adjustable **interface scale**, transparency‑grid and document‑grid appearance, cursor style, units & rulers, autosave, export defaults, performance/cache tuning, and a storage manager — all under **Preferences** (`Ctrl+,`). Everything can be exported/imported as JSON or reset to defaults.

---

## Keyboard shortcuts

A searchable, **remappable** shortcut list lives in Settings ▸ Keyboard shortcuts. The essentials:

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
| New Layer / Group / Merge Down | `Ctrl+Shift+N` / `Ctrl+G` / `Ctrl+E` |
| Clipping mask (create/release) | `Ctrl+Alt+G` |
| Command palette | `Ctrl+K` |
| Fit / 100% / Pixel Grid | `Ctrl+0` / `Ctrl+1` / `Ctrl+'` |
| Preferences | `Ctrl+,` |
| Tools | `V M L W C I B N E S G R O T P U H Z` |

---

## Your files & your privacy

- **Nothing is uploaded, ever.** Graphiq Studio has no backend. All editing happens in your browser's memory and on `<canvas>`.
- **`.gproj` projects** save your entire document — layers, groups, masks, adjustment layers, styles, smart filters, selection, paths and history labels — and open right back up. (Older `.aproj` files still open.)
- **Autosave** snapshots your open documents locally on an interval; if the tab closes unexpectedly, you'll be offered a restore on the next launch.
- Recent files, saved swatches, gradients, presets and preferences are stored in your browser's local storage — you can review and clear them in **Preferences ▸ Storage**.

---

## Scripting (power users)

Open your browser's developer console and type `graphiq.help()`. A safe, curated `window.graphiq` API lets you list/switch documents, run any menu command, read and tweak layers, play saved actions, and export the composite as PNG — all through the same undoable paths the UI uses. Example:

```js
await graphiq.play("My action");
await graphiq.download("result.png");
```

---

## Tech stack & architecture

- **Next.js 16** (App Router) · **React 19** (with the React Compiler) · **TypeScript** (strict) · **SCSS modules** · `lucide-react` icons.
- **No image‑processing libraries.** All compositing, blending, blurs, filters, tone curves, selections, layer effects, history, and the TIFF/PDF/PSD/HDR/LUT encoders are hand‑written against Canvas 2D and `ImageData`.
- A **render‑graph cache** keeps composited layer products in memory so unchanged parts of a document never recompute.
- Heavy work (blur gallery, smart filters, healing, RAW decode) runs in **web workers** with synchronous fallbacks.

For a deep, no‑code‑required explanation of exactly what exists and how it works, see [`FEATURES.md`](./FEATURES.md).

---

## Project scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the development server at `localhost:3000`. |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. |
| `npm run check` | Type‑check with `tsc --noEmit`. |
| `npm run lint` | Run ESLint. |

---

## Browser support

Graphiq Studio targets modern evergreen browsers (Chrome, Edge, Firefox, Safari). Some capabilities depend on the browser:

- **WebP/AVIF export** and **Display P3** appear only where the browser supports them.
- **HEIF/HEIC import** works where the browser ships the codec (Safari does; most others don't) — the app tells you when it can't decode one.
- **HDR PNG** highlights glow on displays that report HDR headroom.

Everything degrades gracefully — unsupported options are hidden or fall back rather than breaking.

---

*Graphiq Studio is a client‑side project. Your photos stay yours.*
