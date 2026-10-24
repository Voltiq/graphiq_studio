// The sessions family (TODO 1.10): the editors that hold a layer while they
// are open — the Blur Gallery (a live preview session in the engine: the
// layers' originals kept, re-blurred as the settings change, committed on
// Apply, put back on Cancel), Liquify and Warp (the layer's pixels handed to
// the dialog, its result applied as one step).
//
// `sessionOps` is called on every render of Editor, as `layerOps` is. The
// Blur Gallery's refs are Editor's hooks, passed in.

import { collectLeafIds, findNode } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { BLUR_FX_LABELS, type BlurFxScope, type BlurFxSettings } from "../lib/tools";
import type { Doc } from "../state/documents";
import type { DialogState } from "../state/dialogs";
/** What the session operations need of the editor. */
export interface SessionContext {
  /** The active document — the latest, read when an operation runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  /** The Blur Gallery's settings, as this render sees them. */
  blurFx: BlurFxSettings;
  setBlurFx(settings: BlurFxSettings): void;
  setBlurPreview(preview: HTMLCanvasElement | null): void;
  setBlurFxOpen(open: boolean): void;
  /** Whether the gallery is open — the latest, for a preview that lands late. */
  blurFxOpenRef: { readonly current: boolean };
  /** The layers the engine's blur session holds, and the pending re-render. */
  blurFxSessionRef: { current: string[] | null };
  blurFxTimerRef: { current: number };
  /** The layer Liquify or Warp is open on, as this render sees it. */
  liquify: DialogState["liquify"];
  setLiquify(session: DialogState["liquify"]): void;
  warping: DialogState["warping"];
  setWarping(session: DialogState["warping"]): void;
}

