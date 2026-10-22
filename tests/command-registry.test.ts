/**
 * The command registry (TODO 1.1): what each command does, when it applies, and
 * whether an action may record it. Availability is the answer the menus, the
 * palette, the header and every runner share, so it is tested here once, as a
 * pure function of a document — nothing rendered.
 */
import { describe, expect, it } from "vitest";
import { COMMAND_IDS, type CommandId } from "../app/lib/menus";
import type { LayerNode } from "../app/lib/layers";
import { WORK_PATH_ID } from "../app/lib/paths";
import { MIN_ANCHORS } from "../app/lib/vector-mask";
import { commandState, type CommandInputs } from "../app/commands/state";
import type { CommandOps } from "../app/commands/ops";
import {
  availability,
  commandFor,
  executeCommand,
  isRecordable,
  unavailableCommands,
} from "../app/commands/registry";

const base = { name: "L", visible: true, opacity: 100, blend: "Normal" };
const pixel = (id: string, extra: object = {}): LayerNode => ({ ...base, id, type: "layer", ...extra }) as LayerNode;
const adjustment = (id: string): LayerNode =>
  ({ ...base, id, type: "adjustment", adjustment: { type: "sliders" } }) as unknown as LayerNode;
const group = (id: string, children: LayerNode[]): LayerNode =>
  ({ ...base, id, type: "group", expanded: true, children }) as LayerNode;
const text = (id: string, onPath = false): LayerNode =>
  pixel(id, { vector: { type: "text", ...(onPath ? { onPath: { pathId: "p" } } : {}) } });
const rect = { x: 0, y: 0, w: 10, h: 10 };
const anchors = (n: number) => Array.from({ length: n }, () => ({}));

/** What a case changes from a fresh document. */
type Over = Omit<Partial<CommandInputs>, "doc"> & { doc?: Partial<CommandInputs["doc"]> };

/** A fresh one-layer document: nothing selected, no history. */
function inputs(over: Over = {}): CommandInputs {
  const { doc, ...rest } = over;
  return {
    docCount: 1,
    historyBack: false,
    historyForward: false,
    floating: false,
    openEdit: false,
    lastSelection: false,
    isolated: false,
    comparing: false,
    ...rest,
    doc: { layers: [pixel("a")], activeLayerId: "a", selectedLayerIds: [], selection: [], ...doc },
  };
}
const state = (over: Over = {}) => commandState(inputs(over));
/** The reason `id` does not apply, "quiet:" + it when quiet, or "ok". */
const why = (id: CommandId, over: Over = {}) => {
  const a = availability(id, state(over));
  return a === true ? "ok" : a.quiet ? `quiet:${a.why}` : a.why;
};
const ok = (id: CommandId, over: Over = {}) => why(id, over) === "ok";

/** A CommandOps that writes down every call instead of doing it. */
function spyOps() {
  const calls: string[] = [];
  const ops = new Proxy({} as CommandOps, {
    get: (_t, name: string) =>
      (...args: unknown[]) =>
        calls.push(args.length ? `${name}(${args.map((a) => JSON.stringify(a)).join(",")})` : name),
  });
  return { ops, calls };
}

