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
import type { Adjustments } from "../lib/adjust";

export type PanelVisibility = {
  color: boolean;
  adjustments: boolean;
  layers: boolean;
  history: boolean;
  navigator: boolean;
};

interface Props {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  activeSlot: "primary" | "secondary";
  onActiveSlot: (slot: "primary" | "secondary") => void;
  layers: LayersApi;
  history: HistorySummary;
  onHistoryJump: (index: number) => void;
  view: NavigatorView;
  panels: PanelVisibility;
  adjust: Adjustments;
  onAdjust: (patch: Partial<Adjustments>) => void;
  adjustFilter: string;
  onAdjustFilter: (name: string) => void;
  onAdjustApply: () => void;
  onAdjustReset: () => void;
  adjustActive: boolean;
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
  activeSlot,
  onActiveSlot,
  layers,
  history,
  onHistoryJump,
  view,
  adjust,
  onAdjust,
  adjustFilter,
  onAdjustFilter,
  onAdjustApply,
  onAdjustReset,
  adjustActive,
  panels,
}: Props) {
  return (
    <aside className={styles.dock} aria-label="Panels">
      {panels.navigator && (
        <Panel title="Navigator" icon={Compass} defaultOpen>
          <NavigatorPanel view={view} />
        </Panel>
      )}

      {panels.color && (
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
            active={activeSlot}
            onActive={onActiveSlot}
          />
        </Panel>
      )}

      {panels.adjustments && (
        <Panel title="Adjustments" icon={SlidersHorizontal}>
          <AdjustmentsPanel
            adjust={adjust}
            onChange={onAdjust}
            filter={adjustFilter}
            onFilter={onAdjustFilter}
            onApply={onAdjustApply}
            onReset={onAdjustReset}
            active={adjustActive}
          />
        </Panel>
      )}

      {panels.layers && (
        <Panel
          title="Layers"
          icon={Layers}
          actions={
            <>
              <IconBtn title="New layer" onClick={layers.add}>
                <Plus size={14} />
              </IconBtn>
              <IconBtn title="Delete layer" onClick={() => layers.remove()}>
                <Trash2 size={14} />
              </IconBtn>
            </>
          }
        >
          <LayersPanel api={layers} />
        </Panel>
      )}

      {panels.history && (
        <Panel title="History" icon={History} defaultOpen={false}>
          <HistoryPanel items={history.items} index={history.index} onJump={onHistoryJump} />
        </Panel>
      )}
    </aside>
  );
}
