// The documents family (TODO 1.10): a new canvas — through the New Document
// dialog or at the stored size, refused if the browser cannot hold it — a
// document closed (never the last; its engine state freed whole), renamed,
// and the sample built and opened.
//
// `documentOps` is called on every render of Editor, as `layerOps` is; it
// closes over that render's tabs and active id, as these always did.

import type { PendingLoad } from "../lib/project";
import type { EngineHandle, TextRenderSpec } from "../lib/paint";
import type { Preferences } from "../lib/prefs";
import type { AutosaveDoc } from "../lib/autosave";
import {
  H as SAMPLE_H,
  SAMPLE_NAME,
  W as SAMPLE_W,
  sampleComps,
  sampleIds,
  sampleTexts,
  sampleTree,
} from "../lib/sample-doc";
import { paintSample } from "../lib/sample-paint";
import { makeDoc, type Doc, type DocumentsState } from "../state/documents";
import type { Store } from "../state/store";

/** What the document operations need of the editor. */
export interface DocumentContext {
  documents: Store<DocumentsState>;
  /** The tabs, and the one in front, as this render sees them. */
  docs: Doc[];
  activeId: string;
  prefsRef: { readonly current: Preferences };
  /** What new documents are numbered from. */
  seqRef: { current: number };
  paintRef: { readonly current: EngineHandle | null };
  /** Autosave's last serialization of each document, dropped with it. */
  docJsonCache: { readonly current: Map<string, AutosaveDoc> };
  /** Whether this browser can hold a canvas this size (saying so when not). */
  acceptSize(w: number, h: number, what: "document"): boolean;
  setActiveId(id: string): void;
  setNewDocOpen(open: boolean): void;
  nextLeafId(): string;
  setPendingLoads(update: (loads: PendingLoad[]) => PendingLoad[]): void;
}

export function documentOps(ctx: DocumentContext) {
  const {
    docs,
    activeId,
    prefsRef,
    seqRef,
    paintRef,
    docJsonCache,
    acceptSize,
    setActiveId,
    setNewDocOpen,
    nextLeafId,
    setPendingLoads,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  // New canvas — the New Document dialog, or the stored default size.
  const createDoc = (opts?: { name?: string; width?: number; height?: number; dpi?: number }) => {
    const p = prefsRef.current;
    /* Before the sequence number moves, so a refusal does not burn a doc id. */
    if (!acceptSize(opts?.width ?? p.newDocWidth, opts?.height ?? p.newDocHeight, "document")) return;
    const seq = (seqRef.current += 1);
    const d = makeDoc(
      seq,
      { w: opts?.width ?? p.newDocWidth, h: opts?.height ?? p.newDocHeight },
      opts?.dpi ?? p.defaultDpi,
    );
    if (opts?.name) d.name = opts.name;
    setDocs((ds) => [...ds, d]);
    setActiveId(d.id);
    setNewDocOpen(false);
  };
  // File ▸ New / the tab-strip "+": dialog by default, instant with the stored
  // defaults when the "ask" preference is off.
  const requestNewDoc = () => {
    if (prefsRef.current.newDocAsk) setNewDocOpen(true);
    else createDoc();
  };

  const closeDoc = (id: string) => {
    if (docs.length <= 1) return; // always keep one canvas open
    // Finish open edits while this tab's history still exists to take them.
    if (id === activeId) paintRef.current?.commitPendingEdits();
    const idx = docs.findIndex((d) => d.id === id);
    const next = docs.filter((d) => d.id !== id);
    setDocs(next);
    docJsonCache.current.delete(id);
    /* Its engine state goes whole: every raster (layers, masks, the quick mask,
       saved channels), every cache and its history. Closing once had to free
       each canvas by id, and left some resident (TODO 1.2). */
    paintRef.current?.closeDocument(id);
    if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)].id);
  };

  const renameDoc = (id: string, name: string) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, name } : d)));
  };

  // The sample document: a layered picture built and painted procedurally (no
  // assets; see sample-doc.ts), loaded through the same PendingLoad machinery
  // every import uses. Its type is rasterised by the engine during the load.
  const openSampleDoc = () => {
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const ids = sampleIds(nextLeafId);
    const flat = (spec: TextRenderSpec) => ({ x: spec.x, y: spec.y, w: 0, h: 0 });
    const layers = sampleTree(ids, (spec) => paintRef.current?.textBounds(spec) ?? flat(spec));
    const { images, masks } = paintSample(ids);
    setDocs((ds) => [
      ...ds,
      {
        id: docId,
        name: SAMPLE_NAME,
        width: SAMPLE_W,
        height: SAMPLE_H,
        layers,
        activeLayerId: ids.titleText,
        selectedLayerIds: [ids.titleText],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: null,
        comps: sampleComps(ids, layers),
      },
    ]);
    setActiveId(docId);
    setPendingLoads((ls) => [...ls, { docId, images, masks, texts: sampleTexts(ids) }]);
  };

  return {
    createDoc,
    requestNewDoc,
    closeDoc,
    renameDoc,
    openSampleDoc,
  };
}
