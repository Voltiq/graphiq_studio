"use client";

import { useEditor } from "../state";
import styles from "./editor.module.scss";

const blendModes = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
] as const;

const LayerPanel = () => {
  const { state, dispatch } = useEditor();

  return (
    <section className={`${styles.panel} ${styles.layerPanel}`}>
      <header>
        <div>
          <h2>Layers</h2>
          <p>{state.layers.length} total</p>
        </div>
        <button onClick={() => dispatch({ type: "ADD_LAYER" })}>+ Layer</button>
      </header>
      <div className={styles.layerList}>
        {state.layers.map((layer) => {
          const isActive = layer.id === state.activeLayerId;
          return (
            <div
              key={layer.id}
              className={isActive ? styles.layerCardActive : styles.layerCard}
              onClick={() => dispatch({ type: "SELECT_LAYER", id: layer.id })}
            >
              <div className={styles.layerHeader}>
                <input
                  className={styles.layerName}
                  value={layer.name}
                  onChange={(event) =>
                    dispatch({ type: "RENAME_LAYER", id: layer.id, name: event.target.value })
                  }
                />
                <div className={styles.layerActions}>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      dispatch({ type: "TOGGLE_LAYER_VISIBILITY", id: layer.id });
                    }}
                  >
                    {layer.visible ? "👁" : "🚫"}
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      dispatch({ type: "DUPLICATE_LAYER", id: layer.id });
                    }}
                  >
                    ⧉
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      dispatch({ type: "DELETE_LAYER", id: layer.id });
                    }}
                    disabled={state.layers.length === 1}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className={styles.layerControls}>
                <label>
                  <span>Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={layer.opacity}
                    onChange={(event) =>
                      dispatch({
                        type: "SET_LAYER_OPACITY",
                        id: layer.id,
                        opacity: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span>Blend</span>
                  <select
                    value={layer.blendMode}
                    onChange={(event) =>
                      dispatch({
                        type: "UPDATE_LAYER_BLEND",
                        id: layer.id,
                        blendMode: event.target.value as typeof blendModes[number],
                      })
                    }
                  >
                    {blendModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default LayerPanel;
