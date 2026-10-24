import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The projects family (TODO 1.10, app/commands/projects.ts): a document
 * written as .gproj and read back (fresh ids, its pixels queued under them),
 * Save and Save As, Open, files refused, a crash snapshot restored — against
 * the documents store and an engine that hands each layer's pixels back as a
 * token, with the file system and the recents list stood in for.
 */

const io = vi.hoisted(() => ({
  downloads: [] as string[],
  recents: [] as string[],
  files: [] as Blob[],
  picked: true,
}));
vi.mock("../app/lib/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/project")>()),
  downloadBlob: (_b: Blob, name: string) => void io.downloads.push(name),
  saveProjectFile: async (b: Blob, name: string) => {
    io.downloads.push(name);
    io.files.push(b);
    return { ok: io.picked, handle: null };
  },
}));
vi.mock("../app/lib/recents", () => ({ addRecent: (name: string) => void io.recents.push(name) }));

const { projectOps } = await import("../app/commands/projects");
const { activeDoc, createDocuments } = await import("../app/state/documents");
const { DEFAULT_ADJUST } = await import("../app/lib/adjust");
type Doc = import("../app/state/documents").Doc;
type LayerNode = import("../app/lib/layers").LayerNode;
type EngineHandle = import("../app/lib/paint").EngineHandle;
type PendingLoad = import("../app/lib/project").PendingLoad;
type AutosaveDoc = import("../app/lib/autosave").AutosaveDoc;

const leaf = (id: string, extra: object = {}) =>
  ({ id, type: "layer", name: `${id}!`, visible: true, opacity: 100, blend: "Normal", ...extra }) as LayerNode;
const group = (id: string, children: LayerNode[]) =>
  ({ ...leaf(id), type: "group", expanded: true, children }) as LayerNode;
const adjustment = (id: string) =>
  ({ ...leaf(id), type: "adjustment", adjustment: { type: "sliders", params: { ...DEFAULT_ADJUST } } }) as LayerNode;

function editor(start: Partial<Doc> = {}, opts: { fits?: boolean; space?: "srgb" | "display-p3" } = {}) {
  const documents = createDocuments();
  documents.set((s) => ({ docs: [{ ...s.docs[0], width: 100, height: 80, ...start }] }));
  const live = <T,>(read: () => T) => ({
    get current() {
      return read();
    },
  });
  const calls: unknown[] = [];
  const cache = new Map<string, AutosaveDoc>();
  let loads: PendingLoad[] = [];
  let saved: unknown = null;
  let saveAsOpen = true;
  const colours = { fg: "#000000", bg: "#ffffff" };
  const seq = { current: 1 };
  const layerSeq = { current: 10 };
  const ops = () =>
    projectOps({
      documents,
      activeIdRef: live(() => documents.get().activeId),
      activeDocRef: live(() => activeDoc(documents.get())),
      paintRef: {
        current: {
          getLayerImage: (id: string) => `data:image/png;base64,${id}`,
          getMaskImage: () => null,
          getFrameSourceImage: () => null,
          selectionMaskImage: () => null,
          historyOf: () => null,
        } as unknown as EngineHandle,
      },
      colorSpaceRef: { current: opts.space ?? "srgb" },
      globalLightRef: { current: { angle: 120, altitude: 30 } },
      fgRef: { current: "#112233" },
      bgRef: { current: "#445566" },
      seqRef: seq,
      layerSeqRef: layerSeq,
      adjSeqRef: { current: 0 },
      docJsonCache: { current: cache },
      fileInputRef: { current: { click: () => calls.push("file input") } as unknown as HTMLInputElement },
      autosaveDirtyRef: { current: true },
      unsavedRef: { current: true },
      showToast: (m) => calls.push(`toast: ${m}`),
      acceptSize: (w, h) => (opts.fits === false ? (calls.push(`refused ${w}x${h}`), false) : true),
      commitFloatIfAny: () => calls.push("float down"),
      setActiveId: (id) => documents.set({ activeId: id }),
      setPendingLoads: (update) => (loads = update(loads)),
      setForeground: (hex) => (colours.fg = hex),
      setBackground: (hex) => (colours.bg = hex),
      restoreGlobalLight: (raw) => calls.push(["light", raw]),
      setColorSpaceState: (s) => calls.push(["space", s]),
      setSaveState: (s) => (saved = s),
      setSaveAsOpen: (open) => (saveAsOpen = open),
      renameDoc: (id, name) =>
        documents.set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, name } : d)) })),
      nextLeafId: () => `layer-${(layerSeq.current += 1)}`,
    });
  const doc = () => activeDoc(documents.get());
  const read = { loads: () => loads, saved: () => saved, saveAsOpen: () => saveAsOpen };
  return { documents, ops, doc, calls, cache, colours, ...read };
}

