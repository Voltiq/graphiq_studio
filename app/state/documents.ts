// The open documents (TODO 1.5, the `documents` slice): the tabs, which one is
// active, what is on its way into the engine for them, and the active one's
// history as the engine reports it.
//
// One store, because they change together: a project opened from a file is a
// new tab, made active, with its pixels queued to load — and those have to
// arrive in the same commit, or the canvas would switch to a document whose
// pixels it has not been told about yet.

import type { SavedChannel } from "../lib/channels";
import type { LayerComp } from "../lib/comps";
import type { Guide } from "../lib/guides";
import type { HdrImage } from "../lib/hdr";
import type { LayerNode } from "../lib/layers";
import type { ImageMetadata } from "../lib/metadata";
import type { HistorySummary, PendingPaste } from "../lib/paint";
import type { SavedPath } from "../lib/paths";
import type { PendingLoad } from "../lib/project";
import type { ColorSampler } from "../lib/samplers";
import type { Rect } from "../lib/view";
import { createStore, type Store } from "./store";

export interface Doc {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: LayerNode[];
  /** Primary layer (drives the blend/opacity panel; anchor for range-select). */
  activeLayerId: string | null;
  /** Full multi-selection (always includes activeLayerId when non-null). */
  selectedLayerIds: string[];
  selection: Rect[];
  /** Selection rotation (radians) about `selectionPivot` (or the bbox centre). */
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  /** Source-image file/EXIF metadata (set when a doc originates from an image). */
  metadata?: ImageMetadata | null;
  /** Pixels per inch — physical-unit rulers/readouts + true-size print. */
  dpi?: number;
  /** Stored pen paths (Paths panel; "work" = the latest Pen-tool commit). */
  paths?: SavedPath[];
  /** Ruler guides (View ▸ Show guides). Per-document, saved in .gproj. */
  guides?: Guide[];
  /** Info-panel colour samplers. Per-document, saved in .gproj. */
  samplers?: ColorSampler[];
  /** Saved selections (named alpha channels; the rasters live in the engine
   *  under selectionChannelKey(docId, id)). Per-document, saved in .gproj. */
  channels?: SavedChannel[];
  /** Named layer-state snapshots (visibility / position / appearance).
   *  Per-document, saved in .gproj. */
  comps?: LayerComp[];
  /** What was done to this document BEFORE this session — read from the file's
   *  history labels. A record, not a navigable stack (see history-log.ts). */
  historyLog?: string[];
  /** 32-bit float radiance source (Merge to HDR) — IN MEMORY only, never
   *  serialized (.gproj/autosave keep the tone-mapped pixels instead). */
  hdr?: HdrImage | null;
}

export const makeDoc = (seq: number, size?: { w: number; h: number }, dpi = 300): Doc => ({
  id: `doc-${seq}`,
  name: `Untitled-${seq}`,
  width: size?.w ?? 1920,
  height: size?.h ?? 1080,
  dpi,
  layers: [],
  activeLayerId: null,
  selectedLayerIds: [],
  selection: [],
  selectionAngle: 0,
  selectionPivot: null,
});

export interface DocumentsState {
  /** The tabs, in order. Starts with a single, unnamed canvas. */
  docs: Doc[];
  activeId: string;
  /** Pixels on their way into the engine, for documents just opened. */
  pendingLoads: PendingLoad[];
  /** A paste the canvas is to place. */
  pendingPaste: PendingPaste | null;
  /** The active document's history, as the engine last reported it. */
  history: HistorySummary;
}

export const createDocuments = (): Store<DocumentsState> =>
  createStore<DocumentsState>({
    docs: [makeDoc(1)],
    activeId: "doc-1",
    pendingLoads: [],
    pendingPaste: null,
    history: {
      items: [{ label: "New", onPath: true }],
      index: 0,
      nonLinear: false,
      bytes: 0,
      sourceIndex: 0,
      snapshots: [],
      sourceSnapshotId: null,
      open: false,
    },
  });

/** The document on show: the active one, or the first if the active is gone. */
export const activeDoc = (s: DocumentsState): Doc => s.docs.find((d) => d.id === s.activeId) ?? s.docs[0];
