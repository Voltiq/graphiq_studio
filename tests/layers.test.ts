/**
 * layers.ts — the layer-tree operations.
 *
 * Every one of these is used by an undoable command, so a bug here is a bug the
 * user cannot back out of. Two things get checked throughout, beyond each
 * function's own contract:
 *
 *  - **Purity.** The tree in React state is shared with the render graph; an
 *    in-place mutation would change history entries retroactively. One test
 *    deep-freezes a tree and runs every operation over it, so a stray write
 *    throws rather than silently corrupting the past.
 *  - **Partitioning.** `clipGroupsOf` decides what gets drawn; if it drops or
 *    duplicates a node, that node vanishes from the canvas or paints twice. It
 *    is checked as a partition of the input, not just case by case.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ADJUST } from "@/app/lib/adjust";
import {
  clearLinkKey,
  clipGroupsOf,
  cloneSubtree,
  collectLeafIds,
  containsId,
  EMPTY_LAYER_FILTER,
  filterLayerTree,
  findNode,
  flattenedIds,
  insertInGroup,
  insertRelative,
  isLinked,
  layerFilterActive,
  linkedLeafIds,
  linkedNodes,
  linkKeyCount,
  mergeDownInTree,
  newLinkKey,
  pruneLinks,
  removeMany,
  removeNode,
  replaceNodeWith,
  setLinkKey,
  topLevelSelected,
  ungroupNode,
  updateNode,
  wrapInGroup,
  type LayerAdjustment,
  type LayerGroup,
  type LayerLeaf,
  type LayerNode,
} from "@/app/lib/layers";

const leaf = (id: string, over: Partial<LayerLeaf> = {}): LayerLeaf => ({
  type: "layer",
  id,
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  ...over,
});
const group = (id: string, children: LayerNode[], over: Partial<LayerGroup> = {}): LayerGroup => ({
  type: "group",
  id,
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  expanded: true,
  children,
  ...over,
});
const adj = (id: string, over: Partial<LayerAdjustment> = {}): LayerAdjustment => ({
  type: "adjustment",
  id,
  name: id,
  visible: true,
  opacity: 100,
  blend: "Normal",
  adjustment: { type: "sliders", params: DEFAULT_ADJUST },
  ...over,
});

/**
 *  A (top → bottom)
 *  G1 ┬ B
 *     └ G2 ─ C     (G2 collapsed)
 *  ADJ
 *  D
 */
const fixture = (): LayerNode[] => [
  leaf("A"),
  group("G1", [leaf("B"), group("G2", [leaf("C")], { expanded: false })]),
  adj("ADJ"),
  leaf("D"),
];

const ids = (nodes: LayerNode[]): string[] =>
  nodes.flatMap((n) => (n.type === "group" ? [n.id, ...ids(n.children)] : [n.id]));

describe("reading the tree", () => {
  it("collects leaf ids in tree order, skipping groups and adjustments", () => {
    expect(collectLeafIds(fixture())).toEqual(["A", "B", "C", "D"]);
  });

  it("finds nodes at any depth", () => {
    expect(findNode(fixture(), "C")?.name).toBe("C");
    expect(findNode(fixture(), "G2")?.type).toBe("group");
    expect(findNode(fixture(), "nope")).toBeNull();
  });

  it("tests containment against a whole subtree", () => {
    const t = fixture();
    const g1 = findNode(t, "G1")!;
    expect(containsId(g1, "G1")).toBe(true);
    expect(containsId(g1, "C")).toBe(true); // two levels down
    expect(containsId(g1, "A")).toBe(false);
    expect(containsId(leaf("X"), "X")).toBe(true);
  });

  it("hides the children of a collapsed group from the panel", () => {
    expect(flattenedIds(fixture())).toEqual(["A", "G1", "B", "G2", "ADJ", "D"]);
    const open = updateNode(fixture(), "G2", { expanded: true });
    expect(flattenedIds(open)).toEqual(["A", "G1", "B", "G2", "C", "ADJ", "D"]);
    const shut = updateNode(fixture(), "G1", { expanded: false });
    expect(flattenedIds(shut)).toEqual(["A", "G1", "ADJ", "D"]);
  });

  it("reports only the outermost selected nodes", () => {
    // Selecting a group AND something inside it must not move the inner node
    // twice — that is what this guards.
    expect(topLevelSelected(fixture(), new Set(["G1", "C", "D"])).map((n) => n.id)).toEqual(["G1", "D"]);
    expect(topLevelSelected(fixture(), new Set(["B", "C"])).map((n) => n.id)).toEqual(["B", "C"]);
    expect(topLevelSelected(fixture(), new Set())).toEqual([]);
  });
});

