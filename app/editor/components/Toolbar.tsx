"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useEditor } from "../state";
import type { ToolId } from "../types";
import styles from "./editor.module.scss";

const tools: Array<{ id: ToolId; label: string; hint: string }> = [
  { id: "brush", label: "Brush", hint: "Paint with primary color" },
  { id: "eraser", label: "Eraser", hint: "Remove strokes" },
  { id: "fill", label: "Fill", hint: "Flood background" },
  { id: "text", label: "Text", hint: "Add text layer" },
  { id: "select", label: "Select", hint: "Select area" },
  { id: "move", label: "Move", hint: "Pan canvas" },
  { id: "crop", label: "Crop", hint: "Adjust bounds" },
  { id: "color-picker", label: "Picker", hint: "Sample colors" },
];

const Toolbar = () => {
  const { state, dispatch } = useEditor();
  const [dimensions, setDimensions] = useState({
    width: state.canvas.width,
    height: state.canvas.height,
  });
  const [isDirty, setIsDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result?.toString();
      if (!dataUrl) return;
      dispatch({
        type: "ADD_LAYER",
        layer: {
          name: file.name.replace(/\.[^.]+$/, ""),
          type: "bitmap",
          data: dataUrl,
        },
      });
    };
    reader.readAsDataURL(file);
  };

  const updateDimension = (key: "width" | "height", value: number) => {
    setDimensions((prev) => ({ ...prev, [key]: Math.max(64, value) }));
    setIsDirty(true);
  };

  const commitResize = () => {
    const nextWidth = isDirty ? dimensions.width : state.canvas.width;
    const nextHeight = isDirty ? dimensions.height : state.canvas.height;
    dispatch({
      type: "UPDATE_CANVAS_SIZE",
      width: Math.round(nextWidth),
      height: Math.round(nextHeight),
    });
    setDimensions({ width: nextWidth, height: nextHeight });
    setIsDirty(false);
  };

  const handleColorFill = () => {
    if (state.status.tool === "fill") {
      dispatch({ type: "SET_CANVAS_BACKGROUND", color: state.color.primary });
    }
  };

  return (
    <section className={`${styles.panel} ${styles.toolbarPanel}`}>
      <header className={styles.toolbar}>
        <div className={styles.toolCluster}>
          {tools.map((tool) => (
            <button
              key={tool.id}
              title={tool.hint}
              className={
                tool.id === state.status.tool ? styles.toolButtonActive : styles.toolButton
              }
              onClick={() => dispatch({ type: "SET_TOOL", tool: tool.id })}
              onDoubleClick={handleColorFill}
            >
              {tool.label}
            </button>
          ))}
        </div>
      </header>
      <div className={styles.toolbarControls}>
        <div className={styles.colorStack}>
          <label className={styles.colorPicker}>
            <span>Primary</span>
            <input
              type="color"
              value={state.color.primary}
              onChange={(event) =>
                dispatch({ type: "SET_PRIMARY_COLOR", value: event.target.value })
              }
            />
          </label>
          <label className={styles.colorPicker}>
            <span>Secondary</span>
            <input
              type="color"
              value={state.color.secondary}
              onChange={(event) =>
                dispatch({ type: "SET_SECONDARY_COLOR", value: event.target.value })
              }
            />
          </label>
          <button className={styles.swapButton} onClick={() => dispatch({ type: "SWAP_COLORS" })}>
            Swap
          </button>
        </div>
        <div className={styles.canvasSizeControls}>
          <div>
            <span>W</span>
            <input
              type="number"
              value={Math.round(isDirty ? dimensions.width : state.canvas.width)}
              onChange={(event) => updateDimension("width", Number(event.target.value))}
            />
          </div>
          <div>
            <span>H</span>
            <input
              type="number"
              value={Math.round(isDirty ? dimensions.height : state.canvas.height)}
              onChange={(event) => updateDimension("height", Number(event.target.value))}
            />
          </div>
          <button onClick={commitResize}>Resize</button>
        </div>
        <div className={styles.actionGroup}>
          <button onClick={() => dispatch({ type: "UNDO" })}>Undo</button>
          <button onClick={() => dispatch({ type: "REDO" })}>Redo</button>
          <button onClick={() => fileInputRef.current?.click()}>Import</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleImport}
          />
        </div>
      </div>
    </section>
  );
};

export default Toolbar;
