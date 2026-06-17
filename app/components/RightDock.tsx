"use client";

import {
  Compass,
  History,
  Layers,
  MoreHorizontal,
  Palette,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import styles from "./RightDock.module.scss";
import Panel from "./Panel";
import ColorPanel from "./panels/ColorPanel";
import AdjustmentsPanel from "./panels/AdjustmentsPanel";
import LayersPanel from "./panels/LayersPanel";
import HistoryPanel from "./panels/HistoryPanel";
import NavigatorPanel from "./panels/NavigatorPanel";
import type { NavigatorView } from "../lib/view";
import type { LayersApi } from "../lib/layers";
import type { HistorySummary } from "../lib/paint";

interface Props {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  layers: LayersApi;
  history: HistorySummary;
  onHistoryJump: (index: number) => void;
  view: NavigatorView;
}

const IconBtn = ({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}) => (
  <button type="button" className={styles.headBtn} title={title} onClick={onClick}>
    {children}
  </button>
);

export default function RightDock({
  foreground,
  background,
  onForeground,
  onBackground,
  layers,
  history,
  onHistoryJump,
  view,
}: Props) {
  return (
    <aside className={styles.dock} aria-label="Panels">
      <Panel title="Navigator" icon={Compass} defaultOpen>
        <NavigatorPanel view={view} />
      </Panel>

      <Panel
        title="Color"
        icon={Palette}
        actions={<IconBtn title="More"><MoreHorizontal size={14} /></IconBtn>}
      >
        <ColorPanel
          foreground={foreground}
          background={background}
          onForeground={onForeground}
          onBackground={onBackground}
        />
      </Panel>

      <Panel title="Adjustments" icon={SlidersHorizontal}>
        <AdjustmentsPanel />
      </Panel>

      <Panel
        title="Layers"
        icon={Layers}
        actions={
          <>
            <IconBtn title="New layer" onClick={layers.add}>
              <Plus size={14} />
            </IconBtn>
            <IconBtn
              title="Delete layer"
              onClick={() => layers.activeLayerId && layers.remove(layers.activeLayerId)}
            >
              <Trash2 size={14} />
            </IconBtn>
          </>
        }
      >
        <LayersPanel api={layers} />
      </Panel>

      <Panel title="History" icon={History} defaultOpen={false}>
        <HistoryPanel items={history.items} index={history.index} onJump={onHistoryJump} />
      </Panel>
    </aside>
  );
}
