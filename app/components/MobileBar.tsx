"use client";

import { Move, PanelsTopLeft, Wrench } from "lucide-react";
import styles from "./MobileBar.module.scss";

export type MobileDrawer = "tools" | "panels" | null;

/**
 * The mobile bottom bar — the always-visible home for the two things that
 * became slide-in drawers on small screens: the Tool rail and the panels
 * dock, plus pan. Rendered only on mobile; desktop keeps the full StatusBar /
 * side rails.
 *
 * Three destinations, and nothing else. The centre used to carry a chip naming
 * the current tool, which measured **218px of a 390px bar** — more than the
 * three actual destinations put together — to say something the options row
 * above was better placed to say. Naming the tool moved there, onto the control
 * that opens that tool's settings, where the name doubles as a label instead of
 * being a read-out on its own.
 */
export default function MobileBar({
  drawer,
  onToggle,
  panMode,
  onTogglePan,
}: {
  drawer: MobileDrawer;
  onToggle: (d: "tools" | "panels") => void;
  /** One-finger drag pans instead of using the tool; the tool stays selected. */
  panMode: boolean;
  onTogglePan: () => void;
}) {
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

      {/* Pan/zoom without giving up the tool. Every drawing and selection tool
          takes the one-finger drag, so panning otherwise meant switching to the
          Hand tool and back for every adjustment. */}
      <button
        type="button"
        className={styles.btn}
        data-active={panMode}
        aria-pressed={panMode}
        title="Drag to pan without changing tool"
        onClick={onTogglePan}
      >
        <Move size={20} />
        <span>Pan</span>
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