beforeEach(() => {
  io.downloads.length = 0;
  io.recents.length = 0;
  io.files.length = 0;
  io.picked = true;
  vi.stubGlobal("window", { alert: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("a project read back", () => {
  it("comes back with its tree and names, fresh ids, its pixels queued under them, in front", () => {
    const layers = [group("g", [leaf("a"), adjustment("j")]), leaf("b")];
    const e = editor({ name: "Lake", layers, activeLayerId: "a" });
    const json = e.ops().serializeDocToJSON(e.doc());
    expect(e.ops().loadProjectText(json)).toBe(true);
    const d = e.doc();
    expect([d.id, d.name, d.width, d.height]).toEqual(["doc-2", "Lake", 100, 80]);
    const shape = (ns: LayerNode[]): unknown[] =>
      ns.map((n) => (n.type === "group" ? [n.name, shape(n.children)] : `${n.type}:${n.name}`));
    expect(shape(d.layers)).toEqual([["g!", ["layer:a!", "adjustment:j!"]], "layer:b!"]);
    const ids = JSON.stringify(d.layers);
    expect(["\"a\"", "\"b\"", "\"g\"", "\"j\""].some((id) => ids.includes(`"id":${id}`)), "fresh ids").toBe(false);
    const [load] = e.loads();
    expect(load.docId).toBe("doc-2");
    const a = (d.layers[0] as { children: LayerNode[] }).children[0];
    expect(load.images).toContainEqual({ id: a.id, data: "data:image/png;base64,a" });
    expect(d.activeLayerId, "the active layer, renamed with the rest").toBe(a.id);
    expect([e.colours.fg, e.colours.bg]).toEqual(["#112233", "#445566"]);
    expect(e.cache.has("doc-2"), "autosave's cache seeded from the file").toBe(true);
    expect(e.calls).toContainEqual(["light", { angle: 120, altitude: 30 }]);
  });

  it("a size this browser cannot hold is refused; a file from another colour space opens in it", () => {
    const big = editor({}, { fits: false });
    expect(big.ops().loadProjectText(big.ops().serializeDocToJSON(big.doc()))).toBe(false);
    expect([big.documents.get().docs.length, big.calls]).toEqual([1, ["refused 100x80"]]);
    // An sRGB file, opened in a Display P3 session, switches the session to sRGB first.
    const file = editor().ops().serializeDocToJSON(editor().doc());
    const p3 = editor({}, { space: "display-p3" });
    p3.ops().loadProjectText(file);
    expect(p3.calls).toContainEqual(["space", "srgb"]);
    expect(p3.calls).toContain("toast: Opened in sRGB — the space this file was saved in.");
    const same = editor();
    same.ops().loadProjectText(file);
    const switched = same.calls.some((c) => Array.isArray(c) && c[0] === "space");
    expect(switched, "no switch when the spaces agree").toBe(false);
  });

  it("a file that is not a project, or not JSON, is refused, saying so", () => {
    const e = editor();
    expect(e.ops().loadProjectText('{"format":"other","layers":[]}')).toBe(false);
    expect(e.ops().loadProjectText("{nope")).toBe(false);
    expect((window.alert as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "This file isn't a valid Graphiq project (.gproj).",
      "Couldn't open the file — it may be corrupted.",
    ]);
    expect(e.documents.get().docs).toHaveLength(1);
  });

  it("a crash snapshot opens every document it holds, the one in front in front, a bad one skipped", () => {
    const e = editor({ name: "One" });
    const one = e.ops().serializeDocToJSON(e.doc());
    const two = e.ops().serializeDocToJSON({ ...e.doc(), name: "Two" });
    const docs = [
      { json: one, name: "One" },
      { json: "{bad", name: "x" },
      { json: two, name: "Two" },
    ];
    const n = e.ops().restoreSnapshot({ docs, activeIndex: 1 } as never);
    expect(n).toBe(2);
    expect(e.documents.get().docs.map((d) => d.name)).toEqual(["One", "One", "Two"]);
    expect(e.doc().name).toBe("Two");
    expect(e.ops().restoreSnapshot({ docs: [], activeIndex: 0 } as never)).toBe(0);
  });
});

describe("Save, Save As and Open", () => {
  it("Save downloads the project under the document's name and marks it saved", () => {
    const e = editor({ name: "Lake" });
    e.ops().saveProject();
    expect([io.downloads, io.recents, e.saved()]).toEqual([
      ["Lake.gproj"],
      ["Lake.gproj"],
      { label: "Saved", ok: true },
    ]);
  });

  it("Save As saves under the name given, renames the tab, closes the dialog; a cancelled picker, none", async () => {
    const e = editor({ name: "Lake" });
    await e.ops().saveProjectAs("Evening.gproj");
    expect([io.downloads, e.doc().name, e.saveAsOpen(), e.saved()]).toEqual([
      ["Evening.gproj"],
      "Evening",
      false,
      { label: "Saved", ok: true },
    ]);
    expect(JSON.parse(await io.files[0].text()).name, "the file carries the new name").toBe("Evening");
    io.picked = false;
    const c = editor({ name: "Lake" });
    await c.ops().saveProjectAs("Other");
    expect([c.doc().name, c.saveAsOpen(), c.saved()]).toEqual(["Lake", true, null]);
  });

  it("Open without the native picker falls back to the file input", async () => {
    const e = editor();
    await e.ops().openProject();
    expect(e.calls).toEqual(["file input"]);
  });

  it("the document written carries its colours, light and space", () => {
    const e = editor({ name: "Lake", layers: [leaf("a")] });
    const p = JSON.parse(e.ops().serializeDocToJSON(e.doc()));
    expect(p).toMatchObject({
      format: "graphiq-project",
      name: "Lake",
      foreground: "#112233",
      background: "#445566",
      globalLight: { angle: 120, altitude: 30 },
      workingSpace: "srgb",
    });
    expect(p.layers[0].data).toBe("data:image/png;base64,a");
    const p3 = editor({}, { space: "display-p3" });
    const written = JSON.parse(p3.ops().serializeDocToJSON(p3.doc()));
    expect(written.workingSpace, "the space it was written in").toBe("display-p3");
  });
});

