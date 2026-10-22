import { describe, expect, it } from "vitest";
import { createToolControllers } from "../app/tools";
import { healTool } from "../app/tools/heal";
import { redEyeTool } from "../app/tools/redeye";
import { blurTool, dodgeTool, smudgeTool, spongeTool } from "../app/tools/retouch";
import { zoomTool } from "../app/tools/view";
import type { OverlayPainter, ToolHost, ToolPointer } from "../app/tools";
import type { PaintEngine } from "../app/lib/paint";
import type { LayerNode } from "../app/lib/layers";
import {
  DEFAULT_BLUR,
  DEFAULT_DODGE,
  DEFAULT_HEAL,
  DEFAULT_REDEYE,
  DEFAULT_SMUDGE,
  DEFAULT_SPONGE,
} from "../app/lib/tools";
import { DEFAULT_MIXER } from "../app/lib/mixer";

/**
 * The tool controllers (TODO 1.4), driven without a browser: a fake engine
 * records what each is asked to do. That they do it to real pixels exactly as
 * the branches they replaced did is proved in the browser
 * (e2e/tool-controllers.spec.ts); here is the contract — when a tool starts,
 * what it starts, what it confines it to, and when it does nothing at all.
 */

type Call = [string, ...unknown[]];

function fake(over: Partial<ToolHost> = {}, floating = false) {
  const calls: Call[] = [];
  const engine = new Proxy(
    { isFloating: floating },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        return (...args: unknown[]) => calls.push([String(key), ...args]);
      },
    },
  ) as unknown as PaintEngine;
  const captured: number[] = [];
  let redraws = 0;
  const zooms: [number, number, number][] = [];
  const layers: LayerNode[] = [
    { id: "L1", type: "layer", name: "Pixels", visible: true, opacity: 100, blend: "Normal" },
    {
      id: "G1",
      type: "group",
      name: "Group",
      visible: true,
      opacity: 100,
      blend: "Normal",
      expanded: true,
      children: [],
    },
  ];
  const h: ToolHost = {
    engine,
    tool: "blur",
    toDoc: (e) => ({ x: e.clientX / 2, y: e.clientY / 2 }),
    capture: (e) => captured.push(e.pointerId),
    redraw: () => {
      redraws++;
    },
    activeLayerId: "L1",
    layers,
    paintBlocked: () => false,
    selection: { rects: null, angle: 0, pivot: null },
    foreground: "#ff8000",
    settings: {
      blur: DEFAULT_BLUR,
      smudge: DEFAULT_SMUDGE,
      mixer: DEFAULT_MIXER,
      dodge: DEFAULT_DODGE,
      sponge: DEFAULT_SPONGE,
      heal: DEFAULT_HEAL,
      redEye: DEFAULT_REDEYE,
    },
    zoomToPoint: (dir, x, y) => zooms.push([dir, x, y]),
    ...over,
  };
  return { h, calls, captured, zooms, redraws: () => redraws };
}

let prevented = 0;
const pointer = (x: number, y: number, over: Partial<ToolPointer> = {}): ToolPointer => ({
  clientX: x,
  clientY: y,
  pointerId: 7,
  pointerType: "mouse",
  button: 0,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  detail: 1,
  preventDefault: () => {
    prevented++;
  },
  ...over,
});

const names = (calls: Call[]) => calls.map((c) => c[0]);

