"use client";

import { useEffect, useState } from "react";
import { Clock, FileText, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { clearRecents, listRecents, readRecent, removeRecent, type RecentMeta } from "../lib/recents";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

export default function RecentsDialog({
  onOpenText,
  onClose,
}: {
  onOpenText: (text: string) => boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<RecentMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /* Projects only: this dialog opens `.gproj` TEXT, and the store now also
     remembers pictures for the phone's start card. */
  const refresh = () => listRecents("project").then(setItems);
  useEffect(() => {
    refresh();
  }, []);

  const open = async (m: RecentMeta) => {
    setBusy(m.id);
    const text = await readRecent(m.id);
    setBusy(null);
    if (text === null) {
      window.alert(`"${m.name}" is no longer available — it may have been moved or deleted, or access was denied.`);
      await removeRecent(m.id);
      refresh();
      return;
    }
    if (onOpenText(text)) onClose();
  };

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await removeRecent(id);
    refresh();
  };

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--sp-3)",
    padding: "9px 11px",
    width: "100%",
    textAlign: "left",
    borderRadius: "var(--r-sm)",
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Recent projects"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className={styles.head}>
          <h2>Open recent</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {items === null ? (
            <p style={{ fontSize: 12.5, color: "var(--text-3)", margin: 0 }}>Loading…</p>
          ) : items.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--text-3)", margin: 0 }}>
              No recent projects yet. Saved and opened <strong>.gproj</strong> files show up here.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  style={{ ...row, opacity: busy === m.id ? 0.6 : 1 }}
                  disabled={busy !== null}
                  onClick={() => open(m)}
                >
                  <FileText size={15} style={{ color: "var(--text-3)", flexShrink: 0 }} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                    <strong
                      style={{
                        fontSize: 13,
                        fontWeight: 550,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.name}
                    </strong>
                    <em
                      style={{
                        fontStyle: "normal",
                        fontSize: 11,
                        color: "var(--text-3)",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Clock size={10} /> {timeAgo(m.savedAt)}
                      {m.kind === "data" && " · cached copy"}
                    </em>
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${m.name}`}
                    onClick={(e) => remove(e, m.id)}
                    style={{ color: "var(--text-3)", padding: 4, flexShrink: 0, borderRadius: 5 }}
                  >
                    <X size={13} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <footer className={styles.foot}>
          {items && items.length > 0 && (
            <button
              type="button"
              className={styles.btn}
              style={{ marginRight: "auto" }}
              onClick={async () => {
                await clearRecents();
                refresh();
              }}
            >
              Clear all
            </button>
          )}
          <button type="button" className={styles.btn} onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
