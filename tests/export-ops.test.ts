import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The export family (TODO 1.10, app/commands/export.ts): the Export dialog
 * opened, single and batch exports and their metadata, PSD, SVG and frames —
 * with the encoders, the save and the metadata writer stood in for, so what is
 * checked is what the family decides: names, scales, counts, what is skipped
 * and what it says.
 */

const io = vi.hoisted(() => ({
  rendered: [] as unknown[],
  saved: [] as [string, string][],
  embedded: [] as unknown[],
  fail: new Set<string>(),
}));
vi.mock("../app/lib/imageio", () => ({
  availableFormats: () => [
    { id: "png", label: "PNG", mime: "image/png", ext: "png", lossy: false, alpha: true },
    { id: "jpeg", label: "JPEG", mime: "image/jpeg", ext: "jpg", lossy: true, alpha: false },
  ],
  renderExport: async (_c: unknown, o: { format: { id: string }; scale: number; quality: number }) => {
    io.rendered.push([o.format.id, o.scale, o.quality]);
    return io.fail.has(o.format.id) ? null : new Blob([o.format.id]);
  },
  saveImageBlob: async (_b: Blob, name: string) => void io.saved.push(["image", name]),
}));
vi.mock("../app/lib/share", () => ({
  saveExportBlob: async (_b: Blob, name: string) => void io.saved.push(["file", name]),
}));
vi.mock("../app/lib/metadata-write", () => ({
  embedMetadata: async (b: Blob, fmt: string, meta: unknown, w: number, h: number) => {
    io.embedded.push([fmt, meta, w, h]);
    return b;
  },
}));

const { exportOps } = await import("../app/commands/export");
const { DEFAULT_PREFS } = await import("../app/lib/prefs");
const { makeDoc } = await import("../app/state/documents");
type Doc = import("../app/state/documents").Doc;
type LayerNode = import("../app/lib/layers").LayerNode;
type EngineHandle = import("../app/lib/paint").EngineHandle;

const leaf = (id: string, extra: object = {}) =>
  ({ id, type: "layer", name: id, visible: true, opacity: 100, blend: "Normal", ...extra }) as LayerNode;
const composite = {
  width: 200,
  height: 100,
  getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(4) }) }),
};

function editor(doc: Partial<Doc> = {}, opts: { composite?: unknown; prefs?: object; engine?: object } = {}) {
  const d = { ...makeDoc(1, { w: 200, h: 100 }), name: "Lake", ...doc };
  const toasts: string[] = [];
  let open: unknown = opts.composite ?? null;
  const ops = exportOps({
    activeDocRef: { current: d },
    paintRef: {
      current: {
        exportComposite: () => composite,
        captureLeaves: (ids: string[]) => new Map(ids.map((id) => [id, { layer: null, mask: null }])),
        captureMask: () => null,
        ...opts.engine,
      } as unknown as EngineHandle,
    },
    prefsRef: { current: { ...DEFAULT_PREFS, authorName: "  Ann  ", copyrightNotice: "© Ann", ...opts.prefs } },
    showToast: (m) => toasts.push(m),
    exportComposite: open as HTMLCanvasElement | null,
    setExportComposite: (c) => (open = c),
  });
  return { ops, toasts, open: () => open };
}

beforeEach(() => {
  io.rendered.length = 0;
  io.saved.length = 0;
  io.embedded.length = 0;
  io.fail.clear();
});

