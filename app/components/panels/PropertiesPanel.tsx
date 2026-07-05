"use client";

import { useEffect, useState } from "react";
import {
  CornerDownRight,
  Contrast,
  Folder,
  Image as ImageIcon,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from "lucide-react";
import styles from "../RightDock.module.scss";
import { Select, Slider, Toggle } from "../Controls";
import { findNode, type LayersApi, type LayerNode, BLEND_MODES } from "../../lib/layers";
import { FX_LABELS, FX_ORDER, hasEnabledFx, type FxKey } from "../../lib/effects";
import { filterLabel, type SmartFilter } from "../../lib/filters";
import { ADJUSTMENT_TYPES } from "../../lib/adjustment-types";
import type { AdjustmentSpec } from "../../lib/adjust";

/** Human label for an adjustment node's spec. */
function adjustmentLabel(spec: AdjustmentSpec): string {
  if (spec.type === "levels") return "Levels";
  if (spec.type === "curves") return "Curves";
  return ADJUSTMENT_TYPES.find((t) => t.id === spec.preset)?.label ?? "Adjustments";
}

/**
 * Properties — a contextual editor for the ACTIVE layer node: the everyday
 * per-layer controls (name, opacity, blend, clip), plus quick toggles for its
 * masks, layer effects, smart filters or adjustment — without opening the full
 * dialogs (each section links into its editor for the deep controls).
 */
export default function PropertiesPanel({ api }: { api: LayersApi }) {
  const node: LayerNode | null = api.activeLayerId ? findNode(api.layers, api.activeLayerId) : null;

  // Inline rename mirrors the Layers panel: draft while focused, commit on blur.
  const [draft, setDraft] = useState(node?.name ?? "");
  const [editingName, setEditingName] = useState(false);
  useEffect(() => {
    if (!editingName) setDraft(node?.name ?? "");
  }, [node?.name, node?.id, editingName]);

  if (!node) {
    return <p className={styles.propsEmpty}>Select a layer to see its properties.</p>;
  }

  const id = node.id;
  const isAdjustment = node.type === "adjustment";
  const isGroup = node.type === "group";
  const KindIcon = isAdjustment ? Contrast : isGroup ? Folder : node.vector ? Shapes : ImageIcon;
  const kind = isAdjustment
    ? adjustmentLabel(node.adjustment)
    : isGroup
      ? "Group"
      : node.vector
        ? node.vector.type === "text"
          ? "Text layer"
          : "Shape layer"
        : "Pixel layer";

  const fxKeys = !isAdjustment && node.effects ? FX_ORDER.filter((k) => node.effects?.[k]) : [];
  const filters: SmartFilter[] = (!isAdjustment && node.filters) || [];

  const setFilterEnabled = (f: SmartFilter, enabled: boolean) =>
    api.update(id, { filters: filters.map((x) => (x.id === f.id ? { ...x, enabled } : x)) });

  return (
    <div className={styles.props}>
      {/* Identity: kind + rename */}
      <div className={styles.propsHead}>
        <span className={styles.propsKindIcon}>
          <KindIcon size={15} />
        </span>
        <div className={styles.propsIdent}>
          <input
            className={styles.propsName}
            value={editingName ? draft : node.name}
            onFocus={() => {
              setDraft(node.name);
              setEditingName(true);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditingName(false);
              const name = draft.trim();
              if (name && name !== node.name) api.update(id, { name });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft(node.name);
                setEditingName(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Layer name"
          />
          <span className={styles.propsKind}>{kind}</span>
        </div>
      </div>

      {/* Common: blend + opacity + clip */}
      <Select
        block
        options={BLEND_MODES}
        value={node.blend}
        onChange={(b) => api.update(id, { blend: b })}
      />
      <Slider
        label="Opacity"
        min={0}
        max={100}
        unit="%"
        value={node.opacity}
        onChange={(v) => api.update(id, { opacity: v })}
      />
      <button
        type="button"
        className={styles.propsRowBtn}
        data-on={!!node.clipped}
        onClick={() => api.toggleClip(id)}
        title="Clip this layer to the alpha of the layer directly below (Alt-click a row in Layers)"
      >
        <CornerDownRight size={13} />
        {node.clipped ? "Clipped to layer below" : "Clip to layer below"}
      </button>

      {/* Masks */}
      {!isAdjustment && (node.mask || node.filterMask) && (
        <section className={styles.propsSection}>
          <span className={styles.propsLabel}>Masks</span>
          {node.mask && (
            <div className={styles.propsRow}>
              <Toggle
                label="Layer mask"
                checked={node.mask.enabled}
                onChange={() => api.toggleMaskEnabled(id)}
              />
              <Toggle
                label="Linked"
                checked={node.mask.linked}
                onChange={() => api.toggleMaskLinked(id)}
              />
            </div>
          )}
          {node.filterMask && (
            <div className={styles.propsRow}>
              <Toggle
                label="Filter mask"
                checked={node.filterMask.enabled}
                onChange={() => api.toggleFilterMaskEnabled(id)}
              />
            </div>
          )}
        </section>
      )}

      {/* Layer effects */}
      {!isAdjustment && (
        <section className={styles.propsSection}>
          <span className={styles.propsLabel}>
            <Sparkles size={11} /> Effects
          </span>
          {fxKeys.length === 0 && <span className={styles.propsHint}>No effects.</span>}
          {fxKeys.map((k: FxKey) => (
            <div key={k} className={styles.propsRow}>
              <Toggle
                label={FX_LABELS[k]}
                checked={!!node.effects?.[k]?.enabled}
                onChange={(on) => api.toggleEffect(id, k, on)}
              />
            </div>
          ))}
          <button type="button" className={styles.propsLink} onClick={() => api.openLayerStyle(id)}>
            {hasEnabledFx(node.effects) || fxKeys.length ? "Edit layer style…" : "Add layer style…"}
          </button>
        </section>
      )}

      {/* Smart filters */}
      {!isAdjustment && (
        <section className={styles.propsSection}>
          <span className={styles.propsLabel}>
            <Wand2 size={11} /> Smart filters
          </span>
          {filters.length === 0 && <span className={styles.propsHint}>No smart filters.</span>}
          {filters.map((f) => (
            <div key={f.id} className={styles.propsRow}>
              <Toggle label={filterLabel(f)} checked={f.enabled} onChange={(on) => setFilterEnabled(f, on)} />
            </div>
          ))}
          <button type="button" className={styles.propsLink} onClick={() => api.openFilters(id)}>
            {filters.length ? "Edit smart filters…" : "Add smart filters…"}
          </button>
        </section>
      )}

      {/* Adjustment layers: link into their editor */}
      {isAdjustment && (
        <section className={styles.propsSection}>
          <span className={styles.propsLabel}>
            <SlidersHorizontal size={11} /> Adjustment
          </span>
          <span className={styles.propsHint}>
            {adjustmentLabel(node.adjustment)} — re-editable, affects everything below
            {node.clipped ? " (clipped to the layer beneath)" : ""}.
          </span>
          <button type="button" className={styles.propsLink} onClick={() => api.editAdjustment(id)}>
            Edit adjustment…
          </button>
        </section>
      )}
    </div>
  );
}
