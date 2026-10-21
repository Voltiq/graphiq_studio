// What the commands need to know to say whether they apply right now — a plain
// snapshot, built from the active document and a few editor facts. TODO 1.1.
//
// Pure on purpose: availability is the one question the menu bar, the phone's
// menu sheet, the palette and the keyboard all ask, and they used to answer it
// four ways (a static `disabled` flag nobody set, the header's own `canUndo`,
// and a toast inside the handler after the fact). Here it is answered once, and
// tests/command-registry.test.ts can ask it without rendering anything.

import { findNode, type LayerNode } from "../lib/layers";
import { hasAdjustments } from "../lib/compare";
import { mergeVisibleIsNoop, visibleLeafIds } from "../lib/merge-visible";
import { WORK_PATH_ID } from "../lib/paths";
import { MIN_ANCHORS } from "../lib/vector-mask";

/** The raw facts, as the editor holds them. */
export interface CommandInputs {
  doc: {
    layers: LayerNode[];
    activeLayerId: string | null;
    selectedLayerIds: string[];
    selection: readonly unknown[];
    guides?: readonly unknown[];
    paths?: readonly { id: string; anchors: readonly unknown[] }[];
    hdr?: unknown;
  };
  docCount: number;
  /** History can step back / forward. */
  historyBack: boolean;
  historyForward: boolean;
  /** A paste or move is floating, uncommitted (Undo cancels it). */
  floating: boolean;
  /** A previous selection is remembered for Reselect. */
  lastSelection: boolean;
  /** Isolate mode is on for this document. */
  isolated: boolean;
  /** The before/after compare split is showing. */
  comparing: boolean;
}

/** The facts the commands' availability rules read. */
export interface CommandState {
  docCount: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  /** Reselect brings back the last selection, only while nothing is selected. */
  canReselect: boolean;
  /** How many layers a layer command acts on: the multi-selection, or the active one. */
  targets: number;
  /** Top-level nodes in the tree. */
  layerCount: number;
  active: null | {
    kind: LayerNode["type"];
    hasMask: boolean;
    maskEnabled: boolean;
    hasVectorMask: boolean;
    isText: boolean;
    textOnPath: boolean;
    hasEffects: boolean;
  };
  visibleLeaves: number;
  /** Merge Visible would change nothing (one visible layer). */
  mergeVisibleNoop: boolean;
  hasHdr: boolean;
  guides: number;
  /** The Work Path is long enough to become a vector mask. */
  workPathReady: boolean;
  /** Compare is open, or there is an adjustment or smart filter to compare. */
  canCompare: boolean;
  isolated: boolean;
}

export function commandState(i: CommandInputs): CommandState {
  const d = i.doc;
  const node = d.activeLayerId ? findNode(d.layers, d.activeLayerId) : null;
  const vector = node && node.type === "layer" ? node.vector : undefined;
  const workPath = (d.paths ?? []).find((p) => p.id === WORK_PATH_ID) ?? (d.paths ?? [])[0];
  return {
    docCount: i.docCount,
    canUndo: i.historyBack || i.floating,
    canRedo: i.historyForward,
    hasSelection: d.selection.length > 0,
    canReselect: i.lastSelection && d.selection.length === 0,
    targets: d.selectedLayerIds.length || (d.activeLayerId ? 1 : 0),
    layerCount: d.layers.length,
    active: node
      ? {
          kind: node.type,
          hasMask: !!node.mask,
          maskEnabled: !!node.mask?.enabled,
          hasVectorMask: !!node.vectorMask,
          isText: vector?.type === "text",
          textOnPath: vector?.type === "text" && !!vector.onPath,
          hasEffects: !!node.effects && Object.keys(node.effects).length > 0,
        }
      : null,
    visibleLeaves: visibleLeafIds(d.layers).length,
    mergeVisibleNoop: mergeVisibleIsNoop(d.layers),
    hasHdr: !!d.hdr,
    guides: d.guides?.length ?? 0,
    workPathReady: !!workPath && workPath.anchors.length >= MIN_ANCHORS,
    canCompare: i.comparing || hasAdjustments(d.layers),
    isolated: i.isolated,
  };
}
