"use client";

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { defaultPlugins } from "./plugins/defaultPlugins";
import type {
  EditorAction,
  EditorDispatch,
  EditorSnapshot,
  EditorState,
  Layer,
} from "./types";

type EditorContextValue = {
  state: EditorState;
  dispatch: EditorDispatch;
};

const EditorContext = createContext<EditorContextValue | undefined>(undefined);

const createId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 11);

const cloneLayers = (layers: Layer[]) => layers.map((layer) => ({ ...layer }));

const snapshotState = (state: EditorState): EditorSnapshot => ({
  layers: cloneLayers(state.layers),
  activeLayerId: state.activeLayerId,
  canvas: { ...state.canvas },
  adjustments: { ...state.adjustments },
  color: { ...state.color, palette: [...state.color.palette] },
  status: { ...state.status },
});

const applySnapshot = (
  state: EditorState,
  snapshot: EditorSnapshot,
  overrides: Partial<EditorState> = {}
): EditorState => ({
  ...state,
  ...snapshot,
  layers: cloneLayers(snapshot.layers),
  canvas: { ...snapshot.canvas },
  adjustments: { ...snapshot.adjustments },
  color: { ...snapshot.color, palette: [...snapshot.color.palette] },
  status: { ...snapshot.status },
  ...overrides,
});

const withHistory = (state: EditorState, next: EditorState): EditorState => ({
  ...state,
  ...next,
  history: [...state.history, snapshotState(state)],
  future: [],
});

const mergeState = (
  state: EditorState,
  patch: Partial<EditorState>
): EditorState => ({
  ...state,
  ...(patch.layers ? { layers: cloneLayers(patch.layers) } : {}),
  ...(patch.canvas ? { canvas: { ...state.canvas, ...patch.canvas } } : {}),
  ...(patch.adjustments
    ? { adjustments: { ...state.adjustments, ...patch.adjustments } }
    : {}),
  ...(patch.color
    ? {
        color: {
          ...state.color,
          ...patch.color,
          palette: patch.color.palette
            ? [...patch.color.palette]
            : [...state.color.palette],
        },
      }
    : {}),
  ...(patch.status ? { status: { ...state.status, ...patch.status } } : {}),
});

const createLayer = (overrides: Partial<Layer>, index: number): Layer => ({
  id: overrides.id ?? createId(),
  name: overrides.name ?? `Layer ${index + 1}`,
  type: overrides.type ?? "bitmap",
  visible: overrides.visible ?? true,
  opacity: overrides.opacity ?? 1,
  blendMode: overrides.blendMode ?? "normal",
  data: overrides.data,
});

const baseLayer = createLayer(
  {
    name: "Background",
    type: "bitmap",
    data: undefined,
  },
  0
);

const initialState: EditorState = {
  layers: [baseLayer],
  activeLayerId: baseLayer.id,
  canvas: {
    width: 1600,
    height: 900,
    background: "#0b0f1a",
  },
  adjustments: {
    exposure: 0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
  },
  color: {
    primary: "#6a6aff",
    secondary: "#ff4f7a",
    palette: ["#6a6aff", "#ff4f7a", "#2cd3aa", "#ffd166"],
  },
  status: {
    zoom: 1,
    tool: "brush",
    message: "Ready",
  },
  history: [],
  future: [],
  pluginRegistry: defaultPlugins,
};

const clamp = (value: number, min = -1, max = 1) =>
  Math.min(max, Math.max(min, value));

