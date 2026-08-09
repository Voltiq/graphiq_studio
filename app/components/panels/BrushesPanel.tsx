"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, Plus, Trash2, Upload } from "lucide-react";
import styles from "../RightDock.module.scss";
import { downloadBlob } from "../../lib/project";
import {
  BUILTIN_BRUSHES,
  exportBrushes,
  freshBrushId,
  getBrushPresets,
  mergeBrushes,
  parseBrushImport,
  presetSummary,
  setBrushPresets,
  subscribeBrushPresets,
  tipProfile,
  type BrushPreset,
  type BrushPresetTool,
} from "../../lib/brushes";
import type { BrushSettings } from "../../lib/paint";

/** Canvas thumbnail of a brush tip: the preset's own radial falloff, scaled so
 *  small and huge brushes both read at a glance (the label carries the real px). */
function TipThumb({ preset, color }: { preset: BrushPreset; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const css = 34;
    if (cv.width !== Math.round(css * dpr)) {
      cv.width = Math.round(css * dpr);
      cv.height = Math.round(css * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    const s = preset.settings;
    // Map 1–200px onto the thumb radius on a curve, so tiny tips stay visible.
    const t = Math.min(1, Math.sqrt(Math.min(s.size, 200) / 200));
    const rad = Math.max(1.6, t * (css / 2 - 2));
    const at = tipProfile(s.hardness);
    const img = ctx.createImageData(Math.round(css * dpr), Math.round(css * dpr));
    const d = img.data;
    const n = img.width;
    // Parse the paint colour once (#rrggbb / #rrggbbaa).
    const hex = color.replace("#", "");
    const cr = parseInt(hex.slice(0, 2) || "60", 16) || 0;
    const cg = parseInt(hex.slice(2, 4) || "60", 16) || 0;
    const cb = parseInt(hex.slice(4, 6) || "f1", 16) || 0;
    const cx = n / 2;
    const alpha = (s.opacity / 100) * (preset.tool === "eraser" ? 0.55 : 1);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5 - cx) / dpr;
        const dy = (y + 0.5 - cx) / dpr;
        const r = Math.hypot(dx, dy) / rad;
        const a = r > 1 ? 0 : at(r) * alpha;
        if (a <= 0) continue;
        const i = (y * n + x) * 4;
        d[i] = cr;
        d[i + 1] = cg;
        d[i + 2] = cb;
        d[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [preset, color]);
  return <canvas ref={ref} className={styles.brushThumb} aria-hidden />;
}

/**
 * Brushes panel: shipped + saved brush presets with live tip previews. Click a
 * row to apply it to the active paint tool; save the current settings as a new
 * preset, rename (double-click) or delete your own, and import/export them as
 * `.gbr` JSON. Built-ins are always present and can't be edited or removed.
 */
export default function BrushesPanel({
  brush,
  onBrush,
  tool,
  foreground,
}: {
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  /** The active tool — a new preset records it, and it drives the row hint. */
  tool: string;
  foreground: string;
}) {
  const [user, setUser] = useState<BrushPreset[]>(() => getBrushPresets());
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Stay in step with the options-bar picker (shared store).
  useEffect(() => subscribeBrushPresets(setUser), []);
  const commit = (next: BrushPreset[]) => setBrushPresets(next);

  const presets = [...BUILTIN_BRUSHES, ...user];
  const presetTool: BrushPresetTool =
    tool === "eraser" ? "eraser" : tool === "pencil" ? "pencil" : "brush";

  const apply = (p: BrushPreset) => {
    onBrush({ ...p.settings });
    setAppliedId(p.id);
  };
  const saveCurrent = () => {
    const base = presetTool === "eraser" ? "Eraser" : presetTool === "pencil" ? "Pencil" : "Brush";
    const n = user.length + 1;
    const p: BrushPreset = {
      id: freshBrushId(),
      name: `${base} ${n}`,
      tool: presetTool,
      settings: { ...brush },
    };
    commit([...user, p]);
    setRenamingId(p.id); // let the name be typed straight away
    setDraft(p.name);
  };
  const remove = (id: string) => commit(user.filter((p) => p.id !== id));
  const finishRename = () => {
    if (!renamingId) return;
    const name = draft.trim();
    if (name) commit(user.map((p) => (p.id === renamingId ? { ...p, name: name.slice(0, 60) } : p)));
    setRenamingId(null);
  };

  const doExport = () => {
    if (!user.length) return;
    downloadBlob(new Blob([exportBrushes(user)], { type: "application/json" }), "brushes.gbr");
  };
  const doImport = async (files: FileList | null) => {
    if (!files?.length) return;
    let incoming: BrushPreset[] = [];
    for (const f of Array.from(files)) {
      try {
        incoming = incoming.concat(parseBrushImport(await f.text()));
      } catch {
        /* skip unreadable files */
      }
    }
    if (incoming.length) commit(mergeBrushes(user, incoming));
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className={styles.brushes}>
      <ul className={styles.brushList}>
        {presets.map((p) => (
          <li
            key={p.id}
            className={styles.brushItem}
            data-active={p.id === appliedId || undefined}
            onClick={() => apply(p)}
            title={`Apply “${p.name}” — ${presetSummary(p.settings)}`}
          >
            <TipThumb preset={p} color={foreground} />
            <div className={styles.brushMeta}>
              {renamingId === p.id ? (
                <input
                  className={styles.brushRename}
                  autoFocus
                  value={draft}
                  // Select the whole placeholder ("Brush 1") so typing REPLACES
                  // it — otherwise the caret lands at the end and the new name
                  // gets appended to the generated one.
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={finishRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") finishRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <span
                  className={styles.brushName}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (p.builtin) return; // shipped presets aren't renamable
                    setRenamingId(p.id);
                    setDraft(p.name);
                  }}
                >
                  {p.name}
                </span>
              )}
              <span className={styles.brushSub}>{presetSummary(p.settings)}</span>
            </div>
            {p.id === appliedId && <Check size={13} className={styles.brushCheck} />}
            {!p.builtin && (
              <button
                type="button"
                className={styles.brushDel}
                title="Delete preset"
                aria-label={`Delete ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(p.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className={styles.brushFooter}>
        <button type="button" className={styles.presetBtn} onClick={saveCurrent} title="Save the current brush settings as a preset">
          <Plus size={14} /> New preset
        </button>
        <span className={styles.footerSpacer} />
        <button
          type="button"
          className={styles.iconOnly}
          onClick={() => fileRef.current?.click()}
          title="Import presets (.gbr / .json)"
          aria-label="Import brush presets"
        >
          <Upload size={14} />
        </button>
        <button
          type="button"
          className={styles.iconOnly}
          onClick={doExport}
          disabled={!user.length}
          title={user.length ? "Export your presets (.gbr)" : "No saved presets to export"}
          aria-label="Export brush presets"
        >
          <Download size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gbr,.json"
          multiple
          hidden
          onChange={(e) => doImport(e.target.files)}
        />
      </div>
    </div>
  );
}
