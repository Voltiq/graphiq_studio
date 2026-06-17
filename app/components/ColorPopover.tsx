"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./ColorPopover.module.scss";
import ColorPicker from "./ColorPicker";

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
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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
      {open && (
        <div className={`${styles.popover} ${styles[align]}`} role="dialog" aria-label="Color picker">
          <ColorPicker value={color} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
