import type { AdjustmentSpec } from "./adjust";
import type { FxKey, LayerEffects } from "./effects";
import type { SmartFilter } from "./filters";
import type { BlendIf } from "./blendif";
import type { GradientStop, GradientType, VectorData } from "./tools";

/** Per-layer mask metadata. The mask *pixels* live in the paint engine (keyed by
 *  layer id, mirroring layer pixels); only this metadata lives on the tree. */
import type { VectorMask } from "./vector-mask";

export interface MaskMeta {
  /** Mask participates in compositing when true; false = temporarily disabled. */
  enabled: boolean;
  /** When true, Move transforms layer + mask together; false = only the active
   *  surface moves. */
  linked: boolean;
}

/** Which surface of a layer paint tools currently target. */
export type ActiveSurface = "pixels" | "mask" | "filterMask";

/** Engine masks-map key of a node's smart-filter mask. The filter mask reuses
 *  the ENTIRE layer-mask machinery (grayscale canvas, alpha cache, history's
 *  "mask" surface, restore paths) by living in the same engine maps under this
 *  derived key — the layer mask stays under the plain node id. */
export function filterMaskKey(id: string): string {
  return "fm:" + id;
}

/** Engine masks-map key of a DOCUMENT's Quick Mask raster. Keyed by document,
 *  not by layer: a quick mask paints a selection, which belongs to the document
 *  — so switching tabs leaves each document's quick mask intact. It rides the
 *  same mask machinery as the two above, but is never composited: the red
 *  overlay is drawn by the canvas, and the raster leaves the document's pixels
 *  untouched until it is turned back into a selection. */
export function quickMaskKey(docId: string): string {
  return "qm:" + docId;
}

/** Colour-label tags for panel organization (filterable; persisted in .gproj). */
export type LayerLabel = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export const LAYER_LABELS: { id: LayerLabel; color: string; name: string }[] = [
  { id: "red", color: "#ef4444", name: "Red" },
  { id: "orange", color: "#f97316", name: "Orange" },
  { id: "yellow", color: "#eab308", name: "Yellow" },
  { id: "green", color: "#22c55e", name: "Green" },
  { id: "blue", color: "#3b82f6", name: "Blue" },
  { id: "purple", color: "#a855f7", name: "Purple" },
  { id: "gray", color: "#9ca3af", name: "Gray" },
];

/** Display colour of a label id ("" for none/unknown). */
export const labelColor = (l: LayerLabel | undefined): string =>
  LAYER_LABELS.find((x) => x.id === l)?.color ?? "";

/** Per-layer edit locks — Photoshop's lock row. `all` implies the other three. */
export interface LayerLocks {
  /** Freeze the alpha channel: paint only where the layer is already opaque. */
  transparency?: boolean;
  /** Block every pixel edit (paint, fill, filter/adjustment bake). */
  pixels?: boolean;
  /** Block moving / transforming the layer. */
  position?: boolean;
  /** Lock everything (transparency + pixels + position). */
  all?: boolean;
}

export type LockFlag = "transparency" | "pixels" | "position" | "all";

type MaybeLocked = { locks?: LayerLocks } | null | undefined;
/** Effective checks — a flag is on when it's set OR `all` is set. */
export const isTransparencyLocked = (n: MaybeLocked): boolean =>
  !!n?.locks && (!!n.locks.all || !!n.locks.transparency);
export const isPixelsLocked = (n: MaybeLocked): boolean =>
  !!n?.locks && (!!n.locks.all || !!n.locks.pixels);
export const isPositionLocked = (n: MaybeLocked): boolean =>
  !!n?.locks && (!!n.locks.all || !!n.locks.position);
