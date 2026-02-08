"use client";

import { useEditor } from "../state";
import styles from "./editor.module.scss";

const StatusBar = () => {
  const { state, dispatch } = useEditor();

  return (
    <footer className={styles.statusBar}>
      <div>
        <strong>{state.status.tool.toUpperCase()}</strong>
        <span>{state.status.message ?? "Ready"}</span>
      </div>
      <div className={styles.zoomControl}>
        <span>{Math.round(state.status.zoom * 100)}%</span>
        <input
          type="range"
          min={0.2}
          max={4}
          step={0.1}
          value={state.status.zoom}
          onChange={(event) =>
            dispatch({ type: "SET_ZOOM", zoom: Number(event.target.value) })
          }
        />
      </div>
    </footer>
  );
};

export default StatusBar;
