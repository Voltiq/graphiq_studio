import { downloadBlob } from "./project";
import {
  FILTER_EXT,
  FILTER_PACK_EXT,
  packToFileJSON,
  presetToFileJSON,
  type AdjustPreset,
} from "./adjust";

/** A filesystem-safe base name for a preset file (never empty). */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[^a-z0-9\-_ ]+/gi, "")
      .trim()
      .replace(/\s+/g, " ") || "filter"
  );
}

// Minimal typings for the File System Access directory API (not in lib.dom yet).
interface FsWritable {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}
interface FsFileHandle {
  createWritable: () => Promise<FsWritable>;
}
interface FsDirHandle {
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<FsDirHandle>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FsFileHandle>;
}
type DirPicker = (opts?: { mode?: string }) => Promise<FsDirHandle>;

/**
 * Export presets to disk. One preset downloads as a single `.gifp` file; several
 * are written as individual `.gifp` files into a chosen folder via the File
 * System Access API, falling back to a single `.gifpack` bundle download where
 * that API is unavailable. Returns false if the user cancelled.
 */
export async function exportPresets(presets: AdjustPreset[]): Promise<boolean> {
  if (!presets.length) return false;

  if (presets.length === 1) {
    downloadBlob(
      new Blob([presetToFileJSON(presets[0])], { type: "application/json" }),
      `${safeFileName(presets[0].name)}.${FILTER_EXT}`,
    );
    return true;
  }

  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (picker) {
    try {
      const root = await picker({ mode: "readwrite" });
      const dir = await root.getDirectoryHandle("Graphiq Filters", { create: true });
      const used = new Set<string>();
      for (const p of presets) {
        const base = safeFileName(p.name);
        let name = base;
        let i = 2;
        while (used.has(name.toLowerCase())) name = `${base} ${i++}`;
        used.add(name.toLowerCase());
        const fh = await dir.getFileHandle(`${name}.${FILTER_EXT}`, { create: true });
        const w = await fh.createWritable();
        await w.write(presetToFileJSON(p));
        await w.close();
      }
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false;
      // Any other failure → fall back to the bundle download below.
    }
  }

  downloadBlob(
    new Blob([packToFileJSON(presets)], { type: "application/json" }),
    `Graphiq Filters.${FILTER_PACK_EXT}`,
  );
  return true;
}
