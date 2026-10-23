"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight } from "lucide-react";
import styles from "./Toolbar.module.scss";
import { ALL_TOOLS, RAIL_CLUSTER_NAMES, RAIL_SLOTS, type Tool, type ToolId } from "../lib/tools";
import ColorPopover from "./ColorPopover";
import { swatchBg } from "../lib/color";
import { uiZoom } from "../lib/ui-scale";
import { clampY } from "../lib/safeArea";
import { exitProps, useLinger } from "../lib/use-presence";
import { useColors, useEditorStores } from "../state/editor";

const byId = (id: ToolId): Tool => ALL_TOOLS.find((t) => t.id === id)!;
/** The rail's slots, flattened, as tools. */
const SLOTS: Tool[][] = RAIL_SLOTS.flat(1).map((slot) => slot.map(byId));
const slotOf = (id: ToolId) => SLOTS.findIndex((slot) => slot.some((t) => t.id === id));
/** How long a press has to be held before a slot opens its flyout. */
const HOLD_MS = 380;

interface Props {
  tool: ToolId;
  onToolChange: (id: ToolId) => void;
  /** Touch layout: six tools up front, the rest in a labelled grid. */
  mobile?: boolean;
  /**
   * Parked off-screen, so nothing in here should be reachable by anything.
   *
   * The phone's rail lives at x:-320 when its drawer is shut. It was still in
   * the tab order: measured, 46 of 59 tab stops on a phone were controls no
   * finger could touch, most of them these. `inert` takes the whole subtree out
   * of the tab order, out of hit-testing and out of the accessibility tree at
   * once, which is exactly what "parked" means.
   */
  parked?: boolean;
}

