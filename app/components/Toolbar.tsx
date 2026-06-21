"use client";

import { ArrowLeftRight } from "lucide-react";
import styles from "./Toolbar.module.scss";
import { TOOL_GROUPS, type ToolId } from "../lib/tools";
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
}

export default function Toolbar({
  tool,
  onToolChange,
  foreground,
  background,
  onForeground,
  onBackground,
  onSwap,
}: Props) {
  return (
    <aside className={styles.toolbar} aria-label="Tools">
      <div className={styles.tools}>
        {TOOL_GROUPS.map((group, gi) => (
          <div key={gi} className={styles.group}>
            {group.map((t) => {
              const Icon = t.icon;
              const active = tool === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={styles.tool}
                  data-active={active}
                  onClick={() => onToolChange(t.id)}
                  aria-pressed={active}
                  aria-label={t.name}
                  title={`${t.name} (${t.shortcut})`}
                >
                  <Icon size={18} strokeWidth={1.9} />
                  <kbd className={styles.kbd}>{t.shortcut}</kbd>
                </button>
              );
            })}
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
