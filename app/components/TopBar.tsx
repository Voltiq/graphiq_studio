"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Redo2, Search, Share2, Undo2 } from "lucide-react";
import styles from "./TopBar.module.scss";
import logo from "../icon.png";
import { MENUS } from "../lib/menus";
import ThemeToggle from "./ThemeToggle";
import type { Theme } from "../lib/theme";

export default function TopBar({
  initialTheme,
  onMenuAction,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  checks,
}: {
  initialTheme: Theme;
  onMenuAction?: (action: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Action ids that are checkable toggles → current on/off state. */
  checks?: Record<string, boolean>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

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
          <img src={logo.src} alt="Aperture" />
        </span>
        <span className={styles.brandName}>Aperture</span>
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

        <div className={styles.search}>
          <Search size={14} />
          <input placeholder="Search tools & menus…" aria-label="Search" />
        </div>

        <ThemeToggle initialTheme={initialTheme} />

        <button type="button" className={styles.shareBtn}>
          <Share2 size={14} />
          Share
        </button>

        <div className={styles.avatar} title="Account" aria-hidden>
          V
        </div>
      </div>
    </header>
  );
}
