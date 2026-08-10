"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Check, Dices, Download, Plus, Save, Upload, X } from "lucide-react";
import styles from "./GradientControl.module.scss";
import ColorPopover from "./ColorPopover";
import { sampleGradient } from "../lib/gradient";
import { swatchBg } from "../lib/color";
import { uiZoom } from "../lib/ui-scale";
import {
  GRADIENT_PRESETS_KEY,
  exportGradients,
  freshGradientId,
  importGradientFiles,
  loadSavedGradients,
  mergeGradients,
  persistSavedGradients,
  type GradientPreset,
} from "../lib/gradientio";
import type { GradientSettings, GradientStop } from "../lib/tools";
import { DEFAULT_NOISE, buildNoiseStops, type NoiseGradient } from "../lib/gradient-noise";

/** A CSS linear-gradient string for a preview swatch. */
export function cssGradient(stops: GradientStop[]): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  return `linear-gradient(90deg, ${sorted
    .map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`)
    .join(", ")})`;
}

const BUILTINS: GradientPreset[] = [
  { id: "b-mono", name: "Black → White", stops: [{ color: "#000000ff", pos: 0 }, { color: "#ffffffff", pos: 1 }] },
  { id: "b-sunset", name: "Sunset", stops: [{ color: "#ff7e5fff", pos: 0 }, { color: "#feb47bff", pos: 1 }] },
  { id: "b-ocean", name: "Ocean", stops: [{ color: "#2193b0ff", pos: 0 }, { color: "#6dd5edff", pos: 1 }] },
  { id: "b-fire", name: "Fire", stops: [{ color: "#f12711ff", pos: 0 }, { color: "#f5af19ff", pos: 1 }] },
  {
    id: "b-rainbow",
    name: "Rainbow",
    stops: [
      { color: "#ff0000ff", pos: 0 },
      { color: "#ffff00ff", pos: 0.25 },
      { color: "#00ff00ff", pos: 0.5 },
      { color: "#00ffffff", pos: 0.7 },
      { color: "#0000ffff", pos: 0.85 },
      { color: "#ff00ffff", pos: 1 },
    ],
  },
];

/**
 * The gradient editor: the multi-stop bar (click to add, drag to shift), the
 * selected-stop colour, reverse, and the preset library with save / import /
 * export. Used inline (Layer Style dialog) and inside GradientControl's
 * popover (the Gradient tool) — both share the same editing model; the preset
 * store bucket is `storageKey` (tool and layer styles share it by default).
 */
export function GradientEditor({
  stops,
  onStops,
  storageKey = GRADIENT_PRESETS_KEY,
}: {
  stops: GradientStop[];
  onStops: (stops: GradientStop[]) => void;
  storageKey?: string;
}) {
  const [sel, setSel] = useState(0);
  const [saved, setSaved] = useState<GradientPreset[]>([]);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  useEffect(() => setSaved(loadSavedGradients(storageKey)), [storageKey]);

  const persist = (list: GradientPreset[]) => {
    setSaved(list);
    persistSavedGradients(storageKey, list);
  };

  const posFromEvent = (e: { clientX: number }): number => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const addStop = (e: ReactPointerEvent) => {
    const pos = posFromEvent(e);
    const next = [...stops, { color: sampleGradient([...stops].sort((a, b) => a.pos - b.pos), pos), pos }];
    onStops(next);
    setSel(next.length - 1);
  };

  const onStopDown = (i: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = i;
    setSel(i);
  };
  const onStopMove = (e: ReactPointerEvent) => {
    if (dragRef.current === null) return;
    const i = dragRef.current;
    const pos = posFromEvent(e);
    onStops(stops.map((s, k) => (k === i ? { ...s, pos } : s)));
  };
  const onStopUp = (e: ReactPointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  const recolor = (hex8: string) => onStops(stops.map((s, k) => (k === sel ? { ...s, color: hex8 } : s)));
  const deleteStop = () => {
    if (stops.length <= 2) return;
    onStops(stops.filter((_, k) => k !== sel));
    setSel(0);
  };
  const reverse = () => onStops(stops.map((s) => ({ color: s.color, pos: 1 - s.pos })));
  const apply = (g: GradientPreset) => {
    onStops(g.stops.map((s) => ({ ...s })));
    setSel(0);
  };
  const startSave = () => {
    setNameDraft(`Gradient ${saved.length + 1}`);
    setNaming(true);
  };
  const confirmSave = () => {
    const name = nameDraft.trim();
    if (!name) return;
    persist([...saved, { id: freshGradientId(), name, stops: stops.map((s) => ({ ...s })) }]);
    setNaming(false);
  };
  const doImport = async () => {
    const imported = await importGradientFiles();
    if (imported.length) persist(mergeGradients(saved, imported));
  };
  const doExport = () => {
    if (saved.length) void exportGradients(saved);
  };

  const selColor = stops[sel]?.color ?? "#000000ff";

  return (
    <div className={styles.editorStack}>
      {/* Editable bar */}
      <div className={styles.editor}>
        <div
          ref={barRef}
          className={styles.bar}
          style={{ backgroundImage: cssGradient(stops) }}
          onPointerDown={addStop}
          title="Click to add a colour stop"
        />
        <div className={styles.stops}>
          {stops.map((s, i) => (
            <span
              key={i}
              className={styles.stop}
              data-sel={i === sel}
              style={{ left: `${s.pos * 100}%`, color: s.color }}
              onPointerDown={onStopDown(i)}
              onPointerMove={onStopMove}
              onPointerUp={onStopUp}
            />
          ))}
        </div>
      </div>

      <div className={styles.row}>
        <ColorPopover
          color={selColor}
          onChange={recolor}
          className={styles.colorSwatch}
          style={swatchBg(selColor)}
          title="Selected stop colour"
          ariaLabel="Selected stop colour"
          align="bottom-start"
        />
        <span className={styles.hint}>Click the bar to add stops</span>
        <button type="button" className={styles.iconBtn} onClick={reverse} title="Reverse stops">
          <ArrowLeftRight size={14} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          disabled={stops.length <= 2}
          onClick={deleteStop}
          title="Delete selected stop"
        >
          <X size={14} />
        </button>
      </div>

      {/* Preset library: save current / import / export */}
      <div className={styles.presetsHead}>
        <span className={styles.presetsLabel}>Presets</span>
        <div className={styles.presetsActions}>
          <button type="button" className={styles.iconBtn} onClick={startSave} title="Save current gradient">
            <Save size={13} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={doImport} title="Import gradients (.ggrad)">
            <Upload size={13} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={!saved.length}
            onClick={doExport}
            title={saved.length ? "Export saved gradients (.ggrad)" : "No saved gradients to export"}
          >
            <Download size={13} />
          </button>
        </div>
      </div>

      {naming && (
        <div className={styles.nameRow}>
          <span className={styles.namePreview} style={{ backgroundImage: cssGradient(stops) }} />
          <input
            className={styles.nameInput}
            autoFocus
            value={nameDraft}
            placeholder="Gradient name"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmSave();
              else if (e.key === "Escape") setNaming(false);
            }}
          />
          <button
            type="button"
            className={styles.iconBtn}
            onClick={confirmSave}
            disabled={!nameDraft.trim()}
            title="Save"
          >
            <Check size={14} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={() => setNaming(false)} title="Cancel">
            <X size={14} />
          </button>
        </div>
      )}

      <div className={styles.presetGrid}>
        {[...BUILTINS, ...saved].map((g) => (
          <div key={g.id} className={styles.presetCell}>
            <button
              type="button"
              className={styles.preset}
              style={{ backgroundImage: cssGradient(g.stops) }}
              title={g.name}
              onClick={() => apply(g)}
            />
            {!g.id.startsWith("b-") && (
              <span
                className={styles.presetDel}
                role="button"
                aria-label={`Delete ${g.name}`}
                onClick={() => persist(saved.filter((x) => x.id !== g.id))}
              >
                <X size={9} />
              </span>
            )}
          </div>
        ))}
        <button
          type="button"
          className={styles.addPreset}
          onClick={startSave}
          title="Save current as a preset"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

/** The Gradient tool's options-bar control: a swatch that opens the editor in
 *  a portalled popover, with the extra "follow Primary → Secondary" source. */
/**
 * Noise gradients: a random ramp from a seed rather than hand-placed stops.
 *
 * It only ever writes STOPS — the generated list flows through the identical
 * render path as every other gradient, so noise composes with reverse, dither,
 * angle smoothing and the gradient presets for free. `noise` is kept alongside
 * so the params stay re-editable; the moment a stop is dragged by hand it is
 * dropped, because the list no longer matches the seed.
 */
function NoiseSection({
  noise,
  onNoise,
}: {
  noise: NoiseGradient | undefined;
  onNoise: (spec: NoiseGradient | null) => void;
}) {
  const on = !!noise;
  const spec = noise ?? DEFAULT_NOISE;
  const patch = (p: Partial<NoiseGradient>) => onNoise({ ...spec, ...p });

  return (
    <div className={styles.noise}>
      <div className={styles.noiseHead}>
        <span className={styles.presetsLabel}>Noise</span>
        <button
          type="button"
          className={styles.sourceBtn}
          data-on={on}
          onClick={() => (on ? onNoise(null) : patch({ seed: (Math.random() * 0xffffffff) >>> 0 }))}
        >
          {on ? "On" : "Off"}
        </button>
      </div>

      {on && (
        <>
          <div className={styles.noiseRow}>
            <button
              type="button"
              className={styles.noiseDice}
              title="New random ramp from a fresh seed"
              onClick={() => patch({ seed: (Math.random() * 0xffffffff) >>> 0 })}
            >
              <Dices size={13} />
              Randomize
            </button>
            <span className={styles.noiseSeed}>#{spec.seed.toString(16).padStart(8, "0")}</span>
          </div>

          <label className={styles.noiseRow}>
            <span className={styles.noiseLabel}>Roughness</span>
            <input
              type="range"
              min={0}
              max={100}
              value={spec.roughness}
              aria-label="Roughness"
              onChange={(e) => patch({ roughness: Number(e.target.value) })}
            />
            <span className={styles.noiseValue}>{spec.roughness}</span>
          </label>

          <div className={styles.noiseRow}>
            {(["rgb", "hsb"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={styles.sourceBtn}
                data-on={spec.model === m}
                onClick={() => patch({ model: m })}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          <label className={styles.noiseCheck}>
            <input
              type="checkbox"
              checked={spec.restrict}
              onChange={(e) => patch({ restrict: e.target.checked })}
            />
            Restrict colours
          </label>
          <label className={styles.noiseCheck}>
            <input
              type="checkbox"
              checked={spec.transparency}
              onChange={(e) => patch({ transparency: e.target.checked })}
            />
            Add transparency
          </label>
        </>
      )}
    </div>
  );
}

export default function GradientControl({
  gradient,
  onGradient,
  fg,
  bg,
}: {
  gradient: GradientSettings;
  onGradient: (patch: Partial<GradientSettings>) => void;
  fg: string;
  bg: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on an outside click — but ignore clicks inside the nested colour
  // picker (a portaled [role="dialog"]) so editing a stop keeps this open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (wrapRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      if (t.closest('[role="dialog"]')) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Anchor the (portaled) popover under the swatch, clamped to the viewport.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = swatchRef.current?.getBoundingClientRect();
    if (!r) return;
    // Zoomed popup: clamp in viewport px (its 252 local px render ×z), then
    // ÷z because style offsets on a zoomed element render ×z.
    const z = uiZoom();
    const W = 252 * z;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) / z,
      top: (r.bottom + 8) / z,
    });
  }, [open]);

  // The stops currently shown: a custom list, or the primary→secondary default.
  const usingCustom = !!gradient.stops;
  const stops: GradientStop[] = gradient.stops ?? [
    { color: fg, pos: 0 },
    { color: bg, pos: 1 },
  ];

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        ref={swatchRef}
        type="button"
        className={styles.swatch}
        style={{ backgroundImage: cssGradient(stops) }}
        title="Edit gradient colours"
        onClick={() => setOpen((v) => !v)}
        aria-label="Gradient colours"
      />

      {open && pos &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.popover}
            style={{ position: "fixed", left: pos.left, top: pos.top }}
          >
            <button
              type="button"
              className={styles.sourceBtn}
              data-on={!usingCustom}
              onClick={() => onGradient({ stops: null })}
            >
              <span
                className={styles.sourceSwatch}
                style={{ backgroundImage: `linear-gradient(90deg, ${fg}, ${bg})` }}
              />
              Primary → Secondary
            </button>

            {/* Editing the stops always switches the gradient to "custom" — and
                drops any noise spec, because a hand-moved stop no longer matches
                the seed that generated the list. */}
            <GradientEditor
              stops={stops}
              onStops={(next) => onGradient({ stops: next, noise: undefined })}
            />

            <NoiseSection
              noise={gradient.noise}
              onNoise={(spec) =>
                spec
                  ? onGradient({ noise: spec, stops: buildNoiseStops(spec) })
                  : onGradient({ noise: undefined })
              }
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