export const hasAnyLock = (n: MaybeLocked): boolean =>
  !!n?.locks &&
  (!!n.locks.all || !!n.locks.transparency || !!n.locks.pixels || !!n.locks.position);

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0–100 */
  opacity: number;
  blend: string;
  /** Colour label (organization only — never affects rendering). */
  label?: LayerLabel;
  /** Edit locks (transparency / pixels / position / all). Absent ⇒ unlocked. */
  locks?: LayerLocks;
  /** Link key: nodes sharing the same non-empty key move together (like PS's
   *  linked layers) without being grouped. Absent ⇒ not linked. */
  linkKey?: string;
  /** Present ⇒ the layer carries a raster mask (pixels held by the engine). */
  mask?: MaskMeta;
  /** A pen path used as a mask, alongside (and multiplied with) the raster one.
   *  The path stays the source of truth, so it re-rasterises crisply at any
   *  document size — see vector-mask.ts. */
  vectorMask?: VectorMask;
  /** Non-destructive layer effects (drop shadow, glow, stroke, …); rendered at
   *  composite time from the layer's alpha — never baked into pixels. */
  effects?: LayerEffects;
  /** Blend If (Photoshop's Blending Options): hide this layer's pixels by their
   *  own tonal range and/or by the tones already composited beneath it. Absent
   *  ⇒ no gating, and the compositor skips the work entirely. */
  blendIf?: BlendIf;
  /** Clip this layer to the alpha silhouette of the layer directly below it in
   *  the same parent (a clipping mask). Absent ⇒ not clipped. Positional: moving
   *  the layer changes what it clips to; inert when there is no valid base below. */
  clipped?: boolean;
  /** Smart filters (Spec 07): an ordered (bottom→top) non-destructive filter
   *  stack rendered on this node's OWN pixels at composite time — below layer
   *  effects, above raw pixels. Params only; never baked unless applied. */
  filters?: SmartFilter[];
  /** Present ⇒ the node carries a filter mask: one grayscale raster (engine-held,
   *  keyed by `filterMaskKey(id)`) that confines the WHOLE smart-filter stack —
   *  white = filtered, black = original pixels, gray = a blend of the two. */
  filterMask?: MaskMeta;
}

/** A re-editable gradient fill (full-canvas). Reuses the gradient tool's stop
 *  model + type; `angle`/`scale` place it (it isn't drawn by dragging). */
export interface GradientFill {
  stops: GradientStop[];
  type: GradientType;
  /** Direction in degrees (0 = →, 90 = ↓). */
  angle: number;
  /** Span as a fraction of the canvas diagonal (1 = corner-to-corner). */
  scale: number;
  reverse: boolean;
  /** Angle gradients only: soften the wrap seam. */
  smooth: boolean;
}

/** A Fill layer's parametric content — rendered fresh at composite time, never
 *  baked, so it stays re-editable (like Photoshop's Solid/Gradient fill layers). */
export type FillSpec =
  | { kind: "solid"; color: string }
  | { kind: "gradient"; gradient: GradientFill };

/** A pixel layer (has its own canvas in the paint engine, keyed by id). */
export interface LayerLeaf extends LayerBase {
  type: "layer";
  /** If set, the layer is a rasterized shape/text that can be re-edited as a vector. */
  vector?: VectorData;
  /** If set, the layer is a parametric Fill layer: it stores no pixels, the
   *  engine renders `fill` full-canvas each frame (confined by mask/clip). */
  fill?: FillSpec;
}

/** A layer whose content comes from a fill spec (no stored pixels). */
export const isFillLayer = (
  n: LayerNode | null | undefined,
): n is LayerLeaf & { fill: FillSpec } => !!n && n.type === "layer" && !!n.fill;

/** A short human label for a fill spec (panel sublabel / default name). */
export const fillLabel = (fill: FillSpec): string =>
  fill.kind === "solid" ? "Color Fill" : "Gradient Fill";

/** A folder of layers/groups. Has no pixels of its own; composites its children. */
export interface LayerGroup extends LayerBase {
  type: "group";
  expanded: boolean;
  children: LayerNode[];
}

/** A non-destructive adjustment node: leaf-like (no children) and pixel-less
 *  (the engine holds no canvas for it). It re-processes the composite of every
 *  layer below it within its parent at composite time. `clipped` restricts the
 *  effect to the pixel layer directly beneath. */
export interface LayerAdjustment extends LayerBase {
  type: "adjustment";
  adjustment: AdjustmentSpec;
  // `clipped` is inherited from LayerBase (promoted in Spec 05 from this node kind).
}

