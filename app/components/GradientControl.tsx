"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Save, X } from "lucide-react";
import styles from "./GradientControl.module.scss";
import ColorPopover from "./ColorPopover";
import { sampleGradient } from "../lib/gradient";
import { swatchBg } from "../lib/color";
import type { GradientSettings, GradientStop } from "../lib/tools";

const PRESETS_KEY = "aperture:gradient-presets";

interface SavedGradient {
  id: string;
  name: string;
  stops: GradientStop[];
}

/** A CSS linear-gradient string for a preview swatch. */
function cssGradient(stops: GradientStop[]): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  return `linear-gradient(90deg, ${sorted
    .map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`)
    .join(", ")})`;
}

const BUILTINS: SavedGradient[] = [
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

function loadSaved(): SavedGradient[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY);
    const list = raw ? (JSON.parse(raw) as SavedGradient[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
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
  const [sel, setSel] = useState(0);
  const [saved, setSaved] = useState<SavedGradient[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  useEffect(() => setSaved(loadSaved()), []);

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
      setNaming(false);
      return;
    }
    const r = swatchRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 252;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      top: r.bottom + 8,
    });
  }, [open]);

  // The stops currently shown: a custom list, or the primary→secondary default.
  const usingCustom = !!gradient.stops;
  const stops: GradientStop[] = gradient.stops ?? [
    { color: fg, pos: 0 },
    { color: bg, pos: 1 },
  ];

  const persistSaved = (list: SavedGradient[]) => {
    setSaved(list);
    try {
      window.localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  };

  // Editing the stops always switches the gradient to "custom".
  const setStops = (next: GradientStop[]) => onGradient({ stops: next });

  const posFromEvent = (e: { clientX: number }): number => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const addStop = (e: ReactPointerEvent) => {
    const pos = posFromEvent(e);
    const next = [...stops, { color: sampleGradient([...stops].sort((a, b) => a.pos - b.pos), pos), pos }];
    setStops(next);
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
    setStops(stops.map((s, k) => (k === i ? { ...s, pos } : s)));
  };
  const onStopUp = (e: ReactPointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  const recolor = (hex8: string) =>
    setStops(stops.map((s, k) => (k === sel ? { ...s, color: hex8 } : s)));
  const deleteStop = () => {
    if (stops.length <= 2) return;
    setStops(stops.filter((_, k) => k !== sel));
    setSel(0);
  };
  const apply = (g: SavedGradient) => {
    setStops(g.stops.map((s) => ({ ...s })));
    setSel(0);
  };
  const startSave = () => {
    setNameDraft(`Gradient ${saved.length + 1}`);
    setNaming(true);
  };
  const confirmSave = () => {
    const name = nameDraft.trim();
    if (!name) return;
    persistSaved([
      ...saved,
      { id: `g-${Date.now().toString(36)}`, name, stops: stops.map((s) => ({ ...s })) },
    ]);
    setNaming(false);
  };

  const selColor = stops[sel]?.color ?? "#000000ff";

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
              <button
                type="button"
                className={styles.iconBtn}
                disabled={stops.length <= 2}
                onClick={deleteStop}
                title="Delete selected stop"
              >
                <X size={14} />
              </button>
              <button type="button" className={styles.iconBtn} onClick={startSave} title="Save gradient">
                <Save size={14} />
              </button>
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
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => setNaming(false)}
                  title="Cancel"
                >
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
                      onClick={() => persistSaved(saved.filter((x) => x.id !== g.id))}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
