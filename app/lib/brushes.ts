// Shared, persisted brush presets (TODO §13 Brushes panel).
//
// A preset is just a named BrushSettings bundle plus the tool it was captured
// from, so applying one restores the whole feel of a brush (size, hardness,
// opacity, flow, blend, smoothing) in one click. Stored under `graphiq:brushes`
// as {version:1, presets:[…]}; the built-ins below are always available and are
// never persisted (so improving them ships to everyone).
//
// Everything here is pure and DOM-free (Node-verifiable) — the tip THUMBNAIL is
// drawn by the panel from `tipProfile`, which returns the brush's analytic
// radial falloff, the same curve the engine's soft tip is baked from.

import type { BrushSettings } from "./paint";
import { DEFAULT_DYNAMICS } from "./pointer";

const KEY = "graphiq:brushes";

/** Which paint tool a preset was captured from — presets apply to any brush-ish
 *  tool, this is only shown as a hint on the row. */
export type BrushPresetTool = "brush" | "pencil" | "eraser";

export interface BrushPreset {
  id: string;
  name: string;
  tool: BrushPresetTool;
  settings: BrushSettings;
  /** True for the shipped presets (not persisted, not deletable/renamable). */
  builtin?: boolean;
}

let seq = 0;
export function freshBrushId(): string {
  return `br-${Date.now().toString(36)}-${(seq += 1)}`;
}

const S = (
  size: number,
  hardness: number,
  opacity: number,
  flow: number,
  smoothing: number,
  blend = "Normal",
): BrushSettings => ({ size, hardness, opacity, flow, blend, smoothing });

/** Shipped presets — a spread of everyday tips. Always present, never stored. */
export const BUILTIN_BRUSHES: BrushPreset[] = [
  { id: "b-soft-round", name: "Soft Round", tool: "brush", builtin: true, settings: S(24, 0, 100, 100, 20) },
  { id: "b-hard-round", name: "Hard Round", tool: "brush", builtin: true, settings: S(18, 100, 100, 100, 10) },
  { id: "b-fine-liner", name: "Fine Liner", tool: "brush", builtin: true, settings: S(4, 90, 100, 100, 40) },
  { id: "b-marker", name: "Marker", tool: "brush", builtin: true, settings: S(40, 75, 85, 70, 25) },
  { id: "b-airbrush", name: "Airbrush", tool: "brush", builtin: true, settings: S(90, 0, 55, 18, 30) },
  { id: "b-wash", name: "Soft Wash", tool: "brush", builtin: true, settings: S(160, 0, 30, 10, 45) },
  { id: "b-pencil", name: "Pencil", tool: "pencil", builtin: true, settings: S(3, 100, 100, 100, 0) },
  { id: "b-eraser-soft", name: "Soft Eraser", tool: "eraser", builtin: true, settings: S(50, 0, 100, 100, 15) },
  { id: "b-eraser-hard", name: "Hard Eraser", tool: "eraser", builtin: true, settings: S(30, 100, 100, 100, 0) },
];

/* ------------------------------ validation -------------------------------- */

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/** Coerce untrusted data into valid BrushSettings (import / stored JSON). */
export function coerceSettings(raw: unknown): BrushSettings {
  const o = (raw ?? {}) as Partial<BrushSettings>;
  return {
    size: Math.round(num(o.size, 24, 1, 2000)),
    hardness: Math.round(num(o.hardness, 100, 0, 100)),
    opacity: Math.round(num(o.opacity, 100, 0, 100)),
    flow: Math.round(num(o.flow, 100, 0, 100)),
    blend: typeof o.blend === "string" && o.blend ? o.blend : "Normal",
    smoothing: Math.round(num(o.smoothing, 0, 0, 100)),
    // Pressure dynamics: absent means "the default", so an older preset (or a
    // hand-written .gbr) keeps behaving exactly as the built-ins do.
    pressureSize: typeof o.pressureSize === "boolean" ? o.pressureSize : DEFAULT_DYNAMICS.size,
    pressureFlow: typeof o.pressureFlow === "boolean" ? o.pressureFlow : DEFAULT_DYNAMICS.flow,
    pressureMin: Math.round(num(o.pressureMin, DEFAULT_DYNAMICS.min, 0, 100)),
  };
}

const TOOLS: BrushPresetTool[] = ["brush", "pencil", "eraser"];

