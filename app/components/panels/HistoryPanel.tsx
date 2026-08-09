"use client";

import { useEffect, useRef } from "react";
import {
  Activity,
  ArrowDownToLine,
  Blend,
  BoxSelect,
  Brush,
  Camera,
  ClipboardPaste,
  Copy,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  FolderPlus,
  Frame,
  History,
  Image as ImageIcon,
  ImagePlus,
  Layers,
  Maximize2,
  Move,
  PaintBucket,
  Pencil,
  PenTool,
  Plus,
  RotateCcw,
  RotateCw,
  Scaling,
  Scissors,
  Shapes,
  SlidersHorizontal,
  SquareDashed,
  Trash2,
  Ungroup,
  type LucideIcon,
} from "lucide-react";
import styles from "../RightDock.module.scss";

/** Pick a fitting icon for a history step from its label. */
function iconForStep(label: string, isFirst: boolean): LucideIcon {
  if (isFirst) return ImageIcon; // the initial document state ("New")
  const l = label.toLowerCase();
  if (l.includes("pencil")) return Pencil;
  if (l.includes("brush")) return Brush;
  if (l.includes("eras")) return Eraser; // Erase
  if (l.includes("fill")) return PaintBucket;
  if (l.includes("gradient")) return Blend;
  if (l.includes("path")) return PenTool;
  if (l.includes("shape")) return Shapes;
  if (l.includes("cut")) return Scissors;
  if (l.includes("deselect")) return SquareDashed; // Deselect
  if (l.includes("invert")) return Frame; // Invert Selection
  if (l.includes("reselect") || l.includes("select")) return BoxSelect; // Select All / Reselect
  if (l.includes("delete")) return Trash2; // Delete / Delete Layer(s)
  if (l.includes("adjust")) return SlidersHorizontal; // Adjustments
  if (l.includes("flip") && l.includes("vertical")) return FlipVertical2;
  if (l.includes("flip")) return FlipHorizontal2; // Flip Horizontal
  if (l.includes("rotate") && l.includes("ccw")) return RotateCcw;
  if (l.includes("rotate")) return RotateCw;
  if (l.includes("scale")) return Scaling;
  if (l.includes("resize")) return Maximize2;
  if (l.includes("move")) return Move;
  if (l.includes("paste")) return ClipboardPaste;
  if (l.includes("import")) return ImagePlus;
  if (l.includes("duplicate")) return Copy;
  if (l.includes("ungroup")) return Ungroup; // before "group"
  if (l.includes("group")) return FolderPlus;
  if (l.includes("merge")) return ArrowDownToLine;
  if (l.includes("flatten")) return Layers;
  if (l.includes("new layer")) return Plus;
  return Activity; // generic fallback
}

// A history row: 24px icon + 6px padding top/bottom = 36px, with a 2px gap.
const ITEM_H = 36;
const GAP = 2;

export default function HistoryPanel({
  items,
  index,
  sourceIndex,
  onJump,
  onSetSource,
  snapshots = [],
  sourceSnapshotId = null,
  onTakeSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
  onSetSourceSnapshot,
  maxRows = 25,
}: {
  items: { label: string }[];
  index: number;
  /** The state the History brush repaints from (0 = the original). */
  sourceIndex: number;
  onJump: (index: number) => void;
  onSetSource: (index: number) => void;
  /** Pinned full-state snapshots, oldest first. */
  snapshots?: { id: string; label: string }[];
  /** When set, the History brush sources from this snapshot, not a step. */
  sourceSnapshotId?: string | null;
  onTakeSnapshot?: () => void;
  onRestoreSnapshot?: (id: string) => void;
  onDeleteSnapshot?: (id: string) => void;
  onSetSourceSnapshot?: (id: string | null) => void;
  /** Rows shown before the list becomes scrollable. */
  maxRows?: number;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);

  // Keep the current step visible as it changes (no-op if already in view).
  // Scroll ONLY this list — `scrollIntoView` would also nudge every scrollable
  // ancestor (the whole panel dock), yanking the dock to the History panel on
  // each step; here we adjust just the list's own scrollTop.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !active) return;
    const lr = list.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    if (ar.top < lr.top) list.scrollTop -= lr.top - ar.top;
    else if (ar.bottom > lr.bottom) list.scrollTop += ar.bottom - lr.bottom;
  }, [index, items.length]);

  const rows = Math.max(3, Math.min(200, Math.round(maxRows) || 25));
  const maxHeight = rows * ITEM_H + (rows - 1) * GAP;

  return (
    <div className={styles.historyWrap}>
      {/* Snapshots: pinned full states. Click one to restore the document to it;
          the clock pins it as the History brush's source. */}
      <div className={styles.snapHead}>
        <span className={styles.snapTitle}>Snapshots</span>
        <button
          type="button"
          className={styles.snapAdd}
          onClick={onTakeSnapshot}
          title="Take a snapshot of the current state"
          aria-label="Take snapshot"
        >
          <Camera size={13} />
        </button>
      </div>
      {snapshots.length > 0 && (
        <ul className={styles.snapList}>
          {snapshots.map((s) => (
            <li key={s.id} className={styles.historyRow}>
              <button
                type="button"
                className={styles.historySource}
                data-source={s.id === sourceSnapshotId}
                title={
                  s.id === sourceSnapshotId
                    ? "History-brush source"
                    : "Set as History-brush source"
                }
                aria-label={`Set ${s.label} as History-brush source`}
                aria-pressed={s.id === sourceSnapshotId}
                onClick={() => onSetSourceSnapshot?.(s.id === sourceSnapshotId ? null : s.id)}
              >
                <History size={12} />
              </button>
              <button
                type="button"
                className={styles.historyItem}
                title={`Restore “${s.label}”`}
                onClick={() => onRestoreSnapshot?.(s.id)}
              >
                <span className={styles.historyIcon}>
                  <Camera size={13} />
                </span>
                <span className={styles.historyLabel}>{s.label}</span>
              </button>
              <button
                type="button"
                className={styles.snapDel}
                title="Delete snapshot"
                aria-label={`Delete ${s.label}`}
                onClick={() => onDeleteSnapshot?.(s.id)}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ol ref={listRef} className={styles.history} style={{ maxHeight, overflowY: "auto" }}>
      {items.map((h, i) => {
        const Icon = iconForStep(h.label, i === 0);
        return (
          <li key={i} className={styles.historyRow}>
            <button
              type="button"
              className={styles.historySource}
              data-source={i === sourceIndex}
              title={i === sourceIndex ? "History-brush source" : "Set as History-brush source"}
              aria-label="Set as History-brush source"
              aria-pressed={i === sourceIndex}
              onClick={() => onSetSource(i)}
            >
              <History size={12} />
            </button>
            <button
              type="button"
              className={styles.historyItem}
              data-active={i === index}
              data-future={i > index}
              onClick={() => onJump(i)}
            >
              <span className={styles.historyIcon}>
                <Icon size={13} />
              </span>
              <span className={styles.historyLabel}>{h.label}</span>
              <span className={styles.historyStep}>{i + 1}</span>
            </button>
          </li>
        );
      })}
      </ol>
    </div>
  );
}