describe("what each command does", () => {
  it("every command does exactly one thing", () => {
    const wrong: string[] = [];
    for (const id of COMMAND_IDS) {
      const { ops, calls } = spyOps();
      commandFor(id).run(ops);
      if (calls.length !== 1) wrong.push(`${id}: ${calls.join(", ") || "nothing"}`);
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ["image-trim", 'open("trim")'],
    ["help-tour", 'open("tour")'],
    ["help-docs", 'open("help-docs")'],
    ["batch-process", 'open("batch")'],
    ["doc-rename", 'open("rename")'],
    ["view-more-space", 'open("more-space")'],
    ["canvas-size", 'sizeDialog("canvas")'],
    ["image-size", 'sizeDialog("image")'],
    ["free-transform", "freeTransform(true)"],
    ["transform", "freeTransform(false)"],
    ["mask-add", 'addMask("reveal")'],
    ["mask-add-hide", 'addMask("hide")'],
    ["mask-from-sel", 'addMask("selection")'],
    ["text-on-path", "textOnPath(true)"],
    ["text-off-path", "textOnPath(false)"],
    ["select-feather", 'modifySelection("feather")'],
    ["select-load", 'selectionChannel("load")'],
    ["view-lock-guides", 'toggleView("lockguides")'],
    ["view-smart-guides", 'toggleView("smartguides")'],
    ["view-100", 'zoom("100")'],
    ["tone-dest-curves", 'destructiveTone("curves")'],
    ["adj-tone-levels", 'addToneAdjustment("levels")'],
    ["prefs-storage", 'openPrefs("storage")'],
    ["window-reset", "resetWorkspace"],
    ["window-layers", 'togglePanel("layers")'],
    ["adj-x-invert", 'addExtraAdjustment("invert")'],
    ["adj-exposure", 'addAdjustment("exposure")'],
    ["fx-add-stroke", 'addEffect("stroke")'],
    ["filter-add-blur", 'addFilter("blur")'],
  ] as [CommandId, string][])("%s → %s", (id, call) => {
    const { ops, calls } = spyOps();
    commandFor(id).run(ops);
    expect(calls).toEqual([call]);
  });
});

describe("when each command applies", () => {
  it("leaves the always-available alone", () => {
    for (const id of ["new-doc", "layer-new", "select-all", "edit-paste", "export-as", "view-fit"] as CommandId[])
      expect(why(id), id).toBe("ok");
  });

  it("undo and redo follow the history — and a floating paste or a live fill can always be undone", () => {
    expect(why("undo")).toBe("quiet:Nothing to undo.");
    expect(ok("undo", { historyBack: true })).toBe(true);
    expect(ok("undo", { floating: true })).toBe(true);
    expect(ok("undo", { openEdit: true }), "a live fill or path, not yet a step").toBe(true);
    expect(ok("redo", { openEdit: true }), "...is nothing to redo").toBe(false);
    expect(why("redo")).toBe("quiet:Nothing to redo.");
    expect(ok("redo", { historyForward: true })).toBe(true);
  });

  it("selection commands need a selection", () => {
    const sel = { doc: { selection: [rect] } };
    for (const id of ["select-deselect", "select-inverse", "select-border", "select-grow", "edit-cut"] as CommandId[]) {
      expect(why(id), id).toBe("quiet:Nothing is selected.");
      expect(ok(id, sel), id).toBe(true);
    }
    expect(why("image-crop")).toBe("Crop trims the canvas to the selection — make a selection first.");
    expect(ok("image-crop", sel)).toBe(true);
    expect(why("select-refine")).toBe("Refine edge needs an active selection — make one first.");
    expect(ok("select-refine", sel)).toBe(true);
  });

  it("cut and content-aware fill also need a layer to take from", () => {
    const sel = [rect];
    expect(why("edit-cut", { doc: { selection: sel, activeLayerId: null } })).toBe("quiet:No layer is selected.");
    expect(ok("edit-caf", { doc: { selection: sel } })).toBe(true);
    expect(why("edit-caf", { doc: { selection: sel, layers: [adjustment("a")] } })).toMatch(/^quiet:/);
  });

  it("reselect only brings back a selection when there is none now", () => {
    expect(why("select-reselect")).toBe("quiet:There is no earlier selection to bring back.");
    expect(ok("select-reselect", { lastSelection: true })).toBe(true);
    expect(why("select-reselect", { lastSelection: true, doc: { selection: [rect] } })).toBe(
      "quiet:Something is already selected.",
    );
  });

  it("layer commands need a layer to act on — the multi-selection counts", () => {
    const none = { doc: { activeLayerId: null } };
    for (const id of ["layer-duplicate", "layer-delete", "layer-group", "layer-merge-down"] as CommandId[]) {
      expect(why(id, none), id).toBe("quiet:No layer is selected.");
      expect(ok(id), `${id}: the active layer alone`).toBe(true);
      expect(ok(id, { doc: { activeLayerId: null, selectedLayerIds: ["a"] } }), id).toBe(true);
    }
    expect(why("free-transform", none)).toMatch(/^quiet:/);
    expect(why("transform", { doc: { layers: [], activeLayerId: "a" } })).toMatch(/^quiet:/);
    expect(why("layer-flatten", { doc: { layers: [], activeLayerId: null } })).toMatch(/^quiet:/);
  });

  it("ungroup needs a group, a frame needs pixels", () => {
    const grouped = { doc: { layers: [group("g", [pixel("a")])], activeLayerId: "g" } };
    expect(why("layer-ungroup")).toMatch(/^quiet:/);
    expect(ok("layer-ungroup", grouped)).toBe(true);
    expect(ok("frame-from-layer")).toBe(true);
    expect(why("frame-from-layer", grouped)).toMatch(/^quiet:/);
  });

  it("isolate needs something to isolate, but can always be left", () => {
    expect(why("layer-isolate", { doc: { activeLayerId: null } })).toBe("Select a layer to isolate.");
    expect(ok("layer-isolate", { doc: { activeLayerId: null }, isolated: true })).toBe(true);
  });

  it("merge and stamp visible say what is missing", () => {
    const hidden = { doc: { layers: [{ ...pixel("a"), visible: false }] } };
    expect(why("layer-merge-visible", hidden)).toBe("Nothing visible to merge.");
    expect(why("layer-stamp-visible", hidden)).toBe("Nothing visible to stamp.");
    expect(why("layer-merge-visible")).toBe("Only one visible layer — nothing to merge into.");
    expect(ok("layer-merge-visible", { doc: { layers: [pixel("a"), pixel("b")] } })).toBe(true);
    expect(ok("layer-stamp-visible")).toBe(true);
  });

  it("masks: one per layer, and the mask commands need one", () => {
    const masked = (enabled: boolean) => ({ doc: { layers: [pixel("a", { mask: { enabled, linked: true } })] } });
    expect(ok("mask-add")).toBe(true);
    expect(why("mask-add", masked(true))).toBe("quiet:This layer already has a mask.");
    expect(why("mask-delete")).toBe("quiet:This layer has no mask.");
    expect(why("mask-to-sel")).toBe("quiet:This layer has no mask.");
    expect(ok("mask-delete", masked(true))).toBe(true);
    expect(why("mask-apply", masked(false))).toBe("Enable the mask before applying.");
    expect(ok("mask-apply", masked(true))).toBe(true);
    expect(why("mask-from-sel")).toBe("Make a selection first to create a mask from it.");
    expect(ok("mask-from-sel", { doc: { selection: [rect] } })).toBe(true);
    // An existing mask is the first answer, as it was in the handler.
    expect(why("mask-from-sel", masked(true))).toBe("quiet:This layer already has a mask.");
  });

  it("vector masks and text on a path need the Work Path", () => {
    const pathMsg = `Draw a path with the Pen tool first (at least ${MIN_ANCHORS} points).`;
    const path = (n: number) => [{ id: WORK_PATH_ID, anchors: anchors(n) }];
    expect(why("vmask-add")).toBe(pathMsg);
    expect(why("vmask-add", { doc: { paths: path(MIN_ANCHORS - 1) } })).toBe(pathMsg);
    expect(ok("vmask-add", { doc: { paths: path(MIN_ANCHORS) } })).toBe(true);
    expect(why("vmask-add", { doc: { activeLayerId: null } })).toBe("Select a layer to mask.");
    expect(why("vmask-invert")).toBe("This layer has no vector mask.");
    expect(ok("vmask-delete", { doc: { layers: [pixel("a", { vectorMask: {} })] } })).toBe(true);

    expect(why("text-on-path")).toBe("Select a text layer first.");
    expect(why("text-on-path", { doc: { layers: [text("a")] } })).toBe(pathMsg);
    expect(ok("text-on-path", { doc: { layers: [text("a")], paths: path(MIN_ANCHORS) } })).toBe(true);
    expect(why("text-off-path", { doc: { layers: [text("a")] } })).toBe("This text is not on a path.");
    expect(ok("text-off-path", { doc: { layers: [text("a", true)] } })).toBe(true);
  });

  it("effects and smart filters style pixels, which an adjustment layer has none of", () => {
    const adj = { doc: { layers: [adjustment("a")] } };
    for (const id of ["fx-add-stroke", "filter-add-blur"] as CommandId[]) {
      expect(ok(id), id).toBe(true);
      expect(why(id, adj), id).toMatch(/^quiet:/);
      expect(why(id, { doc: { activeLayerId: null } }), id).toBe("quiet:No layer is selected.");
    }
    expect(why("tone-dest-levels", adj)).toBe("Select a pixel layer first.");
    expect(why("fx-clear")).toMatch(/^quiet:/);
    expect(ok("fx-clear", { doc: { layers: [pixel("a", { effects: { stroke: {} } })] } })).toBe(true);
  });

  it("document-level commands say what is missing", () => {
    expect(why("doc-close")).toBe("This is the only open document, so it stays open.");
    expect(ok("doc-close", { docCount: 2 })).toBe(true);
    expect(why("hdr-tone")).toMatch(/^No HDR source — this works on documents created via File ▸ Merge to HDR/);
    expect(why("export-hdr")).toBe("No HDR source — export true HDR from a document created via File ▸ Merge to HDR.");
    expect(ok("export-hdr", { doc: { hdr: {} } })).toBe(true);
    expect(why("view-clear-guides")).toBe("This document has no guides.");
    expect(ok("view-clear-guides", { doc: { guides: [{}] } })).toBe(true);
    expect(why("view-compare")).toBe("Nothing to compare — add an adjustment layer or a smart filter first.");
    expect(ok("view-compare", { doc: { layers: [pixel("a"), adjustment("b")] } })).toBe(true);
    // An open split can always be closed, whatever the layers became.
    expect(ok("view-compare", { comparing: true })).toBe(true);
  });

  it("greys exactly what availability rules out, with the same reasons", () => {
    const s = state();
    const blocked = unavailableCommands(s);
    for (const id of COMMAND_IDS) {
      const a = availability(id, s);
      expect(blocked[id], id).toBe(a === true ? undefined : a.why);
    }
    // A fresh document really does grey things, and really leaves most alone.
    expect(Object.keys(blocked).length).toBeGreaterThan(20);
    expect(Object.keys(blocked).length).toBeLessThan(COMMAND_IDS.length / 2);
  });
});

describe("running a command", () => {
  it("runs one that applies, and says nothing", () => {
    const { ops, calls } = spyOps();
    expect(executeCommand("layer-new", state(), ops)).toBe(true);
    expect(calls).toEqual(["newLayer"]);
  });

  it("does not run one that does not apply, and says why", () => {
    const { ops, calls } = spyOps();
    expect(executeCommand("image-crop", state(), ops)).toBe(false);
    expect(calls).toEqual([`toast("Crop trims the canvas to the selection — make a selection first.")`]);
  });

  it("stays silent when the reason is quiet", () => {
    const { ops, calls } = spyOps();
    expect(executeCommand("select-deselect", state(), ops)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("recording", () => {
  /* The commands an action could record before the registry, kept here as the
     contract: each completes with no further input, so it replays unattended. */
  const RECORDABLE = [
    "undo", "redo", "edit-cut", "edit-copy", "edit-paste", "edit-caf", "save", "print",
    "image-crop", "image-rotate-cw", "image-rotate-ccw", "image-flip-h", "image-flip-v",
    "layer-new", "layer-duplicate", "layer-delete", "layer-group", "layer-ungroup",
    "layer-merge-down", "frame-from-layer", "layer-merge-visible", "layer-stamp-visible",
    "layer-flatten", "layer-clip", "mask-add", "mask-add-hide", "mask-from-sel",
    "mask-delete", "mask-apply", "mask-to-sel", "select-all", "select-deselect",
    "select-reselect", "select-inverse", "adj-brightness-contrast", "adj-exposure",
    "adj-vibrance", "adj-color-balance", "adj-black-white", "adj-photo-filter-warm",
    "adj-photo-filter-cool", "adj-x-invert", "adj-x-equalize", "fx-clear",
  ];

  it("records exactly the commands that replay unattended", () => {
    const recordable = COMMAND_IDS.filter((id) => isRecordable(id));
    const expected = [...RECORDABLE, ...COMMAND_IDS.filter((id) => id.startsWith("fx-add-"))];
    expect([...recordable].sort()).toEqual([...new Set(expected)].sort());
  });

  it("records nothing that opens a dialog, and nothing that is not a command", () => {
    for (const id of ["export-as", "image-size", "adj-x-huesat", "filter-add-blur", "adj-tone-curves", "free-transform"])
      expect(isRecordable(id), id).toBe(false);
    for (const id of ["bogus", "", "toString"]) expect(isRecordable(id), id).toBe(false);
  });
});
