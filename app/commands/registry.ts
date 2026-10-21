// The command registry: for every menu command, what it does, when it applies,
// and whether an action may record it. TODO 1.1.
//
// `CommandId` is derived from the menu (lib/menus.ts), and DIRECT is typed
// `{ [K in DirectCommand]: Command }`, so a command with no entry here — or an
// entry for an id no menu has — is a compile error. The families (panels,
// adjustments, effects, smart filters) carry their argument in the id and are
// built from it below.
//
// AVAILABILITY. `when(state)` is the one answer to "does this apply now?", read
// by the menu bar, the phone's menu sheet, the command palette and every way a
// command is run (keys, scripts, recorded actions). An unavailable command says
// WHY; a reason marked `quiet` greys the row but is not announced when the
// command is run anyway — Ctrl+D with nothing selected should do nothing, as it
// always did, not raise a toast. The loud reasons are the sentences the editor
// used to toast from inside the handler after the click.

import { MIN_ANCHORS } from "../lib/vector-mask";
import { COMMAND_IDS, isCommandId, type CommandId } from "../lib/menus";
import {
  adjustmentOf,
  effectOf,
  extraAdjustmentOf,
  familyOf,
  filterOf,
  panelOf,
  type DirectCommand,
  type FamilyCommand,
} from "./families";
import type { CommandOps } from "./ops";
import type { CommandState } from "./state";

/** Why a command does not apply now. `quiet`: grey it, but say nothing if it is run. */
export interface Unavailable {
  why: string;
  quiet?: true;
}
export type Availability = true | Unavailable;

export interface Command {
  run(ops: CommandOps): void;
  /** Whether it applies now; absent = always. */
  when?(s: CommandState): Availability;
  /** Replays unattended, so an action may record it (no dialog to answer). */
  recordable?: true;
}

const say = (why: string): Unavailable => ({ why });
const quiet = (why: string): Unavailable => ({ why, quiet: true });

/* The reasons several commands share. */
const NO_SELECTION = quiet("Nothing is selected.");
const NO_LAYER = quiet("No layer is selected.");
const NO_MASK = quiet("This layer has no mask.");
const anyLayer = (s: CommandState): Availability => (s.targets > 0 ? true : NO_LAYER);
const activeLayer = (s: CommandState): Availability => (s.active ? true : NO_LAYER);
const selection = (s: CommandState): Availability => (s.hasSelection ? true : NO_SELECTION);
/** Effects and smart filters style a layer's own pixels; an adjustment has none. */
const styleable = (s: CommandState): Availability =>
  !s.active ? NO_LAYER : s.active.kind === "adjustment" ? quiet("An adjustment layer has no pixels to style.") : true;
const workPath = (s: CommandState): Availability =>
  s.workPathReady ? true : say(`Draw a path with the Pen tool first (at least ${MIN_ANCHORS} points).`);

