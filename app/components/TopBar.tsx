"use client";

import { useEffect, useRef, useState } from "react";
import { Aperture, Redo2, Search, Share2, Undo2 } from "lucide-react";
import styles from "./TopBar.module.scss";
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
}: {
  initialTheme: Theme;
  onMenuAction?: (action: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
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
          <Aperture size={18} />
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
                {menu.items.map((item, i) => (
                  <div key={`${item.label}-${i}`}>
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => {
                        setOpen(null);
                        if (item.action) onMenuAction?.(item.action);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span className={styles.shortcut}>{item.shortcut}</span>
                      )}
                    </button>
                    {item.separatorAfter && <div className={styles.menuSep} />}
                  </div>
                ))}
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
