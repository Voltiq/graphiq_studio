"use client";

import { useState } from "react";
import { Play, Save, Trash2, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import prefStyles from "./PreferencesDialog.module.scss";
import type { DockLayout, PanelVisibility } from "./RightDock";

/** Everything a named workspace snapshots. */
export interface WorkspaceSnap {
  panels: PanelVisibility;
  dock: DockLayout | null;
}

const WORKSPACES_KEY = "graphiq:workspaces";

function loadWorkspaces(): Record<string, WorkspaceSnap> {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, WorkspaceSnap>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveWorkspaces(map: Record<string, WorkspaceSnap>): void {
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/**
 * Named workspaces: snapshot the whole panel layout — visibility, both docks'
 * membership + order, floating positions, collapsed state — and re-apply it
 * in one click. Window ▸ Reset workspace still restores the factory layout.
 */
export default function WorkspacesDialog({
  capture,
  onApply,
  onClose,
}: {
  capture: () => WorkspaceSnap;
  onApply: (ws: WorkspaceSnap) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<Record<string, WorkspaceSnap>>(() => loadWorkspaces());
  const [draft, setDraft] = useState("");
  const names = Object.keys(saved).sort((a, b) => a.localeCompare(b));

  const saveCurrent = () => {
    const name = draft.trim();
    if (!name) return;
    const next = { ...saved, [name]: capture() };
    setSaved(next);
    saveWorkspaces(next);
    setDraft("");
  };
  const remove = (name: string) => {
    const next = { ...saved };
    delete next[name];
    setSaved(next);
    saveWorkspaces(next);
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Workspaces"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Workspaces</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className={styles.groupLabel}>Save the current layout</span>
          <div style={{ display: "flex", gap: 8 }}>
            <div className={prefStyles.searchBox} style={{ flex: 1 }}>
              <input
                value={draft}
                placeholder="Workspace name…"
                aria-label="Workspace name"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveCurrent();
                  e.stopPropagation();
                }}
              />
            </div>
            <button
              type="button"
              className={styles.btn}
              disabled={!draft.trim()}
              onClick={saveCurrent}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Save size={13} /> Save
            </button>
          </div>
          <p className={styles.note}>
            A workspace snapshots panel visibility, which dock each panel sits in (and its
            order), floating panels with their positions, and collapsed states. Saving an
            existing name overwrites it.
          </p>

          {names.length > 0 && <span className={styles.groupLabel}>Saved workspaces</span>}
          {names.map((name) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {name}
              </span>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  onApply(saved[name]);
                  onClose();
                }}
                title="Apply this workspace"
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Play size={12} /> Apply
              </button>
              <button
                type="button"
                className={styles.close}
                onClick={() => remove(name)}
                title="Delete this workspace"
                aria-label={`Delete ${name}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!names.length && <p className={styles.note}>No saved workspaces yet.</p>}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
