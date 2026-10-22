import { describe, expect, it } from "vitest";
import { createToolControllers } from "../app/tools";
import { healTool } from "../app/tools/heal";
import { createPaintTools } from "../app/tools/paint";
import { redEyeTool } from "../app/tools/redeye";
import { blurTool, dodgeTool, smudgeTool, spongeTool } from "../app/tools/retouch";
import { zoomTool } from "../app/tools/view";
import type { ToolHost, ToolPointer } from "../app/tools";
import { DEFAULT_CLONE, DEFAULT_BLUR, DEFAULT_HEAL, DEFAULT_REDEYE, DEFAULT_SMUDGE } from "../app/lib/tools";
import { DEFAULT_MIXER } from "../app/lib/mixer";
import { BRUSH, fake, names, painter, pointer, prevented } from "./tools-bench";

/**
 * The tool controllers (TODO 1.4), driven without a browser: a fake engine
 * records what each is asked to do. That they do it to real pixels exactly as
 * the branches they replaced did is proved in the browser
 * (e2e/tool-controllers.spec.ts); here is the contract — when a tool starts,
 * what it starts, what it confines it to, and when it does nothing at all.
 */

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
      prevented.n = 0;
      t.down(pointer(100, 60), h);
      expect(t.busy()).toBe(true);
      expect(captured).toEqual([7]);
      expect(prevented.n).toBe(1);
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
    t.drawCursor!(o, h);
    expect(rings).toEqual([]); // not over the canvas yet
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.drawCursor!(o, h);
    expect(rings).toEqual([[10 + 5 * 2, 20 + 6 * 2, Math.max(1, (DEFAULT_BLUR.size / 2) * 2), DEFAULT_BLUR.hardness]]);
  });

  it("shows the mixer's own tip, though it shares the smudge's session", () => {
    const { h } = fake({ tool: "mixer" });
    h.settings = { ...h.settings, mixer: { ...DEFAULT_MIXER, size: 77 } };
    const t = smudgeTool();
    const { o, rings } = painter();
    t.hover!({ x: 0, y: 0 }, pointer(0, 0), h);
    t.drawCursor!(o, h);
    expect(rings[0][2]).toBe(77);
  });

  it("takes its ring away when the pointer leaves — unless a stroke is under way", () => {
    const { h } = fake();
    const t = spongeTool();
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
    t.down(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "dragged out mid-stroke: the ring stays").toBe(true);
  });
});

