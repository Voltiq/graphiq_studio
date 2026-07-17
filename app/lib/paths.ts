// Stored pen paths (TODO §6 Paths panel). Pure model + geometry — the panel
// and Editor do the wiring; nothing here touches the engine or React.
//
// A SavedPath is a pen path (cubic bezier anchors, same PenAnchor shape the
// Pen tool edits) kept on the DOCUMENT, independent of any layer. The pen
// tool's committed path is auto-stored as the "Work Path" (Photoshop-style,
// replaced on every commit); Save duplicates it under a permanent name.
// Reuse happens through the existing machinery: → selection via the lasso
// rasterizer (sampled polygon), → stroke via the engine's livePath/endPath,
// → fill via the selection fill; boolean combines ride the selection ops
// (add / subtract / intersect) — TRUE bezier booleans are out of scope.

import type { PenAnchor } from "./tools";

export interface SavedPath {
  id: string;
  name: string;
  anchors: PenAnchor[];
  closed: boolean;
}

/** The auto-stored latest pen commit (replaced each time; Save duplicates it). */
export const WORK_PATH_ID = "work";

let pathSeq = 0;
export function freshPathId(): string {
  return `path-${Date.now().toString(36)}-${(pathSeq += 1)}`;
}

/** Deep-copy anchors (stored paths must never alias the live editing state). */
export const cloneAnchors = (anchors: PenAnchor[]): PenAnchor[] => anchors.map((a) => ({ ...a }));

/**
 * Sample the path's cubic segments into a polygon (positions only — the same
 * bezier geometry pen.ts strokes). `steps` points per segment; consecutive
 * segment endpoints are not duplicated. Closed paths include the closing
 * segment (last→first), so the polygon ends adjacent to its start.
 */
export function samplePathPolygon(
  anchors: PenAnchor[],
  closed: boolean,
  steps = 24,
): { x: number; y: number }[] {
  if (anchors.length < 2) return anchors.map((a) => ({ x: a.x, y: a.y }));
  const segs: [PenAnchor, PenAnchor][] = [];
  for (let i = 0; i < anchors.length - 1; i++) segs.push([anchors[i], anchors[i + 1]]);
  if (closed && anchors.length > 2) segs.push([anchors[anchors.length - 1], anchors[0]]);
  const pts: { x: number; y: number }[] = [];
  segs.forEach(([a, b], si) => {
    const last = si === segs.length - 1 && !closed;
    const upper = last ? steps : steps - 1; // skip the shared endpoint mid-path
    for (let s = 0; s <= upper; s++) {
      const u = s / steps;
      const mu = 1 - u;
      pts.push({
        x: mu * mu * mu * a.x + 3 * mu * mu * u * a.ox + 3 * mu * u * u * b.ix + u * u * u * b.x,
        y: mu * mu * mu * a.y + 3 * mu * mu * u * a.oy + 3 * mu * u * u * b.iy + u * u * u * b.y,
      });
    }
  });
  return pts;
}

/** SVG path data for the anchors (M + C segments, Z when closed) — powers the
 *  panel thumbnails via a plain <svg><path> (no canvas management). */
export function pathToSvgD(anchors: PenAnchor[], closed: boolean): string {
  if (!anchors.length) return "";
  const f = (v: number) => String(Math.round(v * 100) / 100);
  let d = `M ${f(anchors[0].x)} ${f(anchors[0].y)}`;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    d += ` C ${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`;
  }
  if (closed && anchors.length > 2) {
    const a = anchors[anchors.length - 1];
    const b = anchors[0];
    d += ` C ${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)} Z`;
  }
  return d;
}

/** Bounding box over anchors + handles (the curve's convex hull bound). */
export function pathBounds(anchors: PenAnchor[]): { x: number; y: number; w: number; h: number } {
  if (!anchors.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of anchors) {
    for (const [x, y] of [
      [a.x, a.y],
      [a.ix, a.iy],
      [a.ox, a.oy],
    ]) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0, y: y0, w: Math.max(1e-6, x1 - x0), h: Math.max(1e-6, y1 - y0) };
}

/** Coerce arbitrary parsed data (project load) into a valid SavedPath list. */
export function coercePaths(raw: unknown): SavedPath[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const out: SavedPath[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Partial<SavedPath>;
    if (typeof o.id !== "string" || typeof o.name !== "string" || !Array.isArray(o.anchors)) continue;
    const anchors = o.anchors.filter(
      (a): a is PenAnchor =>
        !!a && typeof a === "object" &&
        num((a as PenAnchor).x) && num((a as PenAnchor).y) &&
        num((a as PenAnchor).ix) && num((a as PenAnchor).iy) &&
        num((a as PenAnchor).ox) && num((a as PenAnchor).oy),
    );
    if (anchors.length < 2) continue;
    out.push({ id: o.id, name: o.name, anchors: cloneAnchors(anchors), closed: !!o.closed });
  }
  return out;
}

/** How a stored path combines into the current selection. */
export type PathSelectOp = "new" | "add" | "subtract" | "intersect";

/** Everything the Paths panel needs (implemented by Editor, like LayersApi). */
export interface PathsApi {
  paths: SavedPath[];
  /** Rasterize the path into the selection (Ctrl=add, Alt=subtract, Ctrl+Alt=intersect). */
  toSelection: (id: string, op: PathSelectOp) => void;
  /** Stroke the path onto the active layer with the Pen tool's current settings. */
  stroke: (id: string) => void;
  /** Fill the path's region on the active layer with the foreground colour. */
  fill: (id: string) => void;
  /** Load the path back into the Pen tool for editing. */
  edit: (id: string) => void;
  /** Duplicate the Work Path (or any path) under a permanent name. */
  save: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
}
