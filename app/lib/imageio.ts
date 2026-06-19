import { downloadBlob } from "./project";

/** Whether this browser can use a wide-gamut Display-P3 canvas working space. */
export function p3Supported(): boolean {
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d", { colorSpace: "display-p3" });
    return ctx?.getContextAttributes().colorSpace === "display-p3";
  } catch {
    return false;
  }
}

export interface ExportFormat {
  id: string;
  label: string;
  mime: string;
  ext: string;
  lossy: boolean; // has a quality knob
  alpha: boolean; // can hold transparency
}

const ALL_FORMATS: ExportFormat[] = [
  { id: "png", label: "PNG", mime: "image/png", ext: "png", lossy: false, alpha: true },
  { id: "jpeg", label: "JPEG", mime: "image/jpeg", ext: "jpg", lossy: true, alpha: false },
  { id: "webp", label: "WebP", mime: "image/webp", ext: "webp", lossy: true, alpha: true },
  { id: "avif", label: "AVIF", mime: "image/avif", ext: "avif", lossy: true, alpha: true },
];

function canEncode(mime: string): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    // Browsers silently fall back to PNG for unsupported types, so check the prefix.
    return c.toDataURL(mime).startsWith(`data:${mime}`);
  } catch {
    return false;
  }
}

/** Formats this browser can actually encode (PNG/JPEG always; WebP/AVIF if supported). */
export function availableFormats(): ExportFormat[] {
  return ALL_FORMATS.filter((f) => f.id === "png" || f.id === "jpeg" || canEncode(f.mime));
}

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 0..1 (lossy formats only)
  scale: number; // 1 = 100%
  transparent: boolean;
  matte: string; // background colour used when not transparent
}

/** Flatten/scale the composite and encode it to the chosen image format. */
export function renderExport(base: HTMLCanvasElement, o: ExportOptions): Promise<Blob | null> {
  const w = Math.max(1, Math.round(base.width * o.scale));
  const h = Math.max(1, Math.round(base.height * o.scale));
  // Match the composite's colour space so wide-gamut exports aren't clamped.
  const cs =
    (base.getContext("2d")?.getContextAttributes().colorSpace as PredefinedColorSpace) ?? "srgb";
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { colorSpace: cs });
  if (!ctx) return Promise.resolve(null);
  const transparent = o.transparent && o.format.alpha;
  if (!transparent) {
    ctx.fillStyle = o.matte;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, 0, 0, w, h);
  return new Promise((resolve) =>
    c.toBlob((b) => resolve(b), o.format.mime, o.format.lossy ? o.quality : undefined),
  );
}

interface SaveHandle {
  createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
}
type ShowSaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

/** Save an exported image via the native picker (folder + name) or a download. */
export async function saveImageBlob(
  blob: Blob,
  filename: string,
  format: ExportFormat,
): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: `${format.label} image`, accept: { [format.mime]: [`.${format.ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false;
    }
  }
  downloadBlob(blob, filename);
  return true;
}

// Camera-RAW extensions browsers can't decode directly — handled via the
// embedded JPEG preview every RAW file carries.
export const RAW_EXTS = [
  "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf",
  "rw2", "orf", "pef", "ptx", "srw", "3fr", "erf", "kdc", "mos", "mrw",
  "x3f", "raw", "rwl", "dcr",
];

/** `accept` value for the import picker: any browser image type plus RAW. */
export const IMPORT_ACCEPT = ["image/*", ...RAW_EXTS.map((e) => `.${e}`)].join(",");

/**
 * Pull the largest embedded JPEG out of a RAW (or other container) file. RAW
 * files embed one or more JPEG previews; we decode each candidate and keep the
 * biggest. This is the embedded preview, not a full raw development.
 */
async function decodeEmbeddedJpeg(file: File): Promise<ImageBitmap | null> {
  let ab: ArrayBuffer;
  try {
    ab = await file.arrayBuffer();
  } catch {
    return null;
  }
  const buf = new Uint8Array(ab);
  const starts: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    // JPEG SOI marker: FF D8 FF
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      starts.push(i);
      if (starts.length >= 16) break;
    }
  }
  let best: ImageBitmap | null = null;
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const bmp = await createImageBitmap(new Blob([ab.slice(s, e)]), {
        colorSpaceConversion: "default",
      });
      if (!best || bmp.width * bmp.height > best.width * best.height) {
        best?.close();
        best = bmp;
      } else {
        bmp.close();
      }
    } catch {
      // not a decodable JPEG at this offset — skip
    }
  }
  return best;
}

/**
 * Decode an image file to a drawable bitmap (null on failure). Honors embedded
 * colour profiles (`colorSpaceConversion: "default"`); falls back to the
 * embedded preview for camera-RAW files browsers can't decode natively.
 */
export async function decodeImageFile(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { colorSpaceConversion: "default" });
  } catch {
    return await decodeEmbeddedJpeg(file);
  }
}