describe("editing the tree", () => {
  it("patches a nested node and leaves the rest alone", () => {
    const t = updateNode(fixture(), "C", { name: "renamed", opacity: 40 });
    const c = findNode(t, "C") as LayerLeaf;
    expect(c.name).toBe("renamed");
    expect(c.opacity).toBe(40);
    expect(c.blend).toBe("Normal"); // untouched fields survive the patch
    expect(ids(t)).toEqual(ids(fixture()));
  });

  it("is a structural no-op for an id that is not there", () => {
    expect(updateNode(fixture(), "ghost", { name: "x" })).toEqual(fixture());
  });

  it("removes a node and hands it back", () => {
    const { tree, removed } = removeNode(fixture(), "B");
    expect(removed?.id).toBe("B");
    expect(ids(tree)).toEqual(["A", "G1", "G2", "C", "ADJ", "D"]);
  });

  it("removes a group with everything inside it", () => {
    const { tree, removed } = removeNode(fixture(), "G1");
    expect(removed?.id).toBe("G1");
    expect(ids(tree)).toEqual(["A", "ADJ", "D"]);
  });

  it("reports nothing removed for an unknown id", () => {
    const { tree, removed } = removeNode(fixture(), "ghost");
    expect(removed).toBeNull();
    expect(tree).toEqual(fixture());
  });

  it("inserts before or after a target, at the target's own level", () => {
    expect(ids(insertRelative(fixture(), leaf("N"), "A", true))[0]).toBe("N");
    expect(ids(insertRelative(fixture(), leaf("N"), "A", false)).slice(0, 2)).toEqual(["A", "N"]);
    // Inside a group, the new node joins that group's children.
    const nested = insertRelative(fixture(), leaf("N"), "B", false);
    expect((findNode(nested, "G1") as LayerGroup).children.map((n) => n.id)).toEqual(["B", "N", "G2"]);
  });

  it("leaves the tree alone when the insert target is missing", () => {
    expect(insertRelative(fixture(), leaf("N"), "ghost", true)).toEqual(fixture());
  });

  it("inserts at the top of a group", () => {
    const t = insertInGroup(fixture(), leaf("N"), "G2");
    expect((findNode(t, "G2") as LayerGroup).children.map((n) => n.id)).toEqual(["N", "C"]);
    // A non-group id is not a place to put a child.
    expect(insertInGroup(fixture(), leaf("N"), "A")).toEqual(fixture());
  });

  it("wraps and unwraps a node symmetrically", () => {
    const g = group("NEW", []);
    const wrapped = wrapInGroup(fixture(), "C", g);
    const nw = findNode(wrapped, "NEW") as LayerGroup;
    expect(nw.children.map((n) => n.id)).toEqual(["C"]);
    expect((findNode(wrapped, "G2") as LayerGroup).children.map((n) => n.id)).toEqual(["NEW"]);
    expect(ungroupNode(wrapped, "NEW")).toEqual(fixture());
  });

  it("ungroups in place, keeping the children's order and position", () => {
    const t = ungroupNode(fixture(), "G1");
    expect(ids(t)).toEqual(["A", "B", "G2", "C", "ADJ", "D"]);
    // Ungrouping something that is not a group does nothing.
    expect(ungroupNode(fixture(), "A")).toEqual(fixture());
  });

  it("replaces a node in place", () => {
    const t = replaceNodeWith(fixture(), "C", leaf("Z"));
    expect((findNode(t, "G2") as LayerGroup).children.map((n) => n.id)).toEqual(["Z"]);
    expect(findNode(t, "C")).toBeNull();
  });

  it("removes many nodes across levels in one pass", () => {
    expect(ids(removeMany(fixture(), new Set(["A", "C", "ADJ"])))).toEqual(["G1", "B", "G2", "D"]);
    // Removing a group takes its children with it, even ones not listed.
    expect(ids(removeMany(fixture(), new Set(["G1"])))).toEqual(["A", "ADJ", "D"]);
    expect(removeMany(fixture(), new Set())).toEqual(fixture());
  });
});

