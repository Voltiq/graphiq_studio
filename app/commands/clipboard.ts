// The clipboard family (TODO 1.10): copy the selection (or the canvas), cut
// it, and paste — in place onto the current layer when it came from this
// canvas, otherwise as the Preferences or the paste dialog decide: a new
// layer, the current layer (floating), or a canvas of its own. A float is put
// down before what follows it; undo takes a float back first.
//
// `clipboardOps` is called on every render of Editor, as `layerOps` is. The
// clipboard itself, the native paste listener and the refs are Editor's.

import type { PasteDest } from "../components/PasteDialog";
import type { Layer } from "../lib/layers";
import type { EngineHandle, PendingPaste } from "../lib/paint";
import type { Preferences } from "../lib/prefs";
import type { ToolId } from "../lib/tools";
import type { Rect } from "../lib/view";
import type { DialogState } from "../state/dialogs";
import type { Doc, DocumentsState } from "../state/documents";
import type { Store } from "../state/store";

/** What the clipboard and history operations need of the editor. */
export interface ClipboardContext {
  documents: Store<DocumentsState>;
  /** The active document's id — the latest, read when an operation runs. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  /** The active document's selection, and its active layer — the latest. */
  selRef: { readonly current: Rect[] };
  activeLayerRef: { readonly current: string | null };
  prefsRef: { readonly current: Preferences };
  /** What new documents and layers are numbered from. */
  seqRef: { current: number };
  layerSeqRef: { current: number };
  /** The last in-app copy, where it came from, and from which document. */
  clipboardRef: { current: HTMLCanvasElement | null };
  copyOriginRef: { current: { x: number; y: number } };
  copyDocIdRef: { current: string | null };
  /** The paste dialog's picture, while it asks. */
  pasteSrc: DialogState["pasteSrc"];
  setPasteSrc(src: DialogState["pasteSrc"]): void;
  setPendingPaste(paste: PendingPaste | null): void;
  setSelection(rects: Rect[]): void;
  setActiveId(id: string): void;
  setTool(tool: ToolId): void;
}

export function clipboardOps(ctx: ClipboardContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    selRef,
    activeLayerRef,
    prefsRef,
    seqRef,
    layerSeqRef,
    clipboardRef,
    copyOriginRef,
    copyDocIdRef,
    pasteSrc,
    setPasteSrc,
    setPendingPaste,
    setSelection,
    setActiveId,
    setTool,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  // Copy the composite within the selection (or whole canvas) to the clipboard.
  const copySelection = () => {
    const d = activeDocRef.current;
    const res = paintRef.current?.copyRegion(
      selRef.current.length ? selRef.current : null,
      d.selectionAngle,
      d.selectionPivot,
    );
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

  // Cut: copy the selection to the clipboard, then erase it from the active layer
  // (recorded as an undoable "Cut" history step). Needs a selection + a layer.
  const cutSelection = () => {
    if (!selRef.current.length || !activeLayerRef.current) return;
    commitFloatIfAny(); // merge any floating paste before cutting
    copySelection();
    const d = activeDocRef.current;
    paintRef.current?.eraseSelection(
      activeLayerRef.current,
      selRef.current,
      d.selectionAngle,
      d.selectionPivot,
      "Cut",
    );
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
        { id: docId, name: `Untitled-${seq}`, width: imgW, height: imgH, dpi: prefsRef.current.defaultDpi, layers: [layer], activeLayerId: layerId, selectedLayerIds: [layerId], selection: [], selectionAngle: 0, selectionPivot: null },
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

  const doUndo = () => {
    if (paintRef.current?.isFloating()) {
      // A floating paste/move isn't committed yet — undo cancels it.
      paintRef.current.discardFloat();
      setSelection([]);
      return;
    }
    // A live adjustment session is finalized inside the engine's jumpTo, so
    // undo steps over it as one "Adjustments" entry.
    paintRef.current?.undo();
  };
  const doRedo = () => paintRef.current?.redo();

  const commitFloatIfAny = () => {
    if (paintRef.current?.isFloating()) paintRef.current.commitFloat();
  };

  // Place clipboard content: an in-app copy from the current canvas pastes
  // straight onto the current layer (in place); anything else opens the paste
  // options dialog.
  const placePaste = (source: ImageBitmap | HTMLCanvasElement, w: number, h: number) => {
    const cb = clipboardRef.current;
    const sameCanvas = cb !== null && copyDocIdRef.current === activeIdRef.current;
    const matchesInternal = source === cb || (!!cb && w === cb.width && h === cb.height);
    if (sameCanvas && matchesInternal) {
      const origin = copyOriginRef.current;
      doPaste(source, w, h, "current-layer", false, origin.x, origin.y);
    } else {
      // Honour the user's default-paste preference, else ask via the dialog.
      const def = prefsRef.current.defaultPaste;
      if (def === "ask") {
        setPasteSrc({ source, w, h });
        return;
      }
      // Destination is defaulted. If the image is larger than the canvas the
      // oversize preference decides: keep (crop), expand, or ask just that.
      const d = activeDocRef.current;
      const oversize = def !== "new-canvas" && (w > d.width || h > d.height);
      if (!oversize) {
        doPaste(source, w, h, def, false);
        return;
      }
      const ov = prefsRef.current.pasteOversize;
      if (ov === "ask") setPasteSrc({ source, w, h, dest: def });
      else doPaste(source, w, h, def, ov === "expand");
    }
  };

  // Paste from the Edit menu: read the OS clipboard (a menu click is a user
  // gesture, so navigator.clipboard.read is allowed), falling back to the last
  // in-app copy/cut when the OS clipboard is empty or unreadable.
  const pasteFromClipboard = async () => {
    try {
      if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const bmp = await createImageBitmap(await item.getType(type));
            placePaste(bmp, bmp.width, bmp.height);
            return;
          }
        }
      }
    } catch {
      /* clipboard unreadable (permission / focus) — fall back to the internal one */
    }
    const c = clipboardRef.current;
    if (c) placePaste(c, c.width, c.height);
  };

  return {
    copySelection,
    cutSelection,
    applyPaste,
    doUndo,
    doRedo,
    commitFloatIfAny,
    placePaste,
    pasteFromClipboard,
  };
}
