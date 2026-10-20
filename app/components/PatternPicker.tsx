"use client";

/**
 * The pattern-tile grid: built-ins first, then yours.
 *
 * Deliberately knows nothing about what it is picked FOR. The two features
 * waiting on this — pattern text fills and pattern fill layers — mount the same
 * component and read `selectedId`; nothing here is about filling anything, so
 * neither of them has to unpick a fill-shaped assumption first.
 *
 * The tiles are drawn onto small canvases rather than shown as `<img>` because
 * a pattern is a thing that REPEATS: the swatch draws the tile tiled, so a seam
 * shows up in the picker instead of in the artwork.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Trash2, Upload } from "../lib/icons";
import {
  PATTERN_EXT,
  builtinPatternMetas,
  deletePattern,
  entryToPattern,
  importPatternFile,
  isBuiltinPattern,
  listPatterns,
  loadPatternTile,
  mergePatterns,
  parsePatternFile,
  patternToEntry,
  serializePatterns,
  type PatternEntry,
  type PatternMeta,
} from "../lib/patterns";
import { downloadBlob } from "../lib/project";
import styles from "./PatternPicker.module.scss";

/** A tile, drawn repeating so its seam is visible at picking time. */
function Swatch({ id, size = 56 }: { id: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let dead = false;
    void (async () => {
      const tile = await loadPatternTile(id);
      const c = ref.current;
      if (dead || !c || !tile) return;
      const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
      c.width = size * dpr;
      c.height = size * dpr;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const pat = ctx.createPattern(tile, "repeat");
      if (!pat) return;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, c.width, c.height);
    })();
    return () => {
      dead = true;
    };
  }, [id, size]);
  return <canvas ref={ref} className={styles.swatch} style={{ width: size, height: size }} />;
}

export interface PatternPickerProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function PatternPicker({ selectedId, onSelect }: PatternPickerProps) {
  const [saved, setSaved] = useState<PatternMeta[]>([]);
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const jsonRef = useRef<HTMLInputElement | null>(null);

  /* The store is async and this renders on the server too, so the list starts
     empty and arrives — the same hydration reason GradientControl loads its
     presets in an effect rather than in the initial state.
     
     The load is a `.then` rather than an awaited call in the effect body so the
     state update is plainly asynchronous: React's lint rule reads a synchronous
     `setState` inside an effect as a cascading render, and it is right to. */
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let dead = false;
    listPatterns().then((l) => {
      if (!dead) setSaved(l);
    });
    return () => {
      dead = true;
    };
  }, [stamp]);
  /** Re-read the store after a change. */
  const refresh = useCallback(async () => setStamp((n) => n + 1), []);

  const builtins = builtinPatternMetas();
  const all = [...builtins, ...saved];

  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    let added = 0;
    for (const f of Array.from(files)) {
      const m = await importPatternFile(f, Date.now(), Math.random());
      if (m) {
        added++;
        onSelect(m.id);
      }
    }
    await refresh();
    setNote(
      added === files.length
        ? ""
        : `${files.length - added} of ${files.length} could not be imported`,
    );
  };

  const addFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const entries: PatternEntry[] = parsePatternFile(await f.text());
    if (!entries.length) {
      setNote("No patterns in that file");
      return;
    }
    for (const e of mergePatterns(all, entries))
      await entryToPattern(e, Date.now(), Math.random());
    await refresh();
    setNote("");
  };

  const exportAll = async () => {
    const entries: PatternEntry[] = [];
    for (const m of saved) {
      const e = await patternToEntry(m);
      if (e) entries.push(e);
    }
    if (!entries.length) {
      /* Built-ins are procedures, not files — exporting them would write out a
         picture of something the app can already draw. */
      setNote("Nothing to export — the built-in tiles are drawn, not stored");
      return;
    }
    downloadBlob(
      new Blob([serializePatterns(entries)], { type: "application/json" }),
      `patterns.${PATTERN_EXT}`,
    );
  };

  return (
    <div className={styles.picker}>
      <div className={styles.grid} role="listbox" aria-label="Patterns">
        {all.map((m) => (
          <div key={m.id} className={styles.cell}>
            <button
              type="button"
              className={styles.tile}
              role="option"
              aria-selected={selectedId === m.id}
              data-selected={selectedId === m.id || undefined}
              title={`${m.name} — ${m.width}×${m.height}`}
              onClick={() => onSelect(m.id)}
            >
              <Swatch id={m.id} />
              <span className={styles.name}>{m.name}</span>
            </button>
            {/* Built-ins cannot be deleted: they are code, and a delete that
                did nothing would be worse than no button. */}
            {!isBuiltinPattern(m.id) && (
              <button
                type="button"
                className={styles.del}
                aria-label={`Delete ${m.name}`}
                title={`Delete ${m.name}`}
                onClick={async () => {
                  await deletePattern(m.id);
                  await refresh();
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {note && <p className={styles.note}>{note}</p>}

      <div className={styles.actions}>
        <button type="button" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Add image…
        </button>
        <button type="button" onClick={() => jsonRef.current?.click()}>
          Import .{PATTERN_EXT}…
        </button>
        <button type="button" onClick={exportAll}>
          <Download size={14} /> Export
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addImages(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={jsonRef}
        type="file"
        accept={`.${PATTERN_EXT},application/json`}
        hidden
        onChange={(e) => {
          void addFile(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
