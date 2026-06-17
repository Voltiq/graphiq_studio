export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0–100 */
  opacity: number;
  blend: string;
}

export const BLEND_MODES = [
  "Normal",
  "Dissolve",
  "Darken",
  "Multiply",
  "Color Burn",
  "Linear Burn",
  "Lighten",
  "Screen",
  "Color Dodge",
  "Add",
  "Overlay",
  "Soft Light",
  "Hard Light",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
];

/** Everything the Layers panel needs to read & mutate the active doc's stack. */
export interface LayersApi {
  layers: Layer[];
  activeLayerId: string | null;
  add: () => void;
  remove: (id: string) => void;
  select: (id: string) => void;
  update: (id: string, patch: Partial<Layer>) => void;
  /** Move `fromId` to just before/after `targetId`. */
  move: (fromId: string, targetId: string, before: boolean) => void;
}
