// The engine's undo history (TODO 1.6): each document's undo TREE — the
// arithmetic is history-tree.ts — the two caps that bound it (steps per
// document, bytes for the session), the structural steps the editor pushes,
// moving through it (undo, redo, a jump, across branches), what the History
// panel is told, the History brush's source, and pinned snapshots.
//
// The entries live on each document (doc-state.ts); this works on the one in
// front through the cursor it shares with the engine, so `withDocument` moves
// both. What it needs of the rest of the engine — a patch's pixels put back,
// the live sessions ended, a snapshot's capture — comes through `HistoryHost`.

import { DocumentScoped, type DocCursor, type Entry, type Layer } from "../doc-state";
import { clampBudgetMB, overBudget, totalBytes } from "../history-budget";
import { ROOT, ancestry, newestChild, offPath, removeNodes, transition, trimVictim } from "../history-tree";
import type { CropSnapshot, DocSnapshot, HistorySummary } from "../paint";

/** What the history needs of the rest of the engine. */
export interface HistoryHost {
  /** Finish every live session (adjustment, shape, gradient, path, fill), so
   *  each is the step it stands for before the history moves. */
  endLive(): void;
  /** Put a pixel patch back onto the surface its entry names. */
  putPatch(e: Entry, img: ImageData): void;
  /** The document's content changed: repaint. */
  emitChange(): void;
  /** Tell the editor what the history now is. */
  onHistory(s: HistorySummary): void;
  /** The layers' pixels changed under the magic wand's cached source. */
  dropWandSource(): void;
  /** Is a bucket fill or a pen path open — a step still to come? */
  sessionOpen(): boolean;
  /** Capture layers' pixels and the document's size, and put them back. */
  cropSnapshot(ownLayerIds: string[]): CropSnapshot;
  cropRestore(snap: CropSnapshot): void;
  /** A canvas in the working colour space. */
  mk(w: number, h: number, readFreq?: boolean): Layer;
  /** A layer's raster. */
  layer(id: string): Layer;
}

export class EngineHistory extends DocumentScoped {
  constructor(
    cursor: DocCursor,
    private readonly host: HistoryHost,
  ) {
    super(cursor);
  }

  // History is an UNDO TREE (see history-tree.ts), one per document: every
  // entry records its parent, and `cur` is the node the document currently
  // shows (ROOT = the original). A linear history is the degenerate case where
  // every parent is the previous entry, so this behaves exactly as the old
  // array + index did.
  /** Photoshop's "Allow Non-Linear History": keep the states a new edit would
   *  otherwise discard, as a branch, instead of truncating them. */
  private nonLinear = false;
  private historyLimit = 60; // max undoable steps kept (Preferences ▸ Performance)
  /** Memory cap for those steps' pixel patches — the cap that actually bounds
   *  RAM, since one full-canvas patch can outweigh a hundred brush dabs. */
  private historyBudgetMB = 512;
  // The last history summary said a fill or a path was open, so its end is told too.
  openTold = false;
  // History brush source (the document's `historySourceIndex`): the state the
  // brush repaints from (0 = the original). The active layer's pixels AT that
  // index are reconstructed from its patch entries on demand (beginHistory), so
  // no full snapshots are stored. Pinned snapshots (`snapshots`, TODO §10) are
  // full pixel captures the user can restore to and point the History brush at;
  // the editor pairs each with the layer TREE it was taken with.
  private snapSeq = 0;

  /** The parent table the pure tree helpers work on. */
  private parents(): number[] {
    return this.entries.map((e) => e.parent);
  }

  /** Items index (0 = the original state) ⇄ node index. */
  private get pos(): number {
    return this.cur + 1;
  }

  /**
   * Attach a freshly built entry to the tree and move onto it. In LINEAR mode
   * anything that was reachable only by redo is discarded first — the old
   * `entries.length = pos` truncation, expressed as "drop everything off the
   * path". In non-linear mode nothing is dropped and the new entry simply
   * branches off wherever you are.
   */
  linkEntry(e: Omit<Entry, "parent">): void {
    if (!this.nonLinear) {
      const stale = offPath(this.parents(), this.cur);
      if (stale.length) this.dropNodes(stale);
    }
    const entry = e as Entry;
    entry.parent = this.cur;
    this.entries.push(entry);
    this.cur = this.entries.length - 1;
  }

  /** Remove entries and renumber everything that points at them. Callers must
   *  never drop the current node's ancestry — the document is showing it. */
  dropNodes(list: number[]): void {
    if (!list.length) return;
    const gone = new Set(list);
    const { parents, remap } = removeNodes(this.parents(), list);
    this.entries = this.entries.filter((_, i) => !gone.has(i));
    this.entries.forEach((e, i) => (e.parent = parents[i]));
    this.cur = this.cur >= 0 && !gone.has(this.cur) ? remap[this.cur] : ROOT;
    // The History-brush source is an ITEMS index (node + 1); a dropped source
    // falls back to the original state rather than silently sliding elsewhere.
    const src = this.historySourceIndex - 1;
    this.historySourceIndex = src < 0 || gone.has(src) ? 0 : remap[src] + 1;
  }