describe("cloneSubtree", () => {
  const gen = () => {
    let n = 0;
    return () => `new-${++n}`;
  };

  it("gives every node in the subtree a fresh id, keeping the shape", () => {
    const src = findNode(fixture(), "G1")!;
    const { node } = cloneSubtree(src, gen());
    expect(ids([node])).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    expect(collectLeafIds([node])).toHaveLength(2);
    expect((node as LayerGroup).children[1].type).toBe("group");
  });

  it("maps old leaf ids to new ones, and only leaves", () => {
    const { leafPairs } = cloneSubtree(findNode(fixture(), "G1")!, gen());
    expect(leafPairs.map(([old]) => old)).toEqual(["B", "C"]);
    expect(new Set(leafPairs.map(([, n]) => n)).size).toBe(2);
  });

  it("pairs a lone leaf with itself", () => {
    const { node, leafPairs } = cloneSubtree(leaf("A"), gen());
    expect(leafPairs).toEqual([["A", "new-1"]]);
    expect(node.id).toBe("new-1");
  });

  it("deep-copies effects and filters so the copy is independently editable", () => {
    const src = leaf("A", {
      effects: { stroke: { enabled: true, size: 3 } } as unknown as LayerLeaf["effects"],
      filters: [{ id: "f1", enabled: true, blendMode: "Normal", opacity: 100, type: "pixelate", params: { cellSize: 8 } }],
    });
    const { node } = cloneSubtree(src, gen()) as { node: LayerLeaf };
    node.filters![0].params = { cellSize: 99 };
    (node.effects as Record<string, { size: number }>).stroke.size = 99;
    expect((src.filters![0].params as { cellSize: number }).cellSize).toBe(8);
    expect((src.effects as unknown as Record<string, { size: number }>).stroke.size).toBe(3);
  });
});

describe("mergeDownInTree", () => {
  const merged = (top: LayerNode, bottom: LayerNode): LayerLeaf =>
    leaf(`${top.id}+${bottom.id}`, { name: bottom.name });

  it("merges a node onto the sibling below it", () => {
    const r = mergeDownInTree(fixture(), "A", merged);
    expect(r.top?.id).toBe("A");
    expect(r.bottom?.id).toBe("G1");
    expect(ids(r.tree)).toEqual(["A+G1", "ADJ", "D"]);
  });

  it("merges within a group, not across its boundary", () => {
    const r = mergeDownInTree(fixture(), "B", merged);
    expect(r.bottom?.id).toBe("G2");
    expect((findNode(r.tree, "B+G2") as LayerLeaf).type).toBe("layer");
    expect(ids(r.tree)).toEqual(["A", "G1", "B+G2", "ADJ", "D"]);
  });

  it("refuses when there is nothing below, inside the same parent", () => {
    // D is bottom of the document...
    const bottom = mergeDownInTree(fixture(), "D", merged);
    expect(bottom.top).toBeNull();
    expect(bottom.tree).toEqual(fixture());
    // ...and C is bottom of its group, so it must not fall through to ADJ.
    const inner = mergeDownInTree(fixture(), "C", merged);
    expect(inner.top).toBeNull();
    expect(inner.tree).toEqual(fixture());
  });

  it("does nothing for an unknown id", () => {
    const r = mergeDownInTree(fixture(), "ghost", merged);
    expect(r.top).toBeNull();
    expect(r.bottom).toBeNull();
  });
});

