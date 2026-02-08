"use client";

import { EditorProvider } from "../state";
import Toolbar from "./Toolbar";
import LayerPanel from "./LayerPanel";
import CanvasStage from "./CanvasStage";
import AdjustmentsPanel from "./AdjustmentsPanel";
import PluginPanel from "./PluginPanel";
import StatusBar from "./StatusBar";
import styles from "./editor.module.scss";

const PhotoEditor = () => {
  return (
    <EditorProvider>
      <div className={styles.editorShell}>
        <Toolbar />
        <div className={styles.workspace}>
          <LayerPanel />
          <CanvasStage />
          <div className={styles.rightRail}>
            <AdjustmentsPanel />
            <PluginPanel />
          </div>
        </div>
        <StatusBar />
      </div>
    </EditorProvider>
  );
};

export default PhotoEditor;
