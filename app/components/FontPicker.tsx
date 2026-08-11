"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import styles from "./FontPicker.module.scss";
import { uiZoom } from "../lib/ui-scale";
import {
  canQuerySystemFonts,
  loadRecentFonts,
  mergeFontLists,
  pushRecent,
  querySystemFonts,
  saveRecentFonts,
  searchFonts,
  validRecents,
} from "../lib/fonts";

const POPOVER_W = 268;

/**
 * Font chooser: type to search, every row previewed in its own face, and the
 * fonts you actually use kept at the top.
 *
 * The preview is the reason this replaced a <select>: a native option list is
 * rendered by the OS in the UI font, so picking a typeface meant reading names
 * and guessing. Each row here sets its own font-family, which is also a free
 * availability check — a font the browser can't resolve visibly falls back.
 */
export default function FontPicker({
  value,
  onChange,
  families,
}: {
  value: string;
  onChange: (family: string) => void;
  families: string[];
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [system, setSystem] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(
    () => (system.length ? mergeFontLists(families, system) : families),
    [families, system],
  );
  const results = useMemo(() => searchFonts(all, query), [all, query]);
  // Recents only lead the list when the user isn't searching — during a search
  // the ranking IS the answer, and a pinned group on top would fight it.
  const recents = useMemo(
    () => (query.trim() ? [] : validRecents(recent, all)),
    [recent, all, query],
  );
  const flat = useMemo(() => [...recents, ...results], [recents, results]);

  // Opening does all its own state work in the handler rather than an effect:
  // the trigger's rect is already measurable at click time (the popover isn't
  // rendered yet and doesn't affect it), so there is nothing to synchronize
  // after a render — and reading localStorage on open keeps the recents fresh
  // if another document changed them.
  const openPicker = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Zoomed popup: clamp in viewport px, then ÷z because style offsets on a
    // zoomed element render ×z (same rule as the gradient popover).
    const z = uiZoom();
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W * z - 8)) / z,
      top: (r.bottom + 6) / z,
    });
    setRecent(loadRecentFonts());
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Follow the keyboard highlight so arrowing past the fold still shows it.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (family: string) => {
    const next = pushRecent(recent, family);
    setRecent(next);
    saveRecentFonts(next);
    onChange(family);
    setOpen(false);
  };

  const loadSystem = async () => {
    const fonts = await querySystemFonts();
    if (fonts.length) setSystem(fonts);
  };

  const row = (family: string, idx: number, key: string) => (
    <button
      key={key}
      type="button"
      data-idx={idx}
      className={styles.row}
      data-active={idx === active}
      data-selected={family === value}
      onMouseEnter={() => setActive(idx)}
      onClick={() => pick(family)}
    >
      <span className={styles.check}>{family === value && <Check size={12} strokeWidth={3} />}</span>
      {/* The sample IS the font — quoted so multi-word families resolve. */}
      <span className={styles.sample} style={{ fontFamily: `"${family}"` }}>
        {family}
      </span>
    </button>
  );

  return (
    <div className={styles.wrap}>
      <span className={styles.label}>Font</span>
      <button
        ref={btnRef}
        type="button"
        className={styles.trigger}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-label="Font"
        aria-expanded={open}
        title={value}
      >
        <span className={styles.triggerName} style={{ fontFamily: `"${value}"` }}>
          {value}
        </span>
        <ChevronDown size={13} className={styles.chevron} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={styles.popover}
            style={{ position: "fixed", left: pos.left, top: pos.top, width: POPOVER_W }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation(); // don't let the canvas treat this as deselect
                setOpen(false);
                btnRef.current?.focus();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(flat.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (flat[active]) pick(flat[active]);
              }
            }}
          >
            <div className={styles.searchRow}>
              <Search size={13} className={styles.searchIcon} />
              <input
                ref={inputRef}
                className={styles.search}
                value={query}
                placeholder="Search fonts"
                aria-label="Search fonts"
                onChange={(e) => {
                  // Reset the highlight here rather than in an effect on
                  // `query` — same result, one render instead of two.
                  setQuery(e.target.value);
                  setActive(0);
                }}
              />
            </div>

            <div className={styles.list} ref={listRef}>
              {recents.length > 0 && (
                <>
                  <div className={styles.groupLabel}>Recent</div>
                  {recents.map((f, i) => row(f, i, `r:${f}`))}
                  <div className={styles.groupLabel}>All fonts</div>
                </>
              )}
              {results.map((f, i) => row(f, recents.length + i, `a:${f}`))}
              {flat.length === 0 && <div className={styles.empty}>No fonts match “{query}”.</div>}
            </div>

            {canQuerySystemFonts() && system.length === 0 && (
              <button type="button" className={styles.systemBtn} onClick={loadSystem}>
                Add system fonts…
              </button>
            )}
            {system.length > 0 && (
              <div className={styles.systemNote}>{system.length} system fonts loaded</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
