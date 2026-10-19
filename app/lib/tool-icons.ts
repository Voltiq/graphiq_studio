import { createLucideIcon } from "lucide-react";

/* The rail's own glyphs, drawn for the design (24-unit grid, round caps, the
   same stroke as the rest of the icon set). Built with lucide's factory so they
   take the same props and classes as every other icon in the app. Tools not
   listed here use the lucide icon of the same idea. */

export const MoveIcon = createLucideIcon("gq-move", [
  ["path", { d: "M12 3v18M3 12h18M12 3 9 6M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3", key: "a" }],
]);

export const MarqueeIcon = createLucideIcon("gq-marquee", [
  ["rect", { x: "4", y: "4", width: "16", height: "16", rx: "2", strokeDasharray: "3 3", key: "a" }],
]);

export const LassoIcon = createLucideIcon("gq-lasso", [
  ["path", { d: "M7 21a4 4 0 0 1-1.5-3.5M4.5 14.5C3 13.3 2 11.7 2 10c0-4 4.5-7 10-7s10 3 10 7-4.5 7-10 7c-1.8 0-3.5-.3-5-.9", key: "a" }],
  ["circle", { cx: "5.5", cy: "16", r: "1.8", key: "b" }],
]);

/** A four-point spark with the wand's stick running straight out of it. */
export const WandIcon = createLucideIcon("gq-wand", [
  ["path", { d: "M16 3l1.4 3.6L21 8l-3.6 1.4L16 13l-1.4-3.6L11 8l3.6-1.4z", key: "a" }],
  ["path", { d: "M3.5 20.5 14.6 9.4", key: "b" }],
]);

export const CropIcon = createLucideIcon("gq-crop", [
  ["path", { d: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2", key: "a" }],
]);

export const BrushIcon = createLucideIcon("gq-brush", [
  ["path", { d: "M9.06 11.9 17.07 3.9a2.1 2.1 0 0 1 3 3l-8.01 8.02", key: "a" }],
  [
    "path",
    {
      d: "M7.07 14.94a3 3 0 0 0-3 3.02c0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02a4 4 0 0 0 4-4.04 3 3 0 0 0-3-3.02z",
      key: "b",
    },
  ],
]);

export const EraserIcon = createLucideIcon("gq-eraser", [
  ["path", { d: "m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21", key: "a" }],
  ["path", { d: "M22 21H7M5 11l9 9", key: "b" }],
]);

export const FillIcon = createLucideIcon("gq-fill", [
  ["path", { d: "m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0z", key: "a" }],
  ["path", { d: "m5 2 5 5M2 13h15M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z", key: "b" }],
]);

export const GradientIcon = createLucideIcon("gq-gradient", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "4", key: "a" }],
  ["path", { d: "M3 14 14 3M10 21 21 10", key: "b" }],
]);

export const TextIcon = createLucideIcon("gq-text", [["path", { d: "M4 7V4h16v3M9 20h6M12 4v16", key: "a" }]]);

export const PenIcon = createLucideIcon("gq-pen", [
  ["path", { d: "m12 19 7-7 3 3-7 7z", key: "a" }],
  ["path", { d: "m18 13-1.5-7.5L2 2l3.5 14.5L13 18z", key: "b" }],
  ["path", { d: "m2 2 7.6 7.6", key: "c" }],
  ["circle", { cx: "11", cy: "11", r: "2", key: "d" }],
]);

export const ShapeIcon = createLucideIcon("gq-shape", [
  ["rect", { x: "3", y: "3", width: "11", height: "11", rx: "2.5", key: "a" }],
  ["circle", { cx: "16", cy: "16", r: "5", key: "b" }],
]);

export const HandIcon = createLucideIcon("gq-hand", [
  ["path", { d: "M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8", key: "a" }],
  ["path", { d: "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15", key: "b" }],
]);

export const ZoomIcon = createLucideIcon("gq-zoom", [
  ["circle", { cx: "11", cy: "11", r: "7", key: "a" }],
  ["path", { d: "m20 20-3.5-3.5M11 8v6M8 11h6", key: "b" }],
]);
