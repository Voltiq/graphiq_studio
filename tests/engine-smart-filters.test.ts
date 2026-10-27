import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, type Layer } from "../app/lib/doc-state";
import { EngineSmartFilters, type SmartFilterHost } from "../app/lib/engine/smart-filters";
import type { SmartFilter } from "../app/lib/filters";
import { filterMaskKey, type LayerNode } from "../app/lib/layers";
import type { Rect } from "../app/lib/view";
import { canvas, fc, installFakeCanvas } from "./fake-canvas";

/**
 * The engine's smart filters (TODO 1.6, app/lib/engine/smart-filters.ts): the
 * stack over a node's pixels, the product cache and the worker that refreshes
 * it, the half-res preview, and the live frames a stroke draws — what runs
 * where, and when. The filter itself is a stand-in (an inversion), so a pixel
 * says which pass made it.
 */

const h = vi.hoisted(() => ({ budget: 1_000_000, applied: [] as { params: unknown; w: number; h: number }[] }));
vi.mock("../app/lib/budgets", () => ({ budgets: () => ({ draftPixels: h.budget }) }));
vi.mock("../app/lib/filters", async (real) => ({
  ...(await real<typeof import("../app/lib/filters")>()),
  applyFilter: (src: ImageData, f: SmartFilter) => {
    h.applied.push({ params: f.params, w: src.width, h: src.height });
    const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    for (let i = 0; i < out.data.length; i += 4) for (let k = 0; k < 3; k++) out.data[i + k] = 255 - out.data[i + k];
    return out;
  },
}));

type RGBA = [number, number, number, number];
const RED: RGBA = [200, 40, 40, 255];
const INV_RED: RGBA = [55, 215, 215, 255];
const SEED: RGBA = [1, 2, 3, 255];

/** A worker that keeps what it was sent; a test answers for it. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: { id: number; nodeId: string; key: string; w: number; h: number; filters: SmartFilter[] }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(m: FakeWorker["posted"][number]) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  /** The job `i` back, its pixels all `px`. */
  reply(i: number, px: RGBA) {
    const j = this.posted[i];
    const data = new Uint8ClampedArray(j.w * j.h * 4);
    for (let p = 0; p < data.length; p += 4) data.set(px, p);
    const { id, nodeId, key, w, h } = j;
    this.onmessage!({ data: { id, nodeId, key, w, h, data: data.buffer } } as MessageEvent);
  }
}

const sharpen = (radius = 1, more: Partial<SmartFilter> = {}) =>
  ({
    id: "f",
    type: "sharpen",
    enabled: true,
    blendMode: "Normal",
    opacity: 100,
    params: { radius, amount: 50, threshold: 0 },
    ...more,
  }) as SmartFilter;
const node = (id: string, filters: SmartFilter[], more: object = {}) =>
  ({ id, type: "layer", name: id, filters, ...more }) as unknown as LayerNode;

function setup(W = 20, H = 10) {
  const cursor = new DocCursor();
  cursor.doc.w = W;
  cursor.doc.h = H;
  const src = canvas(W, H);
  src.ctx.fillStyle = "#c82828";
  src.ctx.fillRect(0, 0, W, H);
  const st = {
    key: "k0",
    live: new Set<string>(),
    cacheOn: true,
    exporting: false,
    workers: true,
    painting: false,
    strokeLayer: null as string | null,
    onMask: false,
    dirty: null as Rect | null,
    masks: {} as Record<string, HTMLCanvasElement>,
    calls: [] as string[],
  };
  const tree: LayerNode[] = [];
  const host: SmartFilterHost = {
    mk: (w, hh) => canvas(w, hh),
    cs: () => "srgb",
    nodeKey: () => st.key,
    noteShared: (id) => st.calls.push(`shared ${id}`),
    clearRenderCaches: () => st.calls.push("clear"),
    emitChange: () => st.calls.push("change"),
    maskDisplay: (id) => st.masks[id] ?? null,
    renderFill: () => src.c,
    leafDisplay: () => src.c,
    curTree: () => tree,
    liveBypass: () => st.live,
    renderCacheOn: () => st.cacheOn,
    exporting: () => st.exporting,
    workersOn: () => st.workers,
    painting: () => st.painting,
    strokeLayer: () => st.strokeLayer,
    strokeOnMask: () => st.onMask,
    dirtyRect: () => st.dirty,
    markDraftPainted: () => st.calls.push("draft painted"),
  };
  return { e: new EngineSmartFilters(cursor, host), st, src, cursor, tree };
}
const px = (c: HTMLCanvasElement | Layer, x: number, y: number) => fc(c).at(x, y);

