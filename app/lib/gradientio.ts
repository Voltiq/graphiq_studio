// Saved gradient presets: the localStorage store shared by the Gradient tool
// and the Layer Style gradient overlay, plus file import/export (.agrad).

import type { GradientPreset, GradientStop } from "./tools";
import { downloadBlob } from "./project";

export type { GradientPreset } from "./tools";

/** The Gradient tool's preset store (the default, shared bucket). */
export const GRADIENT_PRESETS_KEY = "graphiq:gradient-presets";
const LEGACY_PRESETS_KEY = "aperture:gradient-presets"; // pre-rebrand fallback
/** Layer-style bucket, used only when "share saved gradients" is off. */
export const FX_GRADIENT_PRESETS_KEY = "graphiq:gradient-presets-fx";

/** Gradient preset file extension. */
export const GRADIENT_EXT = "ggrad";
/** Pre-rename extension — old files still import. */
export const LEGACY_GRADIENT_EXT = "agrad";

export function loadSavedGradients(key: string = GRADIENT_PRESETS_KEY): GradientPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      window.localStorage.getItem(key) ??
      (key === GRADIENT_PRESETS_KEY ? window.localStorage.getItem(LEGACY_PRESETS_KEY) : null);
    const list = raw ? (JSON.parse(raw) as GradientPreset[]) : [];
    return Array.isArray(list) ? list.filter((g) => Array.isArray(g?.stops)) : [];
  } catch {
    return [];
  }
}

export function persistSavedGradients(key: string, list: GradientPreset[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function freshGradientId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- file format -----------------------------------------------------------

interface GradientFile {
  format: "graphiq-gradients";
  version: 1;
  gradients: { name: string; stops: GradientStop[] }[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Validate one imported entry into a fresh, well-formed preset (or null). */
function sanitize(entry: unknown): GradientPreset | null {
  const e = entry as { name?: unknown; stops?: unknown };
  if (!e || !Array.isArray(e.stops)) return null;
  const stops: GradientStop[] = [];
  for (const s of e.stops as { color?: unknown; pos?: unknown }[]) {
    if (typeof s?.color !== "string" || typeof s?.pos !== "number" || !isFinite(s.pos)) continue;
    stops.push({ color: s.color, pos: clamp01(s.pos) });
  }
  if (stops.length < 2) return null;
  return {
    id: freshGradientId(),
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Imported gradient",
    stops,
  };
}

// ---- export ----------------------------------------------------------------

interface SaveHandle {
  createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
}
type ShowSaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;
type ShowOpenFilePicker = (opts: {
  multiple?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ getFile: () => Promise<File> }[]>;

/**
 * Export presets to a single `.agrad` file via the native save picker, falling
 * back to a plain download. Returns false only when the user cancels.
 */
export async function exportGradients(
  list: GradientPreset[],
  suggestedName = "gradients",
): Promise<boolean> {
  const doc: GradientFile = {
    format: "graphiq-gradients",
    version: 1,
    gradients: list.map((g) => ({ name: g.name, stops: g.stops })),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const name = `${suggestedName}.${GRADIENT_EXT}`;
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: "Graphiq Gradients", accept: { "application/json": [`.${GRADIENT_EXT}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false; // cancelled
      // any other failure → fall through to a plain download
    }
  }
  downloadBlob(blob, name);
  return true;
}

// ---- import ----------------------------------------------------------------

function parseGradientFile(text: string): GradientPreset[] {
  try {
    const doc = JSON.parse(text) as GradientFile | GradientPreset[] | GradientPreset;
    const entries = Array.isArray(doc)
      ? doc
      : (doc as GradientFile).gradients ?? [doc as GradientPreset];
    return entries.map(sanitize).filter((g): g is GradientPreset => g !== null);
  } catch {
    return [];
  }
}

/**
 * Import gradients from one or more `.agrad` / `.json` files (native open
 * picker, `<input type=file>` fallback). Resolves to the parsed presets —
 * empty when cancelled or nothing valid was found.
 */
export async function importGradientFiles(): Promise<GradientPreset[]> {
  const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (picker) {
    try {
      const handles = await picker({
        multiple: true,
        types: [
          {
            description: "Graphiq Gradients",
            accept: { "application/json": [`.${GRADIENT_EXT}`, `.${LEGACY_GRADIENT_EXT}`, ".json"] },
          },
        ],
      });
      const out: GradientPreset[] = [];
      for (const h of handles) out.push(...parseGradientFile(await (await h.getFile()).text()));
      return out;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return [];
      // fall through to the input fallback
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${GRADIENT_EXT},.${LEGACY_GRADIENT_EXT},.json,application/json`;
    input.multiple = true;
    input.onchange = async () => {
      const out: GradientPreset[] = [];
      for (const f of Array.from(input.files ?? [])) out.push(...parseGradientFile(await f.text()));
      resolve(out);
    };
    // Cancelling never fires `change`; resolve empty when focus returns.
    window.addEventListener("focus", () => setTimeout(() => resolve([]), 400), { once: true });
    input.click();
  });
}

/** Merge imported presets into a list, skipping exact duplicates (name+stops). */
export function mergeGradients(existing: GradientPreset[], imported: GradientPreset[]): GradientPreset[] {
  const sig = (g: GradientPreset) => `${g.name}|${JSON.stringify(g.stops)}`;
  const seen = new Set(existing.map(sig));
  const out = [...existing];
  for (const g of imported) {
    if (seen.has(sig(g))) continue;
    seen.add(sig(g));
    out.push(g);
  }
  return out;
}
