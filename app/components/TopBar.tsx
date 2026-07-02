"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownLeft, Redo2, Search, Undo2, type LucideIcon } from "lucide-react";
import styles from "./TopBar.module.scss";
import logo from "../icon.png";
import { MENUS } from "../lib/menus";
import { TOOL_GROUPS, type ToolId } from "../lib/tools";

/** One searchable command: a tool or an executable menu item. */
interface Command {
  key: string;
  label: string;
  sub: string; // "Tool" or "<Menu> menu"
  shortcut?: string;
  icon?: LucideIcon;
  run: () => void;
}

export default function TopBar({
  onMenuAction,
  onSelectTool,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  checks,
}: {
  onMenuAction?: (action: string) => void;
  onSelectTool?: (id: ToolId) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Action ids that are checkable toggles → current on/off state. */
  checks?: Record<string, boolean>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // ---- Search (tools + every executable menu item) --------------------------
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    for (const t of TOOL_GROUPS.flat()) {
      out.push({
        key: `tool:${t.id}`,
        label: t.name,
        sub: "Tool",
        shortcut: t.shortcut,
        icon: t.icon,
        run: () => onSelectTool?.(t.id),
      });
    }
    for (const menu of MENUS) {
      for (const item of menu.items) {
        if (!item.action || item.disabled) continue; // placeholders aren't runnable
        const action = item.action;
        out.push({
          key: `menu:${action}:${item.label}`,
          label: item.label.replace(/…$/, ""),
          sub: `${menu.label} menu`,
          shortcut: item.shortcut,
          run: () => onMenuAction?.(action),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    const starts: Command[] = [];
    const contains: Command[] = [];
    for (const c of commands) {
      const label = c.label.toLowerCase();
      if (label.startsWith(q)) starts.push(c);
      else if (
        label.includes(q) ||
        c.sub.toLowerCase().includes(q) ||
        (c.shortcut ?? "").toLowerCase().includes(q)
      )
        contains.push(c);
    }
    return [...starts, ...contains].slice(0, 10);
  }, [q, commands]);

  const closeSearch = () => {
    setQuery("");
    setHi(0);
  };
  const runCommand = (c: Command) => {
    closeSearch();
    inputRef.current?.blur();
    c.run();
  };

  // Close results on an outside click.
  useEffect(() => {
    if (!q) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) closeSearch();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [q]);

  // Close menus on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <span className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo.src} alt="Graphiq Studio" />
        </span>
        <span className={styles.brandName}>Graphiq</span>
        <span className={styles.brandTag}>Studio</span>
      </div>

      <nav className={styles.menubar} ref={barRef}>
        {MENUS.map((menu) => (
          <div key={menu.label} className={styles.menuRoot}>
            <button
              type="button"
              className={styles.menuButton}
              data-active={open === menu.label}
              onClick={() => setOpen((o) => (o === menu.label ? null : menu.label))}
              onMouseEnter={() => open && setOpen(menu.label)}
            >
              {menu.label}
            </button>
            {open === menu.label && (
              <div className={styles.dropdown} role="menu">
                {menu.items.map((item, i) => {
                  const checkable = item.action != null && checks != null && item.action in checks;
                  const checked = checkable && !!checks?.[item.action!];
                  return (
                    <div key={`${item.label}-${i}`}>
                      <button
                        type="button"
                        className={styles.menuItem}
                        role={checkable ? "menuitemcheckbox" : "menuitem"}
                        aria-checked={checkable ? checked : undefined}
                        disabled={item.disabled}
                        onClick={() => {
                          if (item.action) onMenuAction?.(item.action);
                          // Keep the menu open when flipping a toggle; close otherwise.
                          if (!checkable) setOpen(null);
                        }}
                      >
                        <span className={styles.menuLabel}>
                          {checkable && (
                            <span className={styles.menuCheck} data-on={checked}>
                              <Check size={12} strokeWidth={3} />
                            </span>
                          )}
                          {item.label}
                        </span>
                        {item.shortcut && (
                          <span className={styles.shortcut}>{item.shortcut}</span>
                        )}
                      </button>
                      {item.separatorAfter && <div className={styles.menuSep} />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconBtn}
          title="Undo (Ctrl+Z)"
          onClick={onUndo}
          disabled={!canUndo}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="Redo (Ctrl+Shift+Z)"
          onClick={onRedo}
          disabled={!canRedo}
        >
          <Redo2 size={16} />
        </button>

        <div className={styles.searchWrap} ref={searchRef}>
          <div className={styles.search}>
            <Search size={14} />
            <input
              ref={inputRef}
              placeholder="Search tools & menus…"
              aria-label="Search tools and menus"
              role="combobox"
              aria-expanded={results.length > 0}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (!results.length) {
                  if (e.key === "Escape") {
                    closeSearch();
                    inputRef.current?.blur();
                  }
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((i) => (i + 1) % results.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((i) => (i - 1 + results.length) % results.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  runCommand(results[Math.min(hi, results.length - 1)]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                  inputRef.current?.blur();
                }
              }}
            />
          </div>

          {results.length > 0 && (
            <div className={styles.searchResults} role="listbox" aria-label="Search results">
              {results.map((c, i) => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={styles.searchItem}
                    data-active={i === hi}
                    role="option"
                    aria-selected={i === hi}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => runCommand(c)}
                  >
                    <span className={styles.searchIcon}>
                      {Icon ? <Icon size={14} /> : <CornerDownLeft size={13} />}
                    </span>
                    <span className={styles.searchLabel}>{c.label}</span>
                    <span className={styles.searchSub}>{c.sub}</span>
                    {c.shortcut && <span className={styles.shortcut}>{c.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {q.length > 0 && results.length === 0 && (
            <div className={styles.searchResults}>
              <span className={styles.searchEmpty}>No matches for “{query}”.</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
