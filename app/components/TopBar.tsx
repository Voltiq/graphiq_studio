"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Menu as MenuIcon, PanelRight, Redo2, Search, Undo2, X } from "lucide-react";
import styles from "./TopBar.module.scss";
import { registerDismissible } from "../lib/dismiss";
import logo from "../icon.png";
import ThemeToggle from "./ThemeToggle";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import { MENUS } from "../lib/menus";
import { buildPaletteCommands } from "../lib/palette";
import { type ToolId } from "../lib/tools";
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
  mobile = false,
  tablet = false,
  panelsOpen = false,
  onTogglePanels,
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
  /** On mobile the inline menubar collapses behind a hamburger, the brand text
   *  and search hint hide, and the menus open as a full-height sheet. */
  mobile?: boolean;
  /** A touch device that is not a phone: the panels dock is an overlay there,
   *  so it needs something to open it — the phone has the MobileBar for that
   *  and a desktop has the dock permanently in flow. */
  tablet?: boolean;
  panelsOpen?: boolean;
  onTogglePanels?: () => void;
}) {
  // The registry's effective label, falling back to the static default.
  const keyFor = (kind: "menu" | "tool", id: string, fallback?: string): string | undefined => {
    const v = shortcutLabels?.[`${kind}:${id}`];
    if (v === undefined) return fallback;
    return v || undefined; // "" = explicitly unbound → show nothing
  };
  /* Both touch shells collapse the menubar behind the hamburger: at the 44px
     floor its ten names alone are 593px, and the whole bar wanted 1123 — wider
     than an iPad Pro. See globals.scss. */
  const touchShell = mobile || tablet;
  const [open, setOpen] = useState<string | null>(null);
  // Mobile menu sheet (the collapsed menubar behind the hamburger).
  const [sheetOpen, setSheetOpen] = useState(false);
  /* While the sheet is up it absorbs the back gesture, instead of the gesture
     leaving the editor. It keeps its own state; only the way to close it is
     shared. */
  useEffect(() => {
    if (!sheetOpen) return;
    return registerDismissible(() => setSheetOpen(false));
  }, [sheetOpen]);
  const barRef = useRef<HTMLDivElement>(null);
  // Back to desktop → drop any open sheet so its fixed overlay can't linger.
  useEffect(() => {
    if (!touchShell) {
      setSheetOpen(false);
      setOpen(null);
    }
  }, [touchShell]);

  // ---- Command palette (Ctrl+K): every tool + executable menu item ----------
  const [paletteOpen, setPaletteOpen] = useState(false);

  /* Built by a pure function in ../lib/palette so the coverage property —
     nothing the menus offer is missing from search — is unit-testable without
     rendering the editor. See tests/palette.test.ts. */
  const commands = useMemo<PaletteCommand[]>(
    () => buildPaletteCommands({ keyFor, onSelectTool, onMenuAction }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shortcutLabels, onSelectTool, onMenuAction],
  );

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

  // Fire a menu action and, on mobile, dismiss the whole sheet — unless it's a
  // checkable toggle (View ▸ Grid etc.), where staying open lets you flip more.
  const runMenuAction = (action: string, keepOpen: boolean) => {
    onMenuAction?.(action);
    if (touchShell && !keepOpen) {
      setOpen(null);
      setSheetOpen(false);
    }
  };

  return (
    <header className={styles.topbar} data-tour="topbar">
      {touchShell && (
        <button
          type="button"
          className={styles.hamburger}
          aria-label="Menu"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((s) => !s)}
        >
          {sheetOpen ? <X size={18} /> : <MenuIcon size={18} />}
        </button>
      )}
      <div className={styles.brand}>
        <span className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo.src} alt="Graphiq Studio" />
        </span>
        {!mobile && (
          <>
            <span className={styles.brandName}>Graphiq</span>
            <span className={styles.brandTag}>Studio</span>
            <span className={styles.brandDot} aria-hidden />
          </>
        )}
      </div>

      {touchShell && sheetOpen && <div className={styles.sheetScrim} onClick={() => setSheetOpen(false)} />}
      <nav className={styles.menubar} data-menubar data-sheet={touchShell && sheetOpen ? "true" : undefined} ref={barRef}>
        {/* Search leads the sheet, because browsing ten menus to find one of
            151 commands is the slow path and should not be the only path
            offered. Wrapped in a .menuRoot so it picks up the sheet's row
            metrics rather than needing its own. */}
        {touchShell && sheetOpen && (
          <div className={styles.menuRoot}>
            <button
              type="button"
              className={styles.sheetSearch}
              data-sheet-search
              onClick={() => {
                setSheetOpen(false);
                setPaletteOpen(true);
              }}
            >
              <Search size={16} />
              <span>Search all commands…</span>
            </button>
          </div>
        )}
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
                          if (item.action) runMenuAction(item.action, checkable);
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
          <Search size={touchShell ? 15 : 14} />
          {touchShell ? (
            /* A word, not an icon. As an unlabelled magnifier among five other
               icon buttons this was the least likely thing on the bar to be
               tried, which is the wrong outcome for the fastest way into 151
               menu commands. The keyboard hint is dropped — there is no
               Ctrl+K on a phone. */
            <span className={styles.searchLabel}>Search</span>
          ) : (
            <>
              <span className={styles.searchHint}>Search tools &amp; menus…</span>
              <kbd className={styles.searchKbd}>Ctrl+K</kbd>
            </>
          )}
        </button>

        {tablet && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onTogglePanels}
            aria-label="Panels"
            aria-pressed={panelsOpen}
            data-panels-toggle
            data-open={panelsOpen || undefined}
            title="Panels"
          >
            <PanelRight size={16} />
          </button>
        )}

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