const DIRECT: { [K in DirectCommand]: Command } = {
  // ---- File
  "new-doc": { run: (o) => o.newDoc() },
  "open": { run: (o) => o.openProject() },
  "open-recent": { run: (o) => o.open("open-recent") },
  "save": { run: (o) => o.save(), recordable: true },
  "save-as": { run: (o) => o.open("save-as") },
  "doc-rename": { run: (o) => o.open("rename") },
  "import": { run: (o) => o.openImport() },
  "merge-hdr": { run: (o) => o.open("merge-hdr") },
  "batch-process": { run: (o) => o.open("batch") },
  "export-as": { run: (o) => o.openExport() },
  "export-psd": { run: (o) => o.exportPSD() },
  "export-tiff": { run: (o) => o.open("export-tiff") },
  "export-pdf": { run: (o) => o.open("export-pdf") },
  "export-svg": { run: (o) => o.exportSVG() },
  "export-frames": { run: (o) => o.exportFrames() },
  "export-lut": { run: (o) => o.open("export-lut") },
  "export-hdr": {
    run: (o) => o.open("export-hdr"),
    when: (s) =>
      s.hasHdr || say("No HDR source — export true HDR from a document created via File ▸ Merge to HDR."),
  },
  "print": { run: (o) => o.print(), recordable: true },
  "doc-close": {
    run: (o) => o.closeActiveDoc(),
    /* One canvas always stays open (closing refuses the last one) — say so. */
    when: (s) => s.docCount > 1 || say("This is the only open document, so it stays open."),
  },

  // ---- Edit
  "undo": { run: (o) => o.undo(), when: (s) => s.canUndo || quiet("Nothing to undo."), recordable: true },
  "redo": { run: (o) => o.redo(), when: (s) => s.canRedo || quiet("Nothing to redo."), recordable: true },
  "edit-cut": {
    run: (o) => o.cut(),
    when: (s) => (!s.hasSelection ? NO_SELECTION : activeLayer(s)),
    recordable: true,
  },
  "edit-copy": { run: (o) => o.copy(), recordable: true },
  "edit-paste": { run: (o) => o.paste(), recordable: true },
  "edit-caf": {
    run: (o) => o.contentAwareFill(),
    when: (s) =>
      !s.hasSelection
        ? NO_SELECTION
        : s.active?.kind !== "layer"
          ? quiet("Content-aware fill works on a pixel layer.")
          : true,
    recordable: true,
  },
  "pattern-fill": { run: (o) => o.open("pattern-fill") },
  "free-transform": {
    run: (o) => o.freeTransform(true),
    when: (s) => (s.layerCount && s.active ? true : NO_LAYER),
  },
  "transform": {
    run: (o) => o.freeTransform(false),
    when: (s) => (s.layerCount && s.active ? true : NO_LAYER),
  },

  // ---- Image
  "image-size": { run: (o) => o.sizeDialog("image") },
  "canvas-size": { run: (o) => o.sizeDialog("canvas") },
  "image-crop": {
    run: (o) => o.cropToSelection(),
    when: (s) => s.hasSelection || say("Crop trims the canvas to the selection — make a selection first."),
    recordable: true,
  },
  "image-trim": { run: (o) => o.open("trim") },
  "tone-dest-levels": {
    run: (o) => o.destructiveTone("levels"),
    when: (s) => s.active?.kind === "layer" || say("Select a pixel layer first."),
  },
  "tone-dest-curves": {
    run: (o) => o.destructiveTone("curves"),
    when: (s) => s.active?.kind === "layer" || say("Select a pixel layer first."),
  },
  "hdr-tone": {
    run: (o) => o.open("hdr-tone"),
    when: (s) =>
      s.hasHdr ||
      say(
        "No HDR source — this works on documents created via File ▸ Merge to HDR (the float map lives in memory, not in .gproj).",
      ),
  },
  "image-rotate-cw": { run: (o) => o.transformImage("rotate-cw"), recordable: true },
  "image-rotate-ccw": { run: (o) => o.transformImage("rotate-ccw"), recordable: true },
  "image-flip-h": { run: (o) => o.transformImage("flip-h"), recordable: true },
  "image-flip-v": { run: (o) => o.transformImage("flip-v"), recordable: true },
  "view-proof": { run: (o) => o.toggleProof() },
  "view-gamut": { run: (o) => o.toggleGamut() },
  "color-compare": { run: (o) => o.openCompareProfiles() },
  "view-perf-hud": { run: (o) => o.togglePerfHud() },
  "view-more-space": { run: (o) => o.open("more-space") },

  // ---- Layer
  "layer-new": { run: (o) => o.newLayer(), recordable: true },
  "fill-solid": { run: (o) => o.newFill("solid") },
  "fill-gradient": { run: (o) => o.newFill("gradient") },
  "frame-from-layer": {
    run: (o) => o.frameFromActive(),
    when: (s) => (!s.active ? NO_LAYER : s.active.kind === "layer" || quiet("A frame is made from a pixel layer.")),
    recordable: true,
  },
  "layer-duplicate": { run: (o) => o.duplicateLayers(), when: anyLayer, recordable: true },
  "layer-delete": { run: (o) => o.deleteLayers(), when: anyLayer, recordable: true },
  "layer-group": { run: (o) => o.groupLayers(), when: anyLayer, recordable: true },
  "layer-ungroup": {
    run: (o) => o.ungroupActive(),
    when: (s) => s.active?.kind === "group" || quiet("The selected layer is not a group."),
    recordable: true,
  },
  "layer-isolate": {
    run: (o) => o.toggleIsolate(),
    /* Always available to LEAVE isolate mode; to enter it, something to isolate. */
    when: (s) => s.isolated || s.targets > 0 || say("Select a layer to isolate."),
  },
  "layer-clip": { run: (o) => o.toggleClippingMask(), when: activeLayer, recordable: true },
  "layer-merge-down": { run: (o) => o.mergeLayers(), when: anyLayer, recordable: true },
  "layer-merge-visible": {
    run: (o) => o.mergeVisible(),
    when: (s) =>
      !s.visibleLeaves
        ? say("Nothing visible to merge.")
        : s.mergeVisibleNoop
          ? say("Only one visible layer — nothing to merge into.")
          : true,
    recordable: true,
  },
  "layer-stamp-visible": {
    run: (o) => o.stampVisible(),
    when: (s) => s.visibleLeaves > 0 || say("Nothing visible to stamp."),
    recordable: true,
  },
  "layer-flatten": {
    run: (o) => o.flatten(),
    when: (s) => s.layerCount > 0 || quiet("There are no layers to flatten."),
    recordable: true,
  },
  "mask-add": {
    run: (o) => o.addMask("reveal"),
    when: (s) => (!s.active ? NO_LAYER : s.active.hasMask ? quiet("This layer already has a mask.") : true),
    recordable: true,
  },
  "mask-add-hide": {
    run: (o) => o.addMask("hide"),
    when: (s) => (!s.active ? NO_LAYER : s.active.hasMask ? quiet("This layer already has a mask.") : true),
    recordable: true,
  },
  "mask-from-sel": {
    run: (o) => o.addMask("selection"),
    when: (s) =>
      !s.active
        ? NO_LAYER
        : s.active.hasMask
          ? quiet("This layer already has a mask.")
          : s.hasSelection || say("Make a selection first to create a mask from it."),
    recordable: true,
  },
  "mask-to-sel": {
    run: (o) => o.maskToSelection(),
    when: (s) => s.active?.hasMask || NO_MASK,
    recordable: true,
  },
  "mask-apply": {
    run: (o) => o.applyMask(),
    when: (s) => (!s.active?.hasMask ? NO_MASK : s.active.maskEnabled || say("Enable the mask before applying.")),
    recordable: true,
  },
  "mask-delete": { run: (o) => o.deleteMask(), when: (s) => s.active?.hasMask || NO_MASK, recordable: true },
  "vmask-add": {
    run: (o) => o.addVectorMask(),
    when: (s) => (!s.active ? say("Select a layer to mask.") : workPath(s)),
  },
  "vmask-invert": {
    run: (o) => o.invertVectorMask(),
    when: (s) => s.active?.hasVectorMask || say("This layer has no vector mask."),
  },
  "vmask-delete": {
    run: (o) => o.deleteVectorMask(),
    when: (s) => s.active?.hasVectorMask || say("This layer has no vector mask."),
  },
  "text-on-path": {
    run: (o) => o.textOnPath(true),
    when: (s) => (!s.active?.isText ? say("Select a text layer first.") : workPath(s)),
  },
  "text-off-path": {
    run: (o) => o.textOnPath(false),
    when: (s) =>
      !s.active?.isText ? say("Select a text layer first.") : s.active.textOnPath || say("This text is not on a path."),
  },
  "fx-open": { run: (o) => o.openLayerStyle(), when: activeLayer },
  "fx-clear": {
    run: (o) => o.clearLayerStyle(),
    when: (s) => (!s.active ? NO_LAYER : s.active.hasEffects || quiet("This layer has no layer style.")),
    recordable: true,
  },
  "adj-tone-curves": { run: (o) => o.addToneAdjustment("curves") },
  "adj-tone-levels": { run: (o) => o.addToneAdjustment("levels") },

  // ---- Select
  "select-all": { run: (o) => o.selectAll(), recordable: true },
  "select-deselect": { run: (o) => o.deselect(), when: selection, recordable: true },
  "select-reselect": {
    run: (o) => o.reselect(),
    when: (s) =>
      s.canReselect ||
      quiet(s.hasSelection ? "Something is already selected." : "There is no earlier selection to bring back."),
    recordable: true,
  },
  "select-inverse": { run: (o) => o.invertSelection(), when: selection, recordable: true },
  "select-refine": {
    run: (o) => o.refineEdge(),
    when: (s) => s.hasSelection || say("Refine edge needs an active selection — make one first."),
  },
  "select-border": { run: (o) => o.modifySelection("border"), when: selection },
  "select-smooth": { run: (o) => o.modifySelection("smooth"), when: selection },
  "select-expand": { run: (o) => o.modifySelection("expand"), when: selection },
  "select-contract": { run: (o) => o.modifySelection("contract"), when: selection },
  "select-feather": { run: (o) => o.modifySelection("feather"), when: selection },
  "select-grow": { run: (o) => o.modifySelection("grow"), when: selection },
  "select-save": { run: (o) => o.selectionChannel("save") },
  "select-load": { run: (o) => o.selectionChannel("load") },
  "select-quickmask": { run: (o) => o.toggleQuickMask() },

  // ---- Effects
  "effect-blur": { run: (o) => o.openBlurGallery() },
  "filter-open": { run: (o) => o.openSmartFilters(), when: activeLayer },
  "effect-liquify": { run: (o) => o.openLiquify() },
  "effect-warp": { run: (o) => o.openWarp() },

  // ---- View
  "view-zoom-in": { run: (o) => o.zoom("in") },
  "view-zoom-out": { run: (o) => o.zoom("out") },
  "view-fit": { run: (o) => o.zoom("fit") },
  "view-100": { run: (o) => o.zoom("100") },
  "view-rulers": { run: (o) => o.toggleView("rulers") },
  "view-grid": { run: (o) => o.toggleView("grid") },
  "view-docgrid": { run: (o) => o.toggleView("docgrid") },
  "view-snap": { run: (o) => o.toggleView("snap") },
  "view-guides": { run: (o) => o.toggleView("guides") },
  "view-lock-guides": { run: (o) => o.toggleView("lockguides") },
  "view-smart-guides": { run: (o) => o.toggleView("smartguides") },
  "view-new-guide": { run: (o) => o.open("new-guide") },
  "view-clear-guides": {
    run: (o) => o.clearGuides(),
    when: (s) => s.guides > 0 || say("This document has no guides."),
  },
  "view-compare": {
    run: (o) => o.toggleCompare(),
    /* Nothing to compare against without adjustments or smart filters — a
       split between two identical halves would read as broken. */
    when: (s) => s.canCompare || say("Nothing to compare — add an adjustment layer or a smart filter first."),
  },
  "view-compare-axis": { run: (o) => o.toggleCompareAxis() },

  // ---- Window, Settings, Help
  "workspaces": { run: (o) => o.open("workspaces") },
  "window-reset": { run: (o) => o.resetWorkspace() },
  "preferences": { run: (o) => o.open("preferences") },
  "color-manage": { run: (o) => o.openColorManagement() },
  "shortcuts": { run: (o) => o.open("shortcuts") },
  "prefs-performance": { run: (o) => o.openPrefs("performance") },
  "prefs-storage": { run: (o) => o.openPrefs("storage") },
  "help-start": { run: (o) => o.open("help-start") },
  "help-tour": { run: (o) => o.open("tour") },
  "help-sample": { run: (o) => o.openSample() },
  "help-docs": { run: (o) => o.open("help-docs") },
  "about": { run: (o) => o.open("about") },
};

