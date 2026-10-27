import { describe, expect, it } from "vitest";
import { DocCursor, DocumentState, type Entry, type Layer } from "../app/lib/doc-state";
import { EngineHistory, type HistoryHost } from "../app/lib/engine/history";
import type { CropSnapshot, HistorySummary } from "../app/lib/paint";

/**
 * The engine's undo history (TODO 1.6, app/lib/engine/history.ts): each
 * document's undo tree, its caps, what the History panel is told, the History
 * brush's source and the snapshots — against documents of its own and a host
 * that records what it is asked to do with pixels.
 */

/** A pixel patch, by name, holding `bytes`. */
const img = (tag: string, bytes = 4) => ({ tag, data: { byteLength: bytes } }) as unknown as ImageData;
const tagOf = (i: unknown) => (i as { tag: string }).tag;
const MB = 1024 * 1024;

function engine() {
  const cursor = new DocCursor();
  const calls: unknown[] = [];
  const log: string[] = [];
  const told: HistorySummary[] = [];
  let open = false;
  let wandDrops = 0;
  const raster = (name: string): Layer =>
    ({
      c: { name } as unknown as HTMLCanvasElement,
      ctx: {
        drawImage: (src: { name: string }, x: number, y: number) => calls.push(["draw", name, src.name, x, y]),
        putImageData: (i: unknown, x: number, y: number) => calls.push(["put", name, tagOf(i), x, y]),
      } as unknown as CanvasRenderingContext2D,
    }) as Layer;
  const host: HistoryHost = {
    endLive: () => calls.push("endLive"),
    putPatch: (e, i) => calls.push(["patch", e.label, tagOf(i)]),
    emitChange: () => calls.push("change"),
    onHistory: (s) => told.push(s),
    dropWandSource: () => wandDrops++,
    sessionOpen: () => open,
    cropSnapshot: (ids) =>
      ({ w: 10, h: 10, layers: ids.map((id) => ({ id, c: { name: `snap:${id}` } })) }) as unknown as CropSnapshot,
    cropRestore: (s) => calls.push(["restore", (s as { label?: string }).label]),
    mk: (w, h) => raster(`new ${w}x${h}`),
    layer: (id) => raster(`layer ${id}`),
  };
  const h = new EngineHistory(cursor, host);
  cursor.doc.w = 10;
  cursor.doc.h = 10;
  /** A structural step that logs its sides. */
  const step = (label: string) =>
    h.pushStructural(
      label,
      () => log.push(`undo ${label}`),
      () => log.push(`redo ${label}`),
    );
  /** A pixel step on `layerId`, `bytes` before and after. */
  const patch = (label: string, layerId = "a", bytes = 4, extra: Partial<Entry> = {}) =>
    h.linkEntry({
      label,
      layerId,
      rect: { x: 1, y: 2, w: 3, h: 4 },
      before: img(`${label} before`, bytes),
      after: img(`${label} after`, bytes),
      ...extra,
    });
  const labels = () => told.at(-1)!.items.map((i) => (i.onPath ? i.label : `(${i.label})`));
  return {
    h,
    cursor,
    calls,
    log,
    told,
    step,
    patch,
    labels,
    last: () => told.at(-1)!,
    setOpen: (o: boolean) => (open = o),
    wandDrops: () => wandDrops,
  };
}

describe("steps, and moving through them", () => {
  it("a structural step ends the live sessions first; undo and redo run its sides", () => {
    const e = engine();
    e.step("A");
    expect(e.calls).toEqual(["endLive"]);
    e.step("B");
    expect([e.labels(), e.last().index]).toEqual([["New", "A", "B"], 2]);
    e.h.undo();
    expect([e.log, e.last().index]).toEqual([["undo B"], 1]);
    e.h.redo();
    e.h.undo();
    e.h.undo();
    e.h.undo(); // at the original: nothing more to undo
    expect(e.log).toEqual(["undo B", "redo B", "undo B", "undo A"]);
    expect(e.last().index).toBe(0);
    e.h.redo();
    expect([e.log.at(-1), e.last().index]).toEqual(["redo A", 1]);
  });

  it("a new step after undo drops what redo would have reached; non-linear history keeps it, as a branch", () => {
    const lin = engine();
    lin.step("A");
    lin.step("B");
    lin.h.undo();
    lin.step("C");
    expect(lin.labels()).toEqual(["New", "A", "C"]);
    const non = engine();
    non.h.setNonLinearHistory(true);
    expect(non.last().nonLinear).toBe(true);
    non.step("A");
    non.step("B");
    non.h.undo();
    non.step("C");
    expect(non.labels()).toEqual(["New", "A", "(B)", "C"]);
    non.h.undo();
    non.h.redo();
    expect(non.last().index, "forward is the newest branch").toBe(3);
    non.log.length = 0;
    non.h.jumpTo(2);
    expect([non.log, non.labels()]).toEqual([["undo C", "redo B"], ["New", "A", "B", "(C)"]]);
  });

  it("turning non-linear history off prunes the branches you are not on, in every open document", () => {
    const e = engine();
    e.h.setNonLinearHistory(true);
    const front = e.cursor.doc;
    const back = new DocumentState();
    e.cursor.doc = back;
    e.step("X");
    e.h.undo();
    e.step("Y");
    e.cursor.doc = front;
    e.cursor.docs.set("front", front).set("back", back);
    e.step("A");
    e.h.undo();
    e.step("B");
    e.h.setNonLinearHistory(false);
    expect([front.entries.map((x) => x.label), back.entries.map((x) => x.label)]).toEqual([["B"], ["Y"]]);
    expect(e.last().nonLinear).toBe(false);
  });

  it("a pixel step goes back through the host: before on the way back, after on the way forward", () => {
    const e = engine();
    e.patch("P1");
    e.patch("P2");
    e.h.jumpTo(0);
    e.h.jumpTo(2);
    expect(e.calls.filter((c) => Array.isArray(c) || c === "change")).toEqual([
      ["patch", "P2", "P2 before"],
      ["patch", "P1", "P1 before"],
      "change",
      ["patch", "P1", "P1 after"],
      ["patch", "P2", "P2 after"],
      "change",
    ]);
    e.h.jumpTo(99);
    expect(e.last().index, "a jump past the end lands on the last state").toBe(2);
  });
});

