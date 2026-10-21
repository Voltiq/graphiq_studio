// One document's engine state. TODO 1.2.
//
// The paint engine is shared by every open tab, and it used to keep ALL of
// them in its own fields: one map of layer canvases holding every document's
// rasters side by side (ids are unique editor-wide, so they never collided),
// one set of caches, and one undo history that was swapped in and out of
// "parked" slots on every tab switch. Closing a tab therefore had to find and
// free its pieces one by one, and anything that needed an INACTIVE document —
// compositing it, saving it — had to borrow the active one's size.
//
// Now each open document owns one of these, and the engine works on whichever
// is in front (`PaintEngine.setDocument`). What lives here is exactly what
// belongs to a single document: its size, its layer and mask rasters, the
// caches keyed by its node ids, and its history. What stays on the engine is
// shared by every tab: the view, the scratch and operation buffers, the
// workers, the GPU renderer, live tool sessions, and the render cache with its
// session-wide byte budget (whose entries a document records in `sharedIds`,
// so closing it can take them out too). Closing a tab drops this object, and
// with it everything below.

import { ROOT } from "./history-tree";
import type { ActiveSurface } from "./layers";
import type { DocSnapshot, HistorySide } from "./paint";
import type { Rect } from "./view";
import type { ToneLUTs, ToneLUTs16 } from "./tone";
import type { SelectionMask } from "./selection-mask";
import type { Seg } from "./mask-trace";

/** A raster and its 2D context. */
export interface Layer {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** One state in a document's undo tree. */
export interface Entry {
  label: string;
  /** Index of the entry this one was made ON TOP OF, or ROOT (-1) for the
   *  original document. In linear mode this is always the previous entry, so
   *  the tree degenerates to the list it has always been; in non-linear mode a
   *  new edit made after undoing branches here instead of truncating. */
  parent: number;
  side?: HistorySide;
  // Pixel payload — absent for purely structural entries (layer add/group/etc.),
  // whose effect lives entirely in `side`.
  layerId?: string;
  rect?: { x: number; y: number; w: number; h: number };
  before?: ImageData;
  after?: ImageData;
  // Which surface the pixel payload patches; absent ⇒ "layer" (back-compat).
  surface?: "layer" | "mask";
}

export class DocumentState {
  // ---- Size --------------------------------------------------------------
  w = 0;
  h = 0;
  /** Has a size been applied (`setDoc`)? A new document has none yet. */
  sized = false;
  /** Bumped when the document is reframed or re-encoded (resize, crop,
   *  transform, colour space): an ingredient of every cached render's key, and
   *  how work in flight (a heal in the worker) learns its coordinates went
   *  stale. Per document — resizing one tab says nothing about another. */
  epoch = 0;

  // ---- Rasters -----------------------------------------------------------
  /** Layer pixels, per leaf id. */
  readonly layers = new Map<string, Layer>();
  /** Grayscale masks (R=G=B=value) per key: layer masks, smart-filter masks
   *  (`fm:<id>`), the quick mask and saved selection channels. Coverage, not
   *  colour, so never gamut-converted. */
  readonly masks = new Map<string, Layer>();
  /** Natural-size sources for framed images (see PaintEngine.setFrameSource). */
  readonly frameSrc = new Map<string, HTMLCanvasElement>();
  /** Derived alpha per mask (RGB=0, A=coverage), re-derived on mask edits. */
  readonly maskAlpha = new Map<string, Layer>();
  /** Rasterised vector masks per node id, with the hash each was built from. */
  readonly vectorMaskCache = new Map<string, { key: string; c: HTMLCanvasElement }>();

  // ---- Per-node state and memos -------------------------------------------
  /** Which surface paint tools target, per layer (absent ⇒ pixels). */
  readonly surfaces = new Map<string, ActiveSurface>();
  /** Transparency / pixel locks the engine enforces, per layer. */
  readonly layerLocks = new Map<string, { transparency: boolean; pixels: boolean }>();
  /** Monotonic versions bumped on every committed pixel / mask write. */
  readonly pixelVersion = new Map<string, number>();
  readonly maskVersion = new Map<string, number>();
  /** Memoized layerContentBounds, keyed by `pixelVersion:docEpoch`. */
  readonly contentBoundsCache = new Map<string, { key: string; box: Rect | null }>();
  /** Compiled Curves/Levels LUTs per adjustment-node id, keyed by spec JSON. */
  readonly toneCache = new Map<string, { key: string; luts: ToneLUTs; luts16?: ToneLUTs16 }>();
  /** The coverage behind each soft selection (TODO 1.3), keyed by the outline
   *  rects ARRAY — that object is the selection's identity as it travels
   *  unchanged through React state, undo and Reselect. A hard selection has no
   *  entry: it is exactly its rects. */
  readonly selectionMasks = new WeakMap<Rect[], SelectionMask>();
  /** Each selection's outline as boundary segments — the ants' path — traced
   *  once, keyed the same way. */
  readonly selectionOutlines = new WeakMap<Rect[], Seg[]>();
  /** Ids this document has put in the engine's SHARED caches (render
   *  products, tiled adjustments, filter products), so closing it can take
   *  exactly those out. A stale id costs nothing: dropping it is a no-op. */
  readonly sharedIds = new Set<string>();

