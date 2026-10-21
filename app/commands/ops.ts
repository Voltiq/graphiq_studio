// What the editor lets a command do. TODO 1.1.
//
// The registry (registry.ts) says WHICH operation each command performs; this is
// the editor surface those operations come from. The operations themselves still
// live in Editor, because they close over its React state — moving their bodies
// out is the state store's job (TODO 1.5). What moved here is the mapping, and
// the decision of when a command applies, so neither is buried in the component.

import type { FxKey } from "../lib/effects";
import type { FilterType } from "../lib/filters";
import type { adjustmentOf, extraAdjustmentOf, panelOf } from "./families";

/** The dialogs a command opens with nothing to configure first. */
export type DialogId =
  | "trim"
  | "pattern-fill"
  | "open-recent"
  | "save-as"
  | "rename"
  | "more-space"
  | "export-lut"
  | "export-tiff"
  | "export-pdf"
  | "merge-hdr"
  | "batch"
  | "hdr-tone"
  | "export-hdr"
  | "preferences"
  | "workspaces"
  | "shortcuts"
  | "about"
  | "new-guide"
  | "help-start"
  | "help-docs"
  | "tour";

export type SelectModify = "border" | "smooth" | "expand" | "contract" | "feather" | "grow";
export type ViewToggle = "rulers" | "grid" | "docgrid" | "snap" | "guides" | "lockguides" | "smartguides";

export interface CommandOps {
  /** A sentence to the user: what an unavailable command says when asked to run. */
  toast(message: string): void;
  open(dialog: DialogId): void;

  // ---- documents and files
  newDoc(): void;
  openProject(): void;
  save(): void;
  closeActiveDoc(): void;
  openImport(): void;
  openExport(): void;
  exportSVG(): void;
  exportFrames(): void;
  exportPSD(): void;
  print(): void;
  openSample(): void;
  openPrefs(section: "performance" | "storage"): void;
  openColorManagement(): void;
  openCompareProfiles(): void;

  // ---- history and clipboard
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  contentAwareFill(): void;

  // ---- image
  sizeDialog(mode: "canvas" | "image"): void;
  cropToSelection(): void;
  transformImage(kind: "rotate-cw" | "rotate-ccw" | "flip-h" | "flip-v"): void;
  freeTransform(content: boolean): void;
  destructiveTone(tool: "curves" | "levels"): void;

  // ---- selection
  selectAll(): void;
  deselect(): void;
  reselect(): void;
  invertSelection(): void;
  refineEdge(): void;
  modifySelection(kind: SelectModify): void;
  selectionChannel(mode: "save" | "load"): void;
  toggleQuickMask(): void;

  // ---- layers
  newLayer(): void;
  newFill(kind: "solid" | "gradient"): void;
  duplicateLayers(): void;
  deleteLayers(): void;
  groupLayers(): void;
  ungroupActive(): void;
  frameFromActive(): void;
  toggleIsolate(): void;
  mergeLayers(): void;
  mergeVisible(): void;
  stampVisible(): void;
  flatten(): void;
  toggleClippingMask(): void;
  addMask(init: "reveal" | "hide" | "selection"): void;
  deleteMask(): void;
  applyMask(): void;
  maskToSelection(): void;
  addVectorMask(): void;
  invertVectorMask(): void;
  deleteVectorMask(): void;
  textOnPath(attach: boolean): void;
  openLayerStyle(): void;
  clearLayerStyle(): void;
  addEffect(key: FxKey): void;
  openSmartFilters(): void;
  addFilter(type: FilterType): void;
  addToneAdjustment(tool: "curves" | "levels"): void;
  addAdjustment(type: ReturnType<typeof adjustmentOf>): void;
  addExtraAdjustment(type: ReturnType<typeof extraAdjustmentOf>): void;
  openBlurGallery(): void;
  openLiquify(): void;
  openWarp(): void;

  // ---- view and workspace
  zoom(step: "in" | "out" | "fit" | "100"): void;
  toggleView(key: ViewToggle): void;
  clearGuides(): void;
  toggleCompare(): void;
  toggleCompareAxis(): void;
  toggleProof(): void;
  toggleGamut(): void;
  togglePerfHud(): void;
  togglePanel(panel: ReturnType<typeof panelOf>): void;
  resetWorkspace(): void;
}
