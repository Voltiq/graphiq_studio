"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Play, Square, Trash2, X } from "lucide-react";
import styles from "../RightDock.module.scss";
import { Select } from "../Controls";
import { FKEY_CHOICES, type ActionsApi } from "../../lib/actions";

const NO_KEY = "—";

/**
 * Actions panel: record document menu commands into named, replayable macros
 * (playable from here or an assigned F-key). Recording captures only commands
 * that replay unattended — dialogs, tool strokes and view/window toggles are
 * deliberately not recorded (isRecordable in lib/actions.ts).
 */
export default function ActionsPanel({ api }: { api: ActionsApi }) {
  const { actions, recordingId, playingId } = api;
  const [draftName, setDraftName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const busy = !!recordingId || !!playingId;
  const startRecord = () => {
    const name = draftName.trim() || `Action ${actions.length + 1}`;
    setDraftName("");
    api.record(name);
  };
  const commitRename = () => {
    if (renamingId) api.rename(renamingId, renameDraft.trim() || "Action");
    setRenamingId(null);
  };

  return (
    <div className={styles.actions}>
      {recordingId ? (
        <button type="button" className={styles.recordBar} onClick={api.stop}>
          <span className={styles.recDot} />
          Recording “{actions.find((a) => a.id === recordingId)?.name ?? "action"}” —{" "}
          {actions.find((a) => a.id === recordingId)?.steps.length ?? 0} step
          {(actions.find((a) => a.id === recordingId)?.steps.length ?? 0) === 1 ? "" : "s"}
          <span className={styles.recStop}>
            <Square size={11} /> Stop
          </span>
        </button>
      ) : (
        <div className={styles.actionsHead}>
          <input
            className={styles.actionNameInput}
            value={draftName}
            placeholder="New action name…"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") startRecord();
              e.stopPropagation(); // keep single-letter tool shortcuts out
            }}
            aria-label="New action name"
          />
          <button
            type="button"
            className={styles.recordBtn}
            disabled={busy}
            onClick={startRecord}
            title="Start recording menu commands into a new action"
          >
            <span className={styles.recDot} data-idle />
            Record
          </button>
        </div>
      )}

      {actions.length === 0 && !recordingId ? (
        <p className={styles.actionHint}>
          Record a sequence of document commands — layer ops, image rotates, preset
          adjustments, effects — then replay it in one click or with an F-key. Commands
          that need a dialog (and tool strokes) aren&apos;t captured.
        </p>
      ) : (
        <ul className={styles.actionList}>
          {actions.map((a) => {
            const open = expanded === a.id;
            const isRec = recordingId === a.id;
            const isPlaying = playingId === a.id;
            return (
              <li key={a.id} className={styles.actionItem} data-recording={isRec}>
                <div className={styles.actionRow}>
                  <button
                    type="button"
                    className={styles.layerCaret}
                    onClick={() => setExpanded(open ? null : a.id)}
                    aria-label={open ? "Collapse steps" : "Expand steps"}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  {renamingId === a.id ? (
                    <input
                      className={styles.layerRename}
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                        e.stopPropagation();
                      }}
                    />
                  ) : (
                    <span
                      className={styles.actionName}
                      title="Double-click to rename"
                      onDoubleClick={() => {
                        setRenamingId(a.id);
                        setRenameDraft(a.name);
                      }}
                    >
                      {a.name}
                      <em>
                        {isRec ? "recording…" : `${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`}
                      </em>
                    </span>
                  )}
                  <Select
                    options={[NO_KEY, ...FKEY_CHOICES]}
                    value={a.fkey ?? NO_KEY}
                    onChange={(v) => api.setFKey(a.id, v === NO_KEY ? null : v)}
                  />
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busy || a.steps.length === 0}
                    onClick={() => api.play(a.id)}
                    title={a.steps.length ? "Play this action" : "No steps recorded yet"}
                    aria-label={`Play ${a.name}`}
                  >
                    {isPlaying ? <Square size={13} /> : <Play size={13} />}
                  </button>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    disabled={busy}
                    onClick={() => api.remove(a.id)}
                    title="Delete action"
                    aria-label={`Delete ${a.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {open && (
                  <ol className={styles.actionSteps}>
                    {a.steps.length === 0 && <li className={styles.actionStepEmpty}>No steps yet.</li>}
                    {a.steps.map((s, i) => (
                      <li key={`${s.action}-${i}`} className={styles.actionStep}>
                        <span className={styles.actionStepNum}>{i + 1}</span>
                        <span className={styles.actionStepLabel}>{s.label}</span>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          disabled={busy}
                          onClick={() => api.removeStep(a.id, i)}
                          title="Remove step"
                          aria-label={`Remove step ${i + 1}`}
                        >
                          <X size={11} />
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
