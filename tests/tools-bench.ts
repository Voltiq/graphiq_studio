// The tool controllers' test bench: a fake host whose engine records what it is
// asked to do (and answers the few questions a tool asks it), a pointer event,
// and an overlay painter that records what is drawn.

import type { OverlayPainter, ToolHost, ToolPointer } from "../app/tools";
import type { BrushSettings, PaintEngine, WandSelection } from "../app/lib/paint";
import type { StrokeStep } from "../app/lib/actions";
import type { ColorSampler } from "../app/lib/samplers";
import type { LayerNode } from "../app/lib/layers";
import type { Rect } from "../app/lib/view";
import {
  DEFAULT_BLUR,
  DEFAULT_CLONE,
  DEFAULT_DODGE,
  DEFAULT_HEAL,
  DEFAULT_QUICKSELECT,
  DEFAULT_REDEYE,
  DEFAULT_SMUDGE,
  DEFAULT_SPONGE,
} from "../app/lib/tools";
import { DEFAULT_MIXER } from "../app/lib/mixer";
import { STAR_DEFAULT } from "../app/lib/shapes";

export type Call = [string, ...unknown[]];

export const BRUSH: BrushSettings = { size: 20, hardness: 80, opacity: 100, flow: 100, blend: "Normal", smoothing: 0 };

/** What the fake engine answers when asked (and does not record as a call). */
export interface Answers {
  quickMaskActive?: boolean;
  /** What the active layer's brush lands on. */
  surface?: "pixels" | "mask" | "filterMask";
  /** The region a magic-wand flood finds (null: no source — the whole canvas). */
  wand?: { rects: Rect[]; segments?: WandSelection["segments"] } | null;
  /** The colour sampled under the pointer. */
  color?: string | null;
  /** What the engine makes of a combine, a lasso and a quick-select dab. */
  combined?: WandSelection | null;
  lassoed?: WandSelection | null;
  dab?: WandSelection | null;
  /** A float is up, on this layer, offset this far; and whether a selection lifts. */
  floatLayerId?: string;
  floatOffset?: { x: number; y: number };
  lifts?: boolean;
  /** Where a moved selection lands. */
  shifted?: Rect[];
}

/** What a test changes of the host: anything, and the selection in part. */
export type HostOver = Partial<Omit<ToolHost, "selection">> & { selection?: Partial<ToolHost["selection"]> };

