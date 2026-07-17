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
    body: "M draws marquees (Shift+M cycles rectangle/ellipse/triangle), L is the lasso (Shift+L cycles freehand/polygonal/magnetic), W selects by colour. Hold Ctrl to add and Alt to subtract while dragging. V moves layers or the selected pixels; Free transform scales and rotates them.",
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
          { title: "Magic wand", body: "Selects similar colour with a live tolerance slider; contiguous limits to the connected region, sample-all reads the composite instead of the layer.", keys: "W" },
          { title: "Crop", body: "Ratio presets or free, rule-of-thirds/grid/golden overlays, a darkening shield, and a straighten angle that levels the image as it crops.", keys: "C" },
          { title: "Eyedropper", body: "Picks a colour — point sample or 3×3/5×5/11×11 average, from the active layer or every layer.", keys: "I" },
        ],
      },
      {
        title: "Paint & retouch",
        entries: [
          { title: "Brush / Pencil / Eraser", body: "One brush engine: size, hardness, opacity, flow, blend mode, smoothing. The pencil is always hard-edged and pixel-exact; the eraser removes to transparency.", keys: "B / N / E" },
          { title: "Clone stamp", body: "Alt-click sets the source, then paint copies from it. Aligned keeps the source offset across strokes; sample-all clones from the composite.", keys: "S" },
          { title: "Spot heal", body: "Paint over a blemish — on release it fills with matching texture from the surroundings, tone-blended so no seam shows.", keys: "J" },
          { title: "Red eye", body: "One click on a flash-red pupil neutralizes and darkens it; the blob is found automatically around the click.", keys: "Y" },
          { title: "Paint bucket", body: "Flood-fills by colour similarity with optional anti-aliased edges — tolerance stays live-editable until you commit.", keys: "G" },
          { title: "Gradient", body: "Linear, radial, angle or reflected; drag to place, then re-drag the endpoints and midpoint live. Stops are editable and saveable as presets.", keys: "G" },
          { title: "Blur brush", body: "Softens where you paint (strength and kernel radius in the options bar); can sample all layers.", keys: "R" },
          { title: "Dodge / Burn", body: "Lightens or darkens, targeted at shadows, midtones or highlights, with a protect-tones mode that preserves hue.", keys: "O" },
        ],
      },
      {
        title: "Text, vector & view",
        entries: [
          { title: "Text", body: "Click for point text or drag a box for wrapped paragraph text. Selections inside the editor can mix fonts, sizes, colours, bold/italic/underline.", keys: "T" },
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
          { title: "Filter masks", body: "A second mask that confines a layer's smart-filter stack: white = filtered, black = original. Managed from the Smart Filters dialog." },
        ],
      },
      {
        title: "Layer styles",
        entries: [
          { title: "Eight effects", body: "Drop shadow, inner shadow, outer/inner glow, bevel & emboss, colour and gradient overlays, stroke — rendered live from the layer's silhouette, never baked into pixels." },
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
          { title: "A non-destructive stack", body: "Per layer or group: Blur (the gallery's kinds), Unsharp Mask, Add Noise, Mosaic, Distort (twirl/pinch/wave) and Stylize (find edges/emboss/posterize/threshold). Each entry has its own blend mode, opacity, enable toggle and position in the stack." },
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
          { title: "Rich styling", body: "Inside the editor, select characters and change font, size, colour, bold, italic, underline or strikethrough for just that run — one block can mix them all.", keys: "Ctrl+B" },
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
        ],
      },
      {
        title: "Export",
        entries: [
          { title: "Export As", body: "PNG, JPEG, WebP and AVIF (as the browser supports), with quality, scale, transparency/matte controls and a live file-size estimate that really encodes.", keys: "Ctrl+Shift+E" },
          { title: "Presets & batch", body: "Save your export settings as presets; Batch mode encodes several sizes/formats in one go with filename templates ({name}, {w}, {h}, {scale}, {n}) and downloads a single zip." },
          { title: "PSD, SVG, LUT, print", body: "Export a layered PSD for other editors, an SVG of the vector layers, a .cube LUT of your adjustments — and Print is true-size, honouring the document's ppi." },
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
          { title: "Rulers, grid, snap", body: "Rulers tick in px, inches or centimetres (Preferences ▸ Units & rulers, using the document's resolution); the pixel grid appears at high zoom; snapping helps align drags.", keys: "Ctrl+'" },
          { title: "Transparency checkerboard", body: "The pattern behind transparent pixels is configurable in Preferences ▸ Transparency (size and colours)." },
        ],
      },
      {
        title: "Workspace",
        entries: [
          { title: "Panels", body: "Color, Adjustments, Properties, Layers, Paths, History, Actions, Navigator, Channels and Metadata — toggle them in the Window menu, drag their headers to reorder the dock, collapse what you don't need, or reset the workspace." },
          { title: "Actions (macros)", body: "The Actions panel records sequences of document commands — layer ops, rotates, preset adjustments, effects — and replays them in one click or with an assigned F-key (F2–F10). Commands that open a dialog, and tool strokes, aren't captured." },
          { title: "Command palette", body: "Ctrl+K (or the top-bar search pill) opens the command palette: fuzzy-search every tool and menu command — \"exp svg\" finds Export SVG — with your recently used commands ready when the query is empty.", keys: "Ctrl+K" },
          { title: "Remappable shortcuts", body: "The Keyboard Shortcuts window (Settings or Help menu) is also where you change bindings: click a key chip, press the new keys — Backspace unbinds, Esc cancels — and the menus and palette update instantly. Reset per shortcut or all at once." },
          { title: "History", body: "The History panel lists undoable steps — click any entry to jump. The in-memory cap is set in Preferences ▸ Performance.", keys: "Ctrl+Z" },
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
