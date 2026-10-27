import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, type Layer } from "../app/lib/doc-state";
import { EngineBlurGallery, type BlurGalleryHost } from "../app/lib/engine/blur-gallery";
import { canvas, fc, installFakeCanvas } from "./fake-canvas";

/**
 * The engine's Blur Gallery (TODO 1.6, app/lib/engine/blur-gallery.ts): a
 * session over the chosen layers, previewed from the pixels it began with — in
 * line, or by a worker whose late replies are dropped — committed as one step
 * or cancelled. The blur itself is a stand-in that writes its amount into every
 * pixel, so a pixel says which render made it and from what.
 */

const h = vi.hoisted(() => ({ calls: [] as { src: unknown; kind: string; amount: number; cx: number; cy: number }[] }));
vi.mock("../app/lib/filters", async (real) => ({
  ...(await real<typeof import("../app/lib/filters")>()),
  computeBlurFx: (...[src, kind, amount, , , cx, cy]: [ImageData, string, number, number, unknown, number, number]) => {
    h.calls.push({ src, kind, amount, cx, cy });
    const out = new ImageData(src.width, src.height);
    for (let i = 0; i < out.data.length; i += 4) out.data.set([amount, amount, amount, 255], i);
    return out;
  },
}));

type RGBA = [number, number, number, number];
const W = 10;
const H = 4;

/** A worker that keeps what it was sent; a test answers for it. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: Record<string, unknown>[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(m: Record<string, unknown>) {
    this.posted.push(m);
  }
  terminate() {}
  /** A render's reply for `ids`, every pixel `v`. */
  reply(session: number, seq: number, ids: string[], v: number) {
    const results = ids.map((id) => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < data.length; i += 4) data.set([v, v, v, 255], i);
      return { id, w: W, h: H, data: data.buffer };
    });
    this.onmessage!({ data: { session, seq, results } } as MessageEvent);
  }
}

function setup() {
  const cursor = new DocCursor();
  cursor.doc.w = W;
  cursor.doc.h = H;
  for (const [id, fill] of [
    ["a", "#102030"],
    ["b", "#405060"],
  ] as const) {
    const l = canvas(W, H);
    l.ctx.fillStyle = fill;
    l.ctx.fillRect(0, 0, W, H);
    cursor.doc.layers.set(id, l);
  }
  const st = {
    calls: [] as string[],
    steps: [] as { label: string; undo: () => void; redo: () => void }[],
    workers: true,
  };
  const host: BlurGalleryHost = {
    layer: (id) => cursor.doc.layers.get(id)!,
    bumpPixel: (id) => st.calls.push(`bump ${id}`),
    emitChange: () => st.calls.push("change"),
    endLive: () => st.calls.push("end live"),
    selectionMask: (rects) => {
      const m = canvas(W, H);
      m.ctx.fillStyle = "#fff";
      for (const r of rects) m.ctx.fillRect(r.x, r.y, r.w, r.h);
      return m.c;
    },
    pushStructural: (label, undo, redo) => st.steps.push({ label, undo, redo }),
    dropWandSource: () => st.calls.push("wand"),
    cs: () => "srgb",
    workersOn: () => st.workers,
  };
  const px = (id: string): RGBA => fc(cursor.doc.layers.get(id) as Layer).at(3, 1) as RGBA;
  return { e: new EngineBlurGallery(cursor, host), st, px };
}

beforeEach(() => {
  installFakeCanvas();
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.made = [];
  h.calls = [];
});

describe("in line", () => {
  beforeEach(() => vi.stubGlobal("Worker", undefined));

  it("begins over the chosen layers once the live sessions end, keeping their pixels and the selection", () => {
    const { e, st } = setup();
    e.beginBlurFx(["a", "b"], [{ x: 0, y: 0, w: 4, h: H }]);
    const fx = e.blurFx!;
    expect([st.calls, fx.ids, [...fx.orig.keys()]]).toEqual([["end live"], ["a", "b"], ["a", "b"]]);
    const mask = [fx.mask![3], fx.mask![4], fx.mask!.length];
    expect(mask, "the selection's alpha, a byte a pixel").toEqual([255, 0, W * H]);
    e.cancelBlurFx();
    e.beginBlurFx(["a"], null);
    expect(e.blurFx!.mask, "no selection, no mask").toBeNull();
  });

  it("previews from the pixels it began with, about the anchor, each layer told", () => {
    const { e, st, px } = setup();
    e.beginBlurFx(["a", "b"], null);
    const orig = e.blurFx!.orig.get("a");
    st.calls.length = 0;
    e.previewBlurFx("gaussian", 7, 0, 0.3, 0.5);
    e.previewBlurFx("zoom", 9, 0, 0.3, 0.5);
    expect(h.calls.map((c) => [c.src === orig || c.src === e.blurFx!.orig.get("b"), c.kind, c.cx, c.cy])).toEqual([
      [true, "gaussian", 3, 2],
      [true, "gaussian", 3, 2],
      [true, "zoom", 3, 2],
      [true, "zoom", 3, 2],
    ]);
    expect([px("a"), px("b"), st.calls]).toEqual([
      [9, 9, 9, 255],
      [9, 9, 9, 255],
      ["bump a", "bump b", "change", "bump a", "bump b", "change"],
    ]);
  });

  it("commits as one step whose undo and redo swap the pixels, and lets go of the wand's source", () => {
    const { e, st, px } = setup();
    e.beginBlurFx(["a"], null);
    e.previewBlurFx("gaussian", 7, 0);
    st.calls.length = 0;
    e.commitBlurFx("Gaussian Blur");
    expect([e.blurFx, st.steps.map((s) => s.label), st.calls]).toEqual([null, ["Gaussian Blur"], ["wand"]]);
    st.steps[0].undo();
    expect(px("a"), "undone: as it began").toEqual([16, 32, 48, 255]);
    st.steps[0].redo();
    expect(px("a"), "redone: blurred").toEqual([7, 7, 7, 255]);
    expect(st.calls.filter((c) => c === "wand").length, "and again each way").toBe(3);
  });

  it("puts the pixels back on a cancel, and does nothing with no session", async () => {
    const { e, st, px } = setup();
    e.beginBlurFx(["a"], null);
    e.previewBlurFx("gaussian", 7, 0);
    st.calls.length = 0;
    e.cancelBlurFx();
    expect([px("a"), e.blurFx, st.calls]).toEqual([[16, 32, 48, 255], null, ["bump a", "change"]]);
    e.previewBlurFx("gaussian", 7, 0);
    e.commitBlurFx("Gaussian Blur");
    e.cancelBlurFx();
    expect([await e.previewBlurFxAsync("gaussian", 7, 0), st.steps, h.calls.length]).toEqual([false, [], 1]);
  });

  it("renders the async preview in line when there is no worker, and says it reached the layers", async () => {
    const { e, px } = setup();
    e.beginBlurFx(["a"], null);
    expect([await e.previewBlurFxAsync("box", 5, 0), px("a")]).toEqual([true, [5, 5, 5, 255]]);
  });
});

