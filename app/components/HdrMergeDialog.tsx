"use client";

import { useEffect, useRef, useState } from "react";
import { FilePlus2, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import prefStyles from "./PreferencesDialog.module.scss";
import { Segmented, Slider } from "./Controls";
import {
  downscaleHdr,
  evFromMetadata,
  meanLuma,
  mergeToHdr,
  suggestEvs,
  tonemap,
  type HdrImage,
  type TonemapMethod,
} from "../lib/hdr";
import { extractMetadata } from "../lib/metadata";

interface Frame {
  name: string;
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  ev: number;
  evFromExif: boolean;
}

const PREVIEW_W = 440;

const METHODS: { value: TonemapMethod; text: string; title: string }[] = [
  { value: "filmic", text: "Filmic", title: "Hable curve — cinematic rolloff into highlights" },
  { value: "reinhard", text: "Reinhard", title: "Luminance compression — neutral, colour-preserving" },
  { value: "linear", text: "Linear", title: "Straight clip — keeps mid-tones exact, blows highlights" },
];

/**
 * Merge to HDR (mode "merge"): load 2+ bracketed exposures of the same scene
 * (same pixel size; tripod-aligned — there is no auto-alignment), assign EVs
 * (auto from EXIF when every frame has capture data, else brightness-ranked),
 * merge into a Float32 radiance map, then tone-map with a live preview into a
 * new document that keeps the float source for later re-tone-mapping/export.
 *
 * HDR tone mapping (mode "retone"): the tone stage alone, re-rendering the
 * ACTIVE layer from the document's kept float source — repeated tone edits
 * re-derive from float, so they never accumulate 8-bit loss.
 */
export default function HdrMergeDialog({
  mode,
  hdr,
  docName,
  onCreate,
  onApply,
  onClose,
}: {
  mode: "merge" | "retone";
  /** retone: the document's float radiance source. */
  hdr?: HdrImage;
  docName?: string;
  onCreate?: (r: { name: string; canvas: HTMLCanvasElement; hdr: HdrImage }) => void;
  onApply?: (canvas: HTMLCanvasElement) => void;
  onClose: () => void;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [decoding, setDecoding] = useState(false);
  const [merged, setMerged] = useState<HdrImage | null>(mode === "retone" ? (hdr ?? null) : null);
  const [preview, setPreview] = useState<HdrImage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exposure, setExposure] = useState(0);
  const [method, setMethod] = useState<TonemapMethod>("filmic");
  const evsTouched = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Downscale once per merged map; tone-map the small copy on every tweak.
  useEffect(() => {
    setPreview(merged ? downscaleHdr(merged, PREVIEW_W) : null);
  }, [merged]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !preview) return;
    cv.width = preview.w;
    cv.height = preview.h;
    const bytes = tonemap(preview, { exposure, method });
    cv.getContext("2d")?.putImageData(new ImageData(bytes, preview.w, preview.h), 0, 0);
  }, [preview, exposure, method]);

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setDecoding(true);
    try {
      const added: { frame: Frame; metaEv: number | null }[] = [];
      for (const file of Array.from(list)) {
        try {
          const bmp = await createImageBitmap(file);
          const c = document.createElement("canvas");
          c.width = bmp.width;
          c.height = bmp.height;
          const ctx = c.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(bmp, 0, 0);
          const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          bmp.close();
          const meta = await extractMetadata(file);
          const metaEv = evFromMetadata(meta);
          added.push({
            frame: { name: file.name, w: c.width, h: c.height, rgba, ev: 0, evFromExif: metaEv !== null },
            metaEv,
          });
        } catch {
          /* undecodable file — skip */
        }
      }
      setFrames((prev) => {
        const all = [...prev, ...added.map((a) => a.frame)];
        if (evsTouched.current) return all;
        // Re-suggest across the whole list. EXIF EVs only apply when every
        // frame in the list carries one (they were added together) — mixed
        // lists fall back to brightness ranking inside suggestEvs.
        const metaEvs = [...prev.map(() => null), ...added.map((a) => a.metaEv)];
        const evs = suggestEvs(
          metaEvs,
          all.map((f) => meanLuma(f.rgba)),
        );
        return all.map((f, i) => ({ ...f, ev: evs[i] }));
      });
    } finally {
      setDecoding(false);
    }
  };

  const base = frames[0];
  const mismatched = frames.filter((f) => base && (f.w !== base.w || f.h !== base.h));
  const canMerge = frames.length >= 2 && mismatched.length === 0 && !decoding && !busy;

  const runMerge = () => {
    if (!canMerge) return;
    setBusy("Merging…");
    // Let the busy label paint before the synchronous float crunch.
    window.setTimeout(() => {
      setMerged(mergeToHdr(frames.map((f) => ({ rgba: f.rgba, ev: f.ev })), base.w, base.h));
      setBusy(null);
    }, 30);
  };

  const finish = () => {
    if (!merged || busy) return;
    setBusy(mode === "merge" ? "Rendering…" : "Applying…");
    window.setTimeout(() => {
      const bytes = tonemap(merged, { exposure, method });
      const c = document.createElement("canvas");
      c.width = merged.w;
      c.height = merged.h;
      c.getContext("2d")?.putImageData(new ImageData(bytes, merged.w, merged.h), 0, 0);
      if (mode === "merge") {
        const stem = (frames[0]?.name ?? "merge").replace(/\.[^.]+$/, "");
        onCreate?.({ name: `${stem} HDR`, canvas: c, hdr: merged });
      } else {
        onApply?.(c);
      }
      setBusy(null);
      onClose();
    }, 30);
  };

  const toneStage = merged !== null;

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "merge" ? "Merge to HDR" : "HDR tone mapping"}
        style={{ width: 520 }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>{mode === "merge" ? "Merge to HDR" : `HDR tone mapping — ${docName ?? "document"}`}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "merge" && !toneStage && (
            <>
              <span className={styles.groupLabel}>Bracketed exposures</span>
              <p className={styles.note}>
                Add two or more exposures of the same scene, shot from a tripod (same pixel
                size — there is no auto-alignment). EV comes from EXIF when every frame
                carries capture data; otherwise it is estimated from brightness — edit
                either way.
              </p>
              {frames.map((f, i) => (
                <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>
                    {f.name}
                  </span>
                  <span className={styles.note} style={{ margin: 0 }}>
                    {f.w}×{f.h}
                  </span>
                  <div className={prefStyles.searchBox} style={{ width: 84, flex: "none" }}>
                    <input
                      type="number"
                      step={0.5}
                      value={f.ev}
                      aria-label={`EV for ${f.name}`}
                      title={f.evFromExif ? "EV from EXIF (relative)" : "EV estimated from brightness"}
                      onChange={(e) => {
                        evsTouched.current = true;
                        const v = Number(e.target.value);
                        setFrames((fs) =>
                          fs.map((x, j) => (j === i ? { ...x, ev: Number.isFinite(v) ? v : 0 } : x)),
                        );
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className={styles.close}
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFrames((fs) => fs.filter((_, j) => j !== i))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {mismatched.length > 0 && (
                <p className={styles.note} role="alert">
                  All frames must share the first frame&apos;s pixel size ({base?.w}×{base?.h}) —
                  remove: {mismatched.map((f) => f.name).join(", ")}.
                </p>
              )}
              <button
                type="button"
                className={styles.btn}
                style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6 }}
                disabled={decoding || !!busy}
                onClick={() => fileRef.current?.click()}
              >
                <FilePlus2 size={14} /> {decoding ? "Decoding…" : "Add exposures…"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}

          {toneStage && (
            <>
              <span className={styles.groupLabel}>Tone mapping</span>
              <canvas
                ref={canvasRef}
                style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
                aria-label="Tone-mapped preview"
              />
              <Segmented
                options={METHODS}
                value={method}
                onChange={(v) => setMethod(v as TonemapMethod)}
              />
              <Slider
                label="Exposure"
                min={-4}
                max={4}
                step={0.1}
                bipolar
                value={exposure}
                onChange={setExposure}
                unit=" ev"
              />
              <p className={styles.note}>
                {mode === "merge"
                  ? "The new document keeps the merged 32-bit float radiance in memory — re-tone-map any time via Image ▸ HDR tone mapping, or export true HDR via File ▸ Export HDR PNG. The float source isn't saved into .gproj."
                  : "Re-rendered from the document's float radiance onto the active layer — one undoable step, and repeated tone edits never stack up 8-bit loss."}
              </p>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          {mode === "merge" && toneStage && (
            <button
              type="button"
              className={styles.btn}
              disabled={!!busy}
              onClick={() => setMerged(null)}
              style={{ marginRight: "auto" }}
            >
              Back
            </button>
          )}
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          {!toneStage ? (
            <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!canMerge} onClick={runMerge}>
              {busy ?? `Merge ${frames.length || ""} frame${frames.length === 1 ? "" : "s"}`}
            </button>
          ) : (
            <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!!busy} onClick={finish}>
              {busy ?? (mode === "merge" ? "Create document" : "Apply to layer")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
