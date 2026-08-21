"use client";

import { type DragEventHandler, type ReactNode } from "react";
import { ChevronDown, Pin, PinOff, type LucideIcon } from "lucide-react";
import styles from "./RightDock.module.scss";

/** One tab of a grouped frame. `id` is the panel it stands for. */
export interface PanelTab {
  id: string;
  title: string;
  icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
  /** Dragging a TAB is how a panel leaves the group, so each carries its own
   *  drag wiring rather than sharing the frame's. */
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
}

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
  tabs,
  onHeaderDragOver,
  headerDropping,
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
  /** When present the header becomes a TAB STRIP and `children` is the active
   *  tab's body. `title`/`icon` still name the frame for assistive tech. */
  tabs?: PanelTab[];
  /** Dropping ON the header groups rather than reorders; the dock supplies this
   *  and highlights the header while a drag is over it. */
  onHeaderDragOver?: DragEventHandler<HTMLElement>;
  headerDropping?: boolean;
}) {
  const grouped = !!tabs && tabs.length > 1;
  /* A tab has to name the panel it controls, and that panel has to point back,
     or a screen reader announces a row of buttons and a slab of content with
     nothing tying them together. */
  const tabId = (id: string) => `panel-tab-${id}`;
  const bodyId = (id: string) => `panel-tabpanel-${id}`;
  const activeId = tabs?.find((t) => t.active)?.id;
  return (
    <section
      className={styles.panel}
      data-open={open}
      data-dragging={dragging || undefined}
      data-grouped={grouped || undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Only the header is draggable, so sliders/inputs in the body are safe. */}
      <header
        className={styles.panelHead}
        /* Grouping is a drag gesture with nothing on screen to suggest it, and
           the header is the only place a user is already dragging from. */
        title={
          grouped
            ? "Drag a tab out to separate it"
            : "Drag to reorder — or drop onto another panel's header to group them as tabs"
        }
        data-dropping={headerDropping || undefined}
        draggable={grouped ? false : draggable}
        onDragStart={grouped ? undefined : onDragStart}
        onDragEnd={grouped ? undefined : onDragEnd}
        onDragOver={onHeaderDragOver}
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
        {grouped ? (
          <div className={styles.panelTabs} role="tablist" aria-label={`${title} group`}>
            {tabs!.map((t) => {
              const TabIcon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={tabId(t.id)}
                  aria-selected={t.active}
                  aria-controls={bodyId(t.id)}
                  className={styles.panelTab}
                  data-active={t.active || undefined}
                  draggable={t.draggable}
                  onDragStart={t.onDragStart}
                  onDragEnd={t.onDragEnd}
                  onClick={t.onSelect}
                  title={t.title}
                >
                  <TabIcon size={13} />
                  <span>{t.title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            className={styles.panelTitle}
            onClick={onToggle}
            aria-expanded={open}
          >
            <Icon size={14} />
            <span>{title}</span>
          </button>
        )}
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
      {open &&
        (grouped && activeId ? (
          <div
            className={styles.panelBody}
            role="tabpanel"
            id={bodyId(activeId)}
            aria-labelledby={tabId(activeId)}
          >
            {children}
          </div>
        ) : (
          <div className={styles.panelBody}>{children}</div>
        ))}
    </section>
  );
}
