/**
 * Layer comps — named snapshots of what the layers are doing, so one document
 * can hold several presentations of the same artwork and you can flip between
 * them. Photoshop's model: a comp records **visibility**, **position** and
 * **appearance** (layer style), you choose which of the three it captures, and
 * applying it puts the document back into that state.
 *
 * POSITION IS THE INTERESTING ONE HERE. Photoshop layers carry an offset, so a
 * comp can record a number. In this engine a layer IS a full-canvas raster and
 * moving it rewrites pixels — there is no coordinate to store. So a comp records
 * the layer's **content bounding box** instead, and applying one translates the
 * pixels by the difference between the recorded origin and the current one.
 *
 * That works because a translation moves a bounding box without reshaping it,
 * which also gives an exact guard: if the current box is a different SIZE, the
 * layer's content changed since capture (painted on, filtered, or dragged partly
 * off-canvas and clipped) and the recorded origin no longer describes it. Then
 * the comp refuses to move that layer and says so, rather than sliding the
 * pixels somewhere arbitrary. Refusing is the whole point — a silently wrong
 * position is worse than an honest "this one moved on".
 *
 * Pure and DOM-free: bounds come in through a callback, and applying returns the
 * new tree plus a list of moves for the caller to perform on the engine.
 */

import type { LayerNode } from "./layers";
import type { LayerEffects } from "./effects";
import type { BlendIf } from "./blendif";
import type { KnockoutMode } from "./knockout";

export interface CompRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The three attribute groups a comp can capture, in Photoshop's order. */
export const COMP_ATTRS = ["visibility", "position", "appearance"] as const;
export type CompAttr = (typeof COMP_ATTRS)[number];

export const COMP_ATTR_LABEL: Record<CompAttr, string> = {
  visibility: "Visibility",
  position: "Position",
  appearance: "Appearance (layer style)",
};

/** One layer's recorded state. Every field is optional: a comp that captures
 *  only visibility stores only `visible`, and applying it touches nothing else. */
export interface CompLayerState {
  visible?: boolean;
  /** Content bounds at capture. `null` = the layer had no pixels. */
  bounds?: CompRect | null;
  opacity?: number;
  blend?: string;
  effects?: LayerEffects;
  fillOpacity?: number;
  knockout?: KnockoutMode;
  blendIf?: BlendIf;
  clipped?: boolean;
}

export interface LayerComp {
  id: string;
  name: string;
  comment?: string;
  /** Which attribute groups this comp records (and therefore restores). */
  capture: CompAttr[];
  /** Keyed by layer id. Layers absent from this map are left alone on apply. */
  states: Record<string, CompLayerState>;
}

