"use client";

import { useState } from "react";
import { CircleDashed, PaintBucket, PenTool, Pencil, Save, Trash2 } from "lucide-react";
import styles from "../RightDock.module.scss";
import { pathBounds, pathToSvgD, WORK_PATH_ID, type PathsApi, type PathSelectOp } from "../../lib/paths";

/** Selection op from the click's modifiers (mirrors the lasso conventions). */
const opFor = (e: React.MouseEvent): PathSelectOp =>
  e.ctrlKey && e.altKey ? "intersect" : e.ctrlKey ? "add" : e.altKey ? "subtract" : "new";

/**
 * Paths panel: stored pen paths (the Pen tool's latest commit auto-lands here
 * as "Work Path"). Each path can become a selection (Ctrl adds, Alt subtracts,
 * Ctrl+Alt intersects — the boolean combines), be stroked or filled onto the
 * active layer, or be loaded back into the Pen tool for editing.
 */
export default function PathsPanel({ api }: { api: PathsApi }) {
  const { paths } = api;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (renamingId) api.rename(renamingId, draft.trim() || "Path");
    setRenamingId(null);
  };

  if (!paths.length) {
    return (
      <p className={styles.actionHint}>
        Draw a path with the Pen tool (P) and commit it (Enter) — it lands here as the
        Work Path. Save it to keep it, then turn it into a selection, stroke or fill
        any time.
      </p>
    );
  }

  return (
    <ul className={styles.pathList}>
      {paths.map((p) => {
        const b = pathBounds(p.anchors);
        const pad = Math.max(b.w, b.h) * 0.08;
        return (
          <li key={p.id} className={styles.pathItem}>
            <span className={styles.pathThumb} aria-hidden>
              <svg
                viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <path
                  d={pathToSvgD(p.anchors, p.closed)}
                  fill={p.closed ? "currentColor" : "none"}
                  fillOpacity={p.closed ? 0.25 : undefined}
                  stroke="currentColor"
                  strokeWidth={Math.max(b.w, b.h) / 28}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </span>
            {renamingId === p.id ? (
              <input
                className={styles.layerRename}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                className={styles.pathName}
                data-work={p.id === WORK_PATH_ID}
                title="Double-click to rename"
                onDoubleClick={() => {
                  if (p.id === WORK_PATH_ID) return; // save it to name it
                  setRenamingId(p.id);
                  setDraft(p.name);
                }}
              >
                {p.name}
                <em>
                  {p.anchors.length} pts · {p.closed ? "closed" : "open"}
                </em>
              </span>
            )}
            <button
              type="button"
              className={styles.actionBtn}
              title="Make selection — Ctrl adds, Alt subtracts, Ctrl+Alt intersects"
              aria-label={`Selection from ${p.name}`}
              onClick={(e) => api.toSelection(p.id, opFor(e))}
            >
              <CircleDashed size={13} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title="Stroke the path onto the active layer (Pen tool settings + foreground colour)"
              aria-label={`Stroke ${p.name}`}
              onClick={() => api.stroke(p.id)}
            >
              <PenTool size={13} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title="Fill the path's region on the active layer (foreground colour)"
              aria-label={`Fill ${p.name}`}
              onClick={() => api.fill(p.id)}
            >
              <PaintBucket size={13} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title="Edit with the Pen tool"
              aria-label={`Edit ${p.name}`}
              onClick={() => api.edit(p.id)}
            >
              <Pencil size={13} />
            </button>
            {p.id === WORK_PATH_ID ? (
              <button
                type="button"
                className={styles.actionBtn}
                title="Save the Work Path as a named path"
                aria-label="Save work path"
                onClick={() => api.save(p.id)}
              >
                <Save size={13} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.actionBtn}
                title="Delete path"
                aria-label={`Delete ${p.name}`}
                onClick={() => api.remove(p.id)}
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
