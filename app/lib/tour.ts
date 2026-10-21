// The onboarding tour — what it says, where it points, and what it asks you to
// try. TourOverlay renders it; TourArt draws each stop's illustration;
// tour-layout places the card.
//
// A stop either SPOTLIGHTS a piece of chrome, found by its `data-tour`
// attribute and measured live, or is a CENTRED card about an idea (non-
// destructive editing, selections) that has no single place on screen. The tour
// opens and closes on centred cards, so the first and last thing anyone sees
// depends on no element existing at all.
//
// TWO LAPS, because the desktop one cannot be repaired into a mobile one.
// Measured at 390×844, three of the desktop spotlights pointed at nothing a
// phone user could see:
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
// The words differ as much: the desktop lap teaches Ctrl+K, hovering for a
// shortcut, the scroll wheel and right-clicking, none of which a phone has. So
// the phone walks its own lap, over chrome that is on screen the whole time.
// (On any shell, a stop whose chrome is not on screen when the tour opens — a
// hidden panel, a tablet's closed dock — is skipped rather than shown empty.)

/** What a "try it" watches. Read from the editor while the tour is open. */
export interface TourWatch {
  tool: string;
  zoom: number;
}

/** A small task the stop invites you to do, and how the tour notices it. */
export interface TourTry {
  /** What to do — one short sentence. */
  prompt: string;
  /** Has it been done? `start` is what was true when the stop opened. */
  done: (now: TourWatch, start: TourWatch) => boolean;
  /** Said once it has. */
  praise: string;
  /** Where the spotlight lets you through to the app: the elements inside the
   *  target matching this selector (default: all of the target). */
  hit?: string;
  /** What reaches through it. `pointer` (the default): clicks, taps and the
   *  wheel. `wheel`: the wheel alone, for a try-it over the canvas, where a
   *  click would paint on the picture. */
  reach?: "pointer" | "wheel";
}

/** One line of a stop's tips: the keys (drawn as key caps) and what they do.
 *  Each entry of `keys` is one way to do it — "M", "L", "W" are three — and a
 *  `+` inside one joins keys pressed together: "Ctrl+Shift+N". */
export interface TourTip {
  keys?: string[];
  text: string;
}

/** The illustration a stop shows (see TourArt). */
export type TourArtId =
  | "welcome"
  | "palette"
  | "tools"
  | "options"
  | "zoom"
  | "layers"
  | "adjust"
  | "select"
  | "readout"
  | "export"
  | "done"
  | "dockbar"
  | "card"
  | "pinch";

export interface TourStep {
  id: string;
  /** `[data-tour="…"]` to spotlight; absent = a centred card. */
  target?: string;
  /** Small caps above the title: the part of the tour this stop is in. */
  eyebrow: string;
  title: string;
  body: string;
  tips?: TourTip[];
  /** Lay the tips out as a two-column cheat sheet (the last stop's). */
  sheet?: boolean;
  art: TourArtId;
  try?: TourTry;
}

/** "Change the tool" — the tool in your hand differs from the one you had. */
const toolChanged = (now: TourWatch, start: TourWatch) => now.tool !== start.tool;
/** "Zoom the picture" — any change at all to the zoom level. */
const zoomChanged = (now: TourWatch, start: TourWatch) => now.zoom !== start.zoom;