  // ---- History (an undo TREE — see history-tree.ts) -----------------------
  entries: Entry[] = [];
  /** The node the document shows; ROOT is the original. */
  cur = ROOT;
  /** History-brush source as an items index (0 = the original state). */
  historySourceIndex = 0;
  /** Pinned snapshots, with the canvases they hold. */
  snapshots: DocSnapshot[] = [];
  /** When set, the History brush sources from this snapshot instead of a step. */
  historySourceSnap: string | null = null;
}

/**
 * The document in front, as fields. PaintEngine extends this, so its code keeps
 * reading `this.layers` or `this.w` — and each of those now reads the document
 * the engine is working on. Switching documents is one assignment to `doc`.
 */
export abstract class DocumentScoped {
  protected doc = new DocumentState();
  /** Every open document's state, by editor document id. */
  protected readonly docs = new Map<string, DocumentState>();
  /** The id `doc` is filed under — null until the editor names one, and again
   *  after the document in front is closed. */
  protected docId: string | null = null;

  /** The state of open document `docId`, if the engine holds it. */
  protected docFor(docId: string): DocumentState | undefined {
    return docId === this.docId ? this.doc : this.docs.get(docId);
  }

  /** Is `d` still open (in front, or in the background)? */
  protected isOpen(d: DocumentState): boolean {
    return d === this.doc || [...this.docs.values()].includes(d);
  }

  /** Every open document's state, the one in front first. (Before the editor
   *  names a document, the one in front is not in `docs` yet.) */
  protected *everyDoc(): Generator<DocumentState> {
    yield this.doc;
    for (const d of this.docs.values()) if (d !== this.doc) yield d;
  }

  /**
   * Work on another open document for the length of `fn`, then come back —
   * without ending the live sessions of the one in front, emitting history or
   * touching the view. For bookkeeping (trimming its history), for reading it
   * (saving or compositing a background tab) and for finishing work it started
   * (a heal that lands after a tab switch); never for a new edit, which the
   * user should see happen.
   */
  protected withDocument<T>(d: DocumentState, fn: () => T): T {
    const front = this.doc;
    this.doc = d;
    try {
      return fn();
    } finally {
      this.doc = front;
    }
  }

  /** What the open document holding `id` has under it in `pick`, the one in
   *  front first. Ids are unique across documents, so a background tab's
   *  pixels can be read (for its file, or the autosave) without bringing it
   *  forward. */
  protected holderOf<T>(pick: (d: DocumentState) => Map<string, T>, id: string): T | undefined {
    for (const d of this.everyDoc()) {
      const v = pick(d).get(id);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  protected get w(): number {
    return this.doc.w;
  }
  protected set w(v: number) {
    this.doc.w = v;
  }
  protected get h(): number {
    return this.doc.h;
  }
  protected set h(v: number) {
    this.doc.h = v;
  }
  protected get docEpoch(): number {
    return this.doc.epoch;
  }
  protected set docEpoch(v: number) {
    this.doc.epoch = v;
  }
  protected get sized(): boolean {
    return this.doc.sized;
  }
  protected set sized(v: boolean) {
    this.doc.sized = v;
  }

  protected get layers(): Map<string, Layer> {
    return this.doc.layers;
  }
  protected get masks(): Map<string, Layer> {
    return this.doc.masks;
  }
  protected get frameSrc(): Map<string, HTMLCanvasElement> {
    return this.doc.frameSrc;
  }
  protected get maskAlpha(): Map<string, Layer> {
    return this.doc.maskAlpha;
  }
  protected get vectorMaskCache(): DocumentState["vectorMaskCache"] {
    return this.doc.vectorMaskCache;
  }
  protected get surfaces(): Map<string, ActiveSurface> {
    return this.doc.surfaces;
  }
  protected get layerLocks(): DocumentState["layerLocks"] {
    return this.doc.layerLocks;
  }
  protected get pixelVersion(): Map<string, number> {
    return this.doc.pixelVersion;
  }
  protected get maskVersion(): Map<string, number> {
    return this.doc.maskVersion;
  }
  protected get contentBoundsCache(): DocumentState["contentBoundsCache"] {
    return this.doc.contentBoundsCache;
  }
  protected get toneCache(): DocumentState["toneCache"] {
    return this.doc.toneCache;
  }
  protected get selectionMasks(): DocumentState["selectionMasks"] {
    return this.doc.selectionMasks;
  }

  protected get entries(): Entry[] {
    return this.doc.entries;
  }
  protected set entries(v: Entry[]) {
    this.doc.entries = v;
  }
  protected get cur(): number {
    return this.doc.cur;
  }
  protected set cur(v: number) {
    this.doc.cur = v;
  }
  protected get historySourceIndex(): number {
    return this.doc.historySourceIndex;
  }
  protected set historySourceIndex(v: number) {
    this.doc.historySourceIndex = v;
  }
  protected get snapshots(): DocSnapshot[] {
    return this.doc.snapshots;
  }
  protected set snapshots(v: DocSnapshot[]) {
    this.doc.snapshots = v;
  }
  protected get historySourceSnap(): string | null {
    return this.doc.historySourceSnap;
  }
  protected set historySourceSnap(v: string | null) {
    this.doc.historySourceSnap = v;
  }
}
