"use client";

import { Hand, createLucideIcon } from "lucide-react";
import styles from "./MobileBar.module.scss";
import { ALL_TOOLS, type ToolId } from "../lib/tools";

export type MobileDrawer = "tools" | "panels" | null;

/** The dock's own glyphs for its two destinations, as in the design. */
const AllToolsIcon = createLucideIcon("gq-all-tools", [
  ["rect", { x: "4", y: "4", width: "6", height: "6", rx: "1.5", key: "a" }],
  ["rect", { x: "14", y: "4", width: "6", height: "6", rx: "1.5", key: "b" }],
  ["rect", { x: "4", y: "14", width: "6", height: "6", rx: "1.5", key: "c" }],
  ["rect", { x: "14", y: "14", width: "6", height: "6", rx: "1.5", key: "d" }],
]);
const PanelsIcon = createLucideIcon("gq-panels", [
  ["path", { d: "m12 3 9 5-9 5-9-5z", key: "a" }],
  ["path", { d: "m3 16 9 5 9-5M3 12l9 5 9-5", key: "b" }],
]);

/** The tools a finger reaches for most, one tap away instead of two. The rest
 *  are in the tools sheet. */
const QUICK: ToolId[] = ["move", "select", "brush", "eraser"];

/**
 * The phone's tool dock — a glass bar floating over the foot of the screen:
 * four quick tools, the pan toggle, then the two sheets (all tools, panels).
 * Rendered only on the phone; desktop keeps its rail and docks.
 *
 * The nav element itself is the whole bottom band (its box IS --chrome-bottom,
 * which is what everything anchored to the foot reads); the dock is the pill
 * inside it. The words "Tools", "Pan" and "Panels" stay in the buttons for
 * assistive tech and for anything that finds them by name, while the eye gets
 * the design's icons alone.
 */
export default function MobileBar({
  drawer,
  onToggle,
  panMode,
  onTogglePan,
  tool,
  onToolChange,
}: {
  drawer: MobileDrawer;
  onToggle: (d: "tools" | "panels") => void;
  /** One-finger drag pans instead of using the tool; the tool stays selected. */
  panMode: boolean;
  onTogglePan: () => void;
  tool: ToolId;
  onToolChange: (id: ToolId) => void;
}) {
  return (
    <nav className={styles.bar} data-tour="mobilebar" aria-label="Mobile toolbar">
      <div className={styles.dock}>
        {QUICK.map((id) => {
          const t = ALL_TOOLS.find((x) => x.id === id)!;
          const Icon = t.icon;
          const on = tool === id;
          return (
            <button
              key={id}
              type="button"
              className={styles.tool}
              data-quick={id}
              data-active={on}
              aria-pressed={on}
              aria-label={t.name}
              title={t.name}
              onClick={() => onToolChange(id)}
            >
              <Icon size={20} />
            </button>
          );
        })}

        {/* Pan/zoom without giving up the tool. Every drawing and selection tool
            takes the one-finger drag, so panning otherwise meant switching to the
            Hand tool and back for every adjustment. */}
        <button
          type="button"
          className={styles.toggle}
          data-active={panMode}
          aria-pressed={panMode}
          title="Drag to pan without changing tool"
          onClick={onTogglePan}
        >
          <Hand size={20} />
          <span className={styles.label}>Pan</span>
        </button>

        <span className={styles.divider} aria-hidden />

        <button
          type="button"
          className={styles.toggle}
          data-active={drawer === "tools"}
          aria-pressed={drawer === "tools"}
          title="All tools"
          onClick={() => onToggle("tools")}
        >
          <AllToolsIcon size={20} />
          <span className={styles.label}>Tools</span>
        </button>

        <button
          type="button"
          className={styles.toggle}
          data-active={drawer === "panels"}
          aria-pressed={drawer === "panels"}
          title="Layers and panels"
          onClick={() => onToggle("panels")}
        >
          <PanelsIcon size={20} />
          <span className={styles.label}>Panels</span>
        </button>
      </div>
    </nav>
  );
}
