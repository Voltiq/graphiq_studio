"use client";

import { ArrowLeftRight } from "lucide-react";
import styles from "./Toolbar.module.scss";
import {
  OVERFLOW_TOOLS,
  PRIMARY_TOOLS,
  TOOL_GROUPS,
  type Tool,
  type ToolId,
} from "../lib/tools";
import ColorPopover from "./ColorPopover";
import { swatchBg } from "../lib/color";

interface Props {
  tool: ToolId;
  onToolChange: (id: ToolId) => void;
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  onSwap: () => void;
  /** Touch layout: six tools up front, the rest in a labelled grid. */
  mobile?: boolean;
}

export default function Toolbar({
  tool,
  onToolChange,
  foreground,
  background,
  onForeground,
  onBackground,
  onSwap,
  mobile = false,
}: Props) {
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
        <Icon size={labelled ? 20 : 18} strokeWidth={1.9} />
        {labelled ? (
          <span className={styles.toolLabel}>{t.name}</span>
        ) : (
          <kbd className={styles.kbd}>{t.shortcut}</kbd>
        )}
      </button>
    );
  };

  if (mobile) {
    return (
      <aside className={styles.toolbar} aria-label="Tools" data-tour="toolbar" data-mobile-rail>
        <div className={styles.tools}>
          <div className={styles.sheetGroup} data-tool-section="primary">
            <span className={styles.sheetLabel}>Tools</span>
            <div className={styles.toolGrid}>{PRIMARY_TOOLS.map((t) => toolButton(t, true))}</div>
          </div>
          <div className={styles.sheetGroup} data-tool-section="overflow">
            <span className={styles.sheetLabel}>Everything else</span>
            <div className={styles.toolGrid}>{OVERFLOW_TOOLS.map((t) => toolButton(t, true))}</div>
          </div>
        </div>

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

  return (
    <aside className={styles.toolbar} aria-label="Tools" data-tour="toolbar">
      <div className={styles.tools}>
        {TOOL_GROUPS.map((group, gi) => (
          <div key={gi} className={styles.group}>
            {group.map((t) => toolButton(t, false))}
          </div>
        ))}
      </div>

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
