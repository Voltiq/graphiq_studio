// The image family (TODO 1.10): the whole image rotated and flipped, cropped
// to the selection or trimmed of a border (one crop, shared), Free Transform
// and Transform Selection begun, and Content-Aware Fill.
//
// `imageOps` is called on every render of Editor, as `layerOps` is.

import type { TrimMode, TrimSides } from "../components/TrimDialog";
import { collectLeafIds, findNode } from "../lib/layers";
import type { EngineHandle, ImageTransform } from "../lib/paint";
import type { SelectResizeMode, ToolId } from "../lib/tools";
import type { Rect } from "../lib/view";
import type { Doc, DocumentsState } from "../state/documents";
import type { Store } from "../state/store";

/** What the image operations need of the editor. */
export interface ImageContext {
  documents: Store<DocumentsState>;
  /** The active document's id — the latest, read when a step is made. */
  activeIdRef: { readonly current: string };
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  setSelection(rects: Rect[]): void;
  /** What the marquee's handles transform: the outline, or the pixels in it. */
  setResizeMode(mode: SelectResizeMode): void;
  setTool(tool: ToolId): void;
  /** Put a floating paste or move down before a transform begins. */
  commitFloatIfAny(): void;
}

export function imageOps(ctx: ImageContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    setSelection,
    setResizeMode,
    setTool,
    commitFloatIfAny,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  // Whole-image rotate / flip (Image menu). The engine transforms every layer
  // (90° rotations swap the dimensions), then the doc adopts the new size so the
  // follow-up setDoc is a no-op. Folded into one undoable history step whose undo
  // applies the inverse transform (pixel-exact for 90° rotations & flips).
  const TRANSFORM_LABEL: Record<ImageTransform, string> = {
    "rotate-cw": "Rotate 90° CW",
    "rotate-ccw": "Rotate 90° CCW",
    "flip-h": "Flip Horizontal",
    "flip-v": "Flip Vertical",
  };
  const INVERSE_TRANSFORM: Record<ImageTransform, ImageTransform> = {
    "rotate-cw": "rotate-ccw",
    "rotate-ccw": "rotate-cw",
    "flip-h": "flip-h",
    "flip-v": "flip-v",
  };
  const applyImageTransform = (kind: ImageTransform) => {
    const d = activeDocRef.current;
    if (!d.layers.length) return;
    const eng = paintRef.current;
    if (!eng) return;
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const rot = kind === "rotate-cw" || kind === "rotate-ccw";
    // Swap (rotations) or keep (flips) the doc dimensions; clear the selection.
    const setDims = () =>
      setDocs((ds) =>
        ds.map((x) =>
          x.id === docId
            ? {
                ...x,
                width: rot ? x.height : x.width,
                height: rot ? x.width : x.height,
                selection: [],
                selectionAngle: 0,
                selectionPivot: null,
              }
            : x,
        ),
      );
    const forward = () => {
      eng.transformImage(kind, leafIds);
      setDims();
    };
    const backward = () => {
      eng.transformImage(INVERSE_TRANSFORM[kind], leafIds);
      setDims(); // swapping w/h twice (or keeping it) returns the original size
    };
    forward();
    eng.pushStructural(TRANSFORM_LABEL[kind], backward, forward);
  };

  // Image ▸ Crop — crop the canvas to the current selection's (axis-aligned) bounds.
  const cropToSelection = () => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Crop trims the canvas to the selection — make a selection first.");
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of d.selection) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    // A rotated selection: take the axis-aligned bounds of the rotated corners.
    if (d.selectionAngle) {
      const c = d.selectionPivot ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      const cos = Math.cos(d.selectionAngle);
      const sin = Math.sin(d.selectionAngle);
      const corners: [number, number][] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      x0 = Infinity;
      y0 = Infinity;
      x1 = -Infinity;
      y1 = -Infinity;
      for (const [px, py] of corners) {
        const rx = c.x + (px - c.x) * cos - (py - c.y) * sin;
        const ry = c.y + (px - c.x) * sin + (py - c.y) * cos;
        x0 = Math.min(x0, rx);
        y0 = Math.min(y0, ry);
        x1 = Math.max(x1, rx);
        y1 = Math.max(y1, ry);
      }
    }
    cropToRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, "Crop");
  };

  // Image ▸ Trim — crop away a uniform border (transparent, or a corner colour),
  // on the chosen sides. Scans the composited image for the content bounds.
  const trimImage = (mode: TrimMode, sides: TrimSides) => {
    const d = activeDocRef.current;
    const comp = paintRef.current?.exportComposite(d.layers);
    const ctx = comp?.getContext("2d");
    if (!comp || !ctx) return;
    const w = comp.width;
    const h = comp.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const ref = mode === "bottom-right" ? ((h - 1) * w + (w - 1)) * 4 : 0;
    const rr = data[ref];
    const rg = data[ref + 1];
    const rb = data[ref + 2];
    const ra = data[ref + 3];
    const trimmable = (i: number) =>
      mode === "transparent"
        ? data[i + 3] === 0
        : data[i] === rr && data[i + 1] === rg && data[i + 2] === rb && data[i + 3] === ra;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!trimmable((y * w + x) * 4)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      showToast("Nothing to trim — the image has no border to remove.");
      return;
    }
    const left = sides.left ? minX : 0;
    const top = sides.top ? minY : 0;
    const right = sides.right ? maxX + 1 : w;
    const bottom = sides.bottom ? maxY + 1 : h;
    cropToRect({ x: left, y: top, w: right - left, h: bottom - top }, "Trim");
  };

  // Crop the document to `rect` (clamped to the canvas), as one undoable step —
  // shared by the Crop tool, Image ▸ Crop and Image ▸ Trim.
  const cropToRect = (rect: Rect, label: string, angle = 0) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !d.layers.length) return;
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const r: Rect = {
      x,
      y,
      w: Math.max(1, Math.min(Math.round(rect.w), d.width - x)),
      h: Math.max(1, Math.min(Math.round(rect.h), d.height - y)),
    };
    if (angle === 0 && r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height) return; // no-op
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const snap = eng.cropSnapshot(leafIds);
    const setDims = (w: number, h: number) =>
      setDocs((ds) =>
        ds.map((x2) =>
          x2.id === docId
            ? { ...x2, width: w, height: h, selection: [], selectionAngle: 0, selectionPivot: null }
            : x2,
        ),
      );
    const redo = () => {
      eng.applyCrop(r, leafIds, angle);
      setDims(r.w, r.h);
    };
    const undo = () => {
      eng.cropRestore(snap);
      setDims(snap.w, snap.h);
    };
    redo();
    eng.pushStructural(label, undo, redo);
  };

  // Enter transform via the marquee's handles (drag a corner/edge to scale, the
  // ring to rotate). `content` true = Free Transform (moves the pixels); false =
  // Transform Selection (reshapes the marquee outline only). With no selection
  // there's no outline to reshape, so both transform the whole layer's content.
  const enterTransform = (content: boolean) => {
    const d = activeDocRef.current;
    if (!d.layers.length || !d.activeLayerId) return; // need a layer to transform
    commitFloatIfAny();
    const hasSel = d.selection.length > 0;
    if (!hasSel) setSelection([{ x: 0, y: 0, w: d.width, h: d.height }]);
    setResizeMode(content || !hasSel ? "content" : "bounds");
    setTool("select");
  };

  // Edit ▸ Content-Aware Fill: synthesize the selection from its surroundings.
  const contentAwareFillOp = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id || !d.selection.length) return;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "layer") return;
    paintRef.current?.contentAwareFill(id, d.selection, d.selectionAngle, d.selectionPivot);
  };

  return {
    applyImageTransform,
    cropToSelection,
    trimImage,
    enterTransform,
    contentAwareFillOp,
  };
}
