import { filterMaskKey } from "./layers";
import type { LayerAdjustment, LayerGroup, LayerLeaf, LayerNode } from "./layers";
import type { ImageMetadata } from "./metadata";
import type { SavedPath } from "./paths";
import type { Rect } from "./view";

/** Graphiq project file extension (keeps layers, groups & settings; lossless). */
export const PROJECT_EXT = "gproj";
/** Pre-rename extension — old files still open everywhere. */
export const LEGACY_PROJECT_EXT = "aproj";

type SerializedLeaf = LayerLeaf & {
  data: string | null;
  maskImage?: string | null;
  /** v8: the smart-filter mask grayscale (leaf/group with node.filterMask). */
  filterMaskImage?: string | null;
};
type SerializedGroup = Omit<LayerGroup, "children"> & {
  children: SerializedNode[];
  maskImage?: string | null;
  filterMaskImage?: string | null;
};
/** Adjustment nodes carry no pixel image — just their spec + clip + (Spec 01) mask. */
type SerializedAdjustment = LayerAdjustment & { maskImage?: string | null };
export type SerializedNode = SerializedLeaf | SerializedGroup | SerializedAdjustment;

export interface ProjectFile {
  format: "graphiq-project";
  version: number;
  name: string;
  width: number;
  height: number;
  /** Pixels per inch (physical-unit rulers + print size). Absent in old files. */
  dpi?: number;
  foreground: string;
  background: string;
  activeLayerId: string | null;
  selectedLayerIds: string[];
  selection: Rect[];
  layers: SerializedNode[];
  /** History labels + position. The full undo stack isn't replayable from a file
      (entries hold live callbacks); this is metadata for display / future use. */
  history: { labels: string[]; index: number };
  /** Source-image / authoring metadata (v9) — EXIF fields shown in the Metadata
   *  panel and embedded on export. Absent in older files. */
  metadata?: ImageMetadata | null;
  /** Stored pen paths (v11 — the Paths panel, incl. the Work Path). */
  paths?: SavedPath[];
  savedAt: string;
}

/** Leaf pixel data waiting to be drawn into the engine once a doc is active & sized.
    Each image carries either a PNG data URL (`data`, from a saved project) or an
    already-decoded `source` (e.g. an imported file's bitmap). */
export interface PendingLoad {
  docId: string;
  images: { id: string; data?: string; source?: CanvasImageSource }[];
  /** Grayscale layer masks to restore (PNG data URL or decoded source). */
  masks?: { id: string; data?: string; source?: CanvasImageSource }[];
}

export interface ProjectInput {
  name: string;
  width: number;
  height: number;
  dpi?: number;
  layers: LayerNode[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  selection: Rect[];
  metadata?: ImageMetadata | null;
  paths?: SavedPath[];
}

function serializeNode(
  node: LayerNode,
  getImage: (id: string) => string | null,
  getMask: (id: string) => string | null,
): SerializedNode {
  // A mask (when present) is serialized as a grayscale PNG data URL alongside the
  // node; node.mask metadata rides along through the spread. The filter mask
  // (v8) lives in the engine under filterMaskKey(id) — same exporter works.
  const maskImage = node.mask ? getMask(node.id) : null;
  if (node.type === "adjustment") return { ...node, maskImage }; // no pixel image / filters
  const filterMaskImage = node.filterMask ? getMask(filterMaskKey(node.id)) : null;
  if (node.type === "group") {
    return {
      ...node,
      maskImage,
      filterMaskImage,
      children: node.children.map((c) => serializeNode(c, getImage, getMask)),
    };
  }
  // A Fill layer stores no pixels (its `fill` spec rides through the spread).
  const data = node.fill ? null : getImage(node.id);
  return { ...node, data, maskImage, filterMaskImage };
}

/** Build the full, self-describing project document (layers + pixels + state). */
export function serializeProject(
  doc: ProjectInput,
  colors: { foreground: string; background: string },
  history: { labels: string[]; index: number },
  getImage: (id: string) => string | null,
  getMask: (id: string) => string | null,
): ProjectFile {
  return {
    format: "graphiq-project",
    version: 16, // v16 adds gradient text fill (v15 text warp, v14 fill layers, v13 linked layers)
    name: doc.name,
    width: doc.width,
    height: doc.height,
    dpi: doc.dpi ?? 300,
    foreground: colors.foreground,
    background: colors.background,
    activeLayerId: doc.activeLayerId,
    selectedLayerIds: doc.selectedLayerIds,
    selection: doc.selection,
    layers: doc.layers.map((n) => serializeNode(n, getImage, getMask)),
    history,
    metadata: doc.metadata ?? null,
    paths: doc.paths ?? [],
    savedAt: new Date().toISOString(),
  };
}

/** Trigger a browser download of a blob (fallback when no native picker). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface SaveHandle {
  createWritable: () => Promise<{ write: (d: Blob | string) => Promise<void>; close: () => Promise<void> }>;
}
type ShowSaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

/**
 * Save through the native file picker (lets the user choose folder + name) when
 * the File System Access API is available, otherwise fall back to a download.
 * `ok` is false only when the user cancels the native picker; `handle` is the
 * (re-openable) file handle when the picker was used.
 */
export async function saveProjectFile(
  blob: Blob,
  suggestedName: string,
): Promise<{ ok: boolean; handle: unknown | null }> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: "Graphiq Project",
            accept: { "application/json": [`.${PROJECT_EXT}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, handle };
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return { ok: false, handle: null }; // cancelled
      // any other failure → fall back to a plain download
    }
  }
  downloadBlob(blob, suggestedName);
  return { ok: true, handle: null };
}