export type LayerNode = LayerLeaf | LayerGroup | LayerAdjustment;

/** Back-compat alias: most call sites that say "Layer" mean a pixel layer. */
export type Layer = LayerLeaf;

/** Patch shape accepted by the panel/update (common props + group's expanded). */
export type LayerPatch = Partial<
  Pick<LayerBase, "name" | "visible" | "opacity" | "blend">
> & {
  label?: LayerLabel | undefined;
  locks?: LayerLocks | undefined;
  linkKey?: string | undefined;
  expanded?: boolean;
  vector?: VectorData;
  fill?: FillSpec | undefined;
  mask?: MaskMeta | undefined;
  vectorMask?: VectorMask | undefined;
  adjustment?: AdjustmentSpec;
  clipped?: boolean;
  effects?: LayerEffects | undefined;
  blendIf?: BlendIf | undefined;
  filters?: SmartFilter[] | undefined;
  filterMask?: MaskMeta | undefined;
};

/** Blend-mode name → canvas composite op. Shared by the engine's compositor
 *  and the smart-filter worker (both blend with the same table). Modes without
 *  a native op (Dissolve, Linear Burn≈multiply, Add=lighter) use the closest. */
export const BLEND_MAP: Record<string, GlobalCompositeOperation> = {
  Normal: "source-over",
  Dissolve: "source-over",
  Darken: "darken",
  Multiply: "multiply",
  "Color Burn": "color-burn",
  "Linear Burn": "multiply",
  Lighten: "lighten",
  Screen: "screen",
  "Color Dodge": "color-dodge",
  Add: "lighter",
  Overlay: "overlay",
  "Soft Light": "soft-light",
  "Hard Light": "hard-light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
};
export const blendOp = (b: string): GlobalCompositeOperation => BLEND_MAP[b] ?? "source-over";

export const BLEND_MODES = [
  "Normal",
  "Dissolve",
  "Darken",
  "Multiply",
  "Color Burn",
  "Linear Burn",
  "Lighten",
  "Screen",
  "Color Dodge",
  "Add",
  "Overlay",
  "Soft Light",
  "Hard Light",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
];

// ---- Tree helpers (all pure; never mutate the input) ----

/** Ids of every pixel layer (leaf) in the tree, in order. Adjustment nodes are
 *  pixel-less, so they are excluded (the engine holds no canvas for them). */
export function collectLeafIds(nodes: LayerNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "group") out.push(...collectLeafIds(n.children));
    else if (n.type === "layer") out.push(n.id);
  }
  return out;
}

