"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Layers as LayersIcon,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import styles from "../RightDock.module.scss";
import { BLEND_MODES, findNode, type LayerNode, type LayersApi } from "../../lib/layers";

/** Flatten the tree into display rows, hiding the children of collapsed groups. */
function flattenRows(nodes: LayerNode[], depth = 0): { node: LayerNode; depth: number }[] {
  const out: { node: LayerNode; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.type === "group" && n.expanded) out.push(...flattenRows(n.children, depth + 1));
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
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const margin = 8;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
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
    if (e.shiftKey) api.select(id, "range");
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

  const rows = flattenRows(layers);
  const multi = selectedLayerIds.length > 1;

  return (
    <div className={styles.layers}>
      {active && (
        <div className={styles.layerControls}>
          <label className={styles.blend}>
            <select value={active.blend} onChange={(e) => api.update(active.id, { blend: e.target.value })}>
              {BLEND_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </label>
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
            <span className={styles.opacityValue}>{active.opacity}%</span>
          </div>
        </div>
      )}

      {rows.length > 0 ? (
        <ul className={styles.layerList}>
          {rows.map(({ node: l, depth }) => {
            const isGroup = l.type === "group";
            return (
              <li
                key={l.id}
                className={styles.layerItem}
                data-selected={selected.has(l.id)}
                data-active={l.id === activeLayerId}
                data-hidden={!l.visible}
                data-dragging={l.id === dragId}
                style={{ paddingLeft: 8 + depth * 14 } as React.CSSProperties}
                draggable={editingId !== l.id}
                onClick={(e) => onRowClick(e, l.id)}
                onContextMenu={(e) => openMenu(e, l)}
                onDragStart={(e) => {
                  setDragId(l.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== l.id) {
                    const r = e.currentTarget.getBoundingClientRect();
                    const before = e.clientY - r.top < r.height / 2;
                    api.move(dragId, l.id, before);
                  }
                }}
                onDragEnd={() => setDragId(null)}
              >
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
                  <span className={styles.layerGroupIcon}>
                    {l.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                  </span>
                ) : (
                  <span className={styles.layerThumb} />
                )}
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
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(l);
                    }}
                  >
                    {l.name}
                  </span>
                )}
                {l.opacity < 100 && <span className={styles.layerOpacityTag}>{l.opacity}%</span>}
              </li>
            );
          })}
        </ul>
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
            <button type="button" onClick={() => run(api.duplicate)}>
              <Copy size={13} /> {multi ? "Duplicate Layers" : "Duplicate"}
            </button>
            <div className={styles.menuSep} />
            <button type="button" onClick={() => run(api.group)}>
              <FolderPlus size={13} /> {multi ? "Group Selection" : "Group"}
            </button>
            {menu.node.type === "group" && (
              <button type="button" onClick={() => run(() => api.ungroup(menu.node.id))}>
                <FolderMinus size={13} /> Ungroup
              </button>
            )}
            <button type="button" onClick={() => run(api.merge)}>
              <ArrowDownToLine size={13} /> {multi ? "Merge Layers" : "Merge Down"}
            </button>
            <button type="button" onClick={() => run(api.flatten)}>
              <LayersIcon size={13} /> Flatten Image
            </button>
            <div className={styles.menuSep} />
            <button type="button" className={styles.menuDanger} onClick={() => run(api.remove)}>
              <Trash2 size={13} /> {multi ? "Delete Layers" : "Delete"}
            </button>
          </div>
          </>,
          document.body,
        )}
    </div>
  );
}
