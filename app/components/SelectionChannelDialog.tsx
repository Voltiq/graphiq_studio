"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { Segmented } from "./Controls";
import { defaultChannelName, type ChannelSelectOp, type SavedChannel } from "../lib/channels";

const OPS: { value: ChannelSelectOp; text: string; title: string }[] = [
  { value: "new", text: "New", title: "Replace whatever is selected" },
  { value: "add", text: "Add", title: "Union with the current selection" },
  { value: "subtract", text: "Subtract", title: "Remove it from the current selection" },
  { value: "intersect", text: "Intersect", title: "Keep only where the two overlap" },
];

/**
 * Save / Load selection (Select menu). One component for both: they are the same
 * dialog with different halves — a name going out, a channel + combine mode
 * coming back.
 */
export default function SelectionChannelDialog({
  mode,
  channels,
  hasSelection,
  onSave,
  onLoad,
  onClose,
}: {
  mode: "save" | "load";
  channels: SavedChannel[];
  hasSelection: boolean;
  onSave: (name: string) => void;
  onLoad: (id: string, op: ChannelSelectOp) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => defaultChannelName(channels));
  const [target, setTarget] = useState(() => channels[0]?.id ?? "");
  const [op, setOp] = useState<ChannelSelectOp>("new");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== "save") return;
    const t = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(t);
  }, [mode]);

  const canSubmit = mode === "save" ? hasSelection : !!target;
  const submit = () => {
    if (!canSubmit) return;
    if (mode === "save") onSave(name);
    else onLoad(target, op);
    onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === "save" ? "Save selection" : "Load selection"}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <header className={styles.head}>
          <h2>{mode === "save" ? "Save Selection" : "Load Selection"}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "save" ? (
            <>
              {!hasSelection && (
                <span className={styles.note}>
                  Nothing is selected — a channel stores a region, so there is nothing to save yet.
                </span>
              )}
              <span className={styles.groupLabel}>Name</span>
              <input
                ref={inputRef}
                value={name}
                aria-label="Channel name"
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                style={{
                  height: 30,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
              <span className={styles.note} style={{ margin: 0 }}>
                Saved selections live in the Channels panel and travel with the document.
              </span>
            </>
          ) : channels.length === 0 ? (
            <span className={styles.note}>
              No saved selections yet — use <strong>Select ▸ Save selection…</strong> to store one.
            </span>
          ) : (
            <>
              <span className={styles.groupLabel}>Channel</span>
              <select
                value={target}
                aria-label="Channel"
                onChange={(e) => setTarget(e.target.value)}
                style={{
                  height: 30,
                  padding: "0 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {/* With nothing selected there is nothing to combine WITH, so the
                  three boolean modes would all reduce to "New" anyway. */}
              {hasSelection && (
                <>
                  <span className={styles.groupLabel}>Operation</span>
                  <Segmented
                    options={OPS}
                    value={op}
                    onChange={(v) => setOp(v as ChannelSelectOp)}
                  />
                </>
              )}
              <span className={styles.note} style={{ margin: 0 }}>
                In the Channels panel: click loads, Ctrl adds, Alt subtracts, Ctrl+Alt intersects.
              </span>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primary} disabled={!canSubmit} onClick={submit}>
            {mode === "save" ? "Save" : "Load"}
          </button>
        </footer>
      </div>
    </div>
  );
}
