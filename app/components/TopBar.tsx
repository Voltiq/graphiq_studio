"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, PanelRight, X } from "lucide-react";
import { Check, Download, Menu as MenuIcon, Redo2, Search, Undo2 } from "../lib/icons";
import styles from "./TopBar.module.scss";
import { registerDismissible } from "../lib/dismiss";
import { exitProps, useLinger, usePresence } from "../lib/use-presence";
import logo from "../icon.png";
import ThemeToggle from "./ThemeToggle";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";
import { MENUS, type MenuItem } from "../lib/menus";
import { uiZoom } from "../lib/ui-scale";
import { buildPaletteCommands } from "../lib/palette";
import { type ToolId } from "../lib/tools";
import { DEFAULT_THEME, type Theme } from "../lib/theme";

/** A menu's rows split at each `column` marker, keeping their original index. */
function columnsOf(items: readonly MenuItem[]): { item: MenuItem; i: number }[][] {
  const cols: { item: MenuItem; i: number }[][] = [[]];
  items.forEach((item, i) => {
    if (item.column && cols[cols.length - 1].length) cols.push([]);
    cols[cols.length - 1].push({ item, i });
  });
  return cols;
}

export default function TopBar({
  onMenuAction,
  onSelectTool,
  initialTheme = DEFAULT_THEME,
  blocked,
  checks,
  shortcutLabels,
  mobile = false,
  tablet = false,
  panelsOpen = false,
  onTogglePanels,
  docs = [],
  activeDocId,
  onSelectDoc,
  saved = true,
}: {
  onMenuAction?: (action: string) => void;
  onSelectTool?: (id: ToolId) => void;
  initialTheme?: Theme;
  /** The commands that do not apply right now, each with why (command id →
   *  reason) — commands/registry.ts. Asked on every render, so a menu greys
   *  what applies at the moment it opens. */
  blocked?: () => Readonly<Record<string, string>>;
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
  /** Phone: the open documents, for the name in the header and its menu. */
  docs?: { id: string; name: string }[];
  activeDocId?: string;
  onSelectDoc?: (id: string) => void;
  /** Whether the active document's work is saved (an unsaved dot otherwise). */
  saved?: boolean;
}) {
  // The registry's effective label, falling back to the static default.
  const keyFor = (kind: "menu" | "tool", id: string, fallback?: string): string | undefined => {
    const v = shortcutLabels?.[`${kind}:${id}`];
    if (v === undefined) return fallback;
    return v || undefined; // "" = explicitly unbound → show nothing
  };
  /* What does not apply right now, and why: one answer for the menus, the
     phone's document menu, the palette and the header's undo/redo. A greyed
     row still runs — the editor answers with the reason, as it did before
     rows greyed — so greying only ever adds information. */
  const unavailable = blocked?.() ?? {};
  /* Both touch shells collapse the menubar behind the hamburger: at the 44px
     floor its ten names alone are 593px, and the whole bar wanted 1123 — wider
     than an iPad Pro. See globals.scss. */
  const touchShell = mobile || tablet;
  const [open, setOpen] = useState<string | null>(null);
  /* A menu opening from nothing animates in, and out again when it closes;
     sweeping the pointer along the bar from one menu to the next is a swap,
     and swaps are instant (`data-instant`). */
  const { shown: shownMenu, closing: menuClosing } = useLinger(open);
  const [prevMenu, setPrevMenu] = useState<string | null>(open);
  const [menuSwap, setMenuSwap] = useState(false);
  if (open !== prevMenu) {
    setMenuSwap(open !== null && prevMenu !== null);
    setPrevMenu(open);
  }
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
  const dropRef = useRef<HTMLDivElement>(null);
  /* Phone: the document menu under the name in the header — switch between
     open documents, start one, rename or close this one. */
  const [docMenu, setDocMenu] = useState(false);
  const { mounted: docMenuShown, closing: docMenuClosing } = usePresence(docMenu);
  const docRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!docMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!docRef.current?.contains(e.target as Node)) setDocMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDocMenu(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    const undo = registerDismissible(() => setDocMenu(false));
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      undo();
    };
  }, [docMenu]);
  const docName = docs.find((d) => d.id === activeDocId)?.name ?? "";
  const docAction = (action: string) => {
    setDocMenu(false);
    onMenuAction?.(action);
  };
  /* A wide (multi-column) dropdown opened from a menu name far to the right
     would run off the screen; nudge it back inside, keeping an 8px margin. Its
     offsets render through the bar's UI zoom, so the shift is divided by it.
     Written straight to the element: it is a measurement of this paint, not
     state anything else reads. */
  useLayoutEffect(() => {
    const el = dropRef.current;
    if (!open || !el || touchShell) return;
    el.style.translate = "";
    const over = el.getBoundingClientRect().right - document.documentElement.clientWidth + 8;
    if (over > 0) el.style.translate = `${-over / uiZoom()}px 0`;
  }, [open, touchShell]);
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

  /* Desktop: a field centred in the bar, as in the design. Touch: a compact
     button among the actions (a word, not a hint — see below). */
  const searchButton = (
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
          <span className={styles.searchHint}>Search tools, filters and commands</span>
          <kbd className={styles.searchKbd}>Ctrl+K</kbd>
        </>
      )}
    </button>
  );

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
      {mobile ? (
        /* Phone: the document's name stands where the brand would — the one
           thing worth the width — with a dot while it has unsaved work, and
           its menu behind it. */
        <div className={styles.docRoot} ref={docRef}>
          <button
            type="button"
            className={styles.docTitle}
            aria-haspopup="menu"
            aria-expanded={docMenu}
            aria-label={`${docName}${saved ? "" : ", unsaved changes"} — document menu`}
            onClick={() => setDocMenu((o) => !o)}
          >
            <span className={styles.docName}>{docName}</span>
            {!saved && <span className={styles.docDirty} aria-hidden />}
            <ChevronDown size={16} className={styles.docChevron} />
          </button>
          {docMenuShown && (
            <div className={styles.docMenu} role="menu" aria-label="Documents" {...exitProps(docMenuClosing)}>
              {docs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={d.id === activeDocId}
                  className={styles.menuItem}
                  onClick={() => {
                    setDocMenu(false);
                    onSelectDoc?.(d.id);
                  }}
                >
                  <span className={styles.menuLabel}>{d.name}</span>
                  {d.id === activeDocId && <Check size={15} className={styles.docCheck} />}
                </button>
              ))}
              <div className={styles.menuSep} />
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => docAction("new-doc")}>
                <span className={styles.menuLabel}>New document…</span>
              </button>
              <button type="button" role="menuitem" className={styles.menuItem} onClick={() => docAction("doc-rename")}>
                <span className={styles.menuLabel}>Rename…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                aria-disabled={unavailable["doc-close"] ? true : undefined}
                data-tip={unavailable["doc-close"]}
                onClick={() => docAction("doc-close")}
              >
                <span className={styles.menuLabel}>Close</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.brand}>
          <span className={styles.logo}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo.src} alt="Graphiq Studio" />
          </span>
          <span className={styles.brandName}>Graphiq</span>
        </div>
      )}

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
            {shownMenu === menu.label && (
              <div
                ref={menuClosing ? undefined : dropRef}
                className={styles.dropdown}
                {...exitProps(menuClosing)}
                data-instant={menuSwap || undefined}
                role="menu"
                data-columns={columnsOf(menu.items).length > 1 || undefined}
              >
                {columnsOf(menu.items).map((col, c) => (
                  <div key={c} className={styles.menuCol} role="none" data-menu-col>
                    {col.map(({ item, i }) => {
                      const checkable = item.action != null && checks != null && item.action in checks;
                      const checked = checkable && !!checks?.[item.action!];
                      const why = item.action ? unavailable[item.action] : undefined;
                      return (
                        <div key={`${item.label}-${i}`} role="none">
                          {item.group && (
                            <div className={styles.menuGroup} role="presentation">
                              {item.group}
                            </div>
                          )}
                          <button
                            type="button"
                            className={styles.menuItem}
                            role={checkable ? "menuitemcheckbox" : "menuitem"}
                            aria-checked={checkable ? checked : undefined}
                            aria-disabled={why ? true : undefined}
                            data-tip={why}
                            onClick={() => {
                              if (item.action) runMenuAction(item.action, checkable);
                              // Keep the menu open when flipping a toggle; close otherwise.
                              if (!checkable) setOpen(null);
                            }}
                          >
                            <span className={styles.menuLabel}>{item.label}</span>
                            <span className={styles.menuEnd}>
                              {(() => {
                                const k = item.action
                                  ? keyFor("menu", item.action, item.shortcut)
                                  : item.shortcut;
                                return k ? <span className={styles.shortcut}>{k}</span> : null;
                              })()}
                              {/* A toggle row ends in a small switch showing its
                                  state, so rows never indent for a check slot. */}
                              {checkable && <span className={styles.menuSwitch} data-on={checked} aria-hidden />}
                            </span>
                          </button>
                          {item.separatorAfter && <div className={styles.menuSep} />}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      {!touchShell && searchButton}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconBtn}
          title="Undo (Ctrl+Z)"
          onClick={() => onMenuAction?.("undo")}
          disabled={"undo" in unavailable}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          title="Redo (Ctrl+Shift+Z)"
          onClick={() => onMenuAction?.("redo")}
          disabled={"redo" in unavailable}
        >
          <Redo2 size={16} />
        </button>

        {/* The tablet keeps a search button in the bar; the phone's is the
            first row of the menu sheet, as in the design. */}
        {tablet && searchButton}

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

        {!mobile && <ThemeToggle initialTheme={initialTheme} />}

        {/* The one primary action the bar carries: export the picture. */}
        {(!touchShell || mobile) && (
          <>
            {!mobile && <span className={styles.vsep} aria-hidden />}
            <button
              type="button"
              className={styles.export}
              data-tour="export"
              onClick={() => onMenuAction?.("export-as")}
              title="Export as… (Ctrl+Shift+E)"
            >
              <Download size={15} />
              Export
            </button>
          </>
        )}

        {paletteOpen && (
          <CommandPalette
            commands={commands}
            checks={checks}
            blocked={unavailable}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>
    </header>
  );
}