describe("the caps", () => {
  it("the step cap is held to 10–200 and drops the oldest steps", () => {
    const e = engine();
    for (let i = 1; i <= 12; i++) e.step(`S${i}`);
    e.h.setHistoryLimit(3);
    expect(e.labels()).toEqual(["New", ...Array.from({ length: 10 }, (_, i) => `S${i + 3}`)]);
    e.h.setHistoryLimit(500);
    for (let i = 13; i <= 20; i++) e.step(`S${i}`);
    expect(e.labels()).toHaveLength(19);
    e.h.setHistoryLimit(12.6);
    expect(e.labels()).toHaveLength(14);
    const told = e.told.length;
    e.h.setHistoryLimit(60);
    expect(e.told.length, "nothing dropped, nothing told").toBe(told);
    e.h.setHistoryLimit(500);
    for (let i = 21; i <= 230; i++) e.step(`S${i}`);
    expect(e.cursor.doc.entries, "held to 200").toHaveLength(200);
  });

  it("an abandoned branch goes before the oldest step; the History brush's source is never dropped", () => {
    const e = engine();
    e.h.setNonLinearHistory(true);
    for (let i = 1; i <= 10; i++) e.step(`S${i}`);
    e.h.undo();
    e.step("X");
    e.h.setHistoryLimit(10);
    expect(e.labels()).toEqual(["New", ...Array.from({ length: 9 }, (_, i) => `S${i + 1}`), "X"]);
    const kept = engine();
    kept.step("S1");
    kept.h.setHistorySourceIndex(1);
    for (let i = 2; i <= 12; i++) kept.step(`S${i}`);
    kept.h.setHistoryLimit(10);
    expect([kept.cursor.doc.entries.length, kept.last().sourceIndex], "the cap gives way").toEqual([12, 1]);
  });

  it("the memory cap is for the session: a background document gives up its steps first", () => {
    const e = engine();
    const front = e.cursor.doc;
    const back = new DocumentState();
    e.cursor.docs.set("front", front).set("back", back);
    e.cursor.doc = back;
    e.patch("B1", "b", 10 * MB);
    e.patch("B2", "b", 10 * MB);
    e.cursor.doc = front;
    e.patch("F1", "a", 10 * MB);
    e.patch("F2", "a", 10 * MB);
    expect(e.h.historyBytes()).toBe(80 * MB);
    const kept = () => [back.entries.map((x) => x.label), front.entries.map((x) => x.label)];
    e.h.setHistoryBudgetMB(64);
    expect(kept()).toEqual([["B2"], ["F1", "F2"]]);
    e.h.setHistoryBudgetMB(40);
    expect(kept()).toEqual([[], ["F1", "F2"]]);
    e.h.setHistoryBudgetMB(1); // held to 32: now the one in front gives up its oldest
    expect(kept()).toEqual([[], ["F2"]]);
  });
});

