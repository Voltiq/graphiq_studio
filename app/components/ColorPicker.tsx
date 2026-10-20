"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Download, Plus, Upload } from "lucide-react";
import styles from "./ColorPicker.module.scss";
import { Select } from "./Select";
import {
  clamp,
  hslToHsv,
  hsvToHsl,
  hsvaToRgba,
  parseColor,
  rgbToHsv,
  rgbaToHsva,
  swatchBg,
  toHex6,
  toHex8,
  toRgbaCss,
  type Hsva,
} from "../lib/color";
import {
  addSwatch,
  getSwatches,
  parseSwatchFile,
  removeSwatchAt,
  setSwatches,
  subscribeSwatches,
  swatchesToFileJSON,
} from "../lib/swatches";
import { downloadBlob } from "../lib/project";

const SWATCHES = [
  "#000000", "#3f3f46", "#a1a1aa", "#ffffff", "#ef4444", "#f97316",
  "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
  "#6366f1", "#8b5cf6", "#d946ef", "#ec4899",
];

/* How the value is written. Opacity always has its own field, so there is no
   separate "with alpha" format: the hex field takes 6 digits, or 8 when the
   alpha travels with it (pasting #RRGGBBAA still works). */
type Format = "HEX" | "RGB" | "HSL" | "HSV";
const FORMATS: Format[] = ["HEX", "RGB", "HSL", "HSV"];

type Draft = Record<string, string>;

const hexSan = (max: number) => (v: string) =>
  v.replace(/[^0-9a-fA-F]/g, "").slice(0, max).toUpperCase();
const numSan = (v: string) => v.replace(/[^0-9]/g, "").slice(0, 3);
const toInt = (v: string, max: number) => {
  if (v.trim() === "") return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : clamp(n, 0, max);
};

/** Build the text shown in the input cells for a given colour + format. */
function buildDraft(hsva: Hsva, fmt: Format): Draft {
  const rgba = hsvaToRgba(hsva);
  const a = String(Math.round(hsva.a * 100));
  switch (fmt) {
    case "HEX":
      return { hex: toHex6(rgba).slice(1).toUpperCase(), a };
    case "RGB":
      return { r: String(rgba.r), g: String(rgba.g), b: String(rgba.b), a };
    case "HSL": {
      const hsl = hsvToHsl(hsva.h, hsva.s, hsva.v);
      return { h: String(Math.round(hsva.h)), s: String(Math.round(hsl.s)), l: String(Math.round(hsl.l)), a };
    }
    case "HSV":
      return { h: String(Math.round(hsva.h)), s: String(Math.round(hsva.s)), v: String(Math.round(hsva.v)), a };
  }
}

/**
 * Pointer-draggable surface; reports a normalised position (0–1) on x and y.
 *
 * It carries `role="slider"`, which obliges it to state its value and to be
 * operable from the keyboard — it was doing neither, while still being reachable
 * by Tab, so a keyboard user could focus it and then find nothing worked. The
 * value is supplied by the caller rather than derived here because each surface
 * has its own scale (hue 0–360, opacity and the saturation/brightness square
 * 0–100), and `onStep` lets the caller apply an arrow key on its own terms — the
 * square moves on both axes, the strips only on one.
 */