/** Coerce one untrusted entry into a preset (null when unusable). */
export function coercePreset(raw: unknown): BrushPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : null;
  if (!name) return null;
  const tool = TOOLS.includes(o.tool as BrushPresetTool) ? (o.tool as BrushPresetTool) : "brush";
  return {
    id: typeof o.id === "string" && o.id ? o.id : freshBrushId(),
    name,
    tool,
    settings: coerceSettings(o.settings),
  };
}

/* ------------------------------ load / persist ----------------------------- */

/** Parse the stored blob into user presets (built-ins are added separately). */
export function coerceStore(raw: unknown): BrushPreset[] {
  const list = Array.isArray(raw)
    ? raw // tolerate a bare array
    : raw && typeof raw === "object" && Array.isArray((raw as { presets?: unknown[] }).presets)
      ? (raw as { presets: unknown[] }).presets
      : null;
  if (!list) return [];
  const out: BrushPreset[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const p = coercePreset(item);
    if (!p) continue;
    if (seen.has(p.id)) p.id = freshBrushId(); // de-dup ids from hand-edited files
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** User presets from localStorage (built-ins NOT included). */
export function loadBrushPresets(): BrushPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? coerceStore(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveBrushPresets(presets: BrushPreset[]): void {
  try {
    // Built-ins are code, not content — never persist them.
    const user = presets.filter((p) => !p.builtin);
    window.localStorage.setItem(KEY, JSON.stringify({ version: 1, presets: user }));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/* --------------------- shared live store (panel ↔ options bar) ------------- */
// One cache + listener set so the Brushes panel and the options-bar preset
// picker always agree: saving in the panel updates the dropdown immediately.

let cache: BrushPreset[] | null = null;
type Listener = (presets: BrushPreset[]) => void;
const listeners = new Set<Listener>();

/** The user's presets (loaded once, then served from memory). */
export function getBrushPresets(): BrushPreset[] {
  if (!cache) cache = loadBrushPresets();
  return cache;
}

/** Replace the user's presets: persist and notify every subscriber. */
export function setBrushPresets(next: BrushPreset[]): void {
  cache = next.filter((p) => !p.builtin);
  saveBrushPresets(cache);
  for (const l of listeners) l(cache);
}

export function subscribeBrushPresets(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/* ------------------------------ import / export ---------------------------- */

/** Serialize presets to the app's `.gbr` JSON (user presets only). */
export function exportBrushes(presets: BrushPreset[]): string {
  return JSON.stringify(
    {
      format: "graphiq-brushes",
      version: 1,
      presets: presets
        .filter((p) => !p.builtin)
        .map(({ id, name, tool, settings }) => ({ id, name, tool, settings })),
    },
    null,
    2,
  );
}

/** Parse an imported brush file (our JSON, or a bare array/single preset). */
export function parseBrushImport(text: string): BrushPreset[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  // A single preset object is accepted too.
  if (data && typeof data === "object" && !Array.isArray(data) && "name" in (data as object)) {
    const one = coercePreset(data);
    return one ? [one] : [];
  }
  return coerceStore(data);
}

/** Merge imported presets in, giving fresh ids so nothing is overwritten. */
export function mergeBrushes(existing: BrushPreset[], incoming: BrushPreset[]): BrushPreset[] {
  return [...existing, ...incoming.map((p) => ({ ...p, id: freshBrushId(), builtin: undefined }))];
}

/* ------------------------------ tip preview -------------------------------- */

/**
 * Normalized alpha profile of a brush tip: `at(r)` for r in 0..1 (centre→edge),
 * matching the engine's soft-tip falloff — fully opaque out to the hardness
 * plateau, then a smooth shoulder to zero. Panels draw thumbnails from this, so
 * a preview always reflects what the brush will actually lay down.
 */
export function tipProfile(hardness: number): (r: number) => number {
  const h = clamp(hardness, 0, 100) / 100;
  return (r: number) => {
    const x = clamp(r, 0, 1);
    if (x <= h) return 1;
    if (h >= 1) return x <= 1 ? 1 : 0;
    const t = (x - h) / (1 - h); // 0 at the plateau edge → 1 at the rim
    const s = 1 - t;
    return s * s * (3 - 2 * s); // smoothstep shoulder
  };
}

/** A short human summary of a preset's settings (row subtitle). */
export function presetSummary(s: BrushSettings): string {
  const bits = [`${Math.round(s.size)} px`, `${Math.round(s.hardness)}% hard`];
  if (s.opacity < 100) bits.push(`${Math.round(s.opacity)}% opac`);
  if (s.flow < 100) bits.push(`${Math.round(s.flow)}% flow`);
  if (s.blend && s.blend !== "Normal") bits.push(s.blend);
  return bits.join(" · ");
}