describe("with a worker", () => {
  it("ships the originals once a session, then renders by message, and takes the reply onto its layers", async () => {
    const { e, st, px } = setup();
    e.beginBlurFx(["a", "b"], [{ x: 0, y: 0, w: 4, h: H }]);
    const w = FakeWorker.made[0];
    const init = w.posted[0] as { type: string; session: number; layers: { id: string }[]; mask: ArrayBuffer };
    expect([init.type, init.session, init.layers.map((l) => l.id), init.mask.byteLength]).toEqual([
      "init",
      1,
      ["a", "b"],
      W * H,
    ]);
    const done = e.previewBlurFxAsync("motion", 12, 30, 0.2, 0.8);
    expect(w.posted[1]).toEqual({
      type: "render",
      session: 1,
      seq: 1,
      kind: "motion",
      amount: 12,
      angle: 30,
      ax: 0.2,
      ay: 0.8,
      extra: { band: 20, feather: 30, threshold: 40 },
    });
    expect(e.blurPending.size).toBe(1);
    st.calls.length = 0;
    w.reply(1, 1, ["a", "c"], 77); // "c" is not in the session
    expect([await done, px("a"), px("b"), st.calls, e.blurPending.size]).toEqual([
      true,
      [77, 77, 77, 255],
      [64, 80, 96, 255],
      ["bump a", "change"],
      0,
    ]);
    expect(h.calls, "nothing rendered in line").toEqual([]);
  });

  it("drops a superseded render's reply, and any after the session ended", async () => {
    const { e, px } = setup();
    e.beginBlurFx(["a"], null);
    const w = FakeWorker.made[0];
    const first = e.previewBlurFxAsync("gaussian", 3, 0);
    const second = e.previewBlurFxAsync("gaussian", 4, 0);
    w.reply(1, 1, ["a"], 3);
    expect([await first, px("a")], "superseded").toEqual([false, [16, 32, 48, 255]]);
    e.commitBlurFx("Gaussian Blur");
    expect(w.posted.at(-1), "the worker told").toEqual({ type: "end", session: 1 });
    w.reply(1, 2, ["a"], 4);
    expect([await second, px("a")], "the session over").toEqual([false, [16, 32, 48, 255]]);
    e.beginBlurFx(["a"], null);
    expect((w.posted.at(-1) as { session: number }).session, "a new session, numbered past both").toBe(3);
  });

  it("drops a reply from a session before this one, though it is the latest render", async () => {
    const { e, px } = setup();
    e.beginBlurFx(["a"], null);
    const w = FakeWorker.made[0];
    const late = e.previewBlurFxAsync("gaussian", 3, 0);
    e.cancelBlurFx();
    e.beginBlurFx(["a"], null); // a session again, and no render of its own yet
    w.reply(1, 1, ["a"], 3);
    expect([await late, px("a")]).toEqual([false, [16, 32, 48, 255]]);
  });

  it("releases every render waiting on a worker that fails, and carries on in line", async () => {
    const { e, px } = setup();
    e.beginBlurFx(["a"], null);
    const waiting = e.previewBlurFxAsync("gaussian", 3, 0);
    FakeWorker.made[0].onerror!();
    expect([await waiting, e.blurPending.size]).toEqual([false, 0]);
    expect([await e.previewBlurFxAsync("gaussian", 6, 0), px("a"), FakeWorker.made.length]).toEqual([
      true,
      [6, 6, 6, 255],
      1,
    ]);
  });

  it("uses no worker while background compute is off", async () => {
    const { e, st } = setup();
    st.workers = false;
    e.beginBlurFx(["a"], null);
    expect([await e.previewBlurFxAsync("gaussian", 6, 0), FakeWorker.made.length, h.calls.length]).toEqual([
      true,
      0,
      1,
    ]);
  });
});
