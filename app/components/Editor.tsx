"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./Editor.module.scss";
import TopBar from "./TopBar";
import Toolbar from "./Toolbar";
import OptionsBar from "./OptionsBar";
import CanvasArea from "./CanvasArea";
import RightDock from "./RightDock";
import StatusBar from "./StatusBar";
import CanvasSizeDialog, { type CanvasSize } from "./CanvasSizeDialog";
import PasteDialog, { type PasteDest } from "./PasteDialog";
import {
  DEFAULT_TOOL,
  SAMPLE_SIZE_PX,
  TOOL_BY_KEY,
  type MoveMode,
  type SelectResizeMode,
  type ToolId,
} from "../lib/tools";
import type { Theme } from "../lib/theme";
import type { Pan, Rect } from "../lib/view";
import {
  cloneSubtree,
  collectLeafIds,
  findNode,
  flattenedIds,
  insertInGroup,
  insertRelative,
  mergeDownInTree,
  removeMany,
  removeNode,
  replaceNodeWith,
  topLevelSelected,
  ungroupNode,
  updateNode,
  type Layer,
  type LayerGroup,
  type LayerNode,
  type LayersApi,
} from "../lib/layers";
import type { BrushSettings, EngineHandle, HistorySummary, PendingPaste } from "../lib/paint";
import SaveAsDialog from "./SaveAsDialog";
import RecentsDialog from "./RecentsDialog";
import ExportDialog from "./ExportDialog";
import ImportDialog, { type ImportItem, type ImportMode } from "./ImportDialog";
import {
  PROJECT_EXT,
  downloadBlob,
  saveProjectFile,
  serializeProject,
  type PendingLoad,
  type ProjectFile,
  type SerializedNode,
} from "../lib/project";
import {
  IMPORT_ACCEPT,
  decodeImageFile,
  renderExport,
  saveImageBlob,
  type ExportOptions,
} from "../lib/imageio";
import { addRecent } from "../lib/recents";
import { DEFAULT_ADJUST, filterToAdjust, isDefaultAdjust, type Adjustments } from "../lib/adjust";

interface PasteSrc {
  source: ImageBitmap | HTMLCanvasElement;
  w: number;
  h: number;
}

interface Doc {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: LayerNode[];
  /** Primary layer (drives the blend/opacity panel; anchor for range-select). */
  activeLayerId: string | null;
  /** Full multi-selection (always includes activeLayerId when non-null). */
  selectedLayerIds: string[];
  selection: Rect[];
}

/** A layer selection: the primary (active) id plus the full selected set. */
type Sel = { active: string | null; selected: string[] };

const makeDoc = (seq: number): Doc => ({
  id: `doc-${seq}`,
  name: `Untitled-${seq}`,
  width: 1920,
  height: 1080,
  layers: [],
  activeLayerId: null,
  selectedLayerIds: [],
  selection: [],
});

