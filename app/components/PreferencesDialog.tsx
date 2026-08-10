"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ClipboardPaste,
  FolderOpen,
  Gauge,
  Crosshair,
  Eye,
  Grid2x2,
  Grid3x3,
  HardDrive,
  Palette,
  PenTool,
  Ruler,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { applyTheme, currentTheme, resolvedDark } from "./ThemeToggle";
import { ColorChip, Slider, Toggle } from "./Controls";
import { ACCENTS, ACCENT_COOKIE, DEFAULT_ACCENT, isAccent, type Accent, type Theme } from "../lib/theme";
import { PRESSURE_CURVES, effectivePressure, type PressureCurve } from "../lib/pointer";
import {
  CVD_TYPES,
  SAFE_DELTA_E,
  accentSafety,
  deltaEUnder,
  hexToRgb,
  rgbToHex,
  simulateHex,
  type CvdType,
} from "../lib/cvd";
import { UI_SCALES, applyUiScale, liveUiScale, type UiScale } from "../lib/ui-scale";
import {
  checkerCSS,
  type CheckerColors,
  type CheckerSize,
  type MeasureUnit,
  type PasteDefault,
  type PasteOversize,
  type Preferences,
} from "../lib/prefs";
import { downloadSettings, importSettings, resetSettings } from "../lib/settings";
import { availableFormats } from "../lib/imageio";
import { clearAutosave } from "../lib/autosave";
import { clearRecents, listRecents } from "../lib/recents";
import {
  autosaveInfo,
  clearPresets,
  estimateStorage,
  fmtBytes,
  isPersisted,
  presetsBytes,
  requestPersistence,
  settingsBytes,
} from "../lib/storage";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Theme options as Magiq's preview cards: a mini mock UI + radio + label. */
const THEME_OPTIONS: { id: Theme; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "system", name: "Match system" },
];

/** Interface-scale choices (ui-scale.ts owns the zoom factors). */
const SCALE_OPTIONS: { value: UiScale; title: string; desc: string }[] = UI_SCALES.map((s) => ({
  value: s.id,
  title: `${s.label} — ${Math.round(s.zoom * 100)}%`,
  desc:
    s.id === "compact"
      ? "Denser bars, panels and menus — more room for the canvas"
      : s.id === "comfortable"
        ? "Slightly larger controls and text"
        : s.id === "large"
          ? "Largest controls — for high-resolution displays"
          : "The standard Graphiq Studio size",
}));

function liveAccent(): Accent {
  if (typeof document !== "undefined") {
    const a = document.documentElement.getAttribute("data-accent");
    if (isAccent(a)) return a;
  }
  return DEFAULT_ACCENT;
}

