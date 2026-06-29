import type { VectorData } from "./tools";

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0–100 */
  opacity: number;
  blend: string;
}

/** A pixel layer (has its own canvas in the paint engine, keyed by id). */
export interface LayerLeaf extends LayerBase {
  type: "layer";
  /** If set, the layer is a rasterized shape/text that can be re-edited as a vector. */
  vector?: VectorData;
}

/** A folder of layers/groups. Has no pixels of its own; composites its children. */
export interface LayerGroup extends LayerBase {
  type: "group";
  expanded: boolean;
  children: LayerNode[];
}

export type LayerNode = LayerLeaf | LayerGroup;

/** Back-compat alias: most call sites that say "Layer" mean a pixel layer. */
export type Layer = LayerLeaf;

/** Patch shape accepted by the panel/update (common props + group's expanded). */
export type LayerPatch = Partial<
  Pick<LayerBase, "name" | "visible" | "opacity" | "blend">
> & { expanded?: boolean; vector?: VectorData };

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

/** Ids of every pixel layer (leaf) in the tree, in order. */
export function collectLeafIds(nodes: LayerNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "group") out.push(...collectLeafIds(n.children));
    else out.push(n.id);
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
  if (node.type === "group") {
    const results = node.children.map((c) => cloneSubtree(c, gen));
    return {
      node: { ...node, id, children: results.map((r) => r.node) },
      leafPairs: results.flatMap((r) => r.leafPairs),
    };
  }
  return { node: { ...node, id }, leafPairs: [[node.id, id]] };
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
}
