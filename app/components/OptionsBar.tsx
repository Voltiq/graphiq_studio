"use client";

import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  ArrowLeftRight,
  Bold,
  Check,
  Circle,
  Italic,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Square,
  Strikethrough,
  Triangle,
  Underline,
} from "lucide-react";
import styles from "./OptionsBar.module.scss";
import {
  CROP_RATIOS,
  FONT_FAMILIES,
  getTool,
  SAMPLE_SCOPE_OPTIONS,
  SAMPLE_SIZE_OPTIONS,
  type BlurSettings,
  type HealSettings,
  type CloneSettings,
  type CropSettings,
  type DodgeMode,
  type DodgeRange,
  type DodgeSettings,
  type TextAlign,
  type TextSettings,
  type GradientSettings,
  type GradientType,
  type MarqueeShape,
  type MoveMode,
  type PenSettings,
  type SelectResizeMode,
  type ShapeKind,
  type ShapeSettings,
  type ToolId,
} from "../lib/tools";
import type { Rect } from "../lib/view";
import GradientControl from "./GradientControl";
import type { BrushSettings } from "../lib/paint";
import {
  ColorChip,
  Divider,
  NumberField,
  Segmented,
  Select,
  Slider as BaseSlider,
  Toggle,
} from "./Controls";

/** In the options bar every slider is the compact inline (label-beside) variant. */
function Slider(props: React.ComponentProps<typeof BaseSlider>) {
  return <BaseSlider inline {...props} />;
}

interface ShapeProps {
  shape: ShapeSettings;
  onShape: (patch: Partial<ShapeSettings>) => void;
  fill: string;
  onFill: (c: string) => void;
  stroke: string;
  onStroke: (c: string) => void;
}

interface BlurProps {
  blur: BlurSettings;
  onBlur: (patch: Partial<BlurSettings>) => void;
}

interface HealProps {
  heal: HealSettings;
  onHeal: (patch: Partial<HealSettings>) => void;
}

interface CloneProps {
  clone: CloneSettings;
  onClone: (patch: Partial<CloneSettings>) => void;
}

interface TextProps {
  text: TextSettings;
  onText: (patch: Partial<TextSettings>) => void;
}

interface DodgeProps {
  dodge: DodgeSettings;
  onDodge: (patch: Partial<DodgeSettings>) => void;
}