describe("what the History panel is told", () => {
  it("the states on the path, where you are, the bytes, the source, the snapshots, an open session", () => {
    const e = engine();
    e.step("A");
    e.patch("B", "a", 8);
    e.h.undo();
    e.setOpen(true);
    e.h.syncHistory();
    expect(e.last()).toEqual({
      items: [
        { label: "New", onPath: true },
        { label: "A", onPath: true },
        { label: "B", onPath: false },
      ],
      index: 1,
      nonLinear: false,
      bytes: 16,
      sourceIndex: 0,
      snapshots: [],
      sourceSnapshotId: null,
      open: true,
    });
    expect(e.h.openTold).toBe(true);
    const drops = e.wandDrops();
    e.h.emitHistory(false);
    expect(e.wandDrops(), "not as a fill opens").toBe(drops);
    e.h.emitHistory();
    expect(e.wandDrops()).toBe(drops + 1);
  });

  it("dropping steps renumbers the tree, and the History brush's source with it", () => {
    const e = engine();
    e.step("A");
    e.step("B");
    e.step("C");
    e.h.setHistorySourceIndex(3);
    e.h.dropNodes([0]);
    const labels = () => e.cursor.doc.entries.map((x) => x.label);
    expect([labels(), e.cursor.doc.cur, e.cursor.doc.historySourceIndex]).toEqual([["B", "C"], 1, 2]);
    expect(e.cursor.doc.entries.map((x) => x.parent)).toEqual([-1, 0]);
    e.h.dropNodes([1]);
    expect([e.cursor.doc.cur, e.cursor.doc.historySourceIndex], "the source dropped: back to the original").toEqual([
      -1, 0,
    ]);
    e.h.setHistorySourceIndex(7.6);
    expect(e.last().sourceIndex, "held to the states there are").toBe(1);
    e.cursor.doc.entries.length = 0; // as a resize clears them
    e.h.syncHistory();
    expect(e.last().sourceIndex).toBe(0);
  });

  it("any document's labels and position, without bringing it forward", () => {
    const e = engine();
    const back = new DocumentState();
    e.cursor.doc = back;
    e.step("X");
    e.step("Y");
    e.h.undo();
    e.cursor.doc = new DocumentState();
    e.cursor.docs.set("back", back);
    expect([e.h.historyOf("back"), e.h.historyOf("gone")]).toEqual([{ labels: ["X", "Y"], index: 1 }, null]);
  });
});

describe("snapshots, and the History brush's source", () => {
  it("a snapshot is captured through the host, named, restored, a source, and deleted", () => {
    const e = engine();
    const first = e.h.createSnapshot("  ", ["a"]);
    const mine = e.h.createSnapshot(" Mine ", ["a", "b"]);
    expect(first).toMatch(/^snap-[0-9a-z]+-1$/);
    expect(e.last().snapshots).toEqual([
      { id: first, label: "Snapshot 1" },
      { id: mine, label: "Mine" },
    ]);
    expect(e.h.getSnapshot(mine)?.layers.map((l) => l.id)).toEqual(["a", "b"]);
    expect([e.h.restoreSnapshot(mine), e.h.restoreSnapshot("nope")]).toEqual([true, false]);
    expect(e.calls.at(-1)).toEqual(["restore", "Mine"]);
    e.h.setHistorySourceSnapshot(mine);
    expect(e.last().sourceSnapshotId).toBe(mine);
    e.h.setHistorySourceSnapshot("nope");
    expect(e.last().sourceSnapshotId).toBeNull();
    e.h.setHistorySourceSnapshot(mine);
    e.h.setHistorySourceIndex(0);
    expect(e.last().sourceSnapshotId, "a step and a snapshot are one or the other").toBeNull();
    e.h.setHistorySourceSnapshot(first);
    e.h.deleteSnapshot(first);
    expect([e.last().snapshots.map((s) => s.label), e.last().sourceSnapshotId]).toEqual([["Mine"], null]);
    e.h.setHistorySourceSnapshot(mine);
    e.h.deleteSnapshot(first);
    expect(e.last().sourceSnapshotId, "another one deleted keeps the source").toBe(mine);
  });

  it("a layer at a state is rebuilt from its own pixel patches; from a snapshot, as it was captured", () => {
    const e = engine();
    e.patch("P1", "a");
    e.patch("P2", "b");
    e.patch("P3", "a", 4, { surface: "mask" });
    e.patch("P4", "a", 4, { rect: { x: 5, y: 6, w: 1, h: 1 } });
    e.calls.length = 0;
    e.h.reconstructLayerAt("a", 1);
    expect(e.calls).toEqual([
      ["draw", "new 10x10", "layer a", 0, 0],
      ["put", "new 10x10", "P4 before", 5, 6],
    ]);
    e.h.jumpTo(0);
    e.calls.length = 0;
    e.h.reconstructLayerAt("a", 4);
    expect(e.calls.slice(1)).toEqual([
      ["put", "new 10x10", "P1 after", 1, 2],
      ["put", "new 10x10", "P4 after", 5, 6],
    ]);
    const snap = e.h.createSnapshot("S", ["a"]);
    e.calls.length = 0;
    e.h.snapshotLayer(snap, "a");
    e.h.snapshotLayer(snap, "b");
    expect(e.calls, "a layer the snapshot lacks is transparent").toEqual([["draw", "new 10x10", "snap:a", 0, 0]]);
  });
});
