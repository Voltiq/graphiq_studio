"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownLeft, History, Search, type LucideIcon } from "lucide-react";
import styles from "./CommandPalette.module.scss";
import { fuzzyMatch, highlightRuns } from "../lib/fuzzy";

/** One runnable palette entry (built by TopBar from the tool/menu registries). */
export interface PaletteCommand {
  key: string;
  label: string;
  sub: string; // "Tool" or "<Menu> menu"
  shortcut?: string;
  icon?: LucideIcon;
  /** Menu action id — lets checkable commands (Window toggles) show state. */
  action?: string;
  run: () => void;
}

const RECENTS_KEY = "graphiq:palette-recents";
const MAX_RECENTS = 7;
const MAX_RESULTS = 14;
/* Stable ids so the combobox can point `aria-controls` at its listbox and
   `aria-activedescendant` at the highlighted row. Only one palette is ever
   mounted (it is modal), so fixed ids cannot collide. */
const LIST_ID = "command-palette-list";
const optionId = (i: number) => `command-palette-option-${i}`;

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(key: string) {
  try {
    const next = [key, ...loadRecents().filter((k) => k !== key)].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

interface Row {
  cmd: PaletteCommand;
  /** Highlight runs for the label (plain text when the match hit the subtitle). */
  runs: [string, boolean][];
}

/**
 * The command palette (Ctrl+K): fuzzy-searches every tool and executable menu
 * command. Empty query shows recently used commands; Enter runs the selection.
 */
export default function CommandPalette({
  commands,
  checks,
  onClose,
}: {
  commands: PaletteCommand[];
  /** Action ids that are checkable toggles → current on/off state. */
  checks?: Record<string, boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [recents] = useState<string[]>(() => loadRecents());

  const q = query.trim();
  const rows = useMemo<Row[]>(() => {
    if (!q) {
      // Recently used, in stored order (drop commands that no longer exist).
      const byKey = new Map(commands.map((c) => [c.key, c]));
      return recents
        .map((k) => byKey.get(k))
        .filter((c): c is PaletteCommand => !!c)
        .map((cmd) => ({ cmd, runs: [[cmd.label, false]] as [string, boolean][] }));
    }
    const scored: { row: Row; score: number }[] = [];
    for (const cmd of commands) {
      const onLabel = fuzzyMatch(q, cmd.label);
      if (onLabel) {
        scored.push({ row: { cmd, runs: highlightRuns(cmd.label, onLabel.indices) }, score: onLabel.score });
        continue;
      }
      // Fall back to "<label> <menu>" so "window layers" / "help docs" work —
      // weaker score, no label highlighting.
      const onBoth = fuzzyMatch(q, `${cmd.label} ${cmd.sub}`);
      if (onBoth) scored.push({ row: { cmd, runs: [[cmd.label, false]] }, score: onBoth.score * 0.5 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.row);
  }, [q, commands, recents]);

  // Keep the highlighted row valid + visible as results change. The reset is
  // adjusted DURING render (React's pattern for state derived from props), so
  // the list never paints the old highlight against new results.
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    setSeenQ(q);
    setHi(0);
  }
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, rows.length]);

  const run = (cmd: PaletteCommand) => {
    pushRecent(cmd.key);
    onClose();
    cmd.run();
  };

  // Escape closes from anywhere (capture phase, like the other dialogs).
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

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Search tools, menus & commands…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded={rows.length > 0}
            /* The combobox has to NAME the list it drives and say which option is
               current, or arrowing through the results announces nothing at all:
               focus stays in the input, so a screen reader has no other way to
               know the highlight moved. */
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? optionId(Math.min(hi, rows.length - 1)) : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (rows.length) setHi((i) => (i + 1) % rows.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (rows.length) setHi((i) => (i - 1 + rows.length) % rows.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[Math.min(hi, rows.length - 1)];
                if (row) run(row.cmd);
              }
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>

        <div className={styles.list} id={LIST_ID} ref={listRef} role="listbox" aria-label="Commands">
          {!q && rows.length > 0 && <span className={styles.groupLabel}>Recently used</span>}
          {rows.map((r, i) => {
            const Icon = r.cmd.icon;
            const checkable = !!(checks && r.cmd.action && r.cmd.action in checks);
            const checked = checkable && !!checks![r.cmd.action!];
            return (
              <button
                key={r.cmd.key}
                type="button"
                className={styles.item}
                id={optionId(i)}
                data-active={i === hi}
                data-idx={i}
                role="option"
                aria-selected={i === hi}
                onMouseEnter={() => setHi(i)}
                onClick={() => run(r.cmd)}
              >
                <span className={styles.icon}>
                  {Icon ? <Icon size={14} /> : !q ? <History size={13} /> : <CornerDownLeft size={13} />}
                </span>
                <span className={styles.label}>
                  {r.runs.map(([text, hl], k) =>
                    hl ? (
                      <b key={k} className={styles.hl}>
                        {text}
                      </b>
                    ) : (
                      <span key={k}>{text}</span>
                    ),
                  )}
                </span>
                {checkable && (
                  <span className={styles.checkDot} aria-label={checked ? "On" : "Off"}>
                    {checked ? <Check size={13} strokeWidth={3} /> : null}
                  </span>
                )}
                <span className={styles.sub}>{r.cmd.sub}</span>
                {r.cmd.shortcut && <span className={styles.shortcut}>{r.cmd.shortcut}</span>}
              </button>
            );
          })}
          {rows.length === 0 && (
            <div className={styles.empty}>
              {q ? (
                <>No commands match “{query}”.</>
              ) : (
                <>Type to search every tool and menu command — try “export”, “curves” or “mask”.</>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
