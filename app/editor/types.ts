export type ToolId =
  | "brush"
  | "eraser"
  | "fill"
  | "text"
  | "select"
  | "move"
  | "crop"
  | "color-picker";

export type LayerType = "bitmap" | "vector" | "text" | "adjustment";

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  opacity: number;
  blendMode:
    | "normal"
    | "multiply"
    | "screen"
    | "overlay"
    | "soft-light"
    | "hard-light";
  data?: string;
}

export interface CanvasSettings {
  width: number;
  height: number;
  background: string;
}

export interface AdjustmentSettings {
  exposure: number;
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
}

export interface ColorState {
  primary: string;
  secondary: string;
  palette: string[];
}

export interface EditorStatus {
  zoom: number;
  tool: ToolId;
  message?: string;
}

export interface EditorSnapshot {
  layers: Layer[];
  activeLayerId: string | null;
  canvas: CanvasSettings;
  adjustments: AdjustmentSettings;
  color: ColorState;
  status: EditorStatus;
}

export interface EditorPlugin {
  id: string;
  name: string;
  description: string;
  apply: (state: EditorState) => Partial<EditorState>;
}

export interface EditorState {
  layers: Layer[];
  activeLayerId: string | null;
  canvas: CanvasSettings;
  adjustments: AdjustmentSettings;
  color: ColorState;
  status: EditorStatus;
  history: EditorSnapshot[];
  future: EditorSnapshot[];
  pluginRegistry: EditorPlugin[];
}

export type EditorAction =
  | { type: "SET_TOOL"; tool: ToolId }
  | { type: "SET_PRIMARY_COLOR"; value: string }
  | { type: "SET_SECONDARY_COLOR"; value: string }
  | { type: "SWAP_COLORS" }
  | { type: "UPDATE_CANVAS_SIZE"; width: number; height: number }
  | { type: "SET_CANVAS_BACKGROUND"; color: string }
  | { type: "ADD_LAYER"; layer?: Partial<Layer> }
  | { type: "SELECT_LAYER"; id: string }
  | { type: "TOGGLE_LAYER_VISIBILITY"; id: string }
  | { type: "SET_LAYER_OPACITY"; id: string; opacity: number }
  | { type: "UPDATE_LAYER_BLEND"; id: string; blendMode: Layer["blendMode"] }
  | { type: "UPDATE_LAYER_DATA"; id: string; data: string }
  | { type: "RENAME_LAYER"; id: string; name: string }
  | { type: "DELETE_LAYER"; id: string }
  | { type: "DUPLICATE_LAYER"; id: string }
  | { type: "APPLY_ADJUSTMENT"; payload: Partial<AdjustmentSettings> }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "REGISTER_PLUGIN"; plugin: EditorPlugin }
  | { type: "APPLY_PLUGIN"; pluginId: string }
  | { type: "SET_STATUS_MESSAGE"; message?: string };

export type EditorDispatch = (action: EditorAction) => void;
