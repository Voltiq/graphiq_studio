/**
 * Layer-style presets — save, apply, import and export a whole layer style.
 *
 * Deliberately mirrors the gradient-preset system (`gradientio.ts`): the same
 * localStorage shape, the same file-picker-with-download-fallback, the same
 * merge-on-import rule. Two preset libraries that behave differently would be
 * two things to learn.
 *
 * WHAT A STYLE CARRIES. The eight effects plus the Blending Options that belong
 * to the look — fill opacity, knockout and Blend If. It deliberately does NOT
 * carry the layer's opacity or blend mode: Photoshop's styles do, but those two
 * read as composition rather than decoration, and having "apply a style" quietly
 * set a layer to Multiply at 60% is the kind of surprise that makes people stop
 * using presets. Everything a style does change is visible in the Layer Style
 * dialog it was saved from.
 *
 * Pure apart from localStorage and the file pickers — the parsing and merging
 * are Node-testable.
 */

import type { LayerEffects } from "./effects";
import type { BlendIf } from "./blendif";
import type { KnockoutMode } from "./knockout";
import { downloadBlob } from "./project";

export const STYLE_PRESETS_KEY = "graphiq:layer-styles";

/** Current extension. `.astyle` is accepted on import — it is what the TODO and
 *  the app's older naming used, exactly as gradients accept legacy `.agrad`. */
export const STYLE_EXT = "gstyle";
export const LEGACY_STYLE_EXT = "astyle";

export interface LayerStylePreset {
  id: string;
  name: string;
  effects: LayerEffects;
  fillOpacity?: number;
  knockout?: KnockoutMode;
  blendIf?: BlendIf;
}

