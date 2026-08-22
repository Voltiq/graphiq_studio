"use client";

import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Focus,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  ScanEye,
  Layers as LayersIcon,
  Link2,
  Lock,
  Move,
  Paintbrush,
  PaintBucket,
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
import { cssGradient } from "../GradientControl";
import { swatchBg } from "../../lib/color";
import { uiZoom } from "../../lib/ui-scale";
import {
  BLEND_MODES,
  clipGroupsOf,
  EMPTY_LAYER_FILTER,
  filterLayerTree,
  fillLabel,
  findNode,
  hasAnyLock,
  isFillLayer,
  isLinked,
  isPixelsLocked,
  isPositionLocked,
  isTransparencyLocked,
  labelColor,
  type FillSpec,
  layerFilterActive,
  LAYER_LABELS,
  type LayerFilter,
  type LayerLabel,
  type LayerNode,
  type LayersApi,
  type LockFlag,
} from "../../lib/layers";
import { resolveIsolation } from "../../lib/isolate";
import { hasEnabledFx } from "../../lib/effects";
import { hasEnabledFilters } from "../../lib/filters";
import { clampX, clampY } from "../../lib/safeArea";

type ClipRole = "none" | "base" | "member";
interface Row {
  node: LayerNode;
  depth: number;
  clip: ClipRole;
  /** Visible-but-not-matching under an active filter (rendered dimmed). */
  dim: boolean;
}

// Photoshop-style lock row: transparency & pixels apply to pixel layers only;
// position & all apply to every kind. `all` overrides the individual three.
const LOCK_DEFS: { flag: LockFlag; label: string; Icon: typeof Lock; pixelOnly?: boolean }[] = [
  { flag: "transparency", label: "transparency", Icon: Grid2x2, pixelOnly: true },
  { flag: "pixels", label: "image pixels", Icon: Paintbrush, pixelOnly: true },
  { flag: "position", label: "position", Icon: Move },
  { flag: "all", label: "all", Icon: Lock },
];

/** Background style previewing a fill spec in the layer thumbnail. */
function fillPreview(fill: FillSpec): CSSProperties {
  return fill.kind === "solid"
    ? swatchBg(fill.color)
    : { backgroundImage: cssGradient(fill.gradient.stops) };
}