beforeEach(() => {
  installFakeCanvas();
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.made = [];
  h.applied = [];
  h.budget = 1_000_000;
});

describe("the stack", () => {
  it("runs each enabled filter over a copy, blends it back by its opacity, and keeps to the filter mask", () => {
    const { e, src, st } = setup();
    const out = e.renderFiltered(src.c, [sharpen(), sharpen(1, { enabled: false })]);
    expect([px(out, 3, 3), h.applied.length, px(src, 3, 3)], "one pass; the source as it was").toEqual([
      INV_RED,
      1,
      RED,
    ]);
    const half = e.renderFiltered(src.c, [sharpen(1, { opacity: 50 })]);
    expect(px(half, 3, 3).map((v) => Math.round(v / 2)), "half way back").toEqual([64, 64, 64, 128]);
    // A mask white on the left, clear on the right: filtered there only.
    const m = canvas(20, 10);
    m.ctx.fillStyle = "#fff";
    m.ctx.fillRect(0, 0, 10, 10);
    st.masks[filterMaskKey("a")] = m.c;
    const n = node("a", [sharpen()], { filterMask: { enabled: true } });
    const masked = e.filteredProduct(n, src.c);
    expect([px(masked, 2, 2), px(masked, 15, 2)]).toEqual([INV_RED, RED]);
    st.masks[filterMaskKey("b")] = m.c;
    const off = e.filteredProduct(node("b", [sharpen()], { filterMask: { enabled: false } }), src.c);
    expect(px(off, 15, 2), "a mask turned off confines nothing").toEqual(INV_RED);
  });
});

