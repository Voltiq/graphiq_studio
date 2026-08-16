"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import {
  effectiveLabel,
  eventToBinding,
  formatBinding,
  type ShortcutDef,
  type ShortcutOverrides,
} from "../lib/shortcuts";

interface Row {
  name: string;
  keys: string;
  /** Registry id when the row is remappable (curated gestures have none). */
  id?: string;
  customized?: boolean;
  remappable?: boolean;
}
interface Section {
  title: string;
  rows: Row[];
}

/** Canvas / panel interactions that live outside the registry. Curated — only
 *  what actually exists (keep in sync when adding gestures). */
const CANVAS_SHORTCUTS: Section[] = [
  {
    title: "Application",
    rows: [{ name: "Command palette (search tools & menus)", keys: "Ctrl+K" }],
  },
  {
    title: "Canvas & selections",
    rows: [
      { name: "Zoom at the cursor", keys: "Ctrl+Wheel" },
      { name: "Pan vertically / horizontally", keys: "Wheel / Shift+Wheel" },
      { name: "Cycle marquee shape", keys: "Shift+M" },
      { name: "Cycle lasso mode (freehand / polygonal / magnetic)", keys: "Shift+L" },
      { name: "Polygonal lasso: close path / cancel / undo point", keys: "Enter / Esc / Backspace" },
      { name: "Constrain marquee to 1:1", keys: "hold Shift" },
      { name: "Add to selection while dragging", keys: "hold Ctrl" },
      { name: "Subtract from selection while dragging", keys: "hold Alt" },
      { name: "Nudge selection outline (selection tools) / pixels (Move)", keys: "Arrows" },
      { name: "Nudge by 10 px", keys: "Ctrl+Arrows" },
      { name: "Fill selection with foreground / background", keys: "Backspace / Delete" },
      { name: "Paint with the secondary colour", keys: "Right-drag" },
      { name: "Clone Stamp: set the source point", keys: "Alt+Click" },
      { name: "Commit a pen path", keys: "Enter / Double-click" },
      { name: "Brush-style tools: size / hardness / strength", keys: "[ ] / { } / 0–9" },
      { name: "Set brush size & hardness on the canvas", keys: "Alt+Right-drag" },
      { name: "Curves: nudge the selected point (×10)", keys: "Arrows (Shift)" },
      { name: "Curves: remove a point", keys: "Right-click / ⌫" },
    ],
  },
  {
    title: "Layers panel",
    rows: [
      { name: "Clip a layer to the layer below", keys: "Alt+Click row" },
      { name: "Select a range / toggle selection", keys: "Shift+Click / Ctrl+Click" },
      { name: "Enable or disable a mask", keys: "Shift+Click mask" },
      { name: "Rename a layer or document tab", keys: "Double-click name" },
    ],
  },
];

/**
 * The Keyboard Shortcuts window — a searchable cheat-sheet generated from the
 * shortcut REGISTRY, and the place to REMAP: click a key chip, press the new
 * keys (Backspace unbinds, Esc cancels), reset per-row or all at once.
 */
export default function ShortcutsDialog({
  defs,
  overrides,
  onRebind,
  onResetAll,
  onClose,
}: {
  defs: ShortcutDef[];
  overrides: ShortcutOverrides;
  /** string = bind, null = unbind, undefined = restore the default. */
  onRebind: (id: string, value: string | null | undefined) => void;
  onResetAll: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const customizedCount = Object.keys(overrides).length;

  const sections = useMemo<Section[]>(() => {
    const groups = new Map<string, Row[]>();
    for (const d of defs) {
      const row: Row = {
        name: d.label,
        keys: effectiveLabel(d, overrides),
        id: d.id,
        customized: d.id in overrides,
        remappable: d.remappable,
      };
      const list = groups.get(d.group);
      if (list) list.push(row);
      else groups.set(d.group, [row]);
    }
    return [...[...groups.entries()].map(([title, rows]) => ({ title, rows })), ...CANVAS_SHORTCUTS];
  }, [defs, overrides]);

  // While capturing: swallow every keydown (capture phase) and record it.
  useEffect(() => {
    if (!capturingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setCapturingId(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        onRebind(capturingId, null); // explicitly unbound
        setCapturingId(null);
        return;
      }
      const b = eventToBinding(e);
      if (!b) return; // bare modifier — keep waiting
      onRebind(capturingId, formatBinding(b));
      setCapturingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturingId, onRebind]);

  // Esc closes the dialog (only when not capturing — capture handles its own).
  useEffect(() => {
    if (capturingId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, capturingId]);

  const q = query.trim().toLowerCase();
  const filtered = sections
    .map((s) => ({
      ...s,
      rows: q
        ? s.rows.filter(
            (r) => r.name.toLowerCase().includes(q) || r.keys.toLowerCase().includes(q),
          )
        : s.rows,
    }))
    .filter((s) => s.rows.length > 0);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={`${styles.dialog} ${styles.prefsDialog}`}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <h2>Keyboard shortcuts</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.searchBox}>
            <Search size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Search shortcuts…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <p className={styles.sectionHint}>
            Click a key to remap it — press the new keys, Backspace to unbind, Esc to cancel.
            Grey rows are fixed gestures.
          </p>

          {filtered.map((s) => (
            <section key={s.title} className={styles.section}>
              <span className={styles.groupLabel}>{s.title}</span>
              <div className={styles.shortcutList}>
                {s.rows.map((r) => (
                  <div key={`${s.title}|${r.name}`} className={styles.shortcutRow}>
                    <span className={styles.shortcutName}>
                      {r.name}
                      {r.customized && <span className={styles.customDot} title="Customized" />}
                    </span>
                    {r.id && r.remappable ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {r.customized && (
                          <button
                            type="button"
                            className={styles.chipReset}
                            title="Restore the default"
                            aria-label={`Restore default for ${r.name}`}
                            onClick={() => onRebind(r.id!, undefined)}
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${styles.kbdChip} ${styles.kbdChipBtn}`}
                          data-capturing={capturingId === r.id}
                          onClick={() => setCapturingId(capturingId === r.id ? null : r.id!)}
                          title="Click, then press the new shortcut"
                        >
                          {capturingId === r.id ? "Press keys…" : r.keys || "—"}
                        </button>
                      </span>
                    ) : (
                      <span className={styles.kbdChip} data-fixed={!r.id || undefined}>
                        {r.keys || "—"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!filtered.length && <div className={styles.noResults}>No shortcuts match “{query}”.</div>}
        </div>

        <footer className={styles.foot} style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className={styles.btn}
            disabled={!customizedCount}
            onClick={() => {
              if (window.confirm("Restore every keyboard shortcut to its default?")) onResetAll();
            }}
          >
            Reset all shortcuts
            {customizedCount ? ` (${customizedCount} changed)` : ""}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
