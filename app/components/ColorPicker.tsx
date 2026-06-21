"use client";

import { useRef, useState, type ReactNode } from "react";
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

const SWATCHES = [
  "#000000", "#3f3f46", "#a1a1aa", "#ffffff", "#ef4444", "#f97316",
  "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
  "#6366f1", "#8b5cf6", "#d946ef", "#ec4899",
];

type Format = "HEX" | "HEXA" | "RGBA" | "HSLA" | "HSVA";
const FORMATS: Format[] = ["HEX", "HEXA", "RGBA", "HSLA", "HSVA"];

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
    case "HEXA":
      return { hexa: toHex8(rgba).slice(1).toUpperCase() };
    case "RGBA":
      return { r: String(rgba.r), g: String(rgba.g), b: String(rgba.b), a };
    case "HSLA": {
      const hsl = hsvToHsl(hsva.h, hsva.s, hsva.v);
      return {
        h: String(Math.round(hsva.h)),
        s: String(Math.round(hsl.s)),
        l: String(Math.round(hsl.l)),
        a,
      };
    }
    case "HSVA":
      return {
        h: String(Math.round(hsva.h)),
        s: String(Math.round(hsva.s)),
        v: String(Math.round(hsva.v)),
        a,
      };
  }
}

/** Pointer-draggable surface; reports a normalised position (0–1) on x and y. */
function DragArea({
  className,
  onChange,
  children,
  ariaLabel,
}: {
  className: string;
  onChange: (nx: number, ny: number) => void;
  children?: ReactNode;
  ariaLabel: string;
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
      tabIndex={0}
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
  prefix?: string;
  suffix?: string;
  flex?: number;
  sanitize: (v: string) => string;
  commit: (v: string) => void;
}

export default function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex8: string) => void;
}) {
  const [hsva, setHsva] = useState<Hsva>(() => rgbaToHsva(parseColor(value)));
  const [fmt, setFmt] = useState<Format>("HEX");
  const [draft, setDraft] = useState<Draft>(() => buildDraft(rgbaToHsva(parseColor(value)), "HEX"));
  const editing = useRef(false);

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
    // Keep the input text in sync, unless the user is mid-edit in a field.
    if (editing.current) editing.current = false;
    else setDraft(buildDraft(next, fmt));
    onChange(toHex8(hsvaToRgba(next)));
  };

  // Commit from r/g/b while preserving hue in greyscale regions (avoids jumps).
  const commitRgb = (r: number, g: number, b: number, a: number) => {
    const hsv = rgbToHsv(r, g, b);
    commit({ h: hsv.s === 0 ? hsva.h : hsv.h, s: hsv.s, v: hsv.v, a });
  };

  const onCell = (key: string, raw: string, commitFn: (v: string) => void) => {
    editing.current = true;
    setDraft((d) => ({ ...d, [key]: raw }));
    commitFn(raw);
  };

  const rgba = hsvaToRgba(hsva);
  const hueColor = `hsl(${hsva.h} 100% 50%)`;

  // Build the input cells for the active format.
  const cells: Cell[] = (() => {
    const alpha: Cell = {
      key: "a",
      label: "A",
      suffix: "%",
      sanitize: numSan,
      commit: (v) => {
        const n = toInt(v, 100);
        if (n !== null) commit({ ...hsva, a: n / 100 });
      },
    };
    switch (fmt) {
      case "HEX":
        return [
          {
            key: "hex",
            label: "HEX",
            prefix: "#",
            flex: 2,
            sanitize: hexSan(6),
            commit: (v) => {
              if (v.length === 6) {
                const c = parseColor("#" + v);
                commitRgb(c.r, c.g, c.b, hsva.a);
              }
            },
          },
          alpha,
        ];
      case "HEXA":
        return [
          {
            key: "hexa",
            label: "HEXA",
            prefix: "#",
            flex: 1,
            sanitize: hexSan(8),
            commit: (v) => {
              if (v.length === 8) {
                const c = parseColor("#" + v);
                commit(rgbaToHsva(c));
              }
            },
          },
        ];
      case "RGBA":
        return [
          { key: "r", label: "R", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(n, rgba.g, rgba.b, hsva.a); } },
          { key: "g", label: "G", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(rgba.r, n, rgba.b, hsva.a); } },
          { key: "b", label: "B", sanitize: numSan, commit: (v) => { const n = toInt(v, 255); if (n !== null) commitRgb(rgba.r, rgba.g, n, hsva.a); } },
          alpha,
        ];
      case "HSLA": {
        const hsl = hsvToHsl(hsva.h, hsva.s, hsva.v);
        return [
          { key: "h", label: "H", sanitize: numSan, commit: (v) => { const n = toInt(v, 360); if (n !== null) commit({ ...hsva, h: n }); } },
          { key: "s", label: "S", suffix: "%", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) { const c = hslToHsv(hsva.h, n, hsl.l); commit({ ...c, a: hsva.a }); } } },
          { key: "l", label: "L", suffix: "%", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) { const c = hslToHsv(hsva.h, hsl.s, n); commit({ ...c, a: hsva.a }); } } },
          alpha,
        ];
      }
      case "HSVA":
        return [
          { key: "h", label: "H", sanitize: numSan, commit: (v) => { const n = toInt(v, 360); if (n !== null) commit({ ...hsva, h: n }); } },
          { key: "s", label: "S", suffix: "%", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hsva, s: n }); } },
          { key: "v", label: "V", suffix: "%", sanitize: numSan, commit: (v) => { const n = toInt(v, 100); if (n !== null) commit({ ...hsva, v: n }); } },
          alpha,
        ];
    }
  })();

  return (
    <div className={styles.picker}>
      <DragArea
        className={styles.sv}
        ariaLabel="Saturation and brightness"
        onChange={(nx, ny) => commit({ ...hsva, s: nx * 100, v: (1 - ny) * 100 })}
      >
        <div className={styles.svHue} style={{ background: hueColor }} />
        <div className={styles.svWhite} />
        <div className={styles.svBlack} />
        <span
          className={styles.svHandle}
          style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%`, background: toHex6(rgba) }}
        />
      </DragArea>

      <div className={styles.sliders}>
        <span className={styles.preview} style={swatchBg(toRgbaCss(rgba))} aria-hidden />
        <div className={styles.strips}>
          <DragArea
            className={styles.hue}
            ariaLabel="Hue"
            onChange={(nx) => commit({ ...hsva, h: nx * 360 })}
          >
            <span className={styles.stripHandle} style={{ left: `${(hsva.h / 360) * 100}%` }} />
          </DragArea>

          <DragArea
            className={styles.alpha}
            ariaLabel="Opacity"
            onChange={(nx) => commit({ ...hsva, a: nx })}
          >
            <div
              className={styles.alphaTrack}
              style={{ background: `linear-gradient(to right, transparent, ${toHex6(rgba)})` }}
            />
            <span className={styles.stripHandle} style={{ left: `${hsva.a * 100}%` }} />
          </DragArea>
        </div>
      </div>

      <div className={styles.inputs}>
        <Select
          options={FORMATS}
          value={fmt}
          onChange={(f) => setFmt(f as Format)}
          width={78}
        />

        <div className={styles.cells}>
          {/* cells' callbacks only touch refs in event handlers, never during render */}
          {/* eslint-disable-next-line react-hooks/refs */}
          {cells.map((c) => (
            <span
              key={c.key}
              className={styles.cellInput}
              style={c.flex ? { flex: c.flex } : undefined}
            >
              {c.prefix && <span className={styles.affix}>{c.prefix}</span>}
              <input
                value={draft[c.key] ?? ""}
                spellCheck={false}
                aria-label={c.label}
                inputMode={c.sanitize === numSan ? "numeric" : "text"}
                onChange={(e) => onCell(c.key, c.sanitize(e.target.value), c.commit)}
                onBlur={() => setDraft(buildDraft(hsva, fmt))}
              />
              {c.suffix && <span className={styles.affix}>{c.suffix}</span>}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.swatchBlock}>
        <span className={styles.swatchLabel}>Swatches</span>
        <div className={styles.swatches}>
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={styles.swatch}
              data-selected={c.toLowerCase() === toHex6(rgba).toLowerCase()}
              style={{ background: c }}
              title={c.toUpperCase()}
              onClick={() => {
                const pc = parseColor(c);
                commitRgb(pc.r, pc.g, pc.b, hsva.a);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
