"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FolderPlus,
  Image as ImageIcon,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import styles from "../RightDock.module.scss";
import { Select } from "../Controls";
import { swatchBg } from "../../lib/color";
import { downloadBlob } from "../../lib/project";
import {
  encodeACO,
  encodeASE,
  extractPalette,
  freshGroupId,
  getGroups,
  groupsToFileJSON,
  parseSwatchImport,
  setGroups,
  subscribeGroups,
  type SwatchGroup,
} from "../../lib/swatches";
import type { EngineHandle } from "../../lib/paint";
import type { LayerNode } from "../../lib/layers";

const EXPORT_FORMATS = [".gse (groups)", ".gco", ".json"] as const;

/**
 * Swatches v2 panel: colour GROUPS — click a swatch to make it the foreground,
 * Alt/right-click removes it; groups collapse, rename (double-click) and
 * delete. Import/export speaks .gse/.gco (the app's ASE/ACO binary twins —
 * plain .ase/.aco work too), JSON, GIMP .gpl and loose hex; "From image"
 * median-cuts the composited document into a new palette group. The FIRST
 * group is also what every colour picker's swatch strip shows.
 */
export default function SwatchesPanel({
  foreground,
  onForeground,
  engineRef,
  tree,
  docName,
}: {
  foreground: string;
  onForeground: (c: string) => void;
  engineRef: RefObject<EngineHandle | null>;
  tree: LayerNode[];
  docName: string;
}) {
  const [groups, setLocal] = useState<SwatchGroup[]>(() => getGroups());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [exportFmt, setExportFmt] = useState<string>(EXPORT_FORMATS[0]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeGroups(setLocal), []);

  const commit = (next: SwatchGroup[]) => setGroups(next);

  const addGroup = () =>
    commit([...groups, { id: freshGroupId(), name: `Group ${groups.length + 1}`, colors: [] }]);

  const addCurrent = (gid: string) =>
    commit(
      groups.map((g) =>
        g.id === gid && !g.colors.some((c) => c.toLowerCase() === foreground.toLowerCase())
          ? { ...g, colors: [...g.colors, foreground] }
          : g,
      ),
    );

  const removeColor = (gid: string, index: number) =>
    commit(groups.map((g) => (g.id === gid ? { ...g, colors: g.colors.filter((_, i) => i !== index) } : g)));

  const commitRename = () => {
    if (renamingId) {
      commit(groups.map((g) => (g.id === renamingId ? { ...g, name: renameDraft.trim() || "Group" } : g)));
    }
    setRenamingId(null);
  };

  const fromImage = () => {
    const eng = engineRef.current;
    if (!eng) return;
    const full = eng.exportComposite(tree);
    // Downsample before the median cut — 64px is plenty for a palette.
    const k = Math.max(1, Math.ceil(Math.max(full.width, full.height) / 64));
    const w = Math.max(1, Math.floor(full.width / k));
    const h = Math.max(1, Math.floor(full.height / k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(full, 0, 0, w, h);
    const colors = extractPalette(ctx.getImageData(0, 0, w, h).data, 8);
    if (!colors.length) return;
    commit([...groups, { id: freshGroupId(), name: `${docName} palette`, colors }]);
  };

  const importFile = async (file: File) => {
    const stem = file.name.replace(/\.[^.]+$/, "");
    const imported = parseSwatchImport(await file.arrayBuffer(), stem || "Imported");
    if (imported.length) commit([...groups, ...imported]);
  };

  const doExport = () => {
    const safe = "graphiq-swatches";
    if (exportFmt.startsWith(".gse")) {
      downloadBlob(new Blob([encodeASE(groups)], { type: "application/octet-stream" }), `${safe}.gse`);
    } else if (exportFmt === ".gco") {
      downloadBlob(new Blob([encodeACO(groups)], { type: "application/octet-stream" }), `${safe}.gco`);
    } else {
      downloadBlob(new Blob([groupsToFileJSON(groups)], { type: "application/json" }), `${safe}.json`);
    }
  };

  return (
    <div className={styles.swatchesPanel}>
      <div className={styles.swToolbar}>
        <button type="button" className={styles.actionBtn} title="New group" onClick={addGroup}>
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          title="Extract a palette from the image (median cut over the composite)"
          onClick={fromImage}
        >
          <ImageIcon size={13} />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          title="Import swatches (.gse/.ase, .gco/.aco, .json, .gpl, text)"
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={13} />
        </button>
        <div className={styles.swToolbarSpacer} />
        <Select options={[...EXPORT_FORMATS]} value={exportFmt} onChange={setExportFmt} />
        <button
          type="button"
          className={styles.actionBtn}
          title={`Export all groups as ${exportFmt.split(" ")[0]}`}
          onClick={doExport}
          disabled={!groups.some((g) => g.colors.length)}
        >
          <Download size={13} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gse,.ase,.gco,.aco,.json,.gpl,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {!groups.length && (
        <p className={styles.swHint}>
          No swatches yet — add a group, save the current colour into it, or pull a palette
          straight from the image.
        </p>
      )}

      {groups.map((g) => {
        const open = !closed.has(g.id);
        return (
          <div key={g.id} className={styles.swGroup}>
            <div className={styles.swGroupHead}>
              <button
                type="button"
                className={styles.layerCaret}
                aria-label={open ? `Collapse ${g.name}` : `Expand ${g.name}`}
                onClick={() =>
                  setClosed((s) => {
                    const next = new Set(s);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    return next;
                  })
                }
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              {renamingId === g.id ? (
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
                  className={styles.swGroupName}
                  title="Double-click to rename"
                  onDoubleClick={() => {
                    setRenamingId(g.id);
                    setRenameDraft(g.name);
                  }}
                >
                  {g.name}
                  <em>{g.colors.length}</em>
                </span>
              )}
              <button
                type="button"
                className={styles.actionBtn}
                title="Add the current colour to this group"
                onClick={() => addCurrent(g.id)}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                title="Delete this group"
                onClick={() => commit(groups.filter((x) => x.id !== g.id))}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {open && (
              <div className={styles.swGrid}>
                {g.colors.map((c, i) => (
                  <button
                    key={`${c}-${i}`}
                    type="button"
                    className={styles.swCell}
                    style={swatchBg(c)}
                    data-selected={c.toLowerCase() === foreground.toLowerCase()}
                    title={`${c.toUpperCase()} — click to use, Alt-click to remove`}
                    onClick={(e) => (e.altKey ? removeColor(g.id, i) : onForeground(c))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      removeColor(g.id, i);
                    }}
                  />
                ))}
                {!g.colors.length && <span className={styles.swHint}>Empty — “+” saves the current colour.</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
