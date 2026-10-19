// Interactive onboarding tour (TODO §11) — the step definitions.
//
// Each step spotlights a chrome region found by its `data-tour` attribute
// (TourOverlay measures it live, so docked/floating layouts still work);
// steps without a target render as a centred card (welcome / finish).
//
// TWO LISTS, because the desktop one cannot be repaired into a mobile one.
// Measured at 390×844, three of its six spotlights pointed at nothing a phone
// user could see:
//
//   toolbar  320×692 at x=-320 — the tools rail is a closed drawer, VISIBLE
//                                AREA ZERO. An empty rectangle off the side.
//   dock     390×422 at y=788  — the panels sheet is parked below the fold;
//                                its only on-screen sliver is 788–844, which
//                                is precisely the MobileBar's own rect, so the
//                                step said "Panels" while highlighting the
//                                bottom bar.
//   status     0×0            — the desktop status bar is `display: none`
//                                here, so the spotlight collapsed to the 12×12
//                                dot the padding leaves in the corner.
//
// The bodies were no better: they teach Ctrl+K, hovering a tool for its
// shortcut, Ctrl+wheel, Space-drag, and dragging a panel to the left dock or
// floating it — none of which a phone has, and the last two the mobile shell
// deliberately removed. So the phone gets its own lap, pointing only at chrome
// that is on screen the whole time. Nothing here has to be opened first.

export interface TourStep {
  id: string;
  /** `[data-tour="…"]` selector value; absent = centred card. */
  target?: string;
  title: string;
  body: string;
}

/** The desktop lap. */
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
    body: "Every command lives in the menu bar — or press Ctrl+K (or click the search field in the middle) and fuzzy-search it. Undo/redo, the theme toggle and Export sit on the right.",
  },
  {
    id: "toolbar",
    target: "toolbar",
    title: "Tools",
    body: "Move, selections, brushes, healing, text, shapes… Tools that share a job share a button: one with a mark in its corner holds more — right-click it, or press and hold, to pick another. Hover any tool for its name and single-letter shortcut. The two swatches at the bottom are your foreground and background colours (X swaps them).",
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
    title: "Readouts",
    body: "The document's size and colour space, the cursor position or selection while there is one, and the save state float at the foot of the canvas, either side of the zoom controls.",
  },
  {
    id: "finish",
    title: "That's the lap",
    body: "Open the sample document to poke at real layers, groups and labels — or dive straight in. Help ▸ Getting started keeps the written walkthrough, and Ctrl+K finds anything.",
  },
];

/**
 * The phone's lap.
 *
 * Deliberately shorter, and every target is chrome that is always on screen:
 * the top bar, the bottom bar, the options bar, the stage and the status
 * readout. The tools sheet and the panels sheet are reached THROUGH the bottom
 * bar, so the step points at the buttons that open them rather than at a
 * drawer sitting off-screen — which is also the more useful thing to be shown.
 */
export const MOBILE_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Graphiq Studio",
    body: "A quick lap around the workspace — half a minute, no commitment. You can re-run this any time from Help ▸ Interactive tour.",
  },
  {
    id: "topbar",
    target: "topbar",
    title: "Menus, search & your document",
    body: "☰ opens the menus — and Search, at the top of them: type what you want, “curves”, “flatten”, “export”, and every command and tool is one tap away. Tap the document's name to switch documents, or to rename it.",
  },
  {
    id: "mobilebar",
    target: "mobilebar",
    title: "Your main controls",
    body: "Move, Select, Brush and Eraser are one tap away. The hand pans the picture without giving up your tool; the grid opens every tool, named; the stack slides the panels up.",
  },
  {
    id: "options",
    target: "options",
    title: "Tool settings",
    body: "This card holds the settings of the tool you are holding. Drag its grip to show more or less of them, or tap the grip to fold it away. Anything you must not lose, like Crop's Apply, stays beside the tool's name, and the Shift, Alt and Ctrl keys sit along its foot.",
  },
  {
    id: "canvas",
    target: "canvas",
    title: "The canvas",
    body: "Pinch to zoom, and press and hold with the eyedropper, pen or clone stamp for a magnifier that shows the pixels under your fingertip. Photos you open land here at their own size.",
  },
  {
    id: "status",
    target: "mobilestatus",
    title: "Where you are",
    body: "The picture's size and how far you are zoomed in. Pinch the canvas and watch the number follow — tap it to fit the picture back on screen. The document's name, and whether it is saved, sit in the header.",
  },
  {
    id: "finish",
    title: "That's the lap",
    body: "Open the sample document to poke at real layers and groups — or dive straight in. Help ▸ Getting started keeps the written walkthrough, and Search finds anything.",
  },
];

/** The lap for this shell. */
export const tourSteps = (mobile: boolean): TourStep[] =>
  mobile ? MOBILE_TOUR_STEPS : TOUR_STEPS;
