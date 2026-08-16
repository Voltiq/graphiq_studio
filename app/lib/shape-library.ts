/**
 * Custom shapes — a library of reusable outlines for the Shape tool, and SVG
 * import to fill it.
 *
 * A preset is nothing but a name and a path normalized into the unit square, so
 * drawing one is "scale this path into the drag box". That is what lets an
 * imported logo behave exactly like the built-in rectangle: same fill, same
 * stroke, same live resize, no separate code path.
 *
 * IMPORT IS DELIBERATELY NOT AN SVG RENDERER. It pulls the GEOMETRY out of a
 * file — `<path>` plus the primitive elements, which between them cover the
 * overwhelming majority of icon and logo files — and throws away paint, text,
 * gradients, filters, clip paths and nested transforms. A shape preset is an
 * outline; pretending to import artwork and then dropping half of it silently
 * would be worse than importing an outline and saying so.
 *
 * Storage and file handling mirror the gradient and layer-style libraries.
 *
 * Pure apart from localStorage and the file input.
 */

import { normalizePath, parsePath, pathToD, type PathSeg } from "./svgpath";
import { downloadBlob } from "./project";

export const SHAPE_PRESETS_KEY = "graphiq:custom-shapes";
export const SHAPE_EXT = "gshape";

export interface ShapePreset {
  id: string;
  name: string;
  /** Path data normalized into the unit square, aspect preserved and centred. */
  d: string;
}

export function freshShapeId(): string {
  return `shp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalize whatever geometry we have into a storable preset. */
export function presetFromSegs(name: string, segs: PathSeg[]): ShapePreset | null {
  if (!segs.length) return null;
  return { id: freshShapeId(), name: name.trim() || "Shape", d: pathToD(normalizePath(segs)) };
}

export function presetFromPathData(name: string, d: string): ShapePreset | null {
  return presetFromSegs(name, parsePath(d));
}

// ---- SVG extraction ----------------------------------------------------------

const attr = (tag: string, name: string): string | null => {
  // NOT `\b` before the name: a hyphen counts as a word boundary, so `\bwidth`
  // matches happily inside `stroke-width` and a rect ends up taking its stroke
  // width as its width. Hyphenated attributes are everywhere in SVG, so the
  // preceding character has to be excluded explicitly.
  const m = new RegExp(`(?<![-\\w:.])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
};
const num = (tag: string, name: string, dflt = 0): number => {
  const v = attr(tag, name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

/** `<rect>` → path data, honouring rx/ry when present. */
function rectToD(tag: string): string {
  const x = num(tag, "x");
  const y = num(tag, "y");
  const w = num(tag, "width");
  const h = num(tag, "height");
  if (w <= 0 || h <= 0) return "";
  let rx = num(tag, "rx", NaN);
  let ry = num(tag, "ry", NaN);
  // Either radius alone means both, per the spec.
  if (!Number.isFinite(rx) && !Number.isFinite(ry)) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  if (!Number.isFinite(rx)) rx = ry;
  if (!Number.isFinite(ry)) ry = rx;
  rx = Math.min(Math.max(0, rx), w / 2);
  ry = Math.min(Math.max(0, ry), h / 2);
  if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return (
    `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
    `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
    `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
    `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
  );
}

/** Ellipse (and circle) → two half-arcs, which is the standard construction. */
function ellipseToD(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return "";
  return (
    `M${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}` +
    `A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}Z`
  );
}

function pointsToD(tag: string, close: boolean): string {
  const raw = attr(tag, "points") ?? "";
  const nums = raw.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 4) return "";
  let d = `M${nums[0]} ${nums[1]}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`;
  return close ? d + "Z" : d;
}

/**
 * Every drawable outline in an SVG document, as one combined path.
 *
 * Combined rather than one preset per element: an icon is normally several
 * subpaths (a body and a couple of holes), and splitting them would turn one
 * shape into a pile of fragments that individually mean nothing.
 */
export function svgToPathData(svg: string): string {
  if (typeof svg !== "string") return "";
  // Comments can contain anything, including other elements.
  const text = svg.replace(/<!--[\s\S]*?-->/g, "");
  const parts: string[] = [];
  const tagRe = /<\s*(path|rect|circle|ellipse|polygon|polyline|line)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const kind = m[1].toLowerCase();
    const tag = m[0];
    if (kind === "path") {
      const d = attr(tag, "d");
      if (d) parts.push(d);
    } else if (kind === "rect") {
      parts.push(rectToD(tag));
    } else if (kind === "circle") {
      const r = num(tag, "r");
      parts.push(ellipseToD(num(tag, "cx"), num(tag, "cy"), r, r));
    } else if (kind === "ellipse") {
      parts.push(ellipseToD(num(tag, "cx"), num(tag, "cy"), num(tag, "rx"), num(tag, "ry")));
    } else if (kind === "polygon") {
      parts.push(pointsToD(tag, true));
    } else if (kind === "polyline") {
      parts.push(pointsToD(tag, false));
    } else if (kind === "line") {
      parts.push(`M${num(tag, "x1")} ${num(tag, "y1")}L${num(tag, "x2")} ${num(tag, "y2")}`);
    }
  }
  return parts.filter(Boolean).join(" ");
}

export function presetFromSvg(name: string, svg: string): ShapePreset | null {
  return presetFromPathData(name, svgToPathData(svg));
}

// ---- the shipped set ----------------------------------------------------------

