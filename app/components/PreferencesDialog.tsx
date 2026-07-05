"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardPaste, Gauge, Palette, Ruler, SlidersHorizontal, X } from "lucide-react";
import styles from "./PreferencesDialog.module.scss";
import { applyTheme, currentTheme, resolvedDark } from "./ThemeToggle";
import { Slider, Toggle } from "./Controls";
import { ACCENTS, ACCENT_COOKIE, DEFAULT_ACCENT, isAccent, type Accent, type Theme } from "../lib/theme";
import type { MeasureUnit, PasteDefault, PasteOversize, Preferences } from "../lib/prefs";
import { downloadSettings, importSettings, resetSettings } from "../lib/settings";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Theme options as Magiq's preview cards: a mini mock UI + radio + label. */
const THEME_OPTIONS: { id: Theme; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "system", name: "Match system" },
];

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

type Tab = "appearance" | "pasting" | "editing" | "units" | "performance";

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "pasting", label: "Pasting", icon: ClipboardPaste },
  { id: "editing", label: "Editing", icon: SlidersHorizontal },
  { id: "units", label: "Units & rulers", icon: Ruler },
  { id: "performance", label: "Performance", icon: Gauge },
];

const UNIT_OPTIONS: { value: MeasureUnit; title: string; desc: string }[] = [
  { value: "px", title: "Pixels", desc: "Rulers and size readouts in raw pixels" },
  { value: "in", title: "Inches", desc: "Physical units via the document's resolution (ppi)" },
  { value: "cm", title: "Centimeters", desc: "Physical units via the document's resolution (ppi)" },
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
}

export default function PreferencesDialog({
  initialTheme,
  prefs,
  onChange,
  getCacheStats,
  onClose,
}: {
  initialTheme: Theme;
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  /** Live render-cache stats for the Performance tab (null before first frame). */
  getCacheStats?: () => CacheStats | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("appearance");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(() => currentTheme(initialTheme));
  const [accent, setAccent] = useState<Accent>(() => liveAccent());
  const dark = resolvedDark(theme);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };
  const pickAccent = (a: Accent) => {
    setAccent(a);
    applyAccent(a);
  };

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
                onClick={() => setTab(t.id)}
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
                    {ACCENTS.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={styles.accentDot}
                        data-selected={accent === a.id}
                        style={{ background: dark ? a.dark : a.light }}
                        title={a.label}
                        aria-label={`${a.label} accent`}
                        onClick={() => pickAccent(a.id)}
                      >
                        {accent === a.id && <Check size={14} strokeWidth={3} />}
                      </button>
                    ))}
                  </div>
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
                <section className={styles.section}>
                  <span className={styles.groupLabel}>Autosave</span>
                  <p className={styles.sectionHint}>
                    Snapshots the project so an unexpected exit can be restored. 0 turns it off.
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
                        <strong>{stats.entries}</strong>
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
          </div>
        </div>

        <footer className={styles.foot} style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className={styles.btn}
            title="Reset every preference, tool option, panel layout and theme to its default"
            onClick={() => {
              if (
                window.confirm(
                  "Reset all preferences to their defaults?\n\n" +
                    "Tool options, panel layout, theme, accent, colour management and every " +
                    "Preferences setting return to factory state. Saved gradients, swatches, " +
                    "presets and recent files are kept.\n\nThe app reloads to apply.",
                )
              ) {
                resetSettings();
                window.location.reload();
              }
            }}
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
    </div>
  );
}
