"use client";

import { useEffect, useImperativeHandle, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import SheetHandle, { type Detent } from "./SheetHandle";
import { uiZoom } from "../lib/ui-scale";
import { type WorkingSpace } from "../lib/colorspace";
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
import Panel, { type PanelTab } from "./Panel";
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
import { Camera, Spline, type LucideIcon } from "lucide-react";
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
/* A panel's NAME and ICON, in one place. They used to exist only inline in the
   switch that builds each panel, which was fine while the only thing that needed
   them was the panel's own header — a tab strip needs them too, and reading them
   back out of a rendered element would be worse than naming them here. */
const PANEL_TITLES: Record<PanelId, string> = {
  navigator: "Navigator",
  channels: "Channels",
  color: "Color",
  swatches: "Swatches",
  brushes: "Brushes",
  adjustments: "Adjustments",
  properties: "Properties",
  layers: "Layers",
  paths: "Paths",
  comps: "Layer Comps",
  history: "History",
  actions: "Actions",
  metadata: "Metadata",
  info: "Info",
};
const PANEL_ICONS: Record<PanelId, LucideIcon> = {
  navigator: Compass,
  channels: BarChart3,
  color: Palette,
  swatches: SwatchBook,
  brushes: Brush,
  adjustments: SlidersHorizontal,
  properties: Settings2,
  layers: Layers,
  paths: Spline,
  comps: Camera,
  history: History,
  actions: Zap,
  metadata: Info,
  info: Info,
};

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
  /**
   * TABBED GROUPS: panel id → group key. Panels sharing a key share one frame,
   * shown as a tab strip, drawn at the position of their FIRST member in `order`.
   *
   * A map rather than an array of arrays, and layered OVER `order` rather than
   * replacing it, because everything else in the dock — reordering, dock
   * membership, the Window menu, workspaces — already reads `order` and keeps
   * working untouched. Membership is the only new fact; sequence still comes
   * from the one place it always did.
   */
  groups?: Partial<Record<PanelId, string>>;
  /** Which member of each group is showing. Absent → its first open member. */
  activeTab?: Partial<Record<string, PanelId>>;
}

/** Imperative capture/apply for workspaces + Reset Workspace (null = defaults). */
export interface DockApi {
  capture: () => DockLayout;
  apply: (layout: DockLayout | null) => void;
}

const isPanelId = (v: unknown): v is PanelId => (DEFAULT_ORDER as string[]).includes(v as string);

interface CoercedLayout {
  left: PanelId[];
  floats: DockLayout["floats"];
  groups: Partial<Record<PanelId, string>>;
  activeTab: Partial<Record<string, PanelId>>;
}
const emptyLayout = (): CoercedLayout => ({ left: [], floats: {}, groups: {}, activeTab: {} });