/** The desktop lap. */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    eyebrow: "Welcome",
    title: "Welcome to Graphiq Studio",
    body: "A complete photo editor that runs entirely in your browser — layers, masks, adjustments and dozens of tools — and your pictures never leave your computer. Here's a two-minute look around.",
    tips: [
      { keys: ["←", "→"], text: "Move through the tour" },
      { keys: ["Esc"], text: "Leave whenever you like" },
    ],
    art: "welcome",
  },
  {
    id: "topbar",
    target: "topbar",
    eyebrow: "The basics",
    title: "Menus & search",
    body: "Every command lives in these menus. Faster still: press Ctrl+K anywhere and type what you're after — “curves”, “flatten”, “export” — then press Enter.",
    tips: [
      { keys: ["Ctrl+K"], text: "Search every command and tool" },
      { keys: ["Ctrl+Z"], text: "Undo — the arrows on the right do the same" },
      { text: "A greyed-out command tells you why when you hover it" },
    ],
    art: "palette",
  },
  {
    id: "toolbar",
    target: "toolbar",
    eyebrow: "The basics",
    title: "Tools",
    body: "Brushes, selections, healing, text, shapes and more. Tools that do a similar job share a slot: one with a mark in its corner holds several — right-click it, or press and hold, to choose.",
    tips: [
      { text: "Hover a tool for its name and its one-key shortcut" },
      { keys: ["X"], text: "Swap the two colours at the foot of the rail" },
    ],
    art: "tools",
    try: {
      prompt: "Try it: click a different tool, or press V for Move.",
      done: toolChanged,
      praise: "That's it — and the bar above already shows its settings.",
    },
  },
  {
    id: "options",
    target: "options",
    eyebrow: "The basics",
    title: "Tool options",
    body: "This bar always shows the settings of the tool in your hand: brush size and hardness, selection modes, gradient stops, crop ratios. Click any number to type an exact value.",
    tips: [
      { keys: ["[", "]"], text: "Make the brush smaller or larger" },
      { text: "The preset menu remembers settings you like" },
    ],
    art: "options",
  },
  {
    id: "canvas",
    target: "canvas",
    eyebrow: "The basics",
    title: "The canvas",
    body: "Documents open here as tabs; drop image files anywhere on the window to open them. The scroll wheel moves around the picture, and holding Ctrl as you scroll zooms toward the cursor.",
    tips: [
      { keys: ["Ctrl+0"], text: "Fit the picture on screen" },
      { keys: ["Ctrl+1"], text: "See it at 100%" },
      { keys: ["H"], text: "The Hand tool: drag to move around" },
    ],
    art: "zoom",
    try: {
      prompt: "Try it: hold Ctrl and scroll over the picture.",
      done: zoomChanged,
      praise: "Nice. Ctrl+0 fits it back on screen whenever you like.",
      reach: "wheel",
    },
  },
  {
    id: "dock",
    target: "dock",
    eyebrow: "The basics",
    title: "Layers & panels",
    body: "Layers, adjustments, history, colour and swatches live in these panels. Every layer has its own visibility, blend mode and opacity — and a mask, when you add one.",
    tips: [
      { keys: ["Ctrl+Shift+N"], text: "A new layer" },
      { text: "Drag a panel's header to reorder it, or float it with its pin" },
      { text: "The Window menu shows or hides any panel" },
    ],
    art: "layers",
  },
  {
    id: "nondestructive",
    eyebrow: "Editing",
    title: "Change your mind any time",
    body: "Adjustment layers, layer effects, smart filters and masks never touch your pixels. Hide one, tweak it or delete it whenever you like — the picture underneath stays exactly as it was.",
    tips: [
      { text: "Layer ▸ Adjustment: levels, curves, hue and saturation, and more" },
      { text: "History keeps every step; a snapshot keeps the ones that matter" },
    ],
    art: "adjust",
  },
  {
    id: "selections",
    eyebrow: "Editing",
    title: "Selections",
    body: "Select first, and whatever you do next happens only inside it. Drag a marquee, trace a lasso, click with the magic wand or paint with Quick Selection — soft edges are kept all the way through.",
    tips: [
      { keys: ["M", "L", "W"], text: "Marquee, lasso and magic wand" },
      { keys: ["Ctrl", "Alt"], text: "Hold Ctrl as you drag to add to it, Alt to take away" },
      { keys: ["Q"], text: "Quick Mask: paint a selection with any brush" },
      { keys: ["Shift+F6"], text: "Feather — soften its edge" },
    ],
    art: "select",
  },
  {
    id: "status",
    target: "status",
    eyebrow: "Finding your way",
    title: "Readouts",
    body: "The document's size and colour space, where your cursor is (or how big the selection is), how far you're zoomed in, and whether your work is saved — all at the foot of the canvas.",
    art: "readout",
  },
  {
    id: "export",
    target: "export",
    eyebrow: "Finding your way",
    title: "Saving & exporting",
    body: "Your work is kept safe in this browser as you go, and a crash brings it back. Save a project to keep every layer editable; Export makes a PNG, JPEG or WebP — and File has TIFF, PDF and layered PSD.",
    tips: [
      { keys: ["Ctrl+S"], text: "Save the project, layers and all" },
      { keys: ["Ctrl+Shift+E"], text: "Export a picture" },
    ],
    art: "export",
  },
  {
    id: "finish",
    eyebrow: "All set",
    title: "You're ready",
    body: "That's the whole lap. Open the sample to explore a real layered picture, or start on your own. You can take this tour again from Help ▸ Interactive tour.",
    tips: [
      { keys: ["Ctrl+K"], text: "Find anything" },
      { keys: ["Ctrl+Z"], text: "Undo" },
      { keys: ["B"], text: "Brush" },
      { keys: ["V"], text: "Move" },
      { keys: ["M"], text: "Select" },
      { keys: ["Ctrl+0"], text: "Fit on screen" },
    ],
    sheet: true,
    art: "done",
  },
];