/** A painter that records the rings drawn (and what else touches the canvas). */
function painter() {
  const rings: number[][] = [];
  const ops: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === "fillStyle" ? "" : () => ops.push(String(key))),
      set: (_t, key) => {
        ops.push(`set ${String(key)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const o: OverlayPainter = { ctx, p: { x: 10, y: 20 }, s: 2, ring: (...a) => rings.push(a) };
  return { o, rings, ops };
}

describe("the retouch brushes", () => {
  const cases = [
    { make: blurTool, tool: "blur", verbs: ["beginBlur", "moveBlur", "endBlur"] },
    { make: smudgeTool, tool: "smudge", verbs: ["beginSmudge", "moveSmudge", "endSmudge"] },
    { make: smudgeTool, tool: "mixer", verbs: ["beginMixer", "moveSmudge", "endSmudge"] },
    { make: dodgeTool, tool: "dodge", verbs: ["beginDodge", "moveDodge", "endDodge"] },
    { make: spongeTool, tool: "sponge", verbs: ["beginSponge", "moveSponge", "endSponge"] },
  ] as const;

  for (const c of cases) {
    it(`${c.tool}: one session per stroke — begun on the press, fed each move, ended on the lift`, () => {
      const { h, calls, captured } = fake({ tool: c.tool });
      const t = c.make();
      prevented = 0;
      t.down(pointer(100, 60), h);
      expect(t.busy()).toBe(true);
      expect(captured).toEqual([7]);
      expect(prevented).toBe(1);
      expect(t.move!(pointer(120, 80), h)).toBe(true);
      expect(t.move!(pointer(140, 90), h)).toBe(true);
      t.up!(pointer(140, 90), h);
      expect(t.busy()).toBe(false);
      expect(names(calls)).toEqual([c.verbs[0], c.verbs[1], c.verbs[1], c.verbs[2]]);
      expect(calls[0].slice(1, 2)).toEqual(["L1"]);
      expect(calls[0].slice(3, 5)).toEqual([50, 30]); // where the press landed, in doc px
      expect(calls[1].slice(1)).toEqual([60, 40]);
      // A move outside a stroke is not the tool's: the handler goes on.
      expect(t.move!(pointer(1, 1), h)).toBe(false);
    });
  }

  /* A second finger taking the pointer for a pinch: the stroke the first
     finger began is abandoned — the engine puts the layer back and records
     nothing — and nothing of it is left open for the next contact to feed. */
  for (const c of cases) {
    it(`${c.tool}: a pinch abandons the stroke — the engine puts it back, and it is over`, () => {
      const { h, calls } = fake({ tool: c.tool });
      const t = c.make();
      t.down(pointer(100, 60), h);
      t.move!(pointer(120, 80), h);
      t.cancel!(h);
      expect(t.busy()).toBe(false);
      expect(calls.at(-1)).toEqual([c.verbs[2], false]);
      expect(t.move!(pointer(140, 90), h), "a later move is not fed to it").toBe(false);
      t.up!(pointer(140, 90), h);
      expect(names(calls), "nor does a later lift end it again").toEqual([c.verbs[0], c.verbs[1], c.verbs[2]]);
      t.cancel!(h);
      expect(calls.length, "cancelling with no stroke does nothing").toBe(3);
    });
  }

  it("works inside the selection, rotation and all", () => {
    const sel = { rects: [{ x: 1, y: 2, w: 30, h: 40 }], angle: 0.5, pivot: { x: 16, y: 22 } };
    const { h, calls } = fake({ selection: sel });
    blurTool().down(pointer(100, 60), h);
    expect(calls[0].slice(-3)).toEqual([sel.rects, 0.5, sel.pivot]);
  });

  it("does nothing on an empty document, or on a layer whose pixels are locked", () => {
    for (const over of [{ activeLayerId: null }, { paintBlocked: () => true }]) {
      const { h, calls, captured } = fake(over);
      const t = blurTool();
      t.down(pointer(100, 60), h);
      expect(t.busy()).toBe(false);
      expect(calls).toEqual([]);
      expect(captured).toEqual([]);
    }
  });

  it("merges a floating selection before working on the layer under it", () => {
    const { h, calls } = fake({}, true);
    dodgeTool().down(pointer(100, 60), h);
    expect(names(calls)).toEqual(["commitFloat", "beginDodge"]);
  });

  it("seeds the mixer with the foreground colour, and the smudge only when finger painting", () => {
    const mixer = fake({ tool: "mixer" });
    smudgeTool().down(pointer(0, 0), mixer.h);
    expect(mixer.calls[0][5]).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    const plain = fake({ tool: "smudge" });
    smudgeTool().down(pointer(0, 0), plain.h);
    expect(plain.calls[0][5]).toBeNull();
    const finger = fake({ tool: "smudge" });
    finger.h.settings = { ...finger.h.settings, smudge: { ...DEFAULT_SMUDGE, fingerPaint: true } };
    smudgeTool().down(pointer(0, 0), finger.h);
    expect(finger.calls[0][5]).toEqual({ r: 255, g: 128, b: 0, a: 255 });
  });

  it("draws its ring where the pointer is, at the tip's size and hardness", () => {
    const { h } = fake();
    const t = blurTool();
    const { o, rings } = painter();
    t.drawOverlay!(o, h);
    expect(rings).toEqual([]); // not over the canvas yet
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.drawOverlay!(o, h);
    expect(rings).toEqual([[10 + 5 * 2, 20 + 6 * 2, Math.max(1, (DEFAULT_BLUR.size / 2) * 2), DEFAULT_BLUR.hardness]]);
  });

  it("shows the mixer's own tip, though it shares the smudge's session", () => {
    const { h } = fake({ tool: "mixer" });
    h.settings = { ...h.settings, mixer: { ...DEFAULT_MIXER, size: 77 } };
    const t = smudgeTool();
    const { o, rings } = painter();
    t.hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    t.drawOverlay!(o, h);
    expect(rings[0][2]).toBe(77);
  });

  it("takes its ring away when the pointer leaves — unless a stroke is under way", () => {
    const { h } = fake();
    const t = spongeTool();
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!()).toBe(false);
    t.down(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(), "dragged out mid-stroke: the ring stays").toBe(true);
  });
});

describe("spot healing", () => {
  it("paints a blob while the pointer is down and heals it once, on the lift", () => {
    const { h, calls } = fake({ tool: "heal" });
    const t = healTool();
    t.down(pointer(100, 100), h);
    expect(t.busy()).toBe(true);
    const step = Math.max(2, DEFAULT_HEAL.size / 6);
    t.hover!({ x: 50 + step / 2, y: 50 }, pointer(0, 0), h); // too close: no new dab
    t.hover!({ x: 50 + step * 1.2, y: 50 }, pointer(0, 0), h);
    t.hover!({ x: 50 + step * 2.5, y: 50 }, pointer(0, 0), h);
    expect(calls).toEqual([]); // nothing healed while painting
    t.up!(pointer(0, 0), h);
    expect(t.busy()).toBe(false);
    expect(names(calls)).toEqual(["healSpots"]);
    const [, id, pts, size, hardness] = calls[0];
    expect([id, size, hardness]).toEqual(["L1", DEFAULT_HEAL.size, DEFAULT_HEAL.hardness]);
    expect(pts).toEqual([
      { x: 50, y: 50 },
      { x: 50 + step * 1.2, y: 50 },
      { x: 50 + step * 2.5, y: 50 },
    ]);
    t.up!(pointer(0, 0), h);
    expect(calls.length, "a second lift heals nothing").toBe(1);
  });

  it("drops the blob on a pinch: nothing is healed, then or on the lift", () => {
    const { h, calls } = fake({ tool: "heal" });
    const t = healTool();
    t.down(pointer(100, 100), h);
    t.hover!({ x: 80, y: 50 }, pointer(0, 0), h);
    t.cancel!(h);
    expect(t.busy()).toBe(false);
    expect(t.wantsOverlay!(), "the ring stays; the veil goes").toBe(true);
    t.up!(pointer(0, 0), h);
    expect(calls).toEqual([]);
  });

  it("heals pixels only: not a group, not an empty document", () => {
    for (const over of [{ activeLayerId: "G1" }, { activeLayerId: null }]) {
      const { h, calls } = fake(over);
      const t = healTool();
      t.down(pointer(10, 10), h);
      expect(t.busy()).toBe(false);
      t.up!(pointer(10, 10), h);
      expect(calls).toEqual([]);
    }
  });

  it("shows the blob as a veil under the ring while it is painted", () => {
    const { h } = fake();
    const t = healTool();
    const { o, rings, ops } = painter();
    t.down(pointer(20, 20), h);
    t.drawOverlay!(o, h);
    expect(ops).toContain("arc");
    expect(ops).toContain("fill");
    expect(rings.length).toBe(1);
  });
});

describe("red eye", () => {
  it("darkens the pupil under one click, and is done", () => {
    const { h, calls } = fake({ tool: "redeye" });
    const t = redEyeTool();
    t.down(pointer(40, 60), h);
    expect(t.busy()).toBe(false);
    expect(calls).toEqual([["redEye", "L1", 20, 30, DEFAULT_REDEYE.size, DEFAULT_REDEYE.darken, null, 0, null]]);
  });

  it("darkens only inside the selection — as the heal heals only inside it", () => {
    const sel = { rects: [{ x: 0, y: 0, w: 9, h: 9 }], angle: 0.25, pivot: { x: 4, y: 4 } };
    const eye = fake({ selection: sel });
    redEyeTool().down(pointer(4, 4), eye.h);
    expect(eye.calls[0].slice(-3)).toEqual([sel.rects, 0.25, sel.pivot]);
    const heal = fake({ selection: sel });
    const t = healTool();
    t.down(pointer(4, 4), heal.h);
    t.up!(pointer(4, 4), heal.h);
    expect(heal.calls[0].slice(-3)).toEqual([sel.rects, 0.25, sel.pivot]);
  });

  it("takes its ring away when the pointer leaves the canvas", () => {
    const { h } = fake({ tool: "redeye" });
    const t = redEyeTool();
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    expect(t.wantsOverlay!()).toBe(true);
    t.leave!(h);
    expect(t.wantsOverlay!()).toBe(false);
  });

  it("leaves a group alone", () => {
    const { h, calls } = fake({ activeLayerId: "G1" });
    redEyeTool().down(pointer(40, 60), h);
    expect(calls).toEqual([]);
  });
});

describe("zoom", () => {
  it("steps in on a click, out on a right-click or with Alt, about the pointer", () => {
    const { h, zooms } = fake();
    const t = zoomTool();
    t.down(pointer(300, 200), h);
    t.down(pointer(300, 200, { button: 2 }), h);
    t.down(pointer(300, 200, { altKey: true }), h);
    expect(zooms).toEqual([
      [1, 300, 200],
      [-1, 300, 200],
      [-1, 300, 200],
    ]);
    expect(t.busy()).toBe(false);
  });

  it("answers a tap even with pan mode on", () => {
    expect(zoomTool().overPan).toBe(true);
    expect(blurTool().overPan).toBeFalsy();
  });
});

describe("the set", () => {
  it("gives each canvas its own controllers, so two canvases never share a stroke", () => {
    const a = createToolControllers();
    const b = createToolControllers();
    expect(a.blur).not.toBe(b.blur);
    const { h } = fake();
    a.blur!.down(pointer(0, 0), h);
    expect([a.blur!.busy(), b.blur!.busy()]).toEqual([true, false]);
  });

  it("shares one controller between Smudge and the Mixer brush — one session", () => {
    const set = createToolControllers();
    expect(set.smudge).toBe(set.mixer);
  });
});