describe("the product cache and the worker", () => {
  it("computes a cold miss in line and keeps it; a hit draws it again", () => {
    const { e, src, st } = setup();
    const n = node("a", [sharpen()]);
    const first = e.filteredProduct(n, src.c);
    expect(e.filteredProduct(n, src.c)).toBe(first);
    expect([h.applied.length, e.filteredCache.get("a")?.quality, st.calls]).toEqual([1, "full", ["shared a"]]);
    expect(FakeWorker.made, "no worker for a cold miss").toEqual([]);
  });

  it("draws the stale product while the worker refreshes it, then takes the reply", () => {
    const { e, src, st } = setup();
    const n = node("a", [sharpen()]);
    const stale = e.filteredProduct(n, src.c);
    st.key = "k1";
    expect(e.filteredProduct(n, src.c), "the stale product, this frame").toBe(stale);
    e.filteredProduct(n, src.c); // the same state again: no second job
    const w = FakeWorker.made[0];
    expect(w.posted.map((p) => [p.nodeId, p.key, p.w, p.h])).toEqual([["a", "k1", 20, 10]]);
    expect([h.applied.length, e.filterPending.size]).toEqual([1, 1]);
    st.calls.length = 0;
    w.reply(0, [1, 2, 3, 255]);
    const fresh = e.filteredProduct(n, src.c);
    expect([px(fresh, 0, 0), e.filterWorkerResults, e.filterPending.size, st.calls]).toEqual([
      [1, 2, 3, 255],
      1,
      0,
      ["shared a", "clear", "change"],
    ]);
  });

  it("drops a reply a newer job superseded, or one for a document since resized", () => {
    const { e, src, st, cursor } = setup();
    const n = node("a", [sharpen()]);
    e.filteredProduct(n, src.c);
    st.key = "k1";
    e.filteredProduct(n, src.c);
    st.key = "k2";
    e.filteredProduct(n, src.c);
    const w = FakeWorker.made[0];
    w.reply(0, [9, 9, 9, 255]);
    expect([e.filterWorkerResults, e.filteredCache.get("a")!.key], "the older reply dropped").toEqual([0, "k0"]);
    cursor.doc.w = 21;
    w.reply(1, [9, 9, 9, 255]);
    expect([e.filterWorkerResults, e.filterPending.size], "resized meanwhile: dropped").toEqual([0, 0]);
  });

  it("on a big document refreshes at half resolution, its params scaled, and refines once settled", () => {
    const { e, src, st } = setup(2000, 1000);
    const n = node("a", [sharpen(4)]);
    e.filteredProduct(n, src.c);
    st.key = "k1";
    e.filteredProduct(n, src.c);
    const w = FakeWorker.made[0];
    expect([w.posted[0].w, w.posted[0].h, (w.posted[0].filters[0].params as { radius: number }).radius]).toEqual([
      1000, 500, 2,
    ]);
    w.reply(0, [1, 2, 3, 255]);
    const preview = e.filteredCache.get("a")!;
    expect([preview.quality, preview.canvas.width], "upscaled to the document").toEqual(["preview", 2000]);
    expect(e.filteredProduct(n, src.c), "the preview draws while the full one runs").toBe(preview.canvas);
    expect([w.posted[1].w, w.posted[1].key, w.posted[1].filters[0].params]).toEqual([
      2000,
      "k1",
      { radius: 4, amount: 50, threshold: 0 },
    ]);
  });

  it("never gives an export or the cache switched off a stale product", () => {
    const { e, src, st } = setup();
    const n = node("a", [sharpen()]);
    const stale = e.filteredProduct(n, src.c);
    st.key = "k1";
    st.exporting = true;
    const exported = e.filteredProduct(n, src.c);
    expect([exported === stale, h.applied.length, FakeWorker.made.length]).toEqual([false, 2, 0]);
    st.exporting = false;
    st.key = "k2";
    st.cacheOn = false;
    e.filteredProduct(n, src.c);
    expect([h.applied.length, e.filteredCache.get("a")!.key], "computed, and not kept").toEqual([3, "k1"]);
  });

  it("without workers, or once one fails, refreshes in line", () => {
    const off = setup();
    off.st.workers = false;
    const n = node("a", [sharpen()]);
    off.e.filteredProduct(n, off.src.c);
    off.st.key = "k1";
    off.e.filteredProduct(n, off.src.c);
    expect([FakeWorker.made.length, h.applied.length]).toEqual([0, 2]);

    const { e, src, st } = setup();
    e.filteredProduct(n, src.c);
    st.key = "k1";
    e.filteredProduct(n, src.c);
    const w = FakeWorker.made[0];
    st.calls.length = 0;
    w.onerror!();
    expect([w.terminated, e.filterPending.size, st.calls]).toEqual([true, 0, ["clear", "change"]]);
    st.key = "k2";
    h.applied = [];
    e.filteredProduct(n, src.c);
    expect([FakeWorker.made.length, h.applied.length], "no second worker").toEqual([1, 1]);
  });

  it("keeps eight products at most, the oldest dropped first", () => {
    const { e, src } = setup();
    for (let i = 0; i < 9; i++) e.filteredProduct(node(`n${i}`, [sharpen()]), src.c);
    expect([e.filteredCache.size, e.filteredCache.has("n0"), e.filteredCache.has("n8")]).toEqual([8, false, true]);
  });

  it("compares a current product with the stack run in line, and has nothing to say of a stale one", () => {
    const { e, src, st, tree } = setup();
    const n = node("a", [sharpen()]);
    tree.push(n);
    expect(e.compareFilterProduct("a")).toBeNull();
    e.filteredProduct(n, src.c);
    expect(e.compareFilterProduct()).toMatchObject({ differing: 0, quality: "full", total: 20 * 10 * 4 });
    st.key = "k1";
    expect(e.compareFilterProduct("a")).toBeNull();
  });
});