function applyAccent(a: Accent) {
  document.documentElement.setAttribute("data-accent", a);
  document.cookie = `${ACCENT_COOKIE}=${a}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
}

const PASTE_OPTIONS: { value: PasteDefault; title: string; desc: string }[] = [
  { value: "ask", title: "Ask every time", desc: "Show the paste dialog to choose each time" },
  { value: "new-layer", title: "New layer", desc: "Add a new layer with the pasted image" },
  { value: "current-layer", title: "Current layer", desc: "Draw onto the selected layer" },
  { value: "new-canvas", title: "New canvas", desc: "Open the image as its own document" },
];

const OVERSIZE_OPTIONS: { value: PasteOversize; title: string; desc: string }[] = [
  { value: "ask", title: "Ask every time", desc: "Show the canvas-size question on oversized pastes" },
  { value: "keep", title: "Keep canvas size", desc: "Paste as-is; anything outside the canvas is cropped" },
  { value: "expand", title: "Expand canvas to fit", desc: "Grow the canvas so the whole image fits" },
];

/** Exported so menu actions can deep-link a section (Settings ▸ Performance /
 *  Scratch disks open Preferences directly on the matching tab). */
export type PrefsTab =
  | "appearance"
  | "pasting"
  | "editing"
  | "files"
  | "guides"
  | "cursors"
  | "pen"
  | "a11y"
  | "units"
  | "transparency"
  | "performance"
  | "storage";
type Tab = PrefsTab;

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "pasting", label: "Pasting", icon: ClipboardPaste },
  { id: "editing", label: "Editing", icon: SlidersHorizontal },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "units", label: "Units & rulers", icon: Ruler },
  { id: "transparency", label: "Transparency", icon: Grid2x2 },
  { id: "guides", label: "Guides & grid", icon: Grid3x3 },
  { id: "cursors", label: "Cursors", icon: Crosshair },
  { id: "pen", label: "Touch & pen", icon: PenTool },
  { id: "a11y", label: "Accessibility", icon: Eye },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "storage", label: "Storage", icon: HardDrive },
];

/** The semantic colours as the running theme currently resolves them, read
 *  straight off <html> so the preview reflects the live tokens (including any
 *  CVD swap already applied) rather than a hard-coded copy of the palette. */
function readSemantics(): { name: string; hex: string }[] {
  if (typeof window === "undefined") return [];
  const cs = getComputedStyle(document.documentElement);
  const read = (v: string) => {
    const raw = cs.getPropertyValue(v).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(raw)) return rgbToHex(hexToRgb(raw));
    const m = raw.match(/(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
    return m ? rgbToHex({ r: +m[1], g: +m[2], b: +m[3] }) : "#808080";
  };
  return [
    { name: "Danger", hex: read("--danger") },
    { name: "Success", hex: read("--success") },
    { name: "Warning", hex: read("--warning") },
  ];
}

/**
 * Side-by-side preview: each semantic colour as it is, and as the selected
 * deficiency renders it, with the worst pairwise separation spelled out. Seeing
 * "8" under the shipped palette is far more convincing than being told that red
 * and green are hard to tell apart.
 */
function CvdPreview({ type, dark, accent }: { type: CvdType; dark: boolean; accent: Accent }) {
  // Re-read the live tokens whenever anything that could change them changes.
  const [swatches, setSwatches] = useState<{ name: string; hex: string }[]>([]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSwatches(readSemantics()));
    return () => cancelAnimationFrame(id);
  }, [type, dark]);

  const accentHex = ACCENTS.find((a) => a.id === accent);
  const rows = accentHex
    ? [...swatches, { name: "Accent", hex: dark ? accentHex.dark : accentHex.light }]
    : swatches;
  if (!rows.length) return null;

  // The worst pair in the row, as this vision sees it.
  let worst = Infinity;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      worst = Math.min(worst, deltaEUnder(rows[i].hex, rows[j].hex, type));
    }
  }
  const okSep = worst >= SAFE_DELTA_E;

  return (
    <div className={styles.cvdPreview}>
      <div className={styles.cvdRow}>
        {rows.map((s) => (
          <div key={s.name} className={styles.cvdCell}>
            <span className={styles.cvdChip} style={{ background: s.hex }} />
            {type !== "none" && (
              <span className={styles.cvdChip} style={{ background: simulateHex(s.hex, type) }} />
            )}
            <span className={styles.cvdName}>{s.name}</span>
          </div>
        ))}
      </div>
      <div className={styles.cvdVerdict} data-ok={okSep}>
        {okSep ? <Check size={13} strokeWidth={3} /> : <TriangleAlert size={13} />}
        <span>
          Closest pair: <strong>ΔE {Math.round(worst)}</strong>
          {type === "none" ? " with normal vision" : ` as ${CVD_TYPES.find((t) => t.id === type)?.label.toLowerCase()}`}
          {okSep ? " — comfortably distinct." : " — these read as the same colour."}
        </span>
      </div>
    </div>
  );
}

/**
 * Live pen tester: draw in it and it reports what the browser actually says —
 * pointer type, raw pressure and the curved value the brush would use — plus a
 * pressure-varying trace, so "is my tablet working?" is answerable without
 * committing a stroke to a document. The trace is drawn with the same
 * pressure→width relationship the engine uses.
 */
function PressurePad({ curve, enabled }: { curve: PressureCurve; enabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [info, setInfo] = useState<{ type: string; raw: number; eff: number } | null>(null);

  const clear = () => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (cv && ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    lastRef.current = null;
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) * cv.width) / r.width;
    const y = ((e.clientY - r.top) * cv.height) / r.height;
    const eff = effectivePressure(e.pointerType, e.pressure, { enabled, curve });
    setInfo({ type: e.pointerType, raw: e.pressure, eff });
    const prev = lastRef.current;
    if (prev) {
      ctx.strokeStyle = "var(--accent)";
      ctx.strokeStyle = getComputedStyle(cv).getPropertyValue("color") || "#888";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1, eff * 14);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    lastRef.current = { x, y };
  };

  return (
    <div className={styles.penPad}>
      <canvas
        ref={ref}
        width={520}
        height={130}
        className={styles.penPadCanvas}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          lastRef.current = null;
          draw(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          draw(e);
        }}
        onPointerUp={() => {
          lastRef.current = null;
        }}
        onPointerLeave={() => {
          lastRef.current = null;
        }}
      />
      <div className={styles.penPadInfo}>
        {info ? (
          <>
            <span>
              Device <strong>{info.type || "unknown"}</strong>
            </span>
            <span>
              Reported <strong>{info.raw.toFixed(2)}</strong>
            </span>
            <span>
              Used <strong>{info.eff.toFixed(2)}</strong>
            </span>
            {info.type === "mouse" && <em>a mouse always paints at full strength</em>}
          </>
        ) : (
          <span>Draw above to test — nothing here touches your document.</span>
        )}
        <button type="button" className={styles.penPadClear} onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  );
}

/** Custom confirmation modal (replaces window.confirm) — portalled above the
 *  Preferences dialog. Esc / backdrop cancel; the destructive action is a
 *  deliberate click (no Enter default), and Cancel takes initial focus. */
function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation(); // don't let the Preferences dialog also close
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.confirmOverlay} onMouseDown={onCancel}>
      <div
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className={styles.confirmTitle}>{title}</span>
        <p className={styles.confirmBody}>{body}</p>
        <div className={styles.confirmFoot}>
          <button ref={cancelRef} type="button" className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`${styles.btn} ${styles.danger}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A labelled colour input using the app's own colour picker (not the native
 *  browser one) — shared by the Transparency / Guides / Cursors tabs. */
function WellColor({
  label,
  value,
  onPick,
  aria,
}: {
  label: string;
  value: string;
  onPick: (c: string) => void;
  aria: string;
}) {
  return (
    <div className={styles.colorWellLabel}>
      <span>{label}</span>
      <ColorChip color={value} onChange={onPick} label={aria} />
    </div>
  );
}

const UNIT_OPTIONS: { value: MeasureUnit; title: string; desc: string }[] = [
  { value: "px", title: "Pixels", desc: "Rulers and size readouts in raw pixels" },
  { value: "in", title: "Inches", desc: "Physical units via the document's resolution (ppi)" },
  { value: "cm", title: "Centimeters", desc: "Physical units via the document's resolution (ppi)" },
];

const CHECKER_SIZE_OPTIONS: { value: CheckerSize; title: string; desc: string }[] = [
  { value: "none", title: "None", desc: "No squares — a flat backdrop behind transparency" },
  { value: "small", title: "Small", desc: "8 px squares" },
  { value: "medium", title: "Medium", desc: "16 px squares — the default" },
  { value: "large", title: "Large", desc: "24 px squares" },
];

