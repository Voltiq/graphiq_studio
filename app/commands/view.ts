// The view family (TODO 1.10): Quick Mask — the selection painted as a
// raster, per document, entered and left as steps — Isolate (a view state:
// the canvas shows the chosen layers alone, nothing in the document changes),
// and the guides' commit (each edit a step, kept with the document it was
// made in).
//
// `viewOps` is called on every render of Editor, as `layerOps` is; the state
// these change is Editor's.

import type { Guide } from "../lib/guides";
import { hiddenByIsolation, resolveIsolation } from "../lib/isolate";
import { quickMaskKey } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import type { Doc } from "../state/documents";
import type { SelState } from "./selection";
import type { DocumentsState } from "../state/documents";
import type { Store } from "../state/store";
/** What the view operations need of the editor. */
export interface ViewContext {
  documents: Store<DocumentsState>;
  /** The active document, as this render sees it. */
  active: Doc;
  /** The active document and its id — the latest, read when an operation runs. */
  activeIdRef: { readonly current: string };
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  showToast(message: string): void;
  selStateOf(d: Doc): SelState;
  setSelState(docId: string, s: SelState): void;
  /** Which documents are in Quick Mask. */
  setQuickMaskDocs(update: (docs: string[]) => string[]): void;
  /** What is isolated in the document in front, as this render sees it. */
  isolatedIds: string[] | null;
  setIsolate(isolate: { docId: string; ids: string[] } | null): void;
}

export function viewOps(ctx: ViewContext) {
  const {
    active,
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    selStateOf,
    setSelState,
    setQuickMaskDocs,
    isolatedIds,
    setIsolate,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  const markQuickMask = (docId: string, on: boolean) =>
    setQuickMaskDocs((ds) => (on ? (ds.includes(docId) ? ds : [...ds, docId]) : ds.filter((d) => d !== docId)));

  const toggleQuickMask = () => {
    const eng = paintRef.current;
    if (!eng) return;
    const docId = activeIdRef.current;
    const key = quickMaskKey(docId);
    const before = selStateOf(activeDocRef.current);
    if (eng.quickMaskActive()) {
      // Coverage that spans the whole canvas comes back out as NO selection, the
      // same equivalence the mode was entered under — otherwise turning quick
      // mask on and straight off again would leave a full-canvas marquee behind.
      const d = activeDocRef.current;
      const rects = eng.quickMaskRects();
      const covered = rects.reduce((n, r) => n + r.w * r.h, 0);
      // Fully covered = no selection — unless it is soft, where the rects only
      // say "at least 50%" and the partial pixels are the point.
      const after: SelState =
        covered >= d.width * d.height && !eng.isSoftSelection(rects)
          ? { rects: [], angle: 0, pivot: null }
          : { rects, angle: 0, pivot: null };
      eng.setQuickMask(null);
      markQuickMask(docId, false);
      setSelState(docId, after);
      // Undo re-enters the mode rather than restoring a selection: the raster is
      // deliberately NOT freed on exit, so stepping back lands you in the quick
      // mask exactly as you left it — and the brush strokes inside it are still
      // their own history entries, which then undo visibly.
      eng.pushStructural(
        "Exit Quick Mask",
        () => {
          eng.setQuickMask(key);
          markQuickMask(docId, true);
          setSelState(docId, before);
        },
        () => {
          eng.setQuickMask(null);
          markQuickMask(docId, false);
          setSelState(docId, after);
        },
      );
      showToast(after.rects.length ? "Quick Mask off — coverage is now the selection" : "Quick Mask off");
    } else {
      const empty: SelState = { rects: [], angle: 0, pivot: null };
      eng.enterQuickMask(key, before.rects, before.angle, before.pivot);
      markQuickMask(docId, true);
      setSelState(docId, empty);
      eng.pushStructural(
        "Quick Mask",
        () => {
          eng.setQuickMask(null);
          markQuickMask(docId, false);
          setSelState(docId, before);
        },
        () => {
          eng.setQuickMask(key);
          markQuickMask(docId, true);
          setSelState(docId, empty);
        },
      );
      showToast("Quick Mask on — paint black to mask (red), white to select");
    }
  };

  const toggleIsolate = () => {
    if (isolatedIds) {
      setIsolate(null);
      return;
    }
    const ids = active.selectedLayerIds.length
      ? active.selectedLayerIds
      : active.activeLayerId
        ? [active.activeLayerId]
        : [];
    if (!ids.length) {
      showToast("Select a layer to isolate.");
      return;
    }
    // Soloing everything would be a no-op that still shows the "Isolated" chip —
    // more confusing than just saying so.
    if (hiddenByIsolation(active.layers, resolveIsolation(active.layers, ids)) === 0) {
      showToast("Nothing else is visible to hide.");
      return;
    }
    setIsolate({ docId: active.id, ids });
  };

  // Guide edits are ordinary undo steps: they're structural (no pixels), and the
  // document they belong to is captured by id so an undo landing after a tab
  // switch still edits the right document rather than whatever is on screen.
  const setDocGuides = (docId: string, next: Guide[]) =>
    setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, guides: next } : d)));
  const commitGuides = (label: string, next: Guide[]) => {
    const docId = activeIdRef.current;
    const before = activeDocRef.current.guides ?? [];
    const same =
      before.length === next.length &&
      before.every((g, i) => g.axis === next[i].axis && g.pos === next[i].pos);
    if (same) return;
    setDocGuides(docId, next);
    paintRef.current?.pushStructural(
      label,
      () => setDocGuides(docId, before),
      () => setDocGuides(docId, next),
    );
  };

  return {
    toggleQuickMask,
    toggleIsolate,
    commitGuides,
  };
}
