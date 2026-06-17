"use client";

import { useState } from "react";
import { ChevronDown, Eye, EyeOff, Layers as LayersIcon, Plus, Trash2 } from "lucide-react";
import styles from "../RightDock.module.scss";
import { BLEND_MODES, type Layer, type LayersApi } from "../../lib/layers";

export default function LayersPanel({ api }: { api: LayersApi }) {
  const { layers, activeLayerId } = api;
  const active = layers.find((l) => l.id === activeLayerId) ?? null;

  const [dragId, setDragId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const startRename = (l: Layer) => {
    setEditingId(l.id);
    setDraftName(l.name);
  };
  const commitRename = () => {
    if (editingId) api.update(editingId, { name: draftName.trim() || "Layer" });
    setEditingId(null);
  };

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

      {layers.length > 0 ? (
        <ul className={styles.layerList}>
          {layers.map((l) => (
            <li
              key={l.id}
              className={styles.layerItem}
              data-selected={l.id === activeLayerId}
              data-hidden={!l.visible}
              data-dragging={l.id === dragId}
              draggable={editingId !== l.id}
              onClick={() => api.select(l.id)}
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
              <span className={styles.layerThumb} />
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
          ))}
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
        <span className={styles.footerSpacer} />
        <button
          type="button"
          title="Delete layer"
          disabled={!activeLayerId}
          onClick={() => activeLayerId && api.remove(activeLayerId)}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
