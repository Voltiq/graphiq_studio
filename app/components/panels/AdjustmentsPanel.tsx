"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Check, Download, FolderInput, Layers, Plus, RotateCcw, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";
import { Slider } from "../Controls";
import FilterExportDialog from "../FilterExportDialog";
import styles from "../RightDock.module.scss";
import {
  FILTERS,
  adjustToThumbFilter,
  isDefaultAdjust,
  parsePresetFileText,
  type AdjustPreset,
  type Adjustments,
  type ParsedPreset,
} from "../../lib/adjust";

const PRESETS_KEY = "graphiq:adjust-presets";
const LEGACY_PRESETS_KEY = "aperture:adjust-presets"; // pre-rebrand fallback

/** Read saved custom presets (empty list on first run / parse failure). */
function loadPresets(): AdjustPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY) ?? window.localStorage.getItem(LEGACY_PRESETS_KEY);
    const list = raw ? (JSON.parse(raw) as AdjustPreset[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export default function AdjustmentsPanel({
  adjust,
  onChange,
  filter,
  onFilter,
  onReset,
  active,
  onApplyPreset,
  editing = false,
  editName,
  onCreate,
  onDelete,
  onAddCurves,
  onAddLevels,
}: {
  adjust: Adjustments;
  onChange: (patch: Partial<Adjustments>) => void;
  filter: string;
  onFilter: (name: string) => void;
  onReset: () => void;
  active: boolean;
  /** Apply a full set of adjustment values under a label (built-in or custom). */
  onApplyPreset: (adjust: Adjustments, name: string) => void;
  /** True when bound to an adjustment-layer node (live, no Apply; offers Delete). */
  editing?: boolean;
  editName?: string;
  /** Apply-mode: convert the current preview into a non-destructive adjustment layer. */
  onCreate?: () => void;
  /** Edit-mode: delete the bound adjustment layer. */
  onDelete?: () => void;
  /** Create a Curves / Levels adjustment layer (opens its editor). */
  onAddCurves?: () => void;
  onAddLevels?: () => void;
}) {
  const dirty = !isDefaultAdjust(adjust);
  const [presets, setPresets] = useState<AdjustPreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [exporting, setExporting] = useState(false);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Load after mount (avoids an SSR/hydration mismatch); custom presets are global.
  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  const persist = (list: AdjustPreset[]) => {
    setPresets(list);
    try {
      window.localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
    } catch {
      /* ignore (private mode / quota) */
    }
  };

  const genId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // Append imported presets (giving each a unique name + id) and persist them.
  const mergeImported = (parsed: ParsedPreset[]) => {
    if (!parsed.length) return;
    const taken = new Set(presets.map((p) => p.name.toLowerCase()));
    const uniqueName = (base: string) => {
      let n = base;
      let i = 2;
      while (taken.has(n.toLowerCase())) n = `${base} ${i++}`;
      taken.add(n.toLowerCase());
      return n;
    };
    const added = parsed.map((pp) => ({ id: genId(), name: uniqueName(pp.name), adjust: pp.adjust }));
    persist([...presets, ...added]);
  };

  // Read .gifp / .gifpack files (from a multi-select or a picked folder) → presets.
  const importFromFiles = async (files: File[]) => {
    const valid = files.filter((f) => /\.(gifp|gifpack|aifp|aifpack|json)$/i.test(f.name));
    if (!valid.length) return;
    const parsed: ParsedPreset[] = [];
    for (const f of valid) {
      try {
        parsed.push(...parsePresetFileText(await f.text()));
      } catch {
        /* skip unreadable files */
      }
    }
    if (parsed.length) mergeImported(parsed);
    else window.alert("No valid filter presets were found in the selection.");
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same selection be picked again later
    importFromFiles(files);
  };

  const closeForm = () => {
    setSaving(false);
    setName("");
  };

  const confirmSave = () => {
    const n = name.trim();
    if (!n) return;
    const preset: AdjustPreset = {
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: n,
      adjust,
    };
    persist([...presets, preset]);
    closeForm();
    onApplyPreset(adjust, n); // keep the freshly-saved preset selected
  };

  const deletePreset = (id: string) => persist(presets.filter((p) => p.id !== id));

  return (
    <div className={styles.adjustments}>
      <div className={styles.presetsBlock}>
        <div className={styles.presetsHeader}>
          <span className={styles.groupLabel}>Presets</span>
          <div className={styles.presetActions}>
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => filesInputRef.current?.click()}
              title="Import filter file(s)…"
            >
              <Upload size={14} />
            </button>
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => folderInputRef.current?.click()}
              title="Import a folder of filters…"
            >
              <FolderInput size={14} />
            </button>
            <button
              type="button"
              className={styles.headBtn}
              disabled={!presets.length}
              onClick={() => setExporting(true)}
              title={presets.length ? "Export filters…" : "No custom filters to export"}
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className={styles.savePresetBtn}
              disabled={!dirty}
              onClick={() => (saving ? closeForm() : setSaving(true))}
              title={dirty ? "Save current adjustments as a preset" : "Adjust something to save a preset"}
            >
              <Plus size={13} />
              Save
            </button>
          </div>
        </div>

        {saving && (
          <div className={styles.savePresetForm}>
            <input
              className={styles.savePresetInput}
              autoFocus
              value={name}
              maxLength={24}
              placeholder="Preset name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
                else if (e.key === "Escape") closeForm();
              }}
            />
            <button
              type="button"
              className={styles.savePresetConfirm}
              disabled={!name.trim()}
              onClick={confirmSave}
              aria-label="Save preset"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              className={styles.savePresetCancel}
              onClick={closeForm}
              aria-label="Cancel"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className={styles.filterStrip}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={styles.filterChip}
              data-active={filter === f}
              onClick={() => onFilter(f)}
            >
              <span className={styles.filterThumb} data-filter={f.toLowerCase()} />
              <span>{f}</span>
            </button>
          ))}
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.filterChip}
              data-active={filter === p.name}
              onClick={() => onApplyPreset(p.adjust, p.name)}
            >
              <span className={styles.thumbWrap}>
                <span className={styles.filterThumb} style={{ filter: adjustToThumbFilter(p.adjust) }} />
                <span
                  className={styles.presetDelete}
                  role="button"
                  aria-label={`Delete ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deletePreset(p.id);
                  }}
                >
                  <X size={11} />
                </span>
              </span>
              <span title={p.name}>{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {editing ? (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11.5,
            color: "var(--accent)",
            margin: "2px 0",
          }}
        >
          <SlidersHorizontal size={13} />
          Editing <strong>{editName ?? "Adjustment"}</strong> — changes are live (no Apply).
        </p>
      ) : !active ? (
        <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0" }}>
          Select a pixel layer to adjust, or create an adjustment layer below.
        </p>
      ) : null}

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Light</span>
        <Slider label="Exposure" min={-100} max={100} bipolar value={adjust.exposure} onChange={(v) => onChange({ exposure: v })} />
        <Slider label="Contrast" min={-100} max={100} bipolar value={adjust.contrast} onChange={(v) => onChange({ contrast: v })} />
        <Slider label="Highlights" min={-100} max={100} bipolar value={adjust.highlights} onChange={(v) => onChange({ highlights: v })} />
        <Slider label="Shadows" min={-100} max={100} bipolar value={adjust.shadows} onChange={(v) => onChange({ shadows: v })} />
        <Slider label="Whites" min={-100} max={100} bipolar value={adjust.whites} onChange={(v) => onChange({ whites: v })} />
        <Slider label="Blacks" min={-100} max={100} bipolar value={adjust.blacks} onChange={(v) => onChange({ blacks: v })} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Color</span>
        <Slider label="Temperature" min={-100} max={100} bipolar value={adjust.temperature} onChange={(v) => onChange({ temperature: v })} />
        <Slider label="Tint" min={-100} max={100} bipolar value={adjust.tint} onChange={(v) => onChange({ tint: v })} />
        <Slider label="Vibrance" min={-100} max={100} bipolar value={adjust.vibrance} onChange={(v) => onChange({ vibrance: v })} />
        <Slider label="Saturation" min={-100} max={100} bipolar value={adjust.saturation} onChange={(v) => onChange({ saturation: v })} />
      </div>

      <div className={styles.adjGroup}>
        <span className={styles.groupLabel}>Detail</span>
        <Slider label="Sharpen" min={0} max={100} value={adjust.sharpen} onChange={(v) => onChange({ sharpen: v })} />
        <Slider label="Clarity" min={-100} max={100} bipolar value={adjust.clarity} onChange={(v) => onChange({ clarity: v })} />
        <Slider label="Noise reduction" min={0} max={100} value={adjust.noise} onChange={(v) => onChange({ noise: v })} />
      </div>

      <button
        type="button"
        className={styles.resetAdjust}
        disabled={!dirty}
        onClick={onReset}
      >
        <RotateCcw size={14} />
        {editing ? "Reset this layer" : "Reset adjustments"}
      </button>

      {editing ? (
        <button type="button" className={styles.resetAdjust} onClick={onDelete}>
          <Trash2 size={14} />
          Delete Adjustment Layer
        </button>
      ) : (
        <>
          <button
            type="button"
            className={styles.resetAdjust}
            disabled={!dirty || !active}
            onClick={onCreate}
            title={
              active
                ? "Add these adjustments as a non-destructive layer"
                : "Select a layer first"
            }
          >
            <Layers size={14} />
            Create Adjustment Layer
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className={styles.resetAdjust} style={{ flex: 1 }} onClick={onAddCurves}>
              <SlidersHorizontal size={14} /> Curves
            </button>
            <button type="button" className={styles.resetAdjust} style={{ flex: 1 }} onClick={onAddLevels}>
              <SlidersHorizontal size={14} /> Levels
            </button>
          </div>
        </>
      )}

      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".gifp,.gifpack,.aifp,.aifpack,.json,application/json"
        hidden
        onChange={onInputChange}
      />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          // webkitdirectory isn't a typed React prop — set it imperatively.
          if (el) el.setAttribute("webkitdirectory", "");
        }}
        type="file"
        hidden
        onChange={onInputChange}
      />

      {exporting && <FilterExportDialog presets={presets} onClose={() => setExporting(false)} />}
    </div>
  );
}
