// The projects family (TODO 1.10): a document written as a .gproj (every
// layer, mask, channel, path and setting; images an autosave has already
// encoded passed in), Save and Save As, Open (the native picker when there is
// one, else the file input), a project read back — its ids made fresh, opened
// in the colour space it was written in — and a crash snapshot restored.
//
// `projectOps` is called on every render of Editor, as `layerOps` is. The
// autosave machinery is Editor's (hooks) and calls these.

import { BLOB_REF, type AutosaveDoc, type AutosaveSnapshot } from "../lib/autosave";
import { coerceChannels, selectionChannelKey } from "../lib/channels";
import { WORKING_SPACE_LABELS, type WorkingSpace } from "../lib/colorspace";
import { remapComps, sanitizeComps } from "../lib/comps";
import { sanitizeFrame, type FrameSpec } from "../lib/frame";
import type { GlobalLight } from "../lib/global-light";
import { sanitizeGuides } from "../lib/guides";
import { mergeLog, sanitizeLog } from "../lib/history-log";
import { p3Supported } from "../lib/imageio";
import { coerceBlendingOptions, type KnockoutMode } from "../lib/knockout";
import { filterMaskKey, type LayerNode } from "../lib/layers";
import type { EngineHandle } from "../lib/paint";
import { coercePaths } from "../lib/paths";
import {
  LEGACY_PROJECT_EXT,
  PROJECT_EXT,
  coerceSelectionMask,
  downloadBlob,
  saveProjectFile,
  serializeProject,
  type PendingLoad,
  type ProjectFile,
  type SerializedNode,
} from "../lib/project";
import { addRecent } from "../lib/recents";
import { sanitizeSamplers } from "../lib/samplers";
import { coerceVectorMask, type VectorMask } from "../lib/vector-mask";
import type { Doc } from "../state/documents";
import type { DocumentsState } from "../state/documents";
import type { Store } from "../state/store";
/** What the project operations need of the editor. */
export interface ProjectContext {
  documents: Store<DocumentsState>;
  /** The active document and its id — the latest, read when an operation runs. */
  activeIdRef: { readonly current: string };
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  /** The working colour space, the document light and the colours — the latest. */
  colorSpaceRef: { readonly current: WorkingSpace };
  globalLightRef: { readonly current: GlobalLight };
  fgRef: { readonly current: string };
  bgRef: { readonly current: string };
  /** What documents, layers and adjustment layers are numbered from. */
  seqRef: { current: number };
  layerSeqRef: { current: number };
  adjSeqRef: { current: number };
  /** Autosave's last serialization of each document. */
  docJsonCache: { readonly current: Map<string, AutosaveDoc> };
  /** The hidden file input Open falls back to. */
  fileInputRef: { readonly current: HTMLInputElement | null };
  /** Whether history has moved since the last write, and since the last save. */
  autosaveDirtyRef: { current: boolean };
  unsavedRef: { current: boolean };
  showToast(message: string): void;
  acceptSize(w: number, h: number, what: "document"): boolean;
  /** Put a floating paste down before another document comes in. */
  commitFloatIfAny(): void;
  setActiveId(id: string): void;
  setPendingLoads(update: (loads: PendingLoad[]) => PendingLoad[]): void;
  setForeground(hex: string): void;
  setBackground(hex: string): void;
  /** Bring back a project's document light (sanitized). */
  restoreGlobalLight(raw: unknown): void;
  setColorSpaceState(space: WorkingSpace): void;
  /** The status bar's save indicator. */
  setSaveState(state: { label: string; ok: boolean }): void;
  setSaveAsOpen(open: boolean): void;
  renameDoc(id: string, name: string): void;
  nextLeafId(): string;
}

