"use client";

import { useRef, useState } from "react";
import { FilePlus2, Play, Square, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Select } from "./Controls";
import { availableFormats, renderExport, IMPORT_ACCEPT } from "../lib/imageio";
import {
  BUILTIN_EXPORT_PRESETS,
  dedupeFilenames,
  loadExportPresets,
  sanitizeFilename,
  type ExportPreset,
} from "../lib/exportpresets";
import { buildZip, type ZipEntry } from "../lib/zip";
import { saveExportBlob } from "../lib/share";
import { formatBytes } from "../lib/metadata";
import type { SavedAction } from "../lib/actions";

const NO_ACTION = "None — export only";

/**
 * Batch processing (TODO §14): run a saved Action and/or an export preset over
 * a set of files. Each file opens as a TEMPORARY document (the Editor-provided
 * runner replays the action on it and returns the flattened composite), gets
 * encoded with the chosen preset, and everything downloads as one zip (or a
 * single file when there's only one). Files process strictly one at a time —
 * actions replay through the live app, exactly as if you did it by hand.
 */
export default function BatchDialog({
  actions,
  runFile,
  onClose,
}: {
  actions: SavedAction[];
  /** Open `file`, optionally replay the action, return the composite (null = failed). */
  runFile: (file: File, actionId: string | null) => Promise<HTMLCanvasElement | null>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [actionLabel, setActionLabel] = useState<string>(NO_ACTION);
  const [presets] = useState<ExportPreset[]>(() => [...BUILTIN_EXPORT_PRESETS, ...loadExportPresets()]);
  const [presetName, setPresetName] = useState<string>(BUILTIN_EXPORT_PRESETS[1].name);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [report, setReport] = useState<{ ok: number; errors: string[] } | null>(null);
  const cancelRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const runnable = actions.filter((a) => a.steps.length > 0);
  const preset = presets.find((p) => p.name === presetName) ?? BUILTIN_EXPORT_PRESETS[0];

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const add = Array.from(list).filter((f) => !/\.(gproj|aproj)$/i.test(f.name));
    if (add.length) setFiles((cur) => [...cur, ...add]);
  };

  const doRun = async () => {
    if (busy || !files.length) return;
    setBusy(true);
    setReport(null);
    cancelRef.current = false;
    const actionId = runnable.find((a) => a.name === actionLabel)?.id ?? null;
    const fmt =
      availableFormats().find((f) => f.id === preset.formatId) ?? availableFormats()[0];
    const errors: string[] = [];
    const blobs: { stem: string; data: Uint8Array<ArrayBuffer> }[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        if (cancelRef.current) break;
        setProgress({ done: i, total: files.length, current: files[i].name });
        try {
          const canvas = await runFile(files[i], actionId);
          const blob = canvas
            ? await renderExport(canvas, {
                format: fmt,
                quality: preset.quality / 100,
                scale: preset.scalePct / 100,
                transparent: preset.transparent,
                matte: preset.matte,
              })
            : null;
          if (!blob) {
            errors.push(files[i].name);
            continue;
          }
          blobs.push({
            stem: sanitizeFilename(files[i].name.replace(/\.[^.]+$/, "")) || "image",
            data: new Uint8Array(await blob.arrayBuffer()) as Uint8Array<ArrayBuffer>,
          });
        } catch {
          errors.push(files[i].name);
        }
      }
      const names = dedupeFilenames(blobs.map((b) => `${b.stem}.${fmt.ext}`));
      if (blobs.length === 1) {
        void saveExportBlob(new Blob([blobs[0].data], { type: fmt.mime }), names[0]);
      } else if (blobs.length) {
        const entries: ZipEntry[] = blobs.map((b, i) => ({ name: names[i], data: b.data }));
        void saveExportBlob(buildZip(entries), `batch-${new Date().toISOString().slice(0, 10)}.zip`);
      }
      setReport({ ok: blobs.length, errors });
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={busy ? undefined : onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Batch process"
        style={{ width: 480 }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) addFiles(e.dataTransfer.files);
        }}
      >
        <header className={styles.head}>
          <h2>Batch process</h2>
          <button type="button" className={styles.close} onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Files</span>
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>
                {f.name}
              </span>
              <span className={styles.note} style={{ margin: 0 }}>
                {formatBytes(f.size)}
              </span>
              <button
                type="button"
                className={styles.close}
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.btn}
            style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6 }}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <FilePlus2 size={14} /> Add files… <span className={styles.note} style={{ margin: 0 }}>(or drop them here)</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMPORT_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <span className={styles.groupLabel}>Run action</span>
          <Select
            block
            options={[NO_ACTION, ...runnable.map((a) => a.name)]}
            value={actionLabel}
            onChange={setActionLabel}
          />

          <span className={styles.groupLabel}>Export preset</span>
          <Select block options={presets.map((p) => p.name)} value={presetName} onChange={setPresetName} />

          <p className={styles.note}>
            Each file opens as a temporary document, the action replays on it live (menu
            commands and recorded brush strokes alike), and the flattened result encodes
            with the preset — one zip download (a single file downloads directly).
            Expect the canvas to flick through the files while it runs.
          </p>

          {progress && (
            <p className={styles.note} role="status">
              Processing {progress.done + 1} of {progress.total}: {progress.current}…
            </p>
          )}
          {report && (
            <p className={styles.note} role="status">
              Done — {report.ok} file{report.ok === 1 ? "" : "s"} exported
              {report.errors.length ? `; failed: ${report.errors.join(", ")}` : "."}
            </p>
          )}
        </div>

        <footer className={styles.foot}>
          {busy ? (
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                cancelRef.current = true;
              }}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Square size={12} /> Stop after this file
            </button>
          ) : (
            <button type="button" className={styles.btn} onClick={onClose}>
              Close
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={busy || !files.length}
            onClick={() => void doRun()}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Play size={13} /> {busy ? "Running…" : `Run ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
