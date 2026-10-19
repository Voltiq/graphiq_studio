# Graphiq Studio

**A full-featured photo editor that runs entirely in your browser — no account, no upload, no server. Your images never leave your computer.**

Graphiq Studio is a from-scratch raster image editor with a non‑destructive layer stack, built on Next.js and React. Every pixel operation — compositing, blend modes, blurs, filters, tone curves, selections, layer effects, even the file encoders — is hand‑written against the HTML `<canvas>` API. There are **no image‑processing libraries** under the hood, and nothing is ever sent over the network: open the page, edit your photos, and everything happens locally.

If you've used Photoshop, you'll feel at home — layers, masks, adjustment layers, clipping masks, smart filters, curves and blend modes all work the way you'd expect, on a desktop, a tablet or a phone.

> **New in 3.0 — a new interface, top to bottom.** Two new palettes (Graphite and Porcelain), the Geist typeface, a grouped tool rail that fits on screen, readouts that float over the picture, and a phone layout rebuilt around the things you reach for. See the [release notes](https://github.com/Voltiq/graphiq_studio/releases) for everything that changed.

---

## Table of contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [The interface](#the-interface)
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
- [Testing](#testing)
- [Project scripts](#project-scripts)
- [Browser support](#browser-support)

---

## Highlights

- 🔒 **100% local & private.** No server, no database, no uploads. Images are processed in your browser and never transmitted anywhere.
- 🧱 **Non‑destructive by design.** Layers, raster and vector masks, adjustment and fill layers, clipping masks, layer effects and smart filters — edit anything, forever, without baking pixels.
- 🖌️ **A deep toolbox** — 29 tools, from brushes, healing and the mixer brush to quick selection, perspective crop, frames, editable text, pen paths and shapes, plus Liquify, Warp and Quick Mask.
- 🎚️ **Real adjustments.** Curves and Levels (per channel, with a live histogram), Hue/Saturation, Selective Color, Channel Mixer, Gradient Map, Color Lookup (`.cube` LUTs), and more.
- 🗂️ **A native project format** (`.gproj`) that round‑trips your entire document — layers, masks, adjustments, effects, text, paths and history labels.
- 📤 **Export anywhere.** PNG, JPEG, WebP, AVIF, TIFF, PDF, PSD (layered), SVG (vector layers), 3D LUT `.cube`, and true‑HDR PNG — with EXIF/XMP metadata, presets, and batch export.
- ⚙️ **Automation.** Record actions (menu commands *and* brush strokes), assign them to F‑keys, and run them across many files in one batch.
- 📱 **Made for touch too.** A dedicated phone layout, a tablet layout with finger‑sized controls, pen pressure and palm rejection — and it installs to your home screen.
- ✍️ **Hand‑written imaging.** No third‑party image libraries — the blend modes, blurs, demosaic (RAW), TIFF/PDF/PSD encoders and everything else are original code.

---

## Quick start

**Requirements:** [Node.js](https://nodejs.org/) 20.9+ and npm. A modern browser (Chrome, Edge, Firefox, or Safari).

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

## The interface

Graphiq Studio picks its layout from the device in front of it — a mouse or a finger, and how much screen there is — before the first frame is drawn.

### On the desktop

- **Top bar** — the menus, a **search** field in the middle (`Ctrl+K`: every command and tool, fuzzy‑matched, so "exp svg" finds Export SVG) and an **Export** button.
- **Options bar** — the current tool's settings. Click any number to type an exact value.
- **Tool rail** — related tools share a button, Photoshop‑style: a small mark in a button's corner means it holds more. Right‑click it, or press and hold, to pick another; each button remembers the last tool you used from it, and every keyboard shortcut still picks its tool directly.
- **Canvas** — the picture sits in a rounded well, with its size and colour space, the cursor position and the save state as small chips floating over its foot, either side of the zoom controls.
- **Docks** — panels on either side of the canvas, as floating cards you can reorder, fold, stack into tabs or float.

### On a phone

- **Header** — the document's name (tap it to switch, create, rename or close documents), Undo, Redo and Export. ☰ opens the menus, with Search as their first row.
- **Stage** — the picture in a rounded pane, with a size · zoom chip at the top: tap it to fit the picture back on screen. Pinch to zoom; press and hold with the eyedropper, pen or clone stamp for a magnifier under your fingertip.
- **Options card** — the tool's settings in a card on the foot of the canvas, open by default. Drag its grip to show more or fewer of them, or tap to fold it; the size is remembered. **Shift**, **Alt** and **Ctrl** sit along its foot as keys: tap to hold one for your next gesture, tap again to lock it.
- **Dock** — a floating glass dock with Move, Select, Brush and Eraser one tap away, plus Pan, **Tools** (every tool as a named tile, grouped by what it is for, with your colours at the top) and **Panels** (one panel at a time, picked from a row of chips).

### On a tablet

The tool rail stays — every tool is one tap away — while the panels open as an overlay from the right, toggled from the top bar, so the canvas keeps the width. Every control is at least 44px for a fingertip.

The look is the same everywhere: **Graphite** (dark) and **Porcelain** (light) themes, seven accent colours, and the **Geist** typeface.

---

## A tour of the features

### Documents & canvas

- Open multiple images as **renamable tabs** — each keeps its own layers, undo history, selection, zoom/pan and colour space.
- **New**, **Open** a `.gproj` project, or **Import** an image (or drop one onto the canvas — onto a selected frame, and it lands inside it).
- **Image Size** (resample — the picture scales) vs **Canvas Size** (reframe — the picture stays put while the frame changes).
- **Rotate** 90° either way, **Flip** horizontal/vertical, **Crop** (aspect presets, a rule‑of‑thirds overlay, straighten — optionally content‑aware — and **perspective** crop), and **Trim** away a uniform border.
- **Guides** and **smart guides** that snap to the canvas and to other layers' edges and centres; rulers in px, in or cm (View ▸ Show rulers).
- Zoom with `Ctrl`+scroll, pan by holding **Space** and dragging, **Fit** with `Ctrl+0`, jump to **100%** with `Ctrl+1`, or hold `H` and drag for a bird's‑eye view of the whole document.
- **Before/after compare** (View ▸ Compare before/after, or hold `\`) shows the picture without your adjustment layers and smart filters.

### Tools

Every tool has a single‑key shortcut — `Shift` plus the key cycles through the tools that share it — and its own settings in the options bar. On the desktop rail, tools that share a job share a button:

| Rail button | Tools | Keys |
|---|---|---|
| **Move** | Move — with auto‑select, align & distribute, and on‑canvas transform controls | `V` |
| **Marquee** | Rectangle / ellipse / triangle selections (hold `Shift` for 1:1) | `M` |
| **Lasso** | Freehand, polygonal, or **magnetic** (snaps to edges) | `L` |
| **Magic wand** | Magic wand (select by colour) · **Quick selection** (a selection brush that stops at edges) | `W` |
| **Crop** | Crop (with straighten and perspective) · **Frame** (a window that clips what you place in it) | `C` · `K` |
| **Eyedropper** | Eyedropper (with colour samplers) · **Measure** (distance and angle; straighten from a line) | `I` |
| **Brush** | Brush · Pencil · **Mixer brush** (wet paint that picks up what it is dragged through) | `B` · `N` · `B` |
| **Eraser** | Eraser (optionally *Erase to History*) | `E` |
| **Spot heal** | Spot heal · Red eye · Clone stamp · **History brush** | `J` · `Y` · `S` · `K` |
| **Gradient** | Gradient (linear/radial/angle/reflected, noise gradients, an on‑canvas control) · Paint bucket | `G` |
| **Blur** | Blur · Smudge · Dodge/Burn · Sponge | `R` · `F` · `O` · `A` |
| **Text** | WYSIWYG type with rich runs, warp, gradient fill, type effects and text on a path — always re‑editable | `T` |
| **Pen** | Pen (Bézier paths) · **Direct selection** (reshape a path's points and handles) | `P` · `A` |
| **Shape** | Rectangle, ellipse, triangle, trapezoid, star and custom shapes (import your own SVG), kept as editable vectors | `U` |
| **Hand** | Hand (pan) · Zoom | `H` · `Z` |

Brush‑style tools share `[` / `]` for size, `{` / `}` for hardness and the digit keys for strength or opacity; **Alt + right‑drag** sets size and hardness right on the canvas. Brushes have angle, roundness, scatter, texture and dual tips, pen pressure, and savable presets in the **Brushes** panel. Your tool settings and foreground/background colours are remembered between sessions.

### Selections

- **Add** to a selection with `Ctrl`, **subtract** with `Alt` while you drag. Every selection you make with a tool is a step in History, so it can be undone.
- Select **All** (`Ctrl+A`), **Deselect** (`Ctrl+D`), **Reselect** (`Ctrl+Shift+D`), **Inverse** (`Ctrl+Shift+I`), plus **Feather**, **Grow**, **Border**, **Smooth**, **Expand** and **Contract**.
- **Quick Mask** (`Q`) — paint a selection with any tool; a soft brush gives a soft edge, and soft edges are kept through fills, masks, Inverse and saved channels.
- **Refine edge** — smooth, feather, contrast and shift an edge against white, black or a red overlay, with **Decontaminate** to remove the old background's colour fringe.
- **Save & load selections** as named channels that live in the document.
- **Free Transform** (`Ctrl+Alt+T`) scales/rotates the pixels; **Transform Selection** does the same to just the outline — both with handles, a rotation ring and a movable pivot, or by typing X, Y, W, H and angle in the options bar.
- **Content‑Aware Fill** (`Shift+F5`) fills a selection with texture synthesised from its surroundings.

### Layers

- A **tree** of pixel layers, nestable **groups**, **adjustment layers** and **fill layers** (solid colour or gradient).
- **19 blend modes**, per‑layer opacity, visibility, drag‑to‑reorder (including re‑parenting into groups), multi‑select, and inline rename.
- **Colour labels**, a **search/filter** row, **lock** flags (transparency, pixels, position, all) and **linked layers** that move as one.
- New / Duplicate / Delete / **Group** (`Ctrl+G`) / Ungroup / **Merge Down** (`Ctrl+E`) / **Merge visible** / **Stamp visible** (`Ctrl+Alt+Shift+E`) / Flatten.
- **Isolate** a layer (`Ctrl+Alt+L`) to work on it alone, and save whole arrangements as **Layer Comps**.

### Non‑destructive editing

This is the heart of Graphiq Studio — nothing here bakes into pixels until you ask it to.

- **Layer masks** — paint black to hide, white to reveal, grey for partial. Every paint tool works on a mask, and you can Alt‑click a mask thumbnail to view it on the canvas. **Vector masks** keep a crisp, re‑editable path edge, and can sit alongside a painted one.
- **Adjustment layers** — Curves, Levels, Hue/Saturation, Gradient Map and more re‑process everything beneath them and stay editable forever.
- **Clipping masks** (`Ctrl+Alt+G`) — clip a layer to the shape of the one below (it even reaches through adjustment layers, Photoshop‑style).
- **Layer effects** — Drop Shadow, Inner Shadow, Outer/Inner Glow, **Stroke** (solid or a full gradient), Colour Overlay, Gradient Overlay, and Bevel & Emboss, rendered live from the layer's silhouette — with **global light**, **fill opacity**, **knockout** and a library of **style presets**.
- **Smart filters** — a per‑layer, re‑editable stack of filters with per‑filter blend/opacity, a filter mask and drag‑to‑reorder.

### Adjustments & filters

- **Curves** — a monotone‑cubic spline over a live histogram, per channel, with presets.
- **Levels** — draggable black/gamma/white sliders, Auto, and black/grey/white eyedroppers.
- **More kinds** — Hue/Saturation (with per‑range targeting), Selective Color, Gradient Map, Channel Mixer, Color Lookup (imports a 3D `.cube` LUT), Invert and Equalize.
- **Filters** — blurs (including a blur gallery), sharpen, noise, pixelate, distort and stylize, plus **High Pass**, **Median**, **Dust & Scratches**, **Reduce Noise**, **Dehaze**, **Clarity & Texture**, film **Grain**, **Lens Corrections**, **Oil Paint**, **Halftone**, **Crystallize** and **Glitch** — each previewed on your own layer before you pick it.
- **Liquify** (`Ctrl+Shift+X`) and **Warp / Perspective Warp** reshape a layer.
- **Adjustments panel** for quick, live Light/Colour/Detail tweaks, plus built‑in and savable filter presets.
- **Export your grade as a `.cube` LUT** to reuse in other software.

### Colour management & depth

- Working spaces: **sRGB**, **Display P3** (on supporting browsers), and an emulated **Adobe RGB (1998)** — and a project remembers the space it was made in.
- **Soft proofing** (`Ctrl+Alt+Y`) and **gamut warning** (`Ctrl+Alt+Shift+Y`).
- **ICC profiles** on import — convert or assign.
- A **16‑bit/channel** path for adjustments, and a **32‑bit float HDR** pipeline (Merge to HDR → tone map → export true HDR PNG in PQ or HLG).

### Importing & exporting

**Import:** PNG · JPEG · WebP · AVIF · GIF (animated GIF, APNG and animated WebP open one layer per frame) · BMP · **TIFF** (hand‑written decoder) · **HEIF/HEIC** (where the browser supports it) · **SVG** (as editable vector layers) · **PSD** (layered) · **RAW/DNG** (a develop dialog for exposure and white balance, then a true demosaic with the camera matrix).

**Export:**

| Format | Notes |
|---|---|
| PNG / JPEG / WebP / AVIF | With quality, scale, transparency/matte, and a **live file‑size estimate** that actually encodes. |
| **TIFF** | 8‑ or 16‑bit, Deflate‑compressed. |
| **PDF** | Single page, image‑size or paper size (A4/Letter/…) with margins. |
| **PSD** | Layered — groups, masks, blend modes and clipping survive. |
| **SVG** | Vector and text layers exported as real vectors (gradient‑filled text included). |
| **`.cube` LUT** | Your colour grade as a 3D lookup table. |
| **HDR PNG** | True Rec.2100 (PQ/HLG) 16‑bit. |
| **Frames** | Every layer as a numbered PNG, in a zip. |

- **EXIF + XMP metadata** is embedded on export (editable in the Metadata panel; default attribution in Preferences).
- **Export presets** and a **batch export** that zips several sizes/formats at once with filename templates.
- **Print setup** (`Ctrl+P`) — paper, orientation and margins, fit to the page or print at true size for the document's resolution, optionally with the soft proof baked in.

### Automation

- **Actions** — record a sequence of menu commands *and* brush/pencil/eraser strokes into a named macro, replay it in one click or with an assigned F‑key (F2–F10).
- **Batch processing** (File ▸ Batch process) — run a saved action and/or an export preset over many dropped files; results download as one zip.

### Panels & workspace

- 14 panels: Navigator · Channels · Color · Swatches · Brushes · Adjustments · Properties · Layers · Paths · Layer Comps · History · Actions · Metadata · Info.
- Arrange them across **two docks**, **stack them as tabs**, **float** any panel over the canvas, and save named **workspaces** (Window ▸ Workspaces). **Window ▸ Reset workspace** brings back the default.
- **History** with snapshots, non‑linear branches, a memory budget, and the log of earlier sessions read back from the project file.
- **Channels** with R/G/B + luminosity histograms, clipping warnings, and per‑selection histograms; **Info** reads the colour under the pointer and up to ten pinned colour samplers.
- **Swatches** with colour groups, palette extraction from an image, and import/export of `.gse`/`.gco`/`.gpl`/JSON.

### Preferences

Light, dark or match‑system themes and seven accent colours, an adjustable **interface scale**, transparency‑grid and document‑grid appearance, cursor style, units & rulers, autosave, export defaults, performance/cache tuning, and a storage manager — all under **Preferences** (`Ctrl+,`). **Accessibility** adds colour‑vision palettes (protanopia, deuteranopia, tritanopia, monochromacy) and high contrast; **Touch & pen** sets the pressure curve, with a test pad. Everything can be exported/imported as JSON or reset to defaults.

---

## Keyboard shortcuts

A searchable, **remappable** shortcut list lives in **Settings ▸ Keyboard shortcuts**. The essentials:

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
| Feather / Quick Mask | `Shift+F6` / `Q` |
| New Layer / Group / Merge Down / Stamp Visible | `Ctrl+Shift+N` / `Ctrl+G` / `Ctrl+E` / `Ctrl+Alt+Shift+E` |
| Clipping mask (create/release) / Isolate | `Ctrl+Alt+G` / `Ctrl+Alt+L` |
| Liquify | `Ctrl+Shift+X` |
| Search (command palette) | `Ctrl+K` |
| Fit / 100% / Pixel Grid | `Ctrl+0` / `Ctrl+1` / `Ctrl+'` |
| Show / Lock guides | `Ctrl+;` / `Ctrl+Alt+;` |
| Preferences | `Ctrl+,` |
| Tools | `V M L W C K I B N E J Y S G R F O A T P U H Z` |

---

## Your files & your privacy

- **Nothing is uploaded, ever.** Graphiq Studio has no backend. All editing happens in your browser's memory and on `<canvas>`.
- **`.gproj` projects** save your entire document — layers, groups, masks, adjustment layers, styles, smart filters, selection, paths, guides, comps and history labels — and open right back up in the colour space they were made in. (Older `.aproj` files still open.)
- **Autosave** snapshots your open documents locally on an interval and whenever the tab is hidden; if the tab closes unexpectedly, you'll be offered a restore on the next launch. If the app itself ever crashes, it offers a recovery copy of every open document.
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

- **Next.js 16** (App Router) · **React 19** (with the React Compiler) · **TypeScript** (strict) · **SCSS modules** · `lucide-react` icons · **Geist** and **Geist Mono** (self‑hosted).
- **A token‑based design system.** Colours, type, spacing, radii, shadows and motion are CSS custom properties in `app/globals.scss`, and the shared components (cards, buttons, fields, sliders, switches, segmented controls, menus) are SCSS mixins in `app/styles/_ds.scss` — so the themes, accents, high‑contrast mode and colour‑vision palettes are a change of tokens, not of components.
- **No image‑processing libraries.** All compositing, blending, blurs, filters, tone curves, selections, layer effects, history, and the TIFF/PDF/PSD/HDR/LUT encoders are hand‑written against Canvas 2D and `ImageData`.
- A **render‑graph cache** keeps composited layer products in memory so unchanged parts of a document never recompute.
- Heavy work (blur gallery, smart filters, healing, RAW decode) runs in **web workers** with synchronous fallbacks.

For a deep, no‑code‑required explanation of exactly what exists and how it works, see [`FEATURES.md`](./FEATURES.md).

---

## Testing

Unit tests (Vitest) cover the dependency‑free imaging libraries — tone curves, filters, gradients, the render cache and the layer tree:

```bash
npm test           # once
npm run test:watch # on save
npm run check      # generate Next's types, type-check, and run the unit tests
```

The browser tests (Playwright, `e2e/`) drive a real browser through the desktop, tablet and phone layouts. Among them are the pixel‑identity check (`e2e/pixel-identity.spec.ts`), which renders a fixture document twice after every stage — with the render cache on and off — and requires the results to be byte‑identical, and the layer‑effect goldens (`e2e/golden-effects.spec.ts`, re‑recorded with `GQ_UPDATE_GOLDENS=1`):

```bash
npm run test:e2e   # reuses the dev server on :3000, or starts one
GQ_URL=http://host:port npm run test:e2e   # drive a server you started elsewhere
npm run perf       # interaction budgets
npm run bench      # filter throughput + composite cost, tracked run to run
```

---

## Project scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the development server at `localhost:3000`. |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. |
| `npm run lint` | Run ESLint (no warnings allowed). |
| `npm run check` | Generate Next's types, type‑check, and run the unit tests. |
| `npm test` | Run the unit tests (Vitest). |
| `npm run test:e2e` | Browser tests (Playwright Test, `e2e/`). |
| `npm run perf` / `npm run bench` | Interaction budgets / throughput benchmarks. |

---

## Browser support

Graphiq Studio targets modern evergreen browsers (Chrome, Edge, Firefox, Safari) on desktop, tablet and phone. Some capabilities depend on the browser:

- **WebP/AVIF export** and **Display P3** appear only where the browser supports them.
- **HEIF/HEIC import** works where the browser ships the codec (Safari does; most others don't) — the app tells you when it can't decode one.
- **APNG and animated WebP** open frame by frame where the browser has WebCodecs (Chrome, Edge); elsewhere you get the first frame and a message saying so.
- **System fonts** can be added to the font picker on Chrome and Edge.
- **HDR PNG** highlights glow on displays that report HDR headroom.

Everything degrades gracefully — unsupported options are hidden or fall back rather than breaking.

---

*Graphiq Studio is a client‑side project. Your photos stay yours.*