/** Ids start `b-` so the UI can tell built-ins from the user's own. */
export const BUILTIN_SHAPES: ShapePreset[] = [
  { id: "b-arrow", name: "Arrow", d: "M0 35 L60 35 L60 10 L100 50 L60 90 L60 65 L0 65 Z" },
  { id: "b-star", name: "Star", d: "M50 2 L61 36 L97 36 L68 58 L79 92 L50 71 L21 92 L32 58 L3 36 L39 36 Z" },
  {
    id: "b-heart",
    name: "Heart",
    d: "M50 88 C10 60 4 34 20 20 C34 8 48 16 50 28 C52 16 66 8 80 20 C96 34 90 60 50 88 Z",
  },
  { id: "b-check", name: "Check", d: "M8 52 L20 40 L40 60 L80 20 L92 32 L40 84 Z" },
  { id: "b-cross", name: "Cross", d: "M35 5 H65 V35 H95 V65 H65 V95 H35 V65 H5 V35 H35 Z" },
  {
    id: "b-bubble",
    name: "Speech bubble",
    d: "M10 10 H90 A10 10 0 0 1 100 20 V64 A10 10 0 0 1 90 74 H44 L24 94 V74 H10 A10 10 0 0 1 0 64 V20 A10 10 0 0 1 10 10 Z",
  },
  { id: "b-bolt", name: "Lightning", d: "M58 2 L18 54 H44 L38 98 L82 42 H54 Z" },
  {
    id: "b-moon",
    name: "Moon",
    d: "M62 4 A48 48 0 1 0 62 96 A38 38 0 1 1 62 4 Z",
  },
];

export const isBuiltinShape = (id: string) => id.startsWith("b-");

/** Built-ins are authored in a 0–100 box; normalize once at module load so the
 *  renderer only ever sees unit-square paths. */
const NORMALIZED_BUILTINS: ShapePreset[] = BUILTIN_SHAPES.map((s) => ({
  ...s,
  d: pathToD(normalizePath(parsePath(s.d))),
}));

export const builtinShapes = (): ShapePreset[] => NORMALIZED_BUILTINS;

// ---- persistence ---------------------------------------------------------------

export function sanitizeShape(raw: unknown): ShapePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<ShapePreset>;
  if (typeof o.d !== "string" || !parsePath(o.d).length) return null;
  return {
    id: typeof o.id === "string" && o.id ? o.id : freshShapeId(),
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Shape",
    d: o.d,
  };
}

export function loadSavedShapes(key: string = SHAPE_PRESETS_KEY): ShapePreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return Array.isArray(list) ? list.map(sanitizeShape).filter((s): s is ShapePreset => !!s) : [];
  } catch {
    return [];
  }
}

export function persistSavedShapes(key: string, list: ShapePreset[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* quota or private mode — the library is a convenience, never a blocker */
  }
}

interface ShapeFile {
  format: "graphiq-shapes";
  version: 1;
  shapes: { name: string; d: string }[];
}

export function serializeShapes(list: ShapePreset[]): string {
  const doc: ShapeFile = {
    format: "graphiq-shapes",
    version: 1,
    shapes: list.map((s) => ({ name: s.name, d: s.d })),
  };
  return JSON.stringify(doc, null, 2);
}

export function parseShapeFile(text: string): ShapePreset[] {
  try {
    const doc = JSON.parse(text) as ShapeFile | ShapePreset[] | ShapePreset;
    const entries = Array.isArray(doc) ? doc : ((doc as ShapeFile).shapes ?? [doc as ShapePreset]);
    return (entries as unknown[]).map(sanitizeShape).filter((s): s is ShapePreset => !!s);
  } catch {
    return [];
  }
}

/** Imported shapes are ADDED; colliding names are suffixed, never overwritten. */
export function mergeShapes(existing: ShapePreset[], imported: ShapePreset[]): ShapePreset[] {
  const names = new Set(existing.map((s) => s.name));
  const out = [...existing];
  for (const s of imported) {
    let name = s.name;
    let n = 2;
    while (names.has(name)) name = `${s.name} ${n++}`;
    names.add(name);
    out.push({ ...s, id: freshShapeId(), name });
  }
  return out;
}

/** A file name (with or without extension) turned into a preset name. */
export const shapeNameFromFile = (file: string): string =>
  file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Shape";

// ---- files -------------------------------------------------------------------

interface SaveHandle {
  createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
}
type ShowSaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

export async function exportShapes(
  list: ShapePreset[],
  suggestedName = "custom-shapes",
): Promise<boolean> {
  const blob = new Blob([serializeShapes(list)], { type: "application/json" });
  const name = `${suggestedName}.${SHAPE_EXT}`;
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: "Graphiq Shapes", accept: { "application/json": [`.${SHAPE_EXT}`] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return false; // cancelled
    }
  }
  downloadBlob(blob, name);
  return true;
}

/**
 * Import shapes from `.svg` files or a saved `.gshape` library.
 *
 * One preset per SVG file, named after the file — an icon is one shape, and
 * splitting its subpaths would produce fragments rather than shapes.
 */
export async function importShapeFiles(): Promise<ShapePreset[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.svg,image/svg+xml,.${SHAPE_EXT},application/json`;
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const out: ShapePreset[] = [];
      for (const f of files) {
        const text = await f.text();
        if (/\.svg$/i.test(f.name) || /<svg[\s>]/i.test(text)) {
          const p = presetFromSvg(shapeNameFromFile(f.name), text);
          if (p) out.push(p);
        } else {
          out.push(...parseShapeFile(text));
        }
      }
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}
