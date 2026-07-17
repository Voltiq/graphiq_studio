"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { MENUS } from "../lib/menus";
import { TOOL_GROUPS } from "../lib/tools";

interface Row {
  name: string;
  keys: string;
}
interface Section {
  title: string;
  rows: Row[];
}

/** Canvas / panel interactions that live outside the menu bar. Curated — only
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

/** Build the full registry: tools, every menu item that carries a shortcut,
 *  then the curated canvas/panel gestures. */
function buildSections(): Section[] {
  const tools: Section = {
    title: "Tools",
    rows: TOOL_GROUPS.flat().map((t) => ({ name: t.name, keys: t.shortcut })),
  };
  const menus: Section[] = MENUS.map((m) => ({
    title: `${m.label} menu`,
    rows: m.items
      .filter((it) => it.shortcut)
      .map((it) => ({ name: it.label.replace(/…$/, ""), keys: it.shortcut! })),
  })).filter((s) => s.rows.length > 0);
  return [tools, ...menus, ...CANVAS_SHORTCUTS];
}

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const sections = useMemo(buildSections, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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

          {filtered.map((s) => (
            <section key={s.title} className={styles.section}>
              <span className={styles.groupLabel}>{s.title}</span>
              <div className={styles.shortcutList}>
                {s.rows.map((r) => (
                  <div key={`${s.title}|${r.name}`} className={styles.shortcutRow}>
                    <span className={styles.shortcutName}>{r.name}</span>
                    <span className={styles.kbdChip}>{r.keys}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!filtered.length && <div className={styles.noResults}>No shortcuts match “{query}”.</div>}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
