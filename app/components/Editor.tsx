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
import type { Layer, LayersApi } from "../lib/layers";
import type { BrushSettings, EngineHandle, HistorySummary, PendingPaste } from "../lib/paint";

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
  layers: Layer[];
  activeLayerId: string | null;
  selection: Rect[];
}

const makeDoc = (seq: number): Doc => ({
  id: `doc-${seq}`,
  name: `Untitled-${seq}`,
  width: 1920,
  height: 1080,
  layers: [],
  activeLayerId: null,
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
  const [moveMode, setMoveMode] = useState<MoveMode>("pixels");
  const [resizeMode, setResizeMode] = useState<SelectResizeMode>("bounds");
  const [resizeSmooth, setResizeSmooth] = useState(true);
  const [sampleSizeLabel, setSampleSizeLabel] = useState("Point sample");
  const [sampleScopeLabel, setSampleScopeLabel] = useState("All layers");
  const [pasteSrc, setPasteSrc] = useState<PasteSrc | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  // Internal clipboard fallback (used if the OS clipboard write/read fails).
  const clipboardRef = useRef<HTMLCanvasElement | null>(null);

  // Imperative handle into the paint engine (set by CanvasArea).
  const paintRef = useRef<EngineHandle | null>(null);
  // Latest colours, reachable from the one-time keydown listener.
  const fgRef = useRef(foreground);
  const bgRef = useRef(background);
  fgRef.current = foreground;
  bgRef.current = background;

  // Open documents. Starts with a single, unnamed canvas.
  const [docs, setDocs] = useState<Doc[]>(() => [makeDoc(1)]);
  const [activeId, setActiveId] = useState("doc-1");
  const seqRef = useRef(1);
  const layerSeqRef = useRef(0);

  const active = docs.find((d) => d.id === activeId) ?? docs[0];

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

  const layersApi: LayersApi = {
    layers: active.layers,
    activeLayerId: active.activeLayerId,
    add: () => {
      const seq = (layerSeqRef.current += 1);
      const layer: Layer = {
        id: `layer-${seq}`,
        name: `Layer ${seq}`,
        visible: true,
        opacity: 100,
        blend: "Normal",
      };
      patchActiveDoc((d) => {
        const idx = d.activeLayerId ? d.layers.findIndex((l) => l.id === d.activeLayerId) : -1;
        const layers = d.layers.slice();
        layers.splice(idx === -1 ? 0 : idx, 0, layer); // new layer sits above the active one
        return { ...d, layers, activeLayerId: layer.id };
      });
    },
    remove: (id) =>
      patchActiveDoc((d) => {
        const idx = d.layers.findIndex((l) => l.id === id);
        if (idx === -1) return d;
        const layers = d.layers.filter((l) => l.id !== id);
        const activeLayerId =
          id === d.activeLayerId
            ? layers.length
              ? layers[Math.min(idx, layers.length - 1)].id
              : null
            : d.activeLayerId;
        return { ...d, layers, activeLayerId };
      }),
    select: (id) => {
      commitFloatIfAny();
      patchActiveDoc((d) => ({ ...d, activeLayerId: id }));
    },
    update: (id, patch) =>
      patchActiveDoc((d) => ({
        ...d,
        layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      })),
    move: (fromId, targetId, before) =>
      patchActiveDoc((d) => {
        const layers = d.layers.slice();
        const from = layers.findIndex((l) => l.id === fromId);
        if (from === -1) return d;
        const [moved] = layers.splice(from, 1);
        let to = layers.findIndex((l) => l.id === targetId);
        if (to === -1) return d;
        if (!before) to += 1;
        layers.splice(to, 0, moved);
        const unchanged =
          layers.length === d.layers.length && layers.every((l, i) => l.id === d.layers[i].id);
        return unchanged ? d : { ...d, layers };
      }),
  };

  // Return the active layer id, creating a layer first if none is selected.
  // Uses refs so it is safe to call from the global keydown listener too.
  const ensureLayer = (): string => {
    if (activeLayerRef.current) return activeLayerRef.current;
    const seq = (layerSeqRef.current += 1);
    const id = `layer-${seq}`;
    const layer: Layer = { id, name: `Layer ${seq}`, visible: true, opacity: 100, blend: "Normal" };
    setDocs((ds) =>
      ds.map((d) =>
        d.id === activeIdRef.current
          ? { ...d, layers: [layer, ...d.layers], activeLayerId: id }
          : d,
      ),
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
      const layer: Layer = { id: layerId, name: "Pasted Layer", visible: true, opacity: 100, blend: "Normal" };
      setDocs((ds) => [
        ...ds,
        { id: docId, name: `Untitled-${seq}`, width: imgW, height: imgH, layers: [layer], activeLayerId: layerId, selection: [] },
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

  const handleMenuAction = (actionId: string) => {
    if (actionId === "canvas-size") setSizeDialogOpen(true);
    else if (actionId === "new-doc") createDoc();
    else if (actionId === "undo") doUndo();
    else if (actionId === "redo") doRedo();
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
    </div>
  );
}