export function sessionOps(ctx: SessionContext) {
  const {
    activeDocRef,
    paintRef,
    showToast,
    blurFx,
    setBlurFx,
    setBlurPreview,
    setBlurFxOpen,
    blurFxOpenRef,
    blurFxSessionRef,
    blurFxTimerRef,
    liquify,
    setLiquify,
    warping,
    setWarping,
  } = ctx;

  // ---- Blur Gallery (Effects ▸ Blur Gallery) ----
  // Live preview via an engine session: the affected layers' originals are kept,
  // re-blurred on each change (debounced), committed on Apply, restored on Cancel.
  const blurFxIds = (scope: BlurFxScope): string[] => {
    const d = activeDocRef.current;
    return scope === "canvas" ? collectLeafIds(d.layers) : d.activeLayerId ? [d.activeLayerId] : [];
  };
  const ensureBlurSession = (scope: BlurFxScope) => {
    const ids = blurFxIds(scope);
    const cur = blurFxSessionRef.current;
    const same = !!cur && cur.length === ids.length && cur.every((id, i) => id === ids[i]);
    if (same) return;
    if (cur) paintRef.current?.cancelBlurFx(); // restore the previous scope's pixels
    const d = activeDocRef.current;
    paintRef.current?.beginBlurFx(
      ids,
      d.selection.length ? d.selection : null,
      d.selectionAngle,
      d.selectionPivot,
    );
    blurFxSessionRef.current = ids;
  };
  const renderBlurPreview = (s: BlurFxSettings, immediate = false) => {
    ensureBlurSession(s.scope);
    window.clearTimeout(blurFxTimerRef.current);
    const run = async () => {
      // Off the UI thread (worker); superseded renders resolve false and skip
      // the (also non-trivial) composite snapshot — only the newest one lands.
      const applied = await paintRef.current?.previewBlurFxAsync(
        s.kind,
        s.amount,
        s.angle,
        s.anchor.x,
        s.anchor.y,
        { band: s.band, feather: s.feather, threshold: s.threshold },
      );
      if (!applied || !blurFxOpenRef.current) return;
      // Snapshot the composited result for the dialog's preview pane.
      setBlurPreview(paintRef.current?.exportComposite(activeDocRef.current.layers) ?? null);
    };
    if (immediate) run();
    else blurFxTimerRef.current = window.setTimeout(run, 90);
  };
  const openBlurFx = () => {
    const d = activeDocRef.current;
    if (!d.layers.length) return; // nothing to blur
    // Default the zoom/spin centre to the selection's centre, else the canvas centre.
    let anchor = { x: 0.5, y: 0.5 };
    if (d.selection.length) {
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
      anchor = { x: (x0 + x1) / 2 / d.width, y: (y0 + y1) / 2 / d.height };
    }
    const next = { ...blurFx, anchor };
    setBlurFx(next);
    setBlurPreview(null); // show the dialog's "rendering" state until the first preview
    blurFxSessionRef.current = null; // force a fresh snapshot
    setBlurFxOpen(true);
    // Pop the dialog instantly, THEN do the (possibly heavy) snapshot + first
    // preview — a double rAF lets the dialog paint before that work runs.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (blurFxOpenRef.current) renderBlurPreview(next, true);
      }),
    );
  };
  const changeBlurFx = (patch: Partial<BlurFxSettings>) => {
    const next = { ...blurFx, ...patch };
    setBlurFx(next);
    renderBlurPreview(next);
  };
  const applyBlurFx = async () => {
    window.clearTimeout(blurFxTimerRef.current);
    ensureBlurSession(blurFx.scope);
    // Flush the newest parameters (worker or sync) before committing.
    await paintRef.current?.previewBlurFxAsync(
      blurFx.kind,
      blurFx.amount,
      blurFx.angle,
      blurFx.anchor.x,
      blurFx.anchor.y,
      { band: blurFx.band, feather: blurFx.feather, threshold: blurFx.threshold },
    );
    paintRef.current?.commitBlurFx(`${BLUR_FX_LABELS[blurFx.kind]} Blur`);
    blurFxSessionRef.current = null;
    setBlurPreview(null);
    setBlurFxOpen(false);
  };
  const closeBlurFx = () => {
    window.clearTimeout(blurFxTimerRef.current);
    paintRef.current?.cancelBlurFx();
    blurFxSessionRef.current = null;
    setBlurPreview(null);
    setBlurFxOpen(false);
  };

  // ---- Liquify (modal warp-mesh editor on the active pixel layer) ----------
  const openLiquify = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    const node = id ? findNode(d.layers, id) : null;
    if (!node || node.type !== "layer") {
      showToast("Select a pixel layer to liquify.");
      return;
    }
    if (node.vector) {
      showToast("Liquify needs plain pixels — rasterize the vector layer first.");
      return;
    }
    const canvas = paintRef.current?.getLayerCanvas(id!);
    if (!canvas) return;
    setLiquify({ layerId: id!, name: node.name, canvas });
  };
  const openWarp = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    const node = id ? findNode(d.layers, id) : null;
    if (!node || node.type !== "layer") {
      showToast("Select a pixel layer to warp.");
      return;
    }
    if (node.vector) {
      showToast("Warp needs plain pixels — rasterize the vector layer first.");
      return;
    }
    const canvas = paintRef.current?.getLayerCanvas(id!);
    if (!canvas) return;
    setWarping({ layerId: id!, name: node.name, canvas });
  };
  const applyWarp = (result: HTMLCanvasElement) => {
    const wp = warping;
    setWarping(null);
    if (!wp) return;
    if (!findNode(activeDocRef.current.layers, wp.layerId)) return;
    paintRef.current?.applyLayerImage(wp.layerId, result, "Warp");
  };

  const applyLiquify = (result: HTMLCanvasElement) => {
    const lq = liquify;
    setLiquify(null);
    if (!lq) return;
    // The layer may have been deleted while the dialog was open.
    if (!findNode(activeDocRef.current.layers, lq.layerId)) return;
    paintRef.current?.applyLayerImage(lq.layerId, result, "Liquify");
  };

  return {
    openBlurFx,
    changeBlurFx,
    applyBlurFx,
    closeBlurFx,
    openLiquify,
    openWarp,
    applyWarp,
    applyLiquify,
  };
}