describe("the brush, pencil and eraser", () => {
  const paint = () => createPaintTools().brush;

  it("one stroke per press — begun where it landed, fed each move, ended on the lift", () => {
    const { h, calls, captured } = fake({ tool: "brush" });
    const t = paint();
    prevented.n = 0;
    t.down(pointer(100, 60), h);
    expect(t.busy()).toBe(true);
    expect(captured).toEqual([7]);
    expect(prevented.n).toBe(1);
    expect(calls).toEqual([["beginStroke", "L1", BRUSH, "#ff8000", 50, 30, "paint", null, 0, null, "Brush", 1]]);
    expect(t.move!(pointer(120, 80), h)).toBe(true);
    t.up!(pointer(120, 80), h);
    expect(t.busy()).toBe(false);
    expect(calls.slice(1)).toEqual([["moveStroke", 60, 40, 1], ["endStroke"]]);
    expect(t.move!(pointer(1, 1), h), "a move outside a stroke is not the brush's").toBe(false);
  });

  it("paints the secondary colour with the right button", () => {
    const { h, calls } = fake({ tool: "brush" });
    paint().down(pointer(100, 60, { button: 2 }), h);
    expect(calls[0][3]).toBe("#0000ff");
  });

  it("names the step for the tool, and the eraser erases — as does a stylus turned over", () => {
    const label = (tool: "brush" | "pencil" | "eraser", over: Partial<ToolPointer> = {}) => {
      const { h, calls } = fake({ tool });
      paint().down(pointer(0, 0, over), h);
      return [calls[0][6], calls[0][10]];
    };
    expect(label("brush")).toEqual(["paint", "Brush"]);
    expect(label("pencil")).toEqual(["paint", "Pencil"]);
    expect(label("eraser")).toEqual(["erase", "Erase"]);
    expect(label("brush", { pointerType: "pen", buttons: 32 })).toEqual(["erase", "Erase"]);
    expect(label("brush", { pointerType: "pen", buttons: 1 })).toEqual(["paint", "Brush"]);
    expect(label("brush", { buttons: 32 }), "only a pen has an eraser end").toEqual(["paint", "Brush"]);
    // Turned over with no layer to erase, it paints (a new layer) as the brush would.
    const { h, calls } = fake({ tool: "brush", activeLayerId: null, ensureLayer: () => "NEW" });
    paint().down(pointer(0, 0, { pointerType: "pen", buttons: 32 }), h);
    expect([calls[0][1], calls[0][6]]).toEqual(["NEW", "paint"]);
  });

  it("paints a new layer when none is selected — but the eraser has nothing to erase", () => {
    const brush = fake({ tool: "brush", activeLayerId: null, ensureLayer: () => "NEW" });
    paint().down(pointer(0, 0), brush.h);
    expect(brush.calls[0].slice(0, 2)).toEqual(["beginStroke", "NEW"]);
    const eraser = fake({ tool: "eraser", activeLayerId: null, ensureLayer: () => "NEW" });
    const t = paint();
    t.down(pointer(0, 0), eraser.h);
    expect(eraser.calls).toEqual([]);
    expect(t.busy()).toBe(false);
  });

  it("paints a mask on the layer it belongs to, never a new layer", () => {
    for (const answers of [{ surface: "mask" as const }, { quickMaskActive: true }]) {
      const { h, calls } = fake({ tool: "brush", ensureLayer: () => "NEW" }, false, answers);
      paint().down(pointer(0, 0), h);
      expect(calls[0].slice(0, 2)).toEqual(["beginStroke", "L1"]);
    }
  });

  it("leaves a locked layer alone, and merges a floating selection first", () => {
    const locked = fake({ tool: "brush", paintBlocked: () => true });
    const t = paint();
    t.down(pointer(0, 0), locked.h);
    expect(locked.calls).toEqual([]);
    expect(t.busy()).toBe(false);
    const floating = fake({ tool: "brush" }, true);
    paint().down(pointer(0, 0), floating.h);
    expect(names(floating.calls)).toEqual(["commitFloat", "beginStroke"]);
  });

  it("works inside the selection", () => {
    const sel = { rects: [{ x: 1, y: 2, w: 30, h: 40 }], angle: 0.5, pivot: { x: 16, y: 22 } };
    const { h, calls } = fake({ tool: "brush", selection: sel });
    paint().down(pointer(0, 0), h);
    expect(calls[0].slice(7, 10)).toEqual([sel.rects, 0.5, sel.pivot]);
  });

  it("replays a pen's coalesced samples, each with its own pressure — a mouse's are ignored", () => {
    const samples = [
      { clientX: 10, clientY: 10, pointerType: "pen", pressure: 0.2 },
      { clientX: 20, clientY: 10, pointerType: "pen", pressure: 0.4 },
      { clientX: 30, clientY: 10, pointerType: "pen", pressure: 0.6 },
    ];
    const pen = fake({ tool: "brush" });
    const t = paint();
    t.down(pointer(0, 0, { pointerType: "pen", pressure: 0.1 }), pen.h);
    expect(pen.calls[0][11], "the press's own pressure").toBe(0.1);
    t.move!(pointer(30, 10, { pointerType: "pen", nativeEvent: { getCoalescedEvents: () => samples } }), pen.h);
    expect(pen.calls.slice(1)).toEqual([
      ["moveStroke", 5, 5, 0.2],
      ["moveStroke", 10, 5, 0.4],
      ["moveStroke", 15, 5, 0.6],
    ]);
    const mouse = fake({ tool: "brush" });
    const m = paint();
    m.down(pointer(0, 0), mouse.h);
    m.move!(pointer(30, 10, { nativeEvent: { getCoalescedEvents: () => samples } }), mouse.h);
    expect(mouse.calls.slice(1)).toEqual([["moveStroke", 15, 5, 1]]);
  });

  it("hands the Actions recorder the stroke, its path thinned, once — only while recording", () => {
    const rec = fake({ tool: "pencil" });
    rec.h.strokes = { recording: true, record: (st) => rec.recorded.push(st) };
    const t = paint();
    t.down(pointer(0, 0), rec.h);
    t.move!(pointer(1, 0), rec.h); // half a doc px: too close to keep
    t.move!(pointer(4, 0), rec.h);
    t.up!(pointer(4, 0), rec.h);
    t.up!(pointer(4, 0), rec.h);
    expect(rec.recorded).toEqual([
      {
        tool: "pencil",
        brush: BRUSH,
        color: "#ff8000",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      },
    ]);
    expect(rec.recorded[0].brush, "a copy of the settings, not the live object").not.toBe(BRUSH);
    const off = fake({ tool: "pencil" });
    const u = paint();
    u.down(pointer(0, 0), off.h);
    u.up!(pointer(0, 0), off.h);
    expect(off.recorded).toEqual([]);
  });

  it("a pinch throws the stroke away — and nothing of it is left for the next contact", () => {
    const { h, calls } = fake({ tool: "brush" });
    const t = paint();
    t.down(pointer(0, 0), h);
    t.cancel!(h);
    expect(t.busy()).toBe(false);
    expect(t.move!(pointer(9, 9), h)).toBe(false);
    t.up!(pointer(9, 9), h);
    t.cancel!(h);
    expect(names(calls)).toEqual(["beginStroke", "cancelStroke"]);
  });

  it("Erase to History: the eraser runs the history session, on a layer's pixels only", () => {
    const eraser = { ...BRUSH, eraseToHistory: true };
    const set = (h: ToolHost) => (h.settings = { ...h.settings, brush: eraser });
    const px = fake({ tool: "eraser" });
    set(px.h);
    const t = paint();
    t.down(pointer(100, 60), px.h);
    expect(t.busy()).toBe(true);
    t.move!(pointer(120, 80), px.h);
    t.up!(pointer(120, 80), px.h);
    expect(px.calls).toEqual([
      ["beginHistory", "L1", eraser, 50, 30, null, 0, null, "Erase to History"],
      ["moveHistory", 60, 40],
      ["endHistory"],
    ]);
    for (const answers of [{ surface: "mask" as const }, { quickMaskActive: true }]) {
      const m = fake({ tool: "eraser" }, false, answers);
      set(m.h);
      paint().down(pointer(0, 0), m.h);
      expect(m.calls[0][0], "a mask has no past: it is erased").toBe("beginStroke");
    }
    const flipped = fake({ tool: "brush" });
    set(flipped.h);
    paint().down(pointer(0, 0, { pointerType: "pen", buttons: 32 }), flipped.h);
    expect(flipped.calls[0][0], "a flipped stylus erases to transparency").toBe("beginStroke");
  });

  it("a pinch abandons an Erase-to-History stroke too", () => {
    const { h, calls } = fake({ tool: "eraser" });
    h.settings = { ...h.settings, brush: { ...BRUSH, eraseToHistory: true } };
    const t = paint();
    t.down(pointer(0, 0), h);
    t.cancel!(h);
    expect(calls.at(-1)).toEqual(["endHistory", false]);
    expect(t.busy()).toBe(false);
  });

  it("shows its ring at the tip's size — which stays while a stroke is dragged out", () => {
    const { h } = fake({ tool: "brush" });
    const t = paint();
    const { o, rings } = painter();
    t.hover!({ x: 5, y: 6 }, pointer(10, 12), h);
    t.drawCursor!(o, h);
    expect(rings).toEqual([[10 + 5 * 2, 20 + 6 * 2, BRUSH.size, BRUSH.hardness]]);
    t.down(pointer(40, 12), h);
    t.drawCursor!(o, h);
    expect(rings[1].slice(0, 2), "the press moves it: it tracks the stroke").toEqual([10 + 20 * 2, 20 + 6 * 2]);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "mid-stroke: the ring stays").toBe(true);
    t.up!(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });

  it("keeps the ring through an Erase-to-History stroke dragged out", () => {
    const { h } = fake({ tool: "eraser" });
    h.settings = { ...h.settings, brush: { ...BRUSH, eraseToHistory: true } };
    const t = paint();
    t.down(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
  });
});

describe("the history brush", () => {
  it("paints the layer back from its history: one session per stroke, on the active layer", () => {
    const { h, calls, captured } = fake({ tool: "history" });
    const t = createPaintTools().history;
    t.down(pointer(100, 60), h);
    expect(captured).toEqual([7]);
    t.move!(pointer(120, 80), h);
    t.up!(pointer(120, 80), h);
    expect(calls).toEqual([
      ["beginHistory", "L1", h.settings.history, 50, 30, null, 0, null],
      ["moveHistory", 60, 40],
      ["endHistory"],
    ]);
    expect(t.busy()).toBe(false);
  });

  it("needs a layer, and one it may paint", () => {
    for (const over of [{ activeLayerId: null }, { paintBlocked: () => true }]) {
      const { h, calls } = fake({ tool: "history", ...over });
      const t = createPaintTools().history;
      t.down(pointer(0, 0), h);
      expect(calls).toEqual([]);
      expect(t.busy()).toBe(false);
    }
  });

  it("shows its own tip's ring, kept while a stroke is dragged out", () => {
    const { h } = fake({ tool: "history" });
    const t = createPaintTools().history;
    const { o, rings } = painter();
    t.down(pointer(10, 12), h);
    t.drawCursor!(o, h);
    expect(rings).toEqual([[10 + 5 * 2, 20 + 6 * 2, 30, 50]]);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(true);
    t.up!(pointer(10, 12), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
  });
});

describe("the clone stamp", () => {
  const alt = { altKey: true };
  const tipOf = (c: typeof DEFAULT_CLONE) => ({
    size: c.size,
    hardness: c.hardness,
    opacity: c.opacity,
    flow: c.flow,
    blend: "Normal",
    smoothing: c.smoothing,
  });

  it("does nothing until a source is set", () => {
    const { h, calls } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    t.down(pointer(100, 60), h);
    expect(calls).toEqual([]);
    expect(t.busy()).toBe(false);
  });

  it("Alt-click sets the source; a stroke then samples from it", () => {
    const { h, calls } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), h); // source at (10, 10)
    expect(t.busy(), "a mouse sets it where it clicks: no drag").toBe(false);
    t.down(pointer(100, 60), h);
    expect(t.busy()).toBe(true);
    t.move!(pointer(110, 60), h);
    t.up!(pointer(110, 60), h);
    const c = DEFAULT_CLONE;
    expect(calls).toEqual([
      ["beginClone", "L1", tipOf(c), 50, 30, { x: -40, y: -20 }, c.sampleAll, c.spacing, null, 0, null],
      ["moveStroke", 55, 30, 1],
      ["endStroke"],
    ]);
  });

  it("aligned keeps the offset for the next stroke; not aligned starts each at the source", () => {
    for (const aligned of [true, false]) {
      const { h, calls } = fake({ tool: "clone" });
      h.settings = { ...h.settings, clone: { ...DEFAULT_CLONE, aligned } };
      const t = createPaintTools().clone;
      t.down(pointer(20, 20, alt), h);
      t.down(pointer(100, 60), h);
      t.up!(pointer(100, 60), h);
      t.down(pointer(200, 100), h);
      expect(calls.at(-1)![5]).toEqual(aligned ? { x: -40, y: -20 } : { x: -90, y: -40 });
    }
  });

  it("a new source starts the next stroke at it, even aligned", () => {
    const { h, calls } = fake({ tool: "clone" });
    h.settings = { ...h.settings, clone: { ...DEFAULT_CLONE, aligned: true } };
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), h);
    t.down(pointer(100, 60), h);
    t.up!(pointer(100, 60), h);
    t.down(pointer(60, 20, alt), h); // a new source at (30, 10)
    t.down(pointer(200, 100), h);
    expect(calls.at(-1)![5]).toEqual({ x: -70, y: -40 });
  });

  it("merges a floating selection before cloning onto the layer under it — not to set a source", () => {
    const { h, calls } = fake({ tool: "clone" }, true);
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), h);
    expect(calls).toEqual([]);
    t.down(pointer(100, 60), h);
    expect(names(calls)).toEqual(["commitFloat", "beginClone"]);
  });

  it("paints a new layer when none is selected, and leaves a locked one alone", () => {
    const fresh = fake({ tool: "clone", activeLayerId: null, ensureLayer: () => "NEW" });
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), fresh.h);
    t.down(pointer(100, 60), fresh.h);
    expect(fresh.calls[0].slice(0, 2)).toEqual(["beginClone", "NEW"]);
    const locked = fake({ tool: "clone", paintBlocked: () => true });
    const u = createPaintTools().clone;
    u.down(pointer(20, 20, alt), locked.h);
    u.down(pointer(100, 60), locked.h);
    expect(locked.calls).toEqual([]);
    expect(u.busy()).toBe(false);
  });

  it("on touch, the source is dragged into place — the loupe on it, not on the finger", () => {
    const { h, calls, loupes, captured } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    const touch = { ...alt, pointerType: "touch" };
    t.down(pointer(20, 20, touch), h);
    expect(t.busy(), "a new source, refined by the same drag").toBe(true);
    expect(captured).toEqual([7]);
    expect(loupes).toEqual([{ x: 10, y: 10 }]);
    expect(t.hover!({ x: 30, y: 12 }, pointer(60, 24, touch), h), "the drag is the source's").toBe(true);
    expect(loupes.at(-1)).toEqual({ x: 30, y: 12 });
    expect(t.drop!(h), "the lift ends the grab").toBe(true);
    expect(t.drop!(h)).toBe(false);
    expect(t.busy()).toBe(false);
    expect(t.hover!({ x: 50, y: 50 }, pointer(100, 100), h), "after it, a move is a hover").toBeFalsy();
    // Picked up again near where it was left: by the offset the grab starts with.
    t.down(pointer(64, 28, touch), h); // (32, 14): 2 px from the source at (30, 12)
    t.hover!({ x: 40, y: 20 }, pointer(80, 40, touch), h);
    t.drop!(h);
    t.down(pointer(100, 60), h);
    expect(calls.at(-1)![5], "the source kept its distance from the finger").toEqual({ x: -12, y: -12 });
  });

  it("a pinch ends the grab where it is", () => {
    const { h } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, { ...alt, pointerType: "touch" }), h);
    t.cancel!(h);
    expect(t.busy()).toBe(false);
    expect(t.drop!(h)).toBe(false);
  });

  it("forgets the source when another document becomes the active one", () => {
    const { h, calls } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), h);
    t.switchDoc!();
    t.down(pointer(100, 60), h);
    expect(calls).toEqual([]);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "nor is its marker drawn").toBe(false);
  });

  it("marks the source: a reticle while Alt is held, the ring otherwise", () => {
    const { h } = fake({ tool: "clone" });
    const t = createPaintTools().clone;
    t.down(pointer(20, 20, alt), h);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h), "the pointer gone, the source still shows").toBe(true);
    const off = painter();
    t.drawCursor!(off.o, h);
    expect(off.crosses, "no pointer: the source marker alone").toEqual([[10 + 10 * 2, 20 + 10 * 2, 5]]);
    expect(off.rings).toEqual([]);
    const held = painter();
    t.hover!({ x: 40, y: 40 }, pointer(80, 80, alt), h);
    t.drawCursor!(held.o, h);
    expect(held.crosses.at(-1)).toEqual([10 + 40 * 2, 20 + 40 * 2, 7]);
    expect(held.rings).toEqual([]);
    const plain = painter();
    t.hover!({ x: 40, y: 40 }, pointer(80, 80), h);
    t.drawCursor!(plain.o, h);
    expect(plain.rings).toEqual([[90, 100, DEFAULT_CLONE.size, DEFAULT_CLONE.hardness]]);
  });

  it("shows where it samples from as it paints, joined to the brush — aligned or not", () => {
    for (const aligned of [true, false]) {
      const { h } = fake({ tool: "clone" });
      h.settings = { ...h.settings, clone: { ...DEFAULT_CLONE, aligned } };
      const t = createPaintTools().clone;
      t.down(pointer(20, 20, alt), h);
      t.down(pointer(100, 60), h);
      t.hover!({ x: 60, y: 30 }, pointer(120, 60), h);
      const { o, crosses, ops } = painter();
      t.drawCursor!(o, h);
      expect(crosses[0], "the source rides with the brush").toEqual([10 + 20 * 2, 20 + 10 * 2, 5]);
      expect(ops).toContain("lineTo");
      t.leave!(h);
      const after = painter();
      t.drawCursor!(after.o, h);
      expect(after.rings.length, "dragged out mid-stroke: the ring stays").toBe(1);
    }
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
    expect(t.wantsOverlay!(true, h), "the ring stays; the veil goes").toBe(true);
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
    t.drawCursor!(o, h);
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
    expect(t.wantsOverlay!(true, h)).toBe(true);
    t.leave!(h);
    expect(t.wantsOverlay!(true, h)).toBe(false);
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
  it("says each tool's cursor — the table CanvasArea used to keep — and which take the right button", () => {
    const set = createToolControllers();
    const ring = ["blur", "smudge", "mixer", "history", "clone", "dodge", "sponge", "heal", "redeye"];
    const want: Record<string, string | undefined> = {
      zoom: "zoom-in",
      move: "move",
      text: "text",
      measure: undefined,
      directselect: undefined,
      ...Object.fromEntries([...ring, "quickselect", "brush", "pencil", "eraser"].map((t) => [t, "none"])),
      ...Object.fromEntries(
        ["select", "lasso", "wand", "shape", "bucket", "gradient", "pen", "crop"].map((t) => [t, "crosshair"]),
      ),
    };
    for (const [tool, cursor] of Object.entries(want)) {
      expect(set.byTool[tool as keyof typeof set.byTool]?.cursor, tool).toBe(cursor);
    }
    expect(set.byTool.eyedropper?.cursor).toMatch(/^url\("data:image\/svg\+xml,.* 4 30, crosshair$/);
    expect(set.byTool.frame?.cursor).toMatch(/^url\("data:image\/svg\+xml,.* 11 11, crosshair$/);
    const right = Object.entries(set.byTool)
      .filter(([, c]) => c?.rightButton)
      .map(([t]) => t)
      .sort();
    expect(right).toEqual(["brush", "bucket", "eraser", "pencil", "zoom"]);
  });

  it("gives each canvas its own controllers, so two canvases never share a stroke", () => {
    const a = createToolControllers();
    const b = createToolControllers();
    expect(a.byTool.blur).not.toBe(b.byTool.blur);
    const { h } = fake();
    a.byTool.blur!.down(pointer(0, 0), h);
    expect([a.byTool.blur!.busy(), b.byTool.blur!.busy()]).toEqual([true, false]);
  });

  it("shares one controller between Smudge and the Mixer brush — one session", () => {
    const set = createToolControllers();
    expect(set.byTool.smudge).toBe(set.byTool.mixer);
  });

  it("one controller for the Brush, Pencil and Eraser; one engine stroke for them and the clone", () => {
    const set = createToolControllers();
    expect(set.byTool.pencil).toBe(set.byTool.brush);
    expect(set.byTool.eraser).toBe(set.byTool.brush);
    const { h, calls } = fake({ tool: "clone" });
    set.byTool.clone!.down(pointer(0, 0, { altKey: true }), h);
    set.byTool.clone!.down(pointer(10, 10), h);
    expect(set.byTool.brush!.busy(), "the clone's stroke is the engine's one stroke").toBe(true);
    set.byTool.brush!.up!(pointer(10, 10), h);
    expect(names(calls)).toEqual(["beginClone", "endStroke"]);
    expect(set.byTool.clone!.busy()).toBe(false);
  });

  it("records a brush stroke once — a clone stroke after it is not recorded as it again", () => {
    const set = createToolControllers();
    const { h, recorded } = fake({ tool: "brush" });
    h.strokes = { recording: true, record: (st) => recorded.push(st) };
    set.byTool.brush!.down(pointer(0, 0), h);
    set.byTool.brush!.up!(pointer(0, 0), h);
    set.byTool.clone!.down(pointer(0, 0, { altKey: true }), h);
    set.byTool.clone!.down(pointer(10, 10), h);
    set.byTool.clone!.up!(pointer(10, 10), h);
    expect(recorded.length).toBe(1);
  });
});
