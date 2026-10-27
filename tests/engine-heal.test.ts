import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocCursor, DocumentState, type Layer } from "../app/lib/doc-state";
import { EngineHeal, type HealHost } from "../app/lib/engine/heal";
import type { Rect } from "../app/lib/view";
import { canvas, fc, FakeCanvas, installFakeCanvas } from "./fake-canvas";

/**
 * The engine's heal (TODO 1.6, app/lib/engine/heal.ts): the region a spot heal
 * or a content-aware fill works on and its coverage, the solve in the worker or
 * in line, and the bake — into the document it began in, even one gone to the
 * back. The solver is a stand-in that paints what is covered, so a pixel says
 * whether it was healed; the padding round a region is a fixed 3.
 */

const h = vi.hoisted(() => ({ solved: [] as { w: number; h: number; coverage: Uint8ClampedArray }[] }));
vi.mock("../app/lib/heal", () => ({
  healPadding: () => 3,
  healRegion: ({ src, coverage }: { src: ImageData; coverage: Uint8ClampedArray }) => {
    h.solved.push({ w: src.width, h: src.height, coverage });
    const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    for (let i = 0; i < coverage.length; i++) if (coverage[i]) out.data.set([9, 9, 9, 255], i * 4);
    return out;
  },
}));

const W = 30;
const H = 10;
const BLUE = [16, 32, 48, 255];
const HEALED = [9, 9, 9, 255];

/** A worker that keeps what it was sent; a test answers for it. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: { id: number; w: number; h: number; src: ArrayBuffer; coverage: ArrayBuffer }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(m: FakeWorker["posted"][number]) {
    this.posted.push(m);
  }
  terminate() {}
  /** Job `i` back, every pixel `v`. */
  reply(i: number, v: number) {
    const j = this.posted[i];
    const data = new Uint8ClampedArray(j.w * j.h * 4);
    for (let p = 0; p < data.length; p += 4) data.set([v, v, v, 255], p);
    this.onmessage!({ data: { id: j.id, data: data.buffer } } as MessageEvent);
  }
}

/** A document of one blue layer "a". */
function doc() {
  const d = new DocumentState();
  d.w = W;
  d.h = H;
  const l = canvas(W, H);
  l.ctx.fillStyle = "#102030";
  l.ctx.fillRect(0, 0, W, H);
  d.layers.set("a", l);
  return d;
}

function setup() {
  const cursor = new DocCursor();
  cursor.doc = doc();
  cursor.docs.set("d1", cursor.doc);
  const st = {
    workers: true,
    calls: [] as string[],
    entries: [] as { layerId: string; rect: Rect; label: string }[],
    behind: [] as { d: DocumentState; rect: Rect; label: string }[],
  };
  const host: HealHost = {
    selectionMask: (rects) => {
      const m = canvas(W, H);
      m.ctx.fillStyle = "#fff";
      for (const r of rects) m.ctx.fillRect(r.x, r.y, r.w, r.h);
      return m.c;
    },
    boundsOf: (rects) => rects[0] ?? null,
    pushEntry: (layerId, rect, _before, _after, label) => st.entries.push({ layerId, rect, label }),
    landInBackground: (d, _layerId, rect, _before, _after, label) => st.behind.push({ d, rect, label }),
    bumpPixel: (id, rect) => st.calls.push(`bump ${id} ${JSON.stringify(rect)}`),
    emitChange: () => st.calls.push("change"),
    cs: () => "srgb",
    workersOn: () => st.workers,
  };
  const px = (x: number, y: number, d = cursor.doc) => fc(d.layers.get("a") as Layer).at(x, y);
  return { e: new EngineHeal(cursor, host), st, cursor, px };
}
const covered = (c: Uint8ClampedArray, w: number) =>
  [...c].map((v, i) => (v ? `${i % w},${Math.floor(i / w)}` : "")).filter(Boolean);

beforeEach(() => {
  installFakeCanvas();
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.made = [];
  h.solved = [];
});

