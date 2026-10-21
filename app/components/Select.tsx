"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { Check } from "../lib/icons";
import styles from "./Controls.module.scss";
import { uiZoom } from "../lib/ui-scale";
import { clampX, clampY, visibleBand } from "../lib/safeArea";
import { exitProps, usePresence } from "../lib/use-presence";

/** An option that shows something other than its value, optionally under a
 *  heading. A plain string is its own value and label. */
export interface SelectOption {
  value: string;
  label: string;
  /** Drawn as a heading above the first option of each run of one group. */
  group?: string;
}

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
  variant,
  ariaLabel,
  placeholder,
}: {
  label?: string;
  options: readonly (string | SelectOption)[];
  defaultValue?: string;
  width?: number;
  block?: boolean;
  value?: string;
  onChange?: (s: string) => void;
  /** "inline": a bare label + chevron with no field chrome, for a select that
   *  lives INSIDE another field (the colour panel's value format). */
  variant?: "inline";
  ariaLabel?: string;
  /** What the trigger says while the value matches no option — an action menu
   *  ("Apply a preset…") keeps its value empty and always shows this. */
  placeholder?: string;
}) {
  const opts = options.map((o): SelectOption => (typeof o === "string" ? { value: o, label: o } : o));
  const [internal, setInternal] = useState(defaultValue ?? opts[0]?.value);
  const v = value !== undefined ? value : internal;
  const current = opts.find((o) => o.value === v);
  const shown = current?.label ?? placeholder ?? v;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; origin: string } | null>(null);
  // Still drawn for its exit after it closes.
  const { mounted, closing } = usePresence(open);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Opened from the keyboard: move focus onto the chosen option once shown. */
  const focusOnOpen = useRef(false);

  /** `byKey`: chosen from the keyboard, so focus goes back to the trigger, as
   *  a native select's does. Not after a click — a focused trigger would turn
   *  the next Space (the hand tool, on the canvas) into reopening the list. */
  const set = (s: string, byKey = false) => {
    if (value === undefined) setInternal(s);
    onChange?.(s);
    setOpen(false);
    if (byKey) btnRef.current?.focus();
  };
  const optionButtons = () => [...(popRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];

  /* Keyboard, as a native select. These keys belong to the list, so they stop
     here: a dialog hosting it must not also read Escape as "close the dialog"
     or Enter as its default action (Export used to export). React carries a
     portal's events up through its React parents, so the list needs this as
     much as the trigger does. */
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation(); // the button's click opens it
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusOnOpen.current = true;
      setOpen(true);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const items = optionButtons();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const to =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : e.key === "ArrowDown"
              ? Math.min(items.length - 1, i + 1)
              : Math.max(0, i - 1);
      items[to]?.focus();
    } else if (e.key === "Escape") {
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key !== "Enter" && e.key !== " ") return;
    e.stopPropagation();
  };

  // Opened from the keyboard: land on the chosen option (or the first) once the
  // list is placed — it is invisible until then, and a hidden one takes no focus.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    const items = optionButtons();
    const target = items.find((b) => b.getAttribute("aria-selected") === "true") ?? items[0];
    target?.focus();
    if (target && document.activeElement === target) focusOnOpen.current = false;
  }, [open, pos]);

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
      /* It opens out of its trigger: from the trigger's middle, at the edge
         it hangs from — the bottom when it had to flip above. */
      const origin = `${(r.left + r.width / 2 - left) / z}px ${top < r.top ? "100%" : "0px"}`;
      setPos({ top: top / z, left: left / z, width: r.width / z, origin });
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
    <div className={styles.select} data-block={block || undefined} data-variant={variant}>
      {label && <span className={styles.label}>{label}</span>}
      <button
        ref={btnRef}
        type="button"
        className={styles.selectBox}
        style={width ? { width } : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${shown}` : undefined}
        onClick={(e) => {
          focusOnOpen.current = e.detail === 0; // 0: Enter or Space, not a pointer
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKey}
      >
        <span className={styles.selectValue} data-placeholder={(!current && placeholder !== undefined) || undefined}>
          {shown}
        </span>
        <ChevronDown size={variant === "inline" ? 12 : 14} />
      </button>
      {mounted &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className={styles.selectMenu}
            role="listbox"
            {...exitProps(closing)}
            onKeyDown={onListKey}
            // Tabbing out of the list closes it, as leaving a native one does.
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (!popRef.current?.contains(to) && to !== btnRef.current) setOpen(false);
            }}
            style={
              {
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                minWidth: pos?.width,
                visibility: pos ? "visible" : "hidden",
                "--origin": pos?.origin,
              } as React.CSSProperties
            }
          >
            {opts.map((o, i) => (
              <Fragment key={o.value}>
                {o.group && o.group !== opts[i - 1]?.group && (
                  <div className={styles.selectGroup} role="presentation">
                    {o.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === v}
                  className={styles.selectOption}
                  data-active={o.value === v}
                  onClick={(e) => set(o.value, e.detail === 0)}
                >
                  <span>{o.label}</span>
                  {o.value === v && <Check size={14} />}
                </button>
              </Fragment>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
