"use client";

import { PanelsTopLeft, Wrench } from "lucide-react";
import styles from "./MobileBar.module.scss";
import { getTool, type ToolId } from "../lib/tools";

export type MobileDrawer = "tools" | "panels" | null;

/**
 * The mobile bottom bar — the always-visible home for the two things that
 * became slide-in drawers on small screens: the Tool rail and the panels
 * dock. The centre chip shows (and re-opens) the active tool. Rendered only
 * on mobile; desktop keeps the full StatusBar / side rails.
 */
export default function MobileBar({
  tool,
  drawer,
  onToggle,
}: {
  tool: ToolId;
  drawer: MobileDrawer;
  onToggle: (d: "tools" | "panels") => void;
}) {
  const meta = getTool(tool);
  const ToolIcon = meta.icon;
  return (
    <nav className={styles.bar} data-tour="mobilebar" aria-label="Mobile toolbar">
      <button
        type="button"
        className={styles.btn}
        data-active={drawer === "tools"}
        aria-pressed={drawer === "tools"}
        onClick={() => onToggle("tools")}
      >
        <Wrench size={20} />
        <span>Tools</span>
      </button>

      <button
        type="button"
        className={styles.tool}
        onClick={() => onToggle("tools")}
        aria-label={`Current tool: ${meta.name}. Open tools.`}
      >
        <ToolIcon size={18} strokeWidth={1.9} />
        <span className={styles.toolName}>{meta.name}</span>
      </button>

      <button
        type="button"
        className={styles.btn}
        data-active={drawer === "panels"}
        aria-pressed={drawer === "panels"}
        onClick={() => onToggle("panels")}
      >
        <PanelsTopLeft size={20} />
        <span>Panels</span>
      </button>
    </nav>
  );
}
