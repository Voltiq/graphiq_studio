// The editor's stores, handed to the components that read them (TODO 1.5).
// One set per Editor: created with it, provided around it, so nothing is
// module-global and a second Editor (or a test) gets state of its own.

import { createContext, useContext } from "react";
import { useStore, type Store } from "./store";
import { createColors, createToolOptions, type Colors, type ToolOptions } from "./toolOptions";
import { createView, type ViewState } from "./view";
import { createDialogs, type DialogState } from "./dialogs";
import { createDocuments, type DocumentsState } from "./documents";
import { createPrefs } from "./prefs";
import type { Preferences } from "../lib/prefs";

export interface EditorStores {
  colors: Store<Colors>;
  tools: Store<ToolOptions>;
  view: Store<ViewState>;
  dialogs: Store<DialogState>;
  documents: Store<DocumentsState>;
  prefs: Store<Preferences>;
}

export function createEditorStores(): EditorStores {
  return { colors: createColors(), tools: createToolOptions(), view: createView(), dialogs: createDialogs(), documents: createDocuments(), prefs: createPrefs() };
}

const Stores = createContext<EditorStores | null>(null);
export const EditorStoresProvider = Stores.Provider;

export function useEditorStores(): EditorStores {
  const s = useContext(Stores);
  if (!s) throw new Error("useEditorStores outside an EditorStoresProvider");
  return s;
}

/** What `select` picks out of the colours, kept current. */
export const useColors = <V>(select: (c: Colors) => V): V => useStore(useEditorStores().colors, select);
/** What `select` picks out of the tools' options, kept current. */
export const useToolOptions = <V>(select: (t: ToolOptions) => V): V => useStore(useEditorStores().tools, select);
/** What `select` picks out of the view (the View and Window menus' toggles), kept current. */
export const useView = <V>(select: (v: ViewState) => V): V => useStore(useEditorStores().view, select);
/** What `select` picks out of which dialogs are open, kept current. */
export const useDialogs = <V>(select: (d: DialogState) => V): V => useStore(useEditorStores().dialogs, select);
/** What `select` picks out of the open documents, kept current. */
export const useDocuments = <V>(select: (d: DocumentsState) => V): V => useStore(useEditorStores().documents, select);
/** What `select` picks out of Preferences, kept current. */
export const usePrefs = <V>(select: (p: Preferences) => V): V => useStore(useEditorStores().prefs, select);
