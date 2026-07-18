// Interactive onboarding tour (TODO §11) — the step definitions.
//
// Each step spotlights a chrome region found by its `data-tour` attribute
// (TourOverlay measures it live, so docked/floating layouts still work);
// steps without a target render as a centred card (welcome / finish).

export interface TourStep {
  id: string;
  /** `[data-tour="…"]` selector value; absent = centred card. */
  target?: string;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Graphiq Studio",
    body: "A quick lap around the workspace — half a minute, no commitment. You can re-run this any time from Help ▸ Interactive tour.",
  },
  {
    id: "topbar",
    target: "topbar",
    title: "Menus & search",
    body: "Every command lives in the menu bar — or press Ctrl+K and fuzzy-search it. Undo/redo and the theme toggle sit on the right.",
  },
  {
    id: "toolbar",
    target: "toolbar",
    title: "Tools",
    body: "Move, selections, brushes, healing, text, shapes… hover any tool for its name and single-letter shortcut. The two swatches at the bottom are your foreground and background colours (X swaps them).",
  },
  {
    id: "options",
    target: "options",
    title: "Tool options",
    body: "This bar always shows the ACTIVE tool's settings — brush size and hardness, selection modes, gradient stops, crop ratios. Click any number to type an exact value.",
  },
  {
    id: "canvas",
    target: "canvas",
    title: "The canvas",
    body: "Documents open as tabs above the artwork. Zoom with Ctrl+wheel, pan with Space-drag, and drop image files anywhere here to import them.",
  },
  {
    id: "dock",
    target: "dock",
    title: "Panels",
    body: "Layers, adjustments, history, swatches and friends. Drag a panel's header to reorder it, move it to the left dock, or float it with the pin. The Window menu toggles what's visible.",
  },
  {
    id: "status",
    target: "status",
    title: "Status bar",
    body: "Zoom (click the number to type one), document size, colour space, cursor position and the save state live down here.",
  },
  {
    id: "finish",
    title: "That's the lap",
    body: "Open the sample document to poke at real layers, groups and labels — or dive straight in. Help ▸ Getting started keeps the written walkthrough, and Ctrl+K finds anything.",
  },
];
