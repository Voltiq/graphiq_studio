// In-app documentation content (Help ▸ Getting started / Documentation).
//
// Pure data — the HelpDialog renders and searches it. Every claim here should
// describe something the app actually does; when a feature changes, update the
// matching entry (grep the feature name). Keys shown as chips use the same
// notation as the menus ("Ctrl+X", "Shift+L").

/** One documentation entry: a bolded title, a sentence or two of body, and an
 *  optional shortcut chip. */
export interface HelpEntry {
  title: string;
  body: string;
  keys?: string;
}

export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

/** A reference topic (one nav item in the Help window). */
export interface HelpTopic {
  id: string;
  label: string;
  intro?: string;
  sections: HelpSection[];
}

/** The ordered quick-start walkthrough (Help ▸ Getting started). */
export const GUIDE: HelpEntry[] = [
  {
    title: "Create or open a document",
    body: "File ▸ New starts a blank canvas (size and resolution are yours to set). Open reads a .gproj project with every layer intact; Import brings in PNG/JPEG/WebP/AVIF images, SVG (as editable vector layers), layered PSD files, and camera raw (DNG is truly developed; other raw formats open their embedded preview). Pasting an image from the clipboard works too.",
    keys: "Ctrl+Alt+N",
  },
  {
    title: "Get around the canvas",
    body: "Zoom at the cursor with Ctrl+Wheel; the wheel pans vertically and Shift+Wheel horizontally. Fit on screen with Ctrl+0, actual pixels with Ctrl+1. The Navigator panel drags the view directly, and every document keeps its own zoom and pan.",
    keys: "Ctrl+Wheel",
  },
  {
    title: "Paint with the brush engine",
    body: "B is the soft brush, N the pixel-perfect pencil, E the eraser. The options bar tunes size, hardness, opacity, flow, blend mode and stroke smoothing. X swaps the two colours; right-drag paints with the secondary colour.",
    keys: "B",
  },
  {
    title: "Select, move, transform",
    body: "M draws marquees (Shift+M cycles rectangle/ellipse/triangle), L is the lasso (Shift+L cycles freehand/polygonal/magnetic), W selects by colour (Shift+W cycles wand/quick selection), Q paints one as a red Quick Mask. Hold Ctrl to add and Alt to subtract while dragging. V moves layers or the selected pixels; Free transform scales and rotates them.",
    keys: "Ctrl+Alt+T",
  },
  {
    title: "Build with layers",
    body: "The Layers panel stacks pixel layers, groups and adjustment layers with per-layer blend mode and opacity. Drag rows to reorder, double-click a name to rename, Ctrl+G groups the selection. Add a mask and paint it black to hide, white to reveal; Alt-click a row to clip it to the layer below.",
    keys: "Ctrl+G",
  },
  {
    title: "Edit non-destructively",
    body: "Adjustment layers (Curves, Levels, Hue/Saturation, Gradient Map and more) re-process everything beneath them and stay editable forever. Smart filters do the same for blur, sharpen, noise, pixelate, distort and stylize on a single layer or group. Layer styles add shadows, glows, strokes, overlays and bevels from the layer's silhouette.",
  },
  {
    title: "Save your work, export a picture",
    body: "Ctrl+S saves a .gproj project — layers, masks, adjustments, styles and filters all round-trip. Export As encodes PNG/JPEG/WebP/AVIF with a live file-size estimate, reusable presets and a Batch mode that zips several sizes at once. Autosave snapshots every open document, and an unclean exit offers to restore them on the next launch.",
    keys: "Ctrl+Shift+E",
  },
];

