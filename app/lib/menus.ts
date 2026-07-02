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
      { label: "Open Recent…", separatorAfter: true, action: "open-recent" },
      { label: "Save", shortcut: "Ctrl+S", action: "save" },
      { label: "Save As…", shortcut: "Ctrl+Shift+S", separatorAfter: true, action: "save-as" },
      { label: "Import…", action: "import" },
      { label: "Export As…", shortcut: "Ctrl+Shift+E", separatorAfter: true, action: "export-as" },
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
      { label: "Free Transform", shortcut: "Ctrl+Alt+T", action: "free-transform" },
      { label: "Transform Selection", shortcut: "Ctrl+Alt+Shift+T", action: "transform" },
    ],
  },
  {
    label: "Image",
    items: [
      { label: "Image Size…", shortcut: "Ctrl+Alt+I", action: "image-size" },
      {
        label: "Canvas Size…",
        shortcut: "Ctrl+Alt+C",
        action: "canvas-size",
        separatorAfter: true,
      },
      { label: "Crop", shortcut: "Ctrl+Alt+R", action: "image-crop" },
      { label: "Trim…", shortcut: "Ctrl+Alt+M", action: "image-trim", separatorAfter: true },
      { label: "Adjust: Levels…", action: "tone-dest-levels" },
      { label: "Adjust: Curves…", action: "tone-dest-curves", separatorAfter: true },
      { label: "Rotate 90° CW", action: "image-rotate-cw" },
      { label: "Rotate 90° CCW", action: "image-rotate-ccw" },
      { label: "Flip Horizontal", action: "image-flip-h" },
      { label: "Flip Vertical", action: "image-flip-v" },
    ],
  },
  {
    label: "Layer",
    items: [
      { label: "New Layer", shortcut: "Ctrl+Shift+N", action: "layer-new" },
      { label: "Duplicate Layer", action: "layer-duplicate" },
      { label: "Delete Layer", separatorAfter: true, action: "layer-delete" },
      { label: "Group Layers", shortcut: "Ctrl+G", action: "layer-group" },
      { label: "Ungroup", separatorAfter: true, action: "layer-ungroup" },
      { label: "Merge Down", shortcut: "Ctrl+E", action: "layer-merge-down" },
      { label: "Flatten Image", action: "layer-flatten" },
      { label: "Clipping Mask", shortcut: "Ctrl+Alt+G", separatorAfter: true, action: "layer-clip" },
      { label: "Add Layer Mask", action: "mask-add" },
      { label: "Hide-All Mask", action: "mask-add-hide" },
      { label: "Mask From Selection", action: "mask-from-sel" },
      { label: "Delete Layer Mask", action: "mask-delete" },
      { label: "Apply Layer Mask", action: "mask-apply" },
      { label: "Mask to Selection", separatorAfter: true, action: "mask-to-sel" },
      { label: "Adjustment: Brightness / Contrast", action: "adj-brightness-contrast" },
      { label: "Adjustment: Exposure", action: "adj-exposure" },
      { label: "Adjustment: Vibrance", action: "adj-vibrance" },
      { label: "Adjustment: Color Balance", action: "adj-color-balance" },
      { label: "Adjustment: Black & White", action: "adj-black-white" },
      { label: "Adjustment: Curves", action: "adj-tone-curves" },
      { label: "Adjustment: Levels", action: "adj-tone-levels" },
      { label: "Adjustment: Photo Filter — Warm", action: "adj-photo-filter-warm" },
      { label: "Adjustment: Photo Filter — Cool", action: "adj-photo-filter-cool", separatorAfter: true },
      { label: "Layer Style…", action: "fx-open" },
      { label: "FX: Drop Shadow", action: "fx-add-dropShadow" },
      { label: "FX: Outer Glow", action: "fx-add-outerGlow" },
      { label: "FX: Stroke", action: "fx-add-stroke" },
      { label: "Clear Layer Style", action: "fx-clear" },
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
      { label: "Blur Gallery…", action: "effect-blur", separatorAfter: true },
      // Smart filters (non-destructive, re-editable; Effects ▸ Smart Filters…)
      { label: "Blur (Smart Filter)", action: "filter-add-blur" },
      { label: "Sharpen…", action: "filter-add-sharpen" },
      { label: "Noise…", action: "filter-add-noise" },
      { label: "Pixelate…", action: "filter-add-pixelate" },
      { label: "Distort…", action: "filter-add-distort" },
      { label: "Stylize…", action: "filter-add-stylize", separatorAfter: true },
      { label: "Smart Filters…", action: "filter-open" },
      { label: "Liquify…", shortcut: "Ctrl+Shift+X" },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Zoom In", shortcut: "Ctrl++", action: "view-zoom-in" },
      { label: "Zoom Out", shortcut: "Ctrl+-", action: "view-zoom-out" },
      { label: "Fit on Screen", shortcut: "Ctrl+0", action: "view-fit" },
      { label: "100%", shortcut: "Ctrl+1", separatorAfter: true, action: "view-100" },
      { label: "Show Rulers", action: "view-rulers" },
      { label: "Pixel Grid", shortcut: "Ctrl+'", action: "view-grid" },
      { label: "Snap", separatorAfter: true, action: "view-snap" },
      { label: "Compare Color Profiles…", action: "color-compare" },
    ],
  },
  {
    label: "Window",
    items: [
      { label: "Color", action: "window-color" },
      { label: "Adjustments", action: "window-adjustments" },
      { label: "Layers", action: "window-layers" },
      { label: "History", action: "window-history" },
      { label: "Navigator", action: "window-navigator" },
      { label: "Channels", action: "window-channels" },
      { label: "Metadata", separatorAfter: true, action: "window-metadata" },
      { label: "Reset Workspace", action: "window-reset" },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "Preferences…", shortcut: "Ctrl+K", action: "preferences" },
      { label: "Color Management…", action: "color-manage", separatorAfter: true },
      { label: "Keyboard Shortcuts…", action: "shortcuts", separatorAfter: true },
      { label: "Performance" },
      { label: "Scratch Disks" },
    ],
  },
  {
    label: "Help",
    items: [
      { label: "Getting Started" },
      { label: "Documentation" },
      { label: "Keyboard Shortcuts", action: "shortcuts", separatorAfter: true },
      { label: "About Graphiq Studio" },
    ],
  },
];