describe("live frames", () => {
  /** A settled product — from the worker, its pixels unlike the stack's own, so a
   *  pixel says which pass made it — then a white stroke in its middle, live. */
  function stroking() {
    const s = setup();
    const n = node("a", [sharpen()]);
    s.e.filteredProduct(n, s.src.c);
    s.st.key = "k1";
    s.e.filteredProduct(n, s.src.c);
    FakeWorker.made.at(-1)!.reply(0, SEED); // this engine's worker
    s.st.live.add("a");
    Object.assign(s.st, { painting: true, strokeLayer: "a", dirty: { x: 8, y: 4, w: 2, h: 2 } });
    s.src.ctx.fillStyle = "#fff";
    s.src.ctx.fillRect(8, 4, 2, 2);
    h.applied = [];
    return { ...s, n };
  }

  it("re-filters the stroke's own region at full resolution into the settled product", () => {
    const { e, n, src } = stroking();
    h.budget = 50; // a draft would be 10 × 5: the region, 6 × 6, is smaller
    const out = e.filteredProduct(n, src.c);
    const pass = { params: n.filters![0].params, w: 6, h: 6 };
    expect([h.applied, e.liveRegionHits, e.liveRegionPx], "one pass, 6 × 6").toEqual([[pass], 1, 36]);
    // The rect it writes is the stroke grown by the reach; the one it reads is
    // grown again, and that border, filtered without its neighbours, is not kept.
    expect([px(out, 8, 4), px(out, 7, 3), px(out, 6, 2), px(out, 2, 2)], "the stroke, its reach, beyond").toEqual([
      [0, 0, 0, 255],
      INV_RED,
      SEED,
      SEED,
    ]);
    expect(e.filteredCache.get("a")!.canvas, "the settled product untouched").not.toBe(out);
  });

  it("starts again from the settled product once that moves on", () => {
    const { e, n, src, st } = stroking();
    h.budget = 50;
    e.filteredProduct(n, src.c);
    const next = canvas(20, 10);
    next.ctx.fillStyle = "#040506";
    next.ctx.fillRect(0, 0, 20, 10);
    st.key = "k2";
    e.filteredCache.set("a", { key: "k2", canvas: next.c, quality: "full" });
    expect(px(e.filteredProduct(n, src.c), 2, 2)).toEqual([4, 5, 6, 255]);
  });

  it("falls back to a draft on a mask, with the region off, past the draft's size, or with no full product", () => {
    type S = ReturnType<typeof stroking>;
    for (const [why, change] of [
      ["on the mask", (s: S) => (s.st.onMask = true)],
      ["the region off", (s: S) => s.e.setLiveRegionEnabled(false)],
      ["unbounded", (s: S) => (s.n.filters![0] = { ...s.n.filters![0], type: "noise" } as SmartFilter)],
      ["bigger than a draft", () => (h.budget = 20)], // a draft of 6 × 3
      ["a preview to seed", (s: S) => (s.e.filteredCache.get("a")!.quality = "preview")],
    ] as const) {
      const s = stroking();
      h.budget = 50;
      change(s);
      s.e.filteredProduct(s.n, s.src.c);
      const draftW = Math.round(20 * s.e.draftScale());
      expect([s.e.liveRegionHits, s.e.liveDraftFrames, h.applied[0]?.w, s.st.calls.at(-1)], why).toEqual([
        0,
        1,
        draftW,
        "draft painted",
      ]);
    }
  });

  it("computes the whole stack in line when the document is within the draft's budget", () => {
    const { e, n, src } = stroking();
    e.setLiveRegionEnabled(false);
    e.filteredProduct(n, src.c);
    expect([e.liveDraftFrames, h.applied[0].w]).toEqual([0, 20]);
  });

  it("draws at full size within the budget, the square root of its share beyond, never under a quarter", () => {
    const { e } = setup(); // 200 pixels
    expect([200, 50, 1].map((b) => ((h.budget = b), e.draftScale()))).toEqual([1, 0.5, 0.25]);
  });
});
