export interface MenuItem {
  label: string;
  shortcut?: string;
  separatorAfter?: boolean;
  disabled?: boolean;
  /** Optional action id wired up by the editor. */
  action?: string;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

/** Top menu bar definitions. Items are presentational only for now. */
export const MENUS: Menu[] = [
  {
    label: "File",
    items: [
      { label: "New…", shortcut: "Ctrl+Alt+N", action: "new-doc" },
      { label: "Open…", shortcut: "Ctrl+O", action: "open" },
      { label: "Open recent…", separatorAfter: true, action: "open-recent" },
      { label: "Save", shortcut: "Ctrl+S", action: "save" },
      { label: "Save as…", shortcut: "Ctrl+Shift+S", separatorAfter: true, action: "save-as" },
      { label: "Import…", action: "import" },
      { label: "Merge to HDR…", action: "merge-hdr" },
      { label: "Batch process…", action: "batch-process" },
      { label: "Export as…", shortcut: "Ctrl+Shift+E", action: "export-as" },
      { label: "Export PSD (layered)…", action: "export-psd" },
      { label: "Export TIFF…", action: "export-tiff" },
      { label: "Export PDF…", action: "export-pdf" },
      { label: "Export SVG (vector layers)…", action: "export-svg" },
      { label: "Export LUT (.cube)…", action: "export-lut" },
      { label: "Export HDR PNG…", separatorAfter: true, action: "export-hdr" },
      { label: "Print…", shortcut: "Ctrl+P", separatorAfter: true, action: "print" },
      { label: "Close", shortcut: "Ctrl+W" },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Undo", shortcut: "Ctrl+Z", action: "undo" },
      { label: "Redo", shortcut: "Ctrl+Shift+Z", separatorAfter: true, action: "redo" },
      { label: "Cut", shortcut: "Ctrl+X", action: "edit-cut" },
      { label: "Copy", shortcut: "Ctrl+C", action: "edit-copy" },
      { label: "Paste", shortcut: "Ctrl+V", separatorAfter: true, action: "edit-paste" },
      { label: "Content-aware fill", shortcut: "Shift+F5", separatorAfter: true, action: "edit-caf" },
      { label: "Free transform", shortcut: "Ctrl+Alt+T", action: "free-transform" },
      { label: "Transform selection", shortcut: "Ctrl+Alt+Shift+T", action: "transform" },
    ],
  },
  {
    label: "Image",
    items: [
      { label: "Image size…", shortcut: "Ctrl+Alt+I", action: "image-size" },
      {
        label: "Canvas size…",
        shortcut: "Ctrl+Alt+C",
        action: "canvas-size",
        separatorAfter: true,
      },
      { label: "Crop", shortcut: "Ctrl+Alt+R", action: "image-crop" },
      { label: "Trim…", shortcut: "Ctrl+Alt+M", action: "image-trim", separatorAfter: true },
      { label: "Adjust: levels…", action: "tone-dest-levels" },
      { label: "Adjust: curves…", action: "tone-dest-curves" },
      { label: "HDR tone mapping…", action: "hdr-tone", separatorAfter: true },
      { label: "Rotate 90° CW", action: "image-rotate-cw" },
      { label: "Rotate 90° CCW", action: "image-rotate-ccw" },
      { label: "Flip horizontal", action: "image-flip-h" },
      { label: "Flip vertical", action: "image-flip-v" },
    ],
  },
  {
    label: "Layer",
    items: [
      { label: "New layer", shortcut: "Ctrl+Shift+N", action: "layer-new" },
      { label: "New fill: solid color…", action: "fill-solid" },
      { label: "New fill: gradient…", action: "fill-gradient" },
      { label: "Duplicate layer", action: "layer-duplicate" },
      { label: "Delete layer", separatorAfter: true, action: "layer-delete" },
      { label: "Group layers", shortcut: "Ctrl+G", action: "layer-group" },
      { label: "Ungroup", separatorAfter: true, action: "layer-ungroup" },
      { label: "Merge down", shortcut: "Ctrl+E", action: "layer-merge-down" },
      { label: "Flatten image", action: "layer-flatten" },
      { label: "Clipping mask", shortcut: "Ctrl+Alt+G", separatorAfter: true, action: "layer-clip" },
      { label: "Add layer mask", action: "mask-add" },
      { label: "Hide-all mask", action: "mask-add-hide" },
      { label: "Mask from selection", action: "mask-from-sel" },
      { label: "Delete layer mask", action: "mask-delete" },
      { label: "Apply layer mask", action: "mask-apply" },
      { label: "Mask to selection", separatorAfter: true, action: "mask-to-sel" },
      { label: "Adjustment: brightness / contrast", action: "adj-brightness-contrast" },
      { label: "Adjustment: exposure", action: "adj-exposure" },
      { label: "Adjustment: vibrance", action: "adj-vibrance" },
      { label: "Adjustment: color balance", action: "adj-color-balance" },
      { label: "Adjustment: black & white", action: "adj-black-white" },
      { label: "Adjustment: curves", action: "adj-tone-curves" },
      { label: "Adjustment: levels", action: "adj-tone-levels" },
      { label: "Adjustment: hue / saturation", action: "adj-x-huesat" },
      { label: "Adjustment: selective color", action: "adj-x-selective" },
      { label: "Adjustment: channel mixer", action: "adj-x-chanmix" },
      { label: "Adjustment: gradient map", action: "adj-x-gradientmap" },
      { label: "Adjustment: color lookup (.cube)…", action: "adj-x-colorlookup" },
      { label: "Adjustment: invert", action: "adj-x-invert" },
      { label: "Adjustment: equalize", action: "adj-x-equalize" },
      { label: "Adjustment: photo filter — warm", action: "adj-photo-filter-warm" },
      { label: "Adjustment: photo filter — cool", action: "adj-photo-filter-cool", separatorAfter: true },
      { label: "Layer style…", action: "fx-open" },
      { label: "FX: drop shadow", action: "fx-add-dropShadow" },
      { label: "FX: outer glow", action: "fx-add-outerGlow" },
      { label: "FX: stroke", action: "fx-add-stroke" },
      { label: "Clear layer style", action: "fx-clear" },
    ],
  },
  {
    label: "Select",
    items: [
      { label: "All", shortcut: "Ctrl+A", action: "select-all" },
      { label: "Deselect", shortcut: "Ctrl+D", action: "select-deselect" },
      { label: "Reselect", shortcut: "Ctrl+Shift+D", action: "select-reselect" },
      { label: "Inverse", shortcut: "Ctrl+Shift+I", separatorAfter: true, action: "select-inverse" },
      { label: "Feather…", shortcut: "Shift+F6", action: "select-feather" },
      { label: "Grow…", action: "select-grow" },
    ],
  },
  {
    label: "Effects",
    items: [
      { label: "Blur gallery…", action: "effect-blur", separatorAfter: true },
      // Smart filters (non-destructive, re-editable; Effects ▸ Smart Filters…)
      { label: "Blur (smart filter)", action: "filter-add-blur" },
      { label: "Sharpen…", action: "filter-add-sharpen" },
      { label: "Noise…", action: "filter-add-noise" },
      { label: "Pixelate…", action: "filter-add-pixelate" },
      { label: "Distort…", action: "filter-add-distort" },
      { label: "Stylize…", action: "filter-add-stylize", separatorAfter: true },
      { label: "Smart filters…", action: "filter-open" },
      { label: "Liquify…", shortcut: "Ctrl+Shift+X", action: "effect-liquify" },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Zoom in", shortcut: "Ctrl++", action: "view-zoom-in" },
      { label: "Zoom out", shortcut: "Ctrl+-", action: "view-zoom-out" },
      { label: "Fit on screen", shortcut: "Ctrl+0", action: "view-fit" },
      { label: "100%", shortcut: "Ctrl+1", separatorAfter: true, action: "view-100" },
      { label: "Show rulers", action: "view-rulers" },
      { label: "Pixel grid", shortcut: "Ctrl+'", action: "view-grid" },
      { label: "Document grid", action: "view-docgrid" },
      { label: "Snap", separatorAfter: true, action: "view-snap" },
      { label: "Proof colors", shortcut: "Ctrl+Alt+Y", action: "view-proof" },
      { label: "Gamut warning", shortcut: "Ctrl+Alt+Shift+Y", action: "view-gamut", separatorAfter: true },
      { label: "Compare color profiles…", separatorAfter: true, action: "color-compare" },
      { label: "Performance HUD", action: "view-perf-hud" },
    ],
  },
  {
    label: "Window",
    items: [
      { label: "Color", action: "window-color" },
      { label: "Swatches", action: "window-swatches" },
      { label: "Brushes", action: "window-brushes" },
      { label: "Adjustments", action: "window-adjustments" },
      { label: "Properties", action: "window-properties" },
      { label: "Layers", action: "window-layers" },
      { label: "Paths", action: "window-paths" },
      { label: "History", action: "window-history" },
      { label: "Actions", action: "window-actions" },
      { label: "Navigator", action: "window-navigator" },
      { label: "Channels", action: "window-channels" },
      { label: "Metadata", separatorAfter: true, action: "window-metadata" },
      { label: "Workspaces…", action: "workspaces" },
      { label: "Reset workspace", action: "window-reset" },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "Preferences…", shortcut: "Ctrl+,", action: "preferences" },
      { label: "Color management…", action: "color-manage", separatorAfter: true },
      { label: "Keyboard shortcuts…", action: "shortcuts", separatorAfter: true },
      { label: "Performance…", action: "prefs-performance" },
      { label: "Scratch disks / storage…", action: "prefs-storage" },
    ],
  },
  {
    label: "Help",
    items: [
      { label: "Getting started", action: "help-start" },
      { label: "Interactive tour", action: "help-tour" },
      { label: "Open sample document", action: "help-sample", separatorAfter: true },
      { label: "Documentation", action: "help-docs" },
      { label: "Keyboard shortcuts", action: "shortcuts", separatorAfter: true },
      { label: "About Graphiq Studio", action: "about" },
    ],
  },
];
