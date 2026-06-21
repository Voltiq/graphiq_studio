import type { LucideIcon } from "lucide-react";
import {
  MousePointer2,
  Move,
  BoxSelect,
  Lasso,
  Wand2,
  Crop,
  Pipette,
  Brush,
  Pencil,
  Eraser,
  Stamp,
  PaintBucket,
  Blend,
  Droplet,
  SunMedium,
  Type,
  PenTool,
  Shapes,
  Hand,
  ZoomIn,
} from "lucide-react";

export type ToolId =
  | "move"
  | "select"
  | "lasso"
  | "wand"
  | "crop"
  | "eyedropper"
  | "brush"
  | "pencil"
  | "eraser"
  | "clone"
  | "bucket"
  | "gradient"
  | "blur"
  | "dodge"
  | "text"
  | "pen"
  | "shape"
  | "hand"
  | "zoom";

export interface Tool {
  id: ToolId;
  name: string;
  icon: LucideIcon;
  shortcut: string;
}

/** Tools grouped the way they sit on the rail; each inner array is a cluster. */
export const TOOL_GROUPS: Tool[][] = [
  [
    { id: "move", name: "Move", icon: Move, shortcut: "V" },
    { id: "select", name: "Rectangular Marquee", icon: BoxSelect, shortcut: "M" },
    { id: "lasso", name: "Lasso", icon: Lasso, shortcut: "L" },
    { id: "wand", name: "Magic Wand", icon: Wand2, shortcut: "W" },
    { id: "crop", name: "Crop", icon: Crop, shortcut: "C" },
    { id: "eyedropper", name: "Eyedropper", icon: Pipette, shortcut: "I" },
  ],
  [
    { id: "brush", name: "Brush", icon: Brush, shortcut: "B" },
    { id: "pencil", name: "Pencil", icon: Pencil, shortcut: "N" },
    { id: "eraser", name: "Eraser", icon: Eraser, shortcut: "E" },
    { id: "clone", name: "Clone Stamp", icon: Stamp, shortcut: "S" },
    { id: "bucket", name: "Paint Bucket", icon: PaintBucket, shortcut: "G" },
    { id: "gradient", name: "Gradient", icon: Blend, shortcut: "G" },
  ],
  [
    { id: "blur", name: "Blur", icon: Droplet, shortcut: "R" },
    { id: "dodge", name: "Dodge", icon: SunMedium, shortcut: "O" },
  ],
  [
    { id: "text", name: "Text", icon: Type, shortcut: "T" },
    { id: "pen", name: "Pen", icon: PenTool, shortcut: "P" },
    { id: "shape", name: "Shape", icon: Shapes, shortcut: "U" },
  ],
  [
    { id: "hand", name: "Hand", icon: Hand, shortcut: "H" },
    { id: "zoom", name: "Zoom", icon: ZoomIn, shortcut: "Z" },
  ],
];

export const ALL_TOOLS: Tool[] = TOOL_GROUPS.flat();

export const DEFAULT_TOOL: ToolId = "brush";

/** Move tool sub-mode: move the marquee outline only, or the actual pixels. */
export type MoveMode = "pixels" | "selection";

/** Shape tool: the geometry being drawn. */
export type ShapeKind = "rect" | "ellipse" | "tri";

/** Shape tool settings (fill = primary colour, stroke = secondary colour). */
export interface ShapeSettings {
  kind: ShapeKind;
  strokeWidth: number;
  radius: number;
}

/** Marquee resize sub-mode: resize the outline only, or scale the pixels inside. */
export type SelectResizeMode = "bounds" | "content";

/** Eyedropper sampling options. */
export const SAMPLE_SIZE_OPTIONS = [
  "Point sample",
  "3×3 average",
  "5×5 average",
  "11×11 average",
];
export const SAMPLE_SIZE_PX: Record<string, number> = {
  "Point sample": 1,
  "3×3 average": 3,
  "5×5 average": 5,
  "11×11 average": 11,
};
export const SAMPLE_SCOPE_OPTIONS = ["All layers", "Current layer"];

/** Map a single keyboard letter to a tool id (first match wins for dupes). */
export const TOOL_BY_KEY: Record<string, ToolId> = (() => {
  const m: Record<string, ToolId> = {};
  for (const t of ALL_TOOLS) {
    const k = t.shortcut.toLowerCase();
    if (!(k in m)) m[k] = t.id;
  }
  return m;
})();

export const getTool = (id: ToolId): Tool =>
  ALL_TOOLS.find((t) => t.id === id) ?? ALL_TOOLS[0];

/** Pointer cursor preview used in the options bar headline. */
export { MousePointer2 };
