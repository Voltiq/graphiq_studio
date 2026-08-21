"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./ColorPopover.module.scss";
import ColorPicker from "./ColorPicker";
import { uiZoom } from "../lib/ui-scale";
import { clampX } from "../lib/safeArea";

type Align = "bottom-start" | "bottom-end" | "right-start" | "right-end";

export default function ColorPopover({
  color,
  onChange,
  className,
  wrapClassName,
  style,
  title,
  ariaLabel,
  children,
  align = "bottom-start",
}: {
  color: string;
  onChange: (hex8: string) => void;
  className?: string;
  wrapClassName?: string;
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
  children?: ReactNode;
  align?: Align;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Position the (portalled) popover next to the trigger, clamped to the
  // viewport. The portal escapes any overflow-clipping ancestor (the options
  // bar). setPos is GUARDED to bail when the position is unchanged, so it can
  // never feed a render→effect→setState loop.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const pop = popRef.current;
      const btn = btnRef.current;
      if (!btn) return;
      // Zoomed popup: viewport-px math throughout, ÷z when writing styles.
      const z = uiZoom();
      const r = btn.getBoundingClientRect();
      const pw = (pop?.offsetWidth || 248) * z;
      const ph = (pop?.offsetHeight || 320) * z;
      const gap = 8;
      const margin = 8;
      let top: number;
      let left: number;
      switch (align) {
        case "bottom-end":
          top = r.bottom + gap;
          left = r.right - pw;
          break;
        case "right-start":
          left = r.right + gap;
          top = r.top;
          break;
        case "right-end":
          left = r.right + gap;
          top = r.bottom - ph;
          break;
        default: // bottom-start
          top = r.bottom + gap;
          left = r.left;
      }
      left = Math.round(clampX(left, pw, margin)) / z;
      top = Math.round(Math.min(Math.max(margin, top), window.innerHeight - ph - margin)) / z;
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
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
    <div className={`${styles.wrap} ${wrapClassName ?? ""}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={className}
        style={style}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className={styles.popover}
            role="dialog"
            aria-label="Color picker"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <ColorPicker value={color} onChange={onChange} />
          </div>,
          document.body,
        )}
    </div>
  );
}
