// The view (TODO 1.5, the `ui/panels` slice): the View menu's toggles —
// rulers, the pixel and document grids, snapping, guides — and which panels
// the Window menu shows. Both are remembered between sessions, each the moment
// a menu changes it.

import { createStore, type Store } from "./store";

/** Which dock panels the Window menu shows. */
export type PanelVisibility = {
  color: boolean;
  swatches: boolean;
  brushes: boolean;
  adjustments: boolean;
  properties: boolean;
  layers: boolean;
  paths: boolean;
  comps: boolean;
  history: boolean;
  actions: boolean;
  navigator: boolean;
  channels: boolean;
  metadata: boolean;
  info: boolean;
};

export const ALL_PANELS: PanelVisibility = {
  color: true,
  swatches: true,
  brushes: true,
  adjustments: true,
  properties: true,
  layers: true,
  paths: true,
  comps: true,
  history: true,
  actions: true,
  navigator: true,
  channels: true,
  metadata: true,
  info: true,
};

/** The View menu's toggles, by the names they are stored under. */
export interface ViewFlags {
  rulers: boolean;
  /** The pixel grid. */
  grid: boolean;
  snap: boolean;
  /** The document grid (Preferences ▸ Guides & grid sets its spacing). */
  docgrid: boolean;
  /** Visibility doubles as the snap switch — Photoshop's rule: hidden guides
   *  pull on nothing. Locked guides still show and still snap, they just can't
   *  be dragged. The guides themselves are per-document. */
  guides: boolean;
  lockguides: boolean;
  smartguides: boolean;
}

export interface ViewState extends ViewFlags {
  panels: PanelVisibility;
}

const VIEW_KEY = "pe-view";
const PANELS_KEY = "pe-panels";

/** The page's localStorage, reached only when used (it can throw then). */
export const browserStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (k) => window.localStorage.getItem(k),
  setItem: (k, v) => window.localStorage.setItem(k, v),
};

export const createView = (): Store<ViewState> =>
  createStore<ViewState>({
    rulers: true,
    grid: false,
    snap: true,
    docgrid: false,
    guides: true,
    lockguides: false,
    smartguides: true,
    panels: ALL_PANELS,
  });

const flagsOf = (v: ViewState): ViewFlags => ({
  rulers: v.rulers,
  grid: v.grid,
  snap: v.snap,
  docgrid: v.docgrid,
  guides: v.guides,
  lockguides: v.lockguides,
  smartguides: v.smartguides,
});

/** Bring back the last session's view: a stored flag wins either way, and a
 *  missing one keeps its default — except the rulers, which default OFF.
 *  True when the stored view could be read (the rulers are decided then). */
export function restoreView(view: Store<ViewState>, storage: Pick<Storage, "getItem"> = browserStorage): boolean {
  try {
    const saved = storage.getItem(PANELS_KEY);
    if (saved) view.set({ panels: { ...ALL_PANELS, ...JSON.parse(saved) } });
  } catch {
    /* ignore */
  }
  try {
    const v = JSON.parse(storage.getItem(VIEW_KEY) || "{}");
    /* Rulers default OFF — on every shell, as the design shows the stage and
       as Photoshop starts — and that is a DEFAULT, not an override: a stored
       boolean wins either way, so View ▸ Show rulers sticks once it is used.
       On a touch device it is also the right call on its own merits: a ruler
       is for measuring against a pointer you can place precisely, and on a
       768px tablet the vertical one was the last 22px between the stage and
       the whole width. */
    const patch: Partial<ViewFlags> = { rulers: typeof v.rulers === "boolean" ? v.rulers : false };
    for (const k of ["grid", "snap", "docgrid", "guides", "lockguides", "smartguides"] as const) {
      if (typeof v[k] === "boolean") patch[k] = v[k];
    }
    view.set(patch);
    return true;
  } catch {
    return false;
  }
}

/** Change view toggles and remember them (the View menu's way). */
export function setViewFlags(
  view: Store<ViewState>,
  patch: Partial<ViewFlags>,
  storage: Pick<Storage, "setItem"> = browserStorage,
): void {
  const next = { ...flagsOf(view.get()), ...patch };
  view.set(next);
  try {
    storage.setItem(VIEW_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Show or hide panels and remember it (the Window menu's way). */
export function setPanels(
  view: Store<ViewState>,
  panels: PanelVisibility,
  storage: Pick<Storage, "setItem"> = browserStorage,
): void {
  view.set({ panels });
  try {
    storage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    /* ignore */
  }
}
