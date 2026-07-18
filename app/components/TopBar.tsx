"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Redo2, Search, Undo2 } from "lucide-react";
import styles from "./TopBar.module.scss";
import logo from "../icon.png";
import ThemeToggle from "./ThemeToggle";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import { MENUS } from "../lib/menus";
import { TOOL_GROUPS, type ToolId } from "../lib/tools";
import { DEFAULT_THEME, type Theme } from "../lib/theme";

export default function TopBar({
  onMenuAction,
  onSelectTool,
  initialTheme = DEFAULT_THEME,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  checks,
  shortcutLabels,
}: {
  onMenuAction?: (action: string) => void;
  onSelectTool?: (id: ToolId) => void;
  initialTheme?: Theme;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Action ids that are checkable toggles → current on/off state. */
  checks?: Record<string, boolean>;
  /** Effective shortcut labels from the registry ("menu:<action>"/"tool:<id>"
   *  → "Ctrl+Z"; "" = unbound). Menus/palette show THESE, so remaps are live. */
  shortcutLabels?: Record<string, string>;
}) {
  // The registry's effective label, falling back to the static default.
  const keyFor = (kind: "menu" | "tool", id: string, fallback?: string): string | undefined => {
    const v = shortcutLabels?.[`${kind}:${id}`];
    if (v === undefined) return fallback;
    return v || undefined; // "" = explicitly unbound → show nothing
  };
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // ---- Command palette (Ctrl+K): every tool + executable menu item ----------
  const [paletteOpen, setPaletteOpen] = useState(false);

  const commands = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = [];
    for (const t of TOOL_GROUPS.flat()) {
      out.push({
        key: `tool:${t.id}`,
        label: t.name,
        sub: "Tool",
        shortcut: keyFor("tool", t.id, t.shortcut),
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
          shortcut: keyFor("menu", action, item.shortcut),
          action,
          run: () => onMenuAction?.(action),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcutLabels]);

  // Ctrl+K opens the palette (the chip in the pill advertises it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    <header className={styles.topbar} data-tour="topbar">
      <div className={styles.brand}>
        <span className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo.src} alt="Graphiq Studio" />
        </span>
        <span className={styles.brandName}>Graphiq</span>
        <span className={styles.brandTag}>Studio</span>
        <span className={styles.brandDot} aria-hidden />
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
                        {(() => {
                          const k = item.action
                            ? keyFor("menu", item.action, item.shortcut)
                            : item.shortcut;
                          return k ? <span className={styles.shortcut}>{k}</span> : null;
                        })()}
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

        <button
          type="button"
          className={`${styles.search} ${styles.searchButton}`}
          onClick={() => setPaletteOpen(true)}
          aria-label="Open the command palette"
          title="Command palette (Ctrl+K)"
        >
          <Search size={14} />
          <span className={styles.searchHint}>Search tools &amp; menus…</span>
          <kbd className={styles.searchKbd}>Ctrl+K</kbd>
        </button>

        <ThemeToggle initialTheme={initialTheme} />

        {paletteOpen && (
          <CommandPalette
            commands={commands}
            checks={checks}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
    </header>
  );
}