export default function Toolbar({
  tool,
  onToolChange,
  mobile = false,
  parked = false,
}: Props) {
  // The two colours: the editor's store (TODO 1.5).
  const { colors } = useEditorStores();
  const { foreground, background } = useColors((c) => c);
  const onForeground = colors.setter("foreground");
  const onBackground = colors.setter("background");
  const onSwap = () => colors.set((c) => ({ foreground: c.background, background: c.foreground }));
  /* ---- Desktop slots ----
     Each slot shows one tool of its family: the active one if it belongs here,
     otherwise the last one used from it (its first tool before that). The pick
     is remembered during render, as the active tool changes — keyboard
     shortcuts included — rather than in an effect a frame later. */
  const [picks, setPicks] = useState<Record<number, ToolId>>({});
  const [seen, setSeen] = useState(tool);
  if (seen !== tool) {
    setSeen(tool);
    const si = slotOf(tool);
    if (si >= 0 && picks[si] !== tool) setPicks({ ...picks, [si]: tool });
  }
  const shown = (si: number): Tool => {
    const slot = SLOTS[si];
    return slot.find((t) => t.id === tool) ?? slot.find((t) => t.id === picks[si]) ?? slot[0];
  };

  /* The flyout: the rest of a slot's family, beside it. Opened by right-click
     or by holding the button; closed by a pick, a click outside or Escape. */
  const [fly, setFly] = useState<{
    si: number;
    top: number;
    left: number;
  } | null>(null);
  // Still drawn for its exit after it closes, from where it was.
  const { shown: flyShown, closing: flyClosing } = useLinger(fly);
  const flyRef = useRef<HTMLDivElement>(null);
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const openFly = (si: number, el: HTMLElement) => {
    if (SLOTS[si].length < 2) return;
    const z = uiZoom();
    const r = el.getBoundingClientRect();
    const h = (SLOTS[si].length * 34 + 12) * z;
    // Clear of the rail card (its 8px padding + border), with the shell's gap.
    const rail = el.closest("aside")?.getBoundingClientRect().right ?? r.right;
    setFly({ si, left: (rail + 8) / z, top: clampY(r.top - 6 * z, h, 8) / z });
  };
  useEffect(() => {
    if (!fly) return;
    const onDown = (e: PointerEvent) => {
      if (!flyRef.current?.contains(e.target as Node)) setFly(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFly(null);
    };
    const onResize = () => setFly(null);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    flyRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [fly]);
  const startHold = (si: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || SLOTS[si].length < 2) return;
    const el = e.currentTarget;
    const h = { fired: false, timer: 0 };
    h.timer = window.setTimeout(() => {
      h.fired = true;
      openFly(si, el);
    }, HOLD_MS);
    hold.current = h;
  };
  const endHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };

  /* One button, rendered the same way in the rail and in the grid — the label
     is what differs, and it is what the phone came for. The keyboard shortcut
     badge is deliberately absent on touch: a `kbd` hint is a promise about a
     key, and the device has none. */
  const toolButton = (t: Tool, labelled: boolean) => {
    const Icon = t.icon;
    const active = tool === t.id;
    return (
      <button
        key={t.id}
        type="button"
        className={labelled ? styles.toolCell : styles.tool}
        data-active={active}
        data-tool={t.id}
        onClick={() => onToolChange(t.id)}
        aria-pressed={active}
        aria-label={t.name}
        title={`${t.name} (${t.shortcut})`}
      >
        {labelled ? (
          <>
            <span className={styles.toolIcon}>
              <Icon size={20} />
            </span>
            <span className={styles.toolLabel}>{t.name}</span>
          </>
        ) : (
          <>
            <Icon size={18} />
            <kbd className={styles.kbd}>{t.shortcut}</kbd>
          </>
        )}
      </button>
    );
  };

  if (mobile) {
    return (
      <aside
        className={styles.toolbar}
        aria-label="Tools"
        data-tour="toolbar"
        data-mobile-rail
        inert={parked || undefined}
      >
        {/* The sheet's header: what it is, and the two colours beside it. */}
        <div className={styles.sheetHead}>
          <span className={styles.sheetTitle}>Tools</span>
          <div className={styles.colors}>
            <div className={styles.swatchStack}>
              <ColorPopover
                color={background}
                onChange={onBackground}
                wrapClassName={styles.swatchWrapBg}
                className={styles.swatch}
                style={swatchBg(background)}
                title="Background color"
                ariaLabel="Background color"
                align="right-end"
              />
              <ColorPopover
                color={foreground}
                onChange={onForeground}
                wrapClassName={styles.swatchWrapFg}
                className={styles.swatch}
                style={swatchBg(foreground)}
                title="Foreground color"
                ariaLabel="Foreground color"
                align="right-end"
              />
              <button
                type="button"
                className={styles.swap}
                onClick={onSwap}
                title="Swap colors (X)"
                aria-label="Swap foreground and background colors"
              >
                <ArrowLeftRight size={9} />
              </button>
            </div>
          </div>
        </div>

        {/* The same families as the desktop rail, as titled groups of tiles:
            every tool named, nothing behind a flyout. */}
        <div className={styles.tools}>
          {RAIL_SLOTS.map((cluster, ci) => (
            <section key={ci} className={styles.sheetGroup} data-tool-section={RAIL_CLUSTER_NAMES[ci]}>
              <span className={styles.sheetLabel}>{RAIL_CLUSTER_NAMES[ci]}</span>
              <div className={styles.toolGrid}>{cluster.flat().map((id) => toolButton(byId(id), true))}</div>
            </section>
          ))}
        </div>
      </aside>
    );
  }

  let next = 0;
  const rail = RAIL_SLOTS.map((cluster) => cluster.map(() => next++));
  return (
    <aside className={styles.toolbar} aria-label="Tools" data-tour="toolbar">
      <div className={styles.tools}>
        {rail.map((cluster, ci) => (
          <div key={ci} className={styles.group}>
            {cluster.map((i) => {
              const t = shown(i);
              const Icon = t.icon;
              const active = tool === t.id;
              const more = SLOTS[i].length > 1;
              return (
                <button
                  key={i}
                  type="button"
                  className={styles.tool}
                  data-active={active}
                  data-more={more || undefined}
                  data-tool={t.id}
                  onClick={() => {
                    // A hold that opened the flyout is not also a click.
                    if (hold.current?.fired) {
                      hold.current = null;
                      return;
                    }
                    onToolChange(t.id);
                  }}
                  onPointerDown={startHold(i)}
                  onPointerUp={endHold}
                  onPointerLeave={endHold}
                  onContextMenu={(e) => {
                    if (!more) return;
                    e.preventDefault();
                    openFly(i, e.currentTarget);
                  }}
                  aria-pressed={active}
                  aria-label={t.name}
                  aria-haspopup={more ? "menu" : undefined}
                  aria-expanded={more ? fly?.si === i : undefined}
                  title={
                    more ? `${t.name} (${t.shortcut}) — right-click or hold for more` : `${t.name} (${t.shortcut})`
                  }
                >
                  <Icon size={18} />
                  <kbd className={styles.kbd}>{t.shortcut}</kbd>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {flyShown &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={flyRef}
            className={styles.flyout}
            {...exitProps(flyClosing)}
            role="menu"
            aria-label={`${shown(flyShown.si).name} tools`}
            style={{ top: flyShown.top, left: flyShown.left }}
          >
            {SLOTS[flyShown.si].map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={tool === t.id}
                  className={styles.flyItem}
                  onClick={() => {
                    onToolChange(t.id);
                    setFly(null);
                  }}
                >
                  <Icon size={16} />
                  <span className={styles.flyName}>{t.name}</span>
                  <kbd className={styles.flyKey}>{t.shortcut}</kbd>
                </button>
              );
            })}
          </div>,
          document.body,
        )}

      <div className={styles.colors}>
        <div className={styles.swatchStack}>
          <ColorPopover
            color={background}
            onChange={onBackground}
            wrapClassName={styles.swatchWrapBg}
            className={styles.swatch}
            style={swatchBg(background)}
            title="Background color"
            ariaLabel="Background color"
            align="right-end"
          />
          <ColorPopover
            color={foreground}
            onChange={onForeground}
            wrapClassName={styles.swatchWrapFg}
            className={styles.swatch}
            style={swatchBg(foreground)}
            title="Foreground color"
            ariaLabel="Foreground color"
            align="right-end"
          />
          <button
            type="button"
            className={styles.swap}
            onClick={onSwap}
            title="Swap colors (X)"
            aria-label="Swap foreground and background colors"
          >
            <ArrowLeftRight size={9} />
          </button>
        </div>
      </div>
    </aside>
  );
}
