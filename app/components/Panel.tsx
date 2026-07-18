"use client";

import { type DragEventHandler, type ReactNode } from "react";
import { ChevronDown, Pin, PinOff, type LucideIcon } from "lucide-react";
import styles from "./RightDock.module.scss";

export default function Panel({
  title,
  icon: Icon,
  open,
  onToggle,
  actions,
  children,
  draggable,
  dragging,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  floating,
  onFloat,
}: {
  title: string;
  icon: LucideIcon;
  /** Collapsed/expanded state (owned & persisted by the parent dock). */
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Drag-to-reorder wiring (applied to the section; the header is the handle). */
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragOver?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
  /** Float/dock toggle (the pin button). */
  floating?: boolean;
  onFloat?: () => void;
}) {
  return (
    <section
      className={styles.panel}
      data-open={open}
      data-dragging={dragging || undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Only the header is draggable, so sliders/inputs in the body are safe. */}
      <header
        className={styles.panelHead}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <button
          type="button"
          className={styles.panelCaret}
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
        >
          <ChevronDown className={styles.chevron} size={16} />
        </button>
        <button
          type="button"
          className={styles.panelTitle}
          onClick={onToggle}
          aria-expanded={open}
        >
          <Icon size={14} />
          <span>{title}</span>
        </button>
        <div className={styles.panelActions}>
          {actions}
          {onFloat && (
            <button
              type="button"
              className={styles.headBtn}
              title={floating ? "Dock this panel back" : "Float this panel over the canvas"}
              aria-label={floating ? `Dock ${title}` : `Float ${title}`}
              onClick={onFloat}
            >
              {floating ? <Pin size={13} /> : <PinOff size={13} />}
            </button>
          )}
        </div>
      </header>
      {open && <div className={styles.panelBody}>{children}</div>}
    </section>
  );
}