export function fake(over: HostOver = {}, floating = false, answers: Answers = {}) {
  const calls: Call[] = [];
  const engine = new Proxy(
    {
      isFloating: floating,
      floatLayerId: answers.floatLayerId ?? null,
      getFloatOffset: () => answers.floatOffset ?? { x: 0, y: 0 },
      beginFloatFromSelection: (...args: unknown[]) => {
        calls.push(["beginFloatFromSelection", ...args]);
        return answers.lifts ?? true;
      },
      shiftSelection: (...args: unknown[]) => {
        calls.push(["shiftSelection", ...args]);
        return answers.shifted ?? [];
      },
      quickMaskActive: () => answers.quickMaskActive ?? false,
      getActiveSurface: () => answers.surface ?? "pixels",
      magicWand: (...args: unknown[]) => {
        calls.push(["magicWand", ...args]);
        return answers.wand ?? null;
      },
      sampleColor: (...args: unknown[]) => {
        calls.push(["sampleColor", ...args]);
        return answers.color === undefined ? "#123456" : answers.color;
      },
      combineSelection: (...args: unknown[]) => {
        calls.push(["combineSelection", ...args]);
        return answers.combined ?? null;
      },
      lassoSelect: (...args: unknown[]) => {
        calls.push(["lassoSelect", ...args]);
        return answers.lassoed ?? null;
      },
      quickSelectDab: (...args: unknown[]) => {
        calls.push(["quickSelectDab", ...args]);
        return answers.dab ?? null;
      },
    },
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
  const loupes: { x: number; y: number }[] = [];
  const recorded: StrokeStep[] = [];
  /** What the controller told the editor (not the engine), in order. */
  const told: Call[] = [];
  const samplerList: ColorSampler[] = [{ id: "S1", x: 100, y: 100 }];
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
  const { selection: selOver, ...rest } = over;
  const h: ToolHost = {
    engine,
    tool: "blur",
    latest: () => h,
    doc: { width: 1000, height: 800 },
    toDoc: (e) => ({ x: e.clientX / 2, y: e.clientY / 2 }),
    capture: (e) => captured.push(e.pointerId),
    release: (e) => told.push(["release", e.pointerId]),
    setCursor: (c) => told.push(["cursor", c]),
    cursorAt: (pt) => told.push(["cursorAt", pt]),
    redraw: () => {
      redraws++;
    },
    activeLayerId: "L1",
    layers,
    paintBlocked: () => false,
    ensureLayer: () => "L1",
    grab: (px) => px / 2,
    loupe: (e, at) => loupes.push(at ?? { x: e.clientX, y: e.clientY }),
    pressure: (e) => (e.pointerType === "mouse" ? 1 : e.pressure),
    zoom: 100,
    committable: () => told.push(["committable"]),
    selection: {
      rects: null,
      all: [],
      angle: 0,
      pivot: null,
      set: (rects, segments) => told.push(["select", rects, segments ?? null]),
      combine: (result) => told.push(["combine", result]),
      place: (rects, angle, pivot) => told.push(["place", rects, angle, pivot]),
      seedWand: (seed) => told.push(["seedWand", seed]),
      triangle: (t) => told.push(["triangle", t]),
      ...selOver,
      ...(selOver?.rects && !selOver.all ? { all: selOver.rects } : {}),
    },
    transform: {
      start: () => false,
      hoverCursor: () => told.push(["transformCursor"]),
      startLayer: () => false,
      layerHoverCursor: () => told.push(["layerCursor"]),
    },
    snap: {
      begin: (x, y) => ({ x, y }),
      point: (x, y) => ({ x, y }),
      beginMove: () => told.push(["snapMove"]),
      move: (dx, dy) => ({ dx, dy }),
      end: () => told.push(["snapEnd"]),
    },
    layerAt: () => null,
    pickLayer: (id) => told.push(["pickLayer", id]),
    moveBlocked: () => false,
    linkedExtras: () => [],
    path: {
      current: { current: null },
      picked: { current: new Set<number>() },
      render: () => told.push(["renderPath"]),
      finish: () => told.push(["finishPath"]),
    },
    shape: {
      live: { current: null },
      opts: { kind: "rect", strokeWidth: 0, radius: 0, fill: "#f00", stroke: "#000" },
      trap: { current: { l: 0.25, r: 0.25 } },
      apex: { current: 0.5 },
      star: { current: { ...STAR_DEFAULT } },
      nodeAt: () => null,
      fresh: () => told.push(["freshShape"]),
      schedule: () => told.push(["scheduleShape"]),
      geom: () => undefined,
      setRadius: (r) => told.push(["radius", r]),
      place: (id, box) => told.push(["placeShape", id, box]),
    },
    crop: {
      box: null,
      quad: null,
      straighten: 0,
      aspect: null,
      grid: "thirds",
      shield: 65,
      setBox: (box) => told.push(["cropBox", box]),
      setQuad: (quad) => told.push(["cropQuad", quad]),
      apply: () => told.push(["cropApply"]),
    },
    foreground: "#ff8000",
    background: "#0000ff",
    settings: {
      brush: BRUSH,
      history: { ...BRUSH, size: 30, hardness: 50 },
      clone: DEFAULT_CLONE,
      blur: DEFAULT_BLUR,
      smudge: DEFAULT_SMUDGE,
      mixer: DEFAULT_MIXER,
      dodge: DEFAULT_DODGE,
      sponge: DEFAULT_SPONGE,
      heal: DEFAULT_HEAL,
      redEye: DEFAULT_REDEYE,
      bucket: { tolerance: 32, opacity: 100, contiguous: true, antialias: true },
      gradient: { type: "linear", reverse: false, smooth: false, snap: true, stops: null, fg: "#000", bg: "#fff" },
      sample: { size: 1, all: false },
      marquee: { shape: "rect", apex: 0.5 },
      lasso: "free",
      wand: { tolerance: 32, contiguous: true, sampleAll: false },
      quickSelect: DEFAULT_QUICKSELECT,
      snapPixels: false,
      move: { mode: "pixels", autoSelect: false },
      snapDistance: 8,
    },
    zoomToPoint: (dir, x, y) => zooms.push([dir, x, y]),
    strokes: { recording: false, record: (step) => recorded.push(step) },
    pick: (hex) => told.push(["pick", hex]),
    samplers: {
      list: () => samplerList,
      hit: (x, y, tol) => samplerList.find((q) => Math.hypot(q.x - x, q.y - y) <= tol) ?? null,
      add: (x, y) => told.push(["addSampler", x, y]),
      remove: (id) => told.push(["removeSampler", id]),
      moveLive: (id, x, y) => told.push(["moveSampler", id, x, y]),
      commitMove: (before) => told.push(["commitSamplers", before]),
    },
    // The editor's line, as the next render would hand it back.
    measure: {
      line: null,
      set: (line) => {
        told.push(["measure", line]);
        h.measure = { ...h.measure, line };
      },
    },
    frame: { shape: "rect", drawn: (r, shape) => told.push(["frame", r, shape]) },
    text: {
      editing: false,
      commit: () => told.push(["commitText"]),
      layerAt: () => null,
      reedit: (id) => told.push(["reedit", id]),
      open: (start) => told.push(["openText", start]),
    },
    ...rest,
  };
  return { h, calls, captured, zooms, loupes, recorded, told, redraws: () => redraws };
}

/** preventDefault calls, across every pointer made here. */
export const prevented = { n: 0 };
export const pointer = (x: number, y: number, over: Partial<ToolPointer> = {}): ToolPointer => ({
  clientX: x,
  clientY: y,
  pointerId: 7,
  pointerType: "mouse",
  pressure: 0.5,
  button: 0,
  buttons: 1,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  preventDefault: () => {
    prevented.n++;
  },
  ...over,
});

export const names = (calls: Call[]) => calls.map((c) => c[0]);

/** A painter that records the rings drawn (and what else touches the canvas). */
export function painter() {
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
  const crosses: number[][] = [];
  const o: OverlayPainter = {
    ctx,
    p: { x: 10, y: 20 },
    s: 2,
    width: 800,
    height: 600,
    selected: true,
    ants: 0,
    ring: (...a) => rings.push(a),
    cross: (...a) => crosses.push(a),
    light: (a) => `light ${a}`,
  };
  return { o, rings, crosses, ops };
}
