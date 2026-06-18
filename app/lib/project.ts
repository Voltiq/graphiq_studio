import type { LayerGroup, LayerLeaf, LayerNode } from "./layers";
import type { Rect } from "./view";

/** Aperture project file extension (keeps layers, groups & settings; lossless). */
export const PROJECT_EXT = "aproj";

type SerializedLeaf = LayerLeaf & { data: string | null };
type SerializedGroup = Omit<LayerGroup, "children"> & { children: SerializedNode[] };
export type SerializedNode = SerializedLeaf | SerializedGroup;

export interface ProjectFile {
  format: "aperture-project";
  version: number;
  name: string;
  width: number;
  height: number;
  foreground: string;
  background: string;
  activeLayerId: string | null;
  selectedLayerIds: string[];
  selection: Rect[];
  layers: SerializedNode[];
  /** History labels + position. The full undo stack isn't replayable from a file
      (entries hold live callbacks); this is metadata for display / future use. */
  history: { labels: string[]; index: number };
  savedAt: string;
}

/** Leaf pixel data waiting to be drawn into the engine once a doc is active & sized.
    Each image carries either a PNG data URL (`data`, from a saved project) or an
    already-decoded `source` (e.g. an imported file's bitmap). */
export interface PendingLoad {
  docId: string;
  images: { id: string; data?: string; source?: CanvasImageSource }[];
}

export interface ProjectInput {
  name: string;
  width: number;
  height: number;
  layers: LayerNode[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  selection: Rect[];
}

function serializeNode(node: LayerNode, getImage: (id: string) => string | null): SerializedNode {
  if (node.type === "group") {
    return { ...node, children: node.children.map((c) => serializeNode(c, getImage)) };
  }
  return { ...node, data: getImage(node.id) };
}

/** Build the full, self-describing project document (layers + pixels + state). */
export function serializeProject(
  doc: ProjectInput,
  colors: { foreground: string; background: string },
  history: { labels: string[]; index: number },
  getImage: (id: string) => string | null,
): ProjectFile {
  return {
    format: "aperture-project",
    version: 1,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    foreground: colors.foreground,
    background: colors.background,
    activeLayerId: doc.activeLayerId,
    selectedLayerIds: doc.selectedLayerIds,
    selection: doc.selection,
    layers: doc.layers.map((n) => serializeNode(n, getImage)),
    history,
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
            description: "Aperture Project",
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