  /** Cap the undo history (Preferences ▸ Performance): oldest steps drop off
   *  the far end — their pixel patches are the biggest memory holders. */
  setHistoryLimit(n: number): void {
    this.historyLimit = Math.max(10, Math.min(200, Math.round(n)));
    this.trimHistory();
  }

  /** Cap the undo history by MEMORY as well as by step count. A step count is a
   *  poor proxy for bytes — one full-canvas patch can outweigh a hundred brush
   *  dabs — so whichever cap binds first wins. */
  setHistoryBudgetMB(mb: number): void {
    this.historyBudgetMB = clampBudgetMB(mb);
    this.trimHistory();
  }

  /** Bytes held by the undo stacks' pixel patches, across every open document. */
  historyBytes(): number {
    let n = 0;
    for (const d of this.everyDoc()) n += totalBytes(d.entries);
    return n;
  }

  /** The step cap is per document (each tab keeps its own N states, as in
   *  Photoshop); the memory cap is for the whole session, since it is what
   *  bounds RAM. Background documents give up their steps first — the ones you
   *  are most likely to want back are in the document in front of you. */
  trimHistory(): void {
    const budget = this.historyBudgetMB;
    for (const d of [...this.everyDoc()].slice(1)) {
      const others = this.historyBytes() - totalBytes(d.entries);
      if (!overBudget(others + totalBytes(d.entries), budget)) break;
      this.withDocument(d, () => this.dropTrimVictims(() => overBudget(others + totalBytes(this.entries), budget)));
    }
    const elsewhere = this.historyBytes() - totalBytes(this.entries);
    const dropped = this.dropTrimVictims(
      () =>
        this.entries.length > this.historyLimit ||
        overBudget(totalBytes(this.entries) + elsewhere, budget),
    );
    if (dropped) this.emitHistory();
  }

  /** Drop states from the CURRENT document while `over()` holds; returns how many. */
  private dropTrimVictims(over: () => boolean): number {
    let dropped = 0;
    while (over()) {
      // `trimVictim` picks a state nothing still depends on — an abandoned
      // branch tip first, otherwise the oldest step when it is the only branch
      // off the original. It returns -1 when every remaining state is load-
      // bearing, which makes the cap soft rather than corrupting a branch.
      const victim = trimVictim(this.parents(), this.cur, this.historySourceIndex - 1);
      if (victim < 0) break;
      this.dropNodes([victim]);
      dropped++;
    }
    return dropped;
  }

  /** Any document's history labels (creation order) and position — so a file
   *  written from an inactive tab still carries what was done to it. */
  historyOf(docId: string): { labels: string[]; index: number } | null {
    const d = this.docFor(docId);
    if (!d) return null;
    return { labels: d.entries.map((e) => e.label), index: d.cur + 1 };
  }

  /** Push a structural undo step (no pixel payload — `undo`/`redo` do the work). */
  pushStructural(label: string, undo: () => void, redo: () => void) {
    this.host.endLive();
    this.linkEntry({ label, side: { undo, redo } });
    this.trimHistory();
    this.emitHistory();
  }

  private apply(e: Entry) {
    if (e.after) this.host.putPatch(e, e.after);
  }

  private revert(e: Entry) {
    if (e.before) this.host.putPatch(e, e.before);
  }

  jumpTo(target: number) {
    this.host.endLive(); // finalize a live session before navigating history
    // `target` is an ITEMS index (0 = the original document) — node + 1.
    const node = Math.max(ROOT, Math.min(this.entries.length - 1, target - 1));
    // Walk to the states' common ancestor and back down the other side. For a
    // linear history that is exactly the old two loops; for a branched one it
    // is what lets you jump between branches without replaying the whole tree.
    const { revert, apply } = transition(this.parents(), this.cur, node);
    for (const k of revert) {
      const e = this.entries[k];
      this.revert(e);
      e.side?.undo();
    }
    for (const k of apply) {
      const e = this.entries[k];
      e.side?.redo();
      this.apply(e);
    }
    this.cur = node;
    this.emitHistory();
    this.host.emitChange();
  }

  /* Both end the live sessions BEFORE they work out where to go. A fill or a
     path becomes its step only as it ends; asked first, the step before it
     was taken as the one to undo, and one Undo took both. */
  undo() {
    this.host.endLive();
    if (this.cur >= 0) this.jumpTo(this.entries[this.cur].parent + 1);
  }

  redo() {
    this.host.endLive();
    // With branches, "forward" is the most recently created continuation of
    // where you are — the branch you were last working on.
    const next = newestChild(this.parents(), this.cur);
    if (next >= 0) this.jumpTo(next + 1);
  }