const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
  switch (action.type) {
    case "SET_TOOL":
      return {
        ...state,
        status: { ...state.status, tool: action.tool, message: undefined },
      };
    case "SET_PRIMARY_COLOR": {
      const palette = new Set(state.color.palette);
      palette.add(action.value);
      return withHistory(state, {
        ...state,
        color: {
          ...state.color,
          primary: action.value,
          palette: Array.from(palette).slice(-12),
        },
      });
    }
    case "SET_SECONDARY_COLOR":
      return withHistory(state, {
        ...state,
        color: { ...state.color, secondary: action.value },
      });
    case "SWAP_COLORS":
      return withHistory(state, {
        ...state,
        color: {
          ...state.color,
          primary: state.color.secondary,
          secondary: state.color.primary,
        },
      });
    case "UPDATE_CANVAS_SIZE":
      return withHistory(state, {
        ...state,
        canvas: {
          ...state.canvas,
          width: action.width,
          height: action.height,
        },
        status: {
          ...state.status,
          message: `Canvas resized to ${action.width}×${action.height}`,
        },
      });
    case "SET_CANVAS_BACKGROUND":
      return withHistory(state, {
        ...state,
        canvas: { ...state.canvas, background: action.color },
      });
    case "ADD_LAYER": {
      const layer = createLayer(action.layer ?? {}, state.layers.length);
      return withHistory(state, {
        ...state,
        layers: [layer, ...state.layers],
        activeLayerId: layer.id,
        status: { ...state.status, message: `${layer.name} added` },
      });
    }
    case "SELECT_LAYER":
      return {
        ...state,
        activeLayerId: action.id,
      };
    case "TOGGLE_LAYER_VISIBILITY":
      return withHistory(state, {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === action.id ? { ...layer, visible: !layer.visible } : layer
        ),
      });
    case "SET_LAYER_OPACITY":
      return withHistory(state, {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === action.id ? { ...layer, opacity: action.opacity } : layer
        ),
      });
    case "UPDATE_LAYER_BLEND":
      return withHistory(state, {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === action.id ? { ...layer, blendMode: action.blendMode } : layer
        ),
      });
    case "UPDATE_LAYER_DATA":
      return withHistory(state, {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === action.id ? { ...layer, data: action.data } : layer
        ),
      });
    case "RENAME_LAYER":
      return withHistory(state, {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === action.id ? { ...layer, name: action.name } : layer
        ),
      });
    case "DELETE_LAYER": {
      if (state.layers.length === 1) {
        return state;
      }
      const filtered = state.layers.filter((layer) => layer.id !== action.id);
      return withHistory(state, {
        ...state,
        layers: filtered,
        activeLayerId: filtered[0]?.id ?? null,
      });
    }
    case "DUPLICATE_LAYER": {
      const layer = state.layers.find((l) => l.id === action.id);
      if (!layer) return state;
      const dupe = createLayer(
        {
          ...layer,
          id: undefined,
          name: `${layer.name} Copy`,
        },
        state.layers.length
      );
      return withHistory(state, {
        ...state,
        layers: [dupe, ...state.layers],
        activeLayerId: dupe.id,
      });
    }
    case "APPLY_ADJUSTMENT":
      return withHistory(state, {
        ...state,
        adjustments: {
          ...state.adjustments,
          ...Object.entries(action.payload).reduce((acc, [key, value]) => {
            if (typeof value !== "number") return acc;
            return { ...acc, [key]: clamp(value) };
          }, {} as Partial<typeof state.adjustments>),
        },
      });
    case "SET_ZOOM":
      return {
        ...state,
        status: { ...state.status, zoom: clamp(action.zoom, 0.2, 4) },
      };
    case "UNDO": {
      if (!state.history.length) return state;
      const previous = state.history[state.history.length - 1];
      const nextHistory = state.history.slice(0, -1);
      const snapshot = snapshotState(state);
      return {
        ...applySnapshot(state, previous),
        history: nextHistory,
        future: [snapshot, ...state.future],
        status: { ...state.status, message: "Undo" },
      };
    }
    case "REDO": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return {
        ...applySnapshot(state, next),
        history: [...state.history, snapshotState(state)],
        future: rest,
        status: { ...state.status, message: "Redo" },
      };
    }
    case "REGISTER_PLUGIN":
      if (state.pluginRegistry.some((plugin) => plugin.id === action.plugin.id)) {
        return state;
      }
      return {
        ...state,
        pluginRegistry: [...state.pluginRegistry, action.plugin],
      };
    case "APPLY_PLUGIN": {
      const plugin = state.pluginRegistry.find((p) => p.id === action.pluginId);
      if (!plugin) return state;
      const merged = mergeState(state, plugin.apply(state));
      return withHistory(state, {
        ...merged,
        pluginRegistry: state.pluginRegistry,
        status: {
          ...merged.status,
          message: `${plugin.name} applied`,
        },
      });
    }
    case "SET_STATUS_MESSAGE":
      return {
        ...state,
        status: { ...state.status, message: action.message },
      };
    default:
      return state;
  }
};

export const EditorProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
};

export const useEditor = () => {
  const ctx = useContext(EditorContext);
  if (!ctx) {
    throw new Error("useEditor must be used within an EditorProvider");
  }
  return ctx;
};
