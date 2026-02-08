"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { useEditor } from "../state";
import styles from "./editor.module.scss";

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

const CanvasStage = () => {
  const { state, dispatch } = useEditor();
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const { adjustments } = state;

  const filterString = useMemo(() => {
    const brightnessValue = Math.max(0.1, 1 + adjustments.brightness + adjustments.exposure);
    const contrastValue = Math.max(0.1, 1 + adjustments.contrast);
    const saturationValue = Math.max(0, 1 + adjustments.saturation);
    const tintValue = adjustments.tint * 180;
    const warmth = adjustments.temperature;
    return [
      `brightness(${brightnessValue})`,
      `contrast(${contrastValue})`,
      `saturate(${saturationValue})`,
      `hue-rotate(${tintValue}deg)`,
      `sepia(${Math.max(0, warmth)})`,
      `drop-shadow(0 0 ${Math.max(5, 30 + warmth * 10)}px rgba(0,0,0,0.35))`,
    ].join(" ");
  }, [adjustments]);

  const drawComposite = useCallback(async () => {
    const canvasEl = baseCanvasRef.current;
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    ctx.fillStyle = state.canvas.background;
    ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);

    for (const layer of [...state.layers].reverse()) {
      if (!layer.visible || layer.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      if (layer.blendMode === "multiply") {
        ctx.globalCompositeOperation = "multiply";
      } else if (layer.blendMode === "screen") {
        ctx.globalCompositeOperation = "screen";
      } else {
        ctx.globalCompositeOperation = "source-over";
      }
      if (layer.data) {
        try {
          const image = await loadImage(layer.data);
          ctx.drawImage(image, 0, 0, state.canvas.width, state.canvas.height);
        } catch (error) {
          console.error("Layer render failed", error);
        }
      } else {
        const gradient = ctx.createLinearGradient(0, 0, state.canvas.width, state.canvas.height);
        gradient.addColorStop(0, "rgba(255,255,255,0.05)");
        gradient.addColorStop(1, "rgba(255,255,255,0.0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);
      }
      ctx.restore();
    }
  }, [state.canvas.background, state.canvas.height, state.canvas.width, state.layers]);

  useEffect(() => {
    drawComposite();
  }, [drawComposite, state.canvas.width, state.canvas.height]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }, [state.canvas.width, state.canvas.height, state.activeLayerId]);

  const getPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvasEl = overlayRef.current;
    if (!canvasEl) return { x: 0, y: 0 };
    const rect = canvasEl.getBoundingClientRect();
    const scaleX = state.canvas.width / rect.width;
    const scaleY = state.canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const drawStroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = overlayRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = state.status.tool === "brush" ? 6 : 14;
    ctx.strokeStyle =
      state.status.tool === "eraser" ? state.canvas.background : state.color.primary;
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const commitStroke = useCallback(async () => {
    const overlayCanvas = overlayRef.current;
    if (!overlayCanvas) return;
    const activeLayer = state.layers.find((layer) => layer.id === state.activeLayerId);
    if (!activeLayer) return;
    const buffer = document.createElement("canvas");
    buffer.width = state.canvas.width;
    buffer.height = state.canvas.height;
    const ctx = buffer.getContext("2d");
    if (!ctx) return;
    if (activeLayer.data) {
      try {
        const baseImage = await loadImage(activeLayer.data);
        ctx.drawImage(baseImage, 0, 0, buffer.width, buffer.height);
      } catch (error) {
        console.error("Layer hydration failed", error);
      }
    }
    ctx.drawImage(overlayCanvas, 0, 0, buffer.width, buffer.height);
    dispatch({
      type: "UPDATE_LAYER_DATA",
      id: activeLayer.id,
      data: buffer.toDataURL("image/png"),
    });
    overlayCanvas.getContext("2d")?.clearRect(0, 0, buffer.width, buffer.height);
  }, [dispatch, state.activeLayerId, state.canvas.height, state.canvas.width, state.layers]);

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!["brush", "eraser"].includes(state.status.tool)) return;
    event.preventDefault();
    const point = getPoint(event);
    lastPointRef.current = point;
    setIsDrawing(true);
    drawStroke(point, point);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !lastPointRef.current) return;
    const point = getPoint(event);
    drawStroke(lastPointRef.current, point);
    lastPointRef.current = point;
  };

  const finishStroke = async () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPointRef.current = null;
    await commitStroke();
  };

  const canvasStyle: CSSProperties = {
    width: `${state.canvas.width}px`,
    height: `${state.canvas.height}px`,
  };

  return (
    <section className={`${styles.panel} ${styles.canvasPanel}`}>
      <div className={styles.canvasViewport}>
        <div
          className={styles.canvasInner}
          style={{
            ...canvasStyle,
            transform: `scale(${state.status.zoom})`,
          }}
        >
          <canvas
            ref={baseCanvasRef}
            width={state.canvas.width}
            height={state.canvas.height}
            className={styles.canvasBase}
            style={{ filter: filterString }}
          />
          <canvas
            ref={overlayRef}
            width={state.canvas.width}
            height={state.canvas.height}
            className={styles.canvasOverlay}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerLeave={finishStroke}
          />
        </div>
      </div>
    </section>
  );
};

export default CanvasStage;
