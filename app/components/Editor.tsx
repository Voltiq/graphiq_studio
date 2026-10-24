"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setLookAttribute, watchSystemLook } from "../lib/look";
import { createPortal } from "react-dom";
import styles from "./Editor.module.scss";
import TopBar from "./TopBar";
import Toolbar from "./Toolbar";
import OptionsBar from "./OptionsBar";
import CanvasArea, { type ViewApi } from "./CanvasArea";
import RightDock, { type DockApi, type PanelVisibility } from "./RightDock";
import WorkspacesDialog, { type WorkspaceSnap } from "./WorkspacesDialog";
import StatusBar from "./StatusBar";
import CanvasSizeDialog, { type CanvasSize } from "./CanvasSizeDialog";
import PasteDialog from "./PasteDialog";
import PreferencesDialog, { type PrefsTab } from "./PreferencesDialog";
import HelpDialog from "./HelpDialog";
import AboutDialog from "./AboutDialog";
import TooltipHost from "./Tooltip";
import {
  PROOF_TARGET_LABELS,
  canvasSpaceOf,
  proofIsIdentity,
  proofTransformInPlace,
  type ProofTarget,
  type WorkingSpace,
} from "../lib/colorspace";
import { layoutPage, type PdfLayoutOptions } from "../lib/pdf";
import { boxOf } from "../lib/selection-transform";
import {
} from "../lib/vector-mask";
import { textFxCount } from "../lib/text-fx";
import { DEFAULT_GLOBAL_LIGHT, sanitizeGlobalLight, type GlobalLight } from "../lib/global-light";
import { extractICCProfile } from "../lib/icc";
import { type Preferences } from "../lib/prefs";
import { FX_GRADIENT_PRESETS_KEY, GRADIENT_PRESETS_KEY } from "../lib/gradientio";
import {
  defaultFrame,
  fitContent,
  type FrameFit,
  type FrameSpec,
} from "../lib/frame";
import {
  applyIsolation,
  hiddenByIsolation,
  normalizeIsolation,
  resolveIsolation,
} from "../lib/isolate";
import {
  applyComp,
  captureComp,
  compIsCurrent,
  freshCompId,
  uniqueCompName,
  type CompsApi,
  type LayerComp,
} from "../lib/comps";
import {
  clearAutosave,
  installHeartbeat,
  readAutosave,
  wasUncleanExit,
  writeAutosave,
  type AutosaveDoc,
  type AutosaveSnapshot,
} from "../lib/autosave";
import { registerRecovery } from "../lib/crash";
import { dismissTop, registerDismissible } from "../lib/dismiss";
import { installModifierInjection } from "../lib/modifiers";
import { registerRawDeveloper } from "../lib/rawdev";
import RawDevelopDialog from "./RawDevelopDialog";
import PatternFillDialog, { type PatternFillResult } from "./PatternFillDialog";
import type { RawDevelopOptions } from "../lib/dng";
import { loadToolPrefs, saveToolPrefs } from "../lib/toolPrefs";
import { EditorStoresProvider, createEditorStores } from "../state/editor";
import { useStore } from "../state/store";
import { brushOf, persistToolOptions, restoreToolOptions } from "../state/toolOptions";
import { ALL_PANELS, restoreView, setPanels, setViewFlags, type ViewFlags } from "../state/view";
import { openPrefs as openPrefsOn, openSize, type ToneEdit } from "../state/dialogs";
import type { Doc } from "../state/documents";
import { restorePrefs, updatePrefs as updatePrefsIn } from "../state/prefs";
import { brushKey, stepHardness, stepSize } from "../lib/brush-keys";
import {
  cleanChannelName,
  freshChannelId,
  loadLabel,
  removeChannel,
  renameChannel,
  selectionChannelKey,
  type ChannelSelectOp,
  type SavedChannel,
} from "../lib/channels";
import {
  ALIGN_LABEL,
  DISTRIBUTE_LABEL,
  alignDeltas,
  distributeDeltas,
  nonZero,
  unionBox,
  type AlignMode,
  type Box as AlignBox,
  type Delta,
  type DistributeMode,
} from "../lib/align";
import {
  DEFAULT_TOOL,
  measureInfo,
  type TextRun,
  type CropQuad,
  type PenAnchor,
  type VectorText,
  type MeasureLine,
  type ToolId,
} from "../lib/tools";
import { estimateQuadSize } from "../lib/homography";
import { warpActive, warpedBounds } from "../lib/textwarp";
import type { Theme } from "../lib/theme";
import type { Pan, Rect } from "../lib/view";
import {
  collectLeafIds,
  findNode,
  flattenedIds,
  clearLinkKey,
  isFillLayer,
  insertInGroup,
  insertRelative,
  isLinked,
  isPixelsLocked,
  isTransparencyLocked,
  newLinkKey,
  pruneLinks,
  setLinkKey,
  removeNode,
  topLevelSelected,
  quickMaskKey,
  updateNode,
  type ActiveSurface,
  type Layer,
  type LayerLocks,
  type LayerNode,
  type LayersApi,
} from "../lib/layers";
import type {
  BrushSettings,
  EngineHandle,
  TextRenderSpec,
} from "../lib/paint";
import BlurGalleryDialog from "./BlurGalleryDialog";
import SelectionChannelDialog from "./SelectionChannelDialog";
import LiquifyDialog from "./LiquifyDialog";
import MobileBar, { type MobileDrawer } from "./MobileBar";
import { useVisualViewport } from "../lib/useVisualViewport";
import { encodePngOffThread } from "../lib/png-offthread";
import { useGestureGuard } from "../lib/useGestureGuard";
import { TOUCH_QUERY, useIsMobile, useIsTablet, useMediaQuery } from "../lib/useMediaQuery";
import TrimDialog from "./TrimDialog";
import SelectModifyDialog from "./SelectModifyDialog";
import LayerStyleDialog from "./LayerStyleDialog";
import CurvesDialog from "./CurvesDialog";
import LevelsDialog, { type EyedropKind } from "./LevelsDialog";
import Toast from "./Toast";
import SaveAsDialog from "./SaveAsDialog";
import RenameDocDialog from "./RenameDocDialog";
import MoreSpaceDialog from "./MoreSpaceDialog";
import { INSTALL_EVENT, INSTALL_SLOT } from "../lib/space";
import { checkSize, sharedCeiling } from "../lib/canvas-ceiling";
import { setCanvasFailureHandler } from "../lib/paint";
import RecentsDialog from "./RecentsDialog";
import ExportDialog from "./ExportDialog";
import ImportDialog, { type ImportItem, type ImportMode, type ImportOptions } from "./ImportDialog";
import StartCard from "./StartCard";
import { type Detent } from "./SheetHandle";

import ColorDialog from "./ColorDialog";
import ProfileCompareDialog from "./ProfileCompareDialog";
import {
  LEGACY_PROJECT_EXT,
  PROJECT_EXT,
  type PendingLoad,
} from "../lib/project";
import { type Guide } from "../lib/guides";
import {
  addSampler,
  moveSampler,
  removeSampler,
  samplerAt,
  type ColorSampler,
  type GestureReadout,
} from "../lib/samplers";
import {
  IMPORT_ACCEPT,
  decodeImageFile,
  p3Supported,
  setRawWorkerEnabled,
} from "../lib/imageio";
import { isCommandId } from "../lib/menus";
import { executeCommand, isRecordable, unavailableCommands } from "../commands/registry";
import { commandState } from "../commands/state";
import { layerOps, type Sel } from "../commands/layers";
import { maskOps } from "../commands/masks";
import { selectionOps, type SelState } from "../commands/selection";
import { adjustmentOps } from "../commands/adjustments";
import { effectOps } from "../commands/effects";
import { filterOps } from "../commands/filters";
import { fillOps } from "../commands/fills";
import { imageOps } from "../commands/image";
import { clipboardOps } from "../commands/clipboard";
import { exportOps } from "../commands/export";
import { documentOps } from "../commands/documents";
import { projectOps } from "../commands/projects";
import { sessionOps } from "../commands/sessions";
import { viewOps } from "../commands/view";
import { textOps } from "../commands/text";
import { workspaceOps } from "../commands/workspace";
import type { CommandOps } from "../commands/ops";
import { looksLikeSVG, parseSVGFile, translateVectorPath } from "../lib/svg";
import { parsePSD, type PsdDocument, type PsdImage, type PsdNode } from "../lib/psd";
import {
  addRecent,
  listRecentImages,
  makeThumb,
  readRecentFile,
  setRecentsLimit,
  type RecentImage,
} from "../lib/recents";
import {
  actionLabel,
  freshActionId,
  loadActions,
  saveActions,
  strokeStepLabel,
  PLAYBACK_STEP_MS,
  type ActionsApi,
  type SavedAction,
  type StrokeStep,
} from "../lib/actions";
import {
  cloneAnchors,
  freshPathId,
  samplePathPolygon,
  WORK_PATH_ID,
  type PathsApi,
  type PathSelectOp,
  type SavedPath,
} from "../lib/paths";
import {
  buildDispatchIndex,
  buildShortcutDefs,
  canonicalBinding,
  conflictOf,
  effectiveLabel,
  eventToBinding,
  formatBinding,
  loadShortcutOverrides,
  parseShortcut,
  saveShortcutOverrides,
  type ShortcutOverrides,
} from "../lib/shortcuts";
import {
  DEFAULT_ADJUST,
  filterToAdjust,
  type AdjustmentSpec,
  type Adjustments,
} from "../lib/adjust";
import {
  isExtraSpec,
  parseCubeLUT,
  type ExtraAdjustment,
} from "../lib/adjust-extra";
import AdjustmentExtraDialog from "./AdjustmentExtraDialog";
import {
  ANIMATED_EXT,
  decodeAnimation,
  frameLabel,
  type AnimImage,
} from "../lib/animated";
import type { CompareAxis } from "../lib/compare";
import DialogFocus from "./DialogFocus";
import FillDialog from "./FillDialog";
import NewGuideDialog from "./NewGuideDialog";
import ExportLutDialog from "./ExportLutDialog";
import ExportTiffDialog from "./ExportTiffDialog";
import ExportPdfDialog from "./ExportPdfDialog";
import PrintDialog from "./PrintDialog";
import HdrMergeDialog from "./HdrMergeDialog";
import BatchDialog from "./BatchDialog";
import { buildScriptingApi, type ScriptingDeps } from "../lib/scripting";
import TourOverlay from "./TourOverlay";
import HdrExportDialog from "./HdrExportDialog";
import type { HdrImage } from "../lib/hdr";
import type { LayerEffects } from "../lib/effects";
import SmartFilterDialog from "./SmartFilterDialog";
import WarpDialog from "./WarpDialog";
import RefineEdgeDialog from "./RefineEdgeDialog";
import ShortcutsDialog from "./ShortcutsDialog";
import NewDocDialog from "./NewDocDialog";
import RestoreDialog from "./RestoreDialog";
import {
  autoLevels,
  buildCurvesLUTs,
  curveLUT,
  curveSampler,
  solveGrayPoint,
  type ChannelKey,
  type ChannelParams,
  type CurvePoint,
  type ToneAdjustment,
} from "../lib/tone";
import { extractMetadata, type ImageMetadata } from "../lib/metadata";

/** Stable empty guide list — a fresh `[]` every render would churn the canvas. */
const EMPTY_GUIDES: Guide[] = [];

/** Anything that owns an Escape before the document does: popovers, dropdowns,
 *  menus and dialogs. None of these roles is on anything persistent. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The four canvas corners as a perspective-crop quad (tl, tr, br, bl). */
const fullCanvasQuad = (w: number, h: number): CropQuad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