interface CropProps {
  crop: CropSettings;
  onCrop: (patch: Partial<CropSettings>) => void;
  cropBox: Rect | null;
  onCropBox: (b: Rect | null) => void;
  onCropApply: () => void;
  onCropReset: () => void;
  docWidth: number;
  docHeight: number;
}

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
  marqueeShape,
  onMarqueeShape,
  triangleApex,
  onTriangleApex,
  wand,
  onWand,
  bucket,
  onBucket,
  gradient,
  onGradient,
  pen,
  onPen,
  eyedropper,
  onEyedropper,
  shape,
  onShape,
  blur,
  onBlur,
  heal,
  onHeal,
  clone,
  onClone,
  text,
  onText,
  dodge,
  onDodge,
  crop,
  onCrop,
  cropBox,
  onCropBox,
  onCropApply,
  onCropReset,
  docWidth,
  docHeight,
  fill,
  onFill,
  stroke,
  onStroke,
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
  marqueeShape: MarqueeShape;
  onMarqueeShape: (s: MarqueeShape) => void;
  triangleApex: number;
  onTriangleApex: (v: number) => void;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  onWand: (patch: Partial<{ tolerance: number; contiguous: boolean; sampleAll: boolean }>) => void;
  bucket: { tolerance: number; opacity: number; contiguous: boolean; antialias: boolean };
  onBucket: (patch: Partial<{ tolerance: number; opacity: number; contiguous: boolean; antialias: boolean }>) => void;
  gradient: GradientSettings;
  onGradient: (patch: Partial<GradientSettings>) => void;
  pen: PenSettings;
  onPen: (patch: Partial<PenSettings>) => void;
  eyedropper: { size: string; scope: string };
  onEyedropper: (patch: { size?: string; scope?: string }) => void;
} & ShapeProps &
  BlurProps &
  HealProps &
  CloneProps &
  TextProps &
  DodgeProps &
  CropProps) {
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
          marqueeShape,
          onMarqueeShape,
          triangleApex,
          onTriangleApex,
          wand,
          onWand,
          bucket,
          onBucket,
          gradient,
          onGradient,
          pen,
          onPen,
          eyedropper,
          onEyedropper,
          { shape, onShape, fill, onFill, stroke, onStroke },
          { crop, onCrop, cropBox, onCropBox, onCropApply, onCropReset, docWidth, docHeight },
          { blur, onBlur },
          { heal, onHeal },
          { clone, onClone },
          { text, onText },
          { dodge, onDodge },
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
  marqueeShape: MarqueeShape,
  onMarqueeShape: (s: MarqueeShape) => void,
  triangleApex: number,
  onTriangleApex: (v: number) => void,
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean },
  onWand: (patch: Partial<{ tolerance: number; contiguous: boolean; sampleAll: boolean }>) => void,
  bucket: { tolerance: number; opacity: number; contiguous: boolean; antialias: boolean },
  onBucket: (patch: Partial<{ tolerance: number; opacity: number; contiguous: boolean; antialias: boolean }>) => void,
  gradient: GradientSettings,
  onGradient: (patch: Partial<GradientSettings>) => void,
  pen: PenSettings,
  onPen: (patch: Partial<PenSettings>) => void,
  eyedropper: { size: string; scope: string },
  onEyedropper: (patch: { size?: string; scope?: string }) => void,
  shapeProps: ShapeProps,
  cropProps: CropProps,
  blurProps: BlurProps,
  healProps: HealProps,
  cloneProps: CloneProps,
  textProps: TextProps,
  dodgeProps: DodgeProps,
) {
  const set = (patch: Partial<BrushSettings>) => onBrush({ ...brush, ...patch });
  switch (tool) {
    case "pencil":
      // Pencil: hard-edged & pixel-perfect, so no hardness / flow / smoothing.
      return (
        <>
          <Slider label="Size" min={1} max={500} unit="px" value={brush.size} onChange={(n) => set({ size: n })} />
          <Slider label="Opacity" unit="%" value={brush.opacity} onChange={(n) => set({ opacity: n })} />
          <Divider />
          <Select
            label="Blend"
            options={["Normal", "Multiply", "Screen", "Overlay", "Soft Light", "Color"]}
            width={120}
            value={brush.blend}
            onChange={(s) => set({ blend: s })}
          />
          <Divider />
          <ColorChip color={foreground} onChange={onForeground} label="Pencil color" />
        </>
      );

    case "brush":
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

    case "text": {
      const { text, onText } = textProps;
      return (
        <>
          <Select
            label="Font"
            options={FONT_FAMILIES}
            value={text.fontFamily}
            onChange={(f) => onText({ fontFamily: f })}
            width={150}
          />
          <NumberField
            label="Size"
            value={text.fontSize}
            min={1}
            max={2000}
            onChange={(n) => onText({ fontSize: n })}
            unit="px"
            width={64}
          />
          <Divider />
          <div className={styles.fmtGroup}>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.bold}
              title="Bold (Ctrl+B)"
              onClick={() => onText({ bold: !text.bold })}
            >
              <Bold size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.italic}
              title="Italic (Ctrl+I)"
              onClick={() => onText({ italic: !text.italic })}
            >
              <Italic size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.underline}
              title="Underline (Ctrl+U)"
              onClick={() => onText({ underline: !text.underline })}
            >
              <Underline size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-active={text.strike}
              title="Strikethrough"
              onClick={() => onText({ strike: !text.strike })}
            >
              <Strikethrough size={14} />
            </button>
          </div>
          <Segmented
            value={text.align}
            onChange={(v) => onText({ align: v as TextAlign })}
            options={[
              { value: "left", icon: <AlignLeft size={14} />, title: "Align left" },
              { value: "center", icon: <AlignCenter size={14} />, title: "Align center" },
              { value: "right", icon: <AlignRight size={14} />, title: "Align right" },
            ]}
          />
          <Divider />
          <NumberField
            label="Tracking"
            value={text.tracking}
            min={-200}
            max={800}
            onChange={(n) => onText({ tracking: n })}
            width={58}
          />
          <Slider
            label="Leading"
            min={50}
            max={300}
            unit="%"
            value={Math.round(text.lineHeight * 100)}
            onChange={(n) => onText({ lineHeight: n / 100 })}
          />
          <Divider />
          <ColorChip color={text.color} onChange={(c) => onText({ color: c })} label="Text color" />
          <Toggle
            label="Anti-alias"
            checked={text.antialias}
            onChange={(v) => onText({ antialias: v })}
          />
        </>
      );
    }

    case "shape": {
      const { shape, onShape, fill, onFill, stroke, onStroke } = shapeProps;
      return (
        <>
          <Segmented
            value={shape.kind}
            onChange={(v) => onShape({ kind: v as ShapeKind })}
            options={[
              { value: "rect", icon: <Square size={14} />, title: "Rectangle" },
              { value: "ellipse", icon: <Circle size={14} />, title: "Ellipse" },
              { value: "tri", icon: <Triangle size={14} />, title: "Triangle" },
              {
                value: "trapezoid",
                icon: (
                  <svg
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                  >
                    <path d="M7 6h10l4 12H3z" />
                  </svg>
                ),
                title: "Trapezoid",
              },
            ]}
          />
          <Divider />
          <ColorChip color={fill} onChange={onFill} label="Fill" />
          <ColorChip color={stroke} onChange={onStroke} label="Stroke" />
          <Slider
            label="Stroke W"
            min={0}
            max={60}
            unit="px"
            compact
            value={shape.strokeWidth}
            onChange={(n) => onShape({ strokeWidth: n })}
          />
          {shape.kind !== "ellipse" && (
            <>
              <Divider />
              <Slider
                label="Radius"
                min={0}
                max={200}
                unit="px"
                compact
                value={shape.radius}
                onChange={(n) => onShape({ radius: n })}
              />
            </>
          )}
        </>
      );
    }

    case "crop": {
      const { crop, onCrop, cropBox, onCropBox, onCropApply, onCropReset, docWidth, docHeight } =
        cropProps;
      const box = cropBox ?? { x: 0, y: 0, w: docWidth, h: docHeight };

      const RATIO_OPTS = [
        { id: "free", label: "Free" },
        { id: "original", label: "Original" },
        ...CROP_RATIOS.map((r) => ({ id: r.id, label: r.label })),
        { id: "custom", label: "Custom" },
      ];
      const curRatioLabel = RATIO_OPTS.find((r) => r.id === crop.ratio)?.label ?? "Free";

      const aspectOf = (id: string): number | null => {
        if (id === "free") return null;
        if (id === "original") return docHeight ? docWidth / docHeight : null;
        if (id === "custom")
          return crop.customW > 0 && crop.customH > 0 ? crop.customW / crop.customH : null;
        const p = CROP_RATIOS.find((r) => r.id === id);
        return p ? p.w / p.h : null;
      };
      const aspect = aspectOf(crop.ratio);

      // Reshape a box to a given aspect ratio, keeping its centre and fitting the
      // canvas; used when a ratio is picked or the orientation is swapped.
      const reshape = (b: Rect, a: number): Rect => {
        let w = b.w;
        let h = b.h;
        if (w / h > a) w = h * a;
        else h = w / a;
        if (w > docWidth) {
          w = docWidth;
          h = w / a;
        }
        if (h > docHeight) {
          h = docHeight;
          w = h * a;
        }
        w = Math.round(w);
        h = Math.round(h);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const x = Math.max(0, Math.min(docWidth - w, Math.round(cx - w / 2)));
        const y = Math.max(0, Math.min(docHeight - h, Math.round(cy - h / 2)));
        return { x, y, w, h };
      };

      const pickRatio = (label: string) => {
        const id = RATIO_OPTS.find((r) => r.label === label)?.id ?? "free";
        onCrop({ ratio: id });
        const a = aspectOf(id);
        if (cropBox && a) onCropBox(reshape(cropBox, a));
      };

      // Resize the box from a W/H field, holding the locked ratio (if any) and the
      // box's top-left corner, clamped to the canvas.
      const setW = (w: number) => {
        if (!cropBox) return;
        let nw = Math.max(1, Math.min(docWidth - cropBox.x, w));
        let nh = aspect ? Math.round(nw / aspect) : cropBox.h;
        if (cropBox.y + nh > docHeight) {
          nh = docHeight - cropBox.y;
          if (aspect) nw = Math.round(nh * aspect);
        }
        onCropBox({ ...cropBox, w: nw, h: nh });
      };
      const setH = (h: number) => {
        if (!cropBox) return;
        let nh = Math.max(1, Math.min(docHeight - cropBox.y, h));
        let nw = aspect ? Math.round(nh * aspect) : cropBox.w;
        if (cropBox.x + nw > docWidth) {
          nw = docWidth - cropBox.x;
          if (aspect) nh = Math.round(nw / aspect);
        }
        onCropBox({ ...cropBox, w: nw, h: nh });
      };
      const setX = (x: number) => {
        if (!cropBox) return;
        onCropBox({ ...cropBox, x: Math.max(0, Math.min(docWidth - cropBox.w, x)) });
      };
      const setY = (y: number) => {
        if (!cropBox) return;
        onCropBox({ ...cropBox, y: Math.max(0, Math.min(docHeight - cropBox.h, y)) });
      };

      const swapOrientation = () => {
        if (crop.ratio === "custom") {
          onCrop({ customW: crop.customH, customH: crop.customW });
        } else if (crop.ratio !== "free" && crop.ratio !== "original") {
          const p = CROP_RATIOS.find((r) => r.id === crop.ratio);
          if (p) {
            const inv = CROP_RATIOS.find((r) => r.w === p.h && r.h === p.w);
            if (inv) onCrop({ ratio: inv.id });
            else onCrop({ ratio: "custom", customW: p.h, customH: p.w });
          }
        }
        if (cropBox) {
          const cx = cropBox.x + cropBox.w / 2;
          const cy = cropBox.y + cropBox.h / 2;
          const w = Math.min(cropBox.h, docWidth);
          const h = Math.min(cropBox.w, docHeight);
          const x = Math.max(0, Math.min(docWidth - w, Math.round(cx - w / 2)));
          const y = Math.max(0, Math.min(docHeight - h, Math.round(cy - h / 2)));
          onCropBox({ x, y, w, h });
        }
      };

      const GRID_OPTS = [
        { id: "thirds", label: "Rule of Thirds" },
        { id: "grid", label: "Grid" },
        { id: "diagonal", label: "Diagonal" },
        { id: "golden", label: "Golden ratio" },
        { id: "none", label: "None" },
      ];
      const curGridLabel = GRID_OPTS.find((g) => g.id === crop.grid)?.label ?? "Rule of Thirds";

      return (
        <>
          <Select
            label="Ratio"
            options={RATIO_OPTS.map((r) => r.label)}
            value={curRatioLabel}
            onChange={pickRatio}
            width={140}
          />
          {crop.ratio === "custom" && (
            <>
              <NumberField
                value={crop.customW}
                min={1}
                max={9999}
                onChange={(n) => {
                  onCrop({ customW: n });
                  if (cropBox) onCropBox(reshape(cropBox, n / Math.max(1, crop.customH)));
                }}
                width={52}
              />
              <span className={styles.muted}>:</span>
              <NumberField
                value={crop.customH}
                min={1}
                max={9999}
                onChange={(n) => {
                  onCrop({ customH: n });
                  if (cropBox) onCropBox(reshape(cropBox, Math.max(1, crop.customW) / n));
                }}
                width={52}
              />
            </>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            title="Swap orientation"
            onClick={swapOrientation}
          >
            <ArrowLeftRight size={15} />
          </button>
          <Divider />
          <NumberField label="W" value={Math.round(box.w)} min={1} onChange={setW} unit="px" width={74} />
          <NumberField label="H" value={Math.round(box.h)} min={1} onChange={setH} unit="px" width={74} />
          <NumberField label="X" value={Math.round(box.x)} min={0} onChange={setX} unit="px" width={70} />
          <NumberField label="Y" value={Math.round(box.y)} min={0} onChange={setY} unit="px" width={70} />
          <Divider />
          <Slider
            label="Straighten"
            min={-45}
            max={45}
            value={crop.straighten}
            onChange={(n) => onCrop({ straighten: n })}
            unit="°"
          />
          <Select
            label="Overlay"
            options={GRID_OPTS.map((g) => g.label)}
            value={curGridLabel}
            onChange={(l) => onCrop({ grid: (GRID_OPTS.find((g) => g.label === l)?.id ?? "thirds") as CropSettings["grid"] })}
            width={150}
          />
          <Slider
            label="Shield"
            min={0}
            max={90}
            value={crop.shield}
            onChange={(n) => onCrop({ shield: n })}
            unit="%"
          />
          <Divider />
          <button type="button" className={styles.preset} onClick={onCropReset}>
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            type="button"
            className={`${styles.preset} ${styles.apply}`}
            onClick={onCropApply}
            title="Apply crop (Enter)"
          >
            <Check size={14} />
            Apply
          </button>
        </>
      );
    }

    case "select":
    case "lasso":
    case "wand":
      return (
        <>
          {tool === "select" && (
            <>
              <Segmented
                label="Shape"
                value={marqueeShape}
                onChange={(v) => onMarqueeShape(v as MarqueeShape)}
                options={[
                  { value: "rect", icon: <Square size={14} />, title: "Rectangular marquee" },
                  { value: "ellipse", icon: <Circle size={14} />, title: "Elliptical marquee" },
                  { value: "triangle", icon: <Triangle size={14} />, title: "Triangular marquee" },
                ]}
              />
              {marqueeShape === "triangle" && (
                <Slider
                  label="Apex"
                  min={0}
                  max={100}
                  unit="%"
                  value={Math.round(triangleApex * 100)}
                  onChange={(v) => onTriangleApex(v / 100)}
                />
              )}
              <Divider />
            </>
          )}
          <Segmented
            options={[
              { value: "new", text: "New" },
              { value: "add", icon: <Plus size={13} />, title: "Add to selection" },
              { value: "sub", icon: <Minus size={13} />, title: "Subtract" },
            ]}
          />
          {(tool === "select" || tool === "wand") && (
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
          {tool === "wand" ? (
            <>
              <Divider />
              <Slider
                label="Tolerance"
                min={0}
                max={255}
                value={wand.tolerance}
                onChange={(n) => onWand({ tolerance: n })}
              />
              <Toggle
                label="Contiguous"
                checked={wand.contiguous}
                onChange={(v) => onWand({ contiguous: v })}
              />
              <Toggle
                label="Sample all layers"
                checked={wand.sampleAll}
                onChange={(v) => onWand({ sampleAll: v })}
              />
            </>
          ) : (
            <>
              <Divider />
              <Slider label="Feather" min={0} max={250} defaultValue={0} unit="px" />
              <Toggle label="Anti-alias" defaultChecked />
            </>
          )}
        </>
      );

    case "gradient":
      return (
        <>
          <Segmented
            value={gradient.type}
            onChange={(v) => onGradient({ type: v as GradientType })}
            options={[
              { value: "linear", text: "Linear" },
              { value: "radial", text: "Radial" },
              { value: "angle", text: "Angle" },
              { value: "reflected", text: "Reflected" },
            ]}
          />
          <Divider />
          <GradientControl
            gradient={gradient}
            onGradient={onGradient}
            fg={shapeProps.fill}
            bg={shapeProps.stroke}
          />
          <Divider />
          <Toggle
            label="Reverse"
            checked={gradient.reverse}
            onChange={(v) => onGradient({ reverse: v })}
          />
          {gradient.type === "angle" && (
            <Toggle
              label="Smooth"
              checked={gradient.smooth}
              onChange={(v) => onGradient({ smooth: v })}
            />
          )}
        </>
      );

    case "pen":
      return (
        <>
          <ColorChip color={foreground} onChange={onForeground} label="Stroke" />
          <Divider />
          <Slider
            label="Width"
            min={1}
            max={200}
            unit="px"
            compact
            value={pen.width}
            onChange={(n) => onPen({ width: n })}
          />
          <Slider
            label="Taper"
            min={0}
            max={100}
            unit="%"
            compact
            value={Math.round(pen.taper * 100)}
            onChange={(n) => onPen({ taper: n / 100 })}
          />
          <Slider
            label="Bend"
            min={-100}
            max={100}
            unit="%"
            compact
            value={Math.round(pen.bend * 100)}
            onChange={(n) => onPen({ bend: n / 100 })}
          />
          <Divider />
          <span className={styles.penHint}>
            Click to add points, drag to curve. Click the first point or press Enter to finish.
          </span>
        </>
      );

    case "bucket":
      return (
        <>
          <ColorChip color={foreground} onChange={onForeground} label="Fill color" />
          <Divider />
          <Slider
            label="Tolerance"
            min={0}
            max={255}
            value={bucket.tolerance}
            onChange={(n) => onBucket({ tolerance: n })}
          />
          <Slider
            label="Opacity"
            unit="%"
            value={bucket.opacity}
            onChange={(n) => onBucket({ opacity: n })}
          />
          <Toggle
            label="Contiguous"
            checked={bucket.contiguous}
            onChange={(v) => onBucket({ contiguous: v })}
          />
          <Toggle
            label="Anti-alias"
            checked={bucket.antialias}
            onChange={(v) => onBucket({ antialias: v })}
          />
        </>
      );

    case "clone":
    case "clone": {
      const { clone, onClone } = cloneProps;
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={clone.size}
            onChange={(n) => onClone({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={clone.hardness}
            onChange={(n) => onClone({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Opacity"
            unit="%"
            value={clone.opacity}
            onChange={(n) => onClone({ opacity: n })}
          />
          <Slider
            label="Flow"
            unit="%"
            value={clone.flow}
            onChange={(n) => onClone({ flow: n })}
          />
          <Divider />
          <Select
            label="Sample"
            options={["Current layer", "All layers"]}
            value={clone.sampleAll ? "All layers" : "Current layer"}
            onChange={(l) => onClone({ sampleAll: l === "All layers" })}
            width={140}
          />
          <Toggle
            label="Aligned"
            checked={clone.aligned}
            onChange={(v) => onClone({ aligned: v })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={clone.spacing}
            onChange={(n) => onClone({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={clone.smoothing}
            onChange={(n) => onClone({ smoothing: n })}
          />
        </>
      );
    }

    case "heal": {
      const { heal, onHeal } = healProps;
      return (
        <>
          <Slider
            label="Size"
            min={4}
            max={300}
            unit="px"
            value={heal.size}
            onChange={(n) => onHeal({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={heal.hardness}
            onChange={(n) => onHeal({ hardness: n })}
          />
          <Divider />
          <span className={styles.muted}>Paint over a blemish — it heals when you release.</span>
        </>
      );
    }

    case "blur": {
      const { blur, onBlur } = blurProps;
      return (
        <>
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={blur.size}
            onChange={(n) => onBlur({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={blur.hardness}
            onChange={(n) => onBlur({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Strength"
            unit="%"
            value={blur.strength}
            onChange={(n) => onBlur({ strength: n })}
          />
          <Slider
            label="Radius"
            min={1}
            max={100}
            unit="px"
            value={blur.radius}
            onChange={(n) => onBlur({ radius: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={blur.spacing}
            onChange={(n) => onBlur({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={blur.smoothing}
            onChange={(n) => onBlur({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Sample all layers"
            checked={blur.sampleAll}
            onChange={(v) => onBlur({ sampleAll: v })}
          />
        </>
      );
    }

    case "dodge": {
      const { dodge, onDodge } = dodgeProps;
      const RANGE_OPTS = [
        { id: "shadows", label: "Shadows" },
        { id: "midtones", label: "Midtones" },
        { id: "highlights", label: "Highlights" },
      ];
      const rangeLabel = RANGE_OPTS.find((r) => r.id === dodge.range)?.label ?? "Midtones";
      return (
        <>
          <Segmented
            label="Mode"
            value={dodge.mode}
            onChange={(v) => onDodge({ mode: v as DodgeMode })}
            options={[
              { value: "dodge", text: "Dodge" },
              { value: "burn", text: "Burn" },
            ]}
          />
          <Select
            label="Range"
            options={RANGE_OPTS.map((r) => r.label)}
            value={rangeLabel}
            onChange={(l) =>
              onDodge({ range: (RANGE_OPTS.find((r) => r.label === l)?.id ?? "midtones") as DodgeRange })
            }
            width={120}
          />
          <Slider
            label="Exposure"
            unit="%"
            value={dodge.exposure}
            onChange={(n) => onDodge({ exposure: n })}
          />
          <Divider />
          <Slider
            label="Size"
            min={1}
            max={500}
            unit="px"
            value={dodge.size}
            onChange={(n) => onDodge({ size: n })}
          />
          <Slider
            label="Hardness"
            unit="%"
            value={dodge.hardness}
            onChange={(n) => onDodge({ hardness: n })}
          />
          <Divider />
          <Slider
            label="Spacing"
            min={1}
            max={100}
            unit="%"
            value={dodge.spacing}
            onChange={(n) => onDodge({ spacing: n })}
          />
          <Slider
            label="Smoothing"
            unit="%"
            value={dodge.smoothing}
            onChange={(n) => onDodge({ smoothing: n })}
          />
          <Divider />
          <Toggle
            label="Protect tones"
            checked={dodge.protect}
            onChange={(v) => onDodge({ protect: v })}
          />
        </>
      );
    }

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