/**
 * The phone's lap.
 *
 * Every spotlight is chrome that is on screen the whole time: the top bar, the
 * bottom bar, the options card, the stage, the status readout and the Export
 * button. The tools sheet and the panels sheet are reached THROUGH the bottom
 * bar, so the stop points at the buttons that open them rather than at a drawer
 * sitting off-screen — which is also the more useful thing to be shown.
 */
export const MOBILE_TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    eyebrow: "Welcome",
    title: "Welcome to Graphiq Studio",
    body: "A complete photo editor that runs right here in your browser — layers, masks, adjustments and dozens of tools — and your pictures never leave your phone. Here's a quick look around.",
    tips: [{ text: "Swipe this card sideways to move through the tour" }],
    art: "welcome",
  },
  {
    id: "topbar",
    target: "topbar",
    eyebrow: "The basics",
    title: "Menus, search & your document",
    body: "☰ opens the menus, with Search at the top: type “curves”, “flatten” or “export” and every command and tool is one tap away. Tap the document's name to switch documents or rename one.",
    tips: [{ text: "A greyed-out command tells you why — press and hold it" }],
    art: "palette",
  },
  {
    id: "mobilebar",
    target: "mobilebar",
    eyebrow: "The basics",
    title: "Tools & panels",
    body: "Move, Select, Brush and Eraser are one tap away. The hand moves the picture without putting your tool down, the grid opens every tool by name, and the stack slides the panels up.",
    art: "dockbar",
    try: {
      prompt: "Try it: tap one of the other tools on the left.",
      done: toolChanged,
      praise: "That's it — its settings are on the card above.",
      // The four tools only: the grid and the stack open sheets, which would
      // come up underneath the tour.
      hit: "[data-quick]",
    },
  },
  {
    id: "options",
    target: "options",
    eyebrow: "The basics",
    title: "Tool settings",
    body: "This card holds the settings of the tool in your hand. Drag its grip to see more or fewer of them, or tap it to fold the card into one slim row. The Shift, Alt and Ctrl keys sit along its foot.",
    art: "card",
  },
  {
    id: "canvas",
    target: "canvas",
    eyebrow: "The basics",
    title: "The canvas",
    body: "Pinch to zoom; the hand in the bottom bar moves the picture with one finger. With the eyedropper, pen or clone stamp, a magnifier shows the pixels under your fingertip as you press.",
    art: "pinch",
    try: {
      prompt: "Try it: pinch the picture.",
      done: zoomChanged,
      praise: "Nice — and the zoom readout follows along.",
    },
  },
  {
    id: "nondestructive",
    eyebrow: "Editing",
    title: "Layers you can always change",
    body: "The stack button opens your layers, adjustments and history. Adjustment layers and masks never touch your pixels, so you can hide, tweak or remove them whenever you change your mind.",
    art: "layers",
  },
  {
    id: "status",
    target: "mobilestatus",
    eyebrow: "Finding your way",
    title: "Where you are",
    body: "The picture's size and how far you're zoomed in. Pinch the canvas and watch the number follow — tap it to fit the picture back on screen.",
    art: "readout",
  },
  {
    id: "export",
    target: "export",
    eyebrow: "Finding your way",
    title: "Saving & exporting",
    body: "Your work is kept safe on this device as you go, and comes back after a crash. Export saves the picture to your phone as a PNG, JPEG or WebP; File ▸ Save keeps every layer editable.",
    art: "export",
  },
  {
    id: "finish",
    eyebrow: "All set",
    title: "You're ready",
    body: "That's the whole lap. Open the sample to explore a real layered picture, or start on your own. You can take this tour again from ☰ ▸ Help ▸ Interactive tour.",
    tips: [
      { keys: ["Pinch"], text: "Zoom in and out" },
      { keys: ["☰ ▸ Search"], text: "Find any command or tool" },
      { keys: ["Press"], text: "A magnifier, with the eyedropper, pen or clone stamp" },
      { keys: ["Back"], text: "Closes the sheet or dialog in front" },
    ],
    sheet: true,
    art: "done",
  },
];

/** The lap for this shell. */
export const tourSteps = (mobile: boolean): TourStep[] => (mobile ? MOBILE_TOUR_STEPS : TOUR_STEPS);

/**
 * May this key reach the editor while a "try it" is on screen? The tour keeps
 * the keyboard to itself otherwise. Let through: a tool's letter (plain or
 * with Shift, which cycles a shared slot), the brush size keys and the zoom
 * shortcuts — what the try-its ask for, and nothing that opens something
 * underneath the tour.
 */
export function passesThrough(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  if (e.altKey) return false;
  if (e.ctrlKey || e.metaKey) return ["=", "+", "-", "0", "1"].includes(e.key);
  return /^[a-z[\]]$/i.test(e.key);
}
