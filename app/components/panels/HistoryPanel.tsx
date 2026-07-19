"use client";

import { useEffect, useRef } from "react";
import {
  Activity,
  ArrowDownToLine,
  Blend,
  BoxSelect,
  Brush,
  ClipboardPaste,
  Copy,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  FolderPlus,
  Frame,
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
  onJump,
  maxRows = 25,
}: {
  items: { label: string }[];
  index: number;
  onJump: (index: number) => void;
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
    <ol ref={listRef} className={styles.history} style={{ maxHeight, overflowY: "auto" }}>
      {items.map((h, i) => {
        const Icon = iconForStep(h.label, i === 0);
        return (
          <li key={i}>
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
  );
}
