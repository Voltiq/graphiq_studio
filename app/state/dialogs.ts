// The dialogs (TODO 1.5, the `dialog` slice): which are open, and the one
// thing each that has one is opened with — a Help page, Canvas or Image size,
// the Preferences section.
//
// A field per dialog rather than one `openDialog` slot: no shortcut waits for
// an open dialog to close, so today one opens over another (Image size over
// Preferences, Escape closing them in turn), and a single slot would close the
// first.

import type { DialogId, SelectModify } from "../commands/ops";
import type { ImportItem } from "../components/ImportDialog";
import type { EyedropKind } from "../components/LevelsDialog";
import type { PasteDest } from "../components/PasteDialog";
import type { AutosaveSnapshot } from "../lib/autosave";
import type { RawDevelopOptions } from "../lib/dng";
import type { ChannelHistogram } from "../lib/paint";
import type { RawSession } from "../lib/rawdev";
import type { RefineEdge } from "../lib/refine-edge";
import type { ToneAdjustment } from "../lib/tone";
import { DEFAULT_BLUR_FX, type BlurFxSettings } from "../lib/tools";
import type { HelpStart } from "../components/HelpDialog";
import type { PrefsTab } from "../components/PreferencesDialog";
import { createStore, type Store } from "./store";

/** What a paste asks about: the picture, and where it goes when already decided. */
export interface PasteSrc {
  source: ImageBitmap | HTMLCanvasElement;
  w: number;
  h: number;
  /** Destination already decided (Preferences default) — the dialog only asks
      the oversized-image canvas-size question. */
  dest?: PasteDest;
}

/** Curves or Levels: on an adjustment layer's node, or as a destructive pass. */
export type ToneEdit =
  | { mode: "node"; tool: "curves" | "levels"; layerId: string }
  | { mode: "dest"; tool: "curves" | "levels"; layerId: string; spec: ToneAdjustment };

/** A layer lifted out for Liquify or Warp. */
export interface LayerSession {
  layerId: string;
  name: string;
  canvas: HTMLCanvasElement;
}

export interface DialogState {
  trim: boolean;
  patternFill: boolean;
  recents: boolean;
  saveAs: boolean;
  rename: boolean;
  moreSpace: boolean;
  exportLut: boolean;
  exportTiff: boolean;
  exportPdf: boolean;
  mergeHdr: boolean;
  batch: boolean;
  hdrTone: boolean;
  exportHdr: boolean;
  workspaces: boolean;
  shortcuts: boolean;
  about: boolean;
  newGuide: boolean;
  print: boolean;
  /** Edit ▸ Color management. */
  colorManagement: boolean;
  newDoc: boolean;
  prefs: boolean;
  /** The section Preferences shows — kept, so it re-opens where you were. */
  prefsTab: PrefsTab;
  /** Help, open on Getting started or the documentation. */
  help: HelpStart | null;
  size: boolean;
  sizeMode: "canvas" | "image";
  /** Select ▸ Save / Load selection. */
  channel: "save" | "load" | null;
  /** Select ▸ Modify, and which. */
  selectModify: SelectModify | null;

  // The editing sessions: dialogs opened ON something, holding it while open.
  blurFxOpen: boolean;
  /** The Blur Gallery's settings — kept between openings. */
  blurFx: BlurFxSettings;
  /** The composited result of the live blur preview, shown inside the gallery. */
  blurPreview: HTMLCanvasElement | null;
  /** View ▸ Compare profiles: the composite it compares (undefined: closed). */
  compareComposite: HTMLCanvasElement | null | undefined;
  pasteSrc: PasteSrc | null;
  /** Export: the composite being exported. */
  exportComposite: HTMLCanvasElement | null;
  importItems: ImportItem[] | null;
  refine: { source: HTMLCanvasElement; mask: HTMLCanvasElement; initial: RefineEdge } | null;
  /** A fill layer's dialog. */
  fillEdit: { layerId: string } | null;
  toneEdit: ToneEdit | null;
  toneHist: ChannelHistogram | null;
  /** A Levels eyedropper armed: the next canvas click samples. */
  tonePick: EyedropKind | null;
  /** An extra adjustment's dialog. */
  extraEdit: { layerId: string } | null;
  /** The layer whose Layer style / Smart filters dialog is open. */
  layerStyleTarget: string | null;
  filterTarget: string | null;
  /** An unclean exit's snapshot, offered for restoring. */
  restoreSnap: AutosaveSnapshot | null;
  liquify: LayerSession | null;
  warping: LayerSession | null;
  /** A raw file asking how to develop it, and the answer it waits for. */
  rawAsk: { session: RawSession; name: string; resolve: (o: RawDevelopOptions | null) => void } | null;
}

export const createDialogs = (): Store<DialogState> =>
  createStore<DialogState>({
    trim: false,
    patternFill: false,
    recents: false,
    saveAs: false,
    rename: false,
    moreSpace: false,
    exportLut: false,
    exportTiff: false,
    exportPdf: false,
    mergeHdr: false,
    batch: false,
    hdrTone: false,
    exportHdr: false,
    workspaces: false,
    shortcuts: false,
    about: false,
    newGuide: false,
    print: false,
    colorManagement: false,
    newDoc: false,
    prefs: false,
    prefsTab: "appearance",
    help: null,
    size: false,
    sizeMode: "canvas",
    channel: null,
    selectModify: null,
    blurFxOpen: false,
    blurFx: DEFAULT_BLUR_FX,
    blurPreview: null,
    compareComposite: undefined,
    pasteSrc: null,
    exportComposite: null,
    importItems: null,
    refine: null,
    fillEdit: null,
    toneEdit: null,
    toneHist: null,
    tonePick: null,
    extraEdit: null,
    layerStyleTarget: null,
    filterTarget: null,
    restoreSnap: null,
    liquify: null,
    warping: null,
    rawAsk: null,
  });

/** What each of the commands' dialogs opens (the tour is not a dialog here). */
const OPENS: Record<Exclude<DialogId, "tour">, Partial<DialogState>> = {
  "trim": { trim: true },
  "pattern-fill": { patternFill: true },
  "open-recent": { recents: true },
  "save-as": { saveAs: true },
  "rename": { rename: true },
  "more-space": { moreSpace: true },
  "export-lut": { exportLut: true },
  "export-tiff": { exportTiff: true },
  "export-pdf": { exportPdf: true },
  "merge-hdr": { mergeHdr: true },
  "batch": { batch: true },
  "hdr-tone": { hdrTone: true },
  "export-hdr": { exportHdr: true },
  "preferences": { prefs: true },
  "workspaces": { workspaces: true },
  "shortcuts": { shortcuts: true },
  "about": { about: true },
  "new-guide": { newGuide: true },
  "help-start": { help: "start" },
  "help-docs": { help: "docs" },
};

/** Open one of the commands' dialogs. */
export function openDialog(dialogs: Store<DialogState>, id: Exclude<DialogId, "tour">): void {
  dialogs.set(OPENS[id]);
}

/** Open Preferences — on `tab` when given, else where it was last left. */
export function openPrefs(dialogs: Store<DialogState>, tab?: PrefsTab): void {
  dialogs.set(tab ? { prefsTab: tab, prefs: true } : { prefs: true });
}

/** Open Canvas size or Image size. */
export function openSize(dialogs: Store<DialogState>, mode: "canvas" | "image"): void {
  dialogs.set({ sizeMode: mode, size: true });
}
