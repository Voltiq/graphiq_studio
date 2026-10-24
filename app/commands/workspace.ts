// The workspace family (TODO 1.10): what the command table did itself — open a
// dialog or the tour, zoom, flip a view flag, compare and its axis, proof,
// gamut, the HUD, show or hide a panel, reset the workspace. Each toggles state
// Editor keeps (or the view store), so this is the last of the table's bodies.
//
// `workspaceOps` is called on every render of Editor, as `layerOps` is.

import type { ViewApi } from "../components/CanvasArea";
import type { DockApi } from "../components/RightDock";
import type { CompareAxis } from "../lib/compare";
import { openDialog, type DialogState } from "../state/dialogs";
import type { Store } from "../state/store";
import { ALL_PANELS, setPanels, setViewFlags, type ViewState } from "../state/view";
import type { CommandOps } from "./ops";

/** What the workspace operations need of the editor. */
export interface WorkspaceContext {
  dialogs: Store<DialogState>;
  view: Store<ViewState>;
  /** The canvas's zoom controls, once it has mounted. */
  viewApiRef: { readonly current: ViewApi | null };
  /** The dock, for the factory layout. */
  dockRef: { readonly current: DockApi | null };
  setTour(tour: "open"): void;
  setCompareSplit(update: (split: number | null) => number | null): void;
  setCompareAxis(update: (axis: CompareAxis) => CompareAxis): void;
  setProofColors(update: (on: boolean) => boolean): void;
  setGamutWarn(update: (on: boolean) => boolean): void;
  setPerfHud(update: (on: boolean) => boolean): void;
}

export type WorkspaceOps = Pick<
  CommandOps,
  | "open"
  | "zoom"
  | "toggleView"
  | "toggleCompare"
  | "toggleCompareAxis"
  | "toggleProof"
  | "toggleGamut"
  | "togglePerfHud"
  | "togglePanel"
  | "resetWorkspace"
>;

export function workspaceOps(ctx: WorkspaceContext): WorkspaceOps {
  const { dialogs, view: viewStore, viewApiRef, dockRef, setTour } = ctx;
  const { setCompareSplit, setCompareAxis, setProofColors, setGamutWarn, setPerfHud } = ctx;

  return {
    open: (dialog) => (dialog === "tour" ? setTour("open") : openDialog(dialogs, dialog)),
    zoom: (step) => {
      const view = viewApiRef.current;
      if (step === "in") view?.zoomIn();
      else if (step === "out") view?.zoomOut();
      else if (step === "fit") view?.fit();
      else view?.zoom100();
    },
    toggleView: (key) => setViewFlags(viewStore, { [key]: !viewStore.get()[key] }),
    toggleCompare: () => setCompareSplit((s) => (s === null ? 50 : null)),
    toggleCompareAxis: () => setCompareAxis((a) => (a === "vertical" ? "horizontal" : "vertical")),
    toggleProof: () => setProofColors((p) => !p),
    toggleGamut: () => setGamutWarn((g) => !g),
    togglePerfHud: () => setPerfHud((h) => !h),
    togglePanel: (key) => setPanels(viewStore, { ...viewStore.get().panels, [key]: !viewStore.get().panels[key] }),
    resetWorkspace: () => {
      setPanels(viewStore, { ...ALL_PANELS });
      dockRef.current?.apply(null); // factory dock layout: all right, none floating
    },
  };
}
