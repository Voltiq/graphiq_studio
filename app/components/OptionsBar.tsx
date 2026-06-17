"use client";

import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  Bold,
  Circle,
  Italic,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Square,
  Triangle,
  Underline,
} from "lucide-react";
import styles from "./OptionsBar.module.scss";
import {
  getTool,
  SAMPLE_SCOPE_OPTIONS,
  SAMPLE_SIZE_OPTIONS,
  type MoveMode,
  type SelectResizeMode,
  type ToolId,
} from "../lib/tools";
import type { BrushSettings } from "../lib/paint";
import {
  ColorChip,
  Divider,
  NumberField,
  Segmented,
  Select,
  Slider,
  Toggle,
} from "./Controls";

export default function OptionsBar({
  tool,
  foreground,
  onForeground,
  brush,
  onBrush,
  moveMode,
  onMoveMode,
  resizeMode,
  onResizeMode,
  resizeSmooth,
  onResizeSmooth,
  eyedropper,
  onEyedropper,
}: {
  tool: ToolId;
  foreground: string;
  onForeground: (c: string) => void;
  brush: BrushSettings;
  onBrush: (b: BrushSettings) => void;
  moveMode: MoveMode;
  onMoveMode: (m: MoveMode) => void;
  resizeMode: SelectResizeMode;
  onResizeMode: (m: SelectResizeMode) => void;
  resizeSmooth: boolean;
  onResizeSmooth: (v: boolean) => void;
  eyedropper: { size: string; scope: string };
  onEyedropper: (patch: { size?: string; scope?: string }) => void;
}) {
  const meta = getTool(tool);
  const Icon = meta.icon;

  return (
    <div className={styles.optionsbar}>
      <div className={styles.toolBadge}>
        <Icon size={16} strokeWidth={2} />
        <span>{meta.name}</span>
      </div>
      <Divider />
      <div className={styles.controls}>
        {renderOptions(
          tool,
          foreground,
          onForeground,
          brush,
          onBrush,
          moveMode,
          onMoveMode,
          resizeMode,
          onResizeMode,
          resizeSmooth,
          onResizeSmooth,
          eyedropper,
          onEyedropper,
        )}
      </div>
    </div>
  );
}

