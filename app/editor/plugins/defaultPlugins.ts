import type { EditorPlugin } from "../types";

const clamp = (value: number, min = -1, max = 1) =>
  Math.min(max, Math.max(min, value));

export const defaultPlugins: EditorPlugin[] = [
  {
    id: "soft-glow",
    name: "Soft Glow",
    description: "Boosts exposure and saturation for a dreamy cinematic result.",
    apply: (state) => ({
      adjustments: {
        ...state.adjustments,
        exposure: clamp(state.adjustments.exposure + 0.15),
        saturation: clamp(state.adjustments.saturation + 0.2),
        highlights: clamp(state.adjustments.highlights + 0.1),
      },
    }),
  },
  {
    id: "film-grit",
    name: "Analog Film",
    description: "Adds contrast and cool tones inspired by retro film stocks.",
    apply: (state) => ({
      adjustments: {
        ...state.adjustments,
        contrast: clamp(state.adjustments.contrast + 0.25),
        temperature: clamp(state.adjustments.temperature - 0.15),
        shadows: clamp(state.adjustments.shadows - 0.1),
      },
      color: {
        ...state.color,
        primary: "#9fc5ff",
      },
    }),
  },
  {
    id: "infrared",
    name: "Infrared Shift",
    description: "Experimental look that flips warmth for vibrant infrared hues.",
    apply: (state) => ({
      adjustments: {
        ...state.adjustments,
        saturation: clamp(state.adjustments.saturation + 0.3),
        tint: clamp(state.adjustments.tint + 0.4),
        temperature: clamp(state.adjustments.temperature + 0.35),
      },
      color: {
        ...state.color,
        primary: "#ff6ac2",
        secondary: "#5ef5ff",
      },
    }),
  },
];
