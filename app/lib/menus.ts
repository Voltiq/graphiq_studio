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
      { label: "Close", shortcut: "Ctrl+W" },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Undo", shortcut: "Ctrl+Z", action: "undo" },
      { label: "Redo", shortcut: "Ctrl+Shift+Z", separatorAfter: true, action: "redo" },
      { label: "Cut", shortcut: "Ctrl+X" },
      { label: "Copy", shortcut: "Ctrl+C" },
      { label: "Paste", shortcut: "Ctrl+V", separatorAfter: true },
      { label: "Transform", shortcut: "Ctrl+T" },
      { label: "Free Transform" },
    ],
  },
  {
    label: "Image",
    items: [
      { label: "Image Size…", shortcut: "Ctrl+Alt+I" },
      {
        label: "Canvas Size…",
        shortcut: "Ctrl+Alt+Z",
        action: "canvas-size",
        separatorAfter: true,
      },
      { label: "Crop" },
      { label: "Trim…", separatorAfter: true },
      { label: "Rotate 90° CW" },
      { label: "Rotate 90° CCW" },
      { label: "Flip Horizontal" },
      { label: "Flip Vertical" },
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
    ],
  },
  {
    label: "Select",
    items: [
      { label: "All", shortcut: "Ctrl+A" },
      { label: "Deselect", shortcut: "Ctrl+D" },
      { label: "Reselect", shortcut: "Ctrl+Shift+D" },
      { label: "Inverse", shortcut: "Ctrl+Shift+I", separatorAfter: true },
      { label: "Feather…", shortcut: "Shift+F6" },
      { label: "Grow" },
    ],
  },
  {
    label: "Effects",
    items: [
      { label: "Blur Gallery" },
      { label: "Sharpen" },
      { label: "Distort", separatorAfter: true },
      { label: "Noise" },
      { label: "Pixelate" },
      { label: "Stylize", separatorAfter: true },
      { label: "Liquify…", shortcut: "Ctrl+Shift+X" },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Zoom In", shortcut: "Ctrl++" },
      { label: "Zoom Out", shortcut: "Ctrl+-" },
      { label: "Fit on Screen", shortcut: "Ctrl+0" },
      { label: "100%", shortcut: "Ctrl+1", separatorAfter: true },
      { label: "Show Rulers", shortcut: "Ctrl+R" },
      { label: "Show Grid", shortcut: "Ctrl+'" },
      { label: "Snap" },
    ],
  },
  {
    label: "Window",
    items: [
      { label: "Color" },
      { label: "Adjustments" },
      { label: "Layers" },
      { label: "History" },
      { label: "Navigator", separatorAfter: true },
      { label: "Reset Workspace" },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "Preferences…", shortcut: "Ctrl+K" },
      { label: "Keyboard Shortcuts…", separatorAfter: true },
      { label: "Performance" },
      { label: "Scratch Disks" },
    ],
  },
  {
    label: "Help",
    items: [
      { label: "Getting Started" },
      { label: "Documentation" },
      { label: "Keyboard Shortcuts", separatorAfter: true },
      { label: "About Aperture" },
    ],
  },
];