/** Human-readable summary of a layer's active locks (row indicator tooltip). */
function lockSummary(n: LayerNode): string {
  if (n.locks?.all) return "All locked";
  const on: string[] = [];
  if (isTransparencyLocked(n)) on.push("transparency");
  if (isPixelsLocked(n)) on.push("pixels");
  if (isPositionLocked(n)) on.push("position");
  return `Locked: ${on.join(", ")}`;
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

  /* Reordering by TOUCH.
   *
   * The rows reorder with HTML5 drag and drop, and those events do not fire for
   * a finger at all — so on a phone the layer order could not be changed, by
   * any route. This is a second path rather than a replacement: the mouse keeps
   * the drag-and-drop it already had, unchanged, and touch gets long-press to
   * lift and drag to move. Both end up calling the same `api.move`.
   *
   * A long press is what separates "lift this row" from "scroll the list",
   * which is the only ambiguity a finger has here. */
  const LIFT_MS = 350;
  const SLOP = 8; // px of movement that still counts as holding still
  const touchDrag = useRef<{
    id: string;
    x: number;
    y: number;
    timer: number | null;
    lifted: boolean;
  } | null>(null);

  /* The move/end listeners live only for as long as a touch drag does.
   *
   * They used to be attached for the lifetime of the panel, and that broke the
   * MOUSE path outright: with a window `pointerup`/`pointercancel` pair
   * registered, the rows stopped reordering by drag-and-drop entirely — the
   * same drag reordered against the file without them and did nothing with.
   * Guarding the handlers was not enough, because it is the registration and
   * not the handler that does it. Since nothing needs them until a finger has
   * actually lifted a row, they go on at that moment and come off at the end,
   * and a mouse drag never coexists with them at all. */
  const detach = useRef<(() => void) | null>(null);
  /** The stack as it stood when this drag began, for the single undo entry. */
  const treeBefore = useRef<LayerNode[] | null>(null);
  const commitMove = useCallback(() => {
    const before = treeBefore.current;
    treeBefore.current = null;
    if (before) api.commitMove(before);
  }, [api]);

  const endTouchDrag = useCallback(() => {
    const t = touchDrag.current;
    if (t?.timer) window.clearTimeout(t.timer);
    touchDrag.current = null;
    detach.current?.();
    detach.current = null;
    if (t?.lifted) commitMove();
    setDragId(null);
  }, [commitMove]);

  const attachTouchDrag = useCallback(() => {
    const onMove = (e: PointerEvent) => {
      const t = touchDrag.current;
      if (!t) return;
      if (!t.lifted) {
        // Still deciding: enough movement before the press lands means a scroll.
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > SLOP) endTouchDrag();
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest("[data-layer-id]") : null;
      const overId = row?.getAttribute("data-layer-id");
      if (!overId || overId === t.id) return;
      const r = row!.getBoundingClientRect();
      api.move(t.id, overId, e.clientY - r.top < r.height / 2);
    };
    const onUp = () => endTouchDrag();
    /* Once lifted, the list must stop scrolling under the finger. `touch-action`
       cannot do it: it is latched when the gesture starts, and the gesture has
       already started by the time the press lands — so the scroll is refused
       here instead, which needs a non-passive listener. */
    const block = (e: TouchEvent) => {
      if (touchDrag.current?.lifted) e.preventDefault();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("touchmove", block, { passive: false });
    detach.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("touchmove", block);
    };
  }, [api, endTouchDrag]);

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.pointerType !== "touch" || filterActive || editingId === id) return;
    const timer = window.setTimeout(() => {
      const t = touchDrag.current;
      if (!t) return;
      t.lifted = true;
      t.timer = null;
      treeBefore.current = api.layers;
      setDragId(t.id); // the row dims, exactly as it does for a mouse drag
    }, LIFT_MS);
    touchDrag.current = { id, x: e.clientX, y: e.clientY, timer, lifted: false };
    attachTouchDrag();
  };
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
    const left = clampX(menu.x, width, margin);
    const top = clampY(menu.y, height, margin);
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
  // Isolate mode dims the rows the canvas is not showing. The panel keeps
  // listing them: they are still in the document, and hiding them here would
  // make isolate feel like a destructive filter rather than a viewing aid.
  const isolatedOut = useMemo(() => {
    if (!api.isolatedIds?.length) return null;
    const keep = resolveIsolation(layers, api.isolatedIds).keep;
    const out = new Set<string>();
    const walk = (nodes: typeof layers) => {
      for (const n of nodes) {
        if (!keep.has(n.id)) out.add(n.id);
        if (n.type === "group") walk(n.children);
      }
    };
    walk(layers);
    return out;
  }, [layers, api.isolatedIds]);
  const multi = selectedLayerIds.length > 1;

  // Link button: bind 2+ selected layers, or unlink when everything selected is
  // already linked (so a single linked layer can be unlinked here too).
  const selectedNodes = selectedLayerIds
    .map((id) => findNode(layers, id))
    .filter((n): n is LayerNode => !!n);
  const allSelLinked = selectedNodes.length > 0 && selectedNodes.every((n) => isLinked(n));
  const canToggleLink = selectedLayerIds.length >= 2 || allSelLinked;

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
          <div className={styles.lockRow} role="group" aria-label="Layer locks">
            <span className={styles.lockLabel}>Lock</span>
            <div className={styles.lockBtns}>
              {LOCK_DEFS.map(({ flag, label, Icon, pixelOnly }) => {
                const allOn = !!active.locks?.all;
                const rawOn = !!active.locks?.[flag];
                const na = pixelOnly && active.type !== "layer"; // no pixels to lock
                const on = flag === "all" ? allOn : allOn || rawOn;
                // Individual flags are frozen (but shown locked) while Lock-all is on.
                const disabled = na || (flag !== "all" && allOn);
                return (
                  <button
                    key={flag}
                    type="button"
                    className={styles.lockBtn}
                    data-on={on}
                    aria-pressed={on}
                    disabled={disabled}
                    title={
                      na
                        ? `Lock ${label} applies to pixel layers only`
                        : flag === "all"
                          ? on
                            ? "Unlock all"
                            : "Lock all"
                          : `${on ? "Unlock" : "Lock"} ${label}`
                    }
                    onClick={() => api.setLock(active.id, flag, flag === "all" ? !allOn : !rawOn)}
                  >
                    <Icon size={13} />
                  </button>
                );
              })}
            </div>
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
                data-dim={dim || (isolatedOut ? isolatedOut.has(l.id) : false)}
                data-dragging={l.id === dragId}
                data-layer-id={l.id}
                style={{ paddingLeft: 8 + depth * 14 + (clip === "member" ? 14 : 0) } as React.CSSProperties}
                draggable={editingId !== l.id && !filterActive}
                onPointerDown={(e) => onRowPointerDown(e, l.id)}
                onClick={(e) => onRowClick(e, l.id)}
                onContextMenu={(e) => openMenu(e, l)}
                onDragStart={(e) => {
                  setDragId(l.id);
                  treeBefore.current = api.layers;
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
                onDragEnd={() => {
                  commitMove();
                  setDragId(null);
                }}
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
                    style={isFillLayer(l) ? fillPreview(l.fill) : undefined}
                    title={isFillLayer(l) ? "Fill layer — double-click to edit" : undefined}
                    onDoubleClick={
                      isFillLayer(l)
                        ? (e) => {
                            e.stopPropagation();
                            api.editFill(l.id);
                          }
                        : undefined
                    }
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
                    {isAdjustment
                      ? "Adjustment"
                      : isGroup
                        ? "Group"
                        : isFillLayer(l)
                          ? fillLabel(l.fill)
                          : "Layer"}{" "}
                    · {l.opacity}%
                  </span>
                </div>
                {hasAnyLock(l) && (
                  <span className={styles.rowLock} title={lockSummary(l)} aria-label={lockSummary(l)}>
                    <Lock size={11} />
                  </span>
                )}
                {isLinked(l) && (
                  <button
                    type="button"
                    className={styles.rowLink}
                    title="Linked — moves with its link-mates; click to unlink"
                    aria-label="Linked layer — click to unlink"
                    onClick={(e) => {
                      e.stopPropagation();
                      api.unlinkLayer(l.id);
                    }}
                  >
                    <Link2 size={12} />
                  </button>
                )}
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
          title={
            api.isolatedIds
              ? "Leave isolate mode — show every layer again"
              : "Isolate the selected layers (Ctrl+Alt+L) — a view only, nothing is changed"
          }
          aria-label={api.isolatedIds ? "Exit isolate mode" : "Isolate selected layers"}
          data-on={api.isolatedIds ? true : undefined}
          onClick={() => api.toggleIsolate()}
        >
          {api.isolatedIds ? <ScanEye size={15} /> : <Focus size={15} />}
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
          title={
            allSelLinked
              ? "Unlink layers"
              : "Link layers — move them together without grouping"
          }
          data-on={allSelLinked || undefined}
          disabled={!canToggleLink}
          onClick={() => api.toggleLinkSelected()}
        >
          {allSelLinked ? <Unlink2 size={15} /> : <Link2 size={15} />}
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
            <div className={styles.menuLockRow} aria-label="Lock">
              <span className={styles.menuLockLabel}>Lock</span>
              {LOCK_DEFS.map(({ flag, label, Icon, pixelOnly }) => {
                // Read the live node so toggles stay in sync without closing the menu.
                const node = findNode(layers, menu.node.id) ?? menu.node;
                const allOn = !!node.locks?.all;
                const rawOn = !!node.locks?.[flag];
                const na = pixelOnly && node.type !== "layer";
                const on = flag === "all" ? allOn : allOn || rawOn;
                const disabled = na || (flag !== "all" && allOn);
                return (
                  <button
                    key={flag}
                    type="button"
                    className={styles.lockBtn}
                    data-on={on}
                    disabled={disabled}
                    title={
                      na
                        ? `Lock ${label} applies to pixel layers only`
                        : flag === "all"
                          ? on
                            ? "Unlock all"
                            : "Lock all"
                          : `${on ? "Unlock" : "Lock"} ${label}`
                    }
                    onClick={() => api.setLock(node.id, flag, flag === "all" ? !allOn : !rawOn)}
                  >
                    <Icon size={12} />
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={() => run(api.duplicate)}>
              <Copy size={13} /> {multi ? "Duplicate layers" : "Duplicate"}
            </button>
            {menu.node.type === "adjustment" && (
              <button type="button" onClick={() => run(() => api.editAdjustment(menu.node.id))}>
                <Contrast size={13} /> Edit Adjustment…
              </button>
            )}
            {isFillLayer(menu.node) && (
              <button type="button" onClick={() => run(() => api.editFill(menu.node.id))}>
                <PaintBucket size={13} /> Edit Fill…
              </button>
            )}
            <button type="button" onClick={() => run(() => api.toggleClip(menu.node.id))}>
              <CornerDownRight size={13} /> {menu.node.clipped ? "Release clipping mask" : "Create clipping mask"}
            </button>
            <div className={styles.menuSep} />
            {isLinked(menu.node) ? (
              <button type="button" onClick={() => run(() => api.unlinkLayer(menu.node.id))}>
                <Unlink2 size={13} /> Unlink layer
              </button>
            ) : (
              multi && (
                <button type="button" onClick={() => run(api.toggleLinkSelected)}>
                  <Link2 size={13} /> Link layers
                </button>
              )
            )}
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