export function freshCompId(): string {
  return `comp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Depth-first walk over every node in the tree. */
export function walkNodes(tree: LayerNode[], visit: (n: LayerNode) => void): void {
  for (const n of tree) {
    visit(n);
    if (n.type === "group") walkNodes(n.children, visit);
  }
}

/** Only a pixel layer has a position to record. Groups composite their children
 *  (which are captured individually), adjustments and Fill layers are
 *  full-canvas and parametric — none of them has pixels of their own to move. */
export const hasMovablePixels = (n: LayerNode): boolean => n.type === "layer" && !n.fill;

// ---- capture ----------------------------------------------------------------

export function captureComp(
  name: string,
  capture: CompAttr[],
  tree: LayerNode[],
  boundsOf: (id: string) => CompRect | null,
): LayerComp {
  const attrs = COMP_ATTRS.filter((a) => capture.includes(a));
  const states: Record<string, CompLayerState> = {};
  walkNodes(tree, (n) => {
    const s: CompLayerState = {};
    if (attrs.includes("visibility")) s.visible = n.visible;
    if (attrs.includes("position") && hasMovablePixels(n)) {
      const b = boundsOf(n.id);
      s.bounds = b ? { ...b } : null;
    }
    if (attrs.includes("appearance")) {
      s.opacity = n.opacity;
      s.blend = n.blend;
      s.clipped = !!n.clipped;
      // Undefined is meaningful for these — it is the "no style" state, and a
      // comp has to be able to restore a layer BACK to it.
      s.effects = n.effects ? structuredClone(n.effects) : undefined;
      s.fillOpacity = n.fillOpacity;
      s.knockout = n.knockout;
      s.blendIf = n.blendIf ? structuredClone(n.blendIf) : undefined;
    }
    states[n.id] = s;
  });
  return { id: freshCompId(), name: name.trim() || "Layer Comp", capture: attrs, states };
}

// ---- apply ------------------------------------------------------------------

/** A pixel translation the caller must run on the engine. */
export interface CompMove {
  id: string;
  dx: number;
  dy: number;
}

export type CompSkipReason = "changed" | "empty";

export interface CompApplyResult {
  layers: LayerNode[];
  /** Layers to translate, non-zero deltas only. */
  moves: CompMove[];
  /** Position could not be restored for these (see `CompSkipReason`). */
  skipped: { id: string; name: string; reason: CompSkipReason }[];
  /** Recorded layers that no longer exist. */
  missing: string[];
  /** Layers that exist but the comp never saw (created after capture). */
  unknown: string[];
}

function applyState(n: LayerNode, s: CompLayerState, attrs: CompAttr[]): LayerNode {
  let out = n;
  const set = <K extends keyof LayerNode>(k: K, v: LayerNode[K]) => {
    if (out[k] !== v) out = { ...out, [k]: v };
  };
  if (attrs.includes("visibility") && s.visible !== undefined) set("visible", s.visible);
  if (attrs.includes("appearance")) {
    if (s.opacity !== undefined) set("opacity", s.opacity);
    if (s.blend !== undefined) set("blend", s.blend);
    // These four are written unconditionally (undefined included): a comp taken
    // before a drop shadow existed has to be able to take the shadow back off.
    out = {
      ...out,
      effects: s.effects ? structuredClone(s.effects) : undefined,
      fillOpacity: s.fillOpacity,
      knockout: s.knockout,
      blendIf: s.blendIf ? structuredClone(s.blendIf) : undefined,
      clipped: !!s.clipped,
    };
  }
  return out;
}

export function applyComp(
  comp: LayerComp,
  tree: LayerNode[],
  boundsOf: (id: string) => CompRect | null,
): CompApplyResult {
  const attrs = comp.capture;
  const moves: CompMove[] = [];
  const skipped: CompApplyResult["skipped"] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  const walk = (nodes: LayerNode[]): LayerNode[] =>
    nodes.map((n) => {
      const s = comp.states[n.id];
      let out = n;
      if (s) {
        seen.add(n.id);
        out = applyState(n, s, attrs);
        if (attrs.includes("position") && hasMovablePixels(n) && s.bounds !== undefined) {
          const cur = boundsOf(n.id);
          if (!s.bounds || !cur) {
            // One side has no pixels at all — there is no origin to line up.
            if (s.bounds !== cur) skipped.push({ id: n.id, name: n.name, reason: "empty" });
          } else if (cur.w !== s.bounds.w || cur.h !== s.bounds.h) {
            skipped.push({ id: n.id, name: n.name, reason: "changed" });
          } else {
            const dx = s.bounds.x - cur.x;
            const dy = s.bounds.y - cur.y;
            if (dx !== 0 || dy !== 0) moves.push({ id: n.id, dx, dy });
          }
        }
      } else {
        unknown.push(n.id);
      }
      if (out.type === "group") {
        const g = out; // narrowing is lost inside the closure below if `out` is read there
        const children = walk(g.children);
        if (children.some((c, i) => c !== g.children[i])) out = { ...g, children };
      }
      return out;
    });

  const layers = walk(tree);
  const missing = Object.keys(comp.states).filter((id) => !seen.has(id));
  return { layers, moves, skipped, missing, unknown };
}

/**
 * Does the document currently look like this comp?
 *
 * Only the attributes the comp captured are compared — a visibility-only comp is
 * "current" whatever the opacities are, because those are not its business.
 */
export function compIsCurrent(
  comp: LayerComp,
  tree: LayerNode[],
  boundsOf: (id: string) => CompRect | null,
): boolean {
  let same = true;
  let seen = 0;
  walkNodes(tree, (n) => {
    if (!same) return;
    const s = comp.states[n.id];
    if (!s) {
      same = false; // a layer the comp never saw
      return;
    }
    seen++;
    if (comp.capture.includes("visibility") && s.visible !== undefined && s.visible !== n.visible)
      same = false;
    if (comp.capture.includes("appearance")) {
      if (
        s.opacity !== n.opacity ||
        s.blend !== n.blend ||
        !!s.clipped !== !!n.clipped ||
        s.fillOpacity !== n.fillOpacity ||
        s.knockout !== n.knockout ||
        JSON.stringify(s.effects ?? null) !== JSON.stringify(n.effects ?? null) ||
        JSON.stringify(s.blendIf ?? null) !== JSON.stringify(n.blendIf ?? null)
      )
        same = false;
    }
    if (comp.capture.includes("position") && hasMovablePixels(n) && s.bounds !== undefined) {
      const cur = boundsOf(n.id);
      if (!s.bounds || !cur) {
        if (s.bounds !== cur) same = false;
      } else if (cur.x !== s.bounds.x || cur.y !== s.bounds.y || cur.w !== s.bounds.w || cur.h !== s.bounds.h)
        same = false;
    }
  });
  return same && seen === Object.keys(comp.states).length;
}

/** A one-line summary of what a comp records, for the panel. */
export function compSummary(comp: LayerComp): string {
  if (!comp.capture.length) return "Records nothing";
  const short: Record<CompAttr, string> = {
    visibility: "Visibility",
    position: "Position",
    appearance: "Appearance",
  };
  return COMP_ATTRS.filter((a) => comp.capture.includes(a))
    .map((a) => short[a])
    .join(" · ");
}

// ---- persistence ------------------------------------------------------------

function sanitizeRect(raw: unknown): CompRect | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<CompRect>;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!ok(r.x) || !ok(r.y) || !ok(r.w) || !ok(r.h)) return undefined;
  return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

/** Validate comps read from a `.gproj` — junk is dropped, never thrown on. */
export function sanitizeComps(raw: unknown): LayerComp[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: LayerComp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<LayerComp>;
    if (!o.states || typeof o.states !== "object") continue;
    const id = typeof o.id === "string" && o.id && !ids.has(o.id) ? o.id : freshCompId();
    ids.add(id);
    const states: Record<string, CompLayerState> = {};
    for (const [layerId, s] of Object.entries(o.states as Record<string, unknown>)) {
      if (!s || typeof s !== "object") continue;
      const src = s as CompLayerState;
      const st: CompLayerState = {};
      if (typeof src.visible === "boolean") st.visible = src.visible;
      if ("bounds" in src) {
        const b = sanitizeRect(src.bounds);
        if (b !== undefined) st.bounds = b;
      }
      if (typeof src.opacity === "number" && Number.isFinite(src.opacity)) st.opacity = src.opacity;
      if (typeof src.blend === "string") st.blend = src.blend;
      if (typeof src.clipped === "boolean") st.clipped = src.clipped;
      if (src.effects && typeof src.effects === "object") st.effects = src.effects;
      if (typeof src.fillOpacity === "number" && Number.isFinite(src.fillOpacity))
        st.fillOpacity = src.fillOpacity;
      if (src.knockout === "shallow" || src.knockout === "deep") st.knockout = src.knockout;
      if (src.blendIf && typeof src.blendIf === "object") st.blendIf = src.blendIf;
      states[layerId] = st;
    }
    out.push({
      id,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Layer Comp",
      ...(typeof o.comment === "string" && o.comment.trim() ? { comment: o.comment.trim() } : {}),
      capture: Array.isArray(o.capture) ? COMP_ATTRS.filter((a) => o.capture!.includes(a)) : [],
      states,
    });
  }
  return out;
}

/**
 * Rewrite a comp's layer keys through an id map.
 *
 * Loading a `.gproj` mints fresh layer ids so an opened project cannot collide
 * with documents already open — which silently invalidates every comp, since a
 * comp is nothing but a map keyed by layer id. Entries with no mapping are
 * dropped rather than kept: a key pointing at a layer that does not exist would
 * be reported as "missing" on every apply, forever.
 */
export function remapComps(comps: LayerComp[], idMap: Map<string, string>): LayerComp[] {
  return comps.map((c) => {
    const states: Record<string, CompLayerState> = {};
    for (const [oldId, s] of Object.entries(c.states)) {
      const next = idMap.get(oldId);
      if (next) states[next] = s;
    }
    return { ...c, states };
  });
}

/** Ensure a new comp's name does not collide with an existing one. */
export function uniqueCompName(existing: LayerComp[], want: string): string {
  const taken = new Set(existing.map((c) => c.name));
  const base = want.trim() || "Layer Comp";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** What the Comps panel is handed (mirrors PathsApi / the other panel APIs). */
export interface CompsApi {
  comps: LayerComp[];
  /** The comp the document currently matches, if any. */
  currentId: string | null;
  create: (capture: CompAttr[]) => void;
  apply: (id: string) => void;
  /** Re-capture this comp from the document as it stands now. */
  update: (id: string) => void;
  rename: (id: string, name: string) => void;
  setCapture: (id: string, capture: CompAttr[]) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
}

/** `attrs` with one entry toggled — keeps COMP_ATTRS order, never duplicates. */
export function toggleAttr(attrs: CompAttr[], a: CompAttr): CompAttr[] {
  const next = attrs.includes(a) ? attrs.filter((x) => x !== a) : [...attrs, a];
  return COMP_ATTRS.filter((x) => next.includes(x));
}
