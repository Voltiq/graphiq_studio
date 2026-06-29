// Shared, persisted custom colour swatches (used by every ColorPicker instance).
import { parseColor, toHex8 } from "./color";

const KEY = "graphiq:swatches";
const LEGACY_KEY = "aperture:swatches"; // pre-rebrand key, read once as a fallback
type Listener = (swatches: string[]) => void;
const listeners = new Set<Listener>();
let cache: string[] | null = null;

function load(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export function getSwatches(): string[] {
  if (!cache) cache = load();
  return cache;
}

export function setSwatches(list: string[]): void {
  cache = list;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore (private mode / quota) */
  }
  listeners.forEach((l) => l(list));
}

/** Subscribe to changes so all open pickers stay in sync. Returns an unsubscribe. */
export function subscribeSwatches(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Add a colour to the end (ignoring exact duplicates). */
export function addSwatch(color: string): void {
  const list = getSwatches();
  const c = color.toLowerCase();
  if (list.some((x) => x.toLowerCase() === c)) return;
  setSwatches([...list, color]);
}

export function removeSwatchAt(index: number): void {
  const list = getSwatches();
  if (index < 0 || index >= list.length) return;
  setSwatches(list.filter((_, i) => i !== index));
}

// ----------------------------- Import / export -----------------------------

/** Serialize swatches to a portable `.json` palette body. */
export function swatchesToFileJSON(colors: string[]): string {
  return JSON.stringify({ type: "graphiq-swatches", version: 1, colors }, null, 2);
}

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function normalize(c: string): string | null {
  try {
    return toHex8(parseColor(c));
  } catch {
    return null;
  }
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of list) {
    const k = c.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * Parse colours from an imported palette file. Accepts our JSON (or a bare JSON
 * array), GIMP `.gpl` palettes, and any file with loose `#hex` colours.
 */
export function parseSwatchFile(text: string): string[] {
  const trimmed = text.trim();
  const out: string[] = [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(data)
        ? data
        : Array.isArray((data as { colors?: unknown })?.colors)
          ? (data as { colors: unknown[] }).colors
          : null;
      if (arr) {
        for (const c of arr) {
          const n = typeof c === "string" ? normalize(c) : null;
          if (n) out.push(n);
        }
        return dedupe(out);
      }
    } catch {
      /* not JSON — fall through to text parsing */
    }
  }

  if (/GIMP Palette/i.test(trimmed)) {
    for (const line of trimmed.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) out.push(toHex8({ r: +m[1], g: +m[2], b: +m[3], a: 1 }));
    }
    if (out.length) return dedupe(out);
  }

  for (const h of trimmed.match(HEX_RE) ?? []) {
    const n = normalize(h);
    if (n) out.push(n);
  }
  return dedupe(out);
}