export default function Editor({ initialTheme }: { initialTheme: Theme }) {
  const [tool, setTool] = useState<ToolId>(DEFAULT_TOOL);
  const [zoom, setZoom] = useState(67);
  const [foreground, setForeground] = useState("#6366f1ff");
  const [background, setBackground] = useState("#ffffffff");
  const [sizeDialogOpen, setSizeDialogOpen] = useState(false);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [brush, setBrush] = useState<BrushSettings>({
    size: 24,
    hardness: 80,
    opacity: 100,
    flow: 100,
    blend: "Normal",
    smoothing: 20,
  });
  const [eraser, setEraser] = useState<BrushSettings>({
    size: 30,
    hardness: 90,
    opacity: 100,
    flow: 100,
    blend: "Normal",
    smoothing: 10,
  });
  const [history, setHistory] = useState<HistorySummary>({ items: [{ label: "New" }], index: 0 });
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [adjust, setAdjust] = useState<Adjustments>(DEFAULT_ADJUST);
  const [adjustFilter, setAdjustFilter] = useState("Original");
  const [moveMode, setMoveMode] = useState<MoveMode>("pixels");
  const [resizeMode, setResizeMode] = useState<SelectResizeMode>("bounds");
  const [resizeSmooth, setResizeSmooth] = useState(true);
  const [sampleSizeLabel, setSampleSizeLabel] = useState("Point sample");
  const [sampleScopeLabel, setSampleScopeLabel] = useState("All layers");
  const [pasteSrc, setPasteSrc] = useState<PasteSrc | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [pendingLoads, setPendingLoads] = useState<PendingLoad[]>([]);
  const [exportComposite, setExportComposite] = useState<HTMLCanvasElement | null>(null);
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Internal clipboard fallback (used if the OS clipboard write/read fails).
  const clipboardRef = useRef<HTMLCanvasElement | null>(null);

  // Imperative handle into the paint engine (set by CanvasArea).
  const paintRef = useRef<EngineHandle | null>(null);
  // Latest colours, reachable from the one-time keydown listener.
  const fgRef = useRef(foreground);
  const bgRef = useRef(background);
  fgRef.current = foreground;
  bgRef.current = background;
  const historyRef = useRef(history);
  historyRef.current = history;

  // Open documents. Starts with a single, unnamed canvas.
  const [docs, setDocs] = useState<Doc[]>(() => [makeDoc(1)]);
  const [activeId, setActiveId] = useState("doc-1");
  const seqRef = useRef(1);
  const layerSeqRef = useRef(0);

  const active = docs.find((d) => d.id === activeId) ?? docs[0];

  // The active layer when it's a pixel layer (adjustments target a single leaf).
  const activeLeafNode = active.activeLayerId ? findNode(active.layers, active.activeLayerId) : null;
  const activeLeafId = activeLeafNode && activeLeafNode.type === "layer" ? active.activeLayerId : null;

  // Latest active-doc bits reachable from the one-time keydown listener.
  const activeIdRef = useRef(activeId);
  const selRef = useRef(active.selection);
  const activeLayerRef = useRef(active.activeLayerId);
  const activeDocRef = useRef(active);
  activeIdRef.current = activeId;
  selRef.current = active.selection;
  activeLayerRef.current = active.activeLayerId;
  activeDocRef.current = active;

  // Where the last in-app copy came from, so an in-app paste can drop in place.
  const copyOriginRef = useRef({ x: 0, y: 0 });
  const copyDocIdRef = useRef<string | null>(null);

  const setActiveSize = (s: CanvasSize) =>
    setDocs((ds) => ds.map((d) => (d.id === activeId ? { ...d, ...s } : d)));

  const setSelection = (rects: Rect[]) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selection: rects } : d)));

  // ---- Layer operations (act on the active document) ----
  const patchActiveDoc = (fn: (d: Doc) => Doc) =>
    setDocs((ds) => ds.map((d) => (d.id === activeId ? fn(d) : d)));

  const setDocSel = (docId: string, layers: LayerNode[], sel: Sel) =>
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? { ...d, layers, activeLayerId: sel.active, selectedLayerIds: sel.selected }
          : d,
      ),
    );

  const nextLeafId = () => `layer-${(layerSeqRef.current += 1)}`;
  const single = (id: string | null): Sel => ({ active: id, selected: id ? [id] : [] });
  // Current selection of the active doc (before snapshot for undo).
  const selNow = (): Sel => ({ active: active.activeLayerId, selected: active.selectedLayerIds });
  // The ids an action operates on: the multi-selection, or just the active layer.
  const targetIds = (): string[] =>
    active.selectedLayerIds.length
      ? active.selectedLayerIds
      : active.activeLayerId
        ? [active.activeLayerId]
        : [];

  // Run an undoable structural layer change. `forward` does the engine pixel work
  // (duplicate / rasterize). Created & deleted leaves (from the tree diff) drive
  // canvas undo/redo; the tree + selection are restored through setDocSel.
  const commitLayerChange = (
    label: string,
    treeBefore: LayerNode[],
    selBefore: Sel,
    treeAfter: LayerNode[],
    selAfter: Sel,
    forward: () => void = () => {},
  ) => {
    const docId = activeIdRef.current;
    const eng = paintRef.current;
    const beforeIds = new Set(collectLeafIds(treeBefore));
    const afterIds = new Set(collectLeafIds(treeAfter));
    const deletedIds = [...beforeIds].filter((id) => !afterIds.has(id));
    const createdIds = [...afterIds].filter((id) => !beforeIds.has(id));
    const beforeSnaps = eng ? eng.captureLeaves(deletedIds) : new Map<string, ImageData | null>();
    forward();
    if (eng) deletedIds.forEach((id) => eng.removeLayer(id));
    const afterSnaps = eng ? eng.captureLeaves(createdIds) : new Map<string, ImageData | null>();
    setDocSel(docId, treeAfter, selAfter);
    if (!eng) return;
    const undoSnaps = new Map<string, ImageData | null>();
    deletedIds.forEach((id) => undoSnaps.set(id, beforeSnaps.get(id) ?? null));
    createdIds.forEach((id) => undoSnaps.set(id, null));
    const redoSnaps = new Map<string, ImageData | null>();
    createdIds.forEach((id) => redoSnaps.set(id, afterSnaps.get(id) ?? null));
    deletedIds.forEach((id) => redoSnaps.set(id, null));
    eng.pushStructural(
      label,
      () => {
        eng.restoreLeaves(undoSnaps);
        setDocSel(docId, treeBefore, selBefore);
      },
      () => {
        eng.restoreLeaves(redoSnaps);
        setDocSel(docId, treeAfter, selAfter);
      },
    );
  };

  const addLayerOp = () => {
    const before = active.layers;
    const leaf: Layer = {
      id: nextLeafId(),
      type: "layer",
      name: `Layer ${layerSeqRef.current}`,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const node = active.activeLayerId ? findNode(before, active.activeLayerId) : null;
    let after: LayerNode[];
    if (node && node.type === "group") after = insertInGroup(before, leaf, node.id);
    else if (node) after = insertRelative(before, leaf, node.id, true);
    else after = [leaf, ...before];
    commitLayerChange("New Layer", before, selNow(), after, single(leaf.id));
  };

  const removeSelected = () => {
    const before = active.layers;
    const ids = new Set(targetIds());
    if (!ids.size) return;
    const after = removeMany(before, ids);
    const next = collectLeafIds(after)[0] ?? null;
    commitLayerChange(
      ids.size > 1 ? "Delete Layers" : "Delete Layer",
      before,
      selNow(),
      after,
      single(next),
    );
  };

  const duplicateSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    let after = before;
    const pairs: [string, string][] = [];
    const newIds: string[] = [];
    for (const top of tops) {
      const { node: clone, leafPairs } = cloneSubtree(top, nextLeafId);
      const named = { ...clone, name: `${top.name} copy` } as LayerNode;
      after = insertRelative(after, named, top.id, true);
      pairs.push(...leafPairs);
      newIds.push(named.id);
    }
    commitLayerChange(
      tops.length > 1 ? "Duplicate Layers" : "Duplicate Layer",
      before,
      selNow(),
      after,
      { active: newIds[0], selected: newIds },
      () => pairs.forEach(([from, to]) => paintRef.current?.duplicateLayer(from, to)),
    );
  };

  const groupSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    const gid = `grp-${(layerSeqRef.current += 1)}`;
    const group: LayerGroup = {
      id: gid,
      type: "group",
      name: "Group",
      visible: true,
      opacity: 100,
      blend: "Normal",
      expanded: true,
      children: tops,
    };
    const rest = new Set(tops.slice(1).map((n) => n.id));
    const after = replaceNodeWith(removeMany(before, rest), tops[0].id, group);
    commitLayerChange("Group Layers", before, selNow(), after, single(gid));
  };

  const ungroupLayerOp = (id: string) => {
    const before = active.layers;
    const node = findNode(before, id);
    if (!node || node.type !== "group") return;
    const after = ungroupNode(before, id);
    commitLayerChange("Ungroup", before, selNow(), after, single(node.children[0]?.id ?? null));
  };

  const mergeDownOp = (id: string) => {
    const before = active.layers;
    const tid = nextLeafId();
    const res = mergeDownInTree(before, id, (_top, b) => ({
      id: tid,
      type: "layer",
      name: b.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    }));
    if (!res.top || !res.bottom) return; // nothing below it at this level
    const top = res.top;
    const bottom = res.bottom;
    commitLayerChange("Merge Down", before, selNow(), res.tree, single(tid), () => {
      paintRef.current?.rasterize(tid, [top, bottom], collectLeafIds([top, bottom]));
    });
  };

  const mergeSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (tops.length <= 1) {
      if (tops.length === 1) mergeDownOp(tops[0].id); // single → merge down
      return;
    }
    const tid = nextLeafId();
    const bottommost = tops[tops.length - 1];
    const others = new Set(tops.slice(0, -1).map((n) => n.id));
    const merged: Layer = {
      id: tid,
      type: "layer",
      name: bottommost.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const after = replaceNodeWith(removeMany(before, others), bottommost.id, merged);
    const leafIds = collectLeafIds(tops);
    commitLayerChange("Merge Layers", before, selNow(), after, single(tid), () => {
      paintRef.current?.rasterize(tid, tops, leafIds);
    });
  };

  const flattenImage = () => {
    const before = active.layers;
    if (before.length === 0) return;
    const tid = nextLeafId();
    const flat: Layer = {
      id: tid,
      type: "layer",
      name: "Flattened",
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const all = collectLeafIds(before);
    commitLayerChange("Flatten Image", before, selNow(), [flat], single(tid), () => {
      paintRef.current?.rasterize(tid, before, all);
    });
  };

  const selectLayer = (id: string, mode: "replace" | "toggle" | "range" = "replace") => {
    commitFloatIfAny();
    patchActiveDoc((d) => {
      if (mode === "toggle") {
        const has = d.selectedLayerIds.includes(id);
        const selected = has ? d.selectedLayerIds.filter((x) => x !== id) : [...d.selectedLayerIds, id];
        const activeLayerId = has ? (selected[selected.length - 1] ?? null) : id;
        return { ...d, selectedLayerIds: selected, activeLayerId };
      }
      if (mode === "range") {
        const order = flattenedIds(d.layers);
        const a = order.indexOf(d.activeLayerId ?? id);
        const b = order.indexOf(id);
        if (a === -1 || b === -1) return { ...d, selectedLayerIds: [id], activeLayerId: id };
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return { ...d, selectedLayerIds: order.slice(lo, hi + 1), activeLayerId: id };
      }
      return { ...d, selectedLayerIds: [id], activeLayerId: id };
    });
  };

  const layersApi: LayersApi = {
    layers: active.layers,
    activeLayerId: active.activeLayerId,
    selectedLayerIds: active.selectedLayerIds,
    add: addLayerOp,
    select: selectLayer,
    update: (id, patch) =>
      patchActiveDoc((d) => ({ ...d, layers: updateNode(d.layers, id, patch) })),
    move: (fromId, targetId, before) =>
      patchActiveDoc((d) => {
        if (fromId === targetId) return d;
        if (!findNode(d.layers, fromId)) return d;
        const { tree: without, removed } = removeNode(d.layers, fromId);
        if (!removed) return d;
        if (!findNode(without, targetId)) return d; // target was inside the moved group
        return { ...d, layers: insertRelative(without, removed, targetId, before) };
      }),
    remove: removeSelected,
    duplicate: duplicateSelected,
    group: groupSelected,
    ungroup: ungroupLayerOp,
    merge: mergeSelected,
    flatten: flattenImage,
  };

  // Return a paintable leaf id: the active layer if it's a pixel layer, otherwise
  // create one (inside the active group if a group is selected). Uses refs so it
  // is safe to call from the global keydown listener too.
  const ensureLayer = (): string => {
    const cur = activeLayerRef.current;
    if (cur) {
      const node = findNode(activeDocRef.current.layers, cur);
      if (node && node.type === "layer") return cur;
    }
    const id = nextLeafId();
    const layer: Layer = {
      id,
      type: "layer",
      name: `Layer ${layerSeqRef.current}`,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    setDocs((ds) =>
      ds.map((d) => {
        if (d.id !== activeIdRef.current) return d;
        const node = cur ? findNode(d.layers, cur) : null;
        const layers =
          node && node.type === "group"
            ? insertInGroup(d.layers, layer, node.id)
            : [layer, ...d.layers];
        return { ...d, layers, activeLayerId: id, selectedLayerIds: [id] };
      }),
    );
    return id;
  };

  // Copy the composite within the selection (or whole canvas) to the clipboard.
  const copySelection = () => {
    const res = paintRef.current?.copyRegion(selRef.current.length ? selRef.current : null);
    if (!res) return;
    clipboardRef.current = res.canvas;
    copyOriginRef.current = { x: res.x, y: res.y };
    copyDocIdRef.current = activeIdRef.current;
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      res.canvas.toBlob((blob) => {
        if (!blob) return;
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {});
      });
    }
  };

  // Place a pasted image. Reads active-doc refs so it works from the paste
  // listener too. `posX/posY` override the default (centred) placement.
  const doPaste = (
    source: ImageBitmap | HTMLCanvasElement,
    imgW: number,
    imgH: number,
    dest: PasteDest,
    expand: boolean,
    posX?: number,
    posY?: number,
  ) => {
    setTool("move"); // ready to reposition the pasted content
    if (dest === "new-canvas") {
      const seq = (seqRef.current += 1);
      const lseq = (layerSeqRef.current += 1);
      const docId = `doc-${seq}`;
      const layerId = `layer-${lseq}`;
      const layer: Layer = { id: layerId, type: "layer", name: "Pasted Layer", visible: true, opacity: 100, blend: "Normal" };
      setDocs((ds) => [
        ...ds,
        { id: docId, name: `Untitled-${seq}`, width: imgW, height: imgH, layers: [layer], activeLayerId: layerId, selectedLayerIds: [layerId], selection: [] },
      ]);
      setActiveId(docId);
      setPendingPaste({ docId, layerId, source, x: 0, y: 0 });
      return;
    }

    const act = activeDocRef.current;
    const docId = activeIdRef.current;
    const beforeW = act.width;
    const beforeH = act.height;
    const beforeActive = act.activeLayerId;
    const finalW = expand ? Math.max(beforeW, imgW) : beforeW;
    const finalH = expand ? Math.max(beforeH, imgH) : beforeH;
    let layerId = act.activeLayerId;
    let added: Layer | null = null;
    if (dest === "new-layer" || !layerId) {
      const lseq = (layerSeqRef.current += 1);
      layerId = `layer-${lseq}`;
      added = {
        id: layerId,
        type: "layer",
        name: dest === "new-layer" ? "Pasted Layer" : `Layer ${lseq}`,
        visible: true,
        opacity: 100,
        blend: "Normal",
      };
    }
    const lid = layerId;
    const addedLayer = added;
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? {
              ...d,
              width: finalW,
              height: finalH,
              layers: addedLayer ? [addedLayer, ...d.layers] : d.layers,
              activeLayerId: lid,
              selectedLayerIds: lid ? [lid] : d.selectedLayerIds,
            }
          : d,
      ),
    );
    // Fold the layer addition + canvas resize into the paste's single undo step.
    const structural = addedLayer !== null || finalW !== beforeW || finalH !== beforeH;
    const side = structural
      ? {
          undo: () =>
            setDocs((ds) =>
              ds.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      width: beforeW,
                      height: beforeH,
                      layers: addedLayer ? d.layers.filter((l) => l.id !== addedLayer.id) : d.layers,
                      activeLayerId:
                        addedLayer && d.activeLayerId === addedLayer.id ? beforeActive : d.activeLayerId,
                      selectedLayerIds:
                        addedLayer && d.activeLayerId === addedLayer.id
                          ? beforeActive
                            ? [beforeActive]
                            : []
                          : d.selectedLayerIds,
                    }
                  : d,
              ),
            ),
          redo: () =>
            setDocs((ds) =>
              ds.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      width: finalW,
                      height: finalH,
                      layers: addedLayer
                        ? [addedLayer, ...d.layers.filter((l) => l.id !== addedLayer.id)]
                        : d.layers,
                      activeLayerId: lid,
                      selectedLayerIds: lid ? [lid] : d.selectedLayerIds,
                    }
                  : d,
              ),
            ),
        }
      : undefined;
    const x = posX !== undefined ? posX : Math.round((finalW - imgW) / 2);
    const y = posY !== undefined ? posY : Math.round((finalH - imgH) / 2);
    // Pasting onto the current layer floats above it (movable, merges on deselect);
    // a new layer just bakes the image in.
    const float = dest === "current-layer";
    if (float) setSelection([{ x, y, w: imgW, h: imgH }]);
    setPendingPaste({ docId, layerId: lid, source, x, y, side, float });
  };

  const applyPaste = (opts: { dest: PasteDest; expand: boolean }) => {
    if (!pasteSrc) return;
    doPaste(pasteSrc.source, pasteSrc.w, pasteSrc.h, opts.dest, opts.expand);
    setPasteSrc(null);
  };

  const createDoc = () => {
    const seq = (seqRef.current += 1);
    const d = makeDoc(seq);
    setDocs((ds) => [...ds, d]);
    setActiveId(d.id);
  };

  const closeDoc = (id: string) => {
    if (docs.length <= 1) return; // always keep one canvas open
    const idx = docs.findIndex((d) => d.id === id);
    const next = docs.filter((d) => d.id !== id);
    setDocs(next);
    if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)].id);
  };

  const renameDoc = (id: string, name: string) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, name } : d)));
  };

  const doUndo = () => {
    if (paintRef.current?.isFloating()) {
      // A floating paste/move isn't committed yet — undo cancels it.
      paintRef.current.discardFloat();
      setSelection([]);
    } else {
      paintRef.current?.undo();
    }
  };
  const doRedo = () => paintRef.current?.redo();

  // ---- Project save (.aproj — layers, groups & full state) ----
  // Reads from refs so it also works from the one-time keydown listener.
  const buildProjectBlob = (): Blob => {
    const d = activeDocRef.current;
    const project = serializeProject(
      {
        name: d.name,
        width: d.width,
        height: d.height,
        layers: d.layers,
        activeLayerId: d.activeLayerId,
        selectedLayerIds: d.selectedLayerIds,
        selection: d.selection,
      },
      { foreground: fgRef.current, background: bgRef.current },
      { labels: historyRef.current.items.map((i) => i.label), index: historyRef.current.index },
      (id) => paintRef.current?.getLayerImage(id) ?? null,
    );
    return new Blob([JSON.stringify(project)], { type: "application/json" });
  };

  // Simple Save: download the project under the canvas's current name.
  const saveProject = () => {
    const filename = `${activeDocRef.current.name}.${PROJECT_EXT}`;
    const blob = buildProjectBlob();
    downloadBlob(blob, filename);
    addRecent(filename, { blob }); // remember a re-openable cached copy
  };

  // Save As: pick a name (dialog) then choose folder/path via the native picker.
  const saveProjectAs = async (filename: string) => {
    const base = filename.replace(new RegExp(`\\.${PROJECT_EXT}$`, "i"), "").trim() || activeDocRef.current.name;
    const docId = activeIdRef.current;
    const blob = buildProjectBlob();
    const fname = `${base}.${PROJECT_EXT}`;
    const { ok, handle } = await saveProjectFile(blob, fname);
    if (ok) {
      renameDoc(docId, base); // reflect the saved name on the tab
      addRecent(fname, handle ? { handle } : { blob });
      setSaveAsOpen(false);
    }
  };

  // ---- Project open / load ----
  const openFileDialog = () => fileInputRef.current?.click();

  // Open via the native picker (gives a re-openable handle) when available,
  // otherwise fall back to a hidden <input type=file>.
  const openProject = async () => {
    const picker = (
      window as unknown as {
        showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile: () => Promise<File>; name: string }>>;
      }
    ).showOpenFilePicker;
    if (!picker) {
      openFileDialog();
      return;
    }
    try {
      const [handle] = await picker({
        multiple: false,
        types: [{ description: "Aperture Project", accept: { "application/json": [`.${PROJECT_EXT}`] } }],
      });
      const file = await handle.getFile();
      if (loadProjectText(await file.text())) addRecent(file.name, { handle });
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") window.alert("Couldn't open the file.");
    }
  };

  // Rebuild a document from a parsed .aproj file. Layer ids are remapped to fresh
  // ones so a loaded project never collides with already-open documents.
  const loadProject = (p: ProjectFile) => {
    commitFloatIfAny(); // merge any floating paste on the current doc first
    const idMap = new Map<string, string>();
    const images: { id: string; data: string }[] = [];
    const remap = (list: SerializedNode[]): LayerNode[] =>
      list.map((n) => {
        if (n.type === "group") {
          const id = `grp-${(layerSeqRef.current += 1)}`;
          idMap.set(n.id, id);
          return {
            id,
            type: "group",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            expanded: n.expanded,
            children: remap(n.children),
          };
        }
        const id = nextLeafId();
        idMap.set(n.id, id);
        if (n.data) images.push({ id, data: n.data });
        return {
          id,
          type: "layer",
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
        };
      });

    const layers = remap(p.layers);
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const activeLayerId = p.activeLayerId ? (idMap.get(p.activeLayerId) ?? null) : null;
    const selectedLayerIds = (p.selectedLayerIds ?? [])
      .map((i) => idMap.get(i))
      .filter((x): x is string => !!x);
    const doc: Doc = {
      id: docId,
      name: p.name || `Untitled-${seq}`,
      width: p.width,
      height: p.height,
      layers,
      activeLayerId,
      selectedLayerIds,
      selection: p.selection ?? [],
    };
    setDocs((ds) => [...ds, doc]);
    setActiveId(docId);
    if (p.foreground) setForeground(p.foreground);
    if (p.background) setBackground(p.background);
    setPendingLoads((ls) => [...ls, { docId, images }]);
  };

  // Parse + validate .aproj text and load it. Returns whether it succeeded.
  const loadProjectText = (text: string): boolean => {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.format !== "aperture-project" || !Array.isArray(parsed.layers)) {
        window.alert("This file isn't a valid Aperture project (.aproj).");
        return false;
      }
      loadProject(parsed as ProjectFile);
      return true;
    } catch {
      window.alert("Couldn't open the file — it may be corrupted.");
      return false;
    }
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-opened later
    if (!file) return;
    if (loadProjectText(await file.text())) addRecent(file.name, { blob: file });
  };

  // ---- Export (flatten → image file) ----
  const openExport = () => {
    const composite = paintRef.current?.exportComposite(activeDocRef.current.layers);
    if (composite) setExportComposite(composite);
  };
  const doExport = async (opts: ExportOptions, filename: string) => {
    if (!exportComposite) return;
    const blob = await renderExport(exportComposite, opts);
    if (blob) {
      const base = filename.trim() || activeDocRef.current.name;
      await saveImageBlob(blob, `${base}.${opts.format.ext}`, opts.format);
    }
    setExportComposite(null);
  };

  // ---- Import (one or more image files) ----
  const stripExt = (n: string) => n.replace(/\.[^.]+$/, "") || "Image";
  const openImport = () => importInputRef.current?.click();

  const onImportPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    const decoded = await Promise.all(
      files.map(async (f) => ({ name: f.name, bitmap: await decodeImageFile(f) })),
    );
    const items = decoded.filter((d): d is ImportItem => d.bitmap !== null);
    if (!items.length) {
      window.alert("Couldn't read the selected image(s).");
      return;
    }
    setImportItems(items);
  };

  // Import images onto new layers of the current canvas (one undoable step).
  const importAsLayers = (items: ImportItem[]) => {
    const before = active.layers;
    const leaves: Layer[] = items.map((it) => ({
      id: nextLeafId(),
      type: "layer",
      name: stripExt(it.name),
      visible: true,
      opacity: 100,
      blend: "Normal",
    }));
    const after = [...leaves, ...before]; // first image on top
    commitLayerChange(
      items.length > 1 ? "Import Layers" : "Import Layer",
      before,
      selNow(),
      after,
      { active: leaves[0].id, selected: leaves.map((l) => l.id) },
      () => leaves.forEach((leaf, i) => paintRef.current?.setLayerImage(leaf.id, items[i].bitmap)),
    );
  };

  // Import each image as its own new canvas/tab.
  const importAsCanvases = (items: ImportItem[]) => {
    const entries: PendingLoad[] = [];
    let firstId: string | null = null;
    const docs: Doc[] = items.map((it) => {
      const seq = (seqRef.current += 1);
      const docId = `doc-${seq}`;
      const lid = nextLeafId();
      if (!firstId) firstId = docId;
      entries.push({ docId, images: [{ id: lid, source: it.bitmap }] });
      return {
        id: docId,
        name: stripExt(it.name),
        width: it.bitmap.width,
        height: it.bitmap.height,
        layers: [{ id: lid, type: "layer", name: stripExt(it.name), visible: true, opacity: 100, blend: "Normal" }],
        activeLayerId: lid,
        selectedLayerIds: [lid],
        selection: [],
      };
    });
    setDocs((ds) => [...ds, ...docs]);
    if (firstId) setActiveId(firstId);
    setPendingLoads((ls) => [...ls, ...entries]);
  };

  const applyImport = (mode: ImportMode) => {
    const items = importItems;
    setImportItems(null);
    if (!items?.length) return;
    if (mode === "layers") importAsLayers(items);
    else importAsCanvases(items);
  };

  // ---- Adjustments (live preview on the active leaf, baked on Apply) ----
  const previewAdjust = (next: Adjustments) => {
    if (activeLeafId) paintRef.current?.applyAdjust(activeLeafId, next);
  };
  const onAdjust = (patch: Partial<Adjustments>) => {
    const next = { ...adjust, ...patch };
    setAdjust(next);
    setAdjustFilter(""); // tweaking a slider clears the active filter chip
    previewAdjust(next);
  };
  const onAdjustFilter = (name: string) => {
    const next = filterToAdjust(name);
    setAdjust(next);
    setAdjustFilter(name);
    previewAdjust(next);
  };
  const onAdjustApply = () => {
    if (activeLeafId) paintRef.current?.commitAdjust(activeLeafId, adjust);
    setAdjust(DEFAULT_ADJUST);
    setAdjustFilter("Original");
  };
  const onAdjustReset = () => {
    paintRef.current?.cancelAdjust();
    setAdjust(DEFAULT_ADJUST);
    setAdjustFilter("Original");
  };

  // Discard an unapplied preview when switching layer or document.
  useEffect(() => {
    if (!isDefaultAdjust(adjust)) {
      paintRef.current?.cancelAdjust();
      setAdjust(DEFAULT_ADJUST);
      setAdjustFilter("Original");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.activeLayerId, activeId]);

  const handleMenuAction = (actionId: string) => {
    const al = active.activeLayerId;
    if (actionId === "canvas-size") setSizeDialogOpen(true);
    else if (actionId === "new-doc") createDoc();
    else if (actionId === "open") openProject();
    else if (actionId === "open-recent") setRecentsOpen(true);
    else if (actionId === "save") saveProject();
    else if (actionId === "save-as") setSaveAsOpen(true);
    else if (actionId === "import") openImport();
    else if (actionId === "export-as") openExport();
    else if (actionId === "undo") doUndo();
    else if (actionId === "redo") doRedo();
    else if (actionId === "layer-new") addLayerOp();
    else if (actionId === "layer-duplicate") duplicateSelected();
    else if (actionId === "layer-delete") removeSelected();
    else if (actionId === "layer-group") groupSelected();
    else if (actionId === "layer-ungroup") {
      if (al) ungroupLayerOp(al);
    } else if (actionId === "layer-merge-down") mergeSelected();
    else if (actionId === "layer-flatten") flattenImage();
  };

  const swapColors = () => {
    const f = fgRef.current;
    setForeground(bgRef.current);
    setBackground(f);
  };

  const commitFloatIfAny = () => {
    if (paintRef.current?.isFloating()) paintRef.current.commitFloat();
  };

  // Paste images from the clipboard (Ctrl+V fires a native paste event).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      let blob: Blob | null = null;
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            blob = items[i].getAsFile();
            break;
          }
        }
      }
      // An in-app copy from the current canvas pastes straight onto the current
      // layer (in place) without the options dialog.
      const sameCanvas = clipboardRef.current !== null && copyDocIdRef.current === activeIdRef.current;
      const origin = copyOriginRef.current;
      if (blob) {
        e.preventDefault();
        createImageBitmap(blob)
          .then((bmp) => {
            const cb = clipboardRef.current;
            const matchesInternal = !!cb && bmp.width === cb.width && bmp.height === cb.height;
            if (sameCanvas && matchesInternal) {
              doPaste(bmp, bmp.width, bmp.height, "current-layer", false, origin.x, origin.y);
            } else {
              setPasteSrc({ source: bmp, w: bmp.width, h: bmp.height });
            }
          })
          .catch(() => {});
      } else if (clipboardRef.current) {
        e.preventDefault();
        const c = clipboardRef.current;
        if (sameCanvas) {
          doPaste(c, c.width, c.height, "current-layer", false, origin.x, origin.y);
        } else {
          setPasteSrc({ source: c, w: c.width, h: c.height });
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore only while typing into a text field (not sliders/selects/etc.).
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.isContentEditable ||
          t.tagName === "TEXTAREA" ||
          (t.tagName === "INPUT" &&
            /^(?:text|number|search|email|url|password|tel|)$/i.test((t as HTMLInputElement).type)));
      if (typing) return;

      // Match the produced character (e.key), not the physical position (e.code),
      // so letter shortcuts are correct on QWERTZ/AZERTY etc. (Z/Y aren't swapped).
      const key = e.key.toLowerCase();

      if (e.ctrlKey && e.altKey && key === "z") {
        e.preventDefault();
        setSizeDialogOpen(true);
      } else if (e.ctrlKey && !e.shiftKey && key === "n") {
        // Browsers reserve Ctrl+N (new window) and won't let a normal tab
        // preventDefault it, so Ctrl+Alt+N is the reliable "new canvas". The
        // plain Ctrl+N branch still works where it's allowed (e.g. PWA window).
        e.preventDefault();
        createDoc();
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && key === "s") {
        e.preventDefault();
        setSaveAsOpen(true);
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "s") {
        e.preventDefault();
        saveProject();
      } else if (e.ctrlKey && !e.altKey && key === "o") {
        e.preventDefault();
        openProject();
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && key === "e") {
        e.preventDefault();
        openExport();
      } else if (e.ctrlKey && key === "y") {
        e.preventDefault();
        doRedo();
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && key === "z") {
        e.preventDefault();
        doRedo();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "z") {
        e.preventDefault();
        doUndo();
      } else if (e.ctrlKey && !e.altKey && key === "c" && selRef.current.length) {
        e.preventDefault();
        copySelection();
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && key === "x") {
        e.preventDefault();
        swapColors();
      } else if (e.code === "Escape") {
        // Exiting the selection merges a floating paste down.
        if (paintRef.current?.isFloating()) {
          e.preventDefault();
          paintRef.current.commitFloat();
          setSelection([]);
        } else if (selRef.current.length) {
          e.preventDefault();
          setSelection([]);
        }
      } else if (e.code === "Delete") {
        if (selRef.current.length && activeLayerRef.current) {
          e.preventDefault();
          commitFloatIfAny();
          paintRef.current?.eraseSelection(activeLayerRef.current, selRef.current);
        }
      } else if (e.code === "Backspace") {
        if (selRef.current.length) {
          e.preventDefault();
          commitFloatIfAny();
          paintRef.current?.fillSelection(ensureLayer(), selRef.current, fgRef.current);
        }
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        // Single-key tool shortcuts (V move, M marquee, B brush, …).
        const id = TOOL_BY_KEY[e.key.toLowerCase()];
        if (id) {
          e.preventDefault();
          setTool(id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active tool's brush dynamics (brush vs eraser have independent settings).
  const activeBrush = tool === "eraser" ? eraser : brush;
  const setActiveBrush = tool === "eraser" ? setEraser : setBrush;

  return (
    <div className={styles.app}>
      <TopBar
        initialTheme={initialTheme}
        onMenuAction={handleMenuAction}
        onUndo={doUndo}
        onRedo={doRedo}
        canUndo={history.index > 0}
        canRedo={history.index < history.items.length - 1}
      />
      <OptionsBar
        tool={tool}
        foreground={foreground}
        onForeground={setForeground}
        brush={activeBrush}
        onBrush={setActiveBrush}
        moveMode={moveMode}
        onMoveMode={setMoveMode}
        resizeMode={resizeMode}
        onResizeMode={setResizeMode}
        resizeSmooth={resizeSmooth}
        onResizeSmooth={setResizeSmooth}
        eyedropper={{ size: sampleSizeLabel, scope: sampleScopeLabel }}
        onEyedropper={(patch) => {
          if (patch.size !== undefined) setSampleSizeLabel(patch.size);
          if (patch.scope !== undefined) setSampleScopeLabel(patch.scope);
        }}
      />
      <div className={styles.body}>
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          foreground={foreground}
          background={background}
          onForeground={setForeground}
          onBackground={setBackground}
          onSwap={() => {
            setForeground(background);
            setBackground(foreground);
          }}
        />
        <CanvasArea
          docs={docs}
          activeId={activeId}
          onSelectDoc={(id) => {
            commitFloatIfAny();
            setActiveId(id);
          }}
          onCloseDoc={closeDoc}
          onNewDoc={createDoc}
          onRenameDoc={renameDoc}
          zoom={zoom}
          onZoomChange={setZoom}
          width={active.width}
          height={active.height}
          pan={pan}
          setPan={setPan}
          onViewport={setViewport}
          tool={tool}
          brush={activeBrush}
          color={foreground}
          layers={active.layers}
          activeLayerId={active.activeLayerId}
          ensureLayer={ensureLayer}
          selection={active.selection}
          onSelectionChange={setSelection}
          moveMode={moveMode}
          resizeMode={resizeMode}
          resizeSmooth={resizeSmooth}
          sampleSize={SAMPLE_SIZE_PX[sampleSizeLabel] ?? 1}
          sampleAllLayers={sampleScopeLabel === "All layers"}
          onPick={setForeground}
          pendingPaste={pendingPaste}
          onPasteDone={() => setPendingPaste(null)}
          pendingLoads={pendingLoads}
          onLoadDone={(docId) => setPendingLoads((ls) => ls.filter((p) => p.docId !== docId))}
          paintRef={paintRef}
          onHistory={setHistory}
        />
        <RightDock
          foreground={foreground}
          background={background}
          onForeground={setForeground}
          onBackground={setBackground}
          layers={layersApi}
          history={history}
          onHistoryJump={(i) => paintRef.current?.jumpTo(i)}
          view={{
            zoom,
            pan,
            setPan,
            vpW: viewport.w,
            vpH: viewport.h,
            docW: active.width,
            docH: active.height,
          }}
          adjust={adjust}
          onAdjust={onAdjust}
          adjustFilter={adjustFilter}
          onAdjustFilter={onAdjustFilter}
          onAdjustApply={onAdjustApply}
          onAdjustReset={onAdjustReset}
          adjustActive={!!activeLeafId}
        />
      </div>
      <StatusBar
        tool={tool}
        zoom={zoom}
        onZoomChange={setZoom}
        foreground={foreground}
        width={active.width}
        height={active.height}
      />

      {sizeDialogOpen && (
        <CanvasSizeDialog
          size={{ width: active.width, height: active.height }}
          onApply={setActiveSize}
          onClose={() => setSizeDialogOpen(false)}
        />
      )}

      {pasteSrc && (
        <PasteDialog
          width={pasteSrc.w}
          height={pasteSrc.h}
          docWidth={active.width}
          docHeight={active.height}
          source={pasteSrc.source}
          onApply={applyPaste}
          onClose={() => setPasteSrc(null)}
        />
      )}

      {saveAsOpen && (
        <SaveAsDialog
          defaultName={active.name}
          onSave={saveProjectAs}
          onClose={() => setSaveAsOpen(false)}
        />
      )}

      {recentsOpen && (
        <RecentsDialog onOpenText={loadProjectText} onClose={() => setRecentsOpen(false)} />
      )}

      {exportComposite && (
        <ExportDialog
          composite={exportComposite}
          defaultName={active.name}
          onExport={doExport}
          onClose={() => setExportComposite(null)}
        />
      )}

      {importItems && (
        <ImportDialog items={importItems} onImport={applyImport} onClose={() => setImportItems(null)} />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={`.${PROJECT_EXT},application/json`}
        onChange={onFilePicked}
        hidden
      />
      <input
        ref={importInputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        onChange={onImportPicked}
        hidden
      />
    </div>
  );
}