describe("in line", () => {
  beforeEach(() => vi.stubGlobal("Worker", undefined));

  it("heals the stroke's box, padded and kept on the canvas, its soft discs at the hardness", () => {
    const { e, st } = setup();
    const made: FakeCanvas[] = [];
    vi.stubGlobal("document", { createElement: () => made[made.push(new FakeCanvas()) - 1] });
    e.healSpots("a", [{ x: 10, y: 5 }, { x: 14, y: 5 }], 4, 50);
    // Discs of radius 2 from x 8 to 16, y 3 to 7; padded by 3: x 5 to 19, y 0 to 10 (the canvas's edge).
    expect([h.solved.map((s) => [s.w, s.h]), st.entries]).toEqual([
      [[14, 10]],
      [{ layerId: "a", rect: { x: 5, y: 0, w: 14, h: 10 }, label: "Spot Heal" }],
    ]);
    // Each disc where its point is in the region, solid to half its radius, then fading out.
    const discs = made.flatMap((c) => c.calls).filter((c) => c[0] === "arc" || c[0] === "createRadialGradient");
    expect(discs.map((c) => (c[0] === "arc" ? c.slice(0, 4) : (c.at(-1) as { stops: unknown }).stops))).toEqual([
      [
        [0.5, "rgba(255,255,255,1)"],
        [1, "rgba(255,255,255,0)"],
      ],
      ["arc", 5, 5, 2],
      [
        [0.5, "rgba(255,255,255,1)"],
        [1, "rgba(255,255,255,0)"],
      ],
      ["arc", 9, 5, 2],
    ]);
    expect(st.calls).toEqual([`bump a ${JSON.stringify({ x: 5, y: 0, w: 14, h: 10 })}`, "change"]);
  });

  it("keeps the region on the canvas where the padding would take it off", () => {
    const { e, st } = setup();
    e.healSpots("a", [{ x: 1, y: 1 }, { x: 28, y: 8 }], 4, 50); // padded: -4 to 33 across, -4 to 13 down
    expect([h.solved.map((s) => [s.w, s.h]), st.entries[0].rect]).toEqual([[[W, H]], { x: 0, y: 0, w: W, h: H }]);
  });

  it("fills the selection's box, padded, its coverage the selection itself", () => {
    const { e, st, px } = setup();
    e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
    const s = h.solved[0];
    expect([s.w, s.h, covered(s.coverage, s.w)]).toEqual([8, 8, ["3,3", "4,3", "3,4", "4,4"]]);
    expect([st.entries[0].rect, st.entries[0].label]).toEqual([{ x: 7, y: 1, w: 8, h: 8 }, "Content-Aware Fill"]);
    expect([px(10, 4), px(9, 4)], "healed inside, as it was beside").toEqual([HEALED, BLUE]);
  });

  it("keeps a spot heal inside the selection", () => {
    const { e } = setup();
    const clip = vi.spyOn(e, "clipCoverageToSelection");
    e.healSpots("a", [{ x: 10, y: 5 }], 4, 100);
    const sel = [{ x: 0, y: 0, w: 9, h: H }];
    e.healSpots("a", [{ x: 10, y: 5 }], 4, 100, sel, 15, { x: 1, y: 2 });
    expect(clip.mock.calls.map((c) => c.slice(1)), "clipped once, to the selection").toEqual([
      [5, 0, 10, 10, sel, 15, { x: 1, y: 2 }],
    ]);
    expect(clip.mock.calls[0][0], "the coverage it solves with").toBe(h.solved[1].coverage);
  });

  it("does nothing with no points, no such layer, or no selection", () => {
    const { e, st } = setup();
    e.healSpots("a", [], 4, 50);
    e.healSpots("nope", [{ x: 1, y: 1 }], 4, 50);
    e.contentAwareFill("a", []);
    e.contentAwareFill("nope", [{ x: 1, y: 1, w: 2, h: 2 }]);
    expect([h.solved, st.entries, st.calls]).toEqual([[], [], []]);
  });
});

describe("with a worker", () => {
  it("sends the region and its coverage, and bakes the reply as one step", () => {
    const { e, st, px } = setup();
    e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
    const w = FakeWorker.made[0];
    const job = w.posted[0];
    expect([job.w, job.h, new Uint8ClampedArray(job.coverage).filter(Boolean).length, e.healPending.size]).toEqual([
      8, 8, 4, 1,
    ]);
    expect([h.solved, st.entries], "nothing solved or committed yet").toEqual([[], []]);
    w.reply(0, 77);
    const at = [px(7, 1), px(14, 8), px(15, 9), e.healPending.size];
    expect(at, "the region's corners, and past it").toEqual([[77, 77, 77, 255], [77, 77, 77, 255], BLUE, 0]);
    expect([st.entries.map((x) => x.label), st.calls.at(-1)]).toEqual([["Content-Aware Fill"], "change"]);
  });

  it("drops a reply for a document since resized, reframed, closed, or a layer since deleted", () => {
    for (const [why, change] of [
      ["resized", (s: ReturnType<typeof setup>) => (s.cursor.doc.w = 31)],
      ["reframed", (s: ReturnType<typeof setup>) => s.cursor.doc.epoch++],
      ["closed", (s: ReturnType<typeof setup>) => ((s.cursor.doc = doc()), s.cursor.docs.clear())],
      ["layer deleted", (s: ReturnType<typeof setup>) => s.cursor.doc.layers.delete("a")],
    ] as const) {
      FakeWorker.made = [];
      const s = setup();
      s.e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
      change(s);
      FakeWorker.made[0].reply(0, 77);
      expect([s.st.entries, s.st.behind, s.st.calls], why).toEqual([[], [], []]);
    }
  });

  it("lands a heal whose document went to the back in that document, not the one in front", () => {
    const { e, st, cursor } = setup();
    const first = cursor.doc;
    e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
    const second = doc();
    cursor.docs.set("d2", second);
    cursor.doc = second;
    FakeWorker.made[0].reply(0, 77);
    expect([st.behind.map((b) => [b.d === first, b.rect, b.label]), st.entries]).toEqual([
      [[true, { x: 7, y: 1, w: 8, h: 8 }, "Content-Aware Fill"]],
      [],
    ]);
  });

  it("finishes every heal out to a worker that fails, in line, and carries on without it", () => {
    const { e, st, px } = setup();
    e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
    e.contentAwareFill("a", [{ x: 20, y: 4, w: 2, h: 2 }]);
    FakeWorker.made[0].onerror!();
    expect([h.solved.length, st.entries.length, e.healPending.size, px(20, 4)]).toEqual([2, 2, 0, HEALED]);
    e.contentAwareFill("a", [{ x: 2, y: 4, w: 2, h: 2 }]);
    expect([h.solved.length, FakeWorker.made.length], "in line from now on").toEqual([3, 1]);
  });

  it("uses no worker while background compute is off", () => {
    const { e, st } = setup();
    st.workers = false;
    e.contentAwareFill("a", [{ x: 10, y: 4, w: 2, h: 2 }]);
    expect([FakeWorker.made.length, h.solved.length, st.entries.length]).toEqual([0, 1, 1]);
  });
});