/** Validate a stored/imported layout fragment (unknown ids and junk dropped). */
function coerceLayout(raw: unknown): CoercedLayout {
  const out = emptyLayout();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as { left?: unknown; floats?: unknown; groups?: unknown; activeTab?: unknown };
  if (Array.isArray(o.left)) out.left = o.left.filter(isPanelId);
  if (o.floats && typeof o.floats === "object") {
    for (const [id, p] of Object.entries(o.floats as Record<string, { x?: unknown; y?: unknown }>)) {
      if (isPanelId(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        out.floats[id] = { x: Math.max(0, p.x as number), y: Math.max(0, p.y as number) };
      }
    }
  }
  if (o.groups && typeof o.groups === "object") {
    for (const [id, key] of Object.entries(o.groups as Record<string, unknown>)) {
      if (isPanelId(id) && typeof key === "string" && key) out.groups[id] = key;
    }
    /* A group of one is not a group. Stored layouts can arrive that way — an
       older file, a hand-edited workspace, or a member that was dropped as an
       unknown id above — and a one-tab frame would look like a bug. */
    const count = new Map<string, number>();
    for (const key of Object.values(out.groups)) count.set(key!, (count.get(key!) ?? 0) + 1);
    for (const [id, key] of Object.entries(out.groups))
      if ((count.get(key!) ?? 0) < 2) delete out.groups[id as PanelId];
  }
  if (o.activeTab && typeof o.activeTab === "object") {
    for (const [key, id] of Object.entries(o.activeTab as Record<string, unknown>)) {
      if (typeof key === "string" && isPanelId(id) && out.groups[id] === key) out.activeTab[key] = id;
    }
  }
  return out;
}

function loadLayout(): CoercedLayout {
  if (typeof window === "undefined") return emptyLayout();
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? coerceLayout(JSON.parse(raw)) : emptyLayout();
  } catch {
    return emptyLayout();
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
  /** Touch: the dock is a bottom sheet, and these drive its height. */
  mobile?: boolean;
  /** A touch device that is not a phone: one home for panels, but no bottom
   *  sheet and no accordion — a tablet has the height for several at once. */
  tablet?: boolean;
  detent?: Detent;
  onDetent?: (d: Detent) => void;
  /** Imperative layout capture/apply for workspaces + Reset Workspace. */
  dockRef?: RefObject<DockApi | null>;
  /** Transient status message (clipboard results from the Color panel menu). */
  onToast: (message: string) => void;
}

/**
 * What a drop would do, shown while dragging and carried out on release.
 * `before`/`after` place the panel on its own either side of `id`; `group` makes
 * it a tab of `id`; `end` puts it at the bottom of a dock.
 */
export type DropHint =
  | { kind: "before" | "after" | "group"; id: PanelId }
  | { kind: "end"; side: "left" | "right" };

/** The group-aware extras a dock render passes into one panel's frame. */
interface PanelExtra {
  tabs: PanelTab[];
  dropHint: "before" | "after" | "group" | undefined;
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
  mobile = false,
  tablet = false,
  detent,
  onDetent,
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
  /* Dev-only commit counter, in the same family as CanvasArea's __gq hooks.
     The question it answers: does a closed panel drawer keep re-rendering
     while a stroke is being painted? (Measured: twice across a thirty-step
     stroke, against 52 with the sheet open — see tools/verify-stranded-panels.js.)
     No dep array, so it ticks once per commit. */
  useEffect(() => {
    const w = window as unknown as { __gqPanelRenders?: number };
    w.__gqPanelRenders = (w.__gqPanelRenders ?? 0) + 1;
  });

  const [openMap, setOpenMap] = useState<Record<PanelId, boolean>>(DEFAULT_OPEN);
  /* ---- The phone's accordion --------------------------------------------
     On a desktop the dock is a tall column and five panels open at once is
     convenient. In a bottom sheet it is the difference between usable and not:
     with the default five expanded, the stack measured 4086px, the LAYERS
     header sat 3488px down it, and only four of sixteen panels could be
     reached without scrolling — at any height. One open at a time keeps the
     stack to fifteen headers plus one panel, so everything is a tap away.

     Its own state, never persisted: the desktop layout is saved under
     OPEN_KEY, and writing a phone's "everything shut" over it would collapse
     someone's carefully arranged dock the next time they sat down. */
  const [mobileOpenId, setMobileOpenId] = useState<PanelId | null>(null);
  const [left, setLeft] = useState<PanelId[]>([]);
  const [floats, setFloats] = useState<DockLayout["floats"]>({});
  const [floatTop, setFloatTop] = useState<PanelId | null>(null);
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [groups, setGroups] = useState<Partial<Record<PanelId, string>>>({});
  const [activeTab, setActiveTab] = useState<Partial<Record<string, PanelId>>>({});
  /** What the drop under the pointer would do. Drawn as an insertion line or a
   *  highlight, so a drag never has to be guessed at. */
  const [hint, setHint] = useState<DropHint | null>(null);
  /**
   * The panel being dragged, in a REF as well as in state.
   *
   * The handlers read the ref, never `dragId`. A drag is a discrete event, so
   * React flushes any `setState` during it synchronously and re-renders — which
   * replaces the very handlers the browser is midway through dispatching, and a
   * closure that captured `dragId` before the flush reads `null` afterwards and
   * silently does nothing. `dragId` stays, but only to drive what is DRAWN.
   */
  const dragRef = useRef<PanelId | null>(null);
  /** Ends a drag from anywhere: the ref first, then what is drawn. */
  const endDrag = () => {
    dragRef.current = null;
    setDragId(null);
    setHint(null);
  };

  // Load the saved order + open state after mount (avoids a hydration mismatch).
  /* Reading localStorage during render would produce one thing on the server
     (where there is none) and another on the client — a hydration mismatch. An
     effect after mount is the fix for that, not a symptom of one, so the
     cascading-render rule is suppressed across this block deliberately.

     (The suppression once reported itself as unused: a render-time mutation
     further up made the react-hooks plugin bail out of analysing this
     component, so the rule it silences never ran. Fixing that brought it
     back.) */
  /* eslint-disable react-hooks/set-state-in-effect -- see above */
  useEffect(() => {
    setOrder(loadOrder());
    setOpenMap(loadOpen());
    const l = loadLayout();
    setLeft(l.left);
    setFloats(l.floats);
    setGroups(l.groups);
    setActiveTab(l.activeTab);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
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
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left, floats, groups, activeTab }));
    } catch {
      /* ignore */
    }
  }, [left, floats, groups, activeTab]);

  // Workspaces + Reset Workspace drive the whole layout through this handle.
  // Published with useImperativeHandle rather than assigned during render: a ref
  // written mid-render is not safe under concurrent rendering, and this one is
  // only ever CALLED from menu handlers, never read while rendering (every call
  // site in Editor.tsx goes through `dockRef.current?.`), so publishing it in the
  // commit phase changes nothing about when it is available.
  useImperativeHandle(
    dockRef,
    () => ({
      capture: () => ({ order, left, floats, open: openMap, groups, activeTab }),
      apply: (l: DockLayout | null) => {
        if (!l) {
          setOrder(DEFAULT_ORDER);
          setOpenMap(DEFAULT_OPEN);
          setLeft([]);
          setFloats({});
          setGroups({});
          setActiveTab({});
          return;
        }
        const saved = (l.order ?? []).filter(isPanelId);
        setOrder([...saved, ...DEFAULT_ORDER.filter((id) => !saved.includes(id))]);
        const c = coerceLayout(l);
        setLeft(c.left);
        setFloats(c.floats);
        setGroups(c.groups);
        setActiveTab(c.activeTab);
        setOpenMap({ ...DEFAULT_OPEN, ...(l.open ?? {}) });
      },
    }),
    [order, left, floats, openMap, groups, activeTab],
  );

  /**
   * End a drag from the WINDOW, not from the node it started on.
   *
   * Dragging a panel to the other dock moves it between two portals, so React
   * unmounts the node the drag began on and mounts a new one. The browser still
   * fires `dragend` at the original node — which is now detached, so the event
   * reaches nothing and `dragId` stays set. Both things it drives then linger:
   * the panel keeps its half-opacity dragging tint and every dock keeps showing
   * its dashed drop zone, until some later interaction happens to clear them.
   *
   * NOT `drop`, deliberately. A capture listener on the window runs before the
   * event reaches the panel, and clearing state there re-renders the dock mid
   * dispatch — which swapped out the very `onDrop` about to be called and made
   * every drop a no-op. Drops clear themselves through `applyDrop`; this only
   * has to catch a drag that ends WITHOUT one, where `dragend` fires on a source
   * that necessarily still exists because nothing moved. Escape covers a cancel.
   */
  useEffect(() => {
    if (!dragId) return;
    const onEnd = () => endDrag();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag();
    };
    window.addEventListener("dragend", onEnd, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("dragend", onEnd, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dragId]);

  const toggleOpen = (id: PanelId) => setOpenMap((cur) => ({ ...cur, [id]: !cur[id] }));

  /** Is this panel showing? On a phone, only the one that was opened last. */
  const isOpen = (id: PanelId): boolean => (mobile ? mobileOpenId === id : openMap[id]);

  /**
   * Open or close a panel.
   *
   * On a phone this also RAISES the sheet when the panel that just opened is
   * taller than the room available — and never lowers it. Growing to fit what
   * you asked for is helpful; shrinking under you after you deliberately made
   * the sheet tall is not, which is why the rule is one-directional.
   *
   * The height is measured after the panel has rendered rather than read from
   * a list of "tall" panels: such a list is wrong the moment a panel gains a
   * row, and nothing would say so.
   */
  const togglePanel = (id: PanelId) => {
    if (!mobile) {
      toggleOpen(id);
      return;
    }
    const opening = mobileOpenId !== id;
    setMobileOpenId(opening ? id : null);
    if (!opening || !onDetent) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const dock = document.querySelector('[data-tour="dock"]');
        const section = document.querySelector(`[data-panel-id="${id}"]`);
        if (!dock || !section) return;
        const need = section.getBoundingClientRect().height;
        const have = dock.getBoundingClientRect().height;
        if (need <= have) return;
        if (detent === "peek") onDetent("half");
        else if (detent === "half") onDetent("full");
      });
    });
  };

  /* ---- tabbed groups ----------------------------------------------------
   *
   * A group is a set of panels sharing a key in `groups`. It is drawn as one
   * frame at the position of its first member in `order`, with a tab strip in
   * place of the single title. Nothing else about the dock changes: `order`
   * still decides sequence, `left` still decides which dock, and a member that
   * is closed or floated simply is not in the strip.
   */

  /** Members of a group, in `order`, restricted to one dock's ids AND to panels
   *  the Window menu is actually showing — a hidden member must not appear as a
   *  tab, and must not be able to become the frame's active tab, or the whole
   *  group would render as nothing when panelFor returned null for it. */
  const membersOf = (key: string, within: PanelId[]) =>
    within.filter((id) => groups[id] === key && panels[id]);

  /** Drop a panel out of whatever group it is in, dissolving any group of one. */
  const dropFromGroup = (
    g: Partial<Record<PanelId, string>>,
    id: PanelId,
  ): Partial<Record<PanelId, string>> => {
    const key = g[id];
    if (!key) return g;
    const next = { ...g };
    delete next[id];
    const rest = (Object.keys(next) as PanelId[]).filter((p) => next[p] === key);
    if (rest.length < 2) for (const p of rest) delete next[p]; // a lone tab is not a group
    return next;
  };

  /** Put `from` into `onto`'s group, creating one if `onto` has none. */
  const joinGroup = (from: PanelId, onto: PanelId) => {
    if (from === onto) return;
    setGroups((cur) => {
      const key = cur[onto] ?? `g${Date.now().toString(36)}`;
      if (cur[from] === key) return cur;
      const next = dropFromGroup(cur, from);
      next[onto] = key;
      next[from] = key;
      return next;
    });
    // A group lives in ONE dock: joining moves the panel to its host's side,
    // and a floating panel docks again, or the frame would be split in two.
    setLeft((cur) => {
      const ontoLeft = cur.includes(onto);
      const fromLeft = cur.includes(from);
      if (ontoLeft === fromLeft) return cur;
      return ontoLeft ? [...cur, from] : cur.filter((x) => x !== from);
    });
    setFloats((cur) => {
      if (!cur[from] && !cur[onto]) return cur;
      const next = { ...cur };
      delete next[from];
      delete next[onto];
      return next;
    });
    setActiveTab((cur) => ({ ...cur, [groups[onto] ?? ""]: from }));
    setOpenMap((cur) => (cur[from] ? cur : { ...cur, [from]: true })); // a new tab shows itself
  };

  const leaveGroup = (id: PanelId) => setGroups((cur) => dropFromGroup(cur, id));

  /** The tab a group is showing: the stored one if it is still a member and
   *  open, otherwise the first member that is. */
  const activeOf = (key: string, members: PanelId[]): PanelId | null => {
    const stored = activeTab[key];
    if (stored && members.includes(stored)) return stored;
    return members[0] ?? null;
  };

  const isFloating = (id: PanelId) => !!floats[id];
  const toggleFloat = (id: PanelId) => {
    // Floating takes a panel out of its tab strip: a float is one panel over the
    // canvas, and leaving it in the group would draw it in two places at once.
    setGroups((cur) => dropFromGroup(cur, id));
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
    setGroups((cur) => dropFromGroup(cur, id)); // the tail of a dock is not a group
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

  /**
   * Which of the three things a drop on `id` would do, from where the pointer
   * is inside it.
   *
   * A band at each EDGE inserts the panel before or after; everything between
   * joins it to that panel as a tab. Two reasons it is a fixed band rather than
   * the top and bottom halves. First, "next to" and "inside" are different
   * intents and both have to be reachable on every panel — splitting at the
   * midpoint offers no way to say "inside" at all. Second, a COLLAPSED panel is
   * 34px of pure header, and the old rule handed all 34 of them to grouping,
   * which is why a panel dropped between two others so reliably ended up inside
   * one instead. The band is capped at a third of the height so the middle never
   * disappears on a short panel.
   */
  const EDGE_BAND = 10;
  const zoneOf = (rect: DOMRect, clientY: number): "before" | "after" | "group" => {
    const band = Math.min(EDGE_BAND, rect.height / 3);
    const y = clientY - rect.top;
    if (y < band) return "before";
    if (y > rect.height - band) return "after";
    return "group";
  };

  /* Drag wiring shared by every docked panel. The header is the handle; the
     SECTION is the drop target, and it only ever records what a drop WOULD do.
     Nothing moves until the drop itself — the old code reordered and changed
     dock membership live on every dragover, which reshuffled the list under the
     pointer while you were still aiming at it. */
  const dragProps = (id: PanelId) => ({
    draggable: true,
    dragging: dragId === id,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      dragRef.current = id;
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const from = dragRef.current;
      if (!from || from === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setHint({ kind: zoneOf(e.currentTarget.getBoundingClientRect(), e.clientY), id });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const from = dragRef.current;
      if (!from || from === id) return;
      e.preventDefault();
      e.stopPropagation();
      applyDrop(from, { kind: zoneOf(e.currentTarget.getBoundingClientRect(), e.clientY), id });
    },
    onDragEnd: endDrag,
  });

  /** Carry out what the hint promised. The only place membership changes. */
  const applyDrop = (from: PanelId, hint: DropHint) => {
    if (hint.kind === "end") {
      moveToDockEnd(from, hint.side);
    } else if (hint.kind === "group") {
      joinGroup(from, hint.id);
    } else {
      // Its own panel, next to the target: out of any group, into the target's
      // dock, and either side of it.
      leaveGroup(from);
      const targetLeft = left.includes(hint.id);
      setLeft((cur) => {
        const has = cur.includes(from);
        if (targetLeft === has) return cur;
        return targetLeft ? [...cur, from] : cur.filter((x) => x !== from);
      });
      reorder(from, hint.id, hint.kind === "before");
    }
    endDrag();
  };

  const panelFor = (id: PanelId, extra?: Partial<PanelExtra>): ReactNode => {
    const floating = isFloating(id);
    const dp = {
      // Floating panels move by their grip, not HTML5 DnD.
      ...(floating ? { draggable: false } : dragProps(id)),
      panelId: id,
      open: isOpen(id),
      onToggle: () => togglePanel(id),
      floating,
      onFloat: () => toggleFloat(id),
      /* One drop target per panel, not two. The header used to carry its own
         grouping handler that stopped propagation so the section's reorder could
         not also fire; with the zoning above, the header's middle already IS the
         group band, and one handler cannot fight itself. */
      dropHint:
        hint && hint.kind !== "end" && hint.id === id && dragId && dragId !== id ? hint.kind : undefined,
      ...extra,
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

  /* ---- On a phone there is ONE home for panels -------------------------
     The desktop has three: a right dock, a left dock and free-floating
     windows. The mobile shell shows only the first, which stranded anything
     the user had arranged into the other two — a panel docked left or left
     floating was rendered into a host the phone hides, so it existed and was
     unreachable. Seeded and measured: 13 of 14 panels in the sheet, with the
     14th nowhere a finger could go.

     The left dock host is worse than absent, too: at 360px it still lays out
     over the screen and swallows every press, so with a panel docked left even
     the start card could not be dismissed.

     So on touch the sheet holds `order` — all of them — and the two other
     hosts are not portaled into at all (see the `!mobile` guards below). The
     ids below stay plain derived values, unread on a phone; deciding it once,
     at the portal, is what keeps the left host from laying itself over the
     screen. The stored layout is untouched either way: plug the same profile
     into a desktop and the left dock and the floats are where they were. */
  /* Both touch shells fold every panel into one dock, for the same reason:
     the left dock and the float host are positioned by DRAGGING, and a finger
     is worst at exactly that. What differs is the dock — a bottom sheet on a
     phone, a side drawer on a tablet — and that is CSS, not this. */
  const oneHome = mobile || tablet;
  const rightIds = oneHome ? order : order.filter((id) => !left.includes(id) && !isFloating(id));
  const leftIds = order.filter((id) => left.includes(id) && !isFloating(id));
  const floatIds = order.filter((id) => isFloating(id));

  /**
   * One dock's contents, with grouped panels collapsed into a single frame.
   *
   * Walks the dock's ids in `order` and renders the first member of each group
   * as a tabbed frame, skipping the rest — so a group appears exactly where its
   * earliest member sits, and reordering any member moves the group. A group
   * whose members ended up split across docks renders as one frame per dock,
   * which is the only sensible reading of "these two are in different places";
   * joining forces them into the same dock so it should not arise.
   */
  const renderDock = (ids: PanelId[]): ReactNode[] => {
    const out: ReactNode[] = [];
    const drawn = new Set<string>();
    for (const id of ids) {
      const key = groups[id];
      if (!key) {
        out.push(panelFor(id));
        continue;
      }
      if (drawn.has(key)) continue;
      drawn.add(key);
      const members = membersOf(key, ids);
      /* Render the surviving MEMBER, not the id this loop happened to reach:
         with the other members hidden by the Window menu, `id` may be the hidden
         one, and panelFor would return null while the visible member was already
         marked as drawn — the group would disappear entirely. */
      if (members.length === 0) continue;
      if (members.length === 1) {
        out.push(panelFor(members[0])); // a lone member is just a panel
        continue;
      }
      const active = activeOf(key, members) ?? members[0];
      out.push(
        panelFor(active, {
          tabs: members.map((m) => ({
            id: m,
            title: PANEL_TITLES[m],
            icon: PANEL_ICONS[m],
            active: m === active,
            onSelect: () => setActiveTab((cur) => ({ ...cur, [key]: m })),
            // Dragging a TAB is how a panel leaves the group.
            draggable: true,
            onDragStart: (e: DragEvent<HTMLElement>) => {
              dragRef.current = m; // the handlers read the ref, not the state
              setDragId(m);
              e.dataTransfer.effectAllowed = "move";
            },
            onDragEnd: endDrag,
          })),
        }),
      );
    }
    return out;
  };

  /** Drop target for a dock's empty space (also how the left dock starts). */
  const dropZone = (side: "left" | "right") =>
    dragId ? (
      <div
        className={styles.dockDropZone}
        data-active={hint?.kind === "end" && hint.side === side ? "" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHint({ kind: "end", side });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId) applyDrop(dragId, { kind: "end", side });
        }}
      />
    ) : null;

  return (
    <>
      <aside className={styles.dock} aria-label="Panels" data-tour="dock">
        {/* Touch only: the dock is a bottom sheet there, and a sheet needs
            something to take hold of. */}
        {mobile && detent && onDetent && <SheetHandle detent={detent} onDetent={onDetent} />}
        {renderDock(rightIds)}
        {dropZone("right")}
      </aside>
      {/* Not on touch: see `rightIds` above — the one dock already holds these,
          and an empty left host still lays out at its full width. */}
      {!oneHome &&
        leftHost &&
        createPortal(
          <>
            {renderDock(leftIds)}
            {dropZone("left")}
          </>,
          leftHost,
        )}
      {!oneHome &&
        floatHost &&
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