describe("clipGroupsOf", () => {
  /** Every input node must appear exactly once, as a base or as a member. */
  const expectPartition = (children: LayerNode[]) => {
    const units = clipGroupsOf(children);
    const seen = units.flatMap((u) => [u.base.id, ...u.members.map((m) => m.id)]);
    expect([...seen].sort()).toEqual(children.map((c) => c.id).sort());
    expect(new Set(seen).size).toBe(children.length);
    return units;
  };

  it("gives each unclipped node its own unit, bottom-first", () => {
    const units = expectPartition([leaf("top"), leaf("mid"), leaf("bot")]);
    expect(units.map((u) => u.base.id)).toEqual(["bot", "mid", "top"]);
    expect(units.every((u) => u.members.length === 0)).toBe(true);
  });

  it("attaches a clipped run to the base beneath it", () => {
    const units = expectPartition([
      leaf("c2", { clipped: true }),
      leaf("c1", { clipped: true }),
      leaf("base"),
      leaf("other"),
    ]);
    expect(units.map((u) => u.base.id)).toEqual(["other", "base"]);
    // Members are bottom→top, matching draw order.
    expect(units[1].members.map((m) => m.id)).toEqual(["c1", "c2"]);
  });

  it("never makes an adjustment the base of a clip group", () => {
    // An adjustment has no alpha to clip to, so the clipped layer above it must
    // not be swallowed into a unit that could never mask it.
    const units = expectPartition([leaf("clip", { clipped: true }), adj("A"), leaf("pix")]);
    const adjUnit = units.find((u) => u.base.id === "A")!;
    expect(adjUnit.members).toEqual([]);
    expect(units.find((u) => u.base.id === "clip")).toBeDefined();
  });

  it("lets a run stranded above an adjustment borrow the silhouette below it", () => {
    // §16.9: clipped layers separated from their base by a non-clipped
    // adjustment still clip to that base, drawn at their own stack position.
    const units = expectPartition([
      leaf("c2", { clipped: true }),
      leaf("c1", { clipped: true }),
      adj("A"),
      leaf("pix"),
    ]);
    const stranded = units.find((u) => u.base.id === "c1")!;
    expect(stranded.maskFrom?.id).toBe("pix");
    expect(stranded.members.map((m) => m.id)).toEqual(["c2"]);
    expect(units.find((u) => u.base.id === "pix")!.maskFrom).toBeUndefined();
  });

  it("leaves a clipped node with nothing to clip to inert", () => {
    // Bottom of the list: no base at all.
    const alone = expectPartition([leaf("a"), leaf("c", { clipped: true })]);
    expect(alone.find((u) => u.base.id === "c")!.maskFrom).toBeUndefined();
    // Only adjustments below: still nothing with an alpha silhouette.
    const overAdj = expectPartition([leaf("c", { clipped: true }), adj("A")]);
    expect(overAdj.find((u) => u.base.id === "c")!.maskFrom).toBeUndefined();
  });

  it("clips to a group, which does have a silhouette", () => {
    const units = expectPartition([leaf("c", { clipped: true }), group("G", [leaf("inner")])]);
    expect(units[0].base.id).toBe("G");
    expect(units[0].members.map((m) => m.id)).toEqual(["c"]);
  });

  it("keeps consecutive clip groups apart", () => {
    const units = expectPartition([
      leaf("c2", { clipped: true }),
      leaf("base2"),
      leaf("c1", { clipped: true }),
      leaf("base1"),
    ]);
    expect(units.map((u) => [u.base.id, u.members.map((m) => m.id)])).toEqual([
      ["base1", ["c1"]],
      ["base2", ["c2"]],
    ]);
  });

  it("handles an empty child list", () => {
    expect(clipGroupsOf([])).toEqual([]);
  });
});