function renderOptions(
  tool: ToolId,
  foreground: string,
  onForeground: (c: string) => void,
  brush: BrushSettings,
  onBrush: (b: BrushSettings) => void,
  moveMode: MoveMode,
  onMoveMode: (m: MoveMode) => void,
  resizeMode: SelectResizeMode,
  onResizeMode: (m: SelectResizeMode) => void,
  resizeSmooth: boolean,
  onResizeSmooth: (v: boolean) => void,
  eyedropper: { size: string; scope: string },
  onEyedropper: (patch: { size?: string; scope?: string }) => void,
) {
  const set = (patch: Partial<BrushSettings>) => onBrush({ ...brush, ...patch });
  switch (tool) {
    case "brush":
    case "pencil":
    case "eraser":
      return (
        <>
          <Select label="Preset" options={["Soft Round", "Hard Round", "Chalk", "Spatter"]} width={130} />
          <Divider />
          <Slider label="Size" min={1} max={500} unit="px" value={brush.size} onChange={(n) => set({ size: n })} />
          <Slider label="Hardness" unit="%" value={brush.hardness} onChange={(n) => set({ hardness: n })} />
          <Slider label="Opacity" unit="%" value={brush.opacity} onChange={(n) => set({ opacity: n })} />
          <Slider label="Flow" unit="%" value={brush.flow} onChange={(n) => set({ flow: n })} />
          {tool !== "eraser" && (
            <>
              <Divider />
              <Select
                label="Blend"
                options={["Normal", "Multiply", "Screen", "Overlay", "Soft Light", "Color"]}
                width={120}
                value={brush.blend}
                onChange={(s) => set({ blend: s })}
              />
            </>
          )}
          <Divider />
          <Slider
            label="Smoothing"
            unit="%"
            compact
            value={brush.smoothing}
            onChange={(n) => set({ smoothing: n })}
          />
          {tool !== "eraser" && (
            <>
              <Divider />
              <ColorChip color={foreground} onChange={onForeground} label="Brush color" />
            </>
          )}
        </>
      );

    case "text":
      return (
        <>
          <Select
            label="Font"
            options={["Geist Sans", "Inter", "Playfair Display", "JetBrains Mono", "Georgia"]}
            width={150}
          />
          <NumberField label="Size" defaultValue={48} unit="px" width={62} />
          <Divider />
          <Segmented
            options={[
              { value: "b", icon: <Bold size={14} />, title: "Bold" },
              { value: "i", icon: <Italic size={14} />, title: "Italic" },
              { value: "u", icon: <Underline size={14} />, title: "Underline" },
            ]}
          />
          <Segmented
            defaultValue="left"
            options={[
              { value: "left", icon: <AlignLeft size={14} />, title: "Align left" },
              { value: "center", icon: <AlignCenter size={14} />, title: "Align center" },
              { value: "right", icon: <AlignRight size={14} />, title: "Align right" },
            ]}
          />
          <Divider />
          <NumberField label="Tracking" defaultValue={0} width={56} />
          <NumberField label="Leading" defaultValue={1.4} width={56} />
          <Divider />
          <ColorChip color={foreground} onChange={onForeground} label="Text color" />
        </>
      );

    case "shape":
      return (
        <>
          <Segmented
            options={[
              { value: "rect", icon: <Square size={14} />, title: "Rectangle" },
              { value: "ellipse", icon: <Circle size={14} />, title: "Ellipse" },
              { value: "tri", icon: <Triangle size={14} />, title: "Polygon" },
            ]}
          />
          <Divider />
          <ColorChip color={foreground} onChange={onForeground} label="Fill" />
          <ColorChip color="#1a1d29ff" label="Stroke" />
          <Slider label="Stroke W" min={0} max={60} defaultValue={2} unit="px" compact />
          <Divider />
          <NumberField label="Radius" defaultValue={12} unit="px" width={62} />
        </>
      );

    case "crop":
      return (
        <>
          <Select
            label="Ratio"
            options={["Free", "Original", "1:1", "4:3", "16:9", "3:2", "9:16"]}
            width={110}
          />
          <Divider />
          <NumberField label="W" defaultValue={1920} unit="px" width={72} />
          <NumberField label="H" defaultValue={1080} unit="px" width={72} />
          <Divider />
          <Slider label="Straighten" min={-45} max={45} defaultValue={0} unit="°" />
          <Toggle label="Delete cropped pixels" defaultChecked />
        </>
      );

    case "select":
    case "lasso":
    case "wand":
      return (
        <>
          <Segmented
            options={[
              { value: "new", text: "New" },
              { value: "add", icon: <Plus size={13} />, title: "Add to selection" },
              { value: "sub", icon: <Minus size={13} />, title: "Subtract" },
            ]}
          />
          {tool === "select" && (
            <>
              <Divider />
              <Segmented
                label="Resize"
                value={resizeMode}
                onChange={(v) => onResizeMode(v as SelectResizeMode)}
                options={[
                  {
                    value: "bounds",
                    icon: <Square size={14} />,
                    text: "Bounds",
                    title: "Resize the selection outline only",
                  },
                  {
                    value: "content",
                    icon: <ImageIcon size={14} />,
                    text: "Content",
                    title: "Scale the pixels inside the selection too",
                  },
                ]}
              />
              {resizeMode === "content" && (
                <Toggle
                  label="Smooth"
                  checked={resizeSmooth}
                  onChange={onResizeSmooth}
                />
              )}
            </>
          )}
          <Divider />
          <Slider label="Feather" min={0} max={250} defaultValue={0} unit="px" />
          {tool === "wand" && <Slider label="Tolerance" min={0} max={255} defaultValue={32} />}
          <Toggle label="Anti-alias" defaultChecked />
          {tool === "wand" && <Toggle label="Contiguous" defaultChecked />}
        </>
      );

    case "gradient":
      return (
        <>
          <Segmented
            defaultValue="linear"
            options={[
              { value: "linear", text: "Linear" },
              { value: "radial", text: "Radial" },
              { value: "angle", text: "Angle" },
              { value: "diamond", text: "Diamond" },
            ]}
          />
          <Divider />
          <Slider label="Opacity" defaultValue={100} unit="%" />
          <Toggle label="Reverse" />
          <Toggle label="Dither" defaultChecked />
        </>
      );

    case "bucket":
      return (
        <>
          <ColorChip color={foreground} onChange={onForeground} label="Fill color" />
          <Divider />
          <Slider label="Tolerance" min={0} max={255} defaultValue={32} />
          <Slider label="Opacity" defaultValue={100} unit="%" />
          <Toggle label="Contiguous" defaultChecked />
          <Toggle label="Anti-alias" defaultChecked />
        </>
      );

    case "clone":
    case "blur":
    case "dodge":
      return (
        <>
          <Slider label="Size" min={1} max={500} defaultValue={40} unit="px" />
          <Slider label="Strength" defaultValue={50} unit="%" />
          <Select
            label="Range"
            options={["Midtones", "Shadows", "Highlights"]}
            width={120}
          />
          <Toggle label="Sample all layers" />
        </>
      );

    case "zoom":
      return (
        <>
          <Segmented
            defaultValue="in"
            options={[
              { value: "in", icon: <Plus size={13} />, title: "Zoom in" },
              { value: "out", icon: <Minus size={13} />, title: "Zoom out" },
            ]}
          />
          <Divider />
          {["25%", "50%", "100%", "200%", "Fit"].map((z) => (
            <button key={z} type="button" className={styles.preset}>
              {z}
            </button>
          ))}
        </>
      );

    case "eyedropper":
      return (
        <>
          <Select
            label="Sample size"
            options={SAMPLE_SIZE_OPTIONS}
            width={150}
            value={eyedropper.size}
            onChange={(v) => onEyedropper({ size: v })}
          />
          <Divider />
          <Select
            label="Sample"
            options={SAMPLE_SCOPE_OPTIONS}
            width={130}
            value={eyedropper.scope}
            onChange={(v) => onEyedropper({ scope: v })}
          />
        </>
      );

    case "move":
      return (
        <>
          <Segmented
            label="Move"
            value={moveMode}
            onChange={(v) => onMoveMode(v as MoveMode)}
            options={[
              { value: "pixels", icon: <ImageIcon size={14} />, text: "Pixels", title: "Move pixels" },
              {
                value: "selection",
                icon: <MousePointer2 size={14} />,
                text: "Selection",
                title: "Move selection outline only",
              },
            ]}
          />
          <Divider />
          <Toggle label="Auto-select" defaultChecked />
          <Select label="Scope" options={["Layer", "Group"]} width={100} />
          <Toggle label="Show transform controls" defaultChecked />
          <Toggle label="Snap" defaultChecked />
          <Divider />
          <span className={styles.muted}>Align</span>
          <Segmented
            options={[
              { value: "l", icon: <AlignLeft size={14} />, title: "Align left edges" },
              {
                value: "hc",
                icon: <AlignHorizontalJustifyCenter size={14} />,
                title: "Align horizontal centers",
              },
              { value: "r", icon: <AlignRight size={14} />, title: "Align right edges" },
              { value: "t", icon: <AlignCenter size={14} />, title: "Align top edges" },
              {
                value: "vc",
                icon: <AlignVerticalJustifyCenter size={14} />,
                title: "Align vertical centers",
              },
            ]}
          />
        </>
      );

    default:
      return (
        <>
          <span className={styles.muted}>
            Select a tool to see its options here.
          </span>
          <button type="button" className={styles.preset}>
            <RotateCcw size={13} /> Reset
          </button>
        </>
      );
  }
}