const CHECKER_COLOR_OPTIONS: { value: CheckerColors; title: string; desc: string }[] = [
  { value: "auto", title: "Match theme", desc: "Light or dark greys following the app theme" },
  { value: "light", title: "Light", desc: "White with light-grey squares — the classic" },
  { value: "mid", title: "Medium", desc: "Mid greys" },
  { value: "dark", title: "Dark", desc: "Dark greys" },
  { value: "custom", title: "Custom", desc: "Pick the two square colours yourself" },
];

function OptionList<T extends string>({
  options,
  value,
  onPick,
}: {
  options: { value: T; title: string; desc: string }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className={styles.options}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.option}
          data-active={value === o.value}
          onClick={() => onPick(o.value)}
        >
          <span className={styles.radio} />
          <span className={styles.optText}>
            <strong>{o.title}</strong>
            <em>{o.desc}</em>
          </span>
        </button>
      ))}
    </div>
  );
}

interface CacheStats {
  enabled: boolean;
  entries: number;
  bytes: number;
  budget: number;
  hits: number;
  misses: number;
  /** Resident tiles across tiled products (very large documents; 0 = untiled). */
  tiles: number;
}

export default function PreferencesDialog({
  initialTheme,
  prefs,
  onChange,
  getCacheStats,
  initialTab = "appearance",
  onTabChange,
  onClose,
}: {
  initialTheme: Theme;
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  /** Live render-cache stats for the Performance tab (null before first frame). */
  getCacheStats?: () => CacheStats | null;
  /** Section to open on (menu deep-links: Performance / Scratch disks). */
  initialTab?: PrefsTab;
  /** Reports section switches so re-opening lands on the last-visited tab. */
  onTabChange?: (t: PrefsTab) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // Files ▸ Export defaults: only formats this browser can actually encode.
  const [exportFormats] = useState(() => availableFormats());
  const importInputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(() => currentTheme(initialTheme));
  const [accent, setAccent] = useState<Accent>(() => liveAccent());
  const [uiScale, setUiScale] = useState<UiScale>(() => liveUiScale());
  const dark = resolvedDark(theme);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };
  const pickAccent = (a: Accent) => {
    setAccent(a);
    applyAccent(a);
  };
  const pickUiScale = (s: UiScale) => {
    setUiScale(s);
    applyUiScale(s);
  };

  // The semantic colours the accent must stay distinct from, read from the LIVE
  // tokens (after a frame, so a just-applied theme/CVD swap is already in them).
  const [semantics, setSemantics] = useState<{ name: string; hex: string }[]>([]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSemantics(readSemantics()));
    return () => cancelAnimationFrame(id);
  }, [dark, theme, prefs.colorVision, prefs.highContrast]);
  // Rank the accents by how far they stay from the semantic colours under the
  // chosen vision. Tritanopia and monochromacy leave NO accent fully clear — the
  // triad already occupies the hue axis they can still see — so flagging all six
  // would be true but useless. An accent is badged only when it is both below
  // the readability threshold AND meaningfully worse than the best on offer,
  // and the hint names the clearest choice instead of just complaining.
  const accentReports = ACCENTS.map((a) => ({
    id: a.id,
    label: a.label,
    report: accentSafety(dark ? a.dark : a.light, semantics, prefs.colorVision),
  }));
  const bestMargin = Math.max(...accentReports.map((r) => r.report.minDeltaE), 0);
  const isBadged = (m: number) => m < SAFE_DELTA_E && m < bestMargin - 4;
  const bestAccent = accentReports.find((r) => r.report.minDeltaE === bestMargin);
  const activeReport = accentReports.find((r) => r.id === accent)?.report;
  const unsafeAccent =
    activeReport && activeReport.minDeltaE < SAFE_DELTA_E
      ? activeReport.clashesWith.join(" and ")
      : "";

  // Live cache stats while the Performance tab is visible (1s cadence).
  const [stats, setStats] = useState<CacheStats | null>(null);
  useEffect(() => {
    if (tab !== "performance" || !getCacheStats) return;
    const read = () => setStats(getCacheStats());
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Storage tab: what the browser holds for this app (loaded when opened,
  // re-loaded after any clear action). All reads are best-effort.
  interface StorageInfo {
    estimate: { usage: number; quota: number } | null;
    persisted: boolean | null;
    autosave: { savedAt: number; docs: number; bytes: number } | null;
    recents: number;
    settings: number;
    presets: number;
  }
  const [store, setStore] = useState<StorageInfo | null>(null);
  // Restore-defaults confirmation (custom modal, not window.confirm).
  const [confirmReset, setConfirmReset] = useState(false);
  const loadStore = async () => {
    const [estimate, persisted, autosave, recents] = await Promise.all([
      estimateStorage(),
      isPersisted(),
      autosaveInfo(),
      listRecents().then((l) => l.length).catch(() => 0),
    ]);
    setStore({ estimate, persisted, autosave, recents, settings: settingsBytes(), presets: presetsBytes() });
  };
  useEffect(() => {
    if (tab === "storage") void loadStore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={`${styles.dialog} ${styles.prefsDialog}`}
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>Preferences</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.prefsLayout}>
          <nav className={styles.prefsNav} aria-label="Preference sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.prefsNavItem}
                data-active={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  onTabChange?.(t.id);
                }}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </nav>

          <div className={styles.prefsPane}>
            {tab === "appearance" && (
              <>
                <p className={styles.paneIntro}>
                  Customize how Graphiq Studio looks on this device. Changes apply instantly.
                </p>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>Theme</span>
                  <div className={styles.themeCards}>
                    {THEME_OPTIONS.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={styles.themeCard}
                        data-selected={theme === t.id}
                        onClick={() => pickTheme(t.id)}
                      >
                        <span className={styles.themePreview} data-mode={t.id}>
                          <span className={styles.pBar} style={{ width: "56%", height: 8 }} />
                          <span className={styles.pBar} style={{ width: "82%" }} />
                          <span className={styles.pBar} style={{ width: "44%" }} />
                          <span className={styles.pDot} />
                        </span>
                        <span className={styles.themeMeta}>
                          <span className={styles.themeRadio} data-on={theme === t.id} />
                          {t.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>Accent color</span>
                  <div className={styles.accentRow}>
                    {ACCENTS.map((a) => {
                      const hex = dark ? a.dark : a.light;
                      // The accent marks selection and active state, so it has to
                      // stay distinct from the colours that MEAN something. The
                      // verdict is computed, not curated — swatches are shown as
                      // the chosen vision renders them.
                      const report =
                        accentReports.find((r) => r.id === a.id)?.report ??
                        accentSafety(hex, semantics, prefs.colorVision);
                      const badged = isBadged(report.minDeltaE);
                      const shown = simulateHex(hex, prefs.colorVision);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={styles.accentDot}
                          data-selected={accent === a.id}
                          data-unsafe={badged || undefined}
                          style={{ background: shown }}
                          title={
                            report.safe
                              ? `${a.label} — distinct from danger / success / warning (ΔE ${Math.round(report.minDeltaE)})`
                              : `${a.label} — hard to tell from ${report.clashesWith.join(" and ")} (ΔE ${Math.round(report.minDeltaE)})`
                          }
                          aria-label={`${a.label} accent${report.safe ? "" : `, may clash with ${report.clashesWith.join(" and ")}`}`}
                          onClick={() => pickAccent(a.id)}
                        >
                          {accent === a.id && <Check size={14} strokeWidth={3} />}
                          {badged && (
                            <span className={styles.accentWarn} aria-hidden>
                              <TriangleAlert size={11} strokeWidth={2.5} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {unsafeAccent && (
                    <p className={styles.sectionHint}>
                      <TriangleAlert size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                      This accent is hard to tell apart from <strong>{unsafeAccent}</strong>
                      {prefs.colorVision === "none"
                        ? ""
                        : " with the colour vision set in Accessibility"}
                      , so a selected item can read as a warning or an error.
                      {bestAccent && bestAccent.id !== accent && (
                        <> The clearest here is <strong>{bestAccent.label}</strong>.</>
                      )}
                    </p>
                  )}
                </section>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>Interface scale</span>
                  <OptionList options={SCALE_OPTIONS} value={uiScale} onPick={pickUiScale} />
                  <p className={styles.sectionHint}>
                    Scales the bars, panels, menus and dialogs. The canvas view is never
                    scaled — document pixels always render exactly.
                  </p>
                </section>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>Motion &amp; accessibility</span>
                  <div className={styles.motionCard}>
                    <div className={styles.rowText}>
                      <strong>Reduce motion</strong>
                      <em>Minimize non-essential animations and panel transitions</em>
                    </div>
                    <button
                      type="button"
                      className={styles.switch}
                      role="switch"
                      aria-checked={prefs.reduceMotion}
                      aria-label="Reduce motion"
                      data-on={prefs.reduceMotion}
                      onClick={() => onChange({ reduceMotion: !prefs.reduceMotion })}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                </section>
              </>
            )}

            {tab === "pasting" && (
              <>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Default destination</span>
                  <OptionList
                    options={PASTE_OPTIONS}
                    value={prefs.defaultPaste}
                    onPick={(v) => onChange({ defaultPaste: v })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Oversized images</span>
                  <p className={styles.sectionHint}>
                    When a pasted image is larger than the canvas (and the destination keeps the
                    current canvas):
                  </p>
                  <OptionList
                    options={OVERSIZE_OPTIONS}
                    value={prefs.pasteOversize}
                    onPick={(v) => onChange({ pasteOversize: v })}
                  />
                </section>
              </>
            )}

            {tab === "editing" && (
              <>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>New documents</span>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Ask for a size</strong>
                      <em>Show the New Document dialog; off = create with the defaults below</em>
                    </div>
                    <Toggle label="" checked={prefs.newDocAsk} onChange={(v) => onChange({ newDocAsk: v })} />
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Default size</strong>
                      <em>Width × height in pixels</em>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <div className={styles.searchBox} style={{ width: 76, padding: "0 8px" }}>
                        <input
                          type="number"
                          min={1}
                          max={8192}
                          value={prefs.newDocWidth}
                          onChange={(e) =>
                            onChange({ newDocWidth: Math.max(1, Math.min(8192, Math.round(Number(e.target.value)) || 1)) })
                          }
                        />
                      </div>
                      <span style={{ color: "var(--text-3)", fontSize: 12 }}>×</span>
                      <div className={styles.searchBox} style={{ width: 76, padding: "0 8px" }}>
                        <input
                          type="number"
                          min={1}
                          max={8192}
                          value={prefs.newDocHeight}
                          onChange={(e) =>
                            onChange({ newDocHeight: Math.max(1, Math.min(8192, Math.round(Number(e.target.value)) || 1)) })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Gradients</span>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Snap midpoint to centre</strong>
                      <em>Snap the gradient&apos;s middle line to the centre when it&apos;s close</em>
                    </div>
                    <Toggle
                      label=""
                      checked={prefs.gradientSnap}
                      onChange={(v) => onChange({ gradientSnap: v })}
                    />
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>History</span>
                  <p className={styles.sectionHint}>
                    Max actions shown before the History panel starts scrolling.
                  </p>
                  <Slider
                    label="Max visible actions"
                    min={5}
                    max={100}
                    value={prefs.maxHistory}
                    onChange={(n) => onChange({ maxHistory: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Attribution</span>
                  <p className={styles.sectionHint}>
                    Embedded in exported images (EXIF/XMP) when a document doesn&apos;t set its
                    own author or copyright in the Metadata panel. Leave blank for none.
                  </p>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Author</strong>
                      <em>EXIF Artist / XMP dc:creator</em>
                    </div>
                    <div className={styles.searchBox} style={{ width: 190, padding: "0 10px" }}>
                      <input
                        value={prefs.authorName}
                        placeholder="Your name"
                        onChange={(e) => onChange({ authorName: e.target.value })}
                        aria-label="Default author name"
                      />
                    </div>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Copyright notice</strong>
                      <em>EXIF Copyright / XMP dc:rights</em>
                    </div>
                    <div className={styles.searchBox} style={{ width: 190, padding: "0 10px" }}>
                      <input
                        value={prefs.copyrightNotice}
                        placeholder="© 2026 Your name"
                        onChange={(e) => onChange({ copyrightNotice: e.target.value })}
                        aria-label="Default copyright notice"
                      />
                    </div>
                  </div>
                </section>
              </>
            )}

            {tab === "files" && (
              <>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Autosave</span>
                  <p className={styles.sectionHint}>
                    Snapshots every open document so an unexpected exit can be restored. 0 turns
                    it off.
                  </p>
                  <Slider
                    label="Interval"
                    min={0}
                    max={10}
                    unit=" min"
                    value={prefs.autosaveMinutes}
                    onChange={(n) => onChange({ autosaveMinutes: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Export defaults</span>
                  <p className={styles.sectionHint}>
                    What Export As opens with — format and quality stay fully editable in the
                    dialog each time.
                  </p>
                  <OptionList
                    options={exportFormats.map((f) => ({
                      value: f.id,
                      title: `${f.label} (.${f.ext})`,
                      desc: f.lossy
                        ? `Lossy — opens at the default quality below${f.alpha ? ", supports transparency" : ""}`
                        : "Lossless, supports transparency",
                    }))}
                    value={
                      exportFormats.some((f) => f.id === prefs.defaultExportFormatId)
                        ? prefs.defaultExportFormatId
                        : exportFormats[0].id
                    }
                    onPick={(v) => onChange({ defaultExportFormatId: v })}
                  />
                  <Slider
                    label="Default quality"
                    min={1}
                    max={100}
                    unit="%"
                    value={prefs.defaultExportQuality}
                    onChange={(n) => onChange({ defaultExportQuality: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Recent files</span>
                  <p className={styles.sectionHint}>
                    How many projects File ▸ Open recent remembers. Shrinking applies as new
                    entries are added; the Storage tab can clear the list entirely.
                  </p>
                  <Slider
                    label="Remembered projects"
                    min={4}
                    max={20}
                    value={prefs.recentsLimit}
                    onChange={(n) => onChange({ recentsLimit: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Libraries</span>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Share saved gradients</strong>
                      <em>Layer styles use the same saved &amp; imported presets as the gradient tool</em>
                    </div>
                    <Toggle
                      label=""
                      checked={prefs.sharedGradients}
                      onChange={(v) => onChange({ sharedGradients: v })}
                    />
                  </div>
                </section>
              </>
            )}

            {tab === "units" && (
              <>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Measurement unit</span>
                  <OptionList
                    options={UNIT_OPTIONS}
                    value={prefs.unit}
                    onPick={(v) => onChange({ unit: v })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Resolution</span>
                  <p className={styles.sectionHint}>
                    Default resolution stamped on new documents — it drives inch/cm rulers,
                    physical size readouts and true-size printing. Each document can override it
                    in the New document dialog.
                  </p>
                  <Slider
                    label="Default resolution"
                    min={72}
                    max={600}
                    step={1}
                    unit=" ppi"
                    value={prefs.defaultDpi}
                    onChange={(n) => onChange({ defaultDpi: n })}
                  />
                </section>
              </>
            )}

            {tab === "transparency" && (
              <>
                <p className={styles.paneIntro}>
                  The checkerboard shown behind transparent areas of the canvas. It lives in
                  screen space, so the squares keep their size at every zoom level.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Preview</span>
                  <div
                    className={styles.checkerPreview}
                    style={checkerCSS(
                      prefs.checkerSize,
                      prefs.checkerColors,
                      prefs.checkerA,
                      prefs.checkerB,
                    )}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Grid size</span>
                  <OptionList
                    options={CHECKER_SIZE_OPTIONS}
                    value={prefs.checkerSize}
                    onPick={(v) => onChange({ checkerSize: v })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Grid colors</span>
                  <OptionList
                    options={CHECKER_COLOR_OPTIONS}
                    value={prefs.checkerColors}
                    onPick={(v) => onChange({ checkerColors: v })}
                  />
                  {prefs.checkerColors === "custom" && (
                    <div className={styles.colorWellRow}>
                      <WellColor
                        label="Backdrop"
                        value={prefs.checkerA}
                        onPick={(c) => onChange({ checkerA: c })}
                        aria="Backdrop colour"
                      />
                      <WellColor
                        label="Squares"
                        value={prefs.checkerB}
                        onPick={(c) => onChange({ checkerB: c })}
                        aria="Square colour"
                      />
                    </div>
                  )}
                </section>
              </>
            )}

            {tab === "guides" && (
              <>
                <p className={styles.paneIntro}>
                  The document grid and pixel grid overlays, and how strongly things snap.
                  Toggle the grids from the View menu; these settings shape them.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Document grid</span>
                  <p className={styles.sectionHint}>
                    View ▸ Document grid draws a gridline every {prefs.gridSpacing} px with
                    {" "}{prefs.gridSubdivisions > 1 ? `${prefs.gridSubdivisions} subdivisions` : "no subdivisions"} —
                    lines hide automatically when the zoom would mush them together.
                  </p>
                  <Slider
                    label="Gridline every"
                    min={8}
                    max={256}
                    step={8}
                    unit=" px"
                    value={prefs.gridSpacing}
                    onChange={(n) => onChange({ gridSpacing: n })}
                  />
                  <Slider
                    label="Subdivisions"
                    min={1}
                    max={8}
                    step={1}
                    value={prefs.gridSubdivisions}
                    onChange={(n) => onChange({ gridSubdivisions: n })}
                  />
                  <div className={styles.colorWellRow}>
                    <WellColor
                      label="Grid colour"
                      value={prefs.gridColor}
                      onPick={(c) => onChange({ gridColor: c })}
                      aria="Document grid colour"
                    />
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Pixel grid</span>
                  <p className={styles.sectionHint}>
                    The 1-pixel cell lines (View ▸ Pixel grid, Ctrl+&apos;) that appear from
                    400% zoom.
                  </p>
                  <div className={styles.colorWellRow}>
                    <WellColor
                      label="Line colour"
                      value={prefs.pixelGridColor}
                      onPick={(c) => onChange({ pixelGridColor: c })}
                      aria="Pixel grid colour"
                    />
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Snapping</span>
                  <p className={styles.sectionHint}>
                    How close (in screen pixels) a handle has to get before it snaps — the
                    shape tools&apos; symmetry snaps use this. Selections snapping to whole
                    pixels is the on/off View ▸ Snap toggle, not a distance.
                  </p>
                  <Slider
                    label="Snap distance"
                    min={2}
                    max={16}
                    step={1}
                    unit=" px"
                    value={prefs.snapDistance}
                    onChange={(n) => onChange({ snapDistance: n })}
                  />
                </section>
              </>
            )}

            {tab === "cursors" && (
              <>
                <p className={styles.paneIntro}>
                  How the paint tools&apos; cursor draws on the canvas — the ring scales with
                  zoom and previews the brush&apos;s size and hardness.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Preview</span>
                  <div className={styles.cursorPreview}>
                    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
                      {prefs.paintCursor === "ring" && (
                        <>
                          <circle cx="48" cy="48" r="30" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="3" />
                          <circle cx="48" cy="48" r="30" fill="none" stroke={prefs.ringColor} strokeWidth="1.25" opacity="0.95" />
                          <circle cx="48" cy="48" r="19" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="2.5" strokeDasharray="3 3" />
                          <circle cx="48" cy="48" r="19" fill="none" stroke={prefs.ringColor} strokeWidth="1" opacity="0.8" strokeDasharray="3 3" />
                        </>
                      )}
                      {(prefs.paintCursor === "precise" || prefs.brushCrosshair) && (
                        <>
                          <path
                            d={prefs.paintCursor === "precise" ? "M34 48h28M48 34v28" : "M40 48h16M48 40v16"}
                            stroke="rgba(0,0,0,0.4)"
                            strokeWidth="2.5"
                          />
                          <path
                            d={prefs.paintCursor === "precise" ? "M34 48h28M48 34v28" : "M40 48h16M48 40v16"}
                            stroke={prefs.ringColor}
                            strokeWidth="1"
                            opacity="0.92"
                          />
                        </>
                      )}
                    </svg>
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Painting cursor</span>
                  <OptionList
                    options={[
                      { value: "ring", title: "Brush ring", desc: "Full-size circle with a dashed hardness ring — what the stroke will cover" },
                      { value: "precise", title: "Precise crosshair", desc: "A crosshair at the exact centre, no size preview" },
                    ]}
                    value={prefs.paintCursor}
                    onPick={(v) => onChange({ paintCursor: v })}
                  />
                  {prefs.paintCursor === "ring" && (
                    <div className={styles.motionCard}>
                      <div className={styles.rowText}>
                        <strong>Crosshair in the ring</strong>
                        <em>Mark the exact centre inside the brush ring</em>
                      </div>
                      <button
                        type="button"
                        className={styles.switch}
                        role="switch"
                        aria-checked={prefs.brushCrosshair}
                        aria-label="Crosshair in the ring"
                        data-on={prefs.brushCrosshair}
                        onClick={() => onChange({ brushCrosshair: !prefs.brushCrosshair })}
                      >
                        <span className={styles.switchThumb} />
                      </button>
                    </div>
                  )}
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Ring colour</span>
                  <p className={styles.sectionHint}>
                    Colours the ring, crosshair and the clone tool&apos;s source markers. A dark
                    under-stroke always stays beneath, so any colour reads on light pixels too.
                  </p>
                  <div className={styles.colorWellRow}>
                    <WellColor
                      label="Colour"
                      value={prefs.ringColor}
                      onPick={(c) => onChange({ ringColor: c })}
                      aria="Ring colour"
                    />
                  </div>
                </section>
              </>
            )}

            {tab === "pen" && (
              <>
                <p className={styles.paneIntro}>
                  Settings for drawing tablets, styluses and touchscreens. A mouse is never
                  affected: browsers report a constant 0.5 pressure for a held mouse button, so
                  pressure is only read from devices that actually measure it.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Test your pen</span>
                  <p className={styles.sectionHint}>
                    Draw in the box to see what the browser reports — the device type, the raw
                    pressure and the curved value the brush will use.
                  </p>
                  <PressurePad curve={prefs.pressureCurve} enabled={prefs.penPressure} />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Pen pressure</span>
                  <div className={styles.motionCard}>
                    <div className={styles.rowText}>
                      <strong>Use stylus pressure</strong>
                      <em>Pressure drives the brush — each brush chooses size and/or flow</em>
                    </div>
                    <button
                      type="button"
                      className={styles.switch}
                      role="switch"
                      aria-checked={prefs.penPressure}
                      aria-label="Use stylus pressure"
                      data-on={prefs.penPressure}
                      onClick={() => onChange({ penPressure: !prefs.penPressure })}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Pressure curve</span>
                  <p className={styles.sectionHint}>
                    How hard you have to press for full strength. Which brush properties respond
                    is set per brush, in the brush options bar.
                  </p>
                  <OptionList
                    options={PRESSURE_CURVES.map((c) => ({
                      value: c.id,
                      title: c.label,
                      desc: c.hint,
                    }))}
                    value={prefs.pressureCurve}
                    onPick={(v) => onChange({ pressureCurve: v })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Touch</span>
                  <div className={styles.motionCard}>
                    <div className={styles.rowText}>
                      <strong>Palm rejection</strong>
                      <em>
                        Once a stylus has been used, touch stops drawing — two-finger pan and
                        pinch-zoom keep working, so you can rest your hand on the screen
                      </em>
                    </div>
                    <button
                      type="button"
                      className={styles.switch}
                      role="switch"
                      aria-checked={prefs.palmRejection}
                      aria-label="Palm rejection"
                      data-on={prefs.palmRejection}
                      onClick={() => onChange({ palmRejection: !prefs.palmRejection })}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                  <p className={styles.sectionHint}>
                    Two fingers pan and zoom the canvas at any time. A stylus with an eraser end
                    erases while it&apos;s turned over, without changing the selected tool.
                  </p>
                </section>
              </>
            )}

            {tab === "a11y" && (
              <>
                <p className={styles.paneIntro}>
                  Colour is the one place this interface carries meaning without words — red for
                  danger, green for success, amber for a warning. These settings retune that set so
                  it stays readable, and firm up the whole theme.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Colour vision</span>
                  <p className={styles.sectionHint}>
                    Pick the deficiency to accommodate. The app swaps in a palette whose colours
                    stay apart for that kind of vision, and the accent picker in Appearance starts
                    flagging accents that would clash.
                  </p>
                  <OptionList
                    options={CVD_TYPES.map((t) => ({ value: t.id, title: t.label, desc: t.hint }))}
                    value={prefs.colorVision}
                    onPick={(v) => onChange({ colorVision: v })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Preview</span>
                  <p className={styles.sectionHint}>
                    The semantic colours as you see them, and as this deficiency renders them. The
                    number under each pair is the smallest colour difference in the row — below
                    about {SAFE_DELTA_E} two colours read as the same at a glance.
                  </p>
                  <CvdPreview type={prefs.colorVision} dark={dark} accent={accent} />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Contrast</span>
                  <div className={styles.motionCard}>
                    <div className={styles.rowText}>
                      <strong>High contrast</strong>
                      <em>
                        Stronger borders and input outlines, darker secondary text and a thicker
                        focus ring — within your current theme
                      </em>
                    </div>
                    <button
                      type="button"
                      className={styles.switch}
                      role="switch"
                      aria-checked={prefs.highContrast}
                      aria-label="High contrast"
                      data-on={prefs.highContrast}
                      onClick={() => onChange({ highContrast: !prefs.highContrast })}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                  {prefs.colorVision === "achromatopsia" && (
                    <p className={styles.sectionHint}>
                      With no colour vision at all, only lightness separates these — and three
                      readable colours on one background can only spread so far. High contrast is
                      worth turning on alongside it.
                    </p>
                  )}
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Motion</span>
                  <div className={styles.motionCard}>
                    <div className={styles.rowText}>
                      <strong>Reduce motion</strong>
                      <em>Minimize non-essential animations and panel transitions</em>
                    </div>
                    <button
                      type="button"
                      className={styles.switch}
                      role="switch"
                      aria-checked={prefs.reduceMotion}
                      aria-label="Reduce motion (accessibility)"
                      data-on={prefs.reduceMotion}
                      onClick={() => onChange({ reduceMotion: !prefs.reduceMotion })}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                  </div>
                </section>
              </>
            )}

            {tab === "performance" && (
              <>
                <p className={styles.paneIntro}>
                  The render cache keeps composited layer products in memory so unchanged parts of
                  the document never recompute. A bigger budget helps large, layered documents; a
                  smaller one frees memory sooner.
                </p>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Render cache</span>
                  <Slider
                    label="Memory budget"
                    min={64}
                    max={1024}
                    step={64}
                    unit=" MB"
                    value={prefs.cacheBudgetMB}
                    onChange={(n) => onChange({ cacheBudgetMB: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Undo</span>
                  <p className={styles.sectionHint}>
                    Steps kept in memory — pixel patches are the biggest memory use. Older steps
                    drop off the far end.
                  </p>
                  <Slider
                    label="Undo steps"
                    min={10}
                    max={200}
                    step={10}
                    value={prefs.historyLimit}
                    onChange={(n) => onChange({ historyLimit: n })}
                  />
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Compute</span>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Background workers</strong>
                      <em>
                        Blur gallery, smart filters, healing and RAW decode run off-thread; turn
                        off only when debugging (everything falls back to synchronous)
                      </em>
                    </div>
                    <Toggle
                      label=""
                      checked={prefs.useWorkers}
                      onChange={(on) => onChange({ useWorkers: on })}
                    />
                  </div>
                </section>
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Live statistics</span>
                  {stats ? (
                    <div className={styles.statsCard}>
                      <div className={styles.statRow}>
                        <span>Memory used</span>
                        <strong>
                          {(stats.bytes / (1024 * 1024)).toFixed(1)} of{" "}
                          {Math.round(stats.budget / (1024 * 1024))} MB
                        </strong>
                      </div>
                      <div className={styles.statMeter}>
                        <span
                          style={{
                            width: `${Math.min(100, (stats.bytes / Math.max(1, stats.budget)) * 100)}%`,
                          }}
                        />
                      </div>
                      <div className={styles.statRow}>
                        <span>Cached products</span>
                        <strong>
                          {stats.entries}
                          {stats.tiles > 0 ? ` (${stats.tiles} tiles)` : ""}
                        </strong>
                      </div>
                      <div className={styles.statRow}>
                        <span>Hit rate (this session)</span>
                        <strong>
                          {stats.hits + stats.misses > 0
                            ? `${Math.round((stats.hits / (stats.hits + stats.misses)) * 100)}%`
                            : "—"}
                        </strong>
                      </div>
                      <div className={styles.statRow}>
                        <span>Cache</span>
                        <strong>{stats.enabled ? "On" : "Off (debug)"}</strong>
                      </div>
                    </div>
                  ) : (
                    <p className={styles.sectionHint}>Open a document to see cache activity.</p>
                  )}
                </section>
              </>
            )}

            {tab === "storage" && (
              <>
                <p className={styles.paneIntro}>
                  Graphiq Studio has no scratch-disk files — work in progress lives in memory,
                  and what persists sits in this browser&apos;s storage for this site. Nothing is
                  ever uploaded.
                </p>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>Site storage</span>
                  {store?.estimate ? (
                    <div className={styles.statsCard}>
                      <div className={styles.statRow}>
                        <span>Used by this site</span>
                        <strong>
                          {fmtBytes(store.estimate.usage)} of {fmtBytes(store.estimate.quota)}{" "}
                          available
                        </strong>
                      </div>
                      <div className={styles.statMeter}>
                        <span
                          style={{
                            width: `${Math.min(100, Math.max(0.5, (store.estimate.usage / Math.max(1, store.estimate.quota)) * 100))}%`,
                          }}
                        />
                      </div>
                      <div className={styles.statRow}>
                        <span>Protected from browser cleanup</span>
                        <strong>
                          {store.persisted === null ? "Unknown" : store.persisted ? "Yes" : "No"}
                        </strong>
                      </div>
                    </div>
                  ) : (
                    <p className={styles.sectionHint}>
                      {store ? "This browser doesn't report a storage estimate." : "Measuring…"}
                    </p>
                  )}
                  {store && store.persisted === false && (
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <strong>Request persistent storage</strong>
                        <em>
                          Asks the browser never to auto-evict this site&apos;s data (autosave
                          snapshots, recent files) under storage pressure
                        </em>
                      </div>
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={async () => {
                          await requestPersistence();
                          void loadStore();
                        }}
                      >
                        <ShieldCheck size={13} /> Request
                      </button>
                    </div>
                  )}
                </section>

                <section className={styles.section}>
                  <span className={styles.groupLabel}>What&apos;s stored</span>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Autosave snapshot</strong>
                      <em>
                        {store?.autosave
                          ? `${store.autosave.docs} document${store.autosave.docs === 1 ? "" : "s"}, ~${fmtBytes(store.autosave.bytes)} — saved ${new Date(store.autosave.savedAt).toLocaleString()}`
                          : "No snapshot stored (crash recovery has nothing to restore)"}
                      </em>
                    </div>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={!store?.autosave}
                      onClick={async () => {
                        if (!window.confirm("Delete the stored autosave snapshot?\n\nCrash recovery will have nothing to restore until the next autosave runs.")) return;
                        await clearAutosave();
                        void loadStore();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Recent files</strong>
                      <em>
                        {store
                          ? store.recents
                            ? `${store.recents} remembered project${store.recents === 1 ? "" : "s"} (File ▸ Open recent)`
                            : "No recent projects remembered"
                          : "…"}
                      </em>
                    </div>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={!store?.recents}
                      onClick={async () => {
                        if (!window.confirm("Clear the recent-files list?\n\nSaved .gproj files on disk are not touched — only the app's list (and its cached re-open copies) is cleared.")) return;
                        await clearRecents();
                        void loadStore();
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Saved presets, swatches &amp; actions</strong>
                      <em>
                        {store
                          ? `Gradients, swatches, adjustment looks, export presets and recorded actions — ${store.presets ? `~${fmtBytes(store.presets)}` : "none saved"}`
                          : "…"}
                      </em>
                    </div>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={!store?.presets}
                      onClick={() => {
                        if (!window.confirm("Delete every saved preset?\n\nGradient presets, colour swatches, saved adjustment looks, export presets and recorded actions are removed. Built-in presets remain; open documents are untouched.")) return;
                        clearPresets();
                        void loadStore();
                      }}
                    >
                      Delete…
                    </button>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowText}>
                      <strong>Settings</strong>
                      <em>
                        {store ? `Preferences, tool options, workspace layout — ~${fmtBytes(store.settings)}` : "…"}
                        {" · reset via “Restore defaults…” below"}
                      </em>
                    </div>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>

        <footer className={styles.foot} style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className={styles.btn}
            title="Reset every preference, tool option, panel layout and theme to its default"
            onClick={() => setConfirmReset(true)}
          >
            Restore defaults…
          </button>
          <button
            type="button"
            className={styles.btn}
            title="Download every setting as graphiq-settings.json"
            onClick={() => downloadSettings()}
          >
            Export settings
          </button>
          <button
            type="button"
            className={styles.btn}
            title="Load a graphiq-settings.json export (reloads to apply)"
            onClick={() => importInputRef.current?.click()}
          >
            Import settings…
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (importSettings(await f.text())) window.location.reload();
              else window.alert("That file isn't a Graphiq settings export.");
            }}
          />
          <span style={{ flex: 1 }} />
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onClose}>
            Done
          </button>
        </footer>
      </div>

      {confirmReset && (
        <ConfirmModal
          title="Restore defaults?"
          body={
            "Tool options, panel layout, theme, accent, colour management and every " +
            "Preferences setting return to factory state. Saved gradients, swatches, " +
            "presets and recent files are kept.\n\nThe app reloads to apply."
          }
          confirmLabel="Restore defaults"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            resetSettings();
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