describe("filterLayerTree", () => {
  it("returns null when no criterion is set, so nothing is dimmed", () => {
    expect(layerFilterActive(EMPTY_LAYER_FILTER)).toBe(false);
    expect(filterLayerTree(fixture(), EMPTY_LAYER_FILTER)).toBeNull();
    expect(layerFilterActive({ ...EMPTY_LAYER_FILTER, query: "   " })).toBe(false);
  });

  it("reveals the ancestors of a deep match", () => {
    const r = filterLayerTree(fixture(), { ...EMPTY_LAYER_FILTER, query: "C" })!;
    expect([...r.match]).toEqual(["C"]);
    // G1 and G2 must stay on screen or the match would have nothing to sit in.
    expect(r.visible.has("G1")).toBe(true);
    expect(r.visible.has("G2")).toBe(true);
    expect(r.visible.has("A")).toBe(false);
  });

  it("shows the whole contents of a matching group", () => {
    const r = filterLayerTree(fixture(), { ...EMPTY_LAYER_FILTER, query: "G1" })!;
    expect([...r.match]).toEqual(["G1"]);
    for (const id of ["G1", "B", "G2", "C"]) expect(r.visible.has(id)).toBe(true);
    expect(r.visible.has("D")).toBe(false);
  });

  it("matches names case-insensitively, on a substring", () => {
    const t = updateNode(fixture(), "A", { name: "Background Copy" });
    const r = filterLayerTree(t, { ...EMPTY_LAYER_FILTER, query: "GROUND co" })!;
    expect([...r.match]).toEqual(["A"]);
  });

  it("filters by kind", () => {
    const r = filterLayerTree(fixture(), { ...EMPTY_LAYER_FILTER, kind: "adjustment" })!;
    expect([...r.match]).toEqual(["ADJ"]);
    const g = filterLayerTree(fixture(), { ...EMPTY_LAYER_FILTER, kind: "group" })!;
    expect([...g.match].sort()).toEqual(["G1", "G2"]);
  });

  it("filters by colour label, OR-ing the chosen labels", () => {
    const t = updateNode(updateNode(fixture(), "A", { label: "red" }), "D", { label: "blue" });
    const red = filterLayerTree(t, { ...EMPTY_LAYER_FILTER, labels: ["red"] })!;
    expect([...red.match]).toEqual(["A"]);
    const both = filterLayerTree(t, { ...EMPTY_LAYER_FILTER, labels: ["red", "blue"] })!;
    expect([...both.match].sort()).toEqual(["A", "D"]);
  });

  it("ANDs the criteria together", () => {
    const t = updateNode(fixture(), "A", { label: "red" });
    // Name matches but the kind does not.
    const r = filterLayerTree(t, { ...EMPTY_LAYER_FILTER, query: "A", kind: "group" })!;
    expect(r.match.size).toBe(0);
    // Name and label both match.
    const ok = filterLayerTree(t, { query: "A", kind: "layer", labels: ["red"] })!;
    expect([...ok.match]).toEqual(["A"]);
  });

  it("returns empty sets when nothing matches", () => {
    const r = filterLayerTree(fixture(), { ...EMPTY_LAYER_FILTER, query: "zzz" })!;
    expect(r.match.size).toBe(0);
    expect(r.visible.size).toBe(0);
  });
});

