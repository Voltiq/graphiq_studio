"use client";

import { useEditor } from "../state";
import styles from "./editor.module.scss";

const PluginPanel = () => {
  const { state, dispatch } = useEditor();

  return (
    <section className={styles.panel}>
      <header>
        <div>
          <h2>Plugins</h2>
          <p>Non-destructive recipes</p>
        </div>
      </header>
      <div className={styles.pluginGrid}>
        {state.pluginRegistry.map((plugin) => (
          <article key={plugin.id} className={styles.pluginCard}>
            <h3>{plugin.name}</h3>
            <p>{plugin.description}</p>
            <button onClick={() => dispatch({ type: "APPLY_PLUGIN", pluginId: plugin.id })}>
              Apply
            </button>
          </article>
        ))}
      </div>
    </section>
  );
};

export default PluginPanel;