export function findNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === "group") {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

/** True if `id` is `node` itself or anywhere inside it. */
export function containsId(node: LayerNode, id: string): boolean {
  if (node.id === id) return true;
  if (node.type === "group") return node.children.some((c) => containsId(c, id));
  return false;
}

// ---- Linked layers ----------------------------------------------------------
/** A node is linked when it carries a link key (shared with its link-mates). */
export const isLinked = (n: { linkKey?: string } | null | undefined): boolean => !!n?.linkKey;

/** A fresh, collision-resistant link key. */
export function newLinkKey(): string {
  return `lk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** All nodes in the tree sharing `id`'s link key (⊇ {id}); empty if unlinked. */
export function linkedNodes(tree: LayerNode[], id: string): LayerNode[] {
  const self = findNode(tree, id);
  if (!self?.linkKey) return [];
  const key = self.linkKey;
  const out: LayerNode[] = [];
  const walk = (ns: LayerNode[]) => {
    for (const n of ns) {
      if (n.linkKey === key) out.push(n);
      if (n.type === "group") walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Leaf pixel-layer ids of every node linked to `id` (groups expand to leaves).
 *  Includes `id`'s own leaf when it is a pixel layer. Empty when unlinked. */
export function linkedLeafIds(tree: LayerNode[], id: string): string[] {
  const nodes = linkedNodes(tree, id);
  if (!nodes.length) return [];
  const ids = new Set<string>();
  for (const n of nodes) for (const lid of collectLeafIds([n])) ids.add(lid);
  return [...ids];
}

/** Count of distinct nodes carrying a given link key across the tree. */
export function linkKeyCount(tree: LayerNode[], key: string): number {
  let n = 0;
  const walk = (ns: LayerNode[]) => {
    for (const m of ns) {
      if (m.linkKey === key) n++;
      if (m.type === "group") walk(m.children);
    }
  };
  walk(tree);
  return n;
}

/** Apply `fn` to every node in the tree (recursing into groups), returning a new tree. */
function mapTree(tree: LayerNode[], fn: (n: LayerNode) => LayerNode): LayerNode[] {
  return tree.map((n) => {
    const m = fn(n);
    return m.type === "group" ? { ...m, children: mapTree(m.children, fn) } : m;
  });
}

const stripLinkKey = (n: LayerNode): LayerNode => {
  if (!n.linkKey) return n;
  const rest = { ...n };
  delete (rest as { linkKey?: string }).linkKey;
  return rest;
};

/** Give every node in `ids` the shared link `key` (returns a new tree). */
export function setLinkKey(tree: LayerNode[], ids: Set<string>, key: string): LayerNode[] {
  return mapTree(tree, (n) => (ids.has(n.id) ? { ...n, linkKey: key } : n));
}

/** Remove the link key from every node in `ids`. */
export function clearLinkKey(tree: LayerNode[], ids: Set<string>): LayerNode[] {
  return mapTree(tree, (n) => (ids.has(n.id) ? stripLinkKey(n) : n));
}

/** Drop link keys that now bind fewer than two nodes (a link of one is inert). */
export function pruneLinks(tree: LayerNode[]): LayerNode[] {
  const counts = new Map<string, number>();
  const walk = (ns: LayerNode[]) => {
    for (const n of ns) {
      if (n.linkKey) counts.set(n.linkKey, (counts.get(n.linkKey) ?? 0) + 1);
      if (n.type === "group") walk(n.children);
    }
  };
  walk(tree);
  const orphans = new Set([...counts].filter(([, c]) => c < 2).map(([k]) => k));
  if (!orphans.size) return tree;
  return mapTree(tree, (n) => (n.linkKey && orphans.has(n.linkKey) ? stripLinkKey(n) : n));
}

/** Apply a shallow patch to the matching node (returns a new tree). */
export function updateNode(nodes: LayerNode[], id: string, patch: LayerPatch): LayerNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, ...patch } as LayerNode;
    if (n.type === "group") return { ...n, children: updateNode(n.children, id, patch) };
    return n;
  });
}

/** Remove a node anywhere in the tree, returning the new tree and the removed node. */
export function removeNode(
  nodes: LayerNode[],
  id: string,
): { tree: LayerNode[]; removed: LayerNode | null } {
  let removed: LayerNode | null = null;
  const walk = (list: LayerNode[]): LayerNode[] => {
    const out: LayerNode[] = [];
    for (const n of list) {
      if (n.id === id) {
        removed = n;
        continue;
      }
      if (n.type === "group") out.push({ ...n, children: walk(n.children) });
      else out.push(n);
    }
    return out;
  };
  const tree = walk(nodes);
  return { tree, removed };
}

/** Insert `node` before/after `targetId` within the target's sibling list. */
export function insertRelative(
  nodes: LayerNode[],
  node: LayerNode,
  targetId: string,
  before: boolean,
): LayerNode[] {
  const idx = nodes.findIndex((n) => n.id === targetId);
  if (idx !== -1) {
    const out = nodes.slice();
    out.splice(before ? idx : idx + 1, 0, node);
    return out;
  }
  return nodes.map((n) =>
    n.type === "group" ? { ...n, children: insertRelative(n.children, node, targetId, before) } : n,
  );
}

/** Insert `node` as the first (top) child of the group with `groupId`. */
export function insertInGroup(nodes: LayerNode[], node: LayerNode, groupId: string): LayerNode[] {
  return nodes.map((n) => {
    if (n.id === groupId && n.type === "group") return { ...n, children: [node, ...n.children] };
    if (n.type === "group") return { ...n, children: insertInGroup(n.children, node, groupId) };
    return n;
  });
}

/** Replace the node `id` with a group that wraps it (group takes its place). */
export function wrapInGroup(nodes: LayerNode[], id: string, group: LayerGroup): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of nodes) {
    if (n.id === id) out.push({ ...group, children: [n] });
    else if (n.type === "group") out.push({ ...n, children: wrapInGroup(n.children, id, group) });
    else out.push(n);
  }
  return out;
}

/** Replace the group `id` with its children in place. */
export function ungroupNode(nodes: LayerNode[], id: string): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of nodes) {
    if (n.id === id && n.type === "group") out.push(...n.children);
    else if (n.type === "group") out.push({ ...n, children: ungroupNode(n.children, id) });
    else out.push(n);
  }
  return out;
}

/** Deep-clone a subtree with fresh ids; returns the clone + [oldLeafId, newLeafId] pairs. */
export function cloneSubtree(
  node: LayerNode,
  gen: () => string,
): { node: LayerNode; leafPairs: [string, string][] } {
  const id = gen();
  // Deep-copy effects + smart filters so the clone's edits never alias the original's.
  const fx = node.effects ? { effects: structuredClone(node.effects) } : {};
  const flt = node.filters ? { filters: structuredClone(node.filters) } : {};
  if (node.type === "group") {
    const results = node.children.map((c) => cloneSubtree(c, gen));
    return {
      node: { ...node, id, ...fx, ...flt, children: results.map((r) => r.node) },
      leafPairs: results.flatMap((r) => r.leafPairs),
    };
  }
  return { node: { ...node, id, ...fx, ...flt }, leafPairs: [[node.id, id]] };
}

/** Replace the node `id` with `replacement`, in place. */
export function replaceNodeWith(
  nodes: LayerNode[],
  id: string,
  replacement: LayerNode,
): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of nodes) {
    if (n.id === id) out.push(replacement);
    else if (n.type === "group") out.push({ ...n, children: replaceNodeWith(n.children, id, replacement) });
    else out.push(n);
  }
  return out;
}

/** Remove every node whose id is in `ids` (anywhere in the tree). */
export function removeMany(nodes: LayerNode[], ids: Set<string>): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of nodes) {
    if (ids.has(n.id)) continue;
    if (n.type === "group") out.push({ ...n, children: removeMany(n.children, ids) });
    else out.push(n);
  }
  return out;
}

/** Selected nodes in tree order, excluding any nested under another selected node. */
export function topLevelSelected(nodes: LayerNode[], selected: Set<string>): LayerNode[] {
  const out: LayerNode[] = [];
  const walk = (list: LayerNode[]) => {
    for (const n of list) {
      if (selected.has(n.id)) out.push(n);
      else if (n.type === "group") walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** A clip group: a pixel-bearing base plus the contiguous run of `clipped` nodes
 *  directly above it (bottom→top draw order). `members` is empty for a node drawn
 *  on its own (a plain layer, or a clipped node whose flag is inert). */
export interface ClipGroup {
  base: LayerNode;
  members: LayerNode[];
  /** §16.9 edge case — an orphan clipped run: `base` is itself `clipped`, with
   *  only NON-clipped adjustment layers between it and a pixel node below.
   *  Every node in the run (base AND members) clips to THIS node's silhouette,
   *  rendered at the run's own stack position (so the adjustments beneath
   *  still don't touch the run's pixels — Photoshop semantics). */
  maskFrom?: LayerNode;
}

/** Whether a node can anchor a clip group (have members clip to it). Adjustments
 *  carry no pixels/alpha, so they are never a valid base. */
function canBeClipBase(node: LayerNode): boolean {
  return node.type !== "adjustment";
}

/**
 * Partition an ordered child list (index 0 = top … last = bottom) into clip-group
 * draw units, returned in **bottom→top** order. Each unit's `members` are the
 * contiguous `clipped` nodes directly above its base (also bottom→top).
 *
 * A clipped node stranded above a NON-clipped adjustment (§16.9) walks down
 * past the adjustment run: if a non-clipped pixel node sits beneath, the whole
 * stranded run borrows its silhouette via `maskFrom`. A clipped node with no
 * such base at all (bottom of the list, or only adjustments below) stays
 * inert: a member-less-style unit that composites normally.
 */
export function clipGroupsOf(children: LayerNode[]): ClipGroup[] {
  const n = children.length;
  const consumed = new Set<number>();
  const units: ClipGroup[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (consumed.has(i)) continue;
    const base = children[i];
    const members: LayerNode[] = [];
    let maskFrom: LayerNode | undefined;
    if (canBeClipBase(base)) {
      // Collect the contiguous run of clipped nodes directly above this base.
      for (let j = i - 1; j >= 0 && children[j].clipped; j--) {
        members.push(children[j]); // decreasing index ⇒ bottom→top within the group
        consumed.add(j);
      }
      if (base.clipped) {
        // Orphan run bottom (a pixel base below would have consumed it) —
        // walk down past non-clipped adjustments to a borrowable silhouette.
        let k = i + 1;
        while (k < n && children[k].type === "adjustment" && !children[k].clipped) k++;
        if (k > i + 1 && k < n && canBeClipBase(children[k]) && !children[k].clipped) {
          maskFrom = children[k];
        }
      }
    }
    units.push(maskFrom ? { base, members, maskFrom } : { base, members });
  }
  return units;
}

// ---- Layers-panel search / filter (pure — Node-testable) --------------------

/** Panel filter state: name substring, node kind, and colour labels (OR'd). */
export interface LayerFilter {
  query: string;
  kind: "all" | "layer" | "group" | "adjustment";
  labels: LayerLabel[];
}

export const EMPTY_LAYER_FILTER: LayerFilter = { query: "", kind: "all", labels: [] };

export const layerFilterActive = (f: LayerFilter): boolean =>
  !!f.query.trim() || f.kind !== "all" || f.labels.length > 0;

/**
 * Resolve a filter against the tree. `match` = nodes satisfying every criterion
 * (name AND kind AND label). `visible` additionally includes every ancestor of
 * a match (so hierarchy stays readable) and every descendant of a match (a
 * matching group shows its contents) — the panel dims visible non-matches.
 * An inactive filter returns null (show everything, dim nothing).
 */
export function filterLayerTree(
  nodes: LayerNode[],
  f: LayerFilter,
): { match: Set<string>; visible: Set<string> } | null {
  if (!layerFilterActive(f)) return null;
  const q = f.query.trim().toLowerCase();
  const wantLabels = new Set(f.labels);
  const match = new Set<string>();
  const visible = new Set<string>();
  const matches = (n: LayerNode): boolean =>
    (!q || n.name.toLowerCase().includes(q)) &&
    (f.kind === "all" || n.type === f.kind) &&
    (wantLabels.size === 0 || (!!n.label && wantLabels.has(n.label)));
  const markSubtree = (n: LayerNode) => {
    visible.add(n.id);
    if (n.type === "group") for (const c of n.children) markSubtree(c);
  };
  // Returns whether this subtree contains a match (to reveal ancestors).
  const walk = (n: LayerNode): boolean => {
    const self = matches(n);
    if (self) {
      match.add(n.id);
      markSubtree(n); // a matching group reveals its contents
    }
    let below = false;
    if (n.type === "group") for (const c of n.children) below = walk(c) || below;
    if (self || below) visible.add(n.id);
    return self || below;
  };
  for (const n of nodes) walk(n);
  return { match, visible };
}

/** Visible row ids in order (children of collapsed groups omitted). */
export function flattenedIds(nodes: LayerNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.id);
    if (n.type === "group" && n.expanded) out.push(...flattenedIds(n.children));
  }
  return out;
}

/** Merge the node `id` down onto the next sibling below it (same parent). */
export function mergeDownInTree(
  nodes: LayerNode[],
  id: string,
  makeMerged: (top: LayerNode, bottom: LayerNode) => LayerLeaf,
): { tree: LayerNode[]; top: LayerNode | null; bottom: LayerNode | null } {
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx !== -1) {
    if (idx >= nodes.length - 1) return { tree: nodes, top: null, bottom: null }; // nothing below
    const top = nodes[idx];
    const bottom = nodes[idx + 1];
    const out = nodes.slice();
    out.splice(idx, 2, makeMerged(top, bottom));
    return { tree: out, top, bottom };
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === "group") {
      const r = mergeDownInTree(n.children, id, makeMerged);
      if (r.top) {
        const out = nodes.slice();
        out[i] = { ...n, children: r.tree };
        return { tree: out, top: r.top, bottom: r.bottom };
      }
    }
  }
  return { tree: nodes, top: null, bottom: null };
}

/** How a click changes the selection. */
export type SelectMode = "replace" | "toggle" | "range";

/** Everything the Layers panel needs to read & mutate the active doc's stack.
    The multi-layer actions (remove/duplicate/group/merge) act on the current
    selection; ungroup acts on a specific group id. */
export interface LayersApi {
  layers: LayerNode[];
  activeLayerId: string | null;
  selectedLayerIds: string[];
  add: () => void;
  select: (id: string, mode?: SelectMode) => void;
  update: (id: string, patch: LayerPatch) => void;
  /** Move `fromId` to just before/after `targetId` (may re-parent across groups). */
  move: (fromId: string, targetId: string, before: boolean) => void;
  remove: () => void;
  duplicate: () => void;
  group: () => void;
  ungroup: (id: string) => void;
  merge: () => void;
  flatten: () => void;
  /** Toggle one edit-lock flag (transparency/pixels/position/all) on a layer. */
  setLock: (id: string, flag: LockFlag, on: boolean) => void;
  /** Link the current multi-selection, or unlink it if it's already all linked. */
  toggleLinkSelected: () => void;
  /** Unlink one layer from its link set (row chain / context menu). */
  unlinkLayer: (id: string) => void;
  /** Add a Solid/Gradient fill layer (creates it and opens its editor). */
  addFill: (kind: "solid" | "gradient") => void;
  /** Open the Fill editor for an existing fill layer. */
  editFill: (id: string) => void;
  // ---- Layer masks ----
  /** The active layer's current paint surface (drives the active-surface ring). */
  maskSurface: ActiveSurface;
  /** Make `id`'s pixels or mask the active paint surface. */
  chooseSurface: (id: string, surface: ActiveSurface) => void;
  /** Add a mask to the active layer (reveal-all / hide-all / from-selection). */
  addMask: (init: "reveal" | "hide" | "selection") => void;
  removeMask: () => void;
  applyMask: () => void;
  toggleMaskEnabled: (id: string) => void;
  toggleMaskLinked: (id: string) => void;
  /** Layer id whose mask is being VIEWED grayscale on the canvas (or null). */
  maskViewId: string | null;
  /** Toggle mask view for `id` (Alt-click its mask chip / Channels panel). */
  toggleMaskView: (id: string) => void;
  /** Enable/disable a node's smart-filter mask (Shift-click on its chip). */
  toggleFilterMaskEnabled: (id: string) => void;
  loadMaskAsSelection: () => void;
  // ---- Adjustment layers ----
  /** Create a non-destructive adjustment layer above the active layer. */
  addAdjustment: (typeId: string) => void;
  /** Set a layer's clip-to-layer-below flag (any kind). */
  setAdjustmentClipped: (id: string, clipped: boolean) => void;
  /** Toggle a layer's clipping mask (Alt-click boundary / context menu). */
  toggleClip: (id: string) => void;
  /** Re-open a Curves/Levels adjustment's editor (other adjustments just select). */
  editAdjustment: (id: string) => void;
  // ---- Layer effects (styles) ----
  /** Open the Layer Style dialog bound to `id` (also selects it). */
  openLayerStyle: (id: string) => void;
  /** Open the Smart Filters stack dialog for a layer/group. */
  openFilters: (id: string) => void;
  /** Enable/disable one effect on a layer (the eye toggle in the sub-list). */
  toggleEffect: (id: string, key: FxKey, enabled: boolean) => void;
  copyLayerStyle: (id: string) => void;
  pasteLayerStyle: (id: string) => void;
  clearLayerStyle: (id: string) => void;
  /** True when a copied style is available to paste. */
  canPasteStyle: boolean;
}
