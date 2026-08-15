"use client";

import { useState } from "react";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import styles from "../RightDock.module.scss";
import {
  COMP_ATTRS,
  COMP_ATTR_LABEL,
  toggleAttr,
  type CompAttr,
  type CompsApi,
} from "../../lib/comps";

/** One-letter chip per attribute — compact enough to sit on every row, which is
 *  what makes "what does this comp actually record?" answerable at a glance. */
const ATTR_CHIP: Record<CompAttr, string> = { visibility: "V", position: "P", appearance: "A" };

/**
 * Layer Comps panel: named snapshots of layer visibility, position and
 * appearance. Click a comp to put the document back into that state.
 *
 * Each row carries its own V / P / A toggles rather than hiding them in a dialog,
 * because which attributes a comp records is the thing you most often get wrong —
 * a comp that also restores position when you only wanted visibility moves your
 * artwork, and you find out by accident.
 */
export default function CompsPanel({ api }: { api: CompsApi }) {
  const { comps } = api;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newCapture, setNewCapture] = useState<CompAttr[]>([...COMP_ATTRS]);

  const commitRename = () => {
    if (renamingId) api.rename(renamingId, draft.trim() || "Layer Comp");
    setRenamingId(null);
  };

  const NewButton = (
    <div className={styles.compFooter}>
      <div className={styles.compChips} role="group" aria-label="Attributes a new comp records">
        {COMP_ATTRS.map((a) => (
          <button
            key={a}
            type="button"
            className={styles.compChip}
            data-on={newCapture.includes(a)}
            title={`New comps record ${COMP_ATTR_LABEL[a]}`}
            aria-pressed={newCapture.includes(a)}
            aria-label={`New comps record ${COMP_ATTR_LABEL[a]}`}
            onClick={() => setNewCapture((c) => toggleAttr(c, a))}
          >
            {ATTR_CHIP[a]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={styles.actionBtn}
        title="Capture the current state as a new comp"
        aria-label="New layer comp"
        disabled={!newCapture.length}
        onClick={() => api.create(newCapture)}
      >
        <Plus size={14} />
      </button>
    </div>
  );

  if (!comps.length) {
    return (
      <>
        <p className={styles.actionHint}>
          Get the layers looking how you want, then add a comp to remember it. Flip between
          comps to compare versions of the same artwork — which layers are shown, where they
          sit, and the styles on them.
        </p>
        {NewButton}
      </>
    );
  }

  return (
    <>
      <ul className={styles.pathList}>
        {comps.map((c) => (
          <li key={c.id} className={styles.pathItem} data-current={c.id === api.currentId}>
            <button
              type="button"
              className={styles.compDot}
              data-on={c.id === api.currentId}
              title={c.id === api.currentId ? "The document matches this comp" : `Apply ${c.name}`}
              aria-label={`Apply ${c.name}`}
              onClick={() => api.apply(c.id)}
            />
            {renamingId === c.id ? (
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
                title="Click to apply · double-click to rename"
                onClick={() => api.apply(c.id)}
                onDoubleClick={() => {
                  setRenamingId(c.id);
                  setDraft(c.name);
                }}
              >
                {c.name}
                <em>{Object.keys(c.states).length} layers</em>
              </span>
            )}
            <div className={styles.compChips} role="group" aria-label={`What ${c.name} records`}>
              {COMP_ATTRS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={styles.compChip}
                  data-on={c.capture.includes(a)}
                  title={`${COMP_ATTR_LABEL[a]} — click to ${c.capture.includes(a) ? "stop recording" : "record"}`}
                  aria-pressed={c.capture.includes(a)}
                  aria-label={`${c.name}: ${COMP_ATTR_LABEL[a]}`}
                  onClick={() => api.setCapture(c.id, toggleAttr(c.capture, a))}
                >
                  {ATTR_CHIP[a]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.actionBtn}
              title="Update this comp to match the document as it is now"
              aria-label={`Update ${c.name}`}
              onClick={() => api.update(c.id)}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title="Duplicate comp"
              aria-label={`Duplicate ${c.name}`}
              onClick={() => api.duplicate(c.id)}
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              className={styles.actionBtn}
              title="Delete comp"
              aria-label={`Delete ${c.name}`}
              onClick={() => api.remove(c.id)}
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      {NewButton}
    </>
  );
}
