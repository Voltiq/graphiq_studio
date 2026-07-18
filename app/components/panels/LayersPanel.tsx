"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Contrast,
  CornerDownRight,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Layers as LayersIcon,
  Link2,
  Pencil,
  Plus,
  FlaskConical,
  Search,
  Sparkles,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import styles from "../RightDock.module.scss";
import { EditableValue, Select } from "../Controls";
import { uiZoom } from "../../lib/ui-scale";
import {
  BLEND_MODES,
  clipGroupsOf,
  EMPTY_LAYER_FILTER,
  filterLayerTree,
  findNode,
  labelColor,
  layerFilterActive,
  LAYER_LABELS,
  type LayerFilter,
  type LayerLabel,
  type LayerNode,
  type LayersApi,
} from "../../lib/layers";
import { hasEnabledFx } from "../../lib/effects";
import { hasEnabledFilters } from "../../lib/filters";

type ClipRole = "none" | "base" | "member";
interface Row {
  node: LayerNode;
  depth: number;
  clip: ClipRole;
  /** Visible-but-not-matching under an active filter (rendered dimmed). */
  dim: boolean;
}

const KIND_OPTIONS = ["All kinds", "Layers", "Groups", "Adjustments"] as const;
const KIND_BY_OPTION: Record<string, LayerFilter["kind"]> = {
  "All kinds": "all",
  Layers: "layer",
  Groups: "group",
  Adjustments: "adjustment",
};

/** Flatten the tree into display rows, hiding the children of collapsed groups.
 *  Each row carries its clip role within its parent (resolved by clipGroupsOf): a
 *  clip-group `base` (underlined) or a clipped `member` (indented with an elbow).
 *  Under an active filter, only `vis.visible` rows appear (non-matches dimmed) —
 *  and matched rows inside COLLAPSED groups are revealed so a search always
 *  shows its hits. */
function flattenRows(
  nodes: LayerNode[],
  vis: { match: Set<string>; visible: Set<string> } | null,
  depth = 0,
): Row[] {
  const role = new Map<string, ClipRole>();
  for (const g of clipGroupsOf(nodes)) {
    if (g.members.length) {
      role.set(g.base.id, "base");
      for (const m of g.members) role.set(m.id, "member");
    }
  }
  const out: Row[] = [];
  for (const n of nodes) {
    if (vis && !vis.visible.has(n.id)) continue;
    out.push({ node: n, depth, clip: role.get(n.id) ?? "none", dim: !!vis && !vis.match.has(n.id) });
    if (n.type === "group" && (n.expanded || (vis && !vis.match.has(n.id))))
      out.push(...flattenRows(n.children, vis, depth + 1));
  }
  return out;
}