export const TOPICS: HelpTopic[] = [
  {
    id: "tools",
    label: "Tools",
    intro: "Every tool lives on the left rail; its settings appear in the options bar. Single letters activate tools (shown in each tooltip).",
    sections: [
      {
        title: "Select & frame",
        entries: [
          { title: "Move", body: "Drags the active layer, or just the selected pixels when a selection exists. Arrows nudge (Ctrl+Arrows by 10 px); a mode switch moves the outline only.", keys: "V" },
          { title: "Marquee", body: "Rectangle, ellipse or triangle regions — Shift constrains to 1:1, Shift+M cycles the shape. Handles resize the outline or scale its content.", keys: "M" },
          { title: "Lasso", body: "Freehand drag, polygonal click-to-drop-vertices (Enter closes, Backspace undoes a point), or magnetic edge-snapping. Shift+L cycles the mode.", keys: "L" },
          { title: "Magic wand / Quick selection", body: "The wand selects similar colour with a live tolerance slider (contiguous limits to the connected region, sample-all reads the composite instead of the layer); Quick selection grows a region as you paint over it. They share W — Shift+W cycles between them, as it does for any letter two tools share.", keys: "W" },
          { title: "Crop", body: "Ratio presets or free, rule-of-thirds/grid/golden overlays, a darkening shield, and a straighten angle that levels the image as it crops.", keys: "C" },
          { title: "Eyedropper", body: "Picks a colour — point sample or 3×3/5×5/11×11 average, from the active layer or every layer.", keys: "I" },
        ],
      },
      {
        title: "Paint & retouch",
        entries: [
          { title: "Brush / Pencil / Eraser", body: "One brush engine: size, hardness, opacity, flow, blend mode, smoothing. The pencil is always hard-edged and pixel-exact; the eraser removes to transparency.", keys: "B / N / E" },
          { title: "Pen pressure", body: "With a stylus, pressure drives the brush: the pen button in the options bar chooses whether it controls Size, Flow or both, and the Minimum sets what the lightest touch still puts down. The response curve (Soft / Linear / Firm) and a live test pad are in Preferences ▸ Touch & pen. Opacity is deliberately not pressure-driven — it is the whole-stroke ceiling, so per-dab paint is what Flow means. A mouse always paints at full strength." },
          { title: "Paint cursor", body: "Preferences ▸ Cursors switches the brush-family cursor between the size ring (with a dashed hardness preview and an optional centre crosshair) and a precise crosshair, and recolours it — a dark under-stroke keeps it readable on any pixels." },
          { title: "Clone stamp", body: "Alt-click sets the source, then paint copies from it. Aligned keeps the source offset across strokes; sample-all clones from the composite.", keys: "S" },
          { title: "Spot heal", body: "Paint over a blemish — on release it fills with matching texture from the surroundings, tone-blended so no seam shows.", keys: "J" },
          { title: "Red eye", body: "One click on a flash-red pupil neutralizes and darkens it; the blob is found automatically around the click.", keys: "Y" },
          { title: "Paint bucket", body: "Flood-fills by colour similarity with optional anti-aliased edges — tolerance stays live-editable until you commit.", keys: "G" },
          { title: "Gradient", body: "Linear, radial, angle or reflected; drag to place, then re-drag the endpoints and midpoint live. Stops are editable and saveable as presets. Noise gradients build the ramp from a seed instead: Randomize until you like one, and Roughness takes it from a soft wash to hard stripes. Shares G with the bucket — Shift+G cycles.", keys: "G" },
          { title: "Blur brush", body: "Softens where you paint (strength and kernel radius in the options bar); can sample all layers.", keys: "R" },
          { title: "Dodge / Burn", body: "Lightens or darkens, targeted at shadows, midtones or highlights, with a protect-tones mode that preserves hue.", keys: "O" },
        ],
      },
      {
        title: "Text, vector & view",
        entries: [
          { title: "Text", body: "Click for point text or drag a box for wrapped paragraph text. Selections inside the editor can mix fonts, sizes, colours, bold/italic/underline, all-caps and baseline shift. The font control searches and previews every face.", keys: "T" },
          { title: "Pen", body: "Click-drag bezier anchors into a path, then stroke it with variable width — taper the ends, widen or narrow on curves. Enter commits.", keys: "P" },
          { title: "Shape", body: "Rectangle, ellipse, triangle, trapezoid — live handles adjust corner radius, apex and side insets until you commit. Fill and stroke stay editable.", keys: "U" },
          { title: "Hand / Zoom", body: "Pan by dragging; zoom clicks in, Alt-click zooms out.", keys: "H / Z" },
        ],
      },
    ],
  },
  {
    id: "selections",
    label: "Selections",
    sections: [
      {
        title: "Making & combining",
        entries: [
          { title: "Add and subtract", body: "Hold Ctrl while dragging any selection tool to add to the existing selection, Alt to subtract from it. The wand honours the same modifiers." },
          { title: "Select all / deselect / reselect", body: "Ctrl+A selects the canvas, Ctrl+D drops the selection, Ctrl+Shift+D brings the last one back, Ctrl+Shift+I inverts." },
          { title: "Feather & grow", body: "Select ▸ Feather softens the selection edge by a radius (fills, deletes and adjustments respect it); Grow expands the region.", keys: "Shift+F6" },
          { title: "Quick Mask", body: "Paint a selection instead of dragging one. Q shades everything unselected in red: paint black to mask more, white to select more, then Q again to turn the coverage back into a selection. A soft brush gives a feathered selection. Every paint tool edits the mask, and your image is untouched while you're in the mode — undo steps back into it rather than discarding it.", keys: "Q" },
        ],
      },
      {
        title: "Using a selection",
        entries: [
          { title: "Confine any edit", body: "Painting, fills, gradients, adjustments, filters and the retouch brushes all clip to the active selection automatically." },
          { title: "Transform", body: "Free transform scales/rotates the selected pixels; Transform selection moves only the outline. Handles support corner and edge drags.", keys: "Ctrl+Alt+T" },
          { title: "Content-aware fill", body: "Synthesizes the selected area from its surroundings — larger regions are built from overlapping patches and tone-matched.", keys: "Shift+F5" },
          { title: "To and from masks", body: "Layer ▸ Mask from selection turns the selection into a layer mask; Mask to selection loads a mask back as a selection." },
        ],
      },
    ],
  },
  {
    id: "layers",
    label: "Layers & masks",
    sections: [
      {
        title: "The stack",
        entries: [
          { title: "Layers, groups, adjustments", body: "Pixel layers hold paint; groups nest and composite as one; adjustment layers re-process everything below them. Each row has visibility, blend mode and opacity." },
          { title: "Organising", body: "Drag rows to reorder (into or out of groups), double-click names to rename, Ctrl/Shift-click for multi-selection, Ctrl+G to group. Merge down (Ctrl+E), merge selection, or flatten the image." },
          { title: "Labels & filtering", body: "Tag layers with one of seven colour labels from the right-click menu, then use the panel's filter row to find layers by name, kind (layer/group/adjustment) or label — matches stay bright, their surroundings dim, and reordering pauses until the filter is cleared." },
          { title: "Clipping masks", body: "Alt-click a row (or Ctrl+Alt+G) to clip a layer to the alpha of the layer below — it only shows where the base has pixels. Runs of clipped layers share one base.", keys: "Ctrl+Alt+G" },
        ],
      },
      {
        title: "Masks",
        entries: [
          { title: "Layer masks", body: "Reveal-all, hide-all, or from the selection. Click the mask thumbnail to paint it — black hides, white reveals, grey is partial — with any paint tool including gradients, the blur brush and dodge/burn." },
          { title: "Mask control", body: "Shift-click a mask thumbnail to disable it temporarily; the chain icon unlinks it so layer and mask move independently; Apply bakes it into the layer's alpha." },
          { title: "Viewing a mask", body: "Alt-click a mask thumbnail to see the mask itself, grayscale, on the canvas — painting still targets it, live. Click any thumbnail (or Alt-click again) to return. The Channels panel's mask row has an eye that does the same, plus a tonal curve of the mask beside R/G/B." },
          { title: "Channels histogram", body: "The Channels panel graphs R/G/B and a Luminosity curve, shows how many pixels clip to pure black or white (red-tinted when above half a percent), and — with an active selection — scopes the whole histogram to just the selected pixels." },
          { title: "Filter masks", body: "A second mask that confines a layer's smart-filter stack: white = filtered, black = original. Managed from the Smart Filters dialog." },
          { title: "Clipping masks", body: "Ctrl+Alt+G (or Alt-click a layer row) clips a layer to the one below — it shows only within that base's shape. Clipping even works across adjustment layers: the clipped layer reaches down to the pixel layer beneath them, Photoshop-style.", keys: "Ctrl+Alt+G" },
        ],
      },
      {
        title: "Layer styles",
        entries: [
          { title: "Eight effects", body: "Drop shadow, inner shadow, outer/inner glow, bevel & emboss, colour and gradient overlays, stroke (solid colour or a multi-stop gradient with reverse and angle) — rendered live from the layer's silhouette, never baked into pixels." },
          { title: "Managing styles", body: "Toggle effects individually in the panel's sub-list; copy, paste and clear whole styles from the layer context menu." },
        ],
      },
    ],
  },
  {
    id: "adjustments",
    label: "Adjustments & color",
    sections: [
      {
        title: "Two ways to adjust",
        entries: [
          { title: "Adjustments panel (destructive)", body: "Thirteen sliders (exposure through noise reduction) plus one-click filter looks preview live on the active layer; Apply bakes them, Reset discards. Your own looks can be saved as presets and shared as .gifp files." },
          { title: "Adjustment layers (non-destructive)", body: "The same maths as editable layers: brightness/contrast, exposure, vibrance, colour balance, black & white, photo filter, Curves, Levels, Hue/Saturation (per colour range), Selective Color, Channel Mixer, Gradient Map, Color Lookup (.cube), Invert and Equalize. Clip one to the layer below to limit its reach; re-open its editor from the layer row at any time." },
        ],
      },
      {
        title: "Tone tools",
        entries: [
          { title: "Curves", body: "Monotone-smooth curve per channel over a histogram backdrop; click to add points, drag or arrow-key to move them, right-click to remove. Presets included — and the Target toggle lets you drag directly on the image to shape the curve at the tone under the cursor.", keys: "Arrows" },
          { title: "Levels", body: "Input black/gamma/white and output range per channel, black/grey/white-point eyedroppers, and an Auto contrast stretch." },
          { title: "LUT round-trip", body: "Import any .cube 3D LUT as a Color Lookup layer; export your current adjustment stack (or the panel's sliders) as a .cube at 17/33/65 points to use elsewhere." },
        ],
      },
    ],
  },
  {
    id: "filters",
    label: "Filters & effects",
    sections: [
      {
        title: "Blur Gallery",
        entries: [
          { title: "Nine blurs, live", body: "Box, Gaussian, Motion, Zoom, Spin, Bokeh, Tilt-shift, Surface (edge-preserving) and Spread, previewed live on the layer or the whole canvas — computed off-thread so sliders stay fluid. Zoom/spin/tilt-shift take a draggable anchor." },
        ],
      },
      {
        title: "Smart filters",
        entries: [
          { title: "A non-destructive stack", body: "Per layer or group: Blur (the gallery's kinds), Unsharp Mask, Add Noise, Mosaic, Distort (twirl/pinch/wave) and Stylize (find edges/emboss/posterize/threshold). Each entry has its own blend mode, opacity and enable toggle — drag rows to reorder the stack (or use Up/Down); the drop commits one undo step." },
          { title: "Editing & baking", body: "Re-open the stack from the flask icon on the layer row. A filter mask confines the whole stack; Apply bakes it into pixels as one undoable step. Large documents preview at half resolution while you drag, then refine." },
          { title: "Liquify", body: "Not available yet — it's the one remaining Effects-menu stub." },
        ],
      },
    ],
  },
  {
    id: "textvector",
    label: "Text & vector",
    sections: [
      {
        title: "Text",
        entries: [
          { title: "Point and paragraph text", body: "Click to type free-flowing text, or drag first to make a wrapping paragraph box. Alignment (including justify), line height and letter-spacing live in the options bar.", keys: "T" },
          { title: "Rich styling", body: "Inside the editor, select characters and change font, size, colour, bold, italic, underline, strikethrough, all-caps or baseline shift for just that run — one block can mix them all.", keys: "Ctrl+B" },
          { title: "Choosing a font", body: "The font control opens a searchable list where every entry is previewed in its own typeface. Search ranks the obvious answer first — “new” finds Times New Roman and Courier New, and initials work too (“tnr”). Fonts you pick collect under Recent. On Chrome and Edge, “Add system fonts…” asks permission and then lists everything installed on your machine." },
          { title: "All caps & baseline shift", body: "All caps sets text in capitals without changing what you typed — turn it off and your original casing returns. Baseline shift raises (positive) or lowers (negative) the selected characters by a number of pixels, for superscripts and subscripts; underlines and strikethroughs move with them." },
          { title: "Always re-editable", body: "Text rasterizes onto its layer but keeps its recipe: click it again with the Text tool to re-open and re-edit; the layer re-renders crisply." },
        ],
      },
      {
        title: "Vector layers",
        entries: [
          { title: "Shapes and pen paths", body: "Shape and pen layers keep their geometry too — reselect them to move handles, restyle fill/stroke or adjust the stroke profile, then commit again." },
          { title: "Paths panel", body: "Committed pen paths land in the Paths panel as the Work Path; save them to keep them, then turn any path into a selection (Ctrl adds, Alt subtracts, Ctrl+Alt intersects), stroke or fill it onto the active layer, or load it back into the Pen tool. Stored paths save with the project." },
          { title: "SVG in and out", body: "Imported SVGs become vector-path layers that re-rasterize sharply at any size (features outside the supported subset fall back to a raster copy, honestly labelled). File ▸ Export SVG writes vector/text layers back out as SVG." },
        ],
      },
    ],
  },
  {
    id: "files",
    label: "Open, save & export",
    sections: [
      {
        title: "Projects",
        entries: [
          { title: ".gproj projects", body: "The native format saves every document exactly: layers, groups, masks, adjustment layers, styles, smart filters, selection and history labels. Save uses your name; Save As picks a location with the system dialog.", keys: "Ctrl+S" },
          { title: "Recents", body: "Saved and opened projects are remembered — File ▸ Open recent re-opens them, straight from disk on browsers that allow it." },
          { title: "Autosave & crash recovery", body: "Every open document is snapshotted on an interval (Preferences ▸ Files). If the app closes uncleanly, the next launch offers to restore all of them." },
        ],
      },
      {
        title: "Import",
        entries: [
          { title: "Images", body: "PNG, JPEG, WebP, AVIF, GIF, BMP — everything the browser decodes, with embedded colour profiles honoured. Multiple files import as layers or as separate documents, with placement options." },
          { title: "PSD", body: "Layered Photoshop files open with layers, nested groups, masks, opacity, blend modes, clipping and visibility (8-bit RGB/greyscale; unsupported constructs fall back to the flattened composite, noted on import)." },
          { title: "Camera raw", body: "DNG files are truly developed — demosaic, as-shot white balance, camera colour matrix. Other raw formats (CR2/NEF/ARW/…) open their largest embedded preview." },
          { title: "TIFF & HEIF", body: "TIFF decodes in-app (8/16-bit, strips or tiles, PackBits/LZW/Deflate, grayscale/palette/RGB(A)) — no browser support needed. HEIC/HEIF opens where the browser ships the codec (Safari does; most others don't), and EXIF is read from HEIF/AVIF either way." },
        ],
      },
      {
        title: "Export",
        entries: [
          { title: "Export As", body: "PNG, JPEG, WebP and AVIF (as the browser supports), with quality, scale, transparency/matte controls and a live file-size estimate that really encodes.", keys: "Ctrl+Shift+E" },
          { title: "Presets & batch", body: "Save your export settings as presets; Batch mode encodes several sizes/formats in one go with filename templates ({name}, {w}, {h}, {scale}, {n}) and downloads a single zip." },
          { title: "PSD, TIFF, PDF, SVG, LUT, print", body: "Export a layered PSD for other editors, a Deflate-compressed 8/16-bit TIFF, a single-page PDF (image-size or paper size with margins, JPEG or lossless), an SVG of the vector layers, a .cube LUT of your adjustments — and Print is true-size, honouring the document's ppi." },
        ],
      },
    ],
  },
  {
    id: "colorman",
    label: "Color management",
    sections: [
      {
        title: "Working spaces & proofing",
        entries: [
          { title: "Working space", body: "sRGB, Display P3 (wide gamut, on supporting browsers) or Adobe RGB — the latter is an emulated maths space: pixels stay on an sRGB canvas while adjustments run in Adobe primaries through a 16-bit pipeline." },
          { title: "Soft proofing", body: "Proof colors simulates the target space on the view only; Gamut warning paints out-of-gamut pixels grey. Configure the target in Settings ▸ Color management.", keys: "Ctrl+Alt+Y" },
          { title: "Compare profiles", body: "View ▸ Compare color profiles shows the same composite interpreted under different spaces side by side." },
          { title: "Merge to HDR", body: "File ▸ Merge to HDR combines 2+ bracketed exposures (tripod-aligned, same size; EV auto-read from EXIF) into a 32-bit float radiance map, tone-mapped into a new document. The float source stays with the document in memory — re-tone-map any time via Image ▸ HDR tone mapping without stacking loss." },
          { title: "HDR export", body: "File ▸ Export HDR PNG writes the float source as a 16-bit Rec.2100 PNG (PQ or HLG, cICP-tagged) — on HDR displays its highlights really glow. The float map isn't saved into .gproj, so keep the export if you need the HDR later." },
        ],
      },
    ],
  },
  {
    id: "view",
    label: "View & workspace",
    sections: [
      {
        title: "Viewing",
        entries: [
          { title: "Zoom & pan", body: "Ctrl+Wheel zooms at the cursor, wheel pans, Ctrl+0 fits, Ctrl+1 shows actual pixels. Each document tab keeps its own view.", keys: "Ctrl+0" },
          { title: "Rulers, grids, snap", body: "Rulers tick in px, inches or centimetres (Preferences ▸ Units & rulers) and guides are dragged straight out of them; the pixel grid appears at high zoom, and View ▸ Document grid overlays a configurable grid — spacing, subdivisions, colours and the snap distance live in Preferences ▸ Guides & grid.", keys: "Ctrl+'" },
          { title: "Guides", body: "Drag a guide out of either ruler (hold Alt to flip its orientation), or place one exactly with View ▸ New guide. The Move tool picks guides up again; drag one back onto its ruler to delete it. While View ▸ Snap is on, moving a layer or drawing a marquee snaps to guides, to the canvas edges and centre, and — with View ▸ Smart guides — to the edges and centres of other visible layers, with a magenta line showing what lined up. Hold Ctrl during a drag to suspend snapping. Lock guides freezes them; Clear guides removes them all. Guides are per-document, undoable, and saved in the project file.", keys: "Ctrl+;" },
          { title: "Accessibility", body: "Preferences ▸ Accessibility adapts the interface. Colour vision (protanopia, deuteranopia, tritanopia or monochromacy) swaps the danger / success / warning colours for a set that stays distinguishable for that kind of vision, shows a live before-and-after preview, and makes the accent picker flag any accent that would be confused with a warning or an error. High contrast strengthens borders, secondary text and the focus ring within your current theme. Reduce motion lives here too. Every dialog is fully keyboard-operable: focus moves into it when it opens, Tab stays inside it, and closing it returns focus to where you were." },
          { title: "Touch & pen", body: "Two fingers pan and pinch-zoom the canvas at any time. Palm rejection (Preferences ▸ Touch & pen) stops touch from drawing once a stylus has been used, so you can rest your hand on the screen while the two-finger gestures keep working. A stylus with an eraser end erases while it is turned over, without changing the selected tool." },
          { title: "Before/after compare", body: "View ▸ Compare before/after splits the canvas with a draggable divider — one side without your adjustment layers and smart filters, the other with, labelled Before and After. Compare axis: horizontal flips it to a top/bottom split. Holding the backslash key peeks at the un-adjusted image across the whole canvas without turning anything on. Layer effects are kept on both sides: they are styling rather than colour grading.", keys: "\\" },
          { title: "Transparency checkerboard", body: "The pattern behind transparent pixels is configurable in Preferences ▸ Transparency (size and colours)." },
        ],
      },
      {
        title: "Workspace",
        entries: [
          { title: "Panels", body: "Color, Swatches, Adjustments, Properties, Layers, Paths, History, Actions, Navigator, Channels and Metadata — toggle them in the Window menu, drag their headers to reorder or to move them into the second (left) dock, collapse what you don't need, or reset the workspace." },
          { title: "Interactive tour & sample", body: "Help ▸ Interactive tour replays the spotlight walkthrough of the workspace (it also greets first-time visitors), and Help ▸ Open sample document creates a small layered scene — sky, a grouped shape layer, a headline — to experiment on safely." },
          { title: "Swatches", body: "The Swatches panel organises colours into groups — click to use, Alt-click to remove, double-click a name to rename. Import/export .gse/.gco (also .ase/.aco), JSON and GIMP .gpl, or extract a palette straight from the image; the first group is also the colour picker's swatch strip." },
          { title: "Floating panels & workspaces", body: "The pin on a panel's header floats it over the canvas — drag it by its grip bar, pin again to dock it back. Window ▸ Workspaces saves the whole layout (visibility, docks, floats, collapsed states) under a name and re-applies it in one click." },
          { title: "Actions (macros)", body: "The Actions panel records sequences of document commands — layer ops, rotates, preset adjustments, effects — and brush, pencil and eraser strokes (replayed at the recorded spot with the recorded settings), then replays it all in one click or with an assigned F-key (F2–F10). Commands that open a dialog, and other tools' gestures, aren't captured." },
          { title: "Batch processing", body: "File ▸ Batch process runs a saved action and/or an export preset over many files: each opens as a temporary document, the action replays on it live, and the results download as one zip. The canvas flicks through the files while it works — that's the replay being real." },
          { title: "Scripting (dev console)", body: "Open the browser console and type graphiq.help() — window.graphiq runs menu commands, patches layers, plays actions and exports PNGs, all through the same undoable paths the UI uses. Example: await graphiq.play(\"My action\"); await graphiq.download()." },
          { title: "Command palette", body: "Ctrl+K (or the top-bar search pill) opens the command palette: fuzzy-search every tool and menu command — \"exp svg\" finds Export SVG — with your recently used commands ready when the query is empty.", keys: "Ctrl+K" },
          { title: "Remappable shortcuts", body: "The Keyboard Shortcuts window (Settings or Help menu) is also where you change bindings: click a key chip, press the new keys — Backspace unbinds, Esc cancels — and the menus and palette update instantly. Reset per shortcut or all at once." },
          { title: "Interface scale", body: "Preferences ▸ Appearance ▸ Interface scale resizes the bars, panels, menus and dialogs — Compact (90%) through Large (125%). The canvas view is never scaled, so document pixels always render exactly." },
          { title: "History", body: "The History panel lists undoable steps — click any entry to jump. Preferences ▸ Performance caps history two ways: a step count and an Undo memory budget in MB, whichever is reached first. A live meter there shows what the stack currently holds, because a step count says little about memory — one full-canvas edit stores the pixels before and after. Snapshots are not counted against the budget.", keys: "Ctrl+Z" },
          { title: "Animations", body: "An animated GIF opens as its own document with one layer per frame, named with its delay (Frame 3 · 80 ms); frame 1 sits at the bottom and only the last frame starts visible. APNG and animated WebP decode frame-by-frame on Chrome and Edge; other browsers import the first frame and say so. File ▸ Export frames (zip) writes each layer back out as a numbered PNG with its delay in the filename." },
          { title: "History log", body: "Reopen a project and the History panel shows a collapsible \"N earlier steps · from the file\" section listing what was done to it before, with repeats grouped. Saving again appends to that log, capped so it can never bloat the file. It is a record rather than a time machine: a saved file holds its current pixels, not the ones each step replaced, so those states cannot be travelled to." },
          { title: "Non-linear history", body: "The branch button at the top of the History panel keeps the states a new edit would otherwise discard. With it off (the default), editing after an undo throws away everything after your position; with it on, those states stay in the list as a branch, marked with a rail because they are not on the way to where you are now — click one to go there. Redo follows the branch you were last working on, and turning the option off again drops the branches you left behind." },
        ],
      },
    ],
  },
  {
    id: "privacy",
    label: "Storage & privacy",
    sections: [
      {
        title: "Where your work lives",
        entries: [
          { title: "Everything is local", body: "Graphiq Studio runs entirely in your browser. Images, projects and edits never leave this device — there is no upload, no account, no server-side processing." },
          { title: "What the browser stores", body: "Autosave snapshots and the recent-files list live in IndexedDB; settings and saved presets live in localStorage. Settings ▸ Scratch disks / storage shows usage and offers clear actions." },
          { title: "Keeping it safe", body: "Browsers may evict site storage under pressure — the Storage panel can request persistent storage to protect autosave and recents. Projects you Save as .gproj files are ordinary files, fully under your control." },
        ],
      },
    ],
  },
];

/** Case-insensitive filter over topics: keeps entries whose title/body/keys
 *  match, drops empty sections/topics. Empty query returns the input. */
export function filterTopics(topics: HelpTopic[], query: string): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return topics;
  const out: HelpTopic[] = [];
  for (const t of topics) {
    const sections = t.sections
      .map((s) => ({
        ...s,
        entries: s.entries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.body.toLowerCase().includes(q) ||
            (e.keys ?? "").toLowerCase().includes(q) ||
            s.title.toLowerCase().includes(q) ||
            t.label.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.entries.length > 0);
    if (sections.length) out.push({ ...t, sections });
  }
  return out;
}