/* The parameterized kinds of extra adjustment open their editor (or a file
   picker) on the way in, so only the two that do not may be recorded. */
const RECORDABLE_EXTRA = new Set(["invert", "equalize"]);

/** A family member: its argument comes out of the id, typed by families.ts. */
function familyCommand(id: FamilyCommand): Command {
  const f = familyOf(id);
  switch (f.kind) {
    case "panel":
      return { run: (o) => o.togglePanel(panelOf(f.id)) };
    case "extraAdjustment": {
      const type = extraAdjustmentOf(f.id);
      return { run: (o) => o.addExtraAdjustment(type), ...(RECORDABLE_EXTRA.has(type) ? { recordable: true } : {}) };
    }
    case "adjustment":
      /* The preset adjustments: no dialog, so every one replays unattended. */
      return { run: (o) => o.addAdjustment(adjustmentOf(f.id)), recordable: true };
    case "effect":
      return { run: (o) => o.addEffect(effectOf(f.id)), when: styleable, recordable: true };
    case "filter":
      return { run: (o) => o.addFilter(filterOf(f.id)), when: styleable };
  }
}

/** The command behind an id. */
export function commandFor(id: CommandId): Command {
  return Object.hasOwn(DIRECT, id) ? DIRECT[id as DirectCommand] : familyCommand(id as FamilyCommand);
}

/** Whether `id` applies in `s`. */
export function availability(id: CommandId, s: CommandState): Availability {
  return commandFor(id).when?.(s) ?? true;
}

/** Every command that does NOT apply in `s`, with the reason — what the menus
 *  and the palette grey out. */
export function unavailableCommands(s: CommandState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of COMMAND_IDS) {
    const a = availability(id, s);
    if (a !== true) out[id] = a.why;
  }
  return out;
}

/** Can an action record this command (it replays unattended)? */
export function isRecordable(id: string): boolean {
  return isCommandId(id) && commandFor(id).recordable === true;
}

/**
 * Run `id` if it applies. An unavailable command does nothing — and says why,
 * unless its reason is quiet. Returns whether it ran.
 */
export function executeCommand(id: CommandId, s: CommandState, ops: CommandOps): boolean {
  const a = availability(id, s);
  if (a !== true) {
    if (!a.quiet) ops.toast(a.why);
    return false;
  }
  commandFor(id).run(ops);
  return true;
}
