"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./Editor.module.scss";
import TopBar from "./TopBar";
import Toolbar from "./Toolbar";
import OptionsBar from "./OptionsBar";
import CanvasArea, { type ViewApi } from "./CanvasArea";
import RightDock, { type PanelVisibility } from "./RightDock";
import StatusBar from "./StatusBar";
import CanvasSizeDialog, { type CanvasSize } from "./CanvasSizeDialog";
import PasteDialog, { type PasteDest } from "./PasteDialog";
import PreferencesDialog, { type PrefsTab } from "./PreferencesDialog";
import HelpDialog, { type HelpStart } from "./HelpDialog";
import AboutDialog from "./AboutDialog";
import TooltipHost from "./Tooltip";
import { type ProofTarget, type WorkingSpace } from "../lib/colorspace";
import { extractICCProfile } from "../lib/icc";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Preferences } from "../lib/prefs";
import { FX_GRADIENT_PRESETS_KEY, GRADIENT_PRESETS_KEY } from "../lib/gradientio";
import {
  clearAutosave,
  markSessionAlive,
  markSessionClean,
  readAutosave,
  wasUncleanExit,
  writeAutosave,
  type AutosaveDoc,
  type AutosaveSnapshot,
} from "../lib/autosave";
import { loadToolPrefs, saveToolPrefs } from "../lib/toolPrefs";
import {
  BLUR_FX_LABELS,
  DEFAULT_BLUR,
  DEFAULT_HEAL,
  DEFAULT_REDEYE,
  DEFAULT_BLUR_FX,
  DEFAULT_CLONE,
  DEFAULT_CROP,
  DEFAULT_DODGE,
  DEFAULT_TEXT,
  DEFAULT_TOOL,
  SAMPLE_SIZE_PX,
  cropAspect,
  type BlurFxScope,
  type BlurFxSettings,
  type BlurSettings,
  type HealSettings,
  type RedEyeSettings,
  type TextRun,
  type CloneSettings,
  type CropSettings,
  type PenAnchor,
  type DodgeSettings,
  type TextSettings,
  type VectorText,
  type GradientSettings,
  type MoveMode,
  type PenSettings,
  type SelectResizeMode,
  type LassoMode,
  type MarqueeShape,
  type ShapeSettings,
  type ToolId,
} from "../lib/tools";
import type { Theme } from "../lib/theme";
import { invertRects, type Pan, type Rect } from "../lib/view";
import {
  cloneSubtree,
  collectLeafIds,
  filterMaskKey,
  findNode,
  flattenedIds,
  insertInGroup,
  insertRelative,
  mergeDownInTree,
  removeMany,
  removeNode,
  replaceNodeWith,
  topLevelSelected,
  ungroupNode,
  updateNode,
  type ActiveSurface,
  type Layer,
  type LayerAdjustment,
  type LayerGroup,
  type LayerNode,
  type LayersApi,
  type MaskMeta,
} from "../lib/layers";
import type {
  BrushSettings,
  ChannelHistogram,
  EngineHandle,
  HistorySummary,
  ImageTransform,
  LeafSnapshot,
  PendingPaste,
  TextRenderSpec,
} from "../lib/paint";
import BlurGalleryDialog from "./BlurGalleryDialog";
import TrimDialog, { type TrimMode, type TrimSides } from "./TrimDialog";
import SelectModifyDialog from "./SelectModifyDialog";
import LayerStyleDialog from "./LayerStyleDialog";
import CurvesDialog from "./CurvesDialog";
import LevelsDialog, { type EyedropKind } from "./LevelsDialog";
import Toast from "./Toast";
import SaveAsDialog from "./SaveAsDialog";
import RecentsDialog from "./RecentsDialog";
import ExportDialog, { type BatchRun } from "./ExportDialog";
import ImportDialog, { type ImportItem, type ImportMode, type ImportOptions } from "./ImportDialog";
import ColorDialog from "./ColorDialog";
import ProfileCompareDialog from "./ProfileCompareDialog";
import {
  LEGACY_PROJECT_EXT,
  PROJECT_EXT,
  downloadBlob,
  saveProjectFile,
  serializeProject,
  type PendingLoad,
  type ProjectFile,
  type SerializedNode,
} from "../lib/project";
import {
  IMPORT_ACCEPT,
  availableFormats,
  decodeImageFile,
  p3Supported,
  renderExport,
  saveImageBlob,
  type ExportOptions,
  setRawWorkerEnabled,
} from "../lib/imageio";
import { buildZip } from "../lib/zip";
import { dedupeFilenames, targetFilename } from "../lib/exportpresets";
import { exportSVG, looksLikeSVG, parseSVGFile, translateVectorPath } from "../lib/svg";
import { buildPSD, parsePSD, type PsdDocument, type PsdImage, type PsdNode, type PsdOutNode } from "../lib/psd";
import { addRecent, setRecentsLimit } from "../lib/recents";
import {
  actionLabel,
  freshActionId,
  isRecordable,
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
  coercePaths,
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
  isDefaultAdjust,
  type AdjustmentSpec,
  type Adjustments,
} from "../lib/adjust";
import { ADJUSTMENT_TYPES, specFromPreset, specFromType, specLabel } from "../lib/adjustment-types";
import {
  defaultExtra,
  isExtraSpec,
  parseCubeLUT,
  EXTRA_LABELS,
  type ExtraAdjustment,
  type ExtraAdjustmentType,
} from "../lib/adjust-extra";
import AdjustmentExtraDialog from "./AdjustmentExtraDialog";
import ExportLutDialog from "./ExportLutDialog";
import HdrMergeDialog from "./HdrMergeDialog";
import HdrExportDialog from "./HdrExportDialog";
import type { HdrImage } from "../lib/hdr";
import { DEFAULT_FX, type FxKey, type LayerEffects } from "../lib/effects";
import { defaultFilter, filterLabel, type FilterType, type SmartFilter } from "../lib/filters";
import SmartFilterDialog from "./SmartFilterDialog";
import ShortcutsDialog from "./ShortcutsDialog";
import NewDocDialog from "./NewDocDialog";
import RestoreDialog from "./RestoreDialog";
import {
  autoLevels,
  buildCurvesLUTs,
  curveLUT,
  curveSampler,
  defaultCurves,
  defaultLevels,
  solveGrayPoint,
  type ChannelKey,
  type ChannelParams,
  type CurvePoint,
  type ToneAdjustment,
} from "../lib/tone";
import { extractMetadata, type ImageMetadata } from "../lib/metadata";
import { embedMetadata, type ExportMetadata } from "../lib/metadata-write";

interface PasteSrc {
  source: ImageBitmap | HTMLCanvasElement;
  w: number;
  h: number;
  /** Destination already decided (Preferences default) — the dialog only asks
      the oversized-image canvas-size question. */
  dest?: PasteDest;
}

interface Doc {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: LayerNode[];
  /** Primary layer (drives the blend/opacity panel; anchor for range-select). */
  activeLayerId: string | null;
  /** Full multi-selection (always includes activeLayerId when non-null). */
  selectedLayerIds: string[];
  selection: Rect[];
  /** Selection rotation (radians) about `selectionPivot` (or the bbox centre). */
  selectionAngle: number;
  selectionPivot: { x: number; y: number } | null;
  /** Source-image file/EXIF metadata (set when a doc originates from an image). */
  metadata?: ImageMetadata | null;
  /** Pixels per inch — physical-unit rulers/readouts + true-size print. */
  dpi?: number;
  /** Stored pen paths (Paths panel; "work" = the latest Pen-tool commit). */
  paths?: SavedPath[];
  /** 32-bit float radiance source (Merge to HDR) — IN MEMORY only, never
   *  serialized (.gproj/autosave keep the tone-mapped pixels instead). */
  hdr?: HdrImage | null;
}

/** A layer selection: the primary (active) id plus the full selected set. */
type Sel = { active: string | null; selected: string[] };

const ALL_PANELS: PanelVisibility = {
  color: true,
  adjustments: true,
  properties: true,
  layers: true,
  paths: true,
  history: true,
  actions: true,
  navigator: true,
  channels: true,
  metadata: true,
};
/** Window-menu action id → panel key. */
const PANEL_BY_ACTION: Record<string, keyof PanelVisibility> = {
  "window-color": "color",
  "window-adjustments": "adjustments",
  "window-properties": "properties",
  "window-layers": "layers",
  "window-paths": "paths",
  "window-history": "history",
  "window-actions": "actions",
  "window-navigator": "navigator",
  "window-channels": "channels",
  "window-metadata": "metadata",
};

const makeDoc = (seq: number, size?: { w: number; h: number }, dpi = 300): Doc => ({
  id: `doc-${seq}`,
  name: `Untitled-${seq}`,
  width: size?.w ?? 1920,
  height: size?.h ?? 1080,
  dpi,
  layers: [],
  activeLayerId: null,
  selectedLayerIds: [],
  selection: [],
  selectionAngle: 0,
  selectionPivot: null,
});

