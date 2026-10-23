import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../app/state/store";
import {
  DEFAULT_COLORS,
  DEFAULT_TOOL_OPTIONS,
  brushOf,
  createColors,
  createToolOptions,
  persistToolOptions,
  restoreToolOptions,
  slotColor,
} from "../app/state/toolOptions";
import type { ToolPrefs } from "../app/lib/toolPrefs";
import { ALL_PANELS, createView, restoreView, setPanels, setViewFlags } from "../app/state/view";
import { createDialogs, openDialog, openPrefs, openSize } from "../app/state/dialogs";
import { activeDoc, createDocuments, makeDoc } from "../app/state/documents";

/**
 * The editor's stores (TODO 1.5, app/state): the store itself, and the options
 * bar's state — restored from the last session, saved back as it changes.
 */

describe("a store", () => {
  it("merges a patch, and keeps the rest", () => {
    const s = createStore({ a: 1, b: { x: 1 }, c: "c" });
    const b = s.get().b;
    s.set({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: { x: 1 }, c: "c" });
    expect(s.get().b, "an untouched field is the same object").toBe(b);
    s.set((st) => ({ a: st.a + 10 }));
    expect(s.get().a).toBe(12);
  });

  it("tells its listeners only when something changed — as useState decides, by Object.is", () => {
    const s = createStore({ a: 1, n: NaN, o: { k: 1 } });
    const heard = vi.fn();
    s.subscribe(heard);
    const before = s.get();
    s.set({ a: 1 });
    s.set({ n: NaN });
    s.set({ o: before.o });
    expect(heard).not.toHaveBeenCalled();
    expect(s.get(), "an unchanged set keeps the same state object").toBe(before);
    s.set({ a: 1, o: { k: 1 } });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(s.get()).not.toBe(before);
    s.set({ a: -0 });
    expect(heard, "+0 and -0 differ to Object.is").toHaveBeenCalledTimes(2);
  });

  it("stops telling a listener that unsubscribed, and tells every other one", () => {
    const s = createStore({ a: 0 });
    const one = vi.fn();
    const two = vi.fn();
    const off = s.subscribe(one);
    s.subscribe(two);
    s.set({ a: 1 });
    off();
    s.set({ a: 2 });
    expect([one.mock.calls.length, two.mock.calls.length]).toEqual([1, 2]);
  });

  it("lets a listener unsubscribe while being told, without skipping the next", () => {
    const s = createStore({ a: 0 });
    const seen: string[] = [];
    const off = s.subscribe(() => {
      seen.push("one");
      off();
    });
    s.subscribe(() => seen.push("two"));
    s.set({ a: 1 });
    s.set({ a: 2 });
    expect(seen).toEqual(["one", "two", "two"]);
  });

  it("does not tell a listener of the change it was subscribed during", () => {
    const s = createStore({ a: 0 });
    const late = vi.fn();
    s.subscribe(() => s.subscribe(late));
    s.set({ a: 1 });
    expect(late).not.toHaveBeenCalled();
  });

  it("has a setter per field, shaped like useState's — and always the same one", () => {
    const s = createStore({ size: 4, label: "x" });
    const setSize = s.setter("size");
    expect(s.setter("size")).toBe(setSize);
    expect(s.setter("label")).not.toBe(setSize);
    setSize(9);
    expect(s.get().size).toBe(9);
    setSize((n) => n * 2);
    expect(s.get()).toEqual({ size: 18, label: "x" });
  });
});

