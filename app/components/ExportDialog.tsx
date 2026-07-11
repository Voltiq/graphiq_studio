"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { ColorChip, Segmented, Slider, Toggle } from "./Controls";
import { availableFormats, renderExport, type ExportFormat, type ExportOptions } from "../lib/imageio";
import {
  BUILTIN_EXPORT_PRESETS,
  TEMPLATE_TOKENS,
  defaultBatchTargets,
  freshPresetId,
  freshTargetId,
  loadExportPresets,
  saveExportPresets,
  targetFilename,
  type BatchTarget,
  type ExportPreset,
} from "../lib/exportpresets";

/** Bytes → a short human size ("820 KB", "1.4 MB"). */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export interface BatchRun {
  targets: BatchTarget[];
  template: string;
}

export default function ExportDialog({
  composite,
  defaultName,
  onExport,
  onBatchExport,
  onClose,
}: {
  composite: HTMLCanvasElement;
  defaultName: string;
  onExport: (opts: ExportOptions, filename: string) => void;
  onBatchExport: (run: BatchRun, docName: string) => Promise<void>;
  onClose: () => void;
}) {
  const [formats] = useState(() => availableFormats());
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [format, setFormat] = useState<ExportFormat>(formats[0]);
  const [quality, setQuality] = useState(92);
  const [transparent, setTransparent] = useState(true);
  const [matte, setMatte] = useState("#ffffffff");
  const [scalePct, setScalePct] = useState(100);
  const [name, setName] = useState(defaultName);
  const previewRef = useRef<HTMLCanvasElement>(null);

  // Presets: shipped ones first, then the user's (persisted).
  const [userPresets, setUserPresets] = useState<ExportPreset[]>([]);
  useEffect(() => setUserPresets(loadExportPresets()), []);
  const allPresets = useMemo(() => [...BUILTIN_EXPORT_PRESETS, ...userPresets], [userPresets]);

  // Batch state.
  const [targets, setTargets] = useState<BatchTarget[]>(() => defaultBatchTargets());
  const [template, setTemplate] = useState("{name}");

  const formatById = (id: string) => formats.find((f) => f.id === id) ?? formats[0];

  const effTransparent = transparent && format.alpha;
  const outW = Math.max(1, Math.round(composite.width * (scalePct / 100)));
  const outH = Math.max(1, Math.round(composite.height * (scalePct / 100)));

  const opts = (): ExportOptions => ({
    format,
    quality: quality / 100,
    scale: scalePct / 100,
    transparent,
    matte,
  });

  // Live (exact) file-size estimate: actually encode the composite with the
  // current options, debounced so slider drags don't thrash the encoder.
  const [estSize, setEstSize] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  useEffect(() => {
    if (mode !== "single") return;
    let cancelled = false;
    setEstimating(true);
    const id = window.setTimeout(async () => {
      const blob = await renderExport(composite, {
        format,
        quality: quality / 100,
        scale: scalePct / 100,
        transparent,
        matte,
      });
      if (cancelled) return;
      setEstSize(blob ? blob.size : null);
      setEstimating(false);
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [composite, format, quality, scalePct, transparent, matte, mode]);

  const applyPreset = (p: ExportPreset) => {
    setFormat(formatById(p.formatId));
    setQuality(p.quality);
    setScalePct(p.scalePct);
    setTransparent(p.transparent);
    setMatte(p.matte);
  };
  const savePreset = () => {
    const label = window.prompt("Preset name", `${format.label} ${scalePct}%`);
    if (!label?.trim()) return;
    const preset: ExportPreset = {
      id: freshPresetId(),
      name: label.trim(),
      formatId: format.id,
      quality,
      scalePct,
      transparent,
      matte,
    };
    const next = [...userPresets, preset];
    setUserPresets(next);
    saveExportPresets(next);
  };
  const deletePreset = (id: string) => {
    const next = userPresets.filter((p) => p.id !== id);
    setUserPresets(next);
    saveExportPresets(next);
  };

  // Draw a checker-backed preview of the composite.
  useEffect(() => {
    const c = previewRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const scale = Math.min(c.width / composite.width, c.height / composite.height, 1);
    const w = composite.width * scale;
    const h = composite.height * scale;
    ctx.clearRect(0, 0, c.width, c.height);
    const x = (c.width - w) / 2;
    const y = (c.height - h) / 2;
    if (!effTransparent) {
      ctx.fillStyle = matte;
      ctx.fillRect(x, y, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(composite, x, y, w, h);
  }, [composite, effTransparent, matte]);

  const field: React.CSSProperties = {
    width: "100%",
    height: 34,
    padding: "0 10px",
    fontSize: 13,
    color: "var(--text)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    outline: "none",
  };

  // Batch filename previews (deduped for display).
  const batchNames = useMemo(() => {
    const raw = targets.map((t, i) =>
      targetFilename(t, template, name || defaultName, composite.width, composite.height, i + 1, formatById(t.formatId).ext),
    );
    // Simple in-view de-dup so the preview matches the actual run.
    const seen = new Map<string, number>();
    return raw.map((full) => {
      const dot = full.lastIndexOf(".");
      const b = dot > 0 ? full.slice(0, dot) : full;
      const e = dot > 0 ? full.slice(dot) : "";
      const k = full.toLowerCase();
      const c = seen.get(k) ?? 0;
      seen.set(k, c + 1);
      return c === 0 ? full : `${b}-${c + 1}${e}`;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, template, name, composite.width, composite.height]);

  const [running, setRunning] = useState(false);
  const runBatch = async () => {
    if (!targets.length || running) return;
    setRunning(true);
    try {
      await onBatchExport({ targets, template }, name || defaultName);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Export image"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && mode === "single") onExport(opts(), name);
        }}
      >
        <header className={styles.head}>
          <h2>Export as</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewRow}>
            <canvas ref={previewRef} width={132} height={96} className={styles.preview} />
            <div className={styles.meta}>
              <div className={styles.dim}>
                {outW} × {outH} px
              </div>
              <div className={styles.sub}>
                {format.label} · 8-bit / channel
                {mode === "single" && (
                  <> · {estimating ? "estimating…" : estSize != null ? `~ ${fmtSize(estSize)}` : "—"}</>
                )}
              </div>
            </div>
          </div>

          <Segmented
            value={mode}
            onChange={(v) => setMode(v as "single" | "batch")}
            options={[
              { value: "single", text: "Single" },
              { value: "batch", text: "Batch" },
            ]}
          />

          {mode === "single" ? (
            <>
              <span className={styles.groupLabel}>Preset</span>
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                <select
                  style={{ ...field, padding: "0 8px", flex: 1 }}
                  value=""
                  onChange={(e) => {
                    const p = allPresets.find((x) => x.id === e.target.value);
                    if (p) applyPreset(p);
                  }}
                  aria-label="Apply export preset"
                >
                  <option value="">Apply a preset…</option>
                  {BUILTIN_EXPORT_PRESETS.length > 0 && (
                    <optgroup label="Built-in">
                      {BUILTIN_EXPORT_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {userPresets.length > 0 && (
                    <optgroup label="My presets">
                      {userPresets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button type="button" className={styles.btn} onClick={savePreset}>
                  Save current
                </button>
              </div>
              {userPresets.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {userPresets.map((p) => (
                    <span key={p.id} className={styles.note} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {p.name}
                      <button
                        type="button"
                        onClick={() => deletePreset(p.id)}
                        title={`Delete “${p.name}”`}
                        aria-label={`Delete preset ${p.name}`}
                        style={{ display: "inline-flex", border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", padding: 0 }}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <span className={styles.groupLabel}>Format</span>
              <select
                style={{ ...field, padding: "0 8px" }}
                value={format.id}
                onChange={(e) => setFormat(formatById(e.target.value))}
                aria-label="Format"
              >
                {formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} (.{f.ext})
                  </option>
                ))}
              </select>

              {format.lossy && <Slider label="Quality" unit="%" value={quality} onChange={setQuality} />}

              <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
                {format.alpha && <Toggle label="Transparent" checked={transparent} onChange={setTransparent} />}
                {!effTransparent && <ColorChip color={matte} onChange={setMatte} label="Background" />}
              </div>

              <span className={styles.groupLabel}>Scale</span>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={scalePct}
                  onChange={(e) => setScalePct(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))}
                  style={{ ...field, width: 90 }}
                  aria-label="Scale percent"
                />
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>%</span>
              </div>

              <span className={styles.groupLabel}>File name</span>
              <input
                style={field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.target.select()}
                aria-label="File name"
              />
            </>
          ) : (
            <>
              <span className={styles.groupLabel}>File name template</span>
              <input
                style={field}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                aria-label="Filename template"
              />
              <p className={styles.note}>Tokens: {TEMPLATE_TOKENS.join("  ")} (name, width, height, scale %, extension, index).</p>

              <span className={styles.groupLabel}>Targets</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {targets.map((t) => {
                  const tf = formatById(t.formatId);
                  const patch = (p: Partial<BatchTarget>) =>
                    setTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...p } : x)));
                  return (
                    <div key={t.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        style={{ ...field, width: 96, padding: "0 6px" }}
                        value={t.formatId}
                        onChange={(e) => patch({ formatId: e.target.value })}
                        aria-label="Target format"
                      >
                        {formats.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <span style={{ fontSize: 12, color: "var(--text-3)" }}>@</span>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={t.scalePct}
                        onChange={(e) => patch({ scalePct: Math.max(1, Math.min(1000, Number(e.target.value) || 100)) })}
                        style={{ ...field, width: 68 }}
                        aria-label="Target scale percent"
                      />
                      <span style={{ fontSize: 12, color: "var(--text-3)" }}>%</span>
                      {tf.lossy && (
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={t.quality}
                          onChange={(e) => patch({ quality: Math.max(1, Math.min(100, Number(e.target.value) || 85)) })}
                          style={{ ...field, width: 60 }}
                          title="Quality %"
                          aria-label="Target quality percent"
                        />
                      )}
                      <input
                        style={{ ...field, flex: 1, minWidth: 60 }}
                        value={t.suffix}
                        placeholder="suffix"
                        onChange={(e) => patch({ suffix: e.target.value })}
                        aria-label="Target filename suffix"
                      />
                      <button
                        type="button"
                        className={styles.close}
                        onClick={() => setTargets((ts) => (ts.length > 1 ? ts.filter((x) => x.id !== t.id) : ts))}
                        aria-label="Remove target"
                        title="Remove target"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className={styles.btn}
                style={{ alignSelf: "flex-start" }}
                onClick={() =>
                  setTargets((ts) => [...ts, { id: freshTargetId(), formatId: format.id, quality, scalePct: 100, suffix: "" }])
                }
              >
                <Plus size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                Add target
              </button>

              <span className={styles.groupLabel}>Output ({targets.length} file{targets.length === 1 ? "" : "s"} → .zip)</span>
              <div className={styles.note} style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 96, overflowY: "auto" }}>
                {batchNames.map((n, i) => (
                  <span key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    {n}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          {mode === "single" ? (
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => onExport(opts(), name)}>
              Export
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              disabled={running || !targets.length}
              onClick={runBatch}
            >
              {running ? "Exporting…" : `Export ${targets.length} → .zip`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