  /** Photoshop's History Options ▸ Allow Non-Linear History. Turning it OFF
   *  prunes the branches you are not on, since they can no longer be reached. */
  setNonLinearHistory(on: boolean) {
    if (this.nonLinear === on) return;
    this.nonLinear = on;
    if (!on) {
      const prune = () => {
        const stale = offPath(this.parents(), this.cur);
        if (stale.length) this.dropNodes(stale);
      };
      for (const d of this.everyDoc()) this.withDocument(d, prune);
    }
    this.emitHistory();
  }

  syncHistory() {
    this.emitHistory();
  }

  emitHistory(stale = true) {
    // Any history change means layer pixels changed → wand source is stale.
    // (Not as a fill opens: it re-runs from the wand's source, the ORIGINAL.)
    if (stale) this.host.dropWandSource();
    this.historySourceIndex = Math.max(0, Math.min(this.entries.length, this.historySourceIndex));
    const parents = this.parents();
    const live = new Set(ancestry(parents, this.cur));
    this.openTold = this.host.sessionOpen();
    this.host.onHistory({
      items: [
        { label: "New", onPath: true }, // the original state is on every path
        ...this.entries.map((e, i) => ({ label: e.label, onPath: live.has(i) })),
      ],
      index: this.pos,
      nonLinear: this.nonLinear,
      bytes: this.historyBytes(),
      sourceIndex: this.historySourceIndex,
      snapshots: this.snapshots.map((s) => ({ id: s.id, label: s.label })),
      sourceSnapshotId: this.historySourceSnap,
      open: this.openTold,
    });
  }

  /** Point the History brush at a history state (0 = the original document). */
  setHistorySourceIndex(index: number) {
    this.historySourceIndex = Math.max(0, Math.min(this.entries.length, Math.round(index)));
    this.historySourceSnap = null; // a step and a snapshot are mutually exclusive
    this.emitHistory();
  }

  /** Pin the current pixels of `ownLayerIds` (+ their masks + the doc size) as a
   *  named snapshot. Returns its id. Costs one full copy of those layers. */
  createSnapshot(label: string, ownLayerIds: string[]): string {
    const base = this.host.cropSnapshot(ownLayerIds); // same capture the crop path uses
    const id = `snap-${Date.now().toString(36)}-${(this.snapSeq += 1)}`;
    this.snapshots.push({ ...base, id, label: label.trim() || `Snapshot ${this.snapshots.length + 1}` });
    this.emitHistory();
    return id;
  }

  getSnapshot(id: string): DocSnapshot | null {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  deleteSnapshot(id: string): void {
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    if (this.historySourceSnap === id) this.historySourceSnap = null;
    this.emitHistory();
  }

  /** Restore a snapshot's PIXELS + document size (the caller restores the layer
   *  tree and journals the step — mirrors how crop undo/redo is wired). */
  restoreSnapshot(id: string): boolean {
    const snap = this.getSnapshot(id);
    if (!snap) return false;
    this.host.cropRestore(snap);
    return true;
  }

  /** Point the History brush at a snapshot (null = back to a history step). */
  setHistorySourceSnapshot(id: string | null): void {
    this.historySourceSnap = id && this.getSnapshot(id) ? id : null;
    this.emitHistory();
  }

  /** A doc-sized copy of `layerId`'s pixels as captured in snapshot `snapId`.
   *  A layer missing from the snapshot (created later) yields a TRANSPARENT
   *  source — which is what it looked like then, so the brush erases it back.
   *  A snapshot from a differently-sized document is drawn top-left aligned. */
  snapshotLayer(snapId: string, layerId: string): Layer {
    const out = this.host.mk(this.w, this.h, true);
    const snap = this.getSnapshot(snapId);
    const hit = snap?.layers.find((l) => l.id === layerId);
    if (hit) out.ctx.drawImage(hit.c, 0, 0);
    return out;
  }

  /** Reconstruct one layer's pixels AT a history state, by replaying only that
   *  layer's pixel patches between the current position and `index` onto a copy
   *  of its live canvas — non-destructive and O(patches for this layer). Mask-
   *  surface and purely-structural entries are skipped (documented: sourcing
   *  across a canvas-size change or a layer's own creation is approximate). */
  reconstructLayerAt(layerId: string, index: number): Layer {
    const snap = this.host.mk(this.w, this.h, true);
    snap.ctx.drawImage(this.host.layer(layerId).c, 0, 0);
    // Same walk `jumpTo` uses, but replaying only this layer's patches onto a
    // scratch copy — so a source state on ANOTHER branch reconstructs correctly
    // instead of replaying an index range that no longer describes a path.
    const node = Math.max(ROOT, Math.min(this.entries.length - 1, index - 1));
    const { revert, apply } = transition(this.parents(), this.cur, node);
    for (const k of revert) {
      const e = this.entries[k];
      if (e.layerId === layerId && e.surface !== "mask" && e.before && e.rect) {
        snap.ctx.putImageData(e.before, e.rect.x, e.rect.y);
      }
    }
    for (const k of apply) {
      const e = this.entries[k];
      if (e.layerId === layerId && e.surface !== "mask" && e.after && e.rect) {
        snap.ctx.putImageData(e.after, e.rect.x, e.rect.y);
      }
    }
    return snap;
  }
}
