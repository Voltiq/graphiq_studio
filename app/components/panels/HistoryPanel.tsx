"use client";

import { Brush, FileImage } from "lucide-react";
import styles from "../RightDock.module.scss";

export default function HistoryPanel({
  items,
  index,
  onJump,
}: {
  items: { label: string }[];
  index: number;
  onJump: (index: number) => void;
}) {
  return (
    <ol className={styles.history}>
      {items.map((h, i) => {
        const Icon = i === 0 ? FileImage : Brush;
        return (
          <li key={i}>
            <button
              type="button"
              className={styles.historyItem}
              data-active={i === index}
              data-future={i > index}
              onClick={() => onJump(i)}
            >
              <Icon size={13} />
              <span>{h.label}</span>
              <span className={styles.historyStep}>{i}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
