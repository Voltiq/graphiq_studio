"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import styles from "./Controls.module.scss";
import { uiZoom } from "../lib/ui-scale";
import { clampX, clampY, visibleBand } from "../lib/safeArea";

/**
 * Custom dropdown — a styled trigger + a portalled, frosted-glass popup that
 * matches the app's menus. Standalone (no ColorPopover/Controls imports) so it
 * can be used from ColorPicker without a circular dependency.
 */
export function Select({
  label,
  options,
  defaultValue,
  width,
  block = false,
  value,
  onChange,
}: {
  label?: string;
  options: string[];
  defaultValue?: string;
  width?: number;
  block?: boolean;
  value?: string;
  onChange?: (s: string) => void;
}) {
  const [internal, setInternal] = useState(defaultValue ?? options[0]);
  const v = value !== undefined ? value : internal;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const set = (s: string) => {
    if (value === undefined) setInternal(s);
    onChange?.(s);
    setOpen(false);
  };

  // Position the portalled menu under (or above) the trigger, clamped on-screen.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      // The popup is UI-scale-zoomed: rects/client coords are viewport px,
      // offset sizes are local px (×z), and style offsets render ×z (÷z).
      const z = uiZoom();
      const r = btn.getBoundingClientRect();
      const ph = (popRef.current?.offsetHeight ?? 0) * z;
      const margin = 8;
      /* Flip above the trigger against the VISIBLE band, not the layout
         viewport: with a keyboard open the bottom third of the page is covered
         and innerHeight says nothing about it, so a menu that "fits" would open
         straight behind the keyboard. The clamp then catches a menu too tall to
         fit either way. */
      const band = visibleBand();
      let top = r.bottom + 4;
      if (top + ph > band.bottom - margin) top = Math.max(band.top + margin, r.top - 4 - ph);
      top = clampY(top, ph, margin);
      /* The menu's own width, the same way the height is read above. The
         trigger's width is only its MINIMUM (`minWidth` below), so clamping by
         the trigger let a menu with longer options overhang the edge it was
         supposed to be clamped to — 12px into a cutout, in the case that found
         this. Falls back to the trigger before the portal has mounted.

         On the first pass this reads the menu's NATURAL width, since minWidth
         is only applied once `pos` exists, so a clamped menu can end up a shade
         further inboard than it strictly needs to be. That only affects menus
         that are being clamped at all — an unclamped one still sits flush to
         its trigger — and it errs inside the edge rather than over it. */
      const pw = (popRef.current?.offsetWidth ?? 0) * z || r.width;
      const left = clampX(r.left, pw, margin);
      setPos({ top: top / z, left: left / z, width: r.width / z });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.select} data-block={block || undefined}>
      {label && <span className={styles.label}>{label}</span>}
      <button
        ref={btnRef}
        type="button"
        className={styles.selectBox}
        style={width ? { width } : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.selectValue}>{v}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className={styles.selectMenu}
            role="listbox"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              minWidth: pos?.width,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {options.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === v}
                className={styles.selectOption}
                data-active={o === v}
                onClick={() => set(o)}
              >
                <span>{o}</span>
                {o === v && <Check size={14} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