export default function Editor({ initialTheme }: { initialTheme: Theme }) {
  const [tool, setTool] = useState<ToolId>(DEFAULT_TOOL);
  const [zoom, setZoom] = useState(67);
  const [foreground, setForeground] = useState("#6366f1ff");
  const [background, setBackground] = useState("#ffffffff");
  // Which swatch tools paint with: "primary" = foreground, "secondary" = background.
  const [activeSlot, setActiveSlot] = useState<"primary" | "secondary">("primary");
  const [sizeDialogOpen, setSizeDialogOpen] = useState(false);
  const [sizeDialogMode, setSizeDialogMode] = useState<"canvas" | "image">("canvas");
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [brush, setBrush] = useState<BrushSettings>({
    size: 24,
    hardness: 80,
    opacity: 100,
    flow: 100,
    blend: "Normal",
    smoothing: 20,
  });
  const [eraser, setEraser] = useState<BrushSettings>({
    size: 30,
    hardness: 90,
    opacity: 100,
    flow: 100,
    blend: "Normal",
    smoothing: 10,
  });
  // Pencil: a hard-edged, pixel-perfect tool — always full hardness, no smoothing.
  const [pencil, setPencil] = useState<BrushSettings>({
    size: 4,
    hardness: 100,
    opacity: 100,
    flow: 100,
    blend: "Normal",
    smoothing: 0,
  });
  const [wand, setWand] = useState({ tolerance: 32, contiguous: true, sampleAll: false });
  const [bucket, setBucket] = useState({
    tolerance: 32,
    opacity: 100,
    contiguous: true,
    antialias: false,
  });
  const [shape, setShape] = useState<ShapeSettings>({ kind: "rect", strokeWidth: 2, radius: 12 });
  const [gradient, setGradient] = useState<GradientSettings>({
    type: "linear",
    reverse: false,
    smooth: false,
    stops: null,
  });
  const [pen, setPen] = useState<PenSettings>({ width: 8, taper: 0, bend: 0 });
  const [blur, setBlur] = useState<BlurSettings>(DEFAULT_BLUR);
  const [heal, setHeal] = useState<HealSettings>(DEFAULT_HEAL);
  const [redEye, setRedEye] = useState<RedEyeSettings>(DEFAULT_REDEYE);
  const [clone, setClone] = useState<CloneSettings>(DEFAULT_CLONE);
  const [dodge, setDodge] = useState<DodgeSettings>(DEFAULT_DODGE);
  const [textSettings, setTextSettings] = useState<TextSettings>(DEFAULT_TEXT);
  const [cropSettings, setCropSettings] = useState<CropSettings>(DEFAULT_CROP);
  // The pending crop rectangle (doc coords) while the crop tool is active; null
  // means no crop is in progress. Edited interactively on the canvas overlay and
  // via the options bar; committed with Enter / ✓, dropped with Esc.
  const [cropBox, setCropBox] = useState<Rect | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Preferences section to open on — Settings ▸ Performance / Scratch disks
  // deep-link their tabs; plain Preferences… re-opens wherever you last were.
  const [prefsTab, setPrefsTab] = useState<PrefsTab>("appearance");
  const openPrefs = (tab?: PrefsTab) => {
    if (tab) setPrefsTab(tab);
    setPrefsOpen(true);
  };
  // Help window (Getting started / Documentation) + About.
  const [helpOpen, setHelpOpen] = useState<HelpStart | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [trimOpen, setTrimOpen] = useState(false);
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
  const [blurFxOpen, setBlurFxOpen] = useState(false);
  const [blurFx, setBlurFx] = useState<BlurFxSettings>(DEFAULT_BLUR_FX);
  // The composited result of the live blur preview, shown inside the gallery dialog.
  const [blurPreview, setBlurPreview] = useState<HTMLCanvasElement | null>(null);
  const blurFxSessionRef = useRef<string[] | null>(null);
  const blurFxTimerRef = useRef(0);
  const blurFxOpenRef = useRef(false);
  blurFxOpenRef.current = blurFxOpen;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // Load persisted preferences once on the client (localStorage is unavailable on the server).
  useEffect(() => setPrefs(loadPrefs()), []);
  const updatePrefs = (patch: Partial<Preferences>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  const [history, setHistory] = useState<HistorySummary>({ items: [{ label: "New" }], index: 0 });
  // Any history movement means unsaved work (autosave + status-bar indicator).
  const historyInitRef = useRef(true);
  useEffect(() => {
    if (historyInitRef.current) {
      historyInitRef.current = false;
      return;
    }
    autosaveDirtyRef.current = true;
    setSaveState((s) => (s.label === "Unsaved changes" ? s : { label: "Unsaved changes", ok: false }));
  }, [history]);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [panels, setPanelsState] = useState<PanelVisibility>(ALL_PANELS);
  const [showRulers, setShowRulers] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const viewApiRef = useRef<ViewApi | null>(null);
  // Current view toggles, reachable from the one-time keydown listener.
  const viewSettingsRef = useRef({ rulers: true, grid: false, snap: true });
  viewSettingsRef.current = { rulers: showRulers, grid: showGrid, snap };
  const [colorSpace, setColorSpaceState] = useState<WorkingSpace>("srgb");
  // Soft proofing (view-only): Ctrl+Alt+Y simulate, Ctrl+Alt+Shift+Y gamut warn.
  const [proofColors, setProofColors] = useState(false);
  const [gamutWarn, setGamutWarn] = useState(false);
  const [proofTarget, setProofTargetState] = useState<ProofTarget>("srgb");
  const [colorDialogOpen, setColorDialogOpen] = useState(false);
  const [compareComposite, setCompareComposite] = useState<HTMLCanvasElement | null | undefined>(undefined);
  const [adjust, setAdjust] = useState<Adjustments>(DEFAULT_ADJUST);
  const [adjustFilter, setAdjustFilter] = useState("Original");
  const [selectionFeather, setSelectionFeather] = useState(0);
  const selectionFeatherRef = useRef(0);
  selectionFeatherRef.current = selectionFeather;
  const [selectModify, setSelectModify] = useState<"feather" | "grow" | null>(null);
  const [moveMode, setMoveMode] = useState<MoveMode>("pixels");
  const [resizeMode, setResizeMode] = useState<SelectResizeMode>("bounds");
  const [resizeSmooth, setResizeSmooth] = useState(true);
  const [marqueeShape, setMarqueeShape] = useState<MarqueeShape>("rect");
  const marqueeShapeRef = useRef(marqueeShape);
  marqueeShapeRef.current = marqueeShape;
  const [lassoMode, setLassoMode] = useState<LassoMode>("free");
  const lassoModeRef = useRef(lassoMode);
  lassoModeRef.current = lassoMode;
  const [triangleApex, setTriangleApex] = useState(0.5);
  const [sampleSizeLabel, setSampleSizeLabel] = useState("Point sample");
  const [sampleScopeLabel, setSampleScopeLabel] = useState("All layers");

  // Restore every options-bar setting from the last session (client-only, so the
  // server-rendered defaults don't mismatch), then persist them on any change.
  useEffect(() => {
    const p = loadToolPrefs();
    if (p.foreground) setForeground(p.foreground);
    if (p.background) setBackground(p.background);
    if (p.brush) setBrush((s) => ({ ...s, ...p.brush }));
    if (p.eraser) setEraser((s) => ({ ...s, ...p.eraser }));
    if (p.pencil) setPencil((s) => ({ ...s, ...p.pencil }));
    if (p.wand) setWand((s) => ({ ...s, ...p.wand }));
    if (p.bucket) setBucket((s) => ({ ...s, ...p.bucket }));
    if (p.shape) setShape((s) => ({ ...s, ...p.shape }));
    if (p.gradient) setGradient((s) => ({ ...s, ...p.gradient }));
    if (p.pen) setPen((s) => ({ ...s, ...p.pen }));
    if (p.blur) setBlur((s) => ({ ...s, ...p.blur }));
    if (p.heal) setHeal((s) => ({ ...s, ...p.heal }));
    if (p.redEye) setRedEye((s) => ({ ...s, ...p.redEye }));
    if (p.clone) setClone((s) => ({ ...s, ...p.clone }));
    if (p.dodge) setDodge((s) => ({ ...s, ...p.dodge }));
    if (p.text) setTextSettings((s) => ({ ...s, ...p.text }));
    if (p.crop) setCropSettings((s) => ({ ...s, ...p.crop }));
    if (p.moveMode) setMoveMode(p.moveMode);
    if (p.resizeMode) setResizeMode(p.resizeMode);
    if (typeof p.resizeSmooth === "boolean") setResizeSmooth(p.resizeSmooth);
    if (p.marqueeShape) setMarqueeShape(p.marqueeShape);
    if (p.lassoMode) setLassoMode(p.lassoMode);
    if (typeof p.triangleApex === "number") setTriangleApex(p.triangleApex);
    if (p.sampleSize) setSampleSizeLabel(p.sampleSize);
    if (p.sampleScope) setSampleScopeLabel(p.sampleScope);
  }, []);
  const toolSaveReady = useRef(false);
  useEffect(() => {
    if (!toolSaveReady.current) {
      toolSaveReady.current = true; // skip the first run (defaults / just-loaded)
      return;
    }
    const id = window.setTimeout(
      () =>
        saveToolPrefs({
          foreground,
          background,
          brush,
          eraser,
          pencil,
          wand,
          bucket,
          shape,
          gradient,
          pen,
          blur,
          heal,
          redEye,
          clone,
          dodge,
          text: textSettings,
          crop: cropSettings,
          moveMode,
          resizeMode,
          resizeSmooth,
          marqueeShape,
          lassoMode,
          triangleApex,
          sampleSize: sampleSizeLabel,
          sampleScope: sampleScopeLabel,
        }),
      250,
    );
    return () => window.clearTimeout(id);
  }, [
    foreground,
    background,
    brush,
    eraser,
    pencil,
    wand,
    bucket,
    shape,
    gradient,
    pen,
    blur,
    heal,
    redEye,
    clone,
    dodge,
    textSettings,
    cropSettings,
    moveMode,
    resizeMode,
    resizeSmooth,
    marqueeShape,
    lassoMode,
    triangleApex,
    sampleSizeLabel,
    sampleScopeLabel,
  ]);
  const [pasteSrc, setPasteSrc] = useState<PasteSrc | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [pendingLoads, setPendingLoads] = useState<PendingLoad[]>([]);
  const [exportComposite, setExportComposite] = useState<HTMLCanvasElement | null>(null);
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null);
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
  // Latest colours, reachable from the one-time keydown listener.
  const fgRef = useRef(foreground);
  const bgRef = useRef(background);
  fgRef.current = foreground;
  bgRef.current = background;
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;
  // The colour tools actually paint with = the active swatch.
  const paintColor = activeSlot === "primary" ? foreground : background;
  const setPaintColor = activeSlot === "primary" ? setForeground : setBackground;
  const historyRef = useRef(history);
  historyRef.current = history;

  // Open documents. Starts with a single, unnamed canvas.
  const [docs, setDocs] = useState<Doc[]>(() => [makeDoc(1)]);
  const [activeId, setActiveId] = useState("doc-1");
  const seqRef = useRef(1);
  const layerSeqRef = useRef(0);

  const active = docs.find((d) => d.id === activeId) ?? docs[0];

  // The active layer when it's a pixel layer (adjustments target a single leaf).
  const activeLeafNode = active.activeLayerId ? findNode(active.layers, active.activeLayerId) : null;
  const activeLeafId = activeLeafNode && activeLeafNode.type === "layer" ? active.activeLayerId : null;

  // Latest active-doc bits reachable from the one-time keydown listener.
  const activeIdRef = useRef(activeId);
  const selRef = useRef(active.selection);
  const activeLayerRef = useRef(active.activeLayerId);
  const activeDocRef = useRef(active);
  const toolRef = useRef(tool);
  const cropBoxRef = useRef(cropBox);
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
  cropSettingsRef.current = cropSettings;
  blurRef.current = blur;
  textSettingsRef.current = textSettings;

  // Where the last in-app copy came from, so an in-app paste can drop in place.
  const copyOriginRef = useRef({ x: 0, y: 0 });
  const copyDocIdRef = useRef<string | null>(null);

  const setActiveSize = (s: CanvasSize) => {
    const d = activeDocRef.current;
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

  const openSizeDialog = (mode: "canvas" | "image") => {
    setSizeDialogMode(mode);
    setSizeDialogOpen(true);
  };

  // Image resize (resample): scale every layer, then adopt the new dimensions.
  // resizeImage runs first so the follow-up size change is a no-op for the engine.
  const applyImageSize = (s: CanvasSize) => {
    const d = activeDocRef.current;
    paintRef.current?.resizeImage(s.width, s.height, collectLeafIds(d.layers), true);
    setDocs((ds) =>
      ds.map((x) =>
        x.id === activeIdRef.current
          ? { ...x, width: s.width, height: s.height, selection: [], selectionAngle: 0, selectionPivot: null }
          : x,
      ),
    );
  };

  // Whole-image rotate / flip (Image menu). The engine transforms every layer
  // (90° rotations swap the dimensions), then the doc adopts the new size so the
  // follow-up setDoc is a no-op. Folded into one undoable history step whose undo
  // applies the inverse transform (pixel-exact for 90° rotations & flips).
  const TRANSFORM_LABEL: Record<ImageTransform, string> = {
    "rotate-cw": "Rotate 90° CW",
    "rotate-ccw": "Rotate 90° CCW",
    "flip-h": "Flip Horizontal",
    "flip-v": "Flip Vertical",
  };
  const INVERSE_TRANSFORM: Record<ImageTransform, ImageTransform> = {
    "rotate-cw": "rotate-ccw",
    "rotate-ccw": "rotate-cw",
    "flip-h": "flip-h",
    "flip-v": "flip-v",
  };
  const applyImageTransform = (kind: ImageTransform) => {
    const d = activeDocRef.current;
    if (!d.layers.length) return;
    const eng = paintRef.current;
    if (!eng) return;
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const rot = kind === "rotate-cw" || kind === "rotate-ccw";
    // Swap (rotations) or keep (flips) the doc dimensions; clear the selection.
    const setDims = () =>
      setDocs((ds) =>
        ds.map((x) =>
          x.id === docId
            ? {
                ...x,
                width: rot ? x.height : x.width,
                height: rot ? x.width : x.height,
                selection: [],
                selectionAngle: 0,
                selectionPivot: null,
              }
            : x,
        ),
      );
    const forward = () => {
      eng.transformImage(kind, leafIds);
      setDims();
    };
    const backward = () => {
      eng.transformImage(INVERSE_TRANSFORM[kind], leafIds);
      setDims(); // swapping w/h twice (or keeping it) returns the original size
    };
    forward();
    eng.pushStructural(TRANSFORM_LABEL[kind], backward, forward);
  };

  // Image ▸ Crop — crop the canvas to the current selection's (axis-aligned) bounds.
  const cropToSelection = () => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Crop trims the canvas to the selection — make a selection first.");
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of d.selection) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    // A rotated selection: take the axis-aligned bounds of the rotated corners.
    if (d.selectionAngle) {
      const c = d.selectionPivot ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      const cos = Math.cos(d.selectionAngle);
      const sin = Math.sin(d.selectionAngle);
      const corners: [number, number][] = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      x0 = Infinity;
      y0 = Infinity;
      x1 = -Infinity;
      y1 = -Infinity;
      for (const [px, py] of corners) {
        const rx = c.x + (px - c.x) * cos - (py - c.y) * sin;
        const ry = c.y + (px - c.x) * sin + (py - c.y) * cos;
        x0 = Math.min(x0, rx);
        y0 = Math.min(y0, ry);
        x1 = Math.max(x1, rx);
        y1 = Math.max(y1, ry);
      }
    }
    cropToRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, "Crop");
  };

  // Image ▸ Trim — crop away a uniform border (transparent, or a corner colour),
  // on the chosen sides. Scans the composited image for the content bounds.
  const trimImage = (mode: TrimMode, sides: TrimSides) => {
    const d = activeDocRef.current;
    const comp = paintRef.current?.exportComposite(d.layers);
    const ctx = comp?.getContext("2d");
    if (!comp || !ctx) return;
    const w = comp.width;
    const h = comp.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const ref = mode === "bottom-right" ? ((h - 1) * w + (w - 1)) * 4 : 0;
    const rr = data[ref];
    const rg = data[ref + 1];
    const rb = data[ref + 2];
    const ra = data[ref + 3];
    const trimmable = (i: number) =>
      mode === "transparent"
        ? data[i + 3] === 0
        : data[i] === rr && data[i + 1] === rg && data[i + 2] === rb && data[i + 3] === ra;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!trimmable((y * w + x) * 4)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      showToast("Nothing to trim — the image has no border to remove.");
      return;
    }
    const left = sides.left ? minX : 0;
    const top = sides.top ? minY : 0;
    const right = sides.right ? maxX + 1 : w;
    const bottom = sides.bottom ? maxY + 1 : h;
    cropToRect({ x: left, y: top, w: right - left, h: bottom - top }, "Trim");
  };

  // Crop the document to `rect` (clamped to the canvas), as one undoable step —
  // shared by the Crop tool, Image ▸ Crop and Image ▸ Trim.
  const cropToRect = (rect: Rect, label: string, angle = 0) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !d.layers.length) return;
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const r: Rect = {
      x,
      y,
      w: Math.max(1, Math.min(Math.round(rect.w), d.width - x)),
      h: Math.max(1, Math.min(Math.round(rect.h), d.height - y)),
    };
    if (angle === 0 && r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height) return; // no-op
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const snap = eng.cropSnapshot(leafIds);
    const setDims = (w: number, h: number) =>
      setDocs((ds) =>
        ds.map((x2) =>
          x2.id === docId
            ? { ...x2, width: w, height: h, selection: [], selectionAngle: 0, selectionPivot: null }
            : x2,
        ),
      );
    const redo = () => {
      eng.applyCrop(r, leafIds, angle);
      setDims(r.w, r.h);
    };
    const undo = () => {
      eng.cropRestore(snap);
      setDims(snap.w, snap.h);
    };
    redo();
    eng.pushStructural(label, undo, redo);
  };

  // ---- Crop tool ----------------------------------------------------------
  // Reset the pending crop box to the whole document (also the initial box when
  // the crop tool is first selected). Straighten is left at 0.
  const resetCropBox = useCallback(() => {
    const d = activeDocRef.current;
    setCropBox({ x: 0, y: 0, w: d.width, h: d.height });
    setCropSettings((s) => ({ ...s, straighten: 0 }));
  }, []);

  // Commit the pending crop: snapshot, crop every leaf to the box (rotating by the
  // straighten angle), resize the document, and fold it into one undoable step.
  const applyCropNow = useCallback(() => {
    const box = cropBoxRef.current;
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!box || !eng || !d.layers.length) return;
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
    const docId = activeIdRef.current;
    const leafIds = collectLeafIds(d.layers);
    const snap = eng.cropSnapshot(leafIds);
    const setDims = (w: number, h: number) =>
      setDocs((ds) =>
        ds.map((x) =>
          x.id === docId
            ? { ...x, width: w, height: h, selection: [], selectionAngle: 0, selectionPivot: null }
            : x,
        ),
      );
    const redo = () => {
      eng.applyCrop(rect, leafIds, angle);
      setDims(rect.w, rect.h);
    };
    const undo = () => {
      eng.cropRestore(snap);
      setDims(snap.w, snap.h);
    };
    redo();
    eng.pushStructural("Crop", undo, redo);
    // Re-seat the crop box to the new, full canvas so the tool stays usable.
    setCropBox({ x: 0, y: 0, w: rect.w, h: rect.h });
    setCropSettings((s) => ({ ...s, straighten: 0 }));
  }, []);

  // Entering the crop tool (or switching documents while in it) seats the box on
  // the whole canvas; leaving the tool drops the pending crop without applying it.
  useEffect(() => {
    if (tool !== "crop") {
      setCropBox(null);
      return;
    }
    const d = activeDocRef.current;
    setCropBox({ x: 0, y: 0, w: d.width, h: d.height });
    setCropSettings((s) => ({ ...s, straighten: 0 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, activeId]);

  // Setting a (new) selection resets its rotation transform.
  const setSelection = (rects: Rect[]) => {
    setSelectionFeather(0); // a fresh selection starts unfeathered
    setDocs((ds) =>
      ds.map((d) =>
        d.id === activeIdRef.current
          ? { ...d, selection: rects, selectionAngle: 0, selectionPivot: null }
          : d,
      ),
    );
  };
  // Update only the selection rects, preserving the rotation transform.
  const setSelectionRects = (rects: Rect[]) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selection: rects } : d)));
  const setSelectionAngle = (angle: number) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selectionAngle: angle } : d)));
  const setSelectionPivot = (pivot: { x: number; y: number } | null) =>
    setDocs((ds) => ds.map((d) => (d.id === activeIdRef.current ? { ...d, selectionPivot: pivot } : d)));

  // ---- Select menu (All / Deselect / Reselect / Inverse) ----
  // Selection changes from the menu are undoable: each pushes a structural
  // history entry whose undo/redo restores the selection rects + rotation.
  type SelState = { rects: Rect[]; angle: number; pivot: { x: number; y: number } | null };
  const selStateOf = (d: Doc): SelState => ({
    rects: d.selection,
    angle: d.selectionAngle,
    pivot: d.selectionPivot,
  });
  const setSelState = (docId: string, s: SelState) =>
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? { ...d, selection: s.rects, selectionAngle: s.angle, selectionPivot: s.pivot }
          : d,
      ),
    );
  const sameSelState = (a: SelState, b: SelState) =>
    a.angle === b.angle &&
    (a.pivot?.x ?? null) === (b.pivot?.x ?? null) &&
    (a.pivot?.y ?? null) === (b.pivot?.y ?? null) &&
    a.rects.length === b.rects.length &&
    a.rects.every(
      (r, i) => r.x === b.rects[i].x && r.y === b.rects[i].y && r.w === b.rects[i].w && r.h === b.rects[i].h,
    );

  // The most recent non-empty selection, so Reselect can bring it back.
  const lastSelectionRef = useRef<SelState | null>(null);

  const commitSelection = (label: string, rects: Rect[], angle = 0, pivot: { x: number; y: number } | null = null) => {
    const docId = activeIdRef.current;
    const before = selStateOf(activeDocRef.current);
    const after: SelState = { rects, angle, pivot };
    if (sameSelState(before, after)) return; // no-op → don't journal it
    setSelectionFeather(0); // a changed selection region resets feather (Grow re-applies it)
    setSelState(docId, after);
    paintRef.current?.pushStructural(label, () => setSelState(docId, before), () => setSelState(docId, after));
  };

  // Select ▸ Grow — expand the selection rects outward by `px`, keeping feather.
  const growSelection = (px: number) => {
    const d = activeDocRef.current;
    if (!d.selection.length) {
      showToast("Grow needs an active selection — make one first.");
      return;
    }
    const feather = selectionFeatherRef.current;
    const grown = d.selection.map((r) => {
      const x = Math.max(0, r.x - px);
      const y = Math.max(0, r.y - px);
      const right = Math.min(d.width, r.x + r.w + px);
      const bottom = Math.min(d.height, r.y + r.h + px);
      return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
    });
    commitSelection("Grow", grown, d.selectionAngle, d.selectionPivot);
    setSelectionFeather(feather); // growing keeps the feather radius
  };

  // Select ▸ Feather — soften the selection edges by `px` for fills/erases/moves.
  const featherSelection = (px: number) => {
    if (!activeDocRef.current.selection.length) {
      showToast("Feather needs an active selection — make one first.");
      return;
    }
    setSelectionFeather(px);
  };

  const selectAll = () => {
    commitFloatIfAny();
    const d = activeDocRef.current;
    commitSelection("Select All", [{ x: 0, y: 0, w: d.width, h: d.height }]);
  };
  const deselect = () => {
    if (!activeDocRef.current.selection.length) return;
    commitFloatIfAny(); // merge a floating paste before clearing
    commitSelection("Deselect", []);
  };
  const reselect = () => {
    const last = lastSelectionRef.current;
    if (!last?.rects.length || activeDocRef.current.selection.length) return; // only when nothing is selected
    commitSelection("Reselect", last.rects, last.angle, last.pivot);
  };
  const invertSelection = () => {
    const d = activeDocRef.current;
    if (!d.selection.length) return; // nothing selected → inverse is undefined here
    commitFloatIfAny();
    commitSelection("Invert Selection", invertRects(d.selection, d.width, d.height));
  };

  // Enter transform via the marquee's handles (drag a corner/edge to scale, the
  // ring to rotate). `content` true = Free Transform (moves the pixels); false =
  // Transform Selection (reshapes the marquee outline only). With no selection
  // there's no outline to reshape, so both transform the whole layer's content.
  const enterTransform = (content: boolean) => {
    const d = activeDocRef.current;
    if (!d.layers.length || !d.activeLayerId) return; // need a layer to transform
    commitFloatIfAny();
    const hasSel = d.selection.length > 0;
    if (!hasSel) setSelection([{ x: 0, y: 0, w: d.width, h: d.height }]);
    setResizeMode(content || !hasSel ? "content" : "bounds");
    setTool("select");
  };

  // ---- Layer operations (act on the active document) ----
  const patchActiveDoc = (fn: (d: Doc) => Doc) =>
    setDocs((ds) => ds.map((d) => (d.id === activeId ? fn(d) : d)));

  const setDocSel = (docId: string, layers: LayerNode[], sel: Sel) =>
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? { ...d, layers, activeLayerId: sel.active, selectedLayerIds: sel.selected }
          : d,
      ),
    );

  const nextLeafId = () => `layer-${(layerSeqRef.current += 1)}`;
  const single = (id: string | null): Sel => ({ active: id, selected: id ? [id] : [] });
  // Current selection of the active doc (before snapshot for undo).
  const selNow = (): Sel => ({ active: active.activeLayerId, selected: active.selectedLayerIds });
  // The ids an action operates on: the multi-selection, or just the active layer.
  const targetIds = (): string[] =>
    active.selectedLayerIds.length
      ? active.selectedLayerIds
      : active.activeLayerId
        ? [active.activeLayerId]
        : [];

  // Run an undoable structural layer change. `forward` does the engine pixel work
  // (duplicate / rasterize). Created & deleted leaves (from the tree diff) drive
  // canvas undo/redo; the tree + selection are restored through setDocSel.
  const commitLayerChange = (
    label: string,
    treeBefore: LayerNode[],
    selBefore: Sel,
    treeAfter: LayerNode[],
    selAfter: Sel,
    forward: () => void = () => {},
    /** Canvas-size change folded into the same step (import-expand). */
    dims?: { bw: number; bh: number; aw: number; ah: number },
  ) => {
    const docId = activeIdRef.current;
    const patchDims = (w: number, h: number) =>
      setDocs((ds) => ds.map((d) => (d.id === docId ? { ...d, width: w, height: h } : d)));
    if (dims) patchDims(dims.aw, dims.ah);
    const eng = paintRef.current;
    const beforeIds = new Set(collectLeafIds(treeBefore));
    const afterIds = new Set(collectLeafIds(treeAfter));
    const deletedIds = [...beforeIds].filter((id) => !afterIds.has(id));
    const createdIds = [...afterIds].filter((id) => !beforeIds.has(id));
    const beforeSnaps = eng ? eng.captureLeaves(deletedIds) : new Map<string, LeafSnapshot>();
    forward();
    if (eng) deletedIds.forEach((id) => eng.removeLayer(id));
    const afterSnaps = eng ? eng.captureLeaves(createdIds) : new Map<string, LeafSnapshot>();
    setDocSel(docId, treeAfter, selAfter);
    if (!eng) return;
    const empty: LeafSnapshot = { layer: null, mask: null };
    const undoSnaps = new Map<string, LeafSnapshot>();
    deletedIds.forEach((id) => undoSnaps.set(id, beforeSnaps.get(id) ?? empty));
    createdIds.forEach((id) => undoSnaps.set(id, empty));
    const redoSnaps = new Map<string, LeafSnapshot>();
    createdIds.forEach((id) => redoSnaps.set(id, afterSnaps.get(id) ?? empty));
    deletedIds.forEach((id) => redoSnaps.set(id, empty));
    eng.pushStructural(
      label,
      () => {
        if (dims) patchDims(dims.bw, dims.bh);
        eng.restoreLeaves(undoSnaps);
        setDocSel(docId, treeBefore, selBefore);
      },
      () => {
        if (dims) patchDims(dims.aw, dims.ah);
        eng.restoreLeaves(redoSnaps);
        setDocSel(docId, treeAfter, selAfter);
      },
    );
  };

  const addLayerOp = () => {
    const before = active.layers;
    const leaf: Layer = {
      id: nextLeafId(),
      type: "layer",
      name: `Layer ${layerSeqRef.current}`,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const node = active.activeLayerId ? findNode(before, active.activeLayerId) : null;
    let after: LayerNode[];
    if (node && node.type === "group") after = insertInGroup(before, leaf, node.id);
    else if (node) after = insertRelative(before, leaf, node.id, true);
    else after = [leaf, ...before];
    commitLayerChange("New Layer", before, selNow(), after, single(leaf.id));
  };

  // ---- Layer masks ---------------------------------------------------------
  // Which surface paint tools target on the active layer (mirrors engine state,
  // for the Layers panel ring + the options-bar indicator).
  const [paintSurface, setPaintSurface] = useState<ActiveSurface>("pixels");
  // Re-sync the displayed surface whenever the active layer (or doc) changes.
  useEffect(() => {
    const id = active.activeLayerId;
    setPaintSurface(id ? (paintRef.current?.getActiveSurface(id) ?? "pixels") : "pixels");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.activeLayerId, activeId]);

  const chooseSurface = (layerId: string, surface: ActiveSurface) => {
    paintRef.current?.setActiveSurface(layerId, surface);
    setPaintSurface(paintRef.current?.getActiveSurface(layerId) ?? "pixels");
  };

  const addMaskOp = (init: "reveal" | "hide" | "selection") => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.mask) return; // one mask per layer; never stack
    if (init === "selection" && !d.selection.length) {
      showToast("Make a selection first to create a mask from it.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: { enabled: true, linked: true } });
    eng.allocMask(layerId, init, init === "selection" ? d.selection : null, d.selectionAngle, d.selectionPivot);
    const snap = eng.captureMask(layerId);
    setDocSel(docId, after, sel);
    eng.setActiveSurface(layerId, "mask");
    setPaintSurface("mask");
    eng.pushStructural(
      "Add Layer Mask",
      () => {
        eng.freeMask(layerId);
        setDocSel(docId, before, sel);
        setPaintSurface("pixels");
      },
      () => {
        if (snap) eng.restoreMask(layerId, snap);
        setDocSel(docId, after, sel);
      },
    );
  };

  const removeMaskOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node?.mask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: undefined });
    const snap = eng.captureMask(layerId);
    eng.freeMask(layerId);
    setDocSel(docId, after, sel);
    setPaintSurface("pixels");
    eng.pushStructural(
      "Delete Layer Mask",
      () => {
        if (snap) eng.restoreMask(layerId, snap);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.freeMask(layerId);
        setDocSel(docId, after, sel);
      },
    );
  };

  const applyMaskOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node?.mask) return;
    if (!node.mask.enabled) {
      showToast("Enable the mask before applying.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: undefined });
    const layerBefore = eng.captureLeaves([layerId]); // pixels + mask grayscale
    eng.applyMaskToLayer(layerId); // bake mask into the layer, then free it
    const layerAfter = eng.captureLeaves([layerId]); // baked pixels, no mask
    setDocSel(docId, after, sel);
    setPaintSurface("pixels");
    eng.pushStructural(
      "Apply Layer Mask",
      () => {
        eng.restoreLeaves(layerBefore);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.restoreLeaves(layerAfter);
        setDocSel(docId, after, sel);
      },
    );
  };

  const toggleMaskMeta = (layerId: string, patch: Partial<MaskMeta>, label: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, layerId);
    if (!eng || !node?.mask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { mask: { ...node.mask, ...patch } });
    setDocSel(docId, after, sel);
    eng.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  // ---- Filter mask (Spec 07 addendum): confines a node's smart-filter stack ----
  const addFilterMaskOp = (layerId: string, init: "reveal" | "hide" | "selection" = "reveal") => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.type === "adjustment" || node.filterMask) return;
    if (!node.filters?.length) {
      showToast("Add a smart filter first — the filter mask confines the stack.");
      return;
    }
    if (init === "selection" && !d.selection.length) {
      showToast("Make a selection first to create a mask from it.");
      return;
    }
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: { enabled: true, linked: true } });
    const key = filterMaskKey(layerId);
    eng.allocMask(key, init, init === "selection" ? d.selection : null, d.selectionAngle, d.selectionPivot);
    const snap = eng.captureMask(key);
    setDocSel(docId, after, sel);
    eng.setActiveSurface(layerId, "filterMask");
    setPaintSurface("filterMask");
    eng.pushStructural(
      "Add Filter Mask",
      () => {
        eng.freeMask(key);
        setDocSel(docId, before, sel);
        setPaintSurface("pixels");
      },
      () => {
        if (snap) eng.restoreMask(key, snap);
        setDocSel(docId, after, sel);
      },
    );
  };

  const removeFilterMaskOp = (layerId: string) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng || !layerId) return;
    const node = findNode(d.layers, layerId);
    if (!node || node.type === "adjustment" || !node.filterMask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: undefined });
    const key = filterMaskKey(layerId);
    const snap = eng.captureMask(key);
    eng.freeMask(key); // also resets a "filterMask" active surface to pixels
    setDocSel(docId, after, sel);
    setPaintSurface(eng.getActiveSurface(layerId));
    eng.pushStructural(
      "Delete Filter Mask",
      () => {
        if (snap) eng.restoreMask(key, snap);
        setDocSel(docId, before, sel);
      },
      () => {
        eng.freeMask(key);
        setDocSel(docId, after, sel);
      },
    );
  };

  const setFilterMaskEnabled = (layerId: string, enabled: boolean) => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const node = findNode(d.layers, layerId);
    if (!eng || !node || node.type === "adjustment" || !node.filterMask) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, layerId, { filterMask: { ...node.filterMask, enabled } });
    setDocSel(docId, after, sel);
    eng.pushStructural(
      enabled ? "Enable Filter Mask" : "Disable Filter Mask",
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  const loadMaskAsSelectionOp = () => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    const layerId = d.activeLayerId;
    if (!eng || !layerId) return;
    if (!findNode(d.layers, layerId)?.mask) return;
    commitSelection("Load Mask as Selection", eng.maskSelectionRects(layerId), 0, null);
  };

  // ---- Adjustment layers (non-destructive) ---------------------------------
  const adjSeqRef = useRef(0);
  // Live param-edit session: one undoable step per drag gesture (debounced).
  const adjEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const adjEditTimer = useRef(0);

  const commitAdjustEdit = () => {
    const sess = adjEditRef.current;
    adjEditRef.current = null;
    if (adjEditTimer.current) {
      window.clearTimeout(adjEditTimer.current);
      adjEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Adjustment",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Insert an adjustment layer above the active layer (same parent); mask it from
  // the current selection if one exists, then select it so the panel binds live.
  const addAdjustmentOp = (
    typeId: string,
    fromPreset?: string,
    params?: Adjustments,
    explicitSpec?: AdjustmentSpec,
  ): string | null => {
    const eng = paintRef.current;
    const d = activeDocRef.current;
    if (!eng) return null;
    commitAdjustEdit();
    const docId = d.id;
    const selBefore = selNow();
    const before = d.layers;
    const id = `adj-${(adjSeqRef.current += 1)}`;
    const spec: AdjustmentSpec = explicitSpec
      ? explicitSpec
      : params
        ? { type: "sliders", params }
        : fromPreset
          ? specFromPreset(fromPreset)
          : specFromType(typeId);
    const node: LayerAdjustment = {
      id,
      type: "adjustment",
      name: fromPreset ?? specLabel(spec),
      visible: true,
      opacity: 100,
      blend: "Normal",
      adjustment: spec,
      clipped: false,
    };
    const anchor = d.activeLayerId ? findNode(before, d.activeLayerId) : null;
    let after: LayerNode[];
    if (anchor && anchor.type === "group") after = insertInGroup(before, node, anchor.id);
    else if (anchor) after = insertRelative(before, node, anchor.id, true);
    else after = [node, ...before];
    const hasSel = d.selection.length > 0;
    if (hasSel) {
      after = updateNode(after, id, { mask: { enabled: true, linked: true } });
      eng.allocMask(id, "selection", d.selection, d.selectionAngle, d.selectionPivot);
    }
    const maskSnap = hasSel ? eng.captureMask(id) : null;
    setDocSel(docId, after, single(id));
    eng.pushStructural(
      "New Adjustment Layer",
      () => {
        if (hasSel) eng.freeMask(id);
        setDocSel(docId, before, selBefore);
      },
      () => {
        if (maskSnap) eng.restoreMask(id, maskSnap);
        setDocSel(docId, after, single(id));
      },
    );
    return id;
  };

  // Live param edit from the panel (no per-tick history; one step per gesture).
  const editAdjustmentParams = (patch: Partial<Adjustments>) => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id) return;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "adjustment" || node.adjustment.type !== "sliders") return;
    if (!adjEditRef.current || adjEditRef.current.layerId !== id) {
      commitAdjustEdit();
      adjEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    const spec: AdjustmentSpec = {
      type: "sliders",
      params: { ...node.adjustment.params, ...patch },
    };
    setDocSel(d.id, updateNode(d.layers, id, { adjustment: spec }), selNow());
    if (adjEditTimer.current) window.clearTimeout(adjEditTimer.current);
    adjEditTimer.current = window.setTimeout(commitAdjustEdit, 500); // gesture-end commit
  };

  // Clip / release a layer (any kind) to the layer directly below it — a cheap,
  // pixel-free structural step.
  const setClippedOp = (id: string, clipped: boolean) => {
    const d = activeDocRef.current;
    const node = findNode(d.layers, id);
    if (!node || !!node.clipped === clipped) return;
    commitAdjustEdit();
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { clipped });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      clipped ? "Create Clipping Mask" : "Release Clipping Mask",
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };
  // Toggle the active layer's clip (menu / Ctrl+Alt+G).
  const toggleClippingMask = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id) return;
    const node = findNode(d.layers, id);
    if (node) setClippedOp(id, !node.clipped);
  };

  /** Active node if it's an adjustment layer (drives the panel's edit mode). */
  const activeAdjustment = activeLeafNode?.type === "adjustment" ? activeLeafNode : null;
  // The slider-bundle spec of the active adjustment (Curves/Levels are edited in
  // their own dialogs, not the slider panel).
  const sliderSpec =
    activeAdjustment && activeAdjustment.adjustment.type === "sliders" ? activeAdjustment.adjustment : null;

  // ---- Curves & Levels (tone) ----------------------------------------------
  type ToneEdit =
    | { mode: "node"; tool: "curves" | "levels"; layerId: string }
    | { mode: "dest"; tool: "curves" | "levels"; layerId: string; spec: ToneAdjustment };
  const [toneEdit, setToneEdit] = useState<ToneEdit | null>(null);
  const [toneHist, setToneHist] = useState<ChannelHistogram | null>(null);
  const [tonePick, setTonePick] = useState<EyedropKind | null>(null);
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

  // Live-edit an adjustment NODE's spec (debounced one-step structural history).
  // Shared by the tone dialogs and the extra-adjustment dialog.
  const setToneNodeSpec = (layerId: string, spec: AdjustmentSpec) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, layerId)) return;
    if (!adjEditRef.current || adjEditRef.current.layerId !== layerId) {
      commitAdjustEdit();
      adjEditRef.current = { layerId, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, layerId, { adjustment: spec }), selNow());
    if (adjEditTimer.current) window.clearTimeout(adjEditTimer.current);
    adjEditTimer.current = window.setTimeout(commitAdjustEdit, 500);
  };

  const addToneAdjustment = (tool: "curves" | "levels") => {
    const spec = tool === "curves" ? defaultCurves() : defaultLevels();
    const id = addAdjustmentOp("", undefined, undefined, spec);
    if (id) setToneEdit({ mode: "node", tool, layerId: id });
  };
  const editToneNode = (id: string) => {
    const n = findNode(activeDocRef.current.layers, id);
    if (n?.type !== "adjustment") return;
    const t = n.adjustment.type;
    if (t === "curves" || t === "levels") setToneEdit({ mode: "node", tool: t, layerId: id });
  };

  // ---- Extra adjustment layers (Hue/Sat, Selective, Mixer, Gradient Map,
  //      Color Lookup, Invert, Equalize) --------------------------------------
  const [extraEdit, setExtraEdit] = useState<{ layerId: string } | null>(null);
  const extraSpec: ExtraAdjustment | null = (() => {
    if (!extraEdit) return null;
    const n = findNode(active.layers, extraEdit.layerId);
    return n?.type === "adjustment" && isExtraSpec(n.adjustment) ? n.adjustment : null;
  })();
  // Where a picked .cube lands: a new layer, or an existing node's spec.
  const cubeInputRef = useRef<HTMLInputElement>(null);
  const cubeTargetRef = useRef<"new" | string | null>(null);
  // Export the current adjustments AS a .cube LUT (File menu / Adjustments panel).
  const [lutExportOpen, setLutExportOpen] = useState(false);
  const [hdrMergeOpen, setHdrMergeOpen] = useState(false);
  const [hdrToneOpen, setHdrToneOpen] = useState(false);
  const [hdrExportOpen, setHdrExportOpen] = useState(false);

  const addExtraAdjustment = (type: string) => {
    if (type === "colorlookup") {
      cubeTargetRef.current = "new";
      cubeInputRef.current?.click();
      return;
    }
    if (!(type in EXTRA_LABELS)) return;
    const spec = defaultExtra(type as Exclude<ExtraAdjustmentType, "colorlookup">);
    const id = addAdjustmentOp("", undefined, undefined, spec);
    // Parameterized kinds open their editor right away; invert/equalize are done.
    if (id && (type === "huesat" || type === "selective" || type === "chanmix" || type === "gradientmap"))
      setExtraEdit({ layerId: id });
  };

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
  const openDestructiveTone = (tool: "curves" | "levels") => {
    if (!activeLeafId) {
      showToast("Select a pixel layer first.");
      return;
    }
    setToneEdit({ mode: "dest", tool, layerId: activeLeafId, spec: tool === "curves" ? defaultCurves() : defaultLevels() });
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toneKey]);

  // ---- Layer effects (styles) ----------------------------------------------
  const [layerStyleTarget, setLayerStyleTarget] = useState<string | null>(null);
  const [fxClipboard, setFxClipboard] = useState<LayerEffects | null>(null);
  // Live FX-edit session: one undoable step per drag gesture (debounced).
  const fxEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const fxEditTimer = useRef(0);

  const commitFxEdit = () => {
    const sess = fxEditRef.current;
    fxEditRef.current = null;
    if (fxEditTimer.current) {
      window.clearTimeout(fxEditTimer.current);
      fxEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Layer Style",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Live FX edit from the dialog (no per-tick history; one step per gesture).
  const setLayerEffectsOp = (id: string, effects: LayerEffects) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    if (!fxEditRef.current || fxEditRef.current.layerId !== id) {
      commitFxEdit();
      fxEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, id, { effects }), selNow());
    if (fxEditTimer.current) window.clearTimeout(fxEditTimer.current);
    fxEditTimer.current = window.setTimeout(commitFxEdit, 500);
  };

  // Discrete structural FX op (toggle / paste / clear / open) — one history step.
  const fxStructural = (id: string, effects: LayerEffects | undefined, label: string) => {
    commitFxEdit();
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { effects });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  const toggleEffectOp = (id: string, key: FxKey, enabled: boolean) => {
    const node = findNode(activeDocRef.current.layers, id);
    if (!node) return;
    const cur = node.effects ?? {};
    const existing = cur[key];
    const eff = existing ? { ...existing, enabled } : { ...DEFAULT_FX[key](), enabled };
    fxStructural(id, { ...cur, [key]: eff } as LayerEffects, enabled ? "Enable Effect" : "Disable Effect");
  };

  const copyLayerStyleOp = (id: string) => {
    const fx = findNode(activeDocRef.current.layers, id)?.effects;
    setFxClipboard(fx ? structuredClone(fx) : null);
  };
  const pasteLayerStyleOp = (id: string) => {
    if (!fxClipboard) return;
    fxStructural(id, structuredClone(fxClipboard), "Paste Layer Style");
  };
  const clearLayerStyleOp = (id: string) => fxStructural(id, undefined, "Clear Layer Style");

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
  const [filterTarget, setFilterTarget] = useState<string | null>(null);
  // Live filter-edit session: one undoable step per drag gesture (debounced).
  const filterEditRef = useRef<{ layerId: string; beforeTree: LayerNode[]; selBefore: Sel } | null>(null);
  const filterEditTimer = useRef(0);

  const commitFilterEdit = () => {
    const sess = filterEditRef.current;
    filterEditRef.current = null;
    if (filterEditTimer.current) {
      window.clearTimeout(filterEditTimer.current);
      filterEditTimer.current = 0;
    }
    if (!sess) return;
    const docId = activeIdRef.current;
    const afterTree = activeDocRef.current.layers;
    const after = selNow();
    paintRef.current?.pushStructural(
      "Edit Smart Filter",
      () => setDocSel(docId, sess.beforeTree, sess.selBefore),
      () => setDocSel(docId, afterTree, after),
    );
  };

  // Live param edit from the dialog (no per-tick history; one step per gesture).
  const setFiltersLive = (id: string, filters: SmartFilter[]) => {
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    if (!filterEditRef.current || filterEditRef.current.layerId !== id) {
      commitFilterEdit();
      filterEditRef.current = { layerId: id, beforeTree: d.layers, selBefore: selNow() };
    }
    setDocSel(d.id, updateNode(d.layers, id, { filters }), selNow());
    if (filterEditTimer.current) window.clearTimeout(filterEditTimer.current);
    filterEditTimer.current = window.setTimeout(commitFilterEdit, 500);
  };

  // Discrete structural filter op (add / toggle / reorder / remove / clear).
  const setFiltersOp = (id: string, filters: SmartFilter[] | undefined, label: string) => {
    commitFilterEdit();
    const d = activeDocRef.current;
    if (!findNode(d.layers, id)) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    const after = updateNode(before, id, { filters });
    setDocSel(docId, after, sel);
    paintRef.current?.pushStructural(
      label,
      () => setDocSel(docId, before, sel),
      () => setDocSel(docId, after, sel),
    );
  };

  const openFiltersOp = (id: string) => {
    selectLayer(id, "replace");
    setFilterTarget(id);
  };

  // Menu entry: append a default filter of `type` and open the stack dialog.
  const addFilterOp = (type: FilterType) => {
    const id = activeDocRef.current.activeLayerId;
    if (!id) return;
    const node = findNode(activeDocRef.current.layers, id);
    if (!node || node.type === "adjustment") return;
    const f = defaultFilter(type);
    setFiltersOp(id, [...(node.filters ?? []), f], `Add ${filterLabel(f)}`);
    openFiltersOp(id);
  };

  // Edit ▸ Content-Aware Fill: synthesize the selection from its surroundings.
  const contentAwareFillOp = () => {
    const d = activeDocRef.current;
    const id = d.activeLayerId;
    if (!id || !d.selection.length) return;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "layer") return;
    paintRef.current?.contentAwareFill(id, d.selection, d.selectionAngle, d.selectionPivot);
  };

  // Bake the stack into the layer's pixels: one combined pixel+structural step.
  const applyFiltersOp = (id: string) => {
    commitFilterEdit();
    const d = activeDocRef.current;
    const node = findNode(d.layers, id);
    if (!node || node.type !== "layer" || !node.filters?.length) return;
    const docId = d.id;
    const sel = selNow();
    const before = d.layers;
    // Baking consumes the filter mask too — it shaped the baked pixels.
    const after = updateNode(before, id, { filters: undefined, filterMask: undefined });
    const eng = paintRef.current;
    const key = filterMaskKey(id);
    const fmSnap = node.filterMask ? (eng?.captureMask(key) ?? null) : null;
    setDocSel(docId, after, sel);
    eng?.applySmartFilters(
      id,
      node.filters,
      {
        undo: () => {
          if (fmSnap) eng.restoreMask(key, fmSnap);
          setDocSel(docId, before, sel);
        },
        redo: () => {
          eng.freeMask(key);
          setDocSel(docId, after, sel);
        },
      },
      !!node.filterMask?.enabled,
    );
    eng?.freeMask(key);
    setFilterTarget(null);
  };
  const openLayerStyleOp = (id: string) => {
    selectLayer(id, "replace");
    setLayerStyleTarget(id);
  };
  // Add an effect (default params) and open the dialog to it.
  const addEffectOp = (key: FxKey) => {
    const id = activeDocRef.current.activeLayerId;
    if (!id) return;
    const node = findNode(activeDocRef.current.layers, id);
    if (!node || node.type === "adjustment") return; // adjustments carry no fill to style
    const cur = node.effects ?? {};
    fxStructural(id, { ...cur, [key]: DEFAULT_FX[key]() } as LayerEffects, "Add Layer Effect");
    setLayerStyleTarget(id);
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
      color: t.color,
      antialias: t.antialias,
      runs: p.runs,
    };
  };
  const textVectorOf = (spec: TextRenderSpec): VectorText => ({
    type: "text",
    ...spec,
    bbox: paintRef.current?.textBounds(spec) ?? { x: spec.x, y: spec.y, w: 0, h: 0 },
  });
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

  const removeSelected = () => {
    const before = active.layers;
    const ids = new Set(targetIds());
    if (!ids.size) return;
    const after = removeMany(before, ids);
    const next = collectLeafIds(after)[0] ?? null;
    commitLayerChange(
      ids.size > 1 ? "Delete Layers" : "Delete Layer",
      before,
      selNow(),
      after,
      single(next),
    );
  };

  const duplicateSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    let after = before;
    const pairs: [string, string][] = [];
    const newIds: string[] = [];
    for (const top of tops) {
      const { node: clone, leafPairs } = cloneSubtree(top, nextLeafId);
      const named = { ...clone, name: `${top.name} copy` } as LayerNode;
      after = insertRelative(after, named, top.id, true);
      pairs.push(...leafPairs);
      newIds.push(named.id);
    }
    commitLayerChange(
      tops.length > 1 ? "Duplicate Layers" : "Duplicate Layer",
      before,
      selNow(),
      after,
      { active: newIds[0], selected: newIds },
      () => pairs.forEach(([from, to]) => paintRef.current?.duplicateLayer(from, to)),
    );
  };

  const groupSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (!tops.length) return;
    const gid = `grp-${(layerSeqRef.current += 1)}`;
    const group: LayerGroup = {
      id: gid,
      type: "group",
      name: "Group",
      visible: true,
      opacity: 100,
      blend: "Normal",
      expanded: true,
      children: tops,
    };
    const rest = new Set(tops.slice(1).map((n) => n.id));
    const after = replaceNodeWith(removeMany(before, rest), tops[0].id, group);
    commitLayerChange("Group Layers", before, selNow(), after, single(gid));
  };

  const ungroupLayerOp = (id: string) => {
    const before = active.layers;
    const node = findNode(before, id);
    if (!node || node.type !== "group") return;
    const after = ungroupNode(before, id);
    commitLayerChange("Ungroup", before, selNow(), after, single(node.children[0]?.id ?? null));
  };

  const mergeDownOp = (id: string) => {
    const before = active.layers;
    const tid = nextLeafId();
    const res = mergeDownInTree(before, id, (_top, b) => ({
      id: tid,
      type: "layer",
      name: b.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    }));
    if (!res.top || !res.bottom) return; // nothing below it at this level
    const top = res.top;
    const bottom = res.bottom;
    commitLayerChange("Merge Down", before, selNow(), res.tree, single(tid), () => {
      paintRef.current?.rasterize(tid, [top, bottom], collectLeafIds([top, bottom]));
    });
  };

  const mergeSelected = () => {
    const before = active.layers;
    const tops = topLevelSelected(before, new Set(targetIds()));
    if (tops.length <= 1) {
      if (tops.length === 1) mergeDownOp(tops[0].id); // single → merge down
      return;
    }
    const tid = nextLeafId();
    const bottommost = tops[tops.length - 1];
    const others = new Set(tops.slice(0, -1).map((n) => n.id));
    const merged: Layer = {
      id: tid,
      type: "layer",
      name: bottommost.name,
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const after = replaceNodeWith(removeMany(before, others), bottommost.id, merged);
    const leafIds = collectLeafIds(tops);
    commitLayerChange("Merge Layers", before, selNow(), after, single(tid), () => {
      paintRef.current?.rasterize(tid, tops, leafIds);
    });
  };

  const flattenImage = () => {
    const before = active.layers;
    if (before.length === 0) return;
    const tid = nextLeafId();
    const flat: Layer = {
      id: tid,
      type: "layer",
      name: "Flattened",
      visible: true,
      opacity: 100,
      blend: "Normal",
    };
    const all = collectLeafIds(before);
    commitLayerChange("Flatten Image", before, selNow(), [flat], single(tid), () => {
      paintRef.current?.rasterize(tid, before, all);
    });
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
    remove: removeSelected,
    duplicate: duplicateSelected,
    group: groupSelected,
    ungroup: ungroupLayerOp,
    merge: mergeSelected,
    flatten: flattenImage,
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

  // Copy the composite within the selection (or whole canvas) to the clipboard.
  const copySelection = () => {
    const d = activeDocRef.current;
    const res = paintRef.current?.copyRegion(
      selRef.current.length ? selRef.current : null,
      d.selectionAngle,
      d.selectionPivot,
    );
    if (!res) return;
    clipboardRef.current = res.canvas;
    copyOriginRef.current = { x: res.x, y: res.y };
    copyDocIdRef.current = activeIdRef.current;
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      res.canvas.toBlob((blob) => {
        if (!blob) return;
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {});
      });
    }
  };

  // Cut: copy the selection to the clipboard, then erase it from the active layer
  // (recorded as an undoable "Cut" history step). Needs a selection + a layer.
  const cutSelection = () => {
    if (!selRef.current.length || !activeLayerRef.current) return;
    commitFloatIfAny(); // merge any floating paste before cutting
    copySelection();
    const d = activeDocRef.current;
    paintRef.current?.eraseSelection(
      activeLayerRef.current,
      selRef.current,
      d.selectionAngle,
      d.selectionPivot,
      "Cut",
      selectionFeatherRef.current,
    );
  };

  // Place a pasted image. Reads active-doc refs so it works from the paste
  // listener too. `posX/posY` override the default (centred) placement.
  const doPaste = (
    source: ImageBitmap | HTMLCanvasElement,
    imgW: number,
    imgH: number,
    dest: PasteDest,
    expand: boolean,
    posX?: number,
    posY?: number,
  ) => {
    setTool("move"); // ready to reposition the pasted content
    if (dest === "new-canvas") {
      const seq = (seqRef.current += 1);
      const lseq = (layerSeqRef.current += 1);
      const docId = `doc-${seq}`;
      const layerId = `layer-${lseq}`;
      const layer: Layer = { id: layerId, type: "layer", name: "Pasted Layer", visible: true, opacity: 100, blend: "Normal" };
      setDocs((ds) => [
        ...ds,
        { id: docId, name: `Untitled-${seq}`, width: imgW, height: imgH, dpi: prefsRef.current.defaultDpi, layers: [layer], activeLayerId: layerId, selectedLayerIds: [layerId], selection: [], selectionAngle: 0, selectionPivot: null },
      ]);
      setActiveId(docId);
      setPendingPaste({ docId, layerId, source, x: 0, y: 0 });
      return;
    }

    const act = activeDocRef.current;
    const docId = activeIdRef.current;
    const beforeW = act.width;
    const beforeH = act.height;
    const beforeActive = act.activeLayerId;
    const finalW = expand ? Math.max(beforeW, imgW) : beforeW;
    const finalH = expand ? Math.max(beforeH, imgH) : beforeH;
    let layerId = act.activeLayerId;
    let added: Layer | null = null;
    if (dest === "new-layer" || !layerId) {
      const lseq = (layerSeqRef.current += 1);
      layerId = `layer-${lseq}`;
      added = {
        id: layerId,
        type: "layer",
        name: dest === "new-layer" ? "Pasted Layer" : `Layer ${lseq}`,
        visible: true,
        opacity: 100,
        blend: "Normal",
      };
    }
    const lid = layerId;
    const addedLayer = added;
    setDocs((ds) =>
      ds.map((d) =>
        d.id === docId
          ? {
              ...d,
              width: finalW,
              height: finalH,
              layers: addedLayer ? [addedLayer, ...d.layers] : d.layers,
              activeLayerId: lid,
              selectedLayerIds: lid ? [lid] : d.selectedLayerIds,
            }
          : d,
      ),
    );
    // Fold the layer addition + canvas resize into the paste's single undo step.
    const structural = addedLayer !== null || finalW !== beforeW || finalH !== beforeH;
    const side = structural
      ? {
          undo: () =>
            setDocs((ds) =>
              ds.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      width: beforeW,
                      height: beforeH,
                      layers: addedLayer ? d.layers.filter((l) => l.id !== addedLayer.id) : d.layers,
                      activeLayerId:
                        addedLayer && d.activeLayerId === addedLayer.id ? beforeActive : d.activeLayerId,
                      selectedLayerIds:
                        addedLayer && d.activeLayerId === addedLayer.id
                          ? beforeActive
                            ? [beforeActive]
                            : []
                          : d.selectedLayerIds,
                    }
                  : d,
              ),
            ),
          redo: () =>
            setDocs((ds) =>
              ds.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      width: finalW,
                      height: finalH,
                      layers: addedLayer
                        ? [addedLayer, ...d.layers.filter((l) => l.id !== addedLayer.id)]
                        : d.layers,
                      activeLayerId: lid,
                      selectedLayerIds: lid ? [lid] : d.selectedLayerIds,
                    }
                  : d,
              ),
            ),
        }
      : undefined;
    const x = posX !== undefined ? posX : Math.round((finalW - imgW) / 2);
    const y = posY !== undefined ? posY : Math.round((finalH - imgH) / 2);
    // Pasting onto the current layer floats above it (movable, merges on deselect);
    // a new layer just bakes the image in.
    const float = dest === "current-layer";
    if (float) setSelection([{ x, y, w: imgW, h: imgH }]);
    setPendingPaste({ docId, layerId: lid, source, x, y, side, float });
  };

  const applyPaste = (opts: { dest: PasteDest; expand: boolean }) => {
    if (!pasteSrc) return;
    doPaste(pasteSrc.source, pasteSrc.w, pasteSrc.h, opts.dest, opts.expand);
    setPasteSrc(null);
  };

  // New canvas — the New Document dialog, or the stored default size.
  const createDoc = (opts?: { name?: string; width?: number; height?: number; dpi?: number }) => {
    const seq = (seqRef.current += 1);
    const p = prefsRef.current;
    const d = makeDoc(
      seq,
      { w: opts?.width ?? p.newDocWidth, h: opts?.height ?? p.newDocHeight },
      opts?.dpi ?? p.defaultDpi,
    );
    if (opts?.name) d.name = opts.name;
    setDocs((ds) => [...ds, d]);
    setActiveId(d.id);
    setNewDocOpen(false);
  };
  // File ▸ New / the tab-strip "+": dialog by default, instant with the stored
  // defaults when the "ask" preference is off.
  const [newDocOpen, setNewDocOpen] = useState(false);
  const requestNewDoc = () => {
    if (prefsRef.current.newDocAsk) setNewDocOpen(true);
    else createDoc();
  };

  const closeDoc = (id: string) => {
    if (docs.length <= 1) return; // always keep one canvas open
    const idx = docs.findIndex((d) => d.id === id);
    const next = docs.filter((d) => d.id !== id);
    setDocs(next);
    docJsonCache.current.delete(id);
    if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)].id);
  };

  const renameDoc = (id: string, name: string) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, name } : d)));
  };

  const doUndo = () => {
    if (paintRef.current?.isFloating()) {
      // A floating paste/move isn't committed yet — undo cancels it.
      paintRef.current.discardFloat();
      setSelection([]);
      return;
    }
    // A live adjustment session is finalized inside the engine's jumpTo, so
    // undo steps over it as one "Adjustments" entry.
    paintRef.current?.undo();
  };
  const doRedo = () => paintRef.current?.redo();

  // ---- Project save (.gproj — layers, groups & full state) ----
  // Serialize ANY open document to `.gproj` JSON. The engine keeps every
  // materialized document's layer + mask canvases (globally-unique ids, sized
  // per-document), so pixels resolve for inactive tabs too — which is what
  // lets autosave snapshot all of them. History labels are engine-global, so
  // only the active document carries them (the rest get empty display-only
  // metadata; the undo stack was never file-replayable regardless).
  const serializeDocToJSON = (d: Doc): string => {
    const isActive = d.id === activeIdRef.current;
    const project = serializeProject(
      {
        name: d.name,
        width: d.width,
        height: d.height,
        dpi: d.dpi,
        layers: d.layers,
        activeLayerId: d.activeLayerId,
        selectedLayerIds: d.selectedLayerIds,
        selection: d.selection,
        metadata: d.metadata ?? null,
        paths: d.paths ?? [],
      },
      { foreground: fgRef.current, background: bgRef.current },
      isActive
        ? { labels: historyRef.current.items.map((i) => i.label), index: historyRef.current.index }
        : { labels: [], index: 0 },
      (id) => paintRef.current?.getLayerImage(id) ?? null,
      (id) => paintRef.current?.getMaskImage(id) ?? null,
    );
    return JSON.stringify(project);
  };
  // Reads from refs so it also works from the one-time keydown listener.
  const buildProjectBlob = (): Blob =>
    new Blob([serializeDocToJSON(activeDocRef.current)], { type: "application/json" });

  // ---- Autosave / crash recovery + the status bar's save indicator ----------
  const [saveState, setSaveState] = useState<{ label: string; ok: boolean }>({
    label: "Not saved",
    ok: false,
  });
  const autosaveDirtyRef = useRef(false); // history moved since the last write
  const [restoreSnap, setRestoreSnap] = useState<AutosaveSnapshot | null>(null);
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
  }, [activeId]);

  // Heartbeat: detect an unclean exit and offer the last snapshot for restore.
  useEffect(() => {
    const unclean = wasUncleanExit();
    markSessionAlive();
    const onHide = () => markSessionClean();
    window.addEventListener("pagehide", onHide);
    if (unclean) void readAutosave().then((s) => s && setRestoreSnap(s));
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // Periodic snapshot of ALL open documents (only when something changed since
  // the last write). Refreshes the active document from the engine, keeps the
  // cached JSON for the rest, prunes closed tabs, and writes them in tab order.
  useEffect(() => {
    const mins = prefs.autosaveMinutes;
    if (!mins) return;
    const id = window.setInterval(async () => {
      if (!autosaveDirtyRef.current) return;
      try {
        const docsNow = docsRef.current;
        const active = activeDocRef.current;
        docJsonCache.current.set(active.id, { json: serializeDocToJSON(active), name: active.name });
        const openIds = new Set(docsNow.map((d) => d.id));
        for (const k of [...docJsonCache.current.keys()]) if (!openIds.has(k)) docJsonCache.current.delete(k);
        const entries: AutosaveDoc[] = [];
        let activeIndex = 0;
        for (const d of docsNow) {
          const cached = docJsonCache.current.get(d.id);
          if (!cached) continue;
          if (d.id === active.id) activeIndex = entries.length;
          entries.push(cached);
        }
        if (!entries.length) return;
        await writeAutosave({ docs: entries, activeIndex, savedAt: Date.now() });
        autosaveDirtyRef.current = false;
        setSaveState({
          label: `Autosaved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          ok: true,
        });
      } catch {
        /* serialization/storage hiccup — try again next tick */
      }
    }, mins * 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.autosaveMinutes]);

  // "Reduce motion" preference -> data-motion on <html> (globals.scss kills
  // animations/transitions under [data-motion="off"], like the OS setting).
  useEffect(() => {
    document.documentElement.setAttribute("data-motion", prefs.reduceMotion ? "off" : "on");
  }, [prefs.reduceMotion]);

  // Render-cache budget preference -> engine LRU limit (evicts when shrunk).
  useEffect(() => {
    paintRef.current?.setRenderCacheBudget(prefs.cacheBudgetMB);
  }, [prefs.cacheBudgetMB]);

  // Undo-step cap -> engine history trim (oldest steps drop first).
  useEffect(() => {
    paintRef.current?.setHistoryLimit(prefs.historyLimit);
  }, [prefs.historyLimit]);

  // Background-worker toggle -> engine compute paths + the RAW decoder.
  useEffect(() => {
    paintRef.current?.setWorkersEnabled(prefs.useWorkers);
    setRawWorkerEnabled(prefs.useWorkers);
  }, [prefs.useWorkers]);

  // Recent-files length -> the recents store's post-add trim.
  useEffect(() => {
    setRecentsLimit(prefs.recentsLimit);
  }, [prefs.recentsLimit]);

  const markSaved = (label: string) => {
    autosaveDirtyRef.current = false;
    setSaveState({ label, ok: true });
  };

  // Simple Save: download the project under the canvas's current name.
  const saveProject = () => {
    const filename = `${activeDocRef.current.name}.${PROJECT_EXT}`;
    const blob = buildProjectBlob();
    downloadBlob(blob, filename);
    addRecent(filename, { blob }); // remember a re-openable cached copy
    markSaved("Saved");
  };

  // Save As: pick a name (dialog) then choose folder/path via the native picker.
  const saveProjectAs = async (filename: string) => {
    const base =
      filename.replace(new RegExp(`\\.(${PROJECT_EXT}|${LEGACY_PROJECT_EXT})$`, "i"), "").trim() ||
      activeDocRef.current.name;
    const docId = activeIdRef.current;
    const blob = buildProjectBlob();
    const fname = `${base}.${PROJECT_EXT}`;
    const { ok, handle } = await saveProjectFile(blob, fname);
    if (ok) {
      renameDoc(docId, base); // reflect the saved name on the tab
      addRecent(fname, handle ? { handle } : { blob });
      setSaveAsOpen(false);
      markSaved("Saved");
    }
  };

  // ---- Project open / load ----
  const openFileDialog = () => fileInputRef.current?.click();

  // Open via the native picker (gives a re-openable handle) when available,
  // otherwise fall back to a hidden <input type=file>.
  const openProject = async () => {
    const picker = (
      window as unknown as {
        showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile: () => Promise<File>; name: string }>>;
      }
    ).showOpenFilePicker;
    if (!picker) {
      openFileDialog();
      return;
    }
    try {
      const [handle] = await picker({
        multiple: false,
        types: [
          {
            description: "Graphiq Project",
            accept: { "application/json": [`.${PROJECT_EXT}`, `.${LEGACY_PROJECT_EXT}`] },
          },
        ],
      });
      const file = await handle.getFile();
      if (loadProjectText(await file.text())) addRecent(file.name, { handle });
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") window.alert("Couldn't open the file.");
    }
  };

  // Rebuild a document from a parsed .gproj file. Layer ids are remapped to fresh
  // ones so a loaded project never collides with already-open documents.
  const loadProject = (p: ProjectFile, activate = true): string => {
    commitFloatIfAny(); // merge any floating paste on the current doc first
    const idMap = new Map<string, string>();
    const images: { id: string; data: string }[] = [];
    const masks: { id: string; data: string }[] = [];
    const remap = (list: SerializedNode[]): LayerNode[] =>
      list.map((n) => {
        const mask = n.mask ? { mask: { enabled: n.mask.enabled, linked: n.mask.linked } } : {};
        const fx = n.effects ? { effects: n.effects } : {};
        const clip = n.clipped ? { clipped: true } : {};
        const flt = n.filters?.length ? { filters: n.filters } : {};
        const lbl = n.label ? { label: n.label } : {}; // v10 colour label
        // v8: filter mask meta + grayscale (restored under filterMaskKey(new id)).
        const fmMeta =
          n.type !== "adjustment" && n.filterMask
            ? { filterMask: { enabled: n.filterMask.enabled, linked: n.filterMask.linked } }
            : {};
        const pushFm = (id: string) => {
          if (n.type !== "adjustment" && n.filterMaskImage)
            masks.push({ id: filterMaskKey(id), data: n.filterMaskImage });
        };
        if (n.type === "group") {
          const id = `grp-${(layerSeqRef.current += 1)}`;
          idMap.set(n.id, id);
          if (n.maskImage) masks.push({ id, data: n.maskImage });
          pushFm(id);
          return {
            id,
            type: "group",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            expanded: n.expanded,
            ...mask,
            ...fx,
            ...clip,
            ...flt,
            ...fmMeta,
            ...lbl,
            children: remap(n.children),
          };
        }
        if (n.type === "adjustment") {
          const id = `adj-${(adjSeqRef.current += 1)}`;
          idMap.set(n.id, id);
          if (n.maskImage) masks.push({ id, data: n.maskImage });
          return {
            id,
            type: "adjustment",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            adjustment: n.adjustment,
            clipped: !!n.clipped,
            ...mask,
            ...fx,
            ...lbl,
          };
        }
        const id = nextLeafId();
        idMap.set(n.id, id);
        if (n.data) images.push({ id, data: n.data });
        if (n.maskImage) masks.push({ id, data: n.maskImage });
        pushFm(id);
        return {
          id,
          type: "layer",
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blend: n.blend,
          ...(n.vector ? { vector: n.vector } : {}),
          ...mask,
          ...fx,
          ...clip,
          ...flt,
          ...fmMeta,
          ...lbl,
        };
      });

    const layers = remap(p.layers);
    const seq = (seqRef.current += 1);
    const docId = `doc-${seq}`;
    const activeLayerId = p.activeLayerId ? (idMap.get(p.activeLayerId) ?? null) : null;
    const selectedLayerIds = (p.selectedLayerIds ?? [])
      .map((i) => idMap.get(i))
      .filter((x): x is string => !!x);
    const doc: Doc = {
      id: docId,
      name: p.name || `Untitled-${seq}`,
      width: p.width,
      height: p.height,
      dpi: p.dpi ?? 300,
      layers,
      activeLayerId,
      selectedLayerIds,
      selection: p.selection ?? [],
      selectionAngle: 0,
      selectionPivot: null,
      metadata: p.metadata ?? null, // v9; absent in older files
      paths: coercePaths(p.paths), // v11; absent in older files
    };
    setDocs((ds) => [...ds, doc]);
    if (activate) setActiveId(docId);
    if (p.foreground) setForeground(p.foreground);
    if (p.background) setBackground(p.background);
    setPendingLoads((ls) => [...ls, { docId, images, masks }]);
    // Seed the autosave cache from the file JSON so a never-viewed restored tab
    // still snapshots correctly (refreshed from the engine once it goes active).
    docJsonCache.current.set(docId, { json: JSON.stringify(p), name: doc.name });
    return docId;
  };

  // Parse + validate .gproj text and load it. Returns whether it succeeded.
  const loadProjectText = (text: string): boolean => {
    try {
      const parsed = JSON.parse(text);
      // Accept the current id plus the legacy "aperture-project" so older files open.
      const fmt = parsed?.format;
      if ((fmt !== "graphiq-project" && fmt !== "aperture-project") || !Array.isArray(parsed.layers)) {
        window.alert("This file isn't a valid Graphiq project (.gproj).");
        return false;
      }
      loadProject(parsed as ProjectFile);
      return true;
    } catch {
      window.alert("Couldn't open the file — it may be corrupted.");
      return false;
    }
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-opened later
    if (!file) return;
    if (loadProjectText(await file.text())) addRecent(file.name, { blob: file });
  };

  // Restore a crash snapshot: open every document it holds and activate the one
  // that was active. Returns how many opened (0 = nothing valid).
  const restoreSnapshot = (snap: AutosaveSnapshot): number => {
    const ids: string[] = [];
    for (const entry of snap.docs) {
      try {
        const parsed = JSON.parse(entry.json);
        const fmt = parsed?.format;
        if ((fmt === "graphiq-project" || fmt === "aperture-project") && Array.isArray(parsed.layers)) {
          ids.push(loadProject(parsed as ProjectFile, false));
        }
      } catch {
        /* skip a corrupt entry, keep the rest */
      }
    }
    if (!ids.length) return 0;
    setActiveId(ids[Math.min(snap.activeIndex, ids.length - 1)] ?? ids[0]);
    return ids.length;
  };

  // ---- Export (flatten → image file) ----
  const openExport = () => {
    const composite = paintRef.current?.exportComposite(activeDocRef.current.layers);
    if (composite) setExportComposite(composite);
  };

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

  /** What an export of `d` would embed: the document's own metadata (raw EXIF
   *  twins) with the Preferences attribution as fallback, plus the doc's ppi. */
  const exportMetaFor = (d: Doc): ExportMetadata => {
    const m = d.metadata;
    const p = prefsRef.current;
    return {
      description: m?.description || undefined,
      artist: m?.artist || p.authorName.trim() || undefined,
      copyright: m?.copyright || p.copyrightNotice.trim() || undefined,
      make: m?.make,
      model: m?.model,
      lensModel: m?.lensModel,
      dateTakenRaw: m?.dateTakenRaw,
      exposureTime: m?.exposureTime,
      fNumberValue: m?.fNumberValue,
      iso: m?.iso,
      focalLengthMm: m?.focalLengthMm,
      focalLength35Mm: m?.focalLength35Mm,
      gps: m?.gps,
      dpi: d.dpi ?? 300,
    };
  };

  const doExport = async (opts: ExportOptions, filename: string, embedMeta: boolean) => {
    if (!exportComposite) return;
    let blob = await renderExport(exportComposite, opts);
    if (blob && embedMeta) {
      blob = await embedMetadata(
        blob,
        opts.format.id,
        exportMetaFor(activeDocRef.current),
        Math.max(1, Math.round(exportComposite.width * opts.scale)),
        Math.max(1, Math.round(exportComposite.height * opts.scale)),
      );
    }
    if (blob) {
      const base = filename.trim() || activeDocRef.current.name;
      await saveImageBlob(blob, `${base}.${opts.format.ext}`, opts.format);
    }
    setExportComposite(null);
  };

  // Batch export: encode every target (format + scale + quality) from the same
  // composite, name each through the shared filename template, and download
  // them as ONE .zip (store method — the images are already compressed).
  const doBatchExport = async (run: BatchRun, docName: string) => {
    const comp = exportComposite;
    if (!comp || !run.targets.length) return;
    const fmts = availableFormats();
    const fmtById = (id: string) => fmts.find((f) => f.id === id) ?? fmts[0];
    const names: string[] = [];
    const datas: Uint8Array<ArrayBuffer>[] = [];
    let failed = 0;
    const meta = run.embedMeta ? exportMetaFor(activeDocRef.current) : null;
    for (let i = 0; i < run.targets.length; i++) {
      const t = run.targets[i];
      const fmt = fmtById(t.formatId);
      let blob = await renderExport(comp, {
        format: fmt,
        quality: t.quality / 100,
        scale: t.scalePct / 100,
        transparent: true, // per-target mattes aren't modelled; alpha formats stay transparent
        matte: "#ffffffff",
      });
      if (blob && meta) {
        blob = await embedMetadata(
          blob,
          fmt.id,
          meta,
          Math.max(1, Math.round(comp.width * (t.scalePct / 100))),
          Math.max(1, Math.round(comp.height * (t.scalePct / 100))),
        );
      }
      if (!blob) {
        failed++;
        continue;
      }
      names.push(targetFilename(t, run.template, docName, comp.width, comp.height, i + 1, fmt.ext));
      datas.push(new Uint8Array(await blob.arrayBuffer()));
    }
    if (!datas.length) {
      showToast("Batch export failed — nothing could be encoded.");
      return;
    }
    const unique = dedupeFilenames(names);
    const zip = buildZip(unique.map((name, i) => ({ name, data: datas[i] })));
    downloadBlob(zip, `${(docName.trim() || "export").replace(/\.zip$/i, "")}.zip`);
    setExportComposite(null);
    showToast(
      failed
        ? `Exported ${datas.length} file${datas.length === 1 ? "" : "s"} — ${failed} failed to encode`
        : `Exported ${datas.length} file${datas.length === 1 ? "" : "s"} as .zip`,
    );
  };

  // ---- Print (flatten → browser print dialog) ----
  // Render the active document's composite, then print it from a hidden iframe
  // (avoids popup blockers and prints only the artwork, not the whole app UI).
  const printCanvas = () => {
    const composite = paintRef.current?.exportComposite(activeDocRef.current.layers);
    if (!composite) return;
    const url = composite.toDataURL("image/png");
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
    // Physical size from the document's PPI (true-size print); still fits the
    // page when larger than the printable area.
    const d0 = activeDocRef.current;
    const printW = (d0.width / (d0.dpi ?? 300)).toFixed(4);
    cd.write(
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
        "@page{margin:10mm;}" +
        "*{margin:0;padding:0;box-sizing:border-box;}" +
        ".wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;}" +
        `.wrap img{width:${printW}in;max-width:100%;max-height:100%;object-fit:contain;}` +
        '</style></head><body><div class="wrap"><img alt=""></div></body></html>',
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

  // ---- Blur Gallery (Effects ▸ Blur Gallery) ----
  // Live preview via an engine session: the affected layers' originals are kept,
  // re-blurred on each change (debounced), committed on Apply, restored on Cancel.
  const blurFxIds = (scope: BlurFxScope): string[] => {
    const d = activeDocRef.current;
    return scope === "canvas" ? collectLeafIds(d.layers) : d.activeLayerId ? [d.activeLayerId] : [];
  };
  const ensureBlurSession = (scope: BlurFxScope) => {
    const ids = blurFxIds(scope);
    const cur = blurFxSessionRef.current;
    const same = !!cur && cur.length === ids.length && cur.every((id, i) => id === ids[i]);
    if (same) return;
    if (cur) paintRef.current?.cancelBlurFx(); // restore the previous scope's pixels
    const d = activeDocRef.current;
    paintRef.current?.beginBlurFx(
      ids,
      d.selection.length ? d.selection : null,
      d.selectionAngle,
      d.selectionPivot,
    );
    blurFxSessionRef.current = ids;
  };
  const renderBlurPreview = (s: BlurFxSettings, immediate = false) => {
    ensureBlurSession(s.scope);
    window.clearTimeout(blurFxTimerRef.current);
    const run = async () => {
      // Off the UI thread (worker); superseded renders resolve false and skip
      // the (also non-trivial) composite snapshot — only the newest one lands.
      const applied = await paintRef.current?.previewBlurFxAsync(
        s.kind,
        s.amount,
        s.angle,
        s.anchor.x,
        s.anchor.y,
        { band: s.band, feather: s.feather, threshold: s.threshold },
      );
      if (!applied || !blurFxOpenRef.current) return;
      // Snapshot the composited result for the dialog's preview pane.
      setBlurPreview(paintRef.current?.exportComposite(activeDocRef.current.layers) ?? null);
    };
    if (immediate) run();
    else blurFxTimerRef.current = window.setTimeout(run, 90);
  };
  const openBlurFx = () => {
    const d = activeDocRef.current;
    if (!d.layers.length) return; // nothing to blur
    // Default the zoom/spin centre to the selection's centre, else the canvas centre.
    let anchor = { x: 0.5, y: 0.5 };
    if (d.selection.length) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const r of d.selection) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
      anchor = { x: (x0 + x1) / 2 / d.width, y: (y0 + y1) / 2 / d.height };
    }
    const next = { ...blurFx, anchor };
    setBlurFx(next);
    setBlurPreview(null); // show the dialog's "rendering" state until the first preview
    blurFxSessionRef.current = null; // force a fresh snapshot
    setBlurFxOpen(true);
    // Pop the dialog instantly, THEN do the (possibly heavy) snapshot + first
    // preview — a double rAF lets the dialog paint before that work runs.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (blurFxOpenRef.current) renderBlurPreview(next, true);
      }),
    );
  };
  const changeBlurFx = (patch: Partial<BlurFxSettings>) => {
    const next = { ...blurFx, ...patch };
    setBlurFx(next);
    renderBlurPreview(next);
  };
  const applyBlurFx = async () => {
    window.clearTimeout(blurFxTimerRef.current);
    ensureBlurSession(blurFx.scope);
    // Flush the newest parameters (worker or sync) before committing.
    await paintRef.current?.previewBlurFxAsync(
      blurFx.kind,
      blurFx.amount,
      blurFx.angle,
      blurFx.anchor.x,
      blurFx.anchor.y,
      { band: blurFx.band, feather: blurFx.feather, threshold: blurFx.threshold },
    );
    paintRef.current?.commitBlurFx(`${BLUR_FX_LABELS[blurFx.kind]} Blur`);
    blurFxSessionRef.current = null;
    setBlurPreview(null);
    setBlurFxOpen(false);
  };
  const closeBlurFx = () => {
    window.clearTimeout(blurFxTimerRef.current);
    paintRef.current?.cancelBlurFx();
    blurFxSessionRef.current = null;
    setBlurPreview(null);
    setBlurFxOpen(false);
  };

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

  const onImportPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!allFiles.length) return;
    // PSDs open as their own layered documents; everything else flows through
    // the import dialog.
    const files: File[] = [];
    for (const f of allFiles) {
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
    if (!items.length) {
      window.alert("Couldn't read the selected image(s).");
      return;
    }
    setImportItems(items);
  };

  // Import images onto new layers of the current canvas (one undoable step).
  const importAsLayers = (items: ImportItem[], opts: ImportOptions) => {
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
  const importAsCanvases = (items: ImportItem[]) => {
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

  // Serialize the document's vector-bearing layers (shape / text / imported
  // SVG) to a standalone .svg download. Raster/adjustment layers, masks and
  // layer effects have no vector source — they're skipped and reported.
  const exportVectorSVG = () => {
    const d = activeDocRef.current;
    const { svg, vectorLayers, skipped } = exportSVG(d.layers, d.width, d.height);
    if (!vectorLayers) {
      window.alert(
        "No vector layers to export. SVG export covers shape layers, text layers and imported SVG vector layers.",
      );
      return;
    }
    const name = (d.name || "artwork").replace(/\.svg$/i, "");
    downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
    showToast(
      skipped
        ? `Exported ${vectorLayers} vector layer${vectorLayers === 1 ? "" : "s"} — ${skipped} without a vector source skipped`
        : `Exported ${vectorLayers} vector layer${vectorLayers === 1 ? "" : "s"}`,
    );
  };

  // Write the document as a layered PSD: the full tree (groups as section
  // dividers), masks, opacity/blend/clipping/visibility, plus the flattened
  // composite every PSD reader requires. Adjustment layers have no PSD
  // equivalent in our model and are skipped (the composite keeps the look).
  const exportPSD = () => {
    const d = activeDocRef.current;
    const eng = paintRef.current;
    if (!eng) return;
    const leafIds: string[] = [];
    const collectIds = (ns: LayerNode[]) =>
      ns.forEach((n) => {
        if (n.type === "layer") leafIds.push(n.id);
        else if (n.type === "group") collectIds(n.children);
      });
    collectIds(d.layers);
    const snaps = eng.captureLeaves(leafIds);
    let skipped = 0;
    const convert = (ns: LayerNode[]): PsdOutNode[] =>
      ns.flatMap((n): PsdOutNode[] => {
        if (n.type === "adjustment") {
          skipped++;
          return [];
        }
        if (n.type === "group")
          return [
            {
              kind: "group",
              name: n.name,
              visible: n.visible,
              opacity: n.opacity,
              blend: n.blend,
              children: convert(n.children),
              mask: n.mask ? (eng.captureMask(n.id) ?? null) : null,
              maskEnabled: n.mask?.enabled !== false,
            },
          ];
        const snap = snaps.get(n.id);
        return [
          {
            kind: "layer",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            clipped: !!n.clipped,
            image: snap?.layer ?? null,
            mask: n.mask ? (snap?.mask ?? null) : null,
            maskEnabled: n.mask?.enabled !== false,
          },
        ];
      });
    const nodes = convert(d.layers);
    const comp = eng.exportComposite(d.layers);
    const ctx = comp.getContext("2d");
    if (!ctx) return;
    const buf = buildPSD(
      d.width,
      d.height,
      d.dpi ?? 300,
      nodes,
      ctx.getImageData(0, 0, comp.width, comp.height),
    );
    downloadBlob(new Blob([buf], { type: "image/vnd.adobe.photoshop" }), `${d.name || "artwork"}.psd`);
    showToast(
      skipped
        ? `Exported PSD — ${skipped} adjustment layer${skipped === 1 ? "" : "s"} skipped (no PSD equivalent)`
        : "Exported PSD",
    );
  };

  const applyImport = async (mode: ImportMode, opts: ImportOptions) => {
    let items = importItems;
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
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pe-panels");
      if (saved) setPanelsState({ ...ALL_PANELS, ...JSON.parse(saved) });
    } catch {
      /* ignore */
    }
  }, []);
  const persistPanels = (p: PanelVisibility) => {
    setPanelsState(p);
    try {
      localStorage.setItem("pe-panels", JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };
  const handleWindowAction = (actionId: string) => {
    if (actionId === "window-reset") {
      persistPanels({ ...ALL_PANELS });
      return;
    }
    const id = PANEL_BY_ACTION[actionId];
    if (id) persistPanels({ ...panels, [id]: !panels[id] });
  };

  // ---- View menu: rulers / grid / snap (persisted), zoom commands ----
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem("pe-view") || "{}");
      if (typeof v.rulers === "boolean") setShowRulers(v.rulers);
      if (typeof v.grid === "boolean") setShowGrid(v.grid);
      if (typeof v.snap === "boolean") setSnap(v.snap);
    } catch {
      /* ignore */
    }
  }, []);
  const persistView = (patch: { rulers?: boolean; grid?: boolean; snap?: boolean }) => {
    const next = { ...viewSettingsRef.current, ...patch };
    setShowRulers(next.rulers);
    setShowGrid(next.grid);
    setSnap(next.snap);
    try {
      localStorage.setItem("pe-view", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const handleViewAction = (actionId: string) => {
    const v = viewSettingsRef.current;
    if (actionId === "view-zoom-in") viewApiRef.current?.zoomIn();
    else if (actionId === "view-zoom-out") viewApiRef.current?.zoomOut();
    else if (actionId === "view-fit") viewApiRef.current?.fit();
    else if (actionId === "view-100") viewApiRef.current?.zoom100();
    else if (actionId === "view-rulers") persistView({ rulers: !v.rulers });
    else if (actionId === "view-grid") persistView({ grid: !v.grid });
    else if (actionId === "view-snap") persistView({ snap: !v.snap });
    else if (actionId === "view-proof") setProofColors((p) => !p);
    else if (actionId === "view-gamut") setGamutWarn((g) => !g);
  };

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

  // Playback dispatches through the LATEST handleMenuAction — each step's state
  // must commit (and re-point the refs the handlers read) before the next one,
  // hence the ref + the per-step delay.
  const handleMenuActionRef = useRef<(id: string) => void>(() => {});
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
          handleMenuActionRef.current(step.action);
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
      setTool("pen");
      viewApiRef.current?.loadPenPath(cloneAnchors(p.anchors), p.closed);
    },
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

  const handleMenuAction = (actionId: string) => {
    // Recording: log replay-safe commands into the armed action (never while
    // playing back — a played action must not append to itself).
    if (recordingIdRef.current && !playingRef.current && isRecordable(actionId)) {
      const rid = recordingIdRef.current;
      updateActions((ls) =>
        ls.map((a) =>
          a.id === rid
            ? { ...a, steps: [...a.steps, { action: actionId, label: actionLabel(actionId) }] }
            : a,
        ),
      );
    }
    const al = active.activeLayerId;
    if (actionId === "canvas-size") openSizeDialog("canvas");
    else if (actionId === "image-size") openSizeDialog("image");
    else if (actionId === "image-crop") cropToSelection();
    else if (actionId === "image-trim") setTrimOpen(true);
    else if (actionId === "image-rotate-cw") applyImageTransform("rotate-cw");
    else if (actionId === "image-rotate-ccw") applyImageTransform("rotate-ccw");
    else if (actionId === "image-flip-h") applyImageTransform("flip-h");
    else if (actionId === "image-flip-v") applyImageTransform("flip-v");
    else if (actionId === "edit-cut") cutSelection();
    else if (actionId === "edit-copy") copySelection();
    else if (actionId === "edit-paste") pasteFromClipboard();
    else if (actionId === "free-transform") enterTransform(true);
    else if (actionId === "transform") enterTransform(false);
    else if (actionId === "select-all") selectAll();
    else if (actionId === "select-deselect") deselect();
    else if (actionId === "select-reselect") reselect();
    else if (actionId === "select-inverse") invertSelection();
    else if (actionId === "select-feather") setSelectModify("feather");
    else if (actionId === "select-grow") setSelectModify("grow");
    else if (actionId === "new-doc") requestNewDoc();
    else if (actionId === "open") openProject();
    else if (actionId === "open-recent") setRecentsOpen(true);
    else if (actionId === "save") saveProject();
    else if (actionId === "save-as") setSaveAsOpen(true);
    else if (actionId === "import") openImport();
    else if (actionId === "export-as") openExport();
    else if (actionId === "export-svg") exportVectorSVG();
    else if (actionId === "export-psd") exportPSD();
    else if (actionId === "export-lut") setLutExportOpen(true);
    else if (actionId === "merge-hdr") setHdrMergeOpen(true);
    else if (actionId === "hdr-tone") {
      if (activeDocRef.current.hdr) setHdrToneOpen(true);
      else
        showToast(
          "No HDR source — this works on documents created via File ▸ Merge to HDR (the float map lives in memory, not in .gproj).",
        );
    } else if (actionId === "export-hdr") {
      if (activeDocRef.current.hdr) setHdrExportOpen(true);
      else showToast("No HDR source — export true HDR from a document created via File ▸ Merge to HDR.");
    } else if (actionId === "print") printCanvas();
    else if (actionId === "effect-blur") openBlurFx();
    else if (actionId === "color-manage") openColorDialog();
    else if (actionId === "color-compare") openCompare();
    else if (actionId === "preferences") setPrefsOpen(true);
    else if (actionId.startsWith("window-")) handleWindowAction(actionId);
    else if (actionId.startsWith("view-")) handleViewAction(actionId);
    else if (actionId === "undo") doUndo();
    else if (actionId === "redo") doRedo();
    else if (actionId === "layer-new") addLayerOp();
    else if (actionId === "layer-duplicate") duplicateSelected();
    else if (actionId === "layer-delete") removeSelected();
    else if (actionId === "layer-group") groupSelected();
    else if (actionId === "layer-ungroup") {
      if (al) ungroupLayerOp(al);
    } else if (actionId === "layer-merge-down") mergeSelected();
    else if (actionId === "layer-flatten") flattenImage();
    else if (actionId === "mask-add") addMaskOp("reveal");
    else if (actionId === "mask-add-hide") addMaskOp("hide");
    else if (actionId === "mask-from-sel") addMaskOp("selection");
    else if (actionId === "mask-delete") removeMaskOp();
    else if (actionId === "mask-apply") applyMaskOp();
    else if (actionId === "mask-to-sel") loadMaskAsSelectionOp();
    else if (actionId === "adj-tone-curves") addToneAdjustment("curves");
    else if (actionId === "adj-tone-levels") addToneAdjustment("levels");
    else if (actionId === "tone-dest-curves") openDestructiveTone("curves");
    else if (actionId === "tone-dest-levels") openDestructiveTone("levels");
    else if (actionId.startsWith("adj-x-")) addExtraAdjustment(actionId.slice(6));
    else if (actionId.startsWith("adj-")) addAdjustmentOp(actionId.slice(4));
    else if (actionId === "fx-open") {
      const id = activeDocRef.current.activeLayerId;
      if (id) openLayerStyleOp(id);
    } else if (actionId === "fx-clear") {
      const id = activeDocRef.current.activeLayerId;
      if (id) clearLayerStyleOp(id);
    } else if (actionId.startsWith("fx-add-")) addEffectOp(actionId.slice(7) as FxKey);
    else if (actionId === "layer-clip") toggleClippingMask();
    else if (actionId.startsWith("filter-add-")) addFilterOp(actionId.slice(11) as FilterType);
    else if (actionId === "filter-open") {
      const id = activeDocRef.current.activeLayerId;
      if (id) openFiltersOp(id);
    } else if (actionId === "shortcuts") setShortcutsOpen(true);
    else if (actionId === "prefs-performance") openPrefs("performance");
    else if (actionId === "prefs-storage") openPrefs("storage");
    else if (actionId === "help-start") setHelpOpen("start");
    else if (actionId === "help-docs") setHelpOpen("docs");
    else if (actionId === "about") setAboutOpen(true);
    else if (actionId === "edit-caf") contentAwareFillOp();
  };
  handleMenuActionRef.current = handleMenuAction;

  const swapColors = () => {
    const f = fgRef.current;
    setForeground(bgRef.current);
    setBackground(f);
  };

  const commitFloatIfAny = () => {
    if (paintRef.current?.isFloating()) paintRef.current.commitFloat();
  };

  // Place clipboard content: an in-app copy from the current canvas pastes
  // straight onto the current layer (in place); anything else opens the paste
  // options dialog.
  const placePaste = (source: ImageBitmap | HTMLCanvasElement, w: number, h: number) => {
    const cb = clipboardRef.current;
    const sameCanvas = cb !== null && copyDocIdRef.current === activeIdRef.current;
    const matchesInternal = source === cb || (!!cb && w === cb.width && h === cb.height);
    if (sameCanvas && matchesInternal) {
      const origin = copyOriginRef.current;
      doPaste(source, w, h, "current-layer", false, origin.x, origin.y);
    } else {
      // Honour the user's default-paste preference, else ask via the dialog.
      const def = prefsRef.current.defaultPaste;
      if (def === "ask") {
        setPasteSrc({ source, w, h });
        return;
      }
      // Destination is defaulted. If the image is larger than the canvas the
      // oversize preference decides: keep (crop), expand, or ask just that.
      const d = activeDocRef.current;
      const oversize = def !== "new-canvas" && (w > d.width || h > d.height);
      if (!oversize) {
        doPaste(source, w, h, def, false);
        return;
      }
      const ov = prefsRef.current.pasteOversize;
      if (ov === "ask") setPasteSrc({ source, w, h, dest: def });
      else doPaste(source, w, h, def, ov === "expand");
    }
  };

  // Paste from the Edit menu: read the OS clipboard (a menu click is a user
  // gesture, so navigator.clipboard.read is allowed), falling back to the last
  // in-app copy/cut when the OS clipboard is empty or unreadable.
  const pasteFromClipboard = async () => {
    try {
      if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const bmp = await createImageBitmap(await item.getType(type));
            placePaste(bmp, bmp.width, bmp.height);
            return;
          }
        }
      }
    } catch {
      /* clipboard unreadable (permission / focus) — fall back to the internal one */
    }
    const c = clipboardRef.current;
    if (c) placePaste(c, c.width, c.height);
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
            else handleMenuActionRef.current(d.id.slice(5));
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
        // Exiting the selection merges a floating paste down.
        if (paintRef.current?.isFloating()) {
          e.preventDefault();
          paintRef.current.commitFloat();
          setSelection([]);
        } else if (selRef.current.length) {
          e.preventDefault();
          setSelection([]);
        }
      } else if (e.key === "Enter" && paintRef.current?.isFloating()) {
        // Commit an in-progress transform (the floated, scaled/rotated content).
        e.preventDefault();
        paintRef.current.commitFloat();
        setSelection([]);
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
            selectionFeatherRef.current,
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
            selectionFeatherRef.current,
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
        // Shifted tool letters (Shift+B etc.) still reach a tool bound to the
        // bare letter — the registry pass above requires exact modifiers, and
        // the Shift+L/M cycles just had their chance.
        const bare = canonicalBinding({ ctrl: false, alt: false, shift: false, key: e.key.toLowerCase() });
        const tool = shortcutIndexRef.current.get(bare)?.find((d) => d.id.startsWith("tool:"));
        if (tool) {
          e.preventDefault();
          setTool(tool.id.slice(5) as ToolId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active tool's brush dynamics (brush / pencil / eraser are independent).
  const activeBrush = tool === "eraser" ? eraser : tool === "pencil" ? pencil : brush;
  const setActiveBrush = tool === "eraser" ? setEraser : tool === "pencil" ? setPencil : setBrush;

  return (
    <div className={styles.app}>
      <TopBar
        onMenuAction={handleMenuAction}
        onSelectTool={setTool}
        shortcutLabels={shortcutLabels}
        initialTheme={initialTheme}
        onUndo={doUndo}
        onRedo={doRedo}
        canUndo={history.index > 0}
        canRedo={history.index < history.items.length - 1}
        checks={{
          "window-color": panels.color,
          "window-adjustments": panels.adjustments,
          "window-properties": panels.properties,
          "window-layers": panels.layers,
          "window-paths": panels.paths,
          "window-history": panels.history,
          "window-actions": panels.actions,
          "window-navigator": panels.navigator,
          "window-channels": panels.channels,
          "window-metadata": panels.metadata,
          "view-rulers": showRulers,
          "view-grid": showGrid,
          "view-proof": proofColors,
          "view-gamut": gamutWarn,
          "view-snap": snap,
          "layer-clip": !!activeLeafNode?.clipped,
        }}
      />
      <OptionsBar
        tool={tool}
        foreground={paintColor}
        onForeground={setPaintColor}
        brush={activeBrush}
        onBrush={setActiveBrush}
        moveMode={moveMode}
        onMoveMode={setMoveMode}
        resizeMode={resizeMode}
        onResizeMode={setResizeMode}
        resizeSmooth={resizeSmooth}
        onResizeSmooth={setResizeSmooth}
        marqueeShape={marqueeShape}
        onMarqueeShape={setMarqueeShape}
        lassoMode={lassoMode}
        onLassoMode={setLassoMode}
        triangleApex={triangleApex}
        onTriangleApex={setTriangleApex}
        wand={wand}
        onWand={(patch) => setWand((wd) => ({ ...wd, ...patch }))}
        bucket={bucket}
        onBucket={(patch) => setBucket((b) => ({ ...b, ...patch }))}
        gradient={gradient}
        onGradient={(patch) => setGradient((g) => ({ ...g, ...patch }))}
        pen={pen}
        onPen={(patch) => setPen((pn) => ({ ...pn, ...patch }))}
        eyedropper={{ size: sampleSizeLabel, scope: sampleScopeLabel }}
        onEyedropper={(patch) => {
          if (patch.size !== undefined) setSampleSizeLabel(patch.size);
          if (patch.scope !== undefined) setSampleScopeLabel(patch.scope);
        }}
        shape={shape}
        onShape={(patch) => setShape((s) => ({ ...s, ...patch }))}
        blur={blur}
        onBlur={(patch) => setBlur((b) => ({ ...b, ...patch }))}
        heal={heal}
        onHeal={(patch) => setHeal((h) => ({ ...h, ...patch }))}
        redEye={redEye}
        onRedEye={(patch) => setRedEye((r) => ({ ...r, ...patch }))}
        clone={clone}
        onClone={(patch) => setClone((c) => ({ ...c, ...patch }))}
        dodge={dodge}
        onDodge={(patch) => setDodge((d) => ({ ...d, ...patch }))}
        text={textSettings}
        onText={(patch) => {
          // With a live text selection, character-level changes style the
          // SELECTED range (rich runs); otherwise they set the block/base style.
          if (viewApiRef.current?.applyTextStyle(patch)) return;
          setTextSettings((t) => ({ ...t, ...patch }));
        }}
        crop={cropSettings}
        onCrop={(patch) => setCropSettings((s) => ({ ...s, ...patch }))}
        cropBox={cropBox}
        onCropBox={setCropBox}
        onCropApply={applyCropNow}
        onCropReset={resetCropBox}
        docWidth={active.width}
        docHeight={active.height}
        fill={foreground}
        onFill={setForeground}
        stroke={background}
        onStroke={setBackground}
      />
      <div className={styles.body}>
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          foreground={foreground}
          background={background}
          onForeground={setForeground}
          onBackground={setBackground}
          onSwap={() => {
            setForeground(background);
            setBackground(foreground);
          }}
        />
        <CanvasArea
          docs={docs}
          activeId={activeId}
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
          tool={tool}
          brush={activeBrush}
          color={paintColor}
          foreground={foreground}
          background={background}
          bucket={bucket}
          gradient={{
            type: gradient.type,
            reverse: gradient.reverse,
            smooth: gradient.smooth,
            snap: prefs.gradientSnap,
            stops: gradient.stops,
            fg: foreground,
            bg: background,
          }}
          pen={pen}
          shape={{
            kind: shape.kind,
            strokeWidth: shape.strokeWidth,
            radius: shape.radius,
            fill: foreground,
            stroke: background,
          }}
          blur={blur}
          heal={heal}
          redEye={redEye}
          clone={clone}
          dodge={dodge}
          text={textSettings}
          onText={(patch) => setTextSettings((t) => ({ ...t, ...patch }))}
          onPlaceText={placeText}
          onUpdateText={updateText}
          cropBox={cropBox}
          onCropBox={setCropBox}
          cropGrid={cropSettings.grid}
          cropShield={cropSettings.shield}
          cropStraighten={cropSettings.straighten}
          cropAspect={cropAspect(cropSettings, active.height ? active.width / active.height : 1)}
          onCropApply={applyCropNow}
          layers={active.layers}
          activeLayerId={active.activeLayerId}
          ensureLayer={ensureLayer}
          selection={active.selection}
          onSelectionChange={setSelection}
          onSelectionRects={setSelectionRects}
          selectionAngle={active.selectionAngle}
          selectionPivot={active.selectionPivot}
          selectionFeather={selectionFeather}
          onSelectionAngle={setSelectionAngle}
          onSelectionPivot={setSelectionPivot}
          moveMode={moveMode}
          resizeMode={resizeMode}
          resizeSmooth={resizeSmooth}
          marqueeShape={marqueeShape}
          lassoMode={lassoMode}
          triangleApex={triangleApex}
          wand={wand}
          sampleSize={SAMPLE_SIZE_PX[sampleSizeLabel] ?? 1}
          sampleAllLayers={sampleScopeLabel === "All layers"}
          onPick={setPaintColor}
          tonePick={!!tonePick}
          onTonePick={onTonePicked}
          curveTarget={curveTarget}
          onCurveTargetStart={onCurveTargetStart}
          onCurveTargetDrag={onCurveTargetDrag}
          onCurveTargetEnd={onCurveTargetEnd}
          onPenPathCommit={storeWorkPath}
          recordStrokes={!!recordingId}
          onStrokeRecord={recordStrokeStep}
          pendingPaste={pendingPaste}
          onPasteDone={() => setPendingPaste(null)}
          pendingLoads={pendingLoads}
          onLoadDone={(docId) => setPendingLoads((ls) => ls.filter((p) => p.docId !== docId))}
          colorSpace={colorSpace}
          showRulers={showRulers}
          unit={prefs.unit}
          docDpi={active.dpi ?? 300}
          checkerSize={prefs.checkerSize}
          checkerColors={prefs.checkerColors}
          checkerA={prefs.checkerA}
          checkerB={prefs.checkerB}
          showGrid={showGrid}
          snap={snap}
          viewApiRef={viewApiRef}
          paintRef={paintRef}
          onHistory={setHistory}
          onAdjustEnd={onAdjustEnd}
          onCursor={emitCursor}
        />
        <RightDock
          foreground={foreground}
          background={background}
          onForeground={setForeground}
          onBackground={setBackground}
          activeSlot={activeSlot}
          onActiveSlot={setActiveSlot}
          layers={layersApi}
          history={history}
          maxHistoryRows={prefs.maxHistory}
          onHistoryJump={(i) => paintRef.current?.jumpTo(i)}
          view={{
            zoom,
            pan,
            setPan,
            vpW: viewport.w,
            vpH: viewport.h,
            docW: active.width,
            docH: active.height,
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
          panels={panels}
          engineRef={paintRef}
          docName={active.name}
          colorSpace={colorSpace}
          imageMeta={active.metadata ?? null}
          onEditMeta={updateDocMetadata}
          actionsApi={actionsApi}
          pathsApi={pathsApi}
          docDpi={active.dpi ?? 300}
        />
      </div>
      <StatusBar
        tool={tool}
        zoom={zoom}
        onZoomChange={setZoom}
        foreground={paintColor}
        width={active.width}
        height={active.height}
        colorSpace={colorSpace}
        unit={prefs.unit}
        dpi={active.dpi ?? 300}
        layerCount={collectLeafIds(active.layers).length}
        saveState={saveState}
        selection={active.selection}
        subscribeCursor={subscribeCursor}
      />

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
            else growSelection(px);
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
              gradientStorageKey={prefs.sharedGradients ? GRADIENT_PRESETS_KEY : FX_GRADIENT_PRESETS_KEY}
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
              hasSelection={active.selection.length > 0}
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
      {hdrMergeOpen && (
        <HdrMergeDialog mode="merge" onCreate={createHdrDoc} onClose={() => setHdrMergeOpen(false)} />
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

      {recentsOpen && (
        <RecentsDialog onOpenText={loadProjectText} onClose={() => setRecentsOpen(false)} />
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

      <TooltipHost />
    </div>
  );
}