export function projectOps(ctx: ProjectContext) {
  const {
    activeIdRef,
    activeDocRef,
    paintRef,
    colorSpaceRef,
    globalLightRef,
    fgRef,
    bgRef,
    seqRef,
    layerSeqRef,
    adjSeqRef,
    docJsonCache,
    fileInputRef,
    autosaveDirtyRef,
    unsavedRef,
    showToast,
    acceptSize,
    commitFloatIfAny,
    setActiveId,
    setPendingLoads,
    setForeground,
    setBackground,
    restoreGlobalLight,
    setColorSpaceState,
    setSaveState,
    setSaveAsOpen,
    renameDoc,
    nextLeafId,
  } = ctx;
  const setDocs = ctx.documents.setter("docs");

  // ---- Project save (.gproj — layers, groups & full state) ----
  // Serialize ANY open document to `.gproj` JSON. The engine keeps every
  // materialized document's layer + mask canvases (globally-unique ids, sized
  // per-document), so pixels resolve for inactive tabs too — which is what
  // lets autosave snapshot all of them. History labels are display-only
  // metadata — the undo stack was never file-replayable.
  /** `encoded` lets a caller supply images it has already encoded — autosave
   *  does that from a worker, so the 1 s of PNG encoding this used to do on the
   *  main thread happens off it. Absent, every image is encoded here as before,
   *  which is what the crash path and the file export need: neither can await. */
  const serializeDocToJSON = (d: Doc, encoded?: ReadonlyMap<string, Blob>): string => {
    const live = paintRef.current?.historyOf(d.id) ?? null;
    /* A reference, not the pixels: the Blob travels beside the JSON rather than
       inside it. Anything not in the map is encoded here, as before. */
    const pre = (key: string, encode: () => string | null) =>
      encoded?.has(key) ? `${BLOB_REF}${key}` : encode();
    const project = serializeProject(
      {
        name: d.name,
        width: d.width,
        height: d.height,
        dpi: d.dpi,
        // Document state, not per-layer — saved so a reopened file keeps the
        // lighting the effects in it were authored against.
        globalLight: globalLightRef.current,
        // The space the pixels below were written in. Without it a wide-gamut
        // document reopened in an sRGB session is colour-managed on decode and
        // every RGB value shifts (alpha survives, which is what made it look
        // like a rendering quirk rather than a lossy reopen).
        workingSpace: colorSpaceRef.current,
        layers: d.layers,
        activeLayerId: d.activeLayerId,
        selectedLayerIds: d.selectedLayerIds,
        selection: d.selection,
        // A soft selection's coverage rides with its outline (v25).
        selectionMask: paintRef.current?.selectionMaskImage(d.selection) ?? null,
        metadata: d.metadata ?? null,
        paths: d.paths ?? [],
        guides: d.guides ?? [],
        samplers: d.samplers ?? [],
        channels: d.channels ?? [],
        comps: d.comps ?? [],
      },
      { foreground: fgRef.current, background: bgRef.current },
      // The log a file carries = what it already had + what this session did
      // to THIS document (every tab has its own history), capped.
      {
        labels: mergeLog(d.historyLog ?? [], live?.labels ?? []),
        index: live?.index ?? 0,
      },
      (id) => pre(`layer:${id}`, () => paintRef.current?.getLayerImage(id) ?? null),
      (id) => pre(`mask:${id}`, () => paintRef.current?.getMaskImage(id) ?? null),
      // Channel rasters live in the same masks map, under the doc-scoped key.
      (chId) =>
        pre(`mask:${selectionChannelKey(d.id, chId)}`, () =>
          paintRef.current?.getMaskImage(selectionChannelKey(d.id, chId)) ?? null),
      (id) => pre(`frame:${id}`, () => paintRef.current?.getFrameSourceImage(id) ?? null),
    );
    return JSON.stringify(project);
  };
  // Reads from refs so it also works from the one-time keydown listener.
  // `name` is the one the file is saved under, when that is a new one.
  const buildProjectBlob = (name?: string): Blob => {
    const d = activeDocRef.current;
    return new Blob([serializeDocToJSON(name ? { ...d, name } : d)], { type: "application/json" });
  };

  const markSaved = (label: string) => {
    autosaveDirtyRef.current = false;
    unsavedRef.current = false;
    setSaveState({ label, ok: true });
  };

  // Simple Save: download the project under the canvas's current name.
  const saveProject = () => {
    const filename = `${activeDocRef.current.name}.${PROJECT_EXT}`;
    const blob = buildProjectBlob();
    downloadBlob(blob, filename);
    addRecent(filename, { blob }); // remember a re-openable cached copy
    markSaved("Saved");
  };

  // Save As: pick a name (dialog) then choose folder/path via the native picker.
  const saveProjectAs = async (filename: string) => {
    const base =
      filename.replace(new RegExp(`\\.(${PROJECT_EXT}|${LEGACY_PROJECT_EXT})$`, "i"), "").trim() ||
      activeDocRef.current.name;
    const docId = activeIdRef.current;
    // The file carries the name it is saved as, so it opens back under it.
    const blob = buildProjectBlob(base);
    const fname = `${base}.${PROJECT_EXT}`;
    const { ok, handle } = await saveProjectFile(blob, fname);
    if (ok) {
      renameDoc(docId, base); // reflect the saved name on the tab
      addRecent(fname, handle ? { handle } : { blob });
      setSaveAsOpen(false);
      markSaved("Saved");
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
        types: [
          {
            description: "Graphiq Project",
            accept: { "application/json": [`.${PROJECT_EXT}`, `.${LEGACY_PROJECT_EXT}`] },
          },
        ],
      });
      const file = await handle.getFile();
      if (loadProjectText(await file.text())) addRecent(file.name, { handle });
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") window.alert("Couldn't open the file.");
    }
  };

  // Rebuild a document from a parsed .gproj file. Layer ids are remapped to fresh
  // ones so a loaded project never collides with already-open documents.
  const loadProject = (p: ProjectFile, activate = true): string => {
    /* A .gproj records its own dimensions, and nothing stops a file written on
       one machine naming a size this browser cannot hold. */
    if (!acceptSize(p.width, p.height, "document")) return "";
    commitFloatIfAny(); // merge any floating paste on the current doc first
    /* Open the file in the space it was WRITTEN in (v24), before its pixels are
       decoded. The layer PNGs carry the authoring space's profile, so decoding
       them into a canvas in another space colour-manages every one of them: RGB
       shifts, alpha does not. Both this and setPendingLoads land in one React
       update, and CanvasArea's colour-space effect is declared above its
       pending-load effect, so the engine has switched before anything decodes.
       Files older than v24 predate any space but sRGB, so their absence of a
       field is not ambiguous. */
    const fileSpace: WorkingSpace = p.workingSpace ?? "srgb";
    if (fileSpace !== colorSpaceRef.current && (fileSpace !== "display-p3" || p3Supported())) {
      /* setColorSpaceState, NOT setWorkingSpace: adopting the file's space is
         needed to open it correctly, but it is not the user choosing a
         preference, so it must not overwrite the persisted one. Their own space
         comes back the next time the app loads. */
      setColorSpaceState(fileSpace);
      showToast(`Opened in ${WORKING_SPACE_LABELS[fileSpace]} — the space this file was saved in.`);
    }
    const idMap = new Map<string, string>();
    const images: { id: string; data: string }[] = [];
    const masks: { id: string; data: string }[] = [];
    const frameSources: { id: string; data: string }[] = [];
    const remap = (list: SerializedNode[]): LayerNode[] =>
      list.map((n) => {
        const mask = n.mask ? { mask: { enabled: n.mask.enabled, linked: n.mask.linked } } : {};
        const fx = n.effects ? { effects: n.effects } : {};
        const clip = n.clipped ? { clipped: true } : {};
        // v19: vector mask (a pen path, not a raster — see vector-mask.ts).
        // Typed explicitly: letting TS infer `{vectorMask} | {}` and spreading it
        // into all three node branches made the union too complex to represent.
        const vmRaw = coerceVectorMask((n as { vectorMask?: unknown }).vectorMask);
        const vmask: { vectorMask?: VectorMask } = vmRaw ? { vectorMask: vmRaw } : {};
        // A FRAME's spec (its box, shape, fit and content placement). Sanitized
        // against nothing but itself — the box may legitimately sit outside a
        // resized canvas, and the vector mask is what actually clips.
        const frameRaw = sanitizeFrame((n as { frame?: unknown }).frame);
        const frm: { frame?: FrameSpec } = frameRaw ? { frame: frameRaw } : {};
        // v19 also carries Blending Options (fill opacity + knockout).
        const blending: { fillOpacity?: number; knockout?: KnockoutMode } =
          coerceBlendingOptions(n as { fillOpacity?: unknown; knockout?: unknown });
        const flt = n.filters?.length ? { filters: n.filters } : {};
        const lbl = n.label ? { label: n.label } : {}; // v10 colour label
        const lck = n.locks ? { locks: n.locks } : {}; // v12 edit locks
        const lnk = n.linkKey ? { linkKey: n.linkKey } : {}; // v13 linked layers
        // v8: filter mask meta + grayscale (restored under filterMaskKey(new id)).
        const fmMeta =
          n.type !== "adjustment" && n.filterMask
            ? { filterMask: { enabled: n.filterMask.enabled, linked: n.filterMask.linked } }
            : {};
        const pushFm = (id: string) => {
          if (n.type !== "adjustment" && n.filterMaskImage)
            masks.push({ id: filterMaskKey(id), data: n.filterMaskImage });
        };
        if (n.type === "group") {
          const id = `grp-${(layerSeqRef.current += 1)}`;
          idMap.set(n.id, id);
          if (n.maskImage) masks.push({ id, data: n.maskImage });
          pushFm(id);
          return {
            id,
            type: "group",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            expanded: n.expanded,
            ...mask,
            ...vmask,
            ...blending,
            ...fx,
            ...clip,
            ...flt,
            ...fmMeta,
            ...lbl,
            ...lck,
            ...lnk,
            children: remap(n.children),
          };
        }
        if (n.type === "adjustment") {
          const id = `adj-${(adjSeqRef.current += 1)}`;
          idMap.set(n.id, id);
          if (n.maskImage) masks.push({ id, data: n.maskImage });
          return {
            id,
            type: "adjustment",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            adjustment: n.adjustment,
            clipped: !!n.clipped,
            ...mask,
            ...vmask,
            ...blending,
            ...fx,
            ...lbl,
            ...lck,
            ...lnk,
          };
        }
        const id = nextLeafId();
        idMap.set(n.id, id);
        if (n.data) images.push({ id, data: n.data });
        if (n.maskImage) masks.push({ id, data: n.maskImage });
        if (n.frameSource) frameSources.push({ id, data: n.frameSource });
        pushFm(id);
        return {
          id,
          type: "layer",
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
          ...(n.vector ? { vector: n.vector } : {}),
          ...(n.fill ? { fill: n.fill } : {}), // v14 fill layer (no pixel data)
          ...frm,
          ...mask,
          ...vmask,
          ...blending,
          ...fx,
          ...clip,
          ...flt,
          ...fmMeta,
          ...lbl,
          ...lck,
          ...lnk,
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
      dpi: p.dpi ?? 300,
      layers,
      activeLayerId,
      selectedLayerIds,
      selection: p.selection ?? [],
      selectionAngle: 0,
      selectionPivot: null,
      metadata: p.metadata ?? null, // v9; absent in older files
      paths: coercePaths(p.paths), // v11; absent in older files
      // v17; older files have none, and a guide outside the document is dropped
      // rather than trusted (a hand-edited file shouldn't produce ghost lines).
      guides: sanitizeGuides(p.guides, p.width, p.height),
      samplers: sanitizeSamplers(p.samplers, p.width, p.height),
      // v18; older files have none. Only channels whose RASTER is present are
      // kept — a name with no pixels would load as an empty selection and read
      // as a bug rather than as the missing data it is.
      channels: coerceChannels(p.channels).filter((c) =>
        (p.channelImages ?? []).some((i) => i.id === c.id && !!i.data),
      ),
      // v21; older files have none. Comps are keyed by LAYER ID, and the loader
      // has just minted fresh ones — so they have to be re-keyed through the
      // same map, or every comp would load pointing at layers that don't exist.
      comps: remapComps(sanitizeComps((p as { comps?: unknown }).comps), idMap),
      // Present in every .gproj ever written — nothing read it back until now.
      historyLog: sanitizeLog(p.history?.labels),
    };
    setDocs((ds) => [...ds, doc]);
    if (activate) setActiveId(docId);
    // v20; older files fall back to the default, which is what every effect in
    // them was authored against anyway.
    if (activate) restoreGlobalLight((p as { globalLight?: unknown }).globalLight);
    if (p.foreground) setForeground(p.foreground);
    if (p.background) setBackground(p.background);
    const channelLoads = (p.channelImages ?? [])
      .filter((i) => doc.channels?.some((c) => c.id === i.id))
      .map((i) => ({ id: i.id, data: i.data }));
    // v25: a soft selection's coverage, restored behind THIS array — the one the
    // document now holds as its selection — once the document is in the engine.
    const selMask = doc.selection.length ? coerceSelectionMask(p.selectionMask, p.width, p.height) : null;
    const selection = selMask ? { rects: doc.selection, mask: selMask } : undefined;
    setPendingLoads((ls) => [...ls, { docId, images, masks, channels: channelLoads, frameSources, selection }]);
    // Seed the autosave cache from the file JSON so a never-viewed restored tab
    // still snapshots correctly (refreshed from the engine once it goes active).
    docJsonCache.current.set(docId, { json: JSON.stringify(p), name: doc.name });
    return docId;
  };

  // Parse + validate .gproj text and load it. Returns whether it succeeded.
  const loadProjectText = (text: string): boolean => {
    try {
      const parsed = JSON.parse(text);
      // Accept the current id plus the legacy "aperture-project" so older files open.
      const fmt = parsed?.format;
      if ((fmt !== "graphiq-project" && fmt !== "aperture-project") || !Array.isArray(parsed.layers)) {
        window.alert("This file isn't a valid Graphiq project (.gproj).");
        return false;
      }
      /* An empty id means the size was refused — so the caller must not go on
         to file it under recents as though it had opened. */
      return !!loadProject(parsed as ProjectFile);
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

  // Restore a crash snapshot: open every document it holds and activate the one
  // that was active. Returns how many opened (0 = nothing valid).
  const restoreSnapshot = (snap: AutosaveSnapshot): number => {
    const ids: string[] = [];
    for (const entry of snap.docs) {
      try {
        const parsed = JSON.parse(entry.json);
        const fmt = parsed?.format;
        if ((fmt === "graphiq-project" || fmt === "aperture-project") && Array.isArray(parsed.layers)) {
          const id = loadProject(parsed as ProjectFile, false);
          if (id) ids.push(id);
        }
      } catch {
        /* skip a corrupt entry, keep the rest */
      }
    }
    if (!ids.length) return 0;
    setActiveId(ids[Math.min(snap.activeIndex, ids.length - 1)] ?? ids[0]);
    return ids.length;
  };

  // ---- Export (flatten → image file) ----

  return {
    serializeDocToJSON,
    saveProject,
    saveProjectAs,
    openProject,
    loadProjectText,
    onFilePicked,
    restoreSnapshot,
  };
}
