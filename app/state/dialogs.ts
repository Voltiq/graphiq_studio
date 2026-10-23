// The dialogs (TODO 1.5, the `dialog` slice): which are open, and the one
// thing each that has one is opened with — a Help page, Canvas or Image size,
// the Preferences section.
//
// A field per dialog rather than one `openDialog` slot: no shortcut waits for
// an open dialog to close, so today one opens over another (Image size over
// Preferences, Escape closing them in turn), and a single slot would close the
// first.

import type { DialogId, SelectModify } from "../commands/ops";
import type { HelpStart } from "../components/HelpDialog";
import type { PrefsTab } from "../components/PreferencesDialog";
import { createStore, type Store } from "./store";

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