function DragArea({
  className,
  onChange,
  children,
  ariaLabel,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  onStep,
}: {
  className: string;
  onChange: (nx: number, ny: number) => void;
  children?: ReactNode;
  ariaLabel: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  /** Spoken instead of the bare number — the square needs to say both axes. */
  valueText?: string;
  /** dx / dy are ±1 (±10 with Shift); the caller decides what a step means. */
  onStep?: (dx: number, dy: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const emit = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(clamp((clientX - r.left) / r.width, 0, 1), clamp((clientY - r.top) / r.height, 0, 1));
  };

  return (
    <div
      ref={ref}
      className={className}
      role="slider"
      aria-label={ariaLabel}
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuetext={valueText}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!onStep) return;
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        onStep(dx, dy);
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        emit(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) emit(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
    >
      {children}
    </div>
  );
}

interface Cell {
  key: string;
  label: string;
  sanitize: (v: string) => string;
  commit: (v: string) => void;
}

/** The saved swatches, kept in step with every other picker.
 *
 *  They live in this browser's storage, which the server cannot see, so the
 *  server snapshot is "none" — and React hydrates against that, then renders
 *  the saved ones straight after. Reading storage in the first render instead
 *  drew swatches the server had not, and a failed hydration makes React redo
 *  the whole page from the root. The snapshot has to be stable between
 *  changes; an empty list is always the same empty list. */
const NO_SWATCHES: string[] = [];
const swatchSnapshot = () => {
  const list = getSwatches();
  return list.length ? list : NO_SWATCHES;
};
function useCustomSwatches(): string[] {
  return useSyncExternalStore(subscribeSwatches, swatchSnapshot, () => NO_SWATCHES);
}

/**
 * The colour picker, as the design draws it: the saturation/brightness square,
 * the hue and opacity strips, then one row of values — what the colour is
 * (`lead`: a chip, or the colour panel's primary/secondary pair), the value in
 * the chosen format, and its opacity — and under it the swatches.
 *
 * `swatches` picks how much of the swatch library comes along: one quick row
 * (the colour panel's Picker view, whose Swatches view holds the rest), the
 * whole library (the popover, which has no second view), or none.
 */
export default function ColorPicker({
  value,
  onChange,
  lead,
  swatches = "full",
}: {
  value: string;
  onChange: (hex8: string) => void;
  lead?: ReactNode;
  swatches?: "row" | "full" | "none";
}) {
  const [hsva, setHsva] = useState<Hsva>(() => rgbaToHsva(parseColor(value)));
  const [fmt, setFmt] = useState<Format>("HEX");
  const [draft, setDraft] = useState<Draft>(() => buildDraft(rgbaToHsva(parseColor(value)), "HEX"));
  /** The cell being typed in: it keeps what was typed while the others follow. */
  const editing = useRef<string | null>(null);

  // Adopt external value / format changes DURING RENDER (the React-recommended
  // "adjust state when a prop changes" pattern). No effects → no effect loops;
  // React re-renders before paint and the `prev*` guards make it settle.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    // Skip when the incoming value is just our own last-emitted colour, so an
    // in-progress (fractional) edit isn't clobbered mid-drag.
    if (value.toLowerCase() !== toHex8(hsvaToRgba(hsva)).toLowerCase()) {
      const next = rgbaToHsva(parseColor(value));
      setHsva(next);
      setDraft(buildDraft(next, fmt));
    }
  }
  const [prevFmt, setPrevFmt] = useState(fmt);
  if (fmt !== prevFmt) {
    setPrevFmt(fmt);
    setDraft(buildDraft(hsva, fmt));
  }

  const commit = (next: Hsva) => {
    setHsva(next);
    // Every cell follows the colour except the one being typed in, which keeps
    // its text (a half-typed "25" must not be rewritten under the cursor) — so
    // eight hex digits update the opacity cell at once.
    const key = editing.current;
    editing.current = null;
    setDraft((d) => (key ? { ...buildDraft(next, fmt), [key]: d[key] } : buildDraft(next, fmt)));
    onChange(toHex8(hsvaToRgba(next)));
  };

  // Commit from r/g/b while preserving hue in greyscale regions (avoids jumps).
  const commitRgb = (r: number, g: number, b: number, a: number) => {
    const hsv = rgbToHsv(r, g, b);
    commit({ h: hsv.s === 0 ? hsva.h : hsv.h, s: hsv.s, v: hsv.v, a });
  };

  const onCell = (key: string, raw: string, commitFn: (v: string) => void) => {
    editing.current = key;
    setDraft((d) => ({ ...d, [key]: raw }));
    commitFn(raw);
  };

  const rgba = hsvaToRgba(hsva);
  const hex6 = toHex6(rgba);
  const hueColor = `hsl(${hsva.h} 100% 50%)`;

  const alphaCell: Cell = {
    key: "a",
    label: "Opacity",
    sanitize: numSan,
    commit: (v) => {
      const n = toInt(v, 100);
      if (n !== null) commit({ ...hsva, a: n / 100 });
    },
  };

  // The value cells for the active format (the opacity cell is always its own).
  const cells: Cell[] = (() => {
    switch (fmt) {
      case "HEX":
        return [
          {
            key: "hex",
            label: "Hex",
            sanitize: hexSan(8),
            commit: (v) => {
              if (v.length === 6) {
                const c = parseColor("#" + v);
                commitRgb(c.r, c.g, c.b, hsva.a);
              } else if (v.length === 8) {
                commit(rgbaToHsva(parseColor("#" + v)));
              }
            },
          },
        ];
      case "RGB":
        return [
          { key: "r", label: "Red", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(n, rgba.g, rgba.b, hsva.a); } },
          { key: "g", label: "Green", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(rgba.r, n, rgba.b, hsva.a); } },
          { key: "b", label: "Blue", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(rgba.r, rgba.g, n, hsva.a); } },
        ];
      case "HSL": {
        const hsl = hsvToHsl(hsva.h, hsva.s, hsva.v);
        return [
          { key: "h", label: "Hue", sanitize: numSan, commit: (v) => { const n = toInt(v, 360); if (n !== null) commit({ ...hsva, h: n }); } },
          { key: "s", label: "Saturation", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hslToHsv(hsva.h, n, hsl.l), a: hsva.a }); } },
          { key: "l", label: "Lightness", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hslToHsv(hsva.h, hsl.s, n), a: hsva.a }); } },
        ];
      }
      case "HSV":
        return [
          { key: "h", label: "Hue", sanitize: numSan, commit: (v) => { const n = toInt(v, 360); if (n !== null) commit({ ...hsva, h: n }); } },
          { key: "s", label: "Saturation", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hsva, s: n }); } },
          { key: "v", label: "Brightness", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hsva, v: n }); } },
        ];
    }
  })();

  const input = (c: Cell, className?: string) => (
    <input
      key={c.key}
      className={className}
      value={draft[c.key] ?? ""}
      spellCheck={false}
      aria-label={c.label}
      inputMode={c.sanitize === numSan ? "numeric" : "text"}
      onChange={(e) => onCell(c.key, c.sanitize(e.target.value), c.commit)}
      onBlur={() => {
        editing.current = null;
        setDraft(buildDraft(hsva, fmt));
      }}
      onKeyDown={(e) => e.stopPropagation()} // single-letter tool shortcuts stay out
    />
  );

  return (
    <div className={styles.picker}>
      <DragArea
        className={styles.sv}
        ariaLabel="Saturation and brightness"
        onChange={(nx, ny) => commit({ ...hsva, s: nx * 100, v: (1 - ny) * 100 })}
        valueNow={Math.round(hsva.s)}
        valueMin={0}
        valueMax={100}
        valueText={`Saturation ${Math.round(hsva.s)}%, brightness ${Math.round(hsva.v)}%`}
        onStep={(dx, dy) =>
          commit({
            ...hsva,
            s: clamp(hsva.s + dx, 0, 100),
            // Down arrow darkens: the surface maps y downwards to less brightness.
            v: clamp(hsva.v - dy, 0, 100),
          })
        }
      >
        <div className={styles.svHue} style={{ background: hueColor }} />
        <div className={styles.svWhite} />
        <div className={styles.svBlack} />
        <span className={styles.svHandle} style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%`, background: hex6 }} />
      </DragArea>

      <DragArea
        className={styles.hue}
        ariaLabel="Hue"
        onChange={(nx) => commit({ ...hsva, h: nx * 360 })}
        valueNow={Math.round(hsva.h)}
        valueMin={0}
        valueMax={360}
        valueText={`${Math.round(hsva.h)}°`}
        // Hue is a wheel, so stepping off either end wraps rather than clamps.
        onStep={(dx) => commit({ ...hsva, h: (((hsva.h + dx) % 360) + 360) % 360 })}
      >
        {/* The knob wears the hue it sits on, as the design draws it. */}
        <span className={styles.stripHandle} style={{ left: `${(hsva.h / 360) * 100}%`, background: hueColor }} />
      </DragArea>

      <DragArea
        className={styles.alpha}
        ariaLabel="Opacity"
        onChange={(nx) => commit({ ...hsva, a: nx })}
        valueNow={Math.round(hsva.a * 100)}
        valueMin={0}
        valueMax={100}
        valueText={`${Math.round(hsva.a * 100)}%`}
        onStep={(dx) => commit({ ...hsva, a: clamp(hsva.a * 100 + dx, 0, 100) / 100 })}
      >
        <div className={styles.alphaTrack} style={{ background: `linear-gradient(to right, transparent, ${hex6})` }} />
        <span className={styles.stripHandle} style={{ left: `${hsva.a * 100}%`, background: hex6 }} />
      </DragArea>

      <div className={styles.values}>
        {lead ?? (
          <span
            className={styles.chip}
            style={{ ...swatchBg(toRgbaCss(rgba)), "--glow": hex6 } as React.CSSProperties}
            aria-hidden
          />
        )}
        {/* The format sits inside the value field it governs: "HEX ▾ 6B8DFF". */}
        <div className={styles.field} data-format={fmt}>
          <Select
            variant="inline"
            ariaLabel="Colour value format"
            options={FORMATS}
            value={fmt}
            onChange={(f) => setFmt(f as Format)}
          />
          {fmt === "HEX" && <span className={styles.affix}>#</span>}
          {cells.map((c) => input(c, styles.cell))}
        </div>
        <label className={`${styles.field} ${styles.alphaField}`}>
          {input(alphaCell, styles.cell)}
          <span className={styles.affix}>%</span>
        </label>
      </div>

      {swatches === "row" && <SwatchRow value={toHex8(rgba)} onPick={(c) => commit(rgbaToHsva(parseColor(c)))} />}
      {swatches === "full" && (
        <SwatchLibrary value={toHex8(rgba)} onChange={(c) => commit(rgbaToHsva(parseColor(c)))} />
      )}
    </div>
  );
}

/**
 * One row of swatches under the picker: yours first (newest first), then the
 * presets, as many as the row holds — and a + that adds the current colour.
 * The whole library is one tap away in the panel's Swatches view.
 */
function SwatchRow({ value, onPick }: { value: string; onPick: (hex8: string) => void }) {
  const custom = useCustomSwatches();
  const opaque = value.slice(0, 7).toLowerCase();
  const alpha = value.slice(7) || "ff";
  const items = [
    ...[...custom].reverse().map((c) => ({ c, custom: true })),
    ...SWATCHES.map((c) => ({ c: c + alpha, custom: false })),
  ];
  return (
    <div className={styles.swRow}>
      <div className={styles.swRowItems} role="group" aria-label="Swatches">
        {items.map(({ c, custom: mine }, i) => (
          <button
            key={`${c}-${i}`}
            type="button"
            className={styles.sw}
            data-selected={(mine ? c.toLowerCase() === value.toLowerCase() : c.slice(0, 7).toLowerCase() === opaque) || undefined}
            style={swatchBg(c)}
            aria-label={c.slice(0, 7).toUpperCase()}
            title={c.slice(0, 7).toUpperCase()}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      <button
        type="button"
        className={`${styles.sw} ${styles.swAdd}`}
        aria-label="Add the current colour to your swatches"
        title="Add the current colour to your swatches"
        onClick={() => addSwatch(value)}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * The whole swatch library: the presets, and yours — added from the current
 * colour, imported from a palette file (JSON, .gpl, loose hex), exported, and
 * removed with Alt-click or right-click. A preset keeps the current opacity; a
 * saved swatch brings its own.
 */
export function SwatchLibrary({ value, onChange }: { value: string; onChange: (hex8: string) => void }) {
  const custom = useCustomSwatches();
  const fileRef = useRef<HTMLInputElement>(null);
  const opaque = value.slice(0, 7).toLowerCase();
  const alpha = value.slice(7) || "ff";

  // Merge an imported palette into the saved swatches, skipping duplicates.
  const importFile = async (file: File) => {
    const parsed = parseSwatchFile(await file.text());
    if (!parsed.length) return;
    const merged = [...getSwatches()];
    const seen = new Set(merged.map((x) => x.toLowerCase()));
    for (const c of parsed) {
      if (!seen.has(c.toLowerCase())) {
        seen.add(c.toLowerCase());
        merged.push(c);
      }
    }
    setSwatches(merged);
  };

  const exportSwatches = () =>
    downloadBlob(new Blob([swatchesToFileJSON(getSwatches())], { type: "application/json" }), "graphiq-swatches.json");

  return (
    <div className={styles.library}>
      <div className={styles.libHead}>
        <span className={styles.libLabel}>Yours</span>
        <div className={styles.libActions}>
          <button
            type="button"
            className={styles.libBtn}
            title="Add the current colour to your swatches"
            aria-label="Add the current colour to your swatches"
            onClick={() => addSwatch(value)}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className={styles.libBtn}
            title="Import swatches…"
            aria-label="Import swatches"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} />
          </button>
          <button
            type="button"
            className={styles.libBtn}
            disabled={!custom.length}
            title="Export your swatches"
            aria-label="Export your swatches"
            onClick={exportSwatches}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      {custom.length > 0 ? (
        <div className={styles.swGrid} role="group" aria-label="Your swatches">
          {custom.map((c, i) => (
            <button
              key={`${c}-${i}`}
              type="button"
              className={styles.sw}
              data-selected={c.toLowerCase() === value.toLowerCase() || undefined}
              style={swatchBg(c)}
              aria-label={c.toUpperCase()}
              title={`${c.toUpperCase()} — click to use, Alt-click or right-click to remove`}
              onClick={(e) => (e.altKey ? removeSwatchAt(i) : onChange(c))}
              onContextMenu={(e) => {
                e.preventDefault();
                removeSwatchAt(i);
              }}
            />
          ))}
        </div>
      ) : (
        <p className={styles.libEmpty}>Colours you add with + are kept here, in this browser.</p>
      )}

      <span className={styles.libLabel}>Presets</span>
      <div className={styles.swGrid} role="group" aria-label="Preset swatches">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className={styles.sw}
            data-selected={c === opaque || undefined}
            style={{ background: c }}
            aria-label={c.toUpperCase()}
            title={c.toUpperCase()}
            onClick={() => onChange(c + alpha)}
          />
        ))}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.gpl,.txt,application/json,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = ""; // allow re-importing the same file
        }}
      />
    </div>
  );
}
