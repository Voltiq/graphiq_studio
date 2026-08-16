"use client";

import { useEffect, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { uiZoom } from "../lib/ui-scale";
import { WORKING_SPACE_LABELS, type WorkingSpace } from "../lib/colorspace";
import {
  BarChart3,
  Compass,
  History,
  Info,
  Layers,
  Palette,
  Plus,
  Settings2,
  SlidersHorizontal,
  SwatchBook,
  Brush,
  Trash2,
  Zap,
} from "lucide-react";
import styles from "./RightDock.module.scss";
import Panel from "./Panel";
import ColorPanel from "./panels/ColorPanel";
import ColorPanelMenu from "./panels/ColorPanelMenu";
import SwatchesPanel from "./panels/SwatchesPanel";
import InfoPanel from "./panels/InfoPanel";
import type { ColorSampler, GestureReadout } from "../lib/samplers";
import BrushesPanel from "./panels/BrushesPanel";
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
import CompsPanel from "./panels/CompsPanel";
import type { CompsApi } from "../lib/comps";
import { Camera, Spline } from "lucide-react";
import type { NavigatorView, Rect } from "../lib/view";
import type { LayersApi } from "../lib/layers";
import type { ChannelSelectOp, SavedChannel } from "../lib/channels";
import type { BrushSettings, EngineHandle, HistorySummary } from "../lib/paint";
import type { Adjustments } from "../lib/adjust";
import type { ExtraAdjustmentType } from "../lib/adjust-extra";
import type { ImageMetadata } from "../lib/metadata";
import type { MeasureUnit } from "../lib/prefs";

export type PanelVisibility = {
  color: boolean;
  swatches: boolean;
  brushes: boolean;
  adjustments: boolean;
  properties: boolean;
  layers: boolean;
  paths: boolean;
  comps: boolean;
  history: boolean;
  actions: boolean;
  navigator: boolean;
  channels: boolean;
  metadata: boolean;
  info: boolean;
};

export type PanelId =
  | "navigator"
  | "channels"
  | "color"
  | "swatches"
  | "brushes"
  | "adjustments"
  | "properties"
  | "layers"
  | "paths"
  | "comps"
  | "history"
  | "actions"
  | "metadata"
  | "info";
const DEFAULT_ORDER: PanelId[] = [
  "navigator",
  "channels",
  "info",
  "color",
  "swatches",
  "brushes",
  "adjustments",
  "properties",
  "layers",
  "paths",
  "comps",
  "history",
  "actions",
  "metadata",
];
const ORDER_KEY = "graphiq:panel-order";
const OPEN_KEY = "graphiq:panel-open";
const LAYOUT_KEY = "graphiq:panel-layout"; // dock membership + floating positions
const LEGACY_ORDER_KEY = "aperture:panel-order"; // pre-rebrand fallbacks
const LEGACY_OPEN_KEY = "aperture:panel-open";

/** Everything the docking system persists/snapshots (workspaces capture this). */
export interface DockLayout {
  /** ONE global panel order — each dock renders its members in this order. */
  order: PanelId[];
  /** Panels assigned to the LEFT dock (everything else is right-docked). */
  left: PanelId[];
  /** Floating panels and their positions (local px inside the float host). */
  floats: Partial<Record<PanelId, { x: number; y: number }>>;
  open: Record<PanelId, boolean>;
}

/** Imperative capture/apply for workspaces + Reset Workspace (null = defaults). */
export interface DockApi {
  capture: () => DockLayout;
  apply: (layout: DockLayout | null) => void;
}

const isPanelId = (v: unknown): v is PanelId => (DEFAULT_ORDER as string[]).includes(v as string);

/** Validate a stored/imported layout fragment (unknown ids and junk dropped). */
function coerceLayout(raw: unknown): { left: PanelId[]; floats: DockLayout["floats"] } {
  const out: { left: PanelId[]; floats: DockLayout["floats"] } = { left: [], floats: {} };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as { left?: unknown; floats?: unknown };
  if (Array.isArray(o.left)) out.left = o.left.filter(isPanelId);
  if (o.floats && typeof o.floats === "object") {
    for (const [id, p] of Object.entries(o.floats as Record<string, { x?: unknown; y?: unknown }>)) {
      if (isPanelId(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        out.floats[id] = { x: Math.max(0, p.x as number), y: Math.max(0, p.y as number) };
      }
    }
  }
  return out;
}

function loadLayout(): { left: PanelId[]; floats: DockLayout["floats"] } {
  if (typeof window === "undefined") return { left: [], floats: {} };
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? coerceLayout(JSON.parse(raw)) : { left: [], floats: {} };
  } catch {
    return { left: [], floats: {} };
  }
}

/** Default collapsed/expanded state per panel. */
const DEFAULT_OPEN: Record<PanelId, boolean> = {
  navigator: true,
  channels: false,
  color: true,
  swatches: false,
  brushes: false,
  adjustments: true,
  properties: true,
  layers: true,
  paths: false,
  comps: false,
  history: false,
  actions: false,
  metadata: false,
  info: false,
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
  /** Active paint-tool brush settings — the Brushes panel applies presets to it. */
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  tool: string;
  layers: LayersApi;
  history: HistorySummary;
  maxHistoryRows: number;
  onHistoryJump: (index: number) => void;
  /** Point the History brush at a history state (0 = the original). */
  onSetHistorySource: (index: number) => void;
  /** Toggle Photoshop-style non-linear history (branch instead of truncate). */
  onNonLinearHistory: (on: boolean) => void;
  /** The active document's persisted history log (from its .gproj). */
  historyLog?: string[];
  /** Snapshots (TODO §10): pin the current state / restore / drop one, and
   *  point the History brush at a snapshot instead of a step. */
  onTakeSnapshot: () => void;
  onRestoreSnapshot: (id: string) => void;
  onDeleteSnapshot: (id: string) => void;
  onSetSourceSnapshot: (id: string | null) => void;
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
  /** Active selection — the Channels histogram scopes to it when present. */
  selection: Rect[];
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  /** Saved selections (alpha channels) for the Channels panel. */
  channels: {
    list: SavedChannel[];
    previewOf: (id: string) => string | null;
    onSave: () => void;
    onLoad: (id: string, op: ChannelSelectOp) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
  };
  /** Active document facts for the Metadata panel. */
  docName: string;
  /** Info panel: live pointer readout + document metrics. */
  subscribeCursor: (fn: (p: { x: number; y: number } | null) => void) => () => void;
  subscribeGesture: (fn: (m: GestureReadout) => void) => () => void;
  samplers: ColorSampler[];
  onRemoveSampler: (id: string) => void;
  onClearSamplers: () => void;
  docWidth: number;
  docHeight: number;
  unit?: MeasureUnit;
  dpi?: number;
  colorSpace: WorkingSpace;
  imageMeta: ImageMetadata | null;
  /** Write an edit from the panel's editable fields (description/artist/copyright)
   *  into the active document's metadata. */
  onEditMeta: (patch: Partial<ImageMetadata>) => void;
  /** Macro recorder state + verbs for the Actions panel. */
  actionsApi: ActionsApi;
  /** Stored pen paths + verbs for the Paths panel. */
  pathsApi: PathsApi;
  /** Named layer-state snapshots + verbs for the Layer Comps panel. */
  compsApi: CompsApi;
  docDpi?: number;
  /** Portal target for the LEFT dock column (Editor renders the host div). */
  leftHost?: HTMLElement | null;
  /** Portal target for floating panels (an overlay above the canvas). */
  floatHost?: HTMLElement | null;
  /** Imperative layout capture/apply for workspaces + Reset Workspace. */
  dockRef?: RefObject<DockApi | null>;
  /** Transient status message (clipboard results from the Color panel menu). */
  onToast: (message: string) => void;
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
  brush,
  onBrush,
  tool,
  layers,
  history,
  maxHistoryRows,
  onHistoryJump,
  onSetHistorySource,
  onNonLinearHistory,
  historyLog,
  onTakeSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
  onSetSourceSnapshot,
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
  selection,
  selectionAngle,
  selectionPivot,
  channels,
  docName,
  subscribeCursor,
  subscribeGesture,
  samplers,
  onRemoveSampler,
  onClearSamplers,
  docWidth,
  docHeight,
  unit,
  dpi,
  colorSpace,
  imageMeta,
  onEditMeta,
  actionsApi,
  pathsApi,
  compsApi,
  docDpi = 300,
  leftHost = null,
  floatHost = null,
  dockRef,
  onToast,
}: Props) {
  const [order, setOrder] = useState<PanelId[]>(DEFAULT_ORDER);
  const [openMap, setOpenMap] = useState<Record<PanelId, boolean>>(DEFAULT_OPEN);
  const [left, setLeft] = useState<PanelId[]>([]);
  const [floats, setFloats] = useState<DockLayout["floats"]>({});
  const [floatTop, setFloatTop] = useState<PanelId | null>(null);
  const [dragId, setDragId] = useState<PanelId | null>(null);

  // Load the saved order + open state after mount (avoids a hydration mismatch).
  useEffect(() => {
    setOrder(loadOrder());
    setOpenMap(loadOpen());
    const l = loadLayout();
    setLeft(l.left);
    setFloats(l.floats);
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
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left, floats }));
    } catch {
      /* ignore */
    }
  }, [left, floats]);

  // Workspaces + Reset Workspace drive the whole layout through this handle.
  if (dockRef) {
    dockRef.current = {
      capture: () => ({ order, left, floats, open: openMap }),
      apply: (l) => {
        if (!l) {
          setOrder(DEFAULT_ORDER);
          setOpenMap(DEFAULT_OPEN);
          setLeft([]);
          setFloats({});
          return;
        }
        const saved = (l.order ?? []).filter(isPanelId);
        setOrder([...saved, ...DEFAULT_ORDER.filter((id) => !saved.includes(id))]);
        const c = coerceLayout(l);
        setLeft(c.left);
        setFloats(c.floats);
        setOpenMap({ ...DEFAULT_OPEN, ...(l.open ?? {}) });
      },
    };
  }

  const toggleOpen = (id: PanelId) => setOpenMap((cur) => ({ ...cur, [id]: !cur[id] }));

  const isFloating = (id: PanelId) => !!floats[id];
  const toggleFloat = (id: PanelId) => {
    setFloats((cur) => {
      if (cur[id]) {
        const next = { ...cur };
        delete next[id];
        return next;
      }
      // Cascade new floats so stacking several stays readable.
      const n = Object.keys(cur).length;
      return { ...cur, [id]: { x: 48 + n * 28, y: 48 + n * 28 } };
    });
    setFloatTop(id);
  };

  // Move a floating panel by its grip (pointer drag; positions are LOCAL px in
  // the zoomed float host, so viewport deltas divide by the UI zoom).
  const beginFloatDrag = (e: ReactPointerEvent<HTMLElement>, id: PanelId) => {
    e.preventDefault();
    const start = floats[id];
    if (!start) return;
    setFloatTop(id);
    const z = uiZoom();
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      setFloats((cur) =>
        cur[id]
          ? {
              ...cur,
              [id]: {
                x: Math.max(0, start.x + (ev.clientX - sx) / z),
                y: Math.max(0, start.y + (ev.clientY - sy) / z),
              },
            }
          : cur,
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Drop on a dock's empty tail: join that dock at the end of the order. */
  const moveToDockEnd = (id: PanelId, side: "left" | "right") => {
    setLeft((cur) =>
      side === "left" ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id),
    );
    setOrder((cur) => (cur[cur.length - 1] === id ? cur : [...cur.filter((x) => x !== id), id]));
  };

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

  // Drag wiring shared by every docked panel. `draggable`/start/end go on the
  // header (the handle); `onDragOver` is the section-level drop target that
  // reorders — and, when the target sits in the OTHER dock, moves the dragged
  // panel's membership there first (live cross-dock preview).
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
      const targetLeft = left.includes(id);
      setLeft((cur) => {
        const has = cur.includes(dragId);
        if (targetLeft === has) return cur;
        return targetLeft ? [...cur, dragId] : cur.filter((x) => x !== dragId);
      });
      const r = e.currentTarget.getBoundingClientRect();
      reorder(dragId, id, e.clientY - r.top < r.height / 2);
    },
    onDragEnd: () => setDragId(null),
  });

  const panelFor = (id: PanelId): ReactNode => {
    const floating = isFloating(id);
    const dp = {
      // Floating panels move by their grip, not HTML5 DnD.
      ...(floating ? { draggable: false } : dragProps(id)),
      open: openMap[id],
      onToggle: () => toggleOpen(id),
      floating,
      onFloat: () => toggleFloat(id),
    };
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
            <ChannelsPanel
              engineRef={engineRef}
              tree={layers.layers}
              api={layers}
              selection={selection}
              selectionAngle={selectionAngle}
              selectionPivot={selectionPivot}
              channels={channels}
            />
          </Panel>
        ) : null;
      case "color":
        return panels.color ? (
          <Panel
            key="color"
            title="Color"
            icon={Palette}
            actions={
              <ColorPanelMenu
                foreground={foreground}
                background={background}
                onForeground={onForeground}
                onBackground={onBackground}
                active={activeSlot}
                onToast={onToast}
              />
            }
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
      case "swatches":
        return panels.swatches ? (
          <Panel key="swatches" title="Swatches" icon={SwatchBook} {...dp}>
            <SwatchesPanel
              foreground={foreground}
              onForeground={onForeground}
              engineRef={engineRef}
              tree={layers.layers}
              docName={docName}
            />
          </Panel>
        ) : null;
      case "info":
        return panels.info ? (
          <Panel key="info" title="Info" icon={Info} {...dp}>
            <InfoPanel
              subscribeCursor={subscribeCursor}
              subscribeGesture={subscribeGesture}
              samplers={samplers}
              onRemoveSampler={onRemoveSampler}
              onClearSamplers={onClearSamplers}
              engineRef={engineRef}
              selection={selection}
              width={docWidth}
              height={docHeight}
              unit={unit}
              dpi={dpi}
            />
          </Panel>
        ) : null;
      case "brushes":
        return panels.brushes ? (
          <Panel key="brushes" title="Brushes" icon={Brush} {...dp}>
            <BrushesPanel brush={brush} onBrush={onBrush} tool={tool} foreground={foreground} />
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
              nonLinear={history.nonLinear}
              priorLog={historyLog}
              onNonLinear={onNonLinearHistory}
              sourceIndex={history.sourceIndex}
              onJump={onHistoryJump}
              onSetSource={onSetHistorySource}
              snapshots={history.snapshots}
              sourceSnapshotId={history.sourceSnapshotId}
              onTakeSnapshot={onTakeSnapshot}
              onRestoreSnapshot={onRestoreSnapshot}
              onDeleteSnapshot={onDeleteSnapshot}
              onSetSourceSnapshot={onSetSourceSnapshot}
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
      case "comps":
        return panels.comps ? (
          <Panel key="comps" title="Layer Comps" icon={Camera} {...dp}>
            <CompsPanel api={compsApi} />
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

  const rightIds = order.filter((id) => !left.includes(id) && !isFloating(id));
  const leftIds = order.filter((id) => left.includes(id) && !isFloating(id));
  const floatIds = order.filter((id) => isFloating(id));

  /** Drop target for a dock's empty space (also how the left dock starts). */
  const dropZone = (side: "left" | "right") =>
    dragId ? (
      <div
        className={styles.dockDropZone}
        onDragOver={(e) => {
          e.preventDefault();
          moveToDockEnd(dragId, side);
        }}
        onDrop={(e) => e.preventDefault()}
      />
    ) : null;

  return (
    <>
      <aside className={styles.dock} aria-label="Panels" data-tour="dock">
        {rightIds.map((id) => panelFor(id))}
        {dropZone("right")}
      </aside>
      {leftHost &&
        createPortal(
          <>
            {leftIds.map((id) => panelFor(id))}
            {dropZone("left")}
          </>,
          leftHost,
        )}
      {floatHost &&
        createPortal(
          floatIds.map((id) => {
            const node = panelFor(id);
            const pos = floats[id];
            if (!node || !pos) return null;
            return (
              <div
                key={id}
                className={styles.floatPanel}
                style={{ left: pos.x, top: pos.y, zIndex: floatTop === id ? 2 : 1 }}
                onPointerDown={() => setFloatTop(id)}
              >
                <div
                  className={styles.floatGrip}
                  title="Drag to move this panel"
                  onPointerDown={(e) => beginFloatDrag(e, id)}
                >
                  <span />
                </div>
                {node}
              </div>
            );
          }),
          floatHost,
        )}
    </>
  );
}