export default function LayersPanel({ api }: { api: LayersApi }) {
  const { layers, activeLayerId, selectedLayerIds } = api;
  const active = activeLayerId ? findNode(layers, activeLayerId) : null;
  const selected = new Set(selectedLayerIds);

  const [dragId, setDragId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; node: LayerNode } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Keep the menu fully on screen: clamp to the viewport once its size is known.
  // Runs before paint, so the corrected position is what the user actually sees.
  // The menu is UI-scale-zoomed: gBCR is viewport px already, but style offsets
  // on a zoomed element render ×z, so divide when writing them.
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const margin = 8;
    const z = uiZoom();
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin));
    el.style.left = `${left / z}px`;
    el.style.top = `${top / z}px`;
  }, [menu]);

  const startRename = (n: LayerNode) => {
    setEditingId(n.id);
    setDraftName(n.name);
  };
  const commitRename = () => {
    if (editingId) api.update(editingId, { name: draftName.trim() || "Layer" });
    setEditingId(null);
  };

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.altKey) api.toggleClip(id); // Alt-click clips this layer to the one below
    else if (e.shiftKey) api.select(id, "range");
    else if (e.ctrlKey || e.metaKey) api.select(id, "toggle");
    else api.select(id, "replace");
  };

  const openMenu = (e: React.MouseEvent, node: LayerNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(node.id)) api.select(node.id, "replace");
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const run = (fn: () => void) => {
    fn();
    setMenu(null);
  };

  // ---- Search / filter row (name + kind + colour label) ---------------------
  const [filter, setFilter] = useState<LayerFilter>(EMPTY_LAYER_FILTER);
  const filterActive = layerFilterActive(filter);
  const vis = useMemo(() => filterLayerTree(layers, filter), [layers, filter]);
  const toggleLabelFilter = (l: LayerLabel) =>
    setFilter((f) => ({
      ...f,
      labels: f.labels.includes(l) ? f.labels.filter((x) => x !== l) : [...f.labels, l],
    }));
  // Any labels in use? (the colour-dot strip only appears when relevant)
  const anyLabels = useMemo(() => {
    let found = false;
    const walk = (ns: LayerNode[]) => {
      for (const n of ns) {
        if (n.label) found = true;
        if (n.type === "group") walk(n.children);
      }
    };
    walk(layers);
    return found;
  }, [layers]);

  // Apply a colour label to every selected node (menu acts on the selection).
  const applyLabel = (l: LayerLabel | undefined) => {
    const ids = selectedLayerIds.length ? selectedLayerIds : menu ? [menu.node.id] : [];
    for (const id of ids) api.update(id, { label: l });
  };

  const rows = flattenRows(layers, vis);
  const multi = selectedLayerIds.length > 1;

  return (
    <div className={styles.layers}>
      {active && (
        <div className={styles.layerControls}>
          <Select
            block
            options={BLEND_MODES}
            value={active.blend}
            onChange={(s) => api.update(active.id, { blend: s })}
          />
          <div className={styles.opacity}>
            <span className={styles.opacityLabel}>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={active.opacity}
              onChange={(e) => api.update(active.id, { opacity: Number(e.target.value) })}
              style={{ "--pct": `${active.opacity}%` } as React.CSSProperties}
              aria-label="Layer opacity"
            />
            <EditableValue
              className={styles.opacityValue}
              value={active.opacity}
              min={0}
              max={100}
              display={`${active.opacity}%`}
              onCommit={(n) => api.update(active.id, { opacity: n })}
              ariaLabel="Layer opacity percentage"
            />
          </div>
        </div>
      )}

      <div className={styles.layerFilter}>
        <div className={styles.layerFilterBox}>
          <Search size={12} />
          <input
            value={filter.query}
            placeholder="Filter layers…"
            aria-label="Filter layers by name"
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter(EMPTY_LAYER_FILTER);
              e.stopPropagation(); // keep single-letter tool shortcuts out
            }}
          />
          {filterActive && (
            <button
              type="button"
              onClick={() => setFilter(EMPTY_LAYER_FILTER)}
              aria-label="Clear layer filter"
              title="Clear filter"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <Select
          options={[...KIND_OPTIONS]}
          value={KIND_OPTIONS.find((o) => KIND_BY_OPTION[o] === filter.kind) ?? "All kinds"}
          onChange={(o) => setFilter((f) => ({ ...f, kind: KIND_BY_OPTION[o] ?? "all" }))}
        />
      </div>
      {(anyLabels || filter.labels.length > 0) && (
        <div className={styles.labelFilterRow} aria-label="Filter by colour label">
          {LAYER_LABELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={styles.labelFilterDot}
              data-active={filter.labels.includes(l.id)}
              style={{ background: l.color }}
              title={`Show ${l.name.toLowerCase()}-labelled layers`}
              aria-pressed={filter.labels.includes(l.id)}
              onClick={() => toggleLabelFilter(l.id)}
            />
          ))}
        </div>
      )}

      {rows.length > 0 ? (
        <ul className={styles.layerList}>
          {rows.map(({ node: l, depth, clip, dim }) => {
            const isGroup = l.type === "group";
            const isAdjustment = l.type === "adjustment";
            return (
              <li
                key={l.id}
                className={styles.layerItem}
                data-selected={selected.has(l.id)}
                data-active={l.id === activeLayerId}
                data-hidden={!l.visible}
                data-dim={dim}
                data-dragging={l.id === dragId}
                style={{ paddingLeft: 8 + depth * 14 + (clip === "member" ? 14 : 0) } as React.CSSProperties}
                draggable={editingId !== l.id && !filterActive}
                onClick={(e) => onRowClick(e, l.id)}
                onContextMenu={(e) => openMenu(e, l)}
                onDragStart={(e) => {
                  setDragId(l.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  // Reordering with parts of the tree hidden would be blind —
                  // clear the filter to rearrange.
                  if (filterActive) return;
                  if (dragId && dragId !== l.id) {
                    const r = e.currentTarget.getBoundingClientRect();
                    const before = e.clientY - r.top < r.height / 2;
                    api.move(dragId, l.id, before);
                  }
                }}
                onDragEnd={() => setDragId(null)}
              >
                {clip === "member" && (
                  <CornerDownRight
                    size={12}
                    aria-label="Clipped to layer below"
                    style={{ color: "var(--text-3)", flexShrink: 0 }}
                  />
                )}
                {isGroup ? (
                  <button
                    type="button"
                    className={styles.layerCaret}
                    onClick={(e) => {
                      e.stopPropagation();
                      api.update(l.id, { expanded: !l.expanded });
                    }}
                    aria-label={l.expanded ? "Collapse group" : "Expand group"}
                  >
                    {l.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : (
                  <span className={styles.layerCaret} />
                )}
                <button
                  type="button"
                  className={styles.layerEye}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.update(l.id, { visible: !l.visible });
                  }}
                  aria-label={l.visible ? "Hide layer" : "Show layer"}
                >
                  {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                {isGroup ? (
                  <span
                    className={styles.layerGroupIcon}
                    data-active={l.mask || l.filterMask ? l.id === activeLayerId && api.maskSurface === "pixels" : undefined}
                  >
                    {l.expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                  </span>
                ) : isAdjustment ? (
                  <span className={styles.layerGroupIcon} title="Adjustment layer">
                    <Contrast size={16} />
                  </span>
                ) : (
                  <span
                    className={styles.layerThumb}
                    data-active={l.mask || l.filterMask ? l.id === activeLayerId && api.maskSurface === "pixels" : undefined}
                    onClick={
                      l.mask || l.filterMask
                        ? (e) => {
                            e.stopPropagation();
                            api.select(l.id, "replace");
                            api.chooseSurface(l.id, "pixels");
                          }
                        : undefined
                    }
                  />
                )}
                {isAdjustment && l.type === "adjustment" && (
                  <button
                    type="button"
                    className={styles.maskLink}
                    data-on={l.clipped}
                    title={
                      l.clipped
                        ? "Clipped to the layer below — click to affect all layers below"
                        : "Affects all layers below — click to clip to the layer directly below"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      api.setAdjustmentClipped(l.id, !l.clipped);
                    }}
                  >
                    <CornerDownRight size={12} />
                  </button>
                )}
                {l.mask && (
                  <>
                    <button
                      type="button"
                      className={styles.maskLink}
                      data-on={l.mask.linked}
                      title={l.mask.linked ? "Mask linked — click to unlink" : "Mask unlinked — click to link"}
                      onClick={(e) => {
                        e.stopPropagation();
                        api.toggleMaskLinked(l.id);
                      }}
                    >
                      {l.mask.linked ? <Link2 size={12} /> : <Unlink2 size={12} />}
                    </button>
                    <button
                      type="button"
                      className={styles.maskThumb}
                      data-active={l.id === activeLayerId && api.maskSurface === "mask"}
                      data-disabled={!l.mask.enabled}
                      data-viewing={api.maskViewId === l.id || undefined}
                      title={
                        l.mask.enabled
                          ? api.maskViewId === l.id
                            ? "Viewing the mask — Alt-click (or click a thumbnail) to return"
                            : "Layer mask — click to paint it, Alt-click to view it on the canvas, Shift-click to disable"
                          : "Layer mask (disabled) — Shift-click to enable"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.shiftKey) {
                          api.toggleMaskEnabled(l.id);
                          return;
                        }
                        if (e.altKey) {
                          api.select(l.id, "replace");
                          api.toggleMaskView(l.id);
                          return;
                        }
                        api.select(l.id, "replace");
                        api.chooseSurface(l.id, "mask");
                      }}
                    >
                      {!l.mask.enabled && <span className={styles.maskOff}>✕</span>}
                    </button>
                  </>
                )}
                {l.type !== "adjustment" && l.filterMask && (
                  <button
                    type="button"
                    className={styles.maskThumb}
                    data-kind="filter"
                    data-active={l.id === activeLayerId && api.maskSurface === "filterMask"}
                    data-disabled={!l.filterMask.enabled}
                    title={
                      l.filterMask.enabled
                        ? "Filter mask (confines the smart filters) — click to paint it, Shift-click to disable"
                        : "Filter mask (disabled) — Shift-click to enable"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey) {
                        api.toggleFilterMaskEnabled(l.id);
                        return;
                      }
                      api.select(l.id, "replace");
                      api.chooseSurface(l.id, "filterMask");
                    }}
                  >
                    {l.filterMask.enabled ? (
                      <FlaskConical size={13} />
                    ) : (
                      <span className={styles.maskOff}>✕</span>
                    )}
                  </button>
                )}
                {l.label && (
                  <span
                    className={styles.labelDot}
                    style={{ background: labelColor(l.label) }}
                    title={`${LAYER_LABELS.find((x) => x.id === l.label)?.name ?? ""} label`}
                  />
                )}
                <div className={styles.layerMeta}>
                  {editingId === l.id ? (
                    <input
                      className={styles.layerRename}
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className={styles.layerName}
                      style={clip === "base" ? { textDecoration: "underline" } : undefined}
                      title={clip === "base" ? "Clip-group base" : undefined}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(l);
                      }}
                    >
                      {l.name}
                    </span>
                  )}
                  <span className={styles.layerSub}>
                    {isAdjustment ? "Adjustment" : isGroup ? "Group" : "Layer"} · {l.opacity}%
                  </span>
                </div>
                {!isAdjustment && hasEnabledFilters(l.filters) && (
                  <button
                    type="button"
                    className={styles.maskLink}
                    data-on={true}
                    title="Smart filters — click to edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      api.openFilters(l.id);
                    }}
                  >
                    <FlaskConical size={13} />
                  </button>
                )}
                {!isAdjustment && hasEnabledFx(l.effects) && (
                  <button
                    type="button"
                    className={styles.maskLink}
                    data-on={true}
                    title="Layer effects — click to edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      api.openLayerStyle(l.id);
                    }}
                  >
                    <Sparkles size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : filterActive ? (
        <div className={styles.layersEmpty}>
          <span className={styles.layersEmptyIcon}>
            <Search size={20} />
          </span>
          <p>No layers match</p>
          <span className={styles.layersEmptyHint}>
            Adjust the filter above, or clear it to see every layer.
          </span>
        </div>
      ) : (
        <div className={styles.layersEmpty}>
          <span className={styles.layersEmptyIcon}>
            <LayersIcon size={20} />
          </span>
          <p>No layers yet</p>
          <span className={styles.layersEmptyHint}>
            Create a layer to start building this canvas.
          </span>
        </div>
      )}

      <div className={styles.layerFooter}>
        <button type="button" title="New layer" onClick={api.add}>
          <Plus size={15} />
        </button>
        <button
          type="button"
          title={active?.type === "group" ? "Ungroup" : "Group"}
          disabled={!activeLayerId}
          onClick={() => {
            if (active?.type === "group") api.ungroup(active.id);
            else api.group();
          }}
        >
          <FolderPlus size={15} />
        </button>
        <button
          type="button"
          title={active?.mask ? "Layer already has a mask" : "Add layer mask (reveal all)"}
          disabled={!activeLayerId || !!active?.mask}
          onClick={() => api.addMask("reveal")}
        >
          <CircleDashed size={15} />
        </button>
        <button
          type="button"
          title="Layer style…"
          disabled={!activeLayerId || active?.type === "adjustment"}
          onClick={() => activeLayerId && api.openLayerStyle(activeLayerId)}
        >
          <Sparkles size={15} />
        </button>
        <span className={styles.footerSpacer} />
        <button
          type="button"
          title="Delete layer"
          disabled={!selectedLayerIds.length}
          onClick={() => api.remove()}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {menu &&
        typeof document !== "undefined" &&
        createPortal(
          <>
          <div
            className={styles.menuScrim}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div ref={menuRef} className={styles.layerMenu} style={{ left: menu.x, top: menu.y }} role="menu">
            <button type="button" onClick={() => run(() => startRename(menu.node))}>
              <Pencil size={13} /> Rename
            </button>
            <div className={styles.menuLabelRow} aria-label="Colour label">
              <button
                type="button"
                className={styles.menuLabelNone}
                data-active={!menu.node.label}
                title="No label"
                onClick={() => run(() => applyLabel(undefined))}
              >
                <X size={10} />
              </button>
              {LAYER_LABELS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={styles.menuLabelDot}
                  data-active={menu.node.label === l.id}
                  style={{ background: l.color }}
                  title={`${l.name} label${multi ? " (all selected)" : ""}`}
                  onClick={() => run(() => applyLabel(l.id))}
                />
              ))}
            </div>
            <button type="button" onClick={() => run(api.duplicate)}>
              <Copy size={13} /> {multi ? "Duplicate layers" : "Duplicate"}
            </button>
            {menu.node.type === "adjustment" && (
              <button type="button" onClick={() => run(() => api.editAdjustment(menu.node.id))}>
                <Contrast size={13} /> Edit Adjustment…
              </button>
            )}
            <button type="button" onClick={() => run(() => api.toggleClip(menu.node.id))}>
              <CornerDownRight size={13} /> {menu.node.clipped ? "Release clipping mask" : "Create clipping mask"}
            </button>
            <div className={styles.menuSep} />
            <button type="button" onClick={() => run(api.group)}>
              <FolderPlus size={13} /> {multi ? "Group selection" : "Group"}
            </button>
            {menu.node.type === "group" && (
              <button type="button" onClick={() => run(() => api.ungroup(menu.node.id))}>
                <FolderMinus size={13} /> Ungroup
              </button>
            )}
            <button type="button" onClick={() => run(api.merge)}>
              <ArrowDownToLine size={13} /> {multi ? "Merge layers" : "Merge down"}
            </button>
            <button type="button" onClick={() => run(api.flatten)}>
              <LayersIcon size={13} /> Flatten Image
            </button>
            {menu.node.type !== "adjustment" && (
              <>
                <div className={styles.menuSep} />
                <button type="button" onClick={() => run(() => api.openLayerStyle(menu.node.id))}>
                  <Sparkles size={13} /> Layer Style…
                </button>
                <button type="button" onClick={() => run(() => api.copyLayerStyle(menu.node.id))}>
                  <Copy size={13} /> Copy Layer Style
                </button>
                {api.canPasteStyle && (
                  <button type="button" onClick={() => run(() => api.pasteLayerStyle(menu.node.id))}>
                    <Sparkles size={13} /> Paste Layer Style
                  </button>
                )}
                {hasEnabledFx(menu.node.effects) && (
                  <button type="button" onClick={() => run(() => api.clearLayerStyle(menu.node.id))}>
                    <Trash2 size={13} /> Clear Layer Style
                  </button>
                )}
                <button type="button" onClick={() => run(() => api.openFilters(menu.node.id))}>
                  <FlaskConical size={13} /> Smart Filters…
                </button>
              </>
            )}
            <div className={styles.menuSep} />
            {menu.node.mask ? (
              <>
                <button type="button" onClick={() => run(api.loadMaskAsSelection)}>
                  <CircleDashed size={13} /> Mask to Selection
                </button>
                <button type="button" onClick={() => run(() => api.toggleMaskEnabled(menu.node.id))}>
                  <CircleDashed size={13} /> {menu.node.mask.enabled ? "Disable mask" : "Enable mask"}
                </button>
                <button type="button" onClick={() => run(api.applyMask)}>
                  <CircleDashed size={13} /> Apply Mask
                </button>
                <button type="button" className={styles.menuDanger} onClick={() => run(api.removeMask)}>
                  <Trash2 size={13} /> Delete Mask
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => run(() => api.addMask("reveal"))}>
                  <CircleDashed size={13} /> Add Layer Mask
                </button>
                <button type="button" onClick={() => run(() => api.addMask("selection"))}>
                  <CircleDashed size={13} /> Mask from Selection
                </button>
              </>
            )}
            <div className={styles.menuSep} />
            <button type="button" className={styles.menuDanger} onClick={() => run(api.remove)}>
              <Trash2 size={13} /> {multi ? "Delete layers" : "Delete"}
            </button>
          </div>
          </>,
          document.body,
        )}
    </div>
  );
}
