import { createLucideIcon } from "lucide-react";
import { HandIcon } from "./tool-icons";

/* The interface's own glyphs, as the Graphiq design language v1 draws them
   (the design canvas's Main / Components / Mobile boards): a 24-unit grid,
   round caps and joins, the same 1.6px stroke as every other icon. Built with
   lucide's factory, so they take the same props and classes as the rest.

   Most of them stand in for the lucide icon of the same idea and so carry its
   NAME — Search, Link2, Trash2… — which lets a module swap its import from
   "lucide-react" to here and leave every call site alone. The handful the
   design draws but lucide names differently are exported under their own
   names (MaskIcon, AdjustmentIcon, PressureIcon…). Where the design draws one
   half of a pair (a link, a padlock, a folder), the other half is drawn here
   in the same hand — an unlink from the link's own arcs, an open padlock from
   its shackle — so the two never look borrowed from different sets.

   The tool rail's glyphs live in tool-icons.ts. Icons the design never draws
   (palette, history, alignment…) stay lucide's, at the same stroke. */

const icon = createLucideIcon;

/* ---- Drawn by the design ---------------------------------------------------- */

export const Search = icon("gq-search", [
  ["circle", { cx: "11", cy: "11", r: "7", key: "a" }],
  ["path", { d: "m20 20-3.5-3.5", key: "b" }],
]);

export const Undo2 = icon("gq-undo", [
  ["path", { d: "M9 14 4 9l5-5", key: "a" }],
  ["path", { d: "M4 9h11a5 5 0 0 1 0 10h-4", key: "b" }],
]);

export const Redo2 = icon("gq-redo", [
  ["path", { d: "m15 14 5-5-5-5", key: "a" }],
  ["path", { d: "M20 9H9a5 5 0 0 0 0 10h4", key: "b" }],
]);

/** Export / download: an arrow down onto a line. */
export const Download = icon("gq-download", [["path", { d: "M12 3v12M7 10l5 5 5-5M5 21h14", key: "a" }]]);

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
export const Folder = icon("gq-folder", [["path", { d: FOLDER, key: "a" }]]);

export const Eye = icon("gq-eye", [
  ["path", { d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "3", key: "b" }],
]);

export const EyeOff = icon("gq-eye-off", [
  [
    "path",
    {
      d: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6",
      key: "a",
    },
  ],
]);

/** A layer mask: a rounded square with a disc in it. */
export const MaskIcon = icon("gq-mask", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "5", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "4.5", key: "b" }],
]);

const LOCK_BODY = { x: "5", y: "11", width: "14", height: "10", rx: "2.5", key: "a" } as const;
export const Lock = icon("gq-lock", [
  ["rect", LOCK_BODY],
  ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3", key: "b" }],
]);

const LINK_UPPER = "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1";
const LINK_LOWER = "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1";
/** Two links of a chain: linked layers, a linked mask, kept proportions. */
export const Link2 = icon("gq-link", [["path", { d: `${LINK_UPPER}${LINK_LOWER}`, key: "a" }]]);

/** An adjustment layer: a disc, half filled. */
export const AdjustmentIcon = icon("gq-adjustment", [
  ["circle", { cx: "12", cy: "12", r: "9", key: "a" }],
  ["path", { d: "M12 3a9 9 0 0 1 0 18z", fill: "currentColor", key: "b" }],
]);

/** Duplicate / copy: a square in front of the one it came from. */
export const Copy = icon("gq-copy", [
  ["rect", { x: "8", y: "8", width: "13", height: "13", rx: "3", key: "a" }],
  ["path", { d: "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3", key: "b" }],
]);

export const Trash2 = icon("gq-trash", [["path", { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6", key: "a" }]]);

export const MoreHorizontal = icon("gq-more", [
  ["circle", { cx: "5", cy: "12", r: "1.2", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "1.2", key: "b" }],
  ["circle", { cx: "19", cy: "12", r: "1.2", key: "c" }],
]);

export const Check = icon("gq-check", [["path", { d: "m5 12 5 5 9-10", key: "a" }]]);

/** The menu: three lines, the last one short. */
export const Menu = icon("gq-menu", [["path", { d: "M4 7h16M4 12h16M4 17h10", key: "a" }]]);

/** Layers: three sheets stacked (the panel, and the phone's panels sheet). */
export const Layers = icon("gq-layers", [
  ["path", { d: "m12 3 9 5-9 5-9-5z", key: "a" }],
  ["path", { d: "m3 16 9 5 9-5M3 12l9 5 9-5", key: "b" }],
]);
export const PanelsIcon = Layers;

/** Every tool: four rounded tiles. */
export const AllToolsIcon = icon("gq-all-tools", [
  ["rect", { x: "4", y: "4", width: "6", height: "6", rx: "1.5", key: "a" }],
  ["rect", { x: "14", y: "4", width: "6", height: "6", rx: "1.5", key: "b" }],
  ["rect", { x: "4", y: "14", width: "6", height: "6", rx: "1.5", key: "c" }],
  ["rect", { x: "14", y: "14", width: "6", height: "6", rx: "1.5", key: "d" }],
]);

/** Pen pressure: a stroke that swells and thins. */
export const PressureIcon = icon("gq-pressure", [["path", { d: "M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0", key: "a" }]]);

/** Pan: the rail's hand, shared. */
export { HandIcon };

/* ---- The other half of the design's pairs, in the same hand ------------------ */

/** Unlinked: the chain's two outer arcs, pulled apart, with the break marked. */
export const Unlink2 = icon("gq-unlink", [
  ["path", { d: "M17 13l3-3a5 5 0 0 0-7-7l-1 1M7 11l-3 3a5 5 0 0 0 7 7l1-1", key: "a" }],
  ["path", { d: "M8 2v3M2 8h3M16 22v-3M22 16h-3", key: "b" }],
]);
export const Link2Off = Unlink2;

/** Unlocked: the same body, the shackle swung open. */
export const LockOpen = icon("gq-lock-open", [
  ["rect", LOCK_BODY],
  ["path", { d: "M8 11V8a4 4 0 0 1 7.75-1.4", key: "b" }],
]);

export const FolderPlus = icon("gq-folder-plus", [
  ["path", { d: FOLDER, key: "a" }],
  ["path", { d: "M12 10v6M9 13h6", key: "b" }],
]);

export const FolderMinus = icon("gq-folder-minus", [
  ["path", { d: FOLDER, key: "a" }],
  ["path", { d: "M9 13h6", key: "b" }],
]);

/** An open group: the folder's back, and its front flap tipped forward. */
export const FolderOpen = icon("gq-folder-open", [
  ["path", { d: "M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1", key: "a" }],
  [
    "path",
    {
      d: "M5 19h11.6a2.4 2.4 0 0 0 2.2-1.5l2.3-5.8A1.2 1.2 0 0 0 20 10H7.1a2 2 0 0 0-1.9 1.3L3 17a2 2 0 0 0 2 2z",
      key: "b",
    },
  ],
]);

/** Import / upload: the download's arrow, turned round. */
export const Upload = icon("gq-upload", [["path", { d: "M12 15V3M7 8l5-5 5 5M5 21h14", key: "a" }]]);