describe("linked layers", () => {
  const key = "lk-test";

  it("mints keys that do not collide", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newLinkKey()));
    expect(keys.size).toBe(200);
  });

  it("recognises a linked node", () => {
    expect(isLinked(leaf("A", { linkKey: key }))).toBe(true);
    expect(isLinked(leaf("A"))).toBe(false);
    expect(isLinked(null)).toBe(false);
    expect(isLinked(leaf("A", { linkKey: "" }))).toBe(false);
  });

  it("links nodes across levels and finds them from any member", () => {
    const t = setLinkKey(fixture(), new Set(["A", "C"]), key);
    expect(linkKeyCount(t, key)).toBe(2);
    expect(linkedNodes(t, "A").map((n) => n.id)).toEqual(["A", "C"]);
    expect(linkedNodes(t, "C").map((n) => n.id)).toEqual(["A", "C"]);
    expect(linkedNodes(t, "D")).toEqual([]); // unlinked
  });

  it("expands a linked group to the leaves that actually move", () => {
    const t = setLinkKey(fixture(), new Set(["A", "G1"]), key);
    expect(linkedLeafIds(t, "A").sort()).toEqual(["A", "B", "C"]);
    expect(linkedLeafIds(t, "D")).toEqual([]);
  });

  it("unlinks only the nodes named", () => {
    const t = clearLinkKey(setLinkKey(fixture(), new Set(["A", "C"]), key), new Set(["A"]));
    expect(linkKeyCount(t, key)).toBe(1);
    expect(findNode(t, "A")!.linkKey).toBeUndefined();
    expect("linkKey" in findNode(t, "A")!).toBe(false); // deleted, not set to undefined
  });

  it("prunes a link that binds only one node", () => {
    const t = clearLinkKey(setLinkKey(fixture(), new Set(["A", "C"]), key), new Set(["A"]));
    const pruned = pruneLinks(t);
    expect(findNode(pruned, "C")!.linkKey).toBeUndefined();
  });

  it("keeps a link that still binds two", () => {
    const t = setLinkKey(fixture(), new Set(["A", "C"]), key);
    expect(linkKeyCount(pruneLinks(t), key)).toBe(2);
  });

  it("returns the very same tree when there is nothing to prune", () => {
    // Identity matters: a new array here would invalidate every cached render
    // in the graph on each pass, for no change at all.
    const t = fixture();
    expect(pruneLinks(t)).toBe(t);
    const linked = setLinkKey(t, new Set(["A", "C"]), key);
    expect(pruneLinks(linked)).toBe(linked);
  });
});

describe("purity", () => {
  it("never mutates the tree it is given", () => {
    // Frozen throughout: any in-place write throws in strict mode (ES modules
    // always are), so this catches a mutation wherever it hides.
    const deepFreeze = (nodes: LayerNode[]): LayerNode[] => {
      for (const n of nodes) {
        if (n.type === "group") deepFreeze(n.children);
        Object.freeze(n);
      }
      return Object.freeze(nodes) as LayerNode[];
    };
    const t = deepFreeze(fixture());
    const snapshot = JSON.stringify(t);

    expect(() => {
      updateNode(t, "C", { name: "x" });
      removeNode(t, "G1");
      removeMany(t, new Set(["A", "C"]));
      insertRelative(t, leaf("N"), "B", true);
      insertInGroup(t, leaf("N"), "G2");
      wrapInGroup(t, "C", group("W", []));
      ungroupNode(t, "G1");
      replaceNodeWith(t, "C", leaf("Z"));
      setLinkKey(t, new Set(["A", "C"]), "k");
      clearLinkKey(t, new Set(["A"]));
      pruneLinks(t);
      cloneSubtree(t[1], () => "n");
      mergeDownInTree(t, "A", (a, b) => leaf(`${a.id}${b.id}`));
      collectLeafIds(t);
      flattenedIds(t);
      topLevelSelected(t, new Set(["G1"]));
      clipGroupsOf(t);
      filterLayerTree(t, { ...EMPTY_LAYER_FILTER, query: "C" });
    }).not.toThrow();

    expect(JSON.stringify(t)).toBe(snapshot);
  });
});