export function freshStyleId(): string {
  return `sty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The subset of a layer that a style captures. */
export function styleFromLayer(
  name: string,
  layer: {
    effects?: LayerEffects;
    fillOpacity?: number;
    knockout?: KnockoutMode;
    blendIf?: BlendIf;
  },
): LayerStylePreset {
  return {
    id: freshStyleId(),
    name: name.trim() || "Style",
    effects: structuredClone(layer.effects ?? {}),
    ...(typeof layer.fillOpacity === "number" && layer.fillOpacity < 100
      ? { fillOpacity: layer.fillOpacity }
      : {}),
    ...(layer.knockout && layer.knockout !== "none" ? { knockout: layer.knockout } : {}),
    ...(layer.blendIf ? { blendIf: structuredClone(layer.blendIf) } : {}),
  };
}

/**
 * The patch that applies a preset to a layer.
 *
 * Every field the style owns is written, INCLUDING back to its default when the
 * preset does not carry it — otherwise applying a plain style over a knocked-out
 * layer would leave the knockout behind and the result would not look like the
 * preset. A style is a complete look, not a partial merge.
 */
export function styleToPatch(p: LayerStylePreset): {
  effects: LayerEffects;
  fillOpacity: number | undefined;
  knockout: KnockoutMode | undefined;
  blendIf: BlendIf | undefined;
} {
  return {
    effects: structuredClone(p.effects ?? {}),
    fillOpacity: p.fillOpacity,
    knockout: p.knockout,
    blendIf: p.blendIf ? structuredClone(p.blendIf) : undefined,
  };
}

/**
 * Shipped styles. Ids start `b-` so the UI can tell them from the user's own and
 * refuse to delete them — the same marker gradients use.
 *
 * They are chosen to span the eight effects rather than to be pretty: between
 * them they use every effect at least once, and two of them lean on fill
 * opacity, which is the fastest way to discover what that slider is for.
 */
export const BUILTIN_STYLES: LayerStylePreset[] = [
  {
    id: "b-soft-shadow",
    name: "Soft Shadow",
    effects: {
      dropShadow: {
        enabled: true, blendMode: "Multiply", opacity: 45, color: "#000000",
        angle: 120, distance: 10, spread: 0, size: 18, useGlobalLight: true,
      },
    },
  },
  {
    id: "b-emboss",
    name: "Emboss",
    effects: {
      bevel: {
        enabled: true, style: "emboss", depth: 120, size: 8, soften: 2,
        angle: 120, altitude: 30, useGlobalLight: true,
        highlightMode: "Screen", highlightColor: "#ffffff", highlightOpacity: 80,
        shadowMode: "Multiply", shadowColor: "#000000", shadowOpacity: 70,
      },
      dropShadow: {
        enabled: true, blendMode: "Multiply", opacity: 30, color: "#000000",
        angle: 120, distance: 4, spread: 0, size: 8, useGlobalLight: true,
      },
    },
  },
  {
    id: "b-ink-stamp",
    name: "Ink Stamp",
    effects: {
      colorOverlay: { enabled: true, blendMode: "Normal", opacity: 100, color: "#c1362c" },
      innerShadow: {
        enabled: true, blendMode: "Multiply", opacity: 30, color: "#4a0f0a",
        angle: 120, distance: 0, spread: 0, size: 6, useGlobalLight: false,
      },
    },
  },
  {
    id: "b-neon",
    name: "Neon",
    effects: {
      outerGlow: { enabled: true, blendMode: "Screen", opacity: 90, color: "#3ef0ff", spread: 10, size: 22 },
      innerGlow: { enabled: true, blendMode: "Screen", opacity: 70, color: "#ffffff", spread: 0, size: 8, source: "edge" },
      stroke: { enabled: true, blendMode: "Normal", opacity: 100, size: 2, position: "outside", fillType: "color", color: "#7ff8ff" },
    },
  },
  {
    id: "b-gold-foil",
    name: "Gold Foil",
    effects: {
      gradientOverlay: {
        enabled: true, blendMode: "Normal", opacity: 100, style: "linear", angle: 90, scale: 100,
        gradient: [
          { color: "#7a4b12ff", pos: 0 },
          { color: "#f7d67aff", pos: 0.35 },
          { color: "#fff6d5ff", pos: 0.5 },
          { color: "#d9a544ff", pos: 0.68 },
          { color: "#6b3f0eff", pos: 1 },
        ],
      },
      bevel: {
        enabled: true, style: "innerBevel", depth: 160, size: 6, soften: 1,
        angle: 120, altitude: 40, useGlobalLight: true,
        highlightMode: "Screen", highlightColor: "#fffbe8", highlightOpacity: 85,
        shadowMode: "Multiply", shadowColor: "#3a1f00", shadowOpacity: 70,
      },
      dropShadow: {
        enabled: true, blendMode: "Multiply", opacity: 50, color: "#000000",
        angle: 120, distance: 6, spread: 0, size: 12, useGlobalLight: true,
      },
    },
  },
  {
    id: "b-outline",
    name: "Outline",
    // Fill opacity 0 hides the layer's own pixels and leaves the stroke — the
    // ghost-outline trick, and the clearest demonstration of what fill opacity
    // does that does not need a second layer underneath.
    effects: {
      stroke: { enabled: true, blendMode: "Normal", opacity: 100, size: 3, position: "outside", fillType: "color", color: "#ffffff" },
    },
    fillOpacity: 0,
  },
  {
    id: "b-glass",
    name: "Glass",
    effects: {
      innerShadow: {
        enabled: true, blendMode: "Multiply", opacity: 35, color: "#0a1a2a",
        angle: 120, distance: 3, spread: 0, size: 10, useGlobalLight: true,
      },
      innerGlow: { enabled: true, blendMode: "Screen", opacity: 55, color: "#ffffff", spread: 0, size: 14, source: "edge" },
      stroke: { enabled: true, blendMode: "Normal", opacity: 60, size: 1, position: "inside", fillType: "color", color: "#ffffff" },
      dropShadow: {
        enabled: true, blendMode: "Multiply", opacity: 35, color: "#000000",
        angle: 120, distance: 8, spread: 0, size: 16, useGlobalLight: true,
      },
    },
    fillOpacity: 25,
  },
];

export const isBuiltinStyle = (id: string) => id.startsWith("b-");

export function loadSavedStyles(key: string = STYLE_PRESETS_KEY): LayerStylePreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as LayerStylePreset[]) : [];
    return Array.isArray(list) ? list.map(sanitize).filter((s): s is LayerStylePreset => !!s) : [];
  } catch {
    return [];
  }
}

export function persistSavedStyles(key: string, list: LayerStylePreset[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* quota or private mode — presets are a convenience, never a blocker */
  }
}

// ---- file format -----------------------------------------------------------

interface StyleFile {
  format: "graphiq-styles";
  version: 1;
  styles: Omit<LayerStylePreset, "id">[];
}

/** Accept anything shaped like a style; drop anything that is not. */
export function sanitize(raw: unknown): LayerStylePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<LayerStylePreset>;
  if (!o.effects || typeof o.effects !== "object") return null;
  const out: LayerStylePreset = {
    id: typeof o.id === "string" && o.id ? o.id : freshStyleId(),
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Style",
    effects: o.effects as LayerEffects,
  };
  if (typeof o.fillOpacity === "number" && Number.isFinite(o.fillOpacity))
    out.fillOpacity = Math.max(0, Math.min(100, o.fillOpacity));
  if (o.knockout === "shallow" || o.knockout === "deep") out.knockout = o.knockout;
  if (o.blendIf && typeof o.blendIf === "object") out.blendIf = o.blendIf as BlendIf;
  return out;
}

export function parseStyleFile(text: string): LayerStylePreset[] {
  try {
    const doc = JSON.parse(text) as StyleFile | LayerStylePreset[] | LayerStylePreset;
    const entries = Array.isArray(doc)
      ? doc
      : ((doc as StyleFile).styles ?? [doc as LayerStylePreset]);
    return (entries as unknown[]).map(sanitize).filter((s): s is LayerStylePreset => s !== null);
  } catch {
    return [];
  }
}

/**
 * Imported styles are ADDED, never replacing the library, and a name collision
 * gets a suffix rather than overwriting — importing a file should not be able to
 * destroy work the user already saved.
 */
export function mergeStyles(
  existing: LayerStylePreset[],
  imported: LayerStylePreset[],
): LayerStylePreset[] {
  const names = new Set(existing.map((s) => s.name));
  const out = [...existing];
  for (const s of imported) {
    let name = s.name;
    let n = 2;
    while (names.has(name)) name = `${s.name} ${n++}`;
    names.add(name);
    out.push({ ...s, id: freshStyleId(), name });
  }
  return out;
}

// Declared locally, as in gradientio / imageio / project — the File System
// Access API is not in the DOM lib this project builds against.
interface SaveHandle {
  createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
}
type ShowSaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

/** The file's text. Split out from `exportStyles` so the round trip is testable
 *  without a Blob or a file picker — parse(serialize(x)) is the property that
 *  actually matters, and it is worth checking against the real writer. */
export function serializeStyles(list: LayerStylePreset[]): string {
  const doc: StyleFile = {
    format: "graphiq-styles",
    version: 1,
    // Ids are local identity, not content — they are re-minted on import, so
    // writing them would only invite two libraries to disagree about who owns one.
    styles: list.map((s) => ({
      name: s.name,
      effects: s.effects,
      ...(s.fillOpacity !== undefined ? { fillOpacity: s.fillOpacity } : {}),
      ...(s.knockout !== undefined ? { knockout: s.knockout } : {}),
      ...(s.blendIf !== undefined ? { blendIf: s.blendIf } : {}),
    })),
  };
  return JSON.stringify(doc, null, 2);
}

export async function exportStyles(
  list: LayerStylePreset[],
  suggestedName = "layer-styles",
): Promise<boolean> {
  const blob = new Blob([serializeStyles(list)], { type: "application/json" });
  const name = `${suggestedName}.${STYLE_EXT}`;
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [
          { description: "Graphiq Layer Styles", accept: { "application/json": [`.${STYLE_EXT}`] } },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false; // user cancelled
      // anything else → fall through to a plain download
    }
  }
  downloadBlob(blob, name);
  return true;
}

export async function importStyleFiles(): Promise<LayerStylePreset[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${STYLE_EXT},.${LEGACY_STYLE_EXT},application/json`;
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const out: LayerStylePreset[] = [];
      for (const f of files) out.push(...parseStyleFile(await f.text()));
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}