describe("the options bar's state", () => {
  it("starts from the defaults, a fresh copy per editor", () => {
    const one = createToolOptions();
    const two = createToolOptions();
    expect(one.get()).toEqual(DEFAULT_TOOL_OPTIONS);
    one.set({ moveMode: "selection" });
    expect(two.get().moveMode).toBe("pixels");
    const c1 = createColors();
    c1.set({ foreground: "#000000ff" });
    expect(createColors().get()).toEqual(DEFAULT_COLORS);
  });

  it("says whose brush a tool paints with, and which colour is in use", () => {
    expect([brushOf("brush"), brushOf("pencil"), brushOf("eraser"), brushOf("history"), brushOf("move")]).toEqual([
      "brush",
      "pencil",
      "eraser",
      "brush",
      "brush",
    ]);
    expect([slotColor("primary"), slotColor("secondary")]).toEqual(["foreground", "background"]);
  });

  it("restores a saved session over the defaults, field by field", () => {
    const colors = createColors();
    const tools = createToolOptions();
    restoreToolOptions(colors, tools, {
      foreground: "#112233ff",
      brush: { size: 99 } as ToolPrefs["brush"],
      crop: { shield: 10 } as ToolPrefs["crop"],
      mixer: { wet: 70 } as ToolPrefs["mixer"],
      autoSelect: false,
      resizeSmooth: false,
      triangleApex: 0,
      moveMode: "selection",
      sampleScope: "Current layer",
    });
    const t = tools.get();
    expect(colors.get()).toEqual({ ...DEFAULT_COLORS, foreground: "#112233ff" });
    expect(t.brush).toEqual({ ...DEFAULT_TOOL_OPTIONS.brush, size: 99 });
    expect(t.crop).toEqual({ ...DEFAULT_TOOL_OPTIONS.crop, shield: 10 });
    expect(t.mixer.wet).toBe(70);
    expect([t.autoSelect, t.resizeSmooth, t.triangleApex], "false and 0 are values too").toEqual([false, false, 0]);
    expect([t.moveMode, t.sampleScope, t.sampleSize]).toEqual(["selection", "Current layer", "Point sample"]);
    expect(t.eraser, "what was not saved is not touched").toBe(DEFAULT_TOOL_OPTIONS.eraser);
  });

  it("sanitizes a saved mixer, and ignores what is not a setting", () => {
    const colors = createColors();
    const tools = createToolOptions();
    restoreToolOptions(colors, tools, {
      mixer: { wet: 900 } as ToolPrefs["mixer"],
      autoSelect: "yes" as unknown as boolean,
      triangleApex: "0.2" as unknown as number,
    });
    expect(tools.get().mixer.wet).toBeLessThanOrEqual(100);
    expect([tools.get().autoSelect, tools.get().triangleApex]).toEqual([true, 0.5]);
  });

  it("restoring nothing changes nothing", () => {
    const colors = createColors();
    const tools = createToolOptions();
    const heard = vi.fn();
    tools.subscribe(heard);
    colors.subscribe(heard);
    restoreToolOptions(colors, tools, {});
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("saving the options", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves a quarter-second after the last change — everything, in the order it was always written", () => {
    const colors = createColors();
    const tools = createToolOptions();
    const save = vi.fn();
    persistToolOptions(colors, tools, save);
    tools.set({ moveMode: "selection" });
    vi.advanceTimersByTime(200);
    colors.set({ foreground: "#000000ff" });
    vi.advanceTimersByTime(200);
    expect(save, "each change restarts the wait").not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0] as ToolPrefs;
    expect([saved.foreground, saved.moveMode]).toEqual(["#000000ff", "selection"]);
    expect(Object.keys(saved)).toEqual([
      "foreground", "background", "brush", "eraser", "pencil", "wand", "quickSelect", "bucket", "shape",
      "gradient", "pen", "blur", "smudge", "mixer", "sponge", "historyBrush", "heal", "redEye", "clone",
      "dodge", "text", "crop", "moveMode", "autoSelect", "autoSelectScope", "showTransform", "alignToCanvas",
      "resizeMode", "resizeSmooth", "marqueeShape", "lassoMode", "triangleApex", "sampleSize", "sampleScope",
    ]);
  });

  it("does not save what is not saved: the slot, the Frame tool's shape and fit", () => {
    const colors = createColors();
    const tools = createToolOptions();
    const save = vi.fn();
    persistToolOptions(colors, tools, save);
    colors.set({ activeSlot: "secondary" });
    tools.set({ frameShape: "ellipse", frameFit: "contain" });
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
    tools.set({ resizeMode: "content" });
    vi.advanceTimersByTime(250);
    expect(save).toHaveBeenCalledTimes(1);
    tools.set({ frameShape: "rect" });
    vi.advanceTimersByTime(1000);
    expect(save, "still nothing new to save").toHaveBeenCalledTimes(1);
  });

  it("saves what a restore brought back (merged over the defaults)", () => {
    const colors = createColors();
    const tools = createToolOptions();
    const save = vi.fn();
    persistToolOptions(colors, tools, save);
    restoreToolOptions(colors, tools, { brush: { size: 7 } as ToolPrefs["brush"] });
    vi.advanceTimersByTime(250);
    expect((save.mock.calls[0][0] as ToolPrefs).brush).toEqual({ ...DEFAULT_TOOL_OPTIONS.brush, size: 7 });
  });

  it("stops: a pending save is dropped, and no later change is saved", () => {
    const colors = createColors();
    const tools = createToolOptions();
    const save = vi.fn();
    const stop = persistToolOptions(colors, tools, save);
    tools.set({ lassoMode: "poly" });
    stop();
    vi.advanceTimersByTime(1000);
    colors.set({ background: "#000000ff" });
    tools.set({ lassoMode: "magnetic" });
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("the view", () => {
  const storage = (saved: Record<string, string> = {}) => {
    const data = { ...saved };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  };

  it("restores the stored toggles — the rulers off unless stored — and the panels over all shown", () => {
    const view = createView();
    const st = storage({
      "pe-view": JSON.stringify({ grid: true, snap: false, guides: "yes", docgrid: true, lockguides: true, smartguides: false }),
      "pe-panels": JSON.stringify({ layers: false }),
    });
    expect(restoreView(view, st)).toBe(true);
    const v = view.get();
    expect([v.rulers, v.grid, v.snap, v.guides, v.docgrid, v.lockguides, v.smartguides]).toEqual([
      false,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(v.panels).toEqual({ ...ALL_PANELS, layers: false });
    restoreView(view, storage({ "pe-view": JSON.stringify({ rulers: true }) }));
    expect(view.get().rulers, "a stored true wins").toBe(true);
  });

  it("a view it cannot read changes nothing, and says so", () => {
    for (const raw of ["{nope", "null"]) {
      const view = createView();
      const was = view.get();
      expect(restoreView(view, storage({ "pe-view": raw }))).toBe(false);
      expect(view.get(), raw).toBe(was);
    }
    const view = createView();
    expect(restoreView(view, storage({ "pe-panels": "{nope" })), "the panels are their own").toBe(true);
    expect(view.get().panels).toBe(ALL_PANELS);
  });

  it("a menu's change is kept: all seven toggles, from the state as it is now", () => {
    const view = createView();
    const st = storage();
    setViewFlags(view, { grid: true }, st);
    setViewFlags(view, { snap: false }, st);
    expect(view.get().grid, "the second change keeps the first").toBe(true);
    expect(st.data["pe-view"]).toBe(
      JSON.stringify({ rulers: true, grid: true, snap: false, docgrid: false, guides: true, lockguides: false, smartguides: true }),
    );
    setPanels(view, { ...ALL_PANELS, info: false }, st);
    expect(view.get().panels.info).toBe(false);
    expect(JSON.parse(st.data["pe-panels"])).toEqual({ ...ALL_PANELS, info: false });
  });

  it("a storage that refuses does not stop the change", () => {
    const view = createView();
    const refuses = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    setViewFlags(view, { rulers: false }, refuses);
    setPanels(view, { ...ALL_PANELS, color: false }, refuses);
    expect([view.get().rulers, view.get().panels.color]).toEqual([false, false]);
  });
});

describe("the dialogs", () => {
  it("each command's dialog opens its own — and only it", () => {
    const ids = [
      "trim", "pattern-fill", "open-recent", "save-as", "rename", "more-space", "export-lut", "export-tiff",
      "export-pdf", "merge-hdr", "batch", "hdr-tone", "export-hdr", "preferences", "workspaces", "shortcuts",
      "about", "new-guide", "help-start", "help-docs",
    ] as const;
    const opened = new Set<string>();
    for (const id of ids) {
      const d = createDialogs();
      const was = d.get();
      openDialog(d, id);
      const changed = (Object.keys(was) as (keyof typeof was)[]).filter((k) => d.get()[k] !== was[k]);
      expect(changed, id).toHaveLength(1);
      opened.add(`${changed[0]}=${String(d.get()[changed[0]])}`);
    }
    expect(opened.size, "no two open the same").toBe(ids.length);
    const help = createDialogs();
    openDialog(help, "help-docs");
    expect(help.get().help).toBe("docs");
  });

  it("opens one over another, leaving the first open", () => {
    const d = createDialogs();
    openDialog(d, "preferences");
    openSize(d, "image");
    expect([d.get().prefs, d.get().size, d.get().sizeMode]).toEqual([true, true, "image"]);
    openDialog(d, "shortcuts");
    expect([d.get().prefs, d.get().size, d.get().shortcuts]).toEqual([true, true, true]);
  });

  it("Preferences opens on a section when asked, else where it was left", () => {
    const d = createDialogs();
    openPrefs(d);
    expect(d.get().prefsTab, "the first time: Appearance").toBe("appearance");
    openPrefs(d, "performance");
    expect([d.get().prefs, d.get().prefsTab]).toEqual([true, "performance"]);
    d.set({ prefs: false });
    openPrefs(d);
    expect([d.get().prefs, d.get().prefsTab]).toEqual([true, "performance"]);
  });

  it("Canvas size and Image size are one dialog, opened as either", () => {
    const d = createDialogs();
    openSize(d, "canvas");
    expect([d.get().size, d.get().sizeMode]).toEqual([true, "canvas"]);
    d.set({ size: false });
    openSize(d, "image");
    expect([d.get().size, d.get().sizeMode]).toEqual([true, "image"]);
  });
});

describe("the documents", () => {
  it("start with one untitled canvas, active — a fresh set per editor", () => {
    const one = createDocuments();
    const two = createDocuments();
    expect(one.get().docs.map((d) => [d.id, d.name, d.width, d.height, d.dpi])).toEqual([
      ["doc-1", "Untitled-1", 1920, 1080, 300],
    ]);
    expect([one.get().activeId, one.get().pendingLoads, one.get().pendingPaste]).toEqual(["doc-1", [], null]);
    expect(one.get().history.items).toEqual([{ label: "New", onPath: true }]);
    one.set({ activeId: "doc-9" });
    expect(two.get().activeId).toBe("doc-1");
    expect(two.get().docs).not.toBe(one.get().docs);
  });

  it("makes a document at a size and resolution, empty and unselected", () => {
    expect(makeDoc(4, { w: 10, h: 20 }, 72)).toEqual({
      id: "doc-4",
      name: "Untitled-4",
      width: 10,
      height: 20,
      dpi: 72,
      layers: [],
      activeLayerId: null,
      selectedLayerIds: [],
      selection: [],
      selectionAngle: 0,
      selectionPivot: null,
    });
  });

  it("shows the active document — the first, when the active one is gone", () => {
    const d = createDocuments();
    const second = makeDoc(2);
    d.set((s) => ({ docs: [...s.docs, second], activeId: "doc-2" }));
    expect(activeDoc(d.get())).toBe(second);
    d.set({ activeId: "doc-7" });
    expect(activeDoc(d.get())).toBe(d.get().docs[0]);
  });
});