describe("export", () => {
  it("opens the dialog on the flattened image", () => {
    const e = editor();
    e.ops.openExport();
    expect(e.open()).toBe(composite);
  });

  it("embeds the document's own metadata, or the Preferences' attribution, with its resolution", () => {
    const e = editor();
    const bare = e.ops.exportMetaFor({ ...makeDoc(1), dpi: undefined });
    expect(bare).toMatchObject({ artist: "Ann", copyright: "© Ann", description: undefined, dpi: 300 });
    const own = e.ops.exportMetaFor({
      ...makeDoc(1),
      dpi: 72,
      metadata: { fileName: "a", fileSize: 0, fileType: "", lastModified: 0, artist: "Bo", iso: 200 },
    } as Doc);
    expect(own).toMatchObject({ artist: "Bo", copyright: "© Ann", iso: 200, dpi: 72 });
  });

  it("a single export renders, embeds at the scaled size if asked, saves under its name, and closes", async () => {
    const e = editor({}, { composite });
    const png = { id: "png", label: "PNG", mime: "image/png", ext: "png", lossy: false, alpha: true };
    await e.ops.doExport({ format: png, quality: 1, scale: 0.5, transparent: true, matte: "#fff" }, "  ", true);
    expect(io.embedded).toEqual([["png", expect.objectContaining({ artist: "Ann" }), 100, 50]]);
    expect([io.saved, e.open()]).toEqual([[["image", "Lake.png"]], null]);
    const plain = editor({}, { composite });
    await plain.ops.doExport({ format: png, quality: 1, scale: 1, transparent: true, matte: "#fff" }, "plain", false);
    const plainly = [io.embedded.length, io.saved[1]];
    expect(plainly, "no metadata asked for, none embedded").toEqual([1, ["image", "plain.png"]]);
    const none = editor();
    await none.ops.doExport({ format: png, quality: 1, scale: 1, transparent: true, matte: "#fff" }, "x", false);
    expect(io.rendered, "no image to export: nothing rendered").toHaveLength(2);
  });

  it("a batch encodes each target, names them by the template, and saves one zip — saying what failed", async () => {
    const e = editor({}, { composite });
    const targets = [
      { id: "1", formatId: "png", quality: 100, scalePct: 100, suffix: "" },
      { id: "2", formatId: "jpeg", quality: 80, scalePct: 50, suffix: "@0.5x" },
    ];
    await e.ops.doBatchExport({ targets, template: "{name}", embedMeta: false }, "Lake");
    expect(io.rendered).toEqual([
      ["png", 1, 1],
      ["jpeg", 0.5, 0.8],
    ]);
    expect([io.saved, e.toasts, e.open()]).toEqual([[["file", "Lake.zip"]], ["Exported 2 files as .zip"], null]);
    io.fail.add("jpeg");
    await e.ops.doBatchExport({ targets, template: "{name}", embedMeta: true }, "Lake");
    expect(e.toasts[1]).toBe("Exported 1 file — 1 failed to encode");
    io.fail.add("png");
    await e.ops.doBatchExport({ targets, template: "{name}", embedMeta: false }, "Lake");
    expect(e.toasts[2]).toBe("Batch export failed — nothing could be encoded.");
  });

  it("a PSD keeps the tree, skips adjustment layers and says so", () => {
    const adj = { ...leaf("j"), type: "adjustment", adjustment: { type: "sliders", params: {} } } as LayerNode;
    const group = { ...leaf("g"), type: "group", expanded: true, children: [leaf("a"), adj] } as LayerNode;
    const e = editor({ layers: [group, leaf("b")] });
    e.ops.exportPSD();
    expect([io.saved, e.toasts]).toEqual([
      [["file", "Lake.psd"]],
      ["Exported PSD — 1 adjustment layer skipped (no PSD equivalent)"],
    ]);
  });

  it("an SVG needs a vector layer, and says how many it had and skipped", () => {
    const alerts: string[] = [];
    vi.stubGlobal("window", { alert: (m: string) => alerts.push(m) });
    const none = editor({ layers: [leaf("a")] });
    none.ops.exportVectorSVG();
    expect(alerts[0]).toMatch(/^No vector layers to export/);
    const shape = leaf("s", {
      vector: { type: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10, fill: "#ff0000ff", stroke: "", strokeWidth: 0 },
    });
    const e = editor({ layers: [shape, leaf("a")] });
    e.ops.exportVectorSVG();
    expect([io.saved, e.toasts]).toEqual([
      [["file", "Lake.svg"]],
      ["Exported 1 vector layer — 1 without a vector source skipped"],
    ]);
    vi.unstubAllGlobals();
  });

  it("frames need two top-level layers", async () => {
    const group = { ...leaf("g"), type: "group", expanded: true, children: [] } as LayerNode;
    const e = editor({ layers: [leaf("a"), group] });
    await e.ops.exportFrames();
    expect([e.toasts, io.saved]).toEqual([
      ["Export frames needs at least two layers — each layer becomes one frame."],
      [],
    ]);
  });
});