export default function Editor({ initialTheme }: { initialTheme: Theme }) {
  const [tool, setTool] = useState<ToolId>(DEFAULT_TOOL);
  // --- Mobile shell: the Toolbar and panels dock become swipe-in drawers ----
  const mobile = useIsMobile();
  /* A touch device that is not a phone. Mutually exclusive with `mobile` by
     construction — see TABLET_QUERY, which is the exact complement. */
  const tablet = useIsTablet();
  // Publishes --kb-inset / --vv-h for every overlay; see useVisualViewport.
  useVisualViewport();
  /* Latched Shift/Alt/Ctrl reach the canvas's existing modifier tests; see
     lib/modifiers. Installed always, and inert until a chip is tapped — the
     chips themselves are mobile-only, but a latch left armed while the window
     is resized to a desktop shell should still behave. */
  useEffect(() => installModifierInjection(), []);
  // Keeps the browser's own pinch/pull-to-refresh off the editor's gestures.
  useGestureGuard();
  const [mobileDrawer, setMobileDrawer] = useState<MobileDrawer>(null);
  /* How tall the panels sheet stands. "half" on open: peek is a glance and
     full is the old drawer, so the middle is the one that shows a panel and
     the picture it describes at the same time. */
  const [sheetDetent, setSheetDetent] = useState<Detent>("half");
  /* Pan/zoom as a mode rather than a tool: the one-finger drag pans while this
     is on, and the selected tool is left exactly as it was. */
  const [panMode, setPanMode] = useState(false);
  // Mirror the mobile state onto <html> so the global mobile CSS (keyed off
  // data-mobile / data-drawer, since module classes are hashed) can drive the
  // layout from one source of truth.
  useEffect(() => {
    const el = document.documentElement;
    if (mobile) el.dataset.mobile = "true";
    else delete el.dataset.mobile;
    return () => {
      delete el.dataset.mobile;
    };
  }, [mobile]);
  /* The tablet shell, and the touch flag that both shells share. Written the
     same way and for the same reason: hashed module classes cannot be reached
     from globals.scss, so the root attribute is the one source of truth. The
     inline script in layout.tsx sets all three before the first paint; these
     effects keep them right when the window is resized or a device changes
     mode mid-session. */
  useEffect(() => {
    const el = document.documentElement;
    if (tablet) el.dataset.tablet = "true";
    else delete el.dataset.tablet;
    return () => {
      delete el.dataset.tablet;
    };
  }, [tablet]);
  const touch = useMediaQuery(TOUCH_QUERY);
  useEffect(() => {
    const el = document.documentElement;
    if (touch) el.dataset.touch = "true";
    else delete el.dataset.touch;
    return () => {
      delete el.dataset.touch;
    };
  }, [touch]);
  /* Both touch shells use `data-drawer`, and they use it for different things:
     the phone opens either drawer, the tablet only ever opens "panels" (its
     rail is persistent, which is the difference between the two tiers). */
  const drawerShell = mobile || tablet;
  useEffect(() => {
    const el = document.documentElement;
    if (drawerShell && mobileDrawer) el.dataset.drawer = mobileDrawer;
    else delete el.dataset.drawer;
    /* The panels sheet's height. Written on the root next to `data-drawer`, so
       the CSS that sizes the sheet needs no class name and no prop drilling. */
    if (mobile && mobileDrawer === "panels") el.dataset.sheet = sheetDetent;
    else delete el.dataset.sheet;
  }, [drawerShell, mobile, mobileDrawer, sheetDetent]);
  // An open drawer absorbs the back gesture rather than letting it leave.
  useEffect(() => {
    if (!mobileDrawer) return;
    return registerDismissible(() => setMobileDrawer(null));
  }, [mobileDrawer]);
  // Leaving the touch shells (resize up to a desktop) closes any open drawer.
  useEffect(() => {
    if (!drawerShell) setMobileDrawer(null);
  }, [drawerShell]);
  const toggleMobileDrawer = (d: "tools" | "panels") =>
    setMobileDrawer((cur) => (cur === d ? null : d));

  /**
   * The touch ✓/✕ pair, aimed at whatever is actually live.
   *
   * It works by synthesising the key the desktop uses, so that every existing
   * handler stays as it is — and for a pen path, a crop and a transform those
   * handlers are on `window`, so dispatching there reaches them.
   *
   * A TEXT session is not like that: its handlers live on the `contentEditable`
   * itself and call `stopPropagation`, so a key dispatched at `window` never
   * arrives. The pair was inert for text — visible, tappable, and doing
   * nothing, which is worse than absent. Its contract differs too: plain Enter
   * inserts a newline there, and committing is Ctrl+Enter.
   *
   * So: aim at the editable when there is one, and speak its language.
   */
  const finishTouchSession = (kind: "commit" | "cancel") => {
    const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
    const target: EventTarget = editable ?? window;
    /* `code` as well as `key`, as a real key press has both. The crop tool's
       Escape tests `e.code`, so ✕ sent `key` alone and never reset a crop. */
    const init: KeyboardEventInit =
      kind === "cancel"
        ? { key: "Escape", code: "Escape" }
        : editable
          ? { key: "Enter", code: "Enter", ctrlKey: true }
          : { key: "Enter", code: "Enter" };
    target.dispatchEvent(
      new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }),
    );
  };
  /* While a pointer is down on the canvas, mark it on <html> so the edge strips
     stand aside (globals.scss). An attribute rather than React state on
     purpose: this fires at the start of every stroke, and re-rendering the
     editor to move an invisible 20px strip would be paid for in paint latency.
     Mobile only — the strips do not exist anywhere else. */
  useEffect(() => {
    if (!mobile) return;
    const root = document.documentElement;
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-tour="canvas"]'))
        root.dataset.toolgrab = "true";
    };
    const release = () => delete root.dataset.toolgrab;
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      delete root.dataset.toolgrab;
    };
  }, [mobile]);

  // Edge-swipe: open a drawer by dragging inward from a screen edge. A SECONDARY
  // way in — the MobileBar's buttons are the one that always works, since these
  // strips sit where the system back gesture lives. See globals.scss.
  const edgeSwipe = useRef<{ x: number; side: "left" | "right"; done: boolean } | null>(null);
  const scrimSwipe = useRef<number | null>(null);
  const SWIPE = 36; // px of travel before a swipe commits
  const onEdgeDown = (e: React.PointerEvent, side: "left" | "right") => {
    e.currentTarget.setPointerCapture(e.pointerId);
    edgeSwipe.current = { x: e.clientX, side, done: false };
  };
  const onEdgeMove = (e: React.PointerEvent) => {
    const s = edgeSwipe.current;
    if (!s || s.done) return;
    const dx = e.clientX - s.x;
    if (s.side === "left" && dx > SWIPE) {
      s.done = true;
      setMobileDrawer("tools");
    } else if (s.side === "right" && dx < -SWIPE) {
      s.done = true;
      setMobileDrawer("panels");
    }
  };
  // Swiping the scrim back toward the drawer's own edge dismisses it.
  const onScrimMove = (e: React.PointerEvent) => {
    if (scrimSwipe.current == null) return;
    const dx = e.clientX - scrimSwipe.current;
    if ((mobileDrawer === "tools" && dx < -SWIPE) || (mobileDrawer === "panels" && dx > SWIPE)) {
      scrimSwipe.current = null;
      setMobileDrawer(null);
    }
  };
  const [zoom, setZoom] = useState(67);
  /* The options bar's state and the two colours live in stores (TODO 1.5,
     app/state): the components that show them subscribe there, and Editor
     reads what it acts on. The setters are the stores' own, shaped like
     useState's. */
  const [stores] = useState(createEditorStores);
  const { colors: colorStore, tools: toolStore } = stores;
  // The open documents (TODO 1.5, app/state/documents.ts): read here under the
  // names they had as state, set through the store's setters.
  const docStore = stores.documents;
  /* Which dialogs are open (TODO 1.5, app/state/dialogs.ts) — under the names
     they had as state, with setters shaped like the ones they replace. */
  const dialogStore = stores.dialogs;
  const {
    trim: trimOpen,
    patternFill,
    recents: recentsOpen,
    saveAs: saveAsOpen,
    rename: renameOpen,
    moreSpace: moreSpaceOpen,
    exportLut: lutExportOpen,
    exportTiff: tiffExportOpen,
    exportPdf: pdfExportOpen,
    mergeHdr: hdrMergeOpen,
    batch: batchOpen,
    hdrTone: hdrToneOpen,
    exportHdr: hdrExportOpen,
    workspaces: workspacesOpen,
    shortcuts: shortcutsOpen,
    about: aboutOpen,
    newGuide: newGuideOpen,
    print: printOpen,
    colorManagement: colorDialogOpen,
    newDoc: newDocOpen,
    prefs: prefsOpen,
    prefsTab,
    help: helpOpen,
    size: sizeDialogOpen,
    sizeMode: sizeDialogMode,
    channel: channelDialog,
    selectModify,
    blurFxOpen,
    blurFx,
    blurPreview,
    compareComposite,
    pasteSrc,
    exportComposite,
    importItems,
    refine: refineOpen,
    fillEdit,
    toneEdit,
    toneHist,
    tonePick,
    extraEdit,
    layerStyleTarget,
    filterTarget,
    restoreSnap,
    liquify,
    warping,
    rawAsk,
  } = useStore(dialogStore, (d) => d);
  const setTrimOpen = dialogStore.setter("trim");
  const setPatternFill = dialogStore.setter("patternFill");
  const setRecentsOpen = dialogStore.setter("recents");
  const setSaveAsOpen = dialogStore.setter("saveAs");
  const setRenameOpen = dialogStore.setter("rename");
  const setMoreSpaceOpen = dialogStore.setter("moreSpace");
  const setLutExportOpen = dialogStore.setter("exportLut");
  const setTiffExportOpen = dialogStore.setter("exportTiff");
  const setPdfExportOpen = dialogStore.setter("exportPdf");
  const setHdrMergeOpen = dialogStore.setter("mergeHdr");
  const setBatchOpen = dialogStore.setter("batch");
  const setHdrToneOpen = dialogStore.setter("hdrTone");
  const setHdrExportOpen = dialogStore.setter("exportHdr");
  const setWorkspacesOpen = dialogStore.setter("workspaces");
  const setShortcutsOpen = dialogStore.setter("shortcuts");
  const setAboutOpen = dialogStore.setter("about");
  const setNewGuideOpen = dialogStore.setter("newGuide");
  const setPrintOpen = dialogStore.setter("print");
  const setColorDialogOpen = dialogStore.setter("colorManagement");
  const setNewDocOpen = dialogStore.setter("newDoc");
  const setPrefsOpen = dialogStore.setter("prefs");
  const setPrefsTab = dialogStore.setter("prefsTab");
  const setHelpOpen = dialogStore.setter("help");
  const setSizeDialogOpen = dialogStore.setter("size");
  const setChannelDialog = dialogStore.setter("channel");
  const setSelectModify = dialogStore.setter("selectModify");
  const setBlurFxOpen = dialogStore.setter("blurFxOpen");
  const setBlurFx = dialogStore.setter("blurFx");
  const setBlurPreview = dialogStore.setter("blurPreview");
  const setCompareComposite = dialogStore.setter("compareComposite");
  const setPasteSrc = dialogStore.setter("pasteSrc");
  const setExportComposite = dialogStore.setter("exportComposite");
  const setImportItems = dialogStore.setter("importItems");
  const setRefineOpen = dialogStore.setter("refine");
  const setFillEdit = dialogStore.setter("fillEdit");
  const setToneEdit = dialogStore.setter("toneEdit");
  const setToneHist = dialogStore.setter("toneHist");
  const setTonePick = dialogStore.setter("tonePick");
  const setExtraEdit = dialogStore.setter("extraEdit");
  const setLayerStyleTarget = dialogStore.setter("layerStyleTarget");
  const setFilterTarget = dialogStore.setter("filterTarget");
  const setRestoreSnap = dialogStore.setter("restoreSnap");
  const setLiquify = dialogStore.setter("liquify");
  const setWarping = dialogStore.setter("warping");
  const setRawAsk = dialogStore.setter("rawAsk");
  const { foreground, background, activeSlot } = useStore(colorStore, (c) => c);
  const setForeground = colorStore.setter("foreground");
  const setBackground = colorStore.setter("background");
  // What Editor itself acts on, each subscribed alone.
  const pen = useStore(toolStore, (t) => t.pen);
  const blur = useStore(toolStore, (t) => t.blur);
  const frameFit = useStore(toolStore, (t) => t.frameFit);
  const textSettings = useStore(toolStore, (t) => t.text);
  const cropSettings = useStore(toolStore, (t) => t.crop);
  const alignToCanvas = useStore(toolStore, (t) => t.alignToCanvas);
  const marqueeShape = useStore(toolStore, (t) => t.marqueeShape);
  const lassoMode = useStore(toolStore, (t) => t.lassoMode);
  const setBrush = toolStore.setter("brush");
  const setEraser = toolStore.setter("eraser");
  const setPencil = toolStore.setter("pencil");
  const setBlur = toolStore.setter("blur");
  const setQuickSelect = toolStore.setter("quickSelect");
  const setSmudge = toolStore.setter("smudge");
  const setMixer = toolStore.setter("mixer");
  const setFrameFit = toolStore.setter("frameFit");
  const setSponge = toolStore.setter("sponge");
  const setHistoryBrush = toolStore.setter("historyBrush");
  const setHeal = toolStore.setter("heal");
  const setRedEye = toolStore.setter("redEye");
  const setClone = toolStore.setter("clone");
  const setDodge = toolStore.setter("dodge");
  const setTextSettings = toolStore.setter("text");
  const setCropSettings = toolStore.setter("crop");
  const setResizeMode = toolStore.setter("resizeMode");
  const setMarqueeShape = toolStore.setter("marqueeShape");
  const setLassoMode = toolStore.setter("lassoMode");
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // Global light is DOCUMENT state, not per-layer: one angle every effect that
  // opts in follows, so turning it anywhere turns it everywhere.
  const [globalLight, setGlobalLightState] = useState<GlobalLight>(DEFAULT_GLOBAL_LIGHT);
  const globalLightRef = useRef(globalLight);
  globalLightRef.current = globalLight;
  /** Restore the document light when a project loads (v20+; older files use the
   *  default, which is what every effect was authored against anyway). */
  const restoreGlobalLight = (raw: unknown) => {
    const l = sanitizeGlobalLight(raw);
    setGlobalLightState(l);
    paintRef.current?.setGlobalLight(l);
  };
  const applyGlobalLight = (l: GlobalLight) => {
    const next = sanitizeGlobalLight(l);
    setGlobalLightState(next);
    paintRef.current?.setGlobalLight(next);
  };
  // The pending crop rectangle (doc coords) while the crop tool is active; null
  // means no crop is in progress. Edited interactively on the canvas overlay and
  // via the options bar; committed with Enter / ✓, dropped with Esc.
  const [cropBox, setCropBox] = useState<Rect | null>(null);
  // Perspective-crop quad (tl, tr, br, bl in doc coords); non-null only while the
  // crop tool's Perspective mode is on. Seeded from the box, then dragged freely.
  const [cropQuad, setCropQuad] = useState<CropQuad | null>(null);
  // Preferences: a store (TODO 1.5, app/state/prefs.ts) the canvas reads too.
  const prefsStore = stores.prefs;
  const prefs = useStore(prefsStore, (p) => p);
  // Preferences section to open on — Settings ▸ Performance / Scratch disks
  // deep-link their tabs; plain Preferences… re-opens wherever you last were.
  const openPrefs = (tab?: PrefsTab) => openPrefsOn(dialogStore, tab);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  // Show a brief in-app notification (replaces blocking window.alert).
  const showToast = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  };
  const dismissToast = () => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  };
  /* Asked wherever a document takes its size from something outside our
     control — a file, a dialog, a saved project. Past the browser's canvas
     limits nothing throws: the document opens with the right name, the right
     tab and no pixels at all, and the console stays empty. Refusing with a
     sentence is the entire difference between "this browser cannot do that"
     and "this app ate my photo".

     Free when the answer is no, which is the case that matters — see
     lib/canvas-ceiling for why that decides the design. */
  const acceptSize = (w: number, h: number, what = "image") => {
    const r = checkSize(Math.round(w), Math.round(h), { what });
    if (!r.ok) showToast(r.message);
    return r.ok;
  };
  const blurFxSessionRef = useRef<string[] | null>(null);
  const blurFxTimerRef = useRef(0);
  const blurFxOpenRef = useRef(false);
  blurFxOpenRef.current = blurFxOpen;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // Load persisted preferences once on the client (localStorage is unavailable on the server).
  useEffect(() => restorePrefs(prefsStore), [prefsStore]);
  const updatePrefs = (patch: Partial<Preferences>) => updatePrefsIn(prefsStore, patch);
  const history = useStore(docStore, (d) => d.history);
  // Any history movement means unsaved work (autosave + status-bar indicator).
  const historyInitRef = useRef(true);
  // Each tab has its own history, so switching tabs hands over a different
  // summary — that is not an edit, and must not read as one.
  const historyDocRef = useRef<string | null>(null);
  useEffect(() => {
    const docId = activeIdRef.current;
    const switched = historyDocRef.current !== docId;
    historyDocRef.current = docId;
    if (historyInitRef.current) {
      historyInitRef.current = false;
      return;
    }
    // Still dirty on a switch: one can land in the same render as an edit (a
    // paste into a new canvas switches and journals back to back), and an
    // extra autosave is cheap where a missed one is not.
    autosaveDirtyRef.current = true;
    if (switched) return;
    /* Deliberately NOT the same as the flag above, twice over. An autosave
       clears that one, and "your snapshot is recoverable" is not the promise
       "your work is saved" — only writing a file clears this. And it asks
       whether the user has actually DONE anything: a freshly opened editor
       already reads "Unsaved changes", because its blank document has never
       been written to a file, and prompting on the way out of an untouched app
       would be nagging about nothing. Index 0 is the synthetic origin row.
       Only ever SET here: undoing this tab back to its start says nothing about
       the edits sitting in another tab. */
    if (history.index > 0) unsavedRef.current = true;
    setSaveState((s) => (s.label === "Unsaved changes" ? s : { label: "Unsaved changes", ok: false }));
  }, [history]);
  /* Renaming used to live only on the document tab. The phone reclaims that
     strip when there is a single document, so it needs a second door — and a
     desktop keyboard user never had one at all. */
  /* The install prompt is CAUGHT in the pre-paint script in layout.tsx, not
     here: `beforeinstallprompt` fires before this component has mounted and it
     never replays, so an effect that listens for it directly misses it every
     time — measured, five cold loads out of five, on a browser that was willing
     to install the app throughout. React's job is only to read what was caught
     and to notice when it changes. */
  const [installReady, setInstallReady] = useState(false);
  useEffect(() => {
    const read = () => setInstallReady(!!window[INSTALL_SLOT]);
    read();
    window.addEventListener(INSTALL_EVENT, read);
    return () => window.removeEventListener(INSTALL_EVENT, read);
  }, []);
  /* An allocation that came back dead. There is nothing to recover to — the
     buffer is transparent black and will stay that way — so the only thing that
     matters is that the user is told what happened, because the alternative is
     a photograph that silently turns blank and an app that looks like it
     destroyed their work. Said once: fifty dead buffers are one event. */
  useEffect(() => {
    setCanvasFailureHandler(({ w, h }) => {
      if (process.env.NODE_ENV !== "production") {
        /* Counted, not just shown. The toast is a single slot — reporting five
           times over-writes the same string — so the message on screen cannot
           tell "said once" from "said five times". The count can. */
        const dbg = window as unknown as { __gqCanvasFailures?: number };
        dbg.__gqCanvasFailures = (dbg.__gqCanvasFailures ?? 0) + 1;
      }
      showToast(
        `Your device ran out of memory for an image this size (${w.toLocaleString()} × ` +
          `${h.toLocaleString()}). What is on screen may be incomplete — save a copy, then ` +
          `close other tabs or documents and try again.`,
      );
    });
    return () => setCanvasFailureHandler(null);
  }, []);

  /* Dev-only handle, in the same family as `__gqFits` and `__gqPerf`. The rail
     needs to see what was probed and what that probe cost — specifically that
     `provenArea` is still 0 after boot, which is how "the boot probe allocated
     nothing large" is asserted rather than assumed. */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      __gqCeiling?: () => ReturnType<typeof sharedCeiling>;
      __gqCheckSize?: (a: number, b: number) => ReturnType<typeof checkSize>;
    };
    w.__gqCeiling = () => sharedCeiling();
    w.__gqCheckSize = (a: number, b: number) => checkSize(a, b);
    return () => {
      delete w.__gqCeiling;
      delete w.__gqCheckSize;
    };
  }, []);

  /* Spent either way: the spec allows one `prompt()` per event, whether the
     user accepts or dismisses. Clearing the slot is what keeps the button from
     coming back as a no-op. */
  const runInstall = useCallback(() => {
    const e = window[INSTALL_SLOT];
    if (!e) return;
    window[INSTALL_SLOT] = null;
    setInstallReady(false);
    void e.prompt();
  }, []);
  // The View menu's toggles and the Window menu's panels: a store (TODO 1.5,
  // app/state/view.ts) the canvas, the options bar and the dock read too. The
  // guides themselves are per-document (see Doc).
  const viewStore = stores.view;
  const {
    rulers: showRulers,
    grid: showGrid,
    snap,
    docgrid: showDocGrid,
    guides: showGuides,
    lockguides: lockGuides,
    smartguides: smartGuides,
    panels,
  } = useStore(viewStore, (v) => v);
  const viewApiRef = useRef<ViewApi | null>(null);
  // Before/after compare: the split divider position (null = off) and its axis.
  // Holding \ to peek lives in CanvasArea — it needs no editor state.
  const [compareSplit, setCompareSplit] = useState<number | null>(null);
  const [compareAxis, setCompareAxis] = useState<CompareAxis>("vertical");
  const [colorSpace, setColorSpaceState] = useState<WorkingSpace>("srgb");
  // Read when a project is written, which happens from callbacks that must not
  // capture a stale space (the same reason globalLight has one).
  const colorSpaceRef = useRef(colorSpace);
  colorSpaceRef.current = colorSpace;
  // Soft proofing (view-only): Ctrl+Alt+Y simulate, Ctrl+Alt+Shift+Y gamut warn.
  const [proofColors, setProofColors] = useState(false);
  const [gamutWarn, setGamutWarn] = useState(false);
  // Dev Perf HUD overlay (View ▸ Performance HUD / window.__gqPerf).
  const [perfHud, setPerfHud] = useState(false);
  // Measure/ruler line (doc space) — a session line shown while the tool is active.
  const [measure, setMeasure] = useState<MeasureLine | null>(null);
  // Straighten angle to seat when the crop tool next mounts (the crop-enter effect
  // otherwise zeroes straighten); consumed once, so a plain Crop still starts at 0.
  const pendingStraightenRef = useRef<number | null>(null);
  // "Straighten" feeds the measured tilt into the Crop tool's straighten angle
  // (rotate the image so the measured line becomes level), then activates Crop.
  const straightenFromMeasure = () => {
    if (!measure) return;
    const dev = measureInfo(measure).straighten; // deviation from the nearest axis
    pendingStraightenRef.current = Math.max(-45, Math.min(45, -dev));
    setTool("crop");
  };
  const [proofTarget, setProofTargetState] = useState<ProofTarget>("srgb");
  const [adjust, setAdjust] = useState<Adjustments>(DEFAULT_ADJUST);
  const [adjustFilter, setAdjustFilter] = useState("Original");
  const marqueeShapeRef = useRef(marqueeShape);
  marqueeShapeRef.current = marqueeShape;
  const lassoModeRef = useRef(lassoMode);
  lassoModeRef.current = lassoMode;

  // Restore every options-bar setting from the last session (client-only, so the
  // server-rendered defaults don't mismatch), then persist them on any change.
  useEffect(() => {
    const stop = persistToolOptions(colorStore, toolStore, saveToolPrefs);
    restoreToolOptions(colorStore, toolStore, loadToolPrefs());
    return stop;
  }, [colorStore, toolStore]);
  const setPendingPaste = docStore.setter("pendingPaste");
  const pendingLoads = useStore(docStore, (d) => d.pendingLoads);
  const setPendingLoads = docStore.setter("pendingLoads");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Internal clipboard fallback (used if the OS clipboard write/read fails).
  const clipboardRef = useRef<HTMLCanvasElement | null>(null);

  // Imperative handle into the paint engine (set by CanvasArea).
  const paintRef = useRef<EngineHandle | null>(null);

  // Cursor-position channel: updated imperatively by CanvasArea and consumed only
  // by the StatusBar, so pointer moves don't re-render the whole editor tree.
  type CursorPt = { x: number; y: number } | null;
  const cursorSubsRef = useRef(new Set<(p: CursorPt) => void>());
  const emitCursor = useCallback((p: CursorPt) => {
    cursorSubsRef.current.forEach((fn) => fn(p));
  }, []);
  const subscribeCursor = useCallback((fn: (p: CursorPt) => void) => {
    cursorSubsRef.current.add(fn);
    return () => {
      cursorSubsRef.current.delete(fn);
    };
  }, []);
  // The same arrangement for the live gesture readout (marquee size, move
  // offset): imperative, so a drag updates one panel rather than the tree.
  const gestureSubsRef = useRef(new Set<(m: GestureReadout) => void>());
  const emitGesture = useCallback((m: GestureReadout) => {
    gestureSubsRef.current.forEach((fn) => fn(m));
  }, []);
  const subscribeGesture = useCallback((fn: (m: GestureReadout) => void) => {
    gestureSubsRef.current.add(fn);
    return () => {
      gestureSubsRef.current.delete(fn);
    };
  }, []);
  // Latest colours, reachable from the one-time keydown listener.
  const fgRef = useRef(foreground);
  const bgRef = useRef(background);
  fgRef.current = foreground;
  bgRef.current = background;
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;
  // The colour tools actually paint with = the active swatch.
  const paintColor = activeSlot === "primary" ? foreground : background;
  const historyRef = useRef(history);
  historyRef.current = history;

  // Open documents. Starts with a single, unnamed canvas.
  const docs = useStore(docStore, (d) => d.docs);
  const setDocs = docStore.setter("docs");
  const activeId = useStore(docStore, (d) => d.activeId);
  const setActiveIdState = docStore.setter("activeId");
  /* EVERY tab switch goes through here. Work still open in the tab being left
     — a text edit typed into it — is committed into THAT tab first; the commit
     targets whichever document is active, so after the switch it would be too
     late (it used to be dropped). The engine's own sessions, a floating paste
     included, are finished when it swaps documents (setDocument). */
  const setActiveId = (id: string) => {
    if (id !== activeIdRef.current) {
      flushToolSelectionRef.current(); // a selection gesture belongs to the tab it was made in
      paintRef.current?.commitPendingEdits();
    }
    setActiveIdState(id);
  };
  const seqRef = useRef(1);
  const layerSeqRef = useRef(0);

  const active = docs.find((d) => d.id === activeId) ?? docs[0];

  // The active layer when it's a pixel layer (adjustments target a single leaf).
  const activeLeafNode = active.activeLayerId ? findNode(active.layers, active.activeLayerId) : null;
  const activeLeafId = activeLeafNode && activeLeafNode.type === "layer" ? active.activeLayerId : null;

  // Latest active-doc bits reachable from the one-time keydown listener.
  const activeIdRef = useRef(activeId);
  const selRef = useRef(active.selection);
  /** Set in the keydown CAPTURE phase: did this Escape find an overlay open? */
  const escapeForOverlayRef = useRef(false);
  const activeLayerRef = useRef(active.activeLayerId);
  const activeDocRef = useRef(active);
  const toolRef = useRef(tool);
  const cropBoxRef = useRef(cropBox);
  const cropQuadRef = useRef(cropQuad);
  const cropSettingsRef = useRef(cropSettings);
  const blurRef = useRef(blur);
  const textSettingsRef = useRef(textSettings);
  const docsRef = useRef(docs);
  const pendingLoadsRef = useRef(pendingLoads);
  activeIdRef.current = activeId;
  docsRef.current = docs;
  pendingLoadsRef.current = pendingLoads;
  selRef.current = active.selection;
  activeLayerRef.current = active.activeLayerId;
  activeDocRef.current = active;
  toolRef.current = tool;
  cropBoxRef.current = cropBox;
  cropQuadRef.current = cropQuad;
  cropSettingsRef.current = cropSettings;
  blurRef.current = blur;
  textSettingsRef.current = textSettings;

  // Where the last in-app copy came from, so an in-app paste can drop in place.
  const copyOriginRef = useRef({ x: 0, y: 0 });
  const copyDocIdRef = useRef<string | null>(null);

  const setActiveSize = (s: CanvasSize) => {
    const d = activeDocRef.current;
    if (!acceptSize(s.width, s.height, "canvas")) return;
    if (s.anchor !== undefined && (s.width !== d.width || s.height !== d.height)) {
      // Reframe with the chosen anchor BEFORE patching dims (the reactive
      // setDoc then no-ops) — this is what makes the anchor grid take effect.
      const col = s.anchor % 3;
      const row = Math.floor(s.anchor / 3);
      const dx = col === 0 ? 0 : col === 1 ? Math.round((s.width - d.width) / 2) : s.width - d.width;
      const dy = row === 0 ? 0 : row === 1 ? Math.round((s.height - d.height) / 2) : s.height - d.height;
      paintRef.current?.resizeCanvasAnchored(s.width, s.height, dx, dy, collectLeafIds(d.layers));
    }
    setDocs((ds) =>
      ds.map((doc) => (doc.id === activeId ? { ...doc, width: s.width, height: s.height } : doc)),
    );
  };

  const openSizeDialog = (mode: "canvas" | "image") => openSize(dialogStore, mode);

  // Image resize (resample): scale every layer, then adopt the new dimensions.
  // resizeImage runs first so the follow-up size change is a no-op for the engine.
  const applyImageSize = (s: CanvasSize) => {
    const d = activeDocRef.current;
    if (!acceptSize(s.width, s.height, "image")) return;
    paintRef.current?.resizeImage(s.width, s.height, collectLeafIds(d.layers), true);
    setDocs((ds) =>
      ds.map((x) =>
        x.id === activeIdRef.current
          ? { ...x, width: s.width, height: s.height, selection: [], selectionAngle: 0, selectionPivot: null }
          : x,
      ),
    );
  };

  // ---- Crop tool ----------------------------------------------------------
  // Reset the pending crop box to the whole document (also the initial box when
  // the crop tool is first selected). Straighten is left at 0.
  const resetCropBox = useCallback(() => {
    const d = activeDocRef.current;
    setCropBox({ x: 0, y: 0, w: d.width, h: d.height });
    setCropSettings((s) => ({ ...s, straighten: 0 }));
    if (cropSettingsRef.current.perspective) setCropQuad(fullCanvasQuad(d.width, d.height));
  }, [setCropSettings]);

  // ---- Snapshots (TODO §10) -----------------------------------------------
  // The engine pins the PIXELS (+ masks + doc size); the layer TREE that went
  // with them is React state, so it is kept here, keyed by snapshot id. A
  // restore therefore puts back both halves — and is journalled as one step.
  const snapTreesRef = useRef(new Map<string, { layers: LayerNode[]; w: number; h: number }>());

  const takeSnapshot = useCallback(() => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !d.layers.length) return;
    const label = `Snapshot ${snapTreesRef.current.size + 1}`;
    const id = eng.createSnapshot(label, collectLeafIds(d.layers));
    snapTreesRef.current.set(id, { layers: d.layers, w: d.width, h: d.height });
  }, []);

  const removeSnapshot = useCallback((id: string) => {
    paintRef.current?.deleteSnapshot(id);
    snapTreesRef.current.delete(id);
  }, []);

  // Restore a snapshot: swap in its pixels + tree + size as ONE undoable step
  // (the pre-restore state is captured as a throwaway snapshot so undo is exact).
  const restoreSnapshotNow = useCallback((id: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const target = snapTreesRef.current.get(id);
    if (!eng || !target) return;
    const docId = activeIdRef.current;
    const beforeTree = d.layers;
    const beforeW = d.width;
    const beforeH = d.height;
    const beforeSnap = eng.cropSnapshot(collectLeafIds(beforeTree));
    const setState = (layers: LayerNode[], w: number, h: number) =>
      setDocs((ds) =>
        ds.map((x) =>
          x.id === docId
            ? { ...x, layers, width: w, height: h, selection: [], selectionAngle: 0, selectionPivot: null }
            : x,
        ),
      );
    const redo = () => {
      if (eng.restoreSnapshot(id)) setState(target.layers, target.w, target.h);
    };
    const undo = () => {
      eng.cropRestore(beforeSnap);
      setState(beforeTree, beforeW, beforeH);
    };
    redo();
    eng.pushStructural("Restore Snapshot", undo, redo);
  }, [setDocs]);

  // Commit the pending crop: snapshot, crop every leaf to the box (rotating by the
  // straighten angle), resize the document, and fold it into one undoable step.
  const applyCropNow = useCallback(() => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    /* No `!d.layers.length` bail-out. A new document starts with NO layers, and
       that guard made Crop ▸ Apply (and Enter, and the phone's ✓) a silent no-op
       on it: a box drawn, Apply pressed, the canvas unchanged and nothing in
       History. Cropping an empty canvas is a canvas resize, and the engine's
       crop handles an empty layer list. */
    if (!eng) return;
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const setDims = (w: number, h: number) =>
      setDocs((ds) =>
        ds.map((x) =>
          x.id === docId
            ? { ...x, width: w, height: h, selection: [], selectionAngle: 0, selectionPivot: null }
            : x,
        ),
      );

    // Perspective crop: resample the picked quad into a rectangle (auto-sized to
    // the quad's average edge lengths), as one undoable step.
    const quad = cropQuadRef.current;
    if (cropSettingsRef.current.perspective && quad) {
      const { w: outW, h: outH } = estimateQuadSize(quad);
      const snap = eng.cropSnapshot(leafIds);
      const redo = () => {
        eng.applyPerspectiveCrop(quad, outW, outH, leafIds);
        setDims(outW, outH);
      };
      const undo = () => {
        eng.cropRestore(snap);
        setDims(snap.w, snap.h);
      };
      redo();
      eng.pushStructural("Perspective Crop", undo, redo);
      setCropBox({ x: 0, y: 0, w: outW, h: outH });
      setCropQuad(fullCanvasQuad(outW, outH));
      return;
    }

    const box = cropBoxRef.current;
    if (!box) return;
    const angle = cropSettingsRef.current.straighten;
    const rect: Rect = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.max(1, Math.round(box.w)),
      h: Math.max(1, Math.round(box.h)),
    };
    // A no-op crop (full canvas, no straighten) isn't worth a history entry.
    if (
      angle === 0 &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.w === d.width &&
      rect.h === d.height
    )
      return;
    // Content-aware only bites when the straighten actually leaves corners empty.
    const fill = !!cropSettingsRef.current.fillGaps && angle !== 0;
    const snap = eng.cropSnapshot(leafIds);
    const redo = () => {
      eng.applyCrop(rect, leafIds, angle, fill);
      setDims(rect.w, rect.h);
    };
    const undo = () => {
      eng.cropRestore(snap);
      setDims(snap.w, snap.h);
    };
    redo();
    eng.pushStructural(fill ? "Crop (content-aware)" : "Crop", undo, redo);
    // Re-seat the crop box to the new, full canvas so the tool stays usable.
    setCropBox({ x: 0, y: 0, w: rect.w, h: rect.h });
    setCropSettings((s) => ({ ...s, straighten: 0 }));
  }, [setCropSettings, setDocs]);

  // Entering the crop tool (or switching documents while in it) seats the box on
  // the whole canvas; leaving the tool drops the pending crop without applying it.
  useEffect(() => {
    if (tool !== "crop") {
      setCropBox(null);
      setCropQuad(null);
      return;
    }
    const d = activeDocRef.current;
    setCropBox({ x: 0, y: 0, w: d.width, h: d.height });
    // Seat a straighten angle handed over by the Measure tool's Straighten button,
    // else start level. Consumed once so a normal crop entry stays at 0.
    const seed = pendingStraightenRef.current ?? 0;
    pendingStraightenRef.current = null;
    setCropSettings((s) => ({ ...s, straighten: seed }));
    setCropQuad(
      cropSettingsRef.current.perspective ? fullCanvasQuad(d.width, d.height) : null,
    );
  }, [tool, activeId, setCropSettings]);
  // Toggling Perspective while in the crop tool seeds the quad from the current
  // box (or the full canvas), and leaving the mode drops it.
  useEffect(() => {
    if (tool !== "crop") return;
    if (!cropSettings.perspective) {
      setCropQuad(null);
      return;
    }
    const b = cropBoxRef.current ?? { x: 0, y: 0, w: active.width, h: active.height };
    setCropQuad([
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropSettings.perspective]);

  // The most recent non-empty selection, so Reselect can bring it back.
  const lastSelectionRef = useRef<SelState | null>(null);

  /* Selection TOOLS change the selection live — a Quick Selection drag every
     dab, a Magic Wand re-run as its tolerance slider moves — so each change
     cannot be its own history step. The selection from before the gesture is
     held here, and the whole gesture becomes ONE step when it ends: any
     pointerup or keyup (the effect below), a menu selection command, or a tab
     switch. Before this, tool selections were no step at all: Ctrl+Z after
     drawing a marquee undid the previous paint stroke instead, and a click that
     deselected could not be undone. */
  const pendingToolSelRef = useRef<{ docId: string; before: SelState; after: SelState } | null>(null);

  // The selection, its journal and the Select menu (commands/selection.ts).
  const {
    setSelection,
    setSelectionRects,
    setSelectionAngle,
    setSelectionPivot,
    selStateOf,
    setSelState,
    flushToolSelection,
    toolSelectionChange,
    commitSelection,
    growSelection,
    openRefineEdge,
    applyRefineEdge,
    applySelBox,
    modifySelectionOp,
    featherSelection,
    selectAll,
    deselect,
    reselect,
    invertSelection,
    loadMaskAsSelectionOp,
  } = selectionOps({
    documents: docStore,
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    toolRef,
    lastSelectionRef,
    pendingToolSelRef,
    refineOpen,
    setRefineOpen,
    commitFloatIfAny: () => commitFloatIfAny(),
  });
  const flushToolSelectionRef = useRef(flushToolSelection);
  flushToolSelectionRef.current = flushToolSelection;

  // ---- Transform selection by numbers (options-bar X/Y/W/H/Angle) ----
  // Reported from the CURRENT selection so the fields track marquee drags,
  // Modify operations and undo without any separate state to keep in sync.
  const selNumericBox = useMemo(() => {
    const b = boxOf(active.selection);
    if (!b) return null;
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
      angle: Math.round((active.selectionAngle * 180) / Math.PI),
    };
  }, [active.selection, active.selectionAngle]);

  // Image ▸ rotate, flip, Crop and Trim; Free Transform; Content-Aware Fill
  // (commands/image.ts).
  const {
    applyImageTransform,
    cropToSelection,
    trimImage,
    enterTransform,
    contentAwareFillOp,
  } = imageOps({
    documents: docStore,
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    setSelection,
    setResizeMode,
    setTool,
    commitFloatIfAny: () => commitFloatIfAny(),
  });

  // ---- Layer operations (act on the active document) ----
  const patchActiveDoc = (fn: (d: Doc) => Doc) =>
    setDocs((ds) => ds.map((d) => (d.id === activeId ? fn(d) : d)));

  // The structural layer operations, and the undoable change they all go
  // through (commands/layers.ts, TODO 1.10).
  const {
    setDocSel,
    nextLeafId,
    single,
    selNow,
    targetIds,
    commitLayerChange,
    addLayerOp,
    removeSelected,
    duplicateSelected,
    groupSelected,
    ungroupLayerOp,
    mergeSelected,
    mergeVisibleOp,
    stampVisibleOp,
    flattenImage,
  } = layerOps({ active, activeIdRef, documents: docStore, paintRef, layerSeqRef, showToast });

  // ---- Layer masks ---------------------------------------------------------
  // Which surface paint tools target on the active layer (mirrors engine state,
  // for the Layers panel ring + the options-bar indicator).
  const [paintSurface, setPaintSurface] = useState<ActiveSurface>("pixels");
  // Re-sync the displayed surface whenever the active layer (or doc) changes.
  useEffect(() => {
    const id = active.activeLayerId;
    setPaintSurface(id ? (paintRef.current?.getActiveSurface(id) ?? "pixels") : "pixels");
  }, [active.activeLayerId, activeId]);

  // Mask VIEW (Alt-click a mask chip / Channels panel): the canvas shows the
  // mask's grayscale instead of the composite. Session-only, per active doc.
  const [maskViewId, setMaskViewId] = useState<string | null>(null);
  const maskViewIdRef = useRef(maskViewId);
  maskViewIdRef.current = maskViewId;
  const toggleMaskView = (layerId: string) => {
    const next = maskViewIdRef.current === layerId ? null : layerId;
    setMaskViewId(next);
    paintRef.current?.setMaskView(next);
    if (next) {
      // Viewing a mask also targets it for painting (Photoshop behaviour).
      paintRef.current?.setActiveSurface(layerId, "mask");
      setPaintSurface(paintRef.current?.getActiveSurface(layerId) ?? "pixels");
    }
  };
  // The view never survives a doc switch (CanvasArea also resets the engine),
  // and it ends the moment the viewed layer or its mask goes away.
  useEffect(() => {
    setMaskViewId(null);
  }, [activeId]);
  // The measure line is per-document; drop it when switching tabs.
  useEffect(() => {
    setMeasure(null);
  }, [activeId]);
  useEffect(() => {
    if (!maskViewId) return;
    const node = findNode(active.layers, maskViewId);
    if (!node || node.type === "adjustment" || !node.mask) {
      setMaskViewId(null);
      paintRef.current?.setMaskView(null);
    }
  }, [active.layers, maskViewId]);

  // Keep the engine's view of transparency/pixels locks in step with the tree so
  // it can enforce them at the pixel-commit chokepoint (pushEntry).
  useEffect(() => {
    const list: { id: string; transparency: boolean; pixels: boolean }[] = [];
    const walk = (nodes: LayerNode[]) => {
      for (const n of nodes) {
        list.push({ id: n.id, transparency: isTransparencyLocked(n), pixels: isPixelsLocked(n) });
        if (n.type === "group") walk(n.children);
      }
    };
    walk(active.layers);
    paintRef.current?.syncLayerLocks(list);
  }, [active.layers]);

  const chooseSurface = (layerId: string, surface: ActiveSurface) => {
    paintRef.current?.setActiveSurface(layerId, surface);
    setPaintSurface(paintRef.current?.getActiveSurface(layerId) ?? "pixels");
    // Choosing any surface other than the viewed mask exits mask view — same
    // "click a thumbnail to come back" behaviour as Photoshop.
    if (maskViewIdRef.current && (surface !== "mask" || layerId !== maskViewIdRef.current)) {
      setMaskViewId(null);
      paintRef.current?.setMaskView(null);
    }
  };

  // Layer masks, a smart filter's mask and vector masks (commands/masks.ts).
  const {
    addMaskOp,
    removeMaskOp,
    applyMaskOp,
    toggleMaskMeta,
    addFilterMaskOp,
    removeFilterMaskOp,
    setFilterMaskEnabled,
    addVectorMask,
    invertVectorMask,
    deleteVectorMask,
  } = maskOps({ activeDocRef, paintRef, showToast, setPaintSurface, selNow, setDocSel });

  // ---- Quick Mask (TODO §3) ------------------------------------------------
  //
  // Paint a selection instead of dragging one: entering turns the current
  // selection into a grayscale raster, clears the selection so brushes aren't
  // clipped by it, and shades everything unselected in red. Leaving turns the
  // coverage back into a selection.
  //
  // The engine holds ONE live quick mask, but the raster is keyed per document,
  // so tabs keep their own — this list is which documents are currently in the
  // mode, and an effect below points the engine at the right raster.
  const [quickMaskDocs, setQuickMaskDocs] = useState<string[]>([]);
  const quickMask = quickMaskDocs.includes(activeId);
  const quickMaskDocsRef = useRef<string[]>([]);
  quickMaskDocsRef.current = quickMaskDocs;

  // Switching tabs re-points the engine at that document's quick mask (or off).
  useEffect(() => {
    const eng = paintRef.current;
    if (!eng) return;
    eng.setQuickMask(quickMaskDocs.includes(activeId) ? quickMaskKey(activeId) : null);
  }, [activeId, quickMaskDocs]);

  // ---- Adjustment layers (non-destructive) ---------------------------------
  const adjSeqRef = useRef(0);
  // Live param-edit session: one undoable step per drag gesture (debounced).
  const adjEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const adjEditTimer = useRef(0);

  // ---- Fill layers ---------------------------------------------------------
  // The Fill editor closes the moment its layer goes away (delete / undo).
  useEffect(() => {
    if (!fillEdit) return;
    const n = findNode(active.layers, fillEdit.layerId);
    if (!n || n.type !== "layer" || !n.fill) setFillEdit(null);
  }, [active.layers, fillEdit, setFillEdit]);
  /** Active node if it's an adjustment layer (drives the panel's edit mode). */
  const activeAdjustment = activeLeafNode?.type === "adjustment" ? activeLeafNode : null;
  // The slider-bundle spec of the active adjustment (Curves/Levels are edited in
  // their own dialogs, not the slider panel).
  const sliderSpec =
    activeAdjustment && activeAdjustment.adjustment.type === "sliders" ? activeAdjustment.adjustment : null;

  // ---- Curves & Levels (tone) ----------------------------------------------
  const toneEditRef = useRef<ToneEdit | null>(null);
  toneEditRef.current = toneEdit;
  const tonePickRef = useRef<EyedropKind | null>(null);
  tonePickRef.current = tonePick;
  const toneKey = toneEdit ? `${toneEdit.mode}:${toneEdit.tool}:${toneEdit.layerId}` : "";

  // Refresh the histogram backdrop when the editor opens; clear any pick on close.
  useEffect(() => {
    if (toneEdit) setToneHist(paintRef.current?.histogram(activeDocRef.current.layers) ?? null);
    else setTonePick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toneKey]);

  // The spec currently being edited (from the node, or the destructive session).
  const toneSpec: ToneAdjustment | null = (() => {
    if (!toneEdit) return null;
    if (toneEdit.mode === "dest") return toneEdit.spec;
    const n = findNode(active.layers, toneEdit.layerId);
    return n?.type === "adjustment" && (n.adjustment.type === "levels" || n.adjustment.type === "curves")
      ? n.adjustment
      : null;
  })();

  // ---- Extra adjustment layers (Hue/Sat, Selective, Mixer, Gradient Map,
  //      Color Lookup, Invert, Equalize) --------------------------------------
  const extraSpec: ExtraAdjustment | null = (() => {
    if (!extraEdit) return null;
    const n = findNode(active.layers, extraEdit.layerId);
    return n?.type === "adjustment" && isExtraSpec(n.adjustment) ? n.adjustment : null;
  })();
  // Where a picked .cube lands: a new layer, or an existing node's spec.
  const cubeInputRef = useRef<HTMLInputElement>(null);
  const cubeTargetRef = useRef<"new" | string | null>(null);
  // Export the current adjustments AS a .cube LUT (File menu / Adjustments panel).
  // Dock v2 hosts: the left dock column + the floating-panel overlay (panels
  // portal in from RightDock, which owns the whole layout model).
  const [leftHost, setLeftHost] = useState<HTMLDivElement | null>(null);
  const [floatHost, setFloatHost] = useState<HTMLDivElement | null>(null);
  /* Desktop: the status readouts float over the foot of the stage (CanvasArea
     renders the host); the phone and tablet keep the bar. */
  const [statusHost, setStatusHost] = useState<HTMLDivElement | null>(null);
  const dockRef = useRef<DockApi | null>(null);

  const onCubePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    const target = cubeTargetRef.current;
    cubeTargetRef.current = null;
    if (!f || !target) return;
    let text: string;
    try {
      text = await f.text();
    } catch {
      window.alert("Couldn't read the .cube file.");
      return;
    }
    const parsed = parseCubeLUT(text, stripExt(f.name));
    if (!parsed.lut) {
      window.alert(parsed.error ?? "Couldn't parse the .cube file.");
      return;
    }
    const spec: AdjustmentSpec = {
      type: "colorlookup",
      name: parsed.lut.name,
      size: parsed.lut.size,
      table: parsed.lut.table,
    };
    if (target === "new") addAdjustmentOp("", `Color Lookup — ${parsed.lut.name}`, undefined, spec);
    else setToneNodeSpec(target, spec); // replace the LUT on an existing node
  };
  // Adjustment layers, their live edits, clipping, Curves and Levels, and the
  // extra kinds (commands/adjustments.ts).
  const {
    commitAdjustEdit,
    addAdjustmentOp,
    editAdjustmentParams,
    setClippedOp,
    toggleClippingMask,
    setToneNodeSpec,
    addToneAdjustment,
    editToneNode,
    addExtraAdjustment,
    openDestructiveTone,
  } = adjustmentOps({
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    selNow,
    single,
    setDocSel,
    adjSeqRef,
    adjEditRef,
    adjEditTimer,
    cubeInputRef,
    cubeTargetRef,
    setToneEdit,
    setExtraEdit,
    activeLeafId,
  });

  const onToneChange = (spec: ToneAdjustment) => {
    const te = toneEditRef.current;
    if (!te) return;
    if (te.mode === "node") setToneNodeSpec(te.layerId, spec);
    else {
      setToneEdit({ ...te, spec });
      const d = activeDocRef.current;
      paintRef.current?.previewTone(te.layerId, spec, d.selection, d.selectionAngle, d.selectionPivot);
    }
  };
  const onToneDone = () => {
    const te = toneEditRef.current;
    if (te?.mode === "dest") paintRef.current?.endAdjust(); // bake one pixel step
    else commitAdjustEdit();
    setToneEdit(null);
  };
  const onToneCancel = () => {
    const te = toneEditRef.current;
    if (te?.mode === "dest") paintRef.current?.revertAdjust(); // drop the destructive preview
    else commitAdjustEdit(); // node: keep the (undoable) edits — a safe outside-click close
    setToneEdit(null);
  };
  const onToneAuto = () => {
    if (!toneSpec || toneSpec.type !== "levels" || !toneHist) return;
    const a = autoLevels(toneHist, 0.5);
    onToneChange({ type: "levels", channels: { rgb: toneSpec.channels.rgb, r: a.r, g: a.g, b: a.b } });
  };
  // The Levels eyedroppers sample a pixel on the canvas (pick mode), then set the
  // black / white input point per channel, or solve a neutral grey.
  const onTonePicked = (rgb: { r: number; g: number; b: number }) => {
    const kind = tonePickRef.current;
    setTonePick(null);
    if (!kind || !toneSpec || toneSpec.type !== "levels") return;
    const c = toneSpec.channels;
    let channels = c;
    if (kind === "gray") {
      const g = solveGrayPoint(rgb);
      channels = { rgb: c.rgb, r: g.r, g: g.g, b: g.b };
    } else {
      const v: [number, number, number] = [rgb.r, rgb.g, rgb.b];
      const set = (p: ChannelParams, i: number): ChannelParams =>
        kind === "black"
          ? { ...p, inBlack: Math.min(255, Math.max(0, Math.round(v[i]))) }
          : { ...p, inWhite: Math.min(255, Math.max(1, Math.round(v[i]))) };
      channels = { rgb: c.rgb, r: set(c.r, 0), g: set(c.g, 1), b: set(c.b, 2) };
    }
    onToneChange({ type: "levels", channels });
  };

  // ---- Curves targeted adjustment (click-drag the image to move the curve
  //      point at the sampled tone) ------------------------------------------
  const [curveTarget, setCurveTarget] = useState(false);
  const curveChannelRef = useRef<ChannelKey>("rgb"); // dialog's active channel
  const curveDragRef = useRef<{ ch: ChannelKey; x: number; y0: number } | null>(null);

  /** Recover the PRE-curve value: nearest input whose LUT output matches the
   *  sampled (displayed) byte. A nearest-value scan is robust for any curve
   *  shape (rising, falling, plateaus) at 256 steps. */
  const invertLut = (lut: Uint8ClampedArray, v: number): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < 256; i++) {
      const d = Math.abs(lut[i] - v);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const onCurveTargetStart = (rgb: { r: number; g: number; b: number }) => {
    if (!toneSpec || toneSpec.type !== "curves") return;
    const ch = curveChannelRef.current;
    // The view shows channel(master(raw)) — invert the effective LUTs to get
    // the raw tone, then map to the domain the edited curve actually sees:
    // raw for the master, master(raw) for a colour channel.
    const eff = buildCurvesLUTs(toneSpec);
    const raw = {
      r: invertLut(eff.r, Math.round(rgb.r)),
      g: invertLut(eff.g, Math.round(rgb.g)),
      b: invertLut(eff.b, Math.round(rgb.b)),
    };
    const x =
      ch === "rgb"
        ? Math.round(0.299 * raw.r + 0.587 * raw.g + 0.114 * raw.b)
        : curveLUT(toneSpec.channels.rgb)[ch === "r" ? raw.r : ch === "g" ? raw.g : raw.b];
    const pts = toneSpec.channels[ch];
    const near = pts.find((p) => Math.abs(p.x - x) <= 6);
    if (near) {
      curveDragRef.current = { ch, x: near.x, y0: near.y };
      return;
    }
    // New point ON the current curve, so nothing jumps until the drag moves.
    const y = Math.max(0, Math.min(255, Math.round(curveSampler(pts)(x))));
    const next: CurvePoint[] = [...pts.map((p) => ({ ...p })), { x, y }].sort((a, b) => a.x - b.x);
    curveDragRef.current = { ch, x, y0: y };
    onToneChange({ ...toneSpec, channels: { ...toneSpec.channels, [ch]: next } });
  };

  const onCurveTargetDrag = (dy: number) => {
    const s = curveDragRef.current;
    if (!s || !toneSpec || toneSpec.type !== "curves") return;
    const y = Math.max(0, Math.min(255, Math.round(s.y0 - dy))); // up = brighter
    const pts = toneSpec.channels[s.ch].map((p) => (p.x === s.x ? { ...p, y } : p));
    onToneChange({ ...toneSpec, channels: { ...toneSpec.channels, [s.ch]: pts } });
  };

  const onCurveTargetEnd = () => {
    curveDragRef.current = null;
  };

  // Leaving the tone editor (or switching its target) disarms the mode.
  useEffect(() => {
    setCurveTarget(false);
    curveDragRef.current = null;
    curveChannelRef.current = "rgb";
  }, [toneKey]);

  // ---- Layer effects (styles) ----------------------------------------------
  const [fxClipboard, setFxClipboard] = useState<LayerEffects | null>(null);
  // Live FX-edit session: one undoable step per drag gesture (debounced).
  const fxEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const fxEditTimer = useRef(0);

  // Layer styles (commands/effects.ts).
  const {
    commitFxEdit,
    setLayerEffectsOp,
    stylePatchStructural,
    applyStylePresetOp,
    toggleEffectOp,
    copyLayerStyleOp,
    pasteLayerStyleOp,
    clearLayerStyleOp,
    openLayerStyleOp,
    addEffectOp,
  } = effectOps({
    activeIdRef,
    activeDocRef,
    paintRef,
    selNow,
    setDocSel,
    fxEditRef,
    fxEditTimer,
    fxClipboard,
    setFxClipboard,
    setLayerStyleTarget,
    selectLayer: (id, mode) => selectLayer(id, mode),
  });

  // Fill layers and frames (commands/fills.ts).
  const {
    addFrameLayer,
    frameFromLayerOp,
    addFillOp,
  } = fillOps({
    activeDocRef,
    paintRef,
    showToast,
    foreground,
    background,
    selNow,
    single,
    setDocSel,
    nextLeafId,
    commitAdjustEdit,
    stylePatchStructural,
    setFillEdit,
  });


  // ---- Shortcut registry (single source of truth + user remaps) -------------
  const [shortcutOverrides, setShortcutOverrides] = useState<ShortcutOverrides>({});
  useEffect(() => setShortcutOverrides(loadShortcutOverrides()), []); // client store
  const shortcutOverridesRef = useRef<ShortcutOverrides>({});
  shortcutOverridesRef.current = shortcutOverrides;
  const shortcutDefs = useMemo(() => buildShortcutDefs(), []);
  // canonical binding → defs, consulted by the one-time keydown listener.
  const shortcutIndexRef = useRef(new Map<string, ReturnType<typeof buildShortcutDefs>>());
  shortcutIndexRef.current = useMemo(
    () => buildDispatchIndex(shortcutDefs, shortcutOverrides),
    [shortcutDefs, shortcutOverrides],
  );
  // Effective display labels for menus / palette / shortcuts window.
  const shortcutLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const d of shortcutDefs) out[d.id] = effectiveLabel(d, shortcutOverrides);
    return out;
  }, [shortcutDefs, shortcutOverrides]);

  /** Remap one shortcut. `undefined` restores the default, `null` unbinds, a
   *  string binds it (stealing the key from a remappable current owner). */
  const rebindShortcut = (id: string, value: string | null | undefined) => {
    const prev = shortcutOverridesRef.current;
    const next: ShortcutOverrides = { ...prev };
    if (value === undefined) {
      delete next[id];
    } else if (value === null) {
      next[id] = null;
    } else {
      const b = parseShortcut(value);
      if (!b) return;
      const other = conflictOf(shortcutDefs, prev, id, b);
      if (other) {
        if (!other.remappable) {
          showToast(`${formatBinding(b)} is reserved for “${other.label}”.`);
          return;
        }
        next[other.id] = null; // steal — one binding, one command
        showToast(`${formatBinding(b)} moved here from “${other.label}”.`);
      }
      next[id] = value;
    }
    saveShortcutOverrides(next);
    setShortcutOverrides(next);
  };
  const resetAllShortcuts = () => {
    saveShortcutOverrides({});
    setShortcutOverrides({});
  };

  // ---- Smart filters (Spec 07) ---------------------------------------------
  // Live filter-edit session: one undoable step per drag gesture (debounced).
  const filterEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const filterEditTimer = useRef(0);

  // Smart filters (commands/filters.ts).
  const {
    commitFilterEdit,
    setFiltersLive,
    setFiltersOp,
    openFiltersOp,
    addFilterOp,
    applyFiltersOp,
  } = filterOps({
    activeIdRef,
    activeDocRef,
    paintRef,
    selNow,
    setDocSel,
    filterEditRef,
    filterEditTimer,
    setFilterTarget,
    selectLayer: (id, mode) => selectLayer(id, mode),
  });

  // ---- Smart-blur anchor targeting (drag the canvas to place the zoom/spin
  //      centre or tilt-shift focus band, instead of the X/Y sliders) ---------
  const [filterAnchorId, setFilterAnchorId] = useState<string | null>(null);
  // The armed filter's guide, re-derived every render so slider edits, undo and
  // structural changes keep the on-canvas reticle honest; null = mode off.
  const filterAnchorGuide = useMemo(() => {
    if (!filterTarget || !filterAnchorId) return null;
    const node = findNode(active.layers, filterTarget);
    if (!node || node.type === "adjustment") return null;
    const f = (node.filters ?? []).find((x) => x.id === filterAnchorId);
    if (!f || f.type !== "blur") return null;
    const p = f.params;
    if (p.kind !== "zoom" && p.kind !== "spin" && p.kind !== "tiltshift") return null;
    return { kind: p.kind, anchor: p.anchor, angle: p.angle, band: p.band, feather: p.feather };
  }, [filterTarget, filterAnchorId, active.layers]);
  // Disarm whenever the armed filter stops resolving (dialog closed, filter
  // removed / kind changed / undone, doc switched).
  useEffect(() => {
    if (filterAnchorId && !filterAnchorGuide) setFilterAnchorId(null);
  }, [filterAnchorId, filterAnchorGuide]);
  // Canvas drags patch the armed filter's anchor through the same debounced
  // live path as the dialog's sliders (one history step per gesture).
  const onFilterAnchorDrag = (nx: number, ny: number) => {
    const id = filterTarget;
    if (!id || !filterAnchorId) return;
    const node = findNode(activeDocRef.current.layers, id);
    if (!node || node.type === "adjustment" || !node.filters) return;
    setFiltersLive(
      id,
      node.filters.map((f) =>
        f.id === filterAnchorId && f.type === "blur"
          ? { ...f, params: { ...f.params, anchor: { x: nx, y: ny } } }
          : f,
      ),
    );
  };

  type TextGeom = { x: number; y: number; boxW: number | null; value: string; runs?: TextRun[] };
  const textLayerName = (value: string) => value.trim().split("\n")[0].slice(0, 24) || "Text";
  // Build a render spec from the current text settings + a geometry/value.
  const buildTextSpec = (p: TextGeom): TextRenderSpec => {
    const t = textSettingsRef.current;
    return {
      text: p.value,
      x: p.x,
      y: p.y,
      boxW: p.boxW,
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      bold: t.bold,
      italic: t.italic,
      underline: t.underline,
      strike: t.strike,
      align: t.align,
      lineHeight: t.lineHeight,
      tracking: t.tracking,
      baseline: t.baseline,
      caps: t.caps,
      color: t.color,
      antialias: t.antialias,
      runs: p.runs,
      features: t.features,
      axes: t.axes,
      warp: t.warp,
      fill: t.fill,
    };
  };
  const textVectorOf = (spec: TextRenderSpec): VectorText => {
    const flat = paintRef.current?.textBounds(spec) ?? { x: spec.x, y: spec.y, w: 0, h: 0 };
    return {
      type: "text",
      ...spec,
      bbox: warpActive(spec.warp) ? warpedBounds(flat, spec.warp) : flat,
    };
  };
  const specFromTextVector = (v: VectorText): TextRenderSpec => ({
    text: v.text,
    x: v.x,
    y: v.y,
    boxW: v.boxW,
    fontFamily: v.fontFamily,
    fontSize: v.fontSize,
    bold: v.bold,
    italic: v.italic,
    underline: v.underline,
    strike: v.strike,
    align: v.align,
    lineHeight: v.lineHeight,
    tracking: v.tracking,
    color: v.color,
    antialias: v.antialias,
    runs: v.runs,
    features: v.features,
    axes: v.axes,
    warp: v.warp,
    fill: v.fill,
    onPath: v.onPath,
    /* `baseline` and `caps` were absent from this list. `textVectorOf` spreads
       the whole spec, so they are stored; only the way BACK dropped them, which
       is the direction undo re-renders in. Added while adding `onPath` rather
       than left as a difference between what is saved and what is restored. */
    baseline: v.baseline,
    caps: v.caps,
  });

  // Commit a NEW text block: add a layer named after the text, rasterize it, and
  // keep its vector source on the layer (so it stays re-editable) — one "Type" step.
  const placeText = (p: TextGeom) => {
    if (!p.value.trim()) return;
    const before = active.layers;
    const id = nextLeafId();
    const spec = buildTextSpec(p);
    const leaf: Layer = {
      id,
      type: "layer",
      name: textLayerName(p.value),
      visible: true,
      opacity: 100,
      blend: "Normal",
      vector: textVectorOf(spec),
      // Type effects chosen in the Text tool's FX popover. They are ordinary
      // layer effects — the engine renders them from the layer's alpha — so the
      // tool only has to hand them over once the layer exists.
      ...(textFxCount(textSettingsRef.current.fx) ? { effects: textSettingsRef.current.fx } : {}),
    };
    const node = active.activeLayerId ? findNode(before, active.activeLayerId) : null;
    let after: LayerNode[];
    if (node && node.type === "group") after = insertInGroup(before, leaf, node.id);
    else if (node) after = insertRelative(before, leaf, node.id, true);
    else after = [leaf, ...before];
    commitLayerChange("Type", before, selNow(), after, single(id), () =>
      paintRef.current?.renderText(id, spec),
    );
  };

  // Commit a re-edit of an existing text layer: re-rasterize + update its vector
  // in place (one "Edit Text" step that renders from the old/new vector on undo/redo).
  const updateText = (layerId: string, p: TextGeom) => {
    const eng = paintRef.current;
    const docId = activeIdRef.current;
    const treeBefore = activeDocRef.current.layers;
    const node = findNode(treeBefore, layerId);
    if (!eng || !node || node.type !== "layer") return;
    const oldVec = node.vector?.type === "text" ? node.vector : null;
    const spec = buildTextSpec(p);
    const newVec = textVectorOf(spec);
    const treeAfter = updateNode(treeBefore, layerId, {
      vector: newVec,
      name: textLayerName(p.value),
      // The FX popover was seeded from this layer on re-edit, so writing it back
      // round-trips; a layer whose effects were never touched writes the same
      // value it started with.
      ...(textSettingsRef.current.fx ? { effects: textSettingsRef.current.fx } : {}),
    });
    const setLayers = (tree: LayerNode[]) =>
      setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, layers: tree } : d)));
    const redo = () => {
      eng.renderText(layerId, spec);
      setLayers(treeAfter);
    };
    const undo = () => {
      if (oldVec) eng.renderText(layerId, specFromTextVector(oldVec));
      else eng.clearLayerPixels(layerId);
      setLayers(treeBefore);
    };
    redo();
    eng.pushStructural("Edit Text", undo, redo);
  };

  // Type on a path, and off it (commands/text.ts).
  const {
    setTextPath,
  } = textOps({
    documents: docStore,
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    specFromTextVector,
    textVectorOf,
  });

  // ---- Align & distribute (Move tool options, TODO §2) ---------------------
  //
  // Operates on the top-level SELECTED nodes: a group counts as one object
  // (its box is the union of its leaves, and every leaf inside it takes the
  // same delta), which is what makes aligning a group do the obvious thing
  // instead of scattering its contents.
  const alignBoxesOf = (): { boxes: AlignBox[]; leaves: Map<string, string[]> } => {
    const eng = paintRef.current;
    const tree = activeDocRef.current.layers;
    const boxes: AlignBox[] = [];
    const leaves = new Map<string, string[]>();
    if (!eng) return { boxes, leaves };
    for (const top of topLevelSelected(tree, new Set(targetIds()))) {
      const ids = collectLeafIds([top]);
      const parts = ids.map((id) => eng.layerContentBounds(id)).filter((b): b is Rect => !!b);
      const u = unionBox(parts.map((b, i) => ({ id: String(i), ...b })));
      if (!u) continue; // nothing painted in this node — nothing to align
      boxes.push({ id: top.id, ...u });
      leaves.set(top.id, ids);
    }
    return { boxes, leaves };
  };

  /** `toCanvas` aligns against the document (or the selection, when there is
   *  one) instead of against the selected layers' own union — the only way a
   *  SINGLE layer can be aligned, since its own union is itself. */
  const alignLayersOp = (mode: AlignMode, toCanvas: boolean) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return;
    const { boxes, leaves } = alignBoxesOf();
    if (!boxes.length) {
      showToast("Select a layer with pixels to align.");
      return;
    }
    if (boxes.length < 2 && !toCanvas) {
      showToast("Aligning one layer to itself does nothing — use Align to canvas.");
      return;
    }
    // An active selection is the more specific frame, so it wins over the canvas
    // — "align to canvas" with a marquee up means "align inside the marquee".
    const selBox = unionBox(d.selection.map((r, i) => ({ id: String(i), ...r })));
    const target = toCanvas ? (selBox ?? { x: 0, y: 0, w: d.width, h: d.height }) : unionBox(boxes)!;
    applyDeltas(alignDeltas(boxes, mode, target), leaves, ALIGN_LABEL[mode]);
  };

  const distributeLayersOp = (mode: DistributeMode) => {
    const { boxes, leaves } = alignBoxesOf();
    if (boxes.length < 3) {
      showToast("Distributing needs three or more layers — the outer two set the span.");
      return;
    }
    applyDeltas(distributeDeltas(boxes, mode), leaves, DISTRIBUTE_LABEL[mode]);
  };

  /** Move each node's leaves by its delta, as ONE undoable step. */
  const applyDeltas = (raw: Delta[], leaves: Map<string, string[]>, label: string) => {
    const eng = paintRef.current;
    if (!eng) return;
    const deltas = nonZero(raw);
    if (!deltas.length) {
      showToast("Already in place.");
      return;
    }
    const tree = activeDocRef.current.layers;
    const touched = deltas.flatMap((d) => leaves.get(d.id) ?? []);
    const before = eng.captureLeaves(touched);
    for (const d of deltas)
      for (const leafId of leaves.get(d.id) ?? []) {
        const node = findNode(tree, leafId);
        eng.offsetLayerPixels(leafId, d.dx, d.dy, node?.mask?.linked !== false);
      }
    const after = eng.captureLeaves(touched);
    eng.pushStructural(
      label,
      () => eng.restoreLeaves(before),
      () => eng.restoreLeaves(after),
    );
  };


  const selectLayer = (id: string, mode: "replace" | "toggle" | "range" = "replace") => {
    commitFloatIfAny();
    patchActiveDoc((d) => {
      if (mode === "toggle") {
        const has = d.selectedLayerIds.includes(id);
        const selected = has ? d.selectedLayerIds.filter((x) => x !== id) : [...d.selectedLayerIds, id];
        const activeLayerId = has ? (selected[selected.length - 1] ?? null) : id;
        return { ...d, selectedLayerIds: selected, activeLayerId };
      }
      if (mode === "range") {
        const order = flattenedIds(d.layers);
        const a = order.indexOf(d.activeLayerId ?? id);
        const b = order.indexOf(id);
        if (a === -1 || b === -1) return { ...d, selectedLayerIds: [id], activeLayerId: id };
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return { ...d, selectedLayerIds: order.slice(lo, hi + 1), activeLayerId: id };
      }
      return { ...d, selectedLayerIds: [id], activeLayerId: id };
    });
  };

  // ---- Isolate mode -------------------------------------------------------
  // A VIEW state: the canvas renders a derived tree while the document keeps its
  // real visibility flags, so nothing here touches history, the .gproj, or what
  // an export sees. Held with the document id so switching tabs cannot leave you
  // looking at another document's isolation.
  const [isolate, setIsolate] = useState<{ docId: string; ids: string[] } | null>(null);
  const isolatedIds = useMemo(
    () => normalizeIsolation(active.layers, isolate?.docId === active.id ? isolate.ids : null),
    [active.layers, active.id, isolate],
  );
  const isolation = useMemo(
    () => (isolatedIds ? resolveIsolation(active.layers, isolatedIds) : null),
    [active.layers, isolatedIds],
  );
  // The tree the CANVAS renders (and hit-tests, and draws smart guides from).
  // Every other consumer — export, flatten, the Layers panel — keeps reading
  // `active.layers`, which is what makes this a view state rather than an edit.
  // `applyIsolation` returns the SAME tree when nothing changes, so the render
  // graph keeps every cached layer when isolate is off.
  const viewLayers = useMemo(
    () => (isolation ? applyIsolation(active.layers, isolation) : active.layers),
    [active.layers, isolation],
  );
  const isolatedHiding = isolation ? hiddenByIsolation(active.layers, isolation) : 0;

  // Quick Mask, Isolate, the guides' commit (commands/view.ts).
  const {
    toggleQuickMask,
    toggleIsolate,
    commitGuides,
  } = viewOps({
    documents: docStore,
    active,
    activeIdRef,
    activeDocRef,
    paintRef,
    showToast,
    selStateOf,
    setSelState,
    setQuickMaskDocs,
    isolatedIds,
    setIsolate,
  });

  const layersApi: LayersApi = {
    layers: active.layers,
    activeLayerId: active.activeLayerId,
    selectedLayerIds: active.selectedLayerIds,
    add: addLayerOp,
    select: selectLayer,
    update: (id, patch) =>
      patchActiveDoc((d) => ({ ...d, layers: updateNode(d.layers, id, patch) })),
    move: (fromId, targetId, before) =>
      patchActiveDoc((d) => {
        if (fromId === targetId) return d;
        if (!findNode(d.layers, fromId)) return d;
        const { tree: without, removed } = removeNode(d.layers, fromId);
        if (!removed) return d;
        if (!findNode(without, targetId)) return d; // target was inside the moved group
        return { ...d, layers: insertRelative(without, removed, targetId, before) };
      }),
    /* Reordering has always changed the tree without recording anything, so
       Undo stepped straight past it to whatever came before — by mouse as much
       as by touch. The moves stay live (the row has to follow the pointer), and
       the whole drag is written as one entry when it ends, which is the same
       shape the samplers already use. */
    commitMove: (before) => {
      const docId = activeIdRef.current;
      const d = activeDocRef.current;
      const after = d.layers;
      if (before === after) return;
      const sel: Sel = { active: d.activeLayerId, selected: d.selectedLayerIds };
      paintRef.current?.pushStructural(
        "Reorder layer",
        () => setDocSel(docId, before, sel),
        () => setDocSel(docId, after, sel),
      );
    },
    remove: removeSelected,
    duplicate: duplicateSelected,
    group: groupSelected,
    ungroup: ungroupLayerOp,
    merge: mergeSelected,
    flatten: flattenImage,
    setLock: (id, flag, on) => {
      const n = findNode(active.layers, id);
      if (!n) return;
      const next: LayerLocks = { ...n.locks, [flag]: on };
      // Normalize: keep only the flags that are on, so a fully-unlocked layer
      // stores no `locks` object at all (clean tree + smaller .gproj).
      const clean: LayerLocks = {};
      if (next.transparency) clean.transparency = true;
      if (next.pixels) clean.pixels = true;
      if (next.position) clean.position = true;
      if (next.all) clean.all = true;
      const any = clean.transparency || clean.pixels || clean.position || clean.all;
      patchActiveDoc((d) => ({
        ...d,
        layers: updateNode(d.layers, id, { locks: any ? clean : undefined }),
      }));
    },
    isolatedIds,
    toggleIsolate,
    toggleLinkSelected: () => {
      const ids = active.selectedLayerIds;
      if (!ids.length) return;
      const nodes = ids
        .map((id) => findNode(active.layers, id))
        .filter((n): n is LayerNode => !!n);
      const allLinked = nodes.length > 0 && nodes.every((n) => isLinked(n));
      const set = new Set(ids);
      if (allLinked) {
        // Every selected layer is linked → unlink them all (then prune orphans).
        patchActiveDoc((d) => ({ ...d, layers: pruneLinks(clearLinkKey(d.layers, set)) }));
      } else if (ids.length >= 2) {
        // Bind the whole selection under one fresh key (prune any freed sets).
        const key = newLinkKey();
        patchActiveDoc((d) => ({ ...d, layers: pruneLinks(setLinkKey(d.layers, set, key)) }));
      }
    },
    unlinkLayer: (id) =>
      patchActiveDoc((d) => ({ ...d, layers: pruneLinks(clearLinkKey(d.layers, new Set([id]))) })),
    addFill: (kind) => addFillOp(kind),
    editFill: (id) => {
      if (isFillLayer(findNode(active.layers, id))) setFillEdit({ layerId: id });
    },
    maskSurface: paintSurface,
    chooseSurface,
    addMask: addMaskOp,
    removeMask: removeMaskOp,
    applyMask: applyMaskOp,
    toggleMaskEnabled: (id) => {
      const n = findNode(active.layers, id);
      if (n?.mask) toggleMaskMeta(id, { enabled: !n.mask.enabled }, n.mask.enabled ? "Disable Layer Mask" : "Enable Layer Mask");
    },
    toggleMaskLinked: (id) => {
      const n = findNode(active.layers, id);
      if (n?.mask) toggleMaskMeta(id, { linked: !n.mask.linked }, n.mask.linked ? "Unlink Layer Mask" : "Link Layer Mask");
    },
    maskViewId,
    toggleMaskView,
    toggleFilterMaskEnabled: (id) => {
      const n = findNode(active.layers, id);
      if (n && n.type !== "adjustment" && n.filterMask) setFilterMaskEnabled(id, !n.filterMask.enabled);
    },
    loadMaskAsSelection: loadMaskAsSelectionOp,
    addAdjustment: (typeId) => addAdjustmentOp(typeId),
    setAdjustmentClipped: setClippedOp,
    toggleClip: (id) => {
      const n = findNode(active.layers, id);
      if (n) setClippedOp(id, !n.clipped);
    },
    editAdjustment: (id) => {
      const n = findNode(active.layers, id);
      if (n?.type !== "adjustment") return;
      const t = n.adjustment.type;
      if (t === "curves" || t === "levels") editToneNode(id);
      else if (t === "huesat" || t === "selective" || t === "chanmix" || t === "gradientmap")
        setExtraEdit({ layerId: id });
      else if (t === "colorlookup") {
        // Nothing to slide — editing a LUT layer means choosing another .cube.
        cubeTargetRef.current = id;
        cubeInputRef.current?.click();
      } else selectLayer(id, "replace"); // sliders → panel; invert/equalize have no params
    },
    openLayerStyle: openLayerStyleOp,
    openFilters: openFiltersOp,
    toggleEffect: toggleEffectOp,
    copyLayerStyle: copyLayerStyleOp,
    pasteLayerStyle: pasteLayerStyleOp,
    clearLayerStyle: clearLayerStyleOp,
    canPasteStyle: !!fxClipboard,
  };

  // Return a paintable leaf id: the active layer if it's a pixel layer, otherwise
  // create one (inside the active group if a group is selected). Uses refs so it
  // is safe to call from the global keydown listener too.
  const ensureLayer = (): string => {
    const cur = activeLayerRef.current;
    if (cur) {
      const node = findNode(activeDocRef.current.layers, cur);
      if (node && node.type === "layer") return cur;
    }
    const id = nextLeafId();
    const layer: Layer = {
      id,
      type: "layer",
      name: `Layer ${layerSeqRef.current}`,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    setDocs((ds) =>
      ds.map((d) => {
        if (d.id !== activeIdRef.current) return d;
        const node = cur ? findNode(d.layers, cur) : null;
        const layers =
          node && node.type === "group"
            ? insertInGroup(d.layers, layer, node.id)
            : [layer, ...d.layers];
        return { ...d, layers, activeLayerId: id, selectedLayerIds: [id] };
      }),
    );
    return id;
  };

  // Copy, cut, paste; undo and redo (commands/clipboard.ts).
  const {
    copySelection,
    cutSelection,
    applyPaste,
    doUndo,
    doRedo,
    commitFloatIfAny,
    placePaste,
    pasteFromClipboard,
  } = clipboardOps({
    documents: docStore,
    activeIdRef,
    activeDocRef,
    paintRef,
    selRef,
    activeLayerRef,
    prefsRef,
    seqRef,
    layerSeqRef,
    clipboardRef,
    copyOriginRef,
    copyDocIdRef,
    pasteSrc,
    setPasteSrc,
    setPendingPaste,
    setSelection,
    setActiveId,
    setTool,
  });

  // ---- Autosave / crash recovery + the status bar's save indicator ----------
  const [saveState, setSaveState] = useState<{ label: string; ok: boolean }>({
    label: "Not saved",
    ok: false,
  });
  const autosaveDirtyRef = useRef(false); // history moved since the last write

  /* ---- The phone's start card -------------------------------------------
     Shown over an UNTOUCHED document only: one document, no layers, and no
     history past its base. That predicate is the whole safety story — the card
     is a launch state, not a modal, and appearing over someone's work would
     make it a nuisance rather than a shortcut.

     Dismissal lasts the session rather than being persisted. Reloading onto a
     blank artboard is exactly the state the card is for, so remembering the
     dismissal for ever would be answering a question the user was not asked. */
  const [startDismissed, setStartDismissed] = useState(false);
  const [startSnap, setStartSnap] = useState<AutosaveSnapshot | null>(null);
  const [recents, setRecents] = useState<RecentImage[]>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // Per-document `.gproj` JSON, so a snapshot covers EVERY open tab, not just
  // the active one. A document is (re)serialized when it's active (each tick)
  // and when you switch away from it — it can't change while inactive — and is
  // seeded from its file/snapshot JSON on load so a never-viewed tab (its
  // pixels still queued, not yet in the engine) still restores.
  const docJsonCache = useRef(new Map<string, AutosaveDoc>());
  const prevAutoActiveRef = useRef(activeId);

  // Refresh a document's cached JSON when you leave it (last chance — it's
  // frozen while inactive). Skips documents whose pixels haven't materialized
  // (still in pendingLoads); those keep their seeded JSON.
  useEffect(() => {
    const prev = prevAutoActiveRef.current;
    prevAutoActiveRef.current = activeId;
    if (prev === activeId) return;
    const leaving = docsRef.current.find((d) => d.id === prev);
    if (leaving && !pendingLoadsRef.current.some((p) => p.docId === prev)) {
      try {
        docJsonCache.current.set(prev, { json: serializeDocToJSON(leaving), name: leaving.name });
      } catch {
        /* keep the prior cache entry */
      }
    }
    // A tab switch only, as always: `serializeDocToJSON` (commands/projects.ts) is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /** Edits since the document was last written to a FILE. */
  const unsavedRef = useRef(false);

  /* The back gesture, and leaving with unsaved work.
   *
   * On a phone back is how everything is dismissed, and nothing here consumed
   * it: back left the editor outright. A guard entry is pushed so there is
   * something for it to land on; when it does, the layer in front is closed and
   * the guard is pushed again. With nothing left to close, the navigation is
   * allowed — and only then does beforeunload ask about unsaved work.
   *
   * beforeunload is registered unconditionally but only SPEAKS when there are
   * edits: it does not block the back/forward cache (that is `unload`), and a
   * handler that returns without touching the event prompts no one. It does
   * nothing at all on iOS, which is why the autosave-on-hidden work matters
   * more than this does. */
  useEffect(() => {
    const pushGuard = () => {
      try {
        // `history` here is the editor's own undo history — hence window.
        window.history.pushState({ gqBackGuard: true }, "");
      } catch {
        /* history unavailable — back simply leaves, as before */
      }
    };
    /* A modal dialog is tried first and by its own route: dialogs sit above
       everything and own Escape themselves, so the key goes to whatever has
       focus inside the trap rather than the dialog being closed behind its
       back. */
    const closeTopDialog = (): boolean => {
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (!dialog || !(dialog.parentElement && /overlay/i.test(dialog.parentElement.className || "")))
        return false;
      const target =
        document.activeElement && dialog.contains(document.activeElement)
          ? document.activeElement
          : dialog;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      return true;
    };
    const onPop = () => {
      if (closeTopDialog() || dismissTop()) pushGuard();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // some browsers still want this set
    };
    pushGuard();
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  /* Whether there is anything to continue FROM. Read once on mount, and only
     to label a button — the restore itself goes through the same
     `restoreSnapshot` the crash path uses. */
  useEffect(() => {
    void readAutosave().then((snap) => snap?.docs?.length && setStartSnap(snap));
    void listRecentImages().then(setRecents);
  }, []);

  // Heartbeat: detect an unclean exit and offer the last snapshot for restore.
  useEffect(() => {
    // Read BEFORE arming: installHeartbeat() overwrites the answer.
    const unclean = wasUncleanExit();
    const stopHeartbeat = installHeartbeat();
    if (unclean) void readAutosave().then((s) => s && setRestoreSnap(s));
    return stopHeartbeat;
  }, [setRestoreSnap]);

  /** Every open document, serialized now, in tab order (active one refreshed
   *  from the engine; inactive ones can't have changed since they were cached).
   *  Shared by the autosave tick and by crash recovery. */
  const collectOpenDocs = useCallback((
    encoded?: ReadonlyMap<string, Blob>,
  ): { entries: AutosaveDoc[]; activeIndex: number } => {
    const docsNow = docsRef.current;
    const active = activeDocRef.current;
    /* The cached entry carries its images too, so an inactive tab's references
       still resolve in the next snapshot — they are only re-encoded when that
       tab is the active one. */
    docJsonCache.current.set(active.id, {
      json: serializeDocToJSON(active, encoded),
      name: active.name,
      ...(encoded && encoded.size ? { images: Object.fromEntries(encoded) } : {}),
    });
    const openIds = new Set(docsNow.map((d) => d.id));
    for (const k of [...docJsonCache.current.keys()]) if (!openIds.has(k)) docJsonCache.current.delete(k);
    const entries: AutosaveDoc[] = [];
    let activeIndex = 0;
    for (const d of docsNow) {
      let cached = docJsonCache.current.get(d.id);
      // A tab that has never been left has no cache entry yet. Skipping it lost
      // three of five open documents in a crash-recovery run — and the engine
      // holds every materialized document's canvases, so it can simply be
      // serialized here. The exception is a document whose pixels are still
      // queued (pendingLoads): serializing THAT yields an empty document, which
      // is worse than leaving it out, so it keeps the old behaviour.
      if (!cached && !pendingLoadsRef.current.some((p) => p.docId === d.id)) {
        try {
          cached = { json: serializeDocToJSON(d), name: d.name };
          docJsonCache.current.set(d.id, cached);
        } catch {
          /* one document failing must not cost the others */
        }
      }
      if (!cached) continue;
      if (d.id === active.id) activeIndex = entries.length;
      entries.push(cached);
    }
    return { entries, activeIndex };
    // Made once, as always: it reads the documents through refs, and `serializeDocToJSON`
    // (commands/projects.ts) is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hand the crash boundary a way to serialize the open documents. It is kept
  // at module scope in crash.ts precisely so it outlives this component: when a
  // render throws, React unmounts the editor, and this closure is the only
  // thing left that knows how to reach the user's unsaved work.
  //
  // Deliberately NOT unregistered on unmount. React runs the unmounted subtree's
  // effect cleanups BEFORE it calls the boundary's componentDidCatch, so a
  // cleanup here would disarm recovery at precisely the moment it is needed —
  // measured, not theorised: the crash screen offered "no recoverable work"
  // while the pixels were sitting in the engine. A remount (a hot reload, a new
  // editor) overwrites the entry with a live one.
  useEffect(() => {
    registerRecovery(() => collectOpenDocs().entries);
  }, [collectOpenDocs]);

  /** Snapshot ALL open documents, if anything changed since the last write.
   *  Refreshes the active document from the engine, keeps the cached JSON for
   *  the rest, prunes closed tabs, and writes them in tab order.
   *
   *  Guarded against overlapping runs: the timer and the page going away can
   *  both ask at once, and the second would re-serialize every layer for a
   *  snapshot identical to the one already in flight. */
  const savingRef = useRef(false);

  /** Encode everything the ACTIVE document's JSON needs, in a worker.
   *
   *  Only the active document: `collectOpenDocs` re-serializes that one and
   *  reuses cached JSON for the rest, so the others cost nothing here either.
   *  Each canvas is exactly the one the synchronous getter would have encoded,
   *  so the result is byte-identical — the encoder is the same, it simply runs
   *  somewhere else. Anything that fails to encode is left out of the map and
   *  falls back to the main-thread getter. */
  const encodeDocOffThread = useCallback(async (d: Doc): Promise<Map<string, Blob>> => {
    const out = new Map<string, Blob>();
    const eng = paintRef.current;
    if (!eng) return out;
    const jobs: Promise<void>[] = [];
    const add = (key: string, canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      jobs.push(
        encodePngOffThread(canvas)
          .then((blob) => {
            if (blob) out.set(key, blob);
          })
          .catch(() => {}),
      );
    };
    const walk = (layers: readonly LayerNode[]) => {
      for (const l of layers) {
        // A group has no raster of its own, but its mask is still stored.
        if (l.type !== "group") {
          add(`layer:${l.id}`, eng.getLayerImageCanvas(l.id));
          add(`frame:${l.id}`, eng.getFrameSourceImageCanvas(l.id));
        }
        add(`mask:${l.id}`, eng.getMaskImageCanvas(l.id));
        if (l.type === "group") walk(l.children);
      }
    };
    walk(d.layers);
    for (const ch of d.channels ?? []) {
      const key = selectionChannelKey(d.id, ch.id);
      add(`mask:${key}`, eng.getMaskImageCanvas(key));
    }
    await Promise.all(jobs);
    return out;
  }, []);

  const writeSnapshot = useCallback(async () => {
    if (!autosaveDirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    try {
      const encoded = await encodeDocOffThread(activeDocRef.current);
      const { entries, activeIndex } = collectOpenDocs(encoded);
      if (!entries.length) return;
      const written = await writeAutosave({ docs: entries, activeIndex, savedAt: Date.now() });
      if (!written.ok) {
        /* Say so, and leave the document DIRTY so the next tick tries again.
           Claiming "Autosaved" when nothing was stored is worse than saying
           nothing at all — it is the case where the work is most at risk. */
        setSaveState({ label: `Autosave failed — ${written.reason}`, ok: false });
        return;
      }
      autosaveDirtyRef.current = false;
      setSaveState({
        label: `Autosaved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        ok: true,
      });
    } catch {
      /* serialization/storage hiccup — try again next tick */
    } finally {
      savingRef.current = false;
    }
  }, [collectOpenDocs, encodeDocOffThread]);

  // Periodic snapshot.
  useEffect(() => {
    const mins = prefs.autosaveMinutes;
    if (!mins) return;
    const id = window.setInterval(() => void writeSnapshot(), mins * 60_000);
    return () => window.clearInterval(id);
  }, [prefs.autosaveMinutes, writeSnapshot]);

  /* ...and a snapshot the moment the page goes away, which on a phone is the
     one that matters. A timer alone means up to `autosaveMinutes` of work — two
     by default — dies when the OS reclaims a backgrounded tab, and iOS does
     that eagerly and without warning. `visibilitychange → hidden` is the last
     point a page is reliably allowed to write; `pagehide` covers the paths that
     skip it (a bfcache entry, a navigation away). Both fire on an ordinary tab
     switch too, which is exactly the point: the snapshot is already on disk
     before the tab is a candidate for discarding.

     Not `beforeunload`: it does not fire at all on iOS, and asking for it costs
     the page its bfcache entry. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void writeSnapshot();
    };
    const onPageHide = () => void writeSnapshot();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [writeSnapshot]);

  // "Reduce motion" preference -> data-motion on <html> (globals.scss kills
  // animations/transitions under [data-motion="off"], like the OS setting).
  useEffect(() => {
    document.documentElement.setAttribute("data-motion", prefs.reduceMotion ? "off" : "on");
  }, [prefs.reduceMotion]);

  // Accessibility preferences -> data-cvd / data-contrast on <html>, which
  // globals.scss reads to swap the semantic triad and firm up the theme. Same
  // client-side pattern as data-motion (theme/accent go through cookies because
  // only those two would flash on the very first paint).
  // Changing either repaints every surface: as one swap of the look (lib/look),
  // quietly on the first set.
  useEffect(() => {
    setLookAttribute("data-cvd", prefs.colorVision);
  }, [prefs.colorVision]);
  useEffect(() => {
    setLookAttribute("data-contrast", prefs.highContrast ? "high" : "normal");
  }, [prefs.highContrast]);
  // The OS flipping light/dark under a `system` theme lands in one frame too.
  useEffect(() => watchSystemLook(), []);

  // Render-cache budget preference -> engine LRU limit (evicts when shrunk).
  useEffect(() => {
    paintRef.current?.setRenderCacheBudget(prefs.cacheBudgetMB);
  }, [prefs.cacheBudgetMB]);

  // Non-linear history preference -> engine (also applied to a fresh engine).
  useEffect(() => {
    paintRef.current?.setNonLinearHistory(prefs.nonLinearHistory);
  }, [prefs.nonLinearHistory]);

  // Undo-step cap -> engine history trim (oldest steps drop first).
  useEffect(() => {
    paintRef.current?.setHistoryLimit(prefs.historyLimit);
  }, [prefs.historyLimit]);

  // Undo MEMORY cap -> the same trim, by bytes. Whichever cap binds first wins.
  useEffect(() => {
    paintRef.current?.setHistoryBudgetMB(prefs.historyBudgetMB);
  }, [prefs.historyBudgetMB]);

  // Background-worker toggle -> engine compute paths + the RAW decoder.
  useEffect(() => {
    paintRef.current?.setWorkersEnabled(prefs.useWorkers);
    setRawWorkerEnabled(prefs.useWorkers);
  }, [prefs.useWorkers]);

  // Recent-files length -> the recents store's post-add trim.
  useEffect(() => {
    setRecentsLimit(prefs.recentsLimit);
  }, [prefs.recentsLimit]);

  // New, Close, Rename, the sample (commands/documents.ts).
  const {
    createDoc,
    requestNewDoc,
    closeDoc,
    renameDoc,
    openSampleDoc,
  } = documentOps({
    documents: docStore,
    docs,
    activeId,
    prefsRef,
    seqRef,
    paintRef,
    docJsonCache,
    acceptSize,
    setActiveId,
    setNewDocOpen,
    nextLeafId,
    setPendingLoads,
  });

  // Save, Save As, Open, load and restore a project (commands/projects.ts).
  const {
    serializeDocToJSON,
    saveProject,
    saveProjectAs,
    openProject,
    loadProjectText,
    onFilePicked,
    restoreSnapshot,
  } = projectOps({
    documents: docStore,
    activeIdRef,
    activeDocRef,
    paintRef,
    colorSpaceRef,
    globalLightRef,
    fgRef,
    bgRef,
    seqRef,
    layerSeqRef,
    adjSeqRef,
    docJsonCache,
    fileInputRef,
    autosaveDirtyRef,
    unsavedRef,
    showToast,
    acceptSize,
    commitFloatIfAny,
    setActiveId,
    setPendingLoads,
    setForeground,
    setBackground,
    restoreGlobalLight,
    setColorSpaceState,
    setSaveState,
    setSaveAsOpen,
    renameDoc,
    nextLeafId,
  });

  // Export: the dialog, single and batch, PSD, SVG, frames (commands/export.ts).
  const {
    openExport,
    exportMetaFor,
    doExport,
    doBatchExport,
    exportFrames,
    exportVectorSVG,
    exportPSD,
  } = exportOps({
    activeDocRef,
    paintRef,
    prefsRef,
    showToast,
    exportComposite,
    setExportComposite,
  });

  // Edit description/artist/copyright from the Metadata panel. A document with
  // no source metadata gets a minimal stub so authoring fields work everywhere.
  const updateDocMetadata = (patch: Partial<ImageMetadata>) => {
    patchActiveDoc((d) => ({
      ...d,
      metadata: {
        ...(d.metadata ?? {
          fileName: d.name,
          fileSize: 0,
          fileType: "",
          lastModified: Date.now(),
        }),
        ...patch,
      },
    }));
  };

  // ---- Print (flatten → browser print dialog) ----
  // Render the active document's composite, then print it from a hidden iframe
  // (avoids popup blockers and prints only the artwork, not the whole app UI).
  const printCanvas = () => setPrintOpen(true);

  /**
   * Render the composite onto a sheet laid out by `layoutPage` and hand it to
   * the browser's print dialog.
   *
   * The geometry is the PDF export's model, not a second one: `@page size` is
   * set to the computed sheet so the browser's dialog defaults to the paper the
   * user just chose, and the image is placed absolutely at the computed rect
   * with `margin: 0`, so nothing is scaled twice. `layoutPage` works in PDF
   * coordinates (origin bottom-left), hence the flip on the way to CSS.
   */
  const doPrint = (opts: PdfLayoutOptions, applyProof: boolean) => {
    setPrintOpen(false);
    const composite = paintRef.current?.exportComposite(activeDocRef.current.layers);
    if (!composite) return;
    const layout = layoutPage(composite.width, composite.height, opts);
    let source: HTMLCanvasElement = composite;
    if (applyProof) {
      /* The soft proof is a VIEW transform, so it never reaches a printer on its
         own — the pixels have to carry it. Done here rather than in the engine
         because only this path wants it baked in. */
      const c = document.createElement("canvas");
      c.width = composite.width;
      c.height = composite.height;
      /* In the DOCUMENT's space. A canvas made without one is sRGB, and the
         copy into it alone clipped every colour to sRGB; the proof then ran on
         sRGB numbers it was told were P3. With an sRGB target that looked
         right by accident; with Adobe RGB it printed P3 green as sRGB green. */
      const space = canvasSpaceOf(colorSpaceRef.current);
      const g = c.getContext("2d", { willReadFrequently: true, colorSpace: space });
      if (g) {
        g.drawImage(composite, 0, 0);
        const img = g.getImageData(0, 0, c.width, c.height, { colorSpace: space });
        proofTransformInPlace(img.data, space, proofTarget, true, gamutWarn);
        g.putImageData(img, 0, 0);
        source = c;
      }
    }
    const url = source.toDataURL("image/png");
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const cw = iframe.contentWindow;
    const cd = iframe.contentDocument ?? cw?.document;
    if (!cw || !cd) {
      iframe.remove();
      return;
    }
    cd.open();
    const pt = (v: number) => `${v.toFixed(3)}pt`;
    cd.write(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        // The sheet the user chose, and no page margin: the placement below is
        // already margin-aware, so letting the browser add its own would inset
        // an image that has been positioned to the millimetre.
        `@page{size:${pt(layout.pageW)} ${pt(layout.pageH)};margin:0;}` +
        "*{margin:0;padding:0;box-sizing:border-box;}" +
        "html,body{width:100%;height:100%;}" +
        `img{position:absolute;left:${pt(layout.x)};top:${pt(layout.pageH - layout.y - layout.h)};` +
        `width:${pt(layout.w)};height:${pt(layout.h)};}` +
        '</style></head><body><img alt=""></body></html>',
    );
    cd.close();
    cd.title = activeDocRef.current.name;
    let done = false;
    let printed = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      setTimeout(() => iframe.remove(), 500);
    };
    const fire = () => {
      if (printed) return;
      printed = true;
      cw.focus();
      cw.print();
      cleanup();
    };
    cw.onafterprint = cleanup;
    const img = cd.querySelector("img");
    if (img) {
      img.onload = fire;
      img.onerror = cleanup;
      img.src = url;
      if (img.complete && img.naturalWidth) fire();
    } else {
      cleanup();
    }
    // Safety net if the print dialog never opens / afterprint never fires.
    setTimeout(() => {
      if (document.body.contains(iframe)) iframe.remove();
    }, 60000);
  };

  // The Blur Gallery, Liquify and Warp (commands/sessions.ts).
  const {
    openBlurFx,
    changeBlurFx,
    applyBlurFx,
    closeBlurFx,
    openLiquify,
    openWarp,
    applyWarp,
    applyLiquify,
  } = sessionOps({
    activeDocRef,
    paintRef,
    showToast,
    blurFx,
    setBlurFx,
    setBlurPreview,
    setBlurFxOpen,
    blurFxOpenRef,
    blurFxSessionRef,
    blurFxTimerRef,
    liquify,
    setLiquify,
    warping,
    setWarping,
  });

  // ---- Import (one or more image files) ----
  const stripExt = (n: string) => n.replace(/\.[^.]+$/, "") || "Image";
  const openImport = () => importInputRef.current?.click();

  // Open a parsed PSD as its own document: convert the node tree (fresh ids,
  // masks as MaskMeta) and hand the pixels/masks to the engine via PendingLoad
  // — the same machinery .gproj loading uses.
  const importPSDDocument = (fileName: string, psd: PsdDocument) => {
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const images: PendingLoad["images"] = [];
    const masks: { id: string; source: CanvasImageSource }[] = [];
    const toCanvas = (img: PsdImage): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      return c;
    };
    let firstLeaf: string | null = null;
    const convert = (ns: PsdNode[]): LayerNode[] =>
      ns.map((n): LayerNode => {
        const id = nextLeafId();
        if (n.mask) masks.push({ id, source: toCanvas(n.mask) });
        const base = {
          id,
          name: n.name || "Layer",
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
          ...(n.mask ? { mask: { enabled: n.maskEnabled, linked: true } } : {}),
        };
        if (n.kind === "group")
          return { ...base, type: "group", expanded: true, children: convert(n.children) };
        if (!firstLeaf) firstLeaf = id;
        if (n.image) images.push({ id, source: toCanvas(n.image) });
        return { ...base, type: "layer", ...(n.clipped ? { clipped: true } : {}) };
      });
    const layers = convert(psd.nodes);
    if (!layers.length) return;
    setDocs((ds) => [
      ...ds,
      {
        id: docId,
        name: stripExt(fileName),
        width: psd.width,
        height: psd.height,
        ...(psd.dpi ? { dpi: psd.dpi } : {}),
        layers,
        activeLayerId: firstLeaf,
        selectedLayerIds: firstLeaf ? [firstLeaf] : [],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: null,
      },
    ]);
    setActiveId(docId);
    setPendingLoads((ls) => [...ls, { docId, images, masks }]);
    if (psd.notes.length)
      showToast(psd.notes[0] + (psd.notes.length > 1 ? ` (+${psd.notes.length - 1} more notes)` : ""));
  };

  /** Open an animation as its own document, one layer per frame — bottom layer
   *  = frame 1, so the stack reads in playback order from the bottom up (the
   *  same direction the Layers panel already shows). Each frame's delay rides
   *  in its layer name, which is what Export frames reads back. */
  const importAnimation = (fileName: string, anim: AnimImage) => {
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const images: PendingLoad["images"] = [];
    const layers: LayerNode[] = [];
    anim.frames.forEach((f, i) => {
      const id = nextLeafId();
      images.push({ id, source: f.bitmap });
      layers.push({
        id,
        type: "layer",
        name: frameLabel(i, f.delayMs),
        // Only the last frame is visible, so the document opens showing the
        // final image rather than an opaque stack of every frame at once.
        visible: i === anim.frames.length - 1,
        opacity: 100,
        blend: "Normal",
      });
    });
    if (!layers.length) return;
    // Layers render top-first, so reverse to put frame 1 at the bottom.
    layers.reverse();
    const top = layers[0].id;
    setDocs((ds) => [
      ...ds,
      {
        id: docId,
        name: stripExt(fileName),
        width: anim.width,
        height: anim.height,
        layers,
        activeLayerId: top,
        selectedLayerIds: [top],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: null,
      },
    ]);
    setActiveId(docId);
    setPendingLoads((ls) => [...ls, { docId, images }]);
    showToast(
      anim.note ||
        `Imported ${anim.frames.length} frames as layers — File ▸ Export frames writes them back out.`,
    );
  };

  /** A remembered picture, opened again from its stored bytes. */
  const openRecent = async (entry: RecentImage) => {
    setStartDismissed(true);
    const file = await readRecentFile(entry.id);
    /* The bytes can be gone — storage cleared, or an entry written by a build
       that stored something else. Falling back to the picker beats a card that
       does nothing when tapped. */
    if (!file) {
      setRecents(await listRecentImages());
      photoInputRef.current?.click();
      return;
    }
    await importFiles([file], "canvas");
  };

  /** A photo picked from the start card: it becomes the document, no dialog. */
  const onStartPhotoPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!picked.length) return;
    setStartDismissed(true);
    await importFiles(picked, "canvas");
  };

  const onImportPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []);
    e.target.value = "";
    await importFiles(allFiles);
  };

  /**
   * The whole file-import pipeline, from a list of files to either a new
   * document (PSD / animation) or the import dialog. Extracted so the file
   * picker and a drop on the canvas take exactly the same route — a dropped
   * PSD has to open as a layered document just as a picked one does, and that
   * only stays true if there is one path.
   */
  const importFiles = async (allFiles: File[], direct?: ImportMode) => {
    if (!allFiles.length) return;
    // PSDs and animations open as their own layered documents; everything else
    // flows through the import dialog.
    const files: File[] = [];
    for (const f of allFiles) {
      if (ANIMATED_EXT.test(f.name)) {
        const anim = await decodeAnimation(f).catch(() => null);
        // A single-frame GIF/PNG/WebP returns null and imports normally.
        if (anim && anim.frames.length > 1) {
          importAnimation(f.name, anim);
          continue;
        }
        if (anim && anim.note) showToast(anim.note);
      }
      if (!/\.psd$/i.test(f.name)) {
        files.push(f);
        continue;
      }
      const parsed = parsePSD(await f.arrayBuffer());
      if (parsed) importPSDDocument(f.name, parsed);
      else
        window.alert(
          `Couldn't read "${f.name}". 16/32-bit, CMYK and PSB files are outside the supported PSD subset.`,
        );
    }
    if (!files.length) return;
    const decoded = await Promise.all(
      files.map(async (f) => {
        // SVG: parsed into a vector recipe (or a faithful raster fallback) —
        // browsers can't decode SVG through createImageBitmap.
        if (looksLikeSVG(f)) {
          const svg = await parseSVGFile(f);
          return {
            name: f.name,
            file: f,
            bitmap: svg?.bitmap ?? null,
            meta: await extractMetadata(f),
            icc: null,
            vector: svg?.vector ?? null,
          };
        }
        return {
          name: f.name,
          file: f,
          bitmap: await decodeImageFile(f),
          meta: await extractMetadata(f),
          icc: await extractICCProfile(f),
          vector: null,
        };
      }),
    );
    const items: ImportItem[] = decoded
      .filter((d) => d.bitmap !== null)
      .map((d) => ({
        name: d.name,
        file: d.file,
        bitmap: d.bitmap as ImageBitmap,
        meta: d.meta,
        icc: d.icc,
        vector: d.vector,
      }));
    const failed = decoded.filter((d) => d.bitmap === null);
    if (failed.length) {
      const heif = failed.some((d) => /\.hei[cf]$/i.test(d.name));
      window.alert(
        `Couldn't read: ${failed.map((d) => d.name).join(", ")}.` +
          (heif
            ? " HEIF/HEIC decodes only where the browser supports it (Safari does; most others don't ship the codec)."
            : ""),
      );
    }
    if (!items.length) return;
    /* `direct` skips the import dialog and takes the choice the caller already
       made. The phone's start card is the one caller: "open a photo" has
       exactly one sensible outcome — the photo becomes the document — and
       asking about anchors and oversize handling first would be a dialog
       between the user and the thing they came to do. Everything upstream of
       here is shared, so a PSD picked from the start card still opens as a
       layered document, and an animation still opens as frames. */
    if (direct) {
      await applyImport(direct, { anchor: 4, expand: true, profileMode: "convert" }, items);
      return;
    }
    setImportItems(items);
  };

  /**
   * Draw an image INTO a frame layer, fitted by that frame's own `fit`.
   *
   * The frame's vector mask does the clipping, so this only has to place the
   * pixels: `fitContent` gives the destination rect (cover / contain / stretch /
   * actual size, plus the frame's offset and scale), and the whole thing lands
   * as ONE undoable pixel step that replaces whatever the frame held before —
   * which is what "place into a frame" means everywhere else it exists.
   */
  const placeInFrame = (frameId: string, bitmap: CanvasImageSource, w: number, h: number): boolean => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, frameId);
    if (!eng || !node || node.type !== "layer" || !node.frame) return false;
    // Keep the source at its natural size so the frame can be re-fitted later
    // without the file — re-fitting from the frame's own (already fitted,
    // already cropped) pixels would resample a resample and could not bring
    // back what the previous fit cut off.
    eng.setFrameSource(frameId, bitmap, w, h);
    return drawFrameContent(frameId, node.frame, "Place in Frame");
  };

  /**
   * Render a frame's stored source into the frame layer at the given spec.
   *
   * One undoable pixel step; the frame's vector mask does the clipping. Used
   * both by placement and by every later change to fit / scale / offset, so
   * there is exactly one description of what a frame looks like.
   */
  const drawFrameContent = (frameId: string, spec: FrameSpec, label: string): boolean => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const src = eng?.getFrameSource(frameId);
    if (!eng || !src) return false;
    const rect = fitContent(src.width, src.height, spec);
    const c = document.createElement("canvas");
    c.width = d.width;
    c.height = d.height;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h);
    eng.applyLayerImage(frameId, c, label);
    return true;
  };

  /**
   * Change a frame's spec and re-render its content to match.
   *
   * Two steps go on the undo stack for one gesture (the spec patch, then the
   * pixels) — the alternative is a bespoke combined entry, and the pixel step
   * has to exist anyway because the layer's canvas really did change.
   */
  const editFrameSpec = (frameId: string, patch: Partial<FrameSpec>, label: string) => {
    const node = findNode(activeDocRef.current.layers, frameId);
    if (!node || node.type !== "layer" || !node.frame) return;
    const next = { ...node.frame, ...patch };
    stylePatchStructural(frameId, { frame: next }, label);
    drawFrameContent(frameId, next, label);
  };

  /**
   * Files dropped on the canvas.
   *
   * With a frame selected the image goes straight in — the import dialog's
   * options (anchor, expand-canvas) describe placement the frame has already
   * decided, so asking would be asking about nothing. Everything else takes the
   * ordinary import route, dialog included, so a drop and File ▸ Import behave
   * identically where they mean the same thing.
   */
  const onCanvasFilesDropped = async (files: File[]) => {
    if (!files.length) return;
    const frameId = activeFrameId();
    if (frameId && files.length === 1 && !/\.psd$/i.test(files[0].name)) {
      const bmp = await decodeImageFile(files[0]).catch(() => null);
      if (bmp) {
        placeInFrame(frameId, bmp, bmp.width, bmp.height);
        bmp.close?.();
        return;
      }
    }
    await importFiles(files);
  };

  // The options bar shows the SELECTED frame's fit when there is one, and the
  // tool default otherwise — so the control always describes the frame the next
  // image will land in.
  const activeFrameNode =
    active.activeLayerId
      ? (() => {
          const n = findNode(active.layers, active.activeLayerId);
          return n && n.type === "layer" && n.frame ? n : null;
        })()
      : null;
  const activeFrameFit: FrameFit = activeFrameNode?.frame?.fit ?? frameFit;
  // Whether the selected frame has a source to re-fit. Read through the engine
  // rather than from the tree: the source is a raster, and only the engine knows
  // whether one survived (a frame saved before v23 restores without one).
  const frameHasContent = !!activeFrameNode && !!paintRef.current?.hasFrameSource(activeFrameNode.id);
  const setActiveFrameFit = (fit: FrameFit) => {
    setFrameFit(fit); // remember it for the next new frame either way
    const node = activeFrameNode;
    if (!node?.frame || node.frame.fit === fit) return;
    // With a source stored the content is re-fitted immediately; an empty frame
    // just records the fit for whatever lands in it next.
    editFrameSpec(node.id, { fit }, "Frame fit");
  };

  /** Scale / nudge the picture inside its frame (options bar). */
  const setActiveFrameScale = (scale: number) => {
    const node = activeFrameNode;
    if (node?.frame) editFrameSpec(node.id, { scale }, "Frame scale");
  };
  const nudgeActiveFrameContent = (dx: number, dy: number) => {
    const node = activeFrameNode;
    if (!node?.frame) return;
    const o = node.frame.offset;
    editFrameSpec(node.id, { offset: { x: o.x + dx, y: o.y + dy } }, "Move frame content");
  };
  const resetActiveFrameContent = () => {
    const node = activeFrameNode;
    if (node?.frame) editFrameSpec(node.id, { scale: 1, offset: { x: 0, y: 0 } }, "Reset frame content");
  };

  /** The active layer, when it is a frame — the target for a placement. */
  const activeFrameId = (): string | null => {
    const d = activeDocRef.current;
    const n = d.activeLayerId ? findNode(d.layers, d.activeLayerId) : null;
    return n && n.type === "layer" && n.frame ? n.id : null;
  };

  // Import images onto new layers of the current canvas (one undoable step).
  const importAsLayers = (itemsIn: ImportItem[], opts: ImportOptions) => {
    // A frame is a placeholder waiting for a picture: with one selected, an
    // import fills it rather than dropping a new layer over the top of it.
    // Any extra images still arrive as ordinary layers, so nothing is lost.
    let items = itemsIn;
    const frameId = activeFrameId();
    if (frameId && items.length) {
      const first = items[0];
      if (placeInFrame(frameId, first.bitmap, first.bitmap.width, first.bitmap.height)) {
        items = items.slice(1);
        if (!items.length) return;
      }
    }
    const d0 = activeDocRef.current;
    let maxW = 0;
    let maxH = 0;
    for (const it of items) {
      maxW = Math.max(maxW, it.bitmap.width);
      maxH = Math.max(maxH, it.bitmap.height);
    }
    const grew = opts.expand && (maxW > d0.width || maxH > d0.height);
    const finalW = grew ? Math.max(d0.width, maxW) : d0.width;
    const finalH = grew ? Math.max(d0.height, maxH) : d0.height;
    // Anchor (3×3 grid index) → per-image position on the (possibly grown) canvas.
    const pos = (iw: number, ih: number) => {
      const col = opts.anchor % 3;
      const row = Math.floor(opts.anchor / 3);
      return {
        x: col === 0 ? 0 : col === 1 ? Math.floor((finalW - iw) / 2) : finalW - iw,
        y: row === 0 ? 0 : row === 1 ? Math.floor((finalH - ih) / 2) : finalH - ih,
      };
    };
    const place = () => {
      const before = activeDocRef.current.layers;
      const placements = items.map((it) => pos(it.bitmap.width, it.bitmap.height));
      const leaves: Layer[] = items.map((it, i) => ({
        id: nextLeafId(),
        type: "layer",
        name: stripExt(it.name),
        visible: true,
        opacity: 100,
        blend: "Normal",
        // SVG: keep the vector recipe (shifted to where the pixels land) so the
        // layer stays a re-renderable vector source.
        ...(it.vector ? { vector: translateVectorPath(it.vector, placements[i].x, placements[i].y) } : {}),
      }));
      const after = [...leaves, ...before]; // first image on top
      commitLayerChange(
        items.length > 1 ? "Import Layers" : "Import Layer",
        before,
        selNow(),
        after,
        { active: leaves[0].id, selected: leaves.map((l) => l.id) },
        () =>
          leaves.forEach((leaf, i) => {
            const p = placements[i];
            paintRef.current?.setLayerImage(leaf.id, items[i].bitmap, p.x, p.y);
          }),
      );
      // Surface the (first) imported image's metadata for the Metadata panel.
      if (items[0]?.meta) patchActiveDoc((d) => ({ ...d, metadata: items[0].meta }));
    };
    if (grew) {
      // Grow the canvas first (same undo-less semantics as Canvas Size), then
      // place once the engine has resized (a double rAF spans the re-render).
      // Bail if the user switched documents in the gap — never import into
      // the wrong canvas.
      const docId = d0.id;
      setActiveSize({ width: finalW, height: finalH });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (activeIdRef.current === docId) place();
        }),
      );
    } else {
      place();
    }
  };

  // Import each image as its own new canvas/tab.
  /* Remembered when a picture opens as its own document — which is what the
     start card's Open/Take photo do, and what "New canvas" does from the import
     dialog. Placing an image as a LAYER is not remembered: that is editing the
     document you already had, not opening a picture.

     Fire-and-forget on purpose. The open has already succeeded by the time this
     runs, and a full disk must not turn "your photo is open" into an error. */
  const rememberRecent = (items: ImportItem[]) => {
    void (async () => {
      for (const it of items) {
        if (!it.file || !it.bitmap) continue;
        const thumb = await makeThumb(it.bitmap);
        if (!thumb) continue;
        await addRecent(it.name, {
          image: {
            file: it.file,
            thumb,
            width: it.bitmap.width,
            height: it.bitmap.height,
            type: it.file.type || "image/*",
          },
        });
      }
      setRecents(await listRecentImages());
    })();
  };

  const importAsCanvases = (itemsIn: ImportItem[]) => {
    /* The path that made this necessary: a 20 KB file naming itself 70000×100
       opened as a document with two canvases and not one pixel in it. Each
       picture is judged on its own so one impossible file in a multi-select
       does not take the rest down with it. */
    const items = itemsIn.filter((it) => acceptSize(it.bitmap.width, it.bitmap.height));
    if (!items.length) return;
    rememberRecent(items);
    const entries: PendingLoad[] = [];
    let firstId: string | null = null;
    const docs: Doc[] = items.map((it) => {
      const seq = (seqRef.current += 1);
      const docId = `doc-${seq}`;
      const lid = nextLeafId();
      if (!firstId) firstId = docId;
      entries.push({ docId, images: [{ id: lid, source: it.bitmap }] });
      return {
        id: docId,
        name: stripExt(it.name),
        width: it.bitmap.width,
        height: it.bitmap.height,
        layers: [
          {
            id: lid,
            type: "layer",
            name: stripExt(it.name),
            visible: true,
            opacity: 100,
            blend: "Normal",
            ...(it.vector ? { vector: it.vector } : {}),
          },
        ],
        activeLayerId: lid,
        selectedLayerIds: [lid],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: it.meta ?? null,
      };
    });
    setDocs((ds) => [...ds, ...docs]);
    if (firstId) setActiveId(firstId);
    setPendingLoads((ls) => [...ls, ...entries]);
  };

  // ---- Onboarding (§11): interactive tour + sample document ----------------
  /* "due" is a first run with the tour about to arrive: it greets with its
     welcome card a beat after the editor is up, so it arrives rather than is
     simply there. The phone's start card waits until it has gone — it blurs
     the stage the tour is pointing at — and takes over from it after. */
  const [tour, setTour] = useState<"off" | "due" | "open">("off");
  useEffect(() => {
    try {
      if (localStorage.getItem("graphiq:welcomed")) return;
    } catch {
      return; /* storage unavailable — never nag */
    }
    setTour("due");
    const t = window.setTimeout(() => setTour("open"), 450);
    return () => window.clearTimeout(t);
  }, []);
  const closeTour = () => {
    setTour("off");
    try {
      localStorage.setItem("graphiq:welcomed", "1");
    } catch {
      /* ignore */
    }
  };

  // ---- Batch processing (§14): run one file through the live app ----------
  // Opens the file as a TEMPORARY document, optionally replays a saved action
  // on it (through the exact playback path — menu commands + strokes), and
  // returns the flattened composite. The temp doc closes and the previously
  // active document comes back, whatever happened.
  const batchRunFile = async (file: File, actionId: string | null): Promise<HTMLCanvasElement | null> => {
    const bitmap = await decodeImageFile(file);
    if (!bitmap) return null;
    const prevId = activeIdRef.current;
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const lid = nextLeafId();
    setDocs((ds) => [
      ...ds,
      {
        id: docId,
        name: stripExt(file.name),
        width: bitmap.width,
        height: bitmap.height,
        layers: [
          { id: lid, type: "layer", name: stripExt(file.name), visible: true, opacity: 100, blend: "Normal" },
        ],
        activeLayerId: lid,
        selectedLayerIds: [lid],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: null,
      },
    ]);
    setActiveId(docId);
    setPendingLoads((ls) => [...ls, { docId, images: [{ id: lid, source: bitmap }] }]);
    try {
      // Wait until CanvasArea consumed the load (the engine holds the pixels).
      const deadline = Date.now() + 8000;
      for (;;) {
        if (activeIdRef.current === docId && !pendingLoadsRef.current.some((p) => p.docId === docId)) break;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 60)); // let the engine draw + refs settle
      if (actionId) await playActionRef.current(actionId);
      return paintRef.current?.exportComposite(activeDocRef.current.layers) ?? null;
    } finally {
      setDocs((ds) => ds.filter((d) => d.id !== docId));
      docJsonCache.current.delete(docId);
      setActiveId(prevId);
      bitmap.close();
    }
  };

  // New document from a Merge-to-HDR result — one pixel layer with the
  // tone-mapped bytes, plus the float radiance kept on the doc (in memory)
  // for HDR tone mapping / HDR PNG export.
  const createHdrDoc = (r: { name: string; canvas: HTMLCanvasElement; hdr: HdrImage }) => {
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const lid = nextLeafId();
    setDocs((ds) => [
      ...ds,
      {
        id: docId,
        name: r.name,
        width: r.canvas.width,
        height: r.canvas.height,
        layers: [
          { id: lid, type: "layer", name: "HDR merge", visible: true, opacity: 100, blend: "Normal" },
        ],
        activeLayerId: lid,
        selectedLayerIds: [lid],
        selection: [],
        selectionAngle: 0,
        selectionPivot: null,
        metadata: null,
        hdr: r.hdr,
      },
    ]);
    setActiveId(docId);
    setPendingLoads((ls) => [...ls, { docId, images: [{ id: lid, source: r.canvas }] }]);
  };

  // Re-render the active layer from the doc's float source — one undo step.
  const applyHdrTone = (canvas: HTMLCanvasElement) => {
    paintRef.current?.applyLayerImage(ensureLayer(), canvas, "HDR Tone Mapping");
  };

  /** `from` supplies the items directly. The dialog path leaves it out and the
   *  items come from state, as they always did; the start card cannot, because
   *  it never opened a dialog — and setting the state first would not help, a
   *  state update is not visible to the call that scheduled it. That is exactly
   *  how the direct route failed silently the first time: no items, no error,
   *  no document. */
  const applyImport = async (mode: ImportMode, opts: ImportOptions, from?: ImportItem[]) => {
    let items = from ?? importItems;
    setImportItems(null);
    if (!items?.length) return;
    if (opts.profileMode === "assign") {
      // ASSIGN working space: keep the file's raw numbers and ignore the
      // embedded profile — re-decode without colour management. (The default
      // decode already CONVERTED, so only profiled items need the second pass.)
      items = await Promise.all(
        items.map(async (it) => {
          if (!it.icc || !it.file) return it;
          try {
            const raw = await createImageBitmap(it.file, { colorSpaceConversion: "none" });
            it.bitmap.close();
            return { ...it, bitmap: raw };
          } catch {
            return it; // keep the converted decode rather than failing the import
          }
        }),
      );
    }
    if (mode === "layers") importAsLayers(items, opts);
    else importAsCanvases(items);
  };

  // ---- Adjustments (applied live to the active leaf; no separate Apply) ----
  // The whole continuous adjustment session coalesces into one undoable
  // "Adjustments" history entry (see engine.applyAdjust/endAdjust). When an area
  // is selected, adjustments affect only that (possibly rotated) region.
  const applyLiveAdjust = (next: Adjustments) => {
    if (!activeLeafId) return;
    const d = activeDocRef.current;
    paintRef.current?.applyAdjust(activeLeafId, next, d.selection, d.selectionAngle, d.selectionPivot);
  };
  const onAdjust = (patch: Partial<Adjustments>) => {
    const next = { ...adjust, ...patch };
    setAdjust(next);
    setAdjustFilter(""); // tweaking a slider clears the active filter chip
    applyLiveAdjust(next);
  };
  const onAdjustFilter = (name: string) => {
    const next = filterToAdjust(name);
    setAdjust(next);
    setAdjustFilter(name);
    applyLiveAdjust(next);
  };
  // Apply a full set of adjustment values under a label (custom saved presets).
  const onApplyPreset = (next: Adjustments, name: string) => {
    setAdjust(next);
    setAdjustFilter(name);
    applyLiveAdjust(next);
  };
  const onAdjustReset = () => {
    paintRef.current?.revertAdjust();
    setAdjust(DEFAULT_ADJUST);
    setAdjustFilter("Original");
  };
  // The engine fires onAdjustEnd when a session ends (another op / undo / switch).
  const onAdjustEnd = () => {
    setAdjust(DEFAULT_ADJUST);
    setAdjustFilter("Original");
  };
  // Convert the destructive live preview into a non-destructive adjustment layer.
  const convertPreviewToAdjustment = () => {
    const params = { ...adjust };
    paintRef.current?.revertAdjust(); // discard the preview baked on the active leaf
    setAdjust(DEFAULT_ADJUST);
    setAdjustFilter("Original");
    addAdjustmentOp("", undefined, params);
  };
  // Reset an adjustment-layer node's params to neutral (edit-mode "Reset").
  const resetAdjustmentParams = () => editAdjustmentParams(DEFAULT_ADJUST);

  // Finalize a live adjustment (destructive session + adjustment-layer param edit)
  // when switching layer or document.
  useEffect(() => {
    paintRef.current?.endAdjust();
    commitAdjustEdit();
    commitFxEdit();
    commitFilterEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.activeLayerId, activeId]);

  // Remember the most recent non-empty selection so Reselect can restore it
  // (works after any deselect — menu, Escape, or a tool clearing it).
  useEffect(() => {
    if (active.selection.length) {
      lastSelectionRef.current = {
        rects: active.selection,
        angle: active.selectionAngle,
        pivot: active.selectionPivot,
      };
    }
  }, [active.selection, active.selectionAngle, active.selectionPivot]);

  // ---- Working colour space (sRGB / Display P3 / emulated Adobe RGB), persisted ----
  useEffect(() => {
    const saved = localStorage.getItem("pe-colorspace");
    if (saved === "display-p3" && p3Supported()) setColorSpaceState("display-p3");
    else if (saved === "adobe-rgb") setColorSpaceState("adobe-rgb");
  }, []);
  const setWorkingSpace = (ws: WorkingSpace) => {
    setColorSpaceState(ws);
    try {
      localStorage.setItem("pe-colorspace", ws);
    } catch {
      /* ignore */
    }
  };
  const openColorDialog = () => setColorDialogOpen(true);

  // ---- Soft proofing (view-only) ----
  useEffect(() => {
    const saved = localStorage.getItem("pe-proof-target");
    if (saved === "srgb" || saved === "display-p3" || saved === "adobe-rgb") setProofTargetState(saved);
  }, []);
  const setProofTarget = (t: ProofTarget) => {
    setProofTargetState(t);
    try {
      localStorage.setItem("pe-proof-target", t);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    paintRef.current?.setProofing(proofColors, gamutWarn, proofTarget);
  }, [proofColors, gamutWarn, proofTarget]);
  const openCompare = () => setCompareComposite(paintRef.current?.exportComposite(active.layers) ?? null);

  // ---- Window menu: panel visibility (persisted) ----
  const persistPanels = (p: PanelVisibility) => setPanels(viewStore, p);

  // ---- Guides (View menu, ruler drags — per-document, saved in .gproj) ------
  // Colour samplers ride the same rails as guides: per-document, structural (no
  // pixels), captured by document id so an undo after a tab switch still edits
  // the document the sampler belongs to.
  const setDocSamplers = (docId: string, next: ColorSampler[]) =>
    setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, samplers: next } : d)));
  const commitSamplers = (label: string, next: ColorSampler[]) => {
    const docId = activeIdRef.current;
    const before = activeDocRef.current.samplers ?? [];
    if (before === next) return; // the sampler ops return the same array for a no-op
    setDocSamplers(docId, next);
    paintRef.current?.pushStructural(
      label,
      () => setDocSamplers(docId, before),
      () => setDocSamplers(docId, next),
    );
  };
  /** Placement/removal from the canvas (Eyedropper: shift-click, alt-click). */
  const samplerOps = useMemo(
    () => ({
      add: (x: number, y: number) => {
        const d = activeDocRef.current;
        commitSamplers("Add sampler", addSampler(d.samplers ?? [], x, y, d.width, d.height));
      },
      remove: (id: string) =>
        commitSamplers("Remove sampler", removeSampler(activeDocRef.current.samplers ?? [], id)),
      /** Live during a drag — no history until the gesture ends. */
      moveLive: (id: string, x: number, y: number) => {
        const d = activeDocRef.current;
        setDocSamplers(d.id, moveSampler(d.samplers ?? [], id, x, y, d.width, d.height));
      },
      commitMove: (before: ColorSampler[]) => {
        const docId = activeIdRef.current;
        const after = activeDocRef.current.samplers ?? [];
        if (before === after) return;
        paintRef.current?.pushStructural(
          "Move sampler",
          () => setDocSamplers(docId, before),
          () => setDocSamplers(docId, after),
        );
      },
      hit: (x: number, y: number, tol: number) =>
        samplerAt(activeDocRef.current.samplers ?? [], x, y, tol),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---- View menu: rulers / grid / snap (persisted), zoom commands ----
  useEffect(() => {
    /* The rulers' default is decided before the first paint by the inline
       script in layout.tsx too — it has to be, because the stage's size comes
       from a grid template the cold-load fit measures straight away. Once the
       stored view is in the store, the bridging attribute goes, so from here on
       `data-rulers` is the only thing deciding. */
    if (restoreView(viewStore)) delete document.documentElement.dataset.rulersDefault;
  }, [viewStore]);
  const persistView = (patch: Partial<ViewFlags>) => setViewFlags(viewStore, patch);

  // ---- Actions (macro recorder — Actions panel + F-key playback) ------------
  const [savedActions, setSavedActions] = useState<SavedAction[]>([]);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const savedActionsRef = useRef<SavedAction[]>([]);
  savedActionsRef.current = savedActions;
  const recordingIdRef = useRef<string | null>(null);
  recordingIdRef.current = recordingId;
  const playingRef = useRef(false);
  useEffect(() => setSavedActions(loadActions()), []); // client-only store
  const updateActions = (fn: (list: SavedAction[]) => SavedAction[]) =>
    setSavedActions((list) => {
      const next = fn(list);
      saveActions(next);
      return next;
    });

  // Playback dispatches through the LATEST runCommand — each step's state
  // must commit (and re-point the refs the handlers read) before the next one,
  // hence the ref + the per-step delay.
  const runCommandRef = useRef<(id: string) => boolean>(() => false);
  const playAction = async (id: string) => {
    const act = savedActionsRef.current.find((a) => a.id === id);
    if (!act || !act.steps.length || playingRef.current || recordingIdRef.current) return;
    playingRef.current = true;
    setPlayingId(id);
    try {
      for (const step of act.steps) {
        if (step.stroke) {
          // Recorded paint stroke: replay at the recorded coordinates onto the
          // CURRENT active layer, clipped to the CURRENT selection (like a
          // real stroke would be).
          const s = step.stroke;
          const d = activeDocRef.current;
          paintRef.current?.playStroke(
            ensureLayer(),
            s.tool,
            s.brush,
            s.color,
            s.points,
            d.selection.length ? d.selection : null,
            d.selectionAngle,
            d.selectionPivot,
          );
        } else if (step.action) {
          runCommandRef.current(step.action);
        }
        await new Promise((r) => setTimeout(r, PLAYBACK_STEP_MS));
      }
    } finally {
      playingRef.current = false;
      setPlayingId(null);
    }
    showToast(`Played “${act.name}” (${act.steps.length} step${act.steps.length === 1 ? "" : "s"})`);
  };
  const playActionRef = useRef(playAction);
  playActionRef.current = playAction;

  // CanvasArea reports each finished brush/pencil/eraser stroke while an
  // action is recording (never during playback — no self-appending).
  const recordStrokeStep = (s: StrokeStep) => {
    const rid = recordingIdRef.current;
    if (!rid || playingRef.current) return;
    updateActions((ls) =>
      ls.map((a) =>
        a.id === rid ? { ...a, steps: [...a.steps, { stroke: s, label: strokeStepLabel(s) }] } : a,
      ),
    );
  };

  const actionsApi: ActionsApi = {
    actions: savedActions,
    recordingId,
    playingId,
    record: (name) => {
      if (playingRef.current) return;
      const id = freshActionId();
      updateActions((ls) => [...ls, { id, name, fkey: null, steps: [] }]);
      setRecordingId(id);
    },
    stop: () => setRecordingId(null),
    play: (id) => void playAction(id),
    remove: (id) => {
      if (recordingIdRef.current === id) setRecordingId(null);
      updateActions((ls) => ls.filter((a) => a.id !== id));
    },
    rename: (id, name) => updateActions((ls) => ls.map((a) => (a.id === id ? { ...a, name } : a))),
    setFKey: (id, fkey) =>
      updateActions((ls) =>
        // One action per key: assigning steals the key from any other action.
        ls.map((a) => (a.id === id ? { ...a, fkey } : fkey && a.fkey === fkey ? { ...a, fkey: null } : a)),
      ),
    removeStep: (id, index) =>
      updateActions((ls) =>
        ls.map((a) => (a.id === id ? { ...a, steps: a.steps.filter((_, i) => i !== index) } : a)),
      ),
  };

  // ---- Paths panel (stored pen paths — Work Path + saved copies) ------------
  // ---- Layer comps --------------------------------------------------------
  // Named snapshots of layer visibility / position / appearance. The tricky half
  // is position: a layer here is a full-canvas raster with no coordinate, so a
  // comp records the layer's CONTENT BOUNDS and applying it translates pixels by
  // the origin delta — see comps.ts for why the size is the guard.
  const patchComps = (fn: (list: LayerComp[]) => LayerComp[]) =>
    patchActiveDoc((d) => ({ ...d, comps: fn(d.comps ?? []) }));
  const compBounds = (id: string) => paintRef.current?.layerContentBounds(id) ?? null;
  const compById = (id: string) => (activeDocRef.current.comps ?? []).find((c) => c.id === id);

  /** Apply a comp: the tree change AND the pixel moves as ONE history step. */
  const applyCompOp = (id: string) => {
    const comp = compById(id);
    const eng = paintRef.current;
    if (!comp || !eng) return;
    const d = activeDocRef.current;
    const res = applyComp(comp, d.layers, compBounds);
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const moved = res.moves.map((m) => m.id);
    const pixBefore = moved.length ? eng.captureLeaves(moved) : null;
    for (const m of res.moves) {
      const node = findNode(before, m.id);
      eng.offsetLayerPixels(m.id, m.dx, m.dy, node?.mask?.linked !== false);
    }
    const pixAfter = pixBefore ? eng.captureLeaves(moved) : null;
    setDocSel(docId, res.layers, sel);
    eng.pushStructural(
      `Apply Comp: ${comp.name}`,
      () => {
        if (pixBefore) eng.restoreLeaves(pixBefore);
        setDocSel(docId, before, sel);
      },
      () => {
        if (pixAfter) eng.restoreLeaves(pixAfter);
        setDocSel(docId, res.layers, sel);
      },
    );
    // Say what could NOT be restored. Silence here would be the worst outcome:
    // the comp would look applied while a layer sat in the wrong place.
    const notes: string[] = [];
    if (res.skipped.length)
      notes.push(
        `${res.skipped.length} layer${res.skipped.length > 1 ? "s" : ""} changed since capture — position kept`,
      );
    if (res.unknown.length) notes.push(`${res.unknown.length} newer, left alone`);
    if (res.missing.length) notes.push(`${res.missing.length} gone`);
    showToast(notes.length ? `${comp.name} — ${notes.join("; ")}` : comp.name);
  };

  const compsApi: CompsApi = {
    comps: active.comps ?? [],
    currentId:
      (active.comps ?? []).find((c) => compIsCurrent(c, active.layers, compBounds))?.id ?? null,
    create: (capture) =>
      patchComps((list) => [
        ...list,
        {
          ...captureComp(
            uniqueCompName(list, `Layer Comp ${list.length + 1}`),
            capture,
            activeDocRef.current.layers,
            compBounds,
          ),
        },
      ]),
    apply: applyCompOp,
    update: (id) =>
      patchComps((list) =>
        list.map((c) =>
          c.id === id
            ? { ...captureComp(c.name, c.capture, activeDocRef.current.layers, compBounds), id: c.id }
            : c,
        ),
      ),
    rename: (id, name) =>
      patchComps((list) =>
        list.map((c) =>
          c.id === id ? { ...c, name: uniqueCompName(list.filter((x) => x.id !== id), name) } : c,
        ),
      ),
    // Changing what a comp records RE-CAPTURES it from the document rather than
    // just widening the list: a comp that never recorded position has no bounds
    // to restore, so ticking P would otherwise produce a comp that claims to
    // record a position it does not have.
    setCapture: (id, capture) =>
      patchComps((list) =>
        list.map((c) =>
          c.id === id
            ? { ...captureComp(c.name, capture, activeDocRef.current.layers, compBounds), id: c.id }
            : c,
        ),
      ),
    duplicate: (id) =>
      patchComps((list) => {
        const c = list.find((x) => x.id === id);
        if (!c) return list;
        const copy = { ...structuredClone(c), id: freshCompId(), name: uniqueCompName(list, c.name) };
        const at = list.findIndex((x) => x.id === id);
        return [...list.slice(0, at + 1), copy, ...list.slice(at + 1)];
      }),
    remove: (id) => patchComps((list) => list.filter((c) => c.id !== id)),
  };

  const patchPaths = (fn: (list: SavedPath[]) => SavedPath[]) =>
    patchActiveDoc((d) => ({ ...d, paths: fn(d.paths ?? []) }));
  /** Every pen commit lands here (CanvasArea onPenPathCommit): the Photoshop-
   *  style Work Path — replaced each time, Save duplicates it to keep it. */
  const storeWorkPath = (anchors: PenAnchor[], closed: boolean) =>
    patchPaths((list) => [
      { id: WORK_PATH_ID, name: "Work Path", anchors: cloneAnchors(anchors), closed },
      ...list.filter((x) => x.id !== WORK_PATH_ID),
    ]);
  const pathById = (id: string) => (activeDocRef.current.paths ?? []).find((x) => x.id === id);
  /** Rasterize a path to selection rects via the lasso pipeline (open paths
   *  close with a straight chord, exactly like the lasso's auto-close). */
  const pathRegion = (p: SavedPath) => {
    const poly = samplePathPolygon(p.anchors, p.closed);
    return poly.length >= 3 ? (paintRef.current?.lassoSelect(poly) ?? null) : null;
  };

  // ---- Saved selections (alpha channels, TODO §3) --------------------------
  //
  // The raster is an ordinary engine mask under a reserved key, so saving is
  // allocMask("selection") and loading is maskSelectionRects() — the same two
  // calls the quick mask and "Load mask as selection" already use.

  /**
   * Fill the selection with a repeating tile — or the whole layer when there is
   * no selection, which is what "fill" means with nothing selected everywhere
   * else in the app.
   */
  const fillWithPattern = (r: PatternFillResult) => {
    setPatternFill(false);
    const eng = paintRef.current;
    if (!eng) return;
    const d = activeDocRef.current;
    const rects = selRef.current.length
      ? selRef.current
      : [{ x: 0, y: 0, w: d.width, h: d.height }];
    eng.fillSelection(
      ensureLayer(),
      rects,
      { tile: r.tile, width: r.width, height: r.height, placement: r.placement },
      selRef.current.length ? d.selectionAngle : 0,
      selRef.current.length ? d.selectionPivot : null,
    );
  };

  /* Developing a RAW is a QUESTION, and a question needs somewhere to put the
     answer. `imageio` cannot import a dialog — it runs in the worker too — so
     it asks through a registry, and this holds the asking open until the person
     answers. The promise's `resolve` is the whole state: no dialog is mounted
     unless a RAW is waiting on one. */
  useEffect(
    () =>
      registerRawDeveloper(
        (session, name) =>
          new Promise<RawDevelopOptions | null>((resolve) =>
            setRawAsk({ session, name, resolve }),
          ),
      ),
    [setRawAsk],
  );
  const channelsOf = (): SavedChannel[] => activeDocRef.current.channels ?? [];
  const setChannels = (docId: string, next: SavedChannel[]) =>
    setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, channels: next } : d)));

  const saveSelectionOp = (rawName: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return;
    if (!d.selection.length) {
      showToast("Make a selection first — there is nothing to save.");
      return;
    }
    const list = channelsOf();
    const id = freshChannelId(list);
    const name = cleanChannelName(rawName, list);
    const key = selectionChannelKey(d.id, id);
    eng.allocMask(key, "selection", d.selection, d.selectionAngle, d.selectionPivot);
    const before = list;
    const after = [...list, { id, name }];
    setChannels(d.id, after);
    // The raster is deliberately NOT freed on undo: redo would then have to
    // re-render it from a selection that may no longer exist. Keeping it costs
    // one grayscale canvas and makes both directions exact.
    eng.pushStructural(
      `Save Selection: ${name}`,
      () => setChannels(d.id, before),
      () => setChannels(d.id, after),
    );
    showToast(`Saved selection “${name}”.`);
  };

  const loadSelectionOp = (channelId: string, op: ChannelSelectOp) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const ch = channelsOf().find((c) => c.id === channelId);
    if (!eng || !ch) return;
    const rects = eng.maskSelectionRects(selectionChannelKey(d.id, ch.id));
    if (!rects.length) {
      showToast(`“${ch.name}” is empty.`);
      return;
    }
    const cur = d.selection;
    if (op === "new" || !cur.length) {
      commitSelection(loadLabel(ch.name, "new"), rects);
      return;
    }
    // Either side soft (a saved feathered channel, a Quick Mask selection) →
    // combine coverage, not just outlines. Null for two hard sides: the
    // existing paths below, unchanged.
    const soft = d.selectionAngle ? null : eng.combineSelectionSoft(cur, rects, op);
    if (soft) {
      commitSelection(loadLabel(ch.name, op), soft);
      return;
    }
    if (op === "add" || op === "subtract") {
      const combined = eng.combineSelection(cur, rects, op);
      commitSelection(loadLabel(ch.name, op), combined?.rects ?? []);
      return;
    }
    // intersect: A ∩ B = A − (A − B), built from subtract (same as the Paths panel).
    const aMinusB = eng.combineSelection(cur, rects, "subtract");
    const inter = eng.combineSelection(cur, aMinusB?.rects ?? [], "subtract");
    commitSelection(loadLabel(ch.name, "intersect"), inter?.rects ?? []);
  };

  const renameChannelOp = (id: string, name: string) => {
    const d = activeDocRef.current;
    const before = channelsOf();
    const after = renameChannel(before, id, name);
    if (after === before) return;
    setChannels(d.id, after);
    paintRef.current?.pushStructural(
      "Rename Channel",
      () => setChannels(d.id, before),
      () => setChannels(d.id, after),
    );
  };

  const deleteChannelOp = (id: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const before = channelsOf();
    const after = removeChannel(before, id);
    if (after.length === before.length) return;
    setChannels(d.id, after);
    // Same reasoning as save: the raster stays so undo restores a real channel
    // rather than an empty one. It is dropped when the document closes.
    eng?.pushStructural(
      "Delete Channel",
      () => setChannels(d.id, before),
      () => setChannels(d.id, after),
    );
  };

  const pathsApi: PathsApi = {
    paths: active.paths ?? [],
    toSelection: (id, op: PathSelectOp) => {
      const p = pathById(id);
      const eng = paintRef.current;
      if (!p || !eng) return;
      const sel = pathRegion(p);
      if (!sel || !sel.rects.length) {
        showToast("The path encloses no area.");
        return;
      }
      const cur = activeDocRef.current.selection;
      if (op === "new" || !cur.length) {
        commitSelection("Path to Selection", sel.rects);
      } else if (op === "add" || op === "subtract") {
        const combined = eng.combineSelection(cur, sel.rects, op);
        commitSelection(
          op === "add" ? "Add Path to Selection" : "Subtract Path from Selection",
          combined?.rects ?? [],
        );
      } else {
        // intersect: A ∩ B = A − (A − B), built from the existing subtract.
        const aMinusB = eng.combineSelection(cur, sel.rects, "subtract");
        const inter = eng.combineSelection(cur, aMinusB?.rects ?? [], "subtract");
        commitSelection("Intersect Path with Selection", inter?.rects ?? []);
      }
    },
    stroke: (id) => {
      const p = pathById(id);
      if (!p || !paintRef.current) return;
      paintRef.current.strokePath(ensureLayer(), cloneAnchors(p.anchors), p.closed, pen, paintColor);
    },
    fill: (id) => {
      const p = pathById(id);
      const eng = paintRef.current;
      if (!p || !eng) return;
      const sel = pathRegion(p);
      if (!sel || !sel.rects.length) {
        showToast("The path encloses no area.");
        return;
      }
      eng.fillSelection(ensureLayer(), sel.rects, paintColor);
    },
    edit: (id) => {
      const p = pathById(id);
      if (!p) return;
      // Direct Selection rather than the Pen: the pen's primary click means
      // "add a point at the end", which is the wrong verb for editing an
      // existing path. Committing writes back to THIS path (see `replace`)
      // instead of spawning a fresh Work Path.
      setTool("directselect");
      viewApiRef.current?.loadPenPath(cloneAnchors(p.anchors), p.closed, id);
    },
    replace: (id, anchors, closed) =>
      patchPaths((list) =>
        list.map((x) => (x.id === id ? { ...x, anchors: cloneAnchors(anchors), closed } : x)),
      ),
    save: (id) => {
      const p = pathById(id);
      if (!p) return;
      const named = (activeDocRef.current.paths ?? []).filter((x) => x.id !== WORK_PATH_ID);
      patchPaths((list) => [
        ...list,
        { id: freshPathId(), name: `Path ${named.length + 1}`, anchors: cloneAnchors(p.anchors), closed: p.closed },
      ]);
    },
    rename: (id, name) => patchPaths((list) => list.map((x) => (x.id === id ? { ...x, name } : x))),
    remove: (id) => patchPaths((list) => list.filter((x) => x.id !== id)),
  };

  // The workspace's own toggles: dialogs and the tour, zoom, the view flags,
  // compare, proof, gamut, the HUD, the panels (commands/workspace.ts).
  const workspace = workspaceOps({
    dialogs: dialogStore,
    view: viewStore,
    viewApiRef,
    dockRef,
    setTour,
    setCompareSplit,
    setCompareAxis,
    setProofColors,
    setGamutWarn,
    setPerfHud,
  });

  /* The commands' view of the editor (TODO 1.1). WHICH operation a command
     performs, and whether it applies right now, live in commands/registry.ts;
     the operations themselves in the families beside it (TODO 1.10) — this
     names them. */
  /** Run `fn` on the active layer, if there is one. */
  const onActiveLayer = (fn: (id: string) => void) => {
    const id = activeDocRef.current.activeLayerId;
    if (id) fn(id);
  };
  const commandOps: CommandOps = {
    toast: (message) => showToast(message),
    open: workspace.open,
    newDoc: () => requestNewDoc(),
    openProject: () => openProject(),
    save: () => saveProject(),
    closeActiveDoc: () => closeDoc(activeId),
    openImport: () => openImport(),
    openExport: () => openExport(),
    exportSVG: () => exportVectorSVG(),
    exportFrames: () => void exportFrames(),
    exportPSD: () => exportPSD(),
    print: () => printCanvas(),
    openSample: () => openSampleDoc(),
    openPrefs: (section) => openPrefs(section),
    openColorManagement: () => openColorDialog(),
    openCompareProfiles: () => openCompare(),
    undo: () => doUndo(),
    redo: () => doRedo(),
    cut: () => cutSelection(),
    copy: () => copySelection(),
    paste: () => pasteFromClipboard(),
    contentAwareFill: () => contentAwareFillOp(),
    sizeDialog: (mode) => openSizeDialog(mode),
    cropToSelection: () => cropToSelection(),
    transformImage: (kind) => applyImageTransform(kind),
    freeTransform: (content) => enterTransform(content),
    destructiveTone: (tool) => openDestructiveTone(tool),
    selectAll: () => selectAll(),
    deselect: () => deselect(),
    reselect: () => reselect(),
    invertSelection: () => invertSelection(),
    refineEdge: () => openRefineEdge(),
    modifySelection: (kind) => setSelectModify(kind),
    selectionChannel: (mode) => setChannelDialog(mode),
    toggleQuickMask: () => toggleQuickMask(),
    newLayer: () => addLayerOp(),
    newFill: (kind) => addFillOp(kind),
    duplicateLayers: () => duplicateSelected(),
    deleteLayers: () => removeSelected(),
    groupLayers: () => groupSelected(),
    ungroupActive: () => onActiveLayer(ungroupLayerOp),
    frameFromActive: () => onActiveLayer(frameFromLayerOp),
    toggleIsolate: () => toggleIsolate(),
    mergeLayers: () => mergeSelected(),
    mergeVisible: () => mergeVisibleOp(),
    stampVisible: () => stampVisibleOp(),
    flatten: () => flattenImage(),
    toggleClippingMask: () => toggleClippingMask(),
    addMask: (init) => addMaskOp(init),
    deleteMask: () => removeMaskOp(),
    applyMask: () => applyMaskOp(),
    maskToSelection: () => loadMaskAsSelectionOp(),
    addVectorMask: () => addVectorMask(),
    invertVectorMask: () => invertVectorMask(),
    deleteVectorMask: () => deleteVectorMask(),
    textOnPath: (attach) => setTextPath(attach),
    openLayerStyle: () => onActiveLayer(openLayerStyleOp),
    clearLayerStyle: () => onActiveLayer(clearLayerStyleOp),
    addEffect: (key) => addEffectOp(key),
    openSmartFilters: () => onActiveLayer(openFiltersOp),
    addFilter: (type) => addFilterOp(type),
    addToneAdjustment: (tool) => addToneAdjustment(tool),
    addAdjustment: (type) => addAdjustmentOp(type),
    addExtraAdjustment: (type) => addExtraAdjustment(type),
    openBlurGallery: () => openBlurFx(),
    openLiquify: () => openLiquify(),
    openWarp: () => openWarp(),
    zoom: workspace.zoom,
    toggleView: workspace.toggleView,
    clearGuides: () => commitGuides("Clear Guides", []),
    toggleCompare: workspace.toggleCompare,
    toggleCompareAxis: workspace.toggleCompareAxis,
    toggleProof: workspace.toggleProof,
    toggleGamut: workspace.toggleGamut,
    togglePerfHud: workspace.togglePerfHud,
    togglePanel: workspace.togglePanel,
    resetWorkspace: workspace.resetWorkspace,
  };
  /** What decides whether a command applies — read fresh each time it's asked. */
  const currentCommandState = () =>
    commandState({
      doc: activeDocRef.current,
      docCount: docs.length,
      historyBack: history.index > 0,
      historyForward: history.index < history.items.length - 1,
      floating: !!paintRef.current?.isFloating(),
      openEdit: history.open,
      lastSelection: !!lastSelectionRef.current?.rects.length,
      isolated: isolatedIds !== null,
      comparing: compareSplit !== null,
    });
  /** The commands that do not apply now, with why — what the menus and the
   *  palette grey out. Asked when they render, so it is never stale. */
  const blockedCommands = () => unavailableCommands(currentCommandState());

  /** Run a command by id. The menus, the palette, shortcuts, action playback and
   *  scripts all arrive here with a plain string (recorded steps come back from
   *  storage), so this is the gate: an unknown id says so, and a command that
   *  does not apply now does nothing — saying why, unless its reason is quiet.
   *  Returns whether it ran. */
  const runCommand = (id: string): boolean => {
    if (!isCommandId(id)) {
      console.warn(`Unknown command "${id}"`);
      return false;
    }
    if (!executeCommand(id, currentCommandState(), commandOps)) return false;
    // Recording: log replay-safe commands into the armed action (never while
    // playing back — a played action must not append to itself).
    if (recordingIdRef.current && !playingRef.current && isRecordable(id)) {
      const rid = recordingIdRef.current;
      updateActions((ls) =>
        ls.map((a) => (a.id === rid ? { ...a, steps: [...a.steps, { action: id, label: actionLabel(id) }] } : a)),
      );
    }
    return true;
  };
  runCommandRef.current = runCommand;

  const swapColors = () => {
    const f = fgRef.current;
    setForeground(bgRef.current);
    setBackground(f);
  };

  // Paste images from the clipboard (Ctrl+V fires a native paste event).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      let blob: Blob | null = null;
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            blob = items[i].getAsFile();
            break;
          }
        }
      }
      if (blob) {
        e.preventDefault();
        createImageBitmap(blob)
          .then((bmp) => placePaste(bmp, bmp.width, bmp.height))
          .catch(() => {});
      } else if (clipboardRef.current) {
        e.preventDefault();
        const c = clipboardRef.current;
        placePaste(c, c.width, c.height);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore only while typing into a text field (not sliders/selects/etc.).
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.isContentEditable ||
          t.tagName === "TEXTAREA" ||
          (t.tagName === "INPUT" &&
            /^(?:text|number|search|email|url|password|tel|)$/i.test((t as HTMLInputElement).type)));
      if (typing) return;

      // Actions panel F-key playback (F2–F10, unmodified — F1/F5/F11/F12 stay
      // with the browser and are never assignable).
      if (/^F[2-9]$|^F10$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const act = savedActionsRef.current.find((a) => a.fkey === e.key);
        if (act) {
          e.preventDefault();
          void playActionRef.current(act.id);
          return;
        }
      }

      // Match the produced character (e.key), not the physical position (e.code),
      // so letter shortcuts are correct on QWERTZ/AZERTY etc. (Z/Y aren't swapped).
      const key = e.key.toLowerCase();

      // Crop tool: Enter / Esc commit or reset, arrows nudge the box, plus a few
      // quick toggles. Handled first so they don't fall through to other bindings.
      if (toolRef.current === "crop" && cropBoxRef.current && !e.ctrlKey && !e.metaKey) {
        if (e.key === "Enter") {
          e.preventDefault();
          applyCropNow();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          resetCropBox();
          return;
        }
        if (e.key.startsWith("Arrow")) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          const d = activeDocRef.current;
          const clamp = cropSettingsRef.current.straighten === 0;
          setCropBox((b) =>
            b
              ? {
                  ...b,
                  x: clamp ? Math.max(0, Math.min(d.width - b.w, b.x + dx)) : b.x + dx,
                  y: clamp ? Math.max(0, Math.min(d.height - b.h, b.y + dy)) : b.y + dy,
                }
              : b,
          );
          return;
        }
      }

      // The painting tools the Shortcuts dialog lists under "Brush-style tools"
      // that never had them: [ / ] size, { / } hardness (not the pencil, which
      // is always hard), and on the brush, eraser and pencil a digit sets
      // opacity, as in Photoshop.
      const bk = !e.ctrlKey && !e.metaKey && !e.altKey ? brushKey(e.key) : null;
      const painting = toolRef.current;
      const opacityTool = painting === "brush" || painting === "eraser" || painting === "pencil";
      if (bk && (opacityTool || (bk.kind !== "percent" && ["mixer", "heal", "redeye"].includes(painting)))) {
        type Sized = { size: number; hardness?: number };
        const step = <S extends Sized>(s: S, min = 1, max = 500): S =>
          bk.kind === "size"
            ? { ...s, size: stepSize(s.size, bk.dir, min, max) }
            : bk.kind === "hardness" && s.hardness !== undefined && painting !== "pencil"
              ? { ...s, hardness: stepHardness(s.hardness, bk.dir) }
              : s;
        const brushStep = (s: BrushSettings): BrushSettings =>
          bk.kind === "percent" ? { ...s, opacity: bk.value } : step(s);
        if (painting === "brush") setBrush(brushStep);
        else if (painting === "eraser") setEraser(brushStep);
        else if (painting === "pencil") setPencil(brushStep);
        else if (painting === "mixer") setMixer((s) => step(s));
        else if (painting === "heal") setHeal((s) => step(s, 4, 300));
        else setRedEye((s) => step(s, 6, 200));
        e.preventDefault();
        return;
      }

      // Quick-select shortcuts: [ / ] brush size, digits = tolerance.
      if (toolRef.current === "quickselect" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
          setQuickSelect((s) => {
            const stepPx = Math.max(1, Math.round(s.size * 0.1));
            return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
          });
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          setQuickSelect((s) => ({ ...s, tolerance: n === 0 ? 100 : n * 10 }));
          return;
        }
      }

      // Blur (focus) brush shortcuts: [ / ] size, { / } hardness, digits = strength.
      if (toolRef.current === "blur" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
          setBlur((s) => {
            const stepPx = Math.max(1, Math.round(s.size * 0.1));
            return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
          });
          return;
        }
        if (e.key === "{" || e.key === "}") {
          e.preventDefault();
          const dir = e.key === "}" ? 1 : -1;
          setBlur((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          setBlur((s) => ({ ...s, strength: n === 0 ? 100 : n * 10 }));
          return;
        }
      }

      // Smudge shortcuts: [ / ] size, { / } hardness, digits = strength.
      if (toolRef.current === "smudge" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
          setSmudge((s) => {
            const stepPx = Math.max(1, Math.round(s.size * 0.1));
            return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
          });
          return;
        }
        if (e.key === "{" || e.key === "}") {
          e.preventDefault();
          const dir = e.key === "}" ? 1 : -1;
          setSmudge((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          setSmudge((s) => ({ ...s, strength: n === 0 ? 100 : n * 10 }));
          return;
        }
      }

      // History-brush shortcuts: [ / ] size, { / } hardness, digits = opacity.
      if (toolRef.current === "history" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
          setHistoryBrush((s) => {
            const stepPx = Math.max(1, Math.round(s.size * 0.1));
            return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
          });
          return;
        }
        if (e.key === "{" || e.key === "}") {
          e.preventDefault();
          const dir = e.key === "}" ? 1 : -1;
          setHistoryBrush((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          setHistoryBrush((s) => ({ ...s, opacity: n === 0 ? 100 : n * 10 }));
          return;
        }
      }

      // Clone-stamp shortcuts: [ / ] size, { / } hardness, digits = opacity.
      if (toolRef.current === "clone" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const dir = e.key === "]" ? 1 : -1;
          setClone((s) => {
            const stepPx = Math.max(1, Math.round(s.size * 0.1));
            return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
          });
          return;
        }
        if (e.key === "{" || e.key === "}") {
          e.preventDefault();
          const dir = e.key === "}" ? 1 : -1;
          setClone((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
          return;
        }
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          setClone((s) => ({ ...s, opacity: n === 0 ? 100 : n * 10 }));
          return;
        }
      }

      // Dodge/Burn shortcuts: Shift+O toggles dodge↔burn, [ / ] size,
      // { / } hardness, digits = exposure.
      if (toolRef.current === "dodge" && !e.ctrlKey && !e.metaKey) {
        if (e.shiftKey && key === "o") {
          e.preventDefault();
          setDodge((s) => ({ ...s, mode: s.mode === "dodge" ? "burn" : "dodge" }));
          return;
        }
        if (!e.altKey) {
          if (e.key === "[" || e.key === "]") {
            e.preventDefault();
            const dir = e.key === "]" ? 1 : -1;
            setDodge((s) => {
              const stepPx = Math.max(1, Math.round(s.size * 0.1));
              return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
            });
            return;
          }
          if (e.key === "{" || e.key === "}") {
            e.preventDefault();
            const dir = e.key === "}" ? 1 : -1;
            setDodge((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
            return;
          }
          if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            const n = parseInt(e.key, 10);
            setDodge((s) => ({ ...s, exposure: n === 0 ? 100 : n * 10 }));
            return;
          }
        }
      }

      // Sponge shortcuts: Shift+A toggles saturate↔desaturate, [ / ] size,
      // { / } hardness, digits = flow.
      if (toolRef.current === "sponge" && !e.ctrlKey && !e.metaKey) {
        if (e.shiftKey && key === "a") {
          e.preventDefault();
          setSponge((s) => ({ ...s, mode: s.mode === "saturate" ? "desaturate" : "saturate" }));
          return;
        }
        if (!e.altKey) {
          if (e.key === "[" || e.key === "]") {
            e.preventDefault();
            const dir = e.key === "]" ? 1 : -1;
            setSponge((s) => {
              const stepPx = Math.max(1, Math.round(s.size * 0.1));
              return { ...s, size: Math.max(1, Math.min(500, s.size + dir * stepPx)) };
            });
            return;
          }
          if (e.key === "{" || e.key === "}") {
            e.preventDefault();
            const dir = e.key === "}" ? 1 : -1;
            setSponge((s) => ({ ...s, hardness: Math.max(0, Math.min(100, s.hardness + dir * 10)) }));
            return;
          }
          if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            const n = parseInt(e.key, 10);
            setSponge((s) => ({ ...s, flow: n === 0 ? 100 : n * 10 }));
            return;
          }
        }
      }

      // Registry dispatch: every menu / tool / command shortcut resolves
      // through the ONE registry (defaults from menus.ts + tools.ts, plus the
      // user's remaps) — so remapping really re-routes, unbinding really
      // disables, and menu shortcut labels can never lie about the handler.
      const binding = eventToBinding(e);
      if (binding) {
        const hits = shortcutIndexRef.current.get(canonicalBinding(binding));
        if (hits) {
          for (const d of hits) {
            // Copy/cut fall through without a selection so the browser's own
            // text copy keeps working outside the canvas (old behaviour).
            if ((d.id === "menu:edit-copy" || d.id === "menu:edit-cut") && !selRef.current.length)
              continue;
            e.preventDefault();
            if (d.id.startsWith("tool:")) setTool(d.id.slice(5) as ToolId);
            else if (d.id === "cmd:swap-colors") swapColors();
            else runCommandRef.current(d.id.slice(5));
            return;
          }
        }
      }

      if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "n") {
        // Legacy nicety kept OUTSIDE the registry: browsers reserve Ctrl+N, so
        // the registered binding is Ctrl+Alt+N — but where a plain Ctrl+N does
        // reach us (e.g. a PWA window), honour it too.
        e.preventDefault();
        requestNewDoc();
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === "y") {
        // Legacy redo alias (the registered binding is Ctrl+Shift+Z).
        e.preventDefault();
        doRedo();
      } else if (e.code === "Escape") {
        /* The touch shells' drawers and sheets stand in front of everything
           else, so Escape closes the topmost one before it touches the
           document.

           MEASURED, by tools/mobile.js: open the mobile tools drawer, press
           Escape, and the drawer stayed open with its scrim over the canvas —
           after which the document could not be painted on at all, and nothing
           on screen said why. Tapping Tools again, or tapping the canvas,
           closed it correctly; only the keyboard route was dead. The back
           gesture has consumed this stack since it was written, and Escape is
           the same intent from a keyboard, so it consumes it too. */
        if (dismissTop()) {
          e.preventDefault();
        } else if (escapeForOverlayRef.current) {
          /* This Escape closed a popover, dropdown, menu or dialog (see
             onKeyCapture). It used to reach here as well and deselect on the
             same keystroke: tweak a colour, press Escape to close the picker,
             lose the selection. */
        } else if (paintRef.current?.isFloating()) {
          e.preventDefault();
          paintRef.current.commitFloat();
          deselect();
        } else if (selRef.current.length) {
          // Journalled like Select ▸ Deselect, so Ctrl+Z and Reselect bring it
          // back. It used to clear the selection outright, with no way back.
          e.preventDefault();
          deselect();
        }
      } else if (e.key === "Enter" && paintRef.current?.isFloating()) {
        // Commit an in-progress transform (the floated, scaled/rotated content).
        // The selection it leaves goes as an undoable Deselect, not outright.
        e.preventDefault();
        paintRef.current.commitFloat();
        deselect();
      } else if (e.code === "Delete") {
        if (selRef.current.length && activeLayerRef.current) {
          e.preventDefault();
          commitFloatIfAny();
          const d = activeDocRef.current;
          paintRef.current?.eraseSelection(
            activeLayerRef.current,
            selRef.current,
            d.selectionAngle,
            d.selectionPivot,
            "Delete",
          );
        }
      } else if (e.code === "Backspace") {
        if (selRef.current.length) {
          e.preventDefault();
          commitFloatIfAny();
          const d = activeDocRef.current;
          const fill = activeSlotRef.current === "primary" ? fgRef.current : bgRef.current;
          paintRef.current?.fillSelection(
            ensureLayer(),
            selRef.current,
            fill,
            d.selectionAngle,
            d.selectionPivot,
          );
        }
      } else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") {
        // Shift+L cycles the lasso variant (freehand → polygonal → magnetic).
        e.preventDefault();
        setTool("lasso");
        const cur = lassoModeRef.current;
        const next = cur === "free" ? "poly" : cur === "poly" ? "magnetic" : "free";
        setLassoMode(next);
        showToast(
          next === "free" ? "Freehand lasso" : next === "poly" ? "Polygonal lasso" : "Magnetic lasso",
        );
      } else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "m") {
        // Shift+M cycles the marquee shape (rectangle → ellipse → triangle), à la
        // Photoshop, switching to the marquee tool so the change is visible.
        e.preventDefault();
        setTool("select");
        const cur = marqueeShapeRef.current;
        const next = cur === "rect" ? "ellipse" : cur === "ellipse" ? "triangle" : "rect";
        setMarqueeShape(next);
        showToast(
          next === "rect"
            ? "Rectangular marquee"
            : next === "ellipse"
              ? "Elliptical marquee"
              : "Triangular marquee",
        );
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        // Shifted tool letters reach the tools bound to the bare letter — the
        // registry pass above requires exact modifiers, and the Shift+L/M cycles
        // just had their chance. Where SEVERAL tools share a letter (Magic wand
        // + Quick selection on W, Bucket + Gradient on G, Eyedropper + Measure
        // on I) Shift+letter CYCLES through them the way Photoshop does — which
        // is the only way the second tool of a pair is reachable at all, since
        // the bare letter always fires the first one.
        const bare = canonicalBinding({ ctrl: false, alt: false, shift: false, key: e.key.toLowerCase() });
        const group = shortcutIndexRef.current.get(bare)?.filter((d) => d.id.startsWith("tool:")) ?? [];
        if (group.length) {
          e.preventDefault();
          // No current member selected ⇒ index -1 ⇒ wraps to the first.
          const at = group.findIndex((d) => d.id.slice(5) === toolRef.current);
          const next = group[(at + 1) % group.length];
          setTool(next.id.slice(5) as ToolId);
          if (group.length > 1) showToast(next.label);
        }
      }
    };
    /* Was an overlay open when Escape was PRESSED? Asked in the capture phase,
       before any of them has run: ~80 popovers, dropdowns, menus and dialogs
       close on Escape from their own listeners, and React flushes that close in
       the microtask checkpoint BETWEEN listeners — so by the time onKeyDown runs
       the overlay is already gone from the DOM, and asking there finds nothing
       (measured: 0 overlays, after the dropdown had been open). */
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.code === "Escape") escapeForOverlayRef.current = !!document.querySelector(OVERLAY_SELECTOR);
    };
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keydown", onKeyDown);
    // A selection-tool gesture ends with the pointer or key that drove it.
    // Bubble phase: the canvas's own handlers have applied the change by then.
    const endGesture = () => flushToolSelectionRef.current();
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("keyup", endGesture);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("keyup", endGesture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active tool's brush dynamics (brush / pencil / eraser are independent).
  const setActiveBrush = toolStore.setter(brushOf(tool));

  /** On-canvas brush HUD (Alt + right-drag on the canvas): write the dragged
   *  size/hardness back to whichever tool is active. These are tool OPTIONS —
   *  the same values the options-bar sliders hold — so this deliberately adds
   *  no history step, exactly as dragging those sliders adds none. `hardness`
   *  is null for the tools that have no soft edge (see brush-hud.ts). */
  const setBrushHud = (size: number, hardness: number | null) => {
    const patch = <T extends { size: number }>(s: T): T =>
      hardness === null ? { ...s, size } : { ...s, size, hardness };
    switch (tool) {
      case "brush":
      case "pencil":
      case "eraser":
        setActiveBrush(patch);
        break;
      case "heal":
        setHeal(patch);
        break;
      case "clone":
        setClone(patch);
        break;
      case "blur":
        setBlur(patch);
        break;
      case "smudge":
        setSmudge(patch);
        break;
      case "mixer":
        setMixer(patch);
        break;
      case "dodge":
        setDodge(patch);
        break;
      case "sponge":
        setSponge(patch);
        break;
      case "history":
        setHistoryBrush(patch);
        break;
      case "quickselect":
        setQuickSelect((s) => ({ ...s, size }));
        break;
      case "redeye":
        setRedEye((s) => ({ ...s, size }));
        break;
    }
  };

  // ---- Scripting hook (§14): window.graphiq for the dev console ------------
  // The API object installs once; every call reads this ref, which re-points
  // at fresh render-scope functions/state each render — console snippets
  // always see the live editor. Everything routes through the same journaled
  // paths as the UI (menu dispatch, LayersApi, action playback, compositor).
  const scriptDepsRef = useRef<ScriptingDeps | null>(null);
  useEffect(() => {
    window.graphiq = buildScriptingApi(scriptDepsRef);
    console.info("Graphiq scripting hook ready — try graphiq.help() in this console.");
    return () => {
      delete window.graphiq;
    };
  }, []);
  scriptDepsRef.current = {
    docs,
    activeId,
    setActiveId,
    runCommand,
    layersApi,
    foreground,
    setForeground,
    setSelection,
    savedActions,
    playAction,
    engineRef: paintRef,
    activeLayers: active.layers,
  };

  return (
    <EditorStoresProvider value={stores}>
    <div className={styles.app} data-app>
      {/* Focus management for every modal dialog (see DialogFocus). */}
      <DialogFocus />
      <TopBar
        mobile={mobile}
        tablet={tablet}
        panelsOpen={tablet && mobileDrawer === "panels"}
        onTogglePanels={() => toggleMobileDrawer("panels")}
        onSelectDoc={(id) => {
          commitFloatIfAny();
          setActiveId(id);
        }}
        saved={saveState.ok}
        onMenuAction={runCommand}
        onSelectTool={setTool}
        shortcutLabels={shortcutLabels}
        initialTheme={initialTheme}
        blocked={blockedCommands}
        checks={{
          "window-color": panels.color,
          "window-swatches": panels.swatches,
          "window-brushes": panels.brushes,
          "window-adjustments": panels.adjustments,
          "window-properties": panels.properties,
          "window-layers": panels.layers,
          "window-paths": panels.paths,
          "window-comps": panels.comps,
          "window-history": panels.history,
          "window-actions": panels.actions,
          "window-navigator": panels.navigator,
          "window-channels": panels.channels,
          "window-metadata": panels.metadata,
          "window-info": panels.info,
          "view-rulers": showRulers,
          "view-grid": showGrid,
          "view-docgrid": showDocGrid,
          "view-proof": proofColors,
          "view-gamut": gamutWarn,
          "view-snap": snap,
          "view-compare": compareSplit !== null,
          "view-compare-axis": compareAxis === "horizontal",
          "view-guides": showGuides,
          "view-lock-guides": lockGuides,
          "view-smart-guides": smartGuides,
          "view-perf-hud": perfHud,
          "layer-clip": !!activeLeafNode?.clipped,
          "select-quickmask": quickMask,
        }}
      />
      <OptionsBar
          mobile={mobile}
        tool={tool}
        paintSurface={paintSurface}
        quickMask={quickMask}
        onExitQuickMask={toggleQuickMask}
        onExitMaskEdit={() => {
          const id = activeDocRef.current.activeLayerId;
          if (id) chooseSurface(id, "pixels");
        }}
        selBox={selNumericBox}
        onSelBox={applySelBox}
        frameFit={activeFrameFit}
        onFrameFit={setActiveFrameFit}
        frameSelected={!!activeFrameNode}
        frameHasContent={frameHasContent}
        frameScale={activeFrameNode?.frame?.scale ?? 1}
        onFrameScale={setActiveFrameScale}
        onFrameNudge={nudgeActiveFrameContent}
        onFrameReset={resetActiveFrameContent}
        onCleanMixer={() => {
          paintRef.current?.cleanMixer();
          showToast("Brush cleaned.");
        }}
        onAlign={(mode) => alignLayersOp(mode, alignToCanvas)}
        onDistribute={distributeLayersOp}
        onText={(patch) => {
          // With a live text selection, character-level changes style the
          // SELECTED range (rich runs); otherwise they set the block/base style.
          if (viewApiRef.current?.applyTextStyle(patch)) return;
          setTextSettings((t) => ({ ...t, ...patch }));
        }}
        cropBox={cropBox}
        onCropBox={setCropBox}
        onCropApply={applyCropNow}
        onCropReset={resetCropBox}
        docWidth={active.width}
        docHeight={active.height}
        measure={measure}
        onMeasureClear={() => setMeasure(null)}
        onStraighten={straightenFromMeasure}
      />
      <div className={styles.body}>
        <Toolbar
          mobile={mobile}
          parked={mobile && mobileDrawer !== "tools"}
          tool={tool}
          onToolChange={(id) => {
            setTool(id);
            if (mobile) setMobileDrawer(null); // picking a tool closes the drawer
          }}
        />
        <div className={styles.leftDock} ref={setLeftHost} aria-label="Left dock" />
        <CanvasArea
          panMode={mobile && panMode}
          statusHost={!mobile && !tablet ? setStatusHost : undefined}
          onSelectDoc={(id) => {
            commitFloatIfAny();
            setActiveId(id);
          }}
          onCloseDoc={closeDoc}
          onNewDoc={requestNewDoc}
          onRenameDoc={renameDoc}
          zoom={zoom}
          onZoomChange={setZoom}
          width={active.width}
          height={active.height}
          pan={pan}
          setPan={setPan}
          onViewport={setViewport}
          mobile={mobile}
          tool={tool}
          onPickLayer={(id) => layersApi.select(id, "replace")}
          onPlaceText={placeText}
          onUpdateText={updateText}
          cropBox={cropBox}
          onCropBox={setCropBox}
          cropQuad={cropQuad}
          onCropQuad={setCropQuad}
          onCropApply={applyCropNow}
          layers={viewLayers}
          activeLayerId={active.activeLayerId}
          ensureLayer={ensureLayer}
          onLockedAction={(kind) =>
            showToast(
              kind === "pixels"
                ? "This layer's pixels are locked — unlock it in the Layers panel to edit."
                : kind === "position"
                  ? "This layer's position is locked — unlock it in the Layers panel to move it."
                  : "This is a fill layer — double-click it to edit, or paint on its mask to confine it.",
            )
          }
          perfHud={perfHud}
          onPerfHud={setPerfHud}
          measure={measure}
          onMeasure={setMeasure}
          selection={active.selection}
          onSelectionChange={toolSelectionChange}
          onSelectionRects={setSelectionRects}
          selectionAngle={active.selectionAngle}
          selectionPivot={active.selectionPivot}
          onSelectionAngle={setSelectionAngle}
          onSelectionPivot={setSelectionPivot}
          tonePick={!!tonePick}
          onTonePick={onTonePicked}
          curveTarget={curveTarget}
          onCurveTargetStart={onCurveTargetStart}
          onCurveTargetDrag={onCurveTargetDrag}
          onCurveTargetEnd={onCurveTargetEnd}
          filterAnchor={filterAnchorGuide}
          onFilterAnchorDrag={onFilterAnchorDrag}
          onPenPathCommit={storeWorkPath}
          onPathEdited={(id, anchors, closed) => pathsApi.replace(id, anchors, closed)}
          onFrameDrawn={(rect, shape) => addFrameLayer(defaultFrame(rect, shape))}
          recordStrokes={!!recordingId}
          onStrokeRecord={recordStrokeStep}
          colorSpace={colorSpace}
          docDpi={active.dpi ?? 300}
          guides={active.guides ?? EMPTY_GUIDES}
          onGuidesCommit={commitGuides}
          compareSplit={compareSplit}
          compareAxis={compareAxis}
          onCompareSplit={setCompareSplit}
          onBrushHud={setBrushHud}
          viewApiRef={viewApiRef}
          paintRef={paintRef}
          onAdjustEnd={onAdjustEnd}
          onCursor={emitCursor}
          onGesture={emitGesture}
          onFilesDropped={onCanvasFilesDropped}
          samplers={active.samplers ?? []}
          samplerOps={samplerOps}
        />
        {/* Floating-panel overlay — BEFORE RightDock so the dock stays the
            :last-child that the UI-scale zoom selector targets. */}
        <div className={`${styles.floatHost} gq-m-floathost-hidden`} ref={setFloatHost} />
        <RightDock
          parked={mobile && mobileDrawer !== "panels"}
          mobile={mobile}
          tablet={tablet}
          detent={sheetDetent}
          onDetent={setSheetDetent}
          tool={tool}
          layers={layersApi}
          maxHistoryRows={prefs.maxHistory}
          onHistoryJump={(i) => paintRef.current?.jumpTo(i)}
          onSetHistorySource={(i) => paintRef.current?.setHistorySourceIndex(i)}
          historyLog={active.historyLog}
          onNonLinearHistory={(on) => {
            updatePrefs({ nonLinearHistory: on });
            paintRef.current?.setNonLinearHistory(on);
          }}
          subscribeCursor={subscribeCursor}
          subscribeGesture={subscribeGesture}
          samplers={active.samplers ?? []}
          onRemoveSampler={(id) => samplerOps.remove(id)}
          onClearSamplers={() => commitSamplers("Clear samplers", [])}
          docWidth={active.width}
          docHeight={active.height}
          unit={prefs.unit}
          dpi={active.dpi ?? 300}
          onTakeSnapshot={takeSnapshot}
          onRestoreSnapshot={restoreSnapshotNow}
          onDeleteSnapshot={removeSnapshot}
          onSetSourceSnapshot={(id) => paintRef.current?.setHistorySourceSnapshot(id)}
          view={{
            zoom,
            pan,
            setPan,
            vpW: viewport.w,
            vpH: viewport.h,
            docW: active.width,
            docH: active.height,
            setZoom,
            fit: () => viewApiRef.current?.fit(),
          }}
          adjust={sliderSpec ? sliderSpec.params : adjust}
          onAdjust={sliderSpec ? editAdjustmentParams : onAdjust}
          adjustFilter={sliderSpec ? (sliderSpec.preset ?? "") : adjustFilter}
          onAdjustFilter={
            sliderSpec ? (name) => editAdjustmentParams(filterToAdjust(name)) : onAdjustFilter
          }
          onApplyPreset={
            sliderSpec ? (next) => editAdjustmentParams(next) : onApplyPreset
          }
          onAdjustReset={sliderSpec ? resetAdjustmentParams : onAdjustReset}
          adjustActive={!!activeLeafId}
          editingAdjustment={!!sliderSpec}
          adjustEditName={activeAdjustment?.name}
          onCreateAdjustment={convertPreviewToAdjustment}
          onDeleteAdjustment={removeSelected}
          onAddCurves={() => addToneAdjustment("curves")}
          onAddLevels={() => addToneAdjustment("levels")}
          onAddExtra={addExtraAdjustment}
          onExportLut={() => setLutExportOpen(true)}
          engineRef={paintRef}
          docName={active.name}
          colorSpace={colorSpace}
          imageMeta={active.metadata ?? null}
          onEditMeta={updateDocMetadata}
          actionsApi={actionsApi}
          pathsApi={pathsApi}
          compsApi={compsApi}
          docDpi={active.dpi ?? 300}
          selection={active.selection}
          selectionAngle={active.selectionAngle}
          selectionPivot={active.selectionPivot}
          channels={{
            list: active.channels ?? [],
            previewOf: (id) =>
              paintRef.current?.maskPreviewURL(selectionChannelKey(active.id, id), 48) ?? null,
            onSave: () => setChannelDialog("save"),
            onLoad: loadSelectionOp,
            onRename: renameChannelOp,
            onDelete: deleteChannelOp,
          }}
          leftHost={leftHost}
          floatHost={floatHost}
          dockRef={dockRef}
          onToast={showToast}
          onCommand={(id) => runCommandRef.current(id)}
        />
      </div>
      {(() => {
        const desk = !mobile && !tablet;
        const bar = (
          <StatusBar
            variant={desk ? "chips" : "bar"}
            tool={tool}
            zoom={zoom}
            onZoomChange={setZoom}
            colorSpace={colorSpace}
            isolatedCount={isolatedHiding}
            onExitIsolate={() => setIsolate(null)}
            saveState={saveState}
            measure={tool === "measure" ? measure : null}
            subscribeCursor={subscribeCursor}
          />
        );
        /* Nothing until the host exists, rather than a bar for one frame that
           then jumps into the stage. */
        if (!desk) return bar;
        return statusHost ? createPortal(bar, statusHost) : null;
      })()}

      {/* -------- Mobile shell: bottom bar, drawer scrim, edge-swipe strips ---- */}
      {mobile && (
        <>
          {/* The launch state. `docs.length === 1 && !docs[0].layers.length`
              is "nothing has been made yet"; the history check catches an edit
              that left no layer behind (a canvas resize, say). */}
          {!startDismissed &&
            tour === "off" &&
            !restoreSnap &&
            docs.length === 1 &&
            !active?.layers.length &&
            history.index === 0 && (
              <StartCard
                onOpen={() => photoInputRef.current?.click()}
                onCapture={() => cameraInputRef.current?.click()}
                onContinue={
                  startSnap
                    ? () => {
                        restoreSnapshot(startSnap);
                        setStartDismissed(true);
                      }
                    : undefined
                }
                continueLabel={
                  startSnap
                    ? startSnap.docs.map((d) => d.name).join(", ").slice(0, 60)
                    : undefined
                }
                recents={recents}
                onOpenRecent={openRecent}
                onDismiss={() => setStartDismissed(true)}
              />
            )}
          {/* Finish or throw away whatever is in progress. Enter and Escape are
              load-bearing for a pen path, a crop, a transform and a text
              session, and a phone has neither key — so these send exactly those
              keys, and every existing handler stays as it is. Always rendered,
              shown by CSS only while `html[data-commit]` says a session is
              live (CanvasArea publishes it). */}
          <div className="gq-m-commit" role="group" aria-label="Finish or cancel">
            <button
              type="button"
              aria-label="Cancel"
              title="Cancel (Escape)"
              onClick={() => finishTouchSession("cancel")}
            >
              <span aria-hidden>✕</span>
            </button>
            <button
              type="button"
              aria-label="Commit"
              title="Finish (Enter)"
              data-primary
              onClick={() => finishTouchSession("commit")}
            >
              <span aria-hidden>✓</span>
            </button>
          </div>
          <MobileBar
            drawer={mobileDrawer}
            onToggle={toggleMobileDrawer}
            panMode={panMode}
            onTogglePan={() => setPanMode((v) => !v)}
            tool={tool}
            onToolChange={(id) => {
              setTool(id);
              setMobileDrawer(null);
            }}
          />
          {mobileDrawer ? (
            <div
              className="gq-m-scrim"
              onClick={() => setMobileDrawer(null)}
              onPointerDown={(e) => {
                scrimSwipe.current = e.clientX;
              }}
              onPointerMove={onScrimMove}
              onPointerUp={() => {
                scrimSwipe.current = null;
              }}
            />
          ) : (
            <>
              <div
                className="gq-m-edge"
                data-side="left"
                onPointerDown={(e) => onEdgeDown(e, "left")}
                onPointerMove={onEdgeMove}
                onPointerUp={() => {
                  edgeSwipe.current = null;
                }}
              />
              <div
                className="gq-m-edge"
                data-side="right"
                onPointerDown={(e) => onEdgeDown(e, "right")}
                onPointerMove={onEdgeMove}
                onPointerUp={() => {
                  edgeSwipe.current = null;
                }}
              />
            </>
          )}
        </>
      )}

      {sizeDialogOpen && (
        <CanvasSizeDialog
          size={{ width: active.width, height: active.height }}
          mode={sizeDialogMode}
          onApply={sizeDialogMode === "image" ? applyImageSize : setActiveSize}
          onClose={() => setSizeDialogOpen(false)}
        />
      )}

      {pasteSrc && (
        <PasteDialog
          width={pasteSrc.w}
          height={pasteSrc.h}
          docWidth={active.width}
          docHeight={active.height}
          source={pasteSrc.source}
          sizeOnly={!!pasteSrc.dest}
          initialDest={pasteSrc.dest ?? "current-layer"}
          initialExpand={prefs.pasteOversize === "expand"}
          onApply={applyPaste}
          onClose={() => setPasteSrc(null)}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsDialog
          defs={shortcutDefs}
          overrides={shortcutOverrides}
          onRebind={rebindShortcut}
          onResetAll={resetAllShortcuts}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {helpOpen && <HelpDialog start={helpOpen} onClose={() => setHelpOpen(null)} />}

      {patternFill && (
        <PatternFillDialog onFill={fillWithPattern} onClose={() => setPatternFill(false)} />
      )}
      {rawAsk && (
        <RawDevelopDialog
          session={rawAsk.session}
          fileName={rawAsk.name}
          onDone={(opts) => {
            rawAsk.resolve(opts);
            setRawAsk(null);
          }}
        />
      )}
      {channelDialog && (
        <SelectionChannelDialog
          mode={channelDialog}
          channels={active.channels ?? []}
          hasSelection={active.selection.length > 0}
          onSave={saveSelectionOp}
          onLoad={loadSelectionOp}
          onClose={() => setChannelDialog(null)}
        />
      )}

      {aboutOpen && (
        <AboutDialog
          onOpenGuide={() => setHelpOpen("start")}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onClose={() => setAboutOpen(false)}
        />
      )}

      {restoreSnap && (
        <RestoreDialog
          snap={restoreSnap}
          onRestore={() => {
            const n = restoreSnapshot(restoreSnap);
            setRestoreSnap(null);
            void clearAutosave();
            if (!n) showToast("Couldn't restore the autosaved session.");
          }}
          onDiscard={() => {
            setRestoreSnap(null);
            void clearAutosave();
          }}
        />
      )}

      {newDocOpen && (
        <NewDocDialog
          defaultName={`Untitled-${seqRef.current + 1}`}
          defaultWidth={prefs.newDocWidth}
          defaultHeight={prefs.newDocHeight}
          defaultDpi={prefs.defaultDpi}
          onCreate={createDoc}
          onClose={() => setNewDocOpen(false)}
        />
      )}

      {prefsOpen && (
        <PreferencesDialog
          initialTheme={initialTheme}
          prefs={prefs}
          onChange={updatePrefs}
          getCacheStats={() => paintRef.current?.renderCacheStats() ?? null}
          historySummary={history}
          initialTab={prefsTab}
          onTabChange={setPrefsTab}
          onClose={() => setPrefsOpen(false)}
        />
      )}

      {blurFxOpen && (
        <BlurGalleryDialog
          settings={blurFx}
          onChange={changeBlurFx}
          onApply={applyBlurFx}
          onClose={closeBlurFx}
          hasSelection={active.selection.length > 0}
          preview={blurPreview}
        />
      )}

      {liquify && (
        <LiquifyDialog
          layerName={liquify.name}
          source={liquify.canvas}
          docWidth={active.width}
          docHeight={active.height}
          onApply={applyLiquify}
          onClose={() => setLiquify(null)}
        />
      )}

      {refineOpen && (
        <RefineEdgeDialog
          source={refineOpen.source}
          mask={refineOpen.mask}
          docWidth={active.width}
          docHeight={active.height}
          initial={refineOpen.initial}
          onApply={applyRefineEdge}
          onClose={() => setRefineOpen(null)}
        />
      )}

      {warping && (
        <WarpDialog
          layerName={warping.name}
          source={warping.canvas}
          docWidth={active.width}
          docHeight={active.height}
          onApply={applyWarp}
          onClose={() => setWarping(null)}
        />
      )}

      {trimOpen && (
        <TrimDialog
          onTrim={(mode, sides) => {
            trimImage(mode, sides);
            setTrimOpen(false);
          }}
          onClose={() => setTrimOpen(false)}
        />
      )}

      {selectModify && (
        <SelectModifyDialog
          kind={selectModify}
          onApply={(px) => {
            if (selectModify === "feather") featherSelection(px);
            else if (selectModify === "grow") growSelection(px);
            else modifySelectionOp(selectModify, px);
            setSelectModify(null);
          }}
          onClose={() => setSelectModify(null)}
        />
      )}

      {layerStyleTarget &&
        (() => {
          const node = findNode(active.layers, layerStyleTarget);
          if (!node || node.type === "adjustment") return null;
          return (
            <LayerStyleDialog
              effects={node.effects ?? {}}
              layerName={node.name}
              blendIf={node.blendIf}
              onBlendIf={(b) =>
                // NOTE: not journalled to history yet. This fires on every
                // pointermove of a handle drag, so pushing a structural step
                // here would bury the undo stack under hundreds of "Blend If"
                // entries; it needs a commit-on-release in the control first.
                patchActiveDoc((d) => ({
                  ...d,
                  layers: updateNode(d.layers, layerStyleTarget, { blendIf: b }),
                }))
              }
              globalLight={globalLight}
              onGlobalLight={applyGlobalLight}
              fillOpacity={node.fillOpacity}
              knockout={node.knockout}
              onBlending={(patch) =>
                // Same reasoning as onBlendIf: the fill slider fires per
                // pointermove, so this is a live doc patch rather than a
                // structural history step.
                patchActiveDoc((d) => ({
                  ...d,
                  layers: updateNode(d.layers, layerStyleTarget, patch),
                }))
              }
              gradientStorageKey={prefs.sharedGradients ? GRADIENT_PRESETS_KEY : FX_GRADIENT_PRESETS_KEY}
              onApplyPreset={(p) => applyStylePresetOp(layerStyleTarget, p)}
              onChange={(eff) => setLayerEffectsOp(layerStyleTarget, eff)}
              onToggle={(key, enabled) => toggleEffectOp(layerStyleTarget, key, enabled)}
              onClear={() => {
                clearLayerStyleOp(layerStyleTarget);
                setLayerStyleTarget(null);
              }}
              onClose={() => setLayerStyleTarget(null)}
            />
          );
        })()}

      {filterTarget &&
        (() => {
          const node = findNode(active.layers, filterTarget);
          if (!node || node.type === "adjustment") {
            return null;
          }
          return (
            <SmartFilterDialog
              node={node}
              onLive={(filters) => setFiltersLive(filterTarget, filters)}
              onCommit={(filters, label) => setFiltersOp(filterTarget, filters, label)}
              onApplyAll={() => applyFiltersOp(filterTarget)}
              onAddFilterMask={(init) => addFilterMaskOp(filterTarget, init)}
              onRemoveFilterMask={() => removeFilterMaskOp(filterTarget)}
              onToggleFilterMask={(enabled) => setFilterMaskEnabled(filterTarget, enabled)}
              onPaintFilterMask={() => {
                chooseSurface(filterTarget, "filterMask");
                commitFilterEdit();
                setFilterTarget(null); // close so the brush can reach the canvas
              }}
              anchorArmId={filterAnchorId}
              onToggleAnchorArm={setFilterAnchorId}
              hasSelection={active.selection.length > 0}
              previewSource={paintRef.current?.getLayerCanvas(filterTarget) ?? null}
              space={canvasSpaceOf(colorSpace)}
              onClose={() => {
                commitFilterEdit();
                setFilterTarget(null);
              }}
            />
          );
        })()}

      {lutExportOpen && (
        <ExportLutDialog
          layers={active.layers}
          panelAdjust={sliderSpec ? sliderSpec.params : adjust}
          docName={active.name}
          onClose={() => setLutExportOpen(false)}
        />
      )}
      {workspacesOpen && (
        <WorkspacesDialog
          capture={() =>
            ({ panels, dock: dockRef.current?.capture() ?? null }) satisfies WorkspaceSnap
          }
          onApply={(ws) => {
            persistPanels({ ...ALL_PANELS, ...ws.panels });
            if (ws.dock) dockRef.current?.apply(ws.dock);
          }}
          onClose={() => setWorkspacesOpen(false)}
        />
      )}
      {tiffExportOpen && (
        <ExportTiffDialog
          docName={active.name}
          dpi={active.dpi ?? 300}
          getComposite={() => paintRef.current?.exportComposite(active.layers) ?? null}
          onClose={() => setTiffExportOpen(false)}
        />
      )}
      {pdfExportOpen && (
        <ExportPdfDialog
          docName={active.name}
          docDpi={active.dpi ?? 300}
          width={active.width}
          height={active.height}
          author={active.metadata?.artist || prefs.authorName || ""}
          getComposite={() => paintRef.current?.exportComposite(active.layers) ?? null}
          onClose={() => setPdfExportOpen(false)}
        />
      )}
      {hdrMergeOpen && (
        <HdrMergeDialog mode="merge" onCreate={createHdrDoc} onClose={() => setHdrMergeOpen(false)} />
      )}
      {batchOpen && (
        <BatchDialog actions={savedActions} runFile={batchRunFile} onClose={() => setBatchOpen(false)} />
      )}
      {tour === "open" && (
        <TourOverlay mobile={mobile} watch={{ tool, zoom }} onClose={closeTour} onOpenSample={openSampleDoc} />
      )}
      {hdrToneOpen && active.hdr && (
        <HdrMergeDialog
          mode="retone"
          hdr={active.hdr}
          docName={active.name}
          onApply={applyHdrTone}
          onClose={() => setHdrToneOpen(false)}
        />
      )}
      {hdrExportOpen && active.hdr && (
        <HdrExportDialog hdr={active.hdr} docName={active.name} onClose={() => setHdrExportOpen(false)} />
      )}
      {extraEdit && extraSpec && (
        <AdjustmentExtraDialog
          spec={extraSpec}
          onChange={(s) => setToneNodeSpec(extraEdit.layerId, s)}
          onClose={() => {
            commitAdjustEdit();
            setExtraEdit(null);
          }}
        />
      )}
      {fillEdit &&
        (() => {
          const n = findNode(active.layers, fillEdit.layerId);
          if (!n || n.type !== "layer" || !n.fill) return null;
          return (
            <FillDialog
              fill={n.fill}
              onChange={(fill) =>
                patchActiveDoc((d) => ({
                  ...d,
                  layers: updateNode(d.layers, fillEdit.layerId, { fill }),
                }))
              }
              onClose={() => setFillEdit(null)}
            />
          );
        })()}
      {newGuideOpen && (
        <NewGuideDialog
          width={active.width}
          height={active.height}
          onAdd={(g) => {
            commitGuides("New Guide", [...(activeDocRef.current.guides ?? []), g]);
            // A guide you just asked for should be visible even if guides were off.
            if (!viewStore.get().guides) persistView({ guides: true });
          }}
          onClose={() => setNewGuideOpen(false)}
        />
      )}
      {toneEdit && toneSpec && toneEdit.tool === "curves" && toneSpec.type === "curves" && (
        <CurvesDialog
          spec={toneSpec}
          histogram={toneHist}
          onChange={onToneChange}
          onDone={onToneDone}
          onCancel={onToneCancel}
          targeting={curveTarget}
          onToggleTarget={() => setCurveTarget((t) => !t)}
          onChannel={(c) => {
            curveChannelRef.current = c;
          }}
          doneLabel={toneEdit.mode === "dest" ? "Apply" : "Done"}
          cancelLabel={toneEdit.mode === "dest" ? "Cancel" : "Close"}
        />
      )}
      {toneEdit && toneSpec && toneEdit.tool === "levels" && toneSpec.type === "levels" && (
        <LevelsDialog
          spec={toneSpec}
          histogram={toneHist}
          onChange={onToneChange}
          onDone={onToneDone}
          onCancel={onToneCancel}
          onAuto={onToneAuto}
          onEyedrop={(k) => {
            setTonePick(k);
            showToast(`Click the image to set the ${k} point (Esc to cancel).`);
          }}
          picking={!!tonePick}
          doneLabel={toneEdit.mode === "dest" ? "Apply" : "Done"}
          cancelLabel={toneEdit.mode === "dest" ? "Cancel" : "Close"}
        />
      )}

      {toast && <Toast message={toast} onClose={dismissToast} />}

      {saveAsOpen && (
        <SaveAsDialog
          defaultName={active.name}
          onSave={saveProjectAs}
          onClose={() => setSaveAsOpen(false)}
        />
      )}

      {renameOpen && (
        <RenameDocDialog
          defaultName={active.name}
          onRename={(name) => renameDoc(active.id, name)}
          onClose={() => setRenameOpen(false)}
        />
      )}

      {recentsOpen && (
        <RecentsDialog onOpenText={loadProjectText} onClose={() => setRecentsOpen(false)} />
      )}

      {moreSpaceOpen && (
        <MoreSpaceDialog
          installPrompt={installReady}
          onInstall={runInstall}
          onClose={() => setMoreSpaceOpen(false)}
        />
      )}

      {printOpen && (
        <PrintDialog
          docDpi={active.dpi ?? 300}
          width={active.width}
          height={active.height}
          /* Offered only when a proof is actually configured AND would change
             something — proofing sRGB against sRGB is the identity, and a toggle
             that does nothing is worse than no toggle. */
          proofLabel={
            (proofColors || gamutWarn) && !proofIsIdentity(canvasSpaceOf(colorSpace), proofTarget)
              ? PROOF_TARGET_LABELS[proofTarget]
              : null
          }
          onPrint={doPrint}
          onClose={() => setPrintOpen(false)}
        />
      )}

      {colorDialogOpen && (
        <ColorDialog
          colorSpace={colorSpace}
          onColorSpace={setWorkingSpace}
          proofTarget={proofTarget}
          onProofTarget={setProofTarget}
          proofColors={proofColors}
          gamutWarn={gamutWarn}
          onProofColors={setProofColors}
          onGamutWarn={setGamutWarn}
          onClose={() => setColorDialogOpen(false)}
        />
      )}

      {compareComposite !== undefined && (
        <ProfileCompareDialog
          composite={compareComposite}
          onClose={() => setCompareComposite(undefined)}
        />
      )}

      {exportComposite && (
        <ExportDialog
          composite={exportComposite}
          defaultName={active.name}
          meta={exportMetaFor(active)}
          initialFormatId={prefs.defaultExportFormatId}
          initialQuality={prefs.defaultExportQuality}
          onExport={doExport}
          onBatchExport={doBatchExport}
          onClose={() => setExportComposite(null)}
        />
      )}

      {importItems && (
        <ImportDialog
          items={importItems}
          docWidth={active.width}
          docHeight={active.height}
          workingSpace={colorSpace}
          onImport={applyImport}
          onClose={() => setImportItems(null)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={`.${PROJECT_EXT},.${LEGACY_PROJECT_EXT},application/json`}
        onChange={onFilePicked}
        hidden
      />
      <input
        ref={importInputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        onChange={onImportPicked}
        hidden
      />
      <input ref={cubeInputRef} type="file" accept=".cube" onChange={onCubePicked} hidden />

      {/* The start card's two pickers. Separate inputs rather than one with a
          toggle: `capture` is an ATTRIBUTE, and it is what makes the OS open
          the camera instead of the photo library. Both go straight to a
          document — see the `direct` argument to importFiles. */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        data-start-input="open"
        onChange={onStartPhotoPicked}
        hidden
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        data-start-input="camera"
        onChange={onStartPhotoPicked}
        hidden
      />

      <TooltipHost />
    </div>
    </EditorStoresProvider>
  );
}
