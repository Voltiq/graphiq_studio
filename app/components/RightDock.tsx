"use client";

import { useEffect, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { WORKING_SPACE_LABELS, type WorkingSpace } from "../lib/colorspace";
import {
  BarChart3,
  Compass,
  History,
  Info,
  Layers,
  MoreHorizontal,
  Palette,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Zap,
} from "lucide-react";
import styles from "./RightDock.module.scss";
import Panel from "./Panel";
import ColorPanel from "./panels/ColorPanel";
import AdjustmentsPanel from "./panels/AdjustmentsPanel";
import LayersPanel from "./panels/LayersPanel";
import HistoryPanel from "./panels/HistoryPanel";
import NavigatorPanel from "./panels/NavigatorPanel";
import ChannelsPanel from "./panels/ChannelsPanel";
import MetadataPanel from "./panels/MetadataPanel";
import PropertiesPanel from "./panels/PropertiesPanel";
import ActionsPanel from "./panels/ActionsPanel";
import type { ActionsApi } from "../lib/actions";
import PathsPanel from "./panels/PathsPanel";
import type { PathsApi } from "../lib/paths";
import { Spline } from "lucide-react";
import type { NavigatorView } from "../lib/view";
import type { LayersApi } from "../lib/layers";
import type { EngineHandle, HistorySummary } from "../lib/paint";
import type { Adjustments } from "../lib/adjust";
import type { ExtraAdjustmentType } from "../lib/adjust-extra";
import type { ImageMetadata } from "../lib/metadata";

export type PanelVisibility = {
  color: boolean;
  adjustments: boolean;
  properties: boolean;
  layers: boolean;
  paths: boolean;
  history: boolean;
  actions: boolean;
  navigator: boolean;
  channels: boolean;
  metadata: boolean;
};

type PanelId =
  | "navigator"
  | "channels"
  | "color"
  | "adjustments"
  | "properties"
  | "layers"
  | "paths"
  | "history"
  | "actions"
  | "metadata";
const DEFAULT_ORDER: PanelId[] = [
  "navigator",
  "channels",
  "color",
  "adjustments",
  "properties",
  "layers",
  "paths",
  "history",
  "actions",
  "metadata",
];
const ORDER_KEY = "graphiq:panel-order";
const OPEN_KEY = "graphiq:panel-open";
const LEGACY_ORDER_KEY = "aperture:panel-order"; // pre-rebrand fallbacks
const LEGACY_OPEN_KEY = "aperture:panel-open";

/** Default collapsed/expanded state per panel. */
const DEFAULT_OPEN: Record<PanelId, boolean> = {
  navigator: true,
  channels: false,
  color: true,
  adjustments: true,
  properties: true,
  layers: true,
  paths: false,
  history: false,
  actions: false,
  metadata: false,
};

/** Read the saved panel order, dropping unknown ids and appending any new ones. */
function loadOrder(): PanelId[] {
  if (typeof window === "undefined") return DEFAULT_ORDER;
  try {
    const raw = window.localStorage.getItem(ORDER_KEY) ?? window.localStorage.getItem(LEGACY_ORDER_KEY);
    if (!raw) return DEFAULT_ORDER;
    const saved = (JSON.parse(raw) as string[]).filter((id): id is PanelId =>
      (DEFAULT_ORDER as string[]).includes(id),
    );
    return [...saved, ...DEFAULT_ORDER.filter((id) => !saved.includes(id))];
  } catch {
    return DEFAULT_ORDER;
  }
}

/** Read the saved collapsed/expanded state, merged over the defaults. */
function loadOpen(): Record<PanelId, boolean> {
  if (typeof window === "undefined") return DEFAULT_OPEN;
  try {
    const raw = window.localStorage.getItem(OPEN_KEY) ?? window.localStorage.getItem(LEGACY_OPEN_KEY);
    if (!raw) return DEFAULT_OPEN;
    const saved = JSON.parse(raw) as Partial<Record<PanelId, boolean>>;
    const next = { ...DEFAULT_OPEN };
    for (const id of DEFAULT_ORDER) {
      if (typeof saved[id] === "boolean") next[id] = saved[id] as boolean;
    }
    return next;
  } catch {
    return DEFAULT_OPEN;
  }
}

interface Props {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  activeSlot: "primary" | "secondary";
  onActiveSlot: (slot: "primary" | "secondary") => void;
  layers: LayersApi;
  history: HistorySummary;
  maxHistoryRows: number;
  onHistoryJump: (index: number) => void;
  view: NavigatorView;
  panels: PanelVisibility;
  adjust: Adjustments;
  onAdjust: (patch: Partial<Adjustments>) => void;
  adjustFilter: string;
  onAdjustFilter: (name: string) => void;
  onApplyPreset: (adjust: Adjustments, name: string) => void;
  onAdjustReset: () => void;
  adjustActive: boolean;
  editingAdjustment: boolean;
  adjustEditName?: string;
  onCreateAdjustment: () => void;
  onDeleteAdjustment: () => void;
  onAddCurves: () => void;
  onAddLevels: () => void;
  /** Create one of the extra adjustment layers (Hue/Sat, Selective, …). */
  onAddExtra: (type: ExtraAdjustmentType) => void;
  /** Open the "Export LUT (.cube)" dialog. */
  onExportLut: () => void;
  /** Imperative engine handle, for the live channels histogram. */
  engineRef: RefObject<EngineHandle | null>;
  /** Active document facts for the Metadata panel. */
  docName: string;
  colorSpace: WorkingSpace;
  imageMeta: ImageMetadata | null;
  /** Write an edit from the panel's editable fields (description/artist/copyright)
   *  into the active document's metadata. */
  onEditMeta: (patch: Partial<ImageMetadata>) => void;
  /** Macro recorder state + verbs for the Actions panel. */
  actionsApi: ActionsApi;
  /** Stored pen paths + verbs for the Paths panel. */
  pathsApi: PathsApi;
  docDpi?: number;
}

const IconBtn = ({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) => (
  <button type="button" className={styles.headBtn} title={title} onClick={onClick}>
    {children}
  </button>
);

export default function RightDock({
  foreground,
  background,
  onForeground,
  onBackground,
  activeSlot,
  onActiveSlot,
  layers,
  history,
  maxHistoryRows,
  onHistoryJump,
  view,
  adjust,
  onAdjust,
  adjustFilter,
  onAdjustFilter,
  onApplyPreset,
  onAdjustReset,
  adjustActive,
  editingAdjustment,
  adjustEditName,
  onCreateAdjustment,
  onDeleteAdjustment,
  onAddCurves,
  onAddLevels,
  onAddExtra,
  onExportLut,
  panels,
  engineRef,
  docName,
  colorSpace,
  imageMeta,
  onEditMeta,
  actionsApi,
  pathsApi,
  docDpi = 300,
}: Props) {
  const [order, setOrder] = useState<PanelId[]>(DEFAULT_ORDER);
  const [openMap, setOpenMap] = useState<Record<PanelId, boolean>>(DEFAULT_OPEN);
  const [dragId, setDragId] = useState<PanelId | null>(null);

  // Load the saved order + open state after mount (avoids a hydration mismatch).
  useEffect(() => {
    setOrder(loadOrder());
    setOpenMap(loadOpen());
  }, []);
  // Persist whenever they change.
  useEffect(() => {
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      /* ignore (private mode / quota) */
    }
  }, [order]);
  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify(openMap));
    } catch {
      /* ignore */
    }
  }, [openMap]);

  const toggleOpen = (id: PanelId) => setOpenMap((cur) => ({ ...cur, [id]: !cur[id] }));

  const reorder = (from: PanelId, to: PanelId, before: boolean) =>
    setOrder((cur) => {
      if (from === to) return cur;
      const next = cur.filter((id) => id !== from);
      let idx = next.indexOf(to);
      if (idx < 0) return cur;
      if (!before) idx += 1;
      next.splice(idx, 0, from);
      // No-op guard so live drag-over doesn't re-render when already in place.
      if (next.length === cur.length && next.every((id, i) => id === cur[i])) return cur;
      return next;
    });

  // Drag wiring shared by every panel. `draggable`/start/end go on the header
  // (the handle); `onDragOver` is the section-level drop target that reorders.
  const dragProps = (id: PanelId) => ({
    draggable: true,
    dragging: dragId === id,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (!dragId || dragId === id) return;
      const r = e.currentTarget.getBoundingClientRect();
      reorder(dragId, id, e.clientY - r.top < r.height / 2);
    },
    onDragEnd: () => setDragId(null),
  });

  const panelFor = (id: PanelId): ReactNode => {
    const dp = { ...dragProps(id), open: openMap[id], onToggle: () => toggleOpen(id) };
    switch (id) {
      case "navigator":
        return panels.navigator ? (
          <Panel key="navigator" title="Navigator" icon={Compass} {...dp}>
            <NavigatorPanel view={view} />
          </Panel>
        ) : null;
      case "channels":
        return panels.channels ? (
          <Panel key="channels" title="Channels" icon={BarChart3} {...dp}>
            <ChannelsPanel engineRef={engineRef} tree={layers.layers} />
          </Panel>
        ) : null;
      case "color":
        return panels.color ? (
          <Panel
            key="color"
            title="Color"
            icon={Palette}
            actions={<IconBtn title="More"><MoreHorizontal size={14} /></IconBtn>}
            {...dp}
          >
            <ColorPanel
              foreground={foreground}
              background={background}
              onForeground={onForeground}
              onBackground={onBackground}
              active={activeSlot}
              onActive={onActiveSlot}
            />
          </Panel>
        ) : null;
      case "adjustments":
        return panels.adjustments ? (
          <Panel key="adjustments" title="Adjustments" icon={SlidersHorizontal} {...dp}>
            <AdjustmentsPanel
              adjust={adjust}
              onChange={onAdjust}
              filter={adjustFilter}
              onFilter={onAdjustFilter}
              onApplyPreset={onApplyPreset}
              onReset={onAdjustReset}
              active={adjustActive}
              editing={editingAdjustment}
              editName={adjustEditName}
              onCreate={onCreateAdjustment}
              onDelete={onDeleteAdjustment}
              onAddCurves={onAddCurves}
              onAddLevels={onAddLevels}
              onAddExtra={onAddExtra}
              onExportLut={onExportLut}
            />
          </Panel>
        ) : null;
      case "properties":
        return panels.properties ? (
          <Panel key="properties" title="Properties" icon={Settings2} {...dp}>
            <PropertiesPanel api={layers} />
          </Panel>
        ) : null;
      case "layers":
        return panels.layers ? (
          <Panel
            key="layers"
            title="Layers"
            icon={Layers}
            actions={
              <>
                <IconBtn title="New layer" onClick={layers.add}>
                  <Plus size={14} />
                </IconBtn>
                <IconBtn title="Delete layer" onClick={() => layers.remove()}>
                  <Trash2 size={14} />
                </IconBtn>
              </>
            }
            {...dp}
          >
            <LayersPanel api={layers} />
          </Panel>
        ) : null;
      case "history":
        return panels.history ? (
          <Panel key="history" title="History" icon={History} {...dp}>
            <HistoryPanel
              items={history.items}
              index={history.index}
              onJump={onHistoryJump}
              maxRows={maxHistoryRows}
            />
          </Panel>
        ) : null;
      case "paths":
        return panels.paths ? (
          <Panel key="paths" title="Paths" icon={Spline} {...dp}>
            <PathsPanel api={pathsApi} />
          </Panel>
        ) : null;
      case "actions":
        return panels.actions ? (
          <Panel key="actions" title="Actions" icon={Zap} {...dp}>
            <ActionsPanel api={actionsApi} />
          </Panel>
        ) : null;
      case "metadata":
        return panels.metadata ? (
          <Panel key="metadata" title="Metadata" icon={Info} {...dp}>
            <MetadataPanel
              name={docName}
              width={view.docW}
              height={view.docH}
              dpi={docDpi}
              colorSpace={colorSpace}
              meta={imageMeta}
              onEdit={onEditMeta}
            />
          </Panel>
        ) : null;
    }
  };

  return (
    <aside className={styles.dock} aria-label="Panels">
      {order.map((id) => panelFor(id))}
    </aside>
  );
}
